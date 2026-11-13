// トップと「日程調整をつくる」
import { db, ready, doc, setDoc, serverTimestamp, Timestamp } from "./fb.js";
import * as L from "./logic.js";
import { JP_HOLIDAYS } from "./holidays.js";
import { $, esc, copy, randomId, sha256, store, remember, drawEmoji, firstEmoji, toast } from "./ui.js";

const DURATIONS = [60, 120, 180];
// アイコンの候補（押して選ぶ。ほかの絵文字は横の欄に入れる）
const EMOJIS = ["🗓️", "🎸", "🎤", "🥁", "🎹", "🎵", "🍺", "🍽️", "☕", "📚", "💼", "⚽", "🎮", "✈️", "🎉"];
let emoji = EMOJIS[0];
function renderEmojis() {
  const custom = !EMOJIS.includes(emoji);
  $("#emojis").innerHTML = EMOJIS.map(e => `<button type="button" data-emoji="${e}" aria-pressed="${e === emoji}" aria-label="アイコン ${e}">${e}</button>`).join("")
    + `<input type="text" id="emojiOther" maxlength="16" placeholder="例：🏕️" aria-label="ほかの絵文字" value="${custom ? esc(emoji) : ""}">`;
  drawEmoji($("#emojis"));
}
renderEmojis();
$("#emojis").addEventListener("click", e => {
  const b = e.target.closest("[data-emoji]"); if (!b) return;
  emoji = b.dataset.emoji; renderEmojis();
});
$("#emojis").addEventListener("change", e => {
  if (e.target.id !== "emojiOther") return;
  const v = firstEmoji(e.target.value);
  if (!v) { if (e.target.value.trim()) toast("絵文字を1つ入れてください"); return; }
  emoji = v; renderEmojis();
});

const step = () => +document.querySelector("#step input:checked").value;

// 刻みに合わせて、時刻の選択肢と長さのチップを作り直す（選んでいたものはできるだけ残す）
function buildStep() {
  const st = step();
  for (const [id, def] of [["dayStart", 540], ["dayEnd", 1380]]) {
    const sel = $("#" + id), cur = L.toMin(sel.value) ?? def;
    sel.innerHTML = "";
    const pick = Math.round(cur / st) * st;
    for (let m = id === "dayStart" ? 0 : st; m <= (id === "dayStart" ? 1440 - st : 1440); m += st) {
      sel.add(new Option(L.fmtMin(m), L.fmtMin(m), false, m === pick));
    }
  }
  const was = new Set([...document.querySelectorAll("#durations input:checked")].map(i => +i.value));
  const list = DURATIONS.filter(d => d % st === 0);
  const keep = list.filter(d => was.has(d));
  $("#durations").innerHTML = list.map(d =>
    `<label><input type="checkbox" value="${d}" ${(keep.length ? keep.includes(d) : d === 120) ? "checked" : ""}>${L.fmtDuration(d)}</label>`).join("");
}
$("#step").addEventListener("change", buildStep);
buildStep();

// 期間の初期値：あしたから4週間
const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const t = new Date(); t.setDate(t.getDate() + 1);
$("#from").value = iso(t);
$("#to").value = L.addDays(iso(t), 27);

// この端末で見た日程調整
const recent = store.get("komadori:recent", []);
if (recent.length) {
  $("#recent").hidden = false;
  $("#recentList").innerHTML = recent.map(r =>
    `<li><a style="color:var(--ink);font-weight:700;text-decoration:none" href="/p/${esc(r.id)}${r.admin ? `#admin=${esc(r.admin)}` : ""}">${esc(r.emoji ? r.emoji + " " : "")}${esc(r.title)}</a> ${r.admin ? '<span class="tag dark">つくった日程調整</span>' : ""}</li>`).join("");
  drawEmoji($("#recentList"));
}

// 除外の読み取りをその場で見せる
function readExclude() {
  return L.parseExclusions($("#exclude").value, { from: $("#from").value, to: $("#to").value });
}
function showExclude() {
  const { items, errors } = readExclude();
  $("#excludePreview").innerHTML = items.map(x => `<li>除外：${esc(L.exclusionLabel(x, JP_HOLIDAYS))}</li>`).join("");
  $("#excludeErrors").innerHTML = errors.map(e => `<div>${e.line}行目「${esc(e.text)}」：${esc(e.reason)}</div>`).join("");
}
for (const id of ["exclude", "from", "to"]) $("#" + id).addEventListener("input", showExclude);

// 呼びたい人の読み取りをその場で見せる
$("#invited").addEventListener("input", () => {
  const list = L.parseInvited($("#invited").value), req = list.filter(x => x.required);
  $("#invitedPreview").textContent = list.length ? `${list.length}人${req.length ? `（必須：${req.map(x => x.name).join("、")}）` : ""}` : "";
});

$("#create").addEventListener("submit", async e => {
  e.preventDefault();
  const { items, errors: exErrors } = readExclude();
  const p = {
    title: $("#title").value.trim(), emoji, note: $("#note").value.trim(),
    from: $("#from").value, to: $("#to").value,
    dayStart: $("#dayStart").value, dayEnd: $("#dayEnd").value, step: step(),
    durations: [...document.querySelectorAll("#durations input:checked")].map(i => +i.value),
    exclude: items,
    invited: L.parseInvited($("#invited").value),
  };
  const errs = L.validatePoll(p);
  if (p.invited.length > 100) errs.push("呼びたい人は100人までです");
  if (exErrors.length) errs.push("使わない日・時間帯に読めない行があります");
  $("#errors").innerHTML = errs.map(x => `<div>${esc(x)}</div>`).join("");
  if (errs.length) return;

  $("#submit").disabled = true;
  try {
    const uid = await ready;
    const id = randomId(20), key = randomId(24);
    await setDoc(doc(db, "polls", id), {
      ...p,
      holidays: JP_HOLIDAYS.filter(d => d >= p.from && d <= p.to),
      decided: null,
      adminKeyHash: await sha256(key),
      createdAt: serverTimestamp(),
      expireAt: Timestamp.fromDate(new Date(L.addDays(p.to, 90) + "T00:00:00")),   // 期間の終わりから90日で消す（段階4）
      device: uid,
    });
    remember({ id, title: p.title, emoji, admin: key });
    const base = `${location.origin}/p/${id}`;
    $("#answerUrl").value = base;
    shareText = L.shareText({ emoji, title: p.title, from: p.from, to: p.to, url: base, holidays: JP_HOLIDAYS });
    $("#shareText").textContent = shareText; drawEmoji($("#shareText"));
    $("#share").hidden = !navigator.share;
    $("#copyShare").classList.toggle("primary", !navigator.share);   // 「送る」がない端末では、コピーが主な操作
    $("#adminUrl").value = `${base}#admin=${key}`;
    $("#openPoll").href = `/p/${id}`;
    $("#create").hidden = true; $("#intro").hidden = true; $("#recent").hidden = true;
    $("#done").hidden = false;
    scrollTo(0, 0);
  } catch (err) {
    console.error(err);
    $("#errors").textContent = "つくれませんでした。通信を確かめて、もう一度押してください。";
  } finally {
    $("#submit").disabled = false;
  }
});

let shareText = "";
$("#copyShare").addEventListener("click", () => copy(shareText, "文面をコピーしました"));
$("#share").addEventListener("click", () => navigator.share?.({ text: shareText }).catch(() => {}));

document.addEventListener("click", e => {
  const b = e.target.closest("[data-copy]");
  if (b) copy($("#" + b.dataset.copy).value);
});
