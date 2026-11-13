// 計算のテスト：npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import * as L from "../public/logic.js";

const poll = (over = {}) => ({
  title: "練習", from: "2026-12-01", to: "2026-12-07", dayStart: "09:00", dayEnd: "23:00",
  durations: [120], holidays: [], exclude: [], ...over,
});

test("時刻の読み書き（日をまたぐ 26:00 も）", () => {
  assert.equal(L.toMin("9:00"), 540);
  assert.equal(L.toMin("26:00"), 1560);
  assert.equal(L.toMin("9:75"), null);
  assert.equal(L.toMin("abc"), null);
  assert.equal(L.fmtMin(540), "09:00");
  assert.equal(L.fmtMin(1560), "26:00");
});

test("時間帯：30分に丸める（開始は切り上げ、終わりは切り捨て）", () => {
  assert.deepEqual(L.rangesToText(L.parseRanges("13:10-15:50")), ["13:30-15:30"]);
  assert.deepEqual(L.parseRanges("13:10-13:40"), []);           // 丸めたら何も残らない
  assert.deepEqual(L.rangesToText(L.parseRanges("22:00-26:00")), ["22:00-26:00"]);
});

test("時間帯：区切りの記号と複数・重なりをまとめる", () => {
  assert.deepEqual(L.rangesToText(L.parseRanges("10:00〜12:00 / 11:00~13:00、19:00–21:00")), ["10:00-13:00", "19:00-21:00"]);
  assert.deepEqual(L.rangesToText(L.parseRanges(["10:00-11:00", "11:00-12:00"])), ["10:00-12:00"]);
});

test("枠と時間帯の行き来", () => {
  const s = L.slotSet(L.parseRanges("10:00-11:30"));
  assert.deepEqual([...s], [600, 630, 660]);
  assert.deepEqual(L.rangesToText(L.slotsToRanges(new Set([600, 630, 720]))), ["10:00-11:00", "12:00-12:30"]);
});

test("日付：年のない日付は期間に入る年を選ぶ", () => {
  assert.equal(L.parseDate("1/5", "2026-12-01", "2027-02-28"), "2027-01-05");
  assert.equal(L.parseDate("12/24", "2026-12-01", "2027-02-28"), "2026-12-24");
  assert.equal(L.parseDate("2026/12/5"), "2026-12-05");
  assert.equal(L.parseDate("2/30", "2026-12-01", "2027-02-28"), null);
  assert.deepEqual(L.dateRange("2026-12-30", "2027-01-02"), ["2026-12-30", "2026-12-31", "2027-01-01", "2027-01-02"]);
  assert.equal(L.fmtDay("2026-12-23", ["2026-12-23"]), "12/23(水・祝)");
});

test("除外：前の形（日・曜日・毎日の時間帯・特定の日の時間帯）も、前と同じに読む", () => {
  const p = poll({
    holidays: ["2026-12-02", "2026-12-03"],
    exclude: [
      { kind: "date", date: "2026-12-01" },
      { kind: "weekday", weekdays: [4] },                                  // 木（12/3）。前の「木」は祝日でも当てはまる
      { kind: "time", start: "09:00", end: "18:00", weekdays: [1, 2, 3, 4, 5], holiday: false },
      { kind: "range", date: "2026-12-05", start: "18:00", end: "23:00", note: "別のライブ" },
    ],
  });
  assert.equal(L.excludedOn(p, "2026-12-01").all, true);
  assert.equal(L.excludedOn(p, "2026-12-03").all, true);
  // 12/2 は祝日なので「平日」の決まりは当てはまらない
  assert.equal(L.excludedOn(p, "2026-12-02").slots.size, 0);
  // 12/4（金）は平日の 9-18 が除外
  assert.equal(L.excludedOn(p, "2026-12-04").slots.has(540), true);
  assert.equal(L.excludedOn(p, "2026-12-04").slots.has(1080), false);
  // 12/5（土）は 18-23 だけ。ひとことも出る
  const sat = L.excludedOn(p, "2026-12-05");
  assert.equal(sat.slots.has(1080), true);
  assert.equal(sat.slots.has(1020), false);
  assert.deepEqual(sat.notes, ["別のライブ"]);
  assert.deepEqual(L.activeDates(p), ["2026-12-02", "2026-12-04", "2026-12-05", "2026-12-06", "2026-12-07"]);
  assert.equal(L.exclusionLabel({ kind: "weekday", weekdays: [1, 3] }), "月・水");
  assert.equal(L.exclusionLabel({ kind: "days", weekdays: [1, 2, 3, 4, 5], holiday: false }), "平日（祝日は除く）");
});

