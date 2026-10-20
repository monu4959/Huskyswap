// SQL guard: every query the model writes passes through here before it can run.
//
// It parses the SQL with PostgreSQL's own parser (libpg-query, WebAssembly) and
// accepts only a single SELECT that reads nlq views the role may see, using
// functions from an allowlist. The database login (nlq_agent, read-only,
// nlq-only) is the real boundary; this layer turns mistakes and attacks into
// clear error messages the model can learn from, and blocks the few things a
// read-only role can still do (sleep, read settings, call app functions).

import { parse } from "libpg-query";
import { SCHEMA_CARD } from "./schema-card.ts";
import type { DbRole } from "./types.ts";

export type GuardResult = { ok: true; sql: string } | { ok: false; error: string };

const MAX_SQL_LENGTH = 8000;

// Scalar, aggregate and window functions a reporting query needs. Anything else
// (pg_sleep, set_config, current_setting, dblink, pg_read_file, app functions…)
// is rejected. Some SQL syntax parses into pg_catalog calls: EXTRACT, SUBSTRING,
// POSITION, TRIM, AT TIME ZONE (timezone), LIKE … ESCAPE (like_escape).
const ALLOWED_FUNCTIONS = new Set([
  // aggregates
  "count", "sum", "avg", "min", "max", "stddev", "stddev_pop", "stddev_samp", "variance", "var_pop",
  "var_samp", "percentile_cont", "percentile_disc", "mode", "string_agg", "array_agg", "bool_and",
  "bool_or", "every", "corr", "covar_pop", "covar_samp", "regr_slope", "regr_intercept",
  // window
  "row_number", "rank", "dense_rank", "percent_rank", "cume_dist", "ntile", "lag", "lead",
  "first_value", "last_value", "nth_value",
  // math
  "round", "floor", "ceil", "ceiling", "abs", "trunc", "power", "sqrt", "cbrt", "exp", "ln", "log",
  "log10", "mod", "sign", "div", "width_bucket",
  // dates and times
  "now", "date_trunc", "date_part", "extract", "age", "to_char", "to_date", "to_timestamp", "make_date",
  "make_time", "make_timestamp", "make_timestamptz", "make_interval", "justify_days", "justify_hours",
  "justify_interval", "date_bin", "timezone", "isfinite", "overlaps",
  // text
  "lower", "upper", "initcap", "length", "char_length", "character_length", "btrim", "ltrim", "rtrim",
  "substring", "substr", "position", "strpos", "replace", "concat", "concat_ws", "left", "right",
  "split_part", "lpad", "rpad", "reverse", "translate", "format", "starts_with", "regexp_replace",
  "regexp_match", "regexp_like", "regexp_count", "regexp_substr", "like_escape", "similar_to_escape",
  // arrays and sets
  "array_length", "cardinality", "array_position", "array_to_string", "string_to_array", "unnest",
  "generate_series", "num_nulls", "num_nonnulls",
]);

// Functions allowed in FROM (set-returning)
const ALLOWED_FROM_FUNCTIONS = new Set(["generate_series", "unnest"]);

type Node = Record<string, unknown>;

function viewsFor(role: DbRole) {
  return new Set(SCHEMA_CARD.filter((v) => v.roles.includes(role)).map((v) => v.name));
}

function funcName(call: Node): { schema: string | null; name: string } {
  const parts = (call.funcname as Node[]).map((p) => (p.String as { sval: string }).sval.toLowerCase());
  return parts.length > 1 ? { schema: parts[0], name: parts[parts.length - 1] } : { schema: null, name: parts[0] };
}

// Visit every object or list in the parse tree, calling fn(key, value) for each property
function walk(node: unknown, fn: (key: string, value: Node) => void) {
  if (Array.isArray(node)) {
    for (const item of node) walk(item, fn);
  } else if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      if (value && typeof value === "object") fn(key, value as Node);
      walk(value, fn);
    }
  }
}

