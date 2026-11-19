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
import type { DbRole, ViewCard } from "./types.ts";

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

// Postgres also calls a function through column syntax: alias.f is f(alias) when alias has no
// column f ("attribute notation"), with no FuncCall in the parse tree. These are the functions
// on the role's search path (pg_catalog; nlq has none) that take one composite, polymorphic or
// "any" argument, so alias.f could reach them. All are harmless, but they bypass the allowlist,
// so alias.<one of these> is refused unless it is a real column of some view.
// scripts/test-agent-guard.mjs checks this list against the live catalog.
export const ATTRIBUTE_FUNCTIONS = new Set(
  (
    "any_out anyarray_out anyarray_send anycompatible_out anycompatiblearray_out anycompatiblearray_send anycompatiblemultirange_out " +
    "anycompatiblenonarray_out anycompatiblerange_out anyelement_out anyenum_out anymultirange_out anynonarray_out anyrange_out array_dims " +
    "array_ndims array_out array_send array_shuffle array_to_json cardinality concat enum_first enum_last enum_out enum_range enum_send " +
    "hash_array hash_multirange hash_range hash_record hashenum isempty json_build_array json_build_object jsonb_build_array " +
    "jsonb_build_object lower lower_inc lower_inf multirange multirange_out multirange_send num_nonnulls num_nulls pg_collation_for " +
    "pg_column_compression pg_column_size pg_column_toast_chunk_id pg_ddl_command_out pg_ddl_command_send pg_typeof quote_literal " +
    "quote_nullable range_merge range_out range_send record_out record_send row_to_json shell_out to_json to_jsonb unknownout " +
    "unknownsend unnest upper upper_inc upper_inf void_out void_send"
  ).split(" "),
);
const VIEW_COLUMNS = new Set(SCHEMA_CARD.flatMap((v) => v.columns.map((c) => c.name)));

// ---- Size limits ------------------------------------------------------------------------
//
// A read-only role can still make Postgres allocate hundreds of MB inside the statement
// timeout by building one huge value (lpad('x', 250000000, 'y'), replace() of a replace(),
// string_agg over a cross product, a CTE chain that doubles a string at every level). The
// rules below keep every value within a modest bound; no gold query comes near them.
//
//   * leaves: string literals, pad lengths and format widths are at most 1000 characters;
//     generate_series literals at most 10000 (rows). The longest text in the data is ~500.
//   * size-multiplying functions (replace, regexp_replace, regexp_match, format, concat_ws,
//     array_to_string, string_agg, array_agg): the output can be a product of the inputs'
//     sizes (or of the row count), so their arguments must be "plain": no growing expression
//     and no column that was built by one (tracked through WITH queries and subqueries).
//     At most MAX_MULTIPLYING of them per query.
//   * additive growth (concat, ||, ARRAY[...], ROW(...)) is linear in the text of the query,
//     except when it reuses a built value: at most one reference to a built column per
//     expression, so nothing can double from one WITH level to the next.
//   * string_agg / array_agg: not as window functions (a running total is quadratic), and not
//     over a cross product or generate_series, so their rows are those of at most one view
//     joined on conditions (~24k rows at most today).
//   * more than MAX_CROSS_PRODUCT groups of multi-row relations with no join condition between
//     them at one query level is refused (single-row subqueries don't count).
//   * WITH RECURSIVE is refused: no gold query or example uses it, and it can grow a value or
//     a row set without bound.
const MAX_STRING = 1000;
const MAX_SERIES = 10000;
const MAX_MULTIPLYING = 4;
const MAX_CROSS_PRODUCT = 3;
const MULTIPLYING = new Set(["replace", "regexp_replace", "regexp_match", "format", "concat_ws", "array_to_string", "string_agg", "array_agg"]);
const ROW_AGGREGATES = new Set(["string_agg", "array_agg"]);
const AGGREGATES = new Set([
  "count", "sum", "avg", "min", "max", "stddev", "stddev_pop", "stddev_samp", "variance", "var_pop", "var_samp", "percentile_cont",
  "percentile_disc", "mode", "string_agg", "array_agg", "bool_and", "bool_or", "every", "corr", "covar_pop", "covar_samp", "regr_slope",
  "regr_intercept",
]);

