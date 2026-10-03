/**
 * dates.test.mjs — 日時と締切の解釈（docs/03 §7 の「日時 40 例以上・締切 15 例」）
 * ここが外れると誤登録に直結するので、表記ゆれを表で押さえる。
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  addDays,
  addMinutes,
  deadlineKeywordsIn,
  detectChoices,
  hasDeadlineKeyword,
  formatJa,
  formatMd,
  formatTimeJa,
  inferYear,
  isValidYmd,
  parseDateTimes,
  parseDeadlines,
  toDateOnly,
  toIso,
  weekdayOf,
} from "../../src/core/dates.js";

const BASE = "2026-03-01T10:12:00+09:00"; // 2026-03-01 は日曜

/** 1 件だけ取れることを前提に先頭を返す */
function firstDate(text, base) {
  const list = parseDateTimes(text, { base: base || BASE });
  return list.length > 0 ? list[0] : null;
}

// --- 日時の表記ゆれ（1 行 1 例） ---------------------------------------------
const DATE_CASES = [
  ["年つき・全部入り", "日時：2026年3月5日（木）14:00〜15:00", "2026-03-05T14:00:00+09:00", "2026-03-05T15:00:00+09:00", "high"],
  ["時だけ・終了なし", "3月5日(木) 14時〜", "2026-03-05T14:00:00+09:00", null, "high"],
  ["スラッシュ・ハイフン範囲", "3/5（木）13:30-14:30", "2026-03-05T13:30:00+09:00", "2026-03-05T14:30:00+09:00", "high"],
  ["午後2時", "3月5日 午後2時", "2026-03-05T14:00:00+09:00", null, "medium"],
  ["14時半", "3月5日（木）14時半〜", "2026-03-05T14:30:00+09:00", null, "high"],
  ["午前10時", "3月5日（木）午前10時より", "2026-03-05T10:00:00+09:00", null, "high"],
  ["正午", "3月5日（木）正午開始", "2026-03-05T12:00:00+09:00", null, "high"],
  ["受付時刻は無視", "3月5日（木）10:00～（受付9:45）", "2026-03-05T10:00:00+09:00", null, "high"],
  ["受付が先にあっても開始を採る", "3月5日（木）受付9:45 開始10:00", "2026-03-05T10:00:00+09:00", null, "high"],
  ["全角（NFKC）", "３月５日（木）１４：００〜１５：００", "2026-03-05T14:00:00+09:00", "2026-03-05T15:00:00+09:00", "high"],
  ["令和8年", "令和8年3月5日（木）15:00より", "2026-03-05T15:00:00+09:00", null, "high"],
  ["西暦スラッシュ", "2026/03/05 14:00-15:00", "2026-03-05T14:00:00+09:00", "2026-03-05T15:00:00+09:00", "high"],
  ["西暦ハイフン", "2026-03-05 14:00～15:00", "2026-03-05T14:00:00+09:00", "2026-03-05T15:00:00+09:00", "high"],
  ["曜日なし", "3月5日 14:00〜15:00", "2026-03-05T14:00:00+09:00", "2026-03-05T15:00:00+09:00", "medium"],
  ["曜日を漢字で", "3月5日 木曜日 14:00", "2026-03-05T14:00:00+09:00", null, "high"],
  ["時分の日本語", "3月5日（木）14時30分〜15時30分", "2026-03-05T14:30:00+09:00", "2026-03-05T15:30:00+09:00", "high"],
  ["波ダッシュ", "3月5日（木）14:00〜15:00", "2026-03-05T14:00:00+09:00", "2026-03-05T15:00:00+09:00", "high"],
  ["全角チルダ", "3月5日（木）14:00～15:00", "2026-03-05T14:00:00+09:00", "2026-03-05T15:00:00+09:00", "high"],
  ["「から」で範囲", "3月5日（木）14:00から15:00", "2026-03-05T14:00:00+09:00", "2026-03-05T15:00:00+09:00", "high"],
  ["「より」は開始のみ", "3月5日（木）14:00より", "2026-03-05T14:00:00+09:00", null, "high"],
  ["終日", "3月5日（木）終日", "2026-03-05", null, "high"],
  ["時刻なしは終日扱い", "面接日：3/5(木)", "2026-03-05", null, "high"],
  ["午後12時は正午のまま", "3月5日（木）午後12時", "2026-03-05T12:00:00+09:00", null, "high"],
  ["午前12時は0時", "3月5日（木）午前12時", "2026-03-05T00:00:00+09:00", null, "high"],
  ["PM 表記", "3月5日（木）PM 2:00", "2026-03-05T14:00:00+09:00", null, "high"],
  ["年跨ぎ（12月受信 → 翌年1月）", "1月12日（火）10:00〜11:00", "2027-01-12T10:00:00+09:00", "2027-01-12T11:00:00+09:00", "high", "2026-12-20T10:00:00+09:00"],
  ["受信日と同じ日は未来に含む", "3月1日（日）18:00", "2026-03-01T18:00:00+09:00", null, "high"],
  ["曜日が合わなければ確度を下げる", "3月5日（金）14:00〜15:00", "2026-03-05T14:00:00+09:00", "2026-03-05T15:00:00+09:00", "low", "2026-02-10T09:00:00+09:00"],
  ["日跨ぎの終了", "3月5日（木）22:00〜1:00", "2026-03-05T22:00:00+09:00", "2026-03-06T01:00:00+09:00", "high"],
  ["次の行に時刻", "日時：3月5日（木）\n14:00〜15:00", "2026-03-05T14:00:00+09:00", "2026-03-05T15:00:00+09:00", "high"],
];

