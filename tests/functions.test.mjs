// Cloud Functions のテスト（エミュレーターが動いているときに：node --test tests/functions.test.mjs）
// npm run emu を別に動かしておくか、npm run test:functions で立ち上げてから実行する
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { initializeApp, deleteApp } from "firebase/app";
import { getAuth, signInAnonymously, connectAuthEmulator } from "firebase/auth";
import { getFirestore, connectFirestoreEmulator, doc, setDoc, getDoc, serverTimestamp, Timestamp } from "firebase/firestore";
import { getFunctions, connectFunctionsEmulator, httpsCallable } from "firebase/functions";

const app = initializeApp({ projectId: "demo-komadori", apiKey: "demo-key" });
const auth = getAuth(app), db = getFirestore(app), fns = getFunctions(app, "asia-northeast1");
connectAuthEmulator(auth, "http://127.0.0.1:9109", { disableWarnings: true });
connectFirestoreEmulator(db, "127.0.0.1", 8180);
connectFunctionsEmulator(fns, "127.0.0.1", 5011);
const setPlaces = httpsCallable(fns, "setPlaces");

const id = Array.from({ length: 20 }, () => "abcdefghijkmnpqrstuvwxyz23456789"[Math.random() * 32 | 0]).join("");
const KEY = "testkey0123456789abcdefg";
const avail = { asOf: "", places: [{ id: "A", name: "スタジオA", group: "", note: "", url: "" }], slots: [{ place: "A", date: "2026-12-05", free: ["13:00-18:00"] }, { place: "A", date: "2027-05-01", free: ["10:00-12:00"] }] };

after(async () => { await deleteApp(app); setTimeout(() => process.exit(0), 100).unref(); });

before(async () => {
  const { user } = await signInAnonymously(auth);
  await setDoc(doc(db, "polls", id), {
    title: "テスト", from: "2026-12-01", to: "2026-12-31", dayStart: "09:00", dayEnd: "23:00", step: 30, durations: [120],
    exclude: [], invited: [], adminKeyHash: createHash("sha256").update(KEY).digest("hex"),
    createdAt: serverTimestamp(), expireAt: Timestamp.fromDate(new Date("2027-03-31")), device: user.uid,
  });
});

test("setPlaces：鍵が正しければ保存する（期間の外の行は落とす）", async () => {
  const r = await setPlaces({ pollId: id, key: KEY, avail });
  assert.deepEqual(r.data, { ok: true, places: 1, slots: 1 });
  const snap = await getDoc(doc(db, "polls", id, "places", "current"));
  assert.deepEqual(snap.get("slots"), [{ place: "A", date: "2026-12-05", free: ["13:00-18:00"] }]);
});

test("setPlaces：人数（capacity）は正しい形だけ残す。おかしければ人数なしにする（場所は残す）", async () => {
  const places = [
    { id: "A", name: "A", group: "", note: "", url: "", capacity: { min: 5, max: 8 } },
    { id: "B", name: "B", group: "", note: "", url: "", capacity: { max: 6 } },
    { id: "C", name: "C", group: "", note: "", url: "", capacity: { min: 9, max: 3 } },
    { id: "D", name: "D", group: "", note: "", url: "", capacity: { min: "5" } },
    { id: "E", name: "E", group: "", note: "", url: "" },
  ];
  await setPlaces({ pollId: id, key: KEY, avail: { asOf: "", places, slots: [] } });
  const got = (await getDoc(doc(db, "polls", id, "places", "current"))).get("places");
  assert.deepEqual(got.map(p => p.capacity ?? null), [{ min: 5, max: 8 }, { max: 6 }, null, null, null]);
  await setPlaces({ pollId: id, key: KEY, avail });   // 元に戻す（あとのテストのため）
});

test("setPlaces：鍵がちがえば断る", async () => {
  await assert.rejects(setPlaces({ pollId: id, key: "wrong", avail }), e => e.code === "functions/permission-denied");
});

test("setPlaces：形がちがえば断る（知らない場所・時間帯の形）", async () => {
  await assert.rejects(setPlaces({ pollId: id, key: KEY, avail: { places: [], slots: [{ place: "X", date: "2026-12-05", free: ["13:00-18:00"] }] } }), e => e.code === "functions/invalid-argument");
  await assert.rejects(setPlaces({ pollId: id, key: KEY, avail: { ...avail, slots: [{ place: "A", date: "2026-12-05", free: ["1pm"] }] } }), e => e.code === "functions/invalid-argument");
});