// information_schema relations: not on the search path, but a WITH query must not pose as one
const INFORMATION_SCHEMA = new Set(
  (
    "administrable_role_authorizations applicable_roles attributes character_sets check_constraint_routine_usage check_constraints " +
    "collation_character_set_applicability collations column_column_usage column_domain_usage column_options column_privileges " +
    "column_udt_usage columns constraint_column_usage constraint_table_usage data_type_privileges domain_constraints domain_udt_usage " +
    "domains element_types enabled_roles foreign_data_wrapper_options foreign_data_wrappers foreign_server_options foreign_servers " +
    "foreign_table_options foreign_tables information_schema_catalog_name key_column_usage parameters referential_constraints " +
    "role_column_grants role_routine_grants role_table_grants role_udt_grants role_usage_grants routine_column_usage routine_privileges " +
    "routine_routine_usage routine_sequence_usage routine_table_usage routines schemata sequences sql_features sql_implementation_info " +
    "sql_parts sql_sizing table_constraints table_privileges tables transforms triggered_update_columns triggers udt_privileges " +
    "usage_privileges user_defined_types user_mapping_options user_mappings view_column_usage view_routine_usage view_table_usage views"
  ).split(" "),
);

// Casts that keep a UTC timestamp's UTC day: listed_at::timestamp::date is still the UTC day
const KEEPS_UTC_DAY = new Set(["timestamp", "timestamptz", "text", "varchar", "bpchar"]);

type Node = Record<string, unknown>;

function viewsFor(role: DbRole) {
  return new Set(SCHEMA_CARD.filter((v) => v.roles.includes(role)).map((v) => v.name));
}

function funcName(call: Node): { schema: string | null; name: string } {
  const parts = (call.funcname as Node[]).map((p) => (p.String as { sval: string }).sval.toLowerCase());
  return parts.length > 1 ? { schema: parts[0], name: parts[parts.length - 1] } : { schema: null, name: parts[0] };
}

// Visit every object or list in the parse tree, calling fn(key, value) for each property.
// fn returning false skips that value's subtree.
function walk(node: unknown, fn: (key: string, value: Node) => boolean | void) {
  if (Array.isArray(node)) {
    for (const item of node) walk(item, fn);
  } else if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      if (value && typeof value === "object" && fn(key, value as Node) === false) continue;
      walk(value, fn);
    }
  }
}

// The names in a list of String nodes (undefined for anything else, such as *)
const strings = (list: unknown) => ((list as Node[] | undefined) ?? []).map((f) => (f.String as { sval: string } | undefined)?.sval);
const castTarget = (cast: Node) => strings((cast.typeName as { names: Node[] }).names).at(-1);

// A number literal's value, or null for anything else
function numberLiteral(node: unknown): number | null {
  const c = (node as Node | undefined)?.A_Const as Node | undefined;
  if (c?.ival) return (c.ival as { ival?: number }).ival ?? 0;
  if (c?.fval) return Number((c.fval as { fval: string }).fval);
  return null;
}
const stringLiteral = (node: unknown) => (((node as Node | undefined)?.A_Const as Node | undefined)?.sval as { sval?: string } | undefined)?.sval ?? null;
const isIntegerLiteral = (node: unknown) => Number.isInteger(numberLiteral(node));

// Arguments of an allowed function that set the size of its result
function sizeProblems(name: string, call: Node): string[] {
  const args = (call.args as Node[] | undefined) ?? [];
  if (name === "lpad" || name === "rpad") {
    const length = numberLiteral(args[1]);
    if (args[1] !== undefined && (length === null || Math.abs(length) > MAX_STRING)) return [`${name}() needs a plain number of at most ${MAX_STRING} as its length.`];
  } else if (name === "generate_series") {
    if (args.some((a) => Math.abs(numberLiteral(a) ?? 0) > MAX_SERIES)) return [`Number arguments of generate_series() are limited to ${MAX_SERIES}.`];
  } else if (name === "format") {
    // %[position$][flags][width]type: a width must be a literal number within the cap
    const template = stringLiteral(args[0]);
    const widths = template === null ? null : [...template.matchAll(/%([^a-zA-Z%]*)[a-zA-Z%]/g)].map((m) => m[1].replace(/^\d+\$/, "").replace(/^-+/, ""));
    if (!widths || widths.some((w) => w.includes("*") || (/^\d+$/.test(w) && Number(w) > MAX_STRING))) {
      return [`format() needs a literal format string with widths of at most ${MAX_STRING}.`];
    }
  }
  return [];
}

// An expression node that builds a bigger value out of its parts
function isGrowing(key: string, value: Node) {
  if (key === "FuncCall") {
    const { name } = funcName(value);
    return name === "concat" || MULTIPLYING.has(name);
  }
  if (key === "A_Expr") return strings(value.name).at(-1) === "||";
  return key === "A_ArrayExpr" || key === "RowExpr";
}

// ---- Names, resolved scope by scope ---------------------------------------------------
//
// A WITH query's name is visible only inside the SELECT that defines it: to the later WITH
// queries of the same list, its FROM, its expressions and their subqueries. Anywhere else
// the same name is a real relation and must be an allowed view. Likewise a qualifier ("l" in
// l.title) is looked up from the innermost query level outwards, so "l" can be a view inside
// a WITH query and that WITH query outside it.

