/**
 * app.js — GAS のグローバル関数（エディタで実行するもの・画面から呼ぶもの）
 *
 * 設計の要点:
 * - **`importMail()` はカレンダーに一切触れない**（K-2）。カレンダーに書くのは
 *   本人が画面で「登録」を押したときに走る `api_registerCandidate` だけ。unit で
 *   「取り込みの経路で CalendarApp のモックが 0 回」を固定している。
 * - サービスは `typeof GmailApp !== "undefined"` の形でその場だけ参照する。こうすると
 *   Node のテストで `globalThis.GmailApp = モック` を差し替えて同じコードを動かせる。
 * - `api_*` の引数と戻り値は **JSON にできる値だけ**。`Date` は境界に乗せない（FR-08）。
 * - 台帳が正本。画面は状態を持たず、毎回 `api_listCandidates()` で読み直す。
 */

import { extractCompany, normalizeCompany } from "../core/company.js";
import { hasTimePart, isoFromJstEpoch, jstEpochFromIso } from "../core/dates.js";
import { buildEventPlan, calendarDayUrl, gmailMessageUrl, titleFor } from "../core/events.js";
import { findDuplicateRegistered, mergeCandidates, setStatus } from "../core/ledger.js";
import {
  CANDIDATE_STATUS_IGNORED,
  CANDIDATE_STATUS_MANUAL,
  CANDIDATE_STATUS_NEW,
  CANDIDATE_STATUS_NOISE,
  CANDIDATE_STATUS_REGISTERED,
  newCandidateId,
  normalizeReceivedAt,
  parseMailWithMeta,
} from "../core/parse.js";
import { buildGmailQuery } from "../core/query.js";
import { truncate } from "../core/text.js";
import {
  createEventFromPlan,
  deleteEventById,
  listRecentMails,
  nowIsoJst,
  openLedger,
  settingLabel,
} from "./adapters.js";

/** 画面のタイトル（doGet） */
const APP_TITLE = "選考カレンダー（仮）";
/** 時間主導トリガーが呼ぶ関数名 */
const TRIGGER_HANDLER = "importMail";
/** ロックの待ち時間（ミリ秒）。取れなければ今回は何もしない */
const LOCK_WAIT_MS = 30000;
/** 取り込みを打ち切る時間。GAS の上限 6 分に対して 4 分で止め、残りは次回に回す（K-7） */
const IMPORT_TIME_BUDGET_MS = 240000;
/** ロックが取れなかったときに画面へ返す文言（レビュー r1 重要 1） */
const REGISTER_BUSY_MESSAGE = "他の処理が動いています。少し待ってからもう一度押してください";

/** Gmail（読むだけ） */
function gmailService() {
  if (typeof GmailApp !== "undefined" && GmailApp) return GmailApp;
  throw new Error("Gmail のサービスが使えません。Apps Script で承認をやり直してください");
}

/** カレンダー（本人が押したときだけ触る） */
function calendarService() {
  if (typeof CalendarApp !== "undefined" && CalendarApp) return CalendarApp;
  throw new Error("カレンダーのサービスが使えません。Apps Script で承認をやり直してください");
}

/** スプレッドシート（台帳） */
function spreadsheetService() {
  if (typeof SpreadsheetApp !== "undefined" && SpreadsheetApp) return SpreadsheetApp;
  throw new Error("スプレッドシートのサービスが使えません。Apps Script で承認をやり直してください");
}

/** 台帳 id を覚えるスクリプトプロパティ（無くても動くようにする） */
function scriptProperties() {
  if (typeof PropertiesService === "undefined" || !PropertiesService) return null;
  return PropertiesService.getScriptProperties();
}

/** トリガーの作成・削除 */
function triggerService() {
  if (typeof ScriptApp !== "undefined" && ScriptApp) return ScriptApp;
  throw new Error("ScriptApp が使えません。トリガーの操作はエディタから行ってください");
}

/** 画面（doGet） */
function pageService() {
  if (typeof HtmlService !== "undefined" && HtmlService) return HtmlService;
  throw new Error("HtmlService が使えません");
}

/** 二重起動を直列化するロック（無ければ null） */
function importLock() {
  if (typeof LockService === "undefined" || !LockService) return null;
  return LockService.getScriptLock();
}

