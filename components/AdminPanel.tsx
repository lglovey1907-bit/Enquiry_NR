"use client";

import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import type { Profile } from "@/lib/auth";

type Tab = "pending" | "approved" | "closed";
const when = (s: string | null) => s ? new Date(s).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Kolkata" }) : "–";

export default function AdminPanel({ selfId }: { selfId: string }) {
  const [people, setPeople] = useState<Profile[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [tab, setTab] = useState<Tab>("pending");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    const { data, error } = await createClient().from("profiles").select("*").order("created_at", { ascending: false });
    if (error) setError(error.message); else setPeople(data as Profile[]);
    setLoaded(true);
  }, []);

  useEffect(() => { load(); const t = setInterval(load, 30000); return () => clearInterval(t); }, [load]);

  async function setStatus(p: Profile, status: Profile["status"]) {
    setBusyId(p.id); setError("");
    const { error } = await createClient().from("profiles").update({ status }).eq("id", p.id);
    setBusyId(null);
    if (error) { setError(error.message); return; }
    load();
  }

  const groups: Record<Tab, Profile[]> = {
    pending: people.filter(p => p.status === "pending"),
    approved: people.filter(p => p.status === "approved"),
    closed: people.filter(p => p.status === "rejected" || p.status === "disabled"),
  };
  const shown = groups[tab];

  return (
    <section className="panel">
      <div className="tabs" role="group" aria-label="Filter staff">
        <button type="button" aria-pressed={tab === "pending"} onClick={() => setTab("pending")}>Pending <span className="count">{groups.pending.length}</span></button>
        <button type="button" aria-pressed={tab === "approved"} onClick={() => setTab("approved")}>Approved <span className="count">{groups.approved.length}</span></button>
        <button type="button" aria-pressed={tab === "closed"} onClick={() => setTab("closed")}>Rejected / disabled <span className="count">{groups.closed.length}</span></button>
      </div>
      {error && <div className="msg err" role="alert">{error}</div>}
      {!loaded ? <div className="empty">Loading staff…</div> : shown.length === 0 ? (
        <div className="empty">
          {tab === "pending" ? "No registrations waiting. New sign-ups appear here." : tab === "approved" ? "No approved staff yet." : "Nobody rejected or disabled."}
        </div>
      ) : (
        <div className="tablewrap">
          <table>
            <thead><tr><th>Name</th><th>HRMS ID</th><th>Email</th><th>Registered</th><th>Status</th><th><span className="sr">Actions</span></th></tr></thead>
            <tbody>
              {shown.map(p => (
                <tr key={p.id}>
                  <td>{p.full_name}{p.role === "admin" && <> <span className="pill approved">admin</span></>}</td>
                  <td className="num">{p.hrms_id}</td>
                  <td>{p.email}</td>
                  <td className="num">{when(p.created_at)}</td>
                  <td><span className={`pill ${p.status}`}>{p.status}</span></td>
                  <td>
                    {p.id !== selfId && (
                      <div className="actions">
                        {p.status !== "approved" && (
                          <button className="btn ok sm" type="button" disabled={busyId === p.id} onClick={() => setStatus(p, "approved")}>
                            {p.status === "pending" ? "Approve" : "Restore"}
                          </button>
                        )}
                        {p.status === "pending" && (
                          <button className="btn no sm" type="button" disabled={busyId === p.id} onClick={() => setStatus(p, "rejected")}>Reject</button>
                        )}
                        {p.status === "approved" && (
                          <button className="btn no sm" type="button" disabled={busyId === p.id} onClick={() => setStatus(p, "disabled")}>Disable</button>
                        )}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