// utc: a UTC timestamp (or a cast keeping its UTC day); grown: built by a growing expression
type Column = { name: string; utc: boolean; grown: boolean };
// What a FROM item or a SELECT gives: its columns (null: unknown), whether any of its values
// may have been built by a growing expression, whether it is at most one row, and whether its
// rows are a cross product (or generate_series)
type Rel = { columns: Column[] | null; mayGrow: boolean; singleRow: boolean; multiplied: boolean };
type Source = Rel & { name: string | null; view?: ViewCard; leaf: boolean };
type Level = { sources: Source[]; parent: Level | null; group: number[]; multiplied: boolean };
type Ctes = { names: Map<string, Rel>; parent: Ctes | null };
type Ctx = { ctes: Ctes | null; level: Level | null };

const entry = (node: unknown) => Object.entries(node as Node)[0] as [string, Node];
const UNKNOWN: Rel = { columns: null, mayGrow: true, singleRow: false, multiplied: true };
const grownSource = (s: Source) => (s.columns ? s.columns.some((c) => c.grown) : s.mayGrow);

// Output columns renamed by an alias column list: WITH x(a, b) / (select ...) s(a, b)
function renamed(columns: Column[] | null, names: Node[] | undefined): Column[] | null {
  if (!names?.length) return columns;
  if (!columns || columns.length < names.length) return null;
  const list = strings(names);
  return columns.map((c, i) => (i < list.length ? { ...c, name: list[i] ?? c.name } : c));
}

function hasColumnRef(node: unknown) {
  let found = false;
  walk(node, (key) => {
    if (key === "ColumnRef") found = true;
  });
  return found;
}

class Resolver {
  problems: string[] = [];
  rangeVars = 0; // RangeVars checked, compared with the total as a safety net
  private allowedViews: Set<string>;
  private rels = new WeakMap<Node, Rel>(); // each SELECT analysed so far

  // (no parameter properties: scripts run this file with Node's type stripping)
  constructor(allowedViews: Set<string>) {
    this.allowedViews = allowedViews;
  }

  private cte(name: string, ctes: Ctes | null): Rel | null {
    for (let c = ctes; c; c = c.parent) if (c.names.has(name)) return c.names.get(name)!;
    return null;
  }

  // A WITH query named like a system relation or a view this role can't see is refused outright
  private checkCteName(name: string) {
    const hiddenView = SCHEMA_CARD.some((v) => v.name === name) && !this.allowedViews.has(name);
    if (name.startsWith("pg_") || name.startsWith("_pg_") || INFORMATION_SCHEMA.has(name) || hiddenView) {
      this.problems.push(`WITH query name "${name}" is reserved (it names a system relation or a view you can't query); pick another name.`);
    }
  }

  // Add a FROM leaf to the level; returns its index
  private addLeaf(level: Level | null, source: Source) {
    if (!level) return [];
    level.sources.push(source);
    level.group.push(level.sources.length - 1);
    return [level.sources.length - 1];
  }

  private root(level: Level, i: number): number {
    while (level.group[i] !== i) i = level.group[i] = level.group[level.group[i]];
    return i;
  }

  private union(level: Level | null, indexes: Iterable<number>) {
    if (!level) return;
    let first: number | null = null;
    for (const i of indexes) {
      if (first === null) first = this.root(level, i);
      else level.group[this.root(level, i)] = first;
    }
  }

  private rangeVar(rv: Node, ctx: Ctx): number[] {
    this.rangeVars++;
    const schema = rv.schemaname as string | undefined;
    const name = rv.relname as string;
    const alias = rv.alias as { aliasname?: string; colnames?: Node[] } | undefined;
    const cte = schema ? null : this.cte(name, ctx.ctes);
    let source: Source;
    if (rv.catalogname || (schema && schema !== "nlq")) {
      this.problems.push(`Only nlq views can be queried; ${schema ? `${schema}.` : ""}${name} is not allowed.`);
      return [];
    } else if (cte) {
      source = { ...cte, name, leaf: true }; // a WITH query in scope
    } else if (!this.allowedViews.has(name)) {
      this.problems.push(`Unknown view "${name}". Views you can query: ${[...this.allowedViews].join(", ")}.`);
      return [];
    } else {
      const view = SCHEMA_CARD.find((v) => v.name === name)!;
      const columns = view.columns.map((c) => ({ name: c.name, utc: c.type === "timestamptz", grown: false }));
      source = { name, columns, view, mayGrow: false, singleRow: false, multiplied: false, leaf: true };
    }
    if (alias?.aliasname) source.name = alias.aliasname;
    if (alias?.colnames) source = { ...source, columns: null, view: undefined }; // columns renamed: not checked
    return this.addLeaf(ctx.level, source);
  }

