/**
 * app.test.mjs — GAS のエントリ（src/gas/app.js）を、モックを差し替えて丸ごと動かす
 *
 * ここで確かめたいのは機能そのものより「約束」のほう:
 * - **取り込みはカレンダーに触らない**（K-2）。押したときだけ書く
 * - 同じメールを二度取り込まない・同じ予定を二度作らない（K-11／FR-11）
 * - `google.script.run` の境界に Date を乗せない（FR-08）
 * - 本文を台帳に書かない（NFR-02）
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  api_ignoreCandidate,
  api_importNow,
  api_listCandidates,
  api_registerBulk,
  api_registerCandidate,
  api_restoreCandidate,
  api_undoRegister,
  applyEdits,
  createTrigger,
  deleteTriggers,
  doGet,
  importMail,
  normalizeEditedDateTime,
  parseEdits,
  parseIdList,
  registerMarked,
  setup,
} from "../../src/gas/app.js";
import { HEADERS, toRow } from "../../src/core/ledger.js";
import { installGasMocks, ledgerSheet, loadFixtureMails, pickFixtureMails } from "./helpers/gas-mocks.mjs";

/** モックを差して body を走らせ、必ず片付ける */
function withGas(options, body) {
  const gas = installGasMocks(options);
  try {
    return body(gas);
  } finally {
    gas.restore();
  }
}

/** setup 済みの状態から始める */
function withLedger(options, body) {
  return withGas(options, (gas) => {
    setup();
    return body(gas);
  });
}

function candidateRows(gas) {
  const sheet = ledgerSheet(gas.spreadsheet, "候補");
  return sheet ? sheet.rows() : [];
}

function processedRows(gas) {
  const sheet = ledgerSheet(gas.spreadsheet, "処理済みメール");
  return sheet ? sheet.rows() : [];
}

/** `設定` シートの値を本人が変えた状態にする */
function setSetting(gas, label, value) {
  const sheet = ledgerSheet(gas.spreadsheet, "設定");
  for (let i = 0; i < sheet.grid.length; i += 1) {
    if (String(sheet.grid[i][0]) === label) {
      sheet.getRange(i + 1, 2, 1, 1).setValues([[value]]);
      return true;
    }
  }
  return false;
}

function findCandidate(list, test_) {
  for (let i = 0; i < list.length; i += 1) {
    if (test_(list[i])) return list[i];
  }
  return null;
}

/** 戻り値に Date・関数・undefined が混ざっていないか（JSON にできるか） */
function findNonJsonValue(value, path) {
  if (value === null) return null;
  if (value instanceof Date) return path + " が Date";
  if (typeof value === "function") return path + " が関数";
  if (typeof value === "undefined") return path + " が undefined";
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const found = findNonJsonValue(value[i], path + "[" + i + "]");
      if (found) return found;
    }
    return null;
  }
  if (typeof value === "object") {
    const names = Object.keys(value);
    for (let i = 0; i < names.length; i += 1) {
      const found = findNonJsonValue(value[names[i]], path + "." + names[i]);
      if (found) return found;
    }
    return null;
  }
  return null;
}

// ---------- setup ----------

test("setup(): 台帳を作り、3 シートと URL を返す", () => {
  withGas({ mails: [] }, (gas) => {
    const info = setup();
    assert.deepEqual(info.sheets, ["候補", "設定", "処理済みメール"]);
    assert.ok(info.url.length > 0);
    assert.equal(gas.properties.store["senkocal.spreadsheetId"], info.spreadsheetId);
  });
});

test("setup(): カレンダーには触れない", () => {
  withGas({ mails: [] }, (gas) => {
    setup();
    assert.equal(gas.calendar.calls.length, 0);
  });
});

test("setup(): トリガーは作らない（自動で動き出さない）", () => {
  withGas({ mails: [] }, (gas) => {
    setup();
    assert.equal(gas.script.triggers.length, 0);
  });
});

// ---------- importMail ----------

test("importMail(): fixture 10 通から候補と処理済みが台帳に入る", () => {
  withLedger({ mails: loadFixtureMails(10) }, (gas) => {
    const result = importMail();
    assert.equal(result.skipped, false);
    assert.equal(result.looked, 10);
    assert.ok(result.added >= 8);
    assert.equal(candidateRows(gas).length, result.added + result.noise);
    assert.equal(processedRows(gas).length, 10);
  });
});

test("K-2: 取り込みの経路で CalendarApp を 1 回も呼ばない", () => {
  withLedger({ mails: loadFixtureMails(12) }, (gas) => {
    importMail();
    assert.equal(gas.calendar.calls.length, 0);
  });
});

test("importMail(): 2 回目は同じメールを取り込まない（FR-11）", () => {
  withLedger({ mails: loadFixtureMails(10) }, (gas) => {
    const first = importMail();
    const rowsAfterFirst = candidateRows(gas).length;
    const second = importMail();
    assert.equal(second.added, 0);
    assert.equal(second.looked, 0);
    assert.equal(candidateRows(gas).length, rowsAfterFirst);
    assert.equal(processedRows(gas).length, first.looked);
  });
});

