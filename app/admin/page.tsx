import Header from "@/components/Header";
import AdminPanel from "@/components/AdminPanel";
import { requireApproved } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  const { profile } = await requireApproved({ admin: true });
  return (
    <>
      <Header profile={profile} active="admin" />
      <main className="wrap">
        <div>
          <h1>Staff approvals</h1>
          <p className="lede">Staff who register appear here as pending. Approve them to let them sign in to the staff dashboard.</p>
        </div>
        <AdminPanel selfId={profile.id} />
      </main>
    </>
  );
}