test("除外の貼り付け：［いつ］［どの日］［何時］［ひとこと］", () => {
  const P = { from: "2026-12-01", to: "2027-02-28" };
  const { items, errors } = L.parseExclusions(
    "12/24 クリスマス\n\n1/1-1/15\n1月 平日\n月 水\n月 水 祝\n平日 9:00-18:00\n土日祝 22:00-23:00\n12/12 18:00-23:00 別のライブ\n毎日 0:00-9:00\nなにか\n2/10-2/1", P);
  assert.deepEqual(items, [
    { kind: "rule", from: "2026-12-24", to: "2026-12-24", note: "クリスマス" },
    { kind: "rule", from: "2027-01-01", to: "2027-01-15" },
    { kind: "rule", from: "2027-01-01", to: "2027-01-31", weekdays: [1, 2, 3, 4, 5], holiday: "skip" },
    { kind: "rule", weekdays: [1, 3], holiday: "skip" },
    { kind: "rule", weekdays: [1, 3], holiday: "add" },
    { kind: "rule", start: "09:00", end: "18:00", weekdays: [1, 2, 3, 4, 5], holiday: "skip" },
    { kind: "rule", start: "22:00", end: "23:00", weekdays: [0, 6], holiday: "add" },
    { kind: "rule", start: "18:00", end: "23:00", from: "2026-12-12", to: "2026-12-12", note: "別のライブ" },
    { kind: "rule", start: "00:00", end: "09:00" },
  ]);
  assert.deepEqual(errors.map(e => e.line), [11, 12]);
  const H = ["2027-01-11"];
  assert.deepEqual(items.map(x => L.exclusionLabel(x, H)), [
    "12/24(木) クリスマス", "1/1(金)〜1/15(金)", "1月 平日（祝日は除く）", "月・水（祝日は除く）", "月・水・祝",
    "平日（祝日は除く） 09:00-18:00", "土日祝 22:00-23:00", "12/12(土) 18:00-23:00 別のライブ", "毎日 00:00-09:00",
  ]);
});

test("除外：曜日で書いたものは祝日にかからない。祝日も外すときは「祝」を足す", () => {
  // 12/1(火)〜12/7(月)。12/7(月) を祝日にする
  const p = over => poll({ holidays: ["2026-12-07"], ...over });
  const read = text => L.parseExclusions(text, { from: "2026-12-01", to: "2026-12-07" }).items;
  assert.deepEqual(L.activeDates(p({ exclude: read("月 火") })), ["2026-12-02", "2026-12-03", "2026-12-04", "2026-12-05", "2026-12-06", "2026-12-07"]);
  assert.deepEqual(L.activeDates(p({ exclude: read("月 火 祝") })), ["2026-12-02", "2026-12-03", "2026-12-04", "2026-12-05", "2026-12-06"]);
  assert.deepEqual(L.activeDates(p({ exclude: read("祝") })), ["2026-12-01", "2026-12-02", "2026-12-03", "2026-12-04", "2026-12-05", "2026-12-06"]);
});

test("除外：期間つき（1月は土日祝だけ、2月は全部）", () => {
  const p = poll({ from: "2027-01-01", to: "2027-02-28", holidays: ["2027-01-01", "2027-01-11", "2027-02-11", "2027-02-23"] });
  const exclude = L.parseExclusions("1月 平日", p).items;
  const days = L.activeDates({ ...p, exclude });
  const jan = days.filter(d => d < "2027-02-01"), feb = days.filter(d => d >= "2027-02-01");
  assert.ok(jan.every(d => [0, 6].includes(L.weekdayOf(d)) || p.holidays.includes(d)));
  assert.ok(jan.includes("2027-01-11"));          // 成人の日（月）は残る
  assert.equal(feb.length, 28);                   // 2月は全部
  // 年をまたぐ期間でも、月はその期間にかかる年を選ぶ
  assert.deepEqual(L.parseExclusions("1月", { from: "2026-12-01", to: "2027-02-28" }).items[0], { kind: "rule", from: "2027-01-01", to: "2027-01-31" });
});