test("setPlaces：null で消す", async () => {
  await setPlaces({ pollId: id, key: KEY, avail: null });
  assert.equal((await getDoc(doc(db, "polls", id, "places", "current"))).exists(), false);
});

const call = name => httpsCallable(fns, name);

test("updatePoll：名前・呼びたい人・使わない日を変える。期間の片方だけは断る", async () => {
  await call("updatePoll")({ pollId: id, key: KEY, patch: { title: "新しい名前", invited: [{ name: "アキ", required: true }], exclude: [{ kind: "date", date: "2026-12-24" }] } });
  const p = (await getDoc(doc(db, "polls", id))).data();
  assert.equal(p.title, "新しい名前");
  await call("updatePoll")({ pollId: id, key: KEY, patch: { dayType: "weekend", exclude: [{ kind: "rule", from: "2026-12-01", to: "2026-12-15", weekdays: [1, 2, 3, 4, 5], holiday: "skip" }] } });
  const q = (await getDoc(doc(db, "polls", id))).data();
  assert.equal(q.dayType, "weekend");
  assert.equal(q.exclude[0].holiday, "skip");
  await assert.rejects(call("updatePoll")({ pollId: id, key: KEY, patch: { dayType: "sunday" } }), e => e.code === "functions/invalid-argument");
  await assert.rejects(call("updatePoll")({ pollId: id, key: KEY, patch: { exclude: [{ kind: "rule", from: "2026-12-15", to: "2026-12-01" }] } }), e => e.code === "functions/invalid-argument");
  assert.deepEqual(p.invited, [{ name: "アキ", required: true }]);
  await assert.rejects(call("updatePoll")({ pollId: id, key: KEY, patch: { from: "2026-11-01" } }), e => e.code === "functions/invalid-argument");   // to がない
  await assert.rejects(call("updatePoll")({ pollId: id, key: KEY, patch: { title: "" } }), e => e.code === "functions/invalid-argument");
  await assert.rejects(call("updatePoll")({ pollId: id, key: "wrong", patch: { title: "x" } }), e => e.code === "functions/permission-denied");
});

test("updatePoll：期間を延ばす・縮める（祝日・消す日も変わる）。3か月より長い・逆さまは断る", async () => {
  await call("updatePoll")({ pollId: id, key: KEY, patch: { from: "2026-12-01", to: "2027-01-31", holidays: ["2027-01-01", "2027-01-11"] } });
  let p = (await getDoc(doc(db, "polls", id))).data();
  assert.equal(p.to, "2027-01-31");
  assert.deepEqual(p.holidays, ["2027-01-01", "2027-01-11"]);
  assert.equal(p.expireAt.toDate().toISOString().slice(0, 10), "2027-05-01");
  await call("updatePoll")({ pollId: id, key: KEY, patch: { from: "2026-12-05", to: "2026-12-10", holidays: [] } });
  p = (await getDoc(doc(db, "polls", id))).data();
  assert.equal(p.from, "2026-12-05");
  await assert.rejects(call("updatePoll")({ pollId: id, key: KEY, patch: { from: "2026-01-01", to: "2026-12-31", holidays: [] } }), e => e.code === "functions/invalid-argument");
  await assert.rejects(call("updatePoll")({ pollId: id, key: KEY, patch: { from: "2026-12-10", to: "2026-12-01", holidays: [] } }), e => e.code === "functions/invalid-argument");
});

test("updatePoll：1日の範囲と時間の刻みを変える。刻みに合わない範囲・刻みの値は断る", async () => {
  await call("updatePoll")({ pollId: id, key: KEY, patch: { dayStart: "08:00", dayEnd: "24:00" } });
  let p = (await getDoc(doc(db, "polls", id))).data();
  assert.deepEqual([p.dayStart, p.dayEnd], ["08:00", "24:00"]);
  await call("updatePoll")({ pollId: id, key: KEY, patch: { step: 60, dayStart: "10:00", dayEnd: "22:00" } });
  p = (await getDoc(doc(db, "polls", id))).data();
  assert.deepEqual([p.step, p.dayStart, p.dayEnd], [60, "10:00", "22:00"]);
  await assert.rejects(call("updatePoll")({ pollId: id, key: KEY, patch: { dayStart: "10:30" } }), e => e.code === "functions/invalid-argument");   // 1時間刻みに合わない
  await assert.rejects(call("updatePoll")({ pollId: id, key: KEY, patch: { step: 15 } }), e => e.code === "functions/invalid-argument");
  await assert.rejects(call("updatePoll")({ pollId: id, key: KEY, patch: { dayStart: "22:00", dayEnd: "10:00" } }), e => e.code === "functions/invalid-argument");
  await call("updatePoll")({ pollId: id, key: KEY, patch: { step: 30, dayStart: "10:30", dayEnd: "22:00" } });
  assert.equal((await getDoc(doc(db, "polls", id))).get("dayStart"), "10:30");
});

