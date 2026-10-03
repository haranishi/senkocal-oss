/**
 * company.js — 企業名と媒体の判定
 *
 * 優先順は FR-05 のとおり（① From の表示名 ② 件名 ③ 本文冒頭 ④ 署名）。
 * ただし From が媒体（マイナビ・リクナビ・ATS など）のときは表示名を信じない。
 * 「株式会社サンプル商事 採用担当」から役職名を落とす処理は、落としすぎると
 * 「株式会社リクルート」のような社名まで削るので、削った結果が社名として成立するときだけ削る。
 */

import { normalizeText, signatureBlock, splitLines, stripSignature } from "./text.js";

/** 媒体・ATS のドメイン。ここから来たメールは From 表示名を企業名に使わない */
export const MEDIA_DOMAINS = {
  mynavi: ["mynavi.jp"],
  rikunabi: ["rikunabi.com", "r-agent.com"],
  onecareer: ["onecareer.jp"],
  offerbox: ["offerbox.jp"],
  careertasu: ["career-tasu.jp"],
  iweb: ["i-web.jp"],
  axol: ["axol.jp"],
  sonar: ["sonar-ats.jp", "thinkings.co.jp"],
};

/** ナビ媒体（企業ではなく媒体が送るので From 表示名を企業名に使わない。FR-05） */
export const NAVI_MEDIA = ["mynavi", "rikunabi", "onecareer", "offerbox", "careertasu"];

/** 媒体の呼び名。件名の【】から企業名を拾うときに弾く */
export const MEDIA_NAME_WORDS = [
  "マイナビ",
  "リクナビ",
  "ONE CAREER",
  "ワンキャリア",
  "OfferBox",
  "オファーボックス",
  "キャリタス",
  "あさがくナビ",
  "ダイヤモンド",
  "外資就活",
];

/** ATS の名前。ATS 経由でも表示名にこれが入っていれば企業名として信用しない（軽微 9） */
export const ATS_NAME_WORDS = ["i-web", "iweb", "axol", "sonar", "thinkings", "リクルーティング・パートナーズ"];

/** 件名の【】「」に入りがちな、企業名ではない語 */
export const SUBJECT_NOISE_WORDS = [
  "重要",
  "お知らせ",
  "ご案内",
  "案内",
  "面接",
  "面談",
  "説明会",
  "セミナー",
  "締切",
  "締め切り",
  "受付",
  "日程",
  "日程調整",
  "中止",
  "変更",
  "延期",
  "リマインド",
  "自動送信",
  "予約",
  "完了",
  "内定",
  "選考",
  "結果",
  "エントリー",
  "オファー",
  "スカウト",
  "面接官",
  "最終",
  "次面接",
  "御礼",
  "お礼",
  "確認",
  "返信",
  "必読",
  "本日",
  "明日",
  "PR",
  "広告",
];

/** 表示名や社名の前後に付く役職・部署の語 */
export const COMPANY_ROLE_WORDS = [
  "新卒採用チーム",
  "新卒採用グループ",
  "新卒採用担当",
  "新卒採用事務局",
  "新卒採用",
  "中途採用",
  "採用ご担当",
  "採用担当者",
  "採用担当",
  "採用事務局",
  "採用チーム",
  "採用グループ",
  "採用センター",
  "人事部",
  "人事課",
  "人事担当",
  "人事",
  "事務局",
  "リクルート",
  "御中",
  "各位",
  "様",
  "より",
  "宛",
  // 英語の役職語（軽微 10）。長い語を先に置く＝前方一致で短い語に食われないため
  "Talent Acquisition",
  "Recruiting Team",
  "Recruitment Team",
  "Recruiting",
  "Recruitment",
  "Recruiter",
  "Careers",
  "Career Center",
  "No Reply",
  "No-Reply",
  "NoReply",
  "noreply",
  "HR Department",
  "HR",
];

const CORP_SUFFIX_SOURCE = "株式会社|合同会社|有限会社|一般社団法人|一般財団法人|独立行政法人|学校法人|医療法人";
/** 社名に使う文字（ひらがなを外して「この度はサンプル商事株式会社」の頭を巻き込まないようにする） */
const COMPANY_NAME_CHARS = "0-9A-Za-z\\u30a0-\\u30ff\\u3400-\\u9fff\\uff66-\\uff9f・ー&'’.\\-";
const CORP_NAME_REGEX = new RegExp(
  "([" + COMPANY_NAME_CHARS + "]{1,24})(?:" + CORP_SUFFIX_SOURCE + ")|(?:" + CORP_SUFFIX_SOURCE + ")([" + COMPANY_NAME_CHARS + "]{1,24})"
);
const CORP_SUFFIX_REGEX = new RegExp(CORP_SUFFIX_SOURCE);
const BRACKET_REGEX = /[【「『\[]([^】」』\]]{2,30})[】」』\]]/g;