test("対象の日：土日祝だけ・平日だけ", () => {
  const p = poll({ holidays: ["2026-12-02"] });   // 12/1(火)〜12/7(月)、12/2(水) が祝日
  assert.deepEqual(L.activeDates({ ...p, dayType: "weekend" }), ["2026-12-02", "2026-12-05", "2026-12-06"]);
  assert.deepEqual(L.activeDates({ ...p, dayType: "weekday" }), ["2026-12-01", "2026-12-03", "2026-12-04", "2026-12-07"]);
  assert.equal(L.activeDates({ ...p, dayType: "all" }).length, 7);
});

test("除外の一覧を貼り付けの形に戻す（読み直すと同じになる）", () => {
  const P = { from: "2026-12-01", to: "2027-02-28" };
  const text = "12/24 クリスマス\n1/1-1/15\n1月 平日\n月 水\n月 水 祝\n祝\n平日 9:00-18:00\n土日祝 22:00-23:00\n12/12 18:00-23:00 別のライブ\n毎日 0:00-9:00\n毎日";
  const { items } = L.parseExclusions(text, P);
  assert.equal(items.length, 11);
  assert.deepEqual(L.parseExclusions(L.exclusionsText(items), P).items, items);
  // 前の形も、今の書き方に直して出す
  assert.equal(L.exclusionsText([{ kind: "date", date: "2026-12-24" }, { kind: "time", start: "09:00", end: "18:00", weekdays: [1, 2, 3, 4, 5], holiday: false }]), "12/24\n平日 09:00-18:00");
});

test("調整の設定の確かめ", () => {
  assert.deepEqual(L.validatePoll(poll()), []);
  assert.ok(L.validatePoll(poll({ title: " " })).length);
  assert.ok(L.validatePoll(poll({ from: "2026-12-10", to: "2026-12-01" })).length);
  assert.ok(L.validatePoll(poll({ from: "2026-01-01", to: "2026-12-01" })).length);   // 3か月より長い
  assert.ok(L.validatePoll(poll({ dayStart: "09:10" })).length);
  assert.ok(L.validatePoll(poll({ durations: [] })).length);
});

const people = [
  { name: "アキ", days: { "2026-12-05": { sure: ["13:00-18:00"] }, "2026-12-06": { sure: ["10:00-12:00"] } } },
  { name: "ベン", days: { "2026-12-05": { sure: ["14:00-17:00"], maybe: ["17:00-19:00"] }, "2026-12-06": { sure: ["10:00-12:00"] } } },
  { name: "チカ", days: { "2026-12-05": { sure: ["14:00-16:00"], maybe: ["16:00-17:00"] }, "2026-12-06": { ng: true, sure: ["10:00-12:00"] } } },
];

test("重なりの表：参加できる・調整が必要・参加不可", () => {
  const g = L.grid(poll(), people);
  assert.deepEqual(g["2026-12-05"][840].sure, ["アキ", "ベン", "チカ"]);
  assert.deepEqual(g["2026-12-05"][960].maybe, ["チカ"]);
  assert.deepEqual(g["2026-12-06"][600].sure, ["アキ", "ベン"]);   // チカは参加不可の日
});

test("よい枠：全員そろう枠が先、近い枠はまとめる", () => {
  const w = L.bestWindows(poll(), people, 120);
  assert.equal(w[0].date, "2026-12-05");
  assert.equal(L.fmtMin(w[0].start), "14:00");
  assert.deepEqual(w[0].sure, ["アキ", "ベン", "チカ"]);
  // 3時間なら、チカは 16-17 が「調整が必要」
  const w3 = L.bestWindows(poll(), people, 180);
  assert.equal(L.fmtMin(w3[0].start), "14:00");
  assert.deepEqual(w3[0].sure, ["アキ", "ベン"]);
  assert.deepEqual(w3[0].maybe, ["チカ"]);
  // 同じ日の開始が近い枠は並ばない
  const same = w.filter(x => x.date === "2026-12-05");
  for (let i = 1; i < same.length; i++) assert.ok(Math.abs(same[i].start - same[0].start) >= 120);
});

