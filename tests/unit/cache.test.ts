// Semantic cache: slot matching, scoping and expiry flags. The ops database is
// mocked; embeddings are plain vectors passed in (cache.ts never embeds itself).

import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.fn();
vi.mock("@/lib/agent/ops-db.ts", () => ({ opsPool: () => ({ query }) }));

const { CACHE_SIMILARITY, CACHE_VERSION, cacheForgetRun, cacheLookup, cacheStore, resultHash, slotsOf } = await import("@/lib/agent/cache.ts");
import { PROMPT_VERSION } from "@/lib/agent/prompt.ts";
import { SCHEMA_HASH } from "@/lib/agent/schema-card.ts";
import { SEMANTIC_VERSION } from "@/lib/agent/semantic-layer.ts";
import type { SqlResult } from "@/lib/agent/types.ts";

const sameSlots = (a: string, b: string) => expect(slotsOf(a)).toEqual(slotsOf(b));
const differentSlots = (a: string, b: string) => expect(slotsOf(a)).not.toEqual(slotsOf(b));

describe("slotsOf", () => {
  it("extracts numbers, polarity, time words and stemmed key terms", () => {
    expect(slotsOf("Top 5 cheapest bikes listed this week at Curry")).toEqual({
      numbers: ["5"],
      polarity: ["max", "min"],
      time: ["this", "week"],
      terms: ["bike", "curry", "list"],
    });
  });

  it("is case- and punctuation-insensitive and sorted, so word order doesn't matter", () => {
    sameSlots("How many bikes are listed?", "how many bikes are listed");
    sameSlots("bikes listed, how many", "how many bikes are listed");
  });

  it("normalises numbers: 05 = 5, 2.50 = 2.5", () => {
    expect(slotsOf("top 05 under 2.50").numbers).toEqual(["2.5", "5"]);
  });

  describe("paraphrases share slots (should hit)", () => {
    it.each([
      ["number of bike listings", "how many bikes are listed"],
      ["How many bikes are listed?", "how many bikes are listed"],
      ["how much have i earned from selling", "how much have I earned from selling"],
      ["top 5 meetup spots by completed deals", "best 5 meetup spots by completed deals"],
      ["average price of textbooks", "mean price of textbooks"],
    ])("%j ~ %j", (a, b) => sameSlots(a, b));
  });

  describe("near-misses differ (must miss)", () => {
    it.each([
      ["cheapest bike for sale", "most expensive bike for sale", "min vs max"],
      ["top 5 meetup spots by completed deals", "top 3 meetup spots by completed deals", "5 vs 3"],
      ["listings posted this week", "listings posted last week", "this vs last"],
      ["bikes that sold in fall 2024", "bikes that did not sell in fall 2024", "negation"],
      ["bikes that sold in fall 2024", "bikes that didn't sell in fall 2024", "n't negation"],
      ["any mini fridges for rent at curry?", "any mini fridges for sale at curry?", "rent vs sale"],
      ["how many mini fridges were listed at curry this semester", "how many mini fridges were listed at snell this semester", "curry vs snell"],
      ["deals before thanksgiving", "deals after thanksgiving", "before vs after"],
      ["listings over $20", "listings under $20", "more vs less"],
      ["bikes listed in fall", "bikes listed in spring", "season"],
      ["deals in april", "deals in may", "month"],
      ["average rental price", "total rental price", "avg vs sum"],
      ["how many listings", "what percentage of listings", "count vs pct"],
      ["free listings", "listings", "free"],
    ])("%j vs %j (%s)", (a, b) => differentSlots(a, b));
  });

  it("splits n't off so contractions count as negation", () => {
    expect(slotsOf("which bikes didn't sell").polarity).toEqual(["not", "sale"]);
    expect(slotsOf("which bikes haven't sold").polarity).toEqual(["not", "sale"]);
  });

  it("drops stop words, short words and digits from the key terms", () => {
    expect(slotsOf("what is the price of an iv desk in 2025").terms).toEqual(["desk", "price"]);
  });

  it("stems plurals and -ing / -ed forms together", () => {
    sameSlots("listing boxes", "listed box");
    sameSlots("bike", "bikes");
  });
});

