/**
 * events.test.mjs — 候補 → 予定の計画（FR-09）
 * 「締切は終日＋前日通知」「終了が無ければ既定 60 分」「本文を説明に入れない」を固定する。
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  CONFIDENCE_LABELS,
  DEFAULT_COMPANY_LABEL,
  buildEventPlan,
  calendarDayUrl,
  clampReminders,
  descriptionFor,
  gmailMessageUrl,
  titleFor,
} from "../../src/core/events.js";
import { SETTINGS_DEFAULTS } from "../../src/core/settings.js";

function candidate(extra) {
  const base = {
    id: "c_m0001_1",
    messageId: "m0001",
    threadId: "t0001",
    receivedAt: "2026-03-01T10:12:00+09:00",
    company: "株式会社サンプル商事",
    media: "direct",
    kind: "interview",
    stage: "1次",
    title: "",
    start: "2026-03-05T14:00:00+09:00",
    end: "2026-03-05T15:00:00+09:00",
    allDay: false,
    deadline: null,
    choices: [],
    location: "本社 3F 会議室",
    url: null,
    subject: "【1次面接のご案内】",
    from: "株式会社サンプル商事 <recruit@a.example.jp>",
    confidence: "high",
    reasons: [],
    status: "候補",
    eventId: null,
    registeredAt: null,
    note: "",
  };
  const names = Object.keys(extra || {});
  for (let i = 0; i < names.length; i += 1) base[names[i]] = extra[names[i]];
  return base;
}

// --- タイトル ---------------------------------------------------------------
const TITLE_CASES = [
  ["面接（段階つき）", {}, "【面接】株式会社サンプル商事 1次面接"],
  ["面接（最終）", { stage: "最終" }, "【面接】株式会社サンプル商事 最終面接"],
  ["面接（カジュアル）", { stage: "カジュアル" }, "【面接】株式会社サンプル商事 カジュアル面談"],
  ["面接（段階なし）", { stage: null }, "【面接】株式会社サンプル商事"],
  ["説明会", { kind: "seminar", stage: null }, "【説明会】株式会社サンプル商事"],
  [
    "ES 締切",
    { kind: "es_deadline", stage: null, start: null, end: null, deadline: "2026-03-10T23:59:00+09:00" },
    "【締切 23:59】株式会社サンプル商事 ES提出",
  ],
  [
    "ES 締切（時刻なしは 23:59 とみなす）",
    { kind: "es_deadline", stage: null, start: null, end: null, deadline: "2026-03-10" },
    "【締切 23:59】株式会社サンプル商事 ES提出",
  ],
  [
    "Web テスト締切",
    { kind: "test_deadline", stage: null, start: null, end: null, deadline: "2026-03-08T12:00:00+09:00" },
    "【締切 12:00】株式会社サンプル商事 Webテスト",
  ],
  [
    "日程調整（候補日つき）",
    {
      kind: "schedule_request",
      stage: null,
      start: null,
      end: null,
      deadline: "2026-03-03",
      choices: ["2026-03-05T14:00:00+09:00", "2026-03-06T10:00:00+09:00"],
    },
    "【要返信】株式会社サンプル商事 日程選択（候補: 3/5・3/6）",
  ],
  [
    "日程調整（候補日なし）",
    { kind: "schedule_request", stage: null, start: null, end: null, deadline: "2026-03-03", choices: [] },
    "【要返信】株式会社サンプル商事 日程選択",
  ],
  ["変更（面接）", { kind: "change", stage: null, subject: "【日時変更】2次面接" }, "【変更】株式会社サンプル商事 面接"],
  ["変更（説明会）", { kind: "change", stage: null, subject: "【中止のお知らせ】会社説明会" }, "【変更】株式会社サンプル商事 説明会"],
  ["企業名なし", { company: null, stage: null }, "【面接】" + DEFAULT_COMPANY_LABEL],
];

for (let i = 0; i < TITLE_CASES.length; i += 1) {
  const [name, extra, expected] = TITLE_CASES[i];
  test("タイトル: " + name, () => {
    assert.equal(titleFor(candidate(extra)), expected);
  });
}

test("タイトル: 候補日が 4 件以上なら 3 件＋ほか", () => {
  const title = titleFor(
    candidate({
      kind: "schedule_request",
      stage: null,
      start: null,
      choices: ["2026-03-05", "2026-03-06", "2026-03-09", "2026-03-10"],
    })
  );
  assert.equal(title, "【要返信】株式会社サンプル商事 日程選択（候補: 3/5・3/6・3/9ほか）");
});

// --- 説明 -------------------------------------------------------------------
test("説明: 件名・Gmail リンク・候補 ID・出所が入る", () => {
  const text = descriptionFor(candidate({}));
  assert.ok(text.indexOf("件名: 【1次面接のご案内】") >= 0);
  assert.ok(text.indexOf("Gmail: https://mail.google.com/mail/u/0/#all/m0001") >= 0);
  assert.ok(text.indexOf("候補ID: c_m0001_1") >= 0);
  assert.ok(text.indexOf("選考カレンダーで登録") >= 0);
});

test("NFR-02: 説明に本文は入らない", () => {
  const c = candidate({});
  c.body = "本文をうっかり持たせても";
  const text = descriptionFor(c);
  assert.ok(text.indexOf("本文をうっかり") < 0);
});

test("説明: 候補日は人が読む形で並べる", () => {
  const text = descriptionFor(
    candidate({ kind: "schedule_request", start: null, choices: ["2026-03-05T14:00:00+09:00", "2026-03-06"] })
  );
  assert.ok(text.indexOf("候補日: 3/5（木）14:00・3/6（金）") >= 0);
});

// --- 予定の計画 -------------------------------------------------------------
test("時刻つき予定: そのまま入る", () => {
  const plan = buildEventPlan(candidate({}), SETTINGS_DEFAULTS);
  assert.equal(plan.type, "timed");
  assert.equal(plan.start, "2026-03-05T14:00:00+09:00");
  assert.equal(plan.end, "2026-03-05T15:00:00+09:00");
  assert.equal(plan.date, null);
  assert.equal(plan.location, "本社 3F 会議室");
  assert.deepEqual(plan.reminders, [60, 1440]);
});

test("時刻つき予定: 終了が無ければ既定の 60 分", () => {
  const plan = buildEventPlan(candidate({ end: null }), SETTINGS_DEFAULTS);
  assert.equal(plan.end, "2026-03-05T15:00:00+09:00");
});

test("時刻つき予定: 既定の長さは設定で変えられる", () => {
  const settings = Object.assign({}, SETTINGS_DEFAULTS, { defaultEventMinutes: 90 });
  const plan = buildEventPlan(candidate({ end: null }), settings);
  assert.equal(plan.end, "2026-03-05T15:30:00+09:00");
});

test("締切: 終日予定になり通知は 900 分前だけ（US-3）", () => {
  const plan = buildEventPlan(
    candidate({ kind: "es_deadline", stage: null, start: null, end: null, deadline: "2026-03-10T23:59:00+09:00" }),
    SETTINGS_DEFAULTS
  );
  assert.equal(plan.type, "allDay");
  assert.equal(plan.date, "2026-03-10");
  assert.equal(plan.start, null);
  assert.deepEqual(plan.reminders, [900]);
});

test("日程調整: 返信期限の日の終日予定になる", () => {
  const plan = buildEventPlan(
    candidate({ kind: "schedule_request", stage: null, start: null, end: null, deadline: "2026-03-03" }),
    SETTINGS_DEFAULTS
  );
  assert.equal(plan.type, "allDay");
  assert.equal(plan.date, "2026-03-03");
});

test("日程調整: 返信期限が無ければ受信の翌日", () => {
  const plan = buildEventPlan(
    candidate({ kind: "schedule_request", stage: null, start: null, end: null, deadline: null }),
    SETTINGS_DEFAULTS
  );
  assert.equal(plan.date, "2026-03-02");
});

test("終日の説明会は終日予定になる", () => {
  const plan = buildEventPlan(
    candidate({ kind: "seminar", stage: null, start: "2026-03-05", end: null, allDay: true }),
    SETTINGS_DEFAULTS
  );
  assert.equal(plan.type, "allDay");
  assert.equal(plan.date, "2026-03-05");
});

test("日付がまったく無い候補は invalid（画面で編集してもらう）", () => {
  const plan = buildEventPlan(candidate({ start: null, end: null, deadline: null }), SETTINGS_DEFAULTS);
  assert.equal(plan.type, "invalid");
  assert.ok(plan.reason.length > 0);
});

test("設定を渡さなくても既定で動く", () => {
  const plan = buildEventPlan(candidate({}));
  assert.equal(plan.type, "timed");
  assert.deepEqual(plan.reminders, [60, 1440]);
});

// --- 通知の丸め -------------------------------------------------------------
test("通知: 5〜40320 に丸める", () => {
  assert.deepEqual(clampReminders([0, 3, 60]), [5, 5, 60].slice(1)); // 0 と 3 は 5 に丸まり重複が消える
  assert.deepEqual(clampReminders([99999]), [40320]);
  assert.deepEqual(clampReminders([60, 60, 1440]), [60, 1440]);
  assert.deepEqual(clampReminders("60,1440"), [60, 1440]);
  assert.deepEqual(clampReminders([]), []);
});

test("通知: 設定の値が壊れていても予定は作れる", () => {
  const settings = Object.assign({}, SETTINGS_DEFAULTS, { eventReminderMinutes: "abc", deadlineReminderMinutes: -1 });
  const plan = buildEventPlan(candidate({}), settings);
  assert.deepEqual(plan.reminders, [60, 1440]);
});

// --- URL --------------------------------------------------------------------
test("calendarDayUrl: ゼロ埋めしない日付で組む", () => {
  assert.equal(calendarDayUrl("2026-03-05T14:00:00+09:00"), "https://calendar.google.com/calendar/u/0/r/day/2026/3/5");
  assert.equal(calendarDayUrl("2026-12-20"), "https://calendar.google.com/calendar/u/0/r/day/2026/12/20");
});

test("gmailMessageUrl: messageId から組む", () => {
  assert.equal(gmailMessageUrl("m0001"), "https://mail.google.com/mail/u/0/#all/m0001");
  assert.equal(gmailMessageUrl(null), "");
});

test("確度は色ではなく文言で示す（NFR-06）", () => {
  assert.deepEqual(CONFIDENCE_LABELS, { high: "高", medium: "中", low: "低" });
});

// --- 重要 7: 開始が無く締切だけの説明会・面接 -------------------------------
test("開始が無く締切だけの説明会は「申込締切」のタイトルにする（重要 7）", () => {
  const plan = buildEventPlan(
    candidate({ kind: "seminar", stage: null, start: null, end: null, deadline: "2026-03-10T23:59:00+09:00" })
  );
  assert.equal(plan.type, "allDay");
  assert.equal(plan.date, "2026-03-10");
  assert.equal(plan.title, "【申込締切 23:59】株式会社サンプル商事 説明会");
});

test("締切に時刻が無ければ「【申込締切】」（時刻を書かない・重要 7）", () => {
  const plan = buildEventPlan(
    candidate({ kind: "seminar", stage: null, start: null, end: null, deadline: "2026-03-10" })
  );
  assert.equal(plan.title, "【申込締切】株式会社サンプル商事 説明会");
});

test("開始が無く締切だけの面接も「申込締切」にする（重要 7）", () => {
  const plan = buildEventPlan(
    candidate({ kind: "interview", stage: "1次", start: null, end: null, deadline: "2026-03-10T17:00:00+09:00" })
  );
  assert.equal(plan.title, "【申込締切 17:00】株式会社サンプル商事 1次面接");
});

test("開始も締切も無ければ invalid（重要 7）", () => {
  const plan = buildEventPlan(candidate({ kind: "seminar", stage: null, start: null, end: null, deadline: null }));
  assert.equal(plan.type, "invalid");
  assert.ok(plan.reason.length > 0);
});

test("開始があれば「【説明会】」のまま（重要 7 で変わらない側）", () => {
  const plan = buildEventPlan(
    candidate({
      kind: "seminar",
      stage: null,
      start: "2026-03-05T10:00:00+09:00",
      end: null,
      deadline: "2026-03-01T23:59:00+09:00",
    })
  );
  assert.equal(plan.title, "【説明会】株式会社サンプル商事");
});

// --- 重要 8: 終了 <= 開始 ---------------------------------------------------
test("終了が開始より前なら既定の長さに倒す（重要 8）", () => {
  const plan = buildEventPlan(
    candidate({ start: "2026-03-05T14:00:00+09:00", end: "2026-03-05T13:00:00+09:00" })
  );
  assert.equal(plan.start, "2026-03-05T14:00:00+09:00");
  assert.equal(plan.end, "2026-03-05T15:00:00+09:00");
});

test("終了が開始と同じでも既定の長さに倒す（重要 8）", () => {
  const plan = buildEventPlan(
    candidate({ start: "2026-03-05T14:00:00+09:00", end: "2026-03-05T14:00:00+09:00" })
  );
  assert.equal(plan.end, "2026-03-05T15:00:00+09:00");
});

test("終了が開始より前のときも設定の既定長さを使う（重要 8）", () => {
  const settings = { defaultEventMinutes: 30 };
  const plan = buildEventPlan(
    candidate({ start: "2026-03-05T14:00:00+09:00", end: "2026-03-05T09:00:00+09:00" }),
    settings
  );
  assert.equal(plan.end, "2026-03-05T14:30:00+09:00");
});

// --- 軽微 15: タイトルの長さ ------------------------------------------------
test("titleFor は 200 字で切る（軽微 15）", () => {
  const long = titleFor(candidate({ company: new Array(400).join("あ") }));
  assert.equal(long.length, 200);
  assert.equal(long.slice(-1), "…");
});

test("titleFor は 200 字以内なら切らない", () => {
  const short = titleFor(candidate({}));
  assert.equal(short, "【面接】株式会社サンプル商事 1次面接");
});