test("importMail(): ノイズのメールも「ノイズ」として残す（消さない）", () => {
  withLedger({ mails: pickFixtureMails(["07"]) }, (gas) => {
    const result = importMail();
    assert.equal(result.added, 0);
    assert.equal(result.noise, 1);
    const rows = candidateRows(gas);
    assert.equal(rows.length, 1);
    assert.equal(rows[0][1], "ノイズ");
    assert.equal(processedRows(gas)[0][2], "ノイズ");
  });
});

test("importMail(): 合否の連絡は予定にせず記録だけ残す", () => {
  withLedger({ mails: pickFixtureMails(["14"]) }, (gas) => {
    importMail();
    const rows = candidateRows(gas);
    assert.equal(rows[0][1], "ノイズ");
    assert.equal(rows[0][3], "result");
    assert.equal(processedRows(gas)[0][2], "合否");
  });
});

test("importMail(): 1 回の上限を超えたぶんは次回に回す（K-7）", () => {
  withLedger({ mails: loadFixtureMails(12) }, (gas) => {
    setSetting(gas, "1回の上限", 3);
    const result = importMail();
    assert.equal(result.looked, 3);
    assert.equal(gas.gmail.calls[0].args[2], 3);
    assert.equal(processedRows(gas).length, 3);
  });
});

test("importMail(): ロックが取れなければ何もしない（Gmail も読まない）", () => {
  withLedger({ mails: loadFixtureMails(5), lock: { acquire: false } }, (gas) => {
    const result = importMail();
    assert.equal(result.skipped, true);
    assert.equal(result.added, 0);
    assert.equal(gas.gmail.calls.length, 0);
    assert.equal(candidateRows(gas).length, 0);
  });
});

test("importMail(): 最終実行と最終取り込み件数を書く", () => {
  withLedger({ mails: loadFixtureMails(5) }, (gas) => {
    const result = importMail();
    const list = api_listCandidates();
    assert.ok(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+09:00$/.test(list.lastRun));
    assert.equal(list.lastImportCount, result.added + result.noise);
  });
});

test("importMail(): 検索クエリは設定から組む（取り込み元は Gmail だけ・K-1）", () => {
  withLedger({ mails: loadFixtureMails(2) }, (gas) => {
    setSetting(gas, "検索日数", 14);
    importMail();
    const query = gas.gmail.calls[0].args[0];
    assert.ok(query.indexOf("newer_than:14d") === 0, query);
    assert.ok(query.indexOf("-in:spam") >= 0);
    assert.ok(query.indexOf("http") < 0);
  });
});

test("NFR-02: 取り込んでも本文は台帳に載らない", () => {
  const mail = pickFixtureMails(["01"])[0];
  withLedger({ mails: [mail] }, (gas) => {
    importMail();
    const bodyLine = mail.body.split("\n")[3];
    assert.ok(bodyLine.length > 5);
    assert.equal(JSON.stringify(candidateRows(gas)).indexOf(bodyLine), -1);
  });
});

// ---------- api_listCandidates ----------

test("api_listCandidates(): 候補・設定・最終実行・台帳 URL を返す", () => {
  withLedger({ mails: loadFixtureMails(6) }, () => {
    importMail();
    const list = api_listCandidates();
    assert.ok(list.candidates.length > 0);
    assert.equal(list.settings.intervalHours, 2);
    assert.ok(list.ledgerUrl.indexOf("http") === 0);
  });
});

test("api_listCandidates(): 締切カードの文言に使う通知の分を返す（900 = 前日 9:00）", () => {
  // 画面は Code.gs の関数を呼べないので、「終日予定＋前日 9:00 に通知」の文言は
  // この分数から画面側で組む（docs/02 ④・UI 採点 P9）
  withLedger({ mails: pickFixtureMails(["08"]) }, (gas) => {
    importMail();
    assert.equal(api_listCandidates().settings.deadlineReminderMinutes, 900);
    setSetting(gas, "締切リマインダー分", 1500);
    assert.equal(api_listCandidates().settings.deadlineReminderMinutes, 1500);
  });
});

test("api_listCandidates(): 画面が組めない値（Gmail リンク・登録可否）を足す", () => {
  withLedger({ mails: pickFixtureMails(["01", "17"]) }, () => {
    importMail();
    const list = api_listCandidates();
    const interview = findCandidate(list.candidates, (c) => c.kind === "interview");
    assert.equal(interview.gmailUrl, "https://mail.google.com/mail/u/0/#all/" + interview.messageId);
    assert.equal(interview.registerable, true);
    assert.ok(interview.calendarUrl.indexOf("https://calendar.google.com/") === 0);
    const change = findCandidate(list.candidates, (c) => c.kind === "change");
    assert.equal(change.registerable, false);
    assert.ok(change.planReason.length > 0);
  });
});

test("FR-08: api_listCandidates() の戻り値に Date が混ざらない", () => {
  withLedger({ mails: loadFixtureMails(8) }, () => {
    importMail();
    const found = findNonJsonValue(api_listCandidates(), "result");
    assert.equal(found, null);
    assert.doesNotThrow(() => JSON.parse(JSON.stringify(api_listCandidates())));
  });
});

// ---------- 登録 ----------

