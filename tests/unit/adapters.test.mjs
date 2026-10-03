/**
 * adapters.test.mjs — GAS のサービスに触る層（src/gas/adapters.js）
 *
 * ここは実物の Google を叩けないので、モックで「何を・何回・どんな引数で呼んだか」を見る。
 * とくに大事なのは ①Date を作るのはここだけ（JST 固定） ②シートは一括で読み書き
 * ③台帳の見出しが違えば止まる（黙って壊れた台帳に書かない）の 3 つ。
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  HEADER_MISMATCH_MESSAGE,
  LEDGER_PROPERTY_KEY,
  STATUS_VALIDATION_VALUES,
  createEventFromPlan,
  dateFromIso,
  deleteEventById,
  isoFromDate,
  listRecentMails,
  openLedger,
  settingLabel,
} from "../../src/gas/adapters.js";
import { HEADERS } from "../../src/core/ledger.js";
import { SETTINGS_DEFAULTS } from "../../src/core/settings.js";
import { parseMail } from "../../src/core/parse.js";
import {
  createCalendarAppMock,
  createGmailAppMock,
  createPropertiesServiceMock,
  createSpreadsheetAppMock,
  loadFixtureMails,
  pickFixtureMails,
} from "./helpers/gas-mocks.mjs";

/** 台帳を作った直後の状態を返す */
function freshLedger() {
  const spreadsheet = createSpreadsheetAppMock();
  const properties = createPropertiesServiceMock().getScriptProperties();
  const ledger = openLedger(spreadsheet, { properties: properties, setup: true });
  return { spreadsheet: spreadsheet, properties: properties, ledger: ledger, book: spreadsheet.firstBook() };
}

/** 時刻付きの予定の計画 */
function timedPlan() {
  return {
    type: "timed",
    title: "【面接】株式会社サンプル商事 1次面接",
    start: "2026-03-05T14:00:00+09:00",
    end: "2026-03-05T15:00:00+09:00",
    date: null,
    description: "件名: テスト",
    location: "本社 3F 会議室",
    reminders: [60, 1440],
  };
}

// ---------- listRecentMails ----------

test("listRecentMails: 新しい順に返す", () => {
  const mails = pickFixtureMails(["01", "09", "17"]);
  const gmail = createGmailAppMock(mails);
  const got = listRecentMails(gmail, "newer_than:7d", { max: 50 });
  const dates = got.map((mail) => mail.date);
  const sorted = dates.slice().sort().reverse();
  assert.deepEqual(dates, sorted);
});

test("listRecentMails: 上限で打ち切り、Gmail の検索にも上限を渡す（K-7）", () => {
  const gmail = createGmailAppMock(loadFixtureMails(12));
  const got = listRecentMails(gmail, "q", { max: 3 });
  assert.equal(got.length, 3);
  assert.deepEqual(gmail.calls[0].args, ["q", 0, 3]);
});

test("listRecentMails: 上限が壊れていたら既定に倒す", () => {
  const gmail = createGmailAppMock(loadFixtureMails(3));
  const got = listRecentMails(gmail, "q", { max: "abc" });
  assert.equal(gmail.calls[0].args[2], SETTINGS_DEFAULTS.maxMessagesPerRun);
  assert.equal(got.length, 3);
});

test("listRecentMails: メールの中身をそのまま写す（本文もここでは持つ）", () => {
  const mail = pickFixtureMails(["01"])[0];
  const got = listRecentMails(createGmailAppMock([mail]), "q", { max: 5 });
  assert.equal(got.length, 1);
  assert.equal(got[0].id, mail.id);
  assert.equal(got[0].threadId, mail.threadId);
  assert.equal(got[0].from, mail.from);
  assert.equal(got[0].subject, mail.subject);
  assert.equal(got[0].date, mail.date);
  assert.equal(got[0].body, mail.body);
});

test("listRecentMails: サービスが無ければ止まる", () => {
  assert.throws(() => listRecentMails(null, "q", {}), /Gmail/);
});

test("listRecentMails: 処理済み id は本文を読まずに捨てる（軽微 7）", () => {
  const mails = pickFixtureMails(["01", "09", "17"]);
  const gmail = createGmailAppMock(mails);
  const skip = new Set([mails[0].id, mails[1].id]);
  const got = listRecentMails(gmail, "q", { max: 50, skipIds: skip });
  assert.deepEqual(
    got.map((mail) => mail.id),
    [mails[2].id]
  );
  // 捨てるメッセージの getPlainBody() は呼ばない（2 時間ごとの取り込みで毎回の無駄読みをやめる）
  assert.deepEqual(gmail.bodyReads, [mails[2].id]);
});

