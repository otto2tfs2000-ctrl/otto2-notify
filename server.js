import express from "express";
import crypto from "crypto";

const app = express();
app.use(express.json());

/* 跨網域授權：預約頁在 github.io，服務在 railway.app */
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

/* 請求日誌：方便在 Railway 看得到每一次呼叫 */
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

/* ── 環境變數（設在 Railway → Variables）──
   LINE_TOKEN   : LINE Bot 的 Channel access token（Messaging API 分頁最下方）
   FIREBASE_URL : Realtime Database 網址
   CRON_KEY     : 自訂密碼，保護每日提醒不被亂觸發
   STUDIO_ADDR  : 地址（可省略，有預設值）
   MAP_URL      : 地圖短網址（可省略）
*/
const LINE_TOKEN   = process.env.LINE_TOKEN;
const FIREBASE_URL = (process.env.FIREBASE_URL || "").replace(/\/$/, "");
const CRON_KEY     = process.env.CRON_KEY || "otto2";
const STUDIO_ADDR  = process.env.STUDIO_ADDR || "台中市南屯區干城街328號4樓「Art2plaza親子美學館」內，入內有電梯";
const MAP_URL      = process.env.MAP_URL || "";

/* ── LINE Pay Online API v3 ──
   LINEPAY_CHANNEL_ID     : LINE Pay 商家後台 → 線上服務 → Channel ID
   LINEPAY_CHANNEL_SECRET : 同上，Channel Secret Key（絕不可寫進程式碼或前端）
   LINEPAY_ENV            : sandbox 或 production
   SELF_URL               : 這個服務自己的網址（LINE Pay 要回打）
   LIFF_URL               : 預約頁網址，付款取消時導回
   HOLD_MINUTES           : 未付款訂單保留幾分鐘後釋放名額
*/
const LP_ID     = process.env.LINEPAY_CHANNEL_ID;
const LP_SECRET = process.env.LINEPAY_CHANNEL_SECRET;
const LP_ENV    = (process.env.LINEPAY_ENV || "sandbox").toLowerCase();
const LP_HOST   = LP_ENV === "production" ? "https://api-pay.line.me" : "https://sandbox-api-pay.line.me";
const SELF_URL  = (process.env.SELF_URL || "https://otto2-notify-production.up.railway.app").replace(/\/$/, "");
const LIFF_URL  = process.env.LIFF_URL || "https://liff.line.me/2010906803-FMDYktUN";
const HOLD_MIN  = Number(process.env.HOLD_MINUTES || 15);

const NAVY = "#1E2B4F", GOLD = "#E3B34C", INK = "#2A2E38", SOFT = "#6B7180";

