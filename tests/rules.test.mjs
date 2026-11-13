// Firestore のルールのテスト：npm run test:rules（エミュレーターを立ち上げて実行。Java が必要）
import { test, before, after, beforeEach } from "node:test";
import { readFileSync } from "node:fs";
import { initializeTestEnvironment, assertSucceeds, assertFails } from "@firebase/rules-unit-testing";
import { doc, getDoc, getDocs, collection, setDoc, updateDoc, deleteDoc, serverTimestamp, Timestamp } from "firebase/firestore";

const P = "abcdefghij0123456789";   // 20文字
let env;

before(async () => {
  env = await initializeTestEnvironment({
    projectId: "demo-komadori",
    firestore: { rules: readFileSync(new URL("../firestore.rules", import.meta.url), "utf8"), host: "127.0.0.1", port: 8180 },
  });
});
after(async () => { await env?.cleanup(); });

const pollData = uid => ({
  title: "練習", note: "", from: "2026-12-01", to: "2026-12-31", dayStart: "09:00", dayEnd: "23:00", step: 30,
  durations: [120], holidays: [], exclude: [], invited: [],
  adminKeyHash: "a".repeat(64), createdAt: serverTimestamp(), expireAt: Timestamp.fromDate(new Date("2027-03-31")), device: uid,
});
const person = uid => ({ name: "アキ", note: "", days: { "2026-12-05": { sure: ["13:00-15:00"], maybe: [], ng: false, note: "" } }, updatedAt: serverTimestamp(), device: uid });

beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async ctx => {
    const db = ctx.firestore();
    await setDoc(doc(db, `polls/${P}`), { ...pollData("owner"), createdAt: new Date() });
    await setDoc(doc(db, `polls/${P}/people/p1`), { ...person("dev1"), updatedAt: new Date() });
  });
});

const as = uid => env.authenticatedContext(uid).firestore();
const anon = () => env.unauthenticatedContext().firestore();

test("調整：ID を知っていれば誰でも読める。一覧は取れない", async () => {
  await assertSucceeds(getDoc(doc(anon(), `polls/${P}`)));
  await assertFails(getDocs(collection(anon(), "polls")));
});

test("調整を作る：ログインした端末が自分を device にして作れる", async () => {
  await assertSucceeds(setDoc(doc(as("u1"), "polls/zzzzzzzzzzzzzzzzzzzz"), pollData("u1")));
});

test("調整を作る：アイコンは短い文字だけ", async () => {
  await assertSucceeds(setDoc(doc(as("u1"), "polls/zzzzzzzzzzzzzzzzzzz7"), { ...pollData("u1"), emoji: "🎸" }));
  await assertFails(setDoc(doc(as("u1"), "polls/zzzzzzzzzzzzzzzzzzz8"), { ...pollData("u1"), emoji: "x".repeat(17) }));
});

test("調整を作る：呼びたい人は100人まで", async () => {
  const many = Array.from({ length: 101 }, (_, i) => ({ name: `人${i}`, required: false }));
  await assertSucceeds(setDoc(doc(as("u1"), "polls/zzzzzzzzzzzzzzzzzzz3"), { ...pollData("u1"), invited: [{ name: "アキ", required: true }] }));
  await assertFails(setDoc(doc(as("u1"), "polls/zzzzzzzzzzzzzzzzzzz4"), { ...pollData("u1"), invited: many }));
});

test("調整を作る：期間・時刻・長さは決まった形だけ（画面に出す値なので）", async () => {
  const ng = [
    { from: "2026/12/01" },                                  // 日付の形がちがう
    { to: "2026-11-30" },                                    // 終わりが始まりより前
    { from: "2026-01-01", to: "2026-12-31" },                // 3か月より長い
    { dayStart: "<b>" },                                     // 時刻の形がちがう
    { durations: ["<img src=x onerror=alert(1)>"] },         // 長さが数でない
    { durations: [] },
    { expireAt: Timestamp.fromDate(new Date("2030-01-01")) },  // 消す日が遠すぎる
    { holidays: Array.from({ length: 41 }, () => "2026-12-01") },
  ];
  for (const [i, over] of ng.entries()) {
    await assertFails(setDoc(doc(as("u1"), `polls/zzzzzzzzzzzzzzzzzz${String(i).padStart(2, "0")}`), { ...pollData("u1"), ...over }));
  }
  await assertSucceeds(setDoc(doc(as("u1"), "polls/zzzzzzzzzzzzzzzzzzyy"), { ...pollData("u1"), from: "2026-12-01", to: "2027-03-01", expireAt: Timestamp.fromDate(new Date("2027-05-30")) }));
  await assertFails(setDoc(doc(as("u1"), "polls/ZZZZZZZZZZZZZZZZZZZZ"), pollData("u1")));   // ID は小文字と数字だけ
});

