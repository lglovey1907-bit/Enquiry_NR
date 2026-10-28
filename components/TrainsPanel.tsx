"use client";

import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { INTERVALS, intervalLabel } from "@/lib/intervals";

type Stop = { code: string; name: string; seats: Record<string, number> | null };
type Train = {
  id: number; train_no: string; journey_date: string; train_name: string | null; dep_at: string | null;
  added_at: string; added_by: string | null; status: "queued" | "active" | "departed" | "removed" | "error";
  checked_at: string | null; next_check_at: string; stops: Stop[]; last_error: string | null; refresh_minutes: number;
  chart_ready: boolean | null;
};
type Ref = {
  train_no: string; train_name: string; destination: string | null; destination_code: string | null;
  ndls_departure: string | null; runs_on: string | null; days_codes: number[] | null; platform: number | null;
};
const LIVE = ["queued", "active", "error"];
const DAY = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
/** ISO weekday (1 = Mon … 7 = Sun) of a YYYY-MM-DD date. */
const isoDow = (d: string) => { const w = new Date(d + "T12:00:00Z").getUTCDay(); return w === 0 ? 7 : w; };
const hasSeats = (t: Train) => (t.stops ?? []).some(s => Object.values(s.seats ?? {}).some(n => Number(n) > 0));

const IST = "Asia/Kolkata";
const todayIST = () => new Intl.DateTimeFormat("en-CA", { timeZone: IST }).format(new Date());
const hhmm = (s: string | null) => s ? new Intl.DateTimeFormat("en-IN", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: IST }).format(new Date(s)) : "–";
const dmy = (d: string) => new Date(d + "T00:00:00+05:30").toLocaleDateString("en-IN", { day: "2-digit", month: "short", timeZone: IST });

const STATUS_LABEL: Record<Train["status"], string> = {
  queued: "Waiting for first check", active: "Being checked", departed: "Departed", removed: "Removed", error: "Check failed",
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
  const [refList, setRefList] = useState<Ref[]>([]);

  // New trains start with the admin's default interval; the picker lists reserved NDLS departures.
  useEffect(() => {
    const sb = createClient();
    sb.from("settings").select("default_refresh_minutes").eq("id", 1).maybeSingle()
      .then(({ data }) => { if (data?.default_refresh_minutes) setEvery(data.default_refresh_minutes); });
    sb.from("ndls_trains").select("train_no,train_name,destination,destination_code,ndls_departure,runs_on,days_codes,platform")
      .order("ndls_departure").then(({ data }) => { if (data) setRefList(data as Ref[]); });
  }, []);

  const picked = refList.find(r => r.train_no === trainNo) ?? null;
  const runsThatDay = !picked?.days_codes || picked.days_codes.includes(isoDow(date));

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
    if (!/^\d{5}$/.test(trainNo)) { setError("Choose a train from the list, or type its 5-digit number."); return; }
    if (!refList.some(r => r.train_no === trainNo)) {
      setError(/^[56]/.test(trainNo)
        ? `${trainNo} is an unreserved passenger/MEMU train. Only reserved trains have current booking.`
        : `${trainNo} is not in the reserved trains list for New Delhi. Pick a train from the list.`);
      return;
    }
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
            <label htmlFor="tno" style={{ flexBasis: 260 }}>Train <span className="hint">Reserved trains departing NDLS · {refList.length || "…"} listed</span>
              <input id="tno" list="ndls-reserved" inputMode="numeric" autoComplete="off" placeholder="Type number or pick, e.g. 12002"
                required value={trainNo} onChange={e => setTrainNo(e.target.value.replace(/\D/g, "").slice(0, 5))} />
              <datalist id="ndls-reserved">
                {refList.map(r => (
                  <option key={r.train_no} value={r.train_no}>
                    {`${r.train_name} · dep ${r.ndls_departure ?? "–"} · to ${r.destination_code ?? "?"} · ${r.runs_on ?? ""}`}
                  </option>
                ))}
              </datalist>
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
          {trainNo.length === 5 && (
            picked ? (
              <div className={`msg ${runsThatDay ? "info" : "err"}`}>
                <b>{picked.train_no} {picked.train_name}</b> · dep NDLS {picked.ndls_departure ?? "–"}
                {picked.platform != null && <> · PF {picked.platform}</>} · to {picked.destination ?? picked.destination_code} · runs {picked.runs_on}
                {!runsThatDay && <> — <b>does not run on {DAY[isoDow(date)]} {dmy(date)}</b>. Check the date.</>}
              </div>
            ) : /^[56]/.test(trainNo) ? (
              <div className="msg err">{trainNo} is unreserved (passenger/MEMU). Only reserved trains can be added.</div>
            ) : refList.length > 0 && (
              <div className="msg err">{trainNo} is not in the reserved trains list for New Delhi. Pick a train from the list.</div>
            )
          )}
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
                      {live && (
                        <div className="lede" style={{ fontSize: ".78rem", marginTop: 4 }}>
                          {!t.checked_at ? "Hidden on board until first check"
                            : t.chart_ready === false ? "Hidden on board: chart not prepared"
                            : !hasSeats(t) ? "Hidden on board: no current-booking seats"
                            : t.dep_at && new Date(t.dep_at).getTime() - Date.now() > 4 * 3600_000
                              ? `Shows on board from ${hhmm(new Date(new Date(t.dep_at).getTime() - 4 * 3600_000).toISOString())} (4 h before departure)`
                            : "Showing on board"}
                        </div>
                      )}
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
