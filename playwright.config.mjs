// Playwright はローカルの開発ツールとしてインストールして使用する。
// 確認画面は HtmlService で配るものだが、テストでは同じファイルを file:// で開き、
// google.script.run を tests/e2e/gas-stub.js で差し替えて動かす（Google には触らない）。
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  reporter: "list",
  timeout: 30000,
  workers: 1,
  use: {
    headless: true,
    launchOptions: {
      args: ["--allow-file-access-from-files"],
    },
  },
});
