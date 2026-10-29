"use client";

import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";

type Stop = { code: string; name: string; seats: Record<string, number> | null };
type Train = {
  id: number; train_no: string; journey_date: string; train_name: string | null; dep_at: string | null;
  added_at: string; added_by: string | null; status: "queued" | "active" | "departed" | "removed" | "error";
  checked_at: string | null; next_check_at: string; stops: Stop[]; last_error: string | null; refresh_minutes: number;
  chart_ready: boolean | null;
};
const LIVE = ["queued", "active", "error"];
const IST = "Asia/Kolkata";
const hhmm = (s: string | null) => s ? new Intl.DateTimeFormat("en-IN", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: IST }).format(new Date(s)) : "–";
const left = (s: string | null) => {
  if (!s) return "";
  const m = Math.round((new Date(s).getTime() - Date.now()) / 60000);
  if (m <= 0) return "departing";
  return m < 60 ? `in ${m} min` : `in ${Math.floor(m / 60)} h ${m % 60} min`;
};
/** Destinations with at least one class that has current-booking seats. */
const seatStops = (t: Train) => (t.stops ?? []).filter(s => Object.values(s.seats ?? {}).some(n => Number(n) > 0));

const STATUS_LABEL: Record<Train["status"], string> = {
  queued: "Waiting for check", active: "Checked", departed: "Departed", removed: "Hidden", error: "Check failed",
};

export default function TrainsPanel() {
  const [trains, setTrains] = useState<Train[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [ok, setOk] = useState("");
  const [showDone, setShowDone] = useState(false);
  const [rowBusy, setRowBusy] = useState<number | null>(null);

  const load = useCallback(async () => {
    const since = new Date(Date.now() - 12 * 3600e3).toISOString();
    const { data, error } = await createClient().from("trains").select("*")
      .or(`status.in.(queued,active,error),dep_at.gte.${since}`)
      .order("dep_at", { nullsFirst: false }).order("train_no");
    if (!error && data) setTrains(data as Train[]);
    setLoaded(true);
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 30000);
    return () => clearInterval(t);
  }, [load]);

  async function update(t: Train, patch: Partial<Train>, done: string) {
    setError(""); setOk(""); setRowBusy(t.id);
    const { error } = await createClient().from("trains").update(patch).eq("id", t.id);
    setRowBusy(null);
    if (error) { setError(error.message); return; }
    setOk(done);
    load();
  }
  const hide = (t: Train) => update(t, { status: "removed" }, `Train ${t.train_no} is hidden from the board and won't be checked again today.`);
  const checkNow = (t: Train) =>
    update(t, { next_check_at: new Date().toISOString() }, `Train ${t.train_no} is checked in the next update (within 15 minutes).`);

  const live = trains.filter(t => LIVE.includes(t.status));
  const done = trains.filter(t => !LIVE.includes(t.status));
  const shown = showDone ? done : live;
  const onBoard = live.filter(t => t.checked_at && t.chart_ready !== false && seatStops(t).length > 0).length;
  const waiting = live.filter(t => !t.checked_at).length;

  return (
    <>
      <section className="panel" aria-labelledby="auto-h">
        <div>
          <h2 id="auto-h">Trains are added automatically</h2>
          <p className="lede">
            Every reserved train departing New Delhi in the next 4 hours is added on its own from the NDLS live board.
            Seats are fetched once its chart is prepared, soonest departure first, and rechecked when the request budget allows.
            It appears on the public board once current-booking seats are found, and leaves at departure.
          </p>
        </div>
        <div className="row" style={{ gap: 24 }}>
          <span><b className="num" style={{ fontSize: "1.4rem" }}>{loaded ? live.length : "–"}</b> trains in the next 4 hours</span>
          <span><b className="num" style={{ fontSize: "1.4rem" }}>{loaded ? onBoard : "–"}</b> showing on board</span>
          <span><b className="num" style={{ fontSize: "1.4rem" }}>{loaded ? waiting : "–"}</b> waiting for first check</span>
        </div>
        {error && <div className="msg err" role="alert">{error}</div>}
        {ok && <div className="msg ok" role="status">{ok}</div>}
      </section>

      <section className="panel" aria-labelledby="list-h">
        <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
          <h2 id="list-h">Train list</h2>
          <div className="tabs" role="group" aria-label="Filter">
            <button type="button" aria-pressed={!showDone} onClick={() => setShowDone(false)}>Next 4 hours <span className="count">{live.length}</span></button>
            <button type="button" aria-pressed={showDone} onClick={() => setShowDone(true)}>Departed / hidden <span className="count">{done.length}</span></button>
          </div>
        </div>
        {!loaded ? <div className="empty">Loading trains…</div> : shown.length === 0 ? (
          <div className="empty">{showDone
            ? "No departed or hidden trains in the last 12 hours."
            : "No trains yet. The next seat-check run adds the reserved trains departing in the next 4 hours."}</div>
        ) : (
          <div className="tablewrap">
            <table>
              <thead>
                <tr><th>Train</th><th>Dep NDLS</th><th>Status</th><th>Seats available to</th><th>Last check</th><th><span className="sr">Actions</span></th></tr>
              </thead>
              <tbody>
                {shown.map(t => {
                  const isLive = LIVE.includes(t.status);
                  const due = new Date(t.next_check_at).getTime() <= Date.now() + 60_000;
                  const avail = seatStops(t);
                  return (
                    <tr key={t.id}>
                      <td><span className="tno">{t.train_no}</span><br /><span className="lede">{t.train_name ?? ""}</span></td>
                      <td className="num">{hhmm(t.dep_at)}<br /><span className="lede">{isLive ? left(t.dep_at) : ""}</span></td>
                      <td>
                        <span className={`pill ${t.status}`}>{STATUS_LABEL[t.status]}</span>
                        {isLive && (
                          <div className="lede" style={{ fontSize: ".78rem", marginTop: 4 }}>
                            {!t.checked_at ? (due ? "In queue" : `Queued for ${hhmm(t.next_check_at)}`)
                              : t.chart_ready === false ? "Hidden on board: chart not prepared"
                              : avail.length === 0 ? "Hidden on board: no current-booking seats"
                              : "Showing on board"}
                          </div>
                        )}
                        {(t.status === "error" || t.status === "removed") && t.last_error && <div className="lede" style={{ fontSize: ".8rem" }}>{t.last_error}</div>}
                      </td>
                      <td>
                        {avail.length === 0 ? <span className="lede">–</span> : (
                          <span style={{ fontSize: ".85rem" }}>
                            {avail.map(s => `${s.code} (${Object.entries(s.seats ?? {}).filter(([, n]) => Number(n) > 0).map(([c, n]) => `${c} ${n}`).join(", ")})`).join(" · ")}
                          </span>
                        )}
                      </td>
                      <td className="num">{hhmm(t.checked_at)}</td>
                      <td>
                        {isLive && (
                          <div className="actions">
                            {!due && <button className="btn ghost sm" type="button" disabled={rowBusy === t.id} onClick={() => checkNow(t)}>Check now</button>}
                            <button className="btn no sm" type="button" disabled={rowBusy === t.id} onClick={() => hide(t)}>Hide</button>
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
