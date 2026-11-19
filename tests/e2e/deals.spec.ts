import type { Page } from "@playwright/test";
import { dealsLink, expect, see, shortId, test, type Student } from "./support";

// Deals between two (or three) students in separate browser contexts. After the first
// load nobody reloads: the other side's steps arrive through Supabase Realtime.

const status = (page: Page, label: string) => see(page, label, { exact: true }).first();

async function review(student: Student, stars: number, comment: string) {
  const { page } = student;
  const post = page.getByRole("button", { name: "Post review" });
  await expect(post).toBeDisabled(); // a rating is required
  await page.getByRole("radiogroup", { name: "Rating" }).getByRole("radio", { name: `${stars} star${stars > 1 ? "s" : ""}`, exact: true }).click();
  await page.getByLabel("Comment (optional)").fill(comment);
  await post.click();
  await expect(see(page, "Review posted")).toBeVisible();
  await expect(page.getByLabel(`${stars} out of 5 stars`).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Post review" })).toHaveCount(0);
}

test.describe("deals", () => {
  test("full sale: request, accept, hand over, confirm, both review; item sold and ratings update", async ({ newStudent }) => {
    const tag = `zd${shortId()}`;
    const title = `Organic chemistry textbook ${tag}`;
    const seller = await newStudent({ role: "Seller" });
    const buyer = await newStudent({ role: "Buyer" });
    const itemId = await seller.createListing({ title, category: "textbooks", sale: 25, spotId: 1 });
    await seller.open("/deals");
    await expect(dealsLink(seller.page)).not.toContainText(/\d/);

    // buyer asks to buy
    await buyer.open(`/item/${itemId}`);
    await buyer.page.getByRole("button", { name: "Request to buy" }).click();
    await expect(see(buyer.page, "Request sent to the seller")).toBeVisible();
    await expect(buyer.page).toHaveURL(/\/deals\/\d+$/);
    const dealPath = new URL(buyer.page.url()).pathname;
    await expect(buyer.page.getByRole("heading", { name: "Buying" })).toBeVisible();
    await expect(see(buyer.page, `Waiting for ${seller.name} to accept.`)).toBeVisible();
    await expect(see(buyer.page, "Meet at Snell Library.")).toBeVisible();

    // seller: the Deals badge and the request show up live
    await expect(dealsLink(seller.page)).toContainText("1");
    await seller.page.getByRole("radio", { name: /^Selling/ }).click();
    const row = seller.page.getByRole("link").filter({ hasText: title });
    await expect(row).toContainText(`${buyer.name} sent a request`);
    await expect(row).toContainText("Requested");
    await row.click();
    await expect(seller.page).toHaveURL(new RegExp(`${dealPath}$`));
    await expect(seller.page.getByRole("heading", { name: "Selling" })).toBeVisible();
    await expect(see(seller.page, `${buyer.name} wants to buy this.`)).toBeVisible();

    // accept
    await seller.page.getByRole("button", { name: "Accept", exact: true }).click();
    await expect(see(seller.page, "Request accepted")).toBeVisible();
    await expect(see(seller.page, "Meet up and hand it over.")).toBeVisible();
    await expect(see(buyer.page, `${seller.name} accepted. Agree on a time in chat and bring $25.`)).toBeVisible();
    await expect(status(buyer.page, "Accepted")).toBeVisible();

    // hand over
    await seller.page.getByRole("button", { name: "I handed it over" }).click();
    await expect(see(seller.page, "Marked as handed over")).toBeVisible();
    await expect(see(seller.page, `Waiting for ${buyer.name} to confirm they got it.`)).toBeVisible();

    // buyer confirms
    await expect(see(buyer.page, "Got the item?")).toBeVisible();
    await buyer.page.getByRole("button", { name: "Yes, I have it" }).click();
    await expect(see(buyer.page, "Purchase complete")).toBeVisible();
    await expect(status(buyer.page, "Completed")).toBeVisible();
    await expect(seller.page.getByRole("heading", { name: "Reviews" })).toBeVisible(); // seller's screen moved on too

    // both review
    await review(buyer, 5, `Smooth handoff ${tag}`);
    await review(seller, 4, `Paid on time ${tag}`);
    // each sees the other's review (the seller right away; the buyer after loading again)
    await expect(see(seller.page, `Smooth handoff ${tag}`)).toBeVisible();
    await buyer.open(dealPath);
    await expect(see(buyer.page, `Paid on time ${tag}`)).toBeVisible();

    // the item is sold: no longer requestable, gone from home
    await buyer.open(`/item/${itemId}`);
    await expect(status(buyer.page, "Sold")).toBeVisible();
    await expect(buyer.page.getByRole("button", { name: "Sold" })).toBeDisabled();
    await expect(see(buyer.page, "5.0 from 1 review")).toBeVisible(); // the seller's new rating
    await buyer.open("/");
    await buyer.page.getByRole("searchbox", { name: "Search listings" }).fill(tag);
    await expect(see(buyer.page, "Nothing matches yet")).toBeVisible();

    // ratings and reviews on both profiles
    await seller.open("/profile");
    await expect(see(seller.page, "5.0 from 1 review")).toBeVisible();
    await expect(see(seller.page, `${buyer.name} gave 5 of 5`, { exact: false })).toBeVisible();
    await expect(seller.page.getByRole("article").filter({ hasText: title })).toContainText("Sold");
    await buyer.open("/profile");
    await expect(see(buyer.page, "4.0 from 1 review")).toBeVisible();

    // Deals list: finished, nothing waiting
    await buyer.open("/deals");
    await expect(buyer.page.getByRole("link").filter({ hasText: title })).toContainText("Completed");
    await expect(dealsLink(buyer.page)).not.toContainText(/\d/);
  });

  test("rental: request, accept, hand over, mark returned with condition, close, review", async ({ newStudent }) => {
    const tag = `ze${shortId()}`;
    const title = `Camping stove ${tag}`;
    const owner = await newStudent({ role: "Owner" });
    const renter = await newStudent({ role: "Renter" });
    const itemId = await owner.createListing({ title, category: "sports_outdoors", sale: null, rent: { week: 8, deposit: 20 }, spotId: 3 });

    await renter.open(`/item/${itemId}`);
    await expect(see(renter.page, "Rent, $20 deposit")).toBeVisible();
    await renter.page.getByRole("button", { name: "Request to rent" }).click();
    await expect(see(renter.page, "Rental request sent")).toBeVisible();
    await expect(renter.page).toHaveURL(/\/deals\/\d+$/);
    const dealPath = new URL(renter.page.url()).pathname;
    await expect(renter.page.getByRole("heading", { name: "Renting" })).toBeVisible();

    await owner.open(dealPath);
    await expect(owner.page.getByRole("heading", { name: "Lending" })).toBeVisible();
    await expect(see(owner.page, `${renter.name} wants to rent this for a week.`)).toBeVisible();
    await owner.page.getByRole("button", { name: "Accept", exact: true }).click();
    await expect(see(owner.page, "Request accepted")).toBeVisible();
    await expect(see(renter.page, `${owner.name} accepted. Agree on a time in chat and bring $8 plus the deposit.`)).toBeVisible();

    // pickup starts the rental week
    await owner.page.getByRole("button", { name: "I handed it over" }).click();
    await expect(see(owner.page, "Marked as handed over")).toBeVisible();
    await expect(owner.page.getByRole("heading", { name: "Rental week" })).toBeVisible();
    await expect(see(renter.page, `Enjoy it. Return it to ${owner.name} by`, { exact: false })).toBeVisible();
    await expect(renter.page.getByRole("heading", { name: "Rental week" })).toBeVisible();
    const week = renter.page.locator("dl");
    await expect(week).toContainText("Picked up");
    await expect(week).toContainText("Due back");
    await expect(week).toContainText("Deposit$20");

    // it comes back with minor wear
    await expect(see(owner.page, "When it comes back, record its condition.")).toBeVisible();
    const condition = owner.page.getByRole("radiogroup", { name: "Condition on return" });
    await expect(condition.getByRole("radio", { name: "Same as lent" })).toHaveAttribute("aria-checked", "true");
    await condition.getByRole("radio", { name: "Minor wear" }).click();
    await expect(condition.getByRole("radio", { name: "Minor wear" })).toHaveAttribute("aria-checked", "true");
    await owner.page.getByRole("button", { name: "It's back" }).click();
    await expect(see(owner.page, "Return recorded")).toBeVisible();
    await expect(owner.page.locator("dl")).toContainText("Came backMinor wear");
    await expect(see(owner.page, "Give back the $20 deposit", { exact: false })).toBeVisible();
    await expect(see(renter.page, `${owner.name} has it back and is settling your deposit.`)).toBeVisible();

    // close
    await owner.page.getByRole("button", { name: "Deposit settled, close rental" }).click();
    await expect(see(owner.page, "Rental closed")).toBeVisible();
    await expect(status(owner.page, "Completed")).toBeVisible();
    await expect(status(renter.page, "Completed")).toBeVisible();

    await review(renter, 5, `Worked perfectly ${tag}`);
    await review(owner, 3, `Came back a bit scuffed ${tag}`);

    // after a rental the item can be rented again
    const other = await newStudent({ role: "Next" });
    await other.open(`/item/${itemId}`);
    await expect(other.page.getByRole("button", { name: "Request to rent" })).toBeEnabled();
    await expect(see(other.page, "5.0 from 1 review")).toBeVisible();
  });
});

test.describe("deal rules", () => {
  test("you can't request your own item", async ({ newStudent }) => {
    const seller = await newStudent({ role: "Seller" });
    const title = `Own bike ${shortId()}`;
    const itemId = await seller.createListing({ title, category: "bikes_transport", sale: 120, rent: { week: 15 } });
    await seller.open(`/item/${itemId}`);
    await expect(seller.page.getByRole("heading", { level: 1, name: title })).toBeVisible();
    await expect(seller.page.getByRole("button", { name: /^Request to/ })).toHaveCount(0);
    await expect(seller.page.getByRole("button", { name: "Message" })).toHaveCount(0);
    await expect(seller.page.getByRole("link", { name: "See requests" })).toBeVisible();
    // the buy/rent choice is shown, not offered as a choice
    await expect(seller.page.getByRole("radiogroup", { name: "Buy or rent" })).toHaveCount(0);
  });

  test("once a request is accepted, other buyers' requests are declined and nobody else can request", async ({ newStudent }) => {
    const tag = `zf${shortId()}`;
    const title = `Air fryer ${tag}`;
    const seller = await newStudent({ role: "Seller" });
    const first = await newStudent({ role: "First" });
    const second = await newStudent({ role: "Second" });
    const itemId = await seller.createListing({ title, category: "kitchen", sale: 30 });

    // both ask while it's still available
    await first.open(`/item/${itemId}`);
    await first.page.getByRole("button", { name: "Request to buy" }).click();
    await expect(first.page).toHaveURL(/\/deals\/\d+$/);
    const firstDeal = new URL(first.page.url()).pathname;
    await second.open(`/item/${itemId}`);
    await second.page.getByRole("button", { name: "Request to buy" }).click();
    await expect(second.page).toHaveURL(/\/deals\/\d+$/);
    await expect(status(second.page, "Requested")).toBeVisible();

    // the seller accepts the first
    await seller.open(firstDeal);
    await expect(see(seller.page, `${first.name} wants to buy this.`)).toBeVisible();
    await expect(see(seller.page, "Accepting reserves the item and declines any other requests for it.")).toBeVisible();
    await seller.page.getByRole("button", { name: "Accept", exact: true }).click();
    await expect(see(seller.page, "Request accepted")).toBeVisible();

    // the second buyer's open deal flips to declined, live
    await expect(status(second.page, "Declined")).toBeVisible();
    await expect(see(second.page, `${seller.name} declined this request.`, { exact: false })).toBeVisible();

    // and the listing can't be requested again
    await second.open(`/item/${itemId}`);
    await expect(status(second.page, "Reserved")).toBeVisible();
    await expect(second.page.getByRole("button", { name: "Reserved" })).toBeDisabled();
    await expect(second.page.getByRole("button", { name: "Request to buy" })).toHaveCount(0);
    // nor by someone new
    const third = await newStudent({ role: "Third" });
    await third.page.getByRole("searchbox", { name: "Search listings" }).fill(tag);
    await expect(see(third.page, "Nothing matches yet")).toBeVisible();
    await third.open(`/item/${itemId}`);
    await expect(third.page.getByRole("button", { name: "Reserved" })).toBeDisabled();
  });

  test("a buyer can cancel a request and the item is requestable again", async ({ newStudent }) => {
    const title = `Rice cooker ${shortId()}`;
    const seller = await newStudent({ role: "Seller" });
    const buyer = await newStudent({ role: "Buyer" });
    const itemId = await seller.createListing({ title, category: "kitchen", sale: 15 });

    await buyer.open(`/item/${itemId}`);
    await buyer.page.getByRole("button", { name: "Request to buy" }).click();
    await expect(buyer.page).toHaveURL(/\/deals\/\d+$/);
    const dealPath = new URL(buyer.page.url()).pathname;

    // with an open request the listing offers "View your request" instead of a second request
    await buyer.open(`/item/${itemId}`);
    await expect(buyer.page.getByRole("button", { name: "Request to buy" })).toHaveCount(0);
    await buyer.page.getByRole("link", { name: "View your request" }).click();
    await expect(buyer.page).toHaveURL(new RegExp(`${dealPath}$`));

    // the seller is looking at the request when it's cancelled
    await seller.open(dealPath);
    await expect(see(seller.page, `${buyer.name} wants to buy this.`)).toBeVisible();

    await buyer.page.getByRole("button", { name: "Cancel deal" }).click();
    await expect(see(buyer.page, "Deal cancelled")).toBeVisible();
    await expect(see(buyer.page, "This deal was cancelled.")).toBeVisible();
    await expect(buyer.page.getByRole("button", { name: "Cancel deal" })).toHaveCount(0);

    // the seller's screen updates live: no Accept button left
    await expect(see(seller.page, "This deal was cancelled.")).toBeVisible();
    await expect(seller.page.getByRole("button", { name: "Accept", exact: true })).toHaveCount(0);

    await buyer.open(`/item/${itemId}`);
    await expect(buyer.page.getByRole("button", { name: "Request to buy" })).toBeEnabled();
  });
});
