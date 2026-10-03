/**
 * ui.spec.mjs — 確認画面（src/ui/index.html）を file:// で開いて動かす
 *
 * サーバー（Apps Script）は tests/e2e/gas-stub.js で差し替える。見ているのは
 * 「押して登録できるか」「間違えたときに直せるか」「狭い画面で壊れないか」の 3 つ。
 * Playwright はローカルにインストールした開発ツールを使う。
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";

const root = fileURLToPath(new URL("../..", import.meta.url));
const pageUrl = "file://" + path.join(root, "src/ui/index.html");
const stubPath = path.join(root, "tests/e2e/gas-stub.js");

/** スタブの設定を先に流し込んでから画面を開く */
async function openApp(page, config) {
  if (config) await page.addInitScript("window.__gasStubConfig = " + JSON.stringify(config) + ";");
  await page.addInitScript({ path: stubPath });
  await page.goto(pageUrl);
}

/** 一覧が描き終わるまで待つ */
async function waitList(page) {
  await expect(page.locator("main")).toHaveAttribute("data-state", "list");
}

function cardOf(page, id) {
  return page.locator('.card[data-id="' + id + '"]');
}

test("① 読み込み中から一覧へ。区分ごとに件数が並ぶ", async ({ page }) => {
  await openApp(page, { delay: 150 });
  await expect(page.locator("main")).toHaveAttribute("data-state", "loading");
  await waitList(page);
  await expect(page.locator("#group-timed .group-head")).toContainText("予定");
  await expect(page.locator("#group-timed .card")).toHaveCount(5);
  await expect(page.locator("#group-deadline .card")).toHaveCount(2);
  await expect(page.locator("#group-choice .card")).toHaveCount(2);
  await expect(page.locator("#group-low .card")).toHaveCount(2);
  // 区分見出しの語彙は「明記／一部推定／要確認」の 1 系統（採点 r2 TOP5）
  await expect(page.locator("#group-low .group-head")).toHaveText("要確認 2 件・推定を含む候補");
  await expect(page.locator("#group-registered summary")).toHaveText("登録済み 1 件");
  await expect(page.locator("#group-noise summary")).toHaveText("ノイズ・無視 5 件は候補から外しています");
  // 分母（読んだメール）と分子（候補）を並べる（採点 r3 Q9）
  await expect(page.locator("#last-run")).toContainText("最終取り込み 09:12・メール 12 件から候補 11 件");
});

test("② カードの中で最大の要素は日時（④骨格の要）", async ({ page }) => {
  await openApp(page, {});
  await waitList(page);
  const sizes = await cardOf(page, "c_s01_1").evaluate((card) => {
    const when = parseFloat(getComputedStyle(card.querySelector(".when")).fontSize);
    let other = 0;
    card.querySelectorAll("*").forEach((node) => {
      // 日時は「日付」「時刻」の 2 つの span に分かれているので、その中も日時として飛ばす
      if (node.classList.contains("when") || node.closest(".when")) return;
      if (String(node.textContent || "").trim() === "") return;
      const size = parseFloat(getComputedStyle(node).fontSize);
      if (size > other) other = size;
    });
    return { when: when, other: other };
  });
  expect(sizes.when).toBeGreaterThan(sizes.other);
  await expect(cardOf(page, "c_s01_1").locator(".when")).toHaveText("3/5（木）14:00〜15:00");
});

test("③ 「登録」を押すと登録済みカードになり、カレンダーへの導線が出る", async ({ page }) => {
  await openApp(page, {});
  await waitList(page);
  const card = cardOf(page, "c_s01_1");
  await card.getByRole("button", { name: "登録", exact: true }).click();
  await expect(card).toHaveAttribute("data-status", "登録済み");
  // 1 行目は「✓ 登録済み」の小ラベルと日時の 2 段（採点 r3 Q12）
  await expect(card.locator(".when-label")).toHaveText("✓ 登録済み");
  await expect(card.locator(".when")).toContainText("3/5（木）14:00");
  const link = card.getByRole("link", { name: "カレンダーで開く" });
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(card.getByRole("button", { name: "取り消す" })).toBeVisible();
  // 結果は上部の帯で返る（そこから戻せる・採点 r3 Q5）
  await expect(page.locator("#bulk-done-text")).toContainText("カレンダーに登録しました");
  // 登録済みカードにその場かぎりのメッセージを残さない（2 枚の見た目をそろえる・P22）
  await expect(card.locator(".card-msg")).toHaveText("");
  await expect(page.locator('#group-registered .card .card-msg:not(:empty)')).toHaveCount(0);
});

test("④ 「取り消す」で候補に戻る", async ({ page }) => {
  await openApp(page, {});
  await waitList(page);
  const card = cardOf(page, "c_s01_1");
  await card.getByRole("button", { name: "登録", exact: true }).click();
  await expect(card).toHaveAttribute("data-status", "登録済み");
  await card.getByRole("button", { name: "取り消す" }).click();
  await expect(card).toHaveAttribute("data-status", "候補");
  await expect(card.getByRole("button", { name: "登録", exact: true })).toBeVisible();
  // 取り消しの結果も同じ帯で返す（どこを見れば結果が分かるかを変えない・採点 r3 Q6）
  await expect(page.locator("#bulk-done-text")).toContainText("登録を取り消しました");
  await expect(page.locator("#bulk-undo")).toBeHidden();
});

