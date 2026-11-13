// コマドリの Cloud Functions
// 管理の操作は、管理用の鍵（URL の #admin=…）を確かめてから書く（ルールだけでは鍵を確かめられないため）
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const crypto = require("node:crypto");

initializeApp();
const db = getFirestore();
const REGION = "asia-northeast1";

const sha256 = s => crypto.createHash("sha256").update(String(s)).digest("hex");
const str = (v, max) => typeof v === "string" && v.length <= max;
const RANGE = /^\d{2}:\d{2}-\d{2}:\d{2}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** 管理用の鍵を確かめて、調整のドキュメントを返す */
async function adminPoll(pollId, key) {
  if (!str(pollId, 40) || !/^[a-z0-9]{20}$/.test(pollId) || !str(key, 100) || !key) throw new HttpsError("invalid-argument", "日程調整か鍵がまちがっています");
  const ref = db.doc(`polls/${pollId}`), snap = await ref.get();
  if (!snap.exists) throw new HttpsError("not-found", "日程調整が見つかりません");
  const a = Buffer.from(sha256(key)), b = Buffer.from(String(snap.get("adminKeyHash") || ""));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new HttpsError("permission-denied", "管理用の鍵がちがいます");
  return { ref, poll: snap.data() };
}

/** 場所の空き状況を保存する（avail が null なら消す）。形は logic.js の parseAvailability の結果 */
exports.setPlaces = onCall({ region: REGION }, async req => {
  if (!req.auth) throw new HttpsError("unauthenticated", "ログインしていません");
  const { pollId, key, avail } = req.data || {};
  const { ref, poll } = await adminPoll(pollId, key);
  const doc = ref.collection("places").doc("current");
  if (avail === null) { await doc.delete(); return { ok: true, places: 0, slots: 0 }; }
  const places = Array.isArray(avail?.places) ? avail.places : null, slots = Array.isArray(avail?.slots) ? avail.slots : null;
  if (!places || !slots || places.length > 300 || slots.length > 5000) throw new HttpsError("invalid-argument", "空き状況の形がちがうか、多すぎます（場所300・行5000まで）");
  const ids = new Set();
  const cleanPlaces = places.map(p => {
    if (!str(p?.id, 80) || !p.id || !str(p.name, 80) || !p.name || ids.has(p.id)) throw new HttpsError("invalid-argument", "場所の形がちがいます");
    ids.add(p.id);
    const url = str(p.url, 500) && /^https?:\/\//.test(p.url) ? p.url : "";
    // 人数（適正人数）：1〜999 の整数で min ≦ max のときだけ残す。形がちがえば人数なしにする（場所そのものは残す）
    const n = v => Number.isInteger(v) && v >= 1 && v <= 999;
    const c = p.capacity && typeof p.capacity === "object" ? p.capacity : null;
    const capacity = c && (c.min === undefined || n(c.min)) && (c.max === undefined || n(c.max)) && (c.min !== undefined || c.max !== undefined)
      && !(c.min !== undefined && c.max !== undefined && c.min > c.max)
      ? { ...(c.min !== undefined ? { min: c.min } : {}), ...(c.max !== undefined ? { max: c.max } : {}) } : null;
    return { id: p.id, name: p.name, group: str(p.group, 200) ? p.group : "", note: str(p.note, 200) ? p.note : "", url, ...(capacity ? { capacity } : {}) };
  });
  const cleanSlots = slots.map(s => {
    if (!ids.has(s?.place) || !DATE.test(s.date || "") || !Array.isArray(s.free) || s.free.length > 48 || !s.free.every(f => RANGE.test(f))) throw new HttpsError("invalid-argument", "空きの行の形がちがいます");
    return { place: s.place, date: s.date, free: s.free };
  }).filter(s => s.date >= poll.from && s.date <= poll.to);
  await doc.set({ asOf: str(avail.asOf, 40) ? avail.asOf : "", places: cleanPlaces, slots: cleanSlots, updatedAt: FieldValue.serverTimestamp(), device: req.auth.uid });
  return { ok: true, places: cleanPlaces.length, slots: cleanSlots.length };
});

// ---------- 設定の編集・削除 ----------
const toMin = s => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(s ?? "")); return m ? +m[1] * 60 + +m[2] : null; };
const fmt = m => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

