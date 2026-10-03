/**
 * dates.js — 日時と締切の解釈（JST 固定・ISO 8601 文字列）
 *
 * 設計の要点（K-8）:
 * - **ホストのタイムゾーンに依存しない。** `new Date(y, m, d)` のようなローカル時刻 API を使わず、
 *   `Date.UTC` で「JST の壁時計をそのまま UTC として置いた数値（= JST epoch）」を作って計算する。
 *   こうすると Node を `TZ=UTC` で走らせても `TZ=Asia/Tokyo` でも同じ結果になり、GAS でも同じ。
 * - 値は常に文字列で持つ。時刻付きは `2026-03-05T14:00:00+09:00`、終日は `2026-03-05`。
 * - 年が書かれていないメールが大半なので、受信日から「直近の未来」に倒す。曜日が書いてあれば
 *   それを手がかりに年を選び直し、どうしても合わなければ確度を下げて人に見せる（誤登録より取りこぼしを嫌う）。
 */

import { normalizeText, splitLines } from "./text.js";

/** JST の UTC からのずれ（分）。GAS 側のタイムゾーンも Asia/Tokyo に固定する */
export const JST_OFFSET_MINUTES = 540;
/** 1 日のミリ秒 */
export const DAY_IN_MS = 86400000;
/** 0=日 〜 6=土 */
export const WEEKDAY_LABELS = ["日", "月", "火", "水", "木", "金", "土"];
/** 「3月5日(木)」の (木) を読むための表 */
export const WEEKDAY_INDEX = { 日: 0, 月: 1, 火: 2, 水: 3, 木: 4, 金: 5, 土: 6 };

/**
 * 締切だと判断する語。この語がある行（と直後 2 行）の日時だけを締切として扱う。
 * **「まで」はここに入れない。** 「これまで」「あくまで」「今まで」のような常用表現まで
 * 締切語になり、本文に書いてある開催日時が締切に化けるため（致命 1）。「まで」は
 * `DEADLINE_MADE_REGEX` で「日時トークンの直後」に付くときだけ締切語として数える。
 */
export const DEADLINE_KEYWORDS = [
  "締切",
  "締め切り",
  "締切り",
  "〆切",
  "〆切り",
  "期限",
  "期日",
  "必着",
  "受付終了",
  "応募終了",
];

/**
 * 「まで」を締切語とみなす形。日時トークンの直後（間に空白・「（木）」・「頃」程度しか挟まない）
 * に付くときだけ当てる。「これまで」「あくまで」「今まで」「いままで」は当たらない。
 */
const DEADLINE_MADE_REGEX =
  /(?:\d[ \t]*(?:日|時|分)|\d[ \t]*:[ \t]*\d{2}|\d[ \t]*\/[ \t]*\d|正午|終日)[ \t]*(?:\([ \t]*[日月火水木金土](?:曜日?)?[ \t]*\))?[ \t]*(?:頃|ごろ|位|くらい)?[ \t]*(まで|迄)/g;

/**
 * 受信日を基準に日付が決まる相対表現（軽微 7）。締切語の有無に関わらずこれ自体が締切になる。
 * 時刻は 23:59 とみなす（FR-04 の「時刻が無ければ 23:59」と同じ扱い）。
 */
const RELATIVE_DEADLINE_RULES = [
  { re: /明後日(?:[ \t]*(?:中|まで|迄))?/, days: 2 },
  { re: /明日[ \t]*(?:中|まで|迄)/, days: 1 },
  { re: /(?:本日|今日)[ \t]*(?:中|まで|迄)/, days: 0 },
];

/**
 * 予定（面接・説明会）の日時であることを示す語。この語に係る日時は締切にしない（致命 2）。
 */
export const EVENT_LINE_KEYWORDS = ["面接", "面談", "説明会", "開催", "日時", "会場", "集合"];
const EVENT_LINE_REGEX = /面接|面談|説明会|開催|日時|会場|集合/;
/** 1 行の中の「句」の切れ目。予定の語がどの日時に係るかを句の中だけで見る */
const CLAUSE_BREAK_REGEX = /[、。，；;]/;

/** 「候補日の並び」を見分ける文脈語（これ 1 つで候補日の文脈と決めてよい語） */
export const CHOICE_CONTEXT_KEYWORDS = [
  "第1希望",
  "第2希望",
  "第3希望",
  "候補日",
  "いずれか",
  "ご都合",
  "ご希望の日程",
  "下記日程",
  "下記の日程",
  "以下日程",
  "以下の日程",
  "からお選び",
  "からお選びください",
];

/**
 * **単独では候補日の文脈と決めない語**（レビュー r1 重要 4）。
 * 日本語の「または」は選択の依頼だけでなく、単なる 2 日開催の告知にも使う
 * （「3月5日または3月6日 10:00〜12:00 に開催します」）。無条件に候補日文脈にすると、
 * 本文に書いてある開催日時が予定にならず【要返信】の終日予定に化ける。
 */
export const CHOICE_WEAK_KEYWORDS = ["もしくは", "または", "どちらか", " or "];

/**
 * 返信を求める語。上の弱い語は、この語が**同じ行か前後 1 行**にあるときだけ候補日文脈にする。
 * 「ご調整」「いかがでしょうか」は FIX r0 で固定した入力（`または`／`もしくは` の 2 件）を
 * 通すために入れてある。
 */
const CHOICE_REPLY_REGEX =
  /ご都合|ご希望|お知らせください|お選び|お願いします|第\d希望|候補日|いずれか|ご調整|ご返信|お返事|いかがでしょうか/;