/**
 * 登録の経路（`api_registerCandidate`・`api_registerBulk`・`registerMarked`）を直列化する。
 * これが無いと、画面の二重クリックや Web アプリの並行実行で「台帳を読む → 予定を作る → 台帳を書く」
 * が交差し、**予定が 2 件でき、片方は台帳に残らず「取り消す」で消せなくなる**（レビュー r1 重要 1）。
 * @param {Function} run ロックの中で走らせる処理
 * @returns {*} run の戻り値
 */
function withRegisterLock(run) {
  const lock = importLock();
  if (!lock || typeof lock.tryLock !== "function") return run();
  if (!lock.tryLock(LOCK_WAIT_MS)) throw new Error(REGISTER_BUSY_MESSAGE);
  try {
    return run();
  } finally {
    if (typeof lock.releaseLock === "function") lock.releaseLock();
  }
}

/** 台帳を開く。setupMode のときだけ作る・直す */
function openLedgerForApp(setupMode) {
  return openLedger(spreadsheetService(), { properties: scriptProperties(), setup: setupMode === true });
}

/** 候補の配列から id で位置を探す */
export function indexOfCandidate(list, id) {
  const key = String(id === null || id === undefined ? "" : id).trim();
  if (key === "") return -1;
  for (let i = 0; i < list.length; i += 1) {
    if (String(list[i].id).trim() === key) return i;
  }
  return -1;
}

/** 画面に渡す形（候補＋画面が組めない URL と登録可否だけ足す） */
export function toClientCandidate(candidate, settings) {
  const c = candidate || {};
  const out = {};
  const names = Object.keys(c);
  for (let i = 0; i < names.length; i += 1) out[names[i]] = c[names[i]];
  const plan = buildEventPlan(c, settings);
  out.registerable = plan.type !== "invalid";
  out.planReason = plan.type === "invalid" ? plan.reason || "" : "";
  out.gmailUrl = gmailMessageUrl(c.messageId);
  const at = c.start || c.deadline || null;
  out.calendarUrl = at ? calendarDayUrl(at) : "";
  return out;
}

/**
 * 台帳を用意する（1 回だけ実行する）。トリガーは作らない。
 * @returns {{spreadsheetId: string, url: string, sheets: string[], intervalHours: number}}
 */
export function setup() {
  const ledger = openLedgerForApp(true);
  const settings = ledger.readSettings();
  console.log("台帳を用意しました: " + (ledger.url || ledger.spreadsheetId));
  console.log("次は importMail() を実行して、`候補` シートに候補が入るのを確かめてください。");
  return {
    spreadsheetId: ledger.spreadsheetId,
    url: ledger.url,
    sheets: ["候補", "設定", "処理済みメール"],
    intervalHours: settings.intervalHours,
  };
}

/**
 * Gmail を読んで候補を台帳に足す。**カレンダーには触れない**（K-2）。
 * @returns {{added: number, noise: number, duplicates: number, looked: number, skipped: boolean, stopped: boolean}}
 */
export function importMail() {
  const lock = importLock();
  if (lock && typeof lock.tryLock === "function" && !lock.tryLock(LOCK_WAIT_MS)) {
    console.log("別の取り込みが動いているので、今回は何もしません");
    return { added: 0, noise: 0, duplicates: 0, looked: 0, skipped: true, stopped: false };
  }
  try {
    return runImport();
  } finally {
    if (lock && typeof lock.releaseLock === "function") lock.releaseLock();
  }
}

