/**
 * text.js — 文字列の下ごしらえ（純関数）
 *
 * ここを通した後の文字列だけを他のモジュールが見る、という約束にしている。
 * 全角と半角、引用返信、改行コードの違いを先に潰しておかないと、
 * 日時や企業名の正規表現が「同じ意味なのに一致しない」で落ちるため。
 * GAS(V8) でも Node でも同じ結果になるよう、ロケール依存の API を使わない。
 */

/**
 * NFKC 正規化・改行の統一・引用行の除去・空白の圧縮をまとめて行う。
 * NFKC は全角英数（１４：００）や `（木）`、`㈱` を半角・分解形に寄せる副作用が本命。
 * @param {string} text
 * @returns {string}
 */
export function normalizeText(text) {
  if (text === null || text === undefined) return "";
  let value = String(text);
  value = value.normalize("NFKC");
  value = value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  // NBSP など NFKC で残る空白を普通の空白へ
  value = value.replace(/[\u00a0\u2000-\u200b\u202f\u205f\u3000]/g, " ");
  const lines = value.split("\n");
  const kept = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    // 引用行（> で始まる返信の引用）は落とす。過去メールの日時を拾わないため
    if (/^\s*>/.test(line)) continue;
    kept.push(line.replace(/[ \t]+/g, " ").replace(/^[ \t]+/, "").replace(/[ \t]+$/, ""));
  }
  return kept.join("\n").replace(/\n{3,}/g, "\n\n").replace(/^\n+/, "").replace(/\n+$/, "");
}

/**
 * 行に分ける。行番号を「本文 N 行目」として根拠に残すので、空行も落とさず保つ。
 * @param {string} text
 * @returns {string[]}
 */
export function splitLines(text) {
  if (text === null || text === undefined) return [];
  return String(text).replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
}

/**
 * 署名ブロック（区切り線・「以上」以降）を落とす。
 * 落としすぎると本文が消えるので、残りが元の 30% を切る位置では切らない。
 * @param {string} text
 * @returns {string}
 */
export function stripSignature(text) {
  const value = String(text === null || text === undefined ? "" : text);
  if (value === "") return "";
  const lines = value.split("\n");
  const marker = /^(?:-{2,}|[=＝*＊_]{3,}|[━─―‐‗]{3,}|[※＊]{0,1}\s*以上(?:です)?[。.]?)$/;
  for (let i = 1; i < lines.length; i += 1) {
    if (!marker.test(lines[i].trim())) continue;
    const head = lines.slice(0, i).join("\n");
    if (head.length >= value.length * 0.3) return head.replace(/\s+$/, "");
  }
  return value;
}

/**
 * 署名ブロックだけを返す（企業名を署名から拾うため）。無ければ末尾 8 行。
 * @param {string} text
 * @returns {string}
 */
export function signatureBlock(text) {
  const value = String(text === null || text === undefined ? "" : text);
  const head = stripSignature(value);
  if (head.length < value.length) return value.slice(head.length);
  const lines = value.split("\n");
  return lines.slice(Math.max(0, lines.length - 8)).join("\n");
}

/**
 * n 文字で切る（超えたときだけ末尾に … を付ける）。台帳の件名 200 字制限などに使う。
 * @param {string} text
 * @param {number} n
 * @returns {string}
 */
export function truncate(text, n) {
  const value = String(text === null || text === undefined ? "" : text);
  const limit = Number(n);
  if (!isFinite(limit) || limit <= 0) return "";
  if (value.length <= limit) return value;
  return value.slice(0, limit - 1) + "…";
}

/**
 * 日本語（ひらがな・カタカナ・漢字）と英字の比率から「英語だけのメール」を見分ける。
 * @param {string} text
 * @returns {{letters: number, ascii: number, japanese: number, asciiRatio: number}}
 */
export function letterRatio(text) {
  const value = String(text === null || text === undefined ? "" : text);
  let ascii = 0;
  let japanese = 0;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if ((code >= 65 && code <= 90) || (code >= 97 && code <= 122)) {
      ascii += 1;
    } else if (
      (code >= 0x3040 && code <= 0x30ff) ||
      (code >= 0x3400 && code <= 0x9fff) ||
      (code >= 0xf900 && code <= 0xfaff)
    ) {
      japanese += 1;
    }
  }
  const letters = ascii + japanese;
  return { letters, ascii, japanese, asciiRatio: letters === 0 ? 0 : ascii / letters };
}