const CHOICE_LINE_REGEX = new RegExp(CHOICE_CONTEXT_KEYWORDS.join("|"));
const CHOICE_WEAK_REGEX = new RegExp(CHOICE_WEAK_KEYWORDS.join("|"));

/**
 * その行が候補日の文脈か。強い語は単独で、弱い語は返信を求める語が前後 1 行にあるときだけ。
 * @param {string[]} lines
 * @param {number} index 0 起点
 * @returns {boolean}
 */
function isChoiceContextLine(lines, index) {
  const line = lines[index] || "";
  if (CHOICE_LINE_REGEX.test(line)) return true;
  if (!CHOICE_WEAK_REGEX.test(line)) return false;
  for (let i = index - 1; i <= index + 1; i += 1) {
    if (i < 0 || i >= lines.length) continue;
    if (CHOICE_REPLY_REGEX.test(lines[i])) return true;
  }
  return false;
}

/** 範囲の区切り（〜 ～ - − ― ‐ から より）。NFKC 後は ～ が ~ になる点に注意 */
const RANGE_SEPARATOR_REGEX = /^[ \t]*(?:〜|～|~|-|−|―|‐|–|—|ー|から|より|to)[ \t]*/;
/** 日付と日付の間が区切りだけ＝日付の範囲（「3月5日（木）〜3月7日（土）」） */
const DATE_RANGE_ONLY_REGEX = /^[ \t]*(?:〜|～|~|-|−|―|‐|–|—|から|より|to)[ \t]*$/;
/**
 * 日付と日付の間が「並び」の語だけ＝同じ句に日付が並んでいる（「3月5日（木）・3月6日（金）」）。
 * 時刻が 1 組しか書かれていないとき、この繋がりの中でだけ時刻を配る（レビュー r2 R2-1）。
 */
const LIST_JOINER_ONLY_REGEX = /^[ \t]*(?:・|、|と|または|もしくは)[ \t]*$/;
/** 日付の直後に付く曜日。NFKC 後なので括弧は半角 */
const WEEKDAY_SUFFIX_REGEX = /^[ \t]*(?:\([ \t]*([日月火水木金土])(?:曜日?)?[ \t]*\)|([日月火水木金土])曜日?)/;
/** 午前・午後の言い換え。前に置いても後ろに置いても読む（重要 1） */
const MERIDIEM_SOURCE = "午前|午後|AM|PM|am|pm|a\\.m\\.|p\\.m\\.|A\\.M\\.|P\\.M\\.";
/** 時刻。正午 → 12:00、hh:mm、hh時(半|mm分) の 3 通り。AM／PM は前置・後置の両方 */
const TIME_TOKEN_SOURCE =
  "(正午)|(?:(" +
  MERIDIEM_SOURCE +
  ")[ \\t]*)?(\\d{1,2})[ \\t]*:[ \\t]*(\\d{2})(?:[ \\t]*(" +
  MERIDIEM_SOURCE +
  "))?|(?:(" +
  MERIDIEM_SOURCE +
  ")[ \\t]*)?(\\d{1,2})[ \\t]*時(?:[ \\t]*(半)|[ \\t]*(\\d{1,2})[ \\t]*分)?(?:[ \\t]*(" +
  MERIDIEM_SOURCE +
  "))?";
const TIME_ANYWHERE_REGEX = new RegExp(TIME_TOKEN_SOURCE);
const TIME_AT_START_REGEX = new RegExp("^(?:" + TIME_TOKEN_SOURCE + ")");
/** 「終日」「全日」 */
const ALL_DAY_REGEX = /^[ \t]*(?:は|に|:)?[ \t]*(終日|全日)/;
/** 開始時刻ではない時刻の目印（受付・開場は本番の時刻ではない） */
const NOT_START_TIME_REGEX = /(受付|開場|集合)[ \t]*[::]?[ \t]*$/;

/** 2 桁ゼロ埋め */
export function pad2(value) {
  const n = Number(value);
  return (n < 10 ? "0" : "") + String(n);
}

/**
 * ISO 文字列 → 「JST の壁時計を UTC として置いた epoch」。
 * オフセットが書いてあれば UTC に直してから +9h、無ければ JST の壁時計とみなす。
 * @param {string} iso
 * @returns {number} NaN なら解釈できない
 */
export function jstEpochFromIso(iso) {
  if (iso === null || iso === undefined) return NaN;
  const text = String(iso).trim();
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?[ ]?(Z|[+-]\d{2}:?\d{2})?)?$/.exec(
    text
  );
  if (!m) return NaN;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = m[4] === undefined ? 0 : Number(m[4]);
  const minute = m[5] === undefined ? 0 : Number(m[5]);
  const second = m[6] === undefined ? 0 : Number(m[6]);
  const base = Date.UTC(year, month - 1, day, hour, minute, second);
  const zone = m[7];
  if (!zone) return base;
  let offsetMinutes = 0;
  if (zone !== "Z") {
    const sign = zone.charAt(0) === "-" ? -1 : 1;
    const digits = zone.slice(1).replace(":", "");
    offsetMinutes = sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4)));
  }
  return base - offsetMinutes * 60000 + JST_OFFSET_MINUTES * 60000;
}

/**
 * 「JST epoch」→ ISO 文字列。
 * @param {number} epoch
 * @param {boolean} [allDay]
 * @returns {string}
 */
export function isoFromJstEpoch(epoch, allDay) {
  const d = new Date(epoch);
  const ymd = d.getUTCFullYear() + "-" + pad2(d.getUTCMonth() + 1) + "-" + pad2(d.getUTCDate());
  if (allDay) return ymd;
  return ymd + "T" + pad2(d.getUTCHours()) + ":" + pad2(d.getUTCMinutes()) + ":00+09:00";
}

