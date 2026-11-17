// コマドリの Cloud Functions
// 書き込みはすべて /api/…（サイトと同じアドレス。Hosting から回す）で受ける。
// 広告ブロック・VPN・DNS のフィルターで Google の通信先（ログイン・Firestore への書き込み）が止められていても、保存できるように
// 管理の操作は、管理用の鍵（URL の #admin=…）を確かめてから書く
const { onCall, onRequest, HttpsError } = require("firebase-functions/v2/https");
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
async function setPlaces(data, device) {
  const { pollId, key, avail } = data;
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
  await doc.set({ asOf: str(avail.asOf, 40) ? avail.asOf : "", places: cleanPlaces, slots: cleanSlots, updatedAt: FieldValue.serverTimestamp(), device });
  return { ok: true, places: cleanPlaces.length, slots: cleanSlots.length };
}

// ---------- 設定の編集・削除 ----------
const toMin = s => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(s ?? "")); return m ? +m[1] * 60 + +m[2] : null; };
const fmt = m => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
// 使わない日・時間帯：新しく書くのは kind: rule だけ（logic.js の normRule）。前の形も、そのまま送り直されたときのために受け付ける
const okExcludeItem = x => x && typeof x === "object" && ["rule", "date", "weekday", "days", "time", "range"].includes(x.kind)
  && ["date", "from", "to"].every(k => x[k] === undefined || DATE.test(x[k])) && (x.from === undefined || x.to === undefined || x.from <= x.to)
  && (x.start === undefined || toMin(x.start) != null) && (x.end === undefined || toMin(x.end) != null)
  && (x.weekdays === undefined || (Array.isArray(x.weekdays) && x.weekdays.length <= 7 && x.weekdays.every(w => Number.isInteger(w) && w >= 0 && w <= 6)))
  && (x.holiday === undefined || typeof x.holiday === "boolean" || ["skip", "add", "any"].includes(x.holiday))
  && (x.note === undefined || str(x.note, 100));
const okExclude = v => Array.isArray(v) && v.length <= 200 && v.every(okExcludeItem);
const okInvited = v => Array.isArray(v) && v.length <= 100 && v.every(x => str(x?.name, 40) && x.name && typeof x.required === "boolean");
const spanDays = (from, to) => (Date.parse(to) - Date.parse(from)) / 86400000 + 1;
/** 消す日：期間の終わりから90日 */
const expireOf = to => { const d = new Date(to + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + 90); return d; };

/** 設定を編集する（名前・アイコン・メモ・長さ・呼びたい人・対象の日・使わない日と時間帯・期間・1日の範囲・時間の刻み）。回答は消さない */
async function updatePoll(data) {
  const { pollId, key } = data, patch = data.patch && typeof data.patch === "object" ? data.patch : {};
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
    if (!okInvited(patch.invited)) throw new HttpsError("invalid-argument", "呼びたい人の形がちがいます");
    out.invited = patch.invited.map(x => ({ name: x.name, required: x.required }));
  }
  if ("dayType" in patch) {
    if (!["all", "weekend", "weekday"].includes(patch.dayType)) throw new HttpsError("invalid-argument", "対象の日が正しくありません");
    out.dayType = patch.dayType;
  }
  if ("exclude" in patch) {
    if (!okExclude(patch.exclude)) throw new HttpsError("invalid-argument", "使わない日・時間帯の形がちがいます");
    out.exclude = patch.exclude;
  }
  if ("from" in patch || "to" in patch) {
    // 期間：延ばす・縮めるどちらも可。回答は消さない（期間の外の日は画面に出ないだけ）。1日の範囲・刻みは変えない
    const from = patch.from, to = patch.to;
    if (!DATE.test(from || "") || !DATE.test(to || "") || from > to) throw new HttpsError("invalid-argument", "期間を正しく入れてください");
    if (spanDays(from, to) > 92) throw new HttpsError("invalid-argument", "期間は3か月までです");
    out.from = from; out.to = to;
    const h = patch.holidays;   // 祝日の一覧（画面が日本の祝日から期間の分を選んで送る）
    if (!Array.isArray(h) || h.length > 40 || h.some(d => !DATE.test(d) || d < from || d > to)) throw new HttpsError("invalid-argument", "祝日の形がちがいます");
    out.holidays = h;
    out.expireAt = expireOf(to);
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
  if ("candDates" in patch) {
    // 候補日：管理する人が選んだ日（回答する人にも見せる）。期間の中の日だけ
    const v = patch.candDates, from = out.from || poll.from, to = out.to || poll.to;
    if (!Array.isArray(v) || v.length > 40 || v.some(d => !DATE.test(d || "") || d < from || d > to)) throw new HttpsError("invalid-argument", "候補日の形がちがいます");
    out.candDates = [...new Set(v)].sort();
  }
  if (!Object.keys(out).length) throw new HttpsError("invalid-argument", "変えるものがありません");
  await ref.update(out);
  return { ok: true };
}

