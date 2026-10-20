// Execution-accuracy comparison: does a predicted query return the same answer
// as the gold query? Compares results, not SQL text.
//
//   * columns are matched by their values, not names or positions; the
//     prediction may have extra columns but must contain every gold column
//   * numbers are compared at the precision both sides share (11.1 = 11.11),
//     and a percentage column may match a fraction column (61.6 = 0.616)
//   * text is compared case-insensitively; category labels match their codes
//     ("Dorm essentials" = dorm_essentials); a first-of-month date matches its
//     month ("2025-04-01" = "2025-04")
//   * row order matters only when orderMatters (top-N, "month by month")

import type { SqlResult } from "./types.ts";

type Ok = Extract<SqlResult, { ok: true }>;
type Cell = null | string | { n: number; d: number }; // d: decimals written

const CATEGORY_LABELS: Record<string, string> = {
  textbooks: "textbooks", electronics: "electronics", furniture: "furniture", kitchen: "kitchen",
  "dorm essentials": "dorm_essentials", clothing: "clothing", "sports & outdoors": "sports_outdoors",
  "bikes & transport": "bikes_transport", other: "other",
};

function parse(value: unknown): Cell {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return { n: value, d: Number.isInteger(value) ? 0 : Math.min(String(value).split(".")[1]?.length ?? 0, 6) };
  if (typeof value === "boolean") return value ? "true" : "false";
  const s = String(value).trim();
  if (/^-?\d+(\.\d+)?$/.test(s)) return { n: Number(s), d: s.split(".")[1]?.length ?? 0 };
  let text = s.toLowerCase();
  text = text.replace(/^(\d{4}-\d{2}-\d{2})[ t]00:00:00(\+00|z)?$/, "$1"); // midnight timestamp -> date
  text = text.replace(/^(\d{4}-\d{2})-01$/, "$1"); // first of month -> month
  return CATEGORY_LABELS[text] ?? text;
}

const columnsOf = (r: Ok) => r.columns.map((c) => r.rows.map((row) => parse(row[c])));
const decimals = (col: Cell[]) => Math.max(0, ...col.map((c) => (c && typeof c === "object" ? c.d : 0)));

// A cell as a comparable string, at a given precision and scale
function canon(c: Cell, d: number, factor: number) {
  if (c === null) return "∅";
  if (typeof c === "object") return (Math.round(c.n * factor * 10 ** d) / 10 ** d).toFixed(d);
  return `s:${c}`;
}

// The ways a predicted column can stand for a gold column: same scale, or percent vs fraction.
// Scaling moves the decimal point: a fraction written to 2 places (0.20) is a percentage to 0 (20).
function pairings(gold: Cell[], pred: Cell[]) {
  return [1, 100, 0.01].map((factor) => {
    const predDecimals = Math.max(0, decimals(pred) - Math.round(Math.log10(factor)));
    const d = Math.min(decimals(gold), predDecimals, 4);
    return { d, factor, gold: gold.map((c) => canon(c, d, 1)), pred: pred.map((c) => canon(c, d, factor)) };
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
  if (gold.rowCount !== pred.rowCount) return { match: false, reason: `row count ${pred.rowCount}, expected ${gold.rowCount}` };
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