for (let i = 0; i < DATE_CASES.length; i += 1) {
  const [name, text, start, end, confidence, base] = DATE_CASES[i];
  test("日時: " + name, () => {
    const got = firstDate(text, base);
    assert.ok(got, "日時が取れていない: " + text);
    assert.equal(got.start, start);
    assert.equal(got.end, end);
    assert.equal(got.confidence, confidence);
  });
}

test("日時: 1 行に 2 件（中黒区切り）", () => {
  const list = parseDateTimes("3月5日（木）・3月6日（金）", { base: BASE });
  assert.equal(list.length, 2);
  assert.equal(list[0].start, "2026-03-05");
  assert.equal(list[1].start, "2026-03-06");
});

test("日時: 2 行に 2 件（時刻つき）", () => {
  const list = parseDateTimes("【第1回】3月5日（木）10:00〜11:00\n【第2回】3月6日（金）14:00〜15:00", { base: BASE });
  assert.equal(list.length, 2);
  assert.equal(list[0].start, "2026-03-05T10:00:00+09:00");
  assert.equal(list[1].end, "2026-03-06T15:00:00+09:00");
});

test("日時: 実在しない日付は拾わない", () => {
  assert.deepEqual(parseDateTimes("2月30日（木）14:00", { base: BASE }), []);
});

test("日時: 月が 13 以上のスラッシュは日付にしない", () => {
  assert.deepEqual(parseDateTimes("価格は13/14ページに記載", { base: BASE }), []);
});

test("日時: 引用行（>）の日時は拾わない", () => {
  const list = parseDateTimes("> 日時：3月5日（木）14:00\n新しい日程はありません", { base: BASE });
  assert.deepEqual(list, []);
});

test("日時: 行番号を根拠として返す", () => {
  const list = parseDateTimes("お世話になります。\n\n日時：3月5日（木）14:00", { base: BASE });
  assert.equal(list[0].line, 3);
});

test("日時: raw に元の表記が入る", () => {
  const list = parseDateTimes("日時：3月5日（木）14:00〜15:00", { base: BASE });
  assert.equal(list[0].raw, "3月5日(木)14:00〜15:00");
});

test("日時: base が無くても落ちない", () => {
  const list = parseDateTimes("3月5日 14:00", {});
  assert.equal(list.length, 1);
  assert.ok(/^\d{4}-03-05T14:00:00\+09:00$/.test(list[0].start));
});

test("日時: 空文字・null で空配列", () => {
  assert.deepEqual(parseDateTimes("", { base: BASE }), []);
  assert.deepEqual(parseDateTimes(null, { base: BASE }), []);
});

// --- 年の推定 ---------------------------------------------------------------
test("inferYear: 直近の未来（同年）", () => {
  assert.equal(inferYear(3, 5, BASE, null), 2026);
});

test("inferYear: 直近の未来（翌年）", () => {
  assert.equal(inferYear(1, 12, "2026-12-20T10:00:00+09:00", null), 2027);
});

test("inferYear: 曜日が合う年を選ぶ", () => {
  // 2026-03-05 は木曜。金曜と書かれていても 12 か月以内に一致する年が無ければ直近の未来
  assert.equal(inferYear(3, 5, "2026-02-10T09:00:00+09:00", 5), 2026);
});

