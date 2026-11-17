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

test("調整・回答・履歴・場所の空き状況：直接は書けない（/api から書く）。誰でも読める", async () => {
  await assertFails(setDoc(doc(as("u1"), "polls/zzzzzzzzzzzzzzzzzzzz"), pollData("u1")));
  await assertFails(updateDoc(doc(as("owner"), `polls/${P}`), { title: "x" }));
  await assertFails(deleteDoc(doc(as("owner"), `polls/${P}`)));
  await assertFails(setDoc(doc(as("dev2"), `polls/${P}/people/p2`), person("dev2")));
  await assertFails(updateDoc(doc(as("dev1"), `polls/${P}/people/p1`), { name: "x" }));
  await assertFails(deleteDoc(doc(as("dev1"), `polls/${P}/people/p1`)));
  await assertFails(setDoc(doc(as("dev2"), `polls/${P}/people/p1/log/l1`), { at: serverTimestamp(), device: "dev2", name: "アキ", dates: [] }));
  await assertFails(setDoc(doc(as("owner"), `polls/${P}/places/current`), { places: [], slots: [] }));
  await assertSucceeds(getDoc(doc(anon(), `polls/${P}/people/p1`)));
  await assertSucceeds(getDocs(collection(anon(), `polls/${P}/people`)));
  await assertSucceeds(getDocs(collection(anon(), `polls/${P}/people/p1/log`)));
  await assertSucceeds(getDoc(doc(anon(), `polls/${P}/places/current`)));
});

test("自分の日程調整の一覧（Google の引き継ぎ）：読み書きは本人だけ・決まった形だけ", async () => {
  const list = { recent: [{ id: "a".repeat(20), title: "練習", emoji: "", admin: "key", at: 1 }], updatedAt: serverTimestamp() };
  await assertSucceeds(setDoc(doc(as("u1"), "users/u1"), list));
  await assertSucceeds(getDoc(doc(as("u1"), "users/u1")));
  await assertFails(getDoc(doc(as("u2"), "users/u1")));
  await assertFails(getDoc(doc(anon(), "users/u1")));
  await assertFails(setDoc(doc(as("u2"), "users/u1"), list));
  await assertFails(setDoc(doc(as("u1"), "users/u1"), { ...list, extra: 1 }));
  await assertFails(setDoc(doc(as("u1"), "users/u1"), { recent: Array(51).fill(list.recent[0]), updatedAt: serverTimestamp() }));
  await assertFails(deleteDoc(doc(as("u1"), "users/u1")));
  await assertFails(getDocs(collection(as("u1"), "users")));
});