/** From ヘッダーからメールアドレスだけ取り出す */
export function extractEmailAddress(from) {
  const text = String(from === null || from === undefined ? "" : from);
  const angle = /<([^<>]+)>/.exec(text);
  if (angle) return angle[1].trim();
  const bare = /[^\s<>()"',;:]+@[^\s<>()"',;:]+/.exec(text);
  return bare ? bare[0].trim() : "";
}

/** From ヘッダーから表示名だけ取り出す */
export function extractDisplayName(from) {
  const text = String(from === null || from === undefined ? "" : from).trim();
  const angle = text.indexOf("<");
  let display = angle >= 0 ? text.slice(0, angle) : "";
  if (angle < 0 && text.indexOf("@") < 0) display = text;
  display = display.replace(/^["'\s]+/, "").replace(/["'\s]+$/, "");
  return display;
}

/**
 * 送信元アドレスから媒体を判定する。
 * @param {string} fromAddress From ヘッダー全体でもアドレスだけでもよい
 * @returns {string} mynavi ほか／直接メールは direct／読めなければ unknown
 */
export function detectMedia(fromAddress) {
  const address = extractEmailAddress(fromAddress);
  if (!address) return "unknown";
  const at = address.lastIndexOf("@");
  if (at < 0) return "unknown";
  const domain = address.slice(at + 1).toLowerCase().replace(/[>\s]+$/, "");
  const names = Object.keys(MEDIA_DOMAINS);
  for (let i = 0; i < names.length; i += 1) {
    const list = MEDIA_DOMAINS[names[i]];
    for (let j = 0; j < list.length; j += 1) {
      const d = list[j];
      if (domain === d || domain.slice(-(d.length + 1)) === "." + d) return names[i];
    }
  }
  return "direct";
}

/** 役職・部署の語を前後から落とす。落とした結果が社名として成立しないときは落とさない */
function stripCompanyRoleWords(name) {
  let value = String(name);
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < COMPANY_ROLE_WORDS.length; i += 1) {
      const word = COMPANY_ROLE_WORDS[i];
      // ASCII の語は大文字小文字を区別しない（NOREPLY・No Reply・noreply を同じに扱う）
      const ascii = /^[\x20-\x7e]+$/.test(word);
      const haystack = ascii ? value.toLowerCase() : value;
      const needle = ascii ? word.toLowerCase() : word;
      let next = null;
      if (haystack.slice(-needle.length) === needle) next = value.slice(0, value.length - needle.length);
      else if (haystack.slice(0, needle.length) === needle) next = value.slice(needle.length);
      if (next === null) continue;
      const trimmed = next.replace(/^[\s・,、:\-|/]+/, "").replace(/[\s・,、。:\-|/]+$/, "");
      if (trimmed === "") continue;
      // 「株式会社リクルート」→「株式会社」のように法人格だけになるなら落とさない
      if (CORP_SUFFIX_REGEX.test(value)) {
        const rest = trimmed.replace(new RegExp(CORP_SUFFIX_SOURCE), "");
        if (rest.length === 0) continue;
      } else if (trimmed.length < 2) {
        continue;
      }
      value = trimmed;
      changed = true;
      break;
    }
  }
  return value;
}

/** 役職・部署の語しか無い表示名（「採用担当」「人事部」など）かどうか */
export function isRoleOnlyName(name) {
  let value = String(name === null || name === undefined ? "" : name).normalize("NFKC");
  for (let i = 0; i < COMPANY_ROLE_WORDS.length; i += 1) {
    const word = COMPANY_ROLE_WORDS[i];
    if (/^[\x20-\x7e]+$/.test(word)) {
      // ASCII の語は大文字小文字を区別せず落とす
      const re = new RegExp(word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
      value = value.replace(re, "");
    } else {
      value = value.split(word).join("");
    }
  }
  return value.replace(/[\s・,、。:\-|/]+/g, "") === "";
}

/**
 * 表記ゆれを均す。（株）㈱ (株) → 株式会社、全角英数 → 半角、前後の記号と役職を除く。
 * @param {string} name
 * @returns {string}
 */
export function normalizeCompany(name) {
  if (name === null || name === undefined) return "";
  let value = String(name).normalize("NFKC");
  value = value.replace(/\(株\)/g, "株式会社").replace(/\(有\)/g, "有限会社").replace(/\(同\)/g, "合同会社");
  value = value.replace(/[【】「」『』\[\]<>《》()]/g, " ");
  value = value.replace(/[　\s]+/g, " ").trim();
  value = stripCompanyRoleWords(value);
  value = value.replace(/^[\s・,、:\-|/]+/, "").replace(/[\s・,、。:\-|/]+$/, "");
  return value.trim();
}

/** 文中から法人格を含む社名を拾う */
export function findCorporateName(text) {
  const value = String(text === null || text === undefined ? "" : text);
  const m = CORP_NAME_REGEX.exec(value);
  if (!m) return null;
  const name = normalizeCompany(m[0]);
  return name === "" ? null : name;
}

/** 表示名に媒体・ATS の名前が入っているか（入っていれば企業名として使わない） */
export function hasMediaName(name) {
  const lower = String(name === null || name === undefined ? "" : name).toLowerCase();
  if (lower === "") return false;
  for (let i = 0; i < MEDIA_NAME_WORDS.length; i += 1) {
    if (lower.indexOf(MEDIA_NAME_WORDS[i].toLowerCase()) >= 0) return true;
  }
  for (let i = 0; i < ATS_NAME_WORDS.length; i += 1) {
    if (lower.indexOf(ATS_NAME_WORDS[i].toLowerCase()) >= 0) return true;
  }
  return false;
}

/** 件名の【】「」から企業名らしいものを拾う */
function findBracketCompany(subject) {
  const value = String(subject === null || subject === undefined ? "" : subject);
  BRACKET_REGEX.lastIndex = 0;
  let m = BRACKET_REGEX.exec(value);
  while (m) {
    const inner = m[1].trim();
    let ng = false;
    for (let i = 0; i < MEDIA_NAME_WORDS.length; i += 1) {
      if (inner.toLowerCase().indexOf(MEDIA_NAME_WORDS[i].toLowerCase()) >= 0) ng = true;
    }
    for (let i = 0; i < SUBJECT_NOISE_WORDS.length; i += 1) {
      if (inner.indexOf(SUBJECT_NOISE_WORDS[i]) >= 0) ng = true;
    }
    if (!ng) {
      const name = normalizeCompany(inner);
      if (name.length >= 2 && !/^\d+$/.test(name)) return name;
    }
    m = BRACKET_REGEX.exec(value);
  }
  return null;
}

/**
 * 企業名を決める。
 * @param {{from?: string, subject?: string, body?: string}} mail
 * @returns {{name: string|null, media: string, source: string|null, confidence: string}}
 */
export function extractCompany(mail) {
  const from = String(mail && mail.from ? mail.from : "");
  const subject = normalizeText(mail && mail.subject ? mail.subject : "");
  const body = normalizeText(mail && mail.body ? mail.body : "");
  const media = detectMedia(from);

  // ① From の表示名。**ナビ媒体だけ**飛ばす（媒体が代理で送るので表示名が企業名でない）。
  // ATS（i-web・axol・sonar）は企業自身が使うので、表示名に媒体名が無ければ信用する（軽微 9）
  if (NAVI_MEDIA.indexOf(media) < 0) {
    const raw = extractDisplayName(from);
    const display = isRoleOnlyName(raw) || hasMediaName(raw) ? "" : normalizeCompany(raw);
    if (display.length >= 2 && !/^\d+$/.test(display) && display.indexOf("@") < 0) {
      return { name: display, media: media, source: "from", confidence: "high" };
    }
  }

  // ② 件名（法人格つきの語 → 【】「」の中身）
  const fromSubject = findCorporateName(subject) || findBracketCompany(subject);
  if (fromSubject) {
    return { name: fromSubject, media: media, source: "subject", confidence: "medium" };
  }

  // ③ 本文冒頭（署名を除いた先頭 10 行）
  const head = splitLines(stripSignature(body)).slice(0, 10).join("\n");
  const fromBody = findCorporateName(head);
  if (fromBody) {
    return { name: fromBody, media: media, source: "body", confidence: "medium" };
  }

  // ④ 署名ブロック
  const fromSignature = findCorporateName(signatureBlock(body));
  if (fromSignature) {
    return { name: fromSignature, media: media, source: "signature", confidence: "medium" };
  }

  return { name: null, media: media, source: null, confidence: "low" };
}
