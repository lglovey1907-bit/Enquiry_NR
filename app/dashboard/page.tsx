import Header from "@/components/Header";
import TrainsPanel from "@/components/TrainsPanel";
import DefaultInterval from "@/components/DefaultInterval";
import SyncStatus from "@/components/SyncStatus";
import { requireApproved } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const { profile } = await requireApproved();
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
