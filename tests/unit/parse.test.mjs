/**
 * parse.test.mjs — 合成 fixture 41 通が期待値と全件一致すること（NFR-04）と、
 * 1 通あたりの解析が 5ms 以内であること（NFR-03。50 通 × 5ms = 0.25 秒で GAS の 6 分に余裕）。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { candidateKey, newCandidateId, parseMail, parseMailWithMeta } from "../../src/core/parse.js";

const mailsDir = fileURLToPath(new URL("../fixtures/mails/", import.meta.url));
const expectedDir = fileURLToPath(new URL("../fixtures/expected/", import.meta.url));
const names = fs.readdirSync(mailsDir).sort();
const COMPARED_KEYS = [
  "id",
  "kind",
  "stage",
  "company",
  "media",
  "start",
  "end",
  "allDay",
  "deadline",
  "choices",
  "location",
  "url",
  "confidence",
];

function readMail(name) {
  return JSON.parse(fs.readFileSync(mailsDir + name, "utf8"));
}

test("fixture は 30 通以上ある（docs/03 §7）", () => {
  assert.ok(names.length >= 30, "fixture が " + names.length + " 通しかない");
});

for (let i = 0; i < names.length; i += 1) {
  const name = names[i];
  test("fixture " + name + " が期待値と一致する", () => {
    const mail = readMail(name);
    const expected = JSON.parse(fs.readFileSync(expectedDir + name, "utf8"));
    const meta = parseMailWithMeta(mail);
    assert.equal(meta.isNoise, expected.isNoise, "isNoise");
    assert.equal(meta.kind, expected.kind, "kind");
    assert.equal(meta.stage, expected.stage, "stage");
    assert.equal(meta.candidates.length, expected.candidates.length, "候補の数");
    for (let j = 0; j < expected.candidates.length; j += 1) {
      const got = meta.candidates[j];
      const want = expected.candidates[j];
      for (let k = 0; k < COMPARED_KEYS.length; k += 1) {
        const key = COMPARED_KEYS[k];
        assert.deepEqual(got[key], want[key], name + " の候補 " + (j + 1) + " の " + key);
      }
    }
  });
}

test("NFR-03: 1 通あたりの parseMail が 5ms 以内", () => {
  const mails = names.map(readMail);
  // 1 周目はウォームアップ（正規表現のコンパイル）
  for (let i = 0; i < mails.length; i += 1) parseMail(mails[i]);
  const started = Date.now();
  const rounds = 5;
  for (let r = 0; r < rounds; r += 1) {
    for (let i = 0; i < mails.length; i += 1) parseMail(mails[i]);
  }
  const perMail = (Date.now() - started) / (rounds * mails.length);
  assert.ok(perMail < 5, "1 通あたり " + perMail.toFixed(2) + "ms かかっている");
});

test("K-2: parseMail はカレンダーにも Gmail にも触れない（純関数）", () => {
  const mail = readMail("01.json");
  const before = JSON.stringify(mail);
  parseMail(mail);
  assert.equal(JSON.stringify(mail), before, "入力を書き換えている");
});

test("NFR-02: 候補に本文を入れない", () => {
  const mail = readMail("01.json");
  const candidates = parseMail(mail);
  const serialized = JSON.stringify(candidates);
  assert.ok(serialized.indexOf("持ち物") < 0, "本文が候補に入っている");
  assert.ok(serialized.indexOf("筆記用具") < 0, "本文が候補に入っている");
});

test("候補は台帳の 24 列＋計算で出す isPast だけを持つ", () => {
  const candidate = parseMail(readMail("01.json"))[0];
  // isPast は台帳に列を持たない（開始・締切と受信日時から毎回計算する。軽微 5・6）
  assert.equal(typeof candidate.isPast, "boolean");
  const stored = Object.keys(candidate).filter((name) => name !== "isPast");
  assert.deepEqual(stored.sort(), [
    "allDay",
    "choices",
    "company",
    "confidence",
    "deadline",
    "end",
    "eventId",
    "from",
    "id",
    "kind",
    "location",
    "media",
    "messageId",
    "note",
    "reasons",
    "receivedAt",
    "registeredAt",
    "stage",
    "start",
    "status",
    "subject",
    "threadId",
    "title",
    "url",
  ]);
});

test("候補には根拠（reasons）が入る", () => {
  const candidate = parseMail(readMail("01.json"))[0];
  assert.ok(candidate.reasons.length > 0);
  assert.ok(candidate.reasons.join("").indexOf("日時") >= 0);
});

test("状態の初期値は「候補」", () => {
  const candidate = parseMail(readMail("01.json"))[0];
  assert.equal(candidate.status, "候補");
});

test("newCandidateId: c_<messageId>_<n>", () => {
  assert.equal(newCandidateId("m0001", 1), "c_m0001_1");
  assert.equal(newCandidateId("m0001", 2), "c_m0001_2");
  assert.equal(newCandidateId(null, 1), "c_unknown_1");
});

test("candidateKey: 企業・種別・開始・締切で決まる", () => {
  const a = { company: "株式会社サンプル商事", kind: "interview", start: "2026-03-05T14:00:00+09:00", deadline: null };
  const b = { company: "株式会社サンプル商事", kind: "interview", start: "2026-03-05T14:00:00+09:00", deadline: null };
  const c = { company: "株式会社サンプル商事", kind: "interview", start: "2026-03-06T14:00:00+09:00", deadline: null };
  assert.equal(candidateKey(a), candidateKey(b));
  assert.notEqual(candidateKey(a), candidateKey(c));
});

test("candidateKey: 企業名の空白差は同じ鍵にする", () => {
  const a = { company: "株式会社 サンプル商事", kind: "seminar", start: "2026-03-05", deadline: null };
  const b = { company: "株式会社サンプル商事", kind: "seminar", start: "2026-03-05", deadline: null };
  assert.equal(candidateKey(a), candidateKey(b));
});

test("ノイズと合否は候補を作らない（状態だけ残す）", () => {
  assert.deepEqual(parseMail(readMail("07.json")), []);
  assert.deepEqual(parseMail(readMail("14.json")), []);
  assert.equal(parseMailWithMeta(readMail("07.json")).isNoise, true);
  assert.equal(parseMailWithMeta(readMail("14.json")).kind, "result");
});

test("日時が取れない説明会・面接も低確度で残す（見落とし防止）", () => {
  const candidates = parseMail(readMail("17.json"));
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].start, null);
  assert.equal(candidates[0].confidence, "low");
});

test("申込締切は説明会の候補に付き、別候補にはしない", () => {
  const candidates = parseMail(readMail("33.json"));
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].kind, "seminar");
  assert.equal(candidates[0].deadline, "2026-03-23T17:00:00+09:00");
});

test("説明会に混ざった ES 締切は別候補として立てる", () => {
  const candidates = parseMail(readMail("28.json"));
  assert.equal(candidates.length, 2);
  assert.equal(candidates[0].kind, "seminar");
  assert.equal(candidates[1].kind, "es_deadline");
  assert.equal(candidates[1].deadline, "2026-03-31T23:59:00+09:00");
});

test("日程調整は候補日をまとめて 1 件にする（予定にしない）", () => {
  const candidates = parseMail(readMail("12.json"));
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].start, null);
  assert.equal(candidates[0].choices.length, 3);
  assert.equal(candidates[0].deadline, "2026-03-03");
});

test("複数の開催日は日時ごとに候補を作る", () => {
  const candidates = parseMail(readMail("36.json"));
  assert.equal(candidates.length, 2);
  assert.equal(candidates[0].id, "c_m0036_1");
  assert.equal(candidates[1].id, "c_m0036_2");
});

test("同じ日時が本文に 2 回出てきても候補は 1 件", () => {
  const candidates = parseMail({
    id: "dup1",
    threadId: "dup1",
    from: "株式会社サンプル商事 採用担当 <recruit@a.example.jp>",
    subject: "【1次面接のご案内】",
    date: "2026-03-01T10:00:00+09:00",
    body: "日時：3月5日（木）14:00〜15:00\n\n再掲：3月5日（木）14:00〜15:00にお越しください。",
  });
  assert.equal(candidates.length, 1);
});

test("受信日時は +09:00 の ISO に揃える", () => {
  const candidates = parseMail({
    id: "tz1",
    threadId: "tz1",
    from: "株式会社サンプル商事 <recruit@a.example.jp>",
    subject: "【1次面接のご案内】",
    date: "2026-03-01T01:00:00Z",
    body: "日時：3月5日（木）14:00〜15:00",
  });
  assert.equal(candidates[0].receivedAt, "2026-03-01T10:00:00+09:00");
});

test("空のメールでも落ちない", () => {
  assert.deepEqual(parseMail({}), []);
  assert.deepEqual(parseMail(null), []);
});

// --- 重要 2: 日時が取れない候補は messageId で区別する ----------------------
test("candidateKey: 開始も締切も無い候補は messageId を混ぜる（重要 2）", () => {
  const a = { company: "株式会社サンプル商事", kind: "seminar", start: null, deadline: null, messageId: "m1" };
  const b = { company: "株式会社サンプル商事", kind: "seminar", start: null, deadline: null, messageId: "m2" };
  assert.notEqual(candidateKey(a), candidateKey(b));
  assert.ok(candidateKey(a).indexOf("m1") >= 0);
});

test("candidateKey: 日時があるなら messageId は混ぜない（同じ予定は 1 件に）", () => {
  const a = { company: "A", kind: "interview", start: "2026-03-05T14:00:00+09:00", deadline: null, messageId: "m1" };
  const b = { company: "A", kind: "interview", start: "2026-03-05T14:00:00+09:00", deadline: null, messageId: "m2" };
  assert.equal(candidateKey(a), candidateKey(b));
});

test("candidateKey: 締切だけの候補も messageId を混ぜない", () => {
  const a = { company: "A", kind: "es_deadline", start: null, deadline: "2026-03-10", messageId: "m1" };
  const b = { company: "A", kind: "es_deadline", start: null, deadline: "2026-03-10", messageId: "m2" };
  assert.equal(candidateKey(a), candidateKey(b));
});

test("日時が読めない候補は、別のメールから来ても重複にならない（重要 2）", () => {
  const first = parseMail({
    id: "n1",
    threadId: "n1",
    from: "株式会社サンプル商事 <recruit@a.example.jp>",
    subject: "会社説明会のご案内",
    date: "2026-03-01T10:00:00+09:00",
    body: "会社説明会を実施します。\n日程は追ってご連絡します。",
  });
  const second = parseMail({
    id: "n2",
    threadId: "n2",
    from: "株式会社サンプル商事 <recruit@a.example.jp>",
    subject: "第2回 会社説明会のご案内",
    date: "2026-03-02T10:00:00+09:00",
    body: "第2回の会社説明会を実施します。\n詳細は追ってご連絡します。",
  });
  assert.equal(first.length, 1);
  assert.equal(second.length, 1);
  assert.notEqual(candidateKey(first[0]), candidateKey(second[0]));
});

// --- 重要 3: 合否の連絡が次回面接を兼ねる ----------------------------------
test("result でも本文に面接語と未来の日時があれば interview 候補を 1 件立てる（重要 3）", () => {
  const meta = parseMailWithMeta(readMail("37.json"));
  assert.equal(meta.kind, "result");
  assert.equal(meta.candidates.length, 1);
  assert.equal(meta.candidates[0].kind, "interview");
  assert.equal(meta.candidates[0].stage, "2次");
  assert.equal(meta.candidates[0].start, "2026-03-12T14:00:00+09:00");
});

test("result で面接語が無ければ候補は作らない（お祈り・内定通知）", () => {
  const meta = parseMailWithMeta(readMail("14.json"));
  assert.equal(meta.kind, "result");
  assert.deepEqual(meta.candidates, []);
});

test("result で日時が過去だけなら候補は作らない", () => {
  const meta = parseMailWithMeta({
    id: "r2",
    threadId: "r2",
    from: "株式会社サンプル商事 <recruit@a.example.jp>",
    subject: "選考結果のご連絡",
    date: "2026-03-10T10:00:00+09:00",
    body: "3月5日（木）14:00 の面接にご参加いただきありがとうございました。\n結果は残念ながら見送りとなりました。",
  });
  assert.equal(meta.kind, "result");
  assert.deepEqual(meta.candidates, []);
});

// --- 重要 4: ノイズ確定は 3 条件 --------------------------------------------
test("件名がスカウト返信でも、本文に面談日時があればノイズにしない（重要 4）", () => {
  const meta = parseMailWithMeta(readMail("38.json"));
  assert.equal(meta.isNoise, false);
  assert.equal(meta.kind, "interview");
  assert.equal(meta.candidates.length, 1);
  assert.equal(meta.candidates[0].start, "2026-03-12T14:00:00+09:00");
});

test("件名がノイズ語で本文に種別も日時も無ければノイズ（重要 4 の 3 条件）", () => {
  const meta = parseMailWithMeta(readMail("07.json"));
  assert.equal(meta.isNoise, true);
  assert.deepEqual(meta.candidates, []);
});

// --- 重要 5: 候補日は種別を問わず 1 件に束ねる -----------------------------
test("件名が面接でも本文が候補日の並びなら 1 候補にまとめる（重要 5）", () => {
  const meta = parseMailWithMeta(readMail("39.json"));
  assert.equal(meta.kind, "interview");
  assert.equal(meta.candidates.length, 1);
  assert.equal(meta.candidates[0].kind, "schedule_request");
  assert.equal(meta.candidates[0].choices.length, 3);
  assert.equal(meta.candidates[0].deadline, "2026-03-04");
});

test("説明会の複数日程も「または」で並べば 1 候補にまとめる（重要 5）", () => {
  const candidates = parseMail({
    id: "sc1",
    threadId: "sc1",
    from: "株式会社サンプル商事 <recruit@a.example.jp>",
    subject: "会社説明会のご案内",
    date: "2026-03-01T10:00:00+09:00",
    body: "3月5日（木）10:00 または 3月6日（金）10:00 のいずれかにご参加ください。",
  });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].kind, "schedule_request");
  assert.equal(candidates[0].choices.length, 2);
});

test("候補日が 1 件だけなら束ねずに通常の予定にする", () => {
  const candidates = parseMail({
    id: "sc2",
    threadId: "sc2",
    from: "株式会社サンプル商事 <recruit@a.example.jp>",
    subject: "面接のご案内",
    date: "2026-03-01T10:00:00+09:00",
    body: "ご都合はいかがでしょうか。\n3月5日（木）14:00〜15:00",
  });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].kind, "interview");
  assert.equal(candidates[0].start, "2026-03-05T14:00:00+09:00");
});

// --- 軽微 5・6: 過去日の印 --------------------------------------------------
test("候補に isPast が付く（受信日より前の日付）", () => {
  const candidates = parseMail({
    id: "p1",
    threadId: "p1",
    from: "株式会社サンプル商事 <recruit@a.example.jp>",
    subject: "面接のご案内",
    date: "2026-01-05T09:00:00+09:00",
    body: "面接日：12月20日（土）14:00〜15:00",
  });
  assert.equal(candidates[0].start, "2025-12-20T14:00:00+09:00");
  assert.equal(candidates[0].isPast, true);
  assert.equal(candidates[0].confidence, "medium");
});

test("候補の isPast は締切からも見る", () => {
  const candidates = parseMail({
    id: "p2",
    threadId: "p2",
    from: "株式会社サンプル商事 <recruit@a.example.jp>",
    subject: "エントリーシート提出のお願い",
    date: "2026-03-15T09:00:00+09:00",
    body: "提出締切：2026年3月10日（火）23:59",
  });
  assert.equal(candidates[0].deadline, "2026-03-10T23:59:00+09:00");
  assert.equal(candidates[0].isPast, true);
});

test("未来の候補は isPast が false", () => {
  const candidates = parseMail(readMail("01.json"));
  assert.equal(candidates[0].isPast, false);
});

// --- 軽微 3 の軽い版: 複数日の期間は note に残す ----------------------------
test("複数日のインターンは初日 1 件＋note に期間", () => {
  const candidates = parseMail({
    id: "range1",
    threadId: "range1",
    from: "株式会社サンプル商事 <recruit@a.example.jp>",
    subject: "インターンシップのご案内",
    date: "2026-03-01T10:00:00+09:00",
    body: "開催期間：3月5日（木）〜3月7日（土）の3日間",
  });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].start, "2026-03-05");
  assert.equal(candidates[0].note, "期間: 3/5〜3/7（3日間）");
});

// --- 致命 1・2 を parseMail の高さでも押さえる ------------------------------
/** 送信者と件名を固定して本文だけ変える */
function mailWith(body, subject) {
  return {
    id: "fatal",
    threadId: "fatal",
    from: "株式会社サンプル商事 採用担当 <recruit@a.example.jp>",
    subject: subject || "面接のご案内",
    date: "2026-03-01T10:12:00+09:00",
    body: body,
  };
}

