# Otto2 預約通知服務

用 LINE Flex Message 推播：預約成功、預約取消、前一天上課提醒。

## 部署到 Railway

1. 把這個資料夾推到一個新的 GitHub repo（例如 `otto2-notify`）
2. Railway → New Project → Deploy from GitHub repo → 選它
3. 到 Variables 分頁，新增以下環境變數：

| 變數 | 值 | 說明 |
|---|---|---|
| `LINE_TOKEN` | （貼上） | LINE Developers → Otto2 ART CLUB 旗艦館 channel → Messaging API 分頁最下方的 Channel access token |
| `FIREBASE_URL` | `https://otto2-booking-f9ef7-default-rtdb.asia-southeast1.firebasedatabase.app` | |
| `CRON_KEY` | 自己想一組密碼 | 保護每日提醒不被亂觸發 |
| `MAP_URL` | `https://reurl.cc/4QZm5L` | 選填，地圖短網址 |

4. 部署完成後，Settings → Networking → Generate Domain，得到服務網址
   例如 `https://otto2-notify-production.up.railway.app`

## 設定每日提醒排程

Railway → 專案 → New → Cron Job，指令填：

```
curl "https://你的服務網址/cron/remind?key=你的CRON_KEY"
```

排程時間填 `0 10 * * *`（UTC 10:00 = 台灣傍晚 18:00）

## 三個端點

- `POST /notify/booking` — 預約成功（預約頁自動呼叫）
- `POST /notify/cancel` — 預約取消（後台呼叫）
- `GET /cron/remind?key=xxx` — 前一天提醒（排程呼叫，同一筆只發一次）

## 測試

部署後先手動打一次提醒端點，看回傳的 `sent` 數字：

```
https://你的服務網址/cron/remind?key=你的CRON_KEY
```