test("よい枠：除外した時間には出さない（答えは残る）", () => {
  const p = poll({ exclude: [{ kind: "range", date: "2026-12-05", start: "15:00", end: "16:00" }] });
  const w = L.bestWindows(p, people, 120).filter(x => x.date === "2026-12-05");
  for (const x of w) assert.ok(x.end <= 900 || x.start >= 960);
  assert.deepEqual(people[0].days["2026-12-05"].sure, ["13:00-18:00"]);
});

test("よい枠：人数が同じなら、空いている場所が多い枠を先に（場所がない枠を後に）", () => {
  // 4人とも 10〜22時ずっと参加できる日。人数だけで選ぶと 10-12・12-14・14-16 と早い順に並んでしまう
  const p = poll({ step: 60, dayStart: "10:00", dayEnd: "22:00" });
  const all = ["アキ", "ベン", "チカ", "ダイ"].map(name => ({ name, days: { "2026-12-05": { sure: ["10:00-22:00"] } } }));
  const place = (id, ...free) => ({ id, free });
  const ps = [place("A", "10:00-13:00"), place("B", "20:00-22:00"), place("C", "10:00-14:00", "17:00-22:00"),
    place("D", "20:00-22:00"), place("E", "19:00-22:00"), place("F", "10:00-12:00", "20:00-22:00")];
  const avail = { places: ps.map(x => ({ id: x.id, name: x.id })), slots: ps.map(x => ({ place: x.id, date: "2026-12-05", free: x.free })) };
  const w = L.bestWindows(p, all, 120, { avail }).slice(0, 3);
  assert.deepEqual(w.map(x => [L.fmtMin(x.start), x.places]), [["20:00", 5], ["10:00", 3], ["12:00", 1]]);
  // 場所を貼っていなければ、前と同じに早い順
  assert.deepEqual(L.bestWindows(p, all, 120).slice(0, 3).map(x => L.fmtMin(x.start)), ["10:00", "12:00", "14:00"]);
  // 人数が多い枠は、場所がなくても先（場所は人数が同じときだけ比べる）
  const fewer = [...all.slice(0, 3), { name: "ダイ", days: { "2026-12-05": { sure: ["10:00-12:00"] } } }];
  assert.equal(L.fmtMin(L.bestWindows(p, fewer, 120, { avail })[0].start), "10:00");
});

test("候補の枠の文面", () => {
  assert.equal(L.slotLine({ date: "2026-12-05", start: 840, end: 960, title: "バンド練習" }), "2026-12-05 14:00-16:00 バンド練習");
  assert.equal(L.slotLine({ date: "2026-12-05", start: "13:00", end: "15:00", title: "練習", place: "スタジオA" }), "2026-12-05 13:00-15:00 練習 @スタジオA");
  assert.equal(L.fmtDuration(90), "1時間30分");
});

test("1時間刻み：時間帯は1時間に丸める", () => {
  assert.deepEqual(L.rangesToText(L.parseRanges("13:30-16:30", 60)), ["14:00-16:00"]);
  assert.deepEqual([...L.slotSet(L.parseRanges("10:00-12:00", 60), 60)], [600, 660]);
  assert.deepEqual(L.rangesToText(L.slotsToRanges(new Set([600, 660, 780]), 60)), ["10:00-12:00", "13:00-14:00"]);
});

test("1時間刻み：1日の枠・設定の確かめ", () => {
  assert.deepEqual(L.daySlots(poll({ step: 60, dayStart: "18:00", dayEnd: "22:00" })), [1080, 1140, 1200, 1260]);
  assert.equal(L.stepOf({}), 30);
  assert.equal(L.stepOf({ step: 60 }), 60);
  assert.deepEqual(L.validatePoll(poll({ step: 60 })), []);
  assert.ok(L.validatePoll(poll({ step: 60, dayStart: "09:30" })).length);   // 範囲が1時間刻みでない
  assert.ok(L.validatePoll(poll({ step: 60, durations: [90] })).length);    // 長さが1時間刻みでない
  assert.ok(L.validatePoll(poll({ step: 15 })).length);
});