test("api_registerCandidate(): 予定を 1 件作り、台帳に状態と予定 ID を書く", () => {
  withLedger({ mails: pickFixtureMails(["01"]) }, (gas) => {
    importMail();
    const target = api_listCandidates().candidates[0];
    const result = api_registerCandidate(target.id, JSON.stringify({}));
    assert.equal(result.ok, true);
    assert.equal(gas.calendar.countOf("createEvent"), 1);
    const after = api_listCandidates().candidates[0];
    assert.equal(after.status, "登録済み");
    assert.equal(after.eventId, result.eventId);
    assert.ok(String(after.registeredAt).length > 0);
  });
});

test("api_registerCandidate(): 通知は設定どおり・候補 id をタグに残す（FR-09）", () => {
  withLedger({ mails: pickFixtureMails(["01"]) }, (gas) => {
    importMail();
    const target = api_listCandidates().candidates[0];
    const result = api_registerCandidate(target.id, "");
    const record = gas.calendar.recordOf(result.eventId);
    assert.deepEqual(record.reminders, [60, 1440]);
    assert.equal(record.tags.senkocal, target.id);
    assert.equal(record.options.description.indexOf(target.subject) >= 0, true);
    assert.equal(record.options.description.indexOf("選考カレンダーで登録") >= 0, true);
  });
});

test("api_registerCandidate(): 締切は終日予定＋前日 9:00 の通知（US-3）", () => {
  withLedger({ mails: pickFixtureMails(["08"]) }, (gas) => {
    importMail();
    const target = api_listCandidates().candidates[0];
    const result = api_registerCandidate(target.id, "");
    assert.equal(result.ok, true);
    assert.equal(gas.calendar.countOf("createAllDayEvent"), 1);
    const record = gas.calendar.recordOf(result.eventId);
    assert.deepEqual(record.reminders, [900]);
    assert.ok(record.title.indexOf("【締切") === 0);
  });
});

test("api_registerCandidate(): 編集した開始時刻が予定にも台帳にも効く（US-2）", () => {
  withLedger({ mails: pickFixtureMails(["01"]) }, (gas) => {
    importMail();
    const target = api_listCandidates().candidates[0];
    const edits = { start: "2026-03-06T15:30", end: "2026-03-06T16:30", location: "オンライン" };
    const result = api_registerCandidate(target.id, JSON.stringify(edits));
    assert.equal(result.ok, true);
    const call = gas.calendar.calls.filter((entry) => entry.name === "createEvent")[0];
    assert.equal(call.args[1].toISOString(), "2026-03-06T06:30:00.000Z");
    assert.equal(call.args[3].location, "オンライン");
    const after = api_listCandidates().candidates[0];
    assert.equal(after.start, "2026-03-06T15:30:00+09:00");
    assert.equal(after.location, "オンライン");
  });
});

test("api_registerCandidate(): 企業名を入れるとタイトルが直る", () => {
  withLedger({ mails: pickFixtureMails(["30"]) }, (gas) => {
    importMail();
    const target = api_listCandidates().candidates[0];
    assert.equal(target.company, null);
    const result = api_registerCandidate(target.id, JSON.stringify({ company: "株式会社サンプル通商" }));
    assert.equal(result.ok, true);
    const record = gas.calendar.recordOf(result.eventId);
    assert.ok(record.title.indexOf("株式会社サンプル通商") >= 0, record.title);
    assert.equal(api_listCandidates().candidates[0].company, "株式会社サンプル通商");
  });
});

test("api_registerCandidate(): 日時が無い候補は登録せず、理由を返す（カレンダーに触れない）", () => {
  withLedger({ mails: pickFixtureMails(["17"]) }, (gas) => {
    importMail();
    const target = api_listCandidates().candidates[0];
    const result = api_registerCandidate(target.id, "");
    assert.equal(result.ok, false);
    assert.ok(result.reason.indexOf("日") >= 0);
    assert.equal(gas.calendar.calls.length, 0);
    assert.equal(api_listCandidates().candidates[0].status, "候補");
  });
});

test("api_registerCandidate(): 日時を入れ直せば登録できる", () => {
  withLedger({ mails: pickFixtureMails(["17"]) }, (gas) => {
    importMail();
    const target = api_listCandidates().candidates[0];
    const result = api_registerCandidate(target.id, JSON.stringify({ start: "2026-03-20T10:00" }));
    assert.equal(result.ok, true);
    assert.equal(gas.calendar.countOf("createEvent"), 1);
  });
});

test("api_registerCandidate(): 同じ企業・種別・日時が登録済みなら二重に作らない（FR-09）", () => {
  withLedger({ mails: pickFixtureMails(["01"]) }, (gas) => {
    importMail();
    const target = api_listCandidates().candidates[0];
    api_registerCandidate(target.id, "");
    // 同じ内容の候補がもう 1 件届いた状況を作る
    const sheet = ledgerSheet(gas.spreadsheet, "候補");
    const twin = Object.assign({}, target, { id: target.id + "_twin", status: "候補", eventId: null, registeredAt: null });
    sheet.getRange(sheet.getLastRow() + 1, 1, 1, HEADERS.length).setValues([toRow(twin)]);
    const result = api_registerCandidate(twin.id, "");
    assert.equal(result.ok, false);
    assert.equal(result.duplicateOf, target.id);
    assert.equal(gas.calendar.countOf("createEvent"), 1);
  });
});