test("致命 1: 「これまで」があっても面接日時が候補に残る", () => {
  const candidates = parseMail(mailWith("これまでの選考を踏まえ、面接を 3月5日（木）14:00 に実施します。"));
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].kind, "interview");
  assert.equal(candidates[0].start, "2026-03-05T14:00:00+09:00");
  assert.equal(candidates[0].deadline, null);
});

test("致命 1: 「あくまで予定です」でも 14:00 が消えない", () => {
  const candidates = parseMail(mailWith("面接日時：3月5日（木）14:00〜15:00（あくまで予定です）"));
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].start, "2026-03-05T14:00:00+09:00");
  assert.equal(candidates[0].end, "2026-03-05T15:00:00+09:00");
  assert.equal(candidates[0].deadline, null);
});

test("致命 2: 「締切 3/10、面接 3/15」は面接 3/15 の候補に締切 3/10 が付く", () => {
  const candidates = parseMail(mailWith("締切 3/10、面接 3/15"));
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].kind, "interview");
  assert.equal(candidates[0].start, "2026-03-15");
  assert.equal(candidates[0].deadline, "2026-03-10");
});

test("致命 2: ES 締切の次の行の面接日時は締切にしない（es_deadline は 3/10 だけ）", () => {
  const candidates = parseMail(
    mailWith("ES提出締切：3月10日（火）23:59\n面接は3月20日（金）14:00 を予定しています。", "エントリーシート提出のお願い")
  );
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].kind, "es_deadline");
  assert.equal(candidates[0].deadline, "2026-03-10T23:59:00+09:00");
});