test("1時間刻み：30分の答えは1時間に丸めて数える。よい枠も1時間ごと", () => {
  const p = poll({ step: 60 });
  const ppl = [
    { name: "アキ", days: { "2026-12-05": { sure: ["13:30-18:00"] } } },
    { name: "ベン", days: { "2026-12-05": { sure: ["14:00-17:30"] } } },
  ];
  const g = L.grid(p, ppl);
  assert.deepEqual(g["2026-12-05"][780].sure, []);            // 13:00 の枠はアキも入らない（13:30から）
  assert.deepEqual(g["2026-12-05"][840].sure, ["アキ", "ベン"]);
  assert.equal(g["2026-12-05"][870], undefined);              // 14:30 の枠はない
  const w = L.bestWindows(p, ppl, 120);
  assert.equal(L.fmtMin(w[0].start), "14:00");
  assert.equal(w[0].sure.length, 2);
  assert.ok(w.every(x => x.start % 60 === 0));
});

test("除外の時間帯は、少しでもかかる枠を外す", () => {
  const p = poll({ step: 60, exclude: [{ kind: "range", date: "2026-12-05", start: "18:30", end: "23:00" }] });
  const ex = L.excludedOn(p, "2026-12-05");
  assert.equal(ex.slots.has(1020), false);
  assert.equal(ex.slots.has(1080), true);    // 18:00 の枠は 18:30 からの除外がかかるので外す
  assert.equal(ex.slots.has(1320), true);
  assert.equal(L.excludedOn({ ...p, step: 30 }, "2026-12-05").slots.has(1080), false);   // 30分刻みなら 18:00 の枠は残る
});

test("共有の文面：アイコン・名前・期間・URL", () => {
  assert.equal(L.shareText({ emoji: "🎸", title: "12月の練習", from: "2026-12-01", to: "2026-12-14", url: "https://komadori.web.app/p/x" }),
    "🎸 12月の練習\n日程調整です。12/1(火)〜12/14(月)で空いている時間を回答してください\nhttps://komadori.web.app/p/x");
  assert.equal(L.shareText({ title: "飲み会", from: "2026-12-01", to: "2026-12-01", url: "u" }).split("\n")[0], "飲み会");
});

test("呼びたい人の貼り付け：* は必須、空行・同じ名前は飛ばす", () => {
  assert.deepEqual(L.parseInvited("*アキ\nベン\n\n ＊ チカ \nベン"), [
    { name: "アキ", required: true }, { name: "ベン", required: false }, { name: "チカ", required: true }]);
  assert.equal(L.invitedText([{ name: "アキ", required: true }, { name: "ベン", required: false }]), "*アキ\nベン");
});

test("回答の状況：回答した人・まだの人・一覧にいない人・必須", () => {
  const st = L.answerStatus({ invited: L.parseInvited("*アキ\nベン\nチカ") }, [{ name: "アキ" }, { name: "ダイ" }]);
  assert.deepEqual(st.answered, ["アキ"]);
  assert.deepEqual(st.pending, ["ベン", "チカ"]);
  assert.deepEqual(st.others, ["ダイ"]);
  assert.deepEqual(st.required, ["アキ"]);
  assert.equal(st.invited, 3);
});

test("よい枠：必須の人が来られない枠は出さない（調整が必要なら出す）", () => {
  const w = L.bestWindows(poll(), people, 120, { required: ["チカ"] });
  for (const x of w) assert.ok(x.sure.includes("チカ") || x.maybe.includes("チカ"));
  assert.ok(w.length > 0);
  assert.equal(L.bestWindows(poll(), people, 120, { required: ["いない人"] }).length, 0);
});

test("よい枠：最低人数より少ない枠は出さない", () => {
  const w = L.bestWindows(poll(), people, 120, { min: 3 });
  assert.ok(w.length > 0);
  assert.ok(w.every(x => x.sure.length >= 3));
  assert.equal(L.bestWindows(poll(), people, 120, { min: 4 }).length, 0);
});

const P = { from: "2026-12-01", to: "2026-12-31", step: 30 };

