import assert from "node:assert/strict";
import test from "node:test";
import { api_listCandidates, api_registerCandidate, importMail, setup } from "../../src/gas/app.js";
import { installGasMocks, pickFixtureMails } from "./helpers/gas-mocks.mjs";

test("review-07: reminder failure must not leave an untracked event on retry", () => {
  const gas = installGasMocks({ mails: pickFixtureMails(["01"]) });
  try {
    setup(); importMail();
    const id = api_listCandidates().candidates[0].id;
    const original = gas.calendar.calendar.createEvent;
    gas.calendar.calendar.createEvent = (...args) => {
      const event = original(...args);
      event.addPopupReminder = () => { throw new Error("temporary reminder failure"); };
      return event;
    };
    assert.throws(() => api_registerCandidate(id, ""), /temporary reminder failure/);
    gas.calendar.calendar.createEvent = original;
    const retry = api_registerCandidate(id, "");
    const live = [...gas.calendar.events.values()].filter(e => !e.deleted);
    console.log("review-07:", JSON.stringify({ liveEvents: live.length, trackedEvent: retry.eventId }));
    assert.equal(live.length, 1);
    assert.equal(live[0].id, retry.eventId);
  } finally { gas.restore(); }
});
