/**
 * adapters.js — GAS のサービスに触る薄い層（依存注入）
 *
 * 設計の要点:
 * - **サービスは第 1 引数で受け取る。** こうすると Node ではインメモリのモックを渡して動かせる。
 *   GAS で動かして確かめる手段が無いので、ここを薄く保つことが検証可能性そのものになる（docs/03 §1）。
 * - **Date を作るのはここだけ。** core は ISO 文字列で持ち、カレンダーに渡す瞬間だけ Date にする（K-8）。
 *   `new Date(文字列)` は使わず、`jstEpochFromIso` で得た数値から作る（ホストの TZ に依存しない）。
 * - **シートは一括で読み書きする。** `getDataRange().getValues()` と `setValues` だけを使い、
 *   1 セルずつ触らない（50 通の取り込みを 6 分に収めるため。K-7）。
 * - **本文はシートに書かない**（NFR-02）。メールの本文は取り込みの一時メモリにだけ載る。
 */

import { JST_OFFSET_MINUTES, isoFromJstEpoch, jstEpochFromIso, toDateOnly } from "../core/dates.js";
import { HEADERS, PROCESSED_HEADERS, SETTINGS_HEADERS, toRow, rowsToCandidates } from "../core/ledger.js";
import { CANDIDATE_STATUS_MANUAL, CANDIDATE_STATUSES } from "../core/parse.js";
import { SETTINGS_DEFAULTS, SETTINGS_FIELDS, settingsFromRows, settingsToRows } from "../core/settings.js";

/** 台帳のシート名（docs/03 §3） */
export const SHEET_CANDIDATES = "候補";
export const SHEET_SETTINGS = "設定";
export const SHEET_PROCESSED = "処理済みメール";
/** 台帳のファイル名（setup() が作る） */
export const LEDGER_FILE_NAME = "選考カレンダー台帳";
/** 台帳の id を覚えておくスクリプトプロパティのキー */
export const LEDGER_PROPERTY_KEY = "senkocal.spreadsheetId";
/** 処理済みメールの行がこれを超えたら古い分を捨てる（検索日数の外は二度と来ない） */
export const PROCESSED_MAX_ROWS = 5000;
export const PROCESSED_TRIM_ROWS = 1000;
/** 状態列の入力規則を張る行数（シートの行数が読めないときの控え） */
export const STATUS_VALIDATION_ROWS = 2000;
/** 状態列（台帳の見出し「状態」の位置）。添字を直書きしない */
const STATUS_COLUMN = HEADERS.indexOf("状態") + 1;
/** 入力規則に並べる語＝台帳の状態 5 つ＋手動登録の合図（レビュー r1 重要 2） */
export const STATUS_VALIDATION_VALUES = CANDIDATE_STATUSES.concat([CANDIDATE_STATUS_MANUAL]);
/** 見出しが設計と違うときの文言（画面の error 状態に出す） */
export const HEADER_MISMATCH_MESSAGE = "台帳の見出しが設計と違います。setup() を実行してください";
/** 台帳がまだ無いときの文言 */
export const LEDGER_MISSING_MESSAGE = "台帳がありません。Apps Script で setup() を実行してください";

/** いまの時刻を JST の ISO 文字列で。台帳に書く時刻はすべてこれ */
export function nowIsoJst() {
  return isoFromJstEpoch(Date.now() + JST_OFFSET_MINUTES * 60000, false);
}

/**
 * GAS の Date → JST の ISO 文字列。
 * @param {{getTime: Function}} value
 * @returns {string|null}
 */
export function isoFromDate(value) {
  if (!value || typeof value.getTime !== "function") return null;
  const epoch = value.getTime();
  if (!isFinite(epoch)) return null;
  return isoFromJstEpoch(epoch + JST_OFFSET_MINUTES * 60000, false);
}

/**
 * ISO 文字列 → Date（カレンダーに渡す境界だけで使う）。
 * 終日の `YYYY-MM-DD` は JST の 0 時として作る。
 * @param {string} iso
 * @returns {Date|null}
 */
export function dateFromIso(iso) {
  const epoch = jstEpochFromIso(iso);
  if (!isFinite(epoch)) return null;
  return new Date(epoch - JST_OFFSET_MINUTES * 60000);
}

/** 設定のフィールド名 → シートの日本語キー（書き込みで綴りがずれないように） */
export function settingLabel(field) {
  for (let i = 0; i < SETTINGS_FIELDS.length; i += 1) {
    if (SETTINGS_FIELDS[i].field === field) return SETTINGS_FIELDS[i].label;
  }
  return String(field);
}