test("致命 2: 締切行の次の行の面接日時は予定として残る", () => {
  const candidates = parseMail(mailWith("3月10日（火）17時締切のご返信をお願いします\n3月12日（木）14:00〜15:00 面接"));
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].start, "2026-03-12T14:00:00+09:00");
  assert.equal(candidates[0].deadline, "2026-03-10T17:00:00+09:00");
});

test("REVIEW #27: 「14:00までにご来場」は説明会の開催日時として残る", () => {
  const candidates = parseMail(
    mailWith("説明会は3月5日（木）14:00までにご来場ください", "会社説明会のご案内")
  );
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].kind, "seminar");
  assert.equal(candidates[0].start, "2026-03-05T14:00:00+09:00");
  assert.equal(candidates[0].deadline, null);
});

// --- レビュー r1 重要 4: 「または」の 2 日開催は予定にする ---------------------
test("「または」の 2 日開催は【要返信】に化けない（重要 4）", () => {
  const candidates = parseMail({
    id: "sc9",
    threadId: "sc9",
    from: "株式会社サンプル商事 <recruit@a.example.jp>",
    subject: "会社説明会のご案内",
    date: "2026-03-01T10:00:00+09:00",
    body: "3月5日（木）または3月6日（金）10:00〜12:00 に開催します。",
  });
  // 種別は説明会のまま（schedule_request に倒さない）＝本文の開催日時が予定として残る
  for (let i = 0; i < candidates.length; i += 1) assert.equal(candidates[i].kind, "seminar");
  // 時刻が 1 組しか書かれていなくても、両日が候補になる（レビュー r2 R2-1）
  assert.deepEqual(
    candidates.map((c) => [c.start, c.end]),
    [
      ["2026-03-05T10:00:00+09:00", "2026-03-05T12:00:00+09:00"],
      ["2026-03-06T10:00:00+09:00", "2026-03-06T12:00:00+09:00"],
    ]
  );
  // 時刻が両方に書かれていれば 2 件になる
  const both = parseMail({
    id: "sc10",
    threadId: "sc10",
    from: "株式会社サンプル商事 <recruit@a.example.jp>",
    subject: "会社説明会のご案内",
    date: "2026-03-01T10:00:00+09:00",
    body: "3月5日（木）10:00〜12:00 または 3月6日（金）10:00〜12:00 に開催します。",
  });
  assert.equal(both.length, 2);
  assert.deepEqual(
    both.map((c) => [c.kind, c.start]),
    [
      ["seminar", "2026-03-05T10:00:00+09:00"],
      ["seminar", "2026-03-06T10:00:00+09:00"],
    ]
  );
});

