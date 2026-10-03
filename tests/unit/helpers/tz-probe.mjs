/**
 * TZ 非依存の確認用（子プロセスで走らせる）。
 * `TZ=UTC` でも `TZ=Asia/Tokyo` でも標準出力が 1 バイトも変わらないことを dates.test.mjs が確かめる。
 */
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { addMinutes, formatJa, parseDateTimes, parseDeadlines, weekdayOf } from "../../../src/core/dates.js";
import { parseMail } from "../../../src/core/parse.js";

const mailsDir = fileURLToPath(new URL("../../fixtures/mails/", import.meta.url));
const base = "2026-03-01T10:12:00+09:00";

const result = {
  tz: process.env.TZ || "(unset)",
  dates: parseDateTimes("日時：3月5日（木）14:00〜15:00\n締切：3月10日（火）23:59", { base: base }),
  deadlines: parseDeadlines("提出期限：3月15日（日）正午", { base: base }),
  weekday: weekdayOf("2026-03-05T14:00:00+09:00"),
  formatted: formatJa("2026-03-05T14:00:00+09:00"),
  plus: addMinutes("2026-03-05T23:30:00+09:00", 60),
  candidates: [],
};

for (const name of ["01.json", "12.json", "31.json", "35.json"]) {
  const mail = JSON.parse(fs.readFileSync(mailsDir + name, "utf8"));
  result.candidates.push(parseMail(mail));
}

process.stdout.write(JSON.stringify(result.dates) + "\n");
process.stdout.write(JSON.stringify(result.deadlines) + "\n");
process.stdout.write(JSON.stringify([result.weekday, result.formatted, result.plus]) + "\n");
process.stdout.write(JSON.stringify(result.candidates) + "\n");
