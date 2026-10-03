# 選考カレンダー — OSS版

自分のGmailに届いた案内をルールベースで解析し、確認した候補だけをGoogleカレンダーへ登録する、個人用 Google Apps Script ツールです。

## ソースの構成

`src/core/` に抽出・台帳・予定の純関数、`src/gas/` にGoogleサービスへの接続層、`src/ui/` に確認画面があります。
同梱する41通のメールfixtureは合成データです。実メール、シートID、デプロイURL、OAuth認証情報は含めていません。

## ローカルの確認

```sh
npm run test:unit
npm run build
npm run test:policy
# ブラウザ検証だけで使う開発ツール。実行コードの依存はありません。
npm install --no-save --package-lock=false @playwright/test@1.62.1
npx playwright install chromium
npm run test:e2e
```

E2EはGoogleサービスをスタブに置き換えます。実アカウントにはアクセスしません。

## 自分のアカウントで使う前に

ビルドで生成した `dist/Code.gs`、`dist/index.html`、`dist/appsscript.json` を自分のApps Scriptへ配置する方式です。
詳細は `docs/OWNER_TASKS.md` と `docs/PRIVACY_NOTE.md` を参照してください。
最初はテスト用アカウントと合成メールで確認し、Webアプリへのアクセスを「自分のみ」にしてください。
日時の推定には限界があります。登録前に原文を確認してください。

ソース公開と、第三者へOAuthアプリを提供することは別です。一般提供する場合は [Googleのrestricted scope確認](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification) と最新の審査条件を確認してください。
この作業ではデプロイ、OAuth承認、メール・予定の操作を行っていません。実アカウントでの動作は未検証です。

## ライセンスと公開範囲

自作ソースは [MIT](LICENSE) です。GoogleサービスにはGoogleの条件が適用されます。
このOSS版は新規履歴で、私用の開発指示・採点記録は含めていません。
