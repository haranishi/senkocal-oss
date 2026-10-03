/**
 * text.test.mjs — 文字列の下ごしらえ
 * ここが崩れると日時も企業名も一斉に外れるので、正規化の性質を直接押さえる。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { letterRatio, normalizeText, signatureBlock, splitLines, stripSignature, truncate } from "../../src/core/text.js";

test("NFKC: 全角英数と記号を半角に寄せる", () => {
  assert.equal(normalizeText("１４：００〜１５：００"), "14:00〜15:00");
  assert.equal(normalizeText("（木）"), "(木)");
  assert.equal(normalizeText("㈱サンプル"), "(株)サンプル");
});

test("改行コードを \\n に統一する", () => {
  assert.equal(normalizeText("a\r\nb\rc"), "a\nb\nc");
});

test("引用行（>）を落とす", () => {
  assert.equal(normalizeText("新しい日程です\n> 前の日程：3月5日"), "新しい日程です");
});

test("連続する空白と空行を詰める", () => {
  assert.equal(normalizeText("a    b"), "a b");
  assert.equal(normalizeText("a\n\n\n\nb"), "a\n\nb");
});

test("全角スペースを半角にする", () => {
  assert.equal(normalizeText("日時：　3月5日"), "日時: 3月5日");
});

test("normalizeText は冪等（2 回かけても同じ）", () => {
  const once = normalizeText("１４：００〜１５：００　（木）");
  assert.equal(normalizeText(once), once);
});

test("null・undefined は空文字", () => {
  assert.equal(normalizeText(null), "");
  assert.equal(normalizeText(undefined), "");
});

test("splitLines: 空行も残す（行番号を根拠に使うため）", () => {
  assert.deepEqual(splitLines("a\n\nb"), ["a", "", "b"]);
  assert.deepEqual(splitLines(null), []);
});

test("stripSignature: 区切り線から下を落とす", () => {
  const body = "本文が十分な長さでここに書かれています。日時は3月5日です。よろしくお願いします。\n--\n株式会社サンプル 採用担当\ntel: 03-0000-0000";
  assert.equal(stripSignature(body).indexOf("tel:"), -1);
  assert.ok(stripSignature(body).indexOf("日時は3月5日") >= 0);
});

test("stripSignature: 落としすぎない（残りが 30% を切る位置では切らない）", () => {
  const body = "短い\n--\n" + "本文がここから長々と続きます。".repeat(10);
  assert.equal(stripSignature(body), body);
});

test("signatureBlock: 署名だけを返す", () => {
  const body = "本文が十分な長さでここに書かれています。日時は3月5日です。よろしくお願いします。\n--\nサンプル物産株式会社 採用担当";
  assert.ok(signatureBlock(body).indexOf("サンプル物産株式会社") >= 0);
});

test("truncate: 超えたときだけ … を付ける", () => {
  assert.equal(truncate("abcde", 5), "abcde");
  assert.equal(truncate("abcdef", 5), "abcd…");
  assert.equal(truncate(null, 5), "");
});

test("letterRatio: 英語だけの文と日本語混じりを見分ける", () => {
  assert.ok(letterRatio("Thank you for applying to our company").asciiRatio >= 0.9);
  assert.ok(letterRatio("面接のご案内です Zoom で行います").asciiRatio < 0.9);
  assert.equal(letterRatio("").asciiRatio, 0);
});
