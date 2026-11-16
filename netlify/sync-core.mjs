// TiroFit accounts and sync. Each person signs in with a username and password; their whole log
// is saved as one JSON blob. Passwords are stored only as PBKDF2 hashes. No third-party services.
import { webcrypto as wc } from "node:crypto";
const crypto = globalThis.crypto || wc;
const enc = new TextEncoder();
const ITER = 210000, MAX_BODY = 5 * 1024 * 1024, TOKEN_DAYS = 365;
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const hex = b => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, "0")).join("");
const rand = n => hex(crypto.getRandomValues(new Uint8Array(n)));
const b64u = s => Buffer.from(s).toString("base64url");
const unb64u = s => Buffer.from(s, "base64url").toString();
async function pbkdf2(pass, salt, iter) {
  const k = await crypto.subtle.importKey("raw", enc.encode(pass), "PBKDF2", false, ["deriveBits"]);
  return hex(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: enc.encode(salt), iterations: iter }, k, 256));
}
async function hmac(secret, msg) {
  const k = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return Buffer.from(await crypto.subtle.sign("HMAC", k, enc.encode(msg))).toString("base64url");
}
const same = (a, b) => { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; };
const normUser = u => String(u || "").trim().toLowerCase();
const okUser = u => /^[a-z0-9._@+-]{3,60}$/.test(u);

export function makeHandler({ users, data, envSecret }) {
  let secret = envSecret || null;
  const getSecret = async () => { if (secret) return secret; let s = await users.get("__secret"); if (!s) { s = rand(32); await users.set("__secret", s); s = (await users.get("__secret")) || s; } return (secret = s); };
  const makeToken = async (uid, user) => { const p = b64u(JSON.stringify({ uid, user, exp: Date.now() + TOKEN_DAYS * 864e5 })); return p + "." + await hmac(await getSecret(), p); };
  const readToken = async req => {
    const t = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, ""), [p, sig] = t.split(".");
    if (!p || !sig || !same(sig, await hmac(await getSecret(), p))) return null;
    try { const o = JSON.parse(unb64u(p)); return o.exp > Date.now() ? o : null; } catch { return null; }
  };
  return async req => {
    const origin = req.headers.get("origin");
    if (req.method !== "GET" && origin && new URL(origin).host !== new URL(req.url).host) return json({ error: "forbidden" }, 403);
    if (req.method === "POST") {
      const raw = await req.text(); if (raw.length > 10000) return json({ error: "too_large" }, 413);
      let b; try { b = JSON.parse(raw); } catch { return json({ error: "bad_json" }, 400); }
      const user = normUser(b.user), pass = String(b.pass || "");
      if (!okUser(user)) return json({ error: "bad_user", message: "Use 3 to 60 letters, numbers, dots, dashes, @ or +." }, 400);
      if (pass.length < 8 || pass.length > 200) return json({ error: "bad_pass", message: "Use a password of at least 8 characters." }, 400);
      const key = "u:" + user;
      if (b.action === "signup") {
        if (await users.get(key)) return json({ error: "taken", message: "That username is taken. Try signing in instead." }, 409);
        const salt = rand(16), rec = { uid: rand(12), salt, iter: ITER, hash: await pbkdf2(pass, salt, ITER), created: Date.now() };
        await users.setJSON(key, rec);
        return json({ token: await makeToken(rec.uid, user), user });
      }
      if (b.action === "login") {
        const rec = await users.get(key, { type: "json" });
        if (!rec) return json({ error: "bad_login", message: "Wrong username or password." }, 401);
        if (rec.lockUntil && rec.lockUntil > Date.now()) return json({ error: "locked", message: "Too many tries. Wait 15 minutes and try again." }, 429);
        if (!same(await pbkdf2(pass, rec.salt, rec.iter || ITER), rec.hash)) {
          rec.fails = (rec.fails || 0) + 1; if (rec.fails >= 8) { rec.lockUntil = Date.now() + 15 * 6e4; rec.fails = 0; }
          await users.setJSON(key, rec); return json({ error: "bad_login", message: "Wrong username or password." }, 401);
        }
        if (rec.fails || rec.lockUntil) { delete rec.fails; delete rec.lockUntil; await users.setJSON(key, rec); }
        return json({ token: await makeToken(rec.uid, user), user });
      }
      return json({ error: "bad_action" }, 400);
    }
    const who = await readToken(req);
    if (!who) return json({ error: "signed_out", message: "Please sign in again." }, 401);
    if (req.method === "GET") { const cur = await data.get(who.uid, { type: "json" }); return json({ data: cur?.data ?? null, ver: cur?.ver ?? 0, at: cur?.at ?? null, user: who.user }); }
    if (req.method === "PUT") {
      const raw = await req.text(); if (raw.length > MAX_BODY) return json({ error: "too_large" }, 413);
      let b; try { b = JSON.parse(raw); } catch { return json({ error: "bad_json" }, 400); }
      if (!b || typeof b.data !== "object" || !b.data) return json({ error: "no_data" }, 400);
      const cur = await data.get(who.uid, { type: "json" }), ver = cur?.ver ?? 0;
      if ((+b.ver || 0) !== ver) return json({ error: "conflict", data: cur?.data ?? null, ver }, 409);
      const next = { data: b.data, ver: ver + 1, at: Date.now() };
      await data.setJSON(who.uid, next);
      return json({ ver: next.ver, at: next.at });
    }
    return json({ error: "method" }, 405);
  };
}