// --- レビュー r2 R2-1: 1 行に日付が複数・時刻が 1 組 --------------------------
test("並んだ日付に時刻が 1 組でも、早い日が消えない（R2-1・・／と／または）", () => {
  const bodies = [
    "会社説明会を開催します。\n3月5日（木）・3月6日（金）10:00〜12:00 に開催します。",
    "会社説明会を開催します。\n3月5日（木）と3月6日（金）10:00〜12:00 に開催します。",
    "会社説明会を開催します。\n3月5日（木）または3月6日（金）10:00〜12:00 に開催します。",
  ];
  for (let i = 0; i < bodies.length; i += 1) {
    const candidates = parseMail({
      id: "r21_" + i,
      threadId: "r21_" + i,
      from: "サンプル銀行株式会社 <saiyo@sample-bank.example.jp>",
      subject: "会社説明会のご案内",
      date: "2026-03-01T10:12:00+09:00",
      body: bodies[i],
    });
    assert.deepEqual(
      candidates.map((c) => [c.kind, c.start, c.end, c.allDay]),
      [
        ["seminar", "2026-03-05T10:00:00+09:00", "2026-03-05T12:00:00+09:00", false],
        ["seminar", "2026-03-06T10:00:00+09:00", "2026-03-06T12:00:00+09:00", false],
      ],
      bodies[i]
    );
  }
});

