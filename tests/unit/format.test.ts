// Date and time helpers. vitest.config.ts pins TZ=America/New_York, and the clock is
// faked, so these give the same result on every machine and every day.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clockTime, shortDate, timeAgo } from "@/lib/format.ts";

// toLocale*String puts a narrow no-break space before AM/PM
const plain = (s: string) => s.replace(/\s/g, " ");
const NOW = new Date("2025-04-21T16:00:00Z"); // Monday, noon in Boston (EDT)

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

it("runs in Boston time", () => {
  expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe("America/New_York");
});

describe("timeAgo", () => {
  const ago = (seconds: number) => timeAgo(new Date(NOW.getTime() - seconds * 1000).toISOString());
  it.each([
    [0, "just now"],
    [59, "just now"],
    [60, "1m ago"],
    [59 * 60 + 59, "59m ago"],
    [3600, "1h ago"],
    [23 * 3600 + 3599, "23h ago"],
    [24 * 3600, "1d ago"],
    [6 * 86400 + 86399, "6d ago"],
  ])("%i s ago -> %s", (seconds, expected) => {
    expect(ago(seconds)).toBe(expected);
  });

  it("a week or more shows the date", () => {
    expect(ago(7 * 86400)).toBe("Apr 14");
    expect(timeAgo("2024-12-25T17:00:00Z")).toBe("Dec 25");
  });

  it("a time in the future (clock skew) is 'just now'", () => {
    expect(timeAgo("2025-04-21T16:05:00Z")).toBe("just now");
  });
});

describe("shortDate", () => {
  it("formats a date-only string as that calendar day, with no UTC shift", () => {
    expect(shortDate("2025-04-21")).toBe("Mon, Apr 21");
    expect(shortDate("2025-01-01")).toBe("Wed, Jan 1");
  });
  it("uses only the date part of a timestamp", () => {
    expect(shortDate("2025-04-21T23:30:00Z")).toBe("Mon, Apr 21");
  });
});

describe("clockTime", () => {
  it("today: just the time", () => {
    expect(plain(clockTime("2025-04-21T13:05:00Z"))).toBe("9:05 AM");
  });
  it("yesterday", () => {
    expect(plain(clockTime("2025-04-20T19:05:00Z"))).toBe("Yesterday, 3:05 PM");
  });
  it("earlier: weekday and date", () => {
    expect(plain(clockTime("2025-04-18T19:05:00Z"))).toBe("Fri, Apr 18, 3:05 PM");
  });
  it("uses Boston midnight, not UTC midnight", () => {
    vi.setSystemTime(new Date("2025-04-21T04:30:00Z")); // 00:30 Monday in Boston
    expect(plain(clockTime("2025-04-21T03:30:00Z"))).toBe("Yesterday, 11:30 PM"); // 23:30 Sunday
  });
  it("counts days across a DST change correctly", () => {
    vi.setSystemTime(new Date("2025-03-10T16:00:00Z")); // Monday after clocks went forward
    expect(plain(clockTime("2025-03-09T17:00:00Z"))).toBe("Yesterday, 1:00 PM");
    expect(plain(clockTime("2025-03-09T04:30:00Z"))).toBe("Sat, Mar 8, 11:30 PM");
  });
});