test("inferYear: 12 か月以内に曜日が一致する年があれば採る", () => {
  // 2026-12-20 は日曜、2025-12-20 は土曜。受信 2026-01-05 から見て 2025-12-20 は 12 か月以内
  assert.equal(inferYear(12, 20, "2026-01-05T09:00:00+09:00", 6), 2025);
});

test("inferYear: 受信日と同じ日は過去にしない", () => {
  assert.equal(inferYear(3, 1, BASE, null), 2026);
});

test("inferYear: 受信日の前日は翌年に倒す", () => {
  assert.equal(inferYear(2, 28, BASE, null), 2027);
});

// --- 締切 -------------------------------------------------------------------
const DEADLINE_CASES = [
  ["締切：時刻つき", "締切：3月10日（火）23:59", "2026-03-10T23:59:00+09:00", false],
  ["まで", "3月10日までにご提出ください", "2026-03-10", true],
  ["正午必着", "3/10 正午必着", "2026-03-10T12:00:00+09:00", false],
  ["締め切り", "3月10日（火）17:00 締め切り", "2026-03-10T17:00:00+09:00", false],
  ["〆切", "〆切：3月10日", "2026-03-10", true],
  ["期限", "提出期限：3月15日（日）正午", "2026-03-15T12:00:00+09:00", false],
  ["期日", "応募期日：3/12", "2026-03-12", true],
  ["受付終了", "受付終了：3月10日（火）12:00", "2026-03-10T12:00:00+09:00", false],
  ["応募終了", "応募終了は3月10日です", "2026-03-10", true],
  ["エントリー締切", "エントリー締切：3月10日（火）23:59", "2026-03-10T23:59:00+09:00", false],
  ["締切語の次の行", "提出期限\n3月15日（日）正午", "2026-03-15T12:00:00+09:00", false],
  ["締切語の 2 行あと", "提出期限は下記のとおりです\n\n3月15日（日）", "2026-03-15", true],
  ["全角", "締切：３月１０日（火）２３：５９", "2026-03-10T23:59:00+09:00", false],
  ["西暦つき", "締切：2026年3月10日（火）23:59", "2026-03-10T23:59:00+09:00", false],
  ["受信日と同日の締切", "本日3月1日（日）23:59が締切です", "2026-03-01T23:59:00+09:00", false],
];

for (let i = 0; i < DEADLINE_CASES.length; i += 1) {
  const [name, text, at, allDay] = DEADLINE_CASES[i];
  test("締切: " + name, () => {
    const list = parseDeadlines(text, { base: BASE });
    assert.ok(list.length > 0, "締切が取れていない: " + text);
    assert.equal(list[0].at, at);
    assert.equal(list[0].allDay, allDay);
  });
}

test("締切: 締切語から離れた日時は締切にしない（FR-04）", () => {
  const text = "面接日時: 3月5日（木）14:00\n\n\n\nES提出締切：3月10日（火）23:59";
  const list = parseDeadlines(text, { base: BASE });
  assert.equal(list.length, 1);
  assert.equal(list[0].at, "2026-03-10T23:59:00+09:00");
});

test("締切: 締切語が無ければ空", () => {
  assert.deepEqual(parseDeadlines("日時：3月5日（木）14:00", { base: BASE }), []);
});

test("締切: 同じ日時は 1 件にまとめる", () => {
  const list = parseDeadlines("締切：3月10日（火）23:59\n提出期限：3月10日（火）23:59", { base: BASE });
  assert.equal(list.length, 1);
});

// --- 候補日（日程調整） -----------------------------------------------------
test("detectChoices: 第1〜第3希望を拾う", () => {
  const text = "下記の日程からご都合の良い日をお選びください。\n第1希望 3月5日（木）14:00\n第2希望 3月6日（金）10:00\n第3希望 3月9日（月）13:00\n返信期限：3月3日（火）まで";
  const got = detectChoices(text, { base: "2026-02-25T12:00:00+09:00" });
  assert.equal(got.choices.length, 3);
  assert.equal(got.choices[0], "2026-03-05T14:00:00+09:00");
  assert.equal(got.replyBy, "2026-03-03");
});

test("detectChoices: 返信期限は候補日に混ぜない", () => {
  const text = "候補日は以下のとおりです。\n3月5日（木）14:00\n3月6日（金）10:00\n締切：3月3日（火）";
  const got = detectChoices(text, { base: "2026-02-25T12:00:00+09:00" });
  assert.equal(got.choices.length, 2);
  assert.equal(got.replyBy, "2026-03-03");
});