/** 取り込みの本体（ロックの中で走る） */
export function runImport() {
  const startedAt = Date.now();
  const ledger = openLedgerForApp(false);
  const settings = ledger.readSettings();
  const query = buildGmailQuery(settings);
  // 処理済み id を先に読んで渡す＝除外するメッセージの本文を読まない（軽微 7）
  const processedIds = ledger.readProcessedIds();
  const mails = listRecentMails(gmailService(), query, {
    max: settings.maxMessagesPerRun,
    skipIds: processedIds,
  });
  const existing = ledger.readCandidates();
  const incoming = [];
  const doneIds = [];
  const doneResults = [];
  let looked = 0;
  let stopped = false;

  for (let i = 0; i < mails.length; i += 1) {
    if (Date.now() - startedAt > IMPORT_TIME_BUDGET_MS) {
      stopped = true; // 残りは次回の実行で拾う（処理済みに書いていないので消えない）
      break;
    }
    const mail = mails[i];
    if (!mail || !mail.id || processedIds.has(String(mail.id))) continue;
    looked += 1;
    let meta = null;
    try {
      meta = parseMailWithMeta(mail);
    } catch (err) {
      doneIds.push(mail.id);
      doneResults.push("解析不能");
      continue;
    }
    if (meta.candidates.length > 0) {
      for (let k = 0; k < meta.candidates.length; k += 1) incoming.push(meta.candidates[k]);
      doneIds.push(mail.id);
      doneResults.push("候補 " + meta.candidates.length + " 件");
      continue;
    }
    // 候補にならなかったメールも消さずに「ノイズ」として残す（見逃しを本人が確認できる。FR-01）
    incoming.push(noiseCandidateFrom(mail, meta));
    doneIds.push(mail.id);
    doneResults.push(meta.isNoise ? "ノイズ" : meta.kind === "result" ? "合否" : "候補なし");
  }

  // 重複はすべて mergeCandidates が鍵で弾く。日時の無い候補（ノイズ行を含む）は
  // candidateKey に messageId が混ざるので、別のメールから来た行が共倒れしない（重要 2）
  const merged = mergeCandidates(existing, incoming);
  if (merged.rows.length > 0) ledger.appendCandidates(merged.rows);
  if (doneIds.length > 0) ledger.appendProcessed(doneIds, doneResults);
  ledger.writeSetting(settingLabel("lastRun"), nowIsoJst());
  ledger.writeSetting(settingLabel("lastImportCount"), merged.added.length);
  let addedCount = 0;
  let noiseCount = 0;
  for (let i = 0; i < merged.added.length; i += 1) {
    if (merged.added[i].status === CANDIDATE_STATUS_NOISE) noiseCount += 1;
    else addedCount += 1;
  }

  return {
    added: addedCount,
    noise: noiseCount,
    duplicates: merged.duplicates.length,
    looked: looked,
    skipped: false,
    stopped: stopped,
  };
}

/** 候補にならなかったメールの 1 行（本文は入れない・NFR-02） */
export function noiseCandidateFrom(mail, meta) {
  const source = mail || {};
  const info = meta || { kind: "other", isNoise: true, reasons: [] };
  const company = extractCompany({ from: source.from, subject: source.subject, body: source.body });
  let note = "日時が読めませんでした";
  if (info.isNoise) note = "ノイズと判定";
  else if (info.kind === "result") note = "合否の連絡（予定は作りません）";
  return {
    id: newCandidateId(source.id, 0),
    messageId: String(source.id === null || source.id === undefined ? "" : source.id),
    threadId: String(source.threadId || source.id || ""),
    receivedAt: normalizeReceivedAt(source.date),
    company: company.name,
    media: company.media,
    kind: info.kind || "other",
    stage: null,
    title: "",
    start: null,
    end: null,
    allDay: false,
    deadline: null,
    choices: [],
    location: null,
    url: null,
    subject: truncate(String(source.subject === null || source.subject === undefined ? "" : source.subject), 200),
    from: String(source.from === null || source.from === undefined ? "" : source.from),
    confidence: "low",
    reasons: (info.reasons || []).slice(0, 3),
    status: CANDIDATE_STATUS_NOISE,
    eventId: null,
    registeredAt: null,
    note: note,
  };
}

/**
 * `設定` の実行間隔で時間主導トリガーを作る（既存の同じトリガーは作り直す）。
 * @returns {{hours: number, replaced: number}}
 */
export function createTrigger() {
  const ledger = openLedgerForApp(false);
  const settings = ledger.readSettings();
  const removed = deleteTriggers();
  triggerService().newTrigger(TRIGGER_HANDLER).timeBased().everyHours(settings.intervalHours).create();
  return { hours: settings.intervalHours, replaced: removed.deleted };
}

/**
 * 自動取り込みを止める（**危険**: 以後メールを見なくなる。予定は消えない）。
 * @returns {{deleted: number}}
 */
export function deleteTriggers() {
  const service = triggerService();
  const triggers = service.getProjectTriggers() || [];
  let deleted = 0;
  for (let i = 0; i < triggers.length; i += 1) {
    const handler =
      triggers[i] && typeof triggers[i].getHandlerFunction === "function" ? triggers[i].getHandlerFunction() : "";
    if (handler !== TRIGGER_HANDLER) continue;
    service.deleteTrigger(triggers[i]);
    deleted += 1;
  }
  return { deleted: deleted };
}

/**
 * 確認画面を返す（Web アプリ・アクセスは自分のみ）。
 * @param {object} [e] クエリパラメータ（今は使わない）
 * @returns {object} HtmlOutput
 */
export function doGet(e) {
  return pageService()
    .createHtmlOutputFromFile("index")
    .setTitle(APP_TITLE)
    .addMetaTag("viewport", "width=device-width, initial-scale=1");
}

