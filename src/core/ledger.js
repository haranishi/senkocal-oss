/**
 * ledger.js — 台帳（スプレッドシート）の行と候補の相互変換（純関数）
 *
 * 台帳が正本で、Web アプリはその見え方の一つ（UX 5階層 ③）。だから
 * 「行 → 候補 → 行」で情報が落ちないこと（往復で等しいこと）をテストで固定する。
 * シートには**本文を書かない**（NFR-02）。列は docs/03 §3-1 の 24 列で固定。
 */

import { candidateIsPast, candidateKey } from "./parse.js";

/** `候補` シートの見出し（順序固定・docs/03 §3-1） */
export const HEADERS = [
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
];

/**
 * 見出し → 列番号の対応表。`toRow`／`fromRow` は添字を直書きせずここから引く（重要 6）。
 * こうしておくと `HEADERS` を並べ替えたときに、見出しだけが動いて中身がずれる事故が起きない。
 */
const HEADER_INDEX = {};
for (let i = 0; i < HEADERS.length; i += 1) HEADER_INDEX[HEADERS[i]] = i;

/** 見出し名 → 列番号 */
function col(name) {
  const index = HEADER_INDEX[name];
  if (index === undefined) throw new Error("台帳に無い見出しです: " + name);
  return index;
}

/** `処理済みメール` シートの見出し（docs/03 §3-3） */
export const PROCESSED_HEADERS = ["messageId", "処理日時", "結果"];
/** `設定` シートの見出し */
export const SETTINGS_HEADERS = ["キー", "値", "説明"];

/** 候補日・根拠の区切り */
export const LIST_SEPARATOR = ";";

/** 空欄は "" にして書き込む */
function cell(value) {
  return value === null || value === undefined ? "" : value;
}

/** 空欄は null にして読む */
function nullable(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text === "" ? null : text;
}

