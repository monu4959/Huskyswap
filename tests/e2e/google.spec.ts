// Sign in with Google. A real Google login can't run in a test, so these check
// our side of it: the button sends the browser to Supabase's Google authorize
// endpoint with the right return address (PKCE), and coming back with an error
// or a bad code explains itself and cleans the address bar.

import { expect, see, test } from "./support";

test.describe("sign in with Google", () => {
  test("the button sends you to Google through Supabase, coming back to /login", async ({ page }) => {
    let authorize: URL | null = null;
    await page.route("**/auth/v1/authorize**", async (route) => {
      authorize = new URL(route.request().url());
      await route.fulfill({ status: 200, contentType: "text/html", body: "<p>Google would be here</p>" });
    });
    await page.goto("/login");
    const appOrigin = new URL(page.url()).origin; // before the browser leaves for Google
    await page.getByRole("button", { name: "Continue with Google" }).click();
    await expect.poll(() => authorize?.searchParams.get("provider")).toBe("google");
    const back = new URL(authorize!.searchParams.get("redirect_to")!);
    expect(back.pathname).toBe("/login");
    expect(back.origin).toBe(appOrigin);
    // PKCE: a code challenge goes out, the verifier stays in the browser
    expect(authorize!.searchParams.get("code_challenge")).toBeTruthy();
    expect(authorize!.searchParams.get("code_challenge_method")?.toLowerCase()).toBe("s256");
  });

  test("cancelling at Google comes back with a plain message and a clean address", async ({ page }) => {
    await page.goto("/login?error=access_denied&error_description=The+user+denied+access");
    await expect(see(page, "Google sign-in was cancelled. Try again when you're ready.")).toBeVisible();
    await expect(page).toHaveURL((u) => u.pathname === "/login" && u.search === "");
    await expect(page.getByRole("button", { name: "Continue with Google" })).toBeEnabled();
  });

  test("a stale or forged code doesn't sign you in", async ({ page }) => {
    await page.goto("/login?code=not-a-real-code");
    await expect(see(page, "That sign-in link expired. Tap Continue with Google again.")).toBeVisible();
    await expect(page).toHaveURL((u) => u.pathname === "/login" && u.search === "");
    // still signed out: protected pages send you back here
    await page.goto("/saved");
    await expect(page).toHaveURL((u) => u.pathname === "/login");
  });
});
