# コマドリ（komadori）

みんながそろう「コマ（時間の枠）」を見つける日程調整アプリ。期間だけ決めて URL を送ると、みんなが日ごとの空き時間を回答し、何時間そろうかをよい順に並べます。ログインはいりません。

- 設計：[docs/design.md](docs/design.md)
- 画面の決まり：[docs/ui-rules.md](docs/ui-rules.md)
- 公開先：https://komadori.web.app （Firebase プロジェクト `komadori-app`）
- 不具合・要望：[Issues](https://github.com/shellme/komadori/issues)

## 動かし方
```
npm install && (cd functions && npm install)
npm test            # 計算のテスト
npm run test:rules  # Firestore のルールのテスト（Java が必要）
npm run test:functions  # Cloud Functions のテスト（エミュレーター）
npm run emu         # エミュレーターで画面を確かめる → http://127.0.0.1:5010
```

## ファイル
| ファイル | 中身 |
|---|---|
| public/logic.js | 計算（時間帯の読み取り・30分への丸め・除外・重なり・よい枠・文面）。画面にもデータベースにも依存しない |
| public/index.html, create.js | トップと「調整を作る」 |
| public/p.html, poll.js | 時間を回答／みんなの状況（/p/{pollId}、管理用は #admin=鍵） |
| public/ui.js, fb.js, holidays.js | 画面の共通の部品、Firebase の接続、日本の祝日 |
| public/help.html | 使い方・よくある質問 |
| functions/index.js | Cloud Functions。管理の操作（場所の空き状況・決定・設定の編集・削除）、期限切れの削除、共有したときの表示（OGP） |
| firestore.rules | アクセスルール（匿名ログイン・書いた端末を必ず入れる・履歴は足すだけ） |

## データの守り方
ログインのない道具なので、「URL を知っている人を信じる」作りです。そのうえで次のようにしています。

- **日程調整の ID は推測できない20文字**（`crypto.getRandomValues`）。一覧は取れないので、URL を知らない人は中を読めません。検索にも出しません（`noindex`）
- **回答は URL を知っている人なら誰の行でも直せます**（調整さんと同じ）。その代わり、書いた端末（匿名ログインの uid）を必ず記録します
- **管理の操作（設定の編集・決定・場所の空き状況・削除）は Cloud Functions だけ**から行います。管理用の鍵は URL の `#` の後ろにあるのでサーバーには送られず、データベースには SHA-256 のハッシュだけを置きます。Functions は鍵のハッシュを比べてから書きます
- **Firestore のルールで、書き込める項目・形・大きさを決めています**（`firestore.rules`、テストは `tests/rules.test.mjs`）
- 画面に出す文字はすべてエスケープしてから HTML に入れます（`ui.js` の `esc`）
- 期間の終わりから90日で、回答ごと自動で消します
- `public/fb.js` の Firebase の API キーは、ブラウザで使うための公開してよい値です（守りはルールと Functions で行います）

## ライセンス
[MIT](LICENSE)。

## 絵文字
アイコンと絵文字は [Twemoji](https://github.com/jdecked/twemoji)（画像は CC-BY 4.0）で描いています。アプリのアイコン（public/icon.svg）は Twemoji の 🐦 です。

## デプロイのときに要るもの
- Firebase のコンソールで Firestore と匿名ログインを有効にする
- Cloud Functions を使うので、プロジェクトを従量課金（Blaze）にする