test("空き状況 1：1行に1つ（タブ）・メモ・URL・丸め", () => {
  const r = L.parseAvailability("スタジオA 新宿 32帖\t2026-12-05\t13:10-18:00, 19:00-22:00\n居酒屋まる\t12/5\t18:00-23:00\t4〜8人\thttps://example.com/m\nスタジオA 新宿 32帖\t12/6\t10:00-12:00", P);
  assert.equal(r.format, "lines");
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.places.map(p => p.name), ["スタジオA 新宿 32帖", "居酒屋まる"]);
  assert.equal(r.places[0].note, "32帖");
  assert.equal(r.places[1].note, "4〜8人");
  assert.equal(r.places[1].url, "https://example.com/m");
  assert.deepEqual(r.slots.find(s => s.date === "2026-12-05" && s.place === "スタジオA 新宿 32帖").free, ["13:30-18:00", "19:00-22:00"]);
});

test("空き状況 1：タブがなければ「場所 日付 時間帯」を空白で。読めない行は行番号つきで飛ばす", () => {
  const r = L.parseAvailability("会議室B 12/7 9:00-12:00 / 13:00-17:00 10人\nなにか\n会議室B 12/40 9:00-10:00", P);
  assert.deepEqual(r.slots, [{ place: "会議室B", date: "2026-12-07", free: ["09:00-12:00", "13:00-17:00"] }]);
  assert.equal(r.places[0].note, "10人");
  assert.deepEqual(r.errors.map(e => e.line), [2, 3]);
});

test("空き状況 2：表（縦長）。見出しで列を見分ける（順番は自由・カンマ区切りも）", () => {
  const r = L.parseAvailability("日付,場所,空き,グループ\n2026/12/5,スタジオA,13:00-18:00／19:00-22:00,新宿\n12/6,スタジオB,10:00-12:00,代々木", P);
  assert.equal(r.format, "long");
  assert.deepEqual(r.places.map(p => [p.name, p.group]), [["スタジオA", "新宿"], ["スタジオB", "代々木"]]);
  assert.deepEqual(r.slots[0].free, ["13:00-18:00", "19:00-22:00"]);
});

test("空き状況 3：日付×場所（横長）。グループ・URL の行、空きなしの印", () => {
  const r = L.parseAvailability("日付\tスタジオA 32帖\tスタジオB 20帖\nグループ\t新宿\t代々木\nURL\thttps://a\thttps://b\n2026-12-05\t13:00-18:00 / 19:00-22:00\t受付前\n2026-12-06\t10:00-12:00\t×", P);
  assert.equal(r.format, "wide");
  assert.deepEqual(r.places.map(p => [p.name, p.group, p.url, p.note]), [["スタジオA 32帖", "新宿", "https://a", "32帖"], ["スタジオB 20帖", "代々木", "https://b", "20帖"]]);
  assert.deepEqual(r.slots.filter(s => s.free.length).map(s => [s.place, s.date]), [["スタジオA 32帖", "2026-12-05"], ["スタジオA 32帖", "2026-12-06"]]);
  assert.deepEqual(r.errors, []);
  const bad = L.parseAvailability("日付\tA\tB\n12/40\t10:00-12:00\t10:00-12:00", P);
  assert.equal(bad.errors.length, 1);   // 読めない日付は行ごとに1回だけ知らせる
});

test("空き状況 3：avail_sheet.json（1行目が「日付」の2次元配列）も読める", () => {
  const r = L.parseAvailability(JSON.stringify([["日付", "ノア Ast（30帖）"], ["2026-12-05", "13:00-15:00"]]), P);
  assert.equal(r.format, "wide");
  assert.deepEqual(r.slots, [{ place: "ノア Ast（30帖）", date: "2026-12-05", free: ["13:00-15:00"] }]);
});

test("空き状況 4：JSON。place は id でも name でも。asOf を残す。期間の外は使わない", () => {
  const json = { format: "availability", version: 1, asOf: "2026-11-11T09:00:00+09:00",
    places: [{ id: "a32", name: "スタジオA 32帖", group: "新宿", note: "ドラム2台", url: "https://a" }],
    slots: [{ place: "a32", date: "2026-12-05", free: ["13:00-18:00"] }, { place: "スタジオA 32帖", date: "2026-12-06", free: ["10:00-12:00"] }, { place: "a32", date: "2027-02-01", free: ["10:00-12:00"] }] };
  const r = L.parseAvailability(JSON.stringify(json), P);
  assert.equal(r.asOf, "2026-11-11T09:00:00+09:00");
  assert.equal(r.places.length, 1);
  assert.equal(r.places[0].note, "ドラム2台");
  assert.deepEqual(r.slots.map(s => s.date), ["2026-12-05", "2026-12-06"]);
});

