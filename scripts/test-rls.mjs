// Checks the RLS policies and deal functions by acting as two seeded students.
// Everything runs in one transaction that is rolled back, so nothing changes.
//
//   node scripts/test-rls.mjs

import { readFileSync } from "node:fs";
import pg from "pg";

const url = readFileSync(new URL("../.env.local", import.meta.url), "utf8").match(/^DATABASE_URL=(.*)$/m)[1].trim();
const db = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await db.connect();

let pass = 0;
let fail = 0;
const ok = (cond, label) => {
  if (cond) pass++;
  else fail++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
};
const as = async (uid) => {
  await db.query("reset role");
  await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: uid, role: "authenticated" })]);
  await db.query("set local role authenticated");
};
const expectError = async (sql, params, label) => {
  await db.query("savepoint s");
  try {
    await db.query(sql, params);
    ok(false, `${label} (should have been refused)`);
  } catch (e) {
    ok(true, `${label}: "${e.message}"`);
  }
  await db.query("rollback to savepoint s");
};

try {
  await db.query("begin");
  // An available for-sale item, its active owner, and an active buyer
  const { rows: [pickRow] } = await db.query(`
    select i.item_id, i.owner_id, b.price
    from public.items i join public.buyable_items b using (item_id) join public.profiles p on p.id = i.owner_id
    where i.status = 'available' and p.account_status = 'active' order by i.item_id limit 1`);
  const { rows: [buyerRow] } = await db.query(
    "select id from public.profiles where account_status = 'active' and role = 'student' and id <> $1 order by created_at limit 1", [pickRow.owner_id]);
  const { item_id: item, owner_id: owner } = pickRow;
  const buyer = buyerRow.id;

  // Signed out (anon) sees nothing
  await db.query("set local role anon");
  await expectError("select count(*) from public.items", [], "anon cannot read items");
  await db.query("reset role");

  await as(buyer);
  const { rows: [vis] } = await db.query(`select
    (select count(*) from public.items)::int as items,
    (select count(*) from public.transactions)::int as deals,
    (select count(*) from public.transactions where buyer_id <> $1
       and item_id not in (select item_id from public.items where owner_id = $1))::int as others_deals,
    (select count(*) from public.messages)::int as msgs`, [buyer]);
  ok(vis.items > 2000, `student reads all listings (${vis.items})`);
  ok(vis.others_deals === 0, `student sees only their own deals (${vis.deals} visible, 0 belong to others)`);
  await expectError("update public.items set title = 'hacked' where item_id = $1", [item], "student cannot edit someone else's listing directly");
  await expectError("insert into public.reviews (transaction_id, reviewer_id, reviewee_id, rating) values (1, $1, $2, 5)", [buyer, owner], "student cannot write reviews directly");

  const { rows: [{ request_deal: tx }] } = await db.query("select public.request_deal($1, 'sale')", [item]);
  ok(tx > 0, `buyer requests to buy item ${item} (deal ${tx})`);
  await expectError("select public.request_deal($1, 'sale')", [item], "duplicate request refused");
  await expectError("select public.accept_deal($1)", [tx], "buyer cannot accept their own request");

  const { rows: [{ open_conversation: conv }] } = await db.query("select public.open_conversation($1)", [item]);
  await db.query("insert into public.messages (conversation_id, sender_id, body) values ($1, $2, 'Is this still available?')", [conv, buyer]);
  ok(true, `buyer opens a chat and sends a message (conversation ${conv})`);
  await expectError("insert into public.messages (conversation_id, sender_id, body) values ($1, $2, 'spoof')", [conv, owner], "buyer cannot send as the owner");

  await as(owner);
  await expectError("select public.request_deal($1, 'sale')", [item], "owner cannot buy their own item");
  const { rows: [seen] } = await db.query("select count(*)::int as n from public.messages where conversation_id = $1", [conv]);
  ok(seen.n === 1, "owner sees the buyer's message");
  await db.query("select public.accept_deal($1)", [tx]);
  await db.query("select public.hand_over($1)", [tx]);
  ok(true, "owner accepts and hands over");

  await as(buyer);
  await db.query("select public.confirm_received($1)", [tx]);
  const { rows: [st] } = await db.query(
    "select t.status, i.status as item_status from public.transactions t join public.items i using (item_id) where transaction_id = $1", [tx]);
  ok(st.status === "completed" && st.item_status === "sold", `buyer confirms; deal ${st.status}, item ${st.item_status}`);
  await db.query("select public.leave_review($1, 5::smallint, 'Great seller')", [tx]);
  await expectError("select public.leave_review($1, 4::smallint, 'again')", [tx], "second review refused");

  // A third student can't see this private deal or chat
  const { rows: [third] } = await db.query("reset role; select 1").then(() =>
    db.query("select id from public.profiles where account_status = 'active' and id not in ($1, $2) order by created_at desc limit 1", [buyer, owner]));
  await as(third.id);
  const { rows: [spy] } = await db.query(
    "select (select count(*) from public.transactions where transaction_id = $1)::int as deal, (select count(*) from public.messages where conversation_id = $2)::int as msgs", [tx, conv]);
  ok(spy.deal === 0 && spy.msgs === 0, "a third student can't see that deal or chat");
} catch (e) {
  fail++;
  console.error("Unexpected error:", e.message);
} finally {
  await db.query("rollback");
  await db.end();
}
console.log(`\n${pass} passed, ${fail} failed (all changes rolled back)`);
process.exitCode = fail ? 1 : 0;
