/**
 * screenshots.mjs — 採点用のスクリーンショット（.agent-harness/RUBRIC-ui.md）
 *
 *   node tools/screenshots.mjs --round 1
 *   → .agent-harness/shots/r1/<状態>-<幅>[-full|-dark|-focus].png
 *
 * 撮るのは 390／768／1440 × `empty`／`list`／`list-registered`／`error`、＋ダーク 1 枚・フォーカス 1 枚。
 * 実物は Apps Script の Web アプリだが、ここでは同じ HTML を file:// で開き、
 * `tests/e2e/gas-stub.js` でサーバーを差し替える（Google には触らない）。
 *
 * 縦に長い一覧は「画面に収まる範囲（viewport）」と「全体（fullPage）」の両方を撮る。
 * 採点者は前者で第一印象を、後者で並びの構造を見る。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "@playwright/test";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PAGE_URL = "file://" + path.join(ROOT, "src/ui/index.html");
const STUB_PATH = path.join(ROOT, "tests/e2e/gas-stub.js");
const WIDTHS = [390, 768, 1440];
const HEIGHTS = { 390: 844, 768: 1024, 1440: 900 };

function parseRound(argv) {
  const index = argv.indexOf("--round");
  if (index >= 0 && argv[index + 1]) return String(argv[index + 1]);
  return "1";
}

/** スタブの設定を先に入れてから開く */
async function openApp(page, config) {
  await page.addInitScript("window.__gasStubConfig = " + JSON.stringify(config || {}) + ";");
  await page.addInitScript({ path: STUB_PATH });
  await page.goto(PAGE_URL);
}

function waitState(page, name) {
  return page.waitForFunction(
    (want) => {
      const main = document.querySelector("main");
      return main && main.getAttribute("data-state") === want;
    },
    name,
    { timeout: 15000 }
  );
}

/** 描画が落ち着いてから撮る（途中の姿を採点させない） */
async function settle(page) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
}

async function main() {
  const round = parseRound(process.argv);
  const outDir = path.join(ROOT, ".agent-harness", "shots", "r" + round);
  await fs.mkdir(outDir, { recursive: true });

  const browser = await chromium.launch({ args: ["--allow-file-access-from-files"] });
  const written = [];

  /**
   * 1 枚（または viewport と fullPage の 2 枚）撮る。
   * @param {{name: string, width: number, state: string, config: object,
   *          colorScheme?: string, after?: Function, full?: boolean}} job
   */
  async function shoot(job) {
    const context = await browser.newContext({
      viewport: { width: job.width, height: HEIGHTS[job.width] || 900 },
      colorScheme: job.colorScheme || "light",
      deviceScaleFactor: 2,
    });
    const page = await context.newPage();
    await openApp(page, job.config);
    await waitState(page, job.state);
    if (job.after) await job.after(page);
    await settle(page);

    const file = path.join(outDir, job.name + ".png");
    await page.screenshot({ path: file });
    written.push(path.basename(file));

    if (job.full) {
      const fullFile = path.join(outDir, job.name + "-full.png");
      await page.screenshot({ path: fullFile, fullPage: true });
      written.push(path.basename(fullFile));
    }
    await context.close();
  }

  /** 1 件登録した直後の一覧（登録済みカードの見え方を採点してもらう） */
  async function registerFirst(page) {
    await page.click('.card[data-id="c_s01_1"] button[data-action="register"]');
    await page.waitForFunction(() => {
      const card = document.querySelector('.card[data-id="c_s01_1"]');
      return card && card.getAttribute("data-status") === "登録済み";
    });
  }

  /** まとめて登録した直後（上部の帯と「まとめて取り消す」を採点してもらう） */
  async function registerBulk(page) {
    await page.click("#bulk-register");
    await page.waitForFunction(() => {
      const banner = document.getElementById("bulk-done");
      return banner && banner.hidden === false;
    });
  }

  /** ノイズ・無視の折りたたみを開いた状態 */
  async function openNoise(page) {
    await page.click("#group-noise summary");
    await page.waitForFunction(() => {
      const box = document.getElementById("group-noise");
      return box && box.open === true;
    });
  }

  for (let i = 0; i < WIDTHS.length; i += 1) {
    const width = WIDTHS[i];
    await shoot({ name: "empty-" + width, width: width, state: "empty", config: { mode: "empty" } });
    await shoot({ name: "list-" + width, width: width, state: "list", config: {}, full: true });
    await shoot({
      name: "list-registered-" + width,
      width: width,
      state: "list",
      config: {},
      after: registerFirst,
      full: true,
    });
    await shoot({ name: "error-" + width, width: width, state: "error", config: { mode: "error" } });
  }

  // まとめて登録した直後（帯・P2）とノイズを開いた状態（P4）
  await shoot({ name: "list-390-bulk-done", width: 390, state: "list", config: {}, after: registerBulk, full: true });
  await shoot({ name: "list-390-noise-open", width: 390, state: "list", config: {}, after: openNoise });

  // ダーク（表層の確認）
  await shoot({ name: "list-390-dark", width: 390, state: "list", config: {}, colorScheme: "dark" });

  // フォーカスリング（NFR-06）
  await shoot({
    name: "list-390-focus",
    width: 390,
    state: "list",
    config: {},
    after: async (page) => {
      await page.focus('.card[data-id="c_s01_1"] button[data-action="register"]');
    },
  });

  await browser.close();
  written.sort();
  console.log("撮った枚数: " + written.length + " → " + path.relative(ROOT, outDir));
  for (let i = 0; i < written.length; i += 1) console.log("  " + written[i]);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
