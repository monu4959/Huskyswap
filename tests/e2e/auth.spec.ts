import { HOME_HEADING, LOAD_TIMEOUT, expect, see, shortId, signIn, test, uniqueEmail } from "./support";

test.describe("sign-in", () => {
  test("a new student signs up: email, code, name prompt, then home with listings", async ({ page }) => {
    const email = uniqueEmail("new");
    const name = `Newbie ${shortId()}`;

    await page.goto("/login");
    await expect(page.getByRole("heading", { name: "Buy, sell and borrow on campus" })).toBeVisible();
    await page.getByLabel("Northeastern email").fill(email);
    await page.getByRole("button", { name: /^(Send code|Continue with email)$/ }).click();

    // code screen: shows the address, explains demo mode, focuses the code box
    await expect(page.getByRole("button", { name: new RegExp(email.replace(/[.]/g, "\\.")) })).toBeVisible();
    await expect(see(page, "Demo mode: no email is sent.")).toBeVisible();
    const code = page.getByLabel("Code from the email");
    await expect(code).toBeFocused();
    await code.fill("482913");
    await page.getByRole("button", { name: "Verify and continue" }).click();

    // a new account picks the name other students see
    await expect(page.getByRole("heading", { name: "What should we call you?" })).toBeVisible();
    const nameBox = page.getByLabel("Display name");
    await expect(nameBox).not.toHaveValue("");
    await nameBox.fill(name);
    await page.getByRole("button", { name: "Start browsing" }).click();

    await expect(page).toHaveURL((u) => u.pathname === "/");
    await expect(page.getByRole("heading", { name: HOME_HEADING })).toBeVisible({ timeout: LOAD_TIMEOUT });
    await expect(see(page, `Hi ${name.split(" ")[0]} · Huskies only`)).toBeVisible();
    await expect(page.getByRole("heading", { name: "Featured listings" })).toBeVisible();
    await expect(page.getByRole("article").first()).toBeVisible();
    await expect(see(page, /^[1-9][\d,]* listings?, newest first$/)).toBeVisible();
  });

  test("a returning student signs in without the name prompt", async ({ page }) => {
    const email = uniqueEmail("back");
    const name = `Returning ${shortId()}`;
    await signIn(page, email, name);

    await page.goto("/profile");
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page).toHaveURL(/\/login$/);

    await page.getByLabel("Northeastern email").fill(email.toUpperCase()); // addresses are case-insensitive
    await page.getByRole("button", { name: /^(Send code|Continue with email)$/ }).click();
    await page.getByLabel("Code from the email").fill("000000");
    await page.getByRole("button", { name: "Verify and continue" }).click();

    await expect(page.getByRole("heading", { name: HOME_HEADING })).toBeVisible({ timeout: LOAD_TIMEOUT });
    await expect(page.getByRole("heading", { name: "What should we call you?" })).toHaveCount(0);
    await expect(see(page, `Hi ${name.split(" ")[0]} · Huskies only`)).toBeVisible();
  });

  test("a non-Northeastern address is rejected with a message", async ({ page }) => {
    await page.goto("/login");
    const emailBox = page.getByLabel("Northeastern email");
    await emailBox.fill(`someone.${shortId()}@gmail.com`);
    await page.getByRole("button", { name: /^(Send code|Continue with email)$/ }).click();

    await expect(see(page, "Use your @northeastern.edu email address.")).toBeVisible();
    await expect(emailBox).toHaveAttribute("aria-invalid", "true");
    await expect(page.getByLabel("Code from the email")).toHaveCount(0);

    // a look-alike domain is refused too
    await emailBox.fill(`someone.${shortId()}@northeastern.edu.evil.com`);
    await page.getByRole("button", { name: /^(Send code|Continue with email)$/ }).click();
    await expect(see(page, "Use your @northeastern.edu email address.")).toBeVisible();
    await expect(page).toHaveURL(/\/login$/);
  });

  test("the code screen wants exactly 6 digits", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("Northeastern email").fill(uniqueEmail("code"));
    await page.getByRole("button", { name: /^(Send code|Continue with email)$/ }).click();
    const code = page.getByLabel("Code from the email");
    await code.fill("12ab3");
    await expect(code).toHaveValue("123"); // letters are dropped as you type
    await page.getByRole("button", { name: "Verify and continue" }).click();
    await expect(see(page, "Enter any 6 digits.")).toBeVisible();
    await expect(page).toHaveURL(/\/login$/);
  });
});
