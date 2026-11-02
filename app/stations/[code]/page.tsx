import { notFound, redirect } from "next/navigation";
import Header from "@/components/Header";
import StationSettings from "@/components/StationSettings";
import { requireApproved } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function StationPage({ params }: { params: { code: string } }) {
  const code = params.code.toUpperCase();
  if (code === "NDLS") redirect("/dashboard");
  const { supabase, profile } = await requireApproved();
  const { data: st } = await supabase.from("stations").select("code,name_en").eq("code", code).maybeSingle();
  if (!st) notFound();
  const isAdmin = profile.role === "admin";
  if (!isAdmin) {
    const { data } = await supabase.from("station_admins").select("station").eq("station", code).eq("user_id", profile.id).maybeSingle();
    if (!data) redirect("/dashboard");
  }
  return (
    <>
      <Header profile={profile} active="stations" />
      <main className="wrap">
        <div>
          <h1>{st.code} · {st.name_en}</h1>
          <p className="lede">Keys, settings and live status for the {st.code} current-booking board.</p>
        </div>
        <StationSettings code={code} isAdmin={isAdmin} />
      </main>
    </>
  );
}
