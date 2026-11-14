// 回答する・みんなの状況（/p/{pollId}）
//   時間を入力：回答の状況の行・⚡ まとめて入力（曜日ごと）・未回答／すべて（件数）・月の切り替え・
//              歯車（マスを押したときの動き・ロック）・日ごとの ⋯（コメント・この日の入力を消す）・まとめて・× 参加不可・取り消す
//   みんなの状況：条件（集まりたい長さ・対象の日・参加できる人数・並べ方）・日ごとの人数のマス（+調整）・★ 候補・参加できない人・コメント
import { db, ready, call, doc, getDoc, setDoc, addDoc, collection, onSnapshot, serverTimestamp } from "./fb.js";
import * as L from "./logic.js";
import { JP_HOLIDAYS } from "./holidays.js";
import { $, esc, copy, saveFile, randomId, sha256, store, remember, toast, toastUndo, drawEmoji, setFavicon, firstEmoji, growAll, grow } from "./ui.js";

const pollId = location.pathname.split("/")[2] || "";
const adminKey = new URLSearchParams(location.hash.slice(1)).get("admin");
const meKey = `komadori:me:${pollId}`, viewKey = `komadori:view:${pollId}`;
const WD = "日月火水木金土";
const $$ = sel => [...document.querySelectorAll(sel)];
const isSP = () => matchMedia("(max-width:767px)").matches;

let poll, people = [];
let me = { id: store.get(meKey), name: "", days: {} };   // 回答している人（この端末で選んでいる人）
const view = { f: "all", month: "all", wd: [], ...store.get(viewKey, {}) };   // 日をしぼる（月・曜日・未回答だけ。端末に覚える）
let wasFull = null;
let avail = null;   // 場所の空き状況（places/current）
const STEP = () => L.stepOf(poll);
// 2回押しで確定するボタン：1回目はラベルを短く「本当に〜」にし、説明は横の小さい文字に出す（ボタンの幅を変えないため）
function arm(b, label, noteSel, note) {
  if (b.dataset.confirm === "1") return false;
  b.style.minWidth = `${b.offsetWidth}px`;   // 幅を変えない
  b.dataset.confirm = "1"; b.textContent = label;
  if (noteSel) { $(noteSel).textContent = note; $(noteSel).hidden = false; }
  return true;
}
function disarm(b, label, noteSel) {
  b.dataset.confirm = ""; b.textContent = label; b.style.minWidth = "";
  if (noteSel) $(noteSel).hidden = true;
}
let adminKeyOk = "";   // 確かめた管理用の鍵（管理の操作に使う）   // この調整の刻み（30分か60分）
const todayIso = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

// ---------- 読み込み ----------
async function load() {
  await ready;
  const snap = pollId.length === 20 ? await getDoc(doc(db, "polls", pollId)).catch(() => null) : null;
  $("#loading").hidden = true;
  if (!snap?.exists()) { $("#missing").hidden = false; return; }
  poll = { id: pollId, ...snap.data() };
  document.title = `${poll.title}｜コマドリ`;   // アイコンはタブの印（favicon）に出るので、題名には入れない
  setFavicon(poll.emoji);
  const isAdmin = adminKey && (await sha256(adminKey)) === poll.adminKeyHash;
  remember({ id: pollId, title: poll.title, emoji: poll.emoji, ...(isAdmin ? { admin: adminKey } : {}) });
  renderHeader(isAdmin);
  buildTpl();
  $("#poll").hidden = false;
  syncFilter(); renderDays();
  if (!isSP()) $("#planFilters").open = true;

  // 調整そのもの（設定の編集をすぐ反映。削除されたら知らせる）
  onSnapshot(doc(db, "polls", pollId), snap => {
    if (!snap.exists()) { $("#poll").hidden = true; $("#missing").hidden = false; return; }
    poll = { id: pollId, ...snap.data() };
    renderHeader(!!adminKeyOk); renderWho(); syncFilter(); buildTpl(); renderDays(); renderPlan();   // 期間が変わったら月の一覧も作り直す
  });

  onSnapshot(doc(db, "polls", pollId, "places", "current"), snap => {
    avail = snap.exists() ? snap.data() : null;
    renderPlacesNow(); renderPlaceFilters(); renderDays(); renderPlan();
  });

  onSnapshot(collection(db, "polls", pollId, "people"), qs => {
    people = qs.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => a.name.localeCompare(b.name, "ja"));
    const mine = people.find(p => p.id === me.id);
    // 入力中（名前の欄・コメント）・保存中でなければ、保存された内容を読み直す
    const typing = document.activeElement?.matches?.("#name, [data-note]");
    if (mine && !typing && !dirtyDays.size) { me = { id: mine.id, name: mine.name, days: structuredClone(mine.days || {}) }; renderDays(); }
    renderWho(); renderPlan();
  });
}

function renderHeader(isAdmin) {
  $("#title").textContent = `${poll.emoji ? poll.emoji + " " : ""}${poll.title}`; drawEmoji($("#title"));
  const dayType = poll.dayType && poll.dayType !== "all" ? `（${L.DAY_TYPES[poll.dayType]?.label || ""}）` : "";
  $("#meta").textContent = `${L.fmtDay(poll.from, poll.holidays)}〜${L.fmtDay(poll.to, poll.holidays)}${dayType}・${poll.dayStart}〜${poll.dayEnd}の間で${STEP() === 60 ? "1時間" : "30分"}刻み・${poll.durations.map(L.fmtDuration).join("／")}`;
  document.title = `${poll.title}｜コマドリ`;   // アイコンはタブの印（favicon）に出るので、題名には入れない
  setFavicon(poll.emoji);
  $("#note").textContent = poll.note || ""; $("#note").hidden = !poll.note;
  $("#excludeBox").hidden = !(poll.exclude || []).length;
  $("#excludeList").innerHTML = (poll.exclude || []).map(x => `<li>${esc(L.exclusionLabel(x, poll.holidays))}</li>`).join("");
  if (isAdmin) { $("#adminBox").hidden = false; adminKeyOk = adminKey; }
  $("#share").hidden = !navigator.share;
  const curDur = +$("#dur").value;
  $("#dur").innerHTML = poll.durations.map(d => `<option value="${d}" ${d === curDur ? "selected" : ""}>${L.fmtDuration(d)}</option>`).join("");
}

// ---------- 名前 ----------
// 名前の欄：回答している人がわかっているときは名前だけ（変える・切り替えるボタン）、まだのときは入力欄と一覧
let whoEditing = false;   // 回答中に「名前を変える」「ほかの人に切り替える」を押したとき
function renderWho() {
  if (document.activeElement !== $("#name")) $("#name").value = me.name;
  const st = L.answerStatus(poll, people);
  const known = !!me.id && people.some(p => p.id === me.id);
  const opt = p => `<option value="${esc(p.id)}" ${p.id === me.id ? "selected" : ""}>${esc(p.name)}</option>`;
  const others = people.filter(p => p.id !== me.id);
  $("#who").innerHTML = `<option value="">${others.length || st.pending.length ? "名前を選ぶ" : "（まだ誰も回答していません）"}</option>`
    + (known ? `<option value="__new">新しく回答する（別の名前で）</option>` : "")
    + (st.pending.length ? `<optgroup label="まだ回答していない人">${st.pending.map(n => `<option value="inv:${esc(n)}">${esc(n)}</option>`).join("")}</optgroup>` : "")
    + (others.length ? `<optgroup label="回答した人">${others.map(opt).join("")}</optgroup>` : "");
  $("#whoView").hidden = !known || whoEditing;
  $("#whoEdit").hidden = known && !whoEditing;
  $("#whoName").textContent = me.name;
  // 一覧は、選べる人がいるとき・切り替えるときだけ
  $("#whoPick").hidden = !(others.length || st.pending.length || known);
  $("#whoDoneRow").hidden = !whoEditing;
  $("#whoNote").textContent = whoEditing
    ? "名前を変えると、すぐに保存します。ほかの人の名前を選ぶと、その人の回答を変えられます（変えた端末は記録に残ります）"
    : "はじめての人は名前を入力してから、下の日ごとのマスで空いている時間を押して選んでください";
}
$("#renameBtn").addEventListener("click", () => { whoEditing = true; $("#whoPick").dataset.mode = "rename"; renderWho(); $("#name").focus(); $("#name").select(); });
$("#switchBtn").addEventListener("click", () => { whoEditing = true; renderWho(); $("#who").focus(); });
$("#whoDone").addEventListener("click", () => { whoEditing = false; $("#name").value = me.name; renderWho(); });
$("#who").addEventListener("change", e => {
  const v = e.target.value; if (!v) return;
  if (v === "__new") me = { id: null, name: "", days: {} };
  else if (v.startsWith("inv:")) { me = { id: null, name: v.slice(4), days: {} }; $("#name").value = me.name; }
  else { const p = people.find(x => x.id === v); me = { id: p.id, name: p.name, days: structuredClone(p.days || {}) }; }
  wasFull = null; whoEditing = false;
  renderWho(); renderDays();
  if (v === "__new") $("#name").focus();
});
const isRequired = name => (poll.invited || []).some(x => x.required && x.name === name);
// 名前を変えたら保存（すでに回答している人だけ。はじめての人は時間を押したときに保存）
$("#name").addEventListener("change", () => {
  if (me.id && $("#name").value.trim()) { save([]); whoEditing = false; renderWho(); toast("名前を変えました"); }
});

