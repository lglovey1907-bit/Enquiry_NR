// NDLS current-booking board sync. pg_cron ticks every 5 minutes; runs every settings.sync_minutes (admin setting).
// 1. Marks departed trains.  2. Reads RailRadar's NDLS live board: adds reserved trains departing in the
// next 4 hours, with expected departure, delay and platform.  3. Learns each train's classes and halts
// once from its schedule.  4. Fetches current-booking seats within a daily request budget.
import postgres from "npm:postgres@3.4.4";

const BASE = "https://api.railradar.in/v1";
const WINDOW_H = 4;
const BOARD_MIN_EVERY = 10;         // live board refresh at most this often
const RUN_MAX_CALLS = 40;            // per run (rate limit is 30/min; calls are paced)
const RUN_MAX_MS = 125_000;          // stop starting new calls after this
const GAP_MS = 2_100;                // pacing between calls
const SKIP_TYPES = /(EMU|MEMU|DEMU|PASSENGER|LOCAL|SUBURBAN)/i;
const CLASS_ORDER = ["1A", "2A", "3A", "3E", "SL", "EA", "EC", "CC", "2S"];

type Json = Record<string, any>;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const addDays = (ymd: string, n: number) => { const d = new Date(ymd + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const title = (s: string) => s.toLowerCase().replace(/\b([a-z])/g, m => m.toUpperCase()).replace(/\bJn\b\.?/i, "Jn");

/** Classes present on a train, from a coach layout like "ENG-H1-A1-B1-B2-M1-S1-GEN". */
function classesFrom(layout: string | undefined): string[] {
  const found = new Set<string>();
  for (const tok of (layout ?? "").split("-")) {
    const m = tok.trim().toUpperCase().match(/^([A-Z]+)\d+$/);
    if (!m) continue;
    const p = m[1];
    const map: Record<string, string[]> = { H: ["1A"], HA: ["1A", "2A"], A: ["2A"], B: ["3A"], G: ["3A"], M: ["3E"], S: ["SL"], C: ["CC"], J: ["CC"], E: ["EC"], EA: ["EA"], D: ["2S"] };
    (map[p] ?? []).forEach(c => found.add(c));
  }
  return CLASS_ORDER.filter(c => found.has(c));
}

Deno.serve(async (req) => {
  const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false, max: 1 });
  const [tok] = await sql`select value from private.app_secret where name = 'sync_token'`;
  if (!tok || req.headers.get("x-sync-token") !== tok.value) { await sql.end(); return new Response("forbidden", { status: 403 }); }
  const key = Deno.env.get("RAILRADAR_API_KEY");
  const t0 = Date.now();
  const log: string[] = [];
  let calls = 0, lastCall = 0, stopAll = false;

  // ---- request budget -------------------------------------------------------------------------
  const [s] = await sql`select default_refresh_minutes, board_fetched_at, month_reserve, sync_minutes, last_sync_at
                         from public.settings where id = 1`;
  // The scheduler ticks every 5 minutes; run only when the admin's interval has passed.
  const every = s?.sync_minutes ?? 15;
  if (s?.last_sync_at && Date.now() - new Date(s.last_sync_at).getTime() < (every * 60 - 90) * 1000) {
    await sql.end();
    return Response.json({ ok: true, skipped: true });
  }
  await sql`update public.settings set last_sync_at = now() where id = 1`;   // start time of this run
  const [u] = await sql`select calls, month_limit, month_remaining from public.api_usage
                        where day = (now() at time zone 'Asia/Kolkata')::date`;
  const [last] = await sql`select month_remaining from public.api_usage where month_remaining is not null order by day desc limit 1`;
  const callsToday = u?.calls ?? 0;
  const remaining = u?.month_remaining ?? last?.month_remaining ?? 25000;
  const now = new Date(), ist = new Date(now.getTime() + 330 * 60000);
  const daysInMonth = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth() + 1, 0)).getUTCDate();
  const daysLeft = daysInMonth - ist.getUTCDate() + 1;
  const monthLimit = u?.month_limit ?? 30000;
  // Spread what is left over the rest of the month, but never more than 1.5x an average day
  // (in case the plan's month doesn't reset on the 1st).
  const allowToday = Math.max(0, Math.min(Math.floor((remaining + callsToday - (s?.month_reserve ?? 1500)) / daysLeft),
                                          Math.floor((monthLimit / 30) * 1.5)));
  const leftToday = Math.max(0, allowToday - callsToday);
  const minsLeftToday = 24 * 60 - (ist.getUTCHours() * 60 + ist.getUTCMinutes());
  const runsLeft = Math.max(1, Math.ceil(minsLeftToday / every));
  let runBudget = Math.min(RUN_MAX_CALLS, leftToday, Math.max(10, Math.ceil((leftToday / runsLeft) * 1.5)));
  log.push(`budget ${runBudget} (today ${callsToday}/${allowToday}, month left ${remaining})`);

  async function rr(path: string): Promise<{ status: number; body: Json | null }> {
    if (!key) throw new Error("RAILRADAR_API_KEY missing");
    const wait = lastCall + GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastCall = Date.now(); calls++; runBudget--;
    const r = await fetch(BASE + path, { headers: { Authorization: `Bearer ${key}`, Accept: "application/json" } });
    const lim = Number(r.headers.get("x-ratelimit-limit-month")) || null;
    const rem = r.headers.has("x-ratelimit-remaining-month") ? Number(r.headers.get("x-ratelimit-remaining-month")) : null;
    await sql`select private.count_api_call(1, ${lim}, ${rem})`;
    if (r.status === 429) stopAll = true;
    let body: Json | null = null;
    try { body = await r.json(); } catch { /* ignore */ }
    return { status: r.status, body };
  }
  const canCall = () => !stopAll && runBudget > 0 && Date.now() - t0 < RUN_MAX_MS;

  try {
    // ---- 1. departed -----------------------------------------------------------------------------
    await sql`update public.trains set status = 'departed'
               where status in ('queued','active','error') and coalesce(expected_dep_at, dep_at) <= now()`;

    // ---- 2. live board ---------------------------------------------------------------------------
    const boardDue = !s?.board_fetched_at || Date.now() - new Date(s.board_fetched_at).getTime() > (Math.max(BOARD_MIN_EVERY, every) - 1) * 60000;
    let boardOk = false;
    if (boardDue && canCall()) {
      const { status, body } = await rr(`/stations/NDLS/live?hours=${WINDOW_H}`);
      const list: Json[] = body?.data?.trains ?? [];
      if (status === 200 && list.length >= 5) {
        boardOk = true;
        await sql`update public.settings set board_fetched_at = now() where id = 1`;
        const known = new Set((await sql`select train_no from public.ndls_trains`).map(r => r.train_no));
        const seen: string[] = [];
        for (const e of list) {
          const tr = e.train ?? {}, st = e.stop ?? {}, lv = e.live ?? {};
          const no = String(tr.number ?? "");
          if (!no || !st.departure || !lv.startDate) continue;                 // arrives only / unknown
          if (!known.has(no) && SKIP_TYPES.test(String(tr.type ?? ""))) continue; // unreserved locals
          const jd = addDays(lv.startDate, (Number(st.day) || 1) - 1);
          const depAt = `${jd}T${st.departure}:00+05:30`;
          if (new Date(depAt).getTime() > Date.now() + WINDOW_H * 3600e3) continue;
          if (!known.has(no)) {
            // Special or train missing from the list: learn it from its schedule (needs one call).
            if (!canCall()) continue;
            const sc = await rr(`/trains/${no}`);
            const route: Json[] = sc.body?.data?.route ?? [];
            const i = route.findIndex(x => x.station?.code === "NDLS");
            if (i < 0) continue;
            const halts = route.slice(i + 1).filter(x => x.isHalt && x.station?.code);
            const layout = route[i].coachPosition ?? route.find(x => x.coachPosition)?.coachPosition;
            const cls = classesFrom(layout);
            if (!halts.length || !cls.length) continue;                        // unreserved
            const codes = halts.map(x => x.station.code);
            const names = Object.fromEntries(halts.map(x => [x.station.code, title(x.station.name ?? x.station.code)]));
            await sql`insert into public.ndls_trains (train_no, train_name, category, origin_code, destination_code, destination,
                        ndls_departure, runs_on, days_codes, stop_codes, classes, stop_names, schedule_at, source)
                      values (${no}, ${tr.name ?? no}, ${i === 0 ? "Originating" : "Passing"}, ${tr.source ?? null},
                        ${tr.destination ?? codes[codes.length - 1]}, ${names[codes[codes.length - 1]] ?? null},
                        ${st.departure}, 'RailRadar', '{}', ${codes}, ${cls}, ${sql.json(names)}, now(), 'railradar')
                      on conflict (train_no) do nothing`;
            known.add(no);
          }
          const exp = lv.expectedDepartureTime ?? null;
          const delay = typeof lv.delayMinutes === "number" ? Math.max(0, lv.delayMinutes) : null;
          const note = lv.type === "at-station" ? "At New Delhi" : lv.type === "not-started" ? "Yet to start" : lv.type === "upcoming" ? "On the way" : null;
          await sql`insert into public.trains (train_no, journey_date, train_name, dep_at, refresh_minutes, status, next_check_at, added_at,
                                               expected_dep_at, delay_min, running_note, running_checked_at, platform)
                    values (${no}, ${jd}, ${tr.name ?? null}, ${depAt}, ${s?.default_refresh_minutes ?? 30}, 'queued', now(), now(),
                            ${exp ?? depAt}, ${delay}, ${note}, now(), ${st.platform ?? null})
                    on conflict (train_no, journey_date) do update set
                      train_name = coalesce(public.trains.train_name, excluded.train_name),
                      dep_at = excluded.dep_at,
                      expected_dep_at = greatest(excluded.dep_at, coalesce(excluded.expected_dep_at, excluded.dep_at)),
                      delay_min = excluded.delay_min, running_note = excluded.running_note,
                      status = case when public.trains.status = 'departed'
                                     and greatest(excluded.dep_at, coalesce(excluded.expected_dep_at, excluded.dep_at)) > now()
                                    then case when public.trains.checked_at is null then 'queued' else 'active' end
                                    else public.trains.status end,
                      running_checked_at = now(), platform = coalesce(excluded.platform, public.trains.platform)`;
          seen.push(`${no}|${jd}`);
        }
        // Trains added from the timetable list that NDLS's live board doesn't show are not running today.
        const gone = seen.length < 3 ? [] : await sql`update public.trains set status = 'removed',
                                 last_error = 'Not on the NDLS live board: not running today'
                               where status in ('queued','active','error')
                                 and dep_at between now() + interval '20 minutes' and now() + interval '3 hours'
                                 and not ((train_no || '|' || journey_date::text) = any(${seen}))
                               returning train_no`;
        log.push(`board ${list.length} trains, ${seen.length} reserved departing${gone.length ? `, not running: ${gone.map(g => g.train_no).join(" ")}` : ""}`);
      } else log.push(`board failed (${status})`);
    }
    if (!boardOk && boardDue) {
      // Fallback so the board still fills if RailRadar is down.
      await sql`select private.autofill_board(${WINDOW_H})`;
    }

    // ---- 3. classes and halts from schedules -----------------------------------------------------
    const needSched = await sql`select distinct n.train_no from public.trains t join public.ndls_trains n using (train_no)
                                where t.status in ('queued','active','error') and n.schedule_at is null
                                  and t.dep_at <= now() + interval '4 hours' order by 1 limit 8`;
    for (const r of needSched) {
      if (!canCall()) break;
      const sc = await rr(`/trains/${r.train_no}`);
      const route: Json[] = sc.body?.data?.route ?? [];
      const i = route.findIndex(x => x.station?.code === "NDLS");
      const layout = (i >= 0 ? route[i].coachPosition : null) ?? route.find(x => x.coachPosition)?.coachPosition;
      const cls = classesFrom(layout);
      const names = Object.fromEntries(route.slice(Math.max(0, i + 1)).filter(x => x.station?.code)
        .map(x => [x.station.code, title(x.station.name ?? x.station.code)]));
      await sql`update public.ndls_trains set classes = ${cls.length ? cls : null}, stop_names = ${sql.json(names)}, schedule_at = now()
                where train_no = ${r.train_no}`;
    }

    // ---- 4. seats --------------------------------------------------------------------------------
    const due = await sql`select t.id, t.train_no, t.journey_date::text jd, n.stop_codes, n.classes, n.stop_names
                          from public.trains t join public.ndls_trains n using (train_no)
                          where t.status in ('queued','active','error')
                            and t.next_check_at <= now() + interval '2 minutes'
                            and coalesce(t.expected_dep_at, t.dep_at) > now() + interval '15 minutes'
                            and t.dep_at <= now() + interval '4 hours'
                          order by (t.checked_at is null) desc, coalesce(t.expected_dep_at, t.dep_at)
                          limit 12`;
    let checked = 0;
    for (const t of due) {
      const cls: string[] = t.classes?.length ? t.classes : ["SL", "3A", "2A", "CC"];
      if (!canCall() || runBudget < Math.min(cls.length, 3)) break;
      const [{ claimed }] = await sql`select private.claim_train(${t.id}) as claimed`;
      if (!claimed) continue;
      const codes: string[] = t.stop_codes ?? [];
      if (!codes.length) continue;
      const final = codes[codes.length - 1];
      const extra = [codes[0], codes[Math.floor((codes.length - 1) / 2)]].filter((c, i, a) => c !== final && a.indexOf(c) === i);
      const plan: [string, string][] = [];
      cls.forEach(c => plan.push([final, c]));
      extra.forEach(d => cls.forEach(c => plan.push([d, c])));
      const cap = Math.min(plan.length, Math.max(cls.length, 12));
      const seats: Record<string, Record<string, number>> = {};
      let chart: boolean | null = null, failed = 0, missing = 0, asked = 0;
      for (const [dest, c] of plan.slice(0, cap)) {
        if (!canCall()) break;
        // Skip intermediate halts for a class that already has seats to the final destination.
        if (dest !== final && (seats[final]?.[c] ?? 0) > 0) continue;
        const { status, body } = await rr(`/trains/${t.train_no}/seats?from=NDLS&to=${dest}&date=${t.jd}&class=${c}&quota=GN`);
        asked++;
        if (status === 404) { missing++; if (missing >= 2 && !Object.keys(seats).length) break; continue; }
        if (status !== 200) { failed++; continue; }
        const day = (body?.data?.calendar ?? []).find((x: Json) => x.date === t.jd || x.rawDate === t.jd);
        const st = String(day?.status ?? "").toUpperCase();
        let n = 0;
        if (st.startsWith("CURR_AVBL")) { n = Number(st.split("-")[1]) || Number(day?.availableSeats) || 0; chart = true; }
        else if (/^(AVAILABLE|RAC|GNWL|RLWL|PQWL|RSWL|TQWL|WL)/.test(st)) { if (chart === null) chart = false; }
        else if (st) chart = chart ?? true;                                     // REGRET / NOT AVAILABLE / CHART PREPARED
        else continue;                                                        // journey date not in the reply
        if (chart === false) break;                                           // chart not prepared yet
        (seats[dest] ??= {})[c] = n;
      }
      const names: Json = t.stop_names ?? {};
      if (chart === false) {
        await sql`update public.trains set chart_ready = false, stops = '[]'::jsonb, checked_at = now(), status = 'active',
                    last_error = null, next_check_at = now() + interval '20 minutes' where id = ${t.id}`;
      } else if (Object.keys(seats).length) {
        const stops = codes.filter(c => seats[c]).map(c => ({ code: c, name: names[c] ?? c, seats: seats[c] }));
        await sql`update public.trains set stops = ${sql.json(stops)}, chart_ready = true, checked_at = now(), status = 'active',
                    last_error = null where id = ${t.id}`;
      } else if (missing && missing === asked) {
        // PRS has no seat data for this train through RailRadar (some specials): stop spending requests on it.
        await sql`update public.trains set status = 'removed', last_error = 'No seat data for this train on RailRadar' where id = ${t.id}`;
      } else {
        await sql`update public.trains set status = 'error', next_check_at = now() + interval '15 minutes',
                    last_error = ${failed ? "RailRadar did not return seats" : "Check interrupted"} where id = ${t.id}`;
      }
      checked++;
      log.push(`${t.train_no}: ${chart === false ? "chart not prepared" : Object.entries(seats).map(([d, v]) => d + " " + Object.entries(v).filter(([, n]) => n > 0).map(([c, n]) => c + n).join(",")).join(" ")}`);
    }
    log.push(`checked ${checked}, calls ${calls}${stopAll ? ", rate-limited" : ""}`);
  } catch (e) {
    log.push(`error: ${String(e).slice(0, 200)}`);
  }
  const note = log.join(" · ").slice(0, 1000);
  await sql`update public.settings set last_sync_note = ${note} where id = 1`;
  await sql.end();
  return Response.json({ ok: true, calls, note });
});
