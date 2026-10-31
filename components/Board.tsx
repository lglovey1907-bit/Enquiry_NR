"use client";

import Link from "next/link";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";

type Stop = { code: string; name: string; hi?: string; seats: Record<string, number> | null };
type Train = {
  train_no: string; journey_date: string; train_name: string | null; dep_at: string;
  checked_at: string; next_check_at: string; chart_ready: boolean | null; stops: Stop[]; refresh_minutes: number;
  expected_dep_at: string | null; delay_min: number | null; running_note: string | null; running_checked_at: string | null; platform: string | null; platform_override: string | null;
};

const IST = "Asia/Kolkata";
const POLL_MS = 60_000;
const NOTICES = [
  "करंट बुकिंग टिकट पीआरएस काउंटर एवं आईआरसीटीसी पर उपलब्ध हैं",
  "Current booking tickets are available at the PRS counter and on IRCTC until charting closes",
  "यात्रा से पहले गाड़ी की वास्तविक स्थिति NTES पर देखें",
  "Please check NTES for actual train running time before boarding",
  "सीटों की संख्या नियमित अंतराल पर अपडेट होती है और बुकिंग के समय बदल सकती है",
  "Seat figures are refreshed at regular intervals and may change at the time of booking",
];

const hhmm = (d: Date) => new Intl.DateTimeFormat("en-IN", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: IST }).format(d);
const leftText = (ms: number) => { const m = Math.max(0, Math.round(ms / 60000)), h = Math.floor(m / 60); return h ? `${h}h ${m % 60}m` : `${m}m`; };
const WINDOW_MS = 4 * 3600_000;   // board shows trains departing within the next 4 hours
const WIDE_QUERY = "(min-width: 1200px)"; // two trains side by side, 6 per page; narrower screens: one column, 4 per page
const PAGE_MS = 20_000;           // each frame stays 20 seconds, then the next one; loops
const ONBOARD_MS = 15 * 60_000;   // red "book with the TTE" strip from this close to departure
const LATE_MIN = 5;
// "updating" only while a recheck is genuinely due; a check held back by the daily request budget shows just its time.
const UPDATING_MS = 10 * 60_000;               // delay shown as "running late" from this many minutes
/** Expected departure if the train is running late, else scheduled. */
const depOf = (t: Train) => new Date(t.expected_dep_at ?? t.dep_at);
/** Keep only destinations with at least one class that has current-booking seats, and only those classes. */
const availableOnly = (stops: Stop[]): Stop[] =>
  (stops ?? []).flatMap(s => {
    const seats = Object.fromEntries(Object.entries(s.seats ?? {}).filter(([, n]) => Number(n) > 0));
    return Object.keys(seats).length ? [{ ...s, seats }] : [];
  });
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
          <div className="b-shead">
            <span className="b-dcode">{s.code}</span>
            {s.hi && <span className="b-dhi" lang="hi">{s.hi}</span>}
            <span className="b-dname">{s.name}</span>
          </div>
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

function Running({ t }: { t: Train }) {
  if (t.delay_min == null) return null;
  if (t.delay_min >= LATE_MIN) {
    return (
      <div className={`b-run late${t.delay_min >= 60 ? " big" : ""}`}>
        <span className="hi" lang="hi">{leftText(t.delay_min * 60000).replace("h", " घं").replace("m", " मि")} देरी से</span>
        <span>Running late {leftText(t.delay_min * 60000)}</span>
        <small><span lang="hi">अपेक्षित प्रस्थान</span> · Exp. dep <b>{hhmm(depOf(t))}</b>{t.running_note ? ` · ${t.running_note}` : ""}</small>
      </div>
    );
  }
  return <div className="b-run ok"><span lang="hi">समय पर</span> · On time</div>;
}

