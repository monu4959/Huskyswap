"use client";

// App data, backed by Supabase. Reads run as the signed-in student (row-level
// security filters them); every write goes through a database function from
// supabase/migrations/0002_app_access.sql, which enforces the marketplace rules.
// The store keeps a local copy of what this student can see and refreshes the
// parts an action or a realtime event changes.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { RealtimeChannel, Session } from "@supabase/supabase-js";
import { PHOTO_BUCKET, photoUrl, supabase } from "./supabase";
import type {
  Conversation,
  Item,
  ItemCategory,
  ItemCondition,
  Message,
  Profile,
  Report,
  ReturnCondition,
  Review,
  SavedItem,
  Transaction,
  TransactionType,
} from "./types";

interface Db {
  profiles: Profile[];
  items: Item[];
  saved: SavedItem[];
  conversations: Conversation[];
  messages: Message[];
  transactions: Transaction[];
  reviews: Review[]; // only reviews by or about the signed-in student
  ratings: Rating[]; // everyone's average rating, from the profile_ratings view
}

interface Rating {
  profile_id: string;
  review_count: number;
  average_rating: number;
}

const EMPTY_DB: Db = { profiles: [], items: [], saved: [], conversations: [], messages: [], transactions: [], reviews: [], ratings: [] };

export class ActionError extends Error {}

export interface NewListing {
  title: string;
  description: string;
  category: ItemCategory;
  condition: ItemCondition;
  meetup_spot_id: number;
  sale: { price: number } | null;
  rental: { price_per_week: number; deposit: number } | null;
  images: string[]; // data URLs from the photo picker
}

// ---------- reads ----------

// PostgREST returns at most 1,000 rows per request
async function fetchAll<T>(query: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>) {
  const PAGE = 1000;
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await query(from, from + PAGE - 1);
    if (error) throw new ActionError(error.message);
    rows.push(...(data ?? []));
    if (!data || data.length < PAGE) return rows;
  }
}

const ITEM_COLUMNS =
  "item_id, owner_id, meetup_spot_id, title, description, category, condition, status, created_at, updated_at, buyable_items(price), borrowable_items(price_per_week, deposit), item_images(storage_path, position)";

interface ItemRow {
  item_id: number;
  owner_id: string;
  meetup_spot_id: number;
  title: string;
  description: string;
  category: ItemCategory;
  condition: ItemCondition;
  status: Item["status"];
  created_at: string;
  updated_at: string;
  buyable_items: { price: number } | { price: number }[] | null;
  borrowable_items: { price_per_week: number; deposit: number } | { price_per_week: number; deposit: number }[] | null;
  item_images: { storage_path: string; position: number }[];
}

// Embedded one-to-one rows may come back as an object or a one-element array
const one = <T,>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null));

const toItem = (r: ItemRow): Item => {
  const sale = one(r.buyable_items);
  const rent = one(r.borrowable_items);
  return {
  item_id: r.item_id,
  owner_id: r.owner_id,
  meetup_spot_id: r.meetup_spot_id,
  title: r.title,
  description: r.description,
  category: r.category,
  condition: r.condition,
  status: r.status,
  created_at: r.created_at,
  updated_at: r.updated_at,
  sale: sale ? { price: Number(sale.price) } : null,
  rental: rent ? { price_per_week: Number(rent.price_per_week), deposit: Number(rent.deposit) } : null,
  images: [...(r.item_images ?? [])].sort((a, b) => a.position - b.position).map((i) => photoUrl(i.storage_path)),
  };
};

interface TransactionRow extends Omit<Transaction, "rental" | "agreed_price"> {
  agreed_price: number | string;
  rentals: Transaction["rental"] | NonNullable<Transaction["rental"]>[] | null;
}
const toTransaction = (r: TransactionRow): Transaction => {
  const rental = one(r.rentals);
  return {
  transaction_id: r.transaction_id,
  item_id: r.item_id,
  buyer_id: r.buyer_id,
  type: r.type,
  agreed_price: Number(r.agreed_price),
  status: r.status,
  created_at: r.created_at,
  completed_at: r.completed_at,
  rental: rental ? { ...rental, deposit_agreed: Number(rental.deposit_agreed) } : null,
  };
};

const loadItems = (ids?: number[]) =>
  fetchAll<ItemRow>((from, to) => {
    let q = supabase.from("items").select(ITEM_COLUMNS).order("item_id").range(from, to);
    if (ids) q = q.in("item_id", ids);
    return q;
  }).then((rows) => rows.map(toItem));

