import express from "express";
import crypto from "crypto";

const app = express();
app.use(express.json({ limit: "10mb" }));

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
   LINE_TOKEN      : LINE Bot 的 Channel access token（Messaging API 分頁最下方）
   FIREBASE_URL    : Realtime Database 網址（otto2-booking-f9ef7）
   FIREBASE_SECRET : ★新增★ 上面那本資料庫的「資料庫密鑰」
   CRON_KEY        : 自訂密碼，保護每日提醒不被亂觸發
   STUDIO_ADDR     : 地址（可省略，有預設值）
   MAP_URL         : 地圖短網址（可省略）
*/
const LINE_TOKEN   = process.env.LINE_TOKEN;
const FIREBASE_URL = (process.env.FIREBASE_URL || "").replace(/\/$/, "");
const FIREBASE_SECRET = process.env.FIREBASE_SECRET || "";
const CRON_KEY     = process.env.CRON_KEY || "otto2";
const STUDIO_ADDR  = process.env.STUDIO_ADDR || "台中市南屯區干城街328號4樓「Art2plaza親子美學館」內，入內有電梯";
const MAP_URL      = process.env.MAP_URL || "";
/* 預約頁的 AI 小幫手要用的金鑰，跟 line-ai-helper 用同一組 Anthropic 金鑰即可，
   複製過來當新的環境變數，不用另外申請。 */
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";

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

/* ── 課程／班表試算表：跟後台、客人端讀同一份 ──
   這裡只用「班表」分頁算時段容量，給 /liff/availability 用
   （客服機器人問時段滿了沒，就是打這支）。 */
const COURSE_SHEET_ID = "1QjiDwmPcwbmdhmNv9cz1A6veC_BbC75m1VJG85P3Q6M";
const BK_SLOTS   = ["10:00-12:00", "14:00-16:00", "16:00-18:00"];
const BK_EVE_SLOT = "18:30-21:00";
const CAP_PER_TEACHER = 5;   /* 每位老師可帶人數 */
const SEAT_CAP        = 13;  /* 單一時段人數天花板 */
/* 沒特別指定的日子，看星期幾抓預設老師數（跟後台、客人端一致） */
const BK_BASE_WEEK = { 0: 0, 1: 2, 2: 2, 3: 2, 4: 2, 5: 2, 6: 3 };
/* 手動登記可以打自訂時段（例如 15:00-17:00），算容量時要歸進最接近的
   那一場，跟後台 booking.js 的 SLOT_BASE 一字不差，不然這種自訂時段
   會被漏算，明明滿了卻算成沒人。對不到表的就不算進任何一場（跟後台的
   「其他」分類一樣，不佔任何時段的名額）。 */
const SLOT_BASE = {
  "09:30-11:30": "10:00-12:00", "09:30-12:00": "10:00-12:00",
  "10:00-12:00": "10:00-12:00", "10:30-12:30": "10:00-12:00",
  "13:30-15:30": "14:00-16:00", "14:00-16:00": "14:00-16:00", "14:30-16:30": "14:00-16:00",
  "15:00-17:00": "14:00-16:00", "15:30-17:30": "16:00-18:00",
  "16:00-18:00": "16:00-18:00", "16:30-18:30": "16:00-18:00",
  "18:30-21:00": "18:30-21:00", "19:00-21:00": "18:30-21:00",
};
const bkBase = (sl) => SLOT_BASE[String(sl || "").trim()] || "";

async function gvizSheet(sheetName) {
  const url = `https://docs.google.com/spreadsheets/d/${COURSE_SHEET_ID}/gviz/tq?sheet=${encodeURIComponent(sheetName)}&tqx=out:json`;
  const t = await (await fetch(url)).text();
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  const j = JSON.parse(t.substring(a, b + 1));
  if (!j.table) throw new Error(`找不到工作表「${sheetName}」`);
  return j.table.rows.map((r) => r.c.map((c) => (c ? (c.f ?? c.v) : "")));
}

/* 班表：試算表「班表」當底，Firebase /schedule 蓋過去——
   跟 salary-system/booking.js 的 bkLoadSched 是同一套邏輯，算出來的容量才會跟後台看到的一致。
   快取 5 分鐘，客服機器人問一次不用每次都重讀試算表。 */
let scheduleCache = { data: null, ts: 0 };
const SCHEDULE_TTL = 5 * 60 * 1000;
async function loadSchedule() {
  if (scheduleCache.data && Date.now() - scheduleCache.ts < SCHEDULE_TTL) return scheduleCache.data;
  const m = {};
  try {
    const rows = await gvizSheet("班表");
    if (rows.length && /日期|週/.test(String(rows[0][0]))) rows.shift();
    rows.forEach((r) => {
      const d = String(r[0] || "").trim().replace(/-/g, "/");
      const v = String(r[2] == null ? "" : r[2]).trim();
      if (d && v !== "") m[d] = Math.max(0, Number(v) || 0);
    });
  } catch (e) { console.error("讀班表分頁失敗：", e.message); }
  try {
    const j = await fbGet("schedule");
    if (j) for (const k in j) {
      const v2 = j[k];
      if (v2 === null || v2 === undefined || v2 === "") continue;
      m[String(k).replace(/-/g, "/")] =
        typeof v2 === "object"
          ? { t: Math.max(0, Number(v2.t) || 0), ev: Math.max(0, Number(v2.ev) || 0) }
          : Math.max(0, Number(v2) || 0);
    }
  } catch (e) { console.error("讀 Firebase 班表失敗：", e.message); }
  scheduleCache = { data: m, ts: Date.now() };
  return m;
}
function schedVal(sched, d) {
  const v = sched[d];
  if (v == null) return null;
  if (typeof v === "object") return { t: Math.max(0, Number(v.t) || 0), ev: Math.max(0, Number(v.ev) || 0) };
  return { t: Math.max(0, Number(v) || 0), ev: 0 };
}
function baseTeachersOn(d) {
  const [y, m, dd] = d.split("/").map(Number);
  const w = new Date(y, m - 1, dd).getDay();
  return BK_BASE_WEEK[w] == null ? 1 : BK_BASE_WEEK[w];
}
function teachersOn(sched, d) {
  const v = schedVal(sched, d);
  return v ? v.t : baseTeachersOn(d);
}
function eveOn(sched, d) {
  const v = schedVal(sched, d);
  return v ? v.ev : 0;
}
function capOf(sched, d) { return Math.min(teachersOn(sched, d) * CAP_PER_TEACHER, SEAT_CAP); }
function eveCapOf(sched, d) { return Math.min(eveOn(sched, d) * CAP_PER_TEACHER, SEAT_CAP); }

