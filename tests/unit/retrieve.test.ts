// Context retriever: which views, values, titles, definitions and examples reach the
// model, given what the (mocked) index returns. No embeddings, no database.

import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.fn();
vi.mock("@/lib/agent/ops-db.ts", () => ({ opsPool: () => ({ query }) }));
vi.mock("@/lib/agent/embed.ts", () => ({ embed: vi.fn(async () => [[9, 9]]), toVector: (v: number[]) => `[${v.join(",")}]` }));

const { THRESHOLDS, retrieve, summarize } = await import("@/lib/agent/retrieve.ts");
const { bostonToday } = await import("@/lib/agent/prompt.ts");
import type { DbRole } from "@/lib/agent/types.ts";

type Row = { src: string; kind: string; view_name: string | null; column_name: string | null; value: string | null; meta: Record<string, unknown>; score: number };
const view = (name: string, score: number): Row => ({ src: "vector", kind: "view", view_name: name, column_name: null, value: null, meta: {}, score });
const value = (v: string, col: string, val: string, score: number, src = "vector", meta: Record<string, unknown> = {}): Row => ({ src, kind: "value", view_name: v, column_name: col, value: val, meta, score });
const glossary = (terms: string[], views: string[], score: number): Row => ({ src: "vector", kind: "glossary", view_name: null, column_name: null, value: null, meta: { terms, meaning: `${terms[0]} means...`, views }, score });
const example = (question: string, views: string[], score: number): Row => ({ src: "vector", kind: "example", view_name: null, column_name: null, value: null, meta: { question, sql: "select 1", views }, score });

async function find(question: string, role: DbRole, rows: Row[] = [], examples = true) {
  query.mockResolvedValueOnce({ rows });
  return retrieve(question, role, { vector: [0.5, 0.25], examples });
}
const names = (r: Awaited<ReturnType<typeof find>>) => r.views.map((v) => v.name);

beforeEach(() => query.mockReset());

describe("retrieve: views", () => {
  it("students always get listings; with nothing else found, that's all", async () => {
    expect(names(await find("hello", "nlq_student"))).toEqual(["listings"]);
  });

  it("admins with nothing found fall back to listings_all", async () => {
    expect(names(await find("hello", "nlq_admin"))).toEqual(["listings_all"]);
  });

  it("keeps the top 3 views and any within 0.04 of the best", async () => {
    const r = await find("deal stats", "nlq_admin", [view("deals", 0.9), view("reviews", 0.87), view("reports", 0.8), view("students", 0.7), view("conversations", 0.6)]);
    expect(names(r)).toEqual(["deals", "reviews", "reports"]);
    const r2 = await find("deal stats", "nlq_admin", [view("deals", 0.9), view("reviews", 0.89), view("reports", 0.88), view("students", 0.87), view("conversations", 0.8)]);
    expect(names(r2)).toEqual(["deals", "reviews", "reports", "students"]);
  });

  it("never offers a view the role can't see", async () => {
    const r = await find("deal stats", "nlq_student", [view("deals", 0.95), view("reviews", 0.9), view("calendar", 0.8)]);
    expect(names(r)).not.toContain("deals");
    expect(names(r)).not.toContain("reviews");
    expect(names(r)).toEqual(expect.arrayContaining(["calendar", "listings"]));
  });

  it("offers my_* views only when the question is about the asker", async () => {
    const rows = [view("my_deals", 0.95), view("listings", 0.8)];
    expect(names(await find("how many deals happened", "nlq_student", rows))).not.toContain("my_deals");
    expect(names(await find("how many deals have I made", "nlq_student", rows))).toContain("my_deals");
    expect(names(await find("show MY deals", "nlq_student", rows))).toContain("my_deals");
  });

  it("adds the calendar for time words", async () => {
    for (const q of ["listings this semester", "deals during finals", "rentals in 2024", "sales on Patriots day", "what sold last week"]) {
      expect(names(await find(q, "nlq_student")), q).toContain("calendar");
    }
    expect(names(await find("cheapest desk", "nlq_student"))).not.toContain("calendar");
  });

  it("caps the views at 10", async () => {
    const all = ["calendar", "categories", "conversations", "deals", "listings", "listings_all", "meetup_spots", "reports", "reviews", "saved_items", "students"];
    const r = await find("everything", "nlq_admin", all.map((v) => view(v, 0.9)));
    expect(r.views).toHaveLength(10);
  });

  it("joins are listed only between views that were chosen", async () => {
    const r = await find("deals by spot", "nlq_admin", [view("deals", 0.9), view("listings_all", 0.9), view("meetup_spots", 0.9)]);
    expect(r.joins).toEqual(["deals.item_id = listings_all.item_id", "listings_all.spot_id = meetup_spots.spot_id"]);
  });
});