/** 処理済み id の集合（Set でも配列でも受ける）→ 判定用の関数 */
function skipTest(skipIds) {
  if (!skipIds) return null;
  if (typeof skipIds.has === "function") {
    return function (id) {
      return skipIds.has(id);
    };
  }
  if (!Array.isArray(skipIds) || skipIds.length === 0) return null;
  const seen = {};
  for (let i = 0; i < skipIds.length; i += 1) seen[String(skipIds[i])] = true;
  return function (id) {
    return seen[id] === true;
  };
}

/**
 * 直近のメールを新しい順に取り出す（読むだけ・K-3）。
 * @param {object} gmailApp GmailApp か、そのモック
 * @param {string} query buildGmailQuery が作ったクエリ
 * @param {{max?: number, skipIds?: Set<string>|string[]}} [options]
 *   `skipIds`（処理済みの messageId）に載っているメッセージは**本文を読まずに捨てる**（軽微 7）。
 *   `search` の上限はスレッド数なので、2 時間ごとのトリガーでは毎回ほぼ全部が無駄読みになっていた。
 * @returns {Array<{id: string, threadId: string, from: string, subject: string, date: string|null, body: string}>}
 */
export function listRecentMails(gmailApp, query, options) {
  if (!gmailApp || typeof gmailApp.search !== "function") throw new Error("Gmail のサービスが使えません");
  const wanted = options && options.max !== undefined && options.max !== null ? Number(options.max) : NaN;
  const limit = isFinite(wanted) && wanted > 0 ? Math.floor(wanted) : SETTINGS_DEFAULTS.maxMessagesPerRun;
  const skip = skipTest(options ? options.skipIds : null);
  const threads = gmailApp.search(String(query === null || query === undefined ? "" : query), 0, limit) || [];
  const mails = [];
  for (let i = 0; i < threads.length; i += 1) {
    const messages = threads[i] && typeof threads[i].getMessages === "function" ? threads[i].getMessages() : [];
    for (let j = 0; j < messages.length; j += 1) {
      const message = messages[j];
      if (skip && message && typeof message.getId === "function" && skip(String(message.getId()))) continue;
      mails.push(mailFromMessage(message));
    }
  }
  // 新しい順（受信日時の降順）。日時が読めないものは後ろへ
  mails.sort(function (a, b) {
    const left = a.date || "";
    const right = b.date || "";
    if (left === right) return 0;
    return left < right ? 1 : -1;
  });
  return mails.slice(0, limit);
}

/** GmailMessage → 素の JSON（本文はここから先へ持ち出さない） */
function mailFromMessage(message) {
  if (!message) return { id: "", threadId: "", from: "", subject: "", date: null, body: "" };
  const thread = typeof message.getThread === "function" ? message.getThread() : null;
  const id = String(message.getId ? message.getId() : "");
  return {
    id: id,
    threadId: thread && typeof thread.getId === "function" ? String(thread.getId()) : id,
    from: String(message.getFrom ? message.getFrom() || "" : ""),
    subject: String(message.getSubject ? message.getSubject() || "" : ""),
    date: message.getDate ? isoFromDate(message.getDate()) : null,
    body: String(message.getPlainBody ? message.getPlainBody() || "" : ""),
  };
}

/** 設定のカレンダーID（空なら既定のカレンダー） */
function resolveCalendar(calendarApp, calendarId) {
  if (!calendarApp) throw new Error("カレンダーのサービスが使えません");
  const id = calendarId === null || calendarId === undefined ? "" : String(calendarId).trim();
  const calendar = id === "" ? calendarApp.getDefaultCalendar() : calendarApp.getCalendarById(id);
  if (!calendar) throw new Error("カレンダーが見つかりません。設定のカレンダーIDを確認してください");
  return calendar;
}

/**
 * 予定の計画（buildEventPlan の戻り）をカレンダーに書く。**本人が「登録」を押したときだけ呼ぶ**（K-2）。
 * @param {object} calendarApp
 * @param {object} plan
 * @param {{calendarId?: string, candidateId?: string}} [options]
 * @returns {{eventId: string}}
 */
