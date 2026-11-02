// Current-booking board sync for stations other than NDLS (NDLS keeps its own board-sync function).
// pg_cron calls private.run_station_syncs() every minute; it posts {station} here once per active station
// that has API keys. A per-station lock keeps one run at a time. Each station uses only its own keys and budget.
// Data sources (the station's own keys):
//   RailKit   — NTES live station board: train list, expected departure, delay, platform, classes.
//   irctc.dev — seat availability from PRS (current booking after charting). Limit 10 requests/minute.
//   RailRadar — backup for both, and each new train's halts (fetched once and kept).
// Each run: 1. marks departed trains  2. reads the station board every sync_minutes (30 overnight)
//           3. learns halts/classes once per train  4. seats: one full check per train after charting,
//           then rechecks of the destination/class pairs that had seats, within the station's daily budget.
import postgres from "npm:postgres@3.4.4";
import { configure as rkConfigure, liveAtStation } from "npm:railkit@6.0.2";

const RR = "https://api.railradar.in/v1";
const IC = "https://api.irctc.dev";
const WINDOW_H = 4;
const RUN_MAX_MS = 115_000;
const IC_GAP_MS = 6_200;             // irctc.dev: 10 requests/minute
const RR_GAP_MS = 2_100;             // RailRadar: 30 requests/minute
const RR_BACKUP_DAILY_CAP = 300;     // RailRadar when it is only the backup
const RK_DAILY_CAP = 300;            // RailKit Advance: 10,000 a month
const SKIP_TYPES = /(EMU|MEMU|DEMU|PASSENGER|LOCAL|SUBURBAN)/i;
const CLASS_ORDER = ["1A", "2A", "3A", "3E", "SL", "EA", "EC", "CC", "2S"];
const MON: Record<string, number> = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };

