import { expect, test } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { applyEdits } from "../../src/gas/app.js";
import { buildEventPlan } from "../../src/core/events.js";

const pageUrl = new URL("../../src/ui/index.html", import.meta.url).href;
const stubPath = fileURLToPath(new URL("./gas-stub.js", import.meta.url));
const base = { id: "review-dates", messageId: "review", company: "株式会社サンプル",
  subject: "説明会のご案内", title: "", status: "候補", confidence: "high",
  receivedAt: "2026-03-01T09:00:00+09:00", location: "本社", choices: [] };

for (const [name, values] of [
  ["deadline time", { kind: "es_deadline", start: null, end: null,
    deadline: "2026-03-10T12:00:00+09:00", allDay: true }],
  ["all-day event", { kind: "seminar", start: "2026-03-10", end: null,
    deadline: null, allDay: true }],
]) {
  test("review-05: changing only location preserves " + name, async ({ page }) => {
    const candidate = { ...base, ...values };
    await page.route(/^https?:/, route => route.abort());
    await page.addInitScript(config => { window.__gasStubConfig = config; }, { candidates: [candidate] });
    await page.addInitScript({ path: stubPath });
    await page.goto(pageUrl);
    const card = page.locator('[data-id="review-dates"]');
    await card.getByRole("button", { name: "編集", exact: true }).click();
    await card.locator('input[data-role="location"]').fill("支社");
    await card.getByRole("button", { name: "この内容で登録" }).click();
    await expect(card).toHaveAttribute("data-status", "登録済み");
    const edits = await page.evaluate(() => JSON.parse(window.__gasStub.calls.find(
      call => call.name === "api_registerCandidate").args[1]));
    // Apply the captured browser payload through the real server functions.
    const edited = applyEdits(candidate, edits);
    const plan = buildEventPlan(edited);
    console.log("review-05 " + name + ":", JSON.stringify({ edits, deadline: edited.deadline, type: plan.type }));
    expect(edited.location).toBe("支社");
    expect(edited.start).toBe(candidate.start);
    expect(edited.deadline).toBe(candidate.deadline);
    expect(edited.allDay).toBe(true);
    expect(plan.type).toBe("allDay");
  });
}
