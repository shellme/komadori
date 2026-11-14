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

// ---------- 除外（使わない日・時間帯） ----------
// 除外の決まりは1つの形：{ kind: "rule", from?, to?, weekdays?, holiday?, start?, end?, note? }
//   いつ  ：from〜to（ISO の日付。なければ期間全体。1日だけなら from と to が同じ）
//   どの日：weekdays（曜日の配列。なければ毎日）と holiday（祝日の扱い）
//           "skip" 祝日には当てはまらない（平日・土日・月 水 など）
//           "add"  祝日にも当てはまる（土日祝・月 水 祝・祝）
//           "any"  祝日かどうかを見ない（前の「月 水」の読み方。古い日程調整のため）
//   何時  ：start〜end（なければ1日まるごと）
// 前の形（date・weekday・days・time・range）は normRule で同じ形に直して読む。新しく書くのは rule だけ
const ALL_WEEKDAYS = [0, 1, 2, 3, 4, 5, 6];
const DAY_SETS = {
  "平日": { weekdays: [1, 2, 3, 4, 5], holiday: "skip" },
  "土日": { weekdays: [0, 6], holiday: "skip" },
  "土日祝": { weekdays: [0, 6], holiday: "add" },
  "毎日": {},
};
/** 「対象の日」（poll.dayType）。選んだ日以外を除外の決まりとして足す */
export const DAY_TYPES = {
  all: { label: "すべての日" },
  weekend: { label: "土日祝だけ", rule: { kind: "rule", ...DAY_SETS["平日"] } },
  weekday: { label: "平日だけ", rule: { kind: "rule", ...DAY_SETS["土日祝"] } },
};

/** 除外1つを rule の形に直す（前の形も読む） */
export function normRule(x) {
  const note = x?.note ? { note: x.note } : {};
  const time = x?.start && x?.end ? { start: x.start, end: x.end } : {};
  const set = x => x.weekdays?.length === 7 && x.holiday ? {} : { weekdays: x.weekdays || [], holiday: x.holiday ? "add" : "skip" };
  switch (x?.kind) {
    case "rule": return x;
    case "date": return { kind: "rule", from: x.date, to: x.date, ...note };
    case "range": return { kind: "rule", from: x.date, to: x.date, ...time, ...note };
    case "weekday": return { kind: "rule", weekdays: x.weekdays || [], holiday: "any", ...note };
    case "days": return { kind: "rule", ...set(x), ...note };
    case "time": return { kind: "rule", ...set(x), ...time, ...note };
    default: return { kind: "rule", from: "9999-12-31", to: "9999-12-31" };   // 読めないものはどの日にも当てはめない
  }
}

/** 決まりがその日に当てはまるか */
function ruleHits(r, iso, holidays) {
  if ((r.from && iso < r.from) || (r.to && iso > r.to)) return false;
  if (!r.weekdays) return true;
  if (holidays.includes(iso) && r.holiday !== "any") return r.holiday === "add";
  return r.weekdays.includes(weekdayOf(iso));
}

/** その調整の除外の決まりの一覧（「対象の日」の分を先に） */
const rulesOf = poll => [...(DAY_TYPES[poll.dayType]?.rule ? [DAY_TYPES[poll.dayType].rule] : []), ...(poll.exclude || []).map(normRule)];

/** その日の除外：{ all: 1日まるごと除外か, slots: 除外する枠の Set, notes: ひとこと } */
export function excludedOn(poll, iso) {
  const holidays = poll.holidays || [], step = stepOf(poll);
  const res = { all: false, slots: new Set(), notes: [] };
  for (const r of rulesOf(poll)) {
    if (!ruleHits(r, iso, holidays)) continue;
    if (r.note) res.notes.push(r.note);
    const xs = toMin(r.start), xe = toMin(r.end);
    if (xs == null || xe == null) { res.all = true; continue; }
    // 使えない時間なので、少しでもかかる枠は外す（外側に丸める）
    for (let m = Math.floor(xs / step) * step; m < xe; m += step) res.slots.add(m);
  }
  return res;
}

