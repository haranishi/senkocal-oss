import assert from "node:assert/strict";
import test from "node:test";
import { parseMail } from "../../src/core/parse.js";
import { mergeCandidates } from "../../src/core/ledger.js";

test("review-06: ES and test deadlines at the same instant are separate tasks", () => {
  const mail = { id: "equal-deadlines", from: "株式会社サンプル <hr@example.com>",
    subject: "ES提出とWebテストのご案内", date: "2026-03-01T09:00:00+09:00",
    body: "ES提出締切: 2026年3月10日 17:00\nWebテスト受検期限: 2026年3月10日 17:00" };
  const candidates = mergeCandidates([], parseMail(mail)).added;
  console.log("review-06:", JSON.stringify(candidates.map(c => ({ kind: c.kind, deadline: c.deadline }))));
  assert.deepEqual(candidates.map(c => c.kind), ["es_deadline", "test_deadline"]);
  assert.ok(candidates.every(c => c.deadline === "2026-03-10T17:00:00+09:00"));
  assert.equal(mergeCandidates(candidates, parseMail(mail)).added.length, 0);
  assert.equal(parseMail({ ...mail, body: mail.body + "\nES提出締切: 2026年3月10日 17:00" }).length, 2);
});