/**
 * 年月日（＋時分）から ISO 文字列を作る。時が null／undefined なら終日（日付だけ）。
 * @param {number} y
 * @param {number} m
 * @param {number} d
 * @param {number} [hh]
 * @param {number} [mm]
 * @returns {string}
 */
export function toIso(y, m, d, hh, mm) {
  const ymd = String(y) + "-" + pad2(m) + "-" + pad2(d);
  if (hh === null || hh === undefined) return ymd;
  return ymd + "T" + pad2(hh) + ":" + pad2(mm === null || mm === undefined ? 0 : mm) + ":00+09:00";
}

/** 日付部分（YYYY-MM-DD）だけ取り出す */
export function toDateOnly(iso) {
  if (iso === null || iso === undefined) return null;
  const text = String(iso);
  return text.length >= 10 ? text.slice(0, 10) : null;
}

/** その ISO が時刻を持つか */
export function hasTimePart(iso) {
  return typeof iso === "string" && iso.length > 10 && iso.indexOf("T") === 10;
}

/**
 * 分を足す（引く）。日付だけの文字列に 1440 の倍数を足したときは日付だけで返す。
 * @param {string} iso
 * @param {number} n
 * @returns {string}
 */
export function addMinutes(iso, n) {
  const epoch = jstEpochFromIso(iso);
  if (!isFinite(epoch)) return String(iso);
  const minutes = Number(n) || 0;
  const next = epoch + minutes * 60000;
  const keepDateOnly = !hasTimePart(iso) && minutes % 1440 === 0;
  return isoFromJstEpoch(next, keepDateOnly);
}

/** 日を足す（終日の締切に対して使う） */
export function addDays(iso, n) {
  const epoch = jstEpochFromIso(iso);
  if (!isFinite(epoch)) return String(iso);
  const next = epoch + (Number(n) || 0) * DAY_IN_MS;
  return isoFromJstEpoch(next, !hasTimePart(iso));
}

/**
 * 曜日（0=日）。JST の壁時計で判定する。
 * @param {string} iso
 * @returns {number} 解釈できなければ -1
 */
export function weekdayOf(iso) {
  const epoch = jstEpochFromIso(iso);
  if (!isFinite(epoch)) return -1;
  return new Date(epoch).getUTCDay();
}

/** その年月日が実在するか（2 月 30 日を弾く） */
export function isValidYmd(y, m, d) {
  if (!isFinite(y) || !isFinite(m) || !isFinite(d)) return false;
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const epoch = Date.UTC(y, m - 1, d);
  const check = new Date(epoch);
  return check.getUTCFullYear() === y && check.getUTCMonth() === m - 1 && check.getUTCDate() === d;
}

/** 「3/5（木）14:00」のような人が読む形（画面とタイトル用） */
export function formatJa(iso) {
  const epoch = jstEpochFromIso(iso);
  if (!isFinite(epoch)) return "";
  const d = new Date(epoch);
  const head = d.getUTCMonth() + 1 + "/" + d.getUTCDate() + "（" + WEEKDAY_LABELS[d.getUTCDay()] + "）";
  if (!hasTimePart(iso)) return head;
  return head + pad2(d.getUTCHours()) + ":" + pad2(d.getUTCMinutes());
}

/** 「3/5」だけ（候補日を並べるとき用） */
export function formatMd(iso) {
  const epoch = jstEpochFromIso(iso);
  if (!isFinite(epoch)) return "";
  const d = new Date(epoch);
  return d.getUTCMonth() + 1 + "/" + d.getUTCDate();
}

/** 「14:00」だけ（締切のタイトルに使う） */
export function formatTimeJa(iso) {
  const epoch = jstEpochFromIso(iso);
  if (!isFinite(epoch) || !hasTimePart(iso)) return "";
  const d = new Date(epoch);
  return pad2(d.getUTCHours()) + ":" + pad2(d.getUTCMinutes());
}

/**
 * 年が書かれていない日付の年を推定する。
 * 既定は受信日から見て直近の未来（受信日と同日は未来に含む）。
 * 曜日が書いてあってそれと合わない場合は、受信日から前後 12 か月以内で曜日の合う年を採る。
 * それも無ければ直近の未来のまま返す（呼び出し側が確度を下げる）。
 * @param {number} month
 * @param {number} day
 * @param {string} baseIso 受信日時
 * @param {number|null} weekday 0=日。無ければ null
 * @returns {number}
 */
export function inferYear(month, day, baseIso, weekday) {
  const baseEpoch = jstEpochFromIso(baseIso);
  // base が無いときは「いま」を基準にする（軽微 6）。以前は 2026-01-01 固定で、
  // 2027 年以降に base を渡し忘れると黙って 2026 起点の年になっていた。
  // Date.now() は TZ に依存しないので K-8 に触れない（+9h で JST の壁時計へ寄せる）
  const baseDate = isFinite(baseEpoch)
    ? new Date(baseEpoch)
    : new Date(Date.now() + JST_OFFSET_MINUTES * 60000);
  const baseYear = baseDate.getUTCFullYear();
  const baseDayEpoch = Date.UTC(baseYear, baseDate.getUTCMonth(), baseDate.getUTCDate());

  let nearest = baseYear;
  for (let i = 0; i < 4; i += 1) {
    const y = baseYear + i;
    if (!isValidYmd(y, month, day)) continue;
    if (Date.UTC(y, month - 1, day) >= baseDayEpoch) {
      nearest = y;
      break;
    }
  }
  if (weekday === null || weekday === undefined || weekday < 0) return nearest;
  if (isValidYmd(nearest, month, day) && new Date(Date.UTC(nearest, month - 1, day)).getUTCDay() === weekday) {
    return nearest;
  }
  // 前後 12 か月（366 日）以内で曜日が合う年を探す。差が小さい順・未来を優先
  const candidates = [];
  for (let y = baseYear - 1; y <= baseYear + 1; y += 1) {
    if (!isValidYmd(y, month, day)) continue;
    const diff = Date.UTC(y, month - 1, day) - baseDayEpoch;
    if (Math.abs(diff) > 366 * DAY_IN_MS) continue;
    candidates.push({ year: y, diff });
  }
  candidates.sort(function (a, b) {
    const aAbs = Math.abs(a.diff);
    const bAbs = Math.abs(b.diff);
    if (aAbs !== bAbs) return aAbs - bAbs;
    return b.diff - a.diff;
  });
  for (let i = 0; i < candidates.length; i += 1) {
    const y = candidates[i].year;
    if (new Date(Date.UTC(y, month - 1, day)).getUTCDay() === weekday) return y;
  }
  return nearest;
}

