// Contact-detail masking applied to query results and answers.

import { describe, expect, it } from "vitest";
import { DETAIL_CHARS, scrubDetail, scrubRow, scrubText } from "@/lib/agent/privacy.ts";

describe("scrubText", () => {
  it.each([
    ["bob.smith@example.com", "[email removed]"],
    ["first.last+tag@husky.neu.edu", "[email removed]"],
    ["write to a_b-c@my-domain.co.uk.", "write to [email removed]."],
  ])("masks email %j", (input, expected) => {
    expect(scrubText(input)).toBe(expected);
  });

  it.each([
    "617-555-0123", "617.555.0123", "617 555 0123", "(617) 555-0123", "6175550123", "+1 617 555 0123", "1-617-555-0123",
  ])("masks phone number %j", (phone) => {
    expect(scrubText(`call ${phone} today`)).toBe("call [phone removed] today");
  });

  it.each([
    ["ig @bobsells", "ig [handle removed]"],
    ["@bob.sells on insta", "[handle removed] on insta"],
    ["(snap: @bob_99)", "(snap: [handle removed])"],
  ])("masks social handle %j", (input, expected) => {
    expect(scrubText(input)).toBe(expected);
  });

  it("masks several details in one text", () => {
    expect(scrubText("reach me at bob.smith@example.com or (617) 555-0123, ig @bobsells")).toBe(
      "reach me at [email removed] or [phone removed], ig [handle removed]",
    );
  });

  it.each([
    ["see https://evil.example/pay?x=1.", "see [link removed]."],
    ["go to www.example.com, now", "go to [link removed], now"],
    ["HTTP://EXAMPLE.COM/A", "[link removed]"],
    ["(link: http://x.io/a)", "(link: [link removed])"],
    ["venmo https://venmo.com/u/bob or bob@example.com", "venmo [link removed] or [email removed]"],
  ])("masks link %j", (input, expected) => {
    expect(scrubText(input)).toBe(expected);
  });

  it("an email on a www. domain is masked as an email, not a link", () => {
    expect(scrubText("mail bob@www.example.com")).toBe("mail [email removed]");
  });

  it.each([
    "Mini fridge, $45, pick up at Curry",
    "Calculus 8th edition, ISBN 978-0134",
    "Listed on 2025-04-21 at 14:30",
    "Academic year 2024-25, item 12345",
    "Price @ $20 each",
    "a@b",                      // no domain dot: not an email
    "@ab is too short a handle",
  ])("leaves ordinary text alone: %j", (text) => {
    expect(scrubText(text)).toBe(text);
  });
});

// Red team: a compromised model (or a listing) wrote contact details with fullwidth look-alikes
describe("scrubText: look-alike characters", () => {
  it.each([
    ["call ６１７-５５５-０１４２", "call [phone removed]"],
    ["mail bob＠example．com", "mail [email removed]"],
    ["ｈｔｔｐｓ://evil.example/x", "[link removed]"],
  ])("masks %j", (input, expected) => {
    expect(scrubText(input)).toBe(expected);
  });

  it("leaves other non-ASCII text exactly as it was", () => {
    expect(scrubText("Café table ½ price, ﬁne condition")).toBe("Café table ½ price, ﬁne condition");
  });
});

describe("scrubDetail", () => {
  it("masks database messages that quote row values and cuts them short", () => {
    expect(scrubDetail('invalid input syntax for type boolean: "write to bob@example.com"')).toBe('invalid input syntax for type boolean: "write to [email removed]"');
    expect(scrubDetail("x".repeat(1000))).toHaveLength(DETAIL_CHARS);
  });
});

describe("scrubRow", () => {
  it("masks string cells only and keeps every key", () => {
    const row = { title: "Desk, text 617-555-0123", price: 40, sold: false, notes: null, id: "12" };
    expect(scrubRow(row)).toEqual({ title: "Desk, text [phone removed]", price: 40, sold: false, notes: null, id: "12" });
  });

  it("does not modify its input", () => {
    const row = { t: "bob@example.com" };
    scrubRow(row);
    expect(row.t).toBe("bob@example.com");
  });
});
