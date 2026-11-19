import { randomBytes } from "node:crypto";
import { deflateSync } from "node:zlib";
import { test as base, expect, type Browser, type BrowserContext, type BrowserContextOptions, type Locator, type Page } from "@playwright/test";

// Shared helpers for the HuskySwap browser tests.
//
// Every test makes its own students (fresh @northeastern.edu addresses; demo sign-in
// accepts any 6 digits) and its own listings, so tests never depend on each other or on
// seeded accounts, and they can run in parallel.

export const shortId = () => randomBytes(4).toString("hex");
export const uniqueEmail = (tag = "u") => `e2e-${tag}-${shortId()}@northeastern.edu`;

// A small solid-colour PNG, generated in memory for the photo upload tests (no binary fixtures in git)
export function fixturePng(width = 32, height = 24, rgb: [number, number, number] = [200, 16, 46]) {
  const crc32 = (buf: Buffer) => {
    let crc = 0xffffffff;
    for (const byte of buf) {
      let c = (crc ^ byte) & 0xff;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crc = (crc >>> 8) ^ c;
    }
    return (crc ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: width }, () => rgb).flat())]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour RGB
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.concat(Array.from({ length: height }, () => row)))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

export const HOME_HEADING = "What do you need this week?";

// Signing in downloads every visible profile, listing, chat and rating before the app renders
// (src/lib/store.tsx). That's about 1 s on a quiet machine but far slower when the shared test
// stack is busy, so waits for the app to finish loading get a longer budget than other assertions.
export const LOAD_TIMEOUT = 60_000;

/** Sign in through the real login screens. Pass `name` for a new account (it gets the name prompt). */
export async function signIn(page: Page, email: string, name?: string) {
  await page.goto("/login");
  await page.getByLabel("Northeastern email").fill(email);
  await page.getByRole("button", { name: /^(Send code|Continue with email)$/ }).click();
  await page.getByLabel("Code from the email").fill("123456");
  await page.getByRole("button", { name: "Verify and continue" }).click();
  if (name) {
    await expect(page.getByRole("heading", { name: "What should we call you?" })).toBeVisible();
    await page.getByLabel("Display name").fill(name);
    await page.getByRole("button", { name: "Start browsing" }).click();
  }
  await expect(page).toHaveURL((u) => u.pathname === "/", { timeout: LOAD_TIMEOUT });
  await expect(page.getByRole("heading", { name: HOME_HEADING })).toBeVisible({ timeout: LOAD_TIMEOUT });
}

interface Session {
  access_token: string;
}

export interface ListingInput {
  title: string;
  description?: string;
  category?: string;
  condition?: "new" | "like_new" | "good" | "fair";
  spotId?: number;
  sale?: number | null;
  rent?: { week: number; deposit?: number } | null;
}

/** One signed-in student in their own browser context. */
export class Student {
  // the Supabase URL and publishable key, as the app sends them (captured from its own requests)
  private supabaseUrl: string | null = null;
  private apikey: string | null = null;

  constructor(
    readonly context: BrowserContext,
    readonly page: Page,
    readonly email: string,
    readonly name: string,
  ) {
    context.on("request", (r) => {
      const key = r.headers()["apikey"];
      if (key && !this.apikey) {
        this.apikey = key;
        this.supabaseUrl = new URL(r.url()).origin;
      }
    });
  }

  get firstName() {
    return this.name.split(" ")[0];
  }

  private async session(): Promise<Session> {
    const s = await this.page.evaluate(() => {
      const key = Object.keys(localStorage).find((k) => k.startsWith("sb-") && k.endsWith("-auth-token"));
      return key ? (JSON.parse(localStorage.getItem(key)!) as { access_token: string }) : null;
    });
    if (!s) throw new Error(`${this.email} has no session in localStorage`);
    return s;
  }

