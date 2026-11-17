// Firebase の準備（手元ではエミュレーターにつなぐ）
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, signInAnonymously, onAuthStateChanged, connectAuthEmulator } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, connectFirestoreEmulator } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
export * from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const local = ["localhost", "127.0.0.1"].includes(location.hostname);
const config = local
  ? { projectId: "demo-komadori", apiKey: "demo-key", authDomain: "localhost" }
  : {
    apiKey: "AIzaSyAfjC3ooY8PEA1VvUtqnH2IlAYoVwVxQZI",
    authDomain: "komadori-app.firebaseapp.com",
    projectId: "komadori-app",
    appId: "1:212589940122:web:aac67775b694ee1f3f3e23",
    messagingSenderId: "212589940122",
  };

const app = initializeApp(config);
export const auth = getAuth(app);
export const db = getFirestore(app);
if (local) {
  connectAuthEmulator(auth, "http://127.0.0.1:9109", { disableWarnings: true });
  connectFirestoreEmulator(db, "127.0.0.1", 8180);
}

/** 端末ごとの匿名ログイン。uid を返す（Google とつないだ人は、そのままのログインを使う） */
export const ready = new Promise((resolve, reject) => {
  const off = onAuthStateChanged(auth, u => {
    if (u) { off(); resolve(u.uid); }
    else signInAnonymously(auth).catch(reject);   // 前のログインが残っていないときだけ（残っているのに呼ぶと、Google とのつながりが外れる）
  });
});

ready.catch(err => console.error(err));   // ログインできなくても、見る・保存するはできる（保存は /api から）

/** 端末の印（書いた・直した端末の記録）。ログインできていればその uid、できなければこの端末で作った ID */
function deviceId() {
  if (auth.currentUser) return auth.currentUser.uid;
  const k = "komadori:device";
  try {
    let id = localStorage.getItem(k);
    if (!id) { id = "d" + crypto.randomUUID().replace(/-/g, ""); localStorage.setItem(k, id); }
    return id;
  } catch { return "d-nostorage"; }
}

/**
 * 書き込む（/api/{op}。サイトと同じアドレスなので、広告ブロックなどで Google の通信先が止められていても届く）
 * 失敗したら code つきの Error：通信できない → unavailable、断られた → api/invalid-argument など
 */
export async function api(op, data) {
  let r;
  try {
    r = await fetch(`/api/${op}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...data, device: deviceId() }) });
  } catch (e) { throw Object.assign(new Error("通信できませんでした"), { code: "unavailable", cause: e }); }
  const j = await r.json().catch(() => null);
  if (!r.ok || !j?.ok) throw Object.assign(new Error(j?.error?.message || "うまくいきませんでした"), { code: j?.error?.code ? `api/${j.error.code}` : `http-${r.status}` });
  return j;
}
