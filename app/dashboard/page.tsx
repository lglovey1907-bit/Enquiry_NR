import Header from "@/components/Header";
import TrainsPanel from "@/components/TrainsPanel";
import DefaultInterval from "@/components/DefaultInterval";
import SyncStatus from "@/components/SyncStatus";
import { redirect } from "next/navigation";
import { requireApproved } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const { supabase, profile } = await requireApproved();
  // This page is New Delhi's. A station admin (e.g. ANVT's CMI) goes to their own station instead.
  if (profile.role !== "admin") {
    const { data } = await supabase.from("station_admins").select("station").eq("user_id", profile.id);
    const mine = (data ?? []).map(r => r.station as string);
    if (mine.length === 1) redirect(`/stations/${mine[0]}`);
    if (mine.length > 1) redirect("/stations");
  }
  return (
    <>
      <Header profile={profile} active="dashboard" />
      <main className="wrap">
        <div>
          <h1>Trains departing in the next 4 hours</h1>
          <p className="lede">
            Live status of the seat checks behind the public board. Use Check now for a train passengers are asking
            about, or Hide to take a train off the board.
          </p>
        </div>
        <SyncStatus isAdmin={profile.role === "admin"} />
        <DefaultInterval />
        <TrainsPanel />
      </main>
    </>
  );
}
