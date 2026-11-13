// コマドリの計算（画面にもデータベースにも依存しない。tests/logic.test.mjs でテストする）
// 時刻は「0:00 からの分」で扱う。刻みは調整ごとに30分か60分（poll.step。なければ30分）。日をまたぐ「26:00」も 1560 分として書ける。

export const STEP = 30;
export const STEPS = [30, 60];
/** その調整の刻み（分） */
export const stepOf = poll => STEPS.includes(poll?.step) ? poll.step : STEP;
const WD = "日月火水木金土";

// ---------- 時刻 ----------
/** "9:00" / "09:30" / "26:00" -> 分。読めなければ null */
export function toMin(s) {
  const m = /^\s*(\d{1,2})[:：](\d{2})\s*$/.exec(String(s ?? ""));
  if (!m || +m[2] >= 60 || +m[1] > 30) return null;
  return +m[1] * 60 + +m[2];
}
/** 分 -> "09:00" */
export function fmtMin(min) {
  return `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
}


const RANGE_RE = /(\d{1,2})[:：](\d{2})\s*[-〜~–ー－]\s*(\d{1,2})[:：](\d{2})/g;

/** "13:10-15:50, 19:00〜22:00" -> [[810,930],[1140,1320]]（刻みに丸め、重なりはまとめる） */
export function parseRanges(text, step = STEP) {
  const list = [];
  const src = Array.isArray(text) ? text.join(",") : String(text ?? "");
  for (const m of src.matchAll(RANGE_RE)) {
    const s = toMin(`${m[1]}:${m[2]}`), e = toMin(`${m[3]}:${m[4]}`);
    if (s == null || e == null) continue;
    const a = Math.ceil(s / step) * step, b = Math.floor(e / step) * step;   // 開始は切り上げ、終わりは切り捨て
    if (b > a) list.push([a, b]);
  }
  return mergeRanges(list);
}
export function mergeRanges(list) {
  const sorted = [...list].sort((x, y) => x[0] - y[0]);
  const out = [];
  for (const [s, e] of sorted) {
    const last = out[out.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e); else out.push([s, e]);
  }
  return out;
}
/** [[810,930]] -> ["13:30-15:30"] */
export const rangesToText = list => list.map(([s, e]) => `${fmtMin(s)}-${fmtMin(e)}`);

/** 時間帯の配列 -> 30分の枠の開始（分）の Set */
export function slotSet(ranges, step = STEP) {
  const out = new Set();
  for (const [s, e] of ranges) for (let m = s; m < e; m += step) out.add(m);
  return out;
}
/** 枠の開始（分）の集まり -> まとめた時間帯 */
export function slotsToRanges(slots, step = STEP) {
  return mergeRanges([...slots].map(m => [m, m + step]));
}

// ---------- 日付 ----------
const pad = n => String(n).padStart(2, "0");
const isoOf = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const dateOf = iso => new Date(iso + "T00:00:00");
export const weekdayOf = iso => dateOf(iso).getDay();
export const isIso = s => /^\d{4}-\d{2}-\d{2}$/.test(s || "") && isoOf(dateOf(s)) === s;

export function dateRange(from, to) {
  const out = [];
  if (!isIso(from) || !isIso(to)) return out;
  for (const d = dateOf(from), end = dateOf(to); d <= end; d.setDate(d.getDate() + 1)) out.push(isoOf(d));
  return out;
}
export function addDays(iso, n) { const d = dateOf(iso); d.setDate(d.getDate() + n); return isoOf(d); }

/** "2026-12-24" / "2026/12/24" / "12/24" -> ISO。年がなければ期間 [from, to] に入る年を選ぶ */
export function parseDate(s, from, to) {
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(String(s).trim());
  if (m) { const iso = `${m[1]}-${pad(+m[2])}-${pad(+m[3])}`; return isIso(iso) ? iso : null; }
  m = /^(\d{1,2})[/月](\d{1,2})日?$/.exec(String(s).trim());
  if (!m) return null;
  const y0 = from ? +from.slice(0, 4) : new Date().getFullYear();
  for (const y of [y0, y0 + 1]) {
    const iso = `${y}-${pad(+m[1])}-${pad(+m[2])}`;
    if (isIso(iso) && (!from || iso >= from) && (!to || iso <= to)) return iso;
  }
  const iso = `${y0}-${pad(+m[1])}-${pad(+m[2])}`;
  return isIso(iso) ? iso : null;
}

export function fmtDay(iso, holidays = []) {
  if (!isIso(iso)) return iso || "";
  const d = dateOf(iso);
  return `${d.getMonth() + 1}/${d.getDate()}(${WD[d.getDay()]}${holidays.includes(iso) ? "・祝" : ""})`;
}

// ---------- 除外 ----------
const WEEKDAY_SETS = {
  "毎日": { weekdays: [0, 1, 2, 3, 4, 5, 6], holiday: true },
  "平日": { weekdays: [1, 2, 3, 4, 5], holiday: false },
  "土日": { weekdays: [0, 6], holiday: false },
  "土日祝": { weekdays: [0, 6], holiday: true },
};
export const DAY_SETS = Object.keys(WEEKDAY_SETS);

/** 「平日」などの決まり（kind: days・time）がその日に当てはまるか。祝日は、holiday:true の決まりにだけ当てはまる（土日と同じに数える） */
function daySetHits(rule, iso, holidays) {
  if (holidays.includes(iso)) return !!rule.holiday;
  return (rule.weekdays || []).includes(weekdayOf(iso));
}

/** その日の除外：{ all: 1日まるごと除外か, slots: 除外する枠の Set, notes: ひとこと } */
export function excludedOn(poll, iso) {
  const holidays = poll.holidays || [], step = stepOf(poll);
  const res = { all: false, slots: new Set(), notes: [] };
  for (const x of poll.exclude || []) {
    if (x.kind === "date" && x.date === iso) { res.all = true; if (x.note) res.notes.push(x.note); }
    else if (x.kind === "weekday" && (x.weekdays || []).includes(weekdayOf(iso))) res.all = true;
    else if (x.kind === "days" && daySetHits(x, iso, holidays)) { res.all = true; if (x.note) res.notes.push(x.note); }
    else if ((x.kind === "time" && daySetHits(x, iso, holidays)) || (x.kind === "range" && x.date === iso)) {
      // 使えない時間なので、少しでもかかる枠は外す（外側に丸める）
      const xs = toMin(x.start), xe = toMin(x.end);
      if (xs != null && xe != null) for (let m = Math.floor(xs / step) * step; m < xe; m += step) res.slots.add(m);
      if (x.note) res.notes.push(x.note);
    }
  }
  return res;
}

/** 除外の貼り付け（1行に1つ）を読む -> { items, errors: [{ line, text, reason }] } */
export function parseExclusions(text, { from, to } = {}) {
  const items = [], errors = [];
  String(text ?? "").split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;
    const err = reason => errors.push({ line: i + 1, text: line, reason });
    const ranges = parseRanges(line);
    const words = line.replace(RANGE_RE, " ").split(/[\s　]+/).filter(Boolean);
    const first = words[0] || "";
    if (ranges.length) {
      const [s, e] = ranges[0];
      const t = { start: fmtMin(s), end: fmtMin(e) };
      if (WEEKDAY_SETS[first]) {
        const note = words.slice(1).join(" ");
        items.push({ kind: "time", ...t, ...WEEKDAY_SETS[first], ...(note ? { note } : {}) });
      } else {
        const date = parseDate(first, from, to);
        if (!date) return err("日付か「平日・土日・土日祝・毎日」が読めません");
        const note = words.slice(1).join(" ");
        items.push({ kind: "range", date, ...t, ...(note ? { note } : {}) });
      }
      return;
    }
    if (WEEKDAY_SETS[first]) {   // 「平日」だけ → 祝日以外の平日を丸ごと使わない（土日祝だけで調整したいとき）
      const note = words.slice(1).join(" ");
      items.push({ kind: "days", ...WEEKDAY_SETS[first], ...(note ? { note } : {}) });
      return;
    }
    if (words.length && words.every(w => /^[日月火水木金土]曜?日?$/.test(w))) {
      items.push({ kind: "weekday", weekdays: words.map(w => WD.indexOf(w[0])).sort() });
      return;
    }
    const date = parseDate(first, from, to);
    if (date) { const note = words.slice(1).join(" "); items.push({ kind: "date", date, ...(note ? { note } : {}) }); return; }
    err("読めません（例：12/24、月 水、平日、平日 9:00-18:00、12/12 18:00-23:00 別のライブ）");
  });
  return { items, errors };
}

/** kind: days・time の曜日の組を「平日」などの名前に（どれにも当たらなければ「月・水・祝」の形） */
function daySetName(x) {
  return Object.entries(WEEKDAY_SETS).find(([, v]) => v.holiday === !!x.holiday && v.weekdays.join() === (x.weekdays || []).join())?.[0]
    || (x.weekdays || []).map(w => WD[w]).join("・") + (x.holiday ? "・祝" : "");
}

/** 除外1つを人が読む形に */
export function exclusionLabel(x, holidays = []) {
  const note = x.note ? ` ${x.note}` : "";
  if (x.kind === "date") return `${fmtDay(x.date, holidays)}${note}`;
  if (x.kind === "weekday") return `毎週 ${x.weekdays.map(w => WD[w]).join("・")}`;
  if (x.kind === "days") return `${daySetName(x)}${x.holiday ? "" : "（祝日は除く）"}${note}`;
  if (x.kind === "range") return `${fmtDay(x.date, holidays)} ${x.start}-${x.end}${note}`;
  if (x.kind === "time") return `${daySetName(x)} ${x.start}-${x.end}${note}`;
  return "";
}

/** 除外の一覧を、貼り付けの形（1行に1つ）に戻す。parseExclusions の逆。設定の編集の欄に入れる */
export function exclusionsText(list) {
  return (list || []).map(x => {
    const note = x.note ? ` ${x.note}` : "";
    const md = d => `${+d.slice(5, 7)}/${+d.slice(8)}`;
    if (x.kind === "date") return md(x.date) + note;
    if (x.kind === "weekday") return x.weekdays.map(w => WD[w]).join(" ");
    if (x.kind === "days") return daySetName(x) + note;
    if (x.kind === "range") return `${md(x.date)} ${x.start}-${x.end}${note}`;
    return `${daySetName(x)} ${x.start}-${x.end}${note}`;
  }).join("\n");
}

// ---------- 調整 ----------
/** 調整の設定を確かめる。問題があれば理由の配列を返す（空なら OK） */
export function validatePoll(p) {
  const errs = [], step = stepOf(p);
  if (p.step != null && !STEPS.includes(p.step)) errs.push("刻みは30分か1時間にしてください");
  if (!String(p.title || "").trim()) errs.push("名前を入れてください");
  if (!isIso(p.from) || !isIso(p.to)) errs.push("期間を入れてください");
  else if (p.from > p.to) errs.push("期間の終わりが始まりより前です");
  else if (dateRange(p.from, p.to).length > 92) errs.push("期間は3か月までです");
  const s = toMin(p.dayStart), e = toMin(p.dayEnd);
  if (s == null || e == null || e <= s) errs.push("1日の範囲を正しく入れてください");
  else if (s % step || e % step) errs.push(`1日の範囲は${step}分刻みにしてください`);
  if (!(p.durations || []).length) errs.push("集まりたい長さを1つ以上選んでください");
  else if (p.durations.some(d => !(d > 0) || d % step)) errs.push(`長さは${step === 60 ? "1時間" : "30分"}刻みにしてください`);
  return errs;
}

/** その調整の1日の枠（分の配列） */
export function daySlots(poll) {
  const out = [];
  for (let m = toMin(poll.dayStart), st = stepOf(poll); m < toMin(poll.dayEnd); m += st) out.push(m);
  return out;
}

/** 使える日（1日まるごと除外された日を除く） */
export const activeDates = poll => dateRange(poll.from, poll.to).filter(d => !excludedOn(poll, d).all);

/** ある人のある日の答え -> { sure: Set, maybe: Set }（参加不可・除外を反映） */
export function personDay(person, iso, poll) {
  const d = person.days?.[iso];
  const empty = { sure: new Set(), maybe: new Set() };
  if (!d || d.ng) return empty;
  const ex = excludedOn(poll, iso);
  if (ex.all) return empty;
  const keep = set => new Set([...set].filter(m => !ex.slots.has(m))), step = stepOf(poll);
  return { sure: keep(slotSet(parseRanges(d.sure || [], step), step)), maybe: keep(slotSet(parseRanges(d.maybe || [], step), step)) };
}

/** 日×時間の表：{ [iso]: { [min]: { sure: [名前], maybe: [名前], excluded } } } */
export function grid(poll, people) {
  const slots = daySlots(poll), out = {};
  for (const iso of activeDates(poll)) {
    const ex = excludedOn(poll, iso);
    const days = people.map(p => [p.name, personDay(p, iso, poll)]);
    out[iso] = {};
    for (const m of slots) {
      out[iso][m] = {
        excluded: ex.slots.has(m),
        sure: days.filter(([, d]) => d.sure.has(m)).map(([n]) => n),
        maybe: days.filter(([, d]) => d.maybe.has(m)).map(([n]) => n),
      };
    }
  }
  return out;
}

/** 長さ duration（分）でそろう枠を良い順に返す
 *  required：来られない（参加できる・調整が必要のどちらでもない）と枠を出さない人の名前
 *  min：最後まで「参加できる」人がこの人数より少ない枠は出さない
 *  並べ方：最後まで「参加できる」人数 → 「調整が必要」も含めた人数 → 日付・時刻の早い順。
 *  同じ日で開始が近い（duration 未満の差）枠はよいほう1つにまとめる */
export function bestWindows(poll, people, duration, { limit = 20, required = [], min = 1 } = {}) {
  const g = grid(poll, people), slots = daySlots(poll), n = duration / stepOf(poll), res = [];
  for (const iso of Object.keys(g)) {
    if (!Number.isInteger(n)) break;   // 刻みで割り切れない長さは出さない
    for (let i = 0; i + n <= slots.length; i++) {
      const span = slots.slice(i, i + n).map(m => g[iso][m]);
      if (span.some(c => c.excluded)) continue;
      const sure = span.reduce((acc, c) => acc.filter(x => c.sure.includes(x)), span[0].sure);
      const either = span.reduce((acc, c) => acc.filter(x => c.sure.includes(x) || c.maybe.includes(x)),
        [...span[0].sure, ...span[0].maybe]);
      if (!either.length || sure.length < min) continue;
      if (required.some(n => !either.includes(n))) continue;
      res.push({ date: iso, start: slots[i], end: slots[i] + duration, sure, maybe: either.filter(x => !sure.includes(x)) });
    }
  }
  res.sort((a, b) => b.sure.length - a.sure.length || (b.sure.length + b.maybe.length) - (a.sure.length + a.maybe.length)
    || a.date.localeCompare(b.date) || a.start - b.start);
  const picked = [];
  for (const w of res) {
    if (picked.some(p => p.date === w.date && Math.abs(p.start - w.start) < duration)) continue;
    picked.push(w);
    if (picked.length >= limit) break;
  }
  return picked;
}

// ---------- 書き出し ----------
/** 決まった枠の文面：「2026-12-05 13:00-15:00 バンド練習 @スタジオA」 */
export function slotLine({ date, start, end, title, place }) {
  const t = typeof start === "number" ? `${fmtMin(start)}-${fmtMin(end)}` : `${start}-${end}`;
  return [date, t, title, place ? `@${place}` : ""].filter(Boolean).join(" ");
}

/** 長さ（分）を「2時間」「1時間30分」に */
export function fmtDuration(min) {
  const h = Math.floor(min / 60), m = min % 60;
  return `${h ? `${h}時間` : ""}${m ? `${m}分` : ""}`;
}

/** 回答用の URL を送るときの文面 */
export function shareText({ emoji, title, from, to, url, holidays = [] }) {
  return [`${emoji ? emoji + " " : ""}${title}`, `日程調整です。${fmtDay(from, holidays)}〜${fmtDay(to, holidays)}で空いている時間を回答してください`, url].join("\n");
}

// ---------- 呼びたい人 ----------
/** 「呼びたい人」の貼り付け（1行に1人。先頭の * は必須）-> [{ name, required }]。空行・同じ名前は飛ばす */
export function parseInvited(text) {
  const out = [], seen = new Set();
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    let line = raw.trim(); if (!line) continue;
    const required = /^[*＊]/.test(line);
    line = line.replace(/^[*＊]\s*/, "").trim().slice(0, 40);
    if (!line || seen.has(line)) continue;
    seen.add(line); out.push({ name: line, required });
  }
  return out;
}
/** 呼びたい人の一覧の文字（貼り付けの形に戻す） */
export const invitedText = list => (list || []).map(x => `${x.required ? "*" : ""}${x.name}`).join("\n");

/** 回答の状況：呼びたい人のうち回答した人・まだの人、呼びたい人の一覧にいない回答者、必須の人 */
export function answerStatus(poll, people) {
  const inv = poll.invited || [], names = new Set(people.map(p => p.name));
  const invNames = new Set(inv.map(x => x.name));
  return {
    invited: inv.length,
    answered: inv.filter(x => names.has(x.name)).map(x => x.name),
    pending: inv.filter(x => !names.has(x.name)).map(x => x.name),
    others: people.map(p => p.name).filter(n => !invNames.has(n)),
    required: inv.filter(x => x.required).map(x => x.name),
  };
}

// ---------- 場所の空き状況（貼り付け4形式：1行に1つ・表（縦長）・表（日付×場所）・JSON） ----------
const NONE_CELL = /^(|×|✕|x|-|ー|－|受付前|満|満室|なし)$/i;
const HEAD = { place: ["場所", "店", "部屋", "スタジオ"], date: ["日付", "日"], free: ["空き", "空き時間", "時間"], note: ["メモ", "備考"], url: ["url", "リンク"], group: ["グループ", "エリア", "駅", "店舗"] };
const headOf = cell => Object.keys(HEAD).find(k => HEAD[k].includes(String(cell).trim().toLowerCase()) || HEAD[k].includes(String(cell).trim()));
const splitRow = (line, sep) => sep === "," ? line.split(",").map(s => s.trim()) : line.split("\t").map(s => s.trim());
const tsuboNote = name => (String(name).match(/\d+(?:\.\d+)?\s*帖/) || [""])[0].replace(/\s/g, "");

/** 空き状況を読む -> { asOf, places: [{ id, name, group, note, url }], slots: [{ place, date, free: ["HH:MM-HH:MM"] }], errors, format }
 *  poll の期間に入る日だけ、poll の刻みに丸めて残す。読めなかった行は errors に行番号と理由を入れて飛ばす */
export function parseAvailability(input, poll = {}) {
  const step = stepOf(poll), from = poll.from, to = poll.to;
  const places = new Map(), slots = new Map(), errors = [];
  let asOf = "", format = "";
  const place = (name, extra = {}) => {
    name = String(name || "").trim().slice(0, 80); if (!name) return null;
    const id = String(extra.id || name).slice(0, 80);
    const cur = places.get(id) || { id, name, group: "", note: "", url: "" };
    for (const k of ["group", "note", "url"]) if (extra[k] && !cur[k]) cur[k] = String(extra[k]).trim().slice(0, k === "url" ? 500 : 200);
    if (!cur.note && tsuboNote(name)) cur.note = tsuboNote(name);
    places.set(id, cur); return id;
  };
  const add = (pid, dateText, freeText, line) => {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(String(dateText).trim()) ? String(dateText).trim() : parseDate(String(dateText).replace(/\(.\)|（.）/g, "").trim(), from, to);
    if (!date) { errors.push({ line, text: String(dateText), reason: "日付が読めません" }); return; }
    if ((from && date < from) || (to && date > to)) return;   // 期間の外は使わない
    const t = String(freeText ?? "").trim();
    const ranges = NONE_CELL.test(t) ? [] : parseRanges(Array.isArray(freeText) ? freeText : t.replace(/[／/、]/g, ","), step);
    if (!ranges.length && !NONE_CELL.test(t)) { errors.push({ line, text: t, reason: "時間帯が読めません（例 13:00-18:00）" }); return; }
    const key = `${pid}|${date}`, prev = slots.get(key);
    slots.set(key, { place: pid, date, ranges: mergeRanges([...(prev?.ranges || []), ...ranges]) });
  };

  const text = typeof input === "string" ? input.trim() : "";
  let data = typeof input === "string" ? null : input;
  if (text.startsWith("{") || text.startsWith("[")) {
    try { data = JSON.parse(text); } catch { return { asOf, places: [], slots: [], errors: [{ line: 1, text: text.slice(0, 40), reason: "JSON が読めません" }], format: "json" }; }
  }

  if (data && !Array.isArray(data) && typeof data === "object") {
    // 4. JSON（format: "availability"）
    format = "json"; asOf = String(data.asOf || "");
    const byId = new Map();
    for (const p of data.places || []) { const id = place(p.name || p.id, p); if (id) { byId.set(String(p.id ?? p.name), id); byId.set(String(p.name), id); } }
    (data.slots || []).forEach((s, i) => {
      const pid = byId.get(String(s.place)) || place(s.place);
      if (!pid) { errors.push({ line: i + 1, text: String(s.place), reason: "場所がわかりません" }); return; }
      add(pid, s.date, (s.free || []).join(","), i + 1);
    });
  } else {
    // 表は2次元の配列にそろえる（avail_sheet.json は最初から2次元の配列）
    let rows, sep = "\t";
    if (Array.isArray(data)) rows = data.map(r => r.map(c => String(c ?? "").trim()));
    else {
      const lines = text.split(/\r?\n/);
      sep = lines[0].includes("\t") ? "\t" : (headOf(lines[0].split(",")[0]) && lines[0].includes(",")) ? "," : "";
      rows = sep ? lines.map(l => splitRow(l, sep)) : null;
    }
    const first = rows?.[0] || [], heads = first.map(headOf);
    const isLong = heads.includes("place") && heads.includes("date") && heads.includes("free");
    if (rows && !isLong && String(first[0]).trim() === "日付") {
      // 3. 日付×場所（横長）
      format = "wide";
      const ids = first.slice(1).map(n => place(n));
      rows.slice(1).forEach((r, i) => {
        const k = String(r[0] || "").trim(); if (!k && r.every(c => !String(c).trim())) return;
        const info = { "グループ": "group", "URL": "url", "url": "url", "メモ": "note" }[k];
        if (info) { r.slice(1).forEach((v, j) => { const p = places.get(ids[j]); if (p && v) p[info] = String(v).trim(); }); return; }
        const date = /^\d{4}-\d{2}-\d{2}$/.test(k) ? k : parseDate(k.replace(/\(.\)|（.）/g, ""), from, to);
        if (!date) { errors.push({ line: i + 2, text: k, reason: "日付が読めません" }); return; }
        r.slice(1).forEach((v, j) => { if (ids[j]) add(ids[j], date, v, i + 2); });
      });
    } else if (rows && isLong) {
      // 2. 表（縦長）。見出しの名前で列を見分ける
      format = "long";
      const col = Object.fromEntries(first.map((h, i) => [headOf(h), i]).filter(([k]) => k));
      rows.slice(1).forEach((r, i) => {
        if (r.every(c => !String(c).trim())) return;
        const pid = place(r[col.place], { note: r[col.note], url: r[col.url], group: r[col.group] });
        if (!pid) { errors.push({ line: i + 2, text: r.join(" "), reason: "場所がありません" }); return; }
        add(pid, r[col.date], r[col.free], i + 2);
      });
    } else {
      // 1. 1行に1つ（タブ区切り。タブがなければ「場所 日付 時間帯」を空白で）
      format = "lines";
      text.split(/\r?\n/).forEach((raw, i) => {
        const line = raw.trim(); if (!line) return;
        let name, date, free, rest = [];
        if (line.includes("\t")) {
          const c = line.split("\t").map(s => s.trim());
          [name, date, free, ...rest] = c;
        } else {
          const w = line.split(/[\s　]+/);
          const di = w.findIndex(x => /^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}$|^\d{1,2}[/月]\d{1,2}日?(\(.\)|（.）)?$/.test(x));
          if (di < 1) { errors.push({ line: i + 1, text: line, reason: "「場所 日付 時間帯」の形で読めません" }); return; }
          name = w.slice(0, di).join(" "); date = w[di];
          const after = w.slice(di + 1).join(" ");
          free = (after.match(/\d{1,2}[:：]\d{2}\s*[-〜~–]\s*\d{1,2}[:：]\d{2}/g) || []).join(",");
          rest = [after.replace(/\d{1,2}[:：]\d{2}\s*[-〜~–]\s*\d{1,2}[:：]\d{2}[,、/／\s]*/g, "").trim()].filter(Boolean);
        }
        const url = rest.find(x => /^https?:\/\//.test(x)) || "";
        const note = rest.filter(x => x !== url).join(" ");
        const pid = place(name, { note, url });
        if (!pid) { errors.push({ line: i + 1, text: line, reason: "場所がありません" }); return; }
        add(pid, date, free, i + 1);
      });
    }
  }
  const usedPlaces = [...places.values()];
  return {
    format, asOf, errors,
    places: usedPlaces,
    slots: [...slots.values()].map(s => ({ place: s.place, date: s.date, free: rangesToText(s.ranges) })).sort((a, b) => a.date.localeCompare(b.date) || a.place.localeCompare(b.place)),
  };
}

/** その日の [start, end) に、ずっと空いている場所 */
export function freePlaces(avail, iso, start, end) {
  if (!avail) return [];
  const ok = new Set((avail.slots || []).filter(s => s.date === iso && parseRanges(s.free || []).some(([a, b]) => a <= start && b >= end)).map(s => s.place));
  return (avail.places || []).filter(p => ok.has(p.id));
}
/** その日の各枠（分）に空いている場所があるか：Set(分) */
export function freeSlotsOn(avail, iso, step = STEP) {
  const out = new Set();
  for (const s of avail?.slots || []) if (s.date === iso) for (const m of slotSet(parseRanges(s.free || [], step), step)) out.add(m);
  return out;
}
/** 場所のしぼり込み（グループ・メモや名前の文字） */
export function filterPlaces(avail, { group = "", q = "" } = {}) {
  if (!avail) return avail;
  const words = String(q).trim().toLowerCase().split(/\s+/).filter(Boolean);
  const keep = new Set((avail.places || []).filter(p => (!group || p.group === group)
    && words.every(w => `${p.name} ${p.note} ${p.group}`.toLowerCase().includes(w))).map(p => p.id));
  return { ...avail, places: avail.places.filter(p => keep.has(p.id)), slots: avail.slots.filter(s => keep.has(s.place)) };
}

// ---------- カレンダー ----------
/** 日付と分（26:00 のような日またぎも）-> { date, hh, mm } */
function at(iso, min) { return { date: addDays(iso, Math.floor(min / 1440)), m: ((min % 1440) + 1440) % 1440 }; }
const stamp = (iso, min) => { const t = at(iso, min); return `${t.date.replace(/-/g, "")}T${pad(Math.floor(t.m / 60))}${pad(t.m % 60)}00`; };
const minOf = v => typeof v === "number" ? v : toMin(v);

/** Google カレンダーに追加するリンク（日本時間） */
export function googleCalendarUrl({ title, date, start, end, place = "", details = "" }) {
  const q = new URLSearchParams({ action: "TEMPLATE", text: title, dates: `${stamp(date, minOf(start))}/${stamp(date, minOf(end))}`, ctz: "Asia/Tokyo" });
  if (place) q.set("location", place);
  if (details) q.set("details", details);
  return `https://calendar.google.com/calendar/render?${q}`;
}