// ---------- 保存（押したら自動で） ----------
let saving = Promise.resolve();
const dirtyDays = new Set();   // 保存が終わっていない日（その間はほかの端末の内容で上書きしない）
function save(changedDates) {
  const name = $("#name").value.trim();
  if (!me.id) {
    const same = people.find(p => p.name === name);
    if (same) {
      if (!confirm(`「${name}」はもう回答しています。その回答に続けて入力しますか？`)) return;
      me = { id: same.id, name, days: { ...structuredClone(same.days || {}), ...me.days } };
    } else me.id = randomId(16);
    store.set(meKey, me.id);
  }
  me.name = name;
  changedDates.forEach(d => dirtyDays.add(d));
  // 期間の外になった日の回答も消さずに残す（期間を元に戻せば、また出る）。ただし保存できる日数（100日）を超えるときは、期間から遠い日から外す
  const dist = d => d < poll.from ? poll.from.localeCompare(d) && (Date.parse(poll.from) - Date.parse(d)) : d > poll.to ? Date.parse(d) - Date.parse(poll.to) : 0;
  const id = me.id, days = Object.fromEntries(Object.entries(me.days).sort((a, b) => dist(a[0]) - dist(b[0])).slice(0, 100));
  saving = saving.then(async () => {
    const uid = await ready;
    await setDoc(doc(db, "polls", pollId, "people", id), { name, required: isRequired(name), note: "", days, updatedAt: serverTimestamp(), device: uid });
    await addDoc(collection(db, "polls", pollId, "people", id, "log"), { at: serverTimestamp(), device: uid, name, dates: changedDates.slice(0, 100) });
    for (const d of changedDates) { const s = document.querySelector(`#days [data-date="${d}"] .saved`); if (s) s.textContent = "保存しました"; }
  }).catch(err => { console.error(err); toast("保存できませんでした。通信を確かめて、もう一度押してください"); })
    .finally(() => changedDates.forEach(d => dirtyDays.delete(d)));
  renderWho();
}

// ---------- 日ごとの状態 ----------
const slots = () => L.daySlots(poll);
function dayState(iso) {
  const d = me.days[iso] || {}, st = STEP();
  return { sure: L.slotSet(L.parseRanges(d.sure || [], st), st), maybe: L.slotSet(L.parseRanges(d.maybe || [], st), st), ng: !!d.ng, note: d.note || "" };
}
function setDayState(iso, st) {
  const day = { sure: L.rangesToText(L.slotsToRanges(st.sure, STEP())), maybe: L.rangesToText(L.slotsToRanges(st.maybe, STEP())), ng: st.ng, note: st.note };
  if (!day.sure.length && !day.maybe.length && !day.ng && !day.note) delete me.days[iso];
  else me.days[iso] = day;
}
const answeredDay = (days, iso) => { const d = days?.[iso]; return !!d && (d.ng || (d.sure || []).length > 0 || (d.maybe || []).length > 0); };
// 土日祝（W）か平日（E）か
const kindOf = iso => { const w = L.weekdayOf(iso); return w === 0 || w === 6 || poll.holidays?.includes(iso) ? "W" : "E"; };

function dateHead(iso, extra = "") {
  const d = new Date(iso + "T00:00:00"), w = d.getDay(), hol = poll.holidays?.includes(iso);
  return `<div class="dhead ${w === 0 || hol ? "sun" : w === 6 ? "sat" : ""}"><span class="big">${d.getMonth() + 1}/${d.getDate()}</span><span class="wd">${WD[w]}${hol ? "・祝" : ""}</span>${extra}</div>`;
}
// 1時間ごとの枠にまとめる：[{ h: 13, mins: [780, 810] }]（30分刻みなら :00 と :30、範囲の外の半分は null）
function hourGroups() {
  const st = STEP(), ms = new Set(slots()), out = [];
  for (const h of [...new Set(slots().map(m => Math.floor(m / 60)))]) {
    out.push({ h, mins: st === 60 ? [h * 60] : [h * 60, h * 60 + 30].map(m => ms.has(m) ? m : null) });
  }
  return out;
}
// 時間の枠を並べる。1行の時間数は、パソコンは全部（14時間まで）、スマホは 30分刻みなら4時間・1時間刻みなら7時間
function hourGrid(cls, cellHtml) {
  const gs = hourGroups(), per = STEP() === 60 ? 1 : 2;
  return `<div class="${cls}" style="--pc:${Math.min(14, gs.length)};--sp:${per === 1 ? 7 : 4};--per:${per}">${gs.map(g =>
    `<div class="hour"><span class="hl">${g.h}</span>${g.mins.map(m => m == null ? `<span class="slot gap" aria-hidden="true"></span>` : cellHtml(m)).join("")}</div>`).join("")}</div>`;
}
const short = m => m % 60 ? L.fmtMin(m).replace(/^0/, "") : String(m / 60);
const hm = m => L.fmtMin(m).replace(/^0/, "");

// まとめてのボタン：土日祝は 昼・夜・全部、平日は 夜（1日の範囲に 17時が入らないときは 全部）
function quick(iso) {
  const s = L.toMin(poll.dayStart), e = L.toMin(poll.dayEnd);
  if (!(s < 1020 && e > 1020)) return [["全部", s, e]];
  return kindOf(iso) === "W" ? [["昼", s, 1020], ["夜", 1020, e], ["全部", s, e]] : [["夜", 1020, e]];
}

// ---------- 表示する日：未回答／すべて・月 ----------
const months = () => [...new Set(L.dateRange(poll.from, poll.to).map(d => d.slice(0, 7)))];
const inMonth = iso => view.month === "all" || iso.startsWith(view.month);
const monthDates = () => L.activeDates(poll).filter(inMonth);
const WDS = [["1", "月"], ["2", "火"], ["3", "水"], ["4", "木"], ["5", "金"], ["6", "土"], ["0", "日"], ["h", "祝"]];
// その日が選んだ曜日に入るか（祝日は「祝」を選んだときにも入る）
const inWd = iso => !view.wd.length || view.wd.includes(String(L.weekdayOf(iso))) || (view.wd.includes("h") && poll.holidays?.includes(iso));
const monthLabel = m => { const y = +m.slice(0, 4); return `${y !== new Date().getFullYear() ? y + "年" : ""}${+m.slice(5)}月`; };
function syncFilter() {
  const ms = months();
  if (view.month !== "all" && !ms.includes(view.month)) view.month = "all";
  if (!Array.isArray(view.wd)) view.wd = [];
  // 曜日のボタンは、その曜日の日（祝日を除く）・祝日があるものだけ出す（使わない日に当たる曜日は押しても空振りするため）
  const active = L.activeDates(poll), hol = poll.holidays || [];
  const wds = WDS.filter(([v]) => v === "h" ? active.some(d => hol.includes(d)) : active.some(d => !hol.includes(d) && String(L.weekdayOf(d)) === v));
  view.wd = view.wd.filter(v => wds.some(([x]) => x === v));
  $("#fMonth").innerHTML = `<option value="all">すべての月</option>` + ms.map(m => `<option value="${m}">${monthLabel(m)}</option>`).join("");
  $("#fMonth").value = view.month;
  $("#fMonth").hidden = ms.length <= 1;   // 1か月だけなら月は選ばない
  $("#fWd").hidden = wds.length <= 1;
  $("#fWd").innerHTML = wds.map(([v, l]) => `<button type="button" class="wd" data-wd="${v}" aria-pressed="${view.wd.includes(v)}">${l}</button>`).join("");
  $("#inTodo").checked = view.f === "todo";
  store.set(viewKey, { f: view.f, month: view.month, wd: view.wd });
}
$("#fMonth").addEventListener("change", e => { view.month = e.target.value; syncFilter(); renderDays(); });
$("#fWd").addEventListener("click", e => {
  const b = e.target.closest("[data-wd]"); if (!b) return;
  const v = b.dataset.wd; view.wd = view.wd.includes(v) ? view.wd.filter(x => x !== v) : [...view.wd, v];
  syncFilter(); renderDays();
});
$("#inTodo").addEventListener("change", e => { view.f = e.target.checked ? "todo" : "all"; syncFilter(); renderDays(); });
$("#filterClear").addEventListener("click", () => { view.month = "all"; view.wd = []; view.f = "all"; syncFilter(); renderDays(); });

