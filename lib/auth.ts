import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export type Profile = {
  id: string;
  email: string;
  full_name: string;
  hrms_id: string;
  role: "staff" | "admin";
  status: "pending" | "approved" | "rejected" | "disabled";
  created_at: string;
  reviewed_at: string | null;
};

/** Signed-in user and their profile (null profile = registration not finished). */
export async function getSession() {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { supabase, user: null, profile: null as Profile | null };
  const { data } = await supabase.from("profiles").select("*").eq("id", user.id).maybeSingle();
  return { supabase, user, profile: (data as Profile | null) ?? null };
}

/** Sends the visitor wherever their account state allows. */
export async function requireApproved(opts: { admin?: boolean } = {}) {
  const s = await getSession();
  if (!s.user) redirect("/login");
  if (!s.profile) redirect("/register?step=details");
  if (s.profile.status !== "approved") redirect("/pending");
  if (opts.admin && s.profile.role !== "admin") redirect("/dashboard");
  return s as typeof s & { profile: Profile };
}