// 貼り付けの1行：［いつ］［どの日］［何時］［ひとこと］の順。いつ・どの日のどちらかは要る
const DAY_WORD = /^([日月火水木金土]曜?日?|祝日?)$/;
const DATE_PART = String.raw`(?:\d{4}[-/.])?\d{1,2}[/月]\d{1,2}日?`;
const DATE_SPAN = new RegExp(String.raw`^(${DATE_PART})\s*[-〜~–ー－]\s*(${DATE_PART})(?=\s|$)`);

/** "1月" -> その月の初めと終わり。年は期間 [from, to] にかかる年を選ぶ */
function monthSpan(mm, from, to) {
  const y0 = from ? +from.slice(0, 4) : new Date().getFullYear();
  const span = y => { const a = `${y}-${pad(mm)}-01`; return [a, addDays(isoOf(new Date(y, mm, 1)), -1)]; };
  for (const y of [y0, y0 + 1]) { const [a, b] = span(y); if ((!to || a <= to) && (!from || b >= from)) return [a, b]; }
  return span(y0);
}

/** 除外の貼り付け（1行に1つ）を読む -> { items, errors: [{ line, text, reason }] } */
export function parseExclusions(text, { from, to } = {}) {
  const items = [], errors = [];
  String(text ?? "").split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;
    const err = reason => errors.push({ line: i + 1, text: line, reason });
    const r = { kind: "rule" };
    const ranges = parseRanges(line);
    if (ranges.length) Object.assign(r, { start: fmtMin(ranges[0][0]), end: fmtMin(ranges[0][1]) });
    let rest = line.replace(RANGE_RE, " ").trim();
    // いつ：日付〜日付／○月／日付
    const span = DATE_SPAN.exec(rest);
    if (span) {
      const a = parseDate(span[1].replace(/日$/, ""), from, to), b = parseDate(span[2].replace(/日$/, ""), from, to);
      if (!a || !b) return err("日付が読めません");
      if (a > b) return err("日付の順番が逆です");
      Object.assign(r, { from: a, to: b }); rest = rest.slice(span[0].length);
    }
    let words = rest.split(/[\s　]+/).filter(Boolean);
    if (!span && words.length) {
      const mon = /^(\d{1,2})月$/.exec(words[0]), date = !mon && parseDate(words[0], from, to);
      if (mon && +mon[1] >= 1 && +mon[1] <= 12) { const [a, b] = monthSpan(+mon[1], from, to); Object.assign(r, { from: a, to: b }); words = words.slice(1); }
      else if (date) { Object.assign(r, { from: date, to: date }); words = words.slice(1); }
    }
    // どの日：平日・土日・土日祝・毎日、または曜日（と祝）を並べたもの
    if (words.length && words[0] in DAY_SETS) { Object.assign(r, DAY_SETS[words[0]]); words = words.slice(1); }
    else {
      const ds = []; while (words.length && DAY_WORD.test(words[0])) ds.push(words.shift());
      if (ds.length) {
        const add = ds.some(w => w.startsWith("祝"));
        Object.assign(r, { weekdays: [...new Set(ds.filter(w => !w.startsWith("祝")).map(w => WD.indexOf(w[0])))].sort(), holiday: add ? "add" : "skip" });
      } else if (!r.from) {
        return err("読めません（例：12/24、1/1-1/15、1月 平日、月 水、平日 9:00-18:00、12/12 18:00-23:00 別のライブ）");
      }
    }
    if (words.length) r.note = words.join(" ");
    items.push(r);
  });
  return { items, errors };
}

const md = d => `${+d.slice(5, 7)}/${+d.slice(8)}`;
/** 丸ごと1か月か */
const wholeMonth = r => r.from?.slice(8) === "01" && r.to === addDays(isoOf(new Date(+r.from.slice(0, 4), +r.from.slice(5, 7), 1)), -1);
/** いつ（期間がなければ ""） */
function whenText(r, day = md) {
  if (!r.from) return "";
  if (r.from === r.to) return day(r.from);
  if (wholeMonth(r)) return `${+r.from.slice(5, 7)}月`;
  return `${day(r.from)}-${day(r.to)}`;
}
/** どの日（毎日なら ""）。sep は曜日の区切り */
function daysText(r, sep) {
  if (!r.weekdays) return "";
  const named = Object.entries(DAY_SETS).find(([, v]) => v.weekdays && v.holiday === r.holiday && v.weekdays.join() === r.weekdays.join())?.[0];
  return named || [...r.weekdays.map(w => WD[w]), ...(r.holiday === "add" ? ["祝"] : [])].join(sep);
}

