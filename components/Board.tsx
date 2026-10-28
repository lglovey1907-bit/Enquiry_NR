"use client";

import Link from "next/link";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { intervalLabel } from "@/lib/intervals";

type Stop = { code: string; name: string; seats: Record<string, number> | null };
type Train = {
  train_no: string; journey_date: string; train_name: string | null; dep_at: string;
  checked_at: string; next_check_at: string; chart_ready: boolean | null; stops: Stop[]; refresh_minutes: number;
};

const IST = "Asia/Kolkata";
const POLL_MS = 60_000;
const NOTICES = [
  "Current booking tickets are available at the PRS counter and on IRCTC until charting closes",
  "करंट बुकिंग टिकट पीआरएस काउंटर एवं आईआरसीटीसी पर उपलब्ध हैं",
  "Please check NTES for actual train running time before boarding",
  "यात्रा से पहले गाड़ी की वास्तविक स्थिति NTES पर देखें",
  "Seat figures are refreshed at regular intervals and may change at the time of booking",
];

const hhmm = (d: Date) => new Intl.DateTimeFormat("en-IN", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: IST }).format(d);
const leftText = (ms: number) => { const m = Math.max(0, Math.round(ms / 60000)), h = Math.floor(m / 60); return h ? `${h}h ${m % 60}m` : `${m}m`; };
const hasSeats = (t: { stops: Stop[] }) => (t.stops ?? []).some(s => Object.values(s.seats ?? {}).some(n => Number(n) > 0));
const sig = (n: number) => (n === 0 ? "b-stopc" : n <= 10 ? "b-caution" : "b-go");

