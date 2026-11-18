import assert from "node:assert/strict";
import test from "node:test";
import { importMail, setup } from "../../src/gas/app.js";
import { listRecentMails } from "../../src/gas/adapters.js";
import { createGmailAppMock, installGasMocks, ledgerSheet } from "./helpers/gas-mocks.mjs";

const mails = Array.from({ length: 51 }, (_, i) => ({
  id: "page-" + i, threadId: "thread-" + i,
  from: "株式会社サンプル <hr@example.com>", subject: "面接のご案内",
  date: new Date(Date.UTC(2026, 2, 2, 0, 51 - i)).toISOString(),
  body: "日時は追ってお知らせします。",
}));

test("review-01: repeated imports reach the 51st matching thread", () => {
  const gas = installGasMocks({ mails });
  try {
    setup();
    const looked = [importMail().looked, importMail().looked, importMail().looked];
    console.log("review-01 looked:", JSON.stringify(looked));
    assert.deepEqual(looked, [50, 1, 0]);
    assert.equal(ledgerSheet(gas.spreadsheet, "処理済みメール").rows().length, 51);
    assert.equal(gas.calendar.calls.length, 0);
  } finally { gas.restore(); }
});

test("review-01: a long thread does not read more bodies than the run limit", () => {
  const gmail = createGmailAppMock(mails.map(m => ({ ...m, threadId: "one-thread" })));
  const first = listRecentMails(gmail, "query", { max: 50 });
  assert.equal(first.length, 50);
  assert.equal(gmail.bodyReads.length, 50);
  const second = listRecentMails(gmail, "query", { max: 50, skipIds: new Set(first.map(m => m.id)) });
  assert.deepEqual(second.map(m => m.id), ["page-50"]);
});
