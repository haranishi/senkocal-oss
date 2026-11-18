import assert from "node:assert/strict";
import test from "node:test";
import { api_ignoreCandidate, api_restoreCandidate, api_listCandidates, api_registerCandidate,
  importMail, setup } from "../../src/gas/app.js";
import { installGasMocks, ledgerSheet, pickFixtureMails } from "./helpers/gas-mocks.mjs";

for (const [name, action] of [["ignore", api_ignoreCandidate], ["restore", api_restoreCandidate]]) {
  test("review-08: " + name + " must not overwrite a concurrent registration", () => {
    const gas = installGasMocks({ mails: pickFixtureMails(["01"]) });
    try {
      setup(); importMail();
      const id = api_listCandidates().candidates[0].id;
      const sheet = ledgerSheet(gas.spreadsheet, "候補");
      const getRange = sheet.getDataRange;
      let triggered = false;
      let concurrent = null;
      sheet.getDataRange = () => {
        const range = getRange();
        const getValues = range.getValues;
        range.getValues = () => {
          const snapshot = getValues();
          // Header validation reads the sheet too; count until the candidate read.
          if (!triggered && ++reads === 2) {
            triggered = true;
            try { concurrent = api_registerCandidate(id, ""); }
            catch (err) { assert.match(err.message, /他の処理が動いています/); }
          }
          return snapshot;
        };
        return range;
      };
      let reads = 0;
      action(id);
      const current = api_listCandidates().candidates[0];
      console.log("review-08 " + name + ":", JSON.stringify({
        concurrentRegistered: concurrent?.ok || false, status: current.status, eventId: current.eventId,
      }));
      assert.equal(triggered, true);
      if (concurrent?.ok) {
        assert.equal(current.status, "登録済み");
        assert.equal(current.eventId, concurrent.eventId);
      } else {
        assert.equal(gas.calendar.events.size, 0);
      }
    } finally { gas.restore(); }
  });
}