/** 除外1つを人が読む形に（例：「1月 平日（祝日は除く）」「12/12(土) 18:00-23:00 別のライブ」） */
export function exclusionLabel(x, holidays = []) {
  const r = normRule(x);
  const days = daysText(r, "・") || (r.from ? "" : "毎日");
  // 平日を含む決まりは、祝日にかからないことを書いておく（「月 水」と書いて祝日の月曜が残るのに気づけるように）
  const skipNote = r.holiday === "skip" && r.weekdays?.some(w => w >= 1 && w <= 5) ? "（祝日は除く）" : "";
  return [whenText(r, d => fmtDay(d, holidays)).replace(/-(?=\d+\/)/, "〜"), days + skipNote, r.start ? `${r.start}-${r.end}` : "", r.note || ""].filter(Boolean).join(" ");
}

/** 除外の一覧を、貼り付けの形（1行に1つ）に戻す。parseExclusions の逆。設定の編集の欄に入れる */
export function exclusionsText(list) {
  return (list || []).map(normRule).map(r => [whenText(r), daysText(r, " ") || (r.from ? "" : "毎日"), r.start ? `${r.start}-${r.end}` : "", r.note || ""].filter(Boolean).join(" ")).join("\n");
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
// 並べ方：参加できる人が多い順 → 調整で来られる人も入れて多い順 → 人数に合う空いている場所が多い順 → 広めの場所が多い順（avail があるとき）→ 早い日・早い時間
// 場所は人数が同じ枠どうしの比べにだけ使う（人数より場所を優先はしない）。近い枠をまとめるのは、この並びで先のものを残す
// 優先する人（priority）：枠のあいだずっと来られる（● か △）人を pri、一部の時間だけ来られる人を near に入れる。
// 優先する人が来られる枠 → 一部だけ重なる枠 → そのほか、の順に並べる（来られない日も消さずに、ほかの人の人数で並べる）
export const compareWindows = (a, b) => (b.pri?.length || 0) - (a.pri?.length || 0) || (b.near?.length || 0) - (a.near?.length || 0)
  || b.sure.length - a.sure.length || (b.sure.length + b.maybe.length) - (a.sure.length + a.maybe.length)
  || b.places - a.places || b.roomy - a.roomy || a.date.localeCompare(b.date) || a.start - b.start;

export function bestWindows(poll, people, duration, { limit = 20, required = [], priority = [], min = 1, avail = null } = {}) {
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
      // 空いている場所：この枠に来られる人数（調整が必要も入れる）に合う場所と人数の決まりがない場所（places）、広めの場所（roomy）に分けて数える。入りきらない場所は数えない
      let places = 0, roomy = 0;
      if (avail) for (const p of freePlaces(avail, iso, slots[i], slots[i] + duration)) {
        const f = capacityFit(p, either.length);
        if (f === "fit" || f === "unknown") places++; else if (f === "roomy") roomy++;
      }
      const pri = priority.filter(x => either.includes(x));
      const near = priority.filter(x => !pri.includes(x) && span.some(c => c.sure.includes(x) || c.maybe.includes(x)));
      res.push({ date: iso, start: slots[i], end: slots[i] + duration, sure, maybe: either.filter(x => !sure.includes(x)), places, roomy, pri, near });
    }
  }
  res.sort(compareWindows);
  const picked = [];
  for (const w of res) {
    // 重なる枠はまとめる。ただし優先する人が来られる枠と来られない枠は別に出す（「一部だけ重なる枠」を、来られる枠の横に並べて比べられるように）
    if (picked.some(p => p.date === w.date && Math.abs(p.start - w.start) < duration && p.pri.length === w.pri.length)) continue;
    picked.push(w);
    if (picked.length >= limit) break;
  }
  return picked;
}

