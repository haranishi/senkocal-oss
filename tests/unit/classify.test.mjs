/**
 * classify.test.mjs — 種別・段階・ノイズ（FR-02）
 * 判定語がデータとして export されているので、辞書の全語を機械的に回して網羅を確かめる。
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  KIND_KEYWORDS,
  KIND_PRIORITY,
  NOISE_KEYWORDS,
  STAGE_KEYWORDS,
  classifyMail,
  detectStage,
  matchKeywords,
} from "../../src/core/classify.js";

test("KIND_PRIORITY は docs/03 §4 の順序（強い種別が先）", () => {
  assert.deepEqual(KIND_PRIORITY, [
    "change",
    "result",
    "schedule_request",
    "interview",
    "test_deadline",
    "es_deadline",
    "seminar",
  ]);
});

test("KIND_PRIORITY と KIND_KEYWORDS の種別が一致する", () => {
  assert.deepEqual(Object.keys(KIND_KEYWORDS).sort(), KIND_PRIORITY.slice().sort());
});

// 辞書の全語が、その種別として判定できること（自分より強い種別の語を含む語は除く）
for (let i = 0; i < KIND_PRIORITY.length; i += 1) {
  const kind = KIND_PRIORITY[i];
  test("辞書の網羅: " + kind + " の判定語がすべて " + kind + " になる", () => {
    const words = KIND_KEYWORDS[kind];
    assert.ok(words.length > 0);
    for (let j = 0; j < words.length; j += 1) {
      const got = classifyMail({ subject: "【" + words[j] + "】のご案内", body: "" });
      assert.equal(got.kind, kind, words[j] + " が " + got.kind + " になった");
    }
  });
}

test("件名の種別を本文より優先する（合否メールの中の面接日時に引っぱられない）", () => {
  const got = classifyMail({
    subject: "選考結果のご連絡",
    body: "先日の面接ありがとうございました。次回の説明会は3月5日です。",
  });
  assert.equal(got.kind, "result");
});

test("件名に種別が無ければ本文で判定する（媒体の通知メール）", () => {
  const got = classifyMail({
    subject: "【マイナビ2028】株式会社サンプル物流からメッセージが届いています",
    body: "当社の会社説明会を開催します。",
  });
  assert.equal(got.kind, "seminar");
});

test("優先順: 日時変更は面接より強い", () => {
  assert.equal(classifyMail({ subject: "【日時変更のお知らせ】2次面接", body: "" }).kind, "change");
});

test("優先順: 日程調整は面接より強い", () => {
  assert.equal(classifyMail({ subject: "【日程調整】面接日程のご希望日", body: "" }).kind, "schedule_request");
});

test("優先順: 内定は面接より強い", () => {
  assert.equal(classifyMail({ subject: "【内定のご連絡】面接ありがとうございました", body: "" }).kind, "result");
});

test("優先順: Webテストは ES 締切より強い", () => {
  assert.equal(classifyMail({ subject: "Webテスト受検とエントリーシート提出のご案内", body: "" }).kind, "test_deadline");
});

test("優先順: 面接は説明会より強い", () => {
  assert.equal(classifyMail({ subject: "説明会と面接のご案内", body: "" }).kind, "interview");
});

test("どれにも当たらなければ other", () => {
  assert.equal(classifyMail({ subject: "お問い合わせありがとうございます", body: "担当者より折り返します。" }).kind, "other");
});

// --- 段階 -------------------------------------------------------------------
const STAGE_CASES = [
  ["1次面接のご案内", "1次"],
  ["一次面接のご案内", "1次"],
  ["2次面接のご案内", "2次"],
  ["二次面接のご案内", "2次"],
  ["3次面接のご案内", "3次"],
  ["三次面接のご案内", "3次"],
  ["最終面接のご案内", "最終"],
  ["カジュアル面談のご案内", "カジュアル"],
  ["面接のご案内", null],
];

for (let i = 0; i < STAGE_CASES.length; i += 1) {
  const [text, stage] = STAGE_CASES[i];
  test("段階: " + text + " → " + String(stage), () => {
    assert.equal(detectStage(text), stage);
    assert.equal(classifyMail({ subject: text, body: "" }).stage, stage);
  });
}

test("段階: 最終はほかの段階より優先する", () => {
  assert.equal(detectStage("1次〜最終面接まで"), "最終");
});

test("段階: 面接以外の種別では段階を付けない", () => {
  assert.equal(classifyMail({ subject: "1次選考の結果について", body: "" }).stage, null);
});

test("STAGE_KEYWORDS は 5 段階", () => {
  assert.equal(STAGE_KEYWORDS.length, 5);
});

// --- ノイズ -----------------------------------------------------------------
test("ノイズ: スカウト DM", () => {
  const got = classifyMail({
    subject: "【オファーが届きました】あなたに興味を持った企業があります",
    body: "配信停止はマイページから。",
  });
  assert.equal(got.isNoise, true);
});

test("ノイズ: メルマガ", () => {
  const got = classifyMail({ subject: "【就活メルマガ】今週の注目企業", body: "エントリー受付中の企業一覧" });
  assert.equal(got.isNoise, true);
});

test("ノイズ: システム通知", () => {
  const got = classifyMail({ subject: "【自動送信】ログイン通知", body: "新しい端末からログインがありました。" });
  assert.equal(got.isNoise, true);
});

test("ノイズ: 英語だけのメール", () => {
  const got = classifyMail({
    subject: "Interview Invitation for Software Engineer Position",
    body: "Thank you for applying. We would like to invite you to an interview on March 5.",
  });
  assert.equal(got.isNoise, true);
});

test("ノイズ: 短い英語（署名だけ）はノイズにしない", () => {
  const got = classifyMail({ subject: "面接のご案内", body: "日時：3月5日（木）14:00\nZoom" });
  assert.equal(got.isNoise, false);
});

test("ノイズ: 本文フッターの「配信停止」だけで捨てない（件名に選考の語があるとき）", () => {
  const got = classifyMail({
    subject: "【1次面接のご案内】",
    body: "面接の日程です。\n配信停止はこちら。",
  });
  assert.equal(got.isNoise, false);
  assert.equal(got.kind, "interview");
});

test("ノイズ: 件名のノイズ語だけで決めない（本文に種別があれば残す・重要 4）", () => {
  const got = classifyMail({
    subject: "スカウトのご返信ありがとうございます",
    body: "ご返信ありがとうございます。\n面談日時：3月12日（木）14:00〜15:00",
  });
  assert.equal(got.isNoise, false);
  assert.equal(got.kind, "interview");
});

test("ノイズ: 件名のノイズ語＋本文に種別が無くても日時があれば残す（重要 4）", () => {
  const got = classifyMail({
    subject: "【オファーが届きました】あなたに興味を持った企業があります",
    body: "ご都合をお知らせください。3月12日（木）14:00 に担当者がお伺いします。",
  });
  assert.equal(got.isNoise, false);
});

test("ノイズ: 件名のノイズ語＋本文に種別も日時も無ければノイズ（重要 4 の 3 条件）", () => {
  const got = classifyMail({
    subject: "【オファーが届きました】あなたに興味を持った企業があります",
    body: "あなたのプロフィールに興味を持った企業からオファーが届いています。",
  });
  assert.equal(got.isNoise, true);
});

test("NOISE_KEYWORDS の全語がノイズ判定に効く", () => {
  for (let i = 0; i < NOISE_KEYWORDS.length; i += 1) {
    const got = classifyMail({ subject: "お知らせ " + NOISE_KEYWORDS[i], body: "" });
    assert.equal(got.isNoise, true, NOISE_KEYWORDS[i] + " がノイズにならない");
  }
});

test("matchKeywords: ASCII の語は単語境界で見る（PR が PRESS に当たらない）", () => {
  assert.deepEqual(matchKeywords("【PR】新サービス", ["PR"]), ["PR"]);
  assert.deepEqual(matchKeywords("PRESS RELEASE", ["PR"]), []);
  assert.deepEqual(matchKeywords("SPI受検のご案内", ["SPI"]), ["SPI"]);
});

test("matchKeywords: 大文字小文字を区別しない", () => {
  assert.deepEqual(matchKeywords("WEBテストのご案内", ["webテスト"]), ["webテスト"]);
});

test("matched に当たった語が入る（根拠として台帳に残す）", () => {
  const got = classifyMail({ subject: "【1次面接のご案内】", body: "" });
  assert.ok(got.matched.indexOf("面接") >= 0);
});