/* 課程表快取，給 AI 小幫手組課程清單用。
   欄位順序跟客人端 rowsToGroups 一模一樣（不可插欄）：
   分類0／名稱1／說明2／規格3／時長4／價格5／圖片6／上架7／排序8／最小年齡9。
   快取 5 分鐘，客人聊天來回好幾句不用每句都重讀試算表。 */
let courseCatalogCache = { data: null, ts: 0 };
const COURSE_CATALOG_TTL = 5 * 60 * 1000;
async function loadCourseCatalog() {
  if (courseCatalogCache.data && Date.now() - courseCatalogCache.ts < COURSE_CATALOG_TTL) return courseCatalogCache.data;
  const rows = await gvizSheet("課程");
  const items = rows
    .map((r) => ({
      cat: String(r[0] || "").trim(),
      name: String(r[1] || "").trim(),
      desc: String(r[2] || "").trim(),
      spec: String(r[3] || "").trim(),
      price: String(r[5] ?? "").trim(),
      on: String(r[7] || "Y").trim().toUpperCase() !== "N",
      minAge: Number(r[9]) || 0,
    }))
    .filter((it) => it.name && it.on);
  courseCatalogCache = { data: items, ts: Date.now() };
  return items;
}
/* 組成給 AI 看的課程清單文字。同一門課多個規格併成一行，
   AI 只能從這份清單裡挑課程名稱和規格的原始文字，不可以自己編或翻譯，
   不然客人端拿這串文字去對 groups 會對不到，整個流程就斷了。 */
function courseCatalogText(items) {
  const byKey = new Map();
  for (const it of items) {
    const k = it.cat + "|" + it.name;
    if (!byKey.has(k)) byKey.set(k, { cat: it.cat, name: it.name, desc: it.desc, minAge: it.minAge, specs: [] });
    byKey.get(k).specs.push(`${it.spec || "單一規格"} $${it.price}`);
  }
  return [...byKey.values()]
    .map((g) => `【${g.cat}】${g.name}${g.minAge ? `（${g.minAge}歲以上）` : ""}：${g.desc}\n  規格與價格：${g.specs.join("、")}`)
    .join("\n");
}

const NAVY = "#1E2B4F", GOLD = "#E3B34C", INK = "#2A2E38", SOFT = "#6B7180";

/* ══════════════════════════════════════════════════════════
   Firebase 連線（★這一段是這次新增的重點★）

   以前這台伺服器連 Firebase 跟瀏覽器一樣，直接打網址、不帶任何密碼，
   所以資料庫規則一旦鎖起來，這台伺服器也會跟著讀不到。

   現在改成每一次呼叫都在網址後面掛上 ?auth=資料庫密鑰。
   帶了密鑰就是管理員身分，規則鎖到什麼程度都讀寫得到。
   密鑰只存在 Railway 的環境變數裡，不會出現在任何前端檔案。
   ══════════════════════════════════════════════════════════ */

/* 組出帶密鑰的網址。extra 可以再加 shallow 之類的查詢參數 */
function dbUrl(base, secret, path, extra = {}) {
  const u = new URL(`${base}/${path}.json`);
  if (secret) u.searchParams.set("auth", secret);
  for (const k of Object.keys(extra)) u.searchParams.set(k, extra[k]);
  return u.toString();
}

const fbUrl    = (path, extra) => dbUrl(FIREBASE_URL, FIREBASE_SECRET, path, extra);