  /** Call one of the app's database functions as this student (test setup only; assertions go through the UI). */
  async rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
    await expect.poll(() => this.apikey, { message: "the app never called Supabase" }).not.toBeNull();
    const { access_token } = await this.session();
    const res = await this.page.request.post(`${this.supabaseUrl}/rest/v1/rpc/${fn}`, {
      headers: { apikey: this.apikey!, Authorization: `Bearer ${access_token}`, "Content-Type": "application/json" },
      data: args,
    });
    if (!res.ok()) throw new Error(`${fn} failed: ${res.status()} ${await res.text()}`);
    return (await res.json()) as T;
  }

  /** Create a listing through the same database function the Sell screen uses. Reload the page to see it. */
  async createListing(l: ListingInput): Promise<number> {
    return this.rpc<number>("create_listing", {
      p_title: l.title,
      p_description: l.description ?? "Made by an end-to-end test.",
      p_category: l.category ?? "other",
      p_condition: l.condition ?? "good",
      p_meetup_spot_id: l.spotId ?? 1,
      p_sale_price: l.sale === undefined ? 10 : l.sale,
      p_rent_price: l.rent?.week ?? null,
      p_deposit: l.rent?.deposit ?? 0,
      p_image_paths: [],
    });
  }

  /** Open a page and wait until the signed-in app has loaded (no skeleton, no splash). */
  async open(path: string) {
    await this.page.goto(path);
    await this.loaded();
  }

  /** Reload (the store refetches everything from the database) and wait for the app. */
  async reload() {
    await this.page.reload();
    await this.loaded();
  }

  private async loaded() {
    await expect(this.page.locator("[aria-busy='true']")).toHaveCount(0, { timeout: LOAD_TIMEOUT });
  }
}

type NewStudent = (opts?: { role?: string; dismissHint?: boolean }) => Promise<Student>;

export const test = base.extend<{ newStudent: NewStudent }>({
  newStudent: async (
    { browser, baseURL, viewport, userAgent, isMobile, hasTouch, deviceScaleFactor, locale, timezoneId },
    provide, // Playwright's `use` (renamed so the React hooks lint rule leaves it alone)
  ) => {
    const options: BrowserContextOptions = { baseURL, viewport, userAgent, isMobile, hasTouch, deviceScaleFactor, locale, timezoneId };
    const contexts: BrowserContext[] = [];
    await provide(async ({ role = "Student", dismissHint = true } = {}) => {
      const context = await newContext(browser, options, dismissHint);
      contexts.push(context);
      const page = await context.newPage();
      const id = shortId();
      const student = new Student(context, page, uniqueEmail(role.toLowerCase()), `${role} ${id}`);
      await signIn(page, student.email, student.name);
      return student;
    });
    await Promise.all(contexts.map((c) => c.close()));
  },
});

async function newContext(browser: Browser, options: BrowserContextOptions, dismissHint: boolean) {
  const context = await browser.newContext(options);
  // The assistant's speech bubble floats over the page corner; tests that aren't about it dismiss it up front
  if (dismissHint) await context.addInitScript(() => localStorage.setItem("huskyswap-husky-hint", "dismissed"));
  return context;
}

export { expect };

/** The Chats link in whichever header this viewport shows (mobile header or desktop top nav). */
export const chatsLink = (page: Page) => page.getByRole("link", { name: /^Chats/ });
/** The Deals link in whichever header this viewport shows. */
export const dealsLink = (page: Page) => page.getByRole("link", { name: /^Deals/ });

/** The page should not scroll sideways. */
export async function horizontalOverflow(page: Page) {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

/**
 * Visible text only. Next 16 keeps recently visited routes mounted but hidden (display: none),
 * so a plain getByText can also match the same words on a page the user has left.
 */
export function see(scope: Page | Locator, text: string | RegExp, opts: { exact?: boolean } = {}) {
  // (and not Next's route announcer, which repeats the new page's title for screen readers)
  return scope.getByText(text, opts).filter({ visible: true }).and(scope.locator(":not(#__next-route-announcer__)"));
}