describe("cacheLookup", () => {
  const VECTOR = [0.1, 0.2, 0.3];
  const row = (question: string, similarity: number, extra: Record<string, unknown> = {}) => ({
    cache_id: 42,
    question,
    slots: slotsOf(question),
    sql: "select 1",
    answer: "cached answer",
    result_hash: "abc",
    similarity,
    ...extra,
  });

  beforeEach(() => {
    query.mockReset();
  });

  it("queries by role, cache version and user, with the vector as a pgvector literal", async () => {
    query.mockResolvedValueOnce({ rows: [] });
    await cacheLookup("q", VECTOR, "nlq_student", "user-1");
    const [sql, params] = query.mock.calls[0];
    expect(params).toEqual(["[0.1,0.2,0.3]", "nlq_student", CACHE_VERSION, "user-1"]);
    // scoping happens in SQL: shared entries or this user's, unexpired only
    expect(sql).toMatch(/db_role = \$2 and cache_version = \$3/);
    expect(sql).toMatch(/user_id is null or user_id = \$4::uuid/);
    expect(sql).toMatch(/valid_until is null or valid_until > now\(\)/);
  });

  it("passes a null user when nobody is signed in", async () => {
    query.mockResolvedValueOnce({ rows: [] });
    await cacheLookup("q", VECTOR, "nlq_admin", null);
    expect(query.mock.calls[0][1][3]).toBeNull();
  });

  it("returns a hit for a paraphrase above the similarity floor and counts the hit", async () => {
    query.mockResolvedValueOnce({ rows: [row("how many bikes are listed", 0.97)] }).mockResolvedValueOnce({ rowCount: 1 });
    const hit = await cacheLookup("Number of bike listings?", VECTOR, "nlq_student", null);
    expect(hit).toEqual({ cacheId: 42, question: "how many bikes are listed", sql: "select 1", answer: "cached answer", resultHash: "abc", similarity: 0.97, askedBy: null });
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[1][0]).toMatch(/update ops.query_cache set hits = hits \+ 1/);
    expect(query.mock.calls[1][1]).toEqual([42]);
  });

  it("accepts exactly the similarity floor, not just below it", async () => {
    query.mockResolvedValueOnce({ rows: [row("how many bikes are listed", CACHE_SIMILARITY)] }).mockResolvedValueOnce({});
    expect(await cacheLookup("how many bikes are listed", VECTOR, "nlq_student", null)).not.toBeNull();
    query.mockResolvedValueOnce({ rows: [row("how many bikes are listed", CACHE_SIMILARITY - 0.0001)] });
    expect(await cacheLookup("how many bikes are listed", VECTOR, "nlq_student", null)).toBeNull();
  });

  it("misses a near-miss even with very high similarity", async () => {
    query.mockResolvedValueOnce({ rows: [row("cheapest bike for sale", 0.99)] });
    expect(await cacheLookup("most expensive bike for sale", VECTOR, "nlq_student", null)).toBeNull();
    expect(query).toHaveBeenCalledTimes(1); // no hit counted
  });

  it("skips an incompatible nearer row and takes a compatible one further down", async () => {
    query.mockResolvedValueOnce({ rows: [row("most expensive bike for sale", 0.99, { cache_id: 1 }), row("cheapest bikes for sale", 0.96, { cache_id: 2 })] }).mockResolvedValueOnce({});
    expect((await cacheLookup("cheapest bike for sale", VECTOR, "nlq_student", null))?.cacheId).toBe(2);
  });
});