/** 月のカレンダー（日曜はじまり）：from〜to の入る月ごとに { ym: "2027-01", weeks: [[iso|null ×7], …] } */
export function monthCalendar(from, to) {
  const out = [];
  for (let ym = from.slice(0, 7); ym <= to.slice(0, 7);) {
    const first = `${ym}-01`, [y, m] = ym.split("-").map(Number), weeks = [];
    let week = Array(weekdayOf(first)).fill(null);
    for (let iso = first; iso.slice(0, 7) === ym; iso = addDays(iso, 1)) {
      week.push(iso);
      if (week.length === 7) { weeks.push(week); week = []; }
    }
    if (week.length) weeks.push([...week, ...Array(7 - week.length).fill(null)]);
    out.push({ ym, weeks });
    ym = m === 12 ? `${y + 1}-01` : `${y}-${pad(m + 1)}`;
  }
  return out;
}

/** 場所を広い順に（人数の上限、なければ下限が大きい順。人数のない場所は後ろ） */
export const widestFirst = list => [...list].sort((a, b) =>
  (b.capacity?.max ?? b.capacity?.min ?? -1) - (a.capacity?.max ?? a.capacity?.min ?? -1));

// ---------- 書き出し ----------
/** 候補の枠の文面：「2026-12-05 13:00-15:00 バンド練習 @スタジオA」（LINE などに貼る） */
export function slotLine({ date, start, end, title, place }) {
  const t = typeof start === "number" ? `${fmtMin(start)}-${fmtMin(end)}` : `${start}-${end}`;
  return [date, t, title, place ? `@${place}` : ""].filter(Boolean).join(" ");
}

/** ①②…（20まで。それより先は (21)） */
export const circled = n => n >= 1 && n <= 20 ? String.fromCodePoint(0x2460 + n - 1) : `(${n})`;
/** 投稿する候補の文面（LINE や Slack に貼る）：
 *  ◆候補① 1/16(土) 13:00〜15:00
 *  　場所
 *  　メモ（何行でも） */
export function postText(items, holidays = []) {
  return items.map((x, i) => [`◆候補${circled(i + 1)} ${fmtDay(x.date, holidays)} ${fmtMin(x.start)}〜${fmtMin(x.end)}`,
    ...(x.place ? [`　${x.place}`] : []),
    ...String(x.memo || "").split(/\r?\n/).map(s => s.trim()).filter(Boolean).map(s => `　${s}`)].join("\n")).join("\n\n");
}

/** AI に相談する用の文面（管理する人が ChatGPT などに貼る）：お願い・条件のひな形・設定・回答・場所・アプリが出した候補。
 *  windows はアプリが出した候補（よい順）、conds は { duration, kindLabel, min, required, priority, dates }。
 *  anonymize なら、名前を「メンバーA」…に置き換える（コメントの中の名前は置き換えない） */