// ---------- 時間を回答 ----------
function renderDays() {
  // 使わない日は出さない（場所を取るため。どの日かは上の「使わない日・時間帯」にまとめて出ている）
  const list = L.activeDates(poll).filter(inMonth).filter(inWd)
    .filter(iso => view.f === "all" || !answeredDay(me.days, iso));
  // しぼっている間は、何を見ているかを1行で出す
  const filtered = view.month !== "all" || view.wd.length || view.f === "todo";
  $("#filterNote").hidden = !filtered;
  if (filtered) {
    const parts = [view.month !== "all" ? monthLabel(view.month) : "", view.wd.length ? WDS.filter(([v]) => view.wd.includes(v)).map(([, l]) => l).join("・") + "曜" : "", view.f === "todo" ? "未回答" : ""].filter(Boolean);
    $("#filterText").textContent = `${parts.join("・")}：${list.length}日を表示中`;
  }
  // 月が変わるところに見出し（ずらしている間も上に残る）
  const multi = months().length > 1;
  let prev = "";
  $("#days").innerHTML = list.map(iso => {
    const m = iso.slice(0, 7), head = multi && m !== prev ? `<h3 class="monthhead">${monthLabel(m)}</h3>` : "";
    prev = m; return head + dayHtml(iso);
  }).join("")
    || `<p class="empty">${view.f === "todo" && !view.wd.length && view.month === "all" ? "🎉 未回答の日はありません" : "この条件の日はありません"}</p>`;
  drawEmoji($("#days"));
  renderMeter();
}
function dayHtml(iso) {
  const ex = L.excludedOn(poll, iso);
  const st = dayState(iso), any = st.sure.size || st.maybe.size;
  const status = st.ng ? `<span class="pill ng">参加不可</span>` : any ? `<span class="pill done">回答済み</span>` : `<span class="pill todo">未回答</span>`;
  const cell = m => {
    // 回答済みの日（どこかを入れた日）の空のマスは「行けない」として数えるので、薄い「−」で見せる。まだ何も入れていない日は白いまま（未回答）
    const c = ex.slots.has(m) ? "ex" : st.sure.has(m) ? "sure" : st.maybe.has(m) ? "maybe" : any ? "no" : "none";
    const word = { ex: "使わない時間", sure: "参加できる", maybe: "調整が必要", no: "行けない", none: "未回答" }[c];
    return `<button type="button" class="slot ${c}" data-m="${m}" ${c === "ex" ? "disabled" : ""} aria-label="${L.fmtDay(iso)} ${L.fmtMin(m)}〜${L.fmtMin(m + STEP())} ${word}">${c === "maybe" ? "△" : c === "sure" ? "●" : c === "no" ? "−" : ""}</button>`;
  };
  const menu = `<details class="menu"><summary class="iconbtn" aria-label="そのほかの操作" title="そのほかの操作">⋯</summary><div class="pop">
      ${st.note ? "" : `<button type="button" class="item" data-noteopen>コメントを書く</button>`}
      ${any ? `<button type="button" class="item danger" data-clear>この日の入力を消す</button>` : ""}
      ${st.note && !any ? `<span class="sub" style="padding:8px 12px">操作はありません</span>` : ""}
    </div></details>`;
  return `<div class="card ${st.ng ? "ngday" : ""}" data-date="${iso}" style="gap:12px">
    ${dateHead(iso, `${status}<span class="saved" aria-live="polite" style="margin-left:auto"></span>${menu}`)}
    ${ex.notes.length ? `<p class="dayinfo"><b>使わない時間あり</b>：${esc(ex.notes.join("、"))}</p>` : ""}
    ${st.ng ? `<p class="sub" style="font-weight:700">この日は参加できません</p>` : hourGrid("slots", cell)}
    <div class="opts">
      ${st.ng ? "" : `<span class="k">まとめて</span>${quick(iso).map(([l, a, b]) => `<button type="button" class="btn sm" data-qa="${a}" data-qb="${b}">${l} ${short(a)}–${short(b)}</button>`).join("")}`}
      <button type="button" class="btn sm ngbtn" data-ng aria-pressed="${st.ng}">${st.ng ? "参加不可を取り消す" : "× 参加不可"}</button>
    </div>
    ${st.ng ? "" : placesForMe(iso, st)}
    <input type="text" data-note maxlength="100" value="${esc(st.note)}" placeholder="例：15時以降なら行けます" aria-label="${L.fmtDay(iso)}のコメント" ${st.note ? "" : "hidden"}>
  </div>`;
}
// 自分が入れた時間（調整が必要も含む）で、いちばん短い長さ以上つづけて使える場所
function placesForMe(iso, st) {
  if (!avail) return "";
  const mine = [...new Set([...st.sure, ...st.maybe])].sort((a, b) => a - b), need = Math.min(...poll.durations), step = STEP();
  if (mine.length * step < need) return "";
  const spans = L.slotsToRanges(new Set(mine), step).filter(([a, b]) => b - a >= need);
  const hits = (avail.places || []).map(p => {
    const free = L.slotSet(L.parseRanges((avail.slots || []).find(x => x.place === p.id && x.date === iso)?.free || [], step), step);
    const ok = spans.flatMap(([a, b]) => L.slotsToRanges(new Set([...free].filter(m => m >= a && m < b)), step)).filter(([a, b]) => b - a >= need);
    return { p, ok };
  }).filter(h => h.ok.length);
  if (!hits.length) return `<p class="sub">この時間で空いている場所はありません</p>`;
  return `<details class="quote" style="font-size:13px"><summary style="font-weight:700;color:var(--link)">この時間で空いている場所 ${hits.length}か所</summary><ul class="plain" style="margin-top:6px">${hits.slice(0, 8).map(({ p, ok }) =>
    `<li style="padding:4px 0">${placeLink(p)} <span class="font-num">${ok.map(([a, b]) => `${hm(a)}〜${hm(b)}`).join("・")}</span>${p.group ? ` <span class="sub">${esc(p.group)}</span>` : ""}</li>`).join("")}</ul></details>`;
}
const placeLink = p => p.url ? `<a href="${esc(p.url)}" target="_blank" rel="noopener" style="font-weight:700">${esc(p.name)}</a>` : `<b>${esc(p.name)}</b>`;

function rerenderDay(iso, popM) {
  const el = document.querySelector(`#days [data-date="${iso}"]`); if (!el) return;
  const t = document.createElement("div"); t.innerHTML = dayHtml(iso);
  el.replaceWith(t.firstElementChild);
  if (popM != null) document.querySelector(`#days [data-date="${iso}"] .slot[data-m="${popM}"]`)?.classList.add("pop");
  renderMeter();
}
function renderMeter() {
  const future = L.activeDates(poll).filter(d => d >= todayIso());
  const ds = future.length ? future : L.activeDates(poll);
  const left = ds.filter(d => !answeredDay(me.days, d)).length;
  $("#meter").innerHTML = !ds.length ? "" : left
    ? `<span style="white-space:nowrap">未回答 <b>${left}日</b></span><span class="sub" style="font-weight:400;white-space:nowrap"> ・ ${L.fmtDay(ds[ds.length - 1], poll.holidays)}まで</span>`
    : `<span style="color:var(--ok)">✓ 全日回答済み</span>`;
  // まとめて入力は、この画面でいちばんやってほしいことなので、いつも主な操作（ピンク）にする
  const full = ds.length > 0 && left === 0;
  if (full && wasFull === false && me.id) toast("🎉 全日回答しました");
  wasFull = full;
}

// 入れる前の確かめ（名前・ロック）
// 1つの日程調整に回答できるのは100人まで（それより多いと、スマホで結果の計算が重くなるため。目安は50人まで）
const MAX_PEOPLE = 100;
const blocked = () => {
  const name = $("#name").value.trim();
  if (!name) { toast("先に名前を入力してください"); $("#name").focus(); return true; }
  if (!me.id && !people.some(p => p.name === name) && people.length >= MAX_PEOPLE) {
    toast(`この日程調整は回答できる人数（${MAX_PEOPLE}人）に達しています。呼びかけた人に知らせてください`); return true;
  }
  return false;
};
function change(iso, fn, popM) {
  const st = dayState(iso); fn(st); setDayState(iso, st);
  rerenderDay(iso, popM);
  save([iso]);
}
const NEXT = { none: "sure", sure: "maybe", maybe: "none" };   // 押すたびに 空き → ● → △
const valueOf = (st, m) => st.sure.has(m) ? "sure" : st.maybe.has(m) ? "maybe" : "none";
const setValue = (st, m, v) => { st.sure.delete(m); st.maybe.delete(m); if (v !== "none") { st[v].add(m); st.ng = false; } };
// 歯車の「マスを押したとき」（スマホはいつも順番に切り替え）


// 押す・なぞる（パソコンはなぞったマスを最初のマスと同じにする）
let drag = null;
let tap = null;   // 指で押しはじめた位置（離したときに、ほとんど動いていなければ切り替える）
$("#days").addEventListener("pointerdown", e => {
  const c = e.target.closest(".slot:not(.ex)"); if (!c) return;
  const iso = c.closest("[data-date]").dataset.date, m = +c.dataset.m;
  if (e.pointerType !== "mouse") { tap = { iso, m, x: e.clientX, y: e.clientY }; return; }
  if (blocked()) return;
  const value = NEXT[valueOf(dayState(iso), m)];   // 押すたびに 行けない → ● → △
  drag = { iso, value, done: new Set([m]) };       // なぞったマスは最初のマスと同じにする
  change(iso, st => setValue(st, m, value), m);
  e.preventDefault();
});
$("#days").addEventListener("pointerup", e => {
  const t = tap; tap = null;
  if (!t || e.pointerType === "mouse") return;
  if (Math.hypot(e.clientX - t.x, e.clientY - t.y) > 10) return;   // ずらした（スクロールした）ときは切り替えない
  const c = document.elementFromPoint(e.clientX, e.clientY)?.closest(".slot:not(.ex)");
  if (!c || +c.dataset.m !== t.m || c.closest("[data-date]")?.dataset.date !== t.iso) return;
  if (blocked()) return;
  change(t.iso, st => setValue(st, t.m, NEXT[valueOf(dayState(t.iso), t.m)]), t.m);
});
$("#days").addEventListener("pointercancel", () => { tap = null; });
document.addEventListener("pointermove", e => {
  if (!drag) return;
  const c = document.elementFromPoint(e.clientX, e.clientY)?.closest(".slot:not(.ex)");
  if (!c || c.closest("[data-date]")?.dataset.date !== drag.iso) return;
  const m = +c.dataset.m; if (drag.done.has(m)) return;
  drag.done.add(m);
  change(drag.iso, st => setValue(st, m, drag.value), m);
});
document.addEventListener("pointerup", () => { drag = null; });

