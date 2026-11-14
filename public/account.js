// Google との引き継ぎ（任意）。つなぐと「自分の日程調整」の一覧（管理用の鍵も）を users/{uid} に置き、ほかの端末でも開ける
import { auth, db, ready, doc, getDoc, setDoc, serverTimestamp } from "./fb.js";
import { GoogleAuthProvider, linkWithPopup, signInWithPopup, signInWithCredential, signOut } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { store } from "./ui.js";
import { mergeRecent } from "./logic.js";

const KEY = "komadori:recent";
/** つないでいる Google の情報（つないでいなければ null） */
export async function google() {
  await ready;
  return auth.currentUser?.providerData.find(p => p.providerId === "google.com") || null;
}

const userDoc = () => doc(db, "users", auth.currentUser.uid);
async function cloudList() {
  const snap = await getDoc(userDoc());
  return snap.exists() ? snap.get("recent") || [] : [];
}
const save = list => setDoc(userDoc(), { recent: list, updatedAt: serverTimestamp() });

/** 端末の一覧と Google 側の一覧を合わせる。合わせた一覧を返す（つないでいなければ端末の一覧） */
export async function syncRecent() {
  if (!(await google())) return store.get(KEY, []);
  const merged = mergeRecent(store.get(KEY, []), await cloudList());
  store.set(KEY, merged);
  await save(merged);
  return merged;
}

/** 一覧から外す（日程調整を削除したとき） */
export async function forget(id) {
  store.set(KEY, store.get(KEY, []).filter(x => x.id !== id));
  if (await google()) await save((await cloudList()).filter(x => x.id !== id));
}

/** Google とつなぐ。前にほかの端末でつないだアカウントなら、そちらでログインし直す（switched = true、ページを読み直す） */
export async function connectGoogle() {
  if (inAppBrowser()) throw Object.assign(new Error("in-app browser"), { code: "komadori/in-app" });
  await ready;
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: "select_account" });
  let switched = false;
  try {
    await linkWithPopup(auth.currentUser, provider);
  } catch (e) {
    if (e.code !== "auth/credential-already-in-use") throw e;
    const cred = GoogleAuthProvider.credentialFromError(e);
    if (cred) await signInWithCredential(auth, cred);
    else await signInWithPopup(auth, provider);   // 受け取れなかったときは、もう一度選んでもらう
    switched = true;
  }
  await syncRecent();
  return { switched };
}

/** ログアウトする。この端末の一覧も消す（Google でログインし直せば戻る） */
export async function disconnect() {
  await signOut(auth);
  store.set(KEY, []);
}

/** LINE などのアプリの中のブラウザか（Google はここでのログインを断る） */
export const inAppBrowser = () => /\bLine\/|FBAN|FBAV|Instagram/i.test(navigator.userAgent);

/** つなぐときのエラーを、画面に出す文にする（閉じただけなら空） */
export function connectError(e) {
  if (["auth/popup-closed-by-user", "auth/cancelled-popup-request", "auth/user-cancelled"].includes(e?.code)) return "";
  if (e?.code === "komadori/in-app") return "アプリの中のブラウザでは Google にログインできません。Safari や Chrome で開いてください";
  if (e?.code === "auth/popup-blocked") return "ログインの画面を開けませんでした。ポップアップを許可してください";
  if (e?.code === "auth/unauthorized-domain" || e?.code === "auth/operation-not-allowed") return "いまは Google でログインできません";
  return "Google とつなげませんでした。もう一度試してください";
}
