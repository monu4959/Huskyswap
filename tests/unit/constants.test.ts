// App constants and reference data, checked against the database schema they mirror.

import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  CATEGORIES, CATEGORY_LABEL, CONDITION_LABEL, DEAL_STATUS_LABEL, ITEM_STATUS_LABEL, NU_EMAIL, RETURN_CONDITION_LABEL, formatPrice, isNuEmail,
} from "@/lib/constants.ts";
import { MEETUP_SPOTS } from "@/lib/reference.ts";

const schemaSql = readFileSync(new URL("../../supabase/schema.sql", import.meta.url), "utf8");

// The values of a Postgres enum type in supabase/schema.sql
function enumValues(type: string) {
  const m = new RegExp(`create type public\\.${type}\\s+as\\s+enum\\s*\\(([^)]*)\\)`, "i").exec(schemaSql);
  return m ? [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]) : null;
}

describe("isNuEmail", () => {
  it.each(["a@northeastern.edu", "first.last@northeastern.edu", "  Smith.J@NorthEastern.EDU  "])("accepts %j", (email) => {
    expect(isNuEmail(email)).toBe(true);
  });
  it.each([
    "a@gmail.com", "@northeastern.edu", "a@husky.northeastern.edu", "a@northeastern.edu.evil.com", "a@northeasternXedu",
    "a@b@northeastern.edu", "a@northeastern.edu\nb@gmail.com", "",
  ])("rejects %j", (email) => {
    expect(isNuEmail(email)).toBe(false);
  });
  it("uses the same pattern as public.enforce_nu_email()", () => {
    expect(schemaSql).toContain(`lower(new.email) !~ '${NU_EMAIL.source}'`);
  });
});

describe("formatPrice", () => {
  it.each([
    [0, "Free"],
    [5, "$5"],
    [120, "$120"],
    [4.5, "$4.50"],
    [19.99, "$19.99"],
    [0.5, "$0.50"],
  ])("%d -> %s", (n, expected) => {
    expect(formatPrice(n)).toBe(expected);
  });
});

describe("labels", () => {
  it("CATEGORIES lists every category once", () => {
    expect(CATEGORIES).toEqual(Object.keys(CATEGORY_LABEL));
    expect(new Set(CATEGORIES).size).toBe(CATEGORIES.length);
  });

  it.each([
    ["item_category", CATEGORY_LABEL],
    ["item_condition", CONDITION_LABEL],
    ["item_status", ITEM_STATUS_LABEL],
    ["transaction_status", DEAL_STATUS_LABEL],
    ["return_condition", RETURN_CONDITION_LABEL],
  ] as const)("has a label for every value of public.%s", (type, labels) => {
    const values = enumValues(type);
    expect(values, `enum ${type} in schema.sql`).not.toBeNull();
    expect(Object.keys(labels).sort()).toEqual([...values!].sort());
  });

  it("labels are non-empty and distinct", () => {
    for (const labels of [CATEGORY_LABEL, CONDITION_LABEL, ITEM_STATUS_LABEL, DEAL_STATUS_LABEL, RETURN_CONDITION_LABEL]) {
      const values = Object.values(labels) as string[];
      expect(values.every((v) => v.trim().length > 0)).toBe(true);
      expect(new Set(values).size).toBe(values.length);
    }
  });
});

describe("MEETUP_SPOTS", () => {
  it("mirrors public.meetup_spots: same names, ids in insert order", () => {
    const insert = /insert into public\.meetup_spots \(name\) values([\s\S]*?);/.exec(schemaSql);
    expect(insert).not.toBeNull();
    const names = [...insert![1].matchAll(/\('((?:[^']|'')*)'\)/g)].map((m) => m[1].replace(/''/g, "'"));
    expect(MEETUP_SPOTS).toEqual(names.map((name, i) => ({ spot_id: i + 1, name })));
  });
});

describe("loadPhotos", () => {
  it("returns only hand-reviewed photos, keeping every set", async () => {
    vi.resetModules();
    vi.doMock("@/data/photos.json", () => ({
      default: {
        bikes: [
          { src: "a.jpg", title: "A", reviewed: true },
          { src: "b.jpg", title: "B", reviewed: false },
          { src: "c.jpg", title: "C" },
        ],
        desks: [{ src: "d.jpg", title: "D", reviewed: false }],
      },
    }));
    const { loadPhotos } = await import("@/lib/reference.ts");
    const photos = await loadPhotos();
    expect(Object.keys(photos)).toEqual(["bikes", "desks"]);
    expect(photos.bikes.map((p) => p.src)).toEqual(["a.jpg"]);
    expect(photos.desks).toEqual([]);
    vi.doUnmock("@/data/photos.json");
  });
});
