/**
 * events.js — 候補 → カレンダー予定の計画（FR-09）
 *
 * ここは「何を書くか」を決めるだけで、カレンダーには触らない（触るのは C2 のアダプター）。
 * 締切を時刻付きの予定にしないのが肝（UX 5階層 ②）。期限は時間枠ではないので終日＋前日通知にする。
 * description に本文を絶対に入れない（NFR-02）。入れるのは件名・Gmail リンク・候補 id だけ。
 */

import {
  addDays,
  addMinutes,
  formatJa,
  formatMd,
  formatTimeJa,
  hasTimePart,
  jstEpochFromIso,
  toDateOnly,
} from "./dates.js";
import { SETTINGS_DEFAULTS, clampMinutesList, clampNumber } from "./settings.js";
import { truncate } from "./text.js";

/** Gmail の該当メールを開く URL（画面と予定の説明に貼る） */
export const GMAIL_MESSAGE_URL_PREFIX = "https://mail.google.com/mail/u/0/#all/";
/** カレンダーのその日を開く URL */
export const CALENDAR_DAY_URL_PREFIX = "https://calendar.google.com/calendar/u/0/r/day/";
/** 企業名が取れなかった候補のタイトルに使う */
export const DEFAULT_COMPANY_LABEL = "（企業名未設定）";
/** 締切の時刻が書かれていなかったときに使う時刻 */
export const DEFAULT_DEADLINE_TIME = "23:59";
/** 確度の文言（色に頼らず言葉で示す。NFR-06） */
export const CONFIDENCE_LABELS = { high: "高", medium: "中", low: "低" };
/** 予定の説明の末尾に入れる出所 */
export const EVENT_SIGNATURE_LINE = "選考カレンダーで登録";

/** Gmail のメッセージ URL */
export function gmailMessageUrl(messageId) {
  const id = String(messageId === null || messageId === undefined ? "" : messageId);
  return id === "" ? "" : GMAIL_MESSAGE_URL_PREFIX + id;
}

/**
 * カレンダーのその日を開く URL。
 * @param {string} iso
 * @returns {string}
 */
export function calendarDayUrl(iso) {
  const date = toDateOnly(iso);
  if (!date) return CALENDAR_DAY_URL_PREFIX.replace(/\/$/, "");
  const parts = date.split("-");
  return CALENDAR_DAY_URL_PREFIX + Number(parts[0]) + "/" + Number(parts[1]) + "/" + Number(parts[2]);
}

/** 通知の分を 5〜40320 に丸め、重複を除く */
export function clampReminders(minutes) {
  return clampMinutesList(minutes, []);
}

/** 面接の段階 → タイトルに付ける言葉 */
function stageLabel(stage) {
  if (!stage) return "";
  if (stage === "カジュアル") return "カジュアル面談";
  return stage + "面接";
}

/** 締切のタイトルに出す時刻（時刻が無ければ 23:59） */
function deadlineTimeLabel(candidate) {
  const at = candidate && candidate.deadline ? candidate.deadline : null;
  if (at && hasTimePart(at)) return formatTimeJa(at);
  return DEFAULT_DEADLINE_TIME;
}

/** タイトルの上限（件名と同じ 200 字でそろえる。軽微 15） */
export const TITLE_MAX_LENGTH = 200;

/**
 * 予定のタイトルを作る。
 * @param {object} candidate
 * @returns {string}
 */
export function titleFor(candidate) {
  return truncate(rawTitleFor(candidate), TITLE_MAX_LENGTH);
}

/** タイトルの本体（長さを切る前） */
function rawTitleFor(candidate) {
  const c = candidate || {};
  const company = c.company ? String(c.company) : DEFAULT_COMPANY_LABEL;
  const kind = c.kind || "other";
  // 開始が無く締切だけの説明会・面接は「申込締切」の予定にする（重要 7）。
  // 「【説明会】…」の名前で締切日に置くと、その日に説明会があるように見えてしまう。
  if ((kind === "seminar" || kind === "interview") && !c.start && c.deadline) {
    const time = hasTimePart(c.deadline) ? formatTimeJa(c.deadline) : "";
    const head = "【申込締切" + (time ? " " + time : "") + "】";
    const tail = kind === "seminar" ? " 説明会" : " " + (stageLabel(c.stage) || "面接");
    return head + company + tail;
  }
  if (kind === "interview") {
    const label = stageLabel(c.stage);
    return "【面接】" + company + (label ? " " + label : "");
  }
  if (kind === "seminar") return "【説明会】" + company;
  if (kind === "es_deadline") return "【締切 " + deadlineTimeLabel(c) + "】" + company + " ES提出";
  if (kind === "test_deadline") return "【締切 " + deadlineTimeLabel(c) + "】" + company + " Webテスト";
  if (kind === "schedule_request") {
    const choices = Array.isArray(c.choices) ? c.choices : [];
    if (choices.length === 0) return "【要返信】" + company + " 日程選択";
    const shown = [];
    for (let i = 0; i < choices.length && i < 3; i += 1) shown.push(formatMd(choices[i]));
    const more = choices.length > 3 ? "ほか" : "";
    return "【要返信】" + company + " 日程選択（候補: " + shown.join("・") + more + "）";
  }
  if (kind === "change") {
    const text = String(c.subject || "") + String(c.title || "");
    const target = /説明会|セミナー|座談会|インターン/.test(text) ? "説明会" : "面接";
    return "【変更】" + company + " " + target;
  }
  return "【選考】" + company;
}