test("detectChoices: 1 件だけなら null（単一の予定として扱う）", () => {
  const text = "ご都合はいかがでしょうか。\n3月5日（木）14:00";
  assert.equal(detectChoices(text, { base: BASE }), null);
});

test("detectChoices: 文脈語が無ければ null", () => {
  const text = "3月5日（木）14:00\n3月6日（金）10:00";
  assert.equal(detectChoices(text, { base: BASE }), null);
});

// --- 後置の AM／PM（重要 1） -------------------------------------------------
const MERIDIEM_CASES = [
  ["後置 PM（hh:mm）", "3月5日（木）2:00 PM", "2026-03-05T14:00:00+09:00"],
  ["後置 pm（小文字）", "3月5日（木）2:00 pm", "2026-03-05T14:00:00+09:00"],
  ["後置 p.m.", "3月5日（木）2:00 p.m.", "2026-03-05T14:00:00+09:00"],
  ["後置 AM", "3月5日（木）10:00 AM", "2026-03-05T10:00:00+09:00"],
  ["後置 AM（12時は 0 時）", "3月5日（木）12:00 AM", "2026-03-05T00:00:00+09:00"],
  ["前置 PM＋hh時", "3月5日（木）PM2時", "2026-03-05T14:00:00+09:00"],
  ["後置 PM＋hh時", "3月5日（木）2時 PM", "2026-03-05T14:00:00+09:00"],
  ["空白なしの後置", "3月5日（木）2:00PM", "2026-03-05T14:00:00+09:00"],
];

for (let i = 0; i < MERIDIEM_CASES.length; i += 1) {
  const [name, text, start] = MERIDIEM_CASES[i];
  test("日時（AM/PM）: " + name, () => {
    const got = firstDate(text);
    assert.ok(got, "日時が取れていない: " + text);
    assert.equal(got.start, start);
  });
}

test("日時（AM/PM）: 後置 PM の範囲も両方 12 時間ずらす", () => {
  const got = firstDate("3月5日（木）2:00 PM - 3:00 PM");
  assert.equal(got.start, "2026-03-05T14:00:00+09:00");
  assert.equal(got.end, "2026-03-05T15:00:00+09:00");
});

// --- 深夜表記（軽微 1） -----------------------------------------------------
test("日時: 25 時は翌日 1 時・確度は medium まで下げる", () => {
  const got = firstDate("3月5日（木）25時開始");
  assert.equal(got.start, "2026-03-06T01:00:00+09:00");
  assert.equal(got.confidence, "medium");
});

test("日時: 29 時までは翌日に倒す／30 時は時刻にしない", () => {
  assert.equal(firstDate("3月5日（木）29時").start, "2026-03-06T05:00:00+09:00");
  assert.equal(firstDate("3月5日（木）30時").start, "2026-03-05");
});

// --- ドット区切り（軽微 2） --------------------------------------------------
test("日時: 2026.3.5 のドット区切りを読む", () => {
  const got = firstDate("日時：2026.3.5 14:00〜15:00");
  assert.equal(got.start, "2026-03-05T14:00:00+09:00");
  assert.equal(got.end, "2026-03-05T15:00:00+09:00");
  assert.equal(got.confidence, "high");
});

test("日時: 2026.03.05 のゼロ埋めも読む", () => {
  assert.equal(firstDate("2026.03.05 10:00").start, "2026-03-05T10:00:00+09:00");
});

test("日時: 小数はドット日付にしない", () => {
  assert.deepEqual(parseDateTimes("達成率は98.7.5 ではありません", { base: BASE }), []);
});

// --- 1 行に時間帯が 2 つ（軽微 8） ------------------------------------------
test("日時: 1 行に時間帯が 2 つあれば 2 件にする", () => {
  const list = parseDateTimes("3月5日（木）10時〜12時、13時〜15時", { base: BASE });
  assert.equal(list.length, 2);
  assert.equal(list[0].start, "2026-03-05T10:00:00+09:00");
  assert.equal(list[0].end, "2026-03-05T12:00:00+09:00");
  assert.equal(list[1].start, "2026-03-05T13:00:00+09:00");
  assert.equal(list[1].end, "2026-03-05T15:00:00+09:00");
});

test("日時: 2 枠目は範囲になっているものだけ拾う（受付時刻を増やさない）", () => {
  const list = parseDateTimes("3月5日（木）14:00 受付開始 13:30", { base: BASE });
  assert.equal(list.length, 1);
  assert.equal(list[0].start, "2026-03-05T14:00:00+09:00");
});

