// Context retriever (graph node 3): finds what the SQL node needs for one
// question, without calling a model.
//
//   vector search  views, columns, stored values, glossary, verified examples (gte-small)
//   text search    stored values by trigram word similarity (typos: "currry")
//   aliases        exact words from the semantic layer ("iv" -> International Village)
//
// Every index entry is tagged with the roles allowed to see it, so a student's
// retrieval never surfaces anything from admin-only views.

import { embed, toVector } from "./embed.ts";
import { opsPool } from "./ops-db.ts";
import { SCHEMA_CARD } from "./schema-card.ts";
import { JOIN_PATHS, VALUE_ALIASES } from "./semantic-layer.ts";
import type { DbRole, RetrievalSummary, ViewCard } from "./types.ts";

// Similarity floors for gte-small (cosine; unrelated text still scores ~0.75)
export const THRESHOLDS = { glossary: 0.82, example: 0.88, value: 0.86, title: 0.88, text: 0.8 };
const MAX_VIEWS = 10;
const MIN_VIEWS = 3;

const STOPWORDS = new Set(
  "the a an and or of for to in on at by with from is are was were be been how many much what which who whom whose when where why any all some show me my i we our you your it its this that these those there their them do does did can could would should have has had get got per vs than then as into out over under about between most more less least few top".split(" "),
);
// Marketplace words that say nothing about which item: never matched against titles
const NOT_ITEMS = new Set(
  ("deal deals pick pickup sale sales sell selling sold seller sellers buy buying bought buyer buyers rent rental rentals renting " +
    "cheap cheapest expensive price prices stuff item items thing things available listing listings listed list week weekly " +
    "earn earned spent free used good condition student students came come back late during happen happened take takes took " +
    "turned share average number count total percent like time times reply replies chat chats request requests completed spot " +
    "spots meetup still open returned return damaged most least many much").split(" "),
);
// The my_* views only matter when the question is about the asker
const FIRST_PERSON = /\b(i|i'm|i've|i'd|me|my|mine|myself)\b/i;
const TIME_WORDS = /\b(today|yesterday|tomorrow|week|weekend|weekday|month|year|semester|term|spring|summer|fall|autumn|winter|finals?|move[- ]?(in|out)|break|holiday|jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec|monday|tuesday|wednesday|thursday|friday|saturday|sunday|patriots|thanksgiving|christmas|\d{4}|recent|lately|last|since|ago)\b/i;

export type ValueHit = { view: string; column: string; value: string; score: number; via: "alias" | "text" | "vector" };
export type Retrieved = {
  views: ViewCard[];
  values: ValueHit[];
  titles: { value: string; score: number }[];
  glossary: { terms: string[]; meaning: string; score: number }[];
  examples: { question: string; sql: string; score: number }[];
  joins: string[];
  ms: number;
};

// What the run log keeps about a retrieval
export function summarize(r: Retrieved): RetrievalSummary {
  return {
    views: r.views.map((v) => v.name),
    values: r.values.map((v) => `${v.view}.${v.column}=${v.value} (${v.via} ${v.score.toFixed(2)})`),
    titles: r.titles.map((t) => t.value),
    glossary: r.glossary.map((g) => g.terms[0]),
    examples: r.examples.map((e) => ({ question: e.question, score: Number(e.score.toFixed(3)) })),
    ms: r.ms,
  };
}

type Row = { src: string; kind: string; view_name: string | null; column_name: string | null; value: string | null; meta: Record<string, unknown>; score: number };

// Everyday words that are also stored values (listing condition): only matched in
// pairs like "like new", "brand new", "good condition", never alone ("new listings")
const AMBIGUOUS_VALUE_WORDS = new Set(["new", "good", "fair", "like"]);

// Words and word pairs to match against stored values; titles only get item words
function tokens(question: string) {
  const all = question.toLowerCase().split(/[^a-z0-9'-]+/).filter((w) => w.length >= 3 && !STOPWORDS.has(w));
  const bigrams = all.slice(1).map((w, i) => `${all[i]} ${w}`);
  const words = all.filter((w) => !AMBIGUOUS_VALUE_WORDS.has(w));
  const itemWords = words.filter((w) => !NOT_ITEMS.has(w) && w.length >= 4 && !/^\d+$/.test(w));
  const itemBigrams = itemWords.slice(1).map((w, i) => `${itemWords[i]} ${w}`);
  return { all: [...new Set([...words, ...bigrams])], items: [...new Set([...itemWords, ...itemBigrams])] };
}

// vector: the question's embedding if already computed (the cache node makes one)
export async function retrieve(
  question: string,
  role: DbRole,
  { examples = true, vector: given }: { examples?: boolean; vector?: number[] } = {},
): Promise<Retrieved> {
  const started = performance.now();
  const vector = given ?? (await embed([question]))[0];
  const terms = tokens(question);
  const near = (kind: string, limit: number) => `
    (select 'vector' as src, kind, view_name, column_name, value, meta,
            1 - (embedding operator(extensions.<=>) $1::extensions.vector) as score
     from ops.rag_docs
     where kind ${kind} and $2 = any(roles)
     order by embedding operator(extensions.<=>) $1::extensions.vector
     limit ${limit})`;
  const { rows } = await opsPool().query<Row>(
    `${near("in ('view', 'column')", 15)}
     union all ${near("= 'value'", 12)}
     union all ${near("= 'glossary'", 5)}
     ${examples ? `union all ${near("= 'example'", 3)}` : ""}
     union all
     (select 'text', kind, view_name, column_name, value, meta, extensions.word_similarity(t, lower(value)) as score
      from ops.rag_docs, unnest(case when meta ? 'title' then $4::text[] else $3::text[] end) as t
      where kind = 'value' and $2 = any(roles) and extensions.word_similarity(t, lower(value)) >= ${THRESHOLDS.text}
      order by score desc
      limit 20)`,
    [toVector(vector), role, terms.all, terms.items],
  );

  // Stored values: aliases, text matches and close vector matches; item titles separately
  const aboutMe = FIRST_PERSON.test(question);
  const values = new Map<string, ValueHit>();
  const titles = new Map<string, number>();
  const addValue = (hit: ValueHit) => {
    if (!aboutMe && hit.view.startsWith("my_")) return;
    const key = `${hit.view}.${hit.column}=${hit.value}`;
    if ((values.get(key)?.score ?? -1) < hit.score) values.set(key, hit);
  };
  const lower = ` ${question.toLowerCase().replace(/[^a-z0-9 ]+/g, " ")} `;
  for (const a of VALUE_ALIASES) {
    const viewRoles = SCHEMA_CARD.find((v) => v.name === a.view)?.roles ?? [];
    if (viewRoles.includes(role) && a.aliases.some((alias) => lower.includes(` ${alias} `))) {
      addValue({ view: a.view, column: a.column, value: a.value, score: 1, via: "alias" });
    }
  }
  for (const r of rows.filter((r) => r.kind === "value")) {
    const isTitle = r.meta?.title === true;
    const floor = r.src === "text" ? THRESHOLDS.text : isTitle ? THRESHOLDS.title : THRESHOLDS.value;
    if (r.score < floor) continue;
    if (isTitle) titles.set(r.value!, Math.max(titles.get(r.value!) ?? 0, r.score));
    else addValue({ view: r.view_name!, column: r.column_name!, value: r.value!, score: r.score, via: r.src as ValueHit["via"] });
  }

  // Definitions and examples about the my_* views only when the question is about the asker
  const personal = (views: string[]) => views.some((v) => v.startsWith("my_"));
  const glossary = rows
    .filter((r) => r.kind === "glossary" && r.score >= THRESHOLDS.glossary)
    .map((r) => ({ terms: r.meta.terms as string[], meaning: r.meta.meaning as string, views: r.meta.views as string[], score: r.score }))
    .filter((g) => aboutMe || !personal(g.views));
  const exampleHits = rows
    .filter((r) => r.kind === "example" && r.score >= THRESHOLDS.example)
    .map((r) => ({ question: r.meta.question as string, sql: r.meta.sql as string, views: r.meta.views as string[], score: r.score }))
    .filter((e) => aboutMe || !personal(e.views));

  // Views: best schema matches, plus every view a value, glossary entry or example points to.
  // my_* views are dropped before ranking unless the question is about the asker.
  const viewScore = new Map<string, number>();
  const bump = (view: string, score: number) => viewScore.set(view, Math.max(viewScore.get(view) ?? 0, score));
  for (const r of rows.filter((r) => (r.kind === "view" || r.kind === "column") && (aboutMe || !r.view_name!.startsWith("my_")))) {
    bump(r.view_name!, r.score);
  }
  const ranked = [...viewScore.entries()].sort((a, b) => b[1] - a[1]);
  const chosen = new Set(ranked.filter(([, s], i) => i < MIN_VIEWS || s >= ranked[0][1] - 0.04).map(([v]) => v));
  for (const hit of values.values()) chosen.add(hit.view);
  // The listings fact view: students always get theirs (it's all they can query about
  // items); admins get listings_all when the question matched categories, spots or titles
  const listingsView = role === "nlq_admin" ? "listings_all" : "listings";
  if (role === "nlq_student" || titles.size || [...values.values()].some((h) => ["categories", "meetup_spots", "listings_all"].includes(h.view))) {
    chosen.add(listingsView);
  }
  for (const g of glossary) g.views.forEach((v) => chosen.add(v));
  for (const e of exampleHits) e.views.forEach((v) => chosen.add(v));
  if (TIME_WORDS.test(question)) chosen.add("calendar");

  const allowed = SCHEMA_CARD.filter((v) => v.roles.includes(role) && (aboutMe || !v.name.startsWith("my_")));
  const order = (v: string) => (viewScore.get(v) ?? 0) + (values.size && [...values.values()].some((h) => h.view === v) ? 1 : 0);
  const views = [...chosen]
    .map((name) => allowed.find((v) => v.name === name))
    .filter((v): v is ViewCard => !!v)
    .sort((a, b) => order(b.name) - order(a.name))
    .slice(0, MAX_VIEWS);
  // Never hand the SQL node an empty schema: fall back to the role's main listings view
  if (!views.length) views.push(allowed.find((v) => v.name === (role === "nlq_admin" ? "listings_all" : "listings"))!);
  const names = new Set(views.map((v) => v.name));

  return {
    views,
    values: [...values.values()].sort((a, b) => b.score - a.score).slice(0, 8),
    titles: [...titles.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([value, score]) => ({ value, score })),
    glossary: glossary.slice(0, 4).map(({ terms, meaning, score }) => ({ terms, meaning, score })),
    examples: exampleHits.slice(0, 3).map(({ question, sql, score }) => ({ question, sql, score })),
    joins: JOIN_PATHS.filter((j) => names.has(j.from) && names.has(j.to)).map((j) => j.on),
    ms: Math.round(performance.now() - started),
  };
}