  // The sources called `qualifier` at the innermost level that has any
  private sourcesNamed(qualifier: string, level: Level | null) {
    for (let l = level; l; l = l.parent) {
      const found = l.sources.filter((s) => s.name === qualifier);
      if (found.length) return found;
    }
    return [];
  }

  // Is this column reference a UTC timestamp? An unqualified name is looked up level by
  // level; a level with a source of unknown columns ends the search (can't tell).
  private isUtcColumn(fields: (string | undefined)[], level: Level | null): boolean {
    const column = fields.at(-1);
    if (!column || fields.some((f) => f === undefined)) return false;
    if (fields.length > 1) {
      return this.sourcesNamed(fields.at(-2)!, level).some((s) => s.columns?.some((c) => c.name === column && c.utc));
    }
    for (let l = level; l; l = l.parent) {
      const having = l.sources.filter((s) => s.columns?.some((c) => c.name === column));
      if (having.length) return having.some((s) => s.columns!.some((c) => c.name === column && c.utc));
      if (l.sources.some((s) => s.columns === null)) return false;
    }
    return false;
  }

  // Does this expression carry a UTC day: a UTC timestamp column, through casts that keep it?
  private isUtc(expr: unknown, level: Level | null): boolean {
    let node = expr as Node | undefined;
    while (node?.TypeCast && KEEPS_UTC_DAY.has(castTarget(node.TypeCast as Node) ?? "")) node = (node.TypeCast as Node).arg as Node;
    const ref = node?.ColumnRef as Node | undefined;
    return ref ? this.isUtcColumn(strings(ref.fields), level) : false;
  }

  // May this column reference be a value built by a growing expression? Unknown means yes.
  private isGrownRef(ref: Node, level: Level | null): boolean {
    const raw = ref.fields as Node[];
    const fields = strings(raw);
    if (raw.at(-1)?.A_Star) {
      const from = fields.length > 1 ? this.sourcesNamed(fields.at(-2)!, level) : (level?.sources ?? []);
      return from.some(grownSource);
    }
    const column = fields.at(-1);
    if (!column || fields.some((f) => f === undefined)) return true;
    const grownIn = (s: Source) => (s.columns ? s.columns.some((c) => c.name === column && c.grown) : s.mayGrow);
    if (fields.length > 1) return this.sourcesNamed(fields.at(-2)!, level).some(grownIn);
    for (let l = level; l; l = l.parent) {
      const candidates = l.sources.filter((s) => s.columns === null || s.columns.some((c) => c.name === column));
      if (candidates.length) return candidates.some(grownIn);
    }
    return false;
  }

  // Growing expressions and references to grown values inside an expression (subqueries
  // count as one reference, grown if what they return may be)
  private growthIn(node: unknown, level: Level | null) {
    const out = { nodes: 0, grownRefs: 0 };
    walk(node, (key, value) => {
      if (key === "SelectStmt") {
        if (this.rels.get(value)?.mayGrow ?? true) out.grownRefs++;
        return false;
      }
      if (key === "ColumnRef") {
        if (this.isGrownRef(value, level)) out.grownRefs++;
        return false;
      }
      if (isGrowing(key, value)) out.nodes++;
    });
    return out;
  }

  private grows(node: unknown, level: Level | null) {
    const g = this.growthIn(node, level);
    return g.nodes > 0 || g.grownRefs > 0;
  }

  // Size rules for one growing expression (its children were visited first)
  private checkGrowth(key: string, value: Node, ctx: Ctx) {
    if (key === "FuncCall") {
      const { name } = funcName(value);
      if (MULTIPLYING.has(name)) {
        if (((value.args as Node[] | undefined) ?? []).some((a) => this.grows(a, ctx.level))) {
          this.problems.push(
            `${name}() can multiply the size of its input, so its arguments can't use concat, ||, ARRAY[], replace, format, string_agg or similar, or a column built with them.`,
          );
        }
        if (ROW_AGGREGATES.has(name) && value.over) this.problems.push(`${name}() can't be used as a window function.`);
        if (ROW_AGGREGATES.has(name) && ctx.level?.multiplied) {
          this.problems.push(`${name}() over a cross product (tables without a join condition) or generate_series is not allowed.`);
        }
        return;
      }
    }
    if (this.growthIn(value, ctx.level).grownRefs > 1) {
      this.problems.push("A value built with concat, ||, ARRAY[], string_agg or similar can be used at most once per expression that builds a bigger one.");
    }
  }