test("⑤ 「無視」を押すとノイズ・無視の区分へ移る", async ({ page }) => {
  await openApp(page, {});
  await waitList(page);
  await cardOf(page, "c_s01_1").getByRole("button", { name: "無視" }).click();
  await expect(page.locator("#group-noise summary")).toHaveText("ノイズ・無視 6 件は候補から外しています");
  await expect(cardOf(page, "c_s01_1")).toHaveCount(0);
  await page.locator("#group-noise summary").click();
  await expect(page.locator("#group-noise .noise-item")).toHaveCount(6);
  await expect(page.locator('#group-noise .noise-item[data-id="c_s01_1"]')).toHaveCount(1);
});

test("⑥ 編集して開始を変えると、その内容でサーバーに渡る", async ({ page }) => {
  await openApp(page, {});
  await waitList(page);
  const card = cardOf(page, "c_s01_1");
  await card.getByRole("button", { name: "編集" }).click();
  const start = card.locator('input[data-role="start"]');
  await expect(start).toHaveValue("2026-03-05T14:00");
  await start.fill("2026-03-06T15:30");
  await card.locator('input[data-role="end"]').fill("2026-03-06T16:30");
  await card.getByRole("button", { name: "この内容で登録" }).click();
  await expect(card).toHaveAttribute("data-status", "登録済み");
  await expect(card.locator(".when")).toContainText("3/6（金）15:30");
  const edits = await page.evaluate(() => {
    const calls = window.__gasStub.calls.filter((entry) => entry.name === "api_registerCandidate");
    return JSON.parse(calls[calls.length - 1].args[1]);
  });
  expect(edits.start).toBe("2026-03-06T15:30");
  expect(edits.end).toBe("2026-03-06T16:30");
});

test("⑦ 「まとめて登録」は明記の候補だけ。要確認の候補は残る", async ({ page }) => {
  await openApp(page, {});
  await waitList(page);
  await expect(page.locator("#bulk-register")).toHaveText("明記の 4 件をまとめて登録");
  // ボタンの件数と注記が同じ集合を指す＝注記に対象の企業名が並ぶ（P1）
  await expect(page.locator("#bulk-note")).toHaveText(
    "日時と企業名が明記された候補が対象です。日程調整・変更のお知らせ・過去の日付は入りません。"
  );
  await expect(page.locator("#bulk-targets")).toHaveText(
    "3/5 株式会社サンプル商事・3/6 株式会社サンプル物流・3/8 サンプル化学工業株式会社・3/12 合同会社テストワークス"
  );
  await page.locator("#bulk-register").click();
  await expect(page.locator('.card[data-status="登録済み"]')).toHaveCount(5);
  await expect(page.locator("#bulk-done-text")).toHaveText("4 件を登録しました");
  await expect(page.locator("#bulk-undo")).toBeVisible();
  await expect(page.locator('#group-low .card[data-status="候補"]')).toHaveCount(2);
  await expect(page.locator("#bulk")).toBeHidden();
});

test("⑧ 日程調整カードは候補日と返信期限を見せ、要返信として登録できる", async ({ page }) => {
  await openApp(page, {});
  await waitList(page);
  const card = cardOf(page, "c_s07_1");
  await expect(card.locator(".choices li")).toHaveCount(3);
  await expect(card.locator(".choices li").first()).toHaveText("3/5（木）10:00");
  await expect(card.locator(".when")).toContainText("返信期限 3/8");
  const button = card.getByRole("button", { name: "【要返信】として登録" });
  await expect(button).toBeVisible();
  await button.click();
  await expect(card).toHaveAttribute("data-status", "登録済み");
});

test("⑨ ノイズは畳まれていて、開いて「候補にする」で戻せる", async ({ page }) => {
  await openApp(page, {});
  await waitList(page);
  const details = page.locator("#group-noise");
  expect(await details.evaluate((node) => node.open)).toBe(false);
  // 閉じているあいだは summary だけ＝空の帯を出さない（P5）
  expect(await details.evaluate((node) => node.children.length)).toBe(1);
  await details.locator("summary").click();
  expect(await details.evaluate((node) => node.open)).toBe(true);
  const item = details.locator('.noise-item[data-id="c_n1_0"]');
  await expect(item).toContainText("オファーが届きました");
  // 中身を見ずに戻す判断をしないで済むように、元のメールへの導線も並べる（採点 r3 Q17）
  const open = item.getByRole("link", { name: "Gmail で開く" });
  await expect(open).toHaveAttribute("target", "_blank");
  await expect(open).toHaveAttribute("href", /mail\.google\.com/);
  await item.getByRole("button", { name: "候補にする" }).click();
  await expect(cardOf(page, "c_n1_0")).toHaveCount(1);
  await expect(page.locator("#group-noise .noise-item")).toHaveCount(4);
});

test("⑩ 登録に失敗したら理由を出し、もう一度押せる", async ({ page }) => {
  await openApp(page, { failNext: "api_registerCandidate" });
  await waitList(page);
  const card = cardOf(page, "c_s01_1");
  await card.getByRole("button", { name: "登録", exact: true }).click();
  await expect(card.locator(".card-msg")).toContainText("登録できませんでした");
  await expect(card).toHaveAttribute("data-status", "候補");
  await card.getByRole("button", { name: "登録", exact: true }).click();
  await expect(card).toHaveAttribute("data-status", "登録済み");
});

test("⑪ 候補が無いときは次の取り込みを伝え、その場で取り込める", async ({ page }) => {
  await openApp(page, { mode: "empty", importAdds: 1 });
  await expect(page.locator("main")).toHaveAttribute("data-state", "empty");
  await expect(page.locator("#view-empty")).toContainText("候補はありません");
  await expect(page.locator("#view-empty")).toContainText("2 時間ごと");
  await page.locator("#empty-import").click();
  await waitList(page);
  await expect(page.locator("#notice")).toContainText("候補 1 件");
  await expect(page.locator("#group-timed .card")).toHaveCount(1);
});

