import Header from "@/components/Header";
import TrainsPanel from "@/components/TrainsPanel";
import { requireApproved } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const { profile } = await requireApproved();
  return (
    <>
      <Header profile={profile} active="dashboard" />
      <main className="wrap">
        <div>
          <h1>Trains on the board</h1>
          <p className="lede">
            Add a train departing New Delhi and choose how often its seats are checked. The first check runs within
            15 minutes on its journey date, then at your chosen interval until departure, when it leaves the board.
          </p>
        </div>
        <TrainsPanel userId={profile.id} isAdmin={profile.role === "admin"} />
      </main>
    </>
  );
}