/** 設定を編集する（名前・アイコン・メモ・長さ・呼びたい人・対象の日・使わない日と時間帯・期間・1日の範囲・時間の刻み）。回答は消さない */
exports.updatePoll = onCall({ region: REGION }, async req => {
  if (!req.auth) throw new HttpsError("unauthenticated", "ログインしていません");
  const { pollId, key } = req.data || {}, patch = req.data?.patch || {};
  const { ref, poll } = await adminPoll(pollId, key);
  const out = {};
  if ("title" in patch) { if (!str(patch.title, 80) || !patch.title.trim()) throw new HttpsError("invalid-argument", "名前を入れてください"); out.title = patch.title.trim(); }
  if ("emoji" in patch) { if (!str(patch.emoji, 16)) throw new HttpsError("invalid-argument", "アイコンが長すぎます"); out.emoji = patch.emoji; }
  if ("note" in patch) { if (!str(patch.note, 1000)) throw new HttpsError("invalid-argument", "メモが長すぎます"); out.note = patch.note; }
  if ("durations" in patch) {
    const d = patch.durations;
    if (!Array.isArray(d) || !d.length || d.length > 8 || d.some(x => ![60, 120, 180].includes(x))) throw new HttpsError("invalid-argument", "長さが正しくありません");
    out.durations = [...new Set(d)].sort((a, b) => a - b);
  }
  if ("invited" in patch) {
    const v = patch.invited;
    if (!Array.isArray(v) || v.length > 100 || v.some(x => !str(x?.name, 40) || !x.name || typeof x.required !== "boolean")) throw new HttpsError("invalid-argument", "呼びたい人の形がちがいます");
    out.invited = v.map(x => ({ name: x.name, required: x.required }));
  }
  if ("dayType" in patch) {
    if (!["all", "weekend", "weekday"].includes(patch.dayType)) throw new HttpsError("invalid-argument", "対象の日が正しくありません");
    out.dayType = patch.dayType;
  }
  if ("exclude" in patch) {
    const v = patch.exclude;
    // 新しく書くのは kind: rule だけ（logic.js の normRule）。前の形も、そのまま送り直されたときのために受け付ける
    const okItem = x => x && ["rule", "date", "weekday", "days", "time", "range"].includes(x.kind)
      && ["date", "from", "to"].every(k => x[k] === undefined || DATE.test(x[k])) && (x.from === undefined || x.to === undefined || x.from <= x.to)
      && (x.start === undefined || toMin(x.start) != null) && (x.end === undefined || toMin(x.end) != null)
      && (x.weekdays === undefined || (Array.isArray(x.weekdays) && x.weekdays.length <= 7 && x.weekdays.every(w => Number.isInteger(w) && w >= 0 && w <= 6)))
      && (x.holiday === undefined || typeof x.holiday === "boolean" || ["skip", "add", "any"].includes(x.holiday))
      && (x.note === undefined || str(x.note, 100));
    if (!Array.isArray(v) || v.length > 200 || !v.every(okItem)) throw new HttpsError("invalid-argument", "使わない日・時間帯の形がちがいます");
    out.exclude = v;
  }
  if ("from" in patch || "to" in patch) {
    // 期間：延ばす・縮めるどちらも可。回答は消さない（期間の外の日は画面に出ないだけ）。1日の範囲・刻みは変えない
    const from = patch.from, to = patch.to;
    if (!DATE.test(from || "") || !DATE.test(to || "") || from > to) throw new HttpsError("invalid-argument", "期間を正しく入れてください");
    const days = (Date.parse(to) - Date.parse(from)) / 86400000 + 1;
    if (days > 92) throw new HttpsError("invalid-argument", "期間は3か月までです");
    out.from = from; out.to = to;
    const h = patch.holidays;   // 祝日の一覧（画面が日本の祝日から期間の分を選んで送る）
    if (!Array.isArray(h) || h.length > 40 || h.some(d => !DATE.test(d) || d < from || d > to)) throw new HttpsError("invalid-argument", "祝日の形がちがいます");
    out.holidays = h;
    const exp = new Date(to + "T00:00:00Z"); exp.setUTCDate(exp.getUTCDate() + 90);   // 期間の終わりから90日で消す
    out.expireAt = exp;
  }
  if ("step" in patch || "dayStart" in patch || "dayEnd" in patch) {
    // 1日の範囲・時間の刻み：回答は消さない（範囲の外は出ないだけ。1時間刻みにすると回答は1時間に丸めて数える）
    const step = "step" in patch ? patch.step : (poll.step === 60 ? 60 : 30);
    const ds = "dayStart" in patch ? patch.dayStart : poll.dayStart, de = "dayEnd" in patch ? patch.dayEnd : poll.dayEnd;
    const s0 = toMin(ds), e0 = toMin(de);
    if (![30, 60].includes(step)) throw new HttpsError("invalid-argument", "刻みは30分か1時間にしてください");
    if (s0 == null || e0 == null || s0 >= e0 || e0 > 1440 || s0 % step || e0 % step) throw new HttpsError("invalid-argument", "1日の範囲を正しく入れてください（刻みに合わせて）");
    const durs = out.durations || poll.durations || [];
    if (durs.some(d => d % step)) throw new HttpsError("invalid-argument", "集まりたい長さが刻みと合いません");
    Object.assign(out, { step, dayStart: fmt(s0), dayEnd: fmt(e0) });
  }
  if (!Object.keys(out).length) throw new HttpsError("invalid-argument", "変えるものがありません");
  await ref.update(out);
  return { ok: true };
});

