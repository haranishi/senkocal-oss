import assert from "node:assert/strict";
import test from "node:test";
import { importMail, setup } from "../../src/gas/app.js";
import { openLedger } from "../../src/gas/adapters.js";
import { HEADERS } from "../../src/core/ledger.js";
import { installGasMocks, ledgerSheet } from "./helpers/gas-mocks.mjs";

// This checks the exact values passed to Sheets. The mock does not evaluate formulas.
test("review-02: mail text reaching setValues must be literal text", () => {
  const gas = installGasMocks({ mails: [{
    id: "formula", from: "株式会社サンプル <hr@example.com>",
    subject: "=1+1", date: "2026-03-01T09:00:00+09:00",
    body: "面接日時: 2026年3月5日 14:00\n場所: =1+2",
  }] });
  try {
    setup();
    importMail();
    const sheet = ledgerSheet(gas.spreadsheet, "候補");
    const row = sheet.rows()[0];
    console.log("review-02 setValues subject:", JSON.stringify(row[HEADERS.indexOf("件名")]));
    assert.equal(row[HEADERS.indexOf("件名")], "'=1+1");
    assert.equal(row[HEADERS.indexOf("場所")], "'=1+2");
    const ledger = openLedger(gas.spreadsheet, { properties: gas.properties.getScriptProperties() });
    const candidate = ledger.readCandidates()[0];
    ledger.upsertCandidate({ ...candidate, title: "=1+3" });
    assert.equal(sheet.rows()[0][HEADERS.indexOf("タイトル")], "'=1+3");
    ledger.writeCandidates([{ ...candidate, subject: "=1+4" }]);
    assert.equal(sheet.rows()[0][HEADERS.indexOf("件名")], "'=1+4");
  } finally { gas.restore(); }
});