/**
 * 予定の説明を作る。**本文は入れない**（NFR-02）。
 * @param {object} candidate
 * @returns {string}
 */
export function descriptionFor(candidate) {
  const c = candidate || {};
  const lines = [];
  if (c.subject) lines.push("件名: " + truncate(String(c.subject), 200));
  const confidence = CONFIDENCE_LABELS[c.confidence] || "";
  if (confidence) lines.push("確度: " + confidence);
  const choices = Array.isArray(c.choices) ? c.choices : [];
  if (choices.length > 0) {
    const shown = [];
    for (let i = 0; i < choices.length; i += 1) shown.push(formatJa(choices[i]));
    lines.push("候補日: " + shown.join("・"));
  }
  if (c.deadline) lines.push("締切: " + formatJa(c.deadline));
  if (c.location) lines.push("場所: " + String(c.location));
  if (c.url) lines.push("URL: " + String(c.url));
  const gmail = gmailMessageUrl(c.messageId);
  if (gmail) lines.push("Gmail: " + gmail);
  if (c.id) lines.push("候補ID: " + String(c.id));
  lines.push(EVENT_SIGNATURE_LINE);
  return lines.join("\n");
}

/**
 * 候補と設定から「カレンダーに何を書くか」を決める。
 * @param {object} candidate
 * @param {object} [settings]
 * @returns {{type: string, title: string, start: string|null, end: string|null, date: string|null, description: string, location: string, reminders: number[], reason?: string}}
 */
export function buildEventPlan(candidate, settings) {
  const c = candidate || {};
  const s = settings || SETTINGS_DEFAULTS;
  const defaultMinutes = clampNumber(s.defaultEventMinutes, 5, 720, SETTINGS_DEFAULTS.defaultEventMinutes);
  // 設定が壊れていても予定は作れるようにする（丸めた結果が空なら既定へ倒す）
  let timedReminders = clampReminders(s.eventReminderMinutes);
  if (timedReminders.length === 0) timedReminders = clampReminders(SETTINGS_DEFAULTS.eventReminderMinutes);
  let allDayReminders = clampReminders([s.deadlineReminderMinutes]);
  if (allDayReminders.length === 0) allDayReminders = clampReminders([SETTINGS_DEFAULTS.deadlineReminderMinutes]);
  const plan = {
    type: "timed",
    title: c.title && String(c.title).trim() ? truncate(String(c.title).trim(), TITLE_MAX_LENGTH) : titleFor(c),
    start: null,
    end: null,
    date: null,
    description: descriptionFor(c),
    location: c.location ? String(c.location) : "",
    reminders: timedReminders,
  };

  const kind = c.kind || "other";
  const isDeadlineKind = kind === "es_deadline" || kind === "test_deadline";

  if (isDeadlineKind) {
    const date = toDateOnly(c.deadline || c.start);
    if (!date) return invalidPlan(plan, "締切の日付がありません");
    plan.type = "allDay";
    plan.date = date;
    plan.reminders = allDayReminders;
    return plan;
  }

  if (kind === "schedule_request") {
    const fallback = c.receivedAt ? addDays(toDateOnly(c.receivedAt), 1) : null;
    const date = toDateOnly(c.deadline || fallback);
    if (!date) return invalidPlan(plan, "返信期限の日付がありません");
    plan.type = "allDay";
    plan.date = date;
    plan.reminders = allDayReminders;
    return plan;
  }

  if (!c.start) {
    const date = toDateOnly(c.deadline);
    if (!date) return invalidPlan(plan, "日付がありません。編集して日時を入れてください");
    plan.type = "allDay";
    plan.date = date;
    plan.reminders = allDayReminders;
    return plan;
  }

  if (!hasTimePart(c.start) || c.allDay === true) {
    plan.type = "allDay";
    plan.date = toDateOnly(c.start);
    plan.reminders = allDayReminders;
    return plan;
  }

  plan.type = "timed";
  plan.start = c.start;
  plan.end = c.end && hasTimePart(c.end) ? c.end : addMinutes(c.start, defaultMinutes);
  // 画面で終了を打ち間違えてもカレンダー側が例外を投げないように、既定の長さへ倒す（重要 8）
  if (jstEpochFromIso(plan.end) <= jstEpochFromIso(plan.start)) {
    plan.end = addMinutes(plan.start, defaultMinutes);
  }
  return plan;
}

/** 日付が無くて予定にできない候補（画面で編集してもらう） */
function invalidPlan(plan, reason) {
  plan.type = "invalid";
  plan.start = null;
  plan.end = null;
  plan.date = null;
  plan.reminders = [];
  plan.reason = reason;
  return plan;
}