test("listRecentMails: skipIds は配列でも受ける（無ければ全部読む）", () => {
  const mails = pickFixtureMails(["01", "09"]);
  const gmail = createGmailAppMock(mails);
  assert.equal(listRecentMails(gmail, "q", { max: 50, skipIds: [mails[0].id] }).length, 1);
  const all = createGmailAppMock(mails);
  assert.equal(listRecentMails(all, "q", { max: 50 }).length, 2);
  assert.equal(all.bodyReads.length, 2);
});

// ---------- Date の境界（K-8） ----------

test("isoFromDate: Date → JST の ISO 文字列", () => {
  assert.equal(isoFromDate(new Date(Date.UTC(2026, 2, 5, 5, 0, 0))), "2026-03-05T14:00:00+09:00");
});

test("isoFromDate: Date でなければ null", () => {
  assert.equal(isoFromDate(null), null);
  assert.equal(isoFromDate("2026-03-05"), null);
});

test("dateFromIso: 時刻付きは UTC の瞬間に直る", () => {
  const date = dateFromIso("2026-03-05T14:00:00+09:00");
  assert.equal(date.toISOString(), "2026-03-05T05:00:00.000Z");
});

test("dateFromIso: 日付だけは JST の 0 時（終日予定が前日にずれない）", () => {
  const date = dateFromIso("2026-03-10");
  assert.equal(date.toISOString(), "2026-03-09T15:00:00.000Z");
});

test("dateFromIso: 読めなければ null", () => {
  assert.equal(dateFromIso("きのう"), null);
});

// ---------- createEventFromPlan / deleteEventById ----------

test("createEventFromPlan: 時刻付きは createEvent を 1 回・引数は Date", () => {
  const calendar = createCalendarAppMock();
  const created = createEventFromPlan(calendar, timedPlan(), { candidateId: "c_1" });
  assert.equal(calendar.countOf("createEvent"), 1);
  assert.equal(calendar.countOf("createAllDayEvent"), 0);
  const call = calendar.calls.filter((entry) => entry.name === "createEvent")[0];
  assert.ok(call.args[1] instanceof Date);
  assert.equal(call.args[1].toISOString(), "2026-03-05T05:00:00.000Z");
  assert.equal(call.args[2].toISOString(), "2026-03-05T06:00:00.000Z");
  assert.equal(call.args[3].location, "本社 3F 会議室");
  assert.ok(created.eventId.length > 0);
});

test("createEventFromPlan: 通知を設定どおりに付け、候補 id をタグに残す", () => {
  const calendar = createCalendarAppMock();
  const created = createEventFromPlan(calendar, timedPlan(), { candidateId: "c_m1_1" });
  const record = calendar.recordOf(created.eventId);
  assert.deepEqual(record.reminders, [60, 1440]);
  assert.deepEqual(record.tags, { senkocal: "c_m1_1" });
});

test("createEventFromPlan: 終日は createAllDayEvent", () => {
  const calendar = createCalendarAppMock();
  const plan = {
    type: "allDay",
    title: "【締切 23:59】株式会社サンプル ES提出",
    start: null,
    end: null,
    date: "2026-03-10",
    description: "件名: テスト",
    location: "",
    reminders: [900],
  };
  const created = createEventFromPlan(calendar, plan, {});
  assert.equal(calendar.countOf("createAllDayEvent"), 1);
  const record = calendar.recordOf(created.eventId);
  assert.deepEqual(record.reminders, [900]);
  assert.equal(record.date.toISOString(), "2026-03-09T15:00:00.000Z");
});

test("createEventFromPlan: 日付が無い計画（invalid）は作らずに止まる", () => {
  const calendar = createCalendarAppMock();
  const plan = { type: "invalid", title: "x", reminders: [], reason: "日付がありません。編集して日時を入れてください" };
  assert.throws(() => createEventFromPlan(calendar, plan, {}), /日付がありません/);
  assert.equal(calendar.calls.length, 0);
});

test("createEventFromPlan: カレンダーID があれば getCalendarById を使う", () => {
  const calendar = createCalendarAppMock();
  createEventFromPlan(calendar, timedPlan(), { calendarId: "personal@example.com" });
  assert.equal(calendar.countOf("getCalendarById"), 1);
  assert.equal(calendar.countOf("getDefaultCalendar"), 0);
});

test("deleteEventById: 消せたら true、二度目は false（冪等・FR-10）", () => {
  const calendar = createCalendarAppMock();
  const created = createEventFromPlan(calendar, timedPlan(), {});
  assert.equal(deleteEventById(calendar, created.eventId, {}), true);
  assert.equal(deleteEventById(calendar, created.eventId, {}), false);
});

test("deleteEventById: 空の予定 ID ではカレンダーに触らない", () => {
  const calendar = createCalendarAppMock();
  assert.equal(deleteEventById(calendar, "", {}), false);
  assert.equal(calendar.calls.length, 0);
});