$("#days").addEventListener("click", e => {
  const card = e.target.closest("[data-date]"); if (!card) return;
  const iso = card.dataset.date, ex = L.excludedOn(poll, iso);
  if (e.target.closest("[data-noteopen]")) {
    const inp = card.querySelector("[data-note]"); inp.hidden = false;
    e.target.closest("details").open = false; e.target.closest("[data-noteopen]").remove(); inp.focus(); return;
  }
  const b = e.target.closest("[data-qa], [data-clear], [data-ng]"); if (!b) return;
  if (blocked()) { b.closest("details")?.removeAttribute("open"); return; }
  if (b.matches("[data-qa]")) {
    // まとめて：パソコンで「調整が必要にする」「空きに戻す」を選んでいればそれで、ほかは「参加できる」で入れる
    const v = "sure";
    change(iso, st => { for (let m = +b.dataset.qa; m < +b.dataset.qb; m += STEP()) if (!ex.slots.has(m)) setValue(st, m, v); });
  } else if (b.matches("[data-clear]")) {
    const before = structuredClone(me.days[iso] || null);
    change(iso, st => { st.sure.clear(); st.maybe.clear(); });
    toastUndo(`${L.fmtDay(iso)}の入力を消しました`, () => restore({ [iso]: before }));
  } else {
    change(iso, st => { st.ng = !st.ng; if (st.ng) { st.sure.clear(); st.maybe.clear(); } });
  }
});
$("#days").addEventListener("change", e => {
  if (!e.target.matches("[data-note]") || blocked()) return;
  const iso = e.target.closest("[data-date]").dataset.date;
  const st = dayState(iso); st.note = e.target.value.trim(); setDayState(iso, st); save([iso]);
});
// 日ごとの ⋯ と歯車は、外を押したら閉じる
document.addEventListener("click", e => {
  for (const d of $$("details.menu[open]")) if (!d.contains(e.target)) d.open = false;
});
// 取り消す：日ごとの前の内容に戻す
function restore(before) {
  for (const [iso, d] of Object.entries(before)) { if (d) me.days[iso] = d; else delete me.days[iso]; }
  renderDays(); save(Object.keys(before));
}


