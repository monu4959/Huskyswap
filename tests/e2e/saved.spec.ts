import type { Page } from "@playwright/test";
import { expect, see, shortId, test } from "./support";

// Run a save/unsave click and wait until the database write it starts has succeeded
async function savedWrite(page: Page, click: () => Promise<void>) {
  const write = page.waitForResponse((r) => r.url().includes("/rest/v1/saved_items") && r.request().method() !== "GET");
  await click();
  expect((await write).ok()).toBe(true);
}

test.describe("saved listings", () => {
  test("save from a card and from the detail page; unsave removes it from Saved", async ({ newStudent }) => {
    const tag = `zs${shortId()}`;
    const seller = await newStudent({ role: "Seller" });
    const lampTitle = `Desk lamp ${tag}`;
    const chairTitle = `Desk chair ${tag}`;
    await seller.createListing({ title: lampTitle, category: "furniture", sale: 12 });
    const chairId = await seller.createListing({ title: chairTitle, category: "furniture", sale: 30 });

    const buyer = await newStudent({ role: "Buyer" });
    const { page } = buyer;

    // Saved starts empty
    await buyer.open("/saved");
    await expect(see(page, "Nothing saved yet")).toBeVisible();

    // save the lamp from its card on home
    await buyer.open("/");
    await page.getByRole("searchbox", { name: "Search listings" }).fill(lampTitle);
    // the heart flips at once (optimistic); wait for the write before leaving the page
    await savedWrite(page, () => page.getByRole("button", { name: `Save ${lampTitle}` }).click());
    await expect(page.getByRole("button", { name: `Remove ${lampTitle} from saved` })).toHaveAttribute("aria-pressed", "true");

    // save the chair from its detail page
    await buyer.open(`/item/${chairId}`);
    await savedWrite(page, () => page.getByRole("button", { name: "Save", exact: true }).click());
    await expect(page.getByRole("button", { name: "Remove from saved" })).toHaveAttribute("aria-pressed", "true");

    // both are under Saved, and stay there after a reload (stored on the server)
    await buyer.open("/saved");
    await expect(see(page, "2 listings you're keeping an eye on")).toBeVisible();
    await expect(page.getByRole("article").filter({ hasText: lampTitle })).toBeVisible();
    await expect(page.getByRole("article").filter({ hasText: chairTitle })).toBeVisible();
    await buyer.reload();
    await expect(page.getByRole("article")).toHaveCount(2);

    // unsave the lamp right on the Saved page
    await savedWrite(page, () => page.getByRole("button", { name: `Remove ${lampTitle} from saved` }).click());
    await expect(page.getByRole("article").filter({ hasText: lampTitle })).toHaveCount(0);
    await expect(see(page, "1 listing you're keeping an eye on")).toBeVisible();

    // unsave the chair from its detail page; Saved is empty again, also after a reload
    await buyer.open(`/item/${chairId}`);
    await savedWrite(page, () => page.getByRole("button", { name: "Remove from saved" }).click());
    await expect(page.getByRole("button", { name: "Save", exact: true })).toHaveAttribute("aria-pressed", "false");
    await buyer.open("/saved");
    await expect(see(page, "Nothing saved yet")).toBeVisible();
    await buyer.reload();
    await expect(see(page, "Nothing saved yet")).toBeVisible();
  });

  test("you can't save your own listing", async ({ newStudent }) => {
    const seller = await newStudent({ role: "Seller" });
    const title = `Own lamp ${shortId()}`;
    const id = await seller.createListing({ title, sale: 5 });
    await seller.open(`/item/${id}`);
    await expect(seller.page.getByRole("heading", { level: 1, name: title })).toBeVisible();
    await expect(seller.page.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);
  });
});