const loadDeals = () =>
  fetchAll<TransactionRow>((from, to) =>
    supabase
      .from("transactions")
      .select("transaction_id, item_id, buyer_id, type, agreed_price, status, created_at, completed_at, rentals(start_date, due_date, deposit_agreed, returned_at, return_condition)")
      .order("transaction_id")
      .range(from, to),
  ).then((rows) => rows.map(toTransaction));

const loadChats = async () => {
  const [conversations, messages] = await Promise.all([
    fetchAll<Conversation>((from, to) => supabase.from("conversations").select("*").order("conversation_id").range(from, to)),
    fetchAll<Message>((from, to) => supabase.from("messages").select("*").order("message_id").range(from, to)),
  ]);
  return { conversations, messages };
};

const loadMyReviews = (uid: string) =>
  fetchAll<Review>((from, to) =>
    supabase.from("reviews").select("*").or(`reviewer_id.eq.${uid},reviewee_id.eq.${uid}`).order("review_id").range(from, to),
  );

const loadRatings = () =>
  fetchAll<Rating>((from, to) => supabase.from("profile_ratings").select("*").order("profile_id").range(from, to)).then((rows) =>
    rows.map((r) => ({ ...r, average_rating: Number(r.average_rating) })),
  );

// Listings a student needs: everything on the market, their own, and anything
// their deals, chats or saved list point at (not the thousands of old sold ones)
async function loadRelevantItems(uid: string, relatedIds: number[]) {
  const [active, mine] = await Promise.all([
    fetchAll<ItemRow>((from, to) =>
      supabase.from("items").select(ITEM_COLUMNS).in("status", ["available", "reserved", "rented_out"]).order("item_id").range(from, to),
    ),
    fetchAll<ItemRow>((from, to) => supabase.from("items").select(ITEM_COLUMNS).eq("owner_id", uid).order("item_id").range(from, to)),
  ]);
  const have = new Set([...active, ...mine].map((r) => r.item_id));
  const missing = [...new Set(relatedIds)].filter((id) => !have.has(id));
  const extra: Item[] = [];
  for (let i = 0; i < missing.length; i += 200) extra.push(...(await loadItems(missing.slice(i, i + 200))));
  const byId = new Map<number, Item>();
  for (const it of [...active.map(toItem), ...mine.map(toItem), ...extra]) byId.set(it.item_id, it);
  return [...byId.values()].sort((a, b) => a.item_id - b.item_id);
}

const loadSaved = (uid: string) =>
  fetchAll<SavedItem>((from, to) => supabase.from("saved_items").select("*").eq("user_id", uid).range(from, to));

const loadProfiles = () =>
  fetchAll<Omit<Profile, "email">>((from, to) =>
    supabase.from("profiles").select("id, name, role, account_status, created_at").order("id").range(from, to),
  );

// Turn a Supabase error into a message the toast can show
async function rpc<T = unknown>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw new ActionError(error.message);
  return data as T;
}

async function dataUrlToBlob(dataUrl: string) {
  return (await fetch(dataUrl)).blob();
}

// ---------- store ----------