  // alias.column (or nlq.view.column) on a known view: the column must exist.
  // Unqualified columns, and qualifiers naming a WITH query or subquery, are left to Postgres.
  private columnRef(ref: Node, ctx: Ctx) {
    const fields = strings(ref.fields);
    if (fields.length < 2 || fields.some((f) => f === undefined)) return;
    const [qualifier, column] = fields.slice(-2) as [string, string];
    const found = this.sourcesNamed(qualifier, ctx.level);
    if (!found.length || found.some((s) => !s.view)) return;
    if (!found.some((s) => s.view!.columns.some((c) => c.name === column))) {
      const v = found[0].view!;
      this.problems.push(`Column ${qualifier}.${column} does not exist in ${v.name}. Its columns: ${v.columns.map((c) => c.name).join(", ")}.`);
    }
  }

  // A UTC timestamp cast to a date gives the UTC day, not Boston's: a silent
  // off-by-one-day bug next to the Boston-local *_on columns
  private typeCast(cast: Node, ctx: Ctx) {
    if (castTarget(cast) !== "date" || !this.isUtc(cast.arg, ctx.level)) return;
    let node = cast.arg as Node;
    while (node.TypeCast) node = (node.TypeCast as Node).arg as Node;
    const column = strings((node.ColumnRef as Node).fields).at(-1);
    this.problems.push(`${column} is a UTC timestamp, so ${column}::date is the UTC day. Use (${column} at time zone 'America/New_York')::date, or the view's Boston-local *_on date column.`);
  }

  // A FROM item: checked, its sources added to ctx.level. Returns the leaves it added.
  private fromItem(key: string, value: Node, ctx: Ctx): number[] {
    const level = ctx.level;
    const before = level ? level.sources.map((_, i) => i).filter((i) => level.sources[i].leaf) : [];
    if (key === "RangeVar") return this.rangeVar(value, ctx);
    if (key === "JoinExpr") {
      const leaves = [...this.fromItem(...entry(value.larg), ctx), ...this.fromItem(...entry(value.rarg), ctx)];
      this.visitRest(value, ["larg", "rarg"], ctx);
      if ((value.quals && hasColumnRef(value.quals)) || value.usingClause || value.isNatural) this.union(level, leaves);
      const alias = (value.alias as { aliasname?: string } | undefined)?.aliasname;
      if (alias && level) {
        const parts = leaves.map((i) => level.sources[i]);
        level.sources.push({ ...UNKNOWN, mayGrow: parts.some(grownSource), name: alias, leaf: false });
        level.group.push(level.sources.length - 1);
      }
      return leaves;
    }
    if (key === "RangeSubselect") {
      const subquery = value.subquery as Node;
      const rel = subquery.SelectStmt ? this.select(subquery.SelectStmt as Node, ctx) : (this.visit(subquery, ctx), UNKNOWN);
      this.visitRest(value, ["subquery"], ctx);
      const alias = value.alias as { aliasname?: string; colnames?: Node[] } | undefined;
      const added = this.addLeaf(level, { ...rel, columns: renamed(rel.columns, alias?.colnames), name: alias?.aliasname ?? null, leaf: true });
      if (value.lateral) this.union(level, [...before, ...added]); // correlated with what precedes it
      return added;
    }
    if (key === "RangeFunction") {
      this.visit(value, ctx);
      const calls = ((value.functions as Node[] | undefined) ?? []).map((f) => ((f.List as { items: Node[] }).items[0] as Node).FuncCall as Node | undefined);
      // generate_series makes rows out of nothing: bounded only with integer literal arguments
      const multiplied = calls.some((c) => !c || (funcName(c).name === "generate_series" && !((c.args as Node[] | undefined) ?? []).every(isIntegerLiteral)));
      const name = (value.alias as { aliasname?: string } | undefined)?.aliasname ?? null;
      const added = this.addLeaf(level, { columns: null, mayGrow: this.grows(value.functions, level), singleRow: false, multiplied, name, leaf: true });
      if (hasColumnRef(value.functions)) this.union(level, [...before, ...added]); // functions in FROM are implicitly LATERAL
      return added;
    }
    this.visit({ [key]: value }, ctx);
    return [];
  }

  // The leaves of this level an expression's columns refer to (not looking into subqueries)
  private leavesReferenced(expr: unknown, level: Level) {
    const out = new Set<number>();
    walk(expr, (key, value) => {
      if (key === "SelectStmt") return false;
      if (key !== "ColumnRef") return;
      const fields = strings(value.fields);
      const column = fields.at(-1);
      level.sources.forEach((s, i) => {
        if (!s.leaf) return;
        if (fields.length > 1 ? s.name === fields.at(-2) : !!column && !!s.columns?.some((c) => c.name === column)) out.add(i);
      });
    });
    return out;
  }

