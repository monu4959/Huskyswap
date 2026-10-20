// Build the context retriever's index (ops.rag_docs).
//
//   npm run rag:index
//
// Indexes, each tagged with the nlq roles allowed to retrieve it:
//   view / column  the schema card (names, types, descriptions)
//   value          stored values of the columns in VALUE_COLUMNS, incl. item titles
//   glossary       the semantic layer's business terms
//   example        verified question -> SQL pairs (each one is run first; any failure stops the build)
// Embeds everything locally (gte-small) and replaces the table in one
// transaction. Rerun after changing the schema, the semantic layer or the examples.

import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { closePool, runSelect } from "../src/lib/agent/db.ts";
import { embed, toVector } from "../src/lib/agent/embed.ts";
import { EXAMPLES } from "../src/lib/agent/examples.ts";
import { SCHEMA_CARD, SCHEMA_HASH } from "../src/lib/agent/schema-card.ts";
import { GLOSSARY, SEMANTIC_VERSION, VALUE_COLUMNS } from "../src/lib/agent/semantic-layer.ts";

process.loadEnvFile(fileURLToPath(new URL("../.env.local", import.meta.url)));

const ROLES = ["nlq_student", "nlq_admin"];
const rolesOf = (view) => SCHEMA_CARD.find((v) => v.name === view)?.roles ?? [];
// A role may retrieve an entry only if it can read every view the entry is about
const rolesForViews = (views) => ROLES.filter((r) => views.every((v) => rolesOf(v).includes(r)));
const viewsIn = (sql) => [...new Set([...sql.matchAll(/nlq\.(\w+)/g)].map((m) => m[1]))];

// 1. Every example must run
for (const ex of EXAMPLES) {
  const r = await runSelect(ex.sql, ex.role);
  if (!r.ok) throw new Error(`Example failed: "${ex.question}": ${r.error}`);
}
await closePool();
console.log(`${EXAMPLES.length} examples run OK`);

const db = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await db.connect();

// 2. Collect documents
const docs = [];
for (const v of SCHEMA_CARD) {
  docs.push({ kind: "view", roles: v.roles, view_name: v.name, content: `${v.name}: ${v.description}` });
  for (const c of v.columns) {
    docs.push({
      kind: "column", roles: v.roles, view_name: v.name, column_name: c.name,
      content: `${v.name}.${c.name} (${c.type})${c.description ? `: ${c.description}` : ""}`,
    });
  }
}
for (const col of VALUE_COLUMNS) {
  let values = col.values;
  if (!values) {
    const sql = col.titles
      ? `select lower(btrim(${col.column})) as v from nlq.${col.view} group by 1 order by count(*) desc`
      : `select distinct ${col.column}::text as v from nlq.${col.view} where ${col.column} is not null`;
    values = (await db.query(sql)).rows.map((r) => r.v).filter(Boolean);
  }
  for (const value of values) {
    docs.push({ kind: "value", roles: rolesOf(col.view), view_name: col.view, column_name: col.column, value, content: value, meta: col.titles ? { title: true } : {} });
  }
}
for (const g of GLOSSARY) {
  const roles = rolesForViews(g.views);
  if (roles.length) docs.push({ kind: "glossary", roles, content: `${g.terms.join(", ")}: ${g.meaning}`, meta: { terms: g.terms, meaning: g.meaning, views: g.views } });
}
for (const ex of EXAMPLES) {
  const views = viewsIn(ex.sql);
  docs.push({ kind: "example", roles: rolesForViews(views), content: ex.question, meta: { question: ex.question, sql: ex.sql, views } });
}

// 3. Embed (in batches)
const t0 = performance.now();
for (let i = 0; i < docs.length; i += 128) {
  const batch = docs.slice(i, i + 128);
  const vectors = await embed(batch.map((d) => d.content));
  batch.forEach((d, j) => (d.embedding = toVector(vectors[j])));
}
console.log(`embedded ${docs.length} documents in ${((performance.now() - t0) / 1000).toFixed(1)} s`);

// 4. Replace the index
const examplesHash = createHash("sha256").update(JSON.stringify(EXAMPLES)).digest("hex").slice(0, 8);
const indexVersion = `${SCHEMA_HASH}-${SEMANTIC_VERSION}-${examplesHash}`;
await db.query("begin");
await db.query("delete from ops.rag_docs");
for (let i = 0; i < docs.length; i += 300) {
  await db.query(
    `insert into ops.rag_docs (kind, roles, view_name, column_name, value, content, meta, embedding, index_version)
     select kind, array(select jsonb_array_elements_text(roles)), view_name, column_name, value, content,
            coalesce(meta, '{}'), embedding::extensions.vector, $2
     from jsonb_to_recordset($1::jsonb)
       as x(kind text, roles jsonb, view_name text, column_name text, value text, content text, meta jsonb, embedding text)`,
    [JSON.stringify(docs.slice(i, i + 300)), indexVersion],
  );
}
await db.query("commit");
const { rows } = await db.query("select kind, count(*)::int as n from ops.rag_docs group by 1 order by 1");
await db.end();
console.log(`index ${indexVersion}: ${rows.map((r) => `${r.n} ${r.kind}`).join(", ")}`);
