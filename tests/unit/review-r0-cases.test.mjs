/**
 * review-r0-cases.test.mjs — レビュー r0 の「日時・締切の誤りやすい入力 30 件」を表のまま固定する
 *
 * レビュー時点では **正解 17 件・誤り 13 件**。FIX r0 で採否表のとおり直したので、
 * ここでは 30 件すべてが正解になることを押さえる。見送りにした指摘は末尾に `skip` で理由を残す。
 * 表の並び（# 1〜30）と入力はレビュー本文（`.agent-harness/REVIEW-r0.md`）のまま。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { detectChoices, parseDateTimes, parseDeadlines } from "../../src/core/dates.js";

const BASE = "2026-03-01T10:12:00+09:00"; // 2026-03-01 は日曜

/** 候補日 3 件＋返信期限（表 #26） */
const CHOICE_TEXT =
  "下記の日程からご都合の良い日をお選びください。\n" +
  "第1希望 3月5日（木）14:00\n" +
  "第2希望 3月6日（金）10:00\n" +
  "第3希望 3月9日（月）13:00\n" +
  "返信期限：3月3日（火）まで";

/**
 * 表の 1 行 = { no, name, text, base?, dates?, deadlines?, choices?, replyBy?, notes? }
 * `dates` は [start, end] の配列、`deadlines` は at の配列。省略した項目は検査しない。
 */
const CASES = [
  {
    no: 1,
    name: "日付の範囲（3日間）は初日 1 件＋期間を note に残す",
    text: "開催期間：3月5日（木）〜3月7日（土）の3日間",
    dates: [["2026-03-05", null]],
    notes: ["期間: 3/5〜3/7（3日間）"],
  },
  {
    no: 2,
    name: "時間帯だけの「いずれか30分」は予定にしない（終日 1 件）",
    text: "14:00-16:00 のいずれか30分で面接を行います（3月5日（木））",
    dates: [["2026-03-05", null]],
  },
  {
    no: 3,
    name: "「3/5 or 3/6 のどちらか」は候補日にまとめる",
    text: "3/5 or 3/6 のどちらかでお願いします",
    choices: ["2026-03-05", "2026-03-06"],
  },
  {
    no: 4,
    name: "令和7年（過去の明示年）は確度 high・isPast",
    text: "令和7年3月5日 14:00〜15:00",
    dates: [["2025-03-05T14:00:00+09:00", "2025-03-05T15:00:00+09:00"]],
    confidences: ["high"],
    pasts: [true],
  },
  {
    no: 5,
    name: "実在しない 2月30日は拾わない",
    text: "2月30日（月）14:00〜15:00",
    dates: [],
  },
  {
    no: 6,
    name: "25時は翌日 1 時・確度は medium",
    text: "3月5日（木）25時開始",
    dates: [["2026-03-06T01:00:00+09:00", null]],
    confidences: ["medium"],
  },
  {
    no: 7,
    name: "「〆切: 明日中」は受信日の翌日 23:59",
    text: "〆切: 明日中にご提出ください",
    deadlines: ["2026-03-02T23:59:00+09:00"],
  },
  {
    no: 8,
    name: "繰り返し（毎週水曜）は対象外",
    text: "毎週水曜 14:00 に定例を行います",
    dates: [],
  },
  {
    no: 9,
    name: "受付時刻は開始にしない・2 枠目にもしない",
    text: "3月5日（木）14:00 受付開始 13:30",
    dates: [["2026-03-05T14:00:00+09:00", null]],
  },
  {
    no: 10,
    name: "時刻が無ければ終日",
    text: "開催: 3/5（木）・場所: 東京",
    dates: [["2026-03-05", null]],
  },
  {
    no: 11,
    name: "「締切 3/10、面接 3/15」は締切 1 件だけ",
    text: "締切 3/10、面接 3/15",
    deadlines: ["2026-03-10"],
    dates: [["2026-03-10", null], ["2026-03-15", null]],
  },
  {
    no: 12,
    name: "締切行の次の行の面接日時は締切にしない",
    text: "3月10日（火）17時締切\n3月12日（木）面接",
    deadlines: ["2026-03-10T17:00:00+09:00"],
  },
  {
    no: 13,
    name: "年跨ぎ（12月受信 → 翌年1月）",
    text: "面接日：1/5（月）10:00〜11:00",
    base: "2025-12-28T10:00:00+09:00",
    dates: [["2026-01-05T10:00:00+09:00", "2026-01-05T11:00:00+09:00"]],
    confidences: ["high"],
  },
  {
    no: 14,
    name: "西暦スラッシュ",
    text: "2026/3/5 14:00〜15:00",
    dates: [["2026-03-05T14:00:00+09:00", "2026-03-05T15:00:00+09:00"]],
    confidences: ["high"],
  },
  {
    no: 15,
    name: "ドット区切り（2026.3.5）",
    text: "2026.3.5 14:00〜15:00",
    dates: [["2026-03-05T14:00:00+09:00", "2026-03-05T15:00:00+09:00"]],
    confidences: ["high"],
  },
  {
    no: 16,
    name: "14時00分",
    text: "3月5日(木)14時00分",
    dates: [["2026-03-05T14:00:00+09:00", null]],
  },
  {
    no: 17,
    name: "全角コロン",
    text: "3月5日（木）14：00～15：00",
    dates: [["2026-03-05T14:00:00+09:00", "2026-03-05T15:00:00+09:00"]],
  },
  {
    no: 18,
    name: "午後0時は 12:00",
    text: "3月5日（木）午後0時",
    dates: [["2026-03-05T12:00:00+09:00", null]],
  },
  {
    no: 19,
    name: "前置 AM",
    text: "3月5日（木）AM10:00",
    dates: [["2026-03-05T10:00:00+09:00", null]],
  },
  {
    no: 20,
    name: "1 行に時間帯 2 つ",
    text: "3月5日（木）10時〜12時、13時〜15時",
    dates: [
      ["2026-03-05T10:00:00+09:00", "2026-03-05T12:00:00+09:00"],
      ["2026-03-05T13:00:00+09:00", "2026-03-05T15:00:00+09:00"],
    ],
  },
  {
    no: 21,
    name: "「本日中」は受信日の 23:59",
    text: "本日中にご返信ください",
    deadlines: ["2026-03-01T23:59:00+09:00"],
  },
  {
    no: 22,
    name: "令和8年2月29日は実在しない",
    text: "令和8年2月29日（土）14:00",
    dates: [],
  },
  {
    no: 23,
    name: "前の行の面接日時は締切にしない（FR-04）",
    text: "面接日時: 3月5日（木）14:00\nES提出締切：3月10日（火）23:59",
    deadlines: ["2026-03-10T23:59:00+09:00"],
  },
  {
    no: 24,
    name: "曜日一致で過去年を採るときは確度 medium・isPast",
    text: "面接日：12月20日（土）14:00〜15:00",
    base: "2026-01-05T09:00:00+09:00",
    dates: [["2025-12-20T14:00:00+09:00", "2025-12-20T15:00:00+09:00"]],
    confidences: ["medium"],
    pasts: [true],
  },
  {
    no: 25,
    name: "年つき・ハイフン範囲",
    text: "2026年3月5日(木)13:30-14:30",
    dates: [["2026-03-05T13:30:00+09:00", "2026-03-05T14:30:00+09:00"]],
    confidences: ["high"],
  },
  {
    no: 26,
    name: "候補日 3 件＋返信期限",
    text: CHOICE_TEXT,
    base: "2026-02-25T12:00:00+09:00",
    choices: ["2026-03-05T14:00:00+09:00", "2026-03-06T10:00:00+09:00", "2026-03-09T13:00:00+09:00"],
    replyBy: "2026-03-03",
  },
  {
    no: 27,
    name: "「14:00までにご来場」は開催日時（締切に化けない）",
    text: "説明会は3月5日（木）14:00までにご来場ください",
    deadlines: [],
    dates: [["2026-03-05T14:00:00+09:00", null]],
  },
  {
    no: 28,
    name: "14時3分",
    text: "3月5日（木）14時3分",
    dates: [["2026-03-05T14:03:00+09:00", null]],
  },
  {
    no: 29,
    name: "後置 PM（2:00 PM）",
    text: "3月5日（木）2:00 PM",
    dates: [["2026-03-05T14:00:00+09:00", null]],
    confidences: ["high"],
  },
  {
    no: 30,
    name: "前置 PM（PM2時）",
    text: "3月5日（木）PM2時",
    dates: [["2026-03-05T14:00:00+09:00", null]],
    confidences: ["high"],
  },
];

