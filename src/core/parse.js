/**
 * parse.js — 1 通のメール → 0〜n 件の候補（FR-06）
 *
 * 方針:
 * - 種別ごとに「何を候補にするか」を変える。説明会・面接・変更は**日時ごと**、
 *   ES／Web テストは**締切ごと**、日程調整は**候補日をまとめて 1 件**。合否・その他・ノイズは候補を作らない。
 * - 日時が 1 つも取れない説明会・面接・変更も、確度「低」の候補として残す。
 *   カレンダーに入らないのは困るが、それ以上に「メールが埋もれて気づかない」のが困るため。
 * - 締切語の行にある日時は予定候補にしない（申込締切を説明会の開催日時と取り違えないため）。
 * - 本文は候補に入れない（NFR-02）。持つのは件名・送信者・抽出結果だけ。
 */

import { KIND_KEYWORDS, classifyMail, detectStage, matchKeywords } from "./classify.js";
import { extractCompany } from "./company.js";
import {
  detectChoices,
  hasDeadlineKeyword,
  hasTimePart,
  isoFromJstEpoch,
  jstEpochFromIso,
  parseDateTimes,
  parseDeadlines,
  toDateOnly,
} from "./dates.js";
import { titleFor } from "./events.js";
import { normalizeText, splitLines, truncate } from "./text.js";

/** 候補の状態（台帳の B 列と同じ語） */
export const CANDIDATE_STATUS_NEW = "候補";
export const CANDIDATE_STATUS_REGISTERED = "登録済み";
export const CANDIDATE_STATUS_IGNORED = "無視";
export const CANDIDATE_STATUS_NOISE = "ノイズ";
export const CANDIDATE_STATUS_ERROR = "エラー";
export const CANDIDATE_STATUSES = [
  CANDIDATE_STATUS_NEW,
  CANDIDATE_STATUS_REGISTERED,
  CANDIDATE_STATUS_IGNORED,
  CANDIDATE_STATUS_NOISE,
  CANDIDATE_STATUS_ERROR,
];
/**
 * 本人が台帳の状態列に手で書く「登録して」の合図（FR-07・`registerMarked()` が拾う）。
 * **`CANDIDATE_STATUSES` には入れない**（取り込みが付ける状態ではないので、行の読み書きの
 * 語としては扱わない）が、`setup()` の入力規則には足す。足さないと Sheets が値を拒否して
 * 「Web アプリを配信しなくても運用できる」逃げ道が塞がる（レビュー r1 重要 2）。
 */
export const CANDIDATE_STATUS_MANUAL = "登録";

/** 確度の強さ（小さいほど弱い）。2 つの手がかりのうち弱いほうを候補の確度にする */
const CONFIDENCE_RANK = { low: 0, medium: 1, high: 2 };
const CONFIDENCE_NAMES = ["low", "medium", "high"];