test("空き状況：日をまたぐ 22:00-26:00、1時間刻みでの丸め", () => {
  const r = L.parseAvailability("スタジオA\t12/5\t22:00-26:00\nスタジオA\t12/6\t13:30-16:30", { ...P, step: 60 });
  assert.deepEqual(r.slots.map(s => s.free), [["22:00-26:00"], ["14:00-16:00"]]);
});

test("空いている場所：枠のあいだずっと空いている場所だけ。しぼり込み", () => {
  const a = L.parseAvailability("日付\tA\tB\nグループ\t新宿\t代々木\nメモ\t32帖 ドラム2台\t20帖\n2026-12-05\t13:00-18:00\t14:00-15:00", P);
  assert.deepEqual(L.freePlaces(a, "2026-12-05", 840, 960).map(p => p.id), ["A"]);
  assert.deepEqual(L.freePlaces(a, "2026-12-05", 840, 900).map(p => p.id), ["A", "B"]);
  assert.deepEqual([...L.freeSlotsOn(a, "2026-12-05")].sort((x, y) => x - y).slice(0, 2), [780, 810]);
  assert.deepEqual(L.filterPlaces(a, { group: "代々木" }).places.map(p => p.id), ["B"]);
  assert.deepEqual(L.filterPlaces(a, { q: "ドラム" }).places.map(p => p.id), ["A"]);
});

test("回答の進み具合：参加不可も回答に数え、使わない日は数えない", () => {
  const p = poll({ exclude: [{ kind: "date", date: "2026-12-07" }] });   // 12/1〜12/6 の6日
  const ppl = [
    { name: "アキ", days: Object.fromEntries(L.dateRange("2026-12-01", "2026-12-06").map(d => [d, { sure: ["10:00-12:00"] }])) },
    { name: "ベン", days: { "2026-12-01": { ng: true }, "2026-12-02": { maybe: ["10:00-11:00"] }, "2026-12-03": { sure: [], maybe: [], note: "コメントだけ" } } },
  ];
  assert.deepEqual(L.progress(p, ppl), [{ name: "アキ", left: 0, total: 6 }, { name: "ベン", left: 4, total: 6 }]);
  assert.equal(L.answeredOn(ppl[1].days, "2026-12-03"), false);   // コメントだけは回答に数えない
});

test("場所の人数：いろいろな書き方を { min, max } に。読めない・逆さまは人数なし", () => {
  assert.deepEqual(L.normCapacity({ min: 5, max: 8 }), { min: 5, max: 8 });
  assert.deepEqual(L.normCapacity([3, 6]), { min: 3, max: 6 });
  assert.deepEqual(L.normCapacity("4〜8人"), { min: 4, max: 8 });
  assert.deepEqual(L.normCapacity("〜6人"), { max: 6 });
  assert.deepEqual(L.normCapacity("4人〜"), { min: 4 });
  assert.equal(L.normCapacity({ min: 9, max: 3 }), null);
  assert.equal(L.normCapacity({ max: "x" }), null);
  assert.equal(L.normCapacity(""), null);
  assert.equal(L.capacityLabel({ min: 5, max: 8 }), "5〜8人");
  assert.equal(L.capacityLabel({ max: 6 }), "〜6人");
});

test("場所の人数：JSON の capacity・表の「人数」列・メモの「4〜8人」を読む。なくてもよい", () => {
  const P = { from: "2026-12-01", to: "2026-12-31" };
  const j = L.parseAvailability(JSON.stringify({ format: "availability", version: 1, places: [
    { id: "a", name: "A", group: "恵比寿", capacity: { min: 5, max: 8 } }, { id: "b", name: "B", group: "赤坂" }, { id: "c", name: "C", capacity: { min: 9, max: 1 } }],
    slots: [{ place: "a", date: "2026-12-05", free: ["19:00-22:00"] }] }), P);
  assert.deepEqual(j.places.map(x => x.capacity ?? null), [{ min: 5, max: 8 }, null, null]);
  const t = L.parseAvailability("場所\t日付\t空き\t人数\nA\t12/5\t19:00-22:00\t3〜6人\nB\t12/5\t19:00-22:00\t", P);
  assert.deepEqual(t.places.map(x => x.capacity ?? null), [{ min: 3, max: 6 }, null]);
  const l = L.parseAvailability("居酒屋まる\t12/5\t18:00-23:00\t4〜8人 個室", P);
  assert.deepEqual(l.places[0].capacity, { min: 4, max: 8 });
});