/** 調整を削除する（回答・履歴・場所の空き状況もまとめて） */
async function deletePoll(data) {
  const { ref } = await adminPoll(data.pollId, data.key);
  await db.recursiveDelete(ref);
  return { ok: true };
}

// ---------- 調整を作る・答える ----------
const ID_ABC = "abcdefghijkmnpqrstuvwxyz23456789";
const newId = n => Array.from(crypto.randomBytes(n), b => ID_ABC[b % ID_ABC.length]).join("");
const bad = msg => { throw new HttpsError("invalid-argument", msg); };

/** 調整を作る。ID はここで決める。管理用の鍵は画面で作り、ハッシュだけ受け取る */
async function createPoll(data, device) {
  const p = data.poll && typeof data.poll === "object" ? data.poll : {};
  const title = str(p.title, 80) ? p.title.trim() : "";
  if (!title) bad("名前を入れてください");
  if (!str(p.emoji ?? "", 16)) bad("アイコンが長すぎます");
  if (!str(p.note ?? "", 1000)) bad("メモが長すぎます");
  if (!DATE.test(p.from || "") || !DATE.test(p.to || "") || p.from > p.to) bad("期間を正しく入れてください");
  if (spanDays(p.from, p.to) > 92) bad("期間は3か月までです");
  if (![30, 60].includes(p.step)) bad("刻みは30分か1時間にしてください");
  const s0 = toMin(p.dayStart), e0 = toMin(p.dayEnd);
  if (s0 == null || e0 == null || s0 >= e0 || e0 > 1440 || s0 % p.step || e0 % p.step) bad("1日の範囲を正しく入れてください");
  if (!Array.isArray(p.durations) || !p.durations.length || p.durations.length > 8 || p.durations.some(d => ![60, 120, 180].includes(d) || d % p.step)) bad("長さが正しくありません");
  if (!["all", "weekend", "weekday", undefined].includes(p.dayType)) bad("対象の日が正しくありません");
  if (!okExclude(p.exclude ?? [])) bad("使わない日・時間帯の形がちがいます");
  if (!okInvited(p.invited ?? [])) bad("呼びたい人の形がちがいます");
  const holidays = p.holidays ?? [];
  if (!Array.isArray(holidays) || holidays.length > 40 || holidays.some(d => !DATE.test(d) || d < p.from || d > p.to)) bad("祝日の形がちがいます");
  if (!/^[0-9a-f]{64}$/.test(data.adminKeyHash || "")) bad("管理用の鍵の形がちがいます");
  const id = newId(20);
  await db.doc(`polls/${id}`).create({
    title, emoji: p.emoji || "", note: p.note || "", from: p.from, to: p.to, dayStart: fmt(s0), dayEnd: fmt(e0), step: p.step,
    durations: [...new Set(p.durations)].sort((a, b) => a - b), ...(p.dayType && p.dayType !== "all" ? { dayType: p.dayType } : {}),
    exclude: p.exclude || [], invited: (p.invited || []).map(x => ({ name: x.name, required: x.required })), holidays,
    adminKeyHash: data.adminKeyHash, createdAt: FieldValue.serverTimestamp(), expireAt: expireOf(p.to), device,
  });
  return { ok: true, id };
}

