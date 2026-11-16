// /api/health: Apple Health (via an iPhone Shortcut) and Whoop, saved per account in Netlify Blobs.
// GET  /api/health?action=pull&since=YYYY-MM-DD   (signed in)  -> { days, whoop, shortcut }
// GET  /api/health?action=key                      (signed in)  -> { key }  personal key for the Shortcut
// POST /api/health/in?key=...                      (Shortcut)   body { date, steps, sleep, workout_min, workout_cal, workout_name }
// GET  /api/health?action=whoop_start              (signed in)  -> { url }
// GET  /api/health/whoop-callback?code&state       (Whoop redirect)
// POST /api/health?action=whoop_off                (signed in)
import { getStore } from "@netlify/blobs";
import { makeAuth } from "../sync-core.mjs";

const WHOOP = { auth: "https://api.prod.whoop.com/oauth/oauth2/auth", token: "https://api.prod.whoop.com/oauth/oauth2/token", api: "https://api.prod.whoop.com/developer" };
const SCOPES = "offline read:recovery read:cycles read:sleep read:workout read:profile";
const num = v => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const isDay = d => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ""));
const localDay = (ts, off) => { const m = /^([+-])(\d{2}):?(\d{2})$/.exec(off || "") ; const mins = m ? (m[1] === "-" ? -1 : 1) * (+m[2] * 60 + +m[3]) : 0; return new Date(Date.parse(ts) + mins * 6e4).toISOString().slice(0, 10); };

let A = null, store = null;
const init = () => { if (!A) { A = makeAuth({ users: getStore({ name: "tirofit-users", consistency: "strong" }), envSecret: process.env.AUTH_SECRET || null }); store = getStore({ name: "tirofit-health", consistency: "strong" }); } };
const getRec = async uid => (await store.get("h:" + uid, { type: "json" })) || { days: {} };
const putRec = (uid, r) => store.setJSON("h:" + uid, r);
const mergeDay = (rec, d, patch) => { rec.days[d] = { ...(rec.days[d] || {}), ...patch }; };
const redirectUri = req => new URL("/api/health/whoop-callback", req.url).toString();

