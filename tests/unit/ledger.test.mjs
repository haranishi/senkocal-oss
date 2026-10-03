/**
 * ledger.test.mjs — 台帳の行 ⇄ 候補・併合・状態遷移・設定の丸め
 * 台帳が正本なので「行 → 候補 → 行」で情報が落ちないことを固定する。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  HEADERS,
  PROCESSED_HEADERS,
  findDuplicateRegistered,
  fromRow,
  mergeCandidates,
  registrationKey,
  rowsToCandidates,
  setStatus,
  toRow,
} from "../../src/core/ledger.js";
import { parseMail } from "../../src/core/parse.js";
import {
  SETTINGS_DEFAULTS,
  SETTINGS_FIELDS,
  clampMinutesList,
  clampNumber,
  settingsFromRows,
  settingsToRows,
} from "../../src/core/settings.js";

const mailsDir = fileURLToPath(new URL("../fixtures/mails/", import.meta.url));

function sampleCandidate(name) {
  const mail = JSON.parse(fs.readFileSync(mailsDir + (name || "01.json"), "utf8"));
  return parseMail(mail)[0];
}

// --- 見出し -----------------------------------------------------------------
test("HEADERS は docs/03 §3-1 の 24 列", () => {
  assert.equal(HEADERS.length, 24);
  assert.deepEqual(HEADERS.slice(0, 6), ["id", "状態", "企業名", "種別", "段階", "タイトル"]);
  assert.deepEqual(HEADERS.slice(20), ["threadId", "予定ID", "登録日時", "備考"]);
});

test("処理済みメールの見出しは 3 列", () => {
  assert.deepEqual(PROCESSED_HEADERS, ["messageId", "処理日時", "結果"]);
});

test("本文の列は無い（NFR-02）", () => {
  assert.equal(HEADERS.indexOf("本文"), -1);
});

// --- 往復 -------------------------------------------------------------------
test("toRow → fromRow で候補が元に戻る", () => {
  const candidate = sampleCandidate("01.json");
  assert.deepEqual(fromRow(toRow(candidate)), candidate);
});

test("往復は全 fixture で成り立つ", () => {
  const names = fs.readdirSync(mailsDir).sort();
  let checked = 0;
  for (let i = 0; i < names.length; i += 1) {
    const mail = JSON.parse(fs.readFileSync(mailsDir + names[i], "utf8"));
    const candidates = parseMail(mail);
    for (let j = 0; j < candidates.length; j += 1) {
      assert.deepEqual(fromRow(toRow(candidates[j])), candidates[j], names[i]);
      checked += 1;
    }
  }
  assert.ok(checked >= 30, "検査した候補が " + checked + " 件しかない");
});

test("toRow の列数は見出しと同じ", () => {
  assert.equal(toRow(sampleCandidate()).length, HEADERS.length);
});

test("候補日と根拠は ; で結合する", () => {
  const candidate = sampleCandidate("12.json");
  const row = toRow(candidate);
  assert.equal(row[10], candidate.choices.join(";"));
  assert.ok(row[18].indexOf(";") >= 0 || candidate.reasons.length <= 1);
});

test("終日は真偽値でも TRUE 文字列でも読める", () => {
  const row = toRow(sampleCandidate("12.json"));
  assert.equal(row[8], true);
  const asText = row.slice();
  asText[8] = "TRUE";
  assert.equal(fromRow(asText).allDay, true);
  asText[8] = "FALSE";
  assert.equal(fromRow(asText).allDay, false);
});

test("空欄は null（文字列項目は空文字）で読む", () => {
  const empty = fromRow([]);
  assert.equal(empty.company, null);
  assert.equal(empty.start, null);
  assert.deepEqual(empty.choices, []);
  assert.equal(empty.subject, "");
  assert.equal(empty.note, "");
});

test("rowsToCandidates: 見出し行と空行を読み飛ばす", () => {
  const candidate = sampleCandidate();
  const rows = [HEADERS, toRow(candidate), [], ["", "", ""]];
  const list = rowsToCandidates(rows);
  assert.equal(list.length, 1);
  assert.equal(list[0].id, candidate.id);
});

// --- 併合と重複 -------------------------------------------------------------
test("mergeCandidates: 同じ鍵の候補は足さない（FR-11）", () => {
  const candidate = sampleCandidate();
  const first = mergeCandidates([], [candidate]);
  assert.equal(first.added.length, 1);
  assert.equal(first.rows.length, 1);
  assert.equal(first.duplicates.length, 0);
  const second = mergeCandidates([candidate], [candidate]);
  assert.equal(second.added.length, 0);
  assert.equal(second.duplicates.length, 1);
});

test("mergeCandidates: 既存が行の配列でも判定できる", () => {
  const candidate = sampleCandidate();
  const result = mergeCandidates([toRow(candidate)], [candidate]);
  assert.equal(result.added.length, 0);
});

test("mergeCandidates: 同じ取り込みの中の重複も 1 件にする", () => {
  const candidate = sampleCandidate();
  const result = mergeCandidates([], [candidate, candidate]);
  assert.equal(result.added.length, 1);
  assert.equal(result.duplicates.length, 1);
});

test("mergeCandidates: 別の日時なら足す", () => {
  const candidate = sampleCandidate();
  const other = Object.assign({}, candidate, { id: "c_m0001_2", start: "2026-03-06T14:00:00+09:00" });
  const result = mergeCandidates([candidate], [other]);
  assert.equal(result.added.length, 1);
});

test("findDuplicateRegistered: 登録済みの同じ予定を見つける", () => {
  const candidate = sampleCandidate();
  const registered = setStatus(candidate, "登録済み", { eventId: "evt1", id: "c_old_1" });
  const found = findDuplicateRegistered([registered], candidate);
  assert.ok(found);
  assert.equal(found.eventId, "evt1");
});

test("findDuplicateRegistered: 状態が候補なら重複にしない", () => {
  const candidate = sampleCandidate();
  assert.equal(findDuplicateRegistered([candidate], candidate), null);
});

test("findDuplicateRegistered: 自分自身は重複にしない", () => {
  const registered = setStatus(sampleCandidate(), "登録済み", { eventId: "evt1" });
  assert.equal(findDuplicateRegistered([registered], registered), null);
});

test("registrationKey: 企業・種別・開始（無ければ締切）で決まる", () => {
  const a = { company: "A社", kind: "interview", start: "2026-03-05T14:00:00+09:00", deadline: null };
  const b = { company: "A社", kind: "interview", start: "2026-03-05T14:00:00+09:00", deadline: "2026-03-01" };
  assert.equal(registrationKey(a), registrationKey(b));
});

test("registrationKey: 企業名の空白は無視する（軽微 2）", () => {
  // `.replace(/\s+/g, "")` を外すと「株式会社 サンプル商事」の重複検出が黙って壊れる
  const plain = { company: "株式会社サンプル商事", kind: "interview", start: "2026-03-05T14:00:00+09:00" };
  const spaced = { company: "株式会社 サンプル商事", kind: "interview", start: "2026-03-05T14:00:00+09:00" };
  assert.equal(registrationKey(plain), registrationKey(spaced));
  const registered = setStatus(Object.assign({ id: "c_1" }, plain), "登録済み", { eventId: "evt1" });
  const found = findDuplicateRegistered([registered], Object.assign({ id: "c_2" }, spaced));
  assert.ok(found);
  assert.equal(found.id, "c_1");
});

test("registrationKey: 英字の大小差は同じ会社と見る（軽微 1）", () => {
  const upper = { company: "SAMPLE Inc.", kind: "interview", start: "2026-03-05T14:00:00+09:00" };
  const lower = { company: "Sample Inc.", kind: "interview", start: "2026-03-05T14:00:00+09:00" };
  assert.equal(registrationKey(upper), registrationKey(lower));
  const registered = setStatus(Object.assign({ id: "c_1" }, upper), "登録済み", { eventId: "evt1" });
  assert.ok(findDuplicateRegistered([registered], Object.assign({ id: "c_2" }, lower)));
  // 前株・後株は同一視しない（別法人の同時刻面接を登録できなくしない）
  const maekabu = { company: "株式会社サンプル商事", kind: "interview", start: "2026-03-05T14:00:00+09:00" };
  const atokabu = { company: "サンプル商事株式会社", kind: "interview", start: "2026-03-05T14:00:00+09:00" };
  assert.notEqual(registrationKey(maekabu), registrationKey(atokabu));
});

// --- 状態遷移 ---------------------------------------------------------------
test("setStatus: 元の候補を書き換えない", () => {
  const candidate = sampleCandidate();
  const next = setStatus(candidate, "登録済み", { eventId: "evt1", registeredAt: "2026-03-01T12:00:00+09:00" });
  assert.equal(candidate.status, "候補");
  assert.equal(next.status, "登録済み");
  assert.equal(next.eventId, "evt1");
});

test("setStatus: 取り消しで候補に戻し、予定 ID を消せる", () => {
  const registered = setStatus(sampleCandidate(), "登録済み", { eventId: "evt1" });
  const undone = setStatus(registered, "候補", { eventId: null, registeredAt: null });
  assert.equal(undone.status, "候補");
  assert.equal(undone.eventId, null);
});

test("setStatus: 無視・ノイズ・エラーも扱える", () => {
  const candidate = sampleCandidate();
  assert.equal(setStatus(candidate, "無視").status, "無視");
  assert.equal(setStatus(candidate, "ノイズ").status, "ノイズ");
  assert.equal(setStatus(candidate, "エラー", { note: "権限がありません" }).note, "権限がありません");
});

// --- 設定 -------------------------------------------------------------------
test("SETTINGS_DEFAULTS は docs/03 §3-2 のとおり", () => {
  assert.equal(SETTINGS_DEFAULTS.searchDays, 7);
  assert.equal(SETTINGS_DEFAULTS.deadlineReminderMinutes, 900);
  assert.deepEqual(SETTINGS_DEFAULTS.eventReminderMinutes, [60, 1440]);
  assert.equal(SETTINGS_DEFAULTS.intervalHours, 2);
  assert.equal(SETTINGS_DEFAULTS.maxMessagesPerRun, 50);
  assert.equal(SETTINGS_DEFAULTS.defaultEventMinutes, 60);
});

test("settingsFromRows: 空なら既定", () => {
  assert.deepEqual(settingsFromRows([]), SETTINGS_DEFAULTS);
});

test("settingsFromRows: シートの値を読む", () => {
  const settings = settingsFromRows([
    ["キー", "値", "説明"],
    ["検索日数", 14],
    ["1回の上限", "80"],
    ["予定リマインダー分", "30,120"],
    ["カレンダーID", "abc@group.calendar.google.com"],
  ]);
  assert.equal(settings.searchDays, 14);
  assert.equal(settings.maxMessagesPerRun, 80);
  assert.deepEqual(settings.eventReminderMinutes, [30, 120]);
  assert.equal(settings.calendarId, "abc@group.calendar.google.com");
});

test("settingsFromRows: 範囲外は丸める", () => {
  const settings = settingsFromRows([
    ["検索日数", 999],
    ["1回の上限", 0],
    ["実行間隔時間", 48],
    ["締切リマインダー分", 999999],
    ["予定の既定長さ分", 1],
  ]);
  assert.equal(settings.searchDays, 30);
  assert.equal(settings.maxMessagesPerRun, 1);
  assert.equal(settings.intervalHours, 12);
  assert.equal(settings.deadlineReminderMinutes, 40320);
  assert.equal(settings.defaultEventMinutes, 5);
});

test("settingsFromRows: NaN・空欄は既定へ倒す", () => {
  const settings = settingsFromRows([["検索日数", "ななにち"], ["キーワード", "  "], ["1回の上限", null]]);
  assert.equal(settings.searchDays, 7);
  assert.equal(settings.keywords, SETTINGS_DEFAULTS.keywords);
  assert.equal(settings.maxMessagesPerRun, 50);
});

test("settingsToRows: キー・値・説明の 3 列で全項目を出す", () => {
  const rows = settingsToRows(SETTINGS_DEFAULTS);
  assert.equal(rows.length, SETTINGS_FIELDS.length);
  assert.equal(rows[0][0], "検索日数");
  assert.equal(rows[0][1], 7);
  assert.ok(String(rows[0][2]).length > 0);
});

test("settingsToRows → settingsFromRows で往復する", () => {
  const settings = settingsFromRows([["検索日数", 3], ["予定リマインダー分", "15,60"], ["除外送信者", "a@example.com"]]);
  assert.deepEqual(settingsFromRows(settingsToRows(settings)), settings);
});

test("clampNumber と clampMinutesList", () => {
  assert.equal(clampNumber("7日", 1, 30, 7), 7);
  assert.equal(clampNumber(undefined, 1, 30, 7), 7);
  assert.equal(clampNumber(31, 1, 30, 7), 30);
  assert.deepEqual(clampMinutesList("60, 60, 1440", [60]), [60, 1440]);
  assert.deepEqual(clampMinutesList("", [60]), [60]);
});

// --- 見出しの順序を固定する（重要 6） ---------------------------------------
test("HEADERS は 24 列がこの順で並ぶ（並べ替えたら落ちる）", () => {
  assert.deepEqual(HEADERS, [
    "id",
    "状態",
    "企業名",
    "種別",
    "段階",
    "タイトル",
    "開始",
    "終了",
    "終日",
    "締切",
    "候補日",
    "場所",
    "URL",
    "件名",
    "送信者",
    "媒体",
    "受信日時",
    "確度",
    "根拠",
    "messageId",
    "threadId",
    "予定ID",
    "登録日時",
    "備考",
  ]);
});

test("toRow は見出しの位置に値を置く（添字の直書きをやめた・重要 6）", () => {
  const candidate = sampleCandidate("01.json");
  const row = toRow(candidate);
  assert.equal(row.length, HEADERS.length);
  assert.equal(row[HEADERS.indexOf("開始")], candidate.start);
  assert.equal(row[HEADERS.indexOf("終了")], candidate.end);
  assert.equal(row[HEADERS.indexOf("締切")], candidate.deadline === null ? "" : candidate.deadline);
  assert.equal(row[HEADERS.indexOf("件名")], candidate.subject);
  assert.equal(row[HEADERS.indexOf("messageId")], candidate.messageId);
});

test("fromRow も見出しの位置から読む（重要 6）", () => {
  const row = [];
  for (let i = 0; i < HEADERS.length; i += 1) row.push("");
  row[HEADERS.indexOf("id")] = "c_x_1";
  row[HEADERS.indexOf("状態")] = "候補";
  row[HEADERS.indexOf("種別")] = "interview";
  row[HEADERS.indexOf("開始")] = "2026-03-05T14:00:00+09:00";
  row[HEADERS.indexOf("終了")] = "2026-03-05T15:00:00+09:00";
  const candidate = fromRow(row);
  assert.equal(candidate.start, "2026-03-05T14:00:00+09:00");
  assert.equal(candidate.end, "2026-03-05T15:00:00+09:00");
});

// --- 軽微 13: 見出し行はどこにあっても弾く ---------------------------------
test("rowsToCandidates: 途中に混ざった見出し行も弾く（軽微 13）", () => {
  const candidate = sampleCandidate("01.json");
  const rows = [HEADERS.slice(), toRow(candidate), HEADERS.slice(), toRow(candidate)];
  const list = rowsToCandidates(rows);
  assert.equal(list.length, 2);
  assert.equal(list[0].kind, "interview");
  assert.equal(list[1].kind, "interview");
});

// --- 重要 2: 日時の無い候補は別メールでも消えない --------------------------
test("mergeCandidates: 日時の無い候補は別のメールぶんも残す（重要 2）", () => {
  const first = parseMail({
    id: "mg1",
    threadId: "mg1",
    from: "株式会社サンプル商事 <recruit@a.example.jp>",
    subject: "会社説明会のご案内",
    date: "2026-03-01T10:00:00+09:00",
    body: "会社説明会を実施します。\n日程は追ってご連絡します。",
  });
  const second = parseMail({
    id: "mg2",
    threadId: "mg2",
    from: "株式会社サンプル商事 <recruit@a.example.jp>",
    subject: "第2回 会社説明会のご案内",
    date: "2026-03-02T10:00:00+09:00",
    body: "第2回の会社説明会を実施します。\n詳細は追ってご連絡します。",
  });
  const merged = mergeCandidates(first, second);
  assert.equal(merged.added.length, 1);
  assert.equal(merged.duplicates.length, 0);
});

test("mergeCandidates: 同じメールの同じ候補は 1 件のまま", () => {
  const candidates = parseMail({
    id: "mg3",
    threadId: "mg3",
    from: "株式会社サンプル商事 <recruit@a.example.jp>",
    subject: "会社説明会のご案内",
    date: "2026-03-01T10:00:00+09:00",
    body: "会社説明会を実施します。\n日程は追ってご連絡します。",
  });
  const merged = mergeCandidates(candidates, candidates);
  assert.equal(merged.added.length, 0);
  assert.equal(merged.duplicates.length, 1);
});

// --- 軽微 14: カンマ入りの数値 ----------------------------------------------
test("clampNumber: カンマ区切りは桁を連結せず既定に倒す（軽微 14）", () => {
  assert.equal(clampNumber("60,1440", 5, 40320, 900), 900);
  assert.equal(clampNumber("1440,60", 5, 40320, 900), 900);
  assert.equal(clampNumber("60、1440", 5, 40320, 900), 900);
});

test("clampNumber: 単位つきは読む・非数は既定へ", () => {
  assert.equal(clampNumber("900分", 5, 40320, 60), 900);
  assert.equal(clampNumber("7日", 1, 30, 7), 7);
  assert.equal(clampNumber("abc", 1, 30, 7), 7);
  assert.equal(clampNumber("", 1, 30, 7), 7);
  assert.equal(clampNumber("2026-03-01", 1, 30, 7), 7);
  assert.equal(clampNumber("-3", 1, 200, 50), 1);
  assert.equal(clampNumber(4.6, 5, 720, 60), 5);
});

test("settingsFromRows: 締切リマインダー分にカンマを書かれても壊れない（軽微 14）", () => {
  const settings = settingsFromRows([["締切リマインダー分", "60,1440"]]);
  assert.equal(settings.deadlineReminderMinutes, SETTINGS_DEFAULTS.deadlineReminderMinutes);
});