// --- 日付の範囲（軽微 3 の軽い版） ------------------------------------------
test("日時: 日付の範囲は初日だけの 1 件にし、期間を note に残す", () => {
  const list = parseDateTimes("開催期間：3月5日（木）〜3月7日（土）の3日間", { base: BASE });
  assert.equal(list.length, 1);
  assert.equal(list[0].start, "2026-03-05");
  assert.equal(list[0].note, "期間: 3/5〜3/7（3日間）");
});

test("日時: 中黒で並んだ 2 件は範囲にしない", () => {
  const list = parseDateTimes("3月5日（木）・3月6日（金）", { base: BASE });
  assert.equal(list.length, 2);
  assert.equal(list[0].note, "");
});

// --- 日付が複数・時刻が 1 組（レビュー r2 R2-1） -----------------------------
test("日時: 並んだ日付に時刻が 1 組だけなら、その時刻を各日付へ配る（R2-1）", () => {
  const cases = [
    "3月5日（木）・3月6日（金）10:00〜12:00 に開催します",
    "3月5日（木）と3月6日（金）10:00〜12:00 に開催します",
    "3月5日（木）または3月6日（金）10:00〜12:00 に開催します",
    "3月5日（木）、3月6日（金）10:00〜12:00 に開催します",
    // 時刻が前の日付に付いている書き方も同じに読む
    "3月5日（木）10:00〜12:00・3月6日（金）",
  ];
  for (let i = 0; i < cases.length; i += 1) {
    const list = parseDateTimes(cases[i], { base: BASE });
    assert.equal(list.length, 2, cases[i]);
    assert.deepEqual(
      list.map((entry) => [entry.start, entry.end, entry.allDay]),
      [
        ["2026-03-05T10:00:00+09:00", "2026-03-05T12:00:00+09:00", false],
        ["2026-03-06T10:00:00+09:00", "2026-03-06T12:00:00+09:00", false],
      ],
      cases[i]
    );
  }
  // 3 つ並んでも全部に配る
  const three = parseDateTimes("3月5日（木）・3月6日（金）・3月7日（土）10:00〜12:00", { base: BASE });
  assert.deepEqual(three.map((entry) => entry.start), [
    "2026-03-05T10:00:00+09:00",
    "2026-03-06T10:00:00+09:00",
    "2026-03-07T10:00:00+09:00",
  ]);
});

test("日時: 配らない場合（時刻が 2 組・終日と書いてある・並びでない・期間）", () => {
  // 時刻がそれぞれの日付に付いている＝配る必要がない
  const both = parseDateTimes("【第1回】3月5日（木）10:00〜11:00 ／【第2回】3月6日（金）14:00〜15:00", { base: BASE });
  assert.deepEqual(both.map((entry) => [entry.start, entry.end]), [
    ["2026-03-05T10:00:00+09:00", "2026-03-05T11:00:00+09:00"],
    ["2026-03-06T14:00:00+09:00", "2026-03-06T15:00:00+09:00"],
  ]);
  // 「終日」と書いてある日付は終日のまま
  const allDay = parseDateTimes("3月5日（木）は終日、3月6日（金）10:00〜12:00 に開催します", { base: BASE });
  assert.equal(allDay[0].start, "2026-03-05");
  assert.equal(allDay[0].allDay, true);
  assert.equal(allDay[1].start, "2026-03-06T10:00:00+09:00");
  // 並びの語で繋がっていない（別の文）なら配らない＝締切の時刻を予定に移さない
  const other = parseDateTimes("説明会は3月5日（木）に開催します。ES提出は3月10日（火）10:00までにお願いします", {
    base: BASE,
  });
  assert.equal(other[0].start, "2026-03-05");
  assert.equal(other[0].allDay, true);
  // 期間（3/5〜3/7）は初日だけの 1 件のまま
  const range = parseDateTimes("3月5日（木）〜3月7日（土）10:00〜12:00 に開催します", { base: BASE });
  assert.equal(range.length, 1);
  assert.equal(range[0].start, "2026-03-05T10:00:00+09:00");
  assert.equal(range[0].note, "期間: 3/5〜3/7（3日間）");
});

