import { chatsLink, expect, see, shortId, test } from "./support";

// Two students in two browser contexts. Nothing reloads after the first message:
// everything the other side sees arrives through Supabase Realtime.
test.describe("messaging", () => {
  test("buyer messages the seller; both see each other's messages live with unread badges", async ({ newStudent }) => {
    const tag = `zc${shortId()}`;
    const title = `Monitor ${tag}`;
    const seller = await newStudent({ role: "Seller" });
    const buyer = await newStudent({ role: "Buyer" });
    const itemId = await seller.createListing({ title, category: "electronics", sale: 60 });

    // the seller is already sitting on Chats (loaded after the buyer signed up)
    await seller.open("/inbox");
    await expect(see(seller.page, "No chats yet")).toBeVisible();
    await expect(chatsLink(seller.page)).not.toContainText(/\d/);

    // buyer opens the listing and starts a chat
    await buyer.open(`/item/${itemId}`);
    await buyer.page.getByRole("button", { name: "Message" }).click();
    await expect(buyer.page).toHaveURL(/\/inbox\/\d+$/);
    const chatPath = new URL(buyer.page.url()).pathname;
    await expect(see(buyer.page, seller.name)).toBeVisible();
    await expect(see(buyer.page, title)).toBeVisible();
    const buyerBox = buyer.page.getByRole("textbox", { name: "Message" });
    await expect(buyer.page.getByRole("button", { name: "Send" })).toBeDisabled();
    const question = `Is it still available? ${tag}`;
    await buyerBox.fill(question);
    await buyer.page.getByRole("button", { name: "Send" }).click();
    const buyerMessages = buyer.page.getByRole("list", { name: "Messages" });
    await expect(buyerMessages.getByText(question)).toBeVisible();
    await expect(buyerBox).toHaveValue("");

    // seller: the chat appears in the list without a reload, bold, with an unread badge
    const row = seller.page.getByRole("link").filter({ hasText: question });
    await expect(row).toBeVisible();
    await expect(row).toContainText(`Your listing: ${title}`);
    await expect(row).toContainText("1 unread");
    await expect(chatsLink(seller.page)).toContainText("1");

    // seller opens it: badge clears, the request card area is empty, they reply
    await row.click();
    await expect(seller.page).toHaveURL(new RegExp(`${chatPath}$`));
    await expect(see(seller.page, "Interested in your listing")).toBeVisible();
    const sellerMessages = seller.page.getByRole("list", { name: "Messages" });
    await expect(sellerMessages.getByText(question)).toBeVisible();
    const reply = `Yes! Snell at 3pm? ${tag}`;
    await seller.page.getByRole("textbox", { name: "Message" }).fill(reply);
    await seller.page.getByRole("textbox", { name: "Message" }).press("Enter"); // Enter sends
    await expect(sellerMessages.getByText(reply)).toBeVisible();

    // buyer sees the reply arrive in the open chat
    await expect(buyerMessages.getByText(reply)).toBeVisible();

    // back on the seller's Chats: no unread left, last message is theirs
    await seller.page.getByRole("link", { name: "Back" }).click();
    await expect(seller.page).toHaveURL(/\/inbox$/);
    await expect(seller.page.getByRole("link").filter({ hasText: `You: ${reply}` })).toBeVisible();
    await expect(chatsLink(seller.page)).not.toContainText(/\d/);

    // buyer goes to Chats; a new message from the seller shows up there live with a badge
    await buyer.page.getByRole("link", { name: "Back" }).click();
    await expect(buyer.page).toHaveURL(/\/inbox$/);
    await expect(chatsLink(buyer.page)).not.toContainText(/\d/);
    await seller.page.getByRole("link").filter({ hasText: `You: ${reply}` }).click();
    const followUp = `I can also do tomorrow ${tag}`;
    await seller.page.getByRole("textbox", { name: "Message" }).fill(followUp);
    await seller.page.getByRole("button", { name: "Send" }).click();
    await expect(seller.page.getByRole("list", { name: "Messages" }).getByText(followUp)).toBeVisible();

    const buyerRow = buyer.page.getByRole("link").filter({ hasText: followUp });
    await expect(buyerRow).toBeVisible();
    await expect(buyerRow).toContainText(seller.name);
    await expect(buyerRow).toContainText("1 unread");
    await expect(chatsLink(buyer.page)).toContainText("1");
    await buyerRow.click();
    await expect(buyer.page.getByRole("list", { name: "Messages" }).getByText(followUp)).toBeVisible();
    await buyer.page.getByRole("link", { name: "Back" }).click();
    await expect(chatsLink(buyer.page)).not.toContainText(/\d/);

    // read state is saved: after a reload neither side has unread messages
    await buyer.reload();
    await expect(buyer.page.getByRole("link").filter({ hasText: followUp })).not.toContainText("unread");
  });

  test("the seller sees a brand-new buyer's name in Chats without reloading", async ({ newStudent }) => {
    // Regression: the store fetches profiles it hasn't seen when a realtime event names them
    const title = `Kettle ${shortId()}`;
    const seller = await newStudent({ role: "Seller" });
    const itemId = await seller.createListing({ title, category: "kitchen", sale: 9 });
    await seller.open("/inbox"); // loaded BEFORE the buyer exists

    const buyer = await newStudent({ role: "Buyer" });
    await buyer.open(`/item/${itemId}`);
    await buyer.page.getByRole("button", { name: "Message" }).click();
    const text = `hello ${shortId()}`;
    await buyer.page.getByRole("textbox", { name: "Message" }).fill(text);
    await buyer.page.getByRole("button", { name: "Send" }).click();

    const row = seller.page.getByRole("link").filter({ hasText: text });
    await expect(row).toBeVisible();
    await expect(row).toContainText(buyer.name, { timeout: 5_000 });
  });
});
