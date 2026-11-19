import type { Page } from "@playwright/test";
import { expect, fixturePng, see, shortId, test } from "./support";

// Fill the New listing form through its labels
async function fillListing(
  page: Page,
  l: { title: string; details: string; category: string; condition: string; spot: string; sale?: string; rent?: { week: string; deposit?: string } },
) {
  await page.getByLabel("Title").fill(l.title);
  await page.getByLabel("Details").fill(l.details);
  await page.getByRole("combobox", { name: /^Category/ }).selectOption({ label: l.category });
  await page.getByRole("radiogroup", { name: "Condition" }).getByRole("radio", { name: l.condition, exact: true }).click();
  const sell = page.getByRole("switch", { name: "Sell" });
  const rent = page.getByRole("switch", { name: "Rent" });
  if ((await sell.getAttribute("aria-checked")) !== String(!!l.sale)) await sell.click();
  if ((await rent.getAttribute("aria-checked")) !== String(!!l.rent)) await rent.click();
  await expect(sell).toHaveAttribute("aria-checked", String(!!l.sale));
  await expect(rent).toHaveAttribute("aria-checked", String(!!l.rent));
  if (l.sale) await page.getByLabel("Sale price").fill(l.sale);
  if (l.rent) {
    await page.getByLabel("Price for the week").fill(l.rent.week);
    if (l.rent.deposit) await page.getByLabel("Deposit").fill(l.rent.deposit);
  }
  await page.getByRole("combobox", { name: /^Meetup spot/ }).selectOption({ label: l.spot });
}

