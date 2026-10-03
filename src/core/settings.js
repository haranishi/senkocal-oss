/**
 * settings.js — `設定` シートの既定値と読み書きの形
 *
 * シートのキーは日本語（本人が直接編集するため。docs/03 §3-2）、
 * プログラム側のフィールド名は英語にして、対応表 SETTINGS_FIELDS で橋渡しする。
 * 値が壊れていても止まらないのが仕事なので、欠落・NaN・範囲外はすべて既定へ倒す。
 */

/** 既定の検索キーワード（Gmail 検索の OR 句にそのまま入る） */
export const DEFAULT_SEARCH_KEYWORDS =
  "面接 OR 面談 OR 説明会 OR セミナー OR 選考 OR エントリー OR 締切 OR 〆切 OR 適性検査 OR Webテスト OR SPI OR 内定 OR 日程";

/** 通知（ポップアップ）に指定できる範囲。Google カレンダーの上限が 4 週間 */
export const REMINDER_MIN_MINUTES = 5;
export const REMINDER_MAX_MINUTES = 40320;

/**
 * 設定の項目表。シートの見え方（キー・説明）と、丸めの範囲をここだけで持つ。
 * type: int / text / minutes（分の配列）
 */
export const SETTINGS_FIELDS = [
  { field: "searchDays", label: "検索日数", type: "int", min: 1, max: 30, note: "Gmail を何日ぶんさかのぼるか" },
  { field: "keywords", label: "キーワード", type: "text", note: "OR でつなぐ。空にすると既定に戻る" },
  { field: "excludeSenders", label: "除外送信者", type: "text", note: "カンマ区切り。-from: に展開する" },
  { field: "calendarId", label: "カレンダーID", type: "text", note: "空なら既定のカレンダー" },
  {
    field: "deadlineReminderMinutes",
    label: "締切リマインダー分",
    type: "int",
    min: REMINDER_MIN_MINUTES,
    max: REMINDER_MAX_MINUTES,
    note: "終日予定の通知。900 = 前日 9:00",
  },
  {
    field: "eventReminderMinutes",
    label: "予定リマインダー分",
    type: "minutes",
    note: "時刻付き予定の通知。カンマ区切り",
  },
  { field: "intervalHours", label: "実行間隔時間", type: "int", min: 1, max: 12, note: "トリガーの間隔" },
  { field: "maxMessagesPerRun", label: "1回の上限", type: "int", min: 1, max: 200, note: "1 回の取り込みで見るメール数" },
  { field: "defaultEventMinutes", label: "予定の既定長さ分", type: "int", min: 5, max: 720, note: "終了時刻が無いとき" },
  { field: "lastRun", label: "最終実行", type: "text", note: "書き込み専用" },
  { field: "lastImportCount", label: "最終取り込み件数", type: "int", min: 0, max: 100000, note: "書き込み専用" },
];

/** 既定値（setup() が書く初期状態でもある） */
export const SETTINGS_DEFAULTS = {
  searchDays: 7,
  keywords: DEFAULT_SEARCH_KEYWORDS,
  excludeSenders: "",
  calendarId: "",
  deadlineReminderMinutes: 900,
  eventReminderMinutes: [60, 1440],
  intervalHours: 2,
  maxMessagesPerRun: 50,
  defaultEventMinutes: 60,
  lastRun: "",
  lastImportCount: 0,
};

/**
 * 数値を範囲に丸める。数値でなければ既定を返す。
 * **数字が 2 か所以上ある文字列は既定に倒す**（軽微 14）。以前は数字以外を捨てていたので
 * `"60,1440"` が `601440` に化けて上限へ張り付いていた。単位つき（`"900分"`）は読む。
 * @param {*} value
 * @param {number} min
 * @param {number} max
 * @param {number} fallback
 * @returns {number}
 */
export function clampNumber(value, min, max, fallback) {
  let n;
  if (typeof value === "number") {
    n = value;
  } else {
    const text = String(value === null || value === undefined ? "" : value).trim();
    const runs = text.match(/\d+(?:\.\d+)?/g);
    if (!runs || runs.length !== 1) return fallback;
    n = (text.charAt(0) === "-" ? -1 : 1) * parseFloat(runs[0]);
  }
  if (!isFinite(n)) return fallback;
  const rounded = Math.round(n);
  if (rounded < min) return min;
  if (rounded > max) return max;
  return rounded;
}

/**
 * 通知の分の配列を 5〜40320 に丸め、重複を除く。空になったら既定へ倒す。
 * @param {*} value 配列でも "60,1440" のような文字列でもよい
 * @param {number[]} fallback
 * @returns {number[]}
 */
export function clampMinutesList(value, fallback) {
  let list = [];
  if (Array.isArray(value)) list = value;
  else if (value !== null && value !== undefined && String(value).trim() !== "") list = String(value).split(/[,、\s]+/);
  const out = [];
  for (let i = 0; i < list.length; i += 1) {
    const raw = list[i];
    if (raw === null || raw === undefined || String(raw).trim() === "") continue;
    const n = clampNumber(raw, REMINDER_MIN_MINUTES, REMINDER_MAX_MINUTES, NaN);
    if (!isFinite(n)) continue;
    if (out.indexOf(n) < 0) out.push(n);
  }
  if (out.length === 0) return (fallback || []).slice();
  return out;
}

/**
 * `設定` シートの行（[キー, 値, 説明]）から設定オブジェクトを作る。
 * @param {Array<Array<*>>} rows
 * @returns {object}
 */
export function settingsFromRows(rows) {
  const byLabel = {};
  const list = Array.isArray(rows) ? rows : [];
  for (let i = 0; i < list.length; i += 1) {
    const row = list[i];
    if (!row || row.length === 0) continue;
    const key = String(row[0] === null || row[0] === undefined ? "" : row[0]).trim();
    if (key === "" || key === "キー" || key === "key") continue;
    byLabel[key] = row.length > 1 ? row[1] : "";
  }
  const settings = {};
  for (let i = 0; i < SETTINGS_FIELDS.length; i += 1) {
    const spec = SETTINGS_FIELDS[i];
    const fallback = SETTINGS_DEFAULTS[spec.field];
    const raw = byLabel[spec.label];
    if (spec.type === "int") {
      settings[spec.field] = clampNumber(raw, spec.min, spec.max, fallback);
    } else if (spec.type === "minutes") {
      settings[spec.field] = clampMinutesList(raw, fallback);
    } else {
      const text = raw === null || raw === undefined ? "" : String(raw).trim();
      settings[spec.field] = text === "" ? fallback : text;
    }
  }
  return settings;
}

/**
 * 設定オブジェクト → `設定` シートの行（見出し行は含めない）。
 * @param {object} settings
 * @returns {Array<Array<*>>}
 */
export function settingsToRows(settings) {
  const merged = settingsFromRows([]);
  const source = settings || {};
  const names = Object.keys(merged);
  for (let i = 0; i < names.length; i += 1) {
    const name = names[i];
    if (source[name] !== undefined && source[name] !== null) merged[name] = source[name];
  }
  const normalized = settingsFromRows(
    SETTINGS_FIELDS.map(function (spec) {
      return [spec.label, Array.isArray(merged[spec.field]) ? merged[spec.field].join(",") : merged[spec.field]];
    })
  );
  const rows = [];
  for (let i = 0; i < SETTINGS_FIELDS.length; i += 1) {
    const spec = SETTINGS_FIELDS[i];
    const value = normalized[spec.field];
    rows.push([spec.label, Array.isArray(value) ? value.join(",") : value, spec.note]);
  }
  return rows;
}