test("api_registerCandidate(): すでに登録済みの候補は押しても二度作らない", () => {
  withLedger({ mails: pickFixtureMails(["01"]) }, (gas) => {
    importMail();
    const target = api_listCandidates().candidates[0];
    api_registerCandidate(target.id, "");
    const again = api_registerCandidate(target.id, "");
    assert.equal(again.ok, false);
    assert.equal(gas.calendar.countOf("createEvent"), 1);
  });
});

test("api_registerCandidate(): 知らない id は例外（画面の失敗ハンドラに届く）", () => {
  withLedger({ mails: [] }, () => {
    assert.throws(() => api_registerCandidate("c_none_1", ""), /候補が見つかりません/);
  });
});

test("api_registerBulk(): 一部が失敗しても残りは登録される", () => {
  withLedger({ mails: pickFixtureMails(["01", "02", "17"]) }, (gas) => {
    importMail();
    const list = api_listCandidates().candidates;
    const ids = list.map((c) => c.id);
    const result = api_registerBulk(JSON.stringify(ids));
    const ok = result.results.filter((entry) => entry.ok);
    const failed = result.results.filter((entry) => !entry.ok);
    assert.equal(ok.length, 2);
    assert.equal(failed.length, 1);
    assert.equal(gas.calendar.countOf("createEvent"), 2);
    assert.ok(failed[0].reason.length > 0);
  });
});

test("api_registerBulk(): 登録できた id だけを registeredIds で返す（帯の「まとめて取り消す」用）", () => {
  withLedger({ mails: pickFixtureMails(["01", "02", "17"]) }, (gas) => {
    importMail();
    const list = api_listCandidates().candidates;
    const ids = list.map((c) => c.id);
    const result = api_registerBulk(JSON.stringify(ids));
    const okIds = result.results.filter((entry) => entry.ok).map((entry) => entry.id);
    assert.deepEqual(result.registeredIds, okIds);
    assert.equal(result.registeredIds.length, 2);
    assert.equal(gas.calendar.countOf("createEvent"), 2);
    // 失敗した候補（日時なし）は入らない＝取り消しの対象にならない
    const failed = result.results.filter((entry) => !entry.ok)[0];
    assert.equal(result.registeredIds.indexOf(failed.id), -1);
    // 返ってきた id はそのまま api_undoRegister に渡せる
    for (let i = 0; i < result.registeredIds.length; i += 1) {
      assert.equal(api_undoRegister(result.registeredIds[i]).ok, true);
    }
    assert.equal(gas.calendar.countOf("deleteEvent"), 2);
  });
});

test("api_registerBulk(): 配列でも JSON 文字列でも受け取る", () => {
  withLedger({ mails: pickFixtureMails(["01"]) }, () => {
    importMail();
    const id = api_listCandidates().candidates[0].id;
    const result = api_registerBulk([id]);
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0].ok, true);
  });
});

// ---------- 無視・戻す・取り消す ----------

test("api_ignoreCandidate(): 状態が「無視」になり、カレンダーには触れない", () => {
  withLedger({ mails: pickFixtureMails(["01"]) }, (gas) => {
    importMail();
    const target = api_listCandidates().candidates[0];
    const result = api_ignoreCandidate(target.id);
    assert.equal(result.ok, true);
    assert.equal(result.candidate.status, "無視");
    assert.equal(gas.calendar.calls.length, 0);
  });
});

test("api_restoreCandidate(): ノイズを候補に戻せる（US-5）", () => {
  withLedger({ mails: pickFixtureMails(["07"]) }, () => {
    importMail();
    const target = api_listCandidates().candidates[0];
    assert.equal(target.status, "ノイズ");
    const result = api_restoreCandidate(target.id);
    assert.equal(result.ok, true);
    assert.equal(result.candidate.status, "候補");
  });
});

test("api_restoreCandidate(): 登録済みは「取り消す」を案内して断る", () => {
  withLedger({ mails: pickFixtureMails(["01"]) }, () => {
    importMail();
    const target = api_listCandidates().candidates[0];
    api_registerCandidate(target.id, "");
    const result = api_restoreCandidate(target.id);
    assert.equal(result.ok, false);
    assert.ok(result.reason.indexOf("取り消す") >= 0);
  });
});

test("api_undoRegister(): 予定を消して状態が「候補」に戻る（FR-10）", () => {
  withLedger({ mails: pickFixtureMails(["01"]) }, (gas) => {
    importMail();
    const target = api_listCandidates().candidates[0];
    const registered = api_registerCandidate(target.id, "");
    const result = api_undoRegister(target.id);
    assert.equal(result.ok, true);
    assert.equal(result.deleted, true);
    assert.equal(gas.calendar.countOf("deleteEvent"), 1);
    assert.equal(gas.calendar.recordOf(registered.eventId).deleted, true);
    const after = api_listCandidates().candidates[0];
    assert.equal(after.status, "候補");
    assert.equal(after.eventId, null);
  });
});

