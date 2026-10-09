// Neapol Lake — API для Netlify (Functions v2 + Netlify Blobs).
// Той самий контракт, що й у Node-версії (server.js): /api/state, /api/login, /api/site, /api/bookings, /api/mono/webhook …
import { getStore } from "@netlify/blobs";
import crypto from "node:crypto";

export const config = { path: "/api/*" };

const ENV = k => process.env[k] || "";
const BASE = () => ENV("BASE_URL") || ENV("URL");       // BASE_URL, або адреса сайту, яку дає Netlify
const HOLD_MS = 20 * 60 * 1000;                          // скільки неоплачена бронь тримає дату
const store = () => getStore({ name: "neapol", consistency: "strong" });
const json = (o, status = 200, h = {}) => new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...h } });

// --- токен адміна без стану (підпис HMAC), бо функції не зберігають пам'ять між викликами
const SECRET = () => ENV("TOKEN_SECRET") || "nl|" + ENV("ADMIN_PASSWORD");
const sign = p => crypto.createHmac("sha256", SECRET()).update(p).digest("base64url");
const mkToken = () => { const p = Buffer.from(JSON.stringify({ exp: Date.now() + 12 * 3600e3 })).toString("base64url"); return p + "." + sign(p); };
const isAdmin = req => {
  const [p, s] = (req.headers.get("authorization") || "").replace("Bearer ", "").split(".");
  if (!p || !s) return false;
  const e = sign(p); if (s.length !== e.length || !crypto.timingSafeEqual(Buffer.from(s), Buffer.from(e))) return false;
  try { return JSON.parse(Buffer.from(p, "base64url").toString()).exp > Date.now(); } catch { return false; }
};