test("表は 30 件そろっている", () => {
  assert.equal(CASES.length, 30);
  for (let i = 0; i < CASES.length; i += 1) assert.equal(CASES[i].no, i + 1);
});

for (let i = 0; i < CASES.length; i += 1) {
  const item = CASES[i];
  test("REVIEW-r0 #" + item.no + ": " + item.name, () => {
    const options = { base: item.base || BASE };
    if (item.dates) {
      const got = parseDateTimes(item.text, options);
      assert.deepEqual(
        got.map(function (entry) {
          return [entry.start, entry.end];
        }),
        item.dates,
        "日時"
      );
      if (item.confidences) {
        assert.deepEqual(
          got.map(function (entry) {
            return entry.confidence;
          }),
          item.confidences,
          "確度"
        );
      }
      if (item.pasts) {
        assert.deepEqual(
          got.map(function (entry) {
            return entry.isPast;
          }),
          item.pasts,
          "isPast"
        );
      }
      if (item.notes) {
        assert.deepEqual(
          got.map(function (entry) {
            return entry.note;
          }),
          item.notes,
          "note"
        );
      }
    }
    if (item.deadlines) {
      assert.deepEqual(
        parseDeadlines(item.text, options).map(function (entry) {
          return entry.at;
        }),
        item.deadlines,
        "締切"
      );
    }
    if (item.choices) {
      const got = detectChoices(item.text, options);
      assert.ok(got, "候補日が取れていない");
      assert.deepEqual(got.choices, item.choices, "候補日");
      if (item.replyBy !== undefined) assert.equal(got.replyBy, item.replyBy, "返信期限");
    }
  });
}

// --- 見送りにした指摘（FIX r0 の採否表） -----------------------------------
test.skip("軽微 3（完全版）: 3日間の中日（3/6）も候補にする", () => {
  // 見送り。初日の候補に「期間: 3/5〜3/7（3日間）」を note で残すところまでにした（#1 で固定）。
  // 中日まで候補にすると 3 日間のインターンで 3 件が並び、押す手間が増えるほうが痛いと判断した。
});

test.skip("軽微 11: MEDIA_NAME_WORDS にあってドメインが無い媒体（あさがくナビ・ダイヤモンド・外資就活）", () => {
  // 見送り。実際の送信ドメインが分からないまま推測で足すと、企業の直メールを媒体と誤判定しうる。
  // 本人の実メールでの較正（FR-14）で確かめてから MEDIA_DOMAINS に足す。
});

test.skip("軽微 12: 英語だけのメールを面接案内として拾う", () => {
  // 見送り。FR-02 の「英語のみはノイズ」という仕様どおりの挙動で、台帳には「ノイズ」で残るので気づける。
  // 外資を受けると決まった時点で、仕様のほうを変えてから直す。
});
