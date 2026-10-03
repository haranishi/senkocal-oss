/**
 * gas-mocks.mjs — GmailApp／CalendarApp／SpreadsheetApp などのインメモリ実装
 *
 * Google のサービスは実際に叩けない（叩かない）ので、ここで同じ形の偽物を用意して
 * `globalThis` に差し、`src/gas/*.js` をそのまま Node で走らせる。**呼び出しをすべて記録する**ので、
 * 「取り込みの経路で CalendarApp が 1 回も呼ばれない（K-2）」のような約束を件数 0 で固定できる。
 *
 * 実物との差で気をつけたところ:
 * - `getLastRow()` は「値のある最後の行」。空文字だけの行は数えない
 * - `getRange(...)` はシートの外も読める（実物と同じく空文字が返る）
 * - `createEvent` などは呼び出し引数（Date を含む）をそのまま記録する
 */
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const mailsDir = fileURLToPath(new URL("../../fixtures/mails/", import.meta.url));

/** 値が空とみなせるか */
function isBlank(value) {
  return value === "" || value === null || value === undefined;
}

/** 1 枚のシート */
export function createSheetMock(name) {
  const grid = [];
  const validations = [];
  const calls = [];

  function ensure(row, col) {
    while (grid.length < row) grid.push([]);
    const line = grid[row - 1];
    while (line.length < col) line.push("");
  }

  function readCell(row, col) {
    const line = grid[row - 1];
    if (!line) return "";
    const value = line[col - 1];
    return value === undefined ? "" : value;
  }

  function makeRange(row, col, numRows, numCols) {
    const range = {
      getRow: () => row,
      getColumn: () => col,
      getNumRows: () => numRows,
      getNumColumns: () => numCols,
      getValues() {
        const out = [];
        for (let r = 0; r < numRows; r += 1) {
          const line = [];
          for (let c = 0; c < numCols; c += 1) line.push(readCell(row + r, col + c));
          out.push(line);
        }
        return out;
      },
      getValue() {
        return readCell(row, col);
      },
      setValues(values) {
        calls.push({ name: "setValues", row, col, rows: values.length, cols: values[0] ? values[0].length : 0 });
        for (let r = 0; r < values.length; r += 1) {
          for (let c = 0; c < values[r].length; c += 1) {
            ensure(row + r, col + c);
            grid[row + r - 1][col + c - 1] = values[r][c];
          }
        }
        return range;
      },
      setValue(value) {
        return range.setValues([[value]]);
      },
      clearContent() {
        calls.push({ name: "clearContent", row, col, rows: numRows, cols: numCols });
        for (let r = 0; r < numRows; r += 1) {
          for (let c = 0; c < numCols; c += 1) {
            ensure(row + r, col + c);
            grid[row + r - 1][col + c - 1] = "";
          }
        }
        return range;
      },
      setDataValidation(rule) {
        calls.push({ name: "setDataValidation", row, col, rows: numRows, cols: numCols });
        validations.push({ row, col, numRows, numCols, rule });
        return range;
      },
      setFontWeight() {
        return range;
      },
      setNumberFormat() {
        return range;
      },
      setWrap() {
        return range;
      },
    };
    return range;
  }

  const sheet = {
    grid,
    validations,
    calls,
    getName: () => name,
    getLastRow() {
      let last = 0;
      for (let i = 0; i < grid.length; i += 1) {
        const line = grid[i] || [];
        for (let k = 0; k < line.length; k += 1) {
          if (!isBlank(line[k])) {
            last = i + 1;
            break;
          }
        }
      }
      return last;
    },
    getLastColumn() {
      let last = 0;
      for (let i = 0; i < grid.length; i += 1) {
        const line = grid[i] || [];
        for (let k = 0; k < line.length; k += 1) {
          if (!isBlank(line[k]) && k + 1 > last) last = k + 1;
        }
      }
      return last;
    },
    /** シートの行数（グリッドの大きさ）。実物の新規シートは 1000 行から始まり、書き込みで伸びる */
    getMaxRows() {
      return Math.max(1000, sheet.getLastRow());
    },
    getDataRange() {
      return makeRange(1, 1, Math.max(sheet.getLastRow(), 1), Math.max(sheet.getLastColumn(), 1));
    },
    getRange(row, col, numRows, numCols) {
      return makeRange(row, col, numRows === undefined ? 1 : numRows, numCols === undefined ? 1 : numCols);
    },
    appendRow(values) {
      const row = sheet.getLastRow() + 1;
      makeRange(row, 1, 1, values.length).setValues([values]);
      return sheet;
    },
    deleteRows(start, count) {
      calls.push({ name: "deleteRows", start, count });
      grid.splice(start - 1, count);
      return sheet;
    },
    setFrozenRows(n) {
      sheet.frozenRows = n;
      return sheet;
    },
    /** テストから中身を読む（見出し行を除いた行） */
    rows() {
      const out = [];
      for (let i = 1; i < grid.length; i += 1) {
        const line = grid[i] || [];
        let empty = true;
        for (let k = 0; k < line.length; k += 1) {
          if (!isBlank(line[k])) empty = false;
        }
        if (!empty) out.push(line.slice());
      }
      return out;
    },
  };
  return sheet;
}

