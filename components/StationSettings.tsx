"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { INTERVALS, intervalLabel } from "@/lib/intervals";

type Station = {
  code: string; name_en: string; name_hi: string | null; zone_division: string; local_codes: string[]; active: boolean;
  sync_minutes: number; default_refresh_minutes: number; seat_daily_budget: number; irctc_credits_left: number;
  board_source: string | null; last_sync_at: string | null; last_sync_note: string | null;
};
type Keys = { railradar: string | null; irctcdev: string | null; railkit: string | null; updated_at: string | null };
type Usage = { provider: string; calls: number; month_remaining: number | null };
type TrainRow = { train_no: string; train_name: string | null; dep_at: string; expected_dep_at: string | null; status: string;
                  chart_ready: boolean | null; checked_at: string | null; stops: { code: string; seats: Record<string, number> | null }[]; last_error: string | null };
type Admin = { user_id: string; profiles: { full_name: string; email: string } | null };
type Msg = { kind: "ok" | "err"; text: string } | null;

const IST = "Asia/Kolkata";
const SYNC_OPTIONS = [5, 10, 15, 20, 30, 60];
const hhmm = (s: string | null) => s ? new Intl.DateTimeFormat("en-IN", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: IST }).format(new Date(s)) : "–";
const label = (m: number) => (m < 60 ? `${m} min` : "1 hr");
const KEY_INFO: { id: keyof Omit<Keys, "updated_at">; name: string; use: string }[] = [
  { id: "railradar", name: "RailRadar", use: "Required. Each new train's halts, and backup for the board and seats." },
  { id: "railkit", name: "RailKit", use: "Recommended. NTES live board: train list, delays, platforms." },
  { id: "irctcdev", name: "irctc.dev", use: "Recommended. PRS seat availability. Without it, RailRadar is used for seats." },
];

function Note({ m }: { m: Msg }) {
  return m ? <div className={`msg ${m.kind}`} role={m.kind === "err" ? "alert" : "status"}>{m.text}</div> : null;
}

