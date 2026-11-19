import { expect, horizontalOverflow, shortId, test } from "./support";

// Phone layout sanity at the iPhone 13 width (390 px): nothing scrolls sideways and the
// bottom tab bar is there on the main screens. Runs in the mobile project only.
test.describe("mobile layout", () => {
  test.beforeEach(({ isMobile }) => {
    test.skip(!isMobile, "phone layout only");
  });

  test("no horizontal scroll on the main pages; tab bar on the top-level screens", async ({ newStudent }, testInfo) => {
    const seller = await newStudent({ role: "Wide" });
    const itemId = await seller.createListing({
      title: `Adjustable standing desk converter, black, fits two monitors ${shortId()}`,
      description: "Bought last fall for my dorm. Some scratches on the top, otherwise works perfectly. ".repeat(6),
      sale: 999999,
      rent: { week: 99999, deposit: 99999 },
    });
    const viewer = await newStudent({ role: "Viewer" });
    const { page } = viewer;
    expect(page.viewportSize()!.width).toBe(390);

    const tabBar = page.getByRole("navigation", { name: "Main" });
    const pages: { path: string; tabs: boolean }[] = [
      { path: "/", tabs: true },
      { path: "/saved", tabs: true },
      { path: "/inbox", tabs: true },
      { path: "/deals", tabs: true },
      { path: "/profile", tabs: true },
      { path: "/sell", tabs: false },
      { path: `/item/${itemId}`, tabs: false },
      { path: "/ask", tabs: false },
      { path: "/credits", tabs: true },
    ];
    for (const { path, tabs } of pages) {
      await viewer.open(path);
      await expect.poll(() => horizontalOverflow(page), { message: `${path} scrolls sideways` }).toBeLessThanOrEqual(0);
      if (tabs) {
        await expect(tabBar, `${path} should show the tab bar`).toBeVisible();
        for (const name of ["Home", "Categories", "Sell", "Saved", "Profile"]) {
          await expect(tabBar.getByRole(name === "Categories" ? "button" : "link", { name, exact: true })).toBeVisible();
        }
        // pinned to the bottom of the screen
        const box = (await tabBar.boundingBox())!;
        expect(Math.round(box.y + box.height)).toBe(page.viewportSize()!.height);
      } else {
        await expect(tabBar, `${path} has its own bottom bar instead`).toBeHidden();
      }
    }
    await viewer.open("/");
    await testInfo.attach("home-390.png", { body: await page.screenshot(), contentType: "image/png" });
  });

  test("the tab bar navigates and marks the current tab", async ({ newStudent }) => {
    const { page } = await newStudent({ role: "Tabber" });
    const tabBar = page.getByRole("navigation", { name: "Main" });
    await expect(tabBar.getByRole("link", { name: "Home", exact: true })).toHaveAttribute("aria-current", "page");

    await tabBar.getByRole("link", { name: "Saved", exact: true }).click();
    await expect(page).toHaveURL(/\/saved$/);
    await expect(page.getByRole("heading", { name: "Saved", level: 1 })).toBeVisible();
    await expect(tabBar.getByRole("link", { name: "Saved", exact: true })).toHaveAttribute("aria-current", "page");

    await tabBar.getByRole("link", { name: "Profile", exact: true }).click();
    await expect(page).toHaveURL(/\/profile$/);
    await expect(page.getByRole("heading", { name: "Profile", level: 1 })).toBeVisible();

    // the categories sheet opens from the tab bar and filters home
    await tabBar.getByRole("button", { name: "Categories", exact: true }).click();
    const sheet = page.getByRole("dialog", { name: "Browse by category" });
    await expect(sheet).toBeVisible();
    await sheet.getByRole("button", { name: "Textbooks", exact: true }).click();
    await expect(sheet).toBeHidden();
    await expect(page).toHaveURL(/\/\?category=textbooks$/);
    await expect(page.getByRole("heading", { name: "Textbooks", level: 2 })).toBeVisible();

    await tabBar.getByRole("link", { name: "Sell", exact: true }).click();
    await expect(page).toHaveURL(/\/sell$/);
    await expect(page.getByRole("heading", { name: "New listing" })).toBeVisible();
    await expect(tabBar).toBeHidden(); // the form's Post button takes the bottom
    await expect(page.getByRole("button", { name: "Post listing" })).toBeInViewport();
  });

  test("an unbroken word in a listing doesn't push the item page sideways", async ({ newStudent }) => {
    const seller = await newStudent({ role: "Wide" });
    const itemId = await seller.createListing({
      title: `Serial_${"X1Y2Z3".repeat(10)}_${shortId()}`,
      description: `Model ${"ABCDEF0123".repeat(8)}`,
      sale: 5,
    });
    const viewer = await newStudent({ role: "Viewer" });
    await viewer.open(`/item/${itemId}`);
    await expect.poll(() => horizontalOverflow(viewer.page), { timeout: 3_000 }).toBeLessThanOrEqual(0);
  });
});