async function whoopToken(rec) {
  const w = rec.whoop; if (!w) return null;
  if (w.exp > Date.now() + 60e3) return w.access;
  const r = await fetch(WHOOP.token, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: w.refresh, client_id: process.env.WHOOP_CLIENT_ID, client_secret: process.env.WHOOP_CLIENT_SECRET, scope: "offline" }) });
  if (!r.ok) { rec.whoop.err = "expired"; return null; }
  const t = await r.json(); Object.assign(rec.whoop, { access: t.access_token, refresh: t.refresh_token || w.refresh, exp: Date.now() + (t.expires_in || 3600) * 1000, err: null });
  return t.access_token;
}
async function whoopList(tok, path, startIso) {
  const out = []; let next = null;
  for (let i = 0; i < 8; i++) {
    const u = new URL(WHOOP.api + path); u.searchParams.set("limit", "25"); u.searchParams.set("start", startIso); if (next) u.searchParams.set("nextToken", next);
    let r = await fetch(u, { headers: { authorization: "Bearer " + tok } });
    if (r.status === 404 && path.startsWith("/v2")) { r = await fetch(u.toString().replace("/developer/v2/", "/developer/v1/"), { headers: { authorization: "Bearer " + tok } }); }
    if (!r.ok) break;
    const j = await r.json(); out.push(...(j.records || [])); next = j.next_token || j.nextToken; if (!next) break;
  }
  return out;
}
async function pullWhoop(rec, since) {
  const tok = await whoopToken(rec); if (!tok) return;
  const start = new Date(Date.parse(since + "T00:00:00Z") - 864e5).toISOString();
  const [cyc, recs, sleeps, wos] = await Promise.all([whoopList(tok, "/v2/cycle", start), whoopList(tok, "/v2/recovery", start), whoopList(tok, "/v2/activity/sleep", start), whoopList(tok, "/v2/activity/workout", start)]);
  const cycDay = {};
  cyc.forEach(c => { const d = localDay(c.start, c.timezone_offset); cycDay[c.id] = d; if (c.score?.strain != null) mergeDay(rec, d, { strain: Math.round(c.score.strain * 10) / 10 }); });
  recs.forEach(r => { const d = cycDay[r.cycle_id] || (r.created_at && localDay(r.created_at)); const s = r.score; if (!d || !s || r.score_state === "UNSCORABLE") return; mergeDay(rec, d, { recovery: Math.round(s.recovery_score), hrv: s.hrv_rmssd_milli != null ? Math.round(s.hrv_rmssd_milli) : undefined, rhr: s.resting_heart_rate != null ? Math.round(s.resting_heart_rate) : undefined, src: "whoop" }); });
  sleeps.forEach(s => { if (s.nap) return; const st = s.score?.stage_summary; if (!st) return; const h = ((st.total_in_bed_time_milli || 0) - (st.total_awake_time_milli || 0)) / 3.6e6; if (h > 0.5) mergeDay(rec, localDay(s.end, s.timezone_offset), { sleep: Math.round(h * 4) / 4 }); });
  const byDay = {};
  wos.forEach(w => { const d = localDay(w.start, w.timezone_offset), min = Math.round((Date.parse(w.end) - Date.parse(w.start)) / 6e4), kcal = w.score?.kilojoule != null ? w.score.kilojoule / 4.184 : null; if (min < 3) return; (byDay[d] = byDay[d] || []).push({ id: String(w.id), name: String(w.sport_name || "Workout").replace(/[-_]/g, " ").replace(/^./, c => c.toUpperCase()), min, cal: kcal == null ? null : Math.max(0, Math.round((kcal - min * 1.2) / 5) * 5), strain: w.score?.strain ?? null }); });
  Object.entries(byDay).forEach(([d, l]) => mergeDay(rec, d, { whoopWorkouts: l }));
  rec.whoop.last = Date.now();
}