const okRanges = v => Array.isArray(v) && v.length <= 48 && v.every(r => RANGE.test(r));
const okDay = d => d && typeof d === "object" && !Array.isArray(d)
  && Object.keys(d).every(k => ["sure", "maybe", "ng", "note"].includes(k))
  && (d.sure === undefined || okRanges(d.sure)) && (d.maybe === undefined || okRanges(d.maybe))
  && (d.ng === undefined || typeof d.ng === "boolean") && (d.note === undefined || str(d.note, 500));

/** 答えを保存する（その人の答えをまるごと置き換え、履歴を1つ足す）。誰の答えでも直せる（device は直した端末の印として残す） */
async function saveAnswer(data, device) {
  const { pollId, personId, name, days, dates } = data;
  if (!str(pollId, 40) || !/^[a-z0-9]{20}$/.test(pollId)) bad("日程調整がまちがっています");
  if (!str(personId, 40) || !/^[a-z0-9]{1,40}$/.test(personId)) bad("回答の ID がまちがっています");
  const nm = str(name, 40) ? name.trim() : "";
  if (!nm) bad("名前を入れてください");
  if (!days || typeof days !== "object" || Array.isArray(days) || Object.keys(days).length > 100 || !Object.entries(days).every(([k, d]) => DATE.test(k) && okDay(d))) bad("回答の形がちがいます");
  if (!Array.isArray(dates) || dates.length > 100 || dates.some(d => !DATE.test(d || ""))) bad("変えた日の形がちがいます");
  const ref = db.doc(`polls/${pollId}`), snap = await ref.get();
  if (!snap.exists) throw new HttpsError("not-found", "日程調整が見つかりません");
  const required = (snap.get("invited") || []).some(x => x.required && x.name === nm);
  const person = ref.collection("people").doc(personId), batch = db.batch();
  batch.set(person, { name: nm, required, note: "", days, updatedAt: FieldValue.serverTimestamp(), device });
  batch.set(person.collection("log").doc(), { at: FieldValue.serverTimestamp(), device, name: nm, dates });
  await batch.commit();
  return { ok: true };
}

// ---------- /api/… の受け口 ----------
const ROUTES = { create: createPoll, answer: saveAnswer, setPlaces, updatePoll, deletePoll };
exports.api = onRequest({ region: REGION, memory: "256MiB", maxInstances: 10 }, async (req, res) => {
  res.set("Cache-Control", "no-store");
  const op = req.path.replace(/^\/api/, "").replace(/^\//, "");
  const send = (status, body) => res.status(status).json(body);
  if (req.method !== "POST" || !Object.hasOwn(ROUTES, op)) return send(404, { ok: false, error: { code: "not-found", message: "見つかりません" } });
  const data = req.body && typeof req.body === "object" ? req.body : {};
  // 端末の印（書いた・直した端末の記録。ログインできる端末はその uid、できない端末は画面で作った ID）
  const device = str(data.device, 64) && /^[A-Za-z0-9_-]{6,64}$/.test(data.device) ? data.device : "unknown";
  try {
    send(200, await ROUTES[op](data, device));
  } catch (e) {
    if (e instanceof HttpsError) return send(e.httpErrorCode.status, { ok: false, error: { code: e.code, message: e.message } });
    console.error(e);
    send(500, { ok: false, error: { code: "internal", message: "うまくいきませんでした" } });
  }
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
          // 読み込み中の仮の画面にも、名前と期間を先に出す（中身が届くまでの間も、どの日程調整かわかるように）
          .replace(/<!--SKHEAD-->[\s\S]*?<!--\/SKHEAD-->/, () => `<h1>${escHtml(`${snap.get("emoji") ? snap.get("emoji") + " " : ""}${o.title}`)}</h1><p class="sub">${escHtml(o.desc)}</p>`)
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
