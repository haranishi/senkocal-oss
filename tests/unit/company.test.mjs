/**
 * company.test.mjs — 企業名と媒体（docs/03 §7 の「企業名 20 例」）
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  MEDIA_DOMAINS,
  detectMedia,
  extractDisplayName,
  extractEmailAddress,
  extractCompany,
  findCorporateName,
  isRoleOnlyName,
  normalizeCompany,
} from "../../src/core/company.js";

// --- 媒体の判定 -------------------------------------------------------------
const MEDIA_CASES = [
  ["マイナビ", "マイナビ2028 <no-reply@mynavi.jp>", "mynavi"],
  ["マイナビのサブドメイン", "<info@job.mynavi.jp>", "mynavi"],
  ["リクナビ", "<info@rikunabi.com>", "rikunabi"],
  ["リクルートエージェント", "<info@r-agent.com>", "rikunabi"],
  ["ONE CAREER", "<noreply@onecareer.jp>", "onecareer"],
  ["OfferBox", "<info@offerbox.jp>", "offerbox"],
  ["キャリタス", "<info@career-tasu.jp>", "careertasu"],
  ["i-web", "<mypage@i-web.jp>", "iweb"],
  ["Axol", "<noreply@axol.jp>", "axol"],
  ["sonar ATS", "<system@sonar-ats.jp>", "sonar"],
  ["thinkings", "<system@thinkings.co.jp>", "sonar"],
  ["企業から直接", "株式会社サンプル商事 <recruit@sample-shoji.example.co.jp>", "direct"],
  ["アドレスが読めない", "採用担当", "unknown"],
];

for (let i = 0; i < MEDIA_CASES.length; i += 1) {
  const [name, from, media] = MEDIA_CASES[i];
  test("媒体: " + name, () => {
    assert.equal(detectMedia(from), media);
  });
}

test("媒体: MEDIA_DOMAINS は 8 媒体（K-1 の対象）", () => {
  assert.deepEqual(Object.keys(MEDIA_DOMAINS).sort(), [
    "axol",
    "careertasu",
    "iweb",
    "mynavi",
    "offerbox",
    "onecareer",
    "rikunabi",
    "sonar",
  ]);
});

// --- From ヘッダーの分解 ----------------------------------------------------
test("From: 表示名とアドレスに分ける", () => {
  assert.equal(extractDisplayName("株式会社サンプル商事 採用担当 <recruit@a.example.jp>"), "株式会社サンプル商事 採用担当");
  assert.equal(extractEmailAddress("株式会社サンプル商事 採用担当 <recruit@a.example.jp>"), "recruit@a.example.jp");
  assert.equal(extractDisplayName("<info@example.net>"), "");
  assert.equal(extractEmailAddress("info@example.net"), "info@example.net");
});

test("From: 引用符つきの表示名", () => {
  assert.equal(extractDisplayName('"株式会社サンプル商事" <recruit@a.example.jp>'), "株式会社サンプル商事");
});

// --- 表記ゆれの正規化 -------------------------------------------------------
const NORMALIZE_CASES = [
  ["（株）を株式会社に", "（株）サンプル商事", "株式会社サンプル商事"],
  ["㈱を株式会社に", "㈱サンプル商事", "株式会社サンプル商事"],
  ["後ろの(株)も株式会社に", "サンプル商事(株)", "サンプル商事株式会社"],
  ["（有）を有限会社に", "（有）サンプル", "有限会社サンプル"],
  ["全角英数を半角に", "ＡＢＣ株式会社", "ABC株式会社"],
  ["採用担当を落とす", "株式会社サンプル商事 採用担当", "株式会社サンプル商事"],
  ["人事部を落とす", "サンプル製作所株式会社 人事部", "サンプル製作所株式会社"],
  ["新卒採用チームを落とす", "株式会社サンプル製菓 新卒採用チーム", "株式会社サンプル製菓"],
  ["採用事務局を落とす", "サンプル出版株式会社 採用事務局", "サンプル出版株式会社"],
  ["御中を落とす", "株式会社サンプル商事 御中", "株式会社サンプル商事"],
  ["前後の記号を落とす", "【株式会社サンプル商事】", "株式会社サンプル商事"],
  ["社名が消える削り方はしない", "株式会社リクルート", "株式会社リクルート"],
  ["空文字はそのまま空", "", ""],
];

for (let i = 0; i < NORMALIZE_CASES.length; i += 1) {
  const [name, input, expected] = NORMALIZE_CASES[i];
  test("正規化: " + name, () => {
    assert.equal(normalizeCompany(input), expected);
  });
}

test("役職だけの表示名を見分ける", () => {
  assert.equal(isRoleOnlyName("採用担当"), true);
  assert.equal(isRoleOnlyName("人事部"), true);
  assert.equal(isRoleOnlyName("新卒採用チーム"), true);
  assert.equal(isRoleOnlyName("株式会社サンプル商事 採用担当"), false);
});

test("文中から法人格つきの社名を拾う", () => {
  assert.equal(findCorporateName("この度はサンプル商事株式会社にご応募いただき"), "サンプル商事株式会社");
  assert.equal(findCorporateName("株式会社サンプル物流より、以下のメッセージが届いています。"), "株式会社サンプル物流");
  assert.equal(findCorporateName("法人格のない文章です"), null);
});

// --- 優先順（FR-05） --------------------------------------------------------
test("企業名: ① From 表示名を最優先（確度 high）", () => {
  const got = extractCompany({
    from: "株式会社サンプル商事 採用担当 <recruit@sample-shoji.example.co.jp>",
    subject: "【1次面接のご案内】",
    body: "サンプル別会社株式会社の名前が本文にあっても From を優先する",
  });
  assert.equal(got.name, "株式会社サンプル商事");
  assert.equal(got.source, "from");
  assert.equal(got.confidence, "high");
});

test("企業名: 媒体からのメールは From 表示名を使わない", () => {
  const got = extractCompany({
    from: "マイナビ2028 <no-reply@mynavi.jp>",
    subject: "【マイナビ2028】株式会社サンプル物流からメッセージが届いています",
    body: "",
  });
  assert.equal(got.name, "株式会社サンプル物流");
  assert.equal(got.source, "subject");
  assert.equal(got.media, "mynavi");
});

test("企業名: ② 件名の【】から拾う（媒体名と一般語は弾く）", () => {
  const got = extractCompany({
    from: "採用事務局 <mypage@i-web.jp>",
    subject: "【サンプル銀行】エントリーシート提出のお願い",
    body: "",
  });
  assert.equal(got.name, "サンプル銀行");
  assert.equal(got.source, "subject");
});

test("企業名: ATS（i-web・axol・sonar）の From 表示名は信用する（軽微 9）", () => {
  const got = extractCompany({
    from: "サンプル銀行株式会社 <saiyo@ap.i-web.jp>",
    subject: "エントリーシート提出のお願い",
    body: "ご応募ありがとうございます。",
  });
  assert.equal(got.name, "サンプル銀行株式会社");
  assert.equal(got.source, "from");
  assert.equal(got.media, "iweb");
  assert.equal(got.confidence, "high");
});

test("企業名: ATS でも表示名に媒体名が入っていれば使わない（軽微 9）", () => {
  const got = extractCompany({
    from: "sonar ATS <no-reply@sonar-ats.jp>",
    subject: "【株式会社サンプル電機】2次面接のご案内",
    body: "",
  });
  assert.equal(got.name, "株式会社サンプル電機");
  assert.equal(got.source, "subject");
  assert.equal(got.media, "sonar");
});

test("企業名: ナビ媒体は ATS と違って From を捨てる（軽微 9 の線引き）", () => {
  const got = extractCompany({
    from: "株式会社サンプル物流 <no-reply@rikunabi.com>",
    subject: "リクナビからのお知らせ",
    body: "サンプル海運株式会社の説明会が公開されました。",
  });
  assert.equal(got.name, "サンプル海運株式会社");
  assert.equal(got.source, "body");
  assert.equal(got.media, "rikunabi");
});

test("企業名: 英語の役職語は落とす（軽微 10）", () => {
  const cases = [
    ["SAMPLE Inc. Recruiting <recruit@sample-inc.example.com>", "SAMPLE Inc."],
    ["SAMPLE Inc. Recruiting Team <recruit@sample-inc.example.com>", "SAMPLE Inc."],
    ["SAMPLE Inc. Talent Acquisition <ta@sample-inc.example.com>", "SAMPLE Inc."],
    ["SAMPLE Inc. Careers <careers@sample-inc.example.com>", "SAMPLE Inc."],
    ["SAMPLE Inc. HR <hr@sample-inc.example.com>", "SAMPLE Inc."],
    ["No Reply SAMPLE Inc. <noreply@sample-inc.example.com>", "SAMPLE Inc."],
  ];
  for (let i = 0; i < cases.length; i += 1) {
    const got = extractCompany({ from: cases[i][0], subject: "Interview", body: "" });
    assert.equal(got.name, cases[i][1], cases[i][0]);
  }
});

test("企業名: 英語の役職語だけの表示名は使わない（軽微 10）", () => {
  const words = ["Recruiting", "Recruiting Team", "HR", "Talent Acquisition", "Careers", "No Reply", "noreply"];
  for (let i = 0; i < words.length; i += 1) {
    assert.equal(isRoleOnlyName(words[i]), true, words[i]);
  }
  assert.equal(isRoleOnlyName("SAMPLE Inc. Recruiting"), false);
});

test("企業名: ③ 本文冒頭の「◯◯株式会社です」", () => {
  const got = extractCompany({
    from: "採用担当 <recruit@example.co.jp>",
    subject: "面接日程のご案内",
    body: "サンプル運輸株式会社の採用担当です。\n面接の日程をご案内いたします。",
  });
  assert.equal(got.name, "サンプル運輸株式会社");
  assert.equal(got.source, "body");
  assert.equal(got.confidence, "medium");
});

test("企業名: ④ 署名ブロックから拾う", () => {
  const got = extractCompany({
    from: "<recruit@example.co.jp>",
    subject: "面接のご案内",
    body: "面接の日程についてご案内いたします。\n日時：3月5日（木）14:00\nご確認ください。\n\n--\nサンプル物産株式会社 採用担当\n",
  });
  assert.equal(got.name, "サンプル物産株式会社");
  assert.equal(got.source, "signature");
});

test("企業名: 取れなければ null（画面で入力してもらう）", () => {
  const got = extractCompany({
    from: "<info@example.net>",
    subject: "面接のご案内",
    body: "面接の日程についてご案内いたします。",
  });
  assert.equal(got.name, null);
  assert.equal(got.source, null);
  assert.equal(got.confidence, "low");
});

test("企業名: 表示名が役職だけなら From を使わない", () => {
  const got = extractCompany({ from: "採用担当 <recruit@example.co.jp>", subject: "面接のご案内", body: "" });
  assert.notEqual(got.name, "採用担当");
});

test("企業名: 件名の一般語（予約完了・日程調整）は企業名にしない", () => {
  const got = extractCompany({ from: "<noreply@example.jp>", subject: "【予約完了】説明会のご案内", body: "" });
  assert.equal(got.name, null);
});