test("同じ日付に終日と時刻付きの両方があるときは、時刻付きだけを残す（R2-1 の限定）", () => {
  const candidates = parseMail({
    id: "r22",
    threadId: "r22",
    from: "株式会社サンプル商事 <recruit@a.example.jp>",
    subject: "面接のご案内",
    date: "2026-03-01T10:00:00+09:00",
    body: "面接日は3月5日（木）です。\n当日は3月5日（木）14:00〜15:00 にお越しください。",
  });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].start, "2026-03-05T14:00:00+09:00");
});

// --- レビュー r1 重要 5: 1 通に複数種別の日付 --------------------------------
test("ES 締切と Web テスト期限が並ぶメールは締切ごとに種別を決める（重要 5）", () => {
  const candidates = parseMail({
    id: "mk1",
    threadId: "mk1",
    from: "株式会社サンプル商事 <recruit@a.example.jp>",
    subject: "ES提出とWebテスト受検のご案内",
    date: "2026-03-01T10:00:00+09:00",
    body: "ES提出締切：3月10日（火）23:59\nWebテスト受検期限：3月12日（木）17:00",
  });
  assert.equal(candidates.length, 2);
  assert.deepEqual(
    candidates.map((c) => [c.kind, String(c.deadline).slice(0, 10)]),
    [
      ["es_deadline", "2026-03-10"],
      ["test_deadline", "2026-03-12"],
    ]
  );
  assert.match(candidates[0].title, /ES提出$/);
  assert.match(candidates[1].title, /Webテスト$/);
});

