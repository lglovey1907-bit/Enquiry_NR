import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function StaffHome() {
  const { user, profile } = await getSession();
  if (!user) redirect("/login");
  if (!profile) redirect("/register?step=details");
  if (profile.status !== "approved") redirect("/pending");
  redirect(profile.role === "admin" ? "/admin" : "/dashboard");
}
