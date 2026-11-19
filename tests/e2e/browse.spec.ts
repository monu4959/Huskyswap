import { expect, see, shortId, test } from "./support";

// Home: search, category filter, item detail. A seller posts the listings this test looks for
// (with a unique word in the title), so nothing depends on the seeded data.
test.describe("browsing", () => {
  test("search, filter by category, open an item and see its price, seller and meetup spot", async ({ newStudent }) => {
    const tag = `zq${shortId()}`;
    const seller = await newStudent({ role: "Seller" });
    await seller.createListing({
      title: `Graphing calculator ${tag}`,
      description: "TI-84, works great, batteries included.",
      category: "electronics",
      condition: "like_new",
      spotId: 2, // Curry Student Center
      sale: 45,
    });
    await seller.createListing({ title: `Saucepan ${tag}`, category: "kitchen", sale: 8, spotId: 1 });

    const buyer = await newStudent({ role: "Buyer" });
    const { page } = buyer;
    const results = page.getByRole("article");

    // search: every word must match; the count is announced
    const search = page.getByRole("searchbox", { name: "Search listings" });
    await search.fill(tag);
    await expect(page.getByRole("heading", { name: "Results" })).toBeVisible();
    await expect(results).toHaveCount(2);
    await expect(see(page, "2 listings", { exact: true })).toBeVisible();

    await search.fill(`calculator ${tag}`);
    await expect(results).toHaveCount(1);
    await expect(results.first()).toContainText(`Graphing calculator ${tag}`);
    await expect(results.first()).toContainText("$45");
    await expect(results.first()).toContainText("Curry Student Center");

    // nothing matches: a friendly empty state
    await search.fill(`${tag} unicorn`);
    await expect(see(page, "Nothing matches yet")).toBeVisible();
    await page.getByRole("button", { name: "Clear search" }).click();
    await expect(search).toHaveValue("");

    // category filter (kept in the URL) narrows the same search
    await search.fill(tag);
    await expect(results).toHaveCount(2);
    const categories = page.getByRole("region", { name: "Categories" });
    await categories.getByRole("button", { name: "Kitchen", exact: true }).click();
    await expect(page).toHaveURL(/\?category=kitchen$/);
    await expect(categories.getByRole("button", { name: "Kitchen", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(results).toHaveCount(1);
    await expect(results.first()).toContainText(`Saucepan ${tag}`);

    await categories.getByRole("button", { name: "Electronics", exact: true }).click();
    await expect(page).toHaveURL(/\?category=electronics$/);
    await expect(results).toHaveCount(1);
    await expect(results.first()).toContainText(`Graphing calculator ${tag}`);

    // open it: the detail page shows price, condition, seller and where to meet
    await results.first().getByRole("link").click();
    await expect(page).toHaveURL(/\/item\/\d+$/);
    await expect(page.getByRole("heading", { level: 1, name: `Graphing calculator ${tag}` })).toBeVisible();
    await expect(page.getByLabel("Buy or rent").getByText("$45", { exact: true })).toBeVisible();
    await expect(see(page, "Like new", { exact: true })).toBeVisible();
    await expect(see(page, seller.name, { exact: true })).toBeVisible();
    await expect(see(page, "New seller, no reviews yet")).toBeVisible();
    await expect(see(page, "Meet at Curry Student Center.")).toBeVisible();
    await expect(see(page, "TI-84, works great, batteries included.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Request to buy" })).toBeEnabled();
  });

  test("the Rent a week filter shows only rentals", async ({ newStudent }) => {
    const tag = `zr${shortId()}`;
    const seller = await newStudent({ role: "Seller" });
    await seller.createListing({ title: `Camping tent ${tag}`, category: "sports_outdoors", sale: null, rent: { week: 12, deposit: 30 } });
    await seller.createListing({ title: `Yoga mat ${tag}`, category: "sports_outdoors", sale: 15 });

    const { page } = await newStudent({ role: "Buyer" });
    await page.getByRole("searchbox", { name: "Search listings" }).fill(tag);
    await expect(page.getByRole("article")).toHaveCount(2);

    await page.getByRole("button", { name: "Filters", exact: true }).click();
    await page.getByRole("radiogroup", { name: "Show" }).getByRole("radio", { name: "Rent a week" }).click();
    await expect(page.getByRole("article")).toHaveCount(1);
    const tent = page.getByRole("article").first();
    await expect(tent).toContainText(`Camping tent ${tag}`);
    await expect(tent).toContainText("$12 a week");

    await tent.getByRole("link").click();
    await expect(see(page, "Rent, $30 deposit")).toBeVisible();
    await expect(page.getByRole("button", { name: "Request to rent" })).toBeEnabled();
  });
});