test("順序を逆にしても行の語で決まる（重要 5）", () => {
  const candidates = parseMail({
    id: "mk2",
    threadId: "mk2",
    from: "株式会社サンプル商事 <recruit@a.example.jp>",
    subject: "Webテスト受検のご案内",
    date: "2026-03-01T10:00:00+09:00",
    body: "Webテスト受検期限：3月12日（木）17:00\nES提出締切：3月10日（火）23:59",
  });
  const byDay = {};
  for (let i = 0; i < candidates.length; i += 1) byDay[String(candidates[i].deadline).slice(0, 10)] = candidates[i];
  assert.equal(byDay["2026-03-10"].kind, "es_deadline");
  assert.equal(byDay["2026-03-12"].kind, "test_deadline");
});

test("説明会と面接の日付が並ぶメールは日時ごとに種別を決める（重要 5）", () => {
  const candidates = parseMail({
    id: "mk3",
    threadId: "mk3",
    from: "株式会社サンプル商事 <recruit@a.example.jp>",
    subject: "選考のご案内",
    date: "2026-03-01T10:00:00+09:00",
    body: "会社説明会：3月5日（木）14:00〜15:00\n1次面接：3月12日（木）10:00〜11:00",
  });
  assert.equal(candidates.length, 2);
  assert.deepEqual(
    candidates.map((c) => [c.kind, c.start]),
    [
      ["seminar", "2026-03-05T14:00:00+09:00"],
      ["interview", "2026-03-12T10:00:00+09:00"],
    ]
  );
  assert.equal(candidates[0].title, "【説明会】株式会社サンプル商事");
  assert.equal(candidates[1].title, "【面接】株式会社サンプル商事 1次面接");
  assert.equal(candidates[0].stage, null);
  assert.equal(candidates[1].stage, "1次");
});

