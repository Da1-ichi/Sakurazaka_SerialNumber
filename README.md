# シリアル読み取り試作版

スマホのブラウザでカメラを開き、中央のガイド枠にシリアル欄を合わせて OCR する試作アプリです。

## 機能

- 背面カメラ起動
- 画面下寄りのガイド枠を切り出して OCR
- OCR 結果から英数字 13 桁候補を抽出
- 候補を選んで保存
- 個別コピー / 全件コピー
- localStorage で保持
- 重複表示

## 起動手順

```bash
npm install
npm run dev
```

開発サーバーが起動したら、表示された URL を開いて使ってください。

## スマホで使うとき

- 同じネットワーク内で `npm run dev -- --host` を使うか、通常の `npm run dev` でも vite.config.ts で `host: true` にしているので LAN からアクセスできます。
- iPhone の Safari はカメラ利用に HTTPS が必要になる場合があります。ローカル検証では Mac + Safari の制約に注意してください。
- Android Chrome でも HTTPS または localhost 相当が必要です。

## 調整ポイント

`src/App.tsx` の以下で切り抜き位置を調整できます。

```ts
const cropWidth = Math.floor(videoWidth * 0.72);
const cropHeight = Math.floor(videoHeight * 0.16);
const cropX = Math.floor((videoWidth - cropWidth) / 2);
const cropY = Math.floor(videoHeight * 0.74);
```

## 今後の改善候補

- 文字補正ルールの強化 (`0/O`, `1/I/L`, `8/B`)
- 候補選択ではなく自動確定ロジックの追加
- PWA 化
- CSV 出力
- 撮影画像の台形補正