/**
 * 画面が最初に呼ぶ。台帳の全候補と設定を返す。
 * @returns {{candidates: object[], settings: object, lastRun: string, lastImportCount: number, ledgerUrl: string, now: string}}
 */
export function api_listCandidates() {
  const ledger = openLedgerForApp(false);
  const settings = ledger.readSettings();
  const list = ledger.readCandidates();
  const candidates = [];
  for (let i = 0; i < list.length; i += 1) candidates.push(toClientCandidate(list[i], settings));
  return {
    candidates: candidates,
    settings: {
      intervalHours: settings.intervalHours,
      searchDays: settings.searchDays,
      maxMessagesPerRun: settings.maxMessagesPerRun,
      calendarId: settings.calendarId,
      // 締切カードの「終日予定＋前日 9:00 に通知」を画面が文言にする（900 = 前日 9:00）
      deadlineReminderMinutes: settings.deadlineReminderMinutes,
    },
    lastRun: settings.lastRun || "",
    lastImportCount: settings.lastImportCount || 0,
    ledgerUrl: ledger.url,
    now: nowIsoJst(),
  };
}

/**
 * 候補 1 件を編集内容ごとカレンダーに登録する（**ここだけがカレンダーに書く**）。
 * @param {string} id
 * @param {string} [editsJson] `{"title","start","end","deadline","location","company"}` の JSON 文字列
 * @returns {{ok: boolean, id: string, eventId?: string, duplicateOf?: string, reason?: string, candidate: object}}
 */
export function api_registerCandidate(id, editsJson) {
  const edits = parseEdits(editsJson);
  return withRegisterLock(function () {
    const ledger = openLedgerForApp(false);
    const settings = ledger.readSettings();
    const list = ledger.readCandidates();
    return registerOne(ledger, settings, list, id, edits);
  });
}

/**
 * まとめて登録（高確度だけを画面が選んで渡す）。1 件失敗しても残りは進む。
 *
 * `registeredIds` は**実際に予定を作れた id だけ**。画面はこれを覚えて、帯の
 * 「まとめて取り消す」で 1 件ずつ `api_undoRegister` に渡す（docs/02 ④）。
 * @param {string|string[]} idsJson id の配列 or その JSON 文字列
 * @returns {{results: object[], registeredIds: string[]}}
 */
export function api_registerBulk(idsJson) {
  const ids = parseIdList(idsJson);
  return withRegisterLock(function () {
    const ledger = openLedgerForApp(false);
    const settings = ledger.readSettings();
    const list = ledger.readCandidates();
    const results = [];
    const registeredIds = [];
    for (let i = 0; i < ids.length; i += 1) {
      try {
        const one = registerOne(ledger, settings, list, ids[i], null);
        results.push(one);
        if (one.ok === true) registeredIds.push(String(one.id));
      } catch (err) {
        results.push({ ok: false, id: String(ids[i]), reason: errorMessage(err), candidate: null });
      }
    }
    return { results: results, registeredIds: registeredIds };
  });
}

/**
 * 状態を「無視」にする（予定は作らない・冪等）。
 * 「登録済み」は弾く（軽微 4）。無視にすると予定 ID を持ったままカレンダーに予定が残り、
 * 画面からは取り消せなくなる。`api_restoreCandidate` と同じ形にそろえてある。
 */
export function api_ignoreCandidate(id) {
  return withRegisterLock(function () {
    const ledger = openLedgerForApp(false);
    const settings = ledger.readSettings();
    const list = ledger.readCandidates();
    const index = indexOfCandidate(list, id);
    if (index < 0) throw new Error("候補が見つかりません: " + String(id));
    if (list[index].status === CANDIDATE_STATUS_REGISTERED) {
      return {
        ok: false,
        id: String(id),
        reason: "登録済みの候補は「取り消す」を使ってください",
        candidate: toClientCandidate(list[index], settings),
      };
    }
    return changeCandidateStatus(id, CANDIDATE_STATUS_IGNORED, "");
  });
}