/** 文字列として読む（空欄は ""） */
function textOf(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

/** TRUE/FALSE も真偽値も読む */
function booleanOf(value) {
  if (value === true || value === false) return value;
  const text = String(value === null || value === undefined ? "" : value).trim().toLowerCase();
  return text === "true" || text === "1" || text === "はい" || text === "yes";
}

/** "a;b" → ["a","b"] */
function listOf(value) {
  const text = String(value === null || value === undefined ? "" : value).trim();
  if (text === "") return [];
  const parts = text.split(LIST_SEPARATOR);
  const out = [];
  for (let i = 0; i < parts.length; i += 1) {
    const item = parts[i].trim();
    if (item !== "") out.push(item);
  }
  return out;
}

/**
 * 候補 → シートの 1 行。
 * @param {object} candidate
 * @returns {Array<*>}
 */
export function toRow(candidate) {
  const c = candidate || {};
  const row = [];
  for (let i = 0; i < HEADERS.length; i += 1) row.push("");
  row[col("id")] = cell(c.id);
  row[col("状態")] = cell(c.status);
  row[col("企業名")] = cell(c.company);
  row[col("種別")] = cell(c.kind);
  row[col("段階")] = cell(c.stage);
  row[col("タイトル")] = cell(c.title);
  row[col("開始")] = cell(c.start);
  row[col("終了")] = cell(c.end);
  row[col("終日")] = c.allDay === true;
  row[col("締切")] = cell(c.deadline);
  row[col("候補日")] = (Array.isArray(c.choices) ? c.choices : []).join(LIST_SEPARATOR);
  row[col("場所")] = cell(c.location);
  row[col("URL")] = cell(c.url);
  row[col("件名")] = cell(c.subject);
  row[col("送信者")] = cell(c.from);
  row[col("媒体")] = cell(c.media);
  row[col("受信日時")] = cell(c.receivedAt);
  row[col("確度")] = cell(c.confidence);
  row[col("根拠")] = (Array.isArray(c.reasons) ? c.reasons : []).join(LIST_SEPARATOR);
  row[col("messageId")] = cell(c.messageId);
  row[col("threadId")] = cell(c.threadId);
  row[col("予定ID")] = cell(c.eventId);
  row[col("登録日時")] = cell(c.registeredAt);
  row[col("備考")] = cell(c.note);
  return row;
}

/**
 * シートの 1 行 → 候補。
 * @param {Array<*>} row
 * @returns {object}
 */
export function fromRow(row) {
  const r = Array.isArray(row) ? row : [];
  const candidate = {
    id: textOf(r[col("id")]),
    messageId: textOf(r[col("messageId")]),
    threadId: textOf(r[col("threadId")]),
    receivedAt: nullable(r[col("受信日時")]),
    company: nullable(r[col("企業名")]),
    media: textOf(r[col("媒体")]),
    kind: textOf(r[col("種別")]),
    stage: nullable(r[col("段階")]),
    title: textOf(r[col("タイトル")]),
    start: nullable(r[col("開始")]),
    end: nullable(r[col("終了")]),
    allDay: booleanOf(r[col("終日")]),
    deadline: nullable(r[col("締切")]),
    choices: listOf(r[col("候補日")]),
    location: nullable(r[col("場所")]),
    url: nullable(r[col("URL")]),
    subject: textOf(r[col("件名")]),
    isPast: false,
    from: textOf(r[col("送信者")]),
    confidence: textOf(r[col("確度")]),
    reasons: listOf(r[col("根拠")]),
    status: textOf(r[col("状態")]),
    eventId: nullable(r[col("予定ID")]),
    registeredAt: nullable(r[col("登録日時")]),
    note: textOf(r[col("備考")]),
  };
  // isPast は列に持たず、開始（無ければ締切）と受信日時から毎回計算する（軽微 5・6）
  candidate.isPast = candidateIsPast(candidate);
  return candidate;
}

/**
 * シートの全行 → 候補の配列（見出し行は読み飛ばす）。
 * @param {Array<Array<*>>} rows
 * @returns {object[]}
 */
export function rowsToCandidates(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const out = [];
  for (let i = 0; i < list.length; i += 1) {
    const row = list[i];
    if (!Array.isArray(row)) continue;
    if (textOf(row[0]) === "") continue;
    // 見出し行は 1 行目に限らず弾く（本人がシートの上に行を挿入することがある。軽微 13）
    if (textOf(row[0]) === HEADERS[0]) continue;
    out.push(fromRow(row));
  }
  return out;
}

/** 候補でも行でも受け取れるようにする */
function asCandidate(value) {
  return Array.isArray(value) ? fromRow(value) : value || {};
}

/**
 * 既存の台帳に新しい候補を足す。鍵が同じものは足さない（FR-11）。
 * @param {Array<object|Array<*>>} existing
 * @param {object[]} incoming
 * @returns {{rows: Array<Array<*>>, added: object[], duplicates: object[]}}
 */
export function mergeCandidates(existing, incoming) {
  const seen = {};
  const existingList = Array.isArray(existing) ? existing : [];
  for (let i = 0; i < existingList.length; i += 1) {
    const c = asCandidate(existingList[i]);
    if (!c || !c.kind) continue;
    seen[candidateKey(c)] = true;
  }
  const rows = [];
  const added = [];
  const duplicates = [];
  const incomingList = Array.isArray(incoming) ? incoming : [];
  for (let i = 0; i < incomingList.length; i += 1) {
    const c = asCandidate(incomingList[i]);
    const key = candidateKey(c);
    if (seen[key]) {
      duplicates.push(c);
      continue;
    }
    seen[key] = true;
    added.push(c);
    rows.push(toRow(c));
  }
  return { rows: rows, added: added, duplicates: duplicates };
}

/**
 * 状態を変えた新しい候補を返す（元は書き換えない）。
 * @param {object} candidate
 * @param {string} status
 * @param {object} [extra] 予定ID・登録日時・備考など
 * @returns {object}
 */
export function setStatus(candidate, status, extra) {
  const next = {};
  const source = candidate || {};
  const names = Object.keys(source);
  for (let i = 0; i < names.length; i += 1) next[names[i]] = source[names[i]];
  next.status = status;
  const extraNames = Object.keys(extra || {});
  for (let i = 0; i < extraNames.length; i += 1) next[extraNames[i]] = extra[extraNames[i]];
  return next;
}

/**
 * 重複登録の判定に使う鍵（企業・種別・開始 or 締切）。FR-09
 * 企業名は**空白を除いて小文字にする**（`SAMPLE Inc.` と `Sample Inc.` を同じ会社と見る。軽微 1）。
 * 前株・後株（`株式会社サンプル商事` と `サンプル商事株式会社`）は同一視しない＝別法人になりうる名前で、
 * 同一視すると別会社の同時刻面接を重複と誤判定して登録できなくする（取りこぼし側の事故）。
 */
export function registrationKey(candidate) {
  const c = candidate || {};
  const company = String(c.company === null || c.company === undefined ? "" : c.company)
    .replace(/\s+/g, "")
    .toLowerCase();
  const at = c.start || c.deadline || "";
  return company + "|" + String(c.kind || "") + "|" + String(at);
}

/**
 * すでに「登録済み」の同じ予定を探す。
 * @param {Array<object|Array<*>>} existing
 * @param {object} candidate
 * @returns {object|null}
 */
export function findDuplicateRegistered(existing, candidate) {
  const key = registrationKey(candidate);
  const list = Array.isArray(existing) ? existing : [];
  for (let i = 0; i < list.length; i += 1) {
    const c = asCandidate(list[i]);
    if (!c || c.status !== "登録済み") continue;
    if (c.id && candidate && c.id === candidate.id) continue;
    if (registrationKey(c) === key) return c;
  }
  return null;
}
