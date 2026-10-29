"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";

type Usage = { day: string; calls: number; month_limit: number | null; month_remaining: number | null };
const IST = "Asia/Kolkata";
const hhmm = (s: string | null) => s ? new Intl.DateTimeFormat("en-IN", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: IST }).format(new Date(s)) : "–";

/** Health of the automatic RailRadar sync and the API request budget. */
export default function SyncStatus() {
  const [s, setS] = useState<{ last_sync_at: string | null; last_sync_note: string | null } | null>(null);
  const [u, setU] = useState<Usage | null>(null);
  useEffect(() => {
    const load = async () => {
      const sb = createClient();
      const [{ data: st }, { data: us }] = await Promise.all([
        sb.from("settings").select("last_sync_at,last_sync_note").eq("id", 1).maybeSingle(),
        sb.from("api_usage").select("day,calls,month_limit,month_remaining").order("day", { ascending: false }).limit(1).maybeSingle(),
      ]);
      setS(st); setU(us as Usage | null);
    };
    load();
    const t = setInterval(load, 60000);
    return () => clearInterval(t);
  }, []);
  const stale = s?.last_sync_at ? Date.now() - new Date(s.last_sync_at).getTime() > 40 * 60000 : true;
  return (
    <section className="panel" aria-labelledby="sync-h">
      <div>
        <h2 id="sync-h">Automatic updates</h2>
        <p className="lede">Seats, running status and platforms come from RailRadar every 15 minutes. No computer needs to stay on.</p>
      </div>
      <div className="row" style={{ gap: 24, flexWrap: "wrap" }}>
        <span>Last update <b className="num">{hhmm(s?.last_sync_at ?? null)}</b>{stale && s && <span className="pill error" style={{ marginLeft: 8 }}>Delayed</span>}</span>
        <span>Requests today <b className="num">{u?.calls ?? 0}</b></span>
        <span>Left this month <b className="num">{u?.month_remaining?.toLocaleString("en-IN") ?? "–"}</b>{u?.month_limit ? ` of ${u.month_limit.toLocaleString("en-IN")}` : ""}</span>
      </div>
      {s?.last_sync_note && <p className="lede" style={{ fontSize: ".8rem", wordBreak: "break-word" }}>{s.last_sync_note}</p>}
    </section>
  );
}