/** ノイズ・無視から「候補」に戻す */
export function api_restoreCandidate(id) {
  return withRegisterLock(function () {
    const ledger = openLedgerForApp(false);
    const settings = ledger.readSettings();
    const list = ledger.readCandidates();
    const index = indexOfCandidate(list, id);
    if (index < 0) throw new Error("候補が見つかりません: " + String(id));
    if (list[index].status === CANDIDATE_STATUS_REGISTERED) {
      return {
        ok: false,
        id: String(id),
        reason: "登録済みの候補は「取り消す」を使ってください",
        candidate: toClientCandidate(list[index], settings),
      };
    }
    const next = setStatus(list[index], CANDIDATE_STATUS_NEW, { note: "" });
    ledger.upsertCandidate(next);
    return { ok: true, id: String(id), candidate: toClientCandidate(next, settings) };
  });
}

/**
 * 登録を取り消す。予定を消して状態を「候補」に戻す（冪等・FR-10）。
 *
 * 登録と同じ `LockService` の中で行う（レビュー r2 軽微 4）。登録の途中に割り込むと、
 * 台帳がまだ「候補」なので何もせずに `ok: true` を返し、画面が「取り消しました」と嘘をつく。
 * @param {string} id
 * @returns {{ok: boolean, id: string, deleted: boolean, candidate: object}}
 */
export function api_undoRegister(id) {
  return withRegisterLock(function () {
    const ledger = openLedgerForApp(false);
    const settings = ledger.readSettings();
    const list = ledger.readCandidates();
    const index = indexOfCandidate(list, id);
    if (index < 0) throw new Error("候補が見つかりません: " + String(id));
    const current = list[index];
    let deleted = false;
    if (current.eventId) {
      deleted = deleteEventById(calendarService(), current.eventId, { calendarId: settings.calendarId });
    }
    const next = setStatus(current, CANDIDATE_STATUS_NEW, {
      eventId: null,
      registeredAt: null,
      note: current.eventId && !deleted ? "予定は見つかりませんでした（すでに削除済み）" : "",
    });
    ledger.upsertCandidate(next);
    return { ok: true, id: String(id), deleted: deleted, candidate: toClientCandidate(next, settings) };
  });
}

/** 画面の「いま取り込む」 */
export function api_importNow() {
  const result = importMail();
  return { added: result.added, noise: result.noise, skipped: result.skipped === true };
}

/**
 * 本人がシートの状態列に「登録」と書いた行をまとめて登録する（FR-07・Web アプリ無しの運用）。
 * `importMail()` から呼ばない＝取り込みはカレンダーに触れない（K-2）。
 * @returns {{results: object[]}}
 */
export function registerMarked() {
  return withRegisterLock(function () {
    const ledger = openLedgerForApp(false);
    const settings = ledger.readSettings();
    const list = ledger.readCandidates();
    const results = [];
    for (let i = 0; i < list.length; i += 1) {
      if (String(list[i].status).trim() !== CANDIDATE_STATUS_MANUAL) continue;
      try {
        results.push(registerOne(ledger, settings, list, list[i].id, null));
      } catch (err) {
        results.push({ ok: false, id: String(list[i].id), reason: errorMessage(err), candidate: null });
      }
    }
    return { results: results };
  });
}

/** 登録の本体。台帳の配列 `list` はその場で更新する（まとめて登録の重複判定に効かせるため） */
export function registerOne(ledger, settings, list, id, edits) {
  const index = indexOfCandidate(list, id);
  if (index < 0) throw new Error("候補が見つかりません: " + String(id));
  const current = list[index];
  if (current.status === CANDIDATE_STATUS_REGISTERED && current.eventId) {
    return {
      ok: false,
      id: String(current.id),
      duplicateOf: String(current.id),
      reason: "この候補はすでに登録済みです",
      candidate: toClientCandidate(current, settings),
    };
  }
  const candidate = applyEdits(current, edits);
  const plan = buildEventPlan(candidate, settings);
  if (plan.type === "invalid") {
    const noted = setStatus(candidate, candidate.status || CANDIDATE_STATUS_NEW, { note: plan.reason || "" });
    ledger.upsertCandidate(noted);
    list[index] = noted;
    return {
      ok: false,
      id: String(noted.id),
      reason: plan.reason || "日時を入力してください",
      candidate: toClientCandidate(noted, settings),
    };
  }
  const duplicate = findDuplicateRegistered(list, candidate);
  if (duplicate) {
    const noted = setStatus(candidate, candidate.status || CANDIDATE_STATUS_NEW, { note: "重複: " + duplicate.id });
    ledger.upsertCandidate(noted);
    list[index] = noted;
    return {
      ok: false,
      id: String(noted.id),
      duplicateOf: String(duplicate.id),
      reason: "同じ企業・種別・日時の予定がすでに登録済みです",
      candidate: toClientCandidate(noted, settings),
    };
  }
  const created = createEventFromPlan(calendarService(), plan, {
    calendarId: settings.calendarId,
    candidateId: candidate.id,
  });
  const registered = setStatus(candidate, CANDIDATE_STATUS_REGISTERED, {
    eventId: created.eventId,
    registeredAt: nowIsoJst(),
    note: "",
  });
  // 台帳（正本）にはカレンダーに入れた終了時刻をそのまま残す（レビュー r1 重要 6）
  if (plan.type === "timed") registered.end = plan.end;
  ledger.upsertCandidate(registered);
  list[index] = registered;
  return {
    ok: true,
    id: String(registered.id),
    eventId: created.eventId,
    candidate: toClientCandidate(registered, settings),
  };
}