function Meta({ t, now }: { t: Train; now: Date }) {
  const dep = depOf(t), nx = new Date(t.next_check_at), toDep = dep.getTime() - now.getTime();
  return (
    <div className="b-meta">
      {toDep <= 15 * 60000
        ? <span className="leaving"><span lang="hi">प्रस्थान में</span> / Departing in {leftText(toDep)}</span>
        : <span><span lang="hi">प्रस्थान में</span> / Departs in <b>{leftText(toDep)}</b></span>}
      <span><span lang="hi">सीटें</span> / Seats at <b>{hhmm(new Date(t.checked_at))}</b>{nx <= now && now.getTime() - nx.getTime() < UPDATING_MS && nx < dep ? <em className="due"> · updating</em> : null}</span>
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
  const [hiNames, setHiNames] = useState<Record<string, string>>({});
  useEffect(() => {
    createClient().from("station_hi").select("code,name_hi").then(({ data }) => {
      if (data) setHiNames(Object.fromEntries(data.map(r => [r.code as string, r.name_hi as string])));
    });
  }, []);

  const load = useCallback(async () => {
    const { data, error } = await createClient()
      .from("trains")
      .select("train_no,journey_date,train_name,dep_at,checked_at,next_check_at,chart_ready,stops,refresh_minutes,expected_dep_at,delay_min,running_note,running_checked_at,platform,platform_override")
      .in("status", ["active", "error"])
      .not("checked_at", "is", null)
      .or(`dep_at.gt.${new Date().toISOString()},expected_dep_at.gt.${new Date().toISOString()}`)
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
  // Trains departing in the next 4 hours whose chart is prepared, showing only the
  // destinations and classes that have current-booking seats.
  const live = useMemo(() => {
    const t0 = (now ?? new Date()).getTime();
    return trains
      .filter(t => { const d = depOf(t).getTime(); return d > t0 && new Date(t.dep_at).getTime() <= t0 + WINDOW_MS && t.chart_ready !== false; })
      .map(t => ({ ...t, stops: availableOnly(t.stops).map(s => ({ ...s, hi: hiNames[s.code] })) }))
      .filter(t => t.stops.length > 0)
      .sort((a, b) => depOf(a).getTime() - depOf(b).getTime());
  }, [trains, now, hiNames]);
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

  // Frames of 6 trains; each stays 30 s, then the next, looping.
  const [wide, setWide] = useState(true);
  useEffect(() => {
    const mq = window.matchMedia(WIDE_QUERY);
    const on = () => setWide(mq.matches);
    on(); mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  const PAGE_SIZE = wide ? 6 : 4;
  const pageCount = Math.max(1, Math.ceil(shown.length / PAGE_SIZE));
  const [page, setPage] = useState(0);
  useEffect(() => { if (page >= pageCount) setPage(0); }, [page, pageCount]);
  useEffect(() => {
    if (pageCount <= 1) return;
    const id = setInterval(() => setPage(p => (p + 1) % pageCount), PAGE_MS);
    return () => clearInterval(id);
  }, [pageCount]);
  const frame = shown.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);

  // Split-flap settle: digits roll briefly whenever a train's figures change.
  useEffect(() => {
    if (reduce || !listRef.current) return;
    const timers: number[] = [];
    frame.forEach(t => {
      const k = keyOf(t);
      const stamp = `${t.checked_at}|${page}`;
      if (seen.current.get(k) === stamp) return;
      seen.current.set(k, stamp);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown, page, reduce]);

  // Fit the whole board (6 trains, legend, ticker) on one screen on counter displays.
  // A full 6-train frame sets the scale; shorter frames keep it so every page looks the same.
  const rootRef = useRef<HTMLDivElement>(null);
  const zoomRef = useRef<{ w: number; h: number; z: number } | null>(null);
  const full = frame.length >= PAGE_SIZE;
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const apply = (z: number) => {
      if (z < 0.995) { el.style.setProperty("zoom", String(z)); el.style.setProperty("min-height", `${window.innerHeight / z}px`); }
      else { el.style.removeProperty("zoom"); el.style.removeProperty("min-height"); }
    };
    const fit = () => {
      const w = window.innerWidth, h = window.innerHeight;
      if (w < 900) { zoomRef.current = null; apply(1); return; }
      const kept = zoomRef.current;
      if (!full && kept && kept.w === w && kept.h === h) { apply(kept.z); return; }
      apply(1);
      const z = Math.max(0.5, Math.min(1, h / el.scrollHeight));
      if (full || !kept || kept.w !== w || kept.h !== h) zoomRef.current = full ? { w, h, z } : null;
      apply(z);
    };
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [frame, full, loaded, now]);

  // Browser full screen for counter displays (button, or double-click anywhere on the board).
  const [isFull, setIsFull] = useState(false);
  useEffect(() => {
    const on = () => setIsFull(!!document.fullscreenElement);
    on(); document.addEventListener("fullscreenchange", on);
    return () => document.removeEventListener("fullscreenchange", on);
  }, []);
  const toggleFull = useCallback(() => {
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
    else document.documentElement.requestFullscreen?.().catch(() => {});
  }, []);
  const rows = wide ? Math.ceil(PAGE_SIZE / 2) : PAGE_SIZE;

  const clock = now ? hhmm(now).split(":") : ["--", "--"];
  const today = now ? now.toLocaleDateString("en-IN", { weekday: "short", day: "2-digit", month: "short", year: "numeric", timeZone: IST }).toUpperCase() : "";
  const notices = NOTICES.map((n, i) => <span key={i}>◆ {n}</span>);

  return (
    <div className="b-root" ref={rootRef} onDoubleClick={toggleFull}>
      <section className="b-band b-gut">
        <div className="b-band-in">
          <div>
            <div className="b-zone">Northern Railway · Delhi Division</div>
            <div className="b-hi b-hi-top" lang="hi">करंट बुकिंग में उपलब्ध सीटें</div>
            <h1 className="b-h1">Current Booking Availability</h1>
            <div className="b-plate"><span className="c">NDLS</span><span className="n"><span lang="hi">नई दिल्ली</span> · NEW DELHI</span></div>
          </div>
          <div className="b-clockbox">
            <span className="b-tools">
              {!isFull && <button type="button" className="b-fs" onClick={toggleFull}>⛶ Full screen</button>}
              <Link href="/login" className="b-staff">Staff login</Link>
            </span>
            <span className="b-live"><i className="b-lamp" /><span lang="hi">लाइव बोर्ड</span> · LIVE BOARD</span>
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
            <span><span lang="hi">अगले 4 घंटे में सीटों वाली गाड़ियां</span> / Departing in next 4 hours with seats <b>{loaded ? shown.length : "–"}</b></span>
            <span><span lang="hi">कोटा</span> / Quota <b><span lang="hi">सामान्य · करंट बुकिंग</span> / General · Current Booking</b></span>
            {pageCount > 1 && (
              <span className="b-pager" aria-live="polite">
                <span lang="hi">पृष्ठ</span> / Page <b>{page + 1}</b> / <b>{pageCount}</b>
                <span className="b-dots" aria-hidden="true">{Array.from({ length: pageCount }, (_, i) => <i key={i} className={i === page ? "on" : ""} />)}</span>
                <span className="b-pbar" aria-hidden="true"><i key={`${page}-${pageCount}`} style={{ animationDuration: `${PAGE_MS}ms` }} /></span>
              </span>
            )}
          </div>

          <div className={`b-list${loaded && frame.length ? " fill" : ""}`} style={{ ["--rows" as string]: rows }} key={`frame-${page}`} ref={listRef} aria-label="Current booking seats from New Delhi by train, destination and class">
            {!loaded ? <div className="b-empty"><span lang="hi">गाड़ियां लोड हो रही हैं…</span><br />Loading trains…</div>
              : failed && shown.length === 0 ? <div className="b-empty"><b lang="hi">बोर्ड की जानकारी उपलब्ध नहीं</b><b>Board data unavailable</b>Check the internet connection. The board retries every minute.</div>
              : shown.length === 0 ? <div className="b-empty"><b lang="hi">अगले 4 घंटे में करंट बुकिंग सीटें उपलब्ध नहीं</b><b>No current-booking seats in the next 4 hours</b>Trains departing New Delhi in the next 4 hours appear here once their reservation chart is prepared and current-booking seats are available. Each train leaves the board at its departure time.</div>
              : frame.map((t, i) => (
                <article key={keyOf(t)} data-row={keyOf(t)} className={`b-row${leaving.has(keyOf(t)) ? " out" : ""}`} style={{ animationDelay: `${i * 0.08}s` }}>
                  <div className="b-train">
                    <div className="b-tline"><span className="b-tno">{t.train_no}</span><span className="b-tdep">Dep <b className={t.delay_min != null && t.delay_min >= LATE_MIN ? "struck" : ""}>{hhmm(new Date(t.dep_at))}</b></span></div>
                    <div className="b-tname">{t.train_name}</div>
                    {(t.platform_override ?? t.platform) && <div className="b-pf"><span lang="hi">प्लेटफॉर्म</span> / PF <b>{t.platform_override ?? t.platform}</b></div>}
                    <Running t={t} />
                    {now && <Meta t={t} now={now} />}
                  </div>
                  {t.chart_ready === false ? (
                    <div className="b-stops"><div className="b-stop await"><div className="b-shead">
                      <span className="b-dcode"><span lang="hi">चार्ट प्रतीक्षित</span> · CHART AWAITED</span>
                      <span className="b-dname">Current booking opens after the reservation chart is prepared</span>
                    </div></div></div>
                  ) : <StopStrip train={t} reduce={reduce} />}
                  {now && depOf(t).getTime() - now.getTime() <= ONBOARD_MS && (
                    <div className="b-onboard" role="note">
                      <span lang="hi">प्रस्थान में 15 मिनट से कम समय · टिकट ट्रेन में ऑन-बोर्ड स्टाफ (टीटीई) से बनवाएं</span>
                      <span>Less than 15 min to departure · Ticket can be booked by on-board staff (TTE)</span>
                    </div>
                  )}
                </article>
              ))}
          </div>

          <div className="b-legend">
            <span className="b-sig b-go"><i style={{ background: "var(--sig-go)" }} /><span lang="hi">सीटें उपलब्ध (10 से अधिक)</span> / Seats available (more than 10)</span>
            <span className="b-sig b-caution"><i style={{ background: "var(--sig-caution)" }} /><span lang="hi">कुछ ही सीटें (1–10)</span> / Few seats left (1–10)</span>
            <span className="b-sig"><i style={{ background: "var(--dim)", boxShadow: "none" }} /><span lang="hi">केवल सीटों वाले गंतव्य व श्रेणियां दिखाई गई हैं</span> / Only destinations and classes with seats are shown</span>
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