test("api_undoRegister(): 二度押しても落ちない（冪等）", () => {
  withLedger({ mails: pickFixtureMails(["01"]) }, (gas) => {
    importMail();
    const target = api_listCandidates().candidates[0];
    api_registerCandidate(target.id, "");
    api_undoRegister(target.id);
    const again = api_undoRegister(target.id);
    assert.equal(again.ok, true);
    assert.equal(again.deleted, false);
    assert.equal(gas.calendar.countOf("deleteEvent"), 1);
  });
});

test("api_undoRegister(): 登録と同じロックの中で走る（レビュー r2 軽微 4）", () => {
  withLedger({ mails: pickFixtureMails(["01"]) }, (gas) => {
    importMail();
    const target = api_listCandidates().candidates[0];
    api_registerCandidate(target.id, "");
    const before = gas.lock.calls.filter((call) => call.name === "tryLock").length;
    assert.equal(api_undoRegister(target.id).ok, true);
    const after = gas.lock.calls.filter((call) => call.name === "tryLock").length;
    assert.equal(after - before, 1);
    assert.equal(gas.lock.getScriptLock().hasLock(), false);
  });
});

test("api_undoRegister(): 登録の途中に割り込んでも「取り消しました」と言わない（軽微 4）", () => {
  // 登録がカレンダーに書いている最中に取り消しが来ると、台帳はまだ「候補」なので
  // 何も消さずに ok を返してしまっていた（画面は「取り消しました」と出す）
  withLedger({ mails: pickFixtureMails(["01"]) }, (gas) => {
    importMail();
    const target = api_listCandidates().candidates[0];
    const nested = [];
    const original = gas.calendar.calendar.createEvent;
    let reentered = false;
    gas.calendar.calendar.createEvent = function (title, start, end, options) {
      if (!reentered) {
        reentered = true;
        try {
          nested.push(JSON.stringify(api_undoRegister(target.id)));
        } catch (err) {
          nested.push(String(err.message));
        }
      }
      return original.call(gas.calendar.calendar, title, start, end, options);
    };
    const result = api_registerCandidate(target.id, "");
    gas.calendar.calendar.createEvent = original;
    assert.equal(result.ok, true);
    assert.deepEqual(nested, ["他の処理が動いています。少し待ってからもう一度押してください"]);
    // 登録は完走し、あとから普通に取り消せる
    assert.equal(api_listCandidates().candidates[0].status, "登録済み");
    assert.equal(api_undoRegister(target.id).deleted, true);
  });
});

test("取り消したあとは、もう一度登録できる", () => {
  withLedger({ mails: pickFixtureMails(["01"]) }, (gas) => {
    importMail();
    const target = api_listCandidates().candidates[0];
    api_registerCandidate(target.id, "");
    api_undoRegister(target.id);
    const result = api_registerCandidate(target.id, "");
    assert.equal(result.ok, true);
    assert.equal(gas.calendar.countOf("createEvent"), 2);
  });
});

test("api_importNow(): 画面に返すのは件数だけ", () => {
  withLedger({ mails: loadFixtureMails(6) }, () => {
    const result = api_importNow();
    assert.equal(typeof result.added, "number");
    assert.equal(typeof result.noise, "number");
    assert.equal(result.skipped, false);
  });
});

// ---------- トリガー・画面 ----------

test("createTrigger(): 設定の間隔で importMail のトリガーを作る", () => {
  withLedger({ mails: [] }, (gas) => {
    setSetting(gas, "実行間隔時間", 4);
    const result = createTrigger();
    assert.equal(result.hours, 4);
    assert.equal(gas.script.triggers.length, 1);
    assert.equal(gas.script.triggers[0].getHandlerFunction(), "importMail");
    assert.equal(gas.script.triggers[0].hours, 4);
  });
});

test("createTrigger(): 二度実行してもトリガーは 1 本のまま", () => {
  withLedger({ mails: [] }, (gas) => {
    createTrigger();
    const result = createTrigger();
    assert.equal(result.replaced, 1);
    assert.equal(gas.script.triggers.length, 1);
  });
});

test("deleteTriggers(): importMail のトリガーだけ消す", () => {
  withLedger({ mails: [] }, (gas) => {
    createTrigger();
    gas.script.triggers.push({ getUniqueId: () => "other", getHandlerFunction: () => "somethingElse" });
    const result = deleteTriggers();
    assert.equal(result.deleted, 1);
    assert.equal(gas.script.triggers.length, 1);
    assert.equal(gas.script.triggers[0].getHandlerFunction(), "somethingElse");
  });
});

test("doGet(): index を返し、題と viewport を付ける", () => {
  withGas({ mails: [] }, (gas) => {
    const page = doGet({});
    assert.equal(page.fileName, "index");
    assert.equal(page.title, "選考カレンダー（仮）");
    assert.deepEqual(page.metaTags, [{ name: "viewport", content: "width=device-width, initial-scale=1" }]);
    assert.equal(gas.html.calls[0].args[0], "index");
  });
});

// ---------- シートだけで運用する経路（FR-07） ----------

test("registerMarked(): 状態に「登録」と書いた行を登録する", () => {
  withLedger({ mails: pickFixtureMails(["01"]) }, (gas) => {
    importMail();
    const sheet = ledgerSheet(gas.spreadsheet, "候補");
    sheet.getRange(2, 2, 1, 1).setValues([["登録"]]);
    const result = registerMarked();
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0].ok, true);
    assert.equal(gas.calendar.countOf("createEvent"), 1);
    assert.equal(api_listCandidates().candidates[0].status, "登録済み");
  });
});

