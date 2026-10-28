"use client";

import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { INTERVALS, intervalLabel } from "@/lib/intervals";

type Stop = { code: string; name: string; seats: Record<string, number> | null };
type Train = {
  id: number; train_no: string; journey_date: string; train_name: string | null; dep_at: string | null;
  added_at: string; added_by: string | null; status: "queued" | "active" | "departed" | "removed" | "error";
  checked_at: string | null; next_check_at: string; stops: Stop[]; last_error: string | null; refresh_minutes: number;
};
const LIVE = ["queued", "active", "error"];

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
  const [every, setEvery] = useState<number>(30);
  const [rowBusy, setRowBusy] = useState<number | null>(null);

  // New trains start with the admin's default interval.
  useEffect(() => {
    createClient().from("settings").select("default_refresh_minutes").eq("id", 1).maybeSingle()
      .then(({ data }) => { if (data?.default_refresh_minutes) setEvery(data.default_refresh_minutes); });
  }, []);

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
    const { error } = await createClient().from("trains").insert({ train_no: trainNo, journey_date: date, refresh_minutes: every });
    setBusy(false);
    if (error) {
      setError(error.code === "23505"
        ? `Train ${trainNo} for ${dmy(date)} is already on the list.`
        : error.message.includes("past") ? "Journey date cannot be in the past." : error.message);
      return;
    }
    const today = date === todayIST();
    setOk(today
      ? `Train ${trainNo} added. First seat check within 15 minutes, then every ${intervalLabel(every)}.`
      : `Train ${trainNo} added for ${dmy(date)}. Checks start on its journey date, every ${intervalLabel(every)}.`);
    setTrainNo("");
    load();
  }

  async function update(t: Train, patch: Partial<Train>, done: string) {
    setError(""); setOk(""); setRowBusy(t.id);
    const { error } = await createClient().from("trains").update(patch).eq("id", t.id);
    setRowBusy(null);
    if (error) { setError(error.message); return; }
    setOk(done);
    load();
  }
  const remove = (t: Train) => update(t, { status: "removed" }, `Train ${t.train_no} removed from the board.`);
  const setInterval_ = (t: Train, m: number) =>
    update(t, { refresh_minutes: m }, `Train ${t.train_no} will now be checked every ${intervalLabel(m)}.`);
  const checkNow = (t: Train) =>
    update(t, { next_check_at: new Date().toISOString() }, `Train ${t.train_no} will be checked in the next run, within 15 minutes.`);

  const live = trains.filter(t => LIVE.includes(t.status));
  const done = trains.filter(t => !LIVE.includes(t.status));
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
            <label htmlFor="every">Check seats every
              <select id="every" value={every} onChange={e => setEvery(Number(e.target.value))}>
                {INTERVALS.map(m => <option key={m} value={m}>{intervalLabel(m)}</option>)}
              </select>
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
                <tr><th>Train</th><th>Date</th><th>Dep NDLS</th><th>Status</th><th>Stops</th><th>Last check</th><th>Check every</th><th>Next check</th><th><span className="sr">Actions</span></th></tr>
              </thead>
              <tbody>
                {shown.map(t => {
                  const live = LIVE.includes(t.status);
                  const mine = t.added_by === userId || isAdmin;
                  const due = new Date(t.next_check_at).getTime() <= Date.now() + 60_000;
                  return (
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
                    <td>
                      {live && mine ? (
                        <select aria-label={`Check train ${t.train_no} every`} className="sm" value={t.refresh_minutes}
                          disabled={rowBusy === t.id} onChange={e => setInterval_(t, Number(e.target.value))}>
                          {INTERVALS.map(m => <option key={m} value={m}>{intervalLabel(m)}</option>)}
                        </select>
                      ) : <span className="num">{intervalLabel(t.refresh_minutes)}</span>}
                    </td>
                    <td className="num">{!live ? "–" : due ? "Next run" : hhmm(t.next_check_at)}</td>
                    <td>
                      {live && mine && (
                        <div className="actions">
                          {t.checked_at && !due && (
                            <button className="btn ghost sm" type="button" disabled={rowBusy === t.id} onClick={() => checkNow(t)}>Check now</button>
                          )}
                          <button className="btn no sm" type="button" disabled={rowBusy === t.id} onClick={() => remove(t)}>Remove</button>
                        </div>
                      )}
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
