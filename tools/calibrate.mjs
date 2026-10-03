#!/usr/bin/env node
/**
 * calibrate.mjs — 実メールで抽出の当たり外れを見るための表を出す（FR-14）
 *
 * 合成 fixture で全部通っても、実物の書き方は違う。外れている行を見つけて
 * `src/core/` の辞書と正規表現を直す、その周回のための道具。
 *
 *   node tools/calibrate.mjs            # tests/fixtures/real/ があればそれ、無ければ合成 fixture
 *   node tools/calibrate.mjs --mails    # 合成 fixture を明示して使う
 *   node tools/calibrate.mjs --json     # 表ではなく JSON で出す
 *
 * 実メール（本人がエクスポートしたもの）は tests/fixtures/real/ に置く。
 * このフォルダは .gitignore 済みで、git にもテストにも入らない（K-9）。
 * 期待値を tests/fixtures/real/expected/<同名>.json に置くと、項目ごとの一致率も出る。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseMailWithMeta } from "../src/core/parse.js";

// `| head` や `| less` で途中で閉じられても落ちないようにする
process.stdout.on("error", function (error) {
  if (error && error.code === "EPIPE") process.exit(0);
  throw error;
});

const root = fileURLToPath(new URL("..", import.meta.url));
const REAL_DIR = path.join(root, "tests/fixtures/real");
const MAILS_DIR = path.join(root, "tests/fixtures/mails");
const EXPECTED_KEYS = ["kind", "company", "start", "deadline", "confidence", "stage", "media"];

/** 全角を 2 文字ぶんとして数える（表の桁を揃えるため） */
function displayWidth(text) {
  let width = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    const wide =
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6);
    width += wide ? 2 : 1;
  }
  return width;
}

/** 表示幅で切って右を空白で埋める（列の間には必ず 1 文字ぶんの空きを残す） */
function pad(text, width) {
  const source = text === null || text === undefined ? "" : String(text).replace(/\s+/g, " ");
  const limit = width - 1;
  let value = source;
  if (displayWidth(value) > limit) {
    while (displayWidth(value) > limit - 1) value = value.slice(0, -1);
    value += "…";
  }
  let out = value;
  for (let i = displayWidth(value); i < width; i += 1) out += " ";
  return out;
}

/** ISO を「2026-03-05 14:00」の形に縮める（表で読みやすくするだけ） */
function compactIso(iso) {
  if (!iso) return "-";
  const text = String(iso);
  return text.length > 10 ? text.slice(0, 10) + " " + text.slice(11, 16) : text;
}

/** JSON ファイルを読む（読めなければ null） */
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    process.stderr.write("読めませんでした: " + file + " (" + error.message + ")\n");
    return null;
  }
}

/** 対象のメールを集める */
function collectMails() {
  const useMails = process.argv.indexOf("--mails") >= 0;
  const realFiles = fs.existsSync(REAL_DIR)
    ? fs.readdirSync(REAL_DIR).filter((name) => name.endsWith(".json"))
    : [];
  if (!useMails && realFiles.length > 0) {
    return { dir: REAL_DIR, files: realFiles.sort(), source: "real" };
  }
  const files = fs.existsSync(MAILS_DIR) ? fs.readdirSync(MAILS_DIR).filter((n) => n.endsWith(".json")) : [];
  return { dir: MAILS_DIR, files: files.sort(), source: "mails" };
}

/** 期待値（あれば）を読む */
function readExpected(dir, name) {
  const file = path.join(dir, "expected", name);
  if (!fs.existsSync(file)) return null;
  return readJson(file);
}

const target = collectMails();
const asJson = process.argv.indexOf("--json") >= 0;
const rows = [];
const stats = { total: 0, noise: 0, candidates: 0, byKind: {}, byConfidence: {} };
const score = {};
for (let i = 0; i < EXPECTED_KEYS.length; i += 1) score[EXPECTED_KEYS[i]] = { hit: 0, total: 0 };