test("⑫ 台帳を読めないときは理由と次の行動を出す", async ({ page }) => {
  await openApp(page, { mode: "error" });
  await expect(page.locator("main")).toHaveAttribute("data-state", "error");
  await expect(page.locator("#view-error h2")).toHaveText("初期設定がまだです");
  await expect(page.locator("#error-note")).toHaveText(
    "Apps Script のエディタで setup を一度実行してから、下のボタンを押してください。"
  );
  // 「スタブ」も README への案内も出さない。次の行動はボタン 1 つ（P7・P8・採点 r2 TOP4）
  await expect(page.locator("#view-error")).not.toContainText("スタブ");
  await expect(page.locator("#view-error")).not.toContainText("README");
  await expect(page.locator("#view-error")).not.toContainText("再読み込みします");
  await expect(page.locator("#view-error button")).toHaveCount(1);
  await expect(page.locator("#error-retry")).toBeVisible();
  // ヘッダーの「いま取り込む」は empty と同じく隠す（処理を 2 通りにしない・採点 r3 Q18）
  await expect(page.locator("#import-now")).toBeHidden();
});

test("⑬ 幅 390 で横スクロールが出ず、押せるものは 44px 以上", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openApp(page, {});
  await waitList(page);
  const scroll = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(scroll.scrollWidth).toBeLessThanOrEqual(390);
  expect(scroll.scrollWidth).toBeLessThanOrEqual(scroll.clientWidth);
  const heights = await page
    .locator("#bulk-register, .card .actions button, .card .actions a, #import-now")
    .evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().height));
  expect(heights.length).toBeGreaterThan(5);
  for (let i = 0; i < heights.length; i += 1) expect(heights[i]).toBeGreaterThanOrEqual(44);
});

test("⑭ Tab でフォーカスが見える（NFR-06）", async ({ page }) => {
  await openApp(page, {});
  await waitList(page);
  await page.keyboard.press("Tab");
  const focus = await page.evaluate(() => {
    const node = document.activeElement;
    const style = getComputedStyle(node);
    return {
      tag: node.tagName,
      text: String(node.textContent || "").trim(),
      width: parseFloat(style.outlineWidth),
      style: style.outlineStyle,
    };
  });
  expect(focus.width).toBeGreaterThan(0);
  expect(focus.style).not.toBe("none");
  expect(focus.text.length).toBeGreaterThan(0);
});

test("⑮ google.script.run に Date を渡していない（FR-08）", async ({ page }) => {
  await openApp(page, {});
  await waitList(page);
  const card = cardOf(page, "c_s01_1");
  await card.getByRole("button", { name: "編集" }).click();
  await card.locator('input[data-role="start"]').fill("2026-03-07T09:00");
  await card.getByRole("button", { name: "この内容で登録" }).click();
  await expect(card).toHaveAttribute("data-status", "登録済み");
  await page.locator("#import-now").click();
  await expect(page.locator("#notice")).toContainText("取り込みました");
  const calls = await page.evaluate(() => window.__gasStub.calls.map((entry) => entry.argTypes));
  const types = [];
  for (let i = 0; i < calls.length; i += 1) {
    for (let k = 0; k < calls[i].length; k += 1) types.push(calls[i][k]);
  }
  expect(calls.length).toBeGreaterThan(2);
  expect(types).not.toContain("Date");
  expect(types).not.toContain("object");
  expect(types).not.toContain("function");
});

test("⑯ 企業名が取れていない候補は入力欄が出て、入れて登録できる", async ({ page }) => {
  await openApp(page, {});
  await waitList(page);
  const card = cardOf(page, "c_s08_1");
  const input = card.locator("input.company-input");
  await expect(input).toHaveAttribute("placeholder", "企業名を入力");
  await input.fill("株式会社サンプル通商");
  await card.getByRole("button", { name: "登録", exact: true }).click();
  await expect(card).toHaveAttribute("data-status", "登録済み");
  await expect(card.locator(".company")).toHaveText("株式会社サンプル通商");
  const edits = await page.evaluate(() => {
    const calls = window.__gasStub.calls.filter((entry) => entry.name === "api_registerCandidate");
    return JSON.parse(calls[calls.length - 1].args[1]);
  });
  expect(edits.company).toBe("株式会社サンプル通商");
});

test("⑰ 日時が取れていない候補は「登録」を出さず、編集が主操作になる（採点 r2 TOP3）", async ({ page }) => {
  // 既定の seed で日時が無いのは中止のお知らせ（＝主操作が「Gmail で確認する」になる別ルール）なので、
  // ここでは同じ形の候補をテストの中だけで足す（スクショの構成は変えない）
  await openApp(page, {
    extraCandidates: [
      {
        id: "c_nodate_1",
        messageId: "m_nodate",
        kind: "interview",
        company: "株式会社サンプル部品",
        title: "【面接】株式会社サンプル部品",
        subject: "面接のご案内（日程は追ってご連絡します）",
        confidence: "low",
      },
    ],
  });
  await waitList(page);
  const card = cardOf(page, "c_nodate_1");
  await expect(card.locator(".when")).toHaveText("日時なし");
  // 押せない「登録」を出さない＝押した結果が書けない操作を見せない
  await expect(card.getByRole("button", { name: "登録", exact: true })).toHaveCount(0);
  const main = card.locator(".act-main > *");
  await expect(main).toHaveCount(1);
  await expect(main).toHaveText("編集して日時を入れる");
  // 足りない項目は主操作のすぐ下に 1 行
  const rows = await card.locator(".actions > *").evaluateAll((nodes) => nodes.map((node) => node.className));
  expect(rows[0]).toContain("act-main");
  expect(rows[1]).toContain("hint-plan");
  expect(rows[2]).toContain("act-sub");
  await expect(card.locator(".hint-plan")).toContainText("日付がありません");
  await main.click();
  await card.locator('input[data-role="start"]').fill("2026-03-20T10:00");
  await card.getByRole("button", { name: "この内容で登録" }).click();
  await expect(card).toHaveAttribute("data-status", "登録済み");
});

