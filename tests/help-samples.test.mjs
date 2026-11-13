// 使い方のページ（public/help.html）に載せた空き状況の見本が、本当に読めるかのテスト
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as L from "../public/logic.js";

const html = readFileSync(new URL("../public/help.html", import.meta.url), "utf8");
const unescape = s => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
const samples = [...html.matchAll(/<pre class="sample"[^>]*>([\s\S]*?)<\/pre>/g)].map(m => unescape(m[1]));
const poll = { from: "2026-12-01", to: "2026-12-31", step: 30 };

test("見本は4つの形とAIへの指示の5つ", () => assert.equal(samples.length, 5));

for (const [i, fmt] of [[0, "lines"], [1, "long"], [2, "wide"], [3, "json"]].map(x => x)) {
  test(`見本 ${i + 1}（${fmt}）は読めないところがなく、場所と空きが取れる`, () => {
    const r = L.parseAvailability(samples[i], poll);
    assert.equal(r.format, fmt);
    assert.deepEqual(r.errors, []);
    assert.ok(r.places.length >= 1);
    assert.ok(r.slots.some(s => s.free.length));
  });
}

test("AIへの指示どおりの表（見出しつきのタブ区切り）が読める", () => {
  const out = "場所\t日付\t空き\tメモ\tURL\tグループ\nスタジオA\t2026-12-05\t13:00-18:00, 19:00-22:00\t32帖\thttps://example.com/a\t新宿\nスタジオA\t2026-12-06\t22:00-26:00\t\t\t新宿";
  const r = L.parseAvailability(out, poll);
  assert.equal(r.format, "long");
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.slots.map(s => s.free), [["13:00-18:00", "19:00-22:00"], ["22:00-26:00"]]);
  assert.equal(r.places[0].group, "新宿");
});