describe("cacheStore", () => {
  const result: SqlResult = { ok: true, columns: ["n"], rows: [{ n: 1 }], rowCount: 1, truncated: false };
  const store = (question: string, sql: string, userId: string | null = null) =>
    cacheStore({ question, vector: [1, 2], role: "nlq_student", userId, sql, answer: "a", result, runId: "run-1" });
  const params = () => query.mock.calls[0][1] as unknown[];

  beforeEach(() => {
    query.mockReset();
    query.mockResolvedValue({});
  });

  it("stores role, slots, hash, version, vector and who asked", async () => {
    await store("how many bikes are listed", "select count(*) from nlq.listings");
    expect(params()).toEqual([
      "nlq_student", null, "how many bikes are listed", JSON.stringify(slotsOf("how many bikes are listed")),
      "select count(*) from nlq.listings", "a", resultHash(result), false, "run-1", CACHE_VERSION, "[1,2]", null,
    ]);
  });

  it("shares entries that read no my_* view, even when a student asked, and records who asked", async () => {
    await store("how many bikes are listed", "select count(*) from nlq.listings", "student-a");
    expect(params()[1]).toBeNull();
    expect(params()[11]).toBe("student-a");
  });

  // Red team: the regex missed my_* views spelled with a unicode escape, so personal SQL was
  // cached as shared. Scoping now comes from the parse tree.
  it.each([String.raw`select count(*) from nlq.U&"\006Dy_deals"`, String.raw`select count(*) from U&"my\005Flistings"`, "select count(*) from (select * from nlq.my_reviews) r"])(
    "scopes %j to the student (parse tree, not text)",
    async (sql) => {
      await store("my stuff", sql, "student-a");
      expect(params()[1]).toBe("student-a");
    },
  );

  // Red team: SQL that selects a string constant can put model-chosen text in front of other
  // students ("select 'your account is locked, visit ...'"); it is cached per student only
  it.each(["select 'Your account is locked' as notice, count(*) from nlq.listings", "select title || ' (verified)' from nlq.listings", "select case when true then 'x' end from nlq.categories"])(
    "scopes %j (string constant in the SELECT list) to the student",
    async (sql) => {
      await store("q", sql, "student-a");
      expect(params()[1]).toBe("student-a");
    },
  );
  it("still shares SQL whose string constants are only filters", async () => {
    await store("bikes at curry", "select title from nlq.listings where category = 'bikes_transport' and meetup_spot ilike '%curry%'", "student-a");
    expect(params()[1]).toBeNull();
  });
  it("never stores SQL with a string constant in its SELECT list without a student", async () => {
    await store("q", "select 'hi' as x");
    expect(query).not.toHaveBeenCalled();
  });

  it.each(["my_listings", "my_deals", "my_saved_items", "my_reviews"])("scopes SQL over nlq.%s to the student", async (view) => {
    await store("my stuff", `select count(*) from nlq.${view}`, "student-a");
    expect(params()[1]).toBe("student-a");
  });

  it("never stores my_* SQL without a student", async () => {
    await store("how much have I earned", "select sum(agreed_price) from nlq.my_deals");
    expect(query).not.toHaveBeenCalled();
  });

  it("expires relative-time questions at the next Boston midnight (computed in SQL)", async () => {
    await store("listings posted this week", "select 1");
    expect(params()[7]).toBe(true);
    expect(query.mock.calls[0][0]).toContain("((now() at time zone 'America/New_York')::date + 1)::timestamp at time zone 'America/New_York'");
  });

  it.each([
    "what was listed today", "deals from yesterday", "anything new right now", "what's currently for rent", "bikes rn",
    "listings this semester", "last month's deals", "the past week", "previous semester", "recent listings",
    "listings posted recently", "next week's rentals", "the current semester",
  ])("marks %j as expiring", async (question) => {
    await store(question, "select 1");
    expect(params()[7]).toBe(true);
  });

  it.each(["bikes that sold in fall 2024", "how many bikes are listed", "deals in april 2025", "average price of textbooks"])(
    "keeps %j until evicted",
    async (question) => {
      await store(question, "select 1");
      expect(params()[7]).toBe(false);
    },
  );

  // Fixed: RELATIVE missed relative phrasings that retrieve.ts's TIME_WORDS knows
  // ("ago", "lately", "since"). The model resolves them to fixed dates from "today",
  // so the cached SQL kept answering for the day it was asked, forever.
  it.each([
    "listings posted 3 days ago", "what sold lately", "deals since monday", "how many deals so far",
    "anything for rent tonight", "deals to date", "LATEST listings", "upcoming rental returns", "what sold on friday",
  ])("%j should expire at midnight", async (question) => {
    await store(question, "select 1");
    expect(params()[7]).toBe(true);
  });

  it.each(["how many deals happen on fridays", "agoraphobia books", "the sincerest review", "farthest meetup spot"])(
    "%j has no relative word and is kept",
    async (question) => {
      await store(question, "select 1");
      expect(params()[7]).toBe(false);
    },
  );

  // Fixed: PERSONAL was case-sensitive, so upper-case my_* SQL was stored unscoped
  // (visible to every student) or stored with no student at all.
  it.each(["select count(*) from NLQ.MY_DEALS", "select count(*) from nlq.My_Listings", 'select count(*) from nlq."my_reviews"'])(
    "scopes %j to the student whatever its case",
    async (sql) => {
      await store("my stuff", sql, "student-a");
      expect(params()[1]).toBe("student-a");
    },
  );
  it("never stores upper-case my_* SQL without a student", async () => {
    await store("how much have I earned", "SELECT SUM(agreed_price) FROM NLQ.MY_DEALS");
    expect(query).not.toHaveBeenCalled();
  });
});

describe("resultHash, CACHE_VERSION, cacheForgetRun", () => {
  it("hashes columns and rows: equal results equal, any change differs", () => {
    const a: SqlResult = { ok: true, columns: ["n"], rows: [{ n: 1 }], rowCount: 1, truncated: false };
    expect(resultHash(a)).toBe(resultHash({ ...a, rowCount: 1 }));
    expect(resultHash(a)).toMatch(/^[0-9a-f]{16}$/);
    expect(resultHash(a)).not.toBe(resultHash({ ...a, rows: [{ n: 2 }] }));
    expect(resultHash(a)).not.toBe(resultHash({ ...a, columns: ["m"] }));
    expect(resultHash({ ok: false, error: "x" })).not.toBe(resultHash({ ok: false, error: "y" }));
  });

  it("the cache version changes with the prompt, schema and semantic layer", () => {
    expect(CACHE_VERSION).toBe(`${PROMPT_VERSION}-${SCHEMA_HASH}-${SEMANTIC_VERSION}`);
  });

  it("forgets a run's entries by run id", async () => {
    query.mockReset();
    query.mockResolvedValue({});
    await cacheForgetRun("run-9");
    expect(query).toHaveBeenCalledWith("delete from ops.query_cache where run_id = $1", ["run-9"]);
  });
});