test("⑱ 確度は色ではなく文言で出る（NFR-06）", async ({ page }) => {
  await openApp(page, {});
  await waitList(page);
  await expect(cardOf(page, "c_s01_1").locator(".confidence")).toHaveText("◎ 明記");
  await expect(cardOf(page, "c_s03_1").locator(".confidence")).toHaveText("◯ 一部推定");
  await expect(cardOf(page, "c_s08_1").locator(".confidence")).toHaveText("△ 要確認");
  // 確度は日時行のチップとして出す（右端固定にしない・P11・P15）
  await expect(cardOf(page, "c_s01_1").locator(".card-chips .confidence")).toHaveCount(1);
});

test("⑲ Gmail へのリンクは別タブで開く（サンドボックス対策）", async ({ page }) => {
  await openApp(page, {});
  await waitList(page);
  const link = cardOf(page, "c_s01_1").getByRole("link", { name: "Gmail で開く" });
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(link).toHaveAttribute("rel", "noopener");
  await expect(link).toHaveAttribute("href", /mail\.google\.com/);
});

test("⑳ 768 と 1440 でも 1 カラムのまま中央に収まる", async ({ page }) => {
  for (const width of [768, 1440]) {
    await page.setViewportSize({ width: width, height: 900 });
    await openApp(page, {});
    await waitList(page);
    const box = await page.locator("#group-timed .card").first().boundingBox();
    expect(box.width).toBeLessThanOrEqual(680);
    const scroll = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(scroll).toBeLessThanOrEqual(width);
  }
});

// ---------- ここから UI 採点 r1（.agent-harness/SCORE-r1.md）の反映ぶん ----------

test("㉑ まとめ登録の帯から、そのぶんだけ取り消せる（P2）", async ({ page }) => {
  await openApp(page, {});
  await waitList(page);
  await page.locator("#bulk-register").click();
  await expect(page.locator("#bulk-done-text")).toHaveText("4 件を登録しました");
  await page.locator("#bulk-undo").click();
  // 直前のまとめ登録ぶん 4 件だけが候補へ戻り、もとから登録済みの 1 件は残る
  await expect(page.locator('.card[data-status="登録済み"]')).toHaveCount(1);
  await expect(page.locator("#bulk-done")).toBeHidden();
  await expect(page.locator("#notice")).toContainText("4 件の登録を取り消しました");
  await expect(page.locator("#bulk-register")).toHaveText("明記の 4 件をまとめて登録");
  const undone = await page.evaluate(() =>
    window.__gasStub.calls.filter((entry) => entry.name === "api_undoRegister").map((entry) => entry.args[0])
  );
  expect(undone).toEqual(["c_s01_1", "c_s02_1", "c_s06_1", "c_s04_1"]);
});

test("㉒ 幅 390 で二次操作は高さ 44px・左右 padding 12px・間隔 8px 以上（P3）", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openApp(page, {});
  await waitList(page);

  /** 操作行の各ボタンの見えている面を測る */
  const measure = (card) =>
    card.locator(".act-sub > *").evaluateAll((nodes) =>
      nodes.map((node) => {
        const rect = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        return {
          text: String(node.textContent || "").trim(),
          height: rect.height,
          top: rect.top,
          left: rect.left,
          right: rect.right,
          paddingLeft: parseFloat(style.paddingLeft),
          paddingRight: parseFloat(style.paddingRight),
        };
      })
    );

  const secondary = await measure(cardOf(page, "c_s01_1"));
  expect(secondary.map((box) => box.text)).toEqual(["無視", "編集", "Gmail で開く"]);
  for (const box of secondary) {
    expect(box.height).toBeGreaterThanOrEqual(44);
    expect(box.paddingLeft).toBeGreaterThanOrEqual(12);
    expect(box.paddingRight).toBeGreaterThanOrEqual(12);
  }
  for (let i = 1; i < secondary.length; i += 1) {
    expect(secondary[i].left - secondary[i - 1].right).toBeGreaterThanOrEqual(7.99);
  }
  // 主ボタンは別の行（日程調整カードも同じ並び・P17）
  const main = await cardOf(page, "c_s01_1").locator(".act-main > *").boundingBox();
  expect(main.height).toBeGreaterThanOrEqual(44);
  expect(main.y + main.height).toBeLessThanOrEqual(secondary[0].top + 1);
  const choiceSub = await measure(cardOf(page, "c_s07_1"));
  expect(choiceSub.map((box) => box.text)).toEqual(["無視", "編集", "Gmail で開く"]);

  // 登録済みカードの二次操作も同じ大きさ
  await cardOf(page, "c_s01_1").getByRole("button", { name: "登録", exact: true }).click();
  await expect(cardOf(page, "c_s01_1")).toHaveAttribute("data-status", "登録済み");
  const registered = await measure(cardOf(page, "c_s01_1"));
  expect(registered.map((box) => box.text)).toEqual(["カレンダーで開く", "Gmail で開く", "取り消す"]);
  for (const box of registered) {
    expect(box.height).toBeGreaterThanOrEqual(44);
    expect(box.paddingLeft).toBeGreaterThanOrEqual(12);
  }
});

