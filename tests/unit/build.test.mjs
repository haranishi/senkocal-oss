/**
 * build.test.mjs — 貼るだけの 3 ファイル（K-10・FR-13）
 *
 * GAS で動かして確かめられない以上、「連結したものが本当に動くか」はここでしか分からない。
 * だから **連結結果をその場で評価して `parseMail` を走らせる**（構文が通るだけでは足りない）。
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("./../..", import.meta.url));
const distDir = path.join(root, "dist");
const codePath = path.join(distDir, "Code.gs");

/** ビルドを実行して dist を作り直す */
function runBuild() {
  return execFileSync(process.execPath, [path.join(root, "tools/build-gas.mjs")], {
    cwd: root,
    encoding: "utf8",
  });
}

const buildOutput = runBuild();
const code = fs.readFileSync(codePath, "utf8");

test("ビルドが 3 ファイルを出す（それ以外は置かない）", () => {
  const names = fs.readdirSync(distDir).sort();
  assert.deepEqual(names, ["Code.gs", "appsscript.json", "index.html"]);
  assert.ok(buildOutput.indexOf("OK dist/Code.gs") >= 0, buildOutput);
});

test("K-10: dist/Code.gs に import／export／require が無い", () => {
  assert.equal(/^\s*import\s/m.test(code), false);
  assert.equal(/^\s*export\s/m.test(code), false);
  assert.equal(/\brequire\s*\(/.test(code), false);
});

test("dist/Code.gs の構文が通る（script として読める）", () => {
  assert.doesNotThrow(() =>
    execFileSync(process.execPath, ["--check", "--input-type=commonjs"], { input: code, stdio: "pipe" })
  );
});

test("連結したコードを評価すると parseMail が動く（貼れば動くことの証明）", () => {
  const mail = JSON.parse(fs.readFileSync(path.join(root, "tests/fixtures/mails/01.json"), "utf8"));
  const expected = JSON.parse(fs.readFileSync(path.join(root, "tests/fixtures/expected/01.json"), "utf8"));
  const factory = new Function(
    code + "\nreturn {parseMail: parseMail, buildEventPlan: buildEventPlan, buildGmailQuery: buildGmailQuery, SETTINGS_DEFAULTS: SETTINGS_DEFAULTS};"
  );
  const bundle = factory();
  const candidates = bundle.parseMail(mail);
  assert.equal(candidates.length, expected.candidates.length);
  assert.equal(candidates[0].start, expected.candidates[0].start);
  assert.equal(candidates[0].company, expected.candidates[0].company);
  const plan = bundle.buildEventPlan(candidates[0], bundle.SETTINGS_DEFAULTS);
  assert.equal(plan.type, "timed");
  assert.ok(bundle.buildGmailQuery(bundle.SETTINGS_DEFAULTS).indexOf("newer_than:") === 0);
});

test("連結したコードに GAS のエントリがトップレベルで並ぶ", () => {
  const names = [
    "setup",
    "importMail",
    "createTrigger",
    "deleteTriggers",
    "doGet",
    "api_listCandidates",
    "api_registerCandidate",
    "api_registerBulk",
    "api_ignoreCandidate",
    "api_restoreCandidate",
    "api_undoRegister",
    "api_importNow",
  ];
  for (let i = 0; i < names.length; i += 1) {
    assert.ok(new RegExp("^function " + names[i] + "\\(", "m").test(code), names[i] + " がトップレベルに無い");
  }
});

test("冒頭に使い方コメント（仕組み・前提・使い方・安全設計・危険な関数）がある", () => {
  const head = code.slice(0, 3000);
  assert.ok(head.indexOf("/**") === 0);
  assert.ok(head.indexOf("仕組み:") > 0);
  assert.ok(head.indexOf("前提:") > 0);
  assert.ok(head.indexOf("使い方") > 0);
  assert.ok(head.indexOf("安全設計:") > 0);
  assert.ok(head.indexOf("危険な関数:") > 0);
});

test("モジュールの境目が読める形で入っている", () => {
  const markers = [
    "// ===== src/core/text.js =====",
    "// ===== src/core/dates.js =====",
    "// ===== src/core/company.js =====",
    "// ===== src/core/classify.js =====",
    "// ===== src/core/parse.js =====",
    "// ===== src/core/events.js =====",
    "// ===== src/core/settings.js =====",
    "// ===== src/core/ledger.js =====",
    "// ===== src/core/query.js =====",
    "// ===== src/gas/adapters.js =====",
    "// ===== src/gas/app.js =====",
  ];
  let cursor = -1;
  for (let i = 0; i < markers.length; i += 1) {
    const at = code.indexOf(markers[i]);
    assert.ok(at > cursor, markers[i] + " が無いか順番が違う");
    cursor = at;
  }
});

test("制御文字（NUL など）が出荷物に入らない", () => {
  const bad = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.exec(code);
  assert.equal(bad, null, bad ? "U+" + bad[0].charCodeAt(0).toString(16) + " が入っている" : "");
  const html = fs.readFileSync(path.join(distDir, "index.html"), "utf8");
  assert.equal(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(html), false);
});

test("K-6: dist/appsscript.json のスコープと Web アプリの設定", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(distDir, "appsscript.json"), "utf8"));
  assert.deepEqual(manifest.oauthScopes.slice().sort(), [
    "https://www.googleapis.com/auth/calendar.events",
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/script.scriptapp",
    "https://www.googleapis.com/auth/spreadsheets",
  ]);
  assert.equal(manifest.timeZone, "Asia/Tokyo");
  assert.equal(manifest.runtimeVersion, "V8");
  assert.deepEqual(manifest.webapp, { executeAs: "USER_DEPLOYING", access: "MYSELF" });
});

test("dist/index.html は src/ui/index.html と同じもの（外部参照なし）", () => {
  const built = fs.readFileSync(path.join(distDir, "index.html"), "utf8");
  const source = fs.readFileSync(path.join(root, "src/ui/index.html"), "utf8");
  assert.equal(built, source);
  assert.equal(/<base\s/i.test(built), false);
  assert.equal(/(src|href)\s*=\s*["']https?:/i.test(built), false);
  assert.equal(built.indexOf("google.script.run") >= 0, true);
});

test("同じ入力なら同じ出力（生成物に日付を混ぜない）", () => {
  const before = fs.readFileSync(codePath);
  runBuild();
  const after = fs.readFileSync(codePath);
  assert.ok(before.equals(after));
});
