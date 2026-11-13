// 共有したときの表示（OGP）のテスト：node --test tests/ogp.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const req = createRequire(import.meta.url);
const { ogpFor, ogpHtml, emojiPng, paddedIcon, OG_SIZE } = req("../functions/ogp.js");
const { PNG } = req("../functions/node_modules/pngjs");

const poll = { title: "12月の練習", emoji: "🎸", from: "2026-12-01", to: "2026-12-14" };

test("OGP：名前（アイコンは画像）、説明に期間", () => {
  const o = ogpFor(poll);
  assert.equal(o.title, "12月の練習");   // アイコンは画像で出す
  assert.equal(o.desc, "12/1(火)〜12/14(月)の日程調整");
  assert.equal(o.image, "https://cdn.jsdelivr.net/gh/jdecked/twemoji@15.1.0/assets/72x72/1f3b8.png");
  // 前に決定を入れた日程調整でも、説明は期間のまま（決定はもう出さない）
  assert.equal(ogpFor({ ...poll, decided: { date: "2026-12-05", start: "14:00", end: "16:00" } }).desc, "12/1(火)〜12/14(月)の日程調整");
});

test("OGP：アイコンの PNG（異体字セレクタ・ZWJ・なし）", () => {
  assert.match(emojiPng("🗓️"), /\/1f5d3\.png$/);
  assert.match(emojiPng("🧑‍💻"), /\/1f9d1-200d-1f4bb\.png$/);
  assert.match(emojiPng(""), /\/1f426\.png$/);   // アイコンなしはコマドリ（🐦）
});

test("OGP：HTML に入れるときは文字を逃がす。小さい表示（summary）", () => {
  const h = ogpHtml(ogpFor({ ...poll, title: '"><script>' }), "https://komadori.web.app/p/x");
  assert.ok(!h.includes("<script>"));
  assert.match(h, /twitter:card" content="summary"/);
  assert.match(h, /og:image" content="https:\/\/komadori.web.app\/og\/1f3b8.png"/);   // 余白つきの小さいアイコン
  assert.match(h, /og:site_name" content="コマドリ｜日程調整ツール"/);   // 何のサイトかわかるように
  assert.match(h, /og:url" content="https:\/\/komadori.web.app\/p\/x"/);
});

test("余白つきのアイコン：72px の絵文字を 160px の真ん中に置き、まわりは透明", () => {
  const src = new PNG({ width: 72, height: 72 });
  for (let i = 0; i < src.data.length; i += 4) { src.data[i] = 255; src.data[i + 3] = 255; }   // 赤で塗る
  const out = PNG.sync.read(paddedIcon(PNG.sync.write(src), PNG));
  assert.equal(out.width, OG_SIZE);
  const alpha = (x, y) => out.data[(y * out.width + x) * 4 + 3];
  assert.equal(alpha(0, 0), 0);          // すみは透明
  assert.equal(alpha(80, 80), 255);      // 真ん中は絵文字
  assert.equal(alpha(30, 80), 0);        // 絵文字の左（44px より外）は透明
});