test("㉓ 締切カードの最大文字は日付で、時刻は下の細目に出る（P9）", async ({ page }) => {
  await openApp(page, {});
  await waitList(page);
  const card = cardOf(page, "c_s06_1");
  await expect(card.locator(".when")).toHaveText("3/8（日）締切");
  expect(await card.locator(".when").textContent()).not.toMatch(/\d{1,2}:\d{2}/);
  await expect(card.locator(".when-sub")).toHaveText("23:59 まで・終日予定＋前日 9:00 に通知");
});

test("㉔ 登録済みカードは登録した範囲を出す（終日は「終日」・P10）", async ({ page }) => {
  await openApp(page, {});
  await waitList(page);
  // 「✓ 登録済み」は日時の上の小ラベル。日時の行には範囲だけを出す（採点 r3 Q12）
  await expect(cardOf(page, "c_s15_1").locator(".when-label")).toHaveText("✓ 登録済み");
  await expect(cardOf(page, "c_s15_1").locator(".when")).toHaveText("3/4（水）11:00〜12:00");
  await cardOf(page, "c_s01_1").getByRole("button", { name: "登録", exact: true }).click();
  await expect(cardOf(page, "c_s01_1").locator(".when")).toHaveText("3/5（木）14:00〜15:00");
  await cardOf(page, "c_s06_1").getByRole("button", { name: "登録", exact: true }).click();
  await expect(cardOf(page, "c_s06_1").locator(".when")).toHaveText("3/8（日）終日");
  // 確度チップは登録後は出さない（登録して良いかの目印なので・採点 r3 Q19）
  await expect(cardOf(page, "c_s15_1").locator(".card-chips .confidence")).toHaveCount(0);
  await expect(cardOf(page, "c_s15_1").locator(".card-chips .chip-kind")).toHaveText("【2次面接】");
});

test("㉕ 登録済みは最下部の区分。390 の初期表示に操作できるカードが入る（P24）", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openApp(page, {});
  await waitList(page);
  const order = await page.locator("#groups > *").evaluateAll((nodes) => nodes.map((node) => node.id));
  expect(order[order.length - 1]).toBe("group-registered");
  expect(order.indexOf("group-registered")).toBeGreaterThan(order.indexOf("group-timed"));
  expect(await page.locator("#group-registered").evaluate((node) => node.open)).toBe(true);
  const first = await page.locator('#group-timed .card[data-status="候補"]').first().boundingBox();
  expect(first.y + first.height).toBeLessThanOrEqual(844);
  const registered = await page.locator("#group-registered").boundingBox();
  expect(registered.y).toBeGreaterThan(first.y);
});

test("㉖ フッターは 3 状態で同じ。error でも台帳の行を出す（P6）", async ({ page }) => {
  await openApp(page, { mode: "error" });
  await expect(page.locator("main")).toHaveAttribute("data-state", "error");
  await expect(page.locator(".app-foot")).toBeVisible();
  await expect(page.locator(".app-foot")).toContainText("設定（検索日数・キーワード・通知）");
  // 台帳の URL をまだ知らないときは、その旨を出す
  await expect(page.locator("#ledger-missing")).toHaveText("台帳はまだありません");
  // 一度でも読めていれば、error でも「台帳を開く」を出す
  await page.evaluate(() => {
    window.__gasStub.mode = "list";
  });
  await page.locator("#error-retry").click();
  await waitList(page);
  await expect(page.locator("#ledger-link")).toBeVisible();
  await page.evaluate(() => {
    window.__gasStub.mode = "error";
  });
  await page.locator("#import-now").click();
  await expect(page.locator("main")).toHaveAttribute("data-state", "error");
  await expect(page.locator("#ledger-link")).toBeVisible();
  await expect(page.locator("#ledger-link")).toHaveAttribute("target", "_blank");
  await expect(page.locator("#ledger-missing")).toBeHidden();
});

// ---------- ここから UI 採点 r2（.agent-harness/SCORE-r2.md）とレビュー r1 の反映ぶん ----------

/**
 * その状態の**押せるもの全部**（カードの中も外も）を測る。
 * 採点 r2 の TOP1 は「枠線ボタンが 34px」だったが、実測は 44px だった（受領書 §0）。
 * 読み違えの余地を消すために、いまは 46px を全カード・全状態で固定する。
 */
async function measureAllHits(page) {
  const nodes = page.locator(
    "button:visible, a.btn-quiet:visible, a.link:visible, .fold > summary:visible, input:visible"
  );
  const count = await nodes.count();
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const node = nodes.nth(i);
    const box = await node.boundingBox();
    out.push({
      text: (await node.textContent()) || (await node.getAttribute("placeholder")) || "(入力)",
      height: box ? box.height : 0,
      width: box ? box.width : 0,
    });
  }
  return out;
}

test("㉗ 押せるものは全カード・全状態で 44px 以上（TOP1）", async ({ page }) => {
  const failures = [];
  let measured = 0;
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width: width, height: width === 390 ? 844 : 900 });
    // list（候補・登録済み・ノイズを開いた状態を 1 画面に出す）
    await openApp(page, {});
    await waitList(page);
    await page.locator("#group-noise summary").click();
    await expect(page.locator("#group-noise .noise-item").first()).toBeVisible();
    await cardOf(page, "c_s01_1").getByRole("button", { name: "登録", exact: true }).click();
    await expect(cardOf(page, "c_s01_1")).toHaveAttribute("data-status", "登録済み");
    await cardOf(page, "c_s03_1").getByRole("button", { name: "編集" }).click();
    for (const hit of await measureAllHits(page)) {
      measured += 1;
      if (hit.height < 44) failures.push(width + "px list: " + hit.text.trim() + " = " + hit.height);
    }
    // empty と error
    for (const mode of ["empty", "error"]) {
      await openApp(page, { mode: mode });
      await expect(page.locator("main")).toHaveAttribute("data-state", mode);
      for (const hit of await measureAllHits(page)) {
        measured += 1;
        if (hit.height < 44) failures.push(width + "px " + mode + ": " + hit.text.trim() + " = " + hit.height);
      }
    }
  }
  expect(failures).toEqual([]);
  // 測り漏れの検知（要素を取れていないのに緑になるのを防ぐ）
  expect(measured).toBeGreaterThan(100);
});

