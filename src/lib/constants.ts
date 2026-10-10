import type {
  ItemCategory,
  ItemCondition,
  ItemStatus,
  ReturnCondition,
  TransactionStatus,
} from "./types";

export const APP_NAME = "HuskySwap";

// Same rule as public.enforce_nu_email() in supabase/schema.sql
export const NU_EMAIL = /^[^@]+@northeastern\.edu$/;
export const isNuEmail = (email: string) => NU_EMAIL.test(email.trim().toLowerCase());

export const RENTAL_DAYS = 7;

export const CATEGORY_LABEL: Record<ItemCategory, string> = {
  textbooks: "Textbooks",
  electronics: "Electronics",
  furniture: "Furniture",
  kitchen: "Kitchen",
  clothing: "Clothing",
  dorm_essentials: "Dorm essentials",
  sports_outdoors: "Sports & outdoors",
  bikes_transport: "Bikes & transport",
  other: "Other",
};

export const CATEGORIES = Object.keys(CATEGORY_LABEL) as ItemCategory[];

export const CONDITION_LABEL: Record<ItemCondition, string> = {
  new: "New",
  like_new: "Like new",
  good: "Good",
  fair: "Fair",
};

export const ITEM_STATUS_LABEL: Record<ItemStatus, string> = {
  available: "Available",
  reserved: "Reserved",
  rented_out: "Rented out",
  sold: "Sold",
  removed: "Removed",
};

export const DEAL_STATUS_LABEL: Record<TransactionStatus, string> = {
  requested: "Requested",
  accepted: "Accepted",
  declined: "Declined",
  handed_over: "Handed over",
  returned: "Returned",
  completed: "Completed",
  cancelled: "Cancelled",
};

export const RETURN_CONDITION_LABEL: Record<ReturnCondition, string> = {
  as_lent: "Same as lent",
  minor_wear: "Minor wear",
  damaged: "Damaged",
};

export const formatPrice = (n: number) =>
  n === 0 ? "Free" : `$${Number.isInteger(n) ? n : n.toFixed(2)}`;