describe("retrieve: values and titles", () => {
  it("matches aliases as whole words and adds their views", async () => {
    const r = await find("Any bikes at Curry?", "nlq_student");
    expect(r.values).toEqual(expect.arrayContaining([
      { view: "meetup_spots", column: "name", value: "Curry Student Center", score: 1, via: "alias" },
      { view: "categories", column: "category", value: "bikes_transport", score: 1, via: "alias" },
    ]));
    expect(names(r)).toEqual(expect.arrayContaining(["meetup_spots", "categories", "listings"]));
    expect((await find("curryville bikers", "nlq_student")).values).toEqual([]); // not whole words
  });

  it("admins get listings_all when a category, spot or title matched", async () => {
    expect(names(await find("desks at snell", "nlq_admin"))).toContain("listings_all");
  });

  it("drops value matches under their floor, keeps those over it", async () => {
    const r = await find("returned damaged", "nlq_admin", [
      value("deals", "return_condition", "damaged", THRESHOLDS.value),
      value("deals", "status", "returned", THRESHOLDS.value - 0.01),
      value("deals", "status", "completed", THRESHOLDS.text, "text"),
    ]);
    expect(r.values.map((v) => v.value)).toEqual(["damaged", "completed"]);
    expect(names(r)).toContain("deals");
  });

  it("keeps the best score for a value found twice", async () => {
    const r = await find("damaged", "nlq_admin", [value("deals", "return_condition", "damaged", 0.9), value("deals", "return_condition", "damaged", 0.95, "text")]);
    expect(r.values).toEqual([{ view: "deals", column: "return_condition", value: "damaged", score: 0.95, via: "text" }]);
  });

  it("collects item titles separately, best first, at most 6", async () => {
    const titles = Array.from({ length: 8 }, (_, i) => value("listings", "title", `mini fridge ${i}`, 0.89 + i / 100, "vector", { title: true }));
    titles.push(value("listings", "title", "too far", THRESHOLDS.title - 0.01, "vector", { title: true }));
    const r = await find("mini fridge", "nlq_student", titles);
    expect(r.titles.map((t) => t.value)).toEqual(["mini fridge 7", "mini fridge 6", "mini fridge 5", "mini fridge 4", "mini fridge 3", "mini fridge 2"]);
    expect(r.values).toEqual([]);
  });

  it("ignores my_* values unless the question is about the asker", async () => {
    const rows = [value("my_deals", "my_role", "seller", 0.95)];
    expect((await find("sellers with most deals", "nlq_student", rows)).values).toEqual([]);
    expect((await find("deals where I was the seller", "nlq_student", rows)).values).toHaveLength(1);
  });

  it("sends the vector, role, value terms and item terms to the index", async () => {
    await find("Like new desks for sale", "nlq_student");
    const params = query.mock.calls[0][1];
    expect(params[0]).toBe("[0.5,0.25]");
    expect(params[1]).toBe("nlq_student");
    expect(params[2]).toEqual(expect.arrayContaining(["desks", "sale", "like new", "new desks"])); // "new" alone is too common
    expect(params[2]).not.toContain("new");
    expect(params[3]).toEqual(["desks"]); // only item words go to title matching
  });

  it("leaves examples out of the query when they're off", async () => {
    await find("x", "nlq_student", [], false);
    expect(query.mock.calls[0][0]).not.toContain("'example'");
  });
});

describe("retrieve: definitions and examples", () => {
  it("keeps those over their floor and adds the views they point to", async () => {
    const r = await find("late returns", "nlq_admin", [
      glossary(["late return"], ["deals"], THRESHOLDS.glossary),
      glossary(["too weak"], ["reports"], THRESHOLDS.glossary - 0.01),
      example("how many late returns", ["deals", "calendar"], THRESHOLDS.example),
      example("weak", ["students"], THRESHOLDS.example - 0.01),
    ]);
    expect(r.glossary.map((g) => g.terms[0])).toEqual(["late return"]);
    expect(r.examples.map((e) => e.question)).toEqual(["how many late returns"]);
    expect(names(r)).toEqual(expect.arrayContaining(["deals", "calendar"]));
    expect(names(r)).not.toContain("students");
  });

  it("drops definitions and examples about my_* views unless the question is about the asker", async () => {
    const rows = [glossary(["my deals"], ["my_deals"], 0.95), example("how much did I earn", ["my_deals"], 0.95)];
    const general = await find("total earnings", "nlq_student", rows);
    expect([general.glossary.length, general.examples.length]).toEqual([0, 0]);
    const mine = await find("how much did I earn", "nlq_student", rows);
    expect([mine.glossary.length, mine.examples.length]).toEqual([1, 1]);
  });
});

describe("summarize", () => {
  it("keeps names and rounded scores for the run log", async () => {
    const r = await find("bikes at curry", "nlq_student", [example("cheapest bike", ["listings"], 0.91234), glossary(["bike"], ["listings"], 0.9)]);
    const s = summarize(r);
    expect(s.views).toEqual(names(r));
    expect(s.values).toContain("meetup_spots.name=Curry Student Center (alias 1.00)");
    expect(s.examples).toEqual([{ question: "cheapest bike", score: 0.912 }]);
    expect(s.glossary).toEqual(["bike"]);
  });
});

describe("bostonToday", () => {
  it.each([
    ["2026-10-16T16:00:00Z", "Friday, 2026-10-16"],
    ["2026-10-17T03:59:00Z", "Friday, 2026-10-16"], // 23:59 in Boston (EDT)
    ["2026-10-17T04:00:00Z", "Saturday, 2026-10-17"],
    ["2026-01-01T04:59:00Z", "Wednesday, 2025-12-31"], // 23:59 EST
  ])("%s -> %s", (iso, expected) => {
    expect(bostonToday(new Date(iso))).toBe(expected);
  });
});