test("registerMarked(): 「登録」と書かれていなければ何もしない", () => {
  withLedger({ mails: pickFixtureMails(["01"]) }, (gas) => {
    importMail();
    const result = registerMarked();
    assert.equal(result.results.length, 0);
    assert.equal(gas.calendar.calls.length, 0);
  });
});

// ---------- 編集内容の解釈（純関数） ----------

test("normalizeEditedDateTime: datetime-local を ISO（+09:00）にする", () => {
  assert.equal(normalizeEditedDateTime("2026-03-05T14:00"), "2026-03-05T14:00:00+09:00");
  assert.equal(normalizeEditedDateTime("2026-03-05T09:05"), "2026-03-05T09:05:00+09:00");
});

test("normalizeEditedDateTime: 日付だけの入力は日付のまま（終日の締切）", () => {
  assert.equal(normalizeEditedDateTime("2026-03-10"), "2026-03-10");
});

test("normalizeEditedDateTime: 空は null、読めない値は例外", () => {
  assert.equal(normalizeEditedDateTime(""), null);
  assert.equal(normalizeEditedDateTime(null), null);
  assert.throws(() => normalizeEditedDateTime("あした"), /読めません/);
});

test("applyEdits: 開始を終日にすると終了を落とす", () => {
  const candidate = { id: "c_1", kind: "seminar", status: "候補", start: "2026-03-05T14:00:00+09:00", end: "2026-03-05T15:00:00+09:00", allDay: false };
  const next = applyEdits(candidate, { start: "2026-03-06", end: "" });
  assert.equal(next.start, "2026-03-06");
  assert.equal(next.allDay, true);
  assert.equal(next.end, null);
});

test("applyEdits: 元の候補を書き換えない", () => {
  const candidate = { id: "c_1", kind: "seminar", status: "候補", company: "株式会社サンプル", start: null };
  applyEdits(candidate, { company: "別の会社" });
  assert.equal(candidate.company, "株式会社サンプル");
});

test("applyEdits: 企業名は表記ゆれを直してから入れる", () => {
  const candidate = { id: "c_1", kind: "interview", status: "候補", company: null, start: null };
  const next = applyEdits(candidate, { company: "（株）サンプル物産 採用担当" });
  assert.equal(next.company, "株式会社サンプル物産");
});

test("applyEdits: タイトルを直接書いたらそれを使う", () => {
  const candidate = { id: "c_1", kind: "interview", status: "候補", company: "株式会社サンプル", title: "【面接】株式会社サンプル" };
  const next = applyEdits(candidate, { title: " 最終面接（本社） " });
  assert.equal(next.title, "最終面接（本社）");
});

test("parseEdits / parseIdList: JSON 文字列・オブジェクト・空・壊れた値", () => {
  assert.deepEqual(parseEdits('{"start":"2026-03-05T14:00"}'), { start: "2026-03-05T14:00" });
  assert.deepEqual(parseEdits({ start: "x" }), { start: "x" });
  assert.deepEqual(parseEdits(""), {});
  assert.deepEqual(parseEdits(null), {});
  assert.throws(() => parseEdits("{壊れた"), /読めません/);
  assert.deepEqual(parseIdList('["a","b"]'), ["a", "b"]);
  assert.deepEqual(parseIdList(["a"]), ["a"]);
  assert.deepEqual(parseIdList(""), []);
});

// ---------- FIX r0 の追随 ----------

test("importMail(): 日時の無い候補は別のメールぶんも台帳に残る（重要 2）", () => {
  const mails = [
    {
      id: "z1",
      threadId: "z1",
      from: "株式会社サンプル商事 <recruit@a.example.jp>",
      subject: "会社説明会のご案内",
      date: "2026-03-01T10:00:00+09:00",
      body: "会社説明会を実施します。\n日程は追ってご連絡します。",
    },
    {
      id: "z2",
      threadId: "z2",
      from: "株式会社サンプル商事 <recruit@a.example.jp>",
      subject: "第2回 会社説明会のご案内",
      date: "2026-03-02T10:00:00+09:00",
      body: "第2回の会社説明会を実施します。\n詳細は追ってご連絡します。",
    },
  ];
  withLedger({ mails: mails }, (gas) => {
    const result = importMail();
    assert.equal(result.added, 2);
    assert.equal(result.duplicates, 0);
    assert.equal(candidateRows(gas).length, 2);
  });
});

test("importMail(): ノイズ行も mergeCandidates で重複を弾く（回避策なしで二重にならない）", () => {
  withLedger({ mails: pickFixtureMails(["07"]) }, (gas) => {
    const first = importMail();
    assert.equal(first.noise, 1);
    // 処理済みを消して同じメールをもう一度流しても、鍵が同じなので行は増えない
    const processed = ledgerSheet(gas.spreadsheet, "処理済みメール");
    processed.grid.length = 1;
    const second = importMail();
    assert.equal(second.noise, 0);
    assert.equal(second.duplicates, 1);
    assert.equal(candidateRows(gas).length, 1);
  });
});

