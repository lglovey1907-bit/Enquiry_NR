import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";

export default async function Home() {
  const { user, profile } = await getSession();
  if (!user) redirect("/login");
  if (!profile) redirect("/register?step=details");
  if (profile.status !== "approved") redirect("/pending");
  redirect(profile.role === "admin" ? "/admin" : "/dashboard");
}
