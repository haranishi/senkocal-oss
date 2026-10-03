/**
 * classify.js — 種別・段階・ノイズの判定
 *
 * 判定語はすべてデータとして export し、unit テストで網羅を確かめられるようにしている（FR-02）。
 * 件名は本文より強い手がかりなので、**件名で当たった種別を優先**する
 * （「選考結果のご連絡」の本文に前回の面接日時が書いてあっても result にする、など）。
 * ノイズ判定は「件名に選考の語が無い」ことを条件にして、まっとうな案内メールの
 * フッターにある「配信停止」で捨ててしまう事故を防ぐ。
 */

import { parseDateTimes } from "./dates.js";
import { letterRatio, normalizeText } from "./text.js";

/** 強い種別から先に見る。change → result → schedule_request → interview → test → es → seminar */
export const KIND_PRIORITY = [
  "change",
  "result",
  "schedule_request",
  "interview",
  "test_deadline",
  "es_deadline",
  "seminar",
];

/** 種別の判定語（小文字化して部分一致。ASCII だけの語は単語境界で見る） */
export const KIND_KEYWORDS = {
  change: ["日時変更", "日程変更", "変更のお知らせ", "変更のご連絡", "中止", "延期", "キャンセル", "取り止め"],
  result: [
    "内定",
    "内々定",
    "選考結果",
    "合否",
    "お祈り",
    "残念ながら",
    "見送り",
    "通過のご連絡",
    "不採用",
    "採用内定",
  ],
  schedule_request: [
    "日程調整",
    "希望日",
    "候補日",
    "ご都合",
    "日程のご選択",
    "日程の選択",
    "ご希望の日程",
    "日程をお選び",
  ],
  interview: ["面接", "面談", "グループディスカッション", "GD", "ケース面接", "リクルーター", "選考会"],
  test_deadline: ["webテスト", "適性検査", "spi", "玉手箱", "受検", "テストセンター", "tg-web", "web test"],
  es_deadline: [
    "エントリーシート",
    "es提出",
    "es締切",
    "応募締切",
    "エントリー締切",
    "書類提出",
    "履歴書提出",
    "応募書類",
    "提出書類",
  ],
  seminar: [
    "説明会",
    "会社説明",
    "セミナー",
    "座談会",
    "インターン",
    "インターンシップ",
    "ワークショップ",
    "会社紹介",
    "オープンカンパニー",
    "仕事研究",
  ],
};

/** 面接の段階。前から順に見て最初に当たったものを採る */
export const STAGE_KEYWORDS = [
  { stage: "最終", words: ["最終面接", "最終選考", "最終面談"] },
  { stage: "カジュアル", words: ["カジュアル面談", "カジュアル面接", "カジュアル"] },
  { stage: "3次", words: ["3次", "三次"] },
  { stage: "2次", words: ["2次", "二次"] },
  { stage: "1次", words: ["1次", "一次", "初回面接"] },
];

/** ノイズ（メルマガ・広告・スカウト・システム通知）の判定語 */
export const NOISE_KEYWORDS = [
  "メルマガ",
  "メールマガジン",
  "配信停止",
  "配信の停止",
  "unsubscribe",
  "キャンペーン",
  "スカウト",
  "オファーが届",
  "プレミアム",
  "広告",
  "アンケート",
  "ポイント",
  "ログイン通知",
  "自動送信",
  "無料登録",
  "会員登録",
  "PR",
];

/** 英字だけのメールと見なす閾値（FR-02） */
export const ENGLISH_ONLY_RATIO = 0.9;
/** 短すぎる文面で英字比率を使うと誤るので、この文字数以上のときだけ判定する */
export const ENGLISH_ONLY_MIN_LETTERS = 40;

/** ASCII だけの語か */
function isAsciiWord(word) {
  return /^[\x20-\x7e]+$/.test(word);
}

/** 語の一致（ASCII の語は単語境界つき） */
function hasKeyword(haystackLower, word) {
  const lower = String(word).toLowerCase();
  if (!isAsciiWord(lower)) return haystackLower.indexOf(lower) >= 0;
  const escaped = lower.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
  return new RegExp("(^|[^a-z0-9])" + escaped + "([^a-z0-9]|$)").test(haystackLower);
}

/** 当たった語をすべて返す */
export function matchKeywords(text, words) {
  const lower = String(text === null || text === undefined ? "" : text).toLowerCase();
  const hits = [];
  for (let i = 0; i < words.length; i += 1) {
    if (hasKeyword(lower, words[i])) hits.push(words[i]);
  }
  return hits;
}

/** その文字列に含まれる種別を、優先順に並べて返す */
function kindsIn(text) {
  const found = [];
  for (let i = 0; i < KIND_PRIORITY.length; i += 1) {
    const kind = KIND_PRIORITY[i];
    if (matchKeywords(text, KIND_KEYWORDS[kind]).length > 0) found.push(kind);
  }
  return found;
}

/** 面接の段階（1次／2次／3次／最終／カジュアル） */
export function detectStage(text) {
  const value = String(text === null || text === undefined ? "" : text);
  for (let i = 0; i < STAGE_KEYWORDS.length; i += 1) {
    const entry = STAGE_KEYWORDS[i];
    for (let j = 0; j < entry.words.length; j += 1) {
      if (value.indexOf(entry.words[j]) >= 0) return entry.stage;
    }
  }
  return null;
}

/**
 * 種別・段階・ノイズを判定する。
 * @param {{subject?: string, body?: string, from?: string}} mail
 * @returns {{kind: string, stage: string|null, isNoise: boolean, matched: string[]}}
 */
export function classifyMail(mail) {
  const subject = normalizeText(mail && mail.subject ? mail.subject : "");
  const body = normalizeText(mail && mail.body ? mail.body : "");
  const both = subject + "\n" + body;

  const subjectKinds = kindsIn(subject);
  const bodyKinds = kindsIn(body);
  const kind = subjectKinds.length > 0 ? subjectKinds[0] : bodyKinds.length > 0 ? bodyKinds[0] : "other";

  const matched = [];
  if (kind !== "other") {
    const hits = matchKeywords(subjectKinds.length > 0 ? subject : body, KIND_KEYWORDS[kind]);
    for (let i = 0; i < hits.length; i += 1) matched.push(hits[i]);
  }

  const noiseInSubject = matchKeywords(subject, NOISE_KEYWORDS);
  const noiseInBoth = matchKeywords(both, NOISE_KEYWORDS);
  const ratio = letterRatio(both);
  const englishOnly = ratio.letters >= ENGLISH_ONLY_MIN_LETTERS && ratio.asciiRatio >= ENGLISH_ONLY_RATIO;
  // 件名のノイズ語だけでノイズにしない（重要 4）。本文からも種別が取れず、日時も無いときに限る。
  // 「スカウトのご返信ありがとうございます」の本文に面談日時が書いてあるのは、
  // 媒体スカウト経由で面談が決まった直後のメールの典型なので落とすと痛い。
  const noiseBySubject =
    subjectKinds.length === 0 &&
    noiseInSubject.length > 0 &&
    bodyKinds.length === 0 &&
    parseDateTimes(body, {}).length === 0;
  const isNoise = englishOnly || (kind === "other" && noiseInBoth.length > 0) || noiseBySubject;
  if (englishOnly) matched.push("english-only");
  for (let i = 0; i < noiseInBoth.length; i += 1) matched.push(noiseInBoth[i]);

  const stage = kind === "interview" || kind === "change" || kind === "schedule_request"
    ? detectStage(subject) || detectStage(body)
    : null;

  return { kind: kind, stage: stage, isNoise: isNoise, matched: matched };
}