test("㉘ 塗りつぶしはまとめ登録だけ。個別の主操作はティール枠（TOP2）", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openApp(page, {});
  await waitList(page);
  const bulk = await page.locator("#bulk-register").evaluate((node) => {
    const style = getComputedStyle(node);
    return { background: style.backgroundColor, color: style.color, width: node.getBoundingClientRect().width };
  });
  const register = await cardOf(page, "c_s01_1")
    .getByRole("button", { name: "登録", exact: true })
    .evaluate((node) => {
      const style = getComputedStyle(node);
      return {
        background: style.backgroundColor,
        color: style.color,
        borderColor: style.borderTopColor,
        borderWidth: style.borderTopWidth,
        width: node.getBoundingClientRect().width,
      };
    });
  // まとめ登録＝ティールの塗り／個別＝白地にティールの文字と枠
  expect(bulk.background).toBe("rgb(15, 118, 110)");
  expect(register.background).toBe("rgb(255, 255, 255)");
  expect(register.color).toBe("rgb(15, 118, 110)");
  expect(register.borderColor).toBe("rgb(15, 118, 110)");
  expect(parseFloat(register.borderWidth)).toBeGreaterThanOrEqual(2);
  // 画面に塗りつぶしのボタンは 1 つだけ
  const filled = await page.locator("button:visible, a.btn-quiet:visible").evaluateAll((nodes) =>
    nodes.filter((node) => getComputedStyle(node).backgroundColor === "rgb(15, 118, 110)").map((node) => node.id)
  );
  expect(filled).toEqual(["bulk-register"]);
  // 390 では主操作が行いっぱい（右に空白を残さない）
  const row = await cardOf(page, "c_s01_1").locator(".act-main").boundingBox();
  expect(register.width).toBeGreaterThan(row.width - 1);
  // 768 以上では元の幅のまま
  await page.setViewportSize({ width: 768, height: 1024 });
  await openApp(page, {});
  await waitList(page);
  const wide = await cardOf(page, "c_s01_1").getByRole("button", { name: "登録", exact: true }).boundingBox();
  const wideRow = await cardOf(page, "c_s01_1").locator(".act-main").boundingBox();
  expect(wide.width).toBeLessThan(wideRow.width / 2);
});

test("㉙ 日時があって企業名が無い候補は「登録」を出す（押すと企業名へ案内・TOP3）", async ({ page }) => {
  await openApp(page, {});
  await waitList(page);
  const card = cardOf(page, "c_s08_1");
  const register = card.getByRole("button", { name: "登録", exact: true });
  // 見た目と支援技術には無効として伝わる（Playwright も aria-disabled を無効と見る・採点 r3 Q1）
  await expect(register).toBeDisabled();
  await expect(register).toHaveAttribute("aria-disabled", "true");
  const look = await register.evaluate((node) => ({
    disabled: node.disabled,
    color: getComputedStyle(node).color,
    borderColor: getComputedStyle(node).borderTopColor,
  }));
  // DOM の disabled は付けない＝押せる。色は有効なカードのティールではなくグレー
  expect(look.disabled).toBe(false);
  expect(look.color).toBe("rgb(90, 100, 114)");
  expect(look.borderColor).toBe("rgb(127, 135, 150)");
  await register.click({ force: true });
  // 送らずに入力へ案内する
  await expect(card.locator(".card-msg")).toContainText("企業名を入れてから");
  await expect(card).toHaveAttribute("data-status", "候補");
  const calls = await page.evaluate(
    () => window.__gasStub.calls.filter((entry) => entry.name === "api_registerCandidate").length
  );
  expect(calls).toBe(0);
  const focused = await page.evaluate(() => document.activeElement.className);
  expect(focused).toContain("company-input");
  // 入れると無効の見た目が解け、そのまま押して登録できる
  await card.locator("input.company-input").fill("株式会社サンプル通商");
  await expect(register).toBeEnabled();
  await register.click();
  await expect(card).toHaveAttribute("data-status", "登録済み");
});

test("㉚ チップは種別＝塗り・確度＝枠線＋記号で系統が分かれる（TOP5）", async ({ page }) => {
  await openApp(page, {});
  await waitList(page);
  const chips = await cardOf(page, "c_s01_1")
    .locator(".card-chips .chip")
    .evaluateAll((nodes) =>
      nodes.map((node) => {
        const style = getComputedStyle(node);
        return {
          text: String(node.textContent || "").trim(),
          background: style.backgroundColor,
          borderColor: style.borderTopColor,
        };
      })
    );
  expect(chips.length).toBe(2);
  expect(chips[0].text).toBe("【1次面接】");
  expect(chips[1].text).toBe("◎ 明記");
  // 種別＝面がある／確度＝面が無く枠だけ
  expect(chips[0].background).not.toBe("rgba(0, 0, 0, 0)");
  expect(chips[1].background).toBe("rgba(0, 0, 0, 0)");
  expect(chips[1].borderColor).not.toBe(chips[0].borderColor);
  // 画面から「高確度」「確度が低い」の語が消えている（語彙は 1 系統）
  const body = await page.locator("body").textContent();
  expect(body).not.toContain("高確度");
  expect(body).not.toContain("確度が低い");
});