// --- 過去日（軽微 5・6） ----------------------------------------------------
test("日時: 受信日より前の日付には isPast を付ける", () => {
  const got = firstDate("面接日：12月20日（土）14:00〜15:00", "2026-01-05T09:00:00+09:00");
  assert.equal(got.start, "2025-12-20T14:00:00+09:00");
  assert.equal(got.isPast, true);
  // 曜日一致だけで過去年を採ったので確度は medium 以下（軽微 5）
  assert.equal(got.confidence, "medium");
});

test("日時: 明示された年の過去日も isPast", () => {
  const got = firstDate("令和7年3月5日 14:00〜15:00");
  assert.equal(got.start, "2025-03-05T14:00:00+09:00");
  assert.equal(got.isPast, true);
  assert.equal(got.confidence, "high"); // 年が書いてあるので確度は下げない
});

test("日時: 未来の日付は isPast が false", () => {
  assert.equal(firstDate("3月5日（木）14:00").isPast, false);
  assert.equal(firstDate("3月1日（日）18:00").isPast, false); // 受信日と同日は過去にしない
});

// --- 締切語の判定（致命 1） -------------------------------------------------
test("締切: 「まで」は日時の直後だけ締切語にする", () => {
  assert.equal(hasDeadlineKeyword("3月10日までにご提出ください"), true);
  assert.equal(hasDeadlineKeyword("3月10日（火）17:00までにご返信ください"), true);
  assert.equal(hasDeadlineKeyword("これまでのご応募ありがとうございました"), false);
  assert.equal(hasDeadlineKeyword("今までにない規模の説明会です"), false);
  assert.equal(hasDeadlineKeyword("あくまで予定です"), false);
  assert.equal(hasDeadlineKeyword("いままでの選考を踏まえ"), false);
  assert.equal(hasDeadlineKeyword("最後まで諦めずに"), false);
  assert.equal(hasDeadlineKeyword("当日は開始5分前までにご入室ください"), false);
});

test("締切: 「これまで」は前後の日時を締切に化けさせない（致命 1）", () => {
  const text = "これまでのご応募ありがとうございました。\n次回の説明会は3月5日（木）14:00〜15:00 です。";
  assert.deepEqual(parseDeadlines(text, { base: BASE }), []);
  const list = parseDateTimes(text, { base: BASE });
  assert.equal(list.length, 1);
  assert.equal(list[0].start, "2026-03-05T14:00:00+09:00");
});

test("締切: 「あくまで予定です」でも面接日時は残る（致命 1）", () => {
  const text = "面接日時：3月5日（木）14:00〜15:00（あくまで予定です）";
  assert.deepEqual(parseDeadlines(text, { base: BASE }), []);
  assert.equal(parseDateTimes(text, { base: BASE })[0].start, "2026-03-05T14:00:00+09:00");
});

test("締切: 「14:00までにご来場」は開催日時なので締切にしない（REVIEW #27）", () => {
  const text = "説明会は3月5日（木）14:00までにご来場ください";
  assert.deepEqual(parseDeadlines(text, { base: BASE }), []);
  assert.equal(parseDateTimes(text, { base: BASE })[0].start, "2026-03-05T14:00:00+09:00");
});

test("締切: 締切語の位置を返す（まで は語の位置）", () => {
  const hits = deadlineKeywordsIn("3月10日までにご提出ください");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].word, "まで");
  assert.equal(hits[0].index, "3月10日".length);
});

// --- 締切語 1 つに締切 1 つ（致命 2） ---------------------------------------
test("締切: 同じ行に日時が 2 つあれば締切語にいちばん近いほうだけ（REVIEW #11）", () => {
  const list = parseDeadlines("書類締切 3/10、面接 3/15 14:00〜15:00 です。", { base: BASE });
  assert.equal(list.length, 1);
  assert.equal(list[0].at, "2026-03-10");
});

test("締切: 締切行に日時があれば次の行の面接日時は締切にしない（REVIEW #12）", () => {
  const list = parseDeadlines("3月10日（火）17時締切のご返信をお願いします\n3月12日（木）14:00〜15:00 面接", {
    base: BASE,
  });
  assert.equal(list.length, 1);
  assert.equal(list[0].at, "2026-03-10T17:00:00+09:00");
});

test("締切: ES 締切の次の行の面接日時を締切にしない（致命 2 の C）", () => {
  const list = parseDeadlines("ES提出締切：3月10日（火）23:59\n面接は3月20日（金）14:00 を予定しています。", {
    base: BASE,
  });
  assert.equal(list.length, 1);
  assert.equal(list[0].at, "2026-03-10T23:59:00+09:00");
});

