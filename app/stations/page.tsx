import { redirect } from "next/navigation";
import Header from "@/components/Header";
import StationsList from "@/components/StationsList";
import { requireApproved } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function StationsPage() {
  const { supabase, profile } = await requireApproved();
  const isAdmin = profile.role === "admin";
  const { data } = await supabase.from("station_admins").select("station").eq("user_id", profile.id);
  const manages = (data ?? []).map(r => r.station as string);
  if (!isAdmin && manages.length === 0) redirect("/dashboard");
  return (
    <>
      <Header profile={profile} active="stations" />
      <main className="wrap">
        <div>
          <h1>Station boards</h1>
          <p className="lede">Current-booking boards for stations other than New Delhi. Each station uses its own API keys. New Delhi&apos;s board and settings are unchanged under Trains.</p>
        </div>
        <StationsList isAdmin={isAdmin} manages={manages} />
      </main>
    </>
  );
}