test("㉛ まとめ登録は変更・日程調整・過去日を巻き込まない（レビュー r1 重要 3）", async ({ page }) => {
  await openApp(page, {
    extraCandidates: [
      {
        id: "c_past_1",
        messageId: "m_past",
        kind: "interview",
        stage: "1次",
        company: "株式会社サンプル過去",
        title: "【面接】株式会社サンプル過去 1次面接",
        start: "2026-02-27T10:00:00+09:00",
        end: "2026-02-27T11:00:00+09:00",
        subject: "1次面接のご案内",
        confidence: "high",
        isPast: true,
      },
    ],
  });
  await waitList(page);
  // 確度「高」で企業名も日時もある候補は 7 件あるが、対象は 4 件
  const high = await page.locator('.card[data-confidence="high"][data-status="候補"]').count();
  expect(high).toBe(7);
  await expect(page.locator("#bulk-register")).toHaveText("明記の 4 件をまとめて登録");
  await expect(page.locator("#bulk-targets")).not.toContainText("サンプル建設");
  await expect(page.locator("#bulk-targets")).not.toContainText("サンプル金属");
  await expect(page.locator("#bulk-targets")).not.toContainText("サンプル過去");
  await page.locator("#bulk-register").click();
  await expect(page.locator("#bulk-done-text")).toHaveText("4 件を登録しました");
  const ids = await page.evaluate(() =>
    JSON.parse(window.__gasStub.calls.filter((entry) => entry.name === "api_registerBulk")[0].args[0])
  );
  expect(ids).toEqual(["c_s01_1", "c_s02_1", "c_s06_1", "c_s04_1"]);
  // 中止のお知らせ・日程調整・過去日はそのまま候補に残る
  await expect(cardOf(page, "c_s10_1")).toHaveAttribute("data-status", "候補");
  await expect(cardOf(page, "c_s11_1")).toHaveAttribute("data-status", "候補");
  await expect(cardOf(page, "c_past_1")).toHaveAttribute("data-status", "候補");
  await expect(cardOf(page, "c_past_1")).toContainText("この日付は受信日より前です");
});

