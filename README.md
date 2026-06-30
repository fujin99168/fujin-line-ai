# Fujin LINE AI

福進環保 LINE AI 派工系統 v1

## 功能

- LINE Webhook 接收訊息
- 驗證 LINE Signature
- 寫入 Google Sheets
- 支援群組 / 個人聊天
- 記錄時間、來源、群組 ID、使用者 ID、訊息內容
- 測試訊息包含「測試」時，LINE 會回覆「已收到，已寫入福進環保派工紀錄。」

## Cloudflare 必要 Variables / Secrets

請在 Worker Settings → Variables and secrets 建立：

- `GOOGLE_SERVICE_ACCOUNT`：Google Service Account JSON
- `SHEET_ID`：Google Sheet ID
- `LINE_CHANNEL_SECRET`：LINE Channel Secret
- `LINE_CHANNEL_ACCESS_TOKEN`：LINE Channel Access Token
- `SHEET_NAME`：可選，預設為 `派工紀錄`

## Google Sheet 欄位

建議工作表名稱：`派工紀錄`

第一列欄位：

| 時間 | 來源 | 群組ID | 房間ID | 使用者ID | 事件類型 | 訊息 | 原始資料 |
|---|---|---|---|---|---|---|---|