  // WHERE conditions comparing columns of two FROM items join them (a, b where a.x = b.y)
  private joinByWhere(where: unknown, level: Level) {
    walk(where, (key, value) => {
      if (key === "SelectStmt") return false;
      if (key !== "A_Expr") return;
      const [left, right] = [this.leavesReferenced(value.lexpr, level), this.leavesReferenced(value.rexpr, level)];
      if (left.size && right.size) this.union(level, [...left, ...right]);
    });
  }

  // Visit every property of node except the ones already handled
  private visitRest(node: Node, handled: string[], ctx: Ctx) {
    for (const [key, value] of Object.entries(node)) if (!handled.includes(key)) this.visit(value, ctx);
  }

  // Any part of the tree. A SELECT opens a new scope; FROM items, column references, casts
  // and growing expressions are checked where they are found; everything else is searched.
  visit(node: unknown, ctx: Ctx) {
    if (Array.isArray(node)) {
      for (const item of node) this.visit(item, ctx);
      return;
    }
    if (!node || typeof node !== "object") return;
    for (const [key, value] of Object.entries(node)) {
      if (!value || typeof value !== "object") continue;
      const v = value as Node;
      if (key === "SelectStmt") this.select(v, ctx);
      else if (key === "RangeVar" || key === "JoinExpr" || key === "RangeSubselect" || key === "RangeFunction") this.fromItem(key, v, ctx);
      else if (key === "ColumnRef") this.columnRef(v, ctx);
      else {
        if (key === "TypeCast") this.typeCast(v, ctx);
        this.visit(v, ctx);
        if (isGrowing(key, v)) this.checkGrowth(key, v, ctx);
      }
    }
  }

  // At most one row: an aggregate without GROUP BY, LIMIT 0/1, or no FROM (and no set-returning call)
  private isSingleRow(stmt: Node) {
    const limit = numberLiteral(stmt.limitCount);
    if (limit !== null && limit <= 1) return true;
    if (stmt.groupClause) return false;
    let aggregate = false;
    let setReturning = false;
    walk([stmt.targetList, stmt.havingClause], (key, value) => {
      if (key === "SelectStmt") return false;
      if (key !== "FuncCall") return;
      const { name } = funcName(value);
      if (AGGREGATES.has(name) && !value.over) aggregate = true;
      if (ALLOWED_FROM_FUNCTIONS.has(name)) setReturning = true;
    });
    return !setReturning && (aggregate || !stmt.fromClause);
  }

  // A SELECT (plain, set operation or VALUES), its WITH queries first
  select(stmt: Node, outer: Ctx): Rel {
    const rel = this.selectRel(stmt, outer);
    this.rels.set(stmt, rel);
    return rel;
  }

