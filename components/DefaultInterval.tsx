"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { INTERVALS, intervalLabel } from "@/lib/intervals";

/** Admin-only: the interval new trains start with. Staff can still change it per train. */
export default function DefaultInterval() {
  const [value, setValue] = useState<number | null>(null);
  const [saved, setSaved] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  useEffect(() => {
    createClient().from("settings").select("default_refresh_minutes").eq("id", 1).maybeSingle()
      .then(({ data }) => { const v = data?.default_refresh_minutes ?? 30; setValue(v); setSaved(v); });
  }, []);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (value == null) return;
    setBusy(true); setMsg(null);
    const { error } = await createClient().from("settings").update({ default_refresh_minutes: value }).eq("id", 1);
    setBusy(false);
    if (error) { setMsg({ kind: "err", text: error.message }); return; }
    setSaved(value);
    setMsg({ kind: "ok", text: `Trains will be rechecked at most every ${intervalLabel(value)}. Applies to trains added from now on.` });
  }

  return (
    <section className="panel" aria-labelledby="def-h">
      <div>
        <h2 id="def-h">Recheck interval</h2>
        <p className="lede">After a train is checked, it waits at least this long before being checked again. A shorter time means fresher figures for some trains but slower first checks for others when the board is busy.</p>
      </div>
      <form onSubmit={save} className="setting">
        <label htmlFor="def">Recheck at most every
          <select id="def" value={value ?? ""} disabled={value == null} onChange={e => setValue(Number(e.target.value))}>
            {INTERVALS.map(m => <option key={m} value={m}>{intervalLabel(m)}</option>)}
          </select>
        </label>
        <button className="btn" type="submit" disabled={busy || value == null || value === saved}>{busy ? "Saving…" : "Save"}</button>
      </form>
      {msg && <div className={`msg ${msg.kind}`} role={msg.kind === "err" ? "alert" : "status"}>{msg.text}</div>}
    </section>
  );
}
