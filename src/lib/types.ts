// Mirrors supabase/schema.sql. When the app moves to Supabase these become
// the row types (or get replaced by `supabase gen types typescript`).

export type UserRole = "student" | "admin";
export type AccountStatus = "active" | "suspended" | "deactivated";
export type ItemCategory =
  | "textbooks"
  | "electronics"
  | "furniture"
  | "kitchen"
  | "clothing"
  | "dorm_essentials"
  | "sports_outdoors"
  | "bikes_transport"
  | "other";
export type ItemCondition = "new" | "like_new" | "good" | "fair";
export type ItemStatus = "available" | "reserved" | "rented_out" | "sold" | "removed";
export type TransactionType = "sale" | "rental";
export type TransactionStatus =
  | "requested"
  | "accepted"
  | "declined"
  | "handed_over"
  | "returned"
  | "completed"
  | "cancelled";
export type ReturnCondition = "as_lent" | "minor_wear" | "damaged";
export type ReportStatus = "open" | "in_review" | "resolved";

export interface Profile {
  id: string;
  name: string;
  email: string; // lives in auth.users in Supabase
  role: UserRole;
  account_status: AccountStatus;
  created_at: string;
}

export interface MeetupSpot {
  spot_id: number;
  name: string;
}

export interface Item {
  item_id: number;
  owner_id: string;
  meetup_spot_id: number;
  title: string;
  description: string;
  category: ItemCategory;
  condition: ItemCondition;
  status: ItemStatus;
  created_at: string;
  updated_at: string;
  // buyable_items / borrowable_items, flattened. At least one is set.
  sale: { price: number } | null;
  rental: { price_per_week: number; deposit: number } | null;
  // item_images, ordered by position (0 = cover)
  images: string[];
}

export interface SavedItem {
  user_id: string;
  item_id: number;
  saved_at: string;
}

export interface Conversation {
  conversation_id: number;
  item_id: number;
  buyer_id: string;
  created_at: string;
}

export interface Message {
  message_id: number;
  conversation_id: number;
  sender_id: string;
  body: string;
  sent_at: string;
  read_at: string | null;
}

export interface Rental {
  start_date: string;
  due_date: string; // always start_date + 7 days in v1
  deposit_agreed: number;
  returned_at: string | null;
  return_condition: ReturnCondition | null;
}

export interface Transaction {
  transaction_id: number;
  item_id: number;
  buyer_id: string;
  type: TransactionType;
  agreed_price: number;
  status: TransactionStatus;
  created_at: string;
  completed_at: string | null;
  rental: Rental | null; // rentals row, created at hand-over
}

export interface Review {
  review_id: number;
  transaction_id: number;
  reviewer_id: string;
  reviewee_id: string;
  rating: number;
  comment: string | null;
  created_at: string;
}

export interface Report {
  report_id: number;
  reporter_id: string;
  item_id: number | null;
  transaction_id: number | null;
  reported_user_id: string | null;
  reason: string;
  status: ReportStatus;
  created_at: string;
}
