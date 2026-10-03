/**
 * gas-stub.js — ブラウザ側の `google.script.run` の偽物（addInitScript で流し込む）
 *
 * 本物の Apps Script は動かせないので、確認画面が「サーバーとやり取りする形」だけを再現する。
 * - `withSuccessHandler` / `withFailureHandler` / `withUserObject` はチェーンできる
 * - 呼び出しは `setTimeout(…, delay)` の後にハンドラを呼ぶ（`loading` 状態を撮れるようにするため）
 * - 渡された引数は型ごと記録する（`Date` を境界に乗せていないことをテストで見る）
 * - seed と失敗の注入は `window.__gasStubConfig`（このファイルより先に addInitScript する）で渡す
 *
 * 台帳の代わりは `window.__gasStub.candidates` の配列。api_* はこの配列を書き換える。
 */
(function () {
  var config = window.__gasStubConfig || {};

  /**
   * 画面に出る文言は本番と同じにする（撮影したスクショに「スタブ」を出さないため）。
   * 出どころは src/gas/adapters.js の LEDGER_MISSING_MESSAGE と registerOne の失敗。
   */
  var LEDGER_MISSING_MESSAGE = "台帳がありません。Apps Script で setup() を実行してください";
  var FAILURE_MESSAGE = "カレンダーに書き込めませんでした";

  /** 候補 1 件（サーバーが返す形＝台帳の 24 列＋画面用の 3 つ） */
  function makeCandidate(overrides) {
    var base = {
      id: "c_stub_0",
      messageId: "m_stub_0",
      threadId: "t_stub_0",
      receivedAt: "2026-03-02T09:00:00+09:00",
      company: "株式会社サンプル",
      media: "direct",
      kind: "interview",
      stage: null,
      title: "【面接】株式会社サンプル",
      start: null,
      end: null,
      allDay: false,
      deadline: null,
      choices: [],
      location: null,
      url: null,
      subject: "（件名）",
      from: "株式会社サンプル 採用担当 <recruit@sample.example.co.jp>",
      isPast: false,
      confidence: "high",
      reasons: [],
      status: "候補",
      eventId: null,
      registeredAt: null,
      note: "",
    };
    var names = Object.keys(overrides || {});
    for (var i = 0; i < names.length; i += 1) base[names[i]] = overrides[names[i]];
    return decorate(base);
  }

  /** サーバー側（api_listCandidates）が足している画面用の値 */
  function decorate(candidate) {
    var at = candidate.start || candidate.deadline || null;
    candidate.gmailUrl = "https://mail.google.com/mail/u/0/#all/" + candidate.messageId;
    candidate.calendarUrl = at ? "https://calendar.google.com/calendar/u/0/r/day/" + dayPath(at) : "";
    candidate.registerable = at !== null && at !== "";
    candidate.planReason = candidate.registerable ? "" : "日付がありません。編集して日時を入れてください";
    return candidate;
  }

  function dayPath(iso) {
    var parts = String(iso).slice(0, 10).split("-");
    return Number(parts[0]) + "/" + Number(parts[1]) + "/" + Number(parts[2]);
  }

  /**
   * 既定の seed。予定 5・締切 2・日程調整 2・要確認 2・ノイズ 5・登録済み 1。
   * 確度「高」の `change`（中止のお知らせ）と `schedule_request` を入れてあるのは、
   * 「まとめて登録」がそれを巻き込まないことを固定するため（レビュー r1 重要 3）。
   * seed が確度 中・低 だけだと、条件を外しても E2E が通ってしまっていた。
   */
  function defaultSeed() {
    var list = [
      makeCandidate({
        id: "c_s01_1",
        messageId: "m_s01",
        kind: "interview",
        stage: "1次",
        company: "株式会社サンプル商事",
        title: "【面接】株式会社サンプル商事 1次面接",
        start: "2026-03-05T14:00:00+09:00",
        end: "2026-03-05T15:00:00+09:00",
        location: "本社 3F 会議室",
        subject: "【1次面接のご案内】株式会社サンプル商事",
        confidence: "high",
      }),
      makeCandidate({
        id: "c_s02_1",
        messageId: "m_s02",
        kind: "seminar",
        company: "株式会社サンプル物流",
        title: "【説明会】株式会社サンプル物流",
        start: "2026-03-06T10:00:00+09:00",
        end: "2026-03-06T11:30:00+09:00",
        location: "オンライン（Zoom）",
        url: "https://zoom.us/j/000000000",
        subject: "会社説明会のご案内（3月6日開催）",
        confidence: "high",
      }),
      makeCandidate({
        id: "c_s03_1",
        messageId: "m_s03",
        kind: "interview",
        stage: "最終",
        company: "サンプル製作所株式会社",
        title: "【面接】サンプル製作所株式会社 最終面接",
        start: "2026-03-09T13:00:00+09:00",
        end: "2026-03-09T14:00:00+09:00",
        subject: "最終面接の日程について（サンプル製作所）",
        confidence: "medium",
      }),
      makeCandidate({
        id: "c_s04_1",
        messageId: "m_s04",
        kind: "seminar",
        company: "合同会社テストワークス",
        title: "【説明会】合同会社テストワークス",
        start: "2026-03-12T16:00:00+09:00",
        end: null,
        subject: "【テストワークス】インターンシップ説明会のお知らせ",
        confidence: "high",
      }),
      makeCandidate({
        id: "c_s05_1",
        messageId: "m_s05",
        kind: "es_deadline",
        company: "サンプルフーズ株式会社",
        title: "【締切 23:59】サンプルフーズ株式会社 ES提出",
        deadline: "2026-03-10T23:59:00+09:00",
        allDay: true,
        subject: "エントリーシート提出のご案内",
        confidence: "medium",
      }),
      makeCandidate({
        id: "c_s06_1",
        messageId: "m_s06",
        kind: "test_deadline",
        company: "サンプル化学工業株式会社",
        title: "【締切 23:59】サンプル化学工業株式会社 Webテスト",
        deadline: "2026-03-08T23:59:00+09:00",
        allDay: true,
        subject: "適性検査受検のお願い（3月8日まで）",
        confidence: "high",
      }),
      makeCandidate({
        id: "c_s07_1",
        messageId: "m_s07",
        kind: "schedule_request",
        company: "株式会社サンプル広告",
        title: "【要返信】株式会社サンプル広告 日程選択（候補: 3/5・3/6・3/7）",
        deadline: "2026-03-08",
        allDay: true,
        choices: ["2026-03-05T10:00:00+09:00", "2026-03-06T14:00:00+09:00", "2026-03-07T11:00:00+09:00"],
        subject: "面接日程のご希望をお知らせください",
        confidence: "medium",
      }),
      makeCandidate({
        id: "c_s08_1",
        messageId: "m_s08",
        kind: "interview",
        company: null,
        title: "【面接】（企業名未設定）",
        start: "2026-03-11T16:30:00+09:00",
        end: null,
        subject: "面接のご連絡",
        from: "採用担当 <no-reply@ats.example.com>",
        confidence: "low",
      }),
      makeCandidate({
        id: "c_s09_1",
        messageId: "m_s09",
        kind: "change",
        company: "株式会社サンプル観光",
        title: "【変更】株式会社サンプル観光 説明会",
        subject: "【重要】説明会の日程変更について",
        confidence: "low",
      }),
      makeCandidate({
        id: "c_s10_1",
        messageId: "m_s10",
        kind: "change",
        stage: "1次",
        company: "株式会社サンプル建設",
        title: "【変更】株式会社サンプル建設 面接",
        start: "2026-03-07T10:00:00+09:00",
        end: "2026-03-07T11:00:00+09:00",
        subject: "【重要】1次面接 中止のお知らせ（株式会社サンプル建設）",
        confidence: "high",
      }),
      makeCandidate({
        id: "c_s11_1",
        messageId: "m_s11",
        kind: "schedule_request",
        company: "株式会社サンプル金属",
        title: "【要返信】株式会社サンプル金属 日程選択（候補: 3/13・3/16）",
        deadline: "2026-03-09",
        allDay: true,
        choices: ["2026-03-13T10:00:00+09:00", "2026-03-16T15:00:00+09:00"],
        subject: "面接日程のご都合をお知らせください",
        confidence: "high",
      }),
      makeCandidate({
        id: "c_s15_1",
        messageId: "m_s15",
        kind: "interview",
        stage: "2次",
        company: "株式会社サンプル情報",
        title: "【面接】株式会社サンプル情報 2次面接",
        start: "2026-03-04T11:00:00+09:00",
        end: "2026-03-04T12:00:00+09:00",
        subject: "2次面接のご案内",
        confidence: "high",
        status: "登録済み",
        eventId: "seed-event@example.com",
        registeredAt: "2026-03-02T09:20:00+09:00",
      }),
    ];
    var noiseSubjects = [
      "【オファーが届きました】あなたに興味を持った企業があります",
      "就活マガジン 3月号｜今週のおすすめ求人",
      "【重要】パスワード変更のお知らせ",
      "内定者フォローアップ研修のご案内（配信停止はこちら）",
      "【サンプル人材】あなたにおすすめのインターン 20 選",
    ];
    for (var i = 0; i < noiseSubjects.length; i += 1) {
      list.push(
        makeCandidate({
          id: "c_n" + (i + 1) + "_0",
          messageId: "m_n" + (i + 1),
          kind: "other",
          company: null,
          title: "",
          subject: noiseSubjects[i],
          from: "サンプルナビ <info@mynavi.jp>",
          confidence: "low",
          status: "ノイズ",
          note: "ノイズと判定",
        })
      );
    }
    return list;
  }

  /**
   * この画面が読む候補の一覧。`extraCandidates` は seed に足す差分（サーバー側と同じ形に整えてから足す）。
   * スクショの構成を変えずに、テストだけで見たい候補（過去日など）を混ぜるために使う。
   */
  function seedFor() {
    if (config.candidates) return config.candidates;
    if (config.mode === "empty") return [];
    var list = defaultSeed();
    var extra = config.extraCandidates || [];
    for (var i = 0; i < extra.length; i += 1) list.push(makeCandidate(extra[i]));
    return list;
  }

  var stub = {
    mode: config.mode || "list",
    delay: config.delay === undefined ? 30 : config.delay,
    candidates: seedFor(),
    settings: { intervalHours: 2, searchDays: 7, maxMessagesPerRun: 50, calendarId: "", deadlineReminderMinutes: 900 },
    lastRun: config.lastRun === undefined ? "2026-03-02T09:12:00+09:00" : config.lastRun,
    lastImportCount: config.lastImportCount === undefined ? 12 : config.lastImportCount,
    ledgerUrl: "https://docs.example.com/spreadsheets/d/stub-ledger/edit",
    importAdds: config.importAdds === undefined ? 0 : config.importAdds,
    calls: [],
    failNext: config.failNext || null,
    failAlways: config.failAlways || null,
    eventCounter: 0,
  };
  window.__gasStub = stub;

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function find(id) {
    for (var i = 0; i < stub.candidates.length; i += 1) {
      if (stub.candidates[i].id === id) return stub.candidates[i];
    }
    return null;
  }

  /** 画面が送ってきた datetime-local / date を ISO にする（サーバー側と同じ約束） */
  function toIso(value) {
    if (value === null || value === undefined) return null;
    var text = String(value).trim();
    if (text === "") return null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
    var m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})/.exec(text);
    if (m) return m[1] + "T" + m[2] + ":" + m[3] + ":00+09:00";
    return text;
  }

  function applyEdits(candidate, edits) {
    if (!edits) return candidate;
    if (typeof edits.company === "string" && edits.company.trim() !== "") candidate.company = edits.company.trim();
    if (typeof edits.title === "string" && edits.title.trim() !== "") candidate.title = edits.title.trim();
    if (typeof edits.location === "string") candidate.location = edits.location.trim() === "" ? null : edits.location.trim();
    if (edits.start !== undefined) candidate.start = toIso(edits.start);
    if (edits.end !== undefined) candidate.end = toIso(edits.end);
    if (edits.deadline !== undefined) candidate.deadline = toIso(edits.deadline);
    return decorate(candidate);
  }

  function registerOne(id, edits) {
    var candidate = find(id);
    if (!candidate) throw new Error("候補が見つかりません: " + id);
    applyEdits(candidate, edits);
    if (!candidate.registerable) {
      candidate.note = candidate.planReason;
      return { ok: false, id: id, reason: candidate.planReason, candidate: clone(candidate) };
    }
    if (candidate.status === "登録済み") {
      return { ok: false, id: id, duplicateOf: id, reason: "この候補はすでに登録済みです", candidate: clone(candidate) };
    }
    stub.eventCounter += 1;
    candidate.status = "登録済み";
    candidate.eventId = "stub-event-" + stub.eventCounter;
    candidate.registeredAt = "2026-03-02T09:30:00+09:00";
    candidate.note = "";
    decorate(candidate);
    return { ok: true, id: id, eventId: candidate.eventId, candidate: clone(candidate) };
  }

  function setStatus(id, status) {
    var candidate = find(id);
    if (!candidate) throw new Error("候補が見つかりません: " + id);
    candidate.status = status;
    if (status === "候補") {
      candidate.eventId = null;
      candidate.registeredAt = null;
      candidate.note = "";
    }
    return clone(decorate(candidate));
  }

  var api = {
    api_listCandidates: function () {
      // 本番と同じ文言（src/gas/adapters.js の LEDGER_MISSING_MESSAGE）。「スタブ」を画面に出さない
      if (stub.mode === "error") throw new Error(LEDGER_MISSING_MESSAGE);
      return {
        candidates: clone(stub.candidates),
        settings: clone(stub.settings),
        lastRun: stub.lastRun,
        lastImportCount: stub.lastImportCount,
        ledgerUrl: stub.ledgerUrl,
        now: "2026-03-02T09:40:00+09:00",
      };
    },
    api_registerCandidate: function (id, editsJson) {
      var edits = {};
      if (typeof editsJson === "string" && editsJson !== "") edits = JSON.parse(editsJson);
      else if (editsJson && typeof editsJson === "object") edits = editsJson;
      return registerOne(String(id), edits);
    },
    api_registerBulk: function (idsJson) {
      var ids = typeof idsJson === "string" ? JSON.parse(idsJson) : idsJson || [];
      var results = [];
      var registeredIds = [];
      for (var i = 0; i < ids.length; i += 1) {
        try {
          var one = registerOne(String(ids[i]), null);
          results.push(one);
          if (one.ok) registeredIds.push(one.id);
        } catch (err) {
          results.push({ ok: false, id: String(ids[i]), reason: String(err.message), candidate: null });
        }
      }
      // 画面の帯「まとめて取り消す」はこの id を順に api_undoRegister へ渡す
      return { results: results, registeredIds: registeredIds };
    },
    api_ignoreCandidate: function (id) {
      return { ok: true, id: String(id), candidate: setStatus(String(id), "無視") };
    },
    api_restoreCandidate: function (id) {
      var candidate = find(String(id));
      if (candidate && candidate.status === "登録済み") {
        return { ok: false, id: String(id), reason: "登録済みの候補は「取り消す」を使ってください", candidate: clone(candidate) };
      }
      return { ok: true, id: String(id), candidate: setStatus(String(id), "候補") };
    },
    api_undoRegister: function (id) {
      var candidate = find(String(id));
      var had = Boolean(candidate && candidate.eventId);
      return { ok: true, id: String(id), deleted: had, candidate: setStatus(String(id), "候補") };
    },
    api_importNow: function () {
      var added = stub.importAdds;
      for (var i = 0; i < added; i += 1) {
        stub.candidates.push(
          makeCandidate({
            id: "c_new" + (i + 1) + "_1",
            messageId: "m_new" + (i + 1),
            kind: "seminar",
            company: "株式会社サンプル新着",
            title: "【説明会】株式会社サンプル新着",
            start: "2026-03-14T13:00:00+09:00",
            end: "2026-03-14T14:00:00+09:00",
            subject: "会社説明会のご案内（新着）",
            confidence: "high",
          })
        );
      }
      stub.lastRun = "2026-03-02T09:45:00+09:00";
      stub.lastImportCount = added;
      return { added: added, noise: 0, skipped: false };
    },
  };

  /** 引数を型ごと記録する（Date を境界に乗せていないかを見る） */
  function record(name, args) {
    var values = [];
    var types = [];
    for (var i = 0; i < args.length; i += 1) {
      values.push(args[i]);
      types.push(args[i] instanceof Date ? "Date" : typeof args[i]);
    }
    stub.calls.push({ name: name, args: values, argTypes: types });
  }

  function makeRunner(handlers) {
    var runner = {
      withSuccessHandler: function (fn) {
        return makeRunner({ success: fn, failure: handlers.failure, userObject: handlers.userObject });
      },
      withFailureHandler: function (fn) {
        return makeRunner({ success: handlers.success, failure: fn, userObject: handlers.userObject });
      },
      withUserObject: function (value) {
        return makeRunner({ success: handlers.success, failure: handlers.failure, userObject: value });
      },
    };
    var names = Object.keys(api);
    for (var i = 0; i < names.length; i += 1) {
      runner[names[i]] = makeMethod(names[i], handlers);
    }
    return runner;
  }

  function makeMethod(name, handlers) {
    return function () {
      record(name, arguments);
      var args = Array.prototype.slice.call(arguments);
      var shouldFail = stub.failAlways === name || stub.failNext === name;
      if (stub.failNext === name) stub.failNext = null;
      window.setTimeout(function () {
        if (shouldFail) {
          if (handlers.failure) handlers.failure(new Error(FAILURE_MESSAGE));
          return;
        }
        var result = null;
        try {
          result = api[name].apply(null, args);
        } catch (err) {
          if (handlers.failure) handlers.failure(err);
          return;
        }
        if (handlers.success) handlers.success(result, handlers.userObject);
      }, stub.delay);
    };
  }

  window.google = {
    script: {
      run: makeRunner({}),
      host: {
        setHeight: function () {},
        setWidth: function () {},
        origin: "https://stub.example.com",
        close: function () {},
        editor: { focus: function () {} },
      },
      url: {
        getLocation: function (callback) {
          callback({ parameter: {}, parameters: {}, hash: "" });
        },
      },
    },
  };
})();