test.describe("selling", () => {
  test("post a listing for sale with a photo; it shows on home for others and on your profile; then remove it", async ({ newStudent }) => {
    const tag = `zp${shortId()}`;
    const title = `Mini fridge ${tag}`;
    const seller = await newStudent({ role: "Seller" });
    const { page } = seller;

    await seller.open("/sell");
    await expect(page.getByRole("heading", { name: "New listing" })).toBeVisible();

    // photo: picked from disk, previewed as the cover
    await page.getByLabel("Add photo").setInputFiles({ name: "fridge.png", mimeType: "image/png", buffer: fixturePng() });
    const preview = page.getByRole("img", { name: "Photo 1, cover" });
    await expect(preview).toBeVisible();
    await expect(preview).toHaveAttribute("src", /^data:image\/jpeg;base64,/);
    await expect(see(page, "Cover", { exact: true })).toBeVisible();

    await fillListing(page, {
      title,
      details: "Fits under a desk. Cleaned and defrosted.",
      category: "Dorm essentials",
      condition: "Good",
      spot: "West Village",
      sale: "40",
    });

    const upload = page.waitForResponse((r) => r.url().includes("/storage/v1/object/item-images/") && r.request().method() === "POST");
    await page.getByRole("button", { name: "Post listing" }).click();
    expect((await upload).ok()).toBe(true);

    // lands on the new listing
    await expect(see(page, "Listing posted")).toBeVisible();
    await expect(page).toHaveURL(/\/item\/\d+$/);
    const itemPath = new URL(page.url()).pathname;
    await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
    await expect(page.getByLabel("Buy or rent").getByText("$40", { exact: true })).toBeVisible();
    await expect(see(page, "You", { exact: true })).toBeVisible();
    await expect(see(page, "Meet at West Village.")).toBeVisible();
    // the uploaded photo is served back from Storage and actually renders
    const photo = page.getByRole("img", { name: `${title}, photo 1` });
    await expect(photo).toHaveAttribute("src", /\/storage\/v1\/object\/public\/item-images\//);
    await expect.poll(() => photo.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
    // owners get owner actions, not buyer ones
    await expect(page.getByRole("button", { name: "Remove listing" })).toBeVisible();
    await expect(page.getByRole("button", { name: /Request to/ })).toHaveCount(0);

    // under the seller's profile
    await seller.open("/profile");
    const mine = page.getByRole("article").filter({ hasText: title });
    await expect(mine).toBeVisible();
    await expect(mine).toContainText("$40");
    // your own listings never show on your own home
    await seller.open("/");
    await page.getByRole("searchbox", { name: "Search listings" }).fill(tag);
    await expect(see(page, "Nothing matches yet")).toBeVisible();

    // on home for another student
    const buyer = await newStudent({ role: "Buyer" });
    await buyer.page.getByRole("searchbox", { name: "Search listings" }).fill(tag);
    await expect(buyer.page.getByRole("article")).toHaveCount(1);
    await expect(buyer.page.getByRole("article").first()).toContainText(title);
    // its card shows the uploaded photo (decorative, alt="")
    const cardPhoto = buyer.page.getByRole("article").first().locator("img");
    await expect(cardPhoto).toHaveAttribute("src", /\/storage\/v1\/object\/public\/item-images\//);
    await expect.poll(() => cardPhoto.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);

    // remove it
    await seller.open(itemPath);
    await page.getByRole("button", { name: "Remove listing" }).click();
    await expect(see(page, "Listing removed")).toBeVisible();
    await expect(see(page, "Removed", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Remove listing" })).toHaveCount(0);
    await seller.open("/profile");
    await expect(page.getByRole("article").filter({ hasText: title })).toHaveCount(0);

    // gone for the buyer too (after their next load), and its link says so
    await buyer.open("/");
    await buyer.page.getByRole("searchbox", { name: "Search listings" }).fill(tag);
    await expect(see(buyer.page, "Nothing matches yet")).toBeVisible();
    await buyer.open(itemPath);
    await expect(see(buyer.page, "This listing is gone")).toBeVisible();
  });

  test("post a listing for rent with a deposit", async ({ newStudent }) => {
    const tag = `zt${shortId()}`;
    const title = `Bike helmet ${tag}`;
    const seller = await newStudent({ role: "Lender" });
    const { page } = seller;

    await seller.open("/sell");
    await page.getByLabel("Add photo").setInputFiles({ name: "helmet.png", mimeType: "image/png", buffer: fixturePng(40, 40, [20, 120, 220]) });
    await expect(page.getByRole("img", { name: "Photo 1, cover" })).toBeVisible();
    await fillListing(page, {
      title,
      details: "Size M, MIPS.",
      category: "Bikes & transport",
      condition: "Like new",
      spot: "Marino Recreation Center",
      rent: { week: "6", deposit: "25" },
    });
    await page.getByRole("button", { name: "Post listing" }).click();

    await expect(see(page, "Listing posted")).toBeVisible();
    await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
    await expect(see(page, "Rent, $25 deposit")).toBeVisible();
    await expect(page.getByLabel("Buy or rent")).toContainText("$6 a week");
    await expect(see(page, "Rentals last 7 days from pickup.", { exact: false })).toBeVisible();

    await seller.open("/profile");
    const card = page.getByRole("article").filter({ hasText: title });
    await expect(card).toContainText("$6 a week");
    await expect(card).toContainText("For rent");
  });

  test("the form explains what's missing", async ({ newStudent }) => {
    const seller = await newStudent({ role: "Seller" });
    const { page } = seller;
    await seller.open("/sell");
    await page.getByLabel("Title").fill("ab");
    await page.getByRole("button", { name: "Post listing" }).click();

    await expect(see(page, "Give it a title of at least 3 characters.")).toBeVisible();
    await expect(see(page, "Pick a category.")).toBeVisible();
    await expect(see(page, "Pick a condition.")).toBeVisible();
    await expect(see(page, "Enter a price (0 for free).")).toBeVisible();
    await expect(see(page, "Pick where you'll meet.")).toBeVisible();
    await expect(page.getByLabel("Title")).toHaveAttribute("aria-invalid", "true");
    await expect(page).toHaveURL(/\/sell$/);

    // turning off both Sell and Rent is refused
    await page.getByRole("switch", { name: "Sell" }).click();
    await page.getByRole("button", { name: "Post listing" }).click();
    await expect(see(page, "Turn on Sell, Rent, or both.")).toBeVisible();
  });

  test("a refused form moves focus to the first problem", async ({ newStudent }) => {
    const seller = await newStudent({ role: "Seller" });
    const { page } = seller;
    await seller.open("/sell");
    await page.getByLabel("Title").fill("ab");
    await page.getByRole("button", { name: "Post listing" }).click();
    await expect(see(page, "Give it a title of at least 3 characters.")).toBeVisible();
    await expect(page.getByLabel("Title")).toBeFocused({ timeout: 3_000 });
  });
});