export function aiBrief({ poll, people, avail = null, windows = [], conds = {}, anonymize = false }) {
  const hol = poll.holidays || [], step = stepOf(poll), day = iso => fmtDay(iso, hol);
  const alias = new Map(people.map((p, i) => [p.name, anonymize ? `メンバー${i < 26 ? String.fromCharCode(65 + i) : i + 1}` : p.name]));
  const nm = n => alias.get(n) ?? n, names = list => list.map(nm).join("、");
  const rng = set => rangesToText(slotsToRanges(set, step)).join(", ");
  const dates = conds.dates || activeDates(poll), s0 = toMin(poll.dayStart), e0 = toMin(poll.dayEnd);
  const L = [];
  L.push(`# お願い`, `「${poll.title}」の日程調整の回答です。ここから練習日の候補を選んでください。`,
    `- 「アプリが出した候補」の人数・来られない人・空いている場所は計算済みです。これを正として使い、回答にない時間や空いていない場所を候補にしないでください`,
    `- 下の「条件」に合わせて選び、候補ごとに選んだ理由を1〜2行で添えてください`,
    `- 候補は次の形で書いてください（LINE や Slack にそのまま貼ります）`, ``,
    `◆候補① 1/16(土) 13:00〜15:00`, `　場所の名前`, `　ひとこと（任意）`, ``);
  L.push(`# 条件（わかるところを書き足してください）`, `- 練習の頻度：`, `- 本番の日：`,
    `- 優先する人（来られる日を先に取りたい人）：${names(conds.priority || [])}`,
    `- 必須の人（来られない枠は選ばない人）：${names(conds.required || [])}`,
    `- 遠くから来る人・部屋の希望：`, `- そのほか：`, ``);
  L.push(`# 日程調整の設定`, `- 期間：${day(poll.from)}〜${day(poll.to)}`,
    `- 対象の日：${(DAY_TYPES[poll.dayType] || DAY_TYPES.all).label}`,
    `- 1日の時間：${poll.dayStart}〜${poll.dayEnd}（${step === 60 ? "1時間" : "30分"}刻み）`,
    `- 集まりたい長さ：${fmtDuration(conds.duration || poll.durations?.[0] || 120)}`);
  const ex = exclusionsText(poll.exclude);
  if (ex) L.push(`- 使わない日・時間帯：`, ...ex.split("\n").map(s => `  - ${s}`));
  if (hol.length) L.push(`- 期間中の祝日：${hol.map(day).join("、")}`);
  L.push(``, `# 回答（● 参加できる・△ 調整が必要・× 参加できない。書いていない日は、まだ回答していない）`);
  for (const p of people) {
    L.push(``, `## ${nm(p.name)}`);
    let any = false;
    for (const iso of dates) {
      const d = p.days?.[iso]; if (!d) continue;
      const pd = personDay(p, iso, poll), note = d.note ? ` 💬 ${d.note}` : "";
      const parts = d.ng ? ["×"] : [pd.sure.size ? `● ${rng(pd.sure)}` : "", pd.maybe.size ? `△ ${rng(pd.maybe)}` : ""].filter(Boolean);
      if (!parts.length && !note) continue;
      L.push(`- ${day(iso)} ${parts.join(" ") || "×"}${note}`); any = true;
    }
    if (!any) L.push(`- （まだ回答していない）`);
  }
  if (avail?.places?.length) {
    L.push(``, `# 場所（空き時間。人数は使える人数の目安）${avail.asOf ? `：${fmtAsOf(avail.asOf)}時点` : ""}`);
    for (const pl of avail.places) {
      const rows = dates.map(iso => {
        const sl = (avail.slots || []).find(x => x.place === pl.id && x.date === iso);
        const exs = excludedOn(poll, iso).slots;
        const free = new Set([...slotSet(parseRanges(sl?.free || [], step), step)].filter(m => m >= s0 && m < e0 && !exs.has(m)));
        return free.size ? `- ${day(iso)} ${rng(free)}` : "";
      }).filter(Boolean);
      if (!rows.length) continue;
      const info = [pl.capacity ? capacityLabel(pl.capacity) : "", pl.group || "", pl.note && !pl.name.includes(pl.note) ? pl.note : ""].filter(Boolean).join("・");
      L.push(``, `## ${pl.name}${info ? `（${info}）` : ""}`, ...rows);
    }
  }
  const cond = [fmtDuration(conds.duration || 120), conds.kindLabel || "", conds.min > 1 ? `${conds.min}人以上` : ""].filter(Boolean).join("・");
  L.push(``, `# アプリが出した候補（日ごとに上位3つ。${cond}）`);
  const total = people.length;
  for (const iso of dates) {
    const ws = windows.filter(w => w.date === iso).slice(0, 3);
    for (const w of ws) {
      const missing = people.map(p => p.name).filter(n => !w.sure.includes(n) && !w.maybe.includes(n));
      const pls = avail ? placesForWindow(avail, iso, w.start, w.end, w.sure.length + w.maybe.length) : null;
      const usable = pls ? [...pls.fit, ...pls.unknown, ...pls.roomy].map(p => p.name) : [];
      L.push(`- ${day(iso)} ${fmtMin(w.start)}〜${fmtMin(w.end)}：参加 ${w.sure.length}/${total}人（● ${names(w.sure) || "なし"}${w.maybe.length ? `／△ ${names(w.maybe)}` : ""}）`
        + (missing.length ? `・来られない・未回答：${names(missing)}` : "")
        + (w.near?.length ? `・一部の時間だけ来られる：${names(w.near)}` : "")
        + (pls ? `・空いている場所：${usable.length ? usable.join("、") : "なし"}` : ""));
    }
  }
  return L.join("\n");
}