for (let i = 0; i < target.files.length; i += 1) {
  const name = target.files[i];
  const mail = readJson(path.join(target.dir, name));
  if (!mail) continue;
  const meta = parseMailWithMeta(mail);
  const first = meta.candidates.length > 0 ? meta.candidates[0] : null;
  stats.total += 1;
  if (meta.isNoise) stats.noise += 1;
  stats.candidates += meta.candidates.length;
  stats.byKind[meta.kind] = (stats.byKind[meta.kind] || 0) + 1;
  const confidence = first ? first.confidence : "-";
  stats.byConfidence[confidence] = (stats.byConfidence[confidence] || 0) + 1;

  rows.push({
    file: name,
    subject: mail.subject || "",
    kind: meta.kind,
    stage: first ? first.stage : null,
    company: first ? first.company : null,
    media: first ? first.media : null,
    start: first ? first.start : null,
    deadline: first ? first.deadline : null,
    confidence: confidence,
    noise: meta.isNoise,
    count: meta.candidates.length,
  });

  const expected = readExpected(target.dir, name);
  if (!expected) continue;
  const actual = first || {};
  for (let k = 0; k < EXPECTED_KEYS.length; k += 1) {
    const key = EXPECTED_KEYS[k];
    if (!(key in expected)) continue;
    score[key].total += 1;
    const want = expected[key] === undefined ? null : expected[key];
    const got = actual[key] === undefined ? null : actual[key];
    if (JSON.stringify(want) === JSON.stringify(got)) score[key].hit += 1;
  }
}

if (asJson) {
  process.stdout.write(JSON.stringify({ source: target.source, rows: rows, stats: stats, score: score }, null, 2) + "\n");
} else {
  const header =
    target.source === "real"
      ? "較正: 実メール " + rows.length + " 通（" + path.relative(root, target.dir) + "）"
      : "較正: 合成 fixture " + rows.length + " 通（" +
        path.relative(root, target.dir) +
        "）。実メールは tests/fixtures/real/ に置くとそちらを使う";
  process.stdout.write(header + "\n");
  process.stdout.write(
    pad("ファイル", 12) + pad("件名", 40) + pad("種別", 22) + pad("企業名", 26) + pad("開始", 18) + pad("締切", 18) + pad("確度", 8) + "件数\n"
  );
  process.stdout.write("-".repeat(148) + "\n");
  for (let i = 0; i < rows.length; i += 1) {
    const r = rows[i];
    process.stdout.write(
      pad(r.file, 12) +
        pad(r.subject, 40) +
        pad(r.noise ? "ノイズ" : r.kind + (r.stage ? "/" + r.stage : ""), 22) +
        pad(r.company === null ? "（取れず）" : r.company, 26) +
        pad(compactIso(r.start), 18) +
        pad(compactIso(r.deadline), 18) +
        pad(r.confidence, 8) +
        String(r.count) +
        "\n"
    );
  }
  process.stdout.write("\n");
  process.stdout.write(
    "合計 " + stats.total + " 通 / 候補 " + stats.candidates + " 件 / ノイズ " + stats.noise + " 通\n"
  );
  const kinds = Object.keys(stats.byKind).sort();
  const kindLine = [];
  for (let i = 0; i < kinds.length; i += 1) kindLine.push(kinds[i] + " " + stats.byKind[kinds[i]]);
  process.stdout.write("種別: " + kindLine.join(" / ") + "\n");
  const levels = Object.keys(stats.byConfidence).sort();
  const confLine = [];
  for (let i = 0; i < levels.length; i += 1) confLine.push(levels[i] + " " + stats.byConfidence[levels[i]]);
  process.stdout.write("確度: " + confLine.join(" / ") + "\n");

  let scored = false;
  for (let i = 0; i < EXPECTED_KEYS.length; i += 1) if (score[EXPECTED_KEYS[i]].total > 0) scored = true;
  if (scored) {
    process.stdout.write("\n一致率（expected/ と突き合わせ）\n");
    for (let i = 0; i < EXPECTED_KEYS.length; i += 1) {
      const key = EXPECTED_KEYS[i];
      if (score[key].total === 0) continue;
      const rate = Math.round((score[key].hit / score[key].total) * 1000) / 10;
      process.stdout.write(
        "  " + pad(key, 12) + score[key].hit + "/" + score[key].total + " (" + rate + "%)\n"
      );
    }
  } else if (target.source === "real") {
    process.stdout.write("\n期待値ファイル（tests/fixtures/real/expected/）が無いので一致率は出していない\n");
  }
}