/* 預約／會員資料庫的小工具 */
const fbGet = async (path, extra) => (await fetch(fbUrl(path, extra))).json();
const fbPatch = (path, data) =>
  fetch(fbUrl(path), {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
/* 整個節點覆蓋（給單一值用，例如 lineIndex/{uid} 存的是一支電話字串，不是物件） */
const fbPut = (path, value) =>
  fetch(fbUrl(path), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(value),
  });

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

/* ══ 1.5 方案開通 ══
   行政在後台幫客人入完方案之後推一張卡片，把「買了什麼、拿到什麼、
   什麼時候到期、現在還剩多少」一次講完。

   以前是行政自己打字轉述，打錯很難發現——客人拿到的數字跟系統裡的
   對不起來，等到要用的時候才吵起來。這張卡片的數字直接由賣方案的
   流程帶過來，跟寫進明細的是同一批，不會有兩套說法。

   欄位都是選填，方案沒有的就不顯示。純點數方案不會冒出「堂數 +0」。 */
app.post("/notify/plan", async (req, res) => {
  try {
    const b = req.body || {};
    const uid = b.line?.userId;
    if (!uid) return res.json({ ok: false, skip: "無 LINE 身分，略過推播" });

    const plan = b.plan || {};
    const add  = b.add || {};
    const bal  = b.balance || {};
    const n = (v) => Number(v || 0);
    const money = (v) => "NT$" + n(v).toLocaleString();
    const pts = (v) => n(v).toLocaleString() + " 點";

    const rows = [];
    rows.push(row("方案", plan.name || "—", true));
    if (n(plan.price)) rows.push(row("金額", money(plan.price) + (plan.pay ? `　${plan.pay}` : "")));

    /* 點數拆開寫。客人看到「+16,600」會想這數字哪來的，
       拆成基本、創作回饋、入會回饋三行就不用問。 */
    if (n(add.points))      rows.push(row("基本點數", "＋" + pts(add.points)));
    if (n(add.bonusPoints)) rows.push(row("創作回饋", "＋" + pts(add.bonusPoints)));
    if (n(add.giftPoints))  rows.push(row(b.renew ? "續約回饋" : "入會回饋", "＋" + pts(add.giftPoints)));
    if (n(add.sessions))    rows.push(row("課程堂數", "＋" + n(add.sessions) + " 堂"));
    if (n(add.voucher))     rows.push(row("表框折價金", "＋" + money(add.voucher)));
    if (plan.expiry)        rows.push(row("使用期限", plan.expiry + (plan.months ? `（${plan.months} 個月）` : ""), true));

    /* 分隔線之後是「現在手上有多少」。加了多少跟剩多少是兩件事，
       客人真正在意的是後者。 */
    const balBits = [];
    if (bal.points   != null) balBits.push("點數 " + n(bal.points).toLocaleString());
    if (n(bal.sessions))      balBits.push("堂數 " + n(bal.sessions));
    if (n(bal.voucher))       balBits.push("折價金 " + money(bal.voucher));
    if (n(bal.bonus))         balBits.push("紅利 " + n(bal.bonus));
    if (balBits.length) {
      rows.push({ type: "separator", margin: "sm" });
      rows.push(row("目前餘額", balBits.join("\n"), true));
    }

    const notes = [
      plan.gift ? `入會好禮：${plan.gift}（請到工作室領取）` : "",
      plan.expiry ? "期限內未使用完畢的點數與堂數將不予保留，請提早安排課程。" : "",
      "點數與堂數可於線上預約時折抵，餘額隨時可在預約頁查詢。",
    ].filter(Boolean).join("\n");

    const bubble = card({
      tag: b.renew ? "續約完成通知" : "方案開通通知",
      tagColor: "#C99A3B",
      title: b.name ? `${b.name}，方案已開通` : "方案已開通",
      rows,
      notes,
      footer: "Otto2 ARTCLUB 藝術工作室",
    });

    await push(uid, [
      { type: "flex", altText: `方案開通：${plan.name || ""}`, contents: bubble },
    ]);
    console.log("方案推播成功 →", uid.slice(0, 8) + "...", plan.name);
    res.json({ ok: true });
  } catch (e) {
    console.error("方案推播失敗：", e.message);
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

    const data = await fbGet("bookings");
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
        await fbPatch(`bookings/${b.id}`, { remindedAt: new Date().toISOString() });
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
   STAFF_SECRET         : ★新增★ 上面那本資料庫的「資料庫密鑰」
   SESSION_SECRET       : ★新增★ 自己想一組長一點的亂碼，用來簽發登入憑證
   ══════════════════════════════════════════════════════════ */
const LOGIN_ID     = process.env.LOGIN_CHANNEL_ID || "2010980574";
const LOGIN_SECRET = process.env.LOGIN_CHANNEL_SECRET || "";
const STAFF_DB     = (process.env.STAFF_DB_URL ||
  "https://otto2-2026-default-rtdb.asia-southeast1.firebasedatabase.app").replace(/\/$/, "");
const STAFF_SECRET = process.env.STAFF_SECRET || "";
const SESSION_SECRET = process.env.SESSION_SECRET || LOGIN_SECRET || "otto2-change-me";

const staffUrl = (path, extra) => dbUrl(STAFF_DB, STAFF_SECRET, path, extra);
const staffGet = async (path, extra) => (await fetch(staffUrl(path, extra))).json();

/* ── 登入憑證 ──
   以前前端只存 LINE userId，而 userId 不是秘密（畫面上就看得到），
   所以拿它跟伺服器要資料等於沒有驗證。

   改成由這台伺服器簽發一張憑證：內容是「誰＋到期時間」，
   後面接一段用 SESSION_SECRET 算出來的簽章。
   簽章算不出來就偽造不了，改一個字也會對不起來。          */
const TOKEN_DAYS = 30;

function signToken(userId, days = TOKEN_DAYS) {
  const exp = Date.now() + days * 86400000;
  const body = Buffer.from(`${userId}|${exp}`).toString("base64url");
  const sig = crypto.createHmac("sha256", SESSION_SECRET).update(body).digest("base64url");
  return `${body}.${sig}`;
}

/* 比對字串時用固定時間比較，避免從回應快慢反推內容 */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/* 憑證有效就回傳 userId，無效或過期回傳 null */
function verifyToken(token) {
  if (!token || typeof token !== "string") return null;
  const i = token.lastIndexOf(".");
  if (i < 1) return null;
  const body = token.slice(0, i);
  const sig = token.slice(i + 1);
  const expect = crypto.createHmac("sha256", SESSION_SECRET).update(body).digest("base64url");
  if (!safeEqual(sig, expect)) return null;
  const parts = Buffer.from(body, "base64url").toString().split("|");
  const userId = parts[0];
  const exp = Number(parts[1] || 0);
  if (!userId || !exp || exp < Date.now()) return null;
  return userId;
}

/* 每一支員工專用的 API 都先過這一關：
   憑證有效、名單裡有這個人、而且沒被停用，三個都成立才放行。
   管理員把某人停用，對方下一次呼叫就會被擋，不用等憑證過期。 */
async function requireStaff(req, res) {
  const token = (req.body && req.body.token) || req.query.token || "";
  const uid = verifyToken(token);
  if (!uid) {
    res.status(401).json({ ok: false, error: "登入已過期，請重新登入" });
    return null;
  }
  let staff = null;
  try {
    staff = await staffGet(`staff/${encodeURIComponent(uid)}`);
  } catch (e) {
    res.status(500).json({ ok: false, error: "讀不到員工名單" });
    return null;
  }
  if (!staff || staff.active === false) {
    res.status(403).json({ ok: false, error: "這個帳號沒有權限" });
    return null;
  }
  return { uid, staff };
}

app.post("/auth/line", async (req, res) => {
  try {
    const { code, redirectUri, invite } = req.body || {};
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
      staff = await staffGet(`staff/${encodeURIComponent(pj.userId)}`);
    } catch (e) { /* 讀不到就當作沒有 */ }

    /* 四、還不在名單裡，但帶了邀請碼 → 兌換一次，建立帳號 */
    if (!staff && invite) {
      try {
        const iv = await staffGet(`staffInvites/${encodeURIComponent(invite)}`);
        if (iv && !iv.used) {
          staff = {
            name: iv.name || pj.displayName || "",
            role: iv.role || "teacher",
            tabs: Array.isArray(iv.tabs) ? iv.tabs : [],
            active: true,
            addedAt: new Date().toISOString(),
            addedBy: iv.createdBy || "invite",
          };
          await fetch(staffUrl(`staff/${encodeURIComponent(pj.userId)}`), {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(staff),
          });
          /* 邀請連結只能用一次，兌換完立刻標記 */
          await fetch(staffUrl(`staffInvites/${encodeURIComponent(invite)}`), {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ used: true, usedAt: new Date().toISOString(), usedBy: pj.userId }),
          });
        }
      } catch (e) { /* 兌換失敗就當作沒有帳號 */ }
    }

    const registered = !!(staff && staff.active !== false);

    res.json({
      ok: true,
      userId: pj.userId,
      displayName: pj.displayName || "",
      picture: pj.pictureUrl || "",
      staff: staff || null,
      registered,
      /* 只有真的在名單裡才發憑證，外人拿不到 */
      token: registered ? signToken(pj.userId) : "",
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ══ 主畫面 APP 專用登入（?k=userId.金鑰）══
   以前這段是在瀏覽器裡自己讀 staff/{uid}/appKey 來比對，
   代表那本資料庫必須開放讀取，任何人都撈得到所有人的金鑰。
   現在改成把 uid 和金鑰送來這裡，由伺服器比對，前端讀不到 appKey。 */
app.post("/auth/key", async (req, res) => {
  try {
    const { uid, key } = req.body || {};
    if (!uid || !key) return res.status(400).json({ ok: false, error: "連結格式不對" });

    let staff = null;
    try {
      staff = await staffGet(`staff/${encodeURIComponent(uid)}`);
    } catch (e) { /* 讀不到就當作沒有 */ }

    if (!staff || !staff.appKey || !safeEqual(staff.appKey, key) || staff.active === false) {
      return res.status(403).json({ ok: false, error: "這條連結已經失效" });
    }

    res.json({
      ok: true,
      userId: uid,
      displayName: staff.name || "",
      picture: "",
      staff,
      registered: true,
      token: signToken(uid),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ══ 名單是不是空的（系統剛裝好時要讓第一個人設成管理員）══
   只回傳一個是非題，不會吐出任何名單內容，所以可以公開。 */
app.get("/auth/bootstrap", async (_req, res) => {
  try {
    const j = await staffGet("staff", { shallow: "true" });
    res.json({ ok: true, empty: !j || !Object.keys(j).length });
  } catch (e) {
    res.json({ ok: false, empty: false, error: e.message });
  }
});

/* ══ 重新讀自己的權限（管理員改完設定，對方重整就生效）══ */
app.post("/staff/me", async (req, res) => {
  try {
    const uid = verifyToken((req.body || {}).token);
    if (!uid) return res.status(401).json({ ok: false, error: "登入已過期，請重新登入" });
    let staff = null;
    try {
      staff = await staffGet(`staff/${encodeURIComponent(uid)}`);
    } catch (e) { /* 讀不到就當作沒有 */ }
    res.json({
      ok: true,
      userId: uid,
      staff: staff || null,
      registered: !!(staff && staff.active !== false),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ══ 會員清單（員工限定）══
   以前後台是從瀏覽器直接撈整包 /members，所以那本資料庫必須開放讀取，
   等於一千四百多位客人的姓名電話任何人都拿得到。
   改成從這裡拿，先驗憑證再回資料，規則就能鎖起來。

   body: { token, shallow }
   shallow: true 只回電話清單（判斷是不是舊客人用的，資料量小很多） */
app.post("/staff/members", async (req, res) => {
  const s = await requireStaff(req, res);
  if (!s) return;
  try {
    const shallow = !!(req.body || {}).shallow;
    const data = await fbGet("members", shallow ? { shallow: "true" } : undefined);
    res.json({ ok: true, shallow, members: data || {} });
  } catch (e) {
    console.error("讀會員清單失敗：", e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ══ 只有管理員能過的關卡 ══
   先過 requireStaff（憑證有效、名單裡有、沒被停用），再檢查身分。 */
async function requireOwner(req, res) {
  const s = await requireStaff(req, res);
  if (!s) return null;
  if (s.staff.role !== "owner") {
    res.status(403).json({ ok: false, error: "只有管理員能管理帳號" });
    return null;
  }
  return s;
}

/* ══ 員工名單（管理員限定）══
   staff.js 以前直接從瀏覽器讀 /staff 和 /staffInvites，
   代表 otto2-2026 必須開放讀取。而名單裡存著 appKey——
   那是「主畫面 APP 專屬連結」的登入密碼，撈走名單就能冒充任何一位員工。

   ★這裡回傳前一定要把 appKey 拔掉★
   名單搬到伺服器、金鑰卻整包送回瀏覽器的話，等於白做一場。
   前端只拿得到 hasKey 這個是非題；要實際的連結請走 /staff/applink。

   body: { token } */
app.post("/staff/list", async (req, res) => {
  const s = await requireOwner(req, res);
  if (!s) return;
  try {
    const [a, b] = await Promise.all([staffGet("staff"), staffGet("staffInvites")]);
    const staff = Object.keys(a || {}).map((uid) => {
      const src = a[uid] && typeof a[uid] === "object" ? a[uid] : {};
      const v = Object.assign({}, src, { uid, hasKey: !!src.appKey });
      delete v.appKey;
      return v;
    });
    const invites = Object.keys(b || {})
      .map((t) => {
        const src = b[t] && typeof b[t] === "object" ? b[t] : {};
        return Object.assign({}, src, { token: t });
      })
      .filter((i) => !i.used);
    res.json({ ok: true, staff, invites });
  } catch (e) {
    console.error("讀員工名單失敗：", e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ══ 產生／取回某個人的專屬連結（管理員限定）══
   金鑰在這裡產生、在這裡存、只回這一個人的，
   前端從頭到尾拿不到別人的。
   regen=true 會換一把新的，舊連結立刻失效。

   body: { token, uid, regen } */
app.post("/staff/applink", async (req, res) => {
  const s = await requireOwner(req, res);
  if (!s) return;
  try {
    const { uid, regen } = req.body || {};
    if (!uid) return res.status(400).json({ ok: false, error: "缺少 uid" });
    const target = await staffGet(`staff/${encodeURIComponent(uid)}`);
    if (!target) return res.status(404).json({ ok: false, error: "名單裡沒有這個人" });

    let key = regen ? "" : (target.appKey || "");
    if (!key) {
      key = crypto.randomBytes(12).toString("hex");
      const w = await fetch(staffUrl(`staff/${encodeURIComponent(uid)}/appKey`), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(key),
      });
      if (!w.ok) return res.status(500).json({ ok: false, error: `金鑰寫入失敗 HTTP ${w.status}` });
    }
    res.json({ ok: true, key });
  } catch (e) {
    console.error("產生專屬連結失敗：", e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* 檢查登入設定有沒有弄好，用瀏覽器打開就能看 */
/* ══════════════════════════════════════════════════════════
   客人端（LIFF 預約頁）的讀取

   以前預約頁是直接從瀏覽器讀 Firebase 的，其中兩處讀的是
   整包 /bookings.json——一份包含每一位客人姓名、電話、備註的
   完整名單，任何人知道資料庫網址就能整包下載。頁面原始碼在
   公開倉庫裡，網址就寫在裡面。

   而且它要的只是「這個人來過幾次」跟「這個時段還剩幾位」，
   為了兩個數字把整本資料庫搬給瀏覽器。資料越長越大，
   一年後每個客人開頁面都要下載全部，慢只是副作用，
   個資外洩才是真正的問題。

   這三支端點的設計原則跟後台那幾支不一樣：客人端沒有登入，
   所以只回傳「問的人自己該知道的」，多一個字都不給。
   ── /liff/slots 只吐人數，不吐是誰約的
   ── /liff/member 只吐餘額，不吐明細
   ── /liff/me 要求先知道 userId 才問得到，那串外人拿不到

   這三支上線、前端改完之後，bookings 和 members 的 .read
   就可以關掉了。
   ══════════════════════════════════════════════════════════ */

/* 這個 LINE 帳號在我們這裡的狀態：來過幾次、有沒有方案、留過什麼聯絡方式。
   來訪次數決定體驗價資格，所以要準。
   body: { userId } */
app.post("/liff/me", async (req, res) => {
  try {
    const uid = String((req.body || {}).userId || "").trim();
    if (!uid) return res.status(400).json({ ok: false, error: "缺少 userId" });

    const all = await fbGet("bookings");
    let visits = 0;
    for (const k in (all || {})) {
      const b = all[k];
      if (b && b.line && b.line.userId === uid && b.status !== "cancelled") visits++;
    }

    const prof = await fbGet(`liffProfiles/${uid}`);
    let hasPlan = !!(prof && (prof.plan || Number(prof.credits) > 0));

    /* 有留電話就順便看會員檔案，堂數點數還有餘額的一樣算有方案 */
    let name = (prof && prof.name) || "";
    let phone = (prof && prof.phone) || "";
    /* liffProfiles 沒有電話時退回 lineIndex——前端原本是靠這張對照表
       認人的，少了它，換過裝置的老客人會被當成陌生人。 */
    if (!phone) {
      const idx = await fbGet(`lineIndex/${uid}`);
      if (typeof idx === "string" && /^0\d{8,10}$/.test(idx)) phone = idx;
    }
    if (phone) {
      const m = await fbGet(`members/${phone}`);
      if (m) {
        const c = m.cache || {};
        if (Number(c.points) > 0 || Number(c.sessions) > 0) hasPlan = true;
        if (!name) name = m.name || "";
      }
    }

    res.json({ ok: true, visits, hasPlan, name, phone });
  } catch (e) {
    console.error("/liff/me 失敗：", e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* 某段日期內每個時段已經約了幾位。
   只回傳數字，不回傳任何一位客人的姓名電話。
   body: { from: "2026/08/10", to: "2026/09/30" } 都可省略，省略就給全部 */
app.post("/liff/slots", async (req, res) => {
  try {
    const { from = "", to = "" } = req.body || {};
    const all = await fbGet("bookings");
    const out = {};
    for (const k in (all || {})) {
      const b = all[k];
      if (!b) continue;
      /* 取消和逾期未付訂金的都不佔位，跟前端原本的判斷一致 */
      if (b.status === "cancelled" || b.status === "expired") continue;
      const d = String(b.date || "");
      if (!d) continue;
      if (from && d < from) continue;
      if (to && d > to) continue;
      /* 佔的位子不一定等於人數。地毯這類課要用到機台和桌面，
         一組客人不管幾個人都佔 3 個位子；一般課才是一人一位。
         舊資料沒有 seats 欄位，就退回用人數算，行為跟以前一樣。 */
      const seats = Number(b.seats) || Number(b.people) || 0;
      /* 一筆預約可能橫跨好幾個時段——連堂是兩格，畫一整天是三格。
         新資料存在 slots 陣列裡，舊資料只有 slot／slot2，兩種都要吃。
         漏算的話那些時段會被超收。 */
      const slotList = (Array.isArray(b.slots) && b.slots.length)
        ? b.slots.filter(Boolean)
        : [b.slot, b.slot2].filter(Boolean);
      for (const sl of slotList) {
        if (!sl) continue;
        if (!out[d]) out[d] = {};
        out[d][sl] = (out[d][sl] || 0) + seats;
      }
    }
    res.json({ ok: true, used: out });
  } catch (e) {
    console.error("/liff/slots 失敗：", e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* 某一天每個時段還剩幾位、滿了沒——把「已訂幾位」跟「這天排幾位老師
   換算出的上限」一次算給你，容量公式跟後台、客人端同一套，不會對不起來。
   給客服機器人回答「時段還有位子嗎」用，不用再繞去每小時同步一次的
   Google 行事曆（那份常常漏資料，比不上這裡即時）。
   body: { date }，格式跟其他端點一致，YYYY/MM/DD */
app.post("/liff/availability", async (req, res) => {
  try {
    const date = String((req.body || {}).date || "").trim();
    if (!/^\d{4}\/\d{2}\/\d{2}$/.test(date)) {
      return res.status(400).json({ ok: false, error: "date 格式要 YYYY/MM/DD" });
    }

    const [all, sched] = await Promise.all([fbGet("bookings"), loadSchedule()]);
    const used = {};
    for (const k in (all || {})) {
      const b = all[k];
      if (!b || b.status === "cancelled" || b.status === "expired") continue;
      if (String(b.date || "") !== date) continue;
      const seats = Number(b.seats) || Number(b.people) || 0;
      const slotList = (Array.isArray(b.slots) && b.slots.length)
        ? b.slots.filter(Boolean)
        : [b.slot, b.slot2].filter(Boolean);
      for (const sl of slotList) {
        if (!sl) continue;
        /* 自訂時段（例如 15:00-17:00）要歸進最接近的那一場才算得準；
           對不到表的就不算，跟後台「其他」分類一樣不佔任何時段名額 */
        const base = bkBase(sl) || (BK_SLOTS.includes(sl) || sl === BK_EVE_SLOT ? sl : "");
        if (!base) continue;
        used[base] = (used[base] || 0) + seats;
      }
    }

    const eveTeachers = eveOn(sched, date);
    const slotsToday = eveTeachers > 0 ? [...BK_SLOTS, BK_EVE_SLOT] : [...BK_SLOTS];
    const slots = slotsToday.map((sl) => {
      const cap = sl === BK_EVE_SLOT ? eveCapOf(sched, date) : capOf(sched, date);
      const usedN = used[sl] || 0;
      return { slot: sl, used: usedN, cap, left: Math.max(0, cap - usedN), full: usedN >= cap };
    });

    res.json({ ok: true, date, teachers: teachersOn(sched, date), eveTeachers, slots });
  } catch (e) {
    console.error("/liff/availability 失敗：", e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* 用電話查自己的餘額。只吐餘額與姓名，明細一律不給——
   明細裡有經手人、調整原因這些客人不需要也不該看到的東西。
   body: { phone } */
app.post("/liff/member", async (req, res) => {
  try {
    const raw = String((req.body || {}).phone || "").replace(/[^0-9]/g, "");
    if (!raw) return res.status(400).json({ ok: false, error: "缺少電話" });
    /* +886912345678 這種也要對得起來 */
    const phone = raw.replace(/^886/, "0");
    const userId = String((req.body || {}).userId || "").trim();

    /* 客人這支手機、這個 LINE 帳號一對上，就順手記起來，下次同一支手機
       開頁面才會自動帶出電話。以前是瀏覽器自己直接寫 liffProfiles／lineIndex，
       但這兩個節點的寫入規則後來鎖起來了，瀏覽器沒有密鑰，每次都被拒絕、
       又被 .catch 悄悄吞掉，電話永遠記不住也沒人發現。改成伺服器用密鑰寫，
       不受這個限制——不管這支電話有沒有查到既有會員都要記，第一次來、
       還沒建檔的客人也一樣，下次才認得出來。 */
    if (userId && /^0\d{8,10}$/.test(phone)) {
      fbPut(`liffProfiles/${userId}/phone`, phone).catch(() => {});
      fbPut(`lineIndex/${userId}`, phone).catch(() => {});
    }

    const m = await fbGet(`members/${phone}`);
    if (!m) return res.json({ ok: true, found: false });
    const c = m.cache || {};
    if (userId && !m.lineUserId) {
      fbPatch(`members/${phone}`, { lineUserId: userId }).catch(() => {});
    }
    res.json({
      ok: true, found: true, phone,
      name: m.name || "",
      points: Number(c.points) || 0,
      sessions: Number(c.sessions) || 0,
      bonus: Number(c.bonus) || 0,
      voucher: Number(c.voucher) || 0,
      lineUserId: m.lineUserId || "",
    });
  } catch (e) {
    console.error("/liff/member 失敗：", e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* 客人自己的最近使用紀錄。
   明細裡有經手人、單價、匯入批次這些內部欄位，客人不需要也不該看到，
   這裡只挑時間、類型、增減、說明四樣，其餘一律不吐。
   body: { phone, limit } */
app.post("/liff/ledger", async (req, res) => {
  try {
    const raw = String((req.body || {}).phone || "").replace(/[^0-9]/g, "");
    if (!raw) return res.status(400).json({ ok: false, error: "缺少電話" });
    const phone = raw.replace(/^886/, "0");
    const limit = Math.min(Number((req.body || {}).limit) || 20, 50);

    const l = await fbGet(`members/${phone}/ledger`);
    const list = Object.values(l || {})
      .filter((e) => e && e.at)
      .sort((a, b) => String(b.at).localeCompare(String(a.at)))
      .slice(0, limit)
      .map((e) => ({
        at: e.at,
        type: e.type || "",
        delta: Number(e.delta) || 0,
        reason: e.reason || "",
      }));
    res.json({ ok: true, entries: list });
  } catch (e) {
    console.error("/liff/ledger 失敗：", e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ══ 預約頁的 AI 小幫手 ══════════════════════════════════
   跟 line-ai-helper（LINE 官方帳號的客服機器人）是完全獨立的兩套——
   那支機器人不一定隨時開著，這支直接嵌在預約網頁上，客人點進頁面就在。

   對話收集「幾位、上什麼課、想約哪一天」，收齊、客人也同意送出後，
   AI 在回覆最後夾帶一段 <<<BOOKING>>>...<<<END>>> 的 JSON，
   客人端收到後拿去對真正的課程資料、填好精靈的每一步、
   最後還是走原本「送出預約」那個按鈕，AI 不會替客人按下去。

   body: { message, history:[{role,text}] } */
app.post("/liff/assistant", async (req, res) => {
  try {
    if (!ANTHROPIC_API_KEY) return res.status(500).json({ ok: false, error: "AI 還沒設定金鑰，跟老闆說一聲加 ANTHROPIC_API_KEY" });
    const message = String((req.body || {}).message || "").trim();
    if (!message) return res.status(400).json({ ok: false, error: "缺少訊息" });
    const history = Array.isArray((req.body || {}).history) ? (req.body || {}).history.slice(-12) : [];

    const catalog = await loadCourseCatalog();
    const today = new Date();
    const todayStr = `${today.getFullYear()}/${String(today.getMonth() + 1).padStart(2, "0")}/${String(today.getDate()).padStart(2, "0")}`;

    const systemPrompt =
      `你是 Otto2 ARTCLUB 畫室的預約小幫手，用聊天的方式幫客人在網頁上完成預約。今天是 ${todayStr}。\n\n` +
      `課程清單（只能推薦這裡面真實存在的課程和規格，價格、名稱、規格文字都要照抄，不可以自己編或翻譯）：\n${courseCatalogText(catalog)}\n\n` +
      `你的任務：\n` +
      `1. 用輕鬆口語的繁體中文對話，一次通常只問一個問題，不要一次列一堆問題轟炸客人。\n` +
      `2. 幫客人搞清楚：這次總共幾位大人、幾位小孩、想上哪個課程（可以不只一種課程或人數），想約哪一天，時段（上午／下午／晚上）如果客人主動講就記下來，沒講不用刻意追問。\n` +
      `3. 資訊收齊之後，先完整覆述一次（哪一天、幾位、上什麼課、大概金額）給客人確認，客人明確答應（例如「對」「好」「可以」「沒問題」）之後，才在這句回覆的最後另起一段，輸出下面這個格式的區塊（這段是給系統看的，不是給客人看的說明文字，客人不會看到）：\n\n` +
      "<<<BOOKING>>>\n" +
      `{"adults":1,"kids":0,"date":"2026/08/20","slotPreference":"afternoon","items":[{"courseName":"創作繪畫","spec":"會員價","qty":1}]}\n` +
      "<<<END>>>\n\n" +
      `slotPreference 只能填 morning、afternoon、evening、any 其中一個字。courseName 和 spec 必須跟課程清單裡的原始文字完全一致。客人資訊還沒收齊、或客人還沒明確同意送出之前，絕對不要輸出這個區塊——寧可多問一句，也不要在資訊不齊全時就送出。`;

    const messages = [
      ...history
        .filter((h) => h && h.role && h.text)
        .map((h) => ({ role: h.role === "assistant" ? "assistant" : "user", content: String(h.text).slice(0, 2000) })),
      { role: "user", content: message },
    ];

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 700, system: systemPrompt, messages }),
    });
    const j = await r.json();
    if (!r.ok) {
      console.error("/liff/assistant Claude 呼叫失敗：", JSON.stringify(j));
      return res.status(502).json({ ok: false, error: "AI 暫時連不上，請稍後再試" });
    }
    const raw = (j.content || []).map((c) => c.text || "").join("");

    let reply = raw, booking = null;
    const m = raw.match(/<<<BOOKING>>>([\s\S]*?)<<<END>>>/);
    if (m) {
      reply = raw.slice(0, m.index).trim();
      try { booking = JSON.parse(m[1].trim()); } catch (e) { booking = null; }
    }
    res.json({ ok: true, reply, booking });
  } catch (e) {
    console.error("/liff/assistant 失敗：", e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ══ 行事曆同步用的預約清單 ══════════════════════════════
   Google Apps Script 每小時來撈一次，同步進 Google 行事曆。

   這支會吐客人姓名電話，所以跟其他 /cron 一樣用 CRON_KEY 擋住——
   跟給客人端的 /liff/* 不同，那幾支是公開的、只吐該吐的。

   取消的預約也要回傳（帶 status），行事曆那邊才知道要把已建的
   活動刪掉。只回傳「還有效的」的話，客人取消了，行事曆上那筆
   會一直留著，老師照樣去準備。

   GET /cron/bookings?key=xxx&from=2026/08/10&to=2026/09/30
   不給日期就抓今天起 60 天。 */
app.get("/cron/bookings", async (req, res) => {
  try {
    if (req.query.key !== CRON_KEY) return res.status(403).json({ ok: false });

    const p = (n) => String(n).padStart(2, "0");
    const tw = new Date(Date.now() + 8 * 3600 * 1000);
    const fmt = (d) => `${d.getUTCFullYear()}/${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())}`;
    const from = String(req.query.from || fmt(tw));
    const toD = new Date(tw.getTime());
    toD.setUTCDate(toD.getUTCDate() + 60);
    const to = String(req.query.to || fmt(toD));

    const all = await fbGet("bookings");
    const list = [];
    for (const id in (all || {})) {
      const b = all[id];
      if (!b || !b.date) continue;
      const d = String(b.date);
      if (d < from || d > to) continue;
      list.push({
        id,
        date: d,
        slot: b.slot || "",
        slot2: b.slot2 || "",
        slots: (Array.isArray(b.slots) && b.slots.length)
          ? b.slots.filter(Boolean) : [b.slot, b.slot2].filter(Boolean),
        actualTime: b.actualTime || "",
        people: Number(b.people) || 0,
        seats: Number(b.seats) || Number(b.people) || 0,
        hours: Number(b.hours) || 0,
        adults: Number(b.adults) || 0,
        kids: Number(b.kids) || 0,
        name: (b.customer && b.customer.name) || "",
        phone: (b.customer && b.customer.phone) || "",
        note: (b.customer && b.customer.note) || "",
        courses: (b.items || []).map((i) =>
          `${i.name || ""}${i.spec ? "（" + i.spec + "）" : ""}×${i.qty || 1}`).join("、"),
        source: b.source || "liff",
        status: b.status || "new",
        checkedOut: !!b.checkout,
      });
    }
    list.sort((a, b2) => (a.date + a.slot).localeCompare(b2.date + b2.slot));
    res.json({ ok: true, from, to, total: list.length, bookings: list });
  } catch (e) {
    console.error("/cron/bookings 失敗：", e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/auth/ping", (_, res) => {
  res.json({
    loginChannelId: LOGIN_ID,
    secretSet: !!LOGIN_SECRET,
    staffDb: STAFF_DB,
    staffSecretSet: !!STAFF_SECRET,
    firebaseSecretSet: !!FIREBASE_SECRET,
    sessionSecretSet: SESSION_SECRET !== "otto2-change-me",
  });
});

app.get("/", (_, res) => res.send("Otto2 notify service is running."));

/* 自我檢測：確認 token 是否有效 */
/* 部署版本標記。
   ── 為什麼要有這個 ──
   /health 原本那幾項舊版就有，全部 true 只證明服務活著，
   證明不了跑的是哪一版程式。2026-08-09 那次就是這樣誤判的：
   health 全綠，但 Railway 上其實還是舊檔，/staff/list 回 404。
   以後改完 server.js 就把日期往下加一版，部署後打開 /health 對一眼。 */
const SERVER_VERSION = "2026-08-13-assistant";

app.get("/health", async (_, res) => {
  const out = {
    version: SERVER_VERSION,
    hasCalendarFeed: true,   /* 這個欄位存在，就代表 /cron/bookings 在 */
    hasSeats: true,          /* 時段名額改以 seats 計算（地毯這類佔位課用得到） */
    hasLiffRead: true,   /* 這個欄位存在，就代表 /liff/me、/liff/slots、/liff/member 都在 */
    hasStaffList: true,   /* 這個欄位存在，就代表 /staff/list 和 /staff/applink 都在 */
    hasAssistant: true,   /* 這個欄位存在，就代表 /liff/assistant（預約頁 AI 小幫手）在 */
    lineTokenSet: !!LINE_TOKEN,
    firebaseSet: !!FIREBASE_URL,
    firebaseSecretSet: !!FIREBASE_SECRET,
    staffSecretSet: !!STAFF_SECRET,
    sessionSecretSet: SESSION_SECRET !== "otto2-change-me",
    anthropicKeySet: !!ANTHROPIC_API_KEY,
  };
  if (LINE_TOKEN) {
    try {
      const r = await fetch("https://api.line.me/v2/bot/info", {
        headers: { Authorization: `Bearer ${LINE_TOKEN}` },
      });
      if (r.ok) { const j = await r.json(); out.botName = j.displayName; }
    } catch (e) { out.lineError = e.message; }
  }
  /* 順便確認密鑰真的連得上資料庫。
     故意去戳 members（等一下要鎖起來的路徑）：
     規則鎖上之後還讀得到，就代表密鑰確實有效。
     注意 shallow 不能跟 orderBy／limitToFirst 併用，會被 Firebase 退回。 */
  try {
    const r = await fetch(fbUrl("members", { shallow: "true" }));
    out.firebaseReadable = r.ok;
    if (!r.ok) out.firebaseError = `HTTP ${r.status}: ${(await r.text()).slice(0, 120)}`;
  } catch (e) { out.firebaseError = e.message; }
  try {
    const r = await fetch(staffUrl("staff", { shallow: "true" }));
    out.staffDbReadable = r.ok;
  } catch (e) { out.staffDbError = e.message; }
  res.json(out);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`otto2-notify on ${PORT}`));