/** 午後か（AM/PM・a.m./p.m. も読む） */
function isAfternoonWord(word) {
  const lower = String(word).toLowerCase().split(".").join("");
  return lower === "午後" || lower === "pm";
}

/** 時刻トークンの正規表現マッチ → {hh, mm, nextDay}。時刻として無理があれば null */
function timeFromTokenMatch(m) {
  if (!m) return null;
  if (m[1]) return { hh: 12, mm: 0, nextDay: false };
  let hh;
  let mm;
  let meridiem;
  if (m[3] !== undefined) {
    hh = Number(m[3]);
    mm = Number(m[4]);
    meridiem = m[2] || m[5];
  } else if (m[7] !== undefined) {
    hh = Number(m[7]);
    mm = m[8] ? 30 : m[9] !== undefined ? Number(m[9]) : 0;
    meridiem = m[6] || m[10];
  } else {
    return null;
  }
  if (meridiem) {
    if (isAfternoonWord(meridiem)) {
      if (hh < 12) hh += 12;
    } else if (hh === 12) {
      hh = 0;
    }
  }
  if (!isFinite(hh) || !isFinite(mm) || mm > 59) return null;
  // 「25時」〜「29時」は翌日の 1〜5 時（軽微 1）。呼び出し側が確度を medium まで下げる
  let nextDay = false;
  if (hh >= 24 && hh <= 29) {
    hh -= 24;
    nextDay = true;
  }
  if (hh > 23) return null;
  return { hh: hh, mm: mm, nextDay: nextDay };
}

/** text の中で最初に現れる時刻を返す */
function findTimeIn(text) {
  const m = TIME_ANYWHERE_REGEX.exec(text);
  if (!m) return null;
  const time = timeFromTokenMatch(m);
  if (!time) return null;
  return {
    hh: time.hh,
    mm: time.mm,
    nextDay: time.nextDay,
    index: m.index,
    endIndex: m.index + m[0].length,
    raw: m[0],
  };
}

/**
 * 「時刻に見えるのに時刻として読めないもの」が含まれるか（軽微 8）。
 * `99:99`・`30時` は日付だけを活かして終日にするが、そのまま確度「高」で並ぶと
 * 確度が高い候補だけを対象にする「まとめて登録」に入ってしまう。
 * @param {string} text
 * @returns {boolean}
 */
function hasUnreadableTime(text) {
  let rest = String(text === null || text === undefined ? "" : text);
  for (let guard = 0; guard < 5; guard += 1) {
    const m = TIME_ANYWHERE_REGEX.exec(rest);
    if (!m) return false;
    if (!timeFromTokenMatch(m)) return true;
    const step = m.index + (m[0].length > 0 ? m[0].length : 1);
    rest = rest.slice(step);
  }
  return false;
}

/** text の先頭にある時刻だけを返す（範囲の終わりを読むとき用） */
function findTimeAtStart(text) {
  const m = TIME_AT_START_REGEX.exec(text);
  if (!m) return null;
  const time = timeFromTokenMatch(m);
  if (!time) return null;
  return { hh: time.hh, mm: time.mm, nextDay: time.nextDay, index: 0, endIndex: m[0].length, raw: m[0] };
}

/**
 * 1 つの日付に紐づく時間帯を、先頭から順に拾う。
 * 2 枠目以降は「10時〜12時、13時〜15時」のように**範囲になっているもの**だけを採る
 * （「14:00 受付開始 13:30」の 13:30 を 2 枠目にしないため。軽微 8）。
 * @param {string} region 日付（と曜日）より後ろの文字列
 * @returns {Array<{start: object, end: object|null, beginIndex: number, endIndex: number}>}
 */
function scanTimeSlots(region) {
  const slots = [];
  let offset = 0;
  while (slots.length < 3) {
    const rest = region.slice(offset);
    let found = findTimeIn(rest);
    if (!found) break;
    // 「（受付9:45）」のように受付時刻が先に来るときは開始時刻として採らない
    if (NOT_START_TIME_REGEX.test(rest.slice(0, found.index))) {
      const next = findTimeIn(rest.slice(found.endIndex));
      if (!next) break;
      found = {
        hh: next.hh,
        mm: next.mm,
        nextDay: next.nextDay,
        index: found.endIndex + next.index,
        endIndex: found.endIndex + next.endIndex,
        raw: next.raw,
      };
    }
    let end = null;
    let endIndex = found.endIndex;
    const sep = RANGE_SEPARATOR_REGEX.exec(rest.slice(found.endIndex));
    if (sep) {
      const second = findTimeAtStart(rest.slice(found.endIndex + sep[0].length));
      if (second) {
        end = second;
        endIndex = found.endIndex + sep[0].length + second.endIndex;
      }
    }
    if (slots.length > 0 && (end === null || slots[slots.length - 1].end === null)) break;
    slots.push({ start: found, end: end, beginIndex: offset + found.index, endIndex: offset + endIndex });
    offset = offset + endIndex;
  }
  return slots;
}