test("updatePoll：候補日を入れる（重なりを除いて並べる）。期間の外・形のちがう日は断る", async () => {
  const p0 = (await getDoc(doc(db, "polls", id))).data();
  const [a, b] = [p0.from, p0.to];
  await call("updatePoll")({ pollId: id, key: KEY, patch: { candDates: [b, a, b] } });
  assert.deepEqual((await getDoc(doc(db, "polls", id))).data().candDates, [a, b].sort());
  await call("updatePoll")({ pollId: id, key: KEY, patch: { candDates: [] } });
  assert.deepEqual((await getDoc(doc(db, "polls", id))).data().candDates, []);
  await assert.rejects(call("updatePoll")({ pollId: id, key: KEY, patch: { candDates: ["2020-01-01"] } }), e => e.code === "functions/invalid-argument");
  await assert.rejects(call("updatePoll")({ pollId: id, key: KEY, patch: { candDates: ["12/5"] } }), e => e.code === "functions/invalid-argument");
  await assert.rejects(call("updatePoll")({ pollId: id, key: KEY, patch: { candDates: "2026-12-05" } }), e => e.code === "functions/invalid-argument");
});

test("期限切れの削除：expireAt を過ぎた調整を回答ごと消す", async () => {
  const old = id.slice(0, 19) + "0";
  const { user } = { user: auth.currentUser };
  await setDoc(doc(db, "polls", old), {
    title: "古い", from: "2026-01-01", to: "2026-01-31", dayStart: "09:00", dayEnd: "23:00", step: 30, durations: [120],
    exclude: [], invited: [], adminKeyHash: "a".repeat(64),
    createdAt: serverTimestamp(), expireAt: Timestamp.fromDate(new Date("2026-05-01")), device: user.uid,
  });
  await setDoc(doc(db, "polls", old, "people", "p1"), { name: "アキ", days: {}, updatedAt: serverTimestamp(), device: user.uid });
  const r = await call("runCleanup")({});
  assert.ok(r.data.deleted >= 1);
  assert.equal((await getDoc(doc(db, "polls", old))).exists(), false);
  assert.equal((await getDoc(doc(db, "polls", old, "people", "p1"))).exists(), false);
  assert.equal((await getDoc(doc(db, "polls", id))).exists(), true);   // 期限前は残る
});

test("deletePoll：鍵が正しければ回答ごと消す", async () => {
  await assert.rejects(call("deletePoll")({ pollId: id, key: "wrong" }), e => e.code === "functions/permission-denied");
  await call("deletePoll")({ pollId: id, key: KEY });
  assert.equal((await getDoc(doc(db, "polls", id))).exists(), false);
});

test("pollPage：名前は HTML に入れても崩れない（< や $& があっても）", async () => {
  const pid = Array.from({ length: 20 }, () => "abcdefghijkmnpqrstuvwxyz23456789"[Math.random() * 32 | 0]).join("");
  await setDoc(doc(db, "polls", pid), {
    title: `<b>練習</b> $& $' 100%`, from: "2026-12-01", to: "2026-12-31", dayStart: "09:00", dayEnd: "23:00", step: 30, durations: [120],
    exclude: [], invited: [], adminKeyHash: "a".repeat(64),
    createdAt: serverTimestamp(), expireAt: Timestamp.fromDate(new Date("2027-03-31")), device: auth.currentUser.uid,
  });
  const html = await (await fetch(`http://127.0.0.1:5011/demo-komadori/asia-northeast1/pollPage/p/${pid}`)).text();
  assert.ok(html.includes(`<title>&lt;b&gt;練習&lt;/b&gt; $&amp; $&#39; 100%｜コマドリ</title>`));
  assert.ok(!html.includes("<b>練習</b>"));
});