// ---------- openLedger ----------

test("openLedger(setup): 3 シートと見出しを作り、台帳 id を覚える", () => {
  const fixture = freshLedger();
  const names = fixture.book.getSheets().map((sheet) => sheet.getName());
  assert.deepEqual(names, ["候補", "設定", "処理済みメール"]);
  assert.deepEqual(fixture.book.getSheetByName("候補").grid[0], HEADERS);
  assert.deepEqual(fixture.book.getSheetByName("処理済みメール").grid[0], ["messageId", "処理日時", "結果"]);
  assert.equal(fixture.properties.getProperty(LEDGER_PROPERTY_KEY), fixture.book.getId());
});

test("openLedger(setup): 既定の設定 11 行と状態列の入力規則を置く", () => {
  const fixture = freshLedger();
  const settingsSheet = fixture.book.getSheetByName("設定");
  assert.equal(settingsSheet.rows().length, 11);
  const settings = fixture.ledger.readSettings();
  assert.equal(settings.searchDays, SETTINGS_DEFAULTS.searchDays);
  assert.deepEqual(settings.eventReminderMinutes, SETTINGS_DEFAULTS.eventReminderMinutes);
  const validation = fixture.book.getSheetByName("候補").validations[0];
  assert.equal(validation.col, 2);
  assert.deepEqual(validation.rule.list, ["候補", "登録済み", "無視", "ノイズ", "エラー", "登録"]);
  assert.equal(validation.rule.allowInvalid, false);
});

test("openLedger(setup): 入力規則のリストに「登録」が入る（registerMarked の入口・レビュー r1 重要 2）", () => {
  // README が案内する手作業運用（状態列に「登録」と書く → registerMarked()）は、
  // 入力規則が「登録」を拒否すると入口ごと塞がる。リストに入っていることを固定する
  const fixture = freshLedger();
  const validation = fixture.book.getSheetByName("候補").validations[0];
  assert.ok(validation.rule.list.indexOf("登録") >= 0);
  assert.deepEqual(validation.rule.list, STATUS_VALIDATION_VALUES);
});

test("openLedger(setup): 入力規則は状態列の全体に張る（2000 行で切らない・軽微 14）", () => {
  const fixture = freshLedger();
  const sheet = fixture.book.getSheetByName("候補");
  const validation = sheet.validations[0];
  assert.equal(validation.row, 2);
  assert.equal(validation.numCols, 1);
  assert.equal(validation.numRows, sheet.getMaxRows() - 1);
  assert.ok(validation.numRows >= 999);
});

test("openLedger: 2 回目は作り直さずに開く", () => {
  const fixture = freshLedger();
  openLedger(fixture.spreadsheet, { properties: fixture.properties, setup: true });
  const created = fixture.spreadsheet.calls.filter((call) => call.name === "create");
  assert.equal(created.length, 1);
});

test("openLedger: 台帳がまだ無いのに setup でなければ、setup() を促して止まる", () => {
  const spreadsheet = createSpreadsheetAppMock();
  const properties = createPropertiesServiceMock().getScriptProperties();
  assert.throws(() => openLedger(spreadsheet, { properties: properties, setup: false }), /setup\(\) を実行/);
});

test("openLedger: 見出しが設計と違えば止まる（壊れた台帳に書かない）", () => {
  const fixture = freshLedger();
  fixture.book.getSheetByName("候補").getRange(1, 3, 1, 1).setValues([["会社名"]]);
  assert.throws(
    () => openLedger(fixture.spreadsheet, { properties: fixture.properties, setup: false }),
    (err) => err.message === HEADER_MISMATCH_MESSAGE
  );
});

test("openLedger(setup): 本人が変えた設定は上書きしない", () => {
  const fixture = freshLedger();
  fixture.ledger.writeSetting("検索日数", 14);
  const again = openLedger(fixture.spreadsheet, { properties: fixture.properties, setup: true });
  assert.equal(again.readSettings().searchDays, 14);
});

// ---------- 台帳の読み書き ----------

test("appendCandidates → readCandidates で往復する", () => {
  const fixture = freshLedger();
  const candidates = parseMail(pickFixtureMails(["01"])[0]);
  fixture.ledger.appendCandidates(candidates);
  const read = fixture.ledger.readCandidates();
  assert.equal(read.length, candidates.length);
  assert.equal(read[0].id, candidates[0].id);
  assert.equal(read[0].start, candidates[0].start);
  assert.equal(read[0].company, candidates[0].company);
  assert.equal(read[0].allDay, candidates[0].allDay);
});

