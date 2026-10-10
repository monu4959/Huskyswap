// End-to-end check of the app's Supabase queries using a temporary test account.
// Creates the account (password sign-in), runs the same queries the store makes,
// then deletes the account and anything it created.
//
//   node scripts/smoke-client.mjs

import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { createClient } from "@supabase/supabase-js";

const env = Object.fromEntries(
  readFileSync(new URL("../.env.local", import.meta.url), "utf8")
    .split(/\r?\n/)
    .filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]),
);
const db = new pg.Client({ connectionString: env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await db.connect();

const id = randomUUID();
const email = `smoke.test.${id.slice(0, 8)}@northeastern.edu`;
const password = randomUUID();
let pass = 0;
let fail = 0;
const ok = (cond, label) => {
  if (cond) pass++;
  else fail++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
};

try {
  await db.query(
    `insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
       created_at, updated_at, confirmation_token, recovery_token, email_change_token_new, email_change)
     values ('00000000-0000-0000-0000-000000000000', $1, 'authenticated', 'authenticated', $2, crypt($3, gen_salt('bf')), now(),
       '{"provider":"email","providers":["email"]}', '{"name":"Smoke Test"}', now(), now(), '', '', '', '')`,
    [id, email, password],
  );
  await db.query(
    `insert into auth.identities (id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
     values (gen_random_uuid(), $1::uuid, $2::text, jsonb_build_object('sub', $2::text, 'email', $3::text), 'email', now(), now(), now())`,
    [id, id, email],
  );

  const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false } });

  const anon = await supabase.from("items").select("item_id").limit(1);
  ok(!!anon.error || anon.data.length === 0, "signed out: no data");

  const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
  ok(!signInError, `test student signs in${signInError ? `: ${signInError.message}` : ""}`);

  const { data: profile } = await supabase.from("profiles").select("name").eq("id", id).single();
  ok(profile?.name === "Smoke Test", "profile was created by the sign-up trigger");

  const { data: items, error: itemsError } = await supabase
    .from("items")
    .select("item_id, title, status, buyable_items(price), borrowable_items(price_per_week, deposit), item_images(storage_path, position)")
    .eq("status", "available")
    .not("borrowable_items", "is", null)
    .limit(3);
  ok(!itemsError && items.length > 0, `listings with prices and photos load${itemsError ? `: ${itemsError.message}` : ""}`);
  if (items?.[0]) {
    const i = items[0];
    console.log("      shape:", JSON.stringify({ buyable_items: i.buyable_items, borrowable_items: i.borrowable_items, first_image: i.item_images[0] }));
  }

  const { count } = await supabase.from("items").select("*", { count: "exact", head: true });
  ok(count > 2000, `can count all listings (${count})`);

  const { data: deals } = await supabase.from("transactions").select("transaction_id, rentals(start_date, due_date)");
  ok(Array.isArray(deals) && deals.length === 0, "new student has no deals and can't see others'");

  // A real flow: save, message, request
  const target = items[0];
  const save = await supabase.from("saved_items").insert({ user_id: id, item_id: target.item_id });
  ok(!save.error, "save a listing");
  const { data: conv, error: convError } = await supabase.rpc("open_conversation", { p_item_id: target.item_id, p_buyer_id: null });
  ok(!convError && conv > 0, `open a chat${convError ? `: ${convError.message}` : ""}`);
  const msg = await supabase.from("messages").insert({ conversation_id: conv, sender_id: id, body: "Hi! Is this still available?" }).select().single();
  ok(!msg.error, "send a message");
  const { data: tx, error: txError } = await supabase.rpc("request_deal", { p_item_id: target.item_id, p_type: "rental" });
  ok(!txError && tx > 0, `request to rent${txError ? `: ${txError.message}` : ""}`);
  const { data: mine } = await supabase.from("transactions").select("transaction_id, status, agreed_price, rentals(start_date)").eq("transaction_id", tx).single();
  ok(mine?.status === "requested", `deal visible to the buyer (status ${mine?.status}, $${mine?.agreed_price}/week)`);
  console.log("      rentals embed before hand-over:", JSON.stringify(mine?.rentals));

  const dup = await supabase.rpc("request_deal", { p_item_id: target.item_id, p_type: "rental" });
  ok(!!dup.error, `duplicate request refused: "${dup.error?.message}"`);

  const upload = await supabase.storage.from("item-images").upload(`${id}/smoke.jpg`, new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], { type: "image/jpeg" }), { contentType: "image/jpeg" });
  ok(!upload.error, `upload a photo to your own folder${upload.error ? `: ${upload.error.message}` : ""}`);
  const badUpload = await supabase.storage.from("item-images").upload(`someone-else/x.jpg`, new Blob([new Uint8Array([1])], { type: "image/jpeg" }), { contentType: "image/jpeg" });
  ok(!!badUpload.error, "can't upload into someone else's folder");
  await supabase.storage.from("item-images").remove([`${id}/smoke.jpg`]);
} catch (e) {
  fail++;
  console.error("Unexpected error:", e.message);
} finally {
  // Remove everything the test account created, then the account
  await db.query("delete from public.messages where sender_id = $1", [id]);
  await db.query("delete from public.conversations where buyer_id = $1", [id]);
  await db.query("delete from public.transactions where buyer_id = $1", [id]);
  await db.query("delete from auth.users where id = $1", [id]);
  await db.end();
}
console.log(`\n${pass} passed, ${fail} failed (test account removed)`);
process.exitCode = fail ? 1 : 0;
