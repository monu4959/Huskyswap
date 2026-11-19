// Execution-accuracy comparison: does a predicted query return the same answer
// as the gold query? Compares results, not SQL text.
//
//   * columns are matched by their values, not names or positions; the
//     prediction may have extra columns but must contain every gold column
//   * numbers are compared at the precision both sides share (11.1 = 11.11),
//     and a percentage column may match a fraction column (61.6 = 0.616)
//   * text is compared case-insensitively; category labels match their codes
//     ("Dorm essentials" = dorm_essentials); a first-of-month date matches its
//     month ("2025-04-01" = "2025-04"), and, when all the dates fall in one
//     year, that month's name or number ("April", 4)
//   * a gold answer of one value per group in rows (weekend 0.19 / weekday 0.20)
//     matches a single row holding those values in columns
//   * row order matters only when orderMatters (top-N, "month by month")

import type { SqlResult } from "./types.ts";

type Ok = Extract<SqlResult, { ok: true }>;
// n: the value as a double (month numbers, integer checks); d: decimals written;
// x: the exact decimal, which is what gets rounded and compared
type Decimal = { neg: boolean; digits: bigint; scale: number }; // (-1)^neg * digits * 10^-scale
type Cell = null | string | { n: number; d: number; x: Decimal };

const CATEGORY_LABELS: Record<string, string> = {
  textbooks: "textbooks", electronics: "electronics", furniture: "furniture", kitchen: "kitchen",
  "dorm essentials": "dorm_essentials", clothing: "clothing", "sports & outdoors": "sports_outdoors",
  "bikes & transport": "bikes_transport", other: "other",
};

// A plain decimal string ("-12.50") as an exact decimal
function decimal(s: string): Decimal {
  const neg = s.startsWith("-");
  const [int, frac = ""] = s.replace(/^-/, "").split(".");
  return { neg, digits: BigInt(int + frac), scale: frac.length };
}

// A JS number as a plain decimal string: its shortest round-trip form, exponent expanded
function plain(v: number): string {
  const [mantissa, exp] = String(v).split("e");
  if (exp === undefined) return mantissa;
  const neg = mantissa.startsWith("-");
  const [int, frac = ""] = mantissa.replace(/^-/, "").split(".");
  const digits = int + frac;
  const point = int.length + Number(exp); // position of the decimal point in digits
  const body = point <= 0 ? `0.${"0".repeat(-point)}${digits}` : point >= digits.length ? digits + "0".repeat(point - digits.length) : `${digits.slice(0, point)}.${digits.slice(point)}`;
  return (neg ? "-" : "") + body;
}

function parse(value: unknown): Cell {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return String(value).toLowerCase();
    const s = plain(value);
    return { n: value, d: Number.isInteger(value) ? 0 : Math.min(s.split(".")[1]?.length ?? 0, 6), x: decimal(s) };
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  const s = String(value).trim();
  if (/^-?\d+(\.\d+)?$/.test(s)) return { n: Number(s), d: s.split(".")[1]?.length ?? 0, x: decimal(s) };
  let text = s.toLowerCase();
  text = text.replace(/^(\d{4}-\d{2}-\d{2})[ t]00:00:00(\+00|z)?$/, "$1"); // midnight timestamp -> date
  text = text.replace(/^(\d{4}-\d{2})-01$/, "$1"); // first of month -> month
  return CATEGORY_LABELS[text] ?? text;
}

const columnsOf = (r: Ok) => r.columns.map((c) => r.rows.map((row) => parse(row[c])));
const decimals = (col: Cell[]) => Math.max(0, ...col.map((c) => (c && typeof c === "object" ? c.d : 0)));

// x * factor (factor 1, 100 or 0.01) rounded to d decimals, half away from zero as
// Postgres' round(numeric) does, in exact decimal arithmetic: binary floating point
// would round 1.005 down (1.00499...) and could not tell bigints above 2^53 apart
const [ZERO, ONE, TWO, TEN] = [0, 1, 2, 10].map(BigInt); // no bigint literals: tsconfig targets ES2017
function roundScaled(x: Decimal, factor: number, d: number) {
  const scale = x.scale - Math.round(Math.log10(factor)); // * 100 moves the point two places right
  let q: bigint;
  if (scale <= d) q = x.digits * TEN ** BigInt(d - scale);
  else {
    const unit = TEN ** BigInt(scale - d);
    q = x.digits / unit;
    if (TWO * (x.digits % unit) >= unit) q += ONE;
  }
  const s = q.toString().padStart(d + 1, "0");
  const body = d ? `${s.slice(0, -d)}.${s.slice(-d)}` : s;
  return q !== ZERO && x.neg ? `-${body}` : body;
}

// A cell as a comparable string, at a given precision and scale
function canon(c: Cell, d: number, factor: number) {
  if (c === null) return "∅";
  if (typeof c === "object") return roundScaled(c.x, factor, d);
  return `s:${c}`;
}

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const isNumber = (c: Cell) => c !== null && typeof c === "object";