  private selectRel(stmt: Node, outer: Ctx): Rel {
    let ctes = outer.ctes;
    const withClause = stmt.withClause as { ctes?: Node[]; recursive?: boolean } | undefined;
    if (withClause) {
      ctes = { names: new Map(), parent: outer.ctes };
      const defs = (withClause.ctes ?? []).map((c) => c.CommonTableExpr as Node);
      for (const def of defs) this.checkCteName(def.ctename as string);
      // (WITH RECURSIVE is refused; its names are still scoped as Postgres would)
      if (withClause.recursive) for (const def of defs) ctes.names.set(def.ctename as string, UNKNOWN);
      // Without RECURSIVE a WITH query sees only those before it: a name defined later is a real relation
      const inner: Ctx = { ctes, level: outer.level };
      for (const def of defs) {
        const body = (def.ctequery as Node).SelectStmt as Node | undefined;
        const rel = body ? this.select(body, inner) : (this.visit(def.ctequery, inner), UNKNOWN);
        this.visitRest(def, ["ctequery"], inner);
        ctes.names.set(def.ctename as string, { ...rel, columns: renamed(rel.columns, def.aliascolnames as Node[] | undefined) });
      }
    }

    if (stmt.op && stmt.op !== "SETOP_NONE") {
      const left = this.select(stmt.larg as Node, { ctes, level: outer.level });
      const right = this.select(stmt.rarg as Node, { ctes, level: outer.level });
      const columns =
        left.columns && right.columns && left.columns.length === right.columns.length
          ? left.columns.map((c, i) => ({ name: c.name, utc: c.utc || right.columns![i].utc, grown: c.grown || right.columns![i].grown }))
          : null;
      const rel: Rel = { columns, mayGrow: left.mayGrow || right.mayGrow, singleRow: false, multiplied: left.multiplied || right.multiplied };
      // ORDER BY / LIMIT of a set operation see only its output columns
      const level: Level = { sources: [{ ...rel, name: null, leaf: false }], parent: outer.level, group: [0], multiplied: false };
      this.visitRest(stmt, ["withClause", "larg", "rarg"], { ctes, level });
      return rel;
    }

    const level: Level = { sources: [], parent: outer.level, group: [], multiplied: false };
    const ctx: Ctx = { ctes, level };
    for (const item of (stmt.fromClause as Node[] | undefined) ?? []) this.fromItem(...entry(item), ctx);

    // Groups of FROM items joined by conditions; several unrelated multi-row groups are a cross product
    this.joinByWhere(stmt.whereClause, level);
    const leaves = level.sources.map((s, i) => [s, i] as const).filter(([s]) => s.leaf && !s.singleRow);
    const groups = new Set(leaves.map(([, i]) => this.root(level, i))).size;
    if (groups > MAX_CROSS_PRODUCT) {
      this.problems.push(`${groups} tables are combined without join conditions between them (a cross product); join them on matching columns.`);
    }
    level.multiplied = groups > 1 || leaves.some(([s]) => s.multiplied);

    this.visitRest(stmt, ["withClause", "fromClause"], ctx);
    const singleRow = this.isSingleRow(stmt);
    // generate_series in the SELECT list multiplies rows too, unless its bounds are literals
    let unboundedSeries = false;
    walk(stmt.targetList, (key, value) => {
      if (key === "SelectStmt") return false;
      if (key === "FuncCall" && funcName(value).name === "generate_series" && !((value.args as Node[] | undefined) ?? []).every(isIntegerLiteral)) unboundedSeries = true;
    });
    const multiplied = (level.multiplied || unboundedSeries) && !singleRow;
    if (stmt.valuesLists) return { columns: null, mayGrow: this.grows(stmt.valuesLists, level), singleRow: false, multiplied: false };

    const columns: Column[] = [];
    let known = true;
    for (const target of (stmt.targetList as Node[] | undefined) ?? []) {
      const rt = target.ResTarget as Node;
      const val = rt.val as Node | undefined;
      const ref = val?.ColumnRef as Node | undefined;
      const fields = ref ? strings(ref.fields) : [];
      if (ref && (ref.fields as Node[]).at(-1)?.A_Star) {
        // * or alias.*: the columns of those sources, if known
        const from = fields.length > 1 ? this.sourcesNamed(fields.at(-2)!, level) : level.sources.filter((s) => s.leaf);
        if (!from.length || from.some((s) => s.columns === null)) known = false;
        else columns.push(...from.flatMap((s) => s.columns!));
        continue;
      }
      const name = (rt.name as string | undefined) ?? fields.at(-1) ?? (val?.FuncCall ? funcName(val.FuncCall as Node).name : "?column?");
      columns.push({ name, utc: this.isUtc(val, level), grown: this.grows(val, level) });
    }
    if (!known) return { columns: null, mayGrow: this.grows(stmt.targetList, level), singleRow, multiplied };
    return { columns, mayGrow: columns.some((c) => c.grown), singleRow, multiplied };
  }
}

type Parsed = { stmts?: { stmt: Node; stmt_location?: number; stmt_len?: number }[] };

// The statement's own text, without leading comments, its trailing semicolon(s) or anything
// after them ("; -- note", ";;"). Parser locations are byte offsets into the UTF-8 text.
function statementText(sql: string, stmt: { stmt_location?: number; stmt_len?: number }) {
  const bytes = new TextEncoder().encode(sql);
  const start = stmt.stmt_location ?? 0;
  const end = stmt.stmt_len ? start + stmt.stmt_len : bytes.length;
  return new TextDecoder().decode(bytes.subarray(start, end)).trim();
}

// A parse tree without source locations, to compare two parses of the same statement
const shape = (node: unknown) => JSON.stringify(node, (key, value) => (key === "location" ? undefined : value));

// What the cache needs to know about a (checked) query, from the parse tree, not the text
// (U&"\006dy_deals" is my_deals too):
//   personal       it reads a my_* view, so it only ever applies to the student who asked
//   literalOutput  a SELECT list contains a string constant, so the result can carry text
//                  the model chose ("visit ..."); such SQL is not shared with other students
// Unparseable SQL counts as both.
export async function sqlTraits(sql: string): Promise<{ personal: boolean; literalOutput: boolean }> {
  let tree: Parsed;
  try {
    tree = (await parse(sql)) as unknown as Parsed;
  } catch {
    return { personal: true, literalOutput: true };
  }
  let personal = false;
  let literalOutput = false;
  walk(tree.stmts ?? [], (key, value) => {
    if (key === "RangeVar" && /^my_/i.test(String(value.relname ?? ""))) personal = true;
    if (key === "targetList") {
      walk(value, (k, v) => {
        if (k === "A_Const" && v.sval !== undefined) literalOutput = true;
      });
    }
  });
  return { personal, literalOutput };
}