test("締切: 締切語だけの行の次に面接日時があれば締切にしない", () => {
  const list = parseDeadlines("提出期限\n面接日時：3月20日（金）14:00", { base: BASE });
  assert.deepEqual(list, []);
});

test("締切: 1 行に締切語が 2 つあれば締切も 2 件（それぞれ最も近い日時）", () => {
  const list = parseDeadlines("ES締切 3/10、Webテスト期限 3/12", { base: BASE });
  assert.equal(list.length, 2);
  assert.equal(list[0].at, "2026-03-10");
  assert.equal(list[1].at, "2026-03-12");
});

// --- 相対表現の締切（軽微 7） -----------------------------------------------
const RELATIVE_CASES = [
  ["本日中", "本日中にご返信ください", "2026-03-01T23:59:00+09:00"],
  ["今日中", "今日中にご提出ください", "2026-03-01T23:59:00+09:00"],
  ["明日中", "〆切: 明日中にご提出ください", "2026-03-02T23:59:00+09:00"],
  ["明日まで", "明日までにご返信ください", "2026-03-02T23:59:00+09:00"],
  ["明後日", "明後日が提出の期限です", "2026-03-03T23:59:00+09:00"],
];

for (let i = 0; i < RELATIVE_CASES.length; i += 1) {
  const [name, text, at] = RELATIVE_CASES[i];
  test("締切（相対）: " + name, () => {
    const list = parseDeadlines(text, { base: BASE });
    assert.equal(list.length, 1, text);
    assert.equal(list[0].at, at);
    assert.equal(list[0].allDay, true);
  });
}

test("締切（相対）: 受信日が読めなければ相対表現は締切にしない", () => {
  assert.deepEqual(parseDeadlines("本日中にご返信ください", {}), []);
});

// --- 候補日の文脈語（重要 5・軽微 4） ---------------------------------------
test("detectChoices: or・または・もしくは・どちらかも文脈語にする（返信を求める語つき）", () => {
  const cases = [
    "3/5 or 3/6 のどちらかでお願いします",
    "3月5日（木）または3月6日（金）でご調整ください",
    "3月5日（木）もしくは3月6日（金）はいかがでしょうか",
  ];
  for (let i = 0; i < cases.length; i += 1) {
    const got = detectChoices(cases[i], { base: BASE });
    assert.ok(got, cases[i]);
    assert.equal(got.choices.length, 2, cases[i]);
  }
});

// --- レビュー r1 重要 4: 「または」は単独では候補日文脈にしない ----------------
test("detectChoices: 返信を求める語が無い「または」は候補日にしない（重要 4）", () => {
  const cases = [
    "3月5日（木）または3月6日（金）10:00〜12:00 に開催します。",
    "3月5日（木）もしくは3月6日（金）に実施します。",
    "3/5 or 3/6 に開催予定です。",
  ];
  for (let i = 0; i < cases.length; i += 1) {
    assert.equal(detectChoices(cases[i], { base: BASE }), null, cases[i]);
  }
});

test("detectChoices: 返信を求める語は前後 1 行まで見る（重要 4）", () => {
  const near =
    "面接日程のご希望をお知らせください。\n" + "3月5日（木）14:00 または 3月6日（金）14:00";
  const got = detectChoices(near, { base: BASE });
  assert.ok(got);
  assert.equal(got.choices.length, 2);
  // 3 行離れていれば候補日にしない（告知の「または」を巻き込まない）
  const far =
    "3月5日（木）14:00 または 3月6日（金）14:00 に開催します。\n\n\n" + "ご希望があればお知らせください。";
  assert.equal(detectChoices(far, { base: BASE }), null);
});

// --- 軽微 8: 時刻として無理な値 ---------------------------------------------
test("時刻に見えて読めない値（99:99・30時）は終日・確度 medium にする（軽微 8）", () => {
  const cases = ["3月5日（木）99:99", "3月5日（木）30時開始", "3月5日（木）12:99〜13:00"];
  for (let i = 0; i < cases.length; i += 1) {
    const got = parseDateTimes(cases[i], { base: BASE });
    assert.equal(got.length, 1, cases[i]);
    assert.equal(got[0].start, "2026-03-05", cases[i]);
    assert.equal(got[0].allDay, true, cases[i]);
    // 確度を下げないと「まとめて登録」（確度 高だけ）に入ってしまう
    assert.equal(got[0].confidence, "medium", cases[i]);
  }
  // 読める時刻なら確度は下がらない
  const ok = parseDateTimes("3月5日（木）10:00", { base: BASE });
  assert.equal(ok[0].confidence, "high");
});

