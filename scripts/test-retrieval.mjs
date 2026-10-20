// Checks the context retriever (no model calls): for each question, the views,
// stored values and hints it must find, and what a student must never see.
//
//   npm run test:retrieval -- [--verbose]

import { fileURLToPath } from "node:url";
import { closeOpsPool } from "../src/lib/agent/ops-db.ts";
import { retrieve } from "../src/lib/agent/retrieve.ts";

process.loadEnvFile(fileURLToPath(new URL("../.env.local", import.meta.url)));
const verbose = process.argv.includes("--verbose");

// expect: views (all present), values ("column=value" present), titles (substring of a title hit),
//         glossary (a term), noViews (must be absent)
const CASES = [
  { role: "nlq_student", q: "any mini fridges for rent at currry?", views: ["listings"], values: ["name=Curry Student Center"], titles: ["fridge"] },
  { role: "nlq_student", q: "what can i pick up at iv this week", values: ["name=International Village"] },
  { role: "nlq_student", q: "cheapest bike for sale", values: ["category=bikes_transport"] },
  { role: "nlq_student", q: "how many deals happened last week", noViews: ["deals", "listings_all", "conversations", "reviews", "students"] },
  { role: "nlq_student", q: "how much did i earn from selling stuff", views: ["my_deals"] },
  { role: "nlq_student", q: "orgo textbook under 30 dollars", values: ["category=textbooks"], titles: ["org"], glossary: ["orgo"] },
  { role: "nlq_admin", q: "how many rentals came back late during move-out 2025", views: ["deals", "calendar"], glossary: ["late"] },
  { role: "nlq_admin", q: "which meetup spot has the most completed deals", views: ["deals", "meetup_spots"] },
  { role: "nlq_admin", q: "average time sellers take to reply", views: ["conversations"], glossary: ["reply time"] },
  { role: "nlq_admin", q: "how many students got suspended", views: ["students"], values: ["account_status=suspended"] },
  { role: "nlq_admin", q: "graphing calculators sold in fall 2024", views: ["calendar"], titles: ["calc"] },
  { role: "nlq_admin", q: "share of chats that turned into a request", views: ["conversations"], glossary: ["conversion"] },
  { role: "nlq_student", q: "how many textbooks are listed at snell", views: ["listings"], values: ["category=textbooks", "name=Snell Library"] },
  { role: "nlq_student", q: "average price of desks for sale", views: ["listings"] },
  { role: "nlq_admin", q: "monthly new listings for the last 6 months", views: ["listings_all"], noValues: ["condition=new"] },
  { role: "nlq_admin", q: "how many like new items were listed in fall 2025", values: ["condition=like_new"] },
];

let failures = 0;
for (const c of CASES) {
  const r = await retrieve(c.q, c.role);
  const views = r.views.map((v) => v.name);
  const values = r.values.map((v) => `${v.column}=${v.value}`);
  const problems = [
    ...(c.views ?? []).filter((v) => !views.includes(v)).map((v) => `missing view ${v}`),
    ...(c.values ?? []).filter((v) => !values.includes(v)).map((v) => `missing value ${v}`),
    ...(c.titles ?? []).filter((t) => !r.titles.some((h) => h.value.includes(t))).map((t) => `no title like "${t}"`),
    ...(c.glossary ?? []).filter((g) => !r.glossary.some((e) => e.terms.some((t) => t.includes(g)))).map((g) => `no glossary "${g}"`),
    ...(c.noViews ?? []).filter((v) => views.includes(v)).map((v) => `LEAKED view ${v}`),
    ...(c.noValues ?? []).filter((v) => values.includes(v)).map((v) => `misleading value ${v}`),
  ];
  if (problems.length) failures++;
  console.log(`${problems.length ? "FAIL" : "PASS"}  [${c.role === "nlq_admin" ? "admin" : "student"}] ${c.q}  (${r.ms} ms)${problems.length ? `  ->  ${problems.join("; ")}` : ""}`);
  if (verbose || problems.length) {
    console.log(`      views:    ${views.join(", ")}`);
    console.log(`      values:   ${r.values.map((v) => `${v.column}=${v.value} (${v.via} ${v.score.toFixed(2)})`).join(", ") || "-"}`);
    console.log(`      titles:   ${r.titles.map((t) => `${t.value} (${t.score.toFixed(2)})`).join(", ") || "-"}`);
    console.log(`      glossary: ${r.glossary.map((g) => `${g.terms[0]} (${g.score.toFixed(2)})`).join(", ") || "-"}`);
    console.log(`      examples: ${r.examples.map((e) => `"${e.question}" (${e.score.toFixed(2)})`).join(", ") || "-"}`);
  }
}
await closeOpsPool();
console.log(failures ? `\n${failures} case(s) FAILED` : "\nAll retrieval checks passed");
process.exitCode = failures ? 1 : 0;
