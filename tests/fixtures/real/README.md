# 実メールの置き場（本人専用・git に入らない）

ここに置いた JSON は `.gitignore` で除外される（`tests/fixtures/real/*` を無視し、この README だけ残す設定）。
合成 fixture（`tests/fixtures/mails/`）は実物と形が違うので、**抽出の当たり外れは実メールで確かめる**。その作業場所がここ。

## 置くもの

1 通 = 1 ファイル。ファイル名は何でもよい（`01.json`・`mynavi-2026-03-01.json` など）。中身はこの形。

```json
{
  "id": "18f3ab0c1d2e3f45",
  "threadId": "18f3ab0c1d2e3f45",
  "from": "株式会社◯◯ 採用担当 <recruit@example.co.jp>",
  "subject": "【1次面接のご案内】",
  "date": "2026-03-01T10:12:00+09:00",
  "body": "本文のプレーンテキスト"
}
```

- `date` は受信日時。**必ず `+09:00` を付ける**（年の推定に使う）
- `body` は HTML ではなくプレーンテキスト（Gmail の「メッセージのソースを表示」→ `text/plain` の部分、または本文をそのままコピー）
- `id` は Gmail の message id（分からなければ適当な文字列でよい。較正の表示に使うだけ）

## 作り方（Gmail から手で）

1. Gmail で対象のメールを開く → 右上の「…」→ **メッセージのソースを表示**
2. 表示された画面で本文（`Content-Type: text/plain` の下）をコピー。quoted-printable（`=E3=81...`）で読めない場合は、ソースではなく**通常表示の本文を選択してコピー**でよい
3. 上の形の JSON にして、このフォルダに保存する（改行は `\n`。エディタで JSON として書けば自動で処理される）

## 期待値を付けたいとき

`tests/fixtures/real/expected/<同じファイル名>.json` に、正解を書くと一致率が出る。

```json
{ "kind": "interview", "company": "株式会社◯◯", "start": "2026-03-05T14:00:00+09:00", "deadline": null }
```

書いた項目だけ照合する（`kind` だけ書けば `kind` の一致率だけ出る）。

## 実行

```bash
node tools/calibrate.mjs
```

1 通 1 行の表が出る。外れている行を見て `src/core/` の辞書と正規表現を直す。
`tests/fixtures/real/` が空のときは合成 fixture を使って動く（その旨が表示される）。