// --- 軽微 6: base が無いときの年の推定 --------------------------------------
test("inferYear: base が無ければ「いま」を基準にする（2026 固定をやめた・軽微 6）", () => {
  const realNow = Date.now;
  try {
    // 2030-06-15 の JST 相当（Date.now() は UTC epoch なので 9 時間ぶん引いておく）
    Date.now = function () {
      return Date.UTC(2030, 5, 15, 3, 0, 0);
    };
    assert.equal(inferYear(3, 5, null, null), 2031); // 3/5 は過ぎている → 翌年
    assert.equal(inferYear(12, 20, null, null), 2030); // まだ来ていない → 同年
    assert.equal(inferYear(3, 5, "2026-03-01T10:00:00+09:00", null), 2026); // base があればそれが優先
  } finally {
    Date.now = realNow;
  }
});

// --- 変換・整形 -------------------------------------------------------------
test("toIso: 時刻あり・なし", () => {
  assert.equal(toIso(2026, 3, 5, 14, 0), "2026-03-05T14:00:00+09:00");
  assert.equal(toIso(2026, 3, 5), "2026-03-05");
});

test("weekdayOf: JST の壁時計で判定する", () => {
  assert.equal(weekdayOf("2026-03-05T14:00:00+09:00"), 4);
  assert.equal(weekdayOf("2026-03-05"), 4);
  assert.equal(weekdayOf("2026-03-05T00:30:00+09:00"), 4);
});

test("weekdayOf: 読めない文字列は -1", () => {
  assert.equal(weekdayOf("なにか"), -1);
});

test("addMinutes: 時刻つきは分を足す", () => {
  assert.equal(addMinutes("2026-03-05T14:00:00+09:00", 60), "2026-03-05T15:00:00+09:00");
  assert.equal(addMinutes("2026-03-05T23:30:00+09:00", 60), "2026-03-06T00:30:00+09:00");
});

test("addMinutes: 日付だけの文字列は日付のまま（1440 の倍数）", () => {
  assert.equal(addMinutes("2026-03-05", 1440), "2026-03-06");
});

test("addDays: 日付だけの文字列は日付のまま", () => {
  assert.equal(addDays("2026-03-05", 1), "2026-03-06");
  assert.equal(addDays("2026-02-28", 1), "2026-03-01");
});

test("formatJa: 時刻あり・なし", () => {
  assert.equal(formatJa("2026-03-05T14:00:00+09:00"), "3/5（木）14:00");
  assert.equal(formatJa("2026-03-05"), "3/5（木）");
});

test("formatMd / formatTimeJa", () => {
  assert.equal(formatMd("2026-03-05T14:00:00+09:00"), "3/5");
  assert.equal(formatTimeJa("2026-03-05T09:05:00+09:00"), "09:05");
  assert.equal(formatTimeJa("2026-03-05"), "");
});

test("toDateOnly / isValidYmd", () => {
  assert.equal(toDateOnly("2026-03-05T14:00:00+09:00"), "2026-03-05");
  assert.equal(toDateOnly(null), null);
  assert.equal(isValidYmd(2026, 2, 30), false);
  assert.equal(isValidYmd(2024, 2, 29), true);
  assert.equal(isValidYmd(2026, 2, 29), false);
});

test("UTC のオフセットつき入力も JST に直して読む", () => {
  assert.equal(weekdayOf("2026-03-05T23:00:00Z"), 5); // JST では 3/6（金）
  assert.equal(formatJa("2026-03-05T23:00:00Z"), "3/6（金）08:00");
});

// --- TZ 非依存（K-8） --------------------------------------------------------
test("K-8: TZ を変えても抽出結果が 1 バイトも変わらない", () => {
  const probe = fileURLToPath(new URL("./helpers/tz-probe.mjs", import.meta.url));
  const run = (tz) => {
    const env = {};
    const names = Object.keys(process.env);
    for (let i = 0; i < names.length; i += 1) env[names[i]] = process.env[names[i]];
    env.TZ = tz;
    return execFileSync(process.execPath, [probe], { env: env, encoding: "utf8" });
  };
  const utc = run("UTC");
  assert.equal(run("Asia/Tokyo"), utc);
  assert.equal(run("America/New_York"), utc);
  assert.equal(run("Pacific/Kiritimati"), utc);
});