function useStoreValue() {
  const [session, setSession] = useState<Session | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [db, setDb] = useState<Db>(EMPTY_DB);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const me = session?.user.id ?? null;
  const meRef = useRef(me);
  // a name set during sign-up wins over a profile load that started earlier
  const nameOverride = useRef<string | null>(null);
  useEffect(() => {
    meRef.current = me;
  }, [me]);

  // Session: restored from storage on load, then kept current
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setAuthReady(true);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  const patch = useCallback((fn: (d: Db) => Db) => setDb((d) => fn(d)), []);

  const refreshItems = useCallback(
    async (ids: number[]) => {
      if (!ids.length) return;
      const fresh = await loadItems(ids);
      const byId = new Map(fresh.map((i) => [i.item_id, i]));
      patch((d) => ({
        ...d,
        items: [...d.items.filter((i) => !byId.has(i.item_id)), ...fresh].sort((a, b) => a.item_id - b.item_id),
      }));
    },
    [patch],
  );
  const refreshDeals = useCallback(async () => {
    const transactions = await loadDeals();
    patch((d) => ({ ...d, transactions }));
  }, [patch]);
  const refreshChats = useCallback(async () => {
    const chats = await loadChats();
    patch((d) => ({ ...d, ...chats }));
  }, [patch]);
  const refreshReviews = useCallback(async () => {
    const uid = meRef.current;
    if (!uid) return;
    const [reviews, ratings] = await Promise.all([loadMyReviews(uid), loadRatings()]);
    patch((d) => ({ ...d, reviews, ratings }));
  }, [patch]);

  // Everything this student can see, loaded once per sign-in
  useEffect(() => {
    if (!me) return;
    let cancelled = false;
    (async () => {
      try {
        const [profiles, saved, transactions, chats, reviews, ratings] = await Promise.all([
          loadProfiles(),
          loadSaved(me),
          loadDeals(),
          loadChats(),
          loadMyReviews(me),
          loadRatings(),
        ]);
        const related = [
          ...transactions.map((t) => t.item_id),
          ...chats.conversations.map((c) => c.item_id),
          ...saved.map((s) => s.item_id),
        ];
        const items = await loadRelevantItems(me, related);
        if (cancelled) return;
        const email = session?.user.email ?? "";
        setDb({
          profiles: profiles.map((p) =>
            p.id === me ? { ...p, email, name: nameOverride.current ?? p.name } : { ...p, email: "" },
          ),
          items,
          saved,
          transactions,
          reviews,
          ratings,
          ...chats,
        });
        setLoadedFor(me);
        setLoadError(null);
      } catch (e) {
        if (!cancelled) setLoadError((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reload only when the signed-in student changes
  }, [me]);

  // Realtime: new messages and deal changes involving this student (RLS-filtered)
  useEffect(() => {
    if (!me) return;
    const channel: RealtimeChannel = supabase
      .channel(`student-${me}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "messages" }, ({ new: m }) => {
        const msg = m as Message;
        patch((d) => (d.messages.some((x) => x.message_id === msg.message_id) ? d : { ...d, messages: [...d.messages, msg] }));
        // a chat started by someone else: fetch its conversation row
        refreshChats().catch(() => {});
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "transactions" }, ({ new: t }) => {
        refreshDeals().catch(() => {});
        const itemId = (t as Partial<Transaction>)?.item_id;
        if (itemId) refreshItems([itemId]).catch(() => {});
      })
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [me, patch, refreshChats, refreshDeals, refreshItems]);

  // ---------- auth ----------
  const sendCode = useCallback(async (email: string) => {
    const { error } = await supabase.auth.signInWithOtp({ email, options: { shouldCreateUser: true } });
    if (error) throw new ActionError(error.message);
  }, []);

  // New accounts get their email's local part as a placeholder name
  const isNewAccount = async (userId: string, email: string) => {
    const { data: profile } = await supabase.from("profiles").select("name").eq("id", userId).single();
    return !profile || profile.name === email.split("@")[0];
  };

  const verifyCode = useCallback(async (email: string, token: string) => {
    const { data, error } = await supabase.auth.verifyOtp({ email, token, type: "email" });
    if (error) throw new ActionError(error.message);
    return { isNew: await isNewAccount(data.user!.id, email) };
  }, []);

  // DEVELOPMENT ONLY: email-only sign-in through /api/dev-login (no code is sent)
  const devSignIn = useCallback(async (email: string) => {
    const res = await fetch("/api/dev-login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new ActionError(body.error ?? "Dev sign-in is turned off. Set DEV_LOGIN=true in .env.local and use npm run dev.");
    const { data, error } = await supabase.auth.setSession({ access_token: body.access_token, refresh_token: body.refresh_token });
    if (error || !data.user) throw new ActionError(error?.message ?? "Sign-in failed.");
    return { isNew: await isNewAccount(data.user.id, email) };
  }, []);

  const signOut = useCallback(async () => {
    await supabase.auth.signOut();
    setDb(EMPTY_DB);
    setLoadedFor(null);
  }, []);

  const updateName = useCallback(
    async (name: string) => {
      await rpc("update_my_name", { p_name: name });
      const clean = name.trim();
      nameOverride.current = clean;
      patch((d) => ({ ...d, profiles: d.profiles.map((p) => (p.id === meRef.current ? { ...p, name: clean } : p)) }));
    },
    [patch],
  );

  // ---------- listings ----------
  const createListing = useCallback(
    async (input: NewListing) => {
      const uid = meRef.current;
      if (!uid) throw new ActionError("Sign in first.");
      // Photos go to the student's own folder in Storage
      const paths: string[] = [];
      for (const dataUrl of input.images) {
        const path = `${uid}/${crypto.randomUUID()}.jpg`;
        const { error } = await supabase.storage
          .from(PHOTO_BUCKET)
          .upload(path, await dataUrlToBlob(dataUrl), { contentType: "image/jpeg" });
        if (error) throw new ActionError(`Photo upload failed: ${error.message}`);
        paths.push(path);
      }
      const id = await rpc<number>("create_listing", {
        p_title: input.title,
        p_description: input.description,
        p_category: input.category,
        p_condition: input.condition,
        p_meetup_spot_id: input.meetup_spot_id,
        p_sale_price: input.sale?.price ?? null,
        p_rent_price: input.rental?.price_per_week ?? null,
        p_deposit: input.rental?.deposit ?? 0,
        p_image_paths: paths,
      });
      await refreshItems([id]);
      return id;
    },
    [refreshItems],
  );

  const removeListing = useCallback(
    async (itemId: number) => {
      await rpc("remove_listing", { p_item_id: itemId });
      await refreshItems([itemId]);
    },
    [refreshItems],
  );

  const toggleSave = useCallback(
    async (itemId: number) => {
      const uid = meRef.current;
      if (!uid) return;
      const has = db.saved.some((s) => s.item_id === itemId);
      // optimistic: flip now, undo if the write fails
      patch((d) => ({
        ...d,
        saved: has ? d.saved.filter((s) => s.item_id !== itemId) : [{ user_id: uid, item_id: itemId, saved_at: new Date().toISOString() }, ...d.saved],
      }));
      const { error } = has
        ? await supabase.from("saved_items").delete().eq("user_id", uid).eq("item_id", itemId)
        : await supabase.from("saved_items").insert({ user_id: uid, item_id: itemId });
      if (error) {
        setDb((d) => ({ ...d, saved: has ? [...d.saved, { user_id: uid, item_id: itemId, saved_at: new Date().toISOString() }] : d.saved.filter((s) => s.item_id !== itemId) }));
        throw new ActionError(error.message);
      }
    },
    [db.saved, patch],
  );

  // ---------- messaging ----------
  const openConversation = useCallback(
    async (itemId: number, buyerId?: string) => {
      const id = await rpc<number>("open_conversation", { p_item_id: itemId, p_buyer_id: buyerId ?? null });
      if (!db.conversations.some((c) => c.conversation_id === id)) await refreshChats();
      return id;
    },
    [db.conversations, refreshChats],
  );

  const sendMessage = useCallback(
    async (conversationId: number, body: string) => {
      const text = body.trim();
      const uid = meRef.current;
      if (!text || !uid) return;
      const { data, error } = await supabase
        .from("messages")
        .insert({ conversation_id: conversationId, sender_id: uid, body: text.slice(0, 2000) })
        .select()
        .single();
      if (error) throw new ActionError(error.message);
      patch((d) => (d.messages.some((m) => m.message_id === data.message_id) ? d : { ...d, messages: [...d.messages, data as Message] }));
    },
    [patch],
  );

  const markRead = useCallback(
    async (conversationId: number) => {
      const uid = meRef.current;
      const unread = db.messages.some((m) => m.conversation_id === conversationId && m.sender_id !== uid && !m.read_at);
      if (!unread) return;
      const now = new Date().toISOString();
      patch((d) => ({
        ...d,
        messages: d.messages.map((m) => (m.conversation_id === conversationId && m.sender_id !== uid && !m.read_at ? { ...m, read_at: now } : m)),
      }));
      await rpc("mark_conversation_read", { p_conversation_id: conversationId }).catch(() => {});
    },
    [db.messages, patch],
  );

  // ---------- deals ----------
  // Run a deal function, then refresh the deal list and the item it touched
  const dealAction = useCallback(
    async (fn: string, args: Record<string, unknown>, itemId?: number) => {
      const result = await rpc(fn, args);
      await Promise.all([refreshDeals(), itemId ? refreshItems([itemId]) : Promise.resolve()]);
      return result;
    },
    [refreshDeals, refreshItems],
  );
  const itemOf = useCallback((txId: number) => db.transactions.find((t) => t.transaction_id === txId)?.item_id, [db.transactions]);

  const requestDeal = useCallback(
    (itemId: number, type: TransactionType) => dealAction("request_deal", { p_item_id: itemId, p_type: type }, itemId) as Promise<number>,
    [dealAction],
  );
  const acceptDeal = useCallback((txId: number) => dealAction("accept_deal", { p_tx: txId }, itemOf(txId)), [dealAction, itemOf]);
  const declineDeal = useCallback((txId: number) => dealAction("decline_deal", { p_tx: txId }, itemOf(txId)), [dealAction, itemOf]);
  const cancelDeal = useCallback((txId: number) => dealAction("cancel_deal", { p_tx: txId }, itemOf(txId)), [dealAction, itemOf]);
  const handOver = useCallback((txId: number) => dealAction("hand_over", { p_tx: txId }, itemOf(txId)), [dealAction, itemOf]);
  const confirmReceived = useCallback((txId: number) => dealAction("confirm_received", { p_tx: txId }, itemOf(txId)), [dealAction, itemOf]);
  const markReturned = useCallback(
    (txId: number, condition: ReturnCondition) => dealAction("mark_returned", { p_tx: txId, p_condition: condition }, itemOf(txId)),
    [dealAction, itemOf],
  );
  const closeRental = useCallback((txId: number) => dealAction("close_rental", { p_tx: txId }, itemOf(txId)), [dealAction, itemOf]);

  // ---------- reviews & reports ----------
  const leaveReview = useCallback(
    async (txId: number, rating: number, comment: string) => {
      await rpc("leave_review", { p_tx: txId, p_rating: rating, p_comment: comment });
      await refreshReviews();
    },
    [refreshReviews],
  );

  const submitReport = useCallback(async (target: Pick<Report, "item_id" | "transaction_id" | "reported_user_id">, reason: string) => {
    const text = reason.trim();
    if (text.length < 5) throw new ActionError("Tell us a bit more (at least 5 characters).");
    const { error } = await supabase.from("reports").insert({ ...target, reporter_id: meRef.current, reason: text.slice(0, 1000) });
    if (error) throw new ActionError(error.message);
  }, []);

  // ---------- selectors ----------
  const selectors = useMemo(() => {
    const profileById = new Map(db.profiles.map((p) => [p.id, p]));
    const itemById = new Map(db.items.map((i) => [i.item_id, i]));
    const ratings = new Map(db.ratings.map((r) => [r.profile_id, r]));
    const savedIds = new Set(db.saved.map((s) => s.item_id));

    const profile = (id: string) => profileById.get(id);
    const item = (id: number) => itemById.get(id);
    const ratingFor = (userId: string) => {
      const r = ratings.get(userId);
      return { count: r?.review_count ?? 0, average: r ? r.average_rating : null };
    };
    const isSaved = (itemId: number) => savedIds.has(itemId);
    const myConversations = db.conversations
      .filter((c) => c.buyer_id === me || item(c.item_id)?.owner_id === me)
      .map((c) => {
        const msgs = db.messages.filter((m) => m.conversation_id === c.conversation_id);
        return { conversation: c, last: msgs.at(-1) ?? null, unread: msgs.filter((m) => m.sender_id !== me && !m.read_at).length };
      })
      .sort((a, b) => (b.last?.sent_at ?? b.conversation.created_at).localeCompare(a.last?.sent_at ?? a.conversation.created_at));
    const myDeals = db.transactions.filter((t) => t.buyer_id === me || item(t.item_id)?.owner_id === me);
    // Deals waiting on the signed-in student: owners answer, hand over and close;
    // buyers confirm a sale once they have the item.
    const needsMe = (t: Transaction) =>
      item(t.item_id)?.owner_id === me
        ? ["requested", "accepted", "returned"].includes(t.status)
        : t.status === "handed_over" && t.type === "sale";
    return {
      profile,
      item,
      ratingFor,
      isSaved,
      myConversations,
      myDeals,
      needsMe,
      unreadCount: myConversations.reduce((s, c) => s + c.unread, 0),
      actionCount: myDeals.filter(needsMe).length,
    };
  }, [db, me]);

  return {
    // ready: auth known and, when signed in, this student's data is loaded
    ready: authReady && (!me || loadedFor === me),
    loadError,
    db,
    me,
    email: session?.user.email ?? null,
    ...selectors,
    sendCode,
    verifyCode,
    devSignIn,
    signOut,
    updateName,
    createListing,
    removeListing,
    toggleSave,
    openConversation,
    sendMessage,
    markRead,
    requestDeal,
    acceptDeal,
    declineDeal,
    cancelDeal,
    handOver,
    confirmReceived,
    markReturned,
    closeRental,
    leaveReview,
    submitReport,
  };
}

type Store = ReturnType<typeof useStoreValue>;
const StoreContext = createContext<Store | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const value = useStoreValue();
  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore() {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error("useStore must be used inside <StoreProvider>");
  return ctx;
}