/** 年月日に日数を足した年月日 */
function shiftedYmd(year, month, day, days) {
  const moved = new Date(Date.UTC(year, month - 1, day) + days * DAY_IN_MS);
  return { year: moved.getUTCFullYear(), month: moved.getUTCMonth() + 1, day: moved.getUTCDate() };
}

/** 確度の弱いほうを採る */
function weakerOf(a, b) {
  const rank = { low: 0, medium: 1, high: 2 };
  const names = ["low", "medium", "high"];
  const left = rank[a] === undefined ? 0 : rank[a];
  const right = rank[b] === undefined ? 0 : rank[b];
  return names[Math.min(left, right)];
}

/** 受信日（base）より前の日付か */
function isPastOf(iso, baseIso) {
  const day = toDateOnly(iso);
  const baseDay = toDateOnly(baseIso);
  if (!day || !baseDay) return false;
  return day < baseDay;
}

/**
 * 1 行の中の日付表記をすべて拾う。
 * 「2026年3月5日」「令和8年3月5日」「2026/3/5」「3月5日」「3/5」に対応し、
 * 先に当たったものの範囲は伏せ字にして後のパターンが二重に拾わないようにする。
 */
function scanDateTokensInLine(line) {
  const masked = line.split("");
  const found = [];
  const patterns = [
    {
      re: /(?:(令和|平成|R|H)[ \t]*(\d{1,2})|(\d{4}))[ \t]*年[ \t]*(\d{1,2})[ \t]*月[ \t]*(\d{1,2})[ \t]*日/g,
      read: function (m) {
        let year;
        if (m[3] !== undefined) {
          year = Number(m[3]);
        } else if (m[1] === "令和" || m[1] === "R") {
          year = 2018 + Number(m[2]);
        } else {
          year = 1988 + Number(m[2]);
        }
        return { year: year, month: Number(m[4]), day: Number(m[5]), hasYear: true };
      },
    },
    {
      re: /(\d{4})[ \t]*[/-][ \t]*(\d{1,2})[ \t]*[/-][ \t]*(\d{1,2})/g,
      read: function (m) {
        return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]), hasYear: true };
      },
    },
    {
      // 「2026.3.5」「2026.03.05」（軽微 2）。年が 4 桁のときだけ拾う＝小数と紛れない
      re: /(\d{4})[ \t]*\.[ \t]*(\d{1,2})[ \t]*\.[ \t]*(\d{1,2})(?=$|[^0-9.])/g,
      read: function (m) {
        return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]), hasYear: true };
      },
    },
    {
      re: /(\d{1,2})[ \t]*月[ \t]*(\d{1,2})[ \t]*日/g,
      read: function (m) {
        return { year: null, month: Number(m[1]), day: Number(m[2]), hasYear: false };
      },
    },
    {
      re: /(^|[^0-9/\-])(\d{1,2})\/(\d{1,2})(?=$|[^0-9/])/g,
      read: function (m) {
        return { year: null, month: Number(m[2]), day: Number(m[3]), hasYear: false, lead: m[1].length };
      },
    },
  ];

  for (let p = 0; p < patterns.length; p += 1) {
    const pattern = patterns[p];
    const target = masked.join("");
    pattern.re.lastIndex = 0;
    let m = pattern.re.exec(target);
    while (m) {
      const parsed = pattern.read(m);
      const lead = parsed.lead || 0;
      const start = m.index + lead;
      const end = m.index + m[0].length;
      if (parsed.month >= 1 && parsed.month <= 12 && parsed.day >= 1 && parsed.day <= 31) {
        found.push({
          index: start,
          endIndex: end,
          raw: line.slice(start, end),
          year: parsed.year,
          month: parsed.month,
          day: parsed.day,
          hasYear: parsed.hasYear,
        });
        for (let i = start; i < end; i += 1) masked[i] = "\u0000";
      }
      m = pattern.re.exec(target);
    }
  }
  found.sort(function (a, b) {
    return a.index - b.index;
  });
  return found;
}

/**
 * 日付（ymd）と時刻の枠（slot）から start・end の ISO を作る。
 * 深夜表記（25時）は翌日へ送り、終了が開始以下なら日跨ぎとして終了だけ翌日にする。
 * @param {{year: number, month: number, day: number}} ymd
 * @param {object|null} slot null なら終日（日付だけ）
 * @returns {{start: string, end: string|null}}
 */
function isoRangeOf(ymd, slot) {
  if (!slot) return { start: toIso(ymd.year, ymd.month, ymd.day), end: null };
  let startYmd = ymd;
  if (slot.start.nextDay) startYmd = shiftedYmd(ymd.year, ymd.month, ymd.day, 1);
  const start = toIso(startYmd.year, startYmd.month, startYmd.day, slot.start.hh, slot.start.mm);
  let end = null;
  if (slot.end) {
    let endYmd = startYmd;
    if (slot.end.hh * 60 + slot.end.mm <= slot.start.hh * 60 + slot.start.mm) {
      // 22:00〜01:00 のような日跨ぎ
      endYmd = shiftedYmd(startYmd.year, startYmd.month, startYmd.day, 1);
    }
    end = toIso(endYmd.year, endYmd.month, endYmd.day, slot.end.hh, slot.end.mm);
  }
  return { start: start, end: end };
}

