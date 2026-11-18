import assert from "node:assert/strict";
import test from "node:test";
import { api_listCandidates, api_registerCandidate, applyEdits, importMail, setup } from "../../src/gas/app.js";
import { buildEventPlan, titleFor } from "../../src/core/events.js";
import { installGasMocks, pickFixtureMails } from "./helpers/gas-mocks.mjs";

test("review-04: the edited title must reach the actual calendar call", () => {
  const gas = installGasMocks({ mails: pickFixtureMails(["01"]) });
  try {
    setup(); importMail();
    const id = api_listCandidates().candidates[0].id;
    const result = api_registerCandidate(id, JSON.stringify({ title: "最終面接（本社）" }));
    const record = gas.calendar.recordOf(result.eventId);
    console.log("review-04:", JSON.stringify({ ledger: result.candidate.title, calendar: record.title }));
    assert.equal(record.title, "最終面接（本社）");
    assert.equal(result.candidate.title, record.title);
  } finally { gas.restore(); }
});

test("review-04: generated deadline titles follow date edits; custom titles remain", () => {
  const candidate = { kind: "es_deadline", company: "株式会社サンプル", status: "候補",
    deadline: "2026-03-10T12:00:00+09:00" };
  candidate.title = titleFor(candidate);
  const edits = { deadline: "2026-03-10T17:00" };
  assert.match(buildEventPlan(applyEdits(candidate, edits)).title, /17:00/);
  assert.equal(buildEventPlan(applyEdits({ ...candidate, title: "書類一式の提出" }, edits)).title, "書類一式の提出");
});