export function createEventFromPlan(calendarApp, plan, options) {
  const opts = options || {};
  const p = plan || {};
  if (p.type === "invalid") throw new Error(p.reason || "日時が無いので予定を作れません");
  const calendar = resolveCalendar(calendarApp, opts.calendarId);
  const detail = { description: String(p.description || ""), location: String(p.location || "") };
  let event = null;
  if (p.type === "allDay") {
    const date = dateFromIso(toDateOnly(p.date || p.start));
    if (!date) throw new Error("終日予定の日付が読めません");
    event = calendar.createAllDayEvent(String(p.title || ""), date, detail);
  } else {
    const start = dateFromIso(p.start);
    const end = dateFromIso(p.end || p.start);
    if (!start || !end) throw new Error("予定の日時が読めません");
    event = calendar.createEvent(String(p.title || ""), start, end, detail);
  }
  if (!event) throw new Error("予定を作れませんでした");
  const reminders = Array.isArray(p.reminders) ? p.reminders : [];
  for (let i = 0; i < reminders.length; i += 1) {
    if (typeof event.addPopupReminder === "function") event.addPopupReminder(reminders[i]);
  }
  // どの候補から作った予定かを予定側にも残す（台帳が壊れたときの手がかり）
  if (opts.candidateId && typeof event.setTag === "function") event.setTag("senkocal", String(opts.candidateId));
  return { eventId: String(event.getId()) };
}

/**
 * 予定を消す（「取り消す」）。すでに無ければ false を返すだけ＝冪等（FR-10）。
 * @param {object} calendarApp
 * @param {string} eventId
 * @param {{calendarId?: string}} [options]
 * @returns {boolean}
 */
export function deleteEventById(calendarApp, eventId, options) {
  const id = eventId === null || eventId === undefined ? "" : String(eventId).trim();
  if (id === "") return false;
  const calendar = resolveCalendar(calendarApp, (options || {}).calendarId);
  let event = null;
  try {
    event = calendar.getEventById(id);
  } catch (err) {
    event = null; // 予定が既に消えている場合も「取り消し済み」として扱う
  }
  if (!event) return false;
  event.deleteEvent();
  return true;
}

/** シート全体の値（空なら []） */
function sheetValues(sheet) {
  if (!sheet) return [];
  if (typeof sheet.getLastRow === "function" && sheet.getLastRow() < 1) return [];
  const range = sheet.getDataRange();
  return range && typeof range.getValues === "function" ? range.getValues() || [] : [];
}

/** 見出し行を読む */
function readHeaderRow(sheet, width) {
  const values = sheetValues(sheet);
  const row = values.length > 0 ? values[0] : [];
  const out = [];
  for (let i = 0; i < width; i += 1) out.push(row[i] === null || row[i] === undefined ? "" : String(row[i]).trim());
  return out;
}

/** 見出しが設計どおりか */
function sameHeaders(actual, expected) {
  if (actual.length !== expected.length) return false;
  for (let i = 0; i < expected.length; i += 1) {
    if (actual[i] !== expected[i]) return false;
  }
  return true;
}

/** シートを用意する。setup 以外では見出しを検証するだけ（勝手に直さない） */
function prepareSheet(book, name, headers, setupMode) {
  let sheet = book.getSheetByName(name);
  if (!sheet) {
    if (!setupMode) throw new Error("シート「" + name + "」がありません。setup() を実行してください");
    sheet = book.insertSheet(name);
  }
  if (!sameHeaders(readHeaderRow(sheet, headers.length), headers)) {
    if (!setupMode) throw new Error(HEADER_MISMATCH_MESSAGE);
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    if (typeof sheet.setFrozenRows === "function") sheet.setFrozenRows(1);
  }
  return sheet;
}

/**
 * 状態列（B）に入力規則を張る。本人がシートを直接触るときの誤字を防ぐ。
 * 範囲は**列全体**（2 行目からシートの最終行まで）にする。行数を決め打ちにすると、
 * 候補がその行数を超えたところで規則もドロップダウンも消える（軽微 14）。
 */
function applyStatusValidation(spreadsheetApp, sheet) {
  if (!spreadsheetApp || typeof spreadsheetApp.newDataValidation !== "function") return false;
  const maxRows = typeof sheet.getMaxRows === "function" ? Number(sheet.getMaxRows()) : NaN;
  const rows = isFinite(maxRows) && maxRows > 1 ? maxRows - 1 : STATUS_VALIDATION_ROWS;
  const range = sheet.getRange(2, STATUS_COLUMN, rows, 1);
  if (!range || typeof range.setDataValidation !== "function") return false;
  const rule = spreadsheetApp
    .newDataValidation()
    .requireValueInList(STATUS_VALIDATION_VALUES, true)
    .setAllowInvalid(false)
    .build();
  range.setDataValidation(rule);
  return true;
}