/**
 * `pending` の i 番目と k 番目の日付が、「・」「と」「または」「、」だけで繋がっているか。
 * 途中に別の語（「までに」など）が挟まっていれば「同じ句の並び」とは見ない。
 */
function joinedInList(line, tokens, pending, i, k) {
  const from = i < k ? i : k;
  const to = i < k ? k : i;
  for (let n = from; n < to; n += 1) {
    const gap = line.slice(pending[n].gapStart, tokens[pending[n + 1].tokenIndex].index);
    if (!LIST_JOINER_ONLY_REGEX.test(gap)) return false;
  }
  return true;
}

/**
 * 同じ行に**日付が複数・時刻が 1 組**あるときは、その時刻を並んでいる各日付へ配る（レビュー r2 R2-1）。
 *
 * 「3月5日（木）・3月6日（金）10:00〜12:00」は、時刻が後ろの日付にしか付いていないため
 * 3/5 が終日・3/6 が時刻付きになり、`parseMail` 側の「時刻付き優先」で 3/5 が黙って消えていた。
 * 書いた人の意図は「両日とも 10:00〜12:00」なので、ここで両方を時刻付きにしてから返す。
 *
 * 配らないもの: 時刻が 2 組以上ある行（それぞれの日付に付いている）／「終日」と書いてある日付／
 * 「3/5〜3/7 の 3 日間」のような期間（初日だけの終日のまま）／並びの語で繋がっていない日付。
 */
function spreadSingleTimeSlot(line, tokens, pending, base) {
  let timed = null;
  let timedIndex = -1;
  let timedCount = 0;
  for (let i = 0; i < pending.length; i += 1) {
    if (!pending[i].slot) continue;
    timedCount += 1;
    timed = pending[i];
    timedIndex = i;
  }
  if (timedCount !== 1) return;

  for (let i = 0; i < pending.length; i += 1) {
    const item = pending[i];
    if (i === timedIndex || item.slot) continue;
    if (item.explicitAllDay || item.entry.note) continue;
    if (!joinedInList(line, tokens, pending, i, timedIndex)) continue;
    const range = isoRangeOf(item.ymd, timed.slot);
    item.entry.start = range.start;
    item.entry.end = range.end;
    item.entry.allDay = false;
    item.entry.isPast = isPastOf(range.start, base);
    // 深夜表記（25時）の解釈は割れるので、配った先も確度を下げる（軽微 1 と同じ扱い）
    if (timed.slot.start.nextDay) item.entry.confidence = weakerOf(item.entry.confidence, "medium");
  }
}

/**
 * 本文から日時を拾う。
 * @param {string} text
 * @param {{base?: string}} [options] base = 受信日時の ISO（年の推定に使う）
 * @returns {Array<{start: string, end: string|null, allDay: boolean, raw: string, line: number, col: number, confidence: string, isPast: boolean, note: string}>}
 */