// A column of months (first-of-month dates within one year, month names, or month numbers) as m1..m12
function asMonths(col: Cell[]) {
  const years = new Set<string>();
  const out: string[] = [];
  for (const c of col) {
    if (c === null) return null;
    if (typeof c === "object") {
      if (!Number.isInteger(c.n) || c.n < 1 || c.n > 12) return null;
      out.push(`m${c.n}`);
      continue;
    }
    const ym = /^(\d{4})-(\d{2})$/.exec(c);
    if (ym) years.add(ym[1]);
    const month = ym ? Number(ym[2]) : MONTHS.indexOf(c) + 1;
    if (!month) return null;
    out.push(`m${month}`);
  }
  return years.size <= 1 ? out : null;
}

// The ways a predicted column can stand for a gold column: same scale, or percent vs fraction.
// Scaling moves the decimal point: a fraction written to 2 places (0.20) is a percentage to 0 (20).
function pairings(gold: Cell[], pred: Cell[]) {
  const ways = [1, 100, 0.01].map((factor) => {
    const predDecimals = Math.max(0, decimals(pred) - Math.round(Math.log10(factor)));
    const d = Math.min(decimals(gold), predDecimals, 4);
    return { d, factor, gold: gold.map((c) => canon(c, d, 1)), pred: pred.map((c) => canon(c, d, factor)) };
  });
  // The same months written differently (not two number columns: those must match as numbers)
  const [gm, pm] = [asMonths(gold), asMonths(pred)];
  if (gm && pm && !(gold.every(isNumber) && pred.every(isNumber))) ways.push({ d: 0, factor: 1, gold: gm, pred: pm });
  return ways;
}

// One value per group, in rows (gold) vs in the columns of a single row (prediction).
// Only for gold with one value column and at most one label column; labels can't be
// checked against column names, so every gold value must appear in the row.
function sameAsOneRow(gold: Ok, pred: Ok) {
  if (pred.rowCount !== 1 || gold.rowCount < 2) return false;
  const goldCols = columnsOf(gold);
  const values = goldCols.filter((col) => col.every((c) => c === null || isNumber(c)));
  if (values.length !== 1 || goldCols.length > 2) return false;
  const cells = columnsOf(pred).map((col) => col[0]);
  return [1, 100, 0.01].some((factor) => {
    const used = new Set<number>();
    return values[0].every((g) => {
      const i = cells.findIndex((p, j) => !used.has(j) && pairings([g], [p]).some((w) => w.factor === factor && w.gold[0] === w.pred[0]));
      if (i >= 0) used.add(i);
      return i >= 0;
    });
  });
}

const sameList = (a: string[], b: string[], ordered: boolean) => {
  if (a.length !== b.length) return false;
  const [x, y] = ordered ? [a, b] : [[...a].sort(), [...b].sort()];
  return x.every((v, i) => v === y[i]);
};

export type Comparison = { match: boolean; reason: string };

// Keep only the gold columns that carry the answer (the rest are labels whose form varies)
export function projectColumns(result: Ok, columns?: string[]): Ok {
  if (!columns?.length) return result;
  return { ...result, columns, rows: result.rows.map((row) => Object.fromEntries(columns.map((c) => [c, row[c]]))) };
}

export function compareResults(gold: Ok, pred: Ok, orderMatters = false): Comparison {
  if (gold.truncated || pred.truncated) return { match: false, reason: "result over 200 rows (truncated)" };
  if (gold.rowCount !== pred.rowCount) {
    if (!orderMatters && sameAsOneRow(gold, pred)) return { match: true, reason: "match (one row, a column per group)" };
    return { match: false, reason: `row count ${pred.rowCount}, expected ${gold.rowCount}` };
  }
  if (gold.rowCount === 0) return { match: true, reason: "both empty" };

  const goldCols = columnsOf(gold);
  const predCols = columnsOf(pred);
  const used = new Set<number>();
  const chosen: { gold: string[]; pred: string[] }[] = [];
  for (const [gi, gcol] of goldCols.entries()) {
    let found = false;
    for (const [pi, pcol] of predCols.entries()) {
      if (used.has(pi)) continue;
      const pairing = pairings(gcol, pcol).find((p) => sameList(p.gold, p.pred, orderMatters));
      if (pairing) {
        used.add(pi);
        chosen.push(pairing);
        found = true;
        break;
      }
    }
    if (!found) return { match: false, reason: `no column matches gold column "${gold.columns[gi]}"` };
  }

  // Columns can each match while rows are mixed up: compare whole rows too
  const rows = (side: "gold" | "pred") => Array.from({ length: gold.rowCount }, (_, i) => chosen.map((c) => c[side][i]).join("\u0001"));
  if (!sameList(rows("gold"), rows("pred"), orderMatters)) return { match: false, reason: orderMatters ? "rows in a different order or combination" : "rows combine differently" };
  return { match: true, reason: "match" };
}