export default async req => {
  init();
  const url = new URL(req.url), action = url.searchParams.get("action"), path = url.pathname;
  try {
    // Apple Health Shortcut posts here with its personal key
    if (path.endsWith("/in")) {
      if (req.method !== "POST") return A.json({ error: "method" }, 405);
      const key = url.searchParams.get("key") || req.headers.get("x-health-key") || "";
      const uid = key && /^[a-f0-9]{40}$/.test(key) ? await store.get("k:" + key) : null; if (!uid) return A.json({ error: "bad_key", message: "That Shortcut key isn't valid. Get a new one in the app under You." }, 401);
      const raw = await req.text(); if (raw.length > 20000) return A.json({ error: "too_large" }, 413);
      let b = {}; try { b = JSON.parse(raw || "{}"); } catch { return A.json({ error: "bad_json" }, 400); }
      const rec = await getRec(uid), d = isDay(b.date) ? b.date : new Date(Date.now() - (num(rec.tz) || 0) * 6e4).toISOString().slice(0, 10), p = { hk: Date.now() };
      const steps = num(b.steps), sleep = num(b.sleep ?? b.sleep_hours), wm = num(b.workout_min), wc = num(b.workout_cal);
      if (steps != null && steps >= 0 && steps < 200000) p.steps = Math.round(steps);
      if (sleep != null && sleep > 0 && sleep < 20) p.sleep = Math.round(sleep * 4) / 4;
      if (wm != null && wm > 0 && wm < 1000) p.hkWorkout = { name: String(b.workout_name || "Workout").slice(0, 40), min: Math.round(wm), cal: wc != null && wc >= 0 ? Math.round(wc) : null };
      mergeDay(rec, d, p); rec.shortcutLast = Date.now(); await putRec(uid, rec);
      return A.json({ ok: true, date: d, saved: Object.keys(p).filter(k => k !== "hk") });
    }
    // Whoop sends people back here after they approve
    if (path.endsWith("/whoop-callback")) {
      const code = url.searchParams.get("code"), state = url.searchParams.get("state") || "", [p, sig] = state.split(".");
      const back = m => Response.redirect(new URL("/?whoop=" + m, req.url).toString(), 302);
      if (!code || !p || !sig || !A.same(sig, await A.sign("whoop:" + p))) return back("failed");
      let st; try { st = JSON.parse(A.unb64u(p)); } catch { return back("failed"); }
      if (!st.uid || st.exp < Date.now()) return back("failed");
      const r = await fetch(WHOOP.token, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code, client_id: process.env.WHOOP_CLIENT_ID, client_secret: process.env.WHOOP_CLIENT_SECRET, redirect_uri: redirectUri(req) }) });
      if (!r.ok) { console.error("whoop token", r.status, await r.text()); return back("failed"); }
      const t = await r.json(), rec = await getRec(st.uid);
      rec.whoop = { access: t.access_token, refresh: t.refresh_token, exp: Date.now() + (t.expires_in || 3600) * 1000, since: Date.now() };
      await putRec(st.uid, rec); return back("connected");
    }
    const who = await A.readToken(req); if (!who) return A.json({ error: "signed_out", message: "Sign in under You first." }, 401);
    const tz = num(url.searchParams.get("tz")), setTz = rec => { if (tz != null && Math.abs(tz) <= 840) rec.tz = tz; };
    if (action === "key") {
      const rec = await getRec(who.uid); setTz(rec); if (rec.key) await store.delete("k:" + rec.key);
      rec.key = A.rand(20); await store.set("k:" + rec.key, who.uid); await putRec(who.uid, rec);
      return A.json({ key: rec.key, url: new URL("/api/health/in?key=" + rec.key, req.url).toString() });
    }
    if (action === "whoop_start") {
      if (!process.env.WHOOP_CLIENT_ID || !process.env.WHOOP_CLIENT_SECRET) return A.json({ error: "not_set_up", message: "Whoop isn't set up on the server yet." }, 503);
      const p = A.b64u(JSON.stringify({ uid: who.uid, exp: Date.now() + 15 * 6e4, n: A.rand(6) }));
      const u = new URL(WHOOP.auth); Object.entries({ response_type: "code", client_id: process.env.WHOOP_CLIENT_ID, redirect_uri: redirectUri(req), scope: SCOPES, state: p + "." + await A.sign("whoop:" + p) }).forEach(([k, v]) => u.searchParams.set(k, v));
      return A.json({ url: u.toString() });
    }
    if (action === "whoop_off" && req.method === "POST") { const rec = await getRec(who.uid); delete rec.whoop; await putRec(who.uid, rec); return A.json({ ok: true }); }
    if (action === "pull") {
      const since = isDay(url.searchParams.get("since")) ? url.searchParams.get("since") : new Date(Date.now() - 14 * 864e5).toISOString().slice(0, 10);
      const rec = await getRec(who.uid), tz0 = rec.tz; setTz(rec);
      if (rec.whoop || rec.tz !== tz0) { try { await pullWhoop(rec, since); } catch (e) { console.error("whoop pull", e); } await putRec(who.uid, rec); }
      const days = Object.fromEntries(Object.entries(rec.days).filter(([d]) => d >= since));
      return A.json({ days, whoop: rec.whoop ? { connected: true, last: rec.whoop.last || null, err: rec.whoop.err || null } : { connected: false, available: !!process.env.WHOOP_CLIENT_ID }, shortcut: { key: !!rec.key, last: rec.shortcutLast || null } });
    }
    return A.json({ error: "bad_action" }, 400);
  } catch (err) { console.error(err); return A.json({ error: "server", message: "Health sync hit a snag. Try again in a minute." }, 500); }
};
export const config = { path: ["/api/health", "/api/health/*"] };