function useReducedMotion() {
  const [reduce, setReduce] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduce(mq.matches);
    const on = () => setReduce(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return reduce;
}

function Flaps({ n }: { n: number }) {
  if (n === 0) return <span className="b-flaps"><span className="b-flap wide b-stopc">NIL</span></span>;
  return (
    <span className="b-flaps">
      {[...String(n).padStart(3, "0")].map((ch, i) => (
        <span key={i} className={`b-flap ${sig(n)}`} data-final={ch}>{ch}</span>
      ))}
    </span>
  );
}

function StopCells({ stops }: { stops: Stop[] }) {
  return (
    <>
      {stops.map(s => (
        <div className="b-stop" key={s.code}>
          <div className="b-shead"><span className="b-dcode">{s.code}</span><span className="b-dname">{s.name}</span></div>
          <div className="b-cell">
            {Object.entries(s.seats ?? {}).map(([c, n]) => (
              <div className="b-cls" key={c} aria-label={`${c} ${n === 0 ? "nil" : `${n} seats`}`}>
                <span className="b-ctag">{c}</span><Flaps n={Number(n)} />
              </div>
            ))}
          </div>
        </div>
      ))}
    </>
  );
}

/** A train's stops; scrolls sideways like a banner only when they don't fit. */
function StopStrip({ train, reduce }: { train: Train; reduce: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const [loop, setLoop] = useState(false);
  const [dur, setDur] = useState(40);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useLayoutEffect(() => {
    const b = box.current, t = track.current;
    if (!b || !t) return;
    const single = loop ? t.scrollWidth / 2 : t.scrollWidth;
    const overflows = single > b.clientWidth + 2;
    if (reduce) { if (loop) setLoop(false); return; }
    if (overflows !== loop) { setLoop(overflows); return; }
    if (overflows) setDur(Math.max(18, single / 45));
  }, [loop, width, reduce, train.checked_at, train.stops.length]);

  const overflowManual = reduce && track.current && box.current && track.current.scrollWidth > box.current.clientWidth + 2;
  const mark = <div className="b-loopmark" aria-hidden="true">{train.train_no}</div>;

  return (
    <div ref={box} className={`b-stops${loop ? " loop" : ""}${overflowManual ? " manual" : ""}`} style={{ ["--dur" as string]: `${dur}s` }}>
      <div ref={track} className="b-strack">
        <StopCells stops={train.stops} />
        {loop && <>{mark}<div style={{ display: "contents" }} aria-hidden="true"><StopCells stops={train.stops} /></div>{mark}</>}
      </div>
    </div>
  );
}

function Meta({ t, now }: { t: Train; now: Date }) {
  const dep = new Date(t.dep_at), nx = new Date(t.next_check_at), toDep = dep.getTime() - now.getTime();
  return (
    <div className="b-meta">
      <span>Updated <b>{hhmm(new Date(t.checked_at))}</b> · every {intervalLabel(t.refresh_minutes)}</span>
      {nx >= dep ? <span>No further checks</span>
        : nx <= now ? <span className="due">Update in progress</span>
        : <span>Next check <b>{hhmm(nx)}</b></span>}
      {toDep <= 15 * 60000
        ? <span className="leaving">Departing in {leftText(toDep)}</span>
        : <span>Departs in <b>{leftText(toDep)}</b></span>}
    </div>
  );
}

export default function Board() {
  const reduce = useReducedMotion();
  const [now, setNow] = useState<Date | null>(null);
  const [trains, setTrains] = useState<Train[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const [leaving, setLeaving] = useState<Set<string>>(new Set());
  const listRef = useRef<HTMLDivElement>(null);
  const seen = useRef<Map<string, string>>(new Map());

  const load = useCallback(async () => {
    const { data, error } = await createClient()
      .from("trains")
      .select("train_no,journey_date,train_name,dep_at,checked_at,next_check_at,chart_ready,stops,refresh_minutes")
      .in("status", ["active", "error"])
      .not("checked_at", "is", null)
      .gt("dep_at", new Date().toISOString())
      .order("dep_at");
    if (error) { setFailed(true); setLoaded(true); return; }
    setFailed(false);
    setTrains((data ?? []) as Train[]);
    setLoaded(true);
  }, []);

  useEffect(() => {
    setNow(new Date());
    load();
    const poll = setInterval(load, POLL_MS);
    const tick = setInterval(() => setNow(new Date()), 15_000);
    const onVis = () => { if (document.visibilityState === "visible") { setNow(new Date()); load(); } };
    document.addEventListener("visibilitychange", onVis);
    return () => { clearInterval(poll); clearInterval(tick); document.removeEventListener("visibilitychange", onVis); };
  }, [load]);

  // Trains at or past departure slide off, then drop from the list.
  const keyOf = (t: Train) => `${t.train_no}-${t.journey_date}`;
  // Only trains whose chart is prepared and that have at least one current-booking seat, until departure.
  const live = useMemo(() => trains.filter(t =>
    (!now || new Date(t.dep_at) > now) && t.chart_ready !== false && hasSeats(t)), [trains, now]);
  const [shown, setShown] = useState<Train[]>([]);
  useEffect(() => {
    const liveKeys = new Set(live.map(keyOf));
    const gone = shown.filter(t => !liveKeys.has(keyOf(t))).map(keyOf);
    if (gone.length && !reduce) {
      setLeaving(new Set(gone));
      const id = setTimeout(() => { setLeaving(new Set()); setShown(live); }, 700);
      return () => clearTimeout(id);
    }
    setShown(live);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, reduce]);

  // Split-flap settle: digits roll briefly whenever a train's figures change.
  useEffect(() => {
    if (reduce || !listRef.current) return;
    const timers: number[] = [];
    shown.forEach(t => {
      const k = keyOf(t);
      if (seen.current.get(k) === t.checked_at) return;
      seen.current.set(k, t.checked_at);
      const row = listRef.current!.querySelector(`[data-row="${CSS.escape(k)}"]`);
      row?.querySelectorAll<HTMLElement>(".b-flap[data-final]").forEach((el, idx) => {
        const fin = el.dataset.final!;
        let s = 0; const steps = 8 + (idx % 7);
        const iv = window.setInterval(() => {
          el.classList.remove("spin"); void el.offsetWidth; el.classList.add("spin");
          el.textContent = s >= steps ? fin : String((Number(fin) + steps - s) % 10);
          if (s++ >= steps) clearInterval(iv);
        }, 70);
        timers.push(iv);
      });
    });
    return () => timers.forEach(clearInterval);
  }, [shown, reduce]);

  const clock = now ? hhmm(now).split(":") : ["--", "--"];
  const today = now ? now.toLocaleDateString("en-IN", { weekday: "short", day: "2-digit", month: "short", year: "numeric", timeZone: IST }).toUpperCase() : "";
  const notices = NOTICES.map((n, i) => <span key={i}>◆ {n}</span>);

  return (
    <div className="b-root">
      <section className="b-band b-gut">
        <div className="b-band-in">
          <div>
            <div className="b-zone">Northern Railway · Delhi Division</div>
            <h1 className="b-h1">Current Booking Availability</h1>
            <div className="b-hi">करंट बुकिंग में उपलब्ध सीटें</div>
            <div className="b-plate"><span className="c">NDLS</span><span className="n">NEW DELHI · नई दिल्ली</span></div>
          </div>
          <div className="b-clockbox">
            <Link href="/login" className="b-staff">Staff login</Link>
            <span className="b-live"><i className="b-lamp" />LIVE BOARD</span>
            <div className="b-clock" aria-label="Time now">{clock[0]}<span className="colon">:</span>{clock[1]}</div>
            <div className="b-date">{today}</div>
          </div>
        </div>
        <div className="b-track" aria-hidden="true">
          <div className="b-rails" />
          <div className="b-rake">
            <svg viewBox="0 0 300 22" fill="none">
              <g fill="#f1ede6">
                <path d="M248 3h36q12 0 14 12v4h-50z" />
                <rect x="196" y="3" width="49" height="16" rx="2" /><rect x="144" y="3" width="49" height="16" rx="2" />
                <rect x="92" y="3" width="49" height="16" rx="2" /><rect x="40" y="3" width="49" height="16" rx="2" />
              </g>
              <g fill="#5a1420">
                <rect x="200" y="6" width="41" height="4" rx="1" /><rect x="148" y="6" width="41" height="4" rx="1" />
                <rect x="96" y="6" width="41" height="4" rx="1" /><rect x="44" y="6" width="41" height="4" rx="1" />
                <path d="M276 6h10q6 0 8 6h-18z" /><rect x="40" y="13" width="258" height="1.6" />
              </g>
              <g fill="#16181b">
                {[52, 78, 104, 130, 156, 182, 208, 234, 260, 286].map(x => <circle key={x} cx={x} cy="20" r="2" />)}
              </g>
            </svg>
          </div>
        </div>
      </section>

      <main className="b-main b-gut">
        <div className="b-main-in">
          <div className="b-info">
            <span>Trains with seats <b>{loaded ? shown.length : "–"}</b></span>
            <span>Refresh <b>Set for each train</b></span>
            <span>Quota <b>General · Current Booking</b></span>
          </div>

          <div className="b-list" ref={listRef} aria-label="Current booking seats from New Delhi by train, destination and class">
            {!loaded ? <div className="b-empty">Loading trains…</div>
              : failed && shown.length === 0 ? <div className="b-empty"><b>Board data unavailable</b>Check the internet connection. The board retries every minute.</div>
              : shown.length === 0 ? <div className="b-empty"><b>No current-booking seats right now</b>Trains appear here once their reservation chart is prepared and current-booking seats are available. Each train leaves the board at its departure time.</div>
              : shown.map((t, i) => (
                <article key={keyOf(t)} data-row={keyOf(t)} className={`b-row${leaving.has(keyOf(t)) ? " out" : ""}`} style={{ animationDelay: `${i * 0.12}s` }}>
                  <div className="b-train">
                    <div className="b-tno">{t.train_no}</div>
                    <div className="b-tname">{t.train_name}</div>
                    <div className="b-tdep">Dep NDLS {hhmm(new Date(t.dep_at))}</div>
                    {now && <Meta t={t} now={now} />}
                  </div>
                  {t.chart_ready === false ? (
                    <div className="b-stops"><div className="b-stop await"><div className="b-shead">
                      <span className="b-dcode">CHART AWAITED</span>
                      <span className="b-dname">Current booking opens after the reservation chart is prepared</span>
                    </div></div></div>
                  ) : <StopStrip train={t} reduce={reduce} />}
                </article>
              ))}
          </div>

          <div className="b-legend">
            <span className="b-sig b-go"><i style={{ background: "var(--sig-go)" }} />Seats available (more than 10)</span>
            <span className="b-sig b-caution"><i style={{ background: "var(--sig-caution)" }} />Few seats left (1–10)</span>
            <span className="b-sig b-stopc"><i style={{ background: "var(--sig-stop)" }} />Nil</span>
          </div>
        </div>
      </main>

      <div className="b-ticker b-gut" aria-label="Announcements">
        <div className="b-ticker-in">
          <span className="b-tlabel">सूचना · NOTICE</span>
          <div className="b-tview"><div className="b-ttrack">{notices}{notices}</div></div>
        </div>
      </div>
    </div>
  );
}
