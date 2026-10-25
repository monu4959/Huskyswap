// Unit checks for the execution-accuracy comparator (src/lib/agent/compare.ts).
//
//   npm run test:compare

import { compareResults } from "../src/lib/agent/compare.ts";

const r = (columns, rows) => ({
  ok: true, columns, rows: rows.map((v) => Object.fromEntries(columns.map((c, i) => [c, v[i]]))), rowCount: rows.length, truncated: false,
});

const CASES = [
  ["same value, different column name", true, r(["n"], [["7"]]), r(["late_returns"], [["7"]])],
  ["extra predicted column allowed", true, r(["n"], [["7"]]), r(["late", "total"], [["7", "63"]])],
  ["precision 11.11 vs 11.1", true, r(["p"], [["11.11"]]), r(["pct"], [["11.1"]])],
  ["percent vs fraction", true, r(["p"], [["61.61"]]), r(["share"], [["0.6161"]])],
  ["fraction rounded to 2 places vs percent", true, r(["p"], [["19.73"]]), r(["rate"], [["0.20"]])],
  ["fraction that is actually different", false, r(["p"], [["19.73"]]), r(["rate"], [["0.25"]])],
  ["category label vs code", true, r(["category", "n"], [["dorm_essentials", "5"], ["textbooks", "9"]]), r(["label", "n"], [["Textbooks", "9"], ["Dorm essentials", "5"]])],
  ["month vs first-of-month date", true, r(["m", "n"], [["2025-01-01", "4"], ["2025-02-01", "6"]]), r(["month", "n"], [["2025-01", "4"], ["2025-02", "6"]]), true],
  ["unordered rows in another order", true, r(["a", "n"], [["x", "1"], ["y", "2"]]), r(["a", "n"], [["y", "2"], ["x", "1"]])],
  ["ordered rows in the wrong order", false, r(["a", "n"], [["x", "1"], ["y", "2"]]), r(["a", "n"], [["y", "2"], ["x", "1"]]), true],
  ["wrong value", false, r(["n"], [["7"]]), r(["n"], [["8"]])],
  ["missing gold column", false, r(["a", "n"], [["x", "1"]]), r(["a"], [["x"]])],
  ["rows mixed up across columns", false, r(["a", "n"], [["x", "1"], ["y", "2"]]), r(["a", "n"], [["x", "2"], ["y", "1"]])],
  ["row count differs", false, r(["n"], [["1"], ["2"]]), r(["n"], [["1"]])],
  ["first-of-month date vs month name, one year", true, r(["month"], [["2025-05-01"]]), r(["month_name"], [["May      "]])],
  ["first-of-month dates vs month numbers, ordered", true, r(["m", "n"], [["2025-01-01", "4"], ["2025-02-01", "6"]]), r(["year", "month", "n"], [["2025", "1", "4"], ["2025", "2", "6"]]), true],
  ["month name for dates in two years", false, r(["m"], [["2024-05-01"], ["2025-05-01"]]), r(["m"], [["May"], ["May"]])],
  ["wrong month name", false, r(["month"], [["2025-05-01"]]), r(["month_name"], [["June"]])],
  ["month number vs a count column", false, r(["n"], [["3"], ["5"]]), r(["month"], [["4"], ["5"]])],
  ["groups in rows vs one row of columns", true, r(["is_weekend", "rate"], [["false", "0.1963"], ["true", "0.1909"]]), r(["weekend_pct", "weekday_pct", "n"], [["19.09", "19.63", "2400"]])],
  ["one row missing a group's value", false, r(["type", "avg"], [["rental", "11.74"], ["sale", "64.73"]]), r(["avg_sale"], [["64.73"]])],
  ["one row with a wrong value", false, r(["type", "avg"], [["rental", "11.74"], ["sale", "64.73"]]), r(["avg_sale", "avg_rental"], [["64.73", "12.10"]])],
  ["two value columns in rows aren't pivoted", false, r(["type", "n", "avg"], [["rental", "5", "11.74"], ["sale", "9", "64.73"]]), r(["a", "b", "c", "d"], [["5", "11.74", "9", "64.73"]])],
];

let failures = 0;
for (const [label, expected, gold, pred, ordered] of CASES) {
  const c = compareResults(gold, pred, ordered ?? false);
  if (c.match !== expected) failures++;
  console.log(`${c.match === expected ? "PASS" : "FAIL"}  ${label}  ->  ${c.reason}`);
}
console.log(failures ? `\n${failures} check(s) FAILED` : "\nAll comparator checks passed");
process.exitCode = failures ? 1 : 0;
