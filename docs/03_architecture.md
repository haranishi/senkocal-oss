# 技術設計 v1（senkocal）

## 1. 構成と採用理由
- **Google Apps Script（V8）**で本人のアカウント内に完結。OAuth クライアントを作らないので「Testing 状態のリフレッシュトークン 7 日失効」（調査 §3-1）を踏まない。GmailApp／CalendarApp／SpreadsheetApp／HtmlService／ScriptApp（トリガー）／LockService だけを使う。
- **コアは Node で開発・テストし、ビルドで 1 本の `Code.gs` に束ねる。** GAS 側で動かして確かめる手段が Claude に無いため、抽出・台帳・予定の組み立てを純関数に閉じ込め、GAS のサービスは薄いアダプター（依存注入）にする。アダプターはモックで unit テストする。
- **依存ゼロ・ビルドは自作の連結スクリプト。** GAS は ESM を読めないので、`src/core`・`src/gas` の ESM を「`import` 行を落とし `export` を剥がして連結」する。トップレベルの名前がモジュール間で重複しないことを policy で固定する（名前は `parseMail`・`buildEventPlan` のように動詞＋対象で一意にする）。
- **確認画面は HtmlService の単一 HTML**（インライン CSS/JS）。ローカルの E2E では同じファイルを `file://` で開き、`google.script.run` をスタブして動かす。HtmlService はサンドボックス（IFRAME）で、外部リンクは `target="_blank"`、活性コンテンツは HTTPS のみ（公式）。
- 参考にした先例: `~/Projects/zernio_multipost_gas/code.gs`（本人の GAS の流儀＝冒頭の使い方コメント・`setup()`・シート 1 行 1 件・状態列・トリガー関数・安全設計の明記）、`~/Projects/esfill`（ハーネス・Playwright 借用・policy test・採点ループ）。

## 2. ファイル構成
```
src/core/text.js        NFKC・空白・引用除去（純関数）
src/core/dates.js       日時・締切の解釈（JST 固定・ISO 文字列）
src/core/company.js     企業名と媒体の抽出
src/core/classify.js    種別・段階・ノイズの判定（辞書は export）
src/core/parse.js       1 通 → 候補配列（parseMail）・候補の鍵
src/core/events.js      候補＋設定 → 予定の計画（buildEventPlan）
src/core/ledger.js      台帳の行 ⇄ 候補・併合・状態遷移（純関数）
src/core/query.js       設定 → Gmail 検索クエリ
src/core/settings.js    既定値・`設定` シートの読み書き形・検証
src/gas/adapters.js     GmailApp／CalendarApp／SpreadsheetApp を受け取る薄い関数（依存注入）
src/gas/app.js          GAS のエントリ: setup／importMail／doGet／api_*／createTrigger／deleteTriggers
src/gas/banner.txt      Code.gs 冒頭の使い方コメント（本人の流儀）
src/ui/index.html       確認画面（単一ファイル）
src/manifest/appsscript.json
tools/build-gas.mjs     dist/Code.gs・dist/index.html・dist/appsscript.json を作る
tools/calibrate.mjs     tests/fixtures/real/*.json（gitignore）を parseMail に通して表にする
tools/screenshots.mjs   採点用スクショ（390/768/1440 × 状態）
tests/unit/*.test.mjs   node --test（core・adapters のモック・build の検証）
tests/unit/helpers/gas-mocks.mjs  GmailApp／CalendarApp／SpreadsheetApp／LockService のインメモリ実装
tests/fixtures/mails/*.json       合成メール（id・threadId・from・subject・date・body）30 通以上
tests/fixtures/expected/*.json    parseMail の期待値
tests/fixtures/real/              本人の実メール置き場（.gitignore・空の README だけ置く）
tests/policy.test.mjs
tests/e2e/*.spec.mjs    Playwright（借用）・google.script.run スタブ
tests/e2e/gas-stub.js   window.google.script.run のインメモリ実装（seed・遅延・失敗の注入）
```