/** AI に相談する用のファイルの名前：「本番前の練習_AI相談_2026-11-14.md」（ファイル名に使えない文字は _ に） */
export const briefFileName = (title, today) =>
  `${String(title || "日程調整").replace(/[\\/:*?"<>|\s]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "日程調整"}_AI相談_${today}.md`;

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
const HEAD = { place: ["場所", "店", "部屋", "スタジオ"], date: ["日付", "日"], free: ["空き", "空き時間", "時間"], note: ["メモ", "備考"], url: ["url", "リンク"], group: ["グループ", "エリア", "駅", "店舗"], capacity: ["人数", "適正人数", "定員"] };
const headOf = cell => Object.keys(HEAD).find(k => HEAD[k].includes(String(cell).trim().toLowerCase()) || HEAD[k].includes(String(cell).trim()));
const splitRow = (line, sep) => sep === "," ? line.split(",").map(s => s.trim()) : line.split("\t").map(s => s.trim());
const tsuboNote = name => (String(name).match(/\d+(?:\.\d+)?\s*帖/) || [""])[0].replace(/\s/g, "");

// ---------- 場所の人数（適正人数） ----------
// { min, max }（どちらか片方でもよい）。ない場所は「人数の決まりなし」として、どの人数にも出す
const CAP_RE = /(\d{1,3})?\s*人?\s*[〜~～\-–ー－]\s*(\d{1,3})?\s*人/;
const capInt = v => (v === "" || v == null) ? null : Number.isInteger(+v) && +v >= 1 && +v <= 999 ? +v : NaN;
/** {min,max}・[min,max]・"4〜8人"・"〜6人"・"4人〜" などを { min?, max? } に。読めなければ null */
export function normCapacity(c) {
  if (c == null || c === "") return null;
  let min, max;
  if (Array.isArray(c)) [min, max] = c;
  else if (typeof c === "object") ({ min, max } = c);
  else if (typeof c === "number") max = c;
  else {
    const s = String(c).normalize("NFKC"), m = CAP_RE.exec(s) || /(\d{1,3})\s*人\s*[〜~～\-–ー－]/.exec(s);
    if (!m) { const one = /^\s*(\d{1,3})\s*人?\s*$/.exec(s); if (!one) return null; max = one[1]; }
    else [min, max] = [m[1], m[2]];
  }
  min = capInt(min); max = capInt(max);
  if (Number.isNaN(min) || Number.isNaN(max) || (min == null && max == null) || (min != null && max != null && min > max)) return null;
  return { ...(min != null ? { min } : {}), ...(max != null ? { max } : {}) };
}
/** メモの中の「4〜8人」「〜6人」を人数として読む（項目で渡されなかったとき） */
const capacityInText = s => { const m = String(s || "").normalize("NFKC").match(/\d{0,3}\s*人?\s*[〜~～\-–ー－]\s*\d{0,3}\s*人/); return m ? normCapacity(m[0]) : null; };
/** 人数を読む形に：「5〜8人」「〜6人」「4人〜」 */
export const capacityLabel = c => !c ? "" : c.min != null && c.max != null ? (c.min === c.max ? `${c.min}人` : `${c.min}〜${c.max}人`) : c.max != null ? `〜${c.max}人` : `${c.min}人〜`;
/** その人数に合うか：fit 合う／unknown 人数の決まりなし／roomy 広め（人数が下限より少ない。使えるが割高なことが多い）／small 入りきらない（人数が上限より多い）
 *  少人数で大きい部屋を使うのはよくあるので、広めは「使える場所」として扱い、合う場所の後ろに出す */
export function capacityFit(place, n) {
  const c = place?.capacity;
  if (!c || (c.min == null && c.max == null)) return "unknown";
  if (c.max != null && n > c.max) return "small";
  if (c.min != null && n < c.min) return "roomy";
  return "fit";
}

