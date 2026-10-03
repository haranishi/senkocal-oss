/**
 * query.js — 設定 → Gmail の検索クエリ（FR-01）
 *
 * 取り込み元は Gmail だけ（K-1）。媒体サイトには一切アクセスしないので、
 * 「どのメールを見るか」はこのクエリがすべてを決める。広く取って台帳で捨てる方針
 * （拾いすぎはノイズ行が増えるだけだが、取りこぼしは気づけない）。
 */

import { SETTINGS_DEFAULTS, clampNumber } from "./settings.js";

/** 迷惑メールとゴミ箱は常に外す */
export const QUERY_EXCLUDE_TAIL = ["-in:spam", "-in:trash"];

/**
 * キーワードから落とす文字（軽微 5）。`キーワード` はそのまま `(…)` の中に入るので、
 * 括弧や引用符が混ざると検索式の意味が変わる（`) OR in:anywhere (` と書くと除外が外れる）。
 * 本人が自分のシートに書く値なので事故は小さいが、丸めるのは 1 行で済む。
 */
const KEYWORD_UNSAFE_REGEX = /[(){}"]/g;

/**
 * キーワードを検索式に入れられる形にする。
 * @param {*} value
 * @returns {string}
 */
export function sanitizeKeywords(value) {
  const text = String(value === null || value === undefined ? "" : value);
  return text.replace(KEYWORD_UNSAFE_REGEX, " ").replace(/\s+/g, " ").trim();
}

/**
 * 除外送信者の設定（カンマ・空白・セミコロン区切り）を `-from:` の並びにする。
 * @param {string} value
 * @returns {string[]}
 */
export function buildExcludeFromTerms(value) {
  const text = String(value === null || value === undefined ? "" : value).trim();
  if (text === "") return [];
  const parts = text.split(/[,、;\s]+/);
  const out = [];
  for (let i = 0; i < parts.length; i += 1) {
    const item = parts[i].trim().replace(/^-?from:/i, "");
    if (item === "") continue;
    const term = "-from:" + item;
    if (out.indexOf(term) < 0) out.push(term);
  }
  return out;
}

/**
 * Gmail の検索クエリを組む。
 * @param {object} [settings]
 * @returns {string}
 */
export function buildGmailQuery(settings) {
  const s = settings || SETTINGS_DEFAULTS;
  const days = clampNumber(s.searchDays, 1, 30, SETTINGS_DEFAULTS.searchDays);
  const rawKeywords = sanitizeKeywords(s.keywords);
  const keywords = rawKeywords === "" ? SETTINGS_DEFAULTS.keywords : rawKeywords;
  const terms = ["newer_than:" + days + "d", "(" + keywords + ")"];
  const excludes = buildExcludeFromTerms(s.excludeSenders);
  for (let i = 0; i < excludes.length; i += 1) terms.push(excludes[i]);
  for (let i = 0; i < QUERY_EXCLUDE_TAIL.length; i += 1) terms.push(QUERY_EXCLUDE_TAIL[i]);
  return terms.join(" ");
}