## 3. データ
### 3-1. シート `候補`（1 行 1 候補・見出しは 1 行目・順序固定）
| 列 | 内容 |
|---|---|
| A `id` | `c_<messageId>_<n>` |
| B `状態` | 候補／登録済み／無視／ノイズ／エラー（入力規則。手動登録の合図「登録」も入力規則に含め、`registerMarked()` が拾う） |
| C `企業名` | 取れなければ空 |
| D `種別` | seminar／es_deadline／test_deadline／interview／schedule_request／change／result／other |
| E `段階` | 1次／2次／3次／最終／カジュアル／空 |
| F `タイトル` | 予定タイトル案 |
| G `開始` | ISO 8601（`+09:00`）。終日は `YYYY-MM-DD` |
| H `終了` | ISO or 空 |
| I `終日` | TRUE／FALSE |
| J `締切` | ISO or 空 |
| K `候補日` | 「;」区切りの ISO（日程調整） |
| L `場所` | 文字列 or 空 |
| M `URL` | 本文中の会議 URL（Zoom／Teams／Meet）or 空 |
| N `件名` | 200 字まで |
| O `送信者` | From（表示名＋アドレス） |
| P `媒体` | mynavi／rikunabi／onecareer／offerbox／careertasu／iweb／axol／sonar／direct／unknown |
| Q `受信日時` | ISO |
| R `確度` | high／medium／low |
| S `根拠` | 「;」区切りの短い理由（日時=本文2行目・企業=From など） |
| T `messageId` | Gmail の message id |
| U `threadId` | |
| V `予定ID` | 登録後に `CalendarEvent.getId()` |
| W `登録日時` | ISO |
| X `備考` | エラーの理由・重複の相手 id など |
本文は書かない（NFR-02）。Gmail リンクは `https://mail.google.com/mail/u/0/#all/<messageId>` を画面側で組む。

### 3-2. シート `設定`（A 列キー・B 列値・C 列説明）
`検索日数`=7／`キーワード`=`面接 OR 面談 OR 説明会 OR セミナー OR 選考 OR エントリー OR 締切 OR 〆切 OR 適性検査 OR Webテスト OR SPI OR 内定 OR 日程`／`除外送信者`=空（`-from:` に展開）／`カレンダーID`=空（既定カレンダー）／`締切リマインダー分`=900／`予定リマインダー分`=`60,1440`／`実行間隔時間`=2／`1回の上限`=50／`予定の既定長さ分`=60／`最終実行`（書き込み専用）／`最終取り込み件数`。

### 3-3. シート `処理済みメール`
`messageId`／`処理日時`／`結果`（候補 n 件／ノイズ／解析不能）。取り込みはこの列を `Set` にして照合する。行数が 5,000 を超えたら古い 1,000 行を消す（検索日数 7 日の範囲外は二度と来ない）。

### 3-4. 候補（core の型・JSON）
```json
{"id":"c_18f3a…_1","messageId":"18f3a…","threadId":"18f3a…","receivedAt":"2026-03-01T10:12:00+09:00",
 "company":"株式会社サンプル","media":"direct","kind":"interview","stage":"1次",
 "title":"【面接】株式会社サンプル 1次面接","start":"2026-03-05T14:00:00+09:00","end":"2026-03-05T15:00:00+09:00",
 "allDay":false,"deadline":null,"choices":[],"location":"本社 3F 会議室","url":null,
 "subject":"【1次面接のご案内】株式会社サンプル","isPast":false,"from":"株式会社サンプル 採用担当 <saiyo@example.jp>","confidence":"high","reasons":["日時: 本文 3 行目","企業: From 表示名"],"status":"候補","eventId":null,"registeredAt":null,"note":""}
```
`isPast` は派生値（`fromRow` が受信日と現在から毎回計算）で、台帳の列には持たない。`classify.js` は「本文に日時が無い」判定のため `dates.js` に依存する（一方向・循環なし）。

