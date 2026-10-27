"use client";

import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";

type Stop = { code: string; name: string; seats: Record<string, number> | null };
type Train = {
  id: number; train_no: string; journey_date: string; train_name: string | null; dep_at: string | null;
  added_at: string; added_by: string | null; status: "queued" | "active" | "departed" | "removed" | "error";
  checked_at: string | null; next_check_at: string; stops: Stop[]; last_error: string | null;
};

const IST = "Asia/Kolkata";
const todayIST = () => new Intl.DateTimeFormat("en-CA", { timeZone: IST }).format(new Date());
const hhmm = (s: string | null) => s ? new Intl.DateTimeFormat("en-IN", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: IST }).format(new Date(s)) : "–";
const dmy = (d: string) => new Date(d + "T00:00:00+05:30").toLocaleDateString("en-IN", { day: "2-digit", month: "short", timeZone: IST });

const STATUS_LABEL: Record<Train["status"], string> = {
  queued: "Waiting for first check", active: "On board", departed: "Departed", removed: "Removed", error: "Check failed",
};

export default function TrainsPanel({ userId, isAdmin }: { userId: string; isAdmin: boolean }) {
  const [trains, setTrains] = useState<Train[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [trainNo, setTrainNo] = useState("");
  const [date, setDate] = useState(todayIST());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [ok, setOk] = useState("");
  const [showDone, setShowDone] = useState(false);

  const load = useCallback(async () => {
    const supabase = createClient();
    const since = new Date(Date.now() - 24 * 3600e3).toISOString();
    const { data, error } = await supabase.from("trains").select("*")
      .or(`status.in.(queued,active,error),added_at.gte.${since}`)
      .order("journey_date").order("dep_at", { nullsFirst: false }).order("added_at");
    if (!error && data) setTrains(data as Train[]);
    setLoaded(true);
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 30000);
    return () => clearInterval(t);
  }, [load]);

  async function addTrain(e: React.FormEvent) {
    e.preventDefault();
    setError(""); setOk("");
    if (!/^\d{5}$/.test(trainNo)) { setError("Train number must be 5 digits."); return; }
    setBusy(true);
    const { error } = await createClient().from("trains").insert({ train_no: trainNo, journey_date: date });
    setBusy(false);
    if (error) {
      setError(error.code === "23505"
        ? `Train ${trainNo} for ${dmy(date)} is already on the list.`
        : error.message.includes("past") ? "Journey date cannot be in the past." : error.message);
      return;
    }
    setOk(`Train ${trainNo} added. Its first seat check runs within 15 minutes.`);
    setTrainNo("");
    load();
  }

  async function remove(t: Train) {
    setError(""); setOk("");
    const { error } = await createClient().from("trains").update({ status: "removed" }).eq("id", t.id);
    if (error) { setError(error.message); return; }
    setOk(`Train ${t.train_no} removed from the board.`);
    load();
  }

  const live = trains.filter(t => ["queued", "active", "error"].includes(t.status));
  const done = trains.filter(t => !["queued", "active", "error"].includes(t.status));
  const shown = showDone ? done : live;

  return (
    <>
      <section className="panel" aria-labelledby="add-h">
        <h2 id="add-h">Add a train</h2>
        <form onSubmit={addTrain}>
          <div className="row">
            <label htmlFor="tno">Train number
              <input id="tno" inputMode="numeric" maxLength={5} placeholder="e.g. 12002" required value={trainNo}
                onChange={e => setTrainNo(e.target.value.replace(/\D/g, ""))} />
            </label>
            <label htmlFor="jdate">Journey date from NDLS
              <input id="jdate" type="date" min={todayIST()} required value={date} onChange={e => setDate(e.target.value)} />
            </label>
            <button className="btn" type="submit" disabled={busy}>{busy ? "Adding…" : "Add to board"}</button>
          </div>
          {error && <div className="msg err" role="alert">{error}</div>}
          {ok && <div className="msg ok" role="status">{ok}</div>}
        </form>
      </section>

      <section className="panel" aria-labelledby="list-h">
        <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
          <h2 id="list-h">Train list</h2>
          <div className="tabs" role="group" aria-label="Filter">
            <button type="button" aria-pressed={!showDone} onClick={() => setShowDone(false)}>On board <span className="count">{live.length}</span></button>
            <button type="button" aria-pressed={showDone} onClick={() => setShowDone(true)}>Departed / removed <span className="count">{done.length}</span></button>
          </div>
        </div>
        {!loaded ? <div className="empty">Loading trains…</div> : shown.length === 0 ? (
          <div className="empty">{showDone ? "No departed or removed trains in the last 24 hours." : "No trains on the board. Add one above."}</div>
        ) : (
          <div className="tablewrap">
            <table>
              <thead>
                <tr><th>Train</th><th>Date</th><th>Dep NDLS</th><th>Status</th><th>Stops</th><th>Last check</th><th>Next check</th><th><span className="sr">Actions</span></th></tr>
              </thead>
              <tbody>
                {shown.map(t => (
                  <tr key={t.id}>
                    <td><span className="tno">{t.train_no}</span><br /><span className="lede">{t.train_name ?? "Name pending first check"}</span></td>
                    <td className="num">{dmy(t.journey_date)}</td>
                    <td className="num">{hhmm(t.dep_at)}</td>
                    <td>
                      <span className={`pill ${t.status}`}>{STATUS_LABEL[t.status]}</span>
                      {t.status === "error" && t.last_error && <div className="lede" style={{ fontSize: ".8rem" }}>{t.last_error}</div>}
                    </td>
                    <td className="num">{t.stops?.length || "–"}</td>
                    <td className="num">{hhmm(t.checked_at)}</td>
                    <td className="num">{["queued", "active", "error"].includes(t.status) ? hhmm(t.next_check_at) : "–"}</td>
                    <td>
                      {["queued", "active", "error"].includes(t.status) && (t.added_by === userId || isAdmin) && (
                        <button className="btn no sm" type="button" onClick={() => remove(t)}>Remove</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
