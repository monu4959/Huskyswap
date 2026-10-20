// Who is asking: checks the Supabase access token the browser sends and picks
// the text-to-SQL role. Admins get nlq_admin, everyone else nlq_student.

import { createClient } from "@supabase/supabase-js";
import type { DbRole } from "./types.ts";

export type Asker = { userId: string; role: DbRole };

export async function askerFrom(request: Request): Promise<Asker | Response> {
  const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!token) return Response.json({ error: "Sign in to ask questions." }, { status: 401 });

  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, {
    auth: { persistSession: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  const { data: auth } = await supabase.auth.getUser(token);
  if (!auth.user) return Response.json({ error: "Your session expired. Sign in again." }, { status: 401 });

  // Read as the student, so row-level security applies
  const { data: profile } = await supabase.from("profiles").select("role, account_status").eq("id", auth.user.id).single();
  if (!profile || profile.account_status !== "active") {
    return Response.json({ error: "Your account can't use this right now." }, { status: 403 });
  }
  return { userId: auth.user.id, role: profile.role === "admin" ? "nlq_admin" : "nlq_student" };
}