## 4. モジュール API（実装担当はこの形を変えない。変えるときは受領書で設計へ差し戻す）
### src/core/text.js
- `normalizeText(text) → string`（NFKC・`\r\n`→`\n`・連続空白の圧縮・全角空白→半角・引用行 `>` の除去）
- `splitLines(text) → string[]`、`stripSignature(text) → string`（`--`／`━━`／「以上」以降を落とす。落としすぎ防止で本文の 30% 以上は残す）
- `truncate(text, n) → string`
### src/core/dates.js（JST 固定・ホストの TZ に依存しない）
- `parseDateTimes(text, {base}) → [{start, end, allDay, raw, line, col, confidence, isPast, note}]`（`col` は行内位置＝締切語との距離に使う。`note` は「期間: 3/5〜3/7（3日間）」のような補足）（`base` は受信日時の ISO。年が無ければ `inferYear`。時刻が無ければ `allDay: true` で `start` は `YYYY-MM-DD`）
- `parseDeadlines(text, {base}) → [{at, allDay, raw, line, confidence}]`（締切語 1 つに締切 1 つ。締切語の判定は **必ず `hasDeadlineKeyword(text)`／`deadlineKeywordsIn(text)` を通す**＝「まで」は日時直後だけを締切語にするため、`DEADLINE_KEYWORDS` を `join("|")` して使ってはいけない）
- `detectChoices(text, {base}) → {choices: string[], replyBy: string|null}|null`（「第1希望」「候補日」「いずれか」「ご都合」の文脈で 2 件以上の日付）
- `inferYear(month, day, baseIso, weekday|null) → number`（直近の未来。曜日一致で確定。一致する年が無ければ直近の未来のまま `confidence` を下げる）
- `toIso(y, m, d, hh, mm) → string`（`+09:00`）、`formatJa(iso) → "3/5（木）14:00"`、`addMinutes(iso, n) → string`、`weekdayOf(iso) → 0..6`
### src/core/company.js
- `extractCompany({from, subject, body}) → {name: string|null, media: string, source: "from"|"subject"|"body"|"signature"|null, confidence}`
- `normalizeCompany(name) → string`（（株）→株式会社・全角英数→半角・前後の「採用担当」「人事」「新卒採用」「事務局」「様」「より」を除く）
- `MEDIA_DOMAINS: {[media]: string[]}`、`detectMedia(fromAddress) → string`
### src/core/classify.js
- `classifyMail({subject, body, from}) → {kind, stage: string|null, isNoise: boolean, matched: string[]}`
- `KIND_KEYWORDS: {[kind]: string[]}`、`STAGE_KEYWORDS`、`NOISE_KEYWORDS`、`KIND_PRIORITY: string[]`（`change` → `result` → `schedule_request` → `interview` → `test_deadline` → `es_deadline` → `seminar`）。件名を本文より優先
### src/core/parse.js
- `parseMail(mail) → Candidate[]`（`mail = {id, threadId, from, subject, date(ISO), body}`。ノイズは `[]` を返し、`parseMailWithMeta(mail) → {candidates, isNoise, kind, reasons}` が状態の記録用）
- `candidateKey(c) → string`（`company|kind|start|deadline` を正規化して連結。重複判定に使う。**`start` と `deadline` がどちらも空なら `messageId` を混ぜる**＝日時の無い候補が別メール間で重複扱いにならないように）
- `newCandidateId(messageId, n) → string`
### src/core/events.js
- `buildEventPlan(candidate, settings) → {type: "timed"|"allDay"|"invalid", title, start, end, date, description, location, reminders: number[], reason?}`（`reminders` は 5〜40320 に丸める。`timed` で `end` が無ければ `予定の既定長さ分`。日付が無い候補は `type: "invalid"` と理由を返し、登録側は画面に「日時を入力してください」を出す。`start` が無く `deadline` だけの `seminar`／`interview` はタイトルを「【申込締切 23:59】◯◯ 説明会」にして締切日の終日予定（「【説明会】」の名前で締切日に置かない）。`end <= start` なら `end` を `start`＋既定分に倒す）
- `titleFor(candidate) → string`、`descriptionFor(candidate) → string`（件名・Gmail リンク・候補 id・「選考カレンダーで登録」。本文は入れない）
- `calendarDayUrl(iso) → string`（`https://calendar.google.com/calendar/u/0/r/day/YYYY/M/D`）
### src/core/ledger.js
- `HEADERS: string[]`（§3-1 の順）、`toRow(candidate) → any[]`、`fromRow(row) → Candidate`、`rowsToCandidates(rows)`、`mergeCandidates(existing, incoming) → {rows, added, duplicates}`（`candidateKey` 一致は追加しない）、`setStatus(candidate, status, extra) → Candidate`、`findDuplicateRegistered(existing, candidate) → Candidate|null`
- （設定の既定値と読み書きは `src/core/settings.js` に置く: `SETTINGS_DEFAULTS`、`settingsFromRows(rows) → Settings`（欠落・不正は既定へ倒す。数値は範囲で丸める）、`settingsToRows(settings)`。`ledger.js` は参照するだけ）
### src/core/query.js
- `buildGmailQuery(settings) → string`（`newer_than:7d (面接 OR …) -from:… -in:spam -in:trash`。空のキーワードは既定に倒す）
### src/gas/adapters.js（すべて第 1 引数にサービスを受け取る＝Node ではモック）
- `listRecentMails(gmailApp, query, {max, skipIds}) → Mail[]`（`search` → `getMessages` → `{id, threadId, from, subject, date(ISO), body: getPlainBody()}`。新しい順・上限で打ち切り。`skipIds`（処理済み）に含まれるメッセージは本文を読まない＝無駄読みを避ける）
- `createEventFromPlan(calendarApp, plan, {calendarId, candidateId}) → {eventId}`（`candidateId` を `setTag("senkocal", …)` に使う）（`getDefaultCalendar()` か `getCalendarById`。`createEvent`／`createAllDayEvent` → `addPopupReminder`×n → `setTag("senkocal", candidateId)`）
- `deleteEventById(calendarApp, eventId, {calendarId}) → boolean`
- `openLedger(spreadsheetApp, {spreadsheetId, properties, setup}) → ledger`（`properties` は台帳 id を記憶する `PropertiesService` 相当。`setup: true` なら無ければ `create("選考カレンダー台帳")`・3 シートと見出し・入力規則を作り、`false` なら見出しの検証だけ。`ledger.url` で本人が開く URL を返す）
- `ledger.readCandidates() → Candidate[]`、`ledger.writeCandidates(rows)`、`ledger.appendCandidates(candidates)`、`ledger.upsertCandidate(candidate)`、`ledger.appendProcessed(ids, results)`、`ledger.readProcessedIds() → Set`、`ledger.readSettings() → Settings`、`ledger.writeSetting(key, value)`、`ledger.url`
### src/gas/app.js（GAS のグローバル。ビルドで `Code.gs` 末尾に置く）
- `setup()`／`importMail()`／`registerMarked()`（シートで状態を「登録」にした行を登録する。取り込みとは別関数＝K-2）／`createTrigger()`／`deleteTriggers()`／`doGet(e)`／`api_listCandidates() → {candidates, settings（`deadlineReminderMinutes` を含む）, lastRun, lastImportCount, ledgerUrl}`（候補ごとに画面用の `gmailUrl`・`calendarUrl`・`registerable`・`planReason` を付ける＝画面は `Code.gs` の関数を直接呼べないため）／`api_registerCandidate(id, editsJson) → {ok, eventId, duplicateOf}`／`api_registerBulk(idsJson) → {results, registeredIds}`（配列でも JSON 文字列でも受ける。`registeredIds` は「まとめて取り消す」に使う）／`api_ignoreCandidate(id)`／`api_restoreCandidate(id)`／`api_undoRegister(id)`／`api_importNow() → {added, noise}`
- `importMail` は `LockService.getScriptLock().tryLock(30000)` で直列化。カレンダーには触れない（K-2）
- `api_*` の引数・戻り値は JSON 化できる値だけ（`Date` を渡さない）