/* ── 共用：推播 ── */
async function push(to, messages) {
  if (!LINE_TOKEN) throw new Error("缺少 LINE_TOKEN");
  const res = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${LINE_TOKEN}`,
    },
    body: JSON.stringify({ to, messages }),
  });
  if (!res.ok) throw new Error(`LINE API ${res.status}: ${await res.text()}`);
}

/* ── 共用：格式化 ── */
const WD = ["日", "一", "二", "三", "四", "五", "六"];
function dateLabel(d) {
  const [y, m, dd] = d.split("/").map(Number);
  return `${d}（${WD[new Date(y, m - 1, dd).getDay()]}）`;
}
function itemLines(items = []) {
  return items.map((i) => {
    const spec = i.spec ? `（${i.spec}）` : "";
    const add = (i.addons || []).map((a) => `＋${a.name}`).join("　");
    return `${i.name}${spec} × ${i.qty} 位${add ? "\n　" + add : ""}`;
  });
}

/* ── Flex 元件 ── */
const row = (label, value, bold = false) => ({
  type: "box", layout: "baseline", spacing: "sm",
  contents: [
    { type: "text", text: label, color: SOFT, size: "sm", flex: 2 },
    { type: "text", text: value, wrap: true, color: bold ? NAVY : INK,
      size: "sm", flex: 5, weight: bold ? "bold" : "regular", align: "end" },
  ],
});

function card({ tag, tagColor, title, rows, notes, footer }) {
  return {
    type: "bubble",
    body: {
      type: "box", layout: "vertical", spacing: "md",
      contents: [
        { type: "text", text: tag, weight: "bold", color: tagColor, size: "sm" },
        { type: "text", text: title, weight: "bold", size: "lg", color: NAVY, wrap: true },
        { type: "separator", margin: "md" },
        { type: "box", layout: "vertical", spacing: "sm", margin: "md", contents: rows },
        ...(notes
          ? [
              { type: "separator", margin: "md" },
              { type: "text", text: notes, wrap: true, size: "xs", color: SOFT, margin: "md" },
            ]
          : []),
      ],
    },
    footer: footer
      ? {
          type: "box", layout: "vertical",
          contents: [
            { type: "text", text: footer, size: "xxs", color: SOFT, align: "center" },
          ],
        }
      : undefined,
    styles: { body: { backgroundColor: "#FFFFFF" } },
  };
}

/* ══ 1. 預約成功 ══ */
app.post("/notify/booking", async (req, res) => {
  try {
    const b = req.body || {};
    const uid = b.line?.userId;
    if (!uid) return res.json({ ok: false, skip: "無 LINE 身分，略過推播" });

    const items = itemLines(b.items);
    const dep = b.deposit || {};
    const depName = dep.name || (dep.method === "points" ? "儲值金扣點" : dep.method === "transfer" ? "銀行匯款" : "LINE Pay 訂金");
    const depText = dep.amount
      ? `${depName}　${dep.method === "points" ? dep.amount + " 點" : "NT$" + dep.amount}`
      : depName;
    const depNote =
      dep.method === "points"
        ? "我們將為你預扣點數，小編確認後會再回覆你。"
        : dep.method === "transfer"
        ? "請完成匯款後，將帳號末五碼回傳 LINE，小編確認後預約才算保留成功。"
        : dep.method === "card"
        ? "訂金於上課當日至櫃檯刷卡，小編會再與你確認。"
        : "請於今日內完成 LINE Pay 訂金付款並回傳截圖，小編確認後預約才算保留成功。";

    const bubble = card({
      tag: "預約成功通知",
      tagColor: "#2E7D4F",
      title: "Otto2 ARTCLUB 旗艦館",
      rows: [
        row("日期", dateLabel(b.date), true),
        row("時段", b.actualTime || (b.slot2 ? `${b.slot}\n＋ ${b.slot2}` : b.slot), true),
        row("課程", items.join("\n") || "—"),
        row("人數", `${b.people} 位`),
        row("金額", `NT$${(b.total || 0).toLocaleString()}`),
        row("訂金", depText),
      ],
      notes: depNote,
      footer: "Otto2 ARTCLUB 藝術工作室",
    });

    await push(uid, [
      { type: "flex", altText: `預約成功：${b.date} ${b.slot}`, contents: bubble },
    ]);
    console.log("推播成功 →", uid.slice(0, 8) + "...", b.date, b.slot);
    res.json({ ok: true });
  } catch (e) {
    console.error("推播失敗：", e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ══ 2. 預約取消 ══ */
app.post("/notify/cancel", async (req, res) => {
  try {
    const b = req.body || {};
    const uid = b.line?.userId;
    if (!uid) return res.json({ ok: false, skip: "無 LINE 身分" });

    const bubble = card({
      tag: "預約取消",
      tagColor: SOFT,
      title: "此筆預約已取消",
      rows: [
        row("日期", dateLabel(b.date), true),
        row("時段", b.actualTime || b.slot, true),
        row("課程", itemLines(b.items).join("\n") || "—"),
        row("人數", `${b.people} 位`),
      ],
      notes: b.reason || "如需重新預約，歡迎點選圖文選單的「線上預約」，或直接與小編聯繫。",
      footer: "Otto2 ARTCLUB 藝術工作室",
    });

    await push(uid, [
      { type: "flex", altText: `預約取消：${b.date} ${b.slot}`, contents: bubble },
    ]);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ══ 3. 前一天提醒（Railway Cron 每天傍晚呼叫）══ */
app.get("/cron/remind", async (req, res) => {
  try {
    if (req.query.key !== CRON_KEY) return res.status(403).json({ ok: false });

    // 以台灣時間算「明天」
    const now = new Date(Date.now() + 8 * 3600 * 1000);
    now.setUTCDate(now.getUTCDate() + 1);
    const p = (n) => String(n).padStart(2, "0");
    const target = `${now.getUTCFullYear()}/${p(now.getUTCMonth() + 1)}/${p(now.getUTCDate())}`;

    const data = await (await fetch(`${FIREBASE_URL}/bookings.json`)).json();
    const list = Object.entries(data || {})
      .map(([id, v]) => ({ id, ...v }))
      .filter(
        (b) =>
          b.date === target &&
          b.status !== "cancelled" &&
          b.line?.userId &&
          !b.remindedAt
      );

    let sent = 0;
    const failed = [];
    for (const b of list) {
      const bubble = card({
        tag: "明天見！上課提醒",
        tagColor: GOLD,
        title: "Otto2 ARTCLUB 旗艦館",
        rows: [
          row("日期", dateLabel(b.date), true),
          row("時段", b.actualTime || b.slot, true),
          row("課程", itemLines(b.items).join("\n") || "—"),
          row("人數", `${b.people} 位`),
          row("地址", STUDIO_ADDR),
        ],
        notes:
          "1. 上方時段為實際上課時間，請提前 10-15 分鐘至櫃檯報到\n" +
          "2. 工作室提供畫衣，建議不要穿寬袖衣物，避免沾染\n" +
          "3. 報名流動系列的學員，如留長髮請綁起來\n" +
          "4. 因工作室座位有限，每人低消一作品，請勿攜伴出席\n\n" +
          "零基礎輕鬆玩，不用擔心學不會，最重要的是擁有一顆「期待創作、樂於學習」的心，我們等您到來！",
        footer: "Otto2 ARTCLUB 藝術工作室",
      });

      const msgs = [
        { type: "flex", altText: `明天 ${b.slot} 有課程預約`, contents: bubble },
      ];
      if (MAP_URL) msgs.push({ type: "text", text: `📍 地圖傳送門：${MAP_URL}` });

      try {
        await push(b.line.userId, msgs);
        await fetch(`${FIREBASE_URL}/bookings/${b.id}.json`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ remindedAt: new Date().toISOString() }),
        });
        sent++;
      } catch (e) {
        failed.push({ id: b.id, error: e.message });
      }
    }
    res.json({ ok: true, target, total: list.length, sent, failed });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ══════════════════════════════════════════════════════
   LINE Pay 訂金流程
   ══════════════════════════════════════════════════════ */

/* Firebase 小工具 */
const fbGet = async (path) => (await fetch(`${FIREBASE_URL}/${path}.json`)).json();
const fbPatch = (path, data) =>
  fetch(`${FIREBASE_URL}/${path}.json`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });

/* LINE Pay 簽章：HMAC-SHA256(secret + uri + body + nonce)，用 secret 當金鑰 */
function lpSign(uri, payload, nonce) {
  return crypto
    .createHmac("sha256", LP_SECRET)
    .update(LP_SECRET + uri + payload + nonce)
    .digest("base64");
}

async function lpCall(method, uri, body) {
  if (!LP_ID || !LP_SECRET) throw new Error("缺少 LINEPAY_CHANNEL_ID / LINEPAY_CHANNEL_SECRET");
  const nonce = new Date().toISOString() + "-" + crypto.randomUUID();
  const payload = method === "GET" ? "" : JSON.stringify(body || {});
  const res = await fetch(LP_HOST + uri, {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-LINE-ChannelId": LP_ID,
      "X-LINE-Authorization-Nonce": nonce,
      "X-LINE-Authorization": lpSign(uri, payload, nonce),
    },
    ...(method === "GET" ? {} : { body: payload }),
  });
  const json = await res.json().catch(() => ({}));
  console.log(`LINE Pay ${method} ${uri} →`, json.returnCode, json.returnMessage || "");
  return json;
}

/* ══ 4. 建立付款：前端只傳 bookingId，金額一律從資料庫取 ══ */
app.post("/payment/create", async (req, res) => {
  try {
    const bookingId = (req.body || {}).bookingId;
    if (!bookingId) return res.status(400).json({ ok: false, error: "缺少 bookingId" });

    const b = await fbGet(`bookings/${bookingId}`);
    if (!b) return res.status(404).json({ ok: false, error: "找不到這筆預約" });
    if (b.status === "cancelled") return res.status(409).json({ ok: false, error: "這筆預約已取消" });
    if (b.deposit?.status === "paid")
      return res.json({ ok: true, already: true, message: "訂金已付款" });

    const amount = Number(b.deposit?.amount || 0);
    if (!amount) return res.status(400).json({ ok: false, error: "這筆預約沒有訂金金額" });

    /* orderId 自己編，不用 Firebase key（它開頭可能是減號） */
    const orderId = "OT" + Date.now().toString(36).toUpperCase() + crypto.randomBytes(3).toString("hex").toUpperCase();
    const courseName = b.items?.[0]?.name || "課程";

    const r = await lpCall("POST", "/v3/payments/request", {
      amount,
      currency: "TWD",
      orderId,
      packages: [
        {
          id: orderId,
          amount,
          name: "Otto2 ARTCLUB",
          products: [{ name: `${courseName} 訂金`, quantity: 1, price: amount }],
        },
      ],
      redirectUrls: {
        /* SERVER：由 LINE Pay 伺服器直接回打，客人關掉頁面也不影響 */
        confirmUrl: `${SELF_URL}/payment/confirm`,
        confirmUrlType: "SERVER",
        cancelUrl: `${SELF_URL}/payment/cancel?orderId=${orderId}`,
      },
    });

    if (r.returnCode !== "0000")
      return res.status(502).json({ ok: false, error: `LINE Pay ${r.returnCode}：${r.returnMessage}` });

    /* 對照表：confirm 回來時靠 orderId 找回是哪筆預約 */
    await fbPatch(`payments/${orderId}`, {
      bookingId,
      amount,
      status: "pending",
      transactionId: r.info.transactionId,
      createdAt: new Date().toISOString(),
    });
    await fbPatch(`bookings/${bookingId}`, {
      payment: { orderId, transactionId: r.info.transactionId, status: "pending" },
    });

    res.json({ ok: true, orderId, paymentUrl: r.info.paymentUrl, transactionId: r.info.transactionId });
  } catch (e) {
    console.error("建立付款失敗：", e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ══ 5. 付款確認：LINE Pay 伺服器回打這裡 ══ */
app.all("/payment/confirm", async (req, res) => {
  const transactionId = req.query.transactionId || req.body?.transactionId;
  const orderId = req.query.orderId || req.body?.orderId;
  try {
    if (!transactionId || !orderId)
      return res.status(400).json({ ok: false, error: "缺少 transactionId 或 orderId" });

    const pay = await fbGet(`payments/${orderId}`);
    if (!pay) return res.status(404).json({ ok: false, error: "查無此筆付款" });

    /* 防重複：LINE Pay 偶爾會重送 */
    if (pay.status === "paid") return res.json({ ok: true, already: true });

    const bookingId = pay.bookingId;
    const b = await fbGet(`bookings/${bookingId}`);
    if (!b) return res.status(404).json({ ok: false, error: "查無此筆預約" });

    /* 金額以資料庫為準 */
    const amount = Number(pay.amount || b.deposit?.amount || 0);
    const c = await lpCall("POST", `/v3/payments/${transactionId}/confirm`, {
      amount,
      currency: "TWD",
    });

    if (c.returnCode !== "0000") {
      await fbPatch(`payments/${orderId}`, { status: "failed", error: c.returnMessage });
      return res.status(502).json({ ok: false, error: `LINE Pay ${c.returnCode}：${c.returnMessage}` });
    }

    const paidAt = new Date().toISOString();
    await fbPatch(`payments/${orderId}`, { status: "paid", paidAt });
    await fbPatch(`bookings/${bookingId}`, {
      status: "confirmed",
      payment: { orderId, transactionId, status: "paid", paidAt },
      deposit: { ...(b.deposit || {}), status: "paid", paidAt },
    });

    /* 推播：訂金已收到 */
    const uid = b.line?.userId;
    if (uid) {
      const bubble = card({
        tag: "訂金已收到",
        tagColor: "#2E7D4F",
        title: "預約確認完成",
        rows: [
          row("日期", dateLabel(b.date), true),
          row("時段", b.actualTime || b.slot, true),
          row("課程", itemLines(b.items).join("\n") || "—"),
          row("人數", `${b.people} 位`),
          row("已付訂金", `NT$${amount.toLocaleString()}`),
          row("現場尾款", `NT$${Math.max(0, (b.total || 0) - amount).toLocaleString()}`),
        ],
        notes: "位子已為你保留，上課前一天會再收到提醒。",
        footer: "Otto2 ARTCLUB 藝術工作室",
      });
      await push(uid, [
        { type: "flex", altText: `訂金已收到：${b.date} ${b.slot}`, contents: bubble },
      ]).catch((e) => console.error("訂金推播失敗：", e.message));
    }

    console.log("付款完成 →", orderId, bookingId, amount);
    res.json({ ok: true, orderId, bookingId, amount });
  } catch (e) {
    console.error("確認付款失敗：", e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ══ 6. 客人在付款頁按取消 ══ */
app.get("/payment/cancel", async (req, res) => {
  const { orderId } = req.query;
  try {
    if (orderId) {
      const pay = await fbGet(`payments/${orderId}`);
      if (pay && pay.status === "pending") {
        await fbPatch(`payments/${orderId}`, { status: "cancelled" });
        await fbPatch(`bookings/${pay.bookingId}`, { payment: { orderId, status: "cancelled" } });
      }
    }
  } catch (e) {
    console.error(e);
  }
  res.redirect(LIFF_URL);
});

/* ══ 7. 前端輪詢用：這筆付了沒 ══ */
app.get("/payment/status", async (req, res) => {
  try {
    const { bookingId } = req.query;
    if (!bookingId) return res.status(400).json({ ok: false, error: "缺少 bookingId" });
    const b = await fbGet(`bookings/${bookingId}`);
    if (!b) return res.status(404).json({ ok: false, error: "找不到這筆預約" });
    res.json({
      ok: true,
      paid: b.deposit?.status === "paid",
      status: b.status || "unpaid",
      amount: b.deposit?.amount || 0,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ══ 8. 釋放逾時未付款的名額（Railway Cron 每 5 分鐘呼叫）══ */
app.get("/cron/release", async (req, res) => {
  try {
    if (req.query.key !== CRON_KEY) return res.status(403).json({ ok: false });
    const cutoff = Date.now() - HOLD_MIN * 60 * 1000;
    const data = await fbGet("bookings");
    const stale = Object.entries(data || {})
      .map(([id, v]) => ({ id, ...v }))
      .filter(
        (b) =>
          b.deposit?.method === "linepay" &&
          b.deposit?.status !== "paid" &&
          b.status !== "cancelled" &&
          b.status !== "expired" &&
          b.status !== "confirmed" &&
          new Date(b.ts || 0).getTime() < cutoff
      );

    for (const b of stale) {
      await fbPatch(`bookings/${b.id}`, {
        status: "expired",
        expiredAt: new Date().toISOString(),
      });
    }
    console.log(`釋放逾時未付款 ${stale.length} 筆`);
    res.json({ ok: true, released: stale.length, ids: stale.map((b) => b.id) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ══ 9. 連線測試：真的打一次 LINE Pay，確認金鑰與 IP 白名單 ══
   用法：/payment/ping?key=你的CRON_KEY
   會建立一筆 NT$1 的付款請求但不付款、不寫資料庫，放著自然過期。
   returnCode 0000 = 完全通了。其他代碼看 returnMessage。            */
app.get("/payment/ping", async (req, res) => {
  if (req.query.key !== CRON_KEY) return res.status(403).json({ ok: false });
  try {
    const r = await lpCall("POST", "/v3/payments/request", {
      amount: 1,
      currency: "TWD",
      orderId: "PING" + Date.now().toString(36).toUpperCase(),
      packages: [{ id: "ping", amount: 1, name: "連線測試", products: [{ name: "連線測試", quantity: 1, price: 1 }] }],
      redirectUrls: { confirmUrl: `${SELF_URL}/payment/confirm`, cancelUrl: `${SELF_URL}/payment/cancel` },
    });
    res.json({
      ok: r.returnCode === "0000",
      env: LP_ENV,
      returnCode: r.returnCode,
      returnMessage: r.returnMessage,
      hint:
        r.returnCode === "0000" ? "金鑰與 IP 白名單都正常，可以開始串接"
        : r.returnCode === "1104" ? "找不到商家：Channel ID 錯，或環境（sandbox/production）選錯"
        : r.returnCode === "1101" ? "商家未啟用或無此權限"
        : r.returnCode === "1106" ? "標頭資訊有誤，通常是簽章算錯"
        : "查 LINE Pay 錯誤代碼表，並確認伺服器 IP 已加入白名單",
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message, hint: "連不上 LINE Pay，先確認 IP 白名單" });
  }
});

/* ══════════════════════════════════════════════════════════
   員工後台登入
   老師在後台按「用 LINE 登入」→ LINE 給一組一次性的 code →
   前端把 code 送來這裡 → 這裡拿 Channel secret 去跟 LINE 換身分。
   Channel secret 只能放在這台伺服器，放前端等於公開。

   環境變數（設在 Railway → Variables）：
   LOGIN_CHANNEL_ID     : LINE 員工後台頻道的 Channel ID
   LOGIN_CHANNEL_SECRET : 同頻道的 Channel secret
   STAFF_DB_URL         : 員工名單所在的資料庫（otto2-2026）
   ══════════════════════════════════════════════════════════ */
const LOGIN_ID     = process.env.LOGIN_CHANNEL_ID || "2010980574";
const LOGIN_SECRET = process.env.LOGIN_CHANNEL_SECRET || "";
const STAFF_DB     = (process.env.STAFF_DB_URL ||
  "https://otto2-2026-default-rtdb.asia-southeast1.firebasedatabase.app").replace(/\/$/, "");

app.post("/auth/line", async (req, res) => {
  try {
    const { code, redirectUri } = req.body || {};
    if (!code) return res.status(400).json({ ok: false, error: "缺少 code" });
    if (!LOGIN_SECRET) return res.status(500).json({ ok: false, error: "伺服器還沒設定 LOGIN_CHANNEL_SECRET" });

    /* 一、拿 code 去跟 LINE 換 access token */
    const form = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri || "",
      client_id: LOGIN_ID,
      client_secret: LOGIN_SECRET,
    });
    const tr = await fetch("https://api.line.me/oauth2/v2.1/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form,
    });
    const tj = await tr.json();
    if (!tr.ok) {
      return res.status(400).json({ ok: false, error: "LINE 換 token 失敗",
        detail: tj.error_description || tj.error || "" });
    }

    /* 二、用 access token 讀出這個人的 LINE 身分 */
    const pr = await fetch("https://api.line.me/v2/profile", {
      headers: { Authorization: `Bearer ${tj.access_token}` },
    });
    const pj = await pr.json();
    if (!pr.ok || !pj.userId) {
      return res.status(400).json({ ok: false, error: "讀不到 LINE 個人資料" });
    }

    /* 三、比對員工名單。名單沒有這個人就是外人，直接擋掉 */
    let staff = null;
    try {
      const sr = await fetch(`${STAFF_DB}/staff/${pj.userId}.json`);
      if (sr.ok) staff = await sr.json();
    } catch (e) { /* 讀不到就當作沒有 */ }

    res.json({
      ok: true,
      userId: pj.userId,
      displayName: pj.displayName || "",
      picture: pj.pictureUrl || "",
      staff: staff || null,
      registered: !!(staff && staff.active !== false),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* 檢查登入設定有沒有弄好，用瀏覽器打開就能看 */
app.get("/auth/ping", (_, res) => {
  res.json({
    loginChannelId: LOGIN_ID,
    secretSet: !!LOGIN_SECRET,
    staffDb: STAFF_DB,
  });
});

app.get("/", (_, res) => res.send("Otto2 notify service is running."));

/* 自我檢測：確認 token 是否有效 */
app.get("/health", async (_, res) => {
  const out = {
    tokenSet: !!LINE_TOKEN,
    firebaseSet: !!FIREBASE_URL,
    linePay: { idSet: !!LP_ID, secretSet: !!LP_SECRET, env: LP_ENV, host: LP_HOST },
    selfUrl: SELF_URL,
    holdMinutes: HOLD_MIN,
  };
  if (LINE_TOKEN) {
    try {
      const r = await fetch("https://api.line.me/v2/bot/info", {
        headers: { Authorization: `Bearer ${LINE_TOKEN}` },
      });
      out.lineApi = r.status;
      out.lineOk = r.ok;
      if (r.ok) { const j = await r.json(); out.botName = j.displayName; }
      else out.lineError = (await r.text()).slice(0, 200);
    } catch (e) { out.lineError = e.message; }
  }
  res.json(out);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`otto2-notify on ${PORT}`));
