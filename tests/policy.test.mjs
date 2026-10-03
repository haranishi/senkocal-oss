/**
 * policy.test.mjs — 設計制約（docs/01 §2 の K-1〜K-10）をコードで固定する。
 *
 * ここが通らないコードは、たとえ機能が動いても入れない。
 * 「メールを読むだけ・外に出さない・自動で登録しない・貼るだけで入る」を、
 * 人のレビューではなく機械が毎回確かめるための壁。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { MEDIA_DOMAINS } from "../src/core/company.js";

const root = fileURLToPath(new URL("./..", import.meta.url));

/** 再帰的にファイルを集める */
function collectFiles(dir, extensions) {
  const full = path.join(root, dir);
  if (!fs.existsSync(full)) return [];
  const out = [];
  const walk = (current) => {
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (let i = 0; i < entries.length; i += 1) {
      const entry = entries[i];
      const next = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(next);
      } else if (extensions.some((ext) => entry.name.endsWith(ext))) {
        out.push({ path: path.relative(root, next), text: fs.readFileSync(next, "utf8") });
      }
    }
  };
  walk(full);
  return out;
}

const shippingFiles = collectFiles("src", [".js", ".html", ".json", ".txt"]);
const fixtureFiles = collectFiles("tests/fixtures/mails", [".json"]);

test("前提: 出荷コード（src/）が 1 本以上ある", () => {
  assert.ok(shippingFiles.length > 0);
});