/** .ics の中身（iPhone・Outlook）。uid は調整ごとに同じにして、入れ直しても重ならないようにする */
export function icsText({ title, date, start, end, place = "", details = "", uid = "komadori" }) {
  const e = s => String(s).replace(/\\/g, "\\\\").replace(/;/g, "\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
  return [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//komadori//JP", "CALSCALE:GREGORIAN",
    // 日本時間（夏時間なし）。Outlook などは TZID の定義がないと時刻がずれるので入れる
    "BEGIN:VTIMEZONE", "TZID:Asia/Tokyo", "BEGIN:STANDARD", "DTSTART:19700101T000000", "TZOFFSETFROM:+0900", "TZOFFSETTO:+0900", "TZNAME:JST", "END:STANDARD", "END:VTIMEZONE",
    "BEGIN:VEVENT", `UID:${uid}@komadori.web.app`, `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "")}`,
    `DTSTART;TZID=Asia/Tokyo:${stamp(date, minOf(start))}`, `DTEND;TZID=Asia/Tokyo:${stamp(date, minOf(end))}`,
    `SUMMARY:${e(title)}`, ...(place ? [`LOCATION:${e(place)}`] : []), ...(details ? [`DESCRIPTION:${e(details)}`] : []),
    "END:VEVENT", "END:VCALENDAR", "",
  ].join("\r\n");
}

/** 決まった枠を確かめる（期間・1日の範囲・刻み）。問題があれば理由 */
export function validateDecided(poll, d) {
  if (!d) return "";
  const s = minOf(d.start), e = minOf(d.end), st = stepOf(poll);
  if (!isIso(d.date) || d.date < poll.from || d.date > poll.to) return "期間の中の日を選んでください";
  if (s == null || e == null || e <= s || s % st || e % st) return "時間が正しくありません";
  if (s < toMin(poll.dayStart) || e > toMin(poll.dayEnd)) return "1日の範囲の中で選んでください";
  return "";
}

// ---------- 回答の進み具合 ----------
/** その日に回答したか（どこか1つでも入れた、または参加不可にした） */
export const answeredOn = (days, iso) => { const d = days?.[iso]; return !!d && (!!d.ng || (d.sure || []).length > 0 || (d.maybe || []).length > 0); };
/** 人ごとの進み具合：使える日のうち回答していない日の数 */
export function progress(poll, people) {
  const dates = activeDates(poll);
  return people.map(p => ({ name: p.name, left: dates.filter(d => !answeredOn(p.days, d)).length, total: dates.length }));
}
