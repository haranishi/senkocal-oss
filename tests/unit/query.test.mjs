/**
 * query.test.mjs — Gmail 検索クエリ（FR-01）
 * 取り込み元は Gmail だけ（K-1）なので、ここが唯一の「どこを見るか」の指定になる。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { QUERY_EXCLUDE_TAIL, buildExcludeFromTerms, buildGmailQuery, sanitizeKeywords } from "../../src/core/query.js";
import { SETTINGS_DEFAULTS, settingsFromRows } from "../../src/core/settings.js";

test("既定の設定から組む", () => {
  const query = buildGmailQuery(SETTINGS_DEFAULTS);
  assert.equal(
    query,
    "newer_than:7d (" + SETTINGS_DEFAULTS.keywords + ") -in:spam -in:trash"
  );
});

test("検索日数が反映される", () => {
  const settings = settingsFromRows([["検索日数", 14]]);
  assert.ok(buildGmailQuery(settings).indexOf("newer_than:14d") === 0);
});

test("キーワードは括弧でくくる（OR の効きを固定する）", () => {
  const settings = settingsFromRows([["キーワード", "面接 OR 説明会"]]);
  assert.ok(buildGmailQuery(settings).indexOf("(面接 OR 説明会)") >= 0);
});

test("キーワードが空なら既定に倒す", () => {
  const settings = Object.assign({}, SETTINGS_DEFAULTS, { keywords: "   " });
  assert.ok(buildGmailQuery(settings).indexOf("(" + SETTINGS_DEFAULTS.keywords + ")") >= 0);
});

test("除外送信者は -from: に展開する", () => {
  const settings = settingsFromRows([["除外送信者", "news@example.com, spam@example.net"]]);
  const query = buildGmailQuery(settings);
  assert.ok(query.indexOf("-from:news@example.com") >= 0);
  assert.ok(query.indexOf("-from:spam@example.net") >= 0);
});

test("迷惑メールとゴミ箱は常に外す", () => {
  const query = buildGmailQuery(SETTINGS_DEFAULTS);
  for (let i = 0; i < QUERY_EXCLUDE_TAIL.length; i += 1) {
    assert.ok(query.indexOf(QUERY_EXCLUDE_TAIL[i]) >= 0);
  }
});

test("設定を渡さなくても既定で組める", () => {
  assert.ok(buildGmailQuery().indexOf("newer_than:7d") === 0);
});

test("buildExcludeFromTerms: 区切りのゆれと重複を吸収する", () => {
  assert.deepEqual(buildExcludeFromTerms("a@example.com、b@example.com c@example.com"), [
    "-from:a@example.com",
    "-from:b@example.com",
    "-from:c@example.com",
  ]);
  assert.deepEqual(buildExcludeFromTerms("a@example.com, a@example.com"), ["-from:a@example.com"]);
  assert.deepEqual(buildExcludeFromTerms("-from:a@example.com"), ["-from:a@example.com"]);
  assert.deepEqual(buildExcludeFromTerms(""), []);
});

test("K-1: クエリに媒体サイトの URL が入らない", () => {
  const query = buildGmailQuery(SETTINGS_DEFAULTS);
  assert.ok(query.indexOf("http") < 0);
});

// --- 軽微 5: キーワードの検証 ------------------------------------------------
test("キーワードから括弧と引用符を落とす（検索式の意味を変えさせない・軽微 5）", () => {
  const settings = settingsFromRows([["キーワード", '面接 OR 説明会) OR in:anywhere ("x"']]);
  const query = buildGmailQuery(settings);
  // 括弧は本文側に残らない＝キーワードは必ず 1 組の () の中に収まる
  assert.equal(query.indexOf("in:anywhere"), query.indexOf("(") + 1 + "面接 OR 説明会 OR ".length);
  assert.equal((query.match(/\(/g) || []).length, 1);
  assert.equal((query.match(/\)/g) || []).length, 1);
  assert.ok(query.indexOf('"') < 0);
  assert.ok(query.indexOf("-in:spam") >= 0);
  assert.ok(query.indexOf("-in:trash") >= 0);
});

test("sanitizeKeywords: 落とした文字のぶんの空白は詰める", () => {
  assert.equal(sanitizeKeywords("面接 OR (説明会)"), "面接 OR 説明会");
  assert.equal(sanitizeKeywords('{"面接"}'), "面接");
  assert.equal(sanitizeKeywords("   "), "");
  assert.equal(sanitizeKeywords(null), "");
});

test("キーワードが括弧だけなら既定に倒す（空になった扱い）", () => {
  const settings = settingsFromRows([["キーワード", "()"]]);
  assert.ok(buildGmailQuery(settings).indexOf("(" + SETTINGS_DEFAULTS.keywords + ")") >= 0);
});
