"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";

type Usage = { day: string; calls: number; month_limit: number | null; month_remaining: number | null };
type Settings = { last_sync_at: string | null; last_sync_note: string | null; sync_minutes: number };
const IST = "Asia/Kolkata";
const SYNC_OPTIONS = [5, 10, 15, 20, 30, 60];
const hhmm = (s: string | null) => s ? new Intl.DateTimeFormat("en-IN", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: IST }).format(new Date(s)) : "–";
const label = (m: number) => (m < 60 ? `${m} min` : "1 hr");

/** Health of the automatic RailRadar sync, the request budget, and (admin only) how often the board updates. */
export default function SyncStatus({ isAdmin }: { isAdmin: boolean }) {
  const [s, setS] = useState<Settings | null>(null);
  const [u, setU] = useState<Usage | null>(null);
  const [value, setValue] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  useEffect(() => {
    const load = async () => {
      const sb = createClient();
      const [{ data: st }, { data: us }] = await Promise.all([
        sb.from("settings").select("last_sync_at,last_sync_note,sync_minutes").eq("id", 1).maybeSingle(),
        sb.from("api_usage").select("day,calls,month_limit,month_remaining").order("day", { ascending: false }).limit(1).maybeSingle(),
      ]);
      setS(st as Settings | null); setU(us as Usage | null);
      setValue(v => v ?? (st as Settings | null)?.sync_minutes ?? 15);
    };
    load();
    const t = setInterval(load, 60000);
    return () => clearInterval(t);
  }, []);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (value == null) return;
    setBusy(true); setMsg(null);
    const { error } = await createClient().from("settings").update({ sync_minutes: value }).eq("id", 1);
    setBusy(false);
    if (error) { setMsg({ kind: "err", text: error.message }); return; }
    setS(p => (p ? { ...p, sync_minutes: value } : p));
    setMsg({ kind: "ok", text: `The board will update every ${label(value)}, starting from the next update.` });
  }

  const every = s?.sync_minutes ?? 15;
  const stale = s?.last_sync_at ? Date.now() - new Date(s.last_sync_at).getTime() > (every * 2 + 10) * 60000 : true;
  return (
    <section className="panel" aria-labelledby="sync-h">
      <div>
        <h2 id="sync-h">Automatic updates</h2>
        <p className="lede">
          Seats, running status and platforms come from RailRadar every {label(every)}. No computer needs to stay on.
          A shorter interval gives fresher figures but uses the monthly request allowance faster; the daily limit still applies.
        </p>
      </div>
      <div className="row" style={{ gap: 24, flexWrap: "wrap" }}>
        <span>Last update <b className="num">{hhmm(s?.last_sync_at ?? null)}</b>{stale && s && <span className="pill error" style={{ marginLeft: 8 }}>Delayed</span>}</span>
        <span>Requests today <b className="num">{u?.calls ?? 0}</b></span>
        <span>Left this month <b className="num">{u?.month_remaining?.toLocaleString("en-IN") ?? "–"}</b>{u?.month_limit ? ` of ${u.month_limit.toLocaleString("en-IN")}` : ""}</span>
      </div>
      {isAdmin ? (
        <form onSubmit={save} className="setting">
          <label htmlFor="sync">Update the board every
            <select id="sync" value={value ?? ""} disabled={value == null} onChange={e => setValue(Number(e.target.value))}>
              {SYNC_OPTIONS.map(m => <option key={m} value={m}>{label(m)}</option>)}
            </select>
          </label>
          <button className="btn" type="submit" disabled={busy || value == null || value === every}>{busy ? "Saving…" : "Save"}</button>
        </form>
      ) : (
        <p className="lede" style={{ fontSize: ".85rem" }}>Board update interval: <b>{label(every)}</b> (set by the admin).</p>
      )}
      {msg && <div className={`msg ${msg.kind}`} role={msg.kind === "err" ? "alert" : "status"}>{msg.text}</div>}
      {s?.last_sync_note && <p className="lede" style={{ fontSize: ".8rem", wordBreak: "break-word" }}>{s.last_sync_note}</p>}
    </section>
  );
}
