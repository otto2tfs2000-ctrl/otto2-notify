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
| `FIREBASE_API_KEY` | `AIzaSyDgPVrHEYScDfuIPyvsBNNEdSROKJBgHqY` | 選填，不填就用內建預設值。這是 otto2-admin.html 後台登入用的同一把 Firebase Web API Key，`/admin/broadcast` 拿它驗證後台登入身分 |

4. 部署完成後，Settings → Networking → Generate Domain，得到服務網址
   例如 `https://otto2-notify-production.up.railway.app`

## 設定排程（Railway Cron Job）

Railway → 專案 → New → Cron Job，各建一條：

| 用途 | 指令 | 排程時間 |
|---|---|---|
| 上課前提醒 | `curl "https://你的服務網址/cron/remind?key=你的CRON_KEY"` | `0 10 * * *`（UTC 10:00 = 台灣傍晚 18:00） |
| 訂單逾時提醒 | `curl "https://你的服務網址/cron/overdue-remind?key=你的CRON_KEY"` | `0 * * * *`（每小時一次即可，實際發送頻率由後台「通知設定」的開關與時數控制） |

兩條提醒排程實際會不會發、要提前幾天／幾小時發，都由 otto2-admin.html 後台「通知設定」分頁控制
（存在 Firebase `/settings/notify`），不用改程式碼或排程時間。

## 端點

- `POST /notify/booking` — 預約成功（預約頁自動呼叫）
- `POST /notify/cancel` — 預約取消（後台呼叫）
- `GET /cron/remind?key=xxx` — 上課前提醒（排程呼叫，同一筆只發一次，天數由後台設定）
- `GET /cron/overdue-remind?key=xxx` — 訂單逾時提醒（排程呼叫，同一筆只發一次，時數由後台設定）
- `POST /admin/broadcast` — 手動廣播給所有留過 LINE 身分的客人（後台「通知設定」頁呼叫，需要有效的後台登入 idToken）

## 測試

部署後先手動打一次提醒端點，看回傳的 `sent` 數字：

```
https://你的服務網址/cron/remind?key=你的CRON_KEY
https://你的服務網址/cron/overdue-remind?key=你的CRON_KEY
```