## 5. 流れ
### 5-1. 取り込み（トリガー／手動／画面の「いま取り込む」）
1. ロック取得 → `設定` を読む → `buildGmailQuery` → `listRecentMails`（上限 50）
2. `処理済みメール` の id を除き、各メールを `parseMailWithMeta` → 候補は `mergeCandidates`（既存と重複する鍵は追加しない）→ `候補` に追記、`処理済みメール` に記録（本文は捨てる）
3. `設定` の `最終実行`・`最終取り込み件数` を更新 → ロック解放。6 分に近づく前に打ち切る（開始から 4 分で残りを次回へ）
### 5-2. 確認画面
1. `doGet` → `index.html`（`HtmlService.createHtmlOutputFromFile("index").setTitle(...).addMetaTag("viewport", "width=device-width, initial-scale=1")`）
2. 画面は `google.script.run.withSuccessHandler(render).withFailureHandler(showError).api_listCandidates()` で台帳を読み、区分ごとに描く
3. 「登録」→ `api_registerCandidate(id, JSON.stringify(edits))` → 成功でカードを登録済みに。まとめて登録は `api_registerBulk(ids)`
4. 「取り消す」→ `api_undoRegister(id)`（予定削除・状態を候補へ）。「無視」→ `api_ignoreCandidate`
### 5-3. 登録（サーバー側）
`fromRow` → `edits` を反映 → `findDuplicateRegistered` → あれば `{ok:false, duplicateOf}` → 無ければ `buildEventPlan` → `createEventFromPlan` → 台帳の状態・予定ID・登録日時を更新