test("中止・変更のメールは本文に「説明会」があっても種別を変えない（重要 5）", () => {
  const candidates = parseMail({
    id: "mk4",
    threadId: "mk4",
    from: "株式会社サンプル商事 <recruit@a.example.jp>",
    subject: "【重要】会社説明会 中止のお知らせ",
    date: "2026-03-01T10:00:00+09:00",
    body: "会社説明会：3月5日（木）14:00〜15:00 は中止となりました。",
  });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].kind, "change");
  assert.match(candidates[0].title, /^【変更】/);
});

// --- 軽微 1: 企業名の大小差 -------------------------------------------------
test("candidateKey: 企業名の大小差と空白を吸収する（軽微 1・2）", () => {
  const base = { kind: "interview", start: "2026-03-05T14:00:00+09:00", deadline: null, messageId: "m1" };
  const upper = candidateKey(Object.assign({}, base, { company: "SAMPLE Inc." }));
  const lower = candidateKey(Object.assign({}, base, { company: "sample inc." }));
  const spaced = candidateKey(Object.assign({}, base, { company: "SAMPLE  Inc." }));
  assert.equal(upper, lower);
  assert.equal(upper, spaced);
  // 前株・後株は同一視しない（別法人になりうる）
  assert.notEqual(
    candidateKey(Object.assign({}, base, { company: "株式会社サンプル商事" })),
    candidateKey(Object.assign({}, base, { company: "サンプル商事株式会社" }))
  );
});