export default function StationSettings({ code, isAdmin }: { code: string; isAdmin: boolean }) {
  const [s, setS] = useState<Station | null>(null);
  const [form, setForm] = useState<Station | null>(null);
  const [localText, setLocalText] = useState("");
  const [keys, setKeys] = useState<Keys | null>(null);
  const [newKeys, setNewKeys] = useState({ railradar: "", railkit: "", irctcdev: "" });
  const [usage, setUsage] = useState<Usage[]>([]);
  const [trains, setTrains] = useState<TrainRow[]>([]);
  const [admins, setAdmins] = useState<Admin[]>([]);
  const [adminEmail, setAdminEmail] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [msgKeys, setMsgKeys] = useState<Msg>(null);
  const [msgSet, setMsgSet] = useState<Msg>(null);
  const [msgAdm, setMsgAdm] = useState<Msg>(null);

  const load = useCallback(async (resetForm = false) => {
    const sb = createClient();
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: IST }).format(new Date());
    const [{ data: st }, { data: k }, { data: u }, { data: tr }, { data: ad }] = await Promise.all([
      sb.from("stations").select("*").eq("code", code).maybeSingle(),
      sb.rpc("station_key_status", { p_station: code }),
      sb.from("st_api_usage").select("provider,calls,month_remaining").eq("station", code).eq("day", today),
      sb.from("st_trains").select("train_no,train_name,dep_at,expected_dep_at,status,chart_ready,checked_at,stops,last_error")
        .eq("station", code).gt("dep_at", new Date(Date.now() - 3600e3).toISOString()).order("dep_at").limit(40),
      sb.from("station_admins").select("user_id, profiles(full_name,email)").eq("station", code),
    ]);
    const station = st as Station | null;
    setS(station);
    if (resetForm && station) { setForm(station); setLocalText(station.local_codes.filter(c => c !== code).join(", ")); }
    setKeys(((k as Keys[] | null) ?? [])[0] ?? { railradar: null, irctcdev: null, railkit: null, updated_at: null });
    setUsage((u ?? []) as Usage[]);
    setTrains((tr ?? []) as unknown as TrainRow[]);
    setAdmins((ad ?? []) as unknown as Admin[]);
  }, [code]);

  useEffect(() => { load(true); const t = setInterval(() => load(false), 60000); return () => clearInterval(t); }, [load]);

  async function saveKeys(e: React.FormEvent, clear?: keyof typeof newKeys) {
    e.preventDefault();
    const v = clear ? { railradar: "", railkit: "", irctcdev: "", [clear]: "-" } : newKeys;
    if (!clear && !v.railradar.trim() && !v.railkit.trim() && !v.irctcdev.trim()) { setMsgKeys({ kind: "err", text: "Paste at least one key to save." }); return; }
    setBusy("keys"); setMsgKeys(null);
    const { error } = await createClient().rpc("set_station_keys", { p_station: code, p_railradar: v.railradar, p_irctcdev: v.irctcdev, p_railkit: v.railkit });
    setBusy(null);
    if (error) { setMsgKeys({ kind: "err", text: error.message }); return; }
    setNewKeys({ railradar: "", railkit: "", irctcdev: "" });
    setMsgKeys({ kind: "ok", text: clear ? "Key removed." : "Keys saved. The board starts updating within a few minutes." });
    load(false);
  }

  async function saveSettings(e: React.FormEvent) {
    e.preventDefault();
    if (!form) return;
    const local = Array.from(new Set(localText.toUpperCase().split(/[^A-Z]+/).filter(c => /^[A-Z]{2,5}$/.test(c)).concat(code)));
    if (!form.name_en.trim()) { setMsgSet({ kind: "err", text: "Enter the station name in English." }); return; }
    setBusy("set"); setMsgSet(null);
    const { error } = await createClient().from("stations").update({
      name_en: form.name_en.trim(), name_hi: form.name_hi?.trim() || null, zone_division: form.zone_division.trim() || "Northern Railway",
      local_codes: local, active: form.active, sync_minutes: form.sync_minutes, default_refresh_minutes: form.default_refresh_minutes,
      seat_daily_budget: Math.max(0, Math.round(form.seat_daily_budget)), irctc_credits_left: Math.max(0, Math.round(form.irctc_credits_left)),
    }).eq("code", code);
    setBusy(null);
    if (error) { setMsgSet({ kind: "err", text: error.message }); return; }
    setMsgSet({ kind: "ok", text: "Settings saved." });
    load(true);
  }

  async function addAdmin(e: React.FormEvent) {
    e.preventDefault();
    setBusy("adm"); setMsgAdm(null);
    const { error } = await createClient().rpc("add_station_admin", { p_station: code, p_email: adminEmail });
    setBusy(null);
    if (error) { setMsgAdm({ kind: "err", text: error.message }); return; }
    setAdminEmail(""); setMsgAdm({ kind: "ok", text: "Added. They can now open this page and manage the station." });
    load(false);
  }
  async function removeAdmin(id: string) {
    setBusy("adm"); setMsgAdm(null);
    const { error } = await createClient().from("station_admins").delete().eq("station", code).eq("user_id", id);
    setBusy(null);
    if (error) { setMsgAdm({ kind: "err", text: error.message }); return; }
    load(false);
  }

  if (!s || !form || !keys) return <section className="panel"><div className="empty">Loading {code}…</div></section>;

  const useOf = (p: string) => usage.find(x => x.provider === p);
  const anyKey = !!(keys.railradar || keys.railkit || keys.irctcdev);
  const stale = !s.last_sync_at || Date.now() - new Date(s.last_sync_at).getTime() > (s.sync_minutes * 2 + 10) * 60000;
  const set = (patch: Partial<Station>) => setForm(f => (f ? { ...f, ...patch } : f));
  const seatSummary = (t: TrainRow) => {
    if (t.chart_ready === false) return "Chart not prepared";
    const parts = (t.stops ?? []).map(st => `${st.code} ${Object.entries(st.seats ?? {}).filter(([, n]) => n > 0).map(([c, n]) => `${c} ${n}`).join(", ")}`).filter(x => /\d/.test(x));
    return parts.length ? parts.join(" · ") : t.checked_at ? "No seats" : "Waiting for first check";
  };

  return (
    <>
      <section className="panel" aria-labelledby="st-h">
        <div>
          <h2 id="st-h">Board status</h2>
          <p className="lede">
            Public board: <Link href={`/${code}`} target="_blank" rel="noopener"><b>/{code}</b></Link>. Trains departing in the next 4 hours
            are added automatically from the {code} live board, and seats are checked from {code} once each train&apos;s chart is prepared.
          </p>
        </div>
        {!anyKey ? (
          <div className="msg err" role="status">No API keys yet. Enter this station&apos;s keys below to start the board.</div>
        ) : !s.active ? (
          <div className="msg err" role="status">Paused. Turn on &ldquo;Board running&rdquo; below to resume updates.</div>
        ) : null}
        <div className="row" style={{ gap: 24, flexWrap: "wrap" }}>
          <span>Last update <b className="num">{hhmm(s.last_sync_at)}</b>{anyKey && s.active && stale && <span className="pill error" style={{ marginLeft: 8 }}>Delayed</span>}</span>
          <span>Running times from <b>{s.board_source === "ntes" ? "NTES (RailKit)" : s.board_source === "railradar" ? "RailRadar" : "–"}</b></span>
          <span>Seat checks today <b className="num">{(useOf("seat_checks")?.calls ?? 0).toLocaleString("en-IN")}</b> of {s.seat_daily_budget.toLocaleString("en-IN")}</span>
          <span>irctc.dev credits left <b className="num">{keys.irctcdev ? s.irctc_credits_left.toLocaleString("en-IN") : "–"}</b></span>
          <span>RailKit today <b className="num">{useOf("railkit")?.calls ?? 0}</b></span>
          <span>RailRadar today <b className="num">{useOf("railradar")?.calls ?? 0}</b>{useOf("railradar")?.month_remaining != null ? ` · ${useOf("railradar")!.month_remaining!.toLocaleString("en-IN")} left this month` : ""}</span>
        </div>
        {s.last_sync_note && <p className="lede" style={{ fontSize: ".8rem", wordBreak: "break-word" }}>{s.last_sync_note}</p>}
      </section>

      <section className="panel" aria-labelledby="k-h">
        <div>
          <h2 id="k-h">API keys</h2>
          <p className="lede">{code}&apos;s own keys, paid for by the station. They are used only for this station&apos;s board and can&apos;t be read back from this page; only the last 4 characters are shown.</p>
        </div>
        <form onSubmit={e => saveKeys(e)} style={{ display: "grid", gap: 14 }}>
          {KEY_INFO.map(k => (
            <div key={k.id} className="row">
              <label htmlFor={`k-${k.id}`}>
                <span>{k.name} {keys[k.id] ? <span className="pill approved">set {keys[k.id]}</span> : <span className="pill pending">not set</span>}</span>
                <span className="hint">{k.use}</span>
                <input id={`k-${k.id}`} type="password" autoComplete="off" spellCheck={false} placeholder={keys[k.id] ? "Paste a new key to replace" : "Paste key"}
                  value={newKeys[k.id]} onChange={e => setNewKeys(v => ({ ...v, [k.id]: e.target.value }))} />
              </label>
              {keys[k.id] && <button type="button" className="btn no sm" disabled={busy === "keys"} onClick={e => saveKeys(e, k.id)}>Remove</button>}
            </div>
          ))}
          <div><button className="btn" type="submit" disabled={busy === "keys"}>{busy === "keys" ? "Saving…" : "Save keys"}</button></div>
        </form>
        <Note m={msgKeys} />
      </section>

      <section className="panel" aria-labelledby="set-h">
        <div>
          <h2 id="set-h">Station settings</h2>
        </div>
        <form onSubmit={saveSettings} style={{ display: "grid", gap: 14 }}>
          <div className="row">
            <label htmlFor="en">Name (English)<input id="en" value={form.name_en} onChange={e => set({ name_en: e.target.value })} /></label>
            <label htmlFor="hi">Name (Hindi)<input id="hi" lang="hi" value={form.name_hi ?? ""} onChange={e => set({ name_hi: e.target.value })} /></label>
            <label htmlFor="zd">Zone · Division (board heading)<input id="zd" value={form.zone_division} onChange={e => set({ zone_division: e.target.value })} /></label>
          </div>
          <label htmlFor="lc">
            Nearby stations to hide
            <span className="hint">Seats to these stations are never checked or shown (short trips that don&apos;t need current booking). Station codes separated by commas.</span>
            <input id="lc" value={localText} onChange={e => setLocalText(e.target.value.toUpperCase())} placeholder="NZM, GZB, SBB" />
          </label>
          <div className="row">
            <label htmlFor="sm">Read the live board every
              <select id="sm" value={form.sync_minutes} onChange={e => set({ sync_minutes: Number(e.target.value) })}>
                {SYNC_OPTIONS.map(m => <option key={m} value={m}>{label(m)}</option>)}
              </select>
            </label>
            <label htmlFor="rf">Recheck each train at most every
              <select id="rf" value={form.default_refresh_minutes} onChange={e => set({ default_refresh_minutes: Number(e.target.value) })}>
                {INTERVALS.map(m => <option key={m} value={m}>{intervalLabel(m)}</option>)}
              </select>
            </label>
            <label htmlFor="sb">Seat checks per day
              <span className="hint">Keeps this station within its plan.</span>
              <input id="sb" type="number" min={0} max={20000} inputMode="numeric" value={form.seat_daily_budget} onChange={e => set({ seat_daily_budget: Number(e.target.value) })} />
            </label>
            <label htmlFor="ic">irctc.dev credits left
              <span className="hint">From the irctc.dev account; counts down as checks run.</span>
              <input id="ic" type="number" min={0} inputMode="numeric" value={form.irctc_credits_left} onChange={e => set({ irctc_credits_left: Number(e.target.value) })} />
            </label>
          </div>
          <label htmlFor="ac" style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <input id="ac" type="checkbox" style={{ width: "auto" }} checked={form.active} onChange={e => set({ active: e.target.checked })} />
            Board running (untick to pause all API use for {code})
          </label>
          <div><button className="btn" type="submit" disabled={busy === "set"}>{busy === "set" ? "Saving…" : "Save settings"}</button></div>
        </form>
        <Note m={msgSet} />
      </section>

      <section className="panel" aria-labelledby="tr-h">
        <div>
          <h2 id="tr-h">Trains in the next 4 hours</h2>
          <p className="lede">Added automatically. The public board shows only trains with current-booking seats.</p>
        </div>
        {trains.length === 0 ? <div className="empty">{anyKey ? "No trains yet. They appear after the next board update." : "Trains appear once API keys are saved."}</div> : (
          <div className="tablewrap">
            <table>
              <thead><tr><th>Train</th><th>Dep {code}</th><th>Status</th><th>Seats</th><th>Last check</th></tr></thead>
              <tbody>
                {trains.map(t => (
                  <tr key={`${t.train_no}-${t.dep_at}`}>
                    <td><span className="num"><b>{t.train_no}</b></span> {t.train_name}</td>
                    <td className="num">{hhmm(t.dep_at)}{t.expected_dep_at && t.expected_dep_at !== t.dep_at ? ` → ${hhmm(t.expected_dep_at)}` : ""}</td>
                    <td><span className={`pill ${t.status === "active" ? "approved" : t.status === "error" ? "error" : t.status === "queued" ? "pending" : "disabled"}`}>{t.status}</span>
                      {t.last_error && <div className="hint" style={{ fontSize: ".75rem", color: "var(--muted)" }}>{t.last_error}</div>}</td>
                    <td style={{ fontSize: ".85rem" }}>{seatSummary(t)}</td>
                    <td className="num">{hhmm(t.checked_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {isAdmin && (
        <section className="panel" aria-labelledby="ad-h">
          <div>
            <h2 id="ad-h">Station admins</h2>
            <p className="lede">People who can manage {code}&apos;s keys and settings. They register at the staff portal like everyone else; once you approve them, add them here.</p>
          </div>
          {admins.length > 0 && (
            <ul style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 6 }}>
              {admins.map(a => (
                <li key={a.user_id}>{a.profiles?.full_name ?? "–"} · {a.profiles?.email ?? ""}{" "}
                  <button type="button" className="btn no sm" disabled={busy === "adm"} onClick={() => removeAdmin(a.user_id)}>Remove</button></li>
              ))}
            </ul>
          )}
          <form onSubmit={addAdmin} className="row">
            <label htmlFor="ae">Email of an approved staff member<input id="ae" type="email" value={adminEmail} onChange={e => setAdminEmail(e.target.value)} required /></label>
            <button className="btn" type="submit" disabled={busy === "adm"}>Add admin</button>
          </form>
          <Note m={msgAdm} />
        </section>
      )}
    </>
  );
}