/** 調整を削除する（回答・履歴・場所の空き状況もまとめて） */
exports.deletePoll = onCall({ region: REGION }, async req => {
  if (!req.auth) throw new HttpsError("unauthenticated", "ログインしていません");
  const { pollId, key } = req.data || {};
  const { ref } = await adminPoll(pollId, key);
  await db.recursiveDelete(ref);
  return { ok: true };
});

// ---------- 期限切れの削除（毎日 4時。期間の終わりから90日たった調整を消す） ----------
const { onSchedule } = require("firebase-functions/v2/scheduler");
async function deleteExpired(now = new Date()) {
  const qs = await db.collection("polls").where("expireAt", "<", now).limit(200).get();
  for (const d of qs.docs) await db.recursiveDelete(d.ref);
  return qs.size;
}
exports.cleanupExpired = onSchedule({ region: REGION, schedule: "every day 04:00", timeZone: "Asia/Tokyo" }, async () => {
  const n = await deleteExpired();
  console.log(`期限切れの調整を ${n} 件消しました`);
});
// テスト用（エミュレーターのときだけ呼べる）
if (process.env.FUNCTIONS_EMULATOR === "true") {
  exports.runCleanup = onCall({ region: REGION }, async () => ({ deleted: await deleteExpired() }));
}

// ---------- 共有したときの表示（OGP） ----------
// LINE・Slack などはページの JavaScript を動かさないので、/p/{id} の HTML に調整の名前・期間・アイコンを入れて返す
const { onRequest } = require("firebase-functions/v2/https");
const fs = require("node:fs");
const path = require("node:path");
const { ogpFor, ogpHtml, escHtml, paddedIcon, TW } = require("./ogp.js");
let pageCache = null;
// 本番は1回読んだら使い回す。エミュレーターでは画面を直したらすぐ見えるよう毎回読む
const page = () => process.env.FUNCTIONS_EMULATOR === "true" ? fs.readFileSync(path.join(__dirname, "p.html"), "utf8")
  : (pageCache ??= fs.readFileSync(path.join(__dirname, "p.html"), "utf8"));

exports.pollPage = onRequest({ region: REGION, memory: "256MiB", maxInstances: 5 }, async (req, res) => {
  let html = page();
  const id = (req.path.split("/")[2] || "").slice(0, 40);
  if (/^[a-z0-9]{20}$/.test(id)) {
    try {
      const snap = await db.doc(`polls/${id}`).get();
      if (snap.exists) {
        const o = ogpFor(snap.data());
        // 置き換えは関数で渡す（文字列で渡すと、名前に入った「$&」などが特別な意味になるため）
        html = html
          .replace(/<!--OGP-->[\s\S]*?<!--\/OGP-->/, () => ogpHtml(o, `https://komadori.web.app/p/${id}`))
          .replace("<title>コマドリ</title>", () => `<title>${escHtml(o.title)}｜コマドリ</title>`)
          // 共有の表示でサイト名の横に出る小さい印を、この日程調整のアイコンにする
          .replace('<link rel="icon" href="/icon.png" type="image/png" sizes="72x72">', () => `<link rel="icon" href="${escHtml(o.image)}" type="image/png" sizes="72x72">`)
          .replace('<link rel="apple-touch-icon" href="/icon.png">', () => `<link rel="apple-touch-icon" href="${escHtml(o.image)}">`);
      }
    } catch (e) { console.error(e); }
  }
  // 名前の変更がすぐ届くよう、キャッシュは短く
  res.set("Cache-Control", "public, max-age=60, s-maxage=60");
  res.set("X-Robots-Tag", "noindex, nofollow");
  res.set("Referrer-Policy", "no-referrer");
  res.status(200).type("html").send(html);
});

// 共有の表示に出す、余白つきの小さいアイコン（/og/1f3b8.png）
exports.ogIcon = onRequest({ region: REGION, memory: "256MiB", maxInstances: 3 }, async (req, res) => {
  const m = /^\/og\/([0-9a-f]{2,6}(?:-[0-9a-f]{2,6}){0,7})\.png$/.exec(req.path);
  if (!m) { res.status(404).send("not found"); return; }
  try {
    const r = await fetch(`${TW}${m[1]}.png`);
    if (!r.ok) { res.status(404).send("not found"); return; }
    const { PNG } = require("pngjs");
    res.set("Cache-Control", "public, max-age=604800, s-maxage=2592000");
    res.status(200).type("png").send(paddedIcon(Buffer.from(await r.arrayBuffer()), PNG));
  } catch (e) { console.error(e); res.status(500).send("error"); }
});