/** 空き状況を読む -> { asOf, places: [{ id, name, group, note, url, capacity? }], slots: [{ place, date, free: ["HH:MM-HH:MM"] }], errors, format }
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
    if (!cur.capacity) { const c = normCapacity(extra.capacity) || capacityInText(extra.note); if (c) cur.capacity = c; }
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
        const info = { "グループ": "group", "URL": "url", "url": "url", "メモ": "note", "人数": "capacity", "適正人数": "capacity" }[k];
        if (info === "capacity") { r.slice(1).forEach((v, j) => { const p = places.get(ids[j]), c = normCapacity(v); if (p && c) p.capacity = c; }); return; }
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
        const pid = place(r[col.place], { note: r[col.note], url: r[col.url], group: r[col.group], capacity: r[col.capacity] });
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

/** 空き状況の時点（asOf）を読む形に。"2026-11-13T22:37:00+09:00" -> "11/13 22:37"（日本時間）。ISO でなければそのまま */
export function fmtAsOf(s) {
  const t = String(s || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}(T|$)/.test(t)) return t;
  const d = new Date(/T/.test(t) ? t : t + "T00:00:00+09:00");
  if (Number.isNaN(+d)) return t;
  const j = new Date(+d + 9 * 3600e3);   // 日本時間
  const md = `${j.getUTCMonth() + 1}/${j.getUTCDate()}`;
  return /T/.test(t) ? `${md} ${j.getUTCHours()}:${pad(j.getUTCMinutes())}` : md;
}

/** その日の [start, end) に、ずっと空いている場所 */
export function freePlaces(avail, iso, start, end) {
  if (!avail) return [];
  const ok = new Set((avail.slots || []).filter(s => s.date === iso && parseRanges(s.free || []).some(([a, b]) => a <= start && b >= end)).map(s => s.place));
  return (avail.places || []).filter(p => ok.has(p.id));
}
/** その枠に空いている場所を、人数に合う順に分ける：{ fit, unknown, roomy, small }（n はその枠に来られる人数） */
export function placesForWindow(avail, iso, start, end, n) {
  const out = { fit: [], unknown: [], roomy: [], small: [] };
  for (const p of freePlaces(avail, iso, start, end)) out[capacityFit(p, n)].push(p);
  out.roomy.sort((a, b) => a.capacity.min - b.capacity.min);   // 広めの中では、人数に近い（下限が小さい）部屋を先に
  return out;
}
/** その日の各枠（分）に空いている場所があるか：Set(分) */
export function freeSlotsOn(avail, iso, step = STEP) {
  const out = new Set();
  for (const s of avail?.slots || []) if (s.date === iso) for (const m of slotSet(parseRanges(s.free || [], step), step)) out.add(m);
  return out;
}
/** 場所のしぼり込み（グループはいくつでも選べる。どれかに入れば残す・メモや名前の文字） */
export function filterPlaces(avail, { groups = [], group = "", q = "" } = {}) {
  if (!avail) return avail;
  const gs = [...groups, ...(group ? [group] : [])];
  const words = String(q).trim().toLowerCase().split(/\s+/).filter(Boolean);
  const keep = new Set((avail.places || []).filter(p => (!gs.length || gs.includes(p.group))
    && words.every(w => `${p.name} ${p.note} ${p.group}`.toLowerCase().includes(w))).map(p => p.id));
  return { ...avail, places: avail.places.filter(p => keep.has(p.id)), slots: avail.slots.filter(s => keep.has(s.place)) };
}

// ---------- 回答の進み具合 ----------
/** その日に回答したか（どこか1つでも入れた、または参加不可にした） */
export const answeredOn = (days, iso) => { const d = days?.[iso]; return !!d && (!!d.ng || (d.sure || []).length > 0 || (d.maybe || []).length > 0); };
/** 人ごとの進み具合：使える日のうち回答していない日の数 */
export function progress(poll, people) {
  const dates = activeDates(poll);
  return people.map(p => ({ name: p.name, left: dates.filter(d => !answeredOn(p.days, d)).length, total: dates.length }));
}