test("api_listCandidates(): 過去日の候補には isPast が付いて画面に届く（軽微 5・6）", () => {
  const mails = [
    {
      id: "z3",
      threadId: "z3",
      from: "株式会社サンプル商事 <recruit@a.example.jp>",
      subject: "面接のご案内",
      date: "2026-01-05T09:00:00+09:00",
      body: "面接日：12月20日（土）14:00〜15:00",
    },
  ];
  withLedger({ mails: mails }, () => {
    importMail();
    const target = api_listCandidates().candidates[0];
    assert.equal(target.start, "2025-12-20T14:00:00+09:00");
    assert.equal(target.isPast, true);
  });
});

test("api_listCandidates(): 未来の候補は isPast が false", () => {
  withLedger({ mails: pickFixtureMails(["01"]) }, () => {
    importMail();
    assert.equal(api_listCandidates().candidates[0].isPast, false);
  });
});

test("registerCandidate(): 終了を開始より前に編集しても既定の長さに倒す（重要 8）", () => {
  withLedger({ mails: pickFixtureMails(["01"]) }, (gas) => {
    importMail();
    const target = api_listCandidates().candidates[0];
    const result = api_registerCandidate(
      target.id,
      JSON.stringify({ start: "2026-03-05T14:00:00+09:00", end: "2026-03-05T13:00:00+09:00" })
    );
    assert.equal(result.ok, true);
    const call = gas.calendar.calls.filter((entry) => entry.name === "createEvent")[0];
    assert.ok(call, "createEvent が呼ばれていない");
    assert.ok(call.args[2].getTime() > call.args[1].getTime(), "終了が開始より前のまま渡っている");
  });
});

// ---------- FIX r2 の追随（レビュー r1 の重要・軽微） ----------

test("registerCandidate(): 終了 <= 開始は台帳にも残さない（レビュー r1 重要 6）", () => {
  // r0 の直しは buildEventPlan の中だけだったので、カレンダーは 15:00（正）なのに
  // 台帳の `終了` は 13:00（不正）で残り、画面が「14:00〜13:00」と出していた
  withLedger({ mails: pickFixtureMails(["01"]) }, (gas) => {
    importMail();
    const target = api_listCandidates().candidates[0];
    const result = api_registerCandidate(
      target.id,
      JSON.stringify({ start: "2026-03-05T14:00:00+09:00", end: "2026-03-05T13:00:00+09:00" })
    );
    assert.equal(result.ok, true);
    // 台帳（正本）の終了はカレンダーに入れた値と同じ＝既定 60 分ぶん
    assert.equal(result.candidate.start, "2026-03-05T14:00:00+09:00");
    assert.equal(result.candidate.end, "2026-03-05T15:00:00+09:00");
    const row = candidateRows(gas).filter((line) => line[0] === target.id)[0];
    assert.equal(row[HEADERS.indexOf("開始")], "2026-03-05T14:00:00+09:00");
    assert.equal(row[HEADERS.indexOf("終了")], "2026-03-05T15:00:00+09:00");
    const call = gas.calendar.calls.filter((entry) => entry.name === "createEvent")[0];
    assert.ok(call.args[2].getTime() > call.args[1].getTime());
  });
});

test("applyEdits: 終了が開始以前なら null に落とす（既定の長さに任せる・重要 6）", () => {
  const candidate = { id: "c_1", kind: "interview", status: "候補", start: null, end: null, allDay: false };
  const before = applyEdits(candidate, { start: "2026-03-05T14:00", end: "2026-03-05T13:00" });
  assert.equal(before.end, null);
  const same = applyEdits(candidate, { start: "2026-03-05T14:00", end: "2026-03-05T14:00" });
  assert.equal(same.end, null);
  const after = applyEdits(candidate, { start: "2026-03-05T14:00", end: "2026-03-05T16:00" });
  assert.equal(after.end, "2026-03-05T16:00:00+09:00");
});

test("api_registerCandidate(): 登録の途中に同じ呼び出しが来ても予定は 1 件（重要 1）", () => {
  // 画面の二重クリック（と Web アプリの並行実行）を再現する。カレンダーに書く瞬間に
  // もう一度 api_registerCandidate を呼ぶと、ロックが無ければ 2 件目の予定ができ、
  // 台帳には後の予定 ID しか残らない＝先の予定はアプリから消せなくなる
  withLedger({ mails: pickFixtureMails(["01"]) }, (gas) => {
    importMail();
    const target = api_listCandidates().candidates[0];
    const nested = [];
    const locksBefore = gas.lock.calls.filter((call) => call.name === "tryLock").length;
    const original = gas.calendar.calendar.createEvent;
    let reentered = false;
    gas.calendar.calendar.createEvent = function (title, start, end, options) {
      if (!reentered) {
        reentered = true;
        try {
          api_registerCandidate(target.id, "");
          nested.push("ok");
        } catch (err) {
          nested.push(String(err.message));
        }
      }
      return original.call(gas.calendar.calendar, title, start, end, options);
    };
    const result = api_registerCandidate(target.id, "");
    gas.calendar.calendar.createEvent = original;
    assert.equal(result.ok, true);
    assert.equal(gas.calendar.countOf("createEvent"), 1);
    assert.deepEqual(nested, ["他の処理が動いています。少し待ってからもう一度押してください"]);
    // 台帳の予定 ID は実際に作った 1 件だけ
    const row = candidateRows(gas).filter((line) => line[0] === target.id)[0];
    assert.equal(row[HEADERS.indexOf("予定ID")], result.eventId);
    const locksAfter = gas.lock.calls.filter((call) => call.name === "tryLock").length;
    assert.equal(locksAfter - locksBefore, 2);
  });
});