export function parseDateTimes(text, options) {
  const base = options && options.base ? options.base : null;
  const lines = splitLines(normalizeText(text));
  const results = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const tokens = scanDateTokensInLine(line);
    if (tokens.length === 0) continue;
    // その行ぶんの結果。行を読み終えてから「時刻を配る」判断をするので一旦ここに置く
    const pending = [];

    let skipToken = -1; // 日付の範囲（3/5〜3/7）の終わり側は候補にしない（軽微 3 の軽い版）
    for (let t = 0; t < tokens.length; t += 1) {
      if (t <= skipToken) continue;
      const token = tokens[t];
      const afterDate = line.slice(token.endIndex);
      const weekdayMatch = WEEKDAY_SUFFIX_REGEX.exec(afterDate);
      const weekdayChar = weekdayMatch ? weekdayMatch[1] || weekdayMatch[2] : null;
      const weekday = weekdayChar === null ? null : WEEKDAY_INDEX[weekdayChar];
      const afterWeekday = token.endIndex + (weekdayMatch ? weekdayMatch[0].length : 0);

      const year = token.hasYear ? token.year : inferYear(token.month, token.day, base, weekday);
      if (!isValidYmd(year, token.month, token.day)) continue;

      // 「3月5日（木）〜3月7日（土）」は初日だけを候補にし、期間を note に残す
      let regionStart = afterWeekday;
      let regionEnd = t + 1 < tokens.length ? tokens[t + 1].index : line.length;
      let note = "";
      if (t + 1 < tokens.length && DATE_RANGE_ONLY_REGEX.test(line.slice(afterWeekday, tokens[t + 1].index))) {
        const endToken = tokens[t + 1];
        const endWeekday = WEEKDAY_SUFFIX_REGEX.exec(line.slice(endToken.endIndex));
        const endYear = endToken.hasYear
          ? endToken.year
          : inferYear(endToken.month, endToken.day, base, endWeekday ? WEEKDAY_INDEX[endWeekday[1] || endWeekday[2]] : null);
        if (isValidYmd(endYear, endToken.month, endToken.day)) {
          const days =
            Math.round(
              (Date.UTC(endYear, endToken.month - 1, endToken.day) - Date.UTC(year, token.month - 1, token.day)) /
                DAY_IN_MS
            ) + 1;
          if (days >= 2 && days <= 60) {
            note =
              "期間: " +
              token.month +
              "/" +
              token.day +
              "〜" +
              endToken.month +
              "/" +
              endToken.day +
              "（" +
              days +
              "日間）";
            skipToken = t + 1;
            regionStart = endToken.endIndex + (endWeekday ? endWeekday[0].length : 0);
            regionEnd = t + 2 < tokens.length ? tokens[t + 2].index : line.length;
          }
        }
      }
      const region = line.slice(regionStart, Math.max(regionStart, regionEnd));

      const weekdayMatched =
        weekday === null || new Date(Date.UTC(year, token.month - 1, token.day)).getUTCDay() === weekday;

      let confidence;
      if (token.hasYear) confidence = "high";
      else if (weekday === null) confidence = "medium";
      else if (weekdayMatched) confidence = "high";
      else confidence = "low";

      /**
       * 1 件ぶんを pending に積む。
       * @param {object|null} slot 時刻の枠（null なら終日）
       * @param {number} rawFrom 根拠として残す文字列の開始位置
       * @param {number} rawTo 同・終了位置
       * @param {boolean} [explicitAllDay] 「終日」と書いてあって終日にしたか（時刻を配らない目印）
       */
      const push = function (slot, rawFrom, rawTo, explicitAllDay) {
        const ymd = { year: year, month: token.month, day: token.day };
        const allDay = slot === null;
        const range = isoRangeOf(ymd, slot);
        const start = range.start;
        const end = range.end;
        let level = confidence;
        // 深夜表記（25時）は解釈が割れるので確度を下げる（軽微 1）
        if (slot && slot.start.nextDay) level = weakerOf(level, "medium");
        // 時刻として無理な値（30時・99:99）で終日に倒したときも確度を下げる（軽微 8）
        if (slot === null && hasUnreadableTime(region)) level = weakerOf(level, "medium");
        const past = isPastOf(start, base);
        // 曜日が合う年を選んだ結果が過去になるときは、確度を下げて人に見せる（軽微 5）
        if (past && !token.hasYear && weekday !== null) level = weakerOf(level, "medium");
        pending.push({
          entry: {
            start: start,
            end: end,
            allDay: allDay,
            raw: line.slice(rawFrom, Math.max(rawTo, rawFrom)).replace(/\s+$/, ""),
            line: i + 1,
            col: token.index,
            confidence: level,
            isPast: past,
            note: note,
          },
          tokenIndex: t,
          ymd: ymd,
          slot: slot || null,
          explicitAllDay: explicitAllDay === true,
          // 次の日付までの「間の文字列」を取り出す起点。時刻を読んだぶんは飛ばす
          // （「3月5日（木）10:00〜12:00・3月6日（金）」の間を「・」だけと見るため）
          gapStart: slot ? regionStart + slot.endIndex : regionStart,
        });
      };

      if (ALL_DAY_REGEX.test(region)) {
        push(null, token.index, regionStart + ALL_DAY_REGEX.exec(region)[0].length, true);
        continue;
      }

      const slots = scanTimeSlots(region);
      if (slots.length === 0 && t + 1 === tokens.length && region.replace(/[ \t::、。]/g, "").length <= 6) {
        // 「日時：3月5日（木）」の次の行に時刻だけがあるパターン
        const nextLine = i + 1 < lines.length ? lines[i + 1] : "";
        if (nextLine && scanDateTokensInLine(nextLine).length === 0) {
          const head = scanTimeSlots(nextLine);
          if (head.length > 0 && head[0].beginIndex <= 8) {
            push(head[0], token.index, regionStart);
            continue;
          }
        }
      }
      if (slots.length === 0) {
        push(null, token.index, regionStart);
        continue;
      }
      for (let s = 0; s < slots.length; s += 1) {
        const slot = slots[s];
        if (s === 0) push(slot, token.index, regionStart + slot.endIndex);
        else push(slot, regionStart + slot.beginIndex, regionStart + slot.endIndex);
      }
    }

    // 日付が複数・時刻が 1 組の行は、時刻を各日付へ配ってから返す（レビュー r2 R2-1）
    spreadSingleTimeSlot(line, tokens, pending, base);
    for (let k = 0; k < pending.length; k += 1) results.push(pending[k].entry);
  }
  return results;
}

/** 行に含まれる締切語の位置を返す（「まで」は日時の直後だけ。致命 1） */
export function deadlineKeywordsIn(line) {
  const text = String(line === null || line === undefined ? "" : line);
  const hits = [];
  for (let i = 0; i < DEADLINE_KEYWORDS.length; i += 1) {
    const word = DEADLINE_KEYWORDS[i];
    let at = text.indexOf(word);
    while (at >= 0) {
      hits.push({ index: at, word: word });
      at = text.indexOf(word, at + word.length);
    }
  }
  DEADLINE_MADE_REGEX.lastIndex = 0;
  let m = DEADLINE_MADE_REGEX.exec(text);
  while (m) {
    hits.push({ index: m.index + m[0].length - m[1].length, word: m[1] });
    m = DEADLINE_MADE_REGEX.exec(text);
  }
  hits.sort(function (a, b) {
    return a.index - b.index;
  });
  return hits;
}

/** その行が締切の行か（相対表現「本日中」なども締切として数える） */
export function hasDeadlineKeyword(line) {
  const text = String(line === null || line === undefined ? "" : line);
  if (deadlineKeywordsIn(text).length > 0) return true;
  for (let i = 0; i < RELATIVE_DEADLINE_RULES.length; i += 1) {
    if (RELATIVE_DEADLINE_RULES[i].re.test(text)) return true;
  }
  return false;
}

/** 行のうち index より前にある語の、いちばん後ろの位置（無ければ -1） */
function lastIndexOfWords(text, words) {
  let found = -1;
  for (let i = 0; i < words.length; i += 1) {
    const at = text.lastIndexOf(words[i]);
    if (at > found) found = at;
  }
  return found;
}

/**
 * その日時が「予定の語」に係っているか（致命 2）。
 * 同じ句（、。で区切る）の中で、日時より前に `面接`・`説明会` などがあり、
 * そのあとに締切語が無ければ「予定の日時」とみなして締切候補から外す。
 */