export async function checkSql(input: string, role: DbRole): Promise<GuardResult> {
  const sql = input.trim().replace(/;\s*$/, "").trim();
  if (!sql) return { ok: false, error: "Empty query." };
  if (sql.length > MAX_SQL_LENGTH) return { ok: false, error: `Query is too long (max ${MAX_SQL_LENGTH} characters).` };

  let tree: { stmts?: { stmt: Node }[] };
  try {
    tree = (await parse(sql)) as unknown as typeof tree;
  } catch (e) {
    return { ok: false, error: `Syntax error: ${(e as Error).message}` };
  }
  const stmts = tree.stmts ?? [];
  if (stmts.length !== 1) return { ok: false, error: "Send exactly one SELECT statement." };
  if (!("SelectStmt" in stmts[0].stmt)) {
    return { ok: false, error: "Only SELECT queries are allowed; the data is read-only." };
  }

  const allowedViews = viewsFor(role);
  const cteNames = new Set<string>();
  // alias (or bare view name) -> the nlq views it can stand for, to check qualified columns
  const aliases = new Map<string, Set<string>>();
  walk(stmts, (key, value) => {
    if (key === "CommonTableExpr") cteNames.add(value.ctename as string);
  });
  walk(stmts, (key, value) => {
    if (key !== "RangeVar") return;
    const name = value.relname as string;
    const schema = value.schemaname as string | undefined;
    if ((schema && schema !== "nlq") || (!schema && cteNames.has(name)) || !allowedViews.has(name)) return;
    const alias = (value.alias as { aliasname?: string } | undefined)?.aliasname ?? name;
    if (!aliases.has(alias)) aliases.set(alias, new Set());
    aliases.get(alias)!.add(name);
  });

  const problems: string[] = [];
  walk(stmts, (key, value) => {
    if (key.endsWith("Stmt") && key !== "SelectStmt") {
      problems.push("Only SELECT is allowed, including inside WITH.");
    } else if (key === "intoClause") {
      problems.push("SELECT INTO is not allowed.");
    } else if (key === "lockingClause") {
      problems.push("FOR UPDATE / FOR SHARE is not allowed.");
    } else if (key === "RangeVar") {
      const schema = value.schemaname as string | undefined;
      const name = value.relname as string;
      if (value.catalogname || (schema && schema !== "nlq")) {
        problems.push(`Only nlq views can be queried; ${schema ? `${schema}.` : ""}${name} is not allowed.`);
      } else if (!schema && cteNames.has(name)) {
        // reference to a WITH query
      } else if (!allowedViews.has(name)) {
        problems.push(`Unknown view "${name}". Views you can query: ${[...allowedViews].join(", ")}.`);
      }
    } else if (key === "FuncCall") {
      const { schema, name } = funcName(value);
      if (schema && schema !== "pg_catalog") {
        problems.push(`Function ${schema}.${name}() is not allowed.`);
      } else if (!ALLOWED_FUNCTIONS.has(name)) {
        problems.push(`Function ${name}() is not allowed.`);
      }
    } else if (key === "ColumnRef") {
      // alias.column (or nlq.view.column) on a known view: the column must exist.
      // Unqualified columns are left to Postgres, which reports them precisely.
      const fields = (value.fields as Node[]).map((f) => (f.String as { sval: string } | undefined)?.sval);
      if (fields.length < 2 || fields.some((f) => f === undefined)) return;
      const [qualifier, column] = fields.slice(-2) as [string, string];
      const views = aliases.get(qualifier);
      if (!views) return;
      const known = [...views].map((v) => SCHEMA_CARD.find((c) => c.name === v)!);
      if (!known.some((v) => v.columns.some((c) => c.name === column))) {
        const v = known[0];
        problems.push(`Column ${qualifier}.${column} does not exist in ${v.name}. Its columns: ${v.columns.map((c) => c.name).join(", ")}.`);
      }
    } else if (key === "RangeFunction") {
      for (const fn of (value.functions as Node[]) ?? []) {
        const call = ((fn.List as { items: Node[] }).items[0] as Node).FuncCall as Node | undefined;
        const name = call ? funcName(call).name : "?";
        if (!ALLOWED_FROM_FUNCTIONS.has(name)) problems.push(`${name}() is not allowed in FROM.`);
      }
    }
  });

  if (problems.length) return { ok: false, error: [...new Set(problems)].join(" ") };
  return { ok: true, sql };
}