test("K-3/K-4: 出荷コードに外部通信とメール送信の API を書かない", () => {
  const banned = [
    { pattern: /UrlFetchApp/, why: "外部通信（K-4）" },
    { pattern: /XMLHttpRequest/, why: "外部通信（K-4）" },
    { pattern: /(^|[^.\w])fetch\s*\(/m, why: "外部通信（K-4）" },
    { pattern: /MailApp/, why: "メール送信（K-3）" },
    { pattern: /sendEmail/, why: "メール送信（K-3）" },
    { pattern: /createDraft/, why: "下書き作成（K-3）" },
  ];
  for (let i = 0; i < shippingFiles.length; i += 1) {
    for (let j = 0; j < banned.length; j += 1) {
      assert.ok(
        !banned[j].pattern.test(shippingFiles[i].text),
        shippingFiles[i].path + " に " + banned[j].why + " が書かれている"
      );
    }
  }
});

test("K-3: メールを書き換える API（ラベル・既読・移動・スター）を書かない", () => {
  const banned = [/addLabel/, /removeLabel/, /markRead/, /markUnread/, /moveTo/, /moveThread/, /markStarred/, /\.star\s*\(/];
  for (let i = 0; i < shippingFiles.length; i += 1) {
    for (let j = 0; j < banned.length; j += 1) {
      assert.ok(
        !banned[j].test(shippingFiles[i].text),
        shippingFiles[i].path + " に " + String(banned[j]) + " が書かれている（メールは読むだけ）"
      );
    }
  }
});

test("K-4: LLM・外部 API の呼び出しらしき語を書かない", () => {
  const banned = [/openai/i, /anthropic/i, /\bgemini\b/i, /api[_-]?key/i, /Authorization:\s*Bearer/i];
  for (let i = 0; i < shippingFiles.length; i += 1) {
    for (let j = 0; j < banned.length; j += 1) {
      assert.ok(
        !banned[j].test(shippingFiles[i].text),
        shippingFiles[i].path + " に " + String(banned[j]) + " が書かれている（本文を外に出さない）"
      );
    }
  }
});

test("K-1: 媒体サイトへ HTTP でアクセスするコードを書かない", () => {
  const domains = [];
  const names = Object.keys(MEDIA_DOMAINS);
  for (let i = 0; i < names.length; i += 1) {
    for (let j = 0; j < MEDIA_DOMAINS[names[i]].length; j += 1) domains.push(MEDIA_DOMAINS[names[i]][j]);
  }
  for (let i = 0; i < shippingFiles.length; i += 1) {
    for (let j = 0; j < domains.length; j += 1) {
      const pattern = new RegExp("https?://[^\\s\"'`]*" + domains[j].replace(/\./g, "\\."));
      assert.ok(
        !pattern.test(shippingFiles[i].text),
        shippingFiles[i].path + " に " + domains[j] + " への URL がある（取り込み元は Gmail だけ）"
      );
    }
  }
});

test("K-2: 取り込みの純関数がカレンダーに触れない", () => {
  const core = collectFiles("src/core", [".js"]);
  for (let i = 0; i < core.length; i += 1) {
    assert.ok(!/CalendarApp/.test(core[i].text), core[i].path + " が CalendarApp を触っている");
    assert.ok(!/GmailApp/.test(core[i].text), core[i].path + " が GmailApp を触っている");
    assert.ok(!/SpreadsheetApp/.test(core[i].text), core[i].path + " が SpreadsheetApp を触っている");
  }
});

test("GAS(V8) に無い構文・API を使わない", () => {
  const banned = [
    { pattern: /structuredClone\s*\(/, why: "structuredClone" },
    { pattern: /\.at\s*\(/, why: "Array.prototype.at" },
    { pattern: /Object\.hasOwn\s*\(/, why: "Object.hasOwn" },
    { pattern: /\?\?=/, why: "??=" },
    { pattern: /\|\|=/, why: "||=" },
    { pattern: /Intl\./, why: "Intl" },
    { pattern: /toLocale/, why: "toLocale*" },
    { pattern: /\brequire\s*\(/, why: "require（GAS では動かない）" },
    { pattern: /\bprocess\./, why: "process（GAS には無い）" },
  ];
  for (let i = 0; i < shippingFiles.length; i += 1) {
    for (let j = 0; j < banned.length; j += 1) {
      assert.ok(
        !banned[j].pattern.test(shippingFiles[i].text),
        shippingFiles[i].path + " に " + banned[j].why + " が使われている"
      );
    }
  }
});

test("K-8: ローカル時刻の Date API を使わない（TZ 非依存）", () => {
  const banned = [
    // new Date(2026, 2, 5) や new Date("2026-03-05") はホストの TZ で解釈が変わる。
    // 使ってよいのは new Date(<epoch 変数>) と new Date(Date.UTC(...)) だけ
    { pattern: /new Date\(\s*['"\d]/, why: "new Date(数値リテラル／文字列)（ローカル時刻）" },
    { pattern: /\.getFullYear\s*\(/, why: "getFullYear（getUTCFullYear を使う）" },
    { pattern: /\.getMonth\s*\(/, why: "getMonth" },
    { pattern: /\.getDate\s*\(/, why: "getDate" },
    { pattern: /\.getDay\s*\(/, why: "getDay" },
    { pattern: /\.getHours\s*\(/, why: "getHours" },
    { pattern: /\.getMinutes\s*\(/, why: "getMinutes" },
    { pattern: /Date\.parse\s*\(/, why: "Date.parse（オフセット無しの解釈がホスト依存）" },
  ];
  const core = collectFiles("src/core", [".js"]);
  for (let i = 0; i < core.length; i += 1) {
    for (let j = 0; j < banned.length; j += 1) {
      assert.ok(!banned[j].pattern.test(core[i].text), core[i].path + " に " + banned[j].why + " が使われている");
    }
  }
});

test("ビルドで 1 本に連結するので、トップレベルの名前が重複しない", () => {
  const files = collectFiles("src/core", [".js"]).concat(collectFiles("src/gas", [".js"]));
  const owner = {};
  const duplicates = [];
  const pattern = /^(?:export\s+)?(?:async\s+)?function\s+(\w+)|^(?:export\s+)?(?:const|let|var|class)\s+(\w+)/;
  for (let i = 0; i < files.length; i += 1) {
    const lines = files[i].text.split("\n");
    for (let j = 0; j < lines.length; j += 1) {
      const m = pattern.exec(lines[j]);
      if (!m) continue;
      const name = m[1] || m[2];
      if (owner[name] && owner[name] !== files[i].path) {
        duplicates.push(name + "（" + owner[name] + " と " + files[i].path + "）");
      }
      owner[name] = files[i].path;
    }
  }
  assert.deepEqual(duplicates, []);
});

test("K-9: fixture に実在しそうな個人のメールアドレスが無い", () => {
  const personalDomains = ["@gmail.com", "@yahoo.co.jp", "@icloud.com", "@outlook.com", "@docomo.ne.jp", "@ezweb.ne.jp", "@hotmail.com"];
  for (let i = 0; i < fixtureFiles.length; i += 1) {
    for (let j = 0; j < personalDomains.length; j += 1) {
      assert.ok(
        fixtureFiles[i].text.indexOf(personalDomains[j]) < 0,
        fixtureFiles[i].path + " に個人のメールアドレスらしきものがある"
      );
    }
  }
});

test("K-9: fixture のアドレスは example ドメインか媒体ドメインだけ", () => {
  const allowed = [];
  const names = Object.keys(MEDIA_DOMAINS);
  for (let i = 0; i < names.length; i += 1) {
    for (let j = 0; j < MEDIA_DOMAINS[names[i]].length; j += 1) allowed.push(MEDIA_DOMAINS[names[i]][j]);
  }
  for (let i = 0; i < fixtureFiles.length; i += 1) {
    const addresses = fixtureFiles[i].text.match(/[\w.+-]+@[\w.-]+/g) || [];
    for (let j = 0; j < addresses.length; j += 1) {
      const domain = addresses[j].split("@")[1].toLowerCase();
      const ok =
        domain.indexOf("example.") >= 0 ||
        domain === "example.com" ||
        allowed.some((d) => domain === d || domain.slice(-(d.length + 1)) === "." + d);
      assert.ok(ok, fixtureFiles[i].path + " の " + addresses[j] + " が合成データに見えない");
    }
  }
});

test("K-9: fixture と出荷コードに本人の氏名が入っていない", () => {
  const names = ["__PRIVATE_OWNER_NAME__", "__PRIVATE_OWNER_EMAIL__"];
  const targets = fixtureFiles.concat(shippingFiles);
  for (let i = 0; i < targets.length; i += 1) {
    for (let j = 0; j < names.length; j += 1) {
      assert.ok(targets[i].text.indexOf(names[j]) < 0, targets[i].path + " に本人の氏名らしき文字列がある");
    }
  }
});

test("K-9: 実メールの置き場が .gitignore で除外されている", () => {
  const ignore = fs.readFileSync(path.join(root, ".gitignore"), "utf8");
  assert.ok(ignore.indexOf("tests/fixtures/real/*") >= 0, ".gitignore に tests/fixtures/real/* が無い");
  assert.ok(ignore.indexOf("!tests/fixtures/real/README.md") >= 0, "README だけは残す設定が無い");
  const realDir = path.join(root, "tests/fixtures/real");
  const files = fs.existsSync(realDir) ? fs.readdirSync(realDir) : [];
  for (let i = 0; i < files.length; i += 1) {
    assert.ok(files[i] === "README.md" || files[i] === "expected", "実メールらしきファイルが置かれている: " + files[i]);
  }
});

test("NFR-01: 依存ゼロ（package.json に dependencies を持たない）", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  assert.equal(pkg.dependencies, undefined);
  assert.equal(pkg.devDependencies, undefined);
  assert.equal(pkg.private, true);
  assert.equal(pkg.type, "module");
});

test("K-6: appsscript.json のスコープが 4 つに厳密一致", () => {
  const manifestPath = path.join(root, "src/manifest/appsscript.json");
  // 存在しなければ落とす（軽微 16）。素通りさせると、消したことに気づけない
  assert.ok(fs.existsSync(manifestPath), "src/manifest/appsscript.json が無い");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  assert.deepEqual((manifest.oauthScopes || []).slice().sort(), [
    "https://www.googleapis.com/auth/calendar.events",
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/script.scriptapp",
    "https://www.googleapis.com/auth/spreadsheets",
  ]);
  assert.equal(manifest.timeZone, "Asia/Tokyo");
  assert.equal(manifest.runtimeVersion, "V8");
});

test("K-10: dist は import/export/require を含まない", () => {
  const distPath = path.join(root, "dist/Code.gs");
  // 存在しなければ落とす（軽微 16）。`npm test` は policy より前に build を走らせる
  assert.ok(fs.existsSync(distPath), "dist/Code.gs が無い（npm run build を先に走らせる）");
  const code = fs.readFileSync(distPath, "utf8");
  assert.ok(!/^\s*import\s/m.test(code), "dist に import が残っている");
  assert.ok(!/^\s*export\s/m.test(code), "dist に export が残っている");
  assert.ok(!/\brequire\s*\(/.test(code), "dist に require が残っている");
});
