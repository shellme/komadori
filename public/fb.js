// Firebase の準備（手元ではエミュレーターにつなぐ）
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, signInAnonymously, onAuthStateChanged, connectAuthEmulator } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, connectFirestoreEmulator } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { getFunctions, httpsCallable, connectFunctionsEmulator } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js";
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
const functions = getFunctions(app, "asia-northeast1");
/** Cloud Functions を呼ぶ（例：call("setPlaces", {...})） */
export const call = (name, data) => httpsCallable(functions, name)(data).then(r => r.data);
if (local) {
  connectAuthEmulator(auth, "http://127.0.0.1:9109", { disableWarnings: true });
  connectFirestoreEmulator(db, "127.0.0.1", 8180);
  connectFunctionsEmulator(functions, "127.0.0.1", 5011);
}

/** 端末ごとの匿名ログイン。uid を返す（Google とつないだ人は、そのままのログインを使う） */
export const ready = new Promise((resolve, reject) => {
  const off = onAuthStateChanged(auth, u => {
    if (u) { off(); resolve(u.uid); }
    else signInAnonymously(auth).catch(reject);   // 前のログインが残っていないときだけ（残っているのに呼ぶと、Google とのつながりが外れる）
  });
});