/** 既定の設定を書く。既にある値は残す（本人が変えた設定を setup() で潰さない） */
function fillDefaultSettings(sheet) {
  const current = settingsFromRows(sheetValues(sheet));
  const rows = settingsToRows(current);
  sheet.getRange(2, 1, rows.length, SETTINGS_HEADERS.length).setValues(rows);
  return rows.length;
}

/** 新規作成した台帳に残る空の「シート1」を片付ける（中身があるものは消さない） */
function removeEmptyExtraSheets(book) {
  if (typeof book.getSheets !== "function" || typeof book.deleteSheet !== "function") return 0;
  const keep = [SHEET_CANDIDATES, SHEET_SETTINGS, SHEET_PROCESSED];
  const sheets = book.getSheets() || [];
  const doomed = [];
  for (let i = 0; i < sheets.length; i += 1) {
    const name = String(sheets[i].getName ? sheets[i].getName() : "");
    if (keep.indexOf(name) >= 0) continue;
    const empty = typeof sheets[i].getLastRow !== "function" || sheets[i].getLastRow() < 1;
    if (empty) doomed.push(sheets[i]);
  }
  for (let i = 0; i < doomed.length; i += 1) book.deleteSheet(doomed[i]);
  return doomed.length;
}

/**
 * 台帳を開く（無ければ setup モードのときだけ作る）。
 * @param {object} spreadsheetApp SpreadsheetApp か、そのモック
 * @param {{spreadsheetId?: string, properties?: object, setup?: boolean}} [options]
 *   `properties` は PropertiesService.getScriptProperties() 相当（台帳 id の記憶に使う）
 * @returns {object} ledger ハンドル
 */
export function openLedger(spreadsheetApp, options) {
  if (!spreadsheetApp) throw new Error("スプレッドシートのサービスが使えません");
  const opts = options || {};
  const properties = opts.properties || null;
  const setupMode = opts.setup === true;
  let id = opts.spreadsheetId ? String(opts.spreadsheetId) : "";
  if (id === "" && properties && typeof properties.getProperty === "function") {
    id = String(properties.getProperty(LEDGER_PROPERTY_KEY) || "");
  }
  let book = null;
  if (id !== "") {
    try {
      book = spreadsheetApp.openById(id);
    } catch (err) {
      book = null; // 台帳が消えた・共有が外れた。setup ならもう一度作る
    }
  }
  if (!book) {
    if (!setupMode) throw new Error(LEDGER_MISSING_MESSAGE);
    book = spreadsheetApp.create(LEDGER_FILE_NAME);
    if (properties && typeof properties.setProperty === "function") {
      properties.setProperty(LEDGER_PROPERTY_KEY, String(book.getId()));
    }
  }
  const candidatesSheet = prepareSheet(book, SHEET_CANDIDATES, HEADERS, setupMode);
  const settingsSheet = prepareSheet(book, SHEET_SETTINGS, SETTINGS_HEADERS, setupMode);
  const processedSheet = prepareSheet(book, SHEET_PROCESSED, PROCESSED_HEADERS, setupMode);
  if (setupMode) {
    applyStatusValidation(spreadsheetApp, candidatesSheet);
    fillDefaultSettings(settingsSheet);
    removeEmptyExtraSheets(book);
  }
  return newLedgerHandle(book, candidatesSheet, settingsSheet, processedSheet);
}

/** 行でも候補オブジェクトでも受け取れるようにする */
function asRow(value) {
  return Array.isArray(value) ? value : toRow(value);
}

