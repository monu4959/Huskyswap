// compareResults: execution-accuracy comparison of a predicted result to the gold one.
// The first block ports scripts/test-compare.mjs case for case.

import { describe, expect, it } from "vitest";
import { compareResults, projectColumns } from "@/lib/agent/compare.ts";
import { CATEGORY_LABEL } from "@/lib/constants.ts";
import type { SqlResult } from "@/lib/agent/types.ts";

type Ok = Extract<SqlResult, { ok: true }>;

// A result from column names and rows of cell values
const r = (columns: string[], rows: unknown[][], truncated = false): Ok => ({
  ok: true,
  columns,
  rows: rows.map((v) => Object.fromEntries(columns.map((c, i) => [c, v[i]]))),
  rowCount: rows.length,
  truncated,
});

const match = (gold: Ok, pred: Ok, ordered = false) => compareResults(gold, pred, ordered).match;

describe("compareResults: cases from scripts/test-compare.mjs", () => {
  const CASES: [string, boolean, Ok, Ok, boolean?][] = [
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
  it.each(CASES)("%s -> %s", (_label, expected, gold, pred, ordered) => {
    expect(match(gold, pred, ordered ?? false)).toBe(expected);
  });
});

describe("compareResults: reasons", () => {
  it("explains a missing gold column by name", () => {
    expect(compareResults(r(["a", "n"], [["x", "1"]]), r(["a"], [["x"]]))).toEqual({ match: false, reason: 'no column matches gold column "n"' });
  });
  it("explains a row count mismatch", () => {
    expect(compareResults(r(["n"], [["1"], ["2"]]), r(["n"], [["1"]])).reason).toBe("row count 1, expected 2");
  });
  it("explains rows mixed up, ordered and unordered", () => {
    const gold = r(["a", "n"], [["x", "1"], ["y", "2"]]);
    expect(compareResults(gold, r(["a", "n"], [["x", "2"], ["y", "1"]])).reason).toBe("rows combine differently");
    expect(compareResults(gold, r(["a", "n"], [["y", "1"], ["x", "2"]]), true).reason).toBe("no column matches gold column \"a\"");
  });
});

describe("compareResults: empty and truncated results", () => {
  it("two empty results match whatever their columns", () => {
    expect(compareResults(r(["n"], []), r(["a", "b"], []))).toEqual({ match: true, reason: "both empty" });
  });
  it("empty vs non-empty does not match either way", () => {
    expect(match(r(["n"], []), r(["n"], [["0"]]))).toBe(false);
    expect(match(r(["n"], [["0"]]), r(["n"], []))).toBe(false);
  });
  it("a truncated side never matches, even if identical", () => {
    const big = r(["n"], [["1"]], true);
    expect(compareResults(big, big)).toEqual({ match: false, reason: "result over 200 rows (truncated)" });
    expect(match(r(["n"], [["1"]]), big)).toBe(false);
  });
});

describe("compareResults: nulls", () => {
  it("null matches null", () => {
    expect(match(r(["v"], [[null], ["1"]]), r(["x"], [[null], ["1"]]))).toBe(true);
  });
  it("undefined counts as null", () => {
    expect(match(r(["v"], [[null]]), r(["x"], [[undefined]]))).toBe(true);
  });
  it("null does not match 0, empty string or the text 'null'", () => {
    expect(match(r(["v"], [[null]]), r(["v"], [["0"]]))).toBe(false);
    expect(match(r(["v"], [[null]]), r(["v"], [[""]]))).toBe(false);
    expect(match(r(["v"], [[null]]), r(["v"], [["null"]]))).toBe(false);
  });
  it("a null in a numeric column doesn't stop the percent/fraction pairing", () => {
    expect(match(r(["p"], [["50.00"], [null]]), r(["f"], [["0.5"], [null]]))).toBe(true);
  });
});

describe("compareResults: numbers", () => {
  it("compares JS numbers and numeric strings alike", () => {
    expect(match(r(["n"], [[7]]), r(["n"], [["7"]]))).toBe(true);
    expect(match(r(["avg"], [["12.35"]]), r(["avg"], [[12.3456]]))).toBe(true);
  });
  it("uses the precision both sides share, rounding the more precise one", () => {
    expect(match(r(["v"], [["12.35"]]), r(["v"], [["12.3456"]]))).toBe(true);
    expect(match(r(["v"], [["12.35"]]), r(["v"], [["12.3412"]]))).toBe(false);
    expect(match(r(["v"], [["12"]]), r(["v"], [["12.4"]]))).toBe(true);
    expect(match(r(["v"], [["12"]]), r(["v"], [["12.6"]]))).toBe(false);
  });
  it("trailing zeros don't matter", () => {
    expect(match(r(["v"], [["5"]]), r(["v"], [["5.00"]]))).toBe(true);
  });
  it("negative numbers", () => {
    expect(match(r(["v"], [["-3.25"]]), r(["v"], [["-3.25"]]))).toBe(true);
    expect(match(r(["v"], [["-3.25"]]), r(["v"], [["3.25"]]))).toBe(false);
  });
  it("a fraction column matches a percentage column in either direction", () => {
    expect(match(r(["share"], [["0.25"]]), r(["pct"], [["25.0"]]))).toBe(true);
    expect(match(r(["pct"], [["25.0"]]), r(["share"], [["0.25"]]))).toBe(true);
  });
  it("number vs the same digits as text with other characters doesn't match", () => {
    expect(match(r(["v"], [["1234"]]), r(["v"], [["1,234"]]))).toBe(false);
    expect(match(r(["v"], [["12"]]), r(["v"], [["$12"]]))).toBe(false);
  });
  it("big integers that fit exactly in a double compare as numbers", () => {
    expect(match(r(["id"], [["9007199254740991"]]), r(["id"], [["9007199254740991"]]))).toBe(true);
    expect(match(r(["n"], [["123456789012"]]), r(["n"], [["123456789013"]]))).toBe(false);
  });

  // Fixed: bigint values arrive as strings (pg returns int8 as text) and were parsed
  // with Number(), so two different ids above 2^53 compared equal. Numbers are now
  // compared as exact decimals.
  it("different bigints above 2^53 do not match", () => {
    expect(match(r(["id"], [["9007199254740993"]]), r(["id"], [["9007199254740992"]]))).toBe(false);
  });
  it("equal bigints above 2^53 match, also as a percentage of their fraction", () => {
    expect(match(r(["id"], [["123456789012345678901"]]), r(["id"], [["123456789012345678901"]]))).toBe(true);
    expect(match(r(["id"], [["123456789012345678901"]]), r(["id"], [["123456789012345678902"]]))).toBe(false);
    expect(match(r(["pct"], [["12345678901234567.89"]]), r(["share"], [["123456789012345.6789"]]))).toBe(true);
  });

  // Fixed: rounding to the shared precision was done in binary floating point
  // (Math.round(n * 10 ** d)), so 1.005 -> 100.49999... -> 1.00, while Postgres'
  // round(1.005, 2) = 1.01. Rounding is now done on the decimal digits.
  it("1.005 rounds to the gold 1.01 at 2 decimals, as Postgres rounds", () => {
    expect(match(r(["avg"], [["1.01"]]), r(["avg"], [["1.005"]]))).toBe(true);
  });
  it("the fraction 0.00575 matches the percent 0.58 at 2 decimals", () => {
    expect(match(r(["pct"], [["0.58"]]), r(["share"], [["0.00575"]]))).toBe(true);
  });
  it.each([
    ["half rounds away from zero, as Postgres numeric does", "2.68", "2.675", true],
    ["negative half rounds away from zero", "-1.01", "-1.005", true],
    ["just under half rounds down", "1.00", "1.00499", true],
    ["just under half does not round up", "1.01", "1.00499", false],
    ["a tiny negative rounds to zero, not -0", "0.00", "-0.001", true],
    ["percent half rounds up", "57.5", "0.575", true],
    ["percent to fraction at 4 decimals", "0.0058", "0.575", true],
  ])("decimal rounding: %s", (_label, gold, pred, expected) => {
    expect(match(r(["v"], [[gold]]), r(["v"], [[pred]]))).toBe(expected);
  });
  it("JS numbers are rounded on their decimal form too, exponents included", () => {
    expect(match(r(["avg"], [["1.01"]]), r(["avg"], [[1.005]]))).toBe(true);
    expect(match(r(["v"], [["0.0000"]]), r(["v"], [[1e-7]]))).toBe(true);
    expect(match(r(["v"], [["0.0001"]]), r(["v"], [[1e-7]]))).toBe(false);
    expect(match(r(["v"], [["100000000000000000000"]]), r(["v"], [[1e20]]))).toBe(true);
  });
});

describe("compareResults: text, booleans and categories", () => {
  it("text is compared case-insensitively and trimmed", () => {
    expect(match(r(["t"], [["Curry Student Center"]]), r(["t"], [["  curry student center "]]))).toBe(true);
    expect(match(r(["t"], [["Curry"]]), r(["t"], [["Snell"]]))).toBe(false);
  });
  it("booleans match their text form", () => {
    expect(match(r(["b"], [[true], [false]]), r(["b"], [["true"], ["false"]]))).toBe(true);
    expect(match(r(["b"], [[true]]), r(["b"], [[false]]))).toBe(false);
  });
  it("text that looks like a number in one side and a label in the other doesn't match", () => {
    expect(match(r(["t"], [["7"]]), r(["t"], [["seven"]]))).toBe(false);
  });

  // Every category label the app shows must match its code, so constants.ts and compare.ts can't drift
  it.each(Object.entries(CATEGORY_LABEL))("category code %s matches its label %j", (code, label) => {
    expect(match(r(["category"], [[code]]), r(["label"], [[label]]))).toBe(true);
    expect(match(r(["label"], [[label]]), r(["category"], [[code]]))).toBe(true);
  });
  it("a category label does not match a different code", () => {
    expect(match(r(["category"], [["textbooks"]]), r(["label"], [["Kitchen"]]))).toBe(false);
  });
});

describe("compareResults: dates and months", () => {
  it("a midnight timestamp matches its date", () => {
    expect(match(r(["d"], [["2025-04-21"]]), r(["d"], [["2025-04-21 00:00:00+00"]]))).toBe(true);
    expect(match(r(["d"], [["2025-04-21"]]), r(["d"], [["2025-04-21T00:00:00Z"]]))).toBe(true);
    expect(match(r(["d"], [["2025-04-21"]]), r(["d"], [["2025-04-21 00:00:00"]]))).toBe(true);
  });
  it("a timestamp at another time, or another day, does not match the date", () => {
    expect(match(r(["d"], [["2025-04-21"]]), r(["d"], [["2025-04-21 13:00:00+00"]]))).toBe(false);
    expect(match(r(["d"], [["2025-04-21"]]), r(["d"], [["2025-04-22"]]))).toBe(false);
  });
  it("only the first of the month stands for the month", () => {
    expect(match(r(["m"], [["2025-04-01"]]), r(["m"], [["2025-04"]]))).toBe(true);
    expect(match(r(["m"], [["2025-04-02"]]), r(["m"], [["2025-04"]]))).toBe(false);
  });
  it("month names and numbers match first-of-month dates in one year", () => {
    const gold = r(["m"], [["2025-03-01"], ["2025-04-01"]]);
    expect(match(gold, r(["name"], [["March"], ["April"]]), true)).toBe(true);
    expect(match(gold, r(["num"], [[3], [4]]), true)).toBe(true);
    expect(match(gold, r(["name"], [["April"], ["March"]]), true)).toBe(false);
  });
  it("month numbers out of range are not months", () => {
    expect(match(r(["m"], [["2025-01-01"]]), r(["n"], [["13"]]))).toBe(false);
  });
  it("two number columns are never matched as months", () => {
    expect(match(r(["month"], [["4"]]), r(["n"], [["4.0"]]))).toBe(true); // equal as numbers
    expect(match(r(["month"], [["4"]]), r(["n"], [["5"]]))).toBe(false);
  });
});

describe("compareResults: duplicates and row order", () => {
  it("duplicate rows count: same multiset matches, different multiset doesn't", () => {
    expect(match(r(["v"], [["1"], ["1"], ["2"]]), r(["v"], [["2"], ["1"], ["1"]]))).toBe(true);
    expect(match(r(["v"], [["1"], ["1"], ["2"]]), r(["v"], [["1"], ["2"], ["2"]]))).toBe(false);
  });
  it("ordered comparison needs the same order", () => {
    const gold = r(["t", "n"], [["a", "3"], ["b", "2"], ["c", "1"]]);
    expect(match(gold, r(["t", "n"], [["a", "3"], ["b", "2"], ["c", "1"]]), true)).toBe(true);
    expect(match(gold, r(["t", "n"], [["b", "2"], ["a", "3"], ["c", "1"]]), true)).toBe(false);
    expect(match(gold, r(["t", "n"], [["b", "2"], ["a", "3"], ["c", "1"]]), false)).toBe(true);
  });
  it("one gold column can't be matched twice by the same predicted column", () => {
    expect(match(r(["a", "b"], [["7", "7"]]), r(["x"], [["7"]]))).toBe(false);
    expect(match(r(["a", "b"], [["7", "7"]]), r(["x", "y"], [["7", "7"]]))).toBe(true);
  });
  it("columns can be in any order", () => {
    expect(match(r(["a", "n"], [["x", "1"]]), r(["n", "a"], [["1", "x"]]))).toBe(true);
  });
});

describe("compareResults: groups in rows vs one row", () => {
  const gold = r(["type", "avg"], [["rental", "11.74"], ["sale", "64.73"]]);
  it("matches a single row holding every group's value", () => {
    expect(compareResults(gold, r(["avg_sale", "avg_rental"], [["64.73", "11.74"]]))).toEqual({ match: true, reason: "match (one row, a column per group)" });
  });
  it("not when order matters", () => {
    expect(match(gold, r(["avg_sale", "avg_rental"], [["64.73", "11.74"]]), true)).toBe(false);
  });
  it("a single predicted value can't stand for two equal gold values", () => {
    expect(match(r(["t", "v"], [["a", "5"], ["b", "5"]]), r(["v"], [["5"]]))).toBe(false);
  });
  it("needs at least two gold rows", () => {
    expect(match(r(["t", "v"], [["a", "5"]]), r(["v"], []))).toBe(false);
  });
});

describe("projectColumns", () => {
  const full = r(["label", "n", "extra"], [["Textbooks", "9", "x"]]);
  it("keeps only the named columns, in the given order", () => {
    expect(projectColumns(full, ["n", "label"])).toEqual({ ...full, columns: ["n", "label"], rows: [{ n: "9", label: "Textbooks" }] });
  });
  it("returns the result unchanged with no columns", () => {
    expect(projectColumns(full)).toBe(full);
    expect(projectColumns(full, [])).toBe(full);
  });
  it("lets an answer with different labels match on the value column alone", () => {
    const gold = r(["category", "n"], [["Bikes and scooters", "4"]]);
    expect(match(gold, r(["category", "n"], [["bikes_transport", "4"]]))).toBe(false);
    expect(match(projectColumns(gold, ["n"]), r(["category", "n"], [["bikes_transport", "4"]]))).toBe(true);
  });
});