test("場所の人数：候補に来られる人数に合う場所 → 人数の決まりなし → 合わない場所に分ける", () => {
  const avail = { places: [
    { id: "big", name: "大", capacity: { min: 7, max: 12 } }, { id: "mid", name: "中", capacity: { min: 5, max: 8 } },
    { id: "free", name: "決まりなし" }], slots: ["big", "mid", "free"].map(place => ({ place, date: "2026-12-05", free: ["19:00-22:00"] })) };
  const g = L.placesForWindow(avail, "2026-12-05", 1140, 1260, 5);
  assert.deepEqual([g.fit, g.unknown, g.off].map(x => x.map(p => p.id)), [["mid"], ["free"], ["big"]]);
  assert.equal(L.capacityFit({ capacity: { max: 6 } }, 6), "fit");
  assert.equal(L.capacityFit({ capacity: { min: 4 } }, 3), "off");
  assert.equal(L.capacityFit({}, 3), "unknown");
});

test("よい枠：空いている場所は、人数に合う場所と人数の決まりがない場所だけ数える", () => {
  const p = poll({ step: 60, dayStart: "18:00", dayEnd: "22:00" });
  const five = ["ア", "イ", "ウ", "エ", "オ"].map(name => ({ name, days: { "2026-12-05": { sure: ["18:00-22:00"] } } }));
  // 18-20 は大きい部屋（7人〜）だけ、20-22 は5〜8人の部屋が空いている
  const avail = { places: [{ id: "big", name: "大", capacity: { min: 7 } }, { id: "mid", name: "中", capacity: { min: 5, max: 8 } }],
    slots: [{ place: "big", date: "2026-12-05", free: ["18:00-20:00"] }, { place: "mid", date: "2026-12-05", free: ["20:00-22:00"] }] };
  const w = L.bestWindows(p, five, 120, { avail });
  assert.deepEqual(w.map(x => [L.fmtMin(x.start), x.places]), [["20:00", 1], ["18:00", 0]]);
  // 人数を書いていない場所だけなら、前と同じに数える
  const plain = { places: [{ id: "x", name: "X" }], slots: [{ place: "x", date: "2026-12-05", free: ["18:00-20:00"] }] };
  assert.equal(L.fmtMin(L.bestWindows(p, five, 120, { avail: plain })[0].start), "18:00");
});

test("場所のしぼり込み：グループはいくつでも選べる（どれかに入れば残す）", () => {
  const avail = { places: [{ id: "a", name: "A", group: "恵比寿" }, { id: "b", name: "B", group: "赤坂" }, { id: "c", name: "C", group: "新宿" }],
    slots: ["a", "b", "c"].map(place => ({ place, date: "2026-12-05", free: ["19:00-22:00"] })) };
  assert.deepEqual(L.filterPlaces(avail, { groups: ["恵比寿", "赤坂"] }).places.map(p => p.id), ["a", "b"]);
  assert.deepEqual(L.filterPlaces(avail, { groups: [] }).places.length, 3);
  assert.deepEqual(L.filterPlaces(avail, { groups: ["恵比寿", "赤坂"] }).slots.map(s => s.place), ["a", "b"]);
});

test("空き状況の時点：ISO の日時は「11/13 22:37」に。それ以外はそのまま", () => {
  assert.equal(L.fmtAsOf("2026-11-13T22:37:00+09:00"), "11/13 22:37");
  assert.equal(L.fmtAsOf("2026-11-13T13:05:00Z"), "11/13 22:05");
  assert.equal(L.fmtAsOf("2026-11-13"), "11/13");
  assert.equal(L.fmtAsOf("11/13 20:00"), "11/13 20:00");
  assert.equal(L.fmtAsOf(""), "");
});