/** 1 冊のスプレッドシート */
export function createSpreadsheetMock(id, name) {
  const sheets = [createSheetMock("シート1")];
  const book = {
    getId: () => id,
    getName: () => name,
    getUrl: () => "https://docs.example.com/spreadsheets/d/" + id + "/edit",
    getSheets: () => sheets.slice(),
    getSheetByName(target) {
      for (let i = 0; i < sheets.length; i += 1) {
        if (sheets[i].getName() === target) return sheets[i];
      }
      return null;
    },
    insertSheet(target) {
      const sheet = createSheetMock(target);
      sheets.push(sheet);
      return sheet;
    },
    deleteSheet(sheet) {
      const index = sheets.indexOf(sheet);
      if (index >= 0) sheets.splice(index, 1);
      return book;
    },
  };
  return book;
}

/** SpreadsheetApp */
export function createSpreadsheetAppMock() {
  const books = new Map();
  const calls = [];
  let counter = 0;
  const app = {
    calls,
    books,
    create(name) {
      counter += 1;
      const id = "book-" + counter;
      const book = createSpreadsheetMock(id, name);
      books.set(id, book);
      calls.push({ name: "create", args: [name] });
      return book;
    },
    openById(id) {
      calls.push({ name: "openById", args: [id] });
      const book = books.get(id);
      if (!book) throw new Error("スプレッドシートが見つかりません: " + id);
      return book;
    },
    newDataValidation() {
      const rule = { list: null, allowInvalid: true, dropdown: false };
      const builder = {
        requireValueInList(list, dropdown) {
          rule.list = list.slice();
          rule.dropdown = dropdown === true;
          return builder;
        },
        setAllowInvalid(value) {
          rule.allowInvalid = value === true;
          return builder;
        },
        build() {
          return rule;
        },
      };
      return builder;
    },
    /** テスト用: 最初に作られた台帳 */
    firstBook() {
      const values = Array.from(books.values());
      return values.length > 0 ? values[0] : null;
    },
  };
  return app;
}

/** GmailApp（読むだけ。書き換える API はわざと生やさない） */
export function createGmailAppMock(mails) {
  const calls = [];
  /** 本文を読んだメッセージの id（処理済みを本文ごと読み飛ばしているかを見る・軽微 7） */
  const bodyReads = [];
  const source = Array.isArray(mails) ? mails : [];
  const order = [];
  const grouped = new Map();
  for (let i = 0; i < source.length; i += 1) {
    const mail = source[i];
    const key = String(mail.threadId || mail.id);
    if (!grouped.has(key)) {
      grouped.set(key, []);
      order.push(key);
    }
    grouped.get(key).push(mail);
  }

  function makeThread(key) {
    const thread = {
      getId: () => key,
      getMessages() {
        const list = grouped.get(key) || [];
        return list.map((mail) => makeMessage(mail, thread));
      },
    };
    return thread;
  }

  function makeMessage(mail, thread) {
    return {
      getId: () => String(mail.id),
      getThread: () => thread,
      getFrom: () => String(mail.from || ""),
      getSubject: () => String(mail.subject || ""),
      getDate: () => new Date(mail.date),
      getPlainBody: () => {
        bodyReads.push(String(mail.id));
        return String(mail.body || "");
      },
    };
  }

  return {
    calls,
    bodyReads,
    search(query, start, max) {
      calls.push({ name: "search", args: [query, start, max] });
      const threads = order.map(makeThread);
      const from = start || 0;
      const count = max === undefined || max === null ? threads.length : max;
      return threads.slice(from, from + count);
    },
  };
}