## 6. セキュリティとプライバシーの決め
- スコープは `appsscript.json` に明示: `https://www.googleapis.com/auth/gmail.readonly`・`https://www.googleapis.com/auth/calendar.events`・`https://www.googleapis.com/auth/spreadsheets`・`https://www.googleapis.com/auth/script.scriptapp`。公式ガイド「常に最小のスコープを使う」に従う。GmailApp の読み取りが `gmail.readonly` で動かない場合の差し替え手順を README に書く（公式リファレンスの抜粋には `https://mail.google.com/` だけが載っている＝未確認事項）
- Web アプリは `executeAs: USER_DEPLOYING`・`access: MYSELF`。URL を知っていても本人以外は開けない
- 本文は台帳・ログ・画面に出さない。件名・送信者・抽出結果だけ
- 外部通信ゼロ（`UrlFetchApp` を書かない）。LLM を使わない

## 7. 検証
- `npm run test:unit`＝`node --test "tests/unit/**/*.test.mjs"`／`npm run test:policy`／`npm run build`（連結後に `node --input-type=commonjs --check < dist/Code.gs` で構文検査。`.gs` 拡張子は `node --check` が判定できない。制御文字が残っていれば落とす）／`npm run test:e2e`／`npm test`＝すべて
- unit: 日時 40 例以上（表記ゆれ・年推定・曜日不一致・範囲・午後・半・正午・全角）、締切 15 例、分類（辞書の網羅＋優先順）、企業名 20 例（媒体経由・From 表示名・件名・本文・署名・取れない）、fixture 30 通の `parseMail` が期待値と一致、`mergeCandidates` の重複、`buildEventPlan`（終日・時刻・既定長さ・通知の丸め）、アダプター（モックで 取り込み → 台帳 → 登録 → 取り消し。`importMail` が `CalendarApp` に触れない）、`TZ=UTC` でも同じ結果
- policy: スコープ厳密一致・禁止 API・媒体ドメイン・`dist` に `import/export/require` なし・トップレベル名の重複なし・fixture に実メールらしきもの（本人の氏名・実在ドメインの個人アドレス）が無い・`tests/fixtures/real/` が gitignore
- E2E: `src/ui/index.html` を `file://` で開き `tests/e2e/gas-stub.js` を `addInitScript`。状態 4 つ、登録／無視／編集して登録／まとめて登録／取り消し／日程調整カード／ノイズの畳み／失敗時の表示／390 で横スクロールなし／44px／Tab 移動
- スクショ: `tools/screenshots.mjs --round N` が 390／768／1440 × `empty`／`list`／`list-registered`／`error`＋ダーク 1 枚＋フォーカス 1 枚

## 8. 既知の限界（設計時点）
- 実メールの形は本人の Gmail にしか無い。合成 fixture で通っても実物で外れる可能性があり、較正の周回が要る（OWNER_TASKS）
- `gmail.readonly` で GmailApp が動くかは実アカウントで確かめるまで未確認
- 日時の年推定は「直近の未来」。1 年以上先の案内や過去日の再送は誤る
- 変更・中止メールは候補として出すだけで、既登録の予定を自動で書き換えない（P1）
- HtmlService はサンドボックスで、ブラウザ通知や `localStorage` の挙動が通常のページと違うことがある。画面は状態を持たず毎回台帳から読む