// ---------- ⚡ まとめて入力（曜日ごと：入れない／参加できる／調整が必要／参加不可、時間つき） ----------
const TPL_ROWS = [["1", "月"], ["2", "火"], ["3", "水"], ["4", "木"], ["5", "金"], ["6", "土"], ["0", "日"], ["h", "祝日"]];
const TPL_ST = [["skip", "入れない"], ["sure", "参加できる"], ["maybe", "調整が必要"], ["ng", "参加不可"]];
// 1つの曜日に、時間帯をいくつでも入れられる（例：参加できる 10〜21時 ＋ 調整が必要 9〜10時・21〜22時）。あとの時間帯が前の時間帯に上書きする
const tplStarts = () => slots(), tplEnds = () => [...slots().slice(1), L.toMin(poll.dayEnd)];
const nearOf = (v, list) => list.reduce((a, b) => Math.abs(b - v) < Math.abs(a - v) ? b : a, list[0]);
const optOf = (v, list) => list.map(x => `<option value="${x}" ${x === v ? "selected" : ""}>${L.fmtMin(x)}</option>`).join("");
// ゴミ箱の印（Lucide の trash-2）
const TRASH = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg>`;
function segHtml(l, st, a, b, first) {
  const choices = first ? TPL_ST : TPL_ST.filter(([v]) => v === "sure" || v === "maybe");
  const off = st === "skip" || st === "ng";
  return `<div class="tseg">
    <select class="tst" aria-label="${l}の入れ方">${choices.map(([v, t]) => `<option value="${v}" ${v === st ? "selected" : ""}>${t}</option>`).join("")}</select>
    <span class="tm ${off ? "off" : ""}"><select class="ta" aria-label="${l}の開始">${optOf(a, tplStarts())}</select>〜<select class="tb" aria-label="${l}の終了">${optOf(b, tplEnds())}</select></span>
    ${first ? "" : `<button type="button" class="rmseg" data-rmseg aria-label="この時間帯を消す" title="この時間帯を消す">${TRASH}</button>`}
  </div>`;
}
function buildTpl() {
  if ($("#tplDlg").open) return;   // 入力の途中は作り直さない
  $("#tplRows").innerHTML = TPL_ROWS.map(([w, l]) => {
    const we = w === "6" || w === "0" || w === "h";
    const a = nearOf(we ? 780 : 1140, tplStarts()), b = nearOf(we ? 1020 : 1320, tplEnds());
    return `<div class="tplrow" data-w="${w}" data-l="${l}"><b>${l}</b>
      <div class="segs">${segHtml(l, we ? "sure" : "skip", a, b, true)}</div>
      <button type="button" class="addseg" data-addseg ${we ? "" : "hidden"}>＋ 時間帯</button></div>`;
  }).join("");
}
$("#tplRows").addEventListener("change", e => {
  const seg = e.target.closest(".tseg"), row = e.target.closest(".tplrow"); if (!seg) return;
  const sel = seg.querySelector(".tst");
  if (e.target.matches(".ta, .tb") && (sel.value === "skip" || sel.value === "ng")) sel.value = "sure";
  const off = sel.value === "skip" || sel.value === "ng";
  seg.querySelector(".tm").classList.toggle("off", off);
  // 最初の時間帯が「入れない」「参加不可」なら、足した時間帯は使わないので隠す
  if (seg === row.querySelector(".tseg")) {
    row.querySelector("[data-addseg]").hidden = off;
    row.querySelectorAll(".tseg + .tseg").forEach(x => x.hidden = off);
  }
});
$("#tplRows").addEventListener("click", e => {
  const add = e.target.closest("[data-addseg]"), drop = e.target.closest("[data-rmseg]");
  if (add) {
    const row = add.closest(".tplrow"), last = [...row.querySelectorAll(".tseg")].pop();
    // 足す時間帯は「調整が必要」で、前の時間帯の終わりから1時間
    const b0 = +last.querySelector(".tb").value;
    const a = nearOf(b0, tplStarts()), b = nearOf(b0 + 60, tplEnds());
    row.querySelector(".segs").insertAdjacentHTML("beforeend", segHtml(row.dataset.l, "maybe", a, b, false));
  } else if (drop) drop.closest(".tseg").replaceWith();
  if (add || drop) renderTplSummary();
});
// 入れる日：今日から先の使える日（「〇月だけ」なら、その月）
const tplDays = () => {
  const all = L.activeDates(poll).filter(d => d >= todayIso());
  return document.querySelector('input[name="tplScope"]:checked').value === "month" && view.month !== "all" ? all.filter(d => d.startsWith(view.month)) : all;
};
// 平日の祝日は「祝日」の行。土日の祝日は土日の行
const rowOf = iso => { const w = L.weekdayOf(iso); return poll.holidays?.includes(iso) && w !== 0 && w !== 6 ? "h" : String(w); };
$("#tplOpen").addEventListener("click", () => {
  if (blocked()) return;
  const m = view.month !== "all";
  $("#tplMonthL").textContent = m ? `${+view.month.slice(5)}月だけ` : "表示中の月だけ";
  document.querySelector('input[name="tplScope"][value="month"]').disabled = !m;
  if (!m) document.querySelector('input[name="tplScope"][value="all"]').checked = true;
  disarm($("#tplClear"), "入力をまとめて消す", "#tplNote");
  renderTplSummary();
  $("#tplDlg").showModal();
});
$("#tplCancel").addEventListener("click", () => $("#tplDlg").close());
$("#tplClear").addEventListener("click", e => {
  const b = e.currentTarget;
  if (arm(b, "本当に消す", "#tplNote", "選んだ範囲の時間とコメントをすべて空にします。もう一度押すと消します")) return;
  const before = {};
  for (const d of tplDays()) if (me.days[d]) { before[d] = structuredClone(me.days[d]); delete me.days[d]; }
  $("#tplDlg").close();
  const n = Object.keys(before).length;
  if (!n) { toast("消す入力はありませんでした"); return; }
  renderDays(); save(Object.keys(before));
  toastUndo(`${n}日分の入力を消しました`, () => restore(before));
});
/** まとめて入力で、どの日に何を入れるか：{ fill: [{ iso, sure, maybe, ng }], kept: 回答済みなので入れない日数, overwrite: 上書きする日数 }
 *  押す前の案内（renderTplSummary）と、押したとき（submit）で同じ計算を使う */
function planTpl() {
  const over = $("#tplOver").checked;
  const rules = Object.fromEntries($$("#tplRows .tplrow").map(r => [r.dataset.w,
    [...r.querySelectorAll(".tseg:not([hidden])")].map(x => ({ st: x.querySelector(".tst").value, a: +x.querySelector(".ta").value, b: +x.querySelector(".tb").value }))]));
  const fill = [];
  let kept = 0, overwrite = 0;
  for (const iso of tplDays()) {
    const segs = rules[rowOf(iso)], head = segs?.[0];
    if (!head || head.st === "skip") continue;
    const ex = L.excludedOn(poll, iso), sure = new Set(), maybe = new Set();
    if (head.st !== "ng") for (const g of segs) {   // あとの時間帯が前の時間帯に上書きする
      for (const m of slots()) if (m >= g.a && m < g.b && !ex.slots.has(m)) { sure.delete(m); maybe.delete(m); (g.st === "sure" ? sure : maybe).add(m); }
    }
    if (head.st !== "ng" && !sure.size && !maybe.size) continue;
    if (answeredDay(me.days, iso)) { if (!over) { kept++; continue; } overwrite++; }
    fill.push({ iso, sure, maybe, ng: head.st === "ng" });
  }
  return { fill, kept, overwrite };
}
// 押す前に、何日に入れて、回答済みの日をどうするかを1行で出す（上書きするときは注意の見た目に）
function renderTplSummary() {
  const { fill, kept, overwrite } = planTpl(), el = $("#tplSummary");
  el.className = overwrite ? "warn danger" : "sub";
  el.textContent = !fill.length
    ? `入れる日はありません${kept ? `（回答済みの${kept}日はそのままです）` : ""}`
    : overwrite
      ? `${fill.length}日に入れます。うち回答済みの${overwrite}日は上書きします（入れた後に「取り消す」で戻せます）`
      : `未回答の${fill.length}日に入れます${kept ? `。回答済みの${kept}日はそのままです` : ""}`;
}
$("#tplForm").addEventListener("change", renderTplSummary);
$("#tplForm").addEventListener("submit", e => {
  e.preventDefault();
  const before = {};
  for (const { iso, sure, maybe, ng } of planTpl().fill) {
    before[iso] = structuredClone(me.days[iso] || null);
    const st = dayState(iso);
    st.sure = sure; st.maybe = maybe; st.ng = ng;
    setDayState(iso, st);
  }
  $("#tplDlg").close();
  const n = Object.keys(before).length;
  if (!n) { toast("入れる日がありませんでした（回答済みの日を変えるときは「上書きする」に）"); return; }
  renderDays(); save(Object.keys(before));
  toastUndo(`${n}日分をまとめて入れました`, () => restore(before));
});

// ---------- みんなの状況 ----------
// 名前の一覧：多いとき（7人以上）は人数と最初の3人だけ出し、押すと全員を出す（大人数でカードが縦に伸びすぎないように）
const MANY = 6;
function namesLine(label, names, style = "", cls = "") {
  if (!names.length) return "";
  if (names.length <= MANY) return `<p class="${cls}" style="${style}">${label}：${esc(names.join("、"))}</p>`;
  return `<details class="names ${cls}" style="${style}"><summary>${label} ${names.length}人（${esc(names.slice(0, 3).join("、"))} ほか）</summary><p>${esc(names.join("、"))}</p></details>`;
}
// コメント：3件まではそのまま、それより多いときはたたむ
function notesHtml(notes) {
  const one = ([n, t]) => `<p style="font-size:13px">💬 <b>${esc(n)}</b>：${esc(t)}</p>`;
  if (notes.length <= 3) return notes.map(one).join("");
  return notes.slice(0, 3).map(one).join("") + `<details class="names"><summary>ほかのコメント ${notes.length - 3}件</summary>${notes.slice(3).map(one).join("")}</details>`;
}
function renderPlan(force = false) {
  renderReqChips();
  $("#peopleCount").textContent = people.length ? `(${people.length})` : "";
  const total = people.length, dur = +$("#dur").value || poll.durations[0], kind = $("#kind").value;
  const txt = id => $(id).selectedOptions[0]?.textContent || "";
  $("#planCond").textContent = [txt("#dur"), txt("#kind"), +$("#min").value > 1 ? `${$("#min").value}人以上` : "", needed.size ? `必須：${[...needed].slice(0, 3).join("、")}${needed.size > 3 ? ` ほか${needed.size - 3}人` : ""}` : "", myPrio().size ? `優先：${[...myPrio()].slice(0, 3).join("、")}${myPrio().size > 3 ? ` ほか${myPrio().size - 3}人` : ""}` : "", avail && pgroups.size ? `場所：${[...pgroups].join("・")}` : "", avail && wide() ? "広い場所から" : "", txt("#sort")].filter(Boolean).join("・");
  const ast = L.answerStatus(poll, people);
  // 回答の状況：全部の日に回答した人・まだ残りがある人（残りの日数）・まだ回答していない人（呼びたい人の一覧から）
  const prog = L.progress(poll, people);
  const full = prog.filter(x => !x.left), partial = prog.filter(x => x.left > 0).sort((a, b) => b.left - a.left);
  const everyone = people.length + ast.pending.length;
  $("#answered").innerHTML = everyone ? `<p>全部の日に回答した人：<b style="color:var(--ink)">${full.length}/${everyone}人</b>${full.length === everyone ? "（全員そろいました🎉）" : ""}</p>`
    + namesLine("まだ残りがある人", partial.map(x => `${x.name}（残り${x.left}日）`), "font-weight:700")
    + namesLine("まだ回答していない人", ast.pending, "color:var(--ng);font-weight:700")
    + (ast.invited && ast.others.length ? namesLine("呼びたい人の一覧にいない回答", ast.others) : "") : "";
  // 誰も回答していなくても、場所の空き状況を貼っていれば日ごとのカードを出す（場所の空きを先に見られるように）
  const noAnswer = `<p class="empty">🐦 まだ誰も回答していません。回答用の URL を送ってください</p>`;
  if (!total && !avail) { $("#plan").innerHTML = noAnswer; drawEmoji($("#plan")); return; }
  const required = [...needed].filter(n => people.some(p => p.name === n)), min = +$("#min").value || 1;
  // 必須の人がまだ回答していないときは、候補を出さずに知らせる
  const notYet = [...needed].filter(n => !people.some(p => p.name === n));
  const av = avail ? L.filterPlaces(avail, { groups: [...pgroups], q: $("#pq").value }) : null;
  $("#legendFree").hidden = !av;
  $("#placesAsOfNote").hidden = !avail;
  if (avail) $("#placesAsOfNote").textContent = `📍 場所の空き状況${avail.asOf ? `：${L.fmtAsOf(avail.asOf)}時点` : ""}。予約の前に、必ずそれぞれの場所で空きを確かめてください`;
  // 優先する人が来られる枠 → 一部だけ重なる枠 → 人数 → 空いている場所の数、の順（L.compareWindows）
  $("#prioBox").hidden = $("#psortBox").hidden = !adminKeyOk;
  const priority = [...myPrio()].filter(n => people.some(p => p.name === n));
  const g = L.grid(poll, people), all = L.bestWindows(poll, people, dur, { limit: Infinity, required, priority, min, avail: av });
  const lvl = c => total ? Math.min(4, Math.ceil((c / total) * 4)) : 0;
  const days = Object.keys(g).filter(iso => kind === "all" || kindOf(iso) === kind);
  const list = days.map(iso => ({ iso, wins: all.filter(w => w.date === iso).slice(0, 3) }));
  if (total && $("#sort").value === "score") list.sort((a, b) => !a.wins[0] - !b.wins[0] || (a.wins[0] ? L.compareWindows(a.wins[0], b.wins[0]) : 0) || a.iso.localeCompare(b.iso));
  // 参加できない人：その日に回答していて、この時間が ● でも △ でもない人（その日にまだ回答していない人は分けて出す）
  const missing = w => people.filter(p => L.answeredOn(p.days, w.date)).map(p => p.name).filter(n => !w.sure.includes(n) && !w.maybe.includes(n) && !w.near?.includes(n));   // 優先する人で一部の時間だけ来られる人は、上に「一部の時間だけ」と出す
  const notYetOn = iso => [...people.filter(p => !L.answeredOn(p.days, iso)).map(p => p.name), ...ast.pending];
  $("#planNote").innerHTML = notYet.length ? `<p class="warn">必須の人のうち ${esc(notYet.join("、"))} がまだ回答していないので、その人は数えずに候補を出しています</p>` : "";
  // 候補の「文面をコピー」は、管理用の URL で開いたときだけ出す（決めて知らせる人の操作。回答する人には要らない）
  // 日程の決定はこのアプリでは記録しない（候補をしぼるところまで。決めたら文面をコピーして LINE などで知らせる）
  $("#plan").innerHTML = list.map(({ iso, wins }) => {
    const ngs = people.filter(p => p.days?.[iso]?.ng).map(p => p.name);
    // その日にまだ何も入れていない人（呼びたい人の一覧で、まだ1日も回答していない人も入れる）
    const notYetDay = [...people.filter(p => !L.answeredOn(p.days, iso)).map(p => p.name), ...ast.pending];
    const notes = people.filter(p => p.days?.[iso]?.note).map(p => [p.name, p.days[iso].note]);
    const freeM = av ? L.freeSlotsOn(av, iso, STEP()) : new Set();
    // 人数があるところだけ数字を出す（0 は出さない）
    const cells = hourGrid("heatrow", m => {
      const c = g[iso][m];
      if (c.excluded) return `<span class="slot hx" title="${L.fmtMin(m)}〜 使わない時間"></span>`;
      const cls = `h${c.sure.length ? lvl(c.sure.length) : 0}`;
      return `<span class="slot ${cls}${freeM.has(m) ? " free" : ""}" data-cell="${iso}|${m}" title="${L.fmtMin(m)}〜 参加できる${c.sure.length}人・調整が必要${c.maybe.length}人">${c.sure.length ? `<b>${c.sure.length}</b>` : ""}${c.maybe.length ? `<small class="plus">+${c.maybe.length}</small>` : ""}</span>`;
    });
    return `<div class="card" id="d-${iso}" style="gap:12px">
      ${dateHead(iso)}
      <div aria-label="時間ごとの参加人数">${cells}</div>
      <p class="sub cellinfo" aria-live="polite" hidden></p>
      ${namesLine("× 参加できない", ngs, "font-size:13px;font-weight:700;color:var(--ng)")}
      ${namesLine("未回答", notYetDay, "font-size:13px;color:var(--muted)")}
      ${notesHtml(notes)}
      <div style="display:grid;gap:8px">${wins.length ? wins.map((w, i) => `<div class="cand ${i === 0 ? "top" : ""}">
        <div class="dhead">${i === 0 ? `<span class="star">★ 候補</span>` : ""}<span class="t">${hm(w.start)}〜${hm(w.end)}</span>
          <span style="font-size:14px"><b>${w.sure.length}/${everyone}人</b>${w.maybe.length ? `<span class="sub">（調整で+${w.maybe.length}人）</span>` : ""}</span></div>
        ${prioLine(w)}
        ${av ? candPlaces(av, iso, w) : ""}
        ${namesLine(`<b style="color:var(--maybe)">△</b> 調整が必要`, w.maybe, "font-size:13px")}
        ${namesLine("この時間は参加できない", missing(w), "", "sub")}
        ${namesLine("まだ回答していない", notYetOn(w.date), "", "sub")}
        ${adminKeyOk ? `<div class="actions">
          <button type="button" class="btn sm" data-pick="${iso}|${w.start}|${w.end}" aria-pressed="${picked(iso, w.start, w.end)}">${picked(iso, w.start, w.end) ? "✓ 投稿する候補に入れた" : "投稿する候補に入れる"}</button>
        </div>` : ""}
      </div>`).join("") : total ? `<p class="sub">候補になる時間帯がありません</p>` : ""}</div>
      ${av ? placesOfDay(av, iso) : ""}
    </div>`;
  }).join("") || `<p class="empty">この条件の日はありません</p>`;
  if (!total) $("#plan").insertAdjacentHTML("afterbegin", noAnswer);
  drawEmoji($("#plan"));
  lastWins = all; lastEveryone = everyone; lastAv = av;
  lastDays = days; lastConds = { duration: dur, kindLabel: txt("#kind"), min, required, priority };
  $("#aiBox").hidden = !adminKeyOk || !total;
  renderPicks(force);
}
// ---------- 投稿する候補（管理用の URL で開いたときだけ） ----------
// 候補を選んで、LINE や Slack に貼る文面（◆候補① 日時・場所・メモ）をまとめて作る。この端末にこの日程調整ごとに覚える
const pkKey = `komadori:picks:${pollId}`;
let picks = (store.get(pkKey, []) || []).filter(x => x && L.isIso(x.date) && Number.isInteger(x.start) && Number.isInteger(x.end));
let lastWins = [], lastEveryone = 0, lastAv = null, lastDays = [], lastConds = {};
// AI に相談する用にコピー（管理用の URL だけ）。候補と場所は、いまの条件で出したもの
const brief = () => L.aiBrief({ poll, people, avail: lastAv, windows: lastWins, conds: { ...lastConds, dates: lastDays }, anonymize: $("#aiAnon").checked });
$("#aiCopy").addEventListener("click", () => copy(brief(), "AIに相談する用の文面をコピーしました"));
// 長いときは、Markdown のファイルで保存して AI に添付する
$("#aiSave").addEventListener("click", () => {
  const d = new Date(), today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  saveFile(L.briefFileName(poll.title, today), brief() + "\n");
  toast("ファイルを保存しました");
});
const savePicks = () => store.set(pkKey, picks);
const picked = (date, start, end) => picks.some(x => x.date === date && x.start === start && x.end === end);
function renderPicks(force = false) {
  const box = $("#picks");
  box.hidden = !adminKeyOk || !picks.length;
  if (box.hidden) { box.innerHTML = ""; return; }
  if (!force && box.contains(document.activeElement)) return;   // 書いている途中は描き直さない（ほかの人の回答が届いたときなど）
  box.innerHTML = `<div class="card picks" style="gap:10px"><div><b>投稿する候補 ${picks.length}件</b> <span class="sub">上から ①②…。LINE や Slack に貼る文面にします</span></div>
    ${pickCalendar()}
    <ol class="plain">${picks.map((x, i) => {
      const w = lastWins.find(v => v.date === x.date && v.start === x.start && v.end === x.end);
      const opts = lastAv && w ? fitPlaces(lastAv, x.date, w).map(p => p.name) : [];
      if (x.place && !opts.includes(x.place)) opts.unshift(x.place);
      return `<li class="pick" data-i="${i}">
        <div class="dhead"><b>${L.circled(i + 1)}</b><span class="t">${esc(L.fmtDay(x.date, poll.holidays || []))} ${hm(x.start)}〜${hm(x.end)}</span>${w ? `<span class="sub">${w.sure.length}/${lastEveryone}人${w.maybe.length ? `（+${w.maybe.length}）` : ""}</span>` : ""}</div>
        <label class="field"><span class="label">場所</span><select data-pk="place"><option value="">場所を書かない</option>${opts.map(n => `<option ${n === x.place ? "selected" : ""}>${esc(n)}</option>`).join("")}</select></label>
        <label class="field"><span class="label">メモ <span class="sub">任意。例：※今すぐ予約可</span></span><textarea data-pk="memo" rows="1" maxlength="300">${esc(x.memo || "")}</textarea></label>
        <div class="actions">${i ? `<button type="button" class="btn sm" data-pkact="up">↑ 上へ</button>` : ""}<button type="button" class="btn sm" data-pkact="del">外す</button></div>
      </li>`;
    }).join("")}</ol>
    <div class="actions"><button type="button" class="btn primary" data-pkact="copy">文面をコピー</button><button type="button" class="btn sm" data-pkact="clear">全部外す</button></div></div>`;
  growAll(box);
}
// 投稿する候補を月のカレンダーに置く（練習の間隔・頻度をつかむため）。候補の日は ①② を出し、押すとその日へ
function pickCalendar() {
  const hol = poll.holidays || [], byDay = new Map();
  picks.forEach((x, i) => byDay.set(x.date, [...(byDay.get(x.date) || []), i + 1]));
  const head = [...WD].map((w, i) => `<span class="pc-h ${i === 0 ? "sun" : i === 6 ? "sat" : ""}">${w}</span>`).join("");
  return `<div class="pcal">${L.monthCalendar(poll.from, poll.to).map(({ ym, weeks }) => `<div class="pc-m"><b>${+ym.slice(5)}月</b><div class="pc-g">${head}${weeks.flat().map(iso => {
    if (!iso) return `<span></span>`;
    const w = L.weekdayOf(iso), cls = [iso < poll.from || iso > poll.to || L.excludedOn(poll, iso).all ? "out" : "",   // 期間の外・対象でない日は薄く
       w === 0 || hol.includes(iso) ? "sun" : w === 6 ? "sat" : ""].filter(Boolean).join(" ");
    const n = byDay.get(iso), d = +iso.slice(8);
    return n ? `<a class="pc-d on" href="#d-${iso}" data-goto="d-${iso}" title="候補${n.map(L.circled).join("")}"><span>${d}</span><small>${n.map(L.circled).join("")}</small></a>`
      : `<span class="pc-d ${cls}"><span>${d}</span></span>`;
  }).join("")}</div></div>`).join("")}</div>`;
}
$("#picks").addEventListener("input", e => {
  const li = e.target.closest("[data-i]"), k = e.target.dataset.pk; if (!li || !k) return;
  picks[+li.dataset.i][k] = e.target.value; savePicks();
  if (k === "memo") grow(e.target);
});
$("#picks").addEventListener("click", e => {
  // カレンダーの日：URL の # を変えずにその日へ（管理用の URL の #admin=… を消さないように）
  const go = e.target.closest("a[data-goto]");
  if (go) { e.preventDefault(); document.getElementById(go.dataset.goto)?.scrollIntoView({ behavior: "smooth", block: "start" }); return; }
  const b = e.target.closest("[data-pkact]"); if (!b) return;
  const act = b.dataset.pkact, i = +b.closest("[data-i]")?.dataset.i;
  if (act === "copy") { copy(L.postText(picks, poll.holidays || []), "文面をコピーしました"); return; }
  if (act === "up") [picks[i - 1], picks[i]] = [picks[i], picks[i - 1]];
  if (act === "del") picks.splice(i, 1);
  if (act === "clear") { const before = picks; picks = []; savePicks(); renderPlan(true); toastUndo("投稿する候補を全部外しました", () => { picks = before; savePicks(); renderPlan(true); }); return; }
  savePicks(); renderPlan(true);
});
// 候補の枠に空いている場所：人数に合う場所 → 人数の決まりがない場所 → 広めの場所の順。入りきらない場所は数だけ出す
// 人数は、その枠に来られる人（参加できる＋調整が必要）
// 「広い順」を選んでいれば、人数に合うかに関わらず広い場所から（遠くから来る人がいる日など）
const usablePlaces = g => wide() ? L.widestFirst([...g.fit, ...g.unknown, ...g.roomy]) : [...g.fit, ...g.unknown, ...g.roomy];
const fitPlaces = (av, iso, w) => usablePlaces(L.placesForWindow(av, iso, w.start, w.end, w.sure.length + w.maybe.length));
function candPlaces(av, iso, w) {
  const n = w.sure.length + w.maybe.length, g = L.placesForWindow(av, iso, w.start, w.end, n), list = usablePlaces(g);
  const roomy = new Set(g.roomy);
  const small = g.small.length ? `<span class="sub"> ${n}人には狭い場所 ${g.small.length}か所</span>` : "";
  if (list.length) return `<p style="font-size:14px">📍 ${list.slice(0, 3).map(p => placeLink(p) + capTag(p, roomy.has(p))).join("・")}${list.length > 3 ? `<span class="sub"> ほか${list.length - 3}か所</span>` : ""}${small}</p>`;
  return `<span class="pill todo" style="width:fit-content">${g.small.length ? `${n}人が入れる場所なし` : "空いている場所なし"}</span>${small ? `<p class="sub" style="margin:0">${small}</p>` : ""}`;
}
// 人数（「5〜8人」）。広めの場所には「広め」を足す
const capTag = (p, roomy = false) => p.capacity ? ` <span class="sub">${esc(L.capacityLabel(p.capacity))}${roomy ? "・広め" : ""}</span>` : "";

// その日に空いている場所の一覧（場所ごとの空き時間）。回答がなくても出す
// 優先する人のようす：● 来られる・△ 調整が必要・一部の時間だけ・来られない
function prioLine(w) {
  const names = [...myPrio()].filter(n => people.some(p => p.name === n));
  if (!names.length) return "";
  const one = n => w.sure.includes(n) ? `<span class="pill done">● ${esc(n)}</span>`
    : w.maybe.includes(n) ? `<span class="pill maybe">△ ${esc(n)}</span>`
    : w.near?.includes(n) ? `<span class="pill gray">${esc(n)}：一部の時間だけ</span>`
    : `<span class="pill todo">${esc(n)}：来られない</span>`;
  return `<p class="chips" style="gap:6px">${names.map(one).join("")}</p>`;
}
function placesOfDay(av, iso) {
  const step = STEP(), s0 = L.toMin(poll.dayStart), e0 = L.toMin(poll.dayEnd), ex = L.excludedOn(poll, iso).slots;
  const rows = (av.places || []).map(p => {
    const sl = (av.slots || []).find(x => x.place === p.id && x.date === iso);
    // 1日の範囲と使わない時間を除いた空き
    const free = new Set([...L.slotSet(L.parseRanges(sl?.free || [], step), step)].filter(m => m >= s0 && m < e0 && !ex.has(m)));
    return { p, ranges: L.slotsToRanges(free, step) };
  }).filter(r => r.ranges.length);
  if (!rows.length) return `<p class="sub">📍 この日に空いている場所はありません</p>`;
  return `<details class="placesday" ${people.length ? "" : "open"}><summary>📍 この日に空いている場所 ${rows.length}か所</summary><ul class="plain">${rows.map(({ p, ranges }) =>
    `<li>${placeLink(p)} <span class="font-num">${ranges.map(([a, b]) => `${hm(a)}〜${hm(b)}`).join("・")}</span>${capTag(p)}${p.note && !p.name.includes(p.note) ? ` <span class="sub">${esc(p.note)}</span>` : ""}${p.group ? ` <span class="tag">${esc(p.group)}</span>` : ""}</li>`).join("")}</ul></details>`;
}
for (const id of ["#dur", "#kind", "#sort", "#min"]) $(id).addEventListener("change", renderPlan);
// 場所の並べ方（人数に合う順・広い順）。この端末にこの日程調整ごとに覚える
const psKey = `komadori:psort:${pollId}`;
const wide = () => !!adminKeyOk && $("#psort").value === "wide";
$("#psort").value = store.get(psKey, "fit") === "wide" ? "wide" : "fit";
$("#psort").addEventListener("change", () => { store.set(psKey, $("#psort").value); renderPlan(); });
$("#pq").addEventListener("input", renderPlan);
// 場所のグループ：押して選ぶ（いくつでも）。この端末にこの日程調整ごとに覚える
const pgKey = `komadori:pgroups:${pollId}`;
let pgroups = new Set(store.get(pgKey, []));
function renderPlaceFilters() {
  $("#placeFilters").hidden = !avail;
  const groups = [...new Set((avail?.places || []).map(p => p.group).filter(Boolean))];
  pgroups = new Set([...pgroups].filter(g => groups.includes(g)));   // 貼り直してなくなったグループは外す
  $("#pgroups").innerHTML = groups.map(g => `<button type="button" class="tchip" data-pg="${esc(g)}" aria-pressed="${pgroups.has(g)}">${esc(g)}</button>`).join("");
  $("#pgroupBox").hidden = groups.length <= 1;
}
$("#pgroups").addEventListener("click", e => {
  const b = e.target.closest("[data-pg]"); if (!b) return;
  const g = b.dataset.pg; pgroups.has(g) ? pgroups.delete(g) : pgroups.add(g);
  store.set(pgKey, [...pgroups]);
  renderPlaceFilters(); renderPlan();
});

// ---------- 管理：設定を編集・削除 ----------
$("#openEdit").addEventListener("click", () => {
  $("#edFrom").value = poll.from; $("#edTo").value = poll.to;
  document.querySelector(`input[name="edStep"][value="${STEP()}"]`).checked = true;
  document.querySelector(`input[name="edDayType"][value="${L.DAY_TYPES[poll.dayType] ? poll.dayType : "all"}"]`).checked = true;
  buildEdTimes(poll.dayStart, poll.dayEnd);
  $("#edTitle").value = poll.title; $("#edEmoji").value = poll.emoji || ""; $("#edNote").value = poll.note || "";
  $("#edInvited").value = L.invitedText(poll.invited); $("#edExclude").value = L.exclusionsText(poll.exclude);
  $("#edDur").innerHTML = [60, 120, 180].filter(d => d % STEP() === 0).map(d => `<label><input type="checkbox" value="${d}" ${poll.durations.includes(d) ? "checked" : ""}>${L.fmtDuration(d)}</label>`).join("");
  $("#edErrors").textContent = "";
  disarm($("#pollDel"), "この日程調整を削除", "#editNote");
  $("#editDlg").showModal(); growAll($("#editDlg"));
});
// ダイアログの「やめる」
document.addEventListener("click", e => { const b = e.target.closest("[data-close]"); if (b) b.closest("dialog").close(); });
// 設定の編集：刻みに合わせて1日の範囲の選択肢を作る（選んでいた時刻はできるだけ残す）
const edStep = () => +document.querySelector('input[name="edStep"]:checked').value;
function buildEdTimes(ds, de) {
  const st = edStep();
  for (const [id, cur, first, last] of [["#edDayStart", ds, 0, 1440 - st], ["#edDayEnd", de, st, 1440]]) {
    const pick = Math.round(L.toMin(cur) / st) * st;
    $(id).innerHTML = "";
    for (let m = first; m <= last; m += st) $(id).add(new Option(L.fmtMin(m), L.fmtMin(m), false, m === pick));
  }
}
$("#edStep").addEventListener("change", () => buildEdTimes($("#edDayStart").value, $("#edDayEnd").value));

/** 1日の範囲・刻みを変えたときに、回答がどうなるかを人が読める文にする（なければ空） */
function timeChangeNotes(step, ds, de) {
  const s0 = L.toMin(ds), e0 = L.toMin(de), notes = [];
  const inPeriod = d => d >= poll.from && d <= poll.to;
  const hidden = new Set(), rounded = new Set();
  for (const p of people) for (const [d, day] of Object.entries(p.days || {})) {
    if (!inPeriod(d) || day.ng) continue;
    const ranges = L.parseRanges([...(day.sure || []), ...(day.maybe || [])]);
    if (ranges.some(([a, b]) => a < s0 || b > e0)) hidden.add(p.name);
    if (step === 60 && ranges.some(([a, b]) => a % 60 || b % 60)) rounded.add(p.name);
  }
  if (hidden.size) notes.push(`${hidden.size}人の回答のうち、新しい1日の範囲の外の時間は出なくなります（回答は消えません）`);
  if (rounded.size) notes.push(`${rounded.size}人の回答に30分の区切りがあり、1時間に丸めて数えます。その人が回答を保存し直すと、30分の細かさは戻せません`);
  return notes;
}

$("#edSave").addEventListener("click", async () => {
  const ex = L.parseExclusions($("#edExclude").value, poll);
  const patch = {
    title: $("#edTitle").value.trim(), emoji: firstEmoji($("#edEmoji").value), note: $("#edNote").value.trim(),
    durations: [...document.querySelectorAll("#edDur input:checked")].map(i => +i.value),
    invited: L.parseInvited($("#edInvited").value), exclude: ex.items,
    dayType: document.querySelector('input[name="edDayType"]:checked')?.value || "all",
  };
  const errs = [];
  // 期間：変えたときだけ送る
  const from = $("#edFrom").value, to = $("#edTo").value;
  if (from !== poll.from || to !== poll.to) {
    const pe = L.validatePoll({ ...poll, from, to }).filter(x => /期間/.test(x));
    errs.push(...pe);
    if (!pe.length) {
      // 縮めて回答のある日が期間の外になるときは知らせる
      const out = new Set(), who = new Set();
      for (const p of people) for (const d of Object.keys(p.days || {}))
        if (d >= poll.from && d <= poll.to && (d < from || d > to) && answeredDay(p.days, d)) { out.add(d); who.add(p.name); }
      if (out.size && !confirm(`${who.size}人の回答がある ${out.size}日分が期間の外になり、画面に出なくなります（回答は消えず、期間を元に戻せばまた出ます）。保存しますか？`)) return;
      Object.assign(patch, { from, to, holidays: JP_HOLIDAYS.filter(d => d >= from && d <= to) });
    }
  }
  // 1日の範囲・刻み：変えたときだけ送る
  const step = edStep(), ds = $("#edDayStart").value, de = $("#edDayEnd").value;
  if (step !== STEP() || ds !== poll.dayStart || de !== poll.dayEnd) {
    if (L.toMin(de) <= L.toMin(ds)) errs.push("1日の範囲は、終わりを始まりより後にしてください");
    else {
      const notes = timeChangeNotes(step, ds, de);
      if (notes.length && !confirm(notes.join("\n") + "\n\n保存しますか？")) return;
      Object.assign(patch, { step, dayStart: ds, dayEnd: de });
    }
  }
  if (!patch.title) errs.push("名前を入れてください");
  if (!patch.durations.length) errs.push("長さを1つ以上選んでください");
  if (ex.errors.length) errs.push(...ex.errors.map(e => `使わない日・時間帯の${e.line}行目「${e.text}」：${e.reason}`));
  $("#edErrors").innerHTML = errs.map(x => `<div>${esc(x)}</div>`).join("");
  if (errs.length) return;
  $("#edSave").disabled = true;
  try { await call("updatePoll", { pollId, key: adminKeyOk, patch }); toast("設定を保存しました"); $("#editDlg").close(); }
  catch (err) { console.error(err); $("#edErrors").textContent = err.message || "保存できませんでした"; }
  finally { $("#edSave").disabled = false; }
});
$("#pollDel").addEventListener("click", async e => {
  const b = e.currentTarget;
  if (arm(b, "本当に削除", "#editNote", "回答・場所の空き状況もすべて消え、戻せません。もう一度押すと削除します")) return;
  b.disabled = true;
  try {
    await call("deletePoll", { pollId, key: adminKeyOk });
    store.set("komadori:recent", store.get("komadori:recent", []).filter(x => x.id !== pollId));
    location.href = "/";
  } catch (err) { console.error(err); toast("削除できませんでした"); b.disabled = false; }
});

// ---------- 管理：場所の空き状況を貼る ----------
let parsed = null;
function renderPlacesNow() {
  $("#placesNow").textContent = avail ? `${avail.places.length}か所` : "なし";
  $("#placesNowDlg").textContent = avail ? `いま ${avail.places.length}か所を貼っています${avail.asOf ? `（${L.fmtAsOf(avail.asOf)}時点）` : ""}。貼り直すと置きかわります` : "まだ貼っていません";
  $("#placesDel").hidden = !avail;
}
const FORMAT = { lines: "1行に1つ", long: "表（縦長）", wide: "表（日付×場所）", json: "JSON" };
function readPlaces() {
  const t = $("#placesText").value.trim();
  parsed = t ? L.parseAvailability(t, poll) : null;
  $("#placesSave").disabled = !parsed || !parsed.places.length;
  if (!parsed) { $("#placesPreview").textContent = ""; $("#placesErrors").innerHTML = ""; return; }
  const days = new Set(parsed.slots.filter(s => s.free.length).map(s => s.date)).size;
  $("#placesPreview").innerHTML = `読み取り：<b>${FORMAT[parsed.format]}</b>・場所 ${parsed.places.length}か所・空きのある日 ${days}日${parsed.asOf ? `・${esc(L.fmtAsOf(parsed.asOf))}時点` : ""}`
    + (parsed.places.length ? `<br>${parsed.places.slice(0, 6).map(p => esc(p.name)).join("、")}${parsed.places.length > 6 ? ` ほか${parsed.places.length - 6}か所` : ""}` : "");
  $("#placesErrors").innerHTML = parsed.errors.slice(0, 10).map(e => `<div>${e.line}行目「${esc(String(e.text).slice(0, 30))}」：${esc(e.reason)}（飛ばしました）</div>`).join("")
    + (parsed.errors.length > 10 ? `<div>ほか${parsed.errors.length - 10}行</div>` : "");
}
$("#placesText").addEventListener("input", readPlaces);
$("#openPlaces").addEventListener("click", () => {
  disarm($("#placesDel"), "貼った空き状況を消す", "#placesNote");
  $("#placesDlg").showModal(); growAll($("#placesDlg"));
});
async function loadPlacesFile(f) {
  if (!f) return;
  $("#placesText").value = await f.text(); grow($("#placesText")); readPlaces();
}
$("#placesFile").addEventListener("change", e => loadPlacesFile(e.target.files[0]).catch(err => { console.error(err); toast("ファイルを読み込めませんでした"); }).finally(() => { e.target.value = ""; }));
// ファイルをダイアログに落としても読み込む（ブラウザがファイルを開いてしまわないよう、ダイアログの中ではいつも止める）
{
  const dlg = $("#placesDlg"), box = $("#placesText");
  const hasFile = e => [...(e.dataTransfer?.types || [])].includes("Files");
  dlg.addEventListener("dragover", e => { if (!hasFile(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = "copy"; box.classList.add("dropping"); });
  dlg.addEventListener("dragleave", e => { if (!dlg.contains(e.relatedTarget)) box.classList.remove("dropping"); });
  dlg.addEventListener("drop", e => {
    if (!hasFile(e)) return;
    e.preventDefault(); box.classList.remove("dropping");
    loadPlacesFile(e.dataTransfer.files[0]).catch(err => { console.error(err); toast("ファイルを読み込めませんでした"); });
  });
}
$("#placesSave").addEventListener("click", async () => {
  if (!parsed) return;
  $("#placesSave").disabled = true;
  try {
    const r = await call("setPlaces", { pollId, key: adminKeyOk, avail: { asOf: $("#placesAsOf").value.trim() || parsed.asOf || "", places: parsed.places, slots: parsed.slots } });
    toast(`場所の空き状況を保存しました（${r.places}か所）`);
    $("#placesText").value = ""; grow($("#placesText")); readPlaces(); $("#placesDlg").close();
  } catch (err) { console.error(err); toast(err.message || "保存できませんでした"); $("#placesSave").disabled = false; }
});
$("#placesDel").addEventListener("click", async e => {
  const b = e.currentTarget;
  if (arm(b, "本当に消す", "#placesNote", "貼った空き状況を消します。もう一度押すと消します")) return;
  disarm(b, "貼った空き状況を消す", "#placesNote");
  try { await call("setPlaces", { pollId, key: adminKeyOk, avail: null }); toast("場所の空き状況を消しました"); $("#placesDlg").close(); }
  catch (err) { console.error(err); toast("消せませんでした"); }
});

// 必須の人（この人が来られない枠は出さない）。最初は呼びたい人の一覧の * の人。押して切り替え（この端末の表示だけ）
let needed = null;
// 人を選ぶチップ（必須の人・優先する人で使う）
function personChips(box, set, attr, names) {
  const chip = n => `<button type="button" class="tchip" data-${attr}="${esc(n)}" aria-pressed="${set.has(n)}">${esc(n)}</button>`;
  if (names.length <= 15) { box.innerHTML = names.map(chip).join("") || `<span class="sub">回答した人が出ます</span>`; return; }
  // 大人数のときは、選んだ人だけを出し、ほかの人はたたんでおく（開いていたら開いたまま）
  const open = box.querySelector("details")?.open;
  const chosen = names.filter(n => set.has(n)), rest = names.filter(n => !set.has(n));
  box.innerHTML = (chosen.length ? chosen.map(chip).join("") : `<span class="sub">まだ選んでいません</span>`)
    + `<details class="names" style="width:100%" ${open ? "open" : ""}><summary>ほかの人から選ぶ（${rest.length}人）</summary><div class="chips" style="margin-top:8px">${rest.map(chip).join("")}</div></details>`;
}
function renderReqChips() {
  if (!needed) needed = new Set((poll.invited || []).filter(x => x.required).map(x => x.name));
  const names = [...new Set([...(poll.invited || []).map(x => x.name), ...people.map(p => p.name)])];
  personChips($("#reqChips"), needed, "req", names);
  personChips($("#prioChips"), prio, "prio", names);
  const max = Math.max(1, names.length), cur = +$("#min").value || 1;
  $("#min").innerHTML = Array.from({ length: max }, (_, i) => `<option value="${i + 1}" ${i + 1 === cur ? "selected" : ""}>${i + 1}人以上</option>`).join("");
}
$("#reqChips").addEventListener("click", e => {
  const b = e.target.closest("[data-req]"); if (!b) return;
  const n = b.dataset.req; needed.has(n) ? needed.delete(n) : needed.add(n);
  renderPlan();
});
// 優先する人：この端末にこの日程調整ごとに覚える（決めるまで何度も見返すので）
const prKey = `komadori:prio:${pollId}`;
let prio = new Set(store.get(prKey, []));
const myPrio = () => adminKeyOk ? prio : new Set();   // 優先する人・場所の広い順・投稿する候補は、管理用の URL で開いたときだけ
$("#prioChips").addEventListener("click", e => {
  const b = e.target.closest("[data-prio]"); if (!b) return;
  const n = b.dataset.prio; prio.has(n) ? prio.delete(n) : prio.add(n);
  store.set(prKey, [...prio]);
  renderPlan();
});
$("#plan").addEventListener("click", async e => {
  const b = e.target.closest("[data-pick]");
  if (b) {
    // 投稿する候補に入れる・外す。場所は、空いている場所の1つめを最初に選んでおく
    const [date, s, en] = b.dataset.pick.split("|"), start = +s, end = +en;
    const i = picks.findIndex(x => x.date === date && x.start === start && x.end === end);
    if (i >= 0) picks.splice(i, 1);
    else {
      const av = avail ? L.filterPlaces(avail, { groups: [...pgroups], q: $("#pq").value }) : null;
      const w = lastWins.find(x => x.date === date && x.start === start && x.end === end);
      picks.push({ date, start, end, place: av && w ? (fitPlaces(av, date, w)[0]?.name || "") : "", memo: "" });
    }
    savePicks(); renderPlan(true);
    return;
  }
  const c = e.target.closest("[data-cell]"); if (!c) return;
  const [iso, m] = c.dataset.cell.split("|"), cell = L.grid(poll, people)[iso][m];
  const info = c.closest(".card").querySelector(".cellinfo");
  info.hidden = false;
  info.textContent = `${L.fmtMin(+m)}〜${L.fmtMin(+m + STEP())}：● ${cell.sure.length ? cell.sure.join("、") : "なし"}${cell.maybe.length ? `／△ ${cell.maybe.join("、")}` : ""}`;
});

// ---------- 大きな切り替え ----------
function showTab(name) {
  for (const [t, s] of [["tabAnswer", "answer"], ["tabResult", "result"]]) {
    $("#" + t).setAttribute("aria-selected", String(s === name));
    $("#" + s).hidden = s !== name;
  }
}
$("#tabAnswer").addEventListener("click", () => showTab("answer"));
$("#tabResult").addEventListener("click", () => showTab("result"));
const share = () => L.shareText({ ...poll, url: `${location.origin}/p/${pollId}` });
$("#copyAnswerUrl").addEventListener("click", () => copy(share(), "文面をコピーしました"));
// 「送る」は URL だけ（送り先のアプリが共有の表示を出す）。説明つきで送りたいときは「回答用の文面をコピー」
$("#share").addEventListener("click", () => navigator.share?.({ url: `${location.origin}/p/${pollId}` }).catch(() => {}));

load().catch(err => { console.error(err); $("#loading").textContent = "読み込めませんでした。通信を確かめて、開き直してください。"; });
