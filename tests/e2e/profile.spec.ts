import type { Page } from "@playwright/test";
import { LOAD_TIMEOUT, expect, see, shortId, test } from "./support";

const pageBackground = (page: Page) => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
// --bg in src/app/globals.css
const DARK_BG = "rgb(20, 18, 17)";
const LIGHT_BG = "rgb(247, 245, 242)";

test.describe("profile", () => {
  test("change your display name; it sticks after a reload and shows on your listings", async ({ newStudent }) => {
    const student = await newStudent({ role: "Renamer" });
    const { page } = student;
    const itemId = await student.createListing({ title: `Lamp ${shortId()}`, sale: 4 });
    await student.open("/profile");
    await expect(see(page, student.name, { exact: true })).toBeVisible();
    await expect(see(page, student.email)).toBeVisible();

    const newName = `Paws ${shortId()}`;
    await page.getByRole("button", { name: "Edit name" }).click();
    const box = page.getByRole("textbox", { name: "Display name" });
    await expect(box).toBeFocused();
    await expect(box).toHaveValue(student.name);
    await box.fill(newName);
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(see(page, "Name updated")).toBeVisible();
    await expect(see(page, newName, { exact: true })).toBeVisible();
    await expect(box).toHaveCount(0);

    await student.reload();
    await expect(see(page, newName, { exact: true })).toBeVisible({ timeout: LOAD_TIMEOUT });

    // other students see the new name on the listing
    const buyer = await newStudent({ role: "Viewer" });
    await buyer.open(`/item/${itemId}`);
    await expect(see(buyer.page, newName, { exact: true })).toBeVisible();
  });

  test("an empty name is refused", async ({ newStudent }) => {
    const student = await newStudent({ role: "Blank" });
    const { page } = student;
    await student.open("/profile");
    await page.getByRole("button", { name: "Edit name" }).click();
    await page.getByRole("textbox", { name: "Display name" }).fill("   ");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(see(page, "Enter a name up to 80 characters.")).toBeVisible();
    await student.reload();
    await expect(see(page, student.name, { exact: true })).toBeVisible({ timeout: LOAD_TIMEOUT });
  });

  test("theme switch: dark, light and match device each persist after a reload", async ({ newStudent }) => {
    const student = await newStudent({ role: "Themer" });
    const { page } = student;
    await student.open("/profile");
    const themes = page.getByRole("radiogroup", { name: "App theme" });
    const html = page.locator("html");
    await expect(themes.getByRole("radio", { name: "Match device" })).toHaveAttribute("aria-checked", "true");

    await themes.getByRole("radio", { name: "Dark" }).click();
    await expect(html).toHaveAttribute("data-theme", "dark");
    await expect.poll(() => pageBackground(page)).toBe(DARK_BG);
    await student.reload();
    await expect(html).toHaveAttribute("data-theme", "dark");
    await expect(themes.getByRole("radio", { name: "Dark" })).toHaveAttribute("aria-checked", "true", { timeout: LOAD_TIMEOUT });
    await expect.poll(() => pageBackground(page)).toBe(DARK_BG);

    await themes.getByRole("radio", { name: "Light" }).click();
    await expect(html).toHaveAttribute("data-theme", "light");
    await expect.poll(() => pageBackground(page)).toBe(LIGHT_BG);
    await student.reload();
    await expect(themes.getByRole("radio", { name: "Light" })).toHaveAttribute("aria-checked", "true", { timeout: LOAD_TIMEOUT });
    await expect(html).toHaveAttribute("data-theme", "light");
    await expect.poll(() => pageBackground(page)).toBe(LIGHT_BG);

    // "Match device" follows the OS setting
    await themes.getByRole("radio", { name: "Match device" }).click();
    await expect(html).toHaveAttribute("data-theme", "system");
    await page.emulateMedia({ colorScheme: "dark" });
    await expect.poll(() => pageBackground(page)).toBe(DARK_BG);
    await page.emulateMedia({ colorScheme: "light" });
    await expect.poll(() => pageBackground(page)).toBe(LIGHT_BG);
    await student.reload();
    await expect(themes.getByRole("radio", { name: "Match device" })).toHaveAttribute("aria-checked", "true", { timeout: LOAD_TIMEOUT });
    await expect(html).toHaveAttribute("data-theme", "system");
  });

  test("sign out returns to /login and signed-in pages send you back there", async ({ newStudent }) => {
    const student = await newStudent({ role: "Leaver" });
    const { page } = student;
    await student.open("/profile");
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByLabel("Northeastern email")).toBeVisible();

    for (const path of ["/", "/profile", "/saved", "/inbox", "/deals", "/sell"]) {
      await page.goto(path);
      await expect(page, `${path} should redirect`).toHaveURL(/\/login$/, { timeout: LOAD_TIMEOUT });
      await expect(page.getByLabel("Northeastern email")).toBeVisible();
    }
    // the session is really gone, not just hidden
    const tokens = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("sb-") && k.endsWith("-auth-token")));
    expect(tokens).toEqual([]);
  });
});
