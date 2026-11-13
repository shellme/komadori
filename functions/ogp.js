// 共有したときの表示（OGP）を作る。index.js の pollPage が使う（tests/ogp.test.mjs でテスト）
const WD = "日月火水木金土";
const OG_SIZE = 160;   // 画像の大きさ。絵文字（72px）を真ん中に置き、まわりを透明の余白にする
const TW = "https://cdn.jsdelivr.net/gh/jdecked/twemoji@15.1.0/assets/72x72/";
const escHtml = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const day = iso => { const d = new Date(iso + "T00:00:00Z"); return `${d.getUTCMonth() + 1}/${d.getUTCDate()}(${WD[d.getUTCDay()]})`; };
/** 絵文字 -> Twemoji の PNG（共有の表示は SVG が使えないことが多い） */
function emojiPng(e) {
  if (!e) return `${TW}1f426.png`;
  const s = e.includes("‍") ? e : e.replace(/️/g, "");
  return `${TW}${[...s].map(c => c.codePointAt(0).toString(16)).join("-")}.png`;
}
/** 絵文字 -> Twemoji のファイル名（"1f3b8"） */
const emojiCode = e => emojiPng(e).slice(TW.length, -4);
/** 共有の表示に出す画像：余白つきの小さいアイコン（ogIcon が作る） */
const ogImage = e => `https://komadori.web.app/og/${emojiCode(e)}.png`;
/** 調整から共有の表示を作る（テストしやすいように分ける） */
function ogpFor(poll) {
  const title = poll.title;   // アイコンは画像（og:image）で出るので、題名には入れない
  const desc = `${day(poll.from)}〜${day(poll.to)}の日程調整`;   // 場所を取らないよう短く
  return { title, desc, image: emojiPng(poll.emoji), ogImage: ogImage(poll.emoji) };
}
function ogpHtml({ title, desc, ogImage }, url) {
  return [
    `<meta property="og:type" content="website">`, `<meta property="og:site_name" content="コマドリ｜日程調整ツール">`,
    `<meta property="og:title" content="${escHtml(title)}">`, `<meta property="og:description" content="${escHtml(desc)}">`,
    `<meta property="og:url" content="${escHtml(url)}">`,
    // 画像を出さないと Slack などは空の枠を出すので、余白つきの小さいアイコンを出す
    `<meta property="og:image" content="${escHtml(ogImage)}">`, `<meta property="og:image:width" content="${OG_SIZE}">`, `<meta property="og:image:height" content="${OG_SIZE}">`,
    `<meta name="twitter:card" content="summary">`, `<meta name="description" content="${escHtml(desc)}">`,
  ].join("\n");
}
/** 余白つきの小さいアイコンの PNG を作る（Twemoji の 72px を OG_SIZE の真ん中に置く） */
function paddedIcon(srcPng, PNG) {
  const src = PNG.sync.read(srcPng), out = new PNG({ width: OG_SIZE, height: OG_SIZE });   // 最初は全部透明
  const ox = Math.floor((OG_SIZE - src.width) / 2), oy = Math.floor((OG_SIZE - src.height) / 2);
  PNG.bitblt(src, out, 0, 0, src.width, src.height, ox, oy);
  return PNG.sync.write(out);
}
module.exports = { ogpFor, ogpHtml, escHtml, emojiPng, emojiCode, ogImage, paddedIcon, OG_SIZE, TW };