/** 状態だけを変える（無視など） */
export function changeCandidateStatus(id, status, note) {
  const ledger = openLedgerForApp(false);
  const settings = ledger.readSettings();
  const list = ledger.readCandidates();
  const index = indexOfCandidate(list, id);
  if (index < 0) throw new Error("候補が見つかりません: " + String(id));
  const next = setStatus(list[index], status, { note: note || "" });
  ledger.upsertCandidate(next);
  return { ok: true, id: String(id), candidate: toClientCandidate(next, settings) };
}

/** 画面から来た編集内容（JSON 文字列）を読む */
export function parseEdits(value) {
  if (value === null || value === undefined || value === "") return {};
  if (typeof value === "object") return value;
  let parsed = null;
  try {
    parsed = JSON.parse(String(value));
  } catch (err) {
    throw new Error("編集内容を読めませんでした");
  }
  return parsed && typeof parsed === "object" ? parsed : {};
}

/** まとめて登録の id 配列を読む */
export function parseIdList(value) {
  if (Array.isArray(value)) return value.slice();
  const parsed = parseEdits(value);
  if (Array.isArray(parsed)) return parsed;
  if (parsed && Array.isArray(parsed.ids)) return parsed.ids;
  return [];
}

/** 編集内容を候補に反映する（元の候補は書き換えない） */
export function applyEdits(candidate, edits) {
  const next = setStatus(candidate, candidate.status, {});
  const source = edits || {};
  let companyEdited = false;
  if (typeof source.company === "string") {
    const value = source.company.trim();
    next.company = value === "" ? null : normalizeCompany(value);
    companyEdited = true;
  }
  if (typeof source.location === "string") {
    const value = source.location.trim();
    next.location = value === "" ? null : value;
  }
  if (source.start !== undefined) next.start = normalizeEditedDateTime(source.start);
  if (source.end !== undefined) next.end = normalizeEditedDateTime(source.end);
  if (source.deadline !== undefined) next.deadline = normalizeEditedDateTime(source.deadline);
  if (source.start !== undefined || source.end !== undefined) {
    next.allDay = next.start ? !hasTimePart(next.start) : next.allDay;
    if (next.allDay) next.end = null;
  }
  // 終了が開始以前なら台帳にも残さない（既定の長さに任せる。レビュー r1 重要 6）。
  // 倒すのが plan の中だけだと、カレンダーは 15:00 なのに台帳と画面は「14:00〜13:00」になる
  if (next.start && next.end) {
    const startAt = jstEpochFromIso(next.start);
    const endAt = jstEpochFromIso(next.end);
    if (isFinite(startAt) && isFinite(endAt) && endAt <= startAt) next.end = null;
  }
  if (typeof source.title === "string" && source.title.trim() !== "") next.title = source.title.trim();
  else if (companyEdited ||
    ((source.start !== undefined || source.deadline !== undefined) && candidate.title === titleFor(candidate))) {
    next.title = titleFor(next);
  }
  return next;
}

/** `datetime-local`／`date` の値を ISO（+09:00）に直す */
export function normalizeEditedDateTime(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (text === "") return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{1,2}):(\d{2})/.exec(text);
  if (m) {
    const hour = Number(m[2]);
    return m[1] + "T" + (hour < 10 ? "0" : "") + String(hour) + ":" + m[3] + ":00+09:00";
  }
  const epoch = jstEpochFromIso(text);
  if (isFinite(epoch)) return isoFromJstEpoch(epoch, !hasTimePart(text));
  throw new Error("日時の形が読めません: " + text);
}

/** 例外の文言（画面に出す。本文は含めない） */
export function errorMessage(err) {
  if (!err) return "不明なエラー";
  if (typeof err === "string") return err;
  return String(err.message || err);
}