test("㉜ 編集フォームを 2 回押しても api_registerCandidate は 1 回（レビュー r1 重要 1）", async ({ page }) => {
  // サーバーの応答を遅らせて、1 回目の途中に 2 回目を送る
  await openApp(page, { delay: 500 });
  await waitList(page);
  const card = cardOf(page, "c_s01_1");
  await card.getByRole("button", { name: "編集" }).click();
  const submit = card.getByRole("button", { name: "この内容で登録" });
  await submit.click();
  // 送信中は押せない（①renderEditForm の submit にも disabled）
  await expect(card.getByRole("button", { name: "この内容で登録" })).toBeDisabled();
  await page.waitForTimeout(80);
  // 押せない状態を無視して submit イベントを送っても、②busy の門で止まる
  await card.locator('form[data-role="edit-form"]').evaluate((form) => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  await expect(card).toHaveAttribute("data-status", "登録済み");
  const calls = await page.evaluate(
    () => window.__gasStub.calls.filter((entry) => entry.name === "api_registerCandidate").length
  );
  expect(calls).toBe(1);
  await expect(page.locator('.card[data-status="登録済み"]')).toHaveCount(2);
});

// ---------- ここから UI 採点 r3（.agent-harness/SCORE-r3.md）の反映ぶん ----------

test("㉝ 変更・中止の連絡は理由の 1 行が出て、主操作が「Gmail で確認する」になる（TOP5-5）", async ({ page }) => {
  await openApp(page, {});
  await waitList(page);
  // 件名が「1次面接 中止のお知らせ」なのに 10:00〜11:00 の予定として登録できていたカード
  const card = cardOf(page, "c_s10_1");
  await expect(card.locator(".note-change")).toHaveText(
    "変更・中止の連絡です。予定の作成でなく、既に入れた予定の見直しに使ってください。"
  );
  // 理由は日時行のすぐ下（チップより上）に出す
  const order = await card.evaluate((node) =>
    Array.prototype.map.call(node.children, (child) => child.className || child.tagName)
  );
  expect(order.indexOf("note-change")).toBe(order.indexOf("card-when") + 1);
  expect(order.indexOf("note-change")).toBeLessThan(order.indexOf("card-chips"));
  // 主操作は元のメールを開くほう。登録は残すが二次操作へ落とす
  const main = card.locator(".act-main > *");
  await expect(main).toHaveCount(1);
  await expect(main).toHaveText("Gmail で確認する");
  await expect(main).toHaveAttribute("target", "_blank");
  const mainClass = await main.getAttribute("class");
  expect(mainClass).toContain("btn-strong");
  const sub = await card.locator(".act-sub > *").evaluateAll((nodes) =>
    nodes.map((node) => [String(node.textContent || "").trim(), node.className])
  );
  expect(sub.map((entry) => entry[0])).toEqual(["登録", "編集", "無視"]);
  expect(sub[0][1]).toContain("btn-quiet");
  expect(sub[0][1]).not.toContain("btn-strong");
  // 変更後の新しい日時を入れたい場合があるので、押せば登録はできる
  await card.getByRole("button", { name: "登録", exact: true }).click();
  await expect(card).toHaveAttribute("data-status", "登録済み");
  // 日時が無い変更の連絡（c_s09_1）も同じ主操作にそろえる
  const empty = cardOf(page, "c_s09_1");
  await expect(empty.locator(".note-change")).toBeVisible();
  await expect(empty.locator(".act-main > *")).toHaveText("Gmail で確認する");
  await expect(empty.getByRole("button", { name: "登録", exact: true })).toHaveCount(0);
});

test("㉞ 必須が欠けたカードは 1 ルール（主操作＋直下の理由 1 行）でそろう（TOP5-1）", async ({ page }) => {
  await openApp(page, {
    extraCandidates: [
      {
        id: "c_nodate_2",
        messageId: "m_nodate2",
        kind: "interview",
        company: "株式会社サンプル部品",
        title: "【面接】株式会社サンプル部品",
        subject: "面接のご案内（日程は追ってご連絡します）",
        confidence: "low",
      },
    ],
  });
  await waitList(page);

  /** 操作行の並び（主操作 → 理由 → 二次操作）を取り出す */
  const shapeOf = (card) =>
    card.locator(".actions > *").evaluateAll((nodes) =>
      nodes.map((node) => [node.className, String(node.textContent || "").trim()])
    );

  // ① 企業名が無い（日時はある）→「登録」は出すが無効の見た目。理由は主操作の直下
  const noCompany = await shapeOf(cardOf(page, "c_s08_1"));
  expect(noCompany[0][0]).toContain("act-main");
  expect(noCompany[0][1]).toBe("登録");
  expect(noCompany[1][0]).toContain("hint-company");
  expect(noCompany[1][1]).toBe("企業名を入れてから登録してください");
  expect(noCompany[2][0]).toContain("act-sub");

  // ② 日時が無い →「登録」を出さず「編集して日時を入れる」。理由の位置は ① と同じ
  const noDate = await shapeOf(cardOf(page, "c_nodate_2"));
  expect(noDate[0][0]).toContain("act-main");
  expect(noDate[0][1]).toBe("編集して日時を入れる");
  expect(noDate[1][0]).toContain("hint-plan");
  expect(noDate[1][1]).toContain("日付がありません");
  expect(noDate[2][0]).toContain("act-sub");
  expect(noCompany[1][0].replace("hint-company", "")).toBe(noDate[1][0].replace("hint-plan", ""));

  // ③ 必須がそろっているカードは理由の行を持たない（無効の見た目にもしない）
  const ok = await shapeOf(cardOf(page, "c_s01_1"));
  expect(ok.length).toBe(2);
  const okRegister = cardOf(page, "c_s01_1").getByRole("button", { name: "登録", exact: true });
  expect(await okRegister.getAttribute("aria-disabled")).toBe(null);
});

test("㉟ 登録済みの 1 行目は 390 で折り返さず、「取り消す」は行の右端（TOP5-3）", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openApp(page, {});
  await waitList(page);
  const card = cardOf(page, "c_s15_1");
  // ラベルと日時は別の行。日時そのものは 1 行に収まる（「11:00〜」で切れない）
  await expect(card.locator(".when-label")).toHaveText("✓ 登録済み");
  const when = await card.locator(".when").evaluate((node) => ({
    lines: node.getClientRects().length,
    text: String(node.textContent || ""),
    parts: Array.prototype.map.call(node.children, (child) => ({
      text: String(child.textContent || ""),
      wrap: getComputedStyle(child).whiteSpace,
      lines: child.getClientRects().length,
    })),
  }));
  expect(when.text).toBe("3/4（水）11:00〜12:00");
  expect(when.lines).toBe(1);
  expect(when.parts.map((part) => part.text)).toEqual(["3/4（水）", "11:00〜12:00"]);
  for (const part of when.parts) {
    expect(part.wrap).toBe("nowrap");
    expect(part.lines).toBe(1);
  }
  // 操作行が 2 行に割れても「取り消す」だけが左に残らない
  const row = await card.locator(".act-sub").boundingBox();
  const undo = await card.getByRole("button", { name: "取り消す" }).boundingBox();
  expect(undo.x + undo.width).toBeGreaterThan(row.x + row.width - 1);
});

test("㊱ 単体の登録・取り消しも上部の帯で返し、帯から 1 件だけ戻せる（TOP5-4）", async ({ page }) => {
  await openApp(page, {});
  await waitList(page);
  const card = cardOf(page, "c_s01_1");
  await card.getByRole("button", { name: "登録", exact: true }).click();
  await expect(card).toHaveAttribute("data-status", "登録済み");
  // 帯に結果と「元に戻す」（まとめ登録のときと同じ場所）
  await expect(page.locator("#bulk-done-text")).toHaveText("カレンダーに登録しました。下の「登録済み」に移りました");
  const undo = page.locator("#bulk-undo");
  await expect(undo).toBeVisible();
  await expect(undo).toHaveText("元に戻す");
  await undo.click();
  // 戻したのはその 1 件だけ（もとから登録済みの 1 件は残る）
  await expect(card).toHaveAttribute("data-status", "候補");
  await expect(page.locator('.card[data-status="登録済み"]')).toHaveCount(1);
  const undone = await page.evaluate(() =>
    window.__gasStub.calls.filter((entry) => entry.name === "api_undoRegister").map((entry) => entry.args[0])
  );
  expect(undone).toEqual(["c_s01_1"]);
  // 取り消しの結果も同じ帯で返る（戻すボタンは消える）
  await expect(page.locator("#bulk-done-text")).toHaveText("登録を取り消しました。「候補」に戻しました");
  await expect(undo).toBeHidden();
  await expect(page.locator("#notice")).toHaveText("");
});