export async function checkSql(input: string, role: DbRole): Promise<GuardResult> {
  const trimmed = input.trim().replace(/;\s*$/, "").trim();
  if (!trimmed) return { ok: false, error: "Empty query." };
  if (trimmed.length > MAX_SQL_LENGTH) return { ok: false, error: `Query is too long (max ${MAX_SQL_LENGTH} characters).` };

  let tree: Parsed;
  try {
    tree = (await parse(trimmed)) as unknown as Parsed;
  } catch (e) {
    return { ok: false, error: `Syntax error: ${(e as Error).message}` };
  }
  const stmts = tree.stmts ?? [];
  if (stmts.length !== 1) return { ok: false, error: "Send exactly one SELECT statement." };
  if (!("SelectStmt" in stmts[0].stmt)) {
    return { ok: false, error: "Only SELECT queries are allowed; the data is read-only." };
  }

  // db.ts runs the SQL as a subquery, so return exactly the one statement that was checked
  const sql = statementText(trimmed, stmts[0]);
  const again = ((await parse(sql).catch(() => null)) ?? {}) as Parsed;
  if (again.stmts?.length !== 1 || shape(again.stmts[0].stmt) !== shape(stmts[0].stmt)) {
    return { ok: false, error: "Send exactly one SELECT statement." };
  }

  const allowedViews = viewsFor(role);
  const problems: string[] = [];
  let rangeVars = 0;
  let multiplying = 0;
  walk(stmts, (key, value) => {
    if (key.endsWith("Stmt") && key !== "SelectStmt") {
      problems.push("Only SELECT is allowed, including inside WITH.");
    } else if (key === "intoClause") {
      problems.push("SELECT INTO is not allowed.");
    } else if (key === "lockingClause") {
      problems.push("FOR UPDATE / FOR SHARE is not allowed.");
    } else if (key === "withClause" && value.recursive) {
      problems.push("WITH RECURSIVE is not allowed.");
    } else if (key === "RangeVar") {
      rangeVars++;
    } else if (key === "A_Indirection") {
      // (expr).name / (expr).*: field selection, which can also call a function ((row).f is f(row))
      if (((value.indirection as Node[] | undefined) ?? []).some((i) => i.String || i.A_Star)) {
        problems.push("Field selection like (expr).name or (expr).* is not allowed; select columns as alias.column.");
      }
    } else if (key === "ColumnRef") {
      const fields = strings(value.fields);
      const last = fields.at(-1)?.toLowerCase();
      if (fields.length > 1 && last && ATTRIBUTE_FUNCTIONS.has(last) && !VIEW_COLUMNS.has(last)) {
        problems.push(`${fields.join(".")} is not a column (Postgres would call the function ${last}() on the row). Name your columns differently.`);
      }
    } else if (key === "A_Const" && (stringLiteral({ A_Const: value })?.length ?? 0) > MAX_STRING) {
      problems.push(`String literals are limited to ${MAX_STRING} characters.`);
    } else if (key === "FuncCall") {
      const { schema, name } = funcName(value);
      if (schema && schema !== "pg_catalog") {
        problems.push(`Function ${schema}.${name}() is not allowed.`);
      } else if (!ALLOWED_FUNCTIONS.has(name)) {
        problems.push(`Function ${name}() is not allowed.`);
      } else {
        problems.push(...sizeProblems(name, value));
        if (MULTIPLYING.has(name)) multiplying++;
      }
    } else if (key === "RangeFunction") {
      for (const fn of (value.functions as Node[]) ?? []) {
        const call = ((fn.List as { items: Node[] }).items[0] as Node).FuncCall as Node | undefined;
        const name = call ? funcName(call).name : "?";
        if (!ALLOWED_FROM_FUNCTIONS.has(name)) problems.push(`${name}() is not allowed in FROM.`);
      }
    }
  });
  if (multiplying > MAX_MULTIPLYING) {
    problems.push(`At most ${MAX_MULTIPLYING} calls to replace, regexp_replace, regexp_match, format, concat_ws, array_to_string, string_agg or array_agg per query.`);
  }

  // Views, WITH queries, qualified columns, UTC casts and value sizes, resolved scope by scope.
  // Every relation in the tree must have been checked there (fail closed if one was missed).
  const resolver = new Resolver(allowedViews);
  resolver.visit(stmts[0].stmt, { ctes: null, level: null });
  problems.push(...resolver.problems);
  if (resolver.rangeVars !== rangeVars) problems.push("Could not check every relation in the query; simplify it.");

  if (problems.length) return { ok: false, error: [...new Set(problems)].join(" ") };
  return { ok: true, sql };
}