const taken = b => b && (b.paid || Date.now() - b.created < HOLD_MS);
const addDays = (d, n) => { const x = new Date(d + "T00:00:00Z"); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const overlapsWith = (list, sector, date, days, selfId) => { const end = addDays(date, days - 1);
  return list.filter(b => b.id !== selfId && b.sector === sector && taken(b) && b.date <= end && addDays(b.date, (b.days || 1) - 1) >= date); };
const today = () => new Date().toISOString().slice(0, 10);
const getSite = async s => (await s.get("site", { type: "json" })) || { news: [], photos: [], comps: [] };
const compOn = (site, d) => (site.comps || []).find(c => d >= c.from && d <= c.to);
const payAmt = (site, pct) => { // 50% або 100% від першого рядка «Ціни на сезон» (доба на секторі)
  const r = site.prices && site.prices.season && site.prices.season[0];
  return Math.round((r ? parseInt(String(r.p).replace(/\s/g, "")) || 1200 : 1200) * pct / 100);
};
async function mono(p, opt = {}) {
  const r = await fetch((ENV("MONO_API") || "https://api.monobank.ua") + p, { ...opt, headers: { "X-Token": ENV("MONO_TOKEN"), "Content-Type": "application/json" } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(JSON.stringify(j));
  return j;
}
async function allBookings(s) {
  const { blobs } = await s.list({ prefix: "b/" });
  const rows = await Promise.all(blobs.map(async b => ({ key: b.key, v: await s.get(b.key, { type: "json" }) })));
  const out = [];
  for (const { key, v } of rows) {
    if (!v) continue;
    if (!v.paid && Date.now() - v.created > HOLD_MS + 60000) { await s.delete(key); continue; } // прибрати прострочені
    out.push(v);
  }
  return out;
}

export default async (req) => {
  const url = new URL(req.url), p = url.pathname.replace(/^\/api/, ""), m = req.method;
  const s = store();
  try {
    if (m === "GET" && p === "/health") {
      let storage = true; try { await s.get("site"); } catch { storage = false; }
      return json({ ok: true, payment: !!ENV("MONO_TOKEN"), adminPassword: !!ENV("ADMIN_PASSWORD"), baseUrl: BASE() || null, storage });
    }
    if (m === "GET" && p === "/state") {
      const adm = isAdmin(req), site = await getSite(s), list = (await allBookings(s)).filter(b => adm || taken(b));
      return json({ site, admin: adm, payment: !!ENV("MONO_TOKEN"), bookings: list.map(b => adm ? b : { sector: b.sector, date: b.date, days: b.days || 1, paid: true }) });
    }
    if (m === "POST" && p === "/login") {
      const b = await req.json().catch(() => ({}));
      if (ENV("ADMIN_PASSWORD") && b.password === ENV("ADMIN_PASSWORD")) return json({ token: mkToken() });
      await new Promise(r => setTimeout(r, 600));
      return json({ error: "Невірний пароль" }, 401);
    }
    let mm;
    if (m === "GET" && (mm = p.match(/^\/photo\/(\d+)$/))) {
      const buf = await s.get("photo/" + mm[1], { type: "arrayBuffer" });
      if (!buf) return new Response("Not found", { status: 404 });
      return new Response(buf, { headers: { "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=86400" } });
    }
    if (m === "POST" && p === "/site") {
      if (!isAdmin(req)) return json({ error: "Потрібен вхід адміна" }, 401);
      const body = await req.json(), old = await getSite(s);
      const site = { news: body.news || [], comps: body.comps || [], photos: [] };
      if (body.prices) site.prices = body.prices;
      for (const ph of body.photos || []) {
        let src = String(ph.src || "");
        if (/^data:image\/(jpeg|png|webp);base64,/.test(src)) {
          const id = String(ph.id).replace(/\D/g, "") || String(Date.now());
          await s.set("photo/" + id, Buffer.from(src.split(",")[1], "base64"));
          src = "/api/photo/" + id;
        } else if (!/^\/api\/photo\/\d+$/.test(src)) continue;
        site.photos.push({ id: ph.id, src });
      }
      const keep = new Set(site.photos.map(x => x.src));
      for (const o of old.photos || []) if (!keep.has(o.src)) { const k = String(o.src).match(/^\/api\/photo\/(\d+)$/); if (k) await s.delete("photo/" + k[1]); }
      await s.setJSON("site", site);
      return json({ site });
    }
    if (m === "POST" && p === "/bookings") {
      const b = await req.json().catch(() => ({})), site = await getSite(s);
      const sector = +b.sector, date = String(b.date || "");
      const name = String(b.name || "").trim().slice(0, 80), phone = String(b.phone || "").trim().slice(0, 30);
      const adm = isAdmin(req) && !!b.admin, pct = +b.pct === 100 ? 100 : 50;
      if (!(sector >= 1 && sector <= 15) || !/^\d{4}-\d{2}-\d{2}$/.test(date) || date < today()) return json({ error: "Невірні дані бронювання" }, 400);
      const days = Math.min(5, Math.max(1, parseInt(b.days) || 1));
      for (let i = 0; i < days; i++) if (compOn(site, addDays(date, i))) return json({ error: "У ці дати проходять змагання" }, 400);
      if (!adm && (!name || !phone)) return json({ error: "Заповніть ім'я та телефон" }, 400);
      const id = sector + "_" + date, key = "b/" + id, ex = await s.get(key, { type: "json" });
      if (taken(ex) || overlapsWith(await allBookings(s), sector, date, days, id).length) return json({ error: "Цей сектор на ці дати вже заброньовано" }, 409);
      if (ex) await s.delete(key);
      const bk = { id, sector, date, name: name || "Адмін", phone: phone || "—", days, amount: adm ? 0 : payAmt(site, pct) * days, paid: adm, created: Date.now() };
      const w = await s.setJSON(key, bk, { onlyIfNew: true });          // захист від одночасної подвійної броні
      if (w && w.modified === false) return json({ error: "Цей сектор на цю дату вже заброньовано" }, 409);
      // повторна перевірка після запису: при одночасних заявках лишається та, що створена раніше
      const rival = overlapsWith(await allBookings(s), sector, date, days, id).find(x => x.created < bk.created || (x.created === bk.created && x.id < id));
      if (rival) { await s.delete(key); return json({ error: "Цей сектор на ці дати вже заброньовано" }, 409); }
      if (!adm && ENV("MONO_TOKEN")) {
        try {
          const inv = await mono("/api/merchant/invoice/create", { method: "POST", body: JSON.stringify({
            amount: bk.amount * 100, ccy: 980, validity: HOLD_MS / 1000,
            merchantPaymInfo: { reference: id, destination: `Оплата ${pct}% — сектор ${sector}, ${date}, ${days} діб` },
            redirectUrl: BASE() + "/?paid=1", webHookUrl: BASE() + "/api/mono/webhook" }) });
          bk.invoiceId = inv.invoiceId; await s.setJSON(key, bk);
          return json({ ok: true, pageUrl: inv.pageUrl });
        } catch (e) {
          console.error("Monobank:", e.message); await s.delete(key);
          return json({ error: "Не вдалося створити рахунок на оплату. Спробуйте пізніше або зв'яжіться з нами." }, 502);
        }
      }
      return json({ ok: true });
    }
    if (m === "POST" && p === "/mono/webhook") {
      const b = await req.json().catch(() => ({}));
      const bk = (await allBookings(s)).find(x => x.invoiceId && x.invoiceId === b.invoiceId);
      if (bk && ENV("MONO_TOKEN")) {
        try { // не довіряємо тілу вебхука — перепитуємо статус у Monobank
          const st = await mono("/api/merchant/invoice/status?invoiceId=" + encodeURIComponent(b.invoiceId));
          if (st.status === "success") { bk.paid = true; await s.setJSON("b/" + bk.id, bk); }
          else if (["failure", "expired", "reversed"].includes(st.status) && !bk.paid) await s.delete("b/" + bk.id);
        } catch (e) { console.error("Webhook:", e.message); }
      }
      return json({ ok: true });
    }
    if ((mm = p.match(/^\/bookings\/(\d+_\d{4}-\d{2}-\d{2})(\/paid)?$/))) {
      if (!isAdmin(req)) return json({ error: "Потрібен вхід адміна" }, 401);
      const key = "b/" + mm[1];
      if (m === "DELETE") { await s.delete(key); return json({ ok: true }); }
      if (m === "PATCH" && mm[2]) { const v = await s.get(key, { type: "json" }); if (v) { v.paid = true; await s.setJSON(key, v); } return json({ ok: true }); }
    }
    return json({ error: "Не знайдено" }, 404);
  } catch (e) { console.error(e); return json({ error: "Помилка сервера" }, 500); }
};
