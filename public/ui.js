// 画面の小道具（ふたつの画面で使う）
export const $ = (sel, root = document) => root.querySelector(sel);
export const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export function toast(msg) {
  let el = $("#toast");
  if (!el) { el = document.createElement("div"); el.id = "toast"; el.setAttribute("role", "status"); document.body.append(el); }
  el.textContent = msg; el.classList.add("show");
  clearTimeout(el._t); el._t = setTimeout(() => el.classList.remove("show"), 2200);
}

export async function copy(text, msg = "コピーしました") {
  try { await navigator.clipboard.writeText(text); }
  catch {
    const t = document.createElement("textarea"); t.value = text; document.body.append(t); t.select();
    document.execCommand("copy"); t.remove();
  }
  toast(msg);
}

export function randomId(n) {
  const abc = "abcdefghijkmnpqrstuvwxyz23456789";
  const b = crypto.getRandomValues(new Uint8Array(n));
  return [...b].map(x => abc[x % abc.length]).join("");
}
export async function sha256(s) {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(h)].map(x => x.toString(16).padStart(2, "0")).join("");
}

// 端末に覚えておくもの（使えなくても動く）
export const store = {
  get(k, d = null) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 保存できなくても続ける */ } },
};
export function remember(poll) {
  const all = store.get("komadori:recent", []);
  const old = all.find(x => x.id === poll.id) || {};
  const list = all.filter(x => x.id !== poll.id);
  const admin = poll.admin || old.admin;
  list.unshift({ id: poll.id, title: poll.title, emoji: poll.emoji || "", ...(admin ? { admin } : {}), at: Date.now() });
  store.set("komadori:recent", list.slice(0, 20));
}

// ---------- 絵文字（Twemoji で描く。https://github.com/jdecked/twemoji 、画像は CC-BY 4.0） ----------
const TW_BASE = "https://cdn.jsdelivr.net/gh/jdecked/twemoji@15.1.0/assets/";
const tw = () => window.twemoji;
/** 絵文字1つの画像の URL（読めなければ空） */
export function emojiUrl(e) {
  if (!e || !tw()) return "";
  const code = tw().convert.toCodePoint(e.indexOf("‍") < 0 ? e.replace(/️/g, "") : e);
  return `${TW_BASE}svg/${code}.svg`;
}
/** 要素の中の絵文字を Twemoji の画像にする */
export function drawEmoji(el) {
  if (el && tw()) tw().parse(el, { base: TW_BASE, folder: "svg", ext: ".svg", className: "emoji" });
}
/** タブのアイコンを絵文字にする */
export function setFavicon(e) {
  const url = emojiUrl(e); if (!url) return;
  // 印は PNG と SVG の2つを置いているので、両方をこの絵文字にする
  document.querySelectorAll('link[rel="icon"]').forEach(l => { l.setAttribute("href", url); l.setAttribute("type", "image/svg+xml"); l.removeAttribute("sizes"); });
}
/** 入力された文字から、先頭の絵文字1つを取り出す（なければ空） */
export function firstEmoji(s) {
  const seg = new Intl.Segmenter("ja", { granularity: "grapheme" });
  for (const { segment } of seg.segment(String(s || "").trim())) return /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(segment) ? segment : "";
  return "";
}

/** 「〇〇しました［取り消す］」を6秒出す */
export function toastUndo(msg, undo) {
  toast(msg);
  const el = $("#toast");
  const b = document.createElement("button"); b.type = "button"; b.textContent = "取り消す";
  b.onclick = () => { el.classList.remove("show"); undo(); };
  el.append(b);
  clearTimeout(el._t); el._t = setTimeout(() => el.classList.remove("show"), 6000);
}

// ---------- 複数行の入力欄は、中身に合わせて高さを変える ----------
/** 1つの入力欄の高さを中身に合わせる（最低の高さは CSS の min-height） */
export function grow(t) {
  if (!t || t.tagName !== "TEXTAREA") return;
  t.style.height = "auto";
  t.style.height = `${t.scrollHeight + 3}px`;
}
/** ページの中の入力欄を全部合わせる（プログラムで中身を入れたあとに呼ぶ） */
export const growAll = (root = document) => root.querySelectorAll("textarea").forEach(grow);
document.addEventListener("input", e => grow(e.target));
addEventListener("load", () => growAll());
// 閉じていた欄を開いたときにも合わせる（閉じている間は高さが測れないため）
document.addEventListener("toggle", e => { if (e.target.open) growAll(e.target); }, true);