test("appendCandidates は 1 回の setValues で書く（1 セルずつ触らない）", () => {
  const fixture = freshLedger();
  const sheet = fixture.book.getSheetByName("候補");
  const before = sheet.calls.filter((call) => call.name === "setValues").length;
  fixture.ledger.appendCandidates(parseMail(pickFixtureMails(["36"])[0]));
  const after = sheet.calls.filter((call) => call.name === "setValues").length;
  assert.equal(after - before, 1);
});

test("upsertCandidate: 同じ id の行を置き換える（行が増えない）", () => {
  const fixture = freshLedger();
  const candidates = parseMail(pickFixtureMails(["01"])[0]);
  fixture.ledger.appendCandidates(candidates);
  const changed = Object.assign({}, candidates[0], { status: "登録済み", eventId: "event-9" });
  fixture.ledger.upsertCandidate(changed);
  const read = fixture.ledger.readCandidates();
  assert.equal(read.length, 1);
  assert.equal(read[0].status, "登録済み");
  assert.equal(read[0].eventId, "event-9");
});

test("upsertCandidate: 台帳に無い候補は追記になる", () => {
  const fixture = freshLedger();
  const candidate = parseMail(pickFixtureMails(["01"])[0])[0];
  fixture.ledger.upsertCandidate(candidate);
  assert.equal(fixture.ledger.readCandidates().length, 1);
});

test("upsertCandidate: id が無ければ書かない", () => {
  const fixture = freshLedger();
  assert.throws(() => fixture.ledger.upsertCandidate({ id: "" }), /id/);
});

test("writeCandidates: 消えた候補の行を残さない", () => {
  const fixture = freshLedger();
  const candidates = parseMail(pickFixtureMails(["36"])[0]);
  assert.ok(candidates.length >= 2);
  fixture.ledger.appendCandidates(candidates);
  fixture.ledger.writeCandidates([candidates[0]]);
  assert.equal(fixture.ledger.readCandidates().length, 1);
});

test("appendProcessed → readProcessedIds（同じメールを二度取り込まないための記録）", () => {
  const fixture = freshLedger();
  fixture.ledger.appendProcessed(["m0001", "m0002"], ["候補 1 件", "ノイズ"]);
  const ids = fixture.ledger.readProcessedIds();
  assert.equal(ids.has("m0001"), true);
  assert.equal(ids.has("m0002"), true);
  assert.equal(ids.has("m0003"), false);
  const rows = fixture.book.getSheetByName("処理済みメール").rows();
  assert.equal(rows[0][2], "候補 1 件");
  assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(String(rows[0][1])));
});

test("appendProcessed: 5000 行を超えたら古い 1000 行を捨てる", () => {
  const fixture = freshLedger();
  const sheet = fixture.book.getSheetByName("処理済みメール");
  const rows = [];
  for (let i = 0; i < 5000; i += 1) rows.push(["old-" + i, "2026-01-01T00:00:00+09:00", "ノイズ"]);
  sheet.getRange(2, 1, rows.length, 3).setValues(rows);
  fixture.ledger.appendProcessed(["new-1"], ["候補 1 件"]);
  const deleted = sheet.calls.filter((call) => call.name === "deleteRows");
  assert.equal(deleted.length, 1);
  assert.deepEqual([deleted[0].start, deleted[0].count], [2, 1000]);
});

test("writeSetting: 書いた値が readSettings に出る（最終実行の記録）", () => {
  const fixture = freshLedger();
  fixture.ledger.writeSetting(settingLabel("lastRun"), "2026-03-05T09:00:00+09:00");
  fixture.ledger.writeSetting(settingLabel("lastImportCount"), 7);
  const settings = fixture.ledger.readSettings();
  assert.equal(settings.lastRun, "2026-03-05T09:00:00+09:00");
  assert.equal(settings.lastImportCount, 7);
});

test("writeSetting: 知らないキーは行を足す（設定を壊さない）", () => {
  const fixture = freshLedger();
  fixture.ledger.writeSetting("メモ", "あとで消す");
  const rows = fixture.book.getSheetByName("設定").rows();
  assert.equal(rows.length, 12);
  assert.deepEqual(rows[11].slice(0, 2), ["メモ", "あとで消す"]);
});

test("settingLabel: 英語のフィールド名 → シートの日本語キー", () => {
  assert.equal(settingLabel("lastRun"), "最終実行");
  assert.equal(settingLabel("maxMessagesPerRun"), "1回の上限");
  assert.equal(settingLabel("unknownField"), "unknownField");
});

test("NFR-02: 台帳の行に本文が入らない", () => {
  const fixture = freshLedger();
  const mail = pickFixtureMails(["01"])[0];
  fixture.ledger.appendCandidates(parseMail(mail));
  const bodyHead = mail.body.split("\n")[3];
  const dump = JSON.stringify(fixture.book.getSheetByName("候補").rows());
  assert.ok(bodyHead.length > 5);
  assert.equal(dump.indexOf(bodyHead), -1);
});
