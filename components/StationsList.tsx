"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";

type Row = { code: string; name_en: string; name_hi: string | null; active: boolean; last_sync_at: string | null };
const when = (s: string | null) => s ? new Date(s).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Kolkata" }) : "–";

/** Stations other than New Delhi. The admin can add one; station admins see the stations they manage. */
export default function StationsList({ isAdmin, manages }: { isAdmin: boolean; manages: string[] }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [code, setCode] = useState("");
  const [en, setEn] = useState("");
  const [hi, setHi] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const load = useCallback(async () => {
    const { data } = await createClient().from("stations").select("code,name_en,name_hi,active,last_sync_at").order("code");
    setRows(((data ?? []) as Row[]).filter(r => isAdmin || manages.includes(r.code)));
    setLoaded(true);
  }, [isAdmin, manages]);
  useEffect(() => { load(); }, [load]);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    const c = code.trim().toUpperCase();
    if (!/^[A-Z]{2,5}$/.test(c)) { setMsg({ kind: "err", text: "Station code must be 2–5 letters, e.g. DLI." }); return; }
    if (c === "NDLS") { setMsg({ kind: "err", text: "New Delhi already has its own board at the main address." }); return; }
    if (!en.trim()) { setMsg({ kind: "err", text: "Enter the station name in English." }); return; }
    setBusy(true); setMsg(null);
    const { error } = await createClient().from("stations").insert({ code: c, name_en: en.trim(), name_hi: hi.trim() || null, local_codes: [c] });
    setBusy(false);
    if (error) { setMsg({ kind: "err", text: error.code === "23505" ? `${c} is already added.` : error.message }); return; }
    setCode(""); setEn(""); setHi("");
    setMsg({ kind: "ok", text: `${c} added. Open it to enter its API keys and nearby stations; its board fills on its own after that.` });
    load();
  }

  return (
    <>
      <section className="panel">
        {!loaded ? <div className="empty">Loading stations…</div> : rows.length === 0 ? <div className="empty">No stations yet.</div> : (
          <div className="tablewrap">
            <table>
              <thead><tr><th>Station</th><th>Name</th><th>Board</th><th>Last update</th><th><span className="sr">Settings</span></th></tr></thead>
              <tbody>
                {rows.map(r => (
                  <tr key={r.code}>
                    <td className="num"><b>{r.code}</b></td>
                    <td>{r.name_en}{r.name_hi && <> · <span lang="hi">{r.name_hi}</span></>}</td>
                    <td><Link href={`/${r.code}`} target="_blank" rel="noopener">/{r.code}</Link>{!r.active && <> <span className="pill disabled">paused</span></>}</td>
                    <td className="num">{when(r.last_sync_at)}</td>
                    <td><Link className="btn sm ghost" href={`/stations/${r.code}`}>Settings</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {isAdmin && (
        <section className="panel" aria-labelledby="add-h">
          <div>
            <h2 id="add-h">Add a station</h2>
            <p className="lede">Trains, destinations and charting are picked up automatically from the station&apos;s live board. After adding, enter the station&apos;s own API keys.</p>
          </div>
          <form onSubmit={add} className="row">
            <label htmlFor="sc">Station code<input id="sc" value={code} maxLength={5} onChange={e => setCode(e.target.value.toUpperCase())} placeholder="DLI" /></label>
            <label htmlFor="se">Name (English)<input id="se" value={en} onChange={e => setEn(e.target.value)} placeholder="Delhi Junction" /></label>
            <label htmlFor="sh">Name (Hindi)<input id="sh" lang="hi" value={hi} onChange={e => setHi(e.target.value)} placeholder="दिल्ली जं." /></label>
            <button className="btn" type="submit" disabled={busy}>{busy ? "Adding…" : "Add station"}</button>
          </form>
          {msg && <div className={`msg ${msg.kind}`} role={msg.kind === "err" ? "alert" : "status"}>{msg.text}</div>}
        </section>
      )}
    </>
  );
}