/** 台帳ハンドル（読み書きはすべてここを通す） */
function newLedgerHandle(book, candidatesSheet, settingsSheet, processedSheet) {
  const handle = {
    spreadsheetId: String(book.getId ? book.getId() : ""),
    url: typeof book.getUrl === "function" ? String(book.getUrl() || "") : "",

    /** `候補` シートの全候補 */
    readCandidates: function () {
      return rowsToCandidates(sheetValues(candidatesSheet));
    },

    /** `候補` シートを丸ごと書き換える（見出しは残す） */
    writeCandidates: function (rows) {
      const list = [];
      const source = Array.isArray(rows) ? rows : [];
      for (let i = 0; i < source.length; i += 1) list.push(asRow(source[i]));
      const last = typeof candidatesSheet.getLastRow === "function" ? candidatesSheet.getLastRow() : 0;
      if (last > 1) candidatesSheet.getRange(2, 1, last - 1, HEADERS.length).clearContent();
      if (list.length > 0) candidatesSheet.getRange(2, 1, list.length, HEADERS.length).setValues(list);
      return list.length;
    },

    /** `候補` シートに追記する（1 回の setValues で） */
    appendCandidates: function (rows) {
      const list = [];
      const source = Array.isArray(rows) ? rows : [];
      for (let i = 0; i < source.length; i += 1) list.push(asRow(source[i]));
      if (list.length === 0) return 0;
      const last = typeof candidatesSheet.getLastRow === "function" ? candidatesSheet.getLastRow() : 0;
      const start = (last < 1 ? 1 : last) + 1;
      candidatesSheet.getRange(start, 1, list.length, HEADERS.length).setValues(list);
      return list.length;
    },

    /** 候補 1 件を id で置き換える（無ければ追記） */
    upsertCandidate: function (candidate) {
      const c = candidate || {};
      const id = String(c.id === null || c.id === undefined ? "" : c.id).trim();
      if (id === "") throw new Error("候補の id がありません");
      const values = sheetValues(candidatesSheet);
      for (let i = 0; i < values.length; i += 1) {
        const key = values[i] && values[i][0] !== undefined ? String(values[i][0]).trim() : "";
        if (key === HEADERS[0]) continue; // 見出し行
        if (key !== id) continue;
        candidatesSheet.getRange(i + 1, 1, 1, HEADERS.length).setValues([toRow(c)]);
        return i + 1;
      }
      handle.appendCandidates([toRow(c)]);
      return 0;
    },

    /** `処理済みメール` に追記する（同じメールを二度取り込まないための記録・K-5） */
    appendProcessed: function (ids, results) {
      const list = Array.isArray(ids) ? ids : ids === null || ids === undefined ? [] : [ids];
      const at = nowIsoJst();
      const rows = [];
      for (let i = 0; i < list.length; i += 1) {
        const id = list[i] === null || list[i] === undefined ? "" : String(list[i]).trim();
        if (id === "") continue;
        let result = "";
        if (Array.isArray(results)) result = results[i] === undefined || results[i] === null ? "" : String(results[i]);
        else if (results !== null && results !== undefined) result = String(results);
        rows.push([id, at, result]);
      }
      if (rows.length === 0) return 0;
      const last = typeof processedSheet.getLastRow === "function" ? processedSheet.getLastRow() : 0;
      const start = (last < 1 ? 1 : last) + 1;
      processedSheet.getRange(start, 1, rows.length, PROCESSED_HEADERS.length).setValues(rows);
      trimProcessedRows(processedSheet);
      return rows.length;
    },

    /** 処理済みの messageId の集合 */
    readProcessedIds: function () {
      const values = sheetValues(processedSheet);
      const set = new Set();
      for (let i = 0; i < values.length; i += 1) {
        const key = values[i] && values[i][0] !== undefined ? String(values[i][0]).trim() : "";
        if (key === "" || key === PROCESSED_HEADERS[0]) continue;
        set.add(key);
      }
      return set;
    },

    /** `設定` シート → 設定オブジェクト（欠落・不正は既定へ倒す） */
    readSettings: function () {
      return settingsFromRows(sheetValues(settingsSheet));
    },

    /** 設定を 1 件書く（キーはシートの日本語ラベル） */
    writeSetting: function (key, value) {
      const label = String(key === null || key === undefined ? "" : key).trim();
      if (label === "") return false;
      const values = sheetValues(settingsSheet);
      for (let i = 0; i < values.length; i += 1) {
        const name = values[i] && values[i][0] !== undefined ? String(values[i][0]).trim() : "";
        if (name !== label) continue;
        settingsSheet.getRange(i + 1, 2, 1, 1).setValues([[value]]);
        return true;
      }
      const last = typeof settingsSheet.getLastRow === "function" ? settingsSheet.getLastRow() : 0;
      const start = (last < 1 ? 1 : last) + 1;
      settingsSheet.getRange(start, 1, 1, SETTINGS_HEADERS.length).setValues([[label, value, ""]]);
      return true;
    },
  };
  return handle;
}

/** 処理済みメールが増えすぎたら古い行を捨てる（docs/03 §3-3） */
function trimProcessedRows(sheet) {
  if (typeof sheet.getLastRow !== "function" || typeof sheet.deleteRows !== "function") return 0;
  const last = sheet.getLastRow();
  if (last <= PROCESSED_MAX_ROWS) return 0;
  sheet.deleteRows(2, PROCESSED_TRIM_ROWS);
  return PROCESSED_TRIM_ROWS;
}