function ownedByEventWord(line, dateIndex) {
  let clauseStart = 0;
  for (let i = dateIndex - 1; i >= 0; i -= 1) {
    if (CLAUSE_BREAK_REGEX.test(line.charAt(i))) {
      clauseStart = i + 1;
      break;
    }
  }
  const head = line.slice(clauseStart, dateIndex);
  const eventAt = lastIndexOfWords(head, EVENT_LINE_KEYWORDS);
  if (eventAt < 0) return false;
  const hits = deadlineKeywordsIn(head);
  const deadlineAt = hits.length > 0 ? hits[hits.length - 1].index : -1;
  return !(deadlineAt > eventAt);
}

/** 受信日を基準にした相対表現の締切（本日中・明日中・明後日。軽微 7） */
function relativeDeadlineIn(line, baseIso) {
  const baseEpoch = jstEpochFromIso(baseIso);
  if (!isFinite(baseEpoch)) return null;
  for (let i = 0; i < RELATIVE_DEADLINE_RULES.length; i += 1) {
    const rule = RELATIVE_DEADLINE_RULES[i];
    const m = rule.re.exec(line);
    if (!m) continue;
    const day = new Date(baseEpoch + rule.days * DAY_IN_MS);
    return {
      at: toIso(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), 23, 59),
      allDay: true,
      raw: m[0],
      confidence: "high",
    };
  }
  return null;
}

/**
 * 締切を拾う。**締切語 1 つにつき締切は 1 つ**（致命 2）。
 * 同じ行にあればいちばん近い日時、行に日時が無ければ直後 2 行の最初の日時を採る
 * （前の行は含めない＝直前にある面接日時を締切と誤るため。FR-04）。
 * @param {string} text
 * @param {{base?: string}} [options]
 * @returns {Array<{at: string, allDay: boolean, raw: string, line: number, confidence: string}>}
 */
export function parseDeadlines(text, options) {
  const normalized = normalizeText(text);
  const lines = splitLines(normalized);
  const base = options && options.base ? options.base : null;
  const entries = parseDateTimes(normalized, options);
  const byLine = {};
  for (let i = 0; i < entries.length; i += 1) {
    const key = String(entries[i].line);
    if (!byLine[key]) byLine[key] = [];
    byLine[key].push(entries[i]);
  }

  const results = [];
  const seen = {};
  const push = function (at, allDay, raw, lineNo, confidence) {
    if (!at || seen[at]) return;
    seen[at] = true;
    results.push({ at: at, allDay: allDay, raw: raw, line: lineNo, confidence: confidence });
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    // ① 受信日基準の相対表現（本日中・明日中・明後日）はそれ自体が締切
    const relative = relativeDeadlineIn(line, base);
    if (relative) {
      push(relative.at, relative.allDay, relative.raw, i + 1, relative.confidence);
      continue;
    }
    // ② 締切語
    const hits = deadlineKeywordsIn(line);
    if (hits.length === 0) continue;
    const sameLine = byLine[String(i + 1)] || [];
    if (sameLine.length > 0) {
      // 予定の語に係る日時を外す。全部外れたら「この行に締切は無い」＝次の行は見に行かない
      const usable = [];
      for (let k = 0; k < sameLine.length; k += 1) {
        if (!ownedByEventWord(line, sameLine[k].col)) usable.push(sameLine[k]);
      }
      for (let h = 0; h < hits.length; h += 1) {
        let best = null;
        let bestDistance = -1;
        for (let k = 0; k < usable.length; k += 1) {
          const distance = Math.abs(usable[k].col - hits[h].index);
          if (best === null || distance < bestDistance) {
            best = usable[k];
            bestDistance = distance;
          }
        }
        if (best) push(best.start, best.allDay, best.raw, best.line, best.confidence);
      }
      continue;
    }
    // ③ 直後 2 行の最初の日時（予定の語がある行は締切にしない）
    for (let k = 1; k <= 2; k += 1) {
      if (i + k >= lines.length) break;
      const list = byLine[String(i + k + 1)] || [];
      if (list.length === 0) continue;
      if (EVENT_LINE_REGEX.test(lines[i + k])) break;
      push(list[0].start, list[0].allDay, list[0].raw, list[0].line, list[0].confidence);
      break;
    }
  }
  return results;
}

/**
 * 「第1希望／候補日／いずれか」の文脈で 2 件以上の日付が並んでいれば候補日として返す。
 * @param {string} text
 * @param {{base?: string}} [options]
 * @returns {{choices: string[], replyBy: string|null}|null}
 */
export function detectChoices(text, options) {
  const normalized = normalizeText(text);
  const lines = splitLines(normalized);
  const contextLines = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (isChoiceContextLine(lines, i)) contextLines.push(i + 1);
  }
  if (contextLines.length === 0) return null;

  const entries = parseDateTimes(normalized, options);
  const choices = [];
  const seen = {};
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    const lineText = lines[entry.line - 1] || "";
    if (hasDeadlineKeyword(lineText)) continue; // 返信期限は候補日ではない
    let near = false;
    for (let k = 0; k < contextLines.length; k += 1) {
      const diff = entry.line - contextLines[k];
      if (diff >= 0 && diff <= 6) {
        near = true;
        break;
      }
    }
    if (!near) continue;
    if (seen[entry.start]) continue;
    seen[entry.start] = true;
    choices.push(entry.start);
  }
  if (choices.length < 2) return null;
  const deadlines = parseDeadlines(normalized, options);
  return { choices: choices, replyBy: deadlines.length > 0 ? deadlines[0].at : null };
}