type Json = Record<string, any>;
type Entry = { no: string; name: string | null; type: string; jd: string; startDate: string | null; depAt: string; expAt: string;
               delay: number | null; platform: string | null; classes: string[] | null; note: string | null; cancelled: boolean; departed: boolean };

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const addDays = (ymd: string, n: number) => { const d = new Date(ymd + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const title = (s: string) => s.toLowerCase().replace(/\b([a-z])/g, m => m.toUpperCase()).replace(/\bJn\b\.?/i, "Jn");
const istYmd = (t = Date.now()) => new Date(t + 330 * 60000).toISOString().slice(0, 10);
const at = (ymd: string, hm: string) => new Date(`${ymd}T${hm}:00+05:30`).getTime();
const iso = (t: number) => new Date(t).toISOString();

function classesFrom(layout: string | undefined): string[] {
  const found = new Set<string>();
  for (const tok of (layout ?? "").split("-")) {
    const m = tok.trim().toUpperCase().match(/^([A-Z]+)\d+$/);
    if (!m) continue;
    const map: Record<string, string[]> = { H: ["1A"], HA: ["1A", "2A"], A: ["2A"], B: ["3A"], G: ["3A"], M: ["3E"], S: ["SL"], C: ["CC"], J: ["CC"], E: ["EC"], EA: ["EA"], D: ["2S"] };
    (map[m[1]] ?? []).forEach(c => found.add(c));
  }
  return CLASS_ORDER.filter(c => found.has(c));
}
const classesFromList = (s: string | undefined) => CLASS_ORDER.filter(c => (s ?? "").split(/[,\s]+/).includes(c));

/** Seat count from a list of {date, status}. chart: true = current booking, false = chart not prepared, null = unknown. */
function readSeats(days: Json[] | undefined, jd: string): { n: number | null; chart: boolean | null } {
  const day = (days ?? []).find((x: Json) => x.date === jd || x.rawDate === jd);
  const st = String(day?.status ?? "").toUpperCase();
  if (!st) return { n: null, chart: null };
  if (st.startsWith("CURR_AVBL")) return { n: Number(st.split("-")[1]) || Number(day?.availableSeats) || 0, chart: true };
  if (/^(AVAILABLE|RAC|GNWL|RLWL|PQWL|RSWL|TQWL|NPWL|WL)/.test(st)) return { n: null, chart: false };
  return { n: 0, chart: true };                                            // REGRET / NOT AVAILABLE / CHART PREPARED
}

function fromRailKit(e: Json, now: number, station: string): Entry | null {
  const sch = String(e.departure?.scheduled ?? "").slice(0, 5);
  if (!/^\d{2}:\d{2}$/.test(sch)) return null;                              // terminates here
  const today = istYmd(now);
  const jd = [addDays(today, -1), today, addDays(today, 1)]
    .sort((a, b) => Math.abs(at(a, sch) - now) - Math.abs(at(b, sch) - now))[0];
  const depT = at(jd, sch);
  let expT = depT;
  const act = String(e.departure?.actual ?? "").replace("*", "").slice(0, 5);
  if (/^\d{2}:\d{2}$/.test(act)) {
    expT = at(jd, act);
    if (expT < depT - 6 * 3600e3) expT += 24 * 3600e3;
    if (expT < depT) expT = depT;
  }
  const m = String(e.runDate ?? "").match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
  const startDate = m ? `${m[3]}-${String(MON[m[2]] ?? 1).padStart(2, "0")}-${m[1].padStart(2, "0")}` : null;
  const isSource = String(e.arrival?.actual ?? "").toUpperCase().startsWith("SRC") || e.source === station;
  const delay = Math.round((expT - depT) / 60000);
  return {
    no: String(e.trainNo), name: e.trainName ? title(String(e.trainName)) : null, type: String(e.trainType ?? ""),
    jd, startDate, depAt: iso(depT), expAt: iso(expT), delay, platform: e.platform ? String(e.platform) : null,
    classes: e.classes ? classesFromList(String(e.classes)) : null,
    note: isSource ? (delay > 0 ? "Rescheduled" : "Yet to start") : "On the way",
    cancelled: !!e.cancelled && String(e.cancelled).toLowerCase() !== "false", departed: false,
  };
}

function fromRailRadar(e: Json, stationName: string): Entry | null {
  const tr = e.train ?? {}, st = e.stop ?? {}, lv = e.live ?? {};
  if (!tr.number || !st.departure || !lv.startDate) return null;
  const jd = addDays(lv.startDate, (Number(st.day) || 1) - 1);
  const depT = at(jd, st.departure);
  const expT = Math.max(depT, lv.expectedDepartureTime ? new Date(lv.expectedDepartureTime).getTime() : depT);
  return {
    no: String(tr.number), name: tr.name ?? null, type: String(tr.type ?? ""), jd, startDate: lv.startDate,
    depAt: iso(depT), expAt: iso(expT), delay: typeof lv.delayMinutes === "number" ? Math.max(0, lv.delayMinutes) : null,
    platform: st.platform ?? null, classes: null,
    note: lv.type === "at-station" ? `At ${stationName}` : lv.type === "not-started" ? "Yet to start" : lv.type === "upcoming" ? "On the way" : null,
    cancelled: false, departed: lv.type === "departed",
  };
}

Deno.serve(async (req) => {
  const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false, max: 1 });
  const [tok] = await sql`select value from private.app_secret where name = 'sync_token'`;
  if (!tok || req.headers.get("x-sync-token") !== tok.value) { await sql.end(); return new Response("forbidden", { status: 403 }); }
  const S = String((await req.json().catch(() => ({})))?.station ?? "").toUpperCase();
  if (!/^[A-Z]{2,5}$/.test(S) || S === "NDLS") { await sql.end(); return new Response("bad station", { status: 400 }); }

  const [lock] = await sql`update public.stations set sync_lock_until = now() + interval '3 minutes'
                           where code = ${S} and active and (sync_lock_until is null or sync_lock_until < now()) returning code`;
  if (!lock) { await sql.end(); return Response.json({ ok: true, skipped: "busy or inactive" }); }

  const [s] = await sql`select * from public.stations where code = ${S}`;
  const [k] = await sql`select railradar, irctcdev, railkit from private.station_keys where station = ${S}`;
  const rrKey: string | null = k?.railradar ?? null, icKey: string | null = k?.irctcdev ?? null, rkKey: string | null = k?.railkit ?? null;
  const LOCAL = new Set<string>([...(s.local_codes ?? []), S]);
  const stationName: string = s.name_en ?? S;

  const t0 = Date.now(), now = Date.now();
  const log: string[] = [];
  const used = { rr: 0, ic: 0, rk: 0, seat: 0 };
  let icLast = 0, rrLast = 0, icBlocked = !icKey || (s.irctc_credits_left ?? 0) <= 0, rrBlocked = !rrKey;

  const usage = Object.fromEntries((await sql`select provider, calls from public.st_api_usage
                                               where station = ${S} and day = (now() at time zone 'Asia/Kolkata')::date`)
    .map(r => [r.provider, Number(r.calls)]));
  const [rrMonth] = await sql`select month_remaining from public.st_api_usage where station = ${S} and provider = 'railradar'
                               and month_remaining is not null order by day desc limit 1`;
  const minsNow = Math.floor(((now + 330 * 60000) % 86400000) / 60000);
  const seatAllow = Math.max(0, s.seat_daily_budget ?? 1000);
  const seatPaced = Math.floor(seatAllow * Math.min(1, Math.max(0.05, (minsNow - 240) / (20 * 60))));
  const seatToday = () => (usage.seat_checks ?? 0) + used.seat;
  // RailRadar is a small backup when irctc.dev is set; without irctc.dev it carries the seat checks too.
  const rrCap = icKey ? RR_BACKUP_DAILY_CAP : seatAllow + RR_BACKUP_DAILY_CAP;
  const rrToday = () => (usage.railradar ?? 0) + used.rr;
  const rrOk = () => !rrBlocked && rrToday() < rrCap && (rrMonth?.month_remaining ?? 1000) - used.rr > 300;
  const time = () => Date.now() - t0 < RUN_MAX_MS;

  async function count(provider: string, lim: number | null = null, rem: number | null = null) {
    await sql`select private.count_station_call(${S}, ${provider}, 1, ${lim}, ${rem})`;
  }
  async function rr(path: string): Promise<{ status: number; body: Json | null }> {
    const wait = rrLast + RR_GAP_MS - Date.now(); if (wait > 0) await sleep(wait);
    rrLast = Date.now(); used.rr++;
    try {
      const r = await fetch(RR + path, { headers: { Authorization: `Bearer ${rrKey}`, Accept: "application/json" } });
      const lim = Number(r.headers.get("x-ratelimit-limit-month")) || null;
      const rem = r.headers.has("x-ratelimit-remaining-month") ? Number(r.headers.get("x-ratelimit-remaining-month")) : null;
      await count("railradar", lim, rem);
      if (r.status === 429 || r.status === 401 || r.status === 403) rrBlocked = true;
      return { status: r.status, body: await r.json().catch(() => null) };
    } catch { await count("railradar"); return { status: 0, body: null }; }
  }
  async function ic(path: string): Promise<{ status: number; body: Json | null }> {
    const wait = icLast + IC_GAP_MS - Date.now(); if (wait > 0) await sleep(wait);
    icLast = Date.now(); used.ic++;
    try {
      const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), 20_000);
      const r = await fetch(IC + path, { headers: { "x-api-key": icKey!, accept: "application/json" }, signal: ctl.signal });
      clearTimeout(tm);
      await count("irctcdev");
      if (r.status === 429 || r.status === 401 || r.status === 402 || r.status === 403) icBlocked = true;
      return { status: r.status, body: await r.json().catch(() => null) };
    } catch { await count("irctcdev"); return { status: 0, body: null }; }
  }
  async function seatsFor(no: string, jd: string, dest: string, cls: string) {
    used.seat++; await count("seat_checks");
    if (!icBlocked) {
      const dmy = jd.split("-").reverse().join("-");
      const { status, body } = await ic(`/api/v1/trains/${no}/availability?from=${S}&to=${dest}&date=${dmy}&class=${cls}&quota=GN`);
      if (status === 200 && body?.success !== false) return { status: 200, ...readSeats(body?.availability, jd) };
      if (status === 404) return { status: 404, n: null, chart: null };
    }
    if (!rrOk()) return { status: 0, n: null, chart: null };
    const { status, body } = await rr(`/trains/${no}/seats?from=${S}&to=${dest}&date=${jd}&class=${cls}&quota=GN`);
    return { status, ...(status === 200 ? readSeats(body?.data?.calendar, jd) : { n: null, chart: null }) };
  }
  const seatSource = () => !icBlocked || rrOk();
  const canSeat = () => time() && seatToday() < seatAllow && seatSource();
  const canRecheck = () => time() && seatToday() < seatPaced && seatSource();
  const gapMs = () => (!icBlocked ? IC_GAP_MS : RR_GAP_MS);

  try {
    // ---- 1. departed -----------------------------------------------------------------------------
    await sql`update public.st_trains set status = 'departed'
               where station = ${S} and status in ('queued','active','error') and coalesce(expected_dep_at, dep_at) <= now()`;

    // ---- 2. live board ---------------------------------------------------------------------------
    const night = minsNow < 300;
    const boardEvery = night ? 30 : Math.max(10, s.sync_minutes ?? 15);
    const boardDue = !s.board_fetched_at || Date.now() - new Date(s.board_fetched_at).getTime() > (boardEvery - 1) * 60000;
    if (boardDue) {
      let entries: Entry[] = [], source = "";
      if (rkKey && (usage.railkit ?? 0) < RK_DAILY_CAP) {
        try {
          rkConfigure(rkKey); used.rk++;
          const res: Json = await liveAtStation(S, WINDOW_H as 4);
          await count("railkit");
          const list: Json[] = res?.data?.trains ?? [];
          if (res?.success && list.length >= 1) { entries = list.map(e => fromRailKit(e, now, S)).filter((e): e is Entry => !!e); source = "ntes"; }
        } catch (e) { log.push(`railkit failed: ${String(e).slice(0, 80)}`); }
      }
      if (!source && rrOk()) {
        const { status, body } = await rr(`/stations/${S}/live?hours=${WINDOW_H}`);
        const list: Json[] = body?.data?.trains ?? [];
        if (status === 200 && list.length >= 1) { entries = list.map(e => fromRailRadar(e, stationName)).filter((e): e is Entry => !!e); source = "railradar"; }
        else log.push(`railradar board ${status}`);
      }
      if (source) {
        await sql`update public.stations set board_fetched_at = now(), board_source = ${source} where code = ${S}`;
        const known = new Map((await sql`select train_no, classes, schedule_at from public.st_train_info where station = ${S}`).map(r => [r.train_no, r]));
        const seen: string[] = [], left: string[] = [], cancelled: string[] = [];
        for (const e of entries) {
          const key = `${e.no}|${e.jd}`;
          if (e.departed) { left.push(key); continue; }
          if (e.cancelled) { cancelled.push(key); continue; }
          if (e.classes && !e.classes.length) continue;                     // unreserved (NTES lists only GEN)
          if (!e.classes && !known.has(e.no) && SKIP_TYPES.test(e.type)) continue;
          if (new Date(e.depAt).getTime() > now + WINDOW_H * 3600e3) continue;
          if (!known.has(e.no)) {
            // New train: halts after this station from RailRadar's schedule, once.
            if (!rrOk() || !time()) continue;
            const sc = await rr(`/trains/${e.no}`);
            const route: Json[] = sc.body?.data?.route ?? [];
            const i = route.findIndex(x => x.station?.code === S);
            if (i < 0) continue;
            const halts = route.slice(i + 1).filter(x => x.isHalt && x.station?.code);
            const cls = e.classes?.length ? e.classes : classesFrom(route[i].coachPosition ?? route.find(x => x.coachPosition)?.coachPosition);
            if (!halts.length || !cls.length) continue;
            const codes = halts.map(x => x.station.code);
            const names = Object.fromEntries(halts.map(x => [x.station.code, title(x.station.name ?? x.station.code)]));
            const nm = sc.body?.data?.trainName ?? sc.body?.data?.train?.name ?? sc.body?.data?.name ?? null;
            await sql`insert into public.st_train_info (station, train_no, train_name, display_name, category, origin_code,
                        stop_codes, classes, stop_names, schedule_at, source)
                      values (${S}, ${e.no}, ${nm ?? e.name ?? e.no}, ${nm}, ${i === 0 ? "Originating" : "Passing"}, ${route[0]?.station?.code ?? null},
                        ${codes}, ${cls}, ${sql.json(names)}, now(), 'railradar')
                      on conflict (station, train_no) do nothing`;
            known.set(e.no, { train_no: e.no, classes: cls, schedule_at: new Date() });
          } else if (e.classes?.length) {
            const kn = known.get(e.no);
            if (!kn.classes?.length || kn.classes.join() !== e.classes.join())
              await sql`update public.st_train_info set classes = ${e.classes} where station = ${S} and train_no = ${e.no}`;
          }
          await sql`insert into public.st_trains (station, train_no, journey_date, start_date, train_name, dep_at, refresh_minutes, status,
                                                  next_check_at, added_at, expected_dep_at, delay_min, running_note, running_checked_at, platform)
                    values (${S}, ${e.no}, ${e.jd}, ${e.startDate},
                            coalesce((select n.display_name from public.st_train_info n where n.station = ${S} and n.train_no = ${e.no}), ${e.name}),
                            ${e.depAt}, ${s.default_refresh_minutes ?? 30}, 'queued', now(), now(),
                            ${e.expAt}, ${e.delay}, ${e.note}, now(), ${e.platform})
                    on conflict (station, train_no, journey_date) do update set
                      train_name = coalesce((select n.display_name from public.st_train_info n where n.station = excluded.station and n.train_no = excluded.train_no),
                                            public.st_trains.train_name, excluded.train_name),
                      start_date = coalesce(excluded.start_date, public.st_trains.start_date),
                      dep_at = excluded.dep_at, expected_dep_at = excluded.expected_dep_at,
                      delay_min = excluded.delay_min, running_note = excluded.running_note,
                      status = case when public.st_trains.status = 'departed' and excluded.expected_dep_at > now()
                                    then case when public.st_trains.checked_at is null then 'queued' else 'active' end
                                    else public.st_trains.status end,
                      running_checked_at = now(), platform = coalesce(excluded.platform, public.st_trains.platform)`;
          seen.push(key);
        }
        if (left.length) await sql`update public.st_trains set status = 'departed', running_note = 'Departed'
                                   where station = ${S} and status in ('queued','active','error') and (train_no || '|' || journey_date::text) = any(${left})`;
        if (cancelled.length) await sql`update public.st_trains set status = 'removed', last_error = 'Cancelled (NTES)'
                                   where station = ${S} and status in ('queued','active','error') and (train_no || '|' || journey_date::text) = any(${cancelled})`;
        let gone: Json[] = [], dep: Json[] = [];
        if (seen.length >= 1) {
          gone = await sql`update public.st_trains set status = 'removed', last_error = ${`Not on the ${S} live board: not running today`}
                           where station = ${S} and status in ('queued','active','error')
                             and dep_at between now() + interval '20 minutes' and now() + interval '3 hours'
                             and not ((train_no || '|' || journey_date::text) = any(${seen})) returning train_no`;
          if (source === "ntes")
            dep = await sql`update public.st_trains set status = 'departed', running_note = 'Departed'
                            where station = ${S} and status in ('queued','active','error') and dep_at < now()
                              and not ((train_no || '|' || journey_date::text) = any(${seen})) returning train_no`;
        }
        log.push(`board ${source} ${entries.length}, ${seen.length} reserved` +
                 (gone.length ? `, not running: ${gone.map(g => g.train_no).join(" ")}` : "") +
                 (dep.length ? `, left: ${dep.map(g => g.train_no).join(" ")}` : "") +
                 (cancelled.length ? `, cancelled: ${cancelled.length}` : ""));
      } else {
        log.push(rkKey || rrKey ? "board failed" : "no RailKit or RailRadar key: cannot read the station board");
      }
    }

    // ---- 2b. clean display names (NTES gives short ones) -------------------------------------------
    const [nm] = await sql`select (select count(*) from public.st_trains t join public.st_train_info n using (station, train_no)
                             where t.station = ${S} and t.status in ('queued','active','error') and n.display_name is null)::int missing`;
    if (nm?.missing > 0 && rrOk() && time() && (!s.names_at || Date.now() - new Date(s.names_at).getTime() > 60 * 60000)) {
      await sql`update public.stations set names_at = now() where code = ${S}`;
      const { status, body } = await rr(`/stations/${S}/live?hours=${WINDOW_H}`);
      const pairs = (status === 200 ? (body?.data?.trains ?? []) : [])
        .map((x: Json) => [String(x.train?.number ?? ""), String(x.train?.name ?? "")]).filter(([a, b]: string[]) => a && b);
      for (const [no, name] of pairs) {
        await sql`update public.st_train_info set display_name = ${name} where station = ${S} and train_no = ${no} and display_name is null`;
        await sql`update public.st_trains set train_name = ${name} where station = ${S} and train_no = ${no} and status in ('queued','active','error')
                  and exists (select 1 from public.st_train_info n where n.station = ${S} and n.train_no = ${no} and n.display_name = ${name})`;
      }
    }

    // ---- 4. seats --------------------------------------------------------------------------------
    const due = await sql`select t.id, t.train_no, t.journey_date::text jd, t.stops, n.stop_codes, n.classes, n.stop_names,
                                 coalesce(t.refresh_minutes, ${s.default_refresh_minutes ?? 30}) every,
                                 (t.chart_ready is true and jsonb_array_length(coalesce(t.stops, '[]'::jsonb)) > 0) recheck,
                                 case when t.checked_at is null or t.chart_ready is not true then 0
                                      when jsonb_array_length(coalesce(t.stops, '[]'::jsonb)) > 0 then 1 else 2 end prio
                          from public.st_trains t join public.st_train_info n using (station, train_no)
                          where t.station = ${S} and t.status in ('queued','active','error')
                            and t.next_check_at <= now() + interval '1 minute'
                            and coalesce(t.expected_dep_at, t.dep_at) > now() + interval '15 minutes'
                            and t.dep_at <= now() + interval '4 hours'
                          order by prio, coalesce(t.expected_dep_at, t.dep_at)
                          limit 12`;
    let full = 0, re = 0;
    for (const t of due) {
      const names: Json = t.stop_names ?? {};
      if (t.recheck) {
        if (!canRecheck()) break;
        const old: Json[] = (t.stops ?? []).filter((st: Json) => !LOCAL.has(st.code));
        const pairs: [string, string][] = [];
        old.forEach(st => Object.entries(st.seats ?? {}).forEach(([c, n]) => { if (Number(n) > 0) pairs.push([st.code, c]); }));
        if (!pairs.length) { await sql`update public.st_trains set stops = '[]'::jsonb, next_check_at = now() where id = ${t.id}`; continue; }
        const upd: Record<string, Record<string, number>> = {};
        let ok = 0;
        for (const [dest, c] of pairs.slice(0, 6)) {
          if (!canRecheck()) break;
          const r = await seatsFor(t.train_no, t.jd, dest, c);
          if (r.n === null) continue;
          (upd[dest] ??= {})[c] = r.n; ok++;
        }
        if (!ok) { await sql`update public.st_trains set next_check_at = now() + interval '5 minutes' where id = ${t.id}`; continue; }
        const stops = old.map(st => {
          const seats: Record<string, number> = { ...(st.seats ?? {}), ...(upd[st.code] ?? {}) };
          Object.keys(seats).forEach(c => { if (!(seats[c] > 0)) delete seats[c]; });
          return { code: st.code, name: st.name ?? names[st.code] ?? st.code, seats };
        }).filter(st => Object.keys(st.seats).length);
        await sql`update public.st_trains set stops = ${sql.json(stops)}, checked_at = now(), status = 'active', last_error = null,
                    next_check_at = now() + make_interval(mins => ${t.every}) where id = ${t.id}`;
        re++;
        log.push(`${t.train_no} re: ${stops.map(st => st.code + " " + Object.entries(st.seats).map(([c, n]) => c + n).join(",")).join(" ") || "sold out"}`);
        continue;
      }

      const cls: string[] = t.classes?.length ? t.classes : ["SL", "3A", "2A", "CC"];
      const codes: string[] = (t.stop_codes ?? []).filter((c: string) => !LOCAL.has(c));
      if (!codes.length) {
        await sql`update public.st_trains set status = 'removed', last_error = 'Only nearby stops' where id = ${t.id}`;
        continue;
      }
      const final = codes[codes.length - 1];
      const extra = [codes[0], codes[Math.floor((codes.length - 1) / 2)]].filter((c, i, a) => c !== final && a.indexOf(c) === i);
      const plan: [string, string][] = [];
      cls.forEach(c => plan.push([final, c]));
      extra.forEach(d => cls.forEach(c => plan.push([d, c])));
      const gate = t.prio === 2 ? canRecheck : canSeat;
      if (!gate() || seatAllow - seatToday() < Math.min(cls.length, 3) || RUN_MAX_MS - (Date.now() - t0) < Math.min(plan.length, 10) * gapMs() * 0.6) break;
      const seats: Record<string, Record<string, number>> = {};
      let chart: boolean | null = null, failed = 0, missing = 0, asked = 0;
      for (const [dest, c] of plan.slice(0, 10)) {
        if (!gate()) break;
        if (dest !== final && (seats[final]?.[c] ?? 0) > 0) continue;
        const r = await seatsFor(t.train_no, t.jd, dest, c);
        asked++;
        if (r.status === 404) { missing++; if (missing >= 2 && !Object.keys(seats).length) break; continue; }
        if (r.status !== 200) { failed++; continue; }
        if (r.chart === false) { chart = false; break; }
        if (r.n === null) continue;
        chart = true;
        (seats[dest] ??= {})[c] = r.n;
      }
      if (chart === false) {
        await sql`update public.st_trains set chart_ready = false, stops = '[]'::jsonb, checked_at = now(), status = 'active',
                    last_error = null, next_check_at = now() + interval '20 minutes' where id = ${t.id}`;
      } else if (Object.keys(seats).length) {
        const stops = codes.filter(c => seats[c])
          .map(c => ({ code: c, name: names[c] ?? c, seats: Object.fromEntries(Object.entries(seats[c]).filter(([, n]) => n > 0)) }))
          .filter(st => Object.keys(st.seats).length);
        await sql`update public.st_trains set stops = ${sql.json(stops)}, chart_ready = true, checked_at = now(), status = 'active',
                    last_error = null, next_check_at = now() + make_interval(mins => ${t.every}) where id = ${t.id}`;
      } else if (missing && missing === asked) {
        await sql`update public.st_trains set status = 'removed', last_error = 'No seat data for this train' where id = ${t.id}`;
      } else if (asked === 0) {
        continue;
      } else {
        await sql`update public.st_trains set status = 'error', next_check_at = now() + interval '10 minutes',
                    last_error = ${failed ? "Seat service did not respond" : "Check interrupted"} where id = ${t.id}`;
      }
      full++;
      log.push(`${t.train_no}: ${chart === false ? "chart not prepared" : Object.entries(seats).map(([d, v]) => d + " " + Object.entries(v).filter(([, n]) => n > 0).map(([c, n]) => c + n).join(",")).join(" ")}`);
    }
    log.push(`full ${full}, re ${re} · calls irctc.dev ${used.ic}, railkit ${used.rk}, railradar ${used.rr}` +
             ` · seats today ${seatToday()}/${seatAllow} (paced ${seatPaced})` +
             (icKey ? `, irctc credits ${Math.max(0, (s.irctc_credits_left ?? 0) - used.ic)}` : "") +
             (icKey && icBlocked ? " · irctc.dev unavailable (check key and credits left), using RailRadar" : ""));
  } catch (e) {
    log.push(`error: ${String(e).slice(0, 200)}`);
  }
  const note = log.join(" · ").slice(0, 1000);
  const idle = !used.ic && !used.rk && !used.rr;
  if (idle && !log.some(l => l.startsWith("no ") || l.startsWith("error"))) await sql`update public.stations set last_sync_at = now(), sync_lock_until = null where code = ${S}`;
  else await sql`update public.stations set last_sync_note = ${note}, last_sync_at = now(), sync_lock_until = null where code = ${S}`;
  await sql.end();
  return Response.json({ ok: true, station: S, used, note });
});
