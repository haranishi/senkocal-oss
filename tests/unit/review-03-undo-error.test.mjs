import assert from "node:assert/strict";
import test from "node:test";
import { api_listCandidates, api_registerCandidate, api_undoRegister, importMail, setup } from "../../src/gas/app.js";
import { installGasMocks, pickFixtureMails } from "./helpers/gas-mocks.mjs";

test("review-03: lookup failure must retain the event ID for a later undo", () => {
  const gas = installGasMocks({ mails: pickFixtureMails(["01"]) });
  try {
    setup(); importMail();
    const id = api_listCandidates().candidates[0].id;
    const registered = api_registerCandidate(id, "");
    const original = gas.calendar.calendar.getEventById;
    gas.calendar.calendar.getEventById = () => { throw new Error("temporary calendar failure"); };
    let error = null;
    let result = null;
    try { result = api_undoRegister(id); } catch (err) { error = err; }
    const current = api_listCandidates().candidates[0];
    console.log("review-03:", JSON.stringify({ ok: result?.ok, eventId: current.eventId,
      eventStillExists: !gas.calendar.recordOf(registered.eventId).deleted }));
    assert.match(error?.message || "", /temporary calendar failure/);
    assert.equal(current.eventId, registered.eventId);
    assert.equal(current.status, "登録済み");
    gas.calendar.calendar.getEventById = original;
    assert.equal(api_undoRegister(id).deleted, true);
    assert.equal(api_undoRegister(id).deleted, false);
  } finally { gas.restore(); }
});