/** CalendarApp（呼び出しを全部記録する＝K-2 の検証に使う） */
export function createCalendarAppMock() {
  const calls = [];
  const events = new Map();
  let counter = 0;

  function makeEvent(kind, detail) {
    counter += 1;
    const id = "event-" + counter + "@example.com";
    const record = {
      id,
      kind,
      title: detail.title,
      start: detail.start || null,
      end: detail.end || null,
      date: detail.date || null,
      options: detail.options || {},
      reminders: [],
      tags: {},
      deleted: false,
    };
    const handle = {
      getId: () => id,
      getTitle: () => record.title,
      addPopupReminder(minutes) {
        record.reminders.push(minutes);
        calls.push({ name: "addPopupReminder", args: [minutes] });
        return handle;
      },
      setTag(key, value) {
        record.tags[key] = value;
        calls.push({ name: "setTag", args: [key, value] });
        return handle;
      },
      deleteEvent() {
        record.deleted = true;
        calls.push({ name: "deleteEvent", args: [id] });
      },
    };
    record.handle = handle;
    events.set(id, record);
    return handle;
  }

  const calendar = {
    getName: () => "テスト用カレンダー",
    createEvent(title, start, end, options) {
      calls.push({ name: "createEvent", args: [title, start, end, options] });
      return makeEvent("timed", { title, start, end, options });
    },
    createAllDayEvent(title, date, options) {
      calls.push({ name: "createAllDayEvent", args: [title, date, options] });
      return makeEvent("allDay", { title, date, options });
    },
    getEventById(id) {
      calls.push({ name: "getEventById", args: [id] });
      const record = events.get(id);
      return record && !record.deleted ? record.handle : null;
    },
  };

  return {
    calls,
    events,
    calendar,
    getDefaultCalendar() {
      calls.push({ name: "getDefaultCalendar", args: [] });
      return calendar;
    },
    getCalendarById(id) {
      calls.push({ name: "getCalendarById", args: [id] });
      return calendar;
    },
    /** 名前ごとの呼び出し回数 */
    countOf(name) {
      let n = 0;
      for (let i = 0; i < calls.length; i += 1) {
        if (calls[i].name === name) n += 1;
      }
      return n;
    },
    recordOf(id) {
      return events.get(id) || null;
    },
  };
}

/** PropertiesService */
export function createPropertiesServiceMock(initial) {
  const store = Object.assign({}, initial || {});
  const properties = {
    getProperty(key) {
      return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null;
    },
    setProperty(key, value) {
      store[key] = String(value);
      return properties;
    },
    deleteProperty(key) {
      delete store[key];
      return properties;
    },
    getProperties() {
      return Object.assign({}, store);
    },
  };
  return { store, getScriptProperties: () => properties, getUserProperties: () => properties };
}

/**
 * LockService（取れる／取れないを切り替えられる）。
 * **持っている間は 2 人目に渡さない**＝実物と同じ振る舞いにしてある。こうすると
 * 「登録の途中で同じ api_* が来る」（＝二重クリック）を Node のテストで再現できる。
 */
export function createLockServiceMock(options) {
  const settings = options || {};
  const calls = [];
  let held = false;
  const lock = {
    tryLock(ms) {
      calls.push({ name: "tryLock", args: [ms] });
      if (settings.acquire === false) return false;
      if (held) return false;
      held = true;
      return true;
    },
    releaseLock() {
      held = false;
      calls.push({ name: "releaseLock", args: [] });
    },
    hasLock() {
      return held;
    },
  };
  return { calls, getScriptLock: () => lock };
}