/** 会議 URL とみなすホスト（媒体サイトは含めない＝K-1） */
export const MEETING_URL_REGEX = /https?:\/\/(?:[\w.-]*\.)?(?:zoom\.us|zoom\.com|teams\.microsoft\.com|teams\.live\.com|meet\.google\.com|whereby\.com|webex\.com)\/[^\s"'<>）)]*/i;
/** 場所が書かれている行の目印 */
const LOCATION_LABEL_REGEX = /^(?:場所|会場|開催場所|実施場所|面接会場|面接場所|開催地|集合場所)[ \t]*[::][ \t]*(.+)$/;
/** ES 提出の締切だと分かる語（説明会の申込締切と区別する） */
const ENTRY_DEADLINE_LINE_REGEX = /エントリーシート|ES|応募書類|提出書類|書類提出|履歴書|作文|課題提出/i;

/**
 * 締切の行の語 → その締切の種別（レビュー r1 重要 5）。
 * 1 通に「ES 提出締切」と「Web テスト受検期限」が並ぶと、メール単位の種別（優先順位で
 * `test_deadline`）が両方に付き、**ES 締切の予定が「Webテスト」の名前で入る**。
 * 日付は合っていてタイトルの事実だけが違うので気づきにくい。判定の順は「テスト → ES」。
 */
const DEADLINE_KIND_RULES = [
  { kind: "test_deadline", re: /テスト|適性検査|SPI|玉手箱|受検|tg-web/i },
  {
    kind: "es_deadline",
    re: /エントリーシート|(?:^|[^A-Za-z])ES(?![A-Za-z])|応募書類|提出書類|書類提出|履歴書|提出/i,
  },
];

/**
 * 予定の行の語 → その日時の種別（同上）。説明会と面接の日付が 1 通に並ぶ通知で、
 * **説明会の日に「【面接】」が入る**のを止める。中止・変更のメールは種別を変えない
 * （本文に「説明会」と書いてあっても【変更】のまま出す＝FR-06）。
 */
const EVENT_KIND_RULES = [
  { kind: "seminar", re: /説明会|セミナー|座談会|インターン|オープンカンパニー/ },
  { kind: "interview", re: /面接|面談/ },
];

/** 行の語で種別を決める。当たらなければメールの種別のまま */
function kindFromLine(lineText, rules, fallback) {
  const text = String(lineText === null || lineText === undefined ? "" : lineText);
  for (let i = 0; i < rules.length; i += 1) {
    if (rules[i].re.test(text)) return rules[i].kind;
  }
  return fallback;
}

/** 弱いほうの確度を採る */
function weakerConfidence(a, b) {
  const left = CONFIDENCE_RANK[a] === undefined ? 0 : CONFIDENCE_RANK[a];
  const right = CONFIDENCE_RANK[b] === undefined ? 0 : CONFIDENCE_RANK[b];
  return CONFIDENCE_NAMES[Math.min(left, right)];
}

/** ISO 文字列の日付の部分（YYYY-MM-DD）。終日は元から日付だけなのでそのまま返る */
function dayOfIso(iso) {
  return String(iso === null || iso === undefined ? "" : iso).slice(0, 10);
}

/** 受信日時を JST の ISO に揃える。読めなければ null */
export function normalizeReceivedAt(value) {
  const epoch = jstEpochFromIso(value);
  if (isFinite(epoch)) return isoFromJstEpoch(epoch, false);
  return null;
}

/**
 * 候補の id。`c_<messageId>_<n>`
 * @param {string} messageId
 * @param {number} n 1 から
 * @returns {string}
 */
export function newCandidateId(messageId, n) {
  const id = String(messageId === null || messageId === undefined ? "unknown" : messageId);
  return "c_" + id + "_" + String(n);
}

/**
 * 重複判定の鍵。企業・種別・開始・締切をつないだもの。
 * **開始も締切も空なら `messageId` を混ぜる**（重要 2）。日時が読めなかった候補は
 * 鍵が `会社名|seminar||` で揃ってしまい、別のメールから来た 2 通目が
 * `mergeCandidates` で消える＝「中止連絡を見落とさない」という狙いが打ち消されるため。
 * @param {object} candidate
 * @returns {string}
 */
export function candidateKey(candidate) {
  const c = candidate || {};
  // 企業名は空白を除いて小文字に（`SAMPLE Inc.` と `Sample Inc.` を同じ会社と見る。軽微 1）
  const company = String(c.company === null || c.company === undefined ? "" : c.company)
    .replace(/\s+/g, "")
    .toLowerCase();
  const kind = String(c.kind || "");
  const start = String(c.start === null || c.start === undefined ? "" : c.start);
  const deadline = String(c.deadline === null || c.deadline === undefined ? "" : c.deadline);
  const messageId = start === "" && deadline === "" ? String(c.messageId === null || c.messageId === undefined ? "" : c.messageId) : "";
  return company + "|" + kind + "|" + start + "|" + deadline + "|" + messageId;
}

/**
 * その候補の日付が受信日より前か（軽微 5・6）。画面の並べ替えと「過去日」チップに使う。
 * 台帳に列を増やさないので、行から読み直すときも同じ式で計算する。
 * @param {object} candidate
 * @returns {boolean}
 */
export function candidateIsPast(candidate) {
  const c = candidate || {};
  const at = c.start || c.deadline || null;
  const day = toDateOnly(at);
  const baseDay = toDateOnly(c.receivedAt);
  if (!day || !baseDay) return false;
  return day < baseDay;
}

/** 本文から場所を拾う */
function findLocation(lines) {
  for (let i = 0; i < lines.length; i += 1) {
    const m = LOCATION_LABEL_REGEX.exec(lines[i].trim());
    if (m) {
      const value = m[1].trim().replace(/[。、]$/, "");
      if (value !== "") return truncate(value, 120);
    }
  }
  return null;
}

/** 本文から会議 URL を拾う */
function findMeetingUrl(text) {
  const m = MEETING_URL_REGEX.exec(text);
  return m ? m[0].replace(/[.,。、]$/, "") : null;
}

/**
 * 1 通を解析して候補と付随情報を返す（取り込みの記録用）。
 * @param {{id?: string, threadId?: string, from?: string, subject?: string, date?: string, body?: string}} mail
 * @returns {{candidates: object[], isNoise: boolean, kind: string, stage: string|null, reasons: string[]}}
 */
export function parseMailWithMeta(mail) {
  const source = mail || {};
  const subjectRaw = String(source.subject === null || source.subject === undefined ? "" : source.subject);
  const subject = normalizeText(subjectRaw);
  const body = normalizeText(source.body);
  const from = String(source.from === null || source.from === undefined ? "" : source.from);
  const messageId = String(source.id === null || source.id === undefined ? "" : source.id);
  const threadId = String(source.threadId === null || source.threadId === undefined ? messageId : source.threadId);
  const receivedAt = normalizeReceivedAt(source.date);

  const classified = classifyMail({ subject: subject, body: body, from: from });
  const company = extractCompany({ from: from, subject: subject, body: body });
  const reasons = [];
  if (classified.matched.length > 0) reasons.push("種別: " + classified.matched.slice(0, 3).join("・"));
  if (company.name) reasons.push("企業: " + companySourceLabel(company.source));

  const meta = {
    candidates: [],
    isNoise: classified.isNoise,
    kind: classified.kind,
    stage: classified.stage,
    reasons: reasons,
  };
  if (classified.isNoise) return meta;
  if (classified.kind === "other") return meta;

  const lines = splitLines(body);
  const options = { base: receivedAt };
  const dateTimes = dedupeDateTimes(parseDateTimes(body, options));
  const deadlines = parseDeadlines(body, options);
  const location = findLocation(lines);
  const url = findMeetingUrl(body);

  const base = {
    messageId: messageId,
    threadId: threadId,
    receivedAt: receivedAt,
    company: company.name,
    media: company.media,
    kind: classified.kind,
    stage: classified.stage,
    location: location,
    url: url,
    subject: truncate(subject, 200),
    from: from,
    status: CANDIDATE_STATUS_NEW,
  };

  const candidates = [];
  if (classified.kind === "result") {
    // 合否の連絡が次回面接の案内を兼ねることは新卒選考では普通なので、
    // 本文に面接語と「受信日より後の日時」があれば interview を 1 件だけ立てる（重要 3・FR-02 の例外）
    const interviewWords = matchKeywords(body, KIND_KEYWORDS.interview);
    const future = firstFutureDateTime(dateTimes);
    if (interviewWords.length === 0 || !future) return meta;
    candidates.push(
      buildCandidate(base, {
        kind: "interview",
        stage: detectStage(body),
        start: future.start,
        end: future.end,
        allDay: future.allDay,
        deadline: null,
        choices: [],
        confidence: weakerConfidence(future.confidence, company.confidence),
        reasons: reasons.concat(["合否の連絡に次回の面接日時: 本文 " + future.line + " 行目"]),
        note: future.note || "",
      })
    );
  } else if (classified.kind === "es_deadline" || classified.kind === "test_deadline") {
    for (let i = 0; i < deadlines.length; i += 1) {
      const deadline = deadlines[i];
      candidates.push(
        buildCandidate(base, {
          // 締切ごとに、その行の語で種別を決める（重要 5）
          kind: kindFromLine(lines[deadline.line - 1], DEADLINE_KIND_RULES, classified.kind),
          stage: null,
          start: null,
          end: null,
          allDay: true,
          deadline: deadline.at,
          choices: [],
          confidence: weakerConfidence(deadline.confidence, company.confidence),
          reasons: reasons.concat(["締切: 本文 " + deadline.line + " 行目"]),
        })
      );
    }
    if (candidates.length === 0) {
      candidates.push(
        buildCandidate(base, {
          start: null,
          end: null,
          allDay: true,
          deadline: null,
          choices: [],
          confidence: "low",
          reasons: reasons.concat(["締切が読み取れませんでした"]),
        })
      );
    }
  } else if (classified.kind === "schedule_request" || choiceCandidateKind(classified.kind, body, options)) {
    // 件名が「面接のご案内」でも、本文が「下記のいずれかで」と候補日を並べているなら
    // 独立した予定を n 件立てず、日程調整の 1 候補に倒す（重要 5・FR-03）
    const choices = detectChoices(body, options);
    const replyBy = choices && choices.replyBy ? choices.replyBy : deadlines.length > 0 ? deadlines[0].at : null;
    const list = choices ? choices.choices : [];
    candidates.push(
      buildCandidate(base, {
        kind: "schedule_request",
        start: null,
        end: null,
        allDay: true,
        deadline: replyBy,
        choices: list,
        confidence: weakerConfidence(list.length >= 2 ? "medium" : "low", company.confidence),
        reasons: reasons.concat([list.length >= 2 ? "候補日 " + list.length + " 件" : "候補日は本文から読めず"]),
      })
    );
  } else {
    // seminar / interview / change
    const deadlineSet = {};
    for (let i = 0; i < deadlines.length; i += 1) deadlineSet[deadlines[i].at] = true;
    const eventTimes = [];
    for (let i = 0; i < dateTimes.length; i += 1) {
      if (!deadlineSet[dateTimes[i].start]) eventTimes.push(dateTimes[i]);
    }
    // 終日を落とすのは「同じ日付に時刻付きもある」ときだけ（レビュー r2 R2-1）。
    // 以前は行内に 1 つでも時刻付きがあれば終日を全部落としていたため、
    // 「3月5日（木）・3月6日（金）10:00〜12:00」の 3/5 が黙って消えていた。
    // いまは parseDateTimes が時刻を各日付へ配るので、ここで日付ごとに見れば足りる。
    const timedDays = {};
    for (let i = 0; i < eventTimes.length; i += 1) {
      if (!eventTimes[i].allDay) timedDays[dayOfIso(eventTimes[i].start)] = true;
    }
    const chosen = [];
    for (let i = 0; i < eventTimes.length; i += 1) {
      if (eventTimes[i].allDay && timedDays[dayOfIso(eventTimes[i].start)] === true) continue;
      chosen.push(eventTimes[i]);
    }
    const applyDeadline = firstApplicationDeadline(deadlines, lines);

    for (let i = 0; i < chosen.length; i += 1) {
      const dt = chosen[i];
      const dtLine = lines[dt.line - 1] || "";
      // 日時ごとに、その行の語で種別を決める（重要 5）。変更・中止のメールは変えない
      const dtKind =
        classified.kind === "change" ? "change" : kindFromLine(dtLine, EVENT_KIND_RULES, classified.kind);
      candidates.push(
        buildCandidate(base, {
          kind: dtKind,
          stage: dtKind === "interview" ? detectStage(dtLine) || classified.stage : classified.stage,
          start: dt.start,
          end: dt.end,
          allDay: dt.allDay,
          deadline: applyDeadline ? applyDeadline.at : null,
          choices: [],
          confidence: weakerConfidence(dt.confidence, company.confidence),
          reasons: reasons.concat(["日時: 本文 " + dt.line + " 行目"]),
          note: dt.note || "",
        })
      );
    }
    if (chosen.length === 0) {
      candidates.push(
        buildCandidate(base, {
          start: null,
          end: null,
          allDay: false,
          deadline: applyDeadline ? applyDeadline.at : null,
          choices: [],
          confidence: "low",
          reasons: reasons.concat(["日時が読み取れませんでした"]),
        })
      );
    }
    // 説明会・面接のメールに紛れた ES 締切は、別の候補として立てる（見落とすと落ちるため）
    for (let i = 0; i < deadlines.length; i += 1) {
      const deadline = deadlines[i];
      const lineText = lines[deadline.line - 1] || "";
      if (!ENTRY_DEADLINE_LINE_REGEX.test(lineText)) continue;
      candidates.push(
        buildCandidate(base, {
          kind: "es_deadline",
          stage: null,
          start: null,
          end: null,
          allDay: true,
          deadline: deadline.at,
          choices: [],
          confidence: weakerConfidence(deadline.confidence, company.confidence),
          reasons: reasons.concat(["締切: 本文 " + deadline.line + " 行目"]),
        })
      );
    }
  }

  for (let i = 0; i < candidates.length; i += 1) {
    candidates[i].id = newCandidateId(messageId, i + 1);
    candidates[i].title = titleFor(candidates[i]);
    candidates[i].isPast = candidateIsPast(candidates[i]);
  }
  meta.candidates = candidates;
  return meta;
}

/** 受信日より後（同日を含む）の最初の日時。時刻つきを優先する */
function firstFutureDateTime(entries) {
  const list = Array.isArray(entries) ? entries : [];
  let fallback = null;
  for (let i = 0; i < list.length; i += 1) {
    if (list[i].isPast) continue;
    if (!list[i].allDay) return list[i];
    if (fallback === null) fallback = list[i];
  }
  return fallback;
}

/** 面接・説明会の案内でも、候補日が 2 件以上並んでいれば日程調整として扱うか（重要 5） */
function choiceCandidateKind(kind, body, options) {
  if (kind !== "interview" && kind !== "seminar") return false;
  const choices = detectChoices(body, options);
  return choices !== null && choices.choices.length >= 2;
}

/**
 * 1 通 → 候補の配列。ノイズと合否は空配列。
 * @param {object} mail
 * @returns {object[]}
 */
export function parseMail(mail) {
  return parseMailWithMeta(mail).candidates;
}

/** 同じ開始・終了の日時が本文に何度も出てきたら 1 件にまとめる */
function dedupeDateTimes(entries) {
  const seen = {};
  const out = [];
  for (let i = 0; i < entries.length; i += 1) {
    const key = entries[i].start + "|" + String(entries[i].end);
    if (seen[key]) continue;
    seen[key] = true;
    out.push(entries[i]);
  }
  return out;
}

/** 説明会・面接に付ける申込締切（ES 締切は別候補にするので除く） */
function firstApplicationDeadline(deadlines, lines) {
  for (let i = 0; i < deadlines.length; i += 1) {
    const lineText = lines[deadlines[i].line - 1] || "";
    if (ENTRY_DEADLINE_LINE_REGEX.test(lineText)) continue;
    if (!hasDeadlineKeyword(lineText)) continue;
    return deadlines[i];
  }
  return null;
}

/** 企業名の出所を日本語にする */
function companySourceLabel(source) {
  if (source === "from") return "From 表示名";
  if (source === "subject") return "件名";
  if (source === "body") return "本文";
  if (source === "signature") return "署名";
  return "不明";
}

/** 候補 1 件を組み立てる（台帳の列と 1 対 1 で対応する形にする） */
function buildCandidate(base, extra) {
  const c = {
    id: "",
    messageId: base.messageId,
    threadId: base.threadId,
    receivedAt: base.receivedAt,
    company: base.company,
    media: base.media,
    kind: base.kind,
    stage: base.stage,
    title: "",
    start: null,
    end: null,
    allDay: false,
    deadline: null,
    choices: [],
    location: base.location,
    url: base.url,
    subject: base.subject,
    isPast: false,
    from: base.from,
    confidence: "low",
    reasons: [],
    status: base.status,
    eventId: null,
    registeredAt: null,
    note: "",
  };
  const names = Object.keys(extra || {});
  for (let i = 0; i < names.length; i += 1) c[names[i]] = extra[names[i]];
  if (c.kind !== "interview" && c.kind !== "change" && c.kind !== "schedule_request") c.stage = null;
  if (c.start && !hasTimePart(c.start)) c.allDay = true;
  if (c.start && c.allDay) c.end = null;
  if (!c.start && (c.kind === "es_deadline" || c.kind === "test_deadline" || c.kind === "schedule_request")) {
    c.allDay = true;
  }
  return c;
}

/** 台帳に載せる「受信日」（画面の並べ替え用） */
export function candidateSortKey(candidate) {
  const c = candidate || {};
  const at = c.start || c.deadline || c.receivedAt || "";
  return toDateOnly(at) || "";
}
