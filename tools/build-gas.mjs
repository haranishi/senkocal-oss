/**
 * build-gas.mjs — 貼るだけの 3 ファイルを作る（FR-13・K-10）
 *
 *   node tools/build-gas.mjs
 *   → dist/Code.gs        src/core/*.js＋src/gas/*.js を 1 本に連結したもの
 *   → dist/index.html     src/ui/index.html をそのまま
 *   → dist/appsscript.json src/manifest/appsscript.json をそのまま
 *
 * 変換は 2 つだけ。①`import` 文（複数行も）を丸ごと落とす ②行頭の `export ` を剥がす。
 * GAS は ESM を読めないが、連結すればすべてが同じグローバルに並ぶので、これで動く。
 * その代わり **トップレベルの名前が重複してはいけない**（tests/policy.test.mjs で固定）。
 *
 * 出したあとに検査する: import／export／require が残っていない・制御文字が無い・`node --check` が通る。
 * 生成物に日付を入れない（同じ入力なら同じ出力＝差分で中身の変化だけが見える）。
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** 連結する順番。上流（文字列処理）から下流（GAS のエントリ）へ */
const CORE_ORDER = [
  "text.js",
  "dates.js",
  "company.js",
  "classify.js",
  "parse.js",
  "events.js",
  "settings.js",
  "ledger.js",
  "query.js",
];
const GAS_ORDER = ["adapters.js", "app.js"];

/** 出荷物に混ざってはいけない制御文字（NUL など。貼り付けで壊れる） */
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

/** `import` 文を落とし、行頭の `export ` を剥がす */
function stripModuleSyntax(text) {
  const lines = text.split("\n");
  const out = [];
  let inImport = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (inImport) {
      if (/;\s*$/.test(line)) inImport = false;
      continue;
    }
    if (/^import\s/.test(line) || /^import\{/.test(line)) {
      if (!/;\s*$/.test(line)) inImport = true;
      continue;
    }
    out.push(line.replace(/^export\s+/, ""));
  }
  return out.join("\n").replace(/^\n+/, "").replace(/\n+$/, "");
}

/** banner.txt を JSDoc コメントに包む */
function bannerComment(text) {
  const lines = text.replace(/\n+$/, "").split("\n");
  const out = ["/**"];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    out.push(line === "" ? " *" : " * " + line);
  }
  out.push(" */");
  return out.join("\n");
}

/** src/core の取りこぼしが無いか（新しいモジュールを足したのに連結し忘れる事故を防ぐ） */
function assertAllSourcesListed(dir, listed) {
  const actual = fs
    .readdirSync(path.join(ROOT, dir))
    .filter((name) => name.endsWith(".js"))
    .sort();
  const missing = actual.filter((name) => listed.indexOf(name) < 0);
  if (missing.length > 0) {
    throw new Error(dir + " に連結対象から漏れているファイルがある: " + missing.join(", "));
  }
}

function main() {
  assertAllSourcesListed("src/core", CORE_ORDER);
  assertAllSourcesListed("src/gas", GAS_ORDER);

  const parts = [];
  parts.push(bannerComment(fs.readFileSync(path.join(ROOT, "src/gas/banner.txt"), "utf8")));
  parts.push(
    [
      "",
      "// このファイルは tools/build-gas.mjs が作った生成物です。ここを直しても次のビルドで消えます。",
      "// 直すのは src/core/*.js・src/gas/*.js・src/ui/index.html のほうです（npm run build で作り直す）。",
      "",
    ].join("\n")
  );

  const sources = [];
  for (let i = 0; i < CORE_ORDER.length; i += 1) sources.push("src/core/" + CORE_ORDER[i]);
  for (let i = 0; i < GAS_ORDER.length; i += 1) sources.push("src/gas/" + GAS_ORDER[i]);

  for (let i = 0; i < sources.length; i += 1) {
    const relative = sources[i];
    const text = fs.readFileSync(path.join(ROOT, relative), "utf8");
    parts.push("// ===== " + relative + " =====");
    parts.push(stripModuleSyntax(text));
    parts.push("");
  }

  const code = parts.join("\n") + "\n";

  const distDir = path.join(ROOT, "dist");
  fs.mkdirSync(distDir, { recursive: true });
  const codePath = path.join(distDir, "Code.gs");
  fs.writeFileSync(codePath, code, "utf8");

  const htmlPath = path.join(distDir, "index.html");
  fs.copyFileSync(path.join(ROOT, "src/ui/index.html"), htmlPath);
  const manifestPath = path.join(distDir, "appsscript.json");
  fs.copyFileSync(path.join(ROOT, "src/manifest/appsscript.json"), manifestPath);

  // ---- 検査（ここから下は「出してよいか」の門） ----
  const problems = [];
  if (/^\s*import\s/m.test(code)) problems.push("dist/Code.gs に import が残っている");
  if (/^\s*export\s/m.test(code)) problems.push("dist/Code.gs に export が残っている");
  if (/\brequire\s*\(/.test(code)) problems.push("dist/Code.gs に require( が残っている");
  const control = CONTROL_CHARS.exec(code);
  if (control) {
    const upto = code.slice(0, control.index).split("\n").length;
    problems.push(
      "dist/Code.gs に制御文字（U+" +
        control[0].charCodeAt(0).toString(16).toUpperCase() +
        "）が " +
        upto +
        " 行目にある。貼り付けで壊れるのでソースを直す"
    );
  }
  const html = fs.readFileSync(htmlPath, "utf8");
  if (/<base\s/i.test(html)) problems.push("dist/index.html に <base> がある（HtmlService のサンドボックスでは使わない）");
  if (/(src|href)\s*=\s*["']https?:/i.test(html)) problems.push("dist/index.html が外部のファイルを読んでいる");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if ((manifest.oauthScopes || []).length !== 4) problems.push("dist/appsscript.json のスコープが 4 つでない");

  if (problems.length > 0) {
    for (let i = 0; i < problems.length; i += 1) console.error("NG: " + problems[i]);
    process.exit(1);
  }

  // 構文検査。`.gs` は Node が形式を判定できないので、標準入力に流して script として読ませる
  // （同じことを手でやるなら `node --input-type=commonjs --check < dist/Code.gs`）
  try {
    execFileSync(process.execPath, ["--check", "--input-type=commonjs"], {
      input: code,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (err) {
    console.error("NG: dist/Code.gs の構文検査が落ちた");
    console.error(String(err.stderr || err.message || err));
    process.exit(1);
  }

  // 末尾の改行は「次の行の始まり」ではないので数えない（`wc -l` と同じ数にする・レビュー r2 軽微 3）
  const countLines = (text) => text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
  console.log("OK dist/Code.gs         " + countLines(code) + " 行 / " + Buffer.byteLength(code, "utf8") + " バイト");
  console.log("OK dist/index.html      " + countLines(html) + " 行 / " + Buffer.byteLength(html, "utf8") + " バイト");
  console.log(
    "OK dist/appsscript.json " +
      countLines(fs.readFileSync(manifestPath, "utf8")) +
      " 行 / スコープ " +
      manifest.oauthScopes.length +
      " つ"
  );
  console.log("連結: " + sources.length + " ファイル（" + sources.join(" → ") + "）");
}

main();