test("調整を作る：対象の日は すべて・土日祝だけ・平日だけ", async () => {
  await assertSucceeds(setDoc(doc(as("u1"), "polls/zzzzzzzzzzzzzzzzzzd1"), { ...pollData("u1"), dayType: "weekend" }));
  await assertFails(setDoc(doc(as("u1"), "polls/zzzzzzzzzzzzzzzzzzd2"), { ...pollData("u1"), dayType: "sunday" }));
});

test("調整を作る：刻みは30分か1時間だけ", async () => {
  await assertSucceeds(setDoc(doc(as("u1"), "polls/zzzzzzzzzzzzzzzzzzz6"), { ...pollData("u1"), step: 60 }));
  await assertFails(setDoc(doc(as("u1"), "polls/zzzzzzzzzzzzzzzzzzz5"), { ...pollData("u1"), step: 15 }));
});

test("調整を作る：ログインなし・device 違い・ID が短い・決定（もう使わない項目）・余計な項目はだめ", async () => {
  await assertFails(setDoc(doc(anon(), "polls/zzzzzzzzzzzzzzzzzzzz"), pollData("u1")));
  await assertFails(setDoc(doc(as("u1"), "polls/zzzzzzzzzzzzzzzzzzzz"), pollData("u2")));
  await assertFails(setDoc(doc(as("u1"), "polls/short"), pollData("u1")));
  await assertFails(setDoc(doc(as("u1"), "polls/zzzzzzzzzzzzzzzzzzzz"), { ...pollData("u1"), decided: { date: "2026-12-05" } }));
  await assertFails(setDoc(doc(as("u1"), "polls/zzzzzzzzzzzzzzzzzzzz"), { ...pollData("u1"), admin: true }));
  await assertFails(setDoc(doc(as("u1"), "polls/zzzzzzzzzzzzzzzzzzzz"), { ...pollData("u1"), title: "" }));
});

test("調整は直接は変えられない・消せない（作った端末でも）", async () => {
  await assertFails(updateDoc(doc(as("owner"), `polls/${P}`), { title: "x" }));
  await assertFails(updateDoc(doc(as("owner"), `polls/${P}`), { decided: { date: "2026-12-05" } }));
  await assertFails(deleteDoc(doc(as("owner"), `polls/${P}`)));
});

test("答える：書いた端末を必ず入れる", async () => {
  await assertSucceeds(setDoc(doc(as("dev2"), `polls/${P}/people/p2`), person("dev2")));
  await assertFails(setDoc(doc(as("dev2"), `polls/${P}/people/p3`), person("dev1")));
  const { device, ...noDevice } = person("dev2");
  await assertFails(setDoc(doc(as("dev2"), `polls/${P}/people/p4`), noDevice));
  await assertFails(setDoc(doc(anon(), `polls/${P}/people/p5`), person("x")));
});

test("答える：ほかの端末からも直せる（device は直した端末になる）。消せない", async () => {
  await assertSucceeds(updateDoc(doc(as("dev9"), `polls/${P}/people/p1`), { name: "アキ", days: {}, updatedAt: serverTimestamp(), device: "dev9" }));
  await assertFails(updateDoc(doc(as("dev8"), `polls/${P}/people/p1`), { days: {}, updatedAt: serverTimestamp() }));   // device を自分にしないまま
  await assertFails(deleteDoc(doc(as("dev1"), `polls/${P}/people/p1`)));
});

test("答える：ない調整には書けない・名前は必須・余計な項目はだめ", async () => {
  await assertFails(setDoc(doc(as("dev2"), "polls/nonexistent0000000000/people/p2"), person("dev2")));
  await assertFails(setDoc(doc(as("dev2"), `polls/${P}/people/p2`), { ...person("dev2"), name: "" }));
  await assertFails(setDoc(doc(as("dev2"), `polls/${P}/people/p2`), { ...person("dev2"), admin: true }));
});

test("場所の空き状況：誰でも読める。直接は書けない（管理用の鍵を確かめる Functions から書く）", async () => {
  await assertSucceeds(getDoc(doc(anon(), `polls/${P}/places/current`)));
  await assertFails(setDoc(doc(as("owner"), `polls/${P}/places/current`), { places: [], slots: [] }));
});

test("履歴：足すだけ（変えられない・消せない）", async () => {
  const log = { at: serverTimestamp(), device: "dev2", name: "アキ", dates: ["2026-12-05"] };
  await assertSucceeds(setDoc(doc(as("dev2"), `polls/${P}/people/p1/log/l1`), log));
  await assertFails(setDoc(doc(as("dev2"), `polls/${P}/people/p1/log/l2`), { ...log, device: "other" }));
  await assertFails(updateDoc(doc(as("dev2"), `polls/${P}/people/p1/log/l1`), { name: "x" }));
  await assertFails(deleteDoc(doc(as("dev2"), `polls/${P}/people/p1/log/l1`)));
});