test("api_registerBulk()・registerMarked(): 登録経路はロックの中で走る（重要 1）", () => {
  withLedger({ mails: pickFixtureMails(["01"]) }, (gas) => {
    importMail();
    const id = api_listCandidates().candidates[0].id;
    const before = gas.lock.calls.filter((call) => call.name === "tryLock").length;
    api_registerBulk([id]);
    registerMarked();
    const after = gas.lock.calls.filter((call) => call.name === "tryLock").length;
    assert.equal(after - before, 2);
    // 使い終わったら必ず返す（次の取り込みが止まらない）
    assert.equal(gas.lock.getScriptLock().hasLock(), false);
  });
});

test("registerMarked(): ロックが取れなければ登録しないで理由を返す（重要 1）", () => {
  withLedger({ mails: pickFixtureMails(["01"]) }, (gas) => {
    importMail();
    const id = api_listCandidates().candidates[0].id;
    const sheet = ledgerSheet(gas.spreadsheet, "候補");
    for (let i = 1; i < sheet.grid.length; i += 1) {
      if (String(sheet.grid[i][0]) === id) sheet.getRange(i + 1, 2, 1, 1).setValues([["登録"]]);
    }
    // 取り込みが動いている最中（ロックを持たれている）を作る
    assert.equal(gas.lock.getScriptLock().tryLock(1000), true);
    assert.throws(() => registerMarked(), /他の処理が動いています/);
    assert.equal(gas.calendar.countOf("createEvent"), 0);
    gas.lock.getScriptLock().releaseLock();
    const result = registerMarked();
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0].ok, true);
  });
});

test("api_ignoreCandidate(): 登録済みは弾く（予定を残したまま無視にしない・軽微 4）", () => {
  withLedger({ mails: pickFixtureMails(["01"]) }, (gas) => {
    importMail();
    const target = api_listCandidates().candidates[0];
    api_registerCandidate(target.id, "");
    const result = api_ignoreCandidate(target.id);
    assert.equal(result.ok, false);
    assert.match(result.reason, /取り消す/);
    assert.equal(result.candidate.status, "登録済み");
    // 予定 ID を持ったまま「無視」になっていない
    const row = candidateRows(gas).filter((line) => line[0] === target.id)[0];
    assert.equal(row[HEADERS.indexOf("状態")], "登録済み");
  });
});

test("importMail(): 4 分を超えたら打ち切って残りを次回に回す（K-7・軽微 3）", () => {
  // 時間予算は Date.now を差し替えて固定する（実測 4 分待つわけにはいかない）
  const realNow = Date.now;
  let clock = 1770000000000;
  Date.now = function () {
    return clock;
  };
  try {
    withLedger({ mails: loadFixtureMails(12) }, (gas) => {
      let calls = 0;
      Date.now = function () {
        calls += 1;
        // 3 通目を読み終えたところで 4 分を超えさせる
        if (calls > 4) clock = 1770000000000 + 240001;
        return clock;
      };
      const result = importMail();
      assert.equal(result.stopped, true);
      assert.ok(result.looked < 12, "打ち切っていない: " + result.looked);
      assert.ok(result.looked >= 1);
      // 打ち切ったぶんは処理済みに書かないので、次の実行で拾える
      assert.equal(processedRows(gas).length, result.looked);
      Date.now = function () {
        return clock;
      };
      const second = importMail();
      assert.equal(second.stopped, false);
      assert.ok(second.looked > 0);
    });
  } finally {
    Date.now = realNow;
  }
});

test("importMail(): 4 分に届かなければ打ち切らない（stopped は false）", () => {
  withLedger({ mails: loadFixtureMails(12) }, () => {
    const result = importMail();
    assert.equal(result.stopped, false);
    assert.equal(result.looked, 12);
  });
});

test("importMail(): 種別が混ざったメールは締切ごとに種別を決める（重要 5）", () => {
  const mails = [
    {
      id: "z10",
      threadId: "z10",
      from: "株式会社サンプル商事 <recruit@a.example.jp>",
      subject: "ES提出とWebテスト受検のご案内",
      date: "2026-03-01T10:00:00+09:00",
      body: "ES提出締切：3月10日（火）23:59\nWebテスト受検期限：3月12日（木）17:00",
    },
  ];
  withLedger({ mails: mails }, () => {
    importMail();
    const list = api_listCandidates().candidates;
    const byDeadline = {};
    for (let i = 0; i < list.length; i += 1) byDeadline[String(list[i].deadline).slice(0, 10)] = list[i];
    assert.equal(byDeadline["2026-03-10"].kind, "es_deadline");
    assert.match(byDeadline["2026-03-10"].title, /ES提出$/);
    assert.equal(byDeadline["2026-03-12"].kind, "test_deadline");
    assert.match(byDeadline["2026-03-12"].title, /Webテスト$/);
  });
});
