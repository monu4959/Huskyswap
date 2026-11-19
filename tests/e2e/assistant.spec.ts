import { expect, see, test } from "./support";

// "Ask HuskySwap": the floating husky and its chat panel. The model isn't configured in the
// test stack, so these tests check the UI only and never send a question.
test.describe("assistant panel", () => {
  test("opens and closes; the question box is usable", async ({ newStudent, isMobile }) => {
    const student = await newStudent({ role: "Asker", dismissHint: false });
    const { page } = student;

    // the tip bubble appears once and can be dismissed for good
    const tip = see(page, "Woof! Need help finding something?");
    await expect(tip).toBeVisible();
    await page.getByRole("button", { name: "Dismiss the assistant tip" }).click();
    await expect(tip).toHaveCount(0);
    await student.reload();
    await expect(page.getByRole("button", { name: /^Open Ask HuskySwap/ })).toBeVisible();
    await expect(see(page, "Woof! Need help finding something?")).toHaveCount(0);

    const launcher = page.getByRole("button", { name: "Open Ask HuskySwap, the marketplace assistant" });
    await expect(launcher).toHaveAttribute("aria-expanded", "false");
    await launcher.click();

    const panel = page.getByRole("dialog", { name: "Ask HuskySwap" });
    await expect(panel).toBeVisible();
    await expect(see(panel, "Questions about listings and your own activity")).toBeVisible();
    await expect(see(panel, "Woof! Ask me in your own words.")).toBeVisible();
    await expect(panel.getByRole("button", { name: "Cheapest textbooks for sale" })).toBeVisible();

    const box = panel.getByRole("textbox", { name: "Your question" });
    await expect(box).toBeFocused();
    const send = panel.getByRole("button", { name: "Send" });
    await expect(send).toBeDisabled();
    await box.fill("Any mini fridges near Curry?");
    await expect(send).toBeEnabled();
    await box.fill("   ");
    await expect(send).toBeDisabled(); // whitespace isn't a question
    await box.fill("Any mini fridges near Curry?");

    if (isMobile) {
      // full screen on phones: the panel covers the viewport and the launcher hides
      const box2 = await panel.boundingBox();
      const vp = page.viewportSize()!;
      expect(box2!.width).toBeCloseTo(vp.width, 0);
      expect(box2!.height).toBeCloseTo(vp.height, 0);
      await expect(page.getByRole("button", { name: "Close Ask HuskySwap" })).toBeHidden();
    } else {
      // a floating card on desktop: the launcher stays and now closes it
      const card = await panel.boundingBox();
      expect(card!.width).toBeLessThanOrEqual(400);
      await expect(page.getByRole("button", { name: "Close Ask HuskySwap" })).toHaveAttribute("aria-expanded", "true");
    }

    // close with the X
    await panel.getByRole("button", { name: "Close chat" }).click();
    await expect(panel).toBeHidden();
    await expect(launcher).toBeVisible();

    // reopen: what you typed is still there; Escape closes it too
    await launcher.click();
    await expect(panel.getByRole("textbox", { name: "Your question" })).toHaveValue("Any mini fridges near Curry?");
    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden();
    await expect(launcher).toBeVisible();
  });

  test("closing the panel puts keyboard focus back on the launcher", async ({ newStudent }) => {
    const { page } = await newStudent({ role: "Focus" });
    const launcher = page.getByRole("button", { name: "Open Ask HuskySwap, the marketplace assistant" });
    const panel = page.getByRole("dialog", { name: "Ask HuskySwap" });

    await launcher.click();
    await panel.getByRole("button", { name: "Close chat" }).click();
    await expect(panel).toBeHidden();
    await expect(launcher).toBeFocused({ timeout: 3_000 });

    await launcher.click();
    await expect(panel).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden();
    await expect(launcher).toBeFocused({ timeout: 3_000 });
  });

  test("the launcher is hidden where it would cover a composer", async ({ newStudent }) => {
    const student = await newStudent({ role: "Asker" });
    await student.open("/");
    await expect(student.page.getByRole("button", { name: /^Open Ask HuskySwap/ })).toBeVisible();
    await student.open("/ask");
    await expect(student.page.getByRole("heading", { name: "Ask HuskySwap" })).toBeVisible();
    await expect(student.page.getByRole("textbox", { name: "Your question" })).toBeEditable();
    await expect(student.page.getByRole("button", { name: /^Open Ask HuskySwap/ })).toHaveCount(0);
  });
});