/** HtmlService */
export function createHtmlServiceMock() {
  const calls = [];
  function makeOutput(fileName) {
    const output = {
      fileName,
      title: "",
      metaTags: [],
      setTitle(value) {
        output.title = value;
        calls.push({ name: "setTitle", args: [value] });
        return output;
      },
      addMetaTag(name, content) {
        output.metaTags.push({ name, content });
        calls.push({ name: "addMetaTag", args: [name, content] });
        return output;
      },
      getContent() {
        return "<!-- " + fileName + " -->";
      },
    };
    return output;
  }
  return {
    calls,
    createHtmlOutputFromFile(fileName) {
      calls.push({ name: "createHtmlOutputFromFile", args: [fileName] });
      return makeOutput(fileName);
    },
  };
}

/** ScriptApp（トリガー） */
export function createScriptAppMock() {
  const triggers = [];
  const calls = [];
  let counter = 0;
  return {
    calls,
    triggers,
    newTrigger(handlerName) {
      calls.push({ name: "newTrigger", args: [handlerName] });
      const builder = {
        timeBased() {
          calls.push({ name: "timeBased", args: [] });
          const clock = {
            everyHours(hours) {
              calls.push({ name: "everyHours", args: [hours] });
              return {
                create() {
                  counter += 1;
                  const id = "trigger-" + counter;
                  const trigger = {
                    getUniqueId: () => id,
                    getHandlerFunction: () => handlerName,
                    hours,
                  };
                  triggers.push(trigger);
                  calls.push({ name: "create", args: [handlerName, hours] });
                  return trigger;
                },
              };
            },
            everyMinutes(minutes) {
              calls.push({ name: "everyMinutes", args: [minutes] });
              return clock;
            },
          };
          return clock;
        },
      };
      return builder;
    },
    getProjectTriggers() {
      return triggers.slice();
    },
    deleteTrigger(trigger) {
      const index = triggers.indexOf(trigger);
      if (index >= 0) triggers.splice(index, 1);
      calls.push({ name: "deleteTrigger", args: [trigger.getHandlerFunction()] });
    },
  };
}

/**
 * すべてのモックを globalThis に差す。
 * @param {{mails?: object[], lock?: {acquire?: boolean}, properties?: object}} [options]
 * @returns {{gmail, calendar, spreadsheet, properties, lock, html, script, restore: Function}}
 */
export function installGasMocks(options) {
  const settings = options || {};
  const handles = {
    gmail: createGmailAppMock(settings.mails || []),
    calendar: createCalendarAppMock(),
    spreadsheet: createSpreadsheetAppMock(),
    properties: createPropertiesServiceMock(settings.properties),
    lock: createLockServiceMock(settings.lock),
    html: createHtmlServiceMock(),
    script: createScriptAppMock(),
  };
  const names = {
    GmailApp: handles.gmail,
    CalendarApp: handles.calendar,
    SpreadsheetApp: handles.spreadsheet,
    PropertiesService: handles.properties,
    LockService: handles.lock,
    HtmlService: handles.html,
    ScriptApp: handles.script,
  };
  const keys = Object.keys(names);
  const previous = {};
  for (let i = 0; i < keys.length; i += 1) {
    previous[keys[i]] = globalThis[keys[i]];
    globalThis[keys[i]] = names[keys[i]];
  }
  handles.restore = function () {
    for (let i = 0; i < keys.length; i += 1) {
      if (previous[keys[i]] === undefined) delete globalThis[keys[i]];
      else globalThis[keys[i]] = previous[keys[i]];
    }
  };
  return handles;
}

/** 合成メール fixture を番号順に読む */
export function loadFixtureMails(limit) {
  const names = fs
    .readdirSync(mailsDir)
    .filter((name) => name.endsWith(".json"))
    .sort();
  const picked = limit === undefined || limit === null ? names : names.slice(0, limit);
  return picked.map((name) => JSON.parse(fs.readFileSync(mailsDir + name, "utf8")));
}

/** 番号を指定して読む（例: pickFixtureMails(["01", "17"])） */
export function pickFixtureMails(numbers) {
  return numbers.map((number) => JSON.parse(fs.readFileSync(mailsDir + number + ".json", "utf8")));
}

/** 台帳のシートをテストから覗く */
export function ledgerSheet(spreadsheet, name) {
  const book = spreadsheet.firstBook();
  return book ? book.getSheetByName(name) : null;
}
