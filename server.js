import express from "express";
import crypto from "crypto";

const app = express();

/* transactionId 是 LINE Pay 的 19 位數大整數交易 ID，超過 JS Number 安全
   整數範圍（16 位數），直接用內建 JSON.parse 解析會悄悄失真——存進資料庫、
   拿去打 Confirm API 的都變成另一個不存在的交易 ID（LINE Pay 回 1159
   The transaction request does not exist）。在 JSON.parse 之前先把這個
   欄位包成字串，全程當字串處理。兩邊都會經過這裡：LINE Pay 打我們的
   /payment/confirm（走下面這段 body 解析），跟我們打 LINE Pay API 拿回應
   （走 lpCall 那邊），各自要各自修一次。 */
function parseBigIntSafeJson(text) {
  if (!text) return {};
  try {
    return JSON.parse(text.replace(/"transactionId"\s*:\s*(\d+)/g, '"transactionId":"$1"'));
  } catch {
    return {};
  }
}
app.use(express.text({ type: "*/*", limit: "10mb" }));
app.use((req, _res, next) => { req.body = parseBigIntSafeJson(req.body); next(); });

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

/* ── 訂金付款通知店家 ──
   SECRETARY_LINE_TOKEN / OWNER_USER_ID：跟 line-ai-helper 的取貨提醒用同一組
   （從 ai-post-loop 複製來的憑證），刻意不用客服帳號的 client，走小秘書帳號推播 */
const SECRETARY_LINE_TOKEN = process.env.SECRETARY_LINE_TOKEN || "";
const OWNER_USER_ID = process.env.OWNER_USER_ID || "";
async function pushOwner(text) {
  if (!SECRETARY_LINE_TOKEN || !OWNER_USER_ID) return;
  const res = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${SECRETARY_LINE_TOKEN}`,
    },
    body: JSON.stringify({ to: OWNER_USER_ID, messages: [{ type: "text", text }] }),
  });
  if (!res.ok) console.error("店家付款通知失敗：", res.status, await res.text());
}

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
  const out = j.table.rows.map((r) => r.c.map((c) => (c ? (c.f ?? c.v) : "")));
  /* 標題掛在陣列上（不可列舉），後來加在最右邊的欄位（例如「兩人價」）照標題找 */
  Object.defineProperty(out, "__head", { value: (j.table.cols || []).map((c) => String((c && (c.label || c.id)) || "").trim()), enumerable: false });
  return out;
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
          ? {
              t: Math.max(0, Number(v2.t) || 0), tPM: v2.tPM, ev: Math.max(0, Number(v2.ev) || 0),
              capAM: v2.capAM != null ? Math.max(0, Number(v2.capAM) || 0) : null,
              capPM: v2.capPM != null ? Math.max(0, Number(v2.capPM) || 0) : null,
              capPM2: v2.capPM2 != null ? Math.max(0, Number(v2.capPM2) || 0) : null,
              capEve: v2.capEve != null ? Math.max(0, Number(v2.capEve) || 0) : null,
            }
          : Math.max(0, Number(v2) || 0);
    }
  } catch (e) { console.error("讀 Firebase 班表失敗：", e.message); }
  scheduleCache = { data: m, ts: Date.now() };
  return m;
}
/* tPM（下午老師數）2026-08-17 新增，跟 salary-system/booking.js 的
   bkSchedVal 一字不差——舊資料沒有 tPM 就沿用 t，維持舊行為。 */
function schedVal(sched, d) {
  const v = sched[d];
  if (v == null) return null;
  if (typeof v === "object") return {
    t: Math.max(0, Number(v.t) || 0),
    tPM: (v.tPM == null ? Math.max(0, Number(v.t) || 0) : Math.max(0, Number(v.tPM) || 0)),
    ev: Math.max(0, Number(v.ev) || 0),
    capAM: v.capAM != null ? Math.max(0, Number(v.capAM) || 0) : null,
    capPM: v.capPM != null ? Math.max(0, Number(v.capPM) || 0) : null,
    capPM2: v.capPM2 != null ? Math.max(0, Number(v.capPM2) || 0) : null,
    capEve: v.capEve != null ? Math.max(0, Number(v.capEve) || 0) : null,
  };
  return { t: Math.max(0, Number(v) || 0), tPM: Math.max(0, Number(v) || 0), ev: 0, capAM: null, capPM: null, capPM2: null, capEve: null };
}
function baseTeachersOn(d) {
  const [y, m, dd] = d.split("/").map(Number);
  const w = new Date(y, m - 1, dd).getDay();
  return BK_BASE_WEEK[w] == null ? 1 : BK_BASE_WEEK[w];
}
function teachersOn(sched, d) { /* 上午 */
  const v = schedVal(sched, d);
  return v ? v.t : baseTeachersOn(d);
}
function teachersOnPM(sched, d) { /* 下午 */
  const v = schedVal(sched, d);
  return v ? v.tPM : baseTeachersOn(d);
}
function eveOn(sched, d) {
  const v = schedVal(sched, d);
  return v ? v.ev : 0;
}
function rawCapOf(sched, d) { return Math.min(teachersOn(sched, d) * CAP_PER_TEACHER, SEAT_CAP); }
function rawCapOfPM(sched, d) { return Math.min(teachersOnPM(sched, d) * CAP_PER_TEACHER, SEAT_CAP); }
function rawEveCapOf(sched, d) { return Math.min(eveOn(sched, d) * CAP_PER_TEACHER, SEAT_CAP); }
/* 後台可以幫某個時段手動降上限（位子還夠，但那個時段先不排更多人進來），
   跟老師排班算出來的上限取較小值——跟 salary-system/booking.js 的 bkCapOf 系列、
   otto2artclub-booking/index.html 的 capOf 系列一字不差，這三個檔案的容量公式
   要一起改，漏一個地方客人/AI看到的名額就會跟後台對不起來。
   14:00-16:00 用 capPM，16:00-18:00 用 capPM2，各自獨立；老師排班的天花板
   （rawCapOfPM）還是共用同一批下午老師算出來的。 */
function capOf(sched, d) { const v = schedVal(sched, d), b = rawCapOf(sched, d); return (v && v.capAM != null) ? Math.min(b, v.capAM) : b; }
function capOfPM(sched, d) { const v = schedVal(sched, d), b = rawCapOfPM(sched, d); return (v && v.capPM != null) ? Math.min(b, v.capPM) : b; }
function capOfPM2(sched, d) { const v = schedVal(sched, d), b = rawCapOfPM(sched, d); return (v && v.capPM2 != null) ? Math.min(b, v.capPM2) : b; }
function eveCapOf(sched, d) { const v = schedVal(sched, d), b = rawEveCapOf(sched, d); return (v && v.capEve != null) ? Math.min(b, v.capEve) : b; }

/* 課程表快取，給 AI 小幫手組課程清單用。
   欄位順序跟客人端 rowsToGroups 一模一樣（不可插欄）：
   分類0／名稱1／說明2／規格3／時長4／價格5／圖片6／上架7／排序8／最小年齡9。
   快取 5 分鐘，客人聊天來回好幾句不用每句都重讀試算表。 */
let courseCatalogCache = { data: null, ts: 0 };
const COURSE_CATALOG_TTL = 5 * 60 * 1000;
async function loadCourseCatalog() {
  if (courseCatalogCache.data && Date.now() - courseCatalogCache.ts < COURSE_CATALOG_TTL) return courseCatalogCache.data;
  const rows = await gvizSheet("課程");
  /* 「兩人價」是後來加在最右邊的欄，照標題找：gviz 有認出標題列就在 __head，
     沒認出來的話標題會是資料第一列（「分類」開頭） */
  let head = rows.__head || [];
  if (rows.length && String(rows[0][0] || "").trim() === "分類") head = rows[0].map((x) => String(x || "").trim());
  const iPair = head.findIndex((h) => String(h).replace(/\s/g, "") === "兩人價");
  const items = rows
    .map((r) => ({
      cat: String(r[0] || "").trim(),
      name: String(r[1] || "").trim(),
      desc: String(r[2] || "").trim(),
      spec: String(r[3] || "").trim(),
      price: String(r[5] ?? "").trim(),
      pair: iPair >= 0 ? Number(String(r[iPair] ?? "").replace(/[^\d.]/g, "")) || 0 : 0,
      on: String(r[7] || "Y").trim().toUpperCase() !== "N",
      minAge: Number(r[9]) || 0,
    }))
    .filter((it) => it.name && it.on && it.name !== "課程名稱");
  courseCatalogCache = { data: items, ts: Date.now() };
  return items;
}
/* 加購清單，同一份快取邏輯。欄位：課程名稱0／規格1／加購名稱2／價格3／排序4，
   跟客人端 SHEET_HEADERS「加購」一模一樣。規格是空的就代表這門課不分規格都能加購。 */
let addonCatalogCache = { data: null, ts: 0 };
async function loadAddonCatalog() {
  if (addonCatalogCache.data && Date.now() - addonCatalogCache.ts < COURSE_CATALOG_TTL) return addonCatalogCache.data;
  let items = [];
  try {
    const rows = await gvizSheet("加購");
    items = rows
      .map((r) => ({
        courseName: String(r[0] || "").trim(),
        spec: String(r[1] || "").trim(),
        name: String(r[2] || "").trim(),
        price: String(r[3] ?? "").trim(),
      }))
      .filter((it) => it.courseName && it.name);
  } catch (e) { console.error("讀加購分頁失敗：", e.message); }
  addonCatalogCache = { data: items, ts: Date.now() };
  return items;
}

/* 給 AI 看的公休日提示。之前發生過 AI 沒查真正的班表，
   直接答應客人約在公休的星期日——因為它完全不知道哪幾天沒開課。
   規則本身（預設週日公休）加上近期班表的例外（例如某週日有開、
   或平日臨時公休），一起整理成一段話餵給它，它才不會亂答應日期。
   最終有沒有位置還是要看 /liff/availability 那邊算出來的真實名額，
   這段只是讓 AI 在對話階段就不要建議或答應明顯不開課的日子。 */
async function closedDaysNote(days = 30) {
  const sched = await loadSchedule();
  const exceptions = [];
  const now = new Date();
  for (let i = 0; i < days; i++) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i);
    const ds = `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`;
    const t = teachersOn(sched, ds), tPM = teachersOnPM(sched, ds);
    const isSun = d.getDay() === 0;
    if (isSun && (t > 0 || tPM > 0)) exceptions.push(`${ds}（${WD[d.getDay()]}）例外有開課`);
    if (!isSun && t === 0 && tPM === 0) exceptions.push(`${ds}（${WD[d.getDay()]}）臨時公休`);
  }
  return `預設每週日公休，其餘平日和週六都有開課。` +
    (exceptions.length ? `近期例外（以這份為準）：${exceptions.join("、")}。` : "近期沒有例外。") +
    `絕對不要建議或答應公休日；不確定某天算不算公休，就用「這天要不要開課我不確定，選好之後直接帶你看實際空位，那邊會準確顯示」帶過，不要自己猜。`;
}
/* 「體驗價／會員價／單次原價」這種不是真的不同商品，只是同一堂課的
   價格分級——AI 沒辦法確認客人是不是會員，三個一起列出來只會讓人
   誤用或困惑。這種課程只給 AI 看「非會員會付的那個價格」，其餘規格
   （像是 A4／A5 這種真的不同尺寸）還是全部列出來讓客人挑。 */
const PRICE_TIER_WORDS = ["體驗價", "會員價", "單次原價", "原價", "優惠價"];
const isPriceTierSpec = (s) => PRICE_TIER_WORDS.some((w) => String(s || "").includes(w));

/* 組成給 AI 看的課程清單文字，含加購。同一門課多個規格併成一行，
   AI 只能從這份清單裡挑課程名稱和規格的原始文字，不可以自己編或翻譯，
   不然客人端拿這串文字去對 groups 會對不到，整個流程就斷了。 */
/* 兩人價：大熊在課程表「兩人價」欄自己挑課設定，沒填的課沒有同行優惠。
   同課同尺寸每兩位算一次兩人價，落單的那位照原價（跟客人端 pairTotal 同一條公式）。 */
const pairNote = (v) => (v.pair > 0
  ? `（兩人同行 $${v.pair}：同一門課同一個規格每兩位一組算 $${v.pair}，落單的那位照原價；booking JSON 的 price 仍填單人原價 $${v.price}）`
  : "");
function courseCatalogText(items, addons) {
  const byKey = new Map();
  for (const it of items) {
    const k = it.cat + "|" + it.name;
    if (!byKey.has(k)) byKey.set(k, { cat: it.cat, name: it.name, desc: it.desc, minAge: it.minAge, variants: [] });
    byKey.get(k).variants.push({ spec: it.spec, price: it.price, pair: it.pair });
  }
  const addonsByCourse = new Map();
  for (const a of addons || []) {
    if (!addonsByCourse.has(a.courseName)) addonsByCourse.set(a.courseName, []);
    addonsByCourse.get(a.courseName).push(`${a.name}${a.spec ? `（限${a.spec}）` : ""} +$${a.price}`);
  }
  return [...byKey.values()]
    .map((g) => {
      const allTier = g.variants.length > 0 && g.variants.every((v) => isPriceTierSpec(v.spec));
      let specsText;
      if (allTier) {
        const orig =
          g.variants.find((v) => v.spec.includes("單次原價")) ||
          g.variants.find((v) => v.spec.includes("原價")) ||
          g.variants.reduce((a, b) => (Number(b.price) > Number(a.price) ? b : a));
        specsText = `非會員價 $${orig.price}${pairNote(orig)}（這是唯一給你的價格，不要主動提會員價或體驗價這些選項——` +
          `如果之後要輸出 booking JSON，spec 請填「${orig.spec}」；客人是不是會員、能不能用優惠價，` +
          `交給客人送出預約、填手機那一步由系統自動核對套用，你不用猜也不用問）`;
      } else {
        specsText = g.variants.map((v) => `${v.spec || "單一規格"} $${v.price}${pairNote(v)}`).join("、");
      }
      const ads = addonsByCourse.get(g.name);
      return `【${g.cat}】${g.name}${g.minAge ? `（${g.minAge}歲以上）` : ""}：${g.desc}\n  規格與價格：${specsText}` +
        (ads ? `\n  可加購：${ads.join("、")}` : "");
    })
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

function card({ tag, tagColor, title, rows, notes, footer, button }) {
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
    footer: button || footer
      ? {
          type: "box", layout: "vertical", spacing: "sm",
          contents: [
            ...(button
              ? [{ type: "button", style: "primary", color: NAVY, height: "sm",
                   action: { type: "uri", label: button.label, uri: button.uri } }]
              : []),
            ...(footer ? [{ type: "text", text: footer, size: "xxs", color: SOFT, align: "center" }] : []),
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

    /* LINE Pay 這個商家的線上服務通路目前 Confirm 那步一直卡 LINE Pay
       1169（換帳號、換付款方式都一樣），還沒確認開通前，客人這邊一律退回
       舊的「請截圖回傳 LINE」人工核對流程。createPaymentOrder 這支函式
       本身留著沒刪——LINE Pay 那邊確認開通後，把下面這段 payButton 的
       邏輯放回來就好，不用重寫。 */
    const payButton = null;
    const depNote =
      dep.hold
        ? "已使用你先前預付的訂金，不用再付款，當天見！"
        : dep.method === "points"
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
      button: payButton,
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

/* ══ 1.6 固定時段（2026-10-03）══
   家長要求每週固定同一時段上課，後台一次排好最多一個月（4 次）。
   這張卡取代一般的預約確認，把日期、預扣點數、取消規則一次講清楚。
   點數是核銷時才真的扣，這裡只是告知。 */
app.post("/notify/fixed", async (req, res) => {
  try {
    const b = req.body || {};
    const uid = b.line?.userId;
    if (!uid) return res.json({ ok: false, skip: "無 LINE 身分，略過推播" });
    const dates = Array.isArray(b.dates) ? b.dates : [];
    if (!dates.length) return res.status(400).json({ ok: false, error: "沒有日期" });
    const pts = Number(b.pts || 800);
    const slots = (Array.isArray(b.slots) ? b.slots : []).join("、");
    const [y, m, dd] = dates[0].split("/").map(Number);
    const wd = WD[new Date(y, m - 1, dd).getDay()];

    const bubble = card({
      tag: "固定時段預約",
      tagColor: "#3B4A8C",
      title: b.name ? `${b.name}，固定時段已保留` : "固定時段已保留",
      rows: [
        row("時段", `每週${wd}　${slots}`, true),
        row("日期", dates.map(dateLabel).join("\n"), true),
        row("課程", itemLines(b.items).join("\n") || "—"),
        ...(b.people ? [row("人數", `${b.people} 位`)] : []),
        row("預扣點數", `${pts} 點 × ${dates.length} 次 = ${(pts * dates.length).toLocaleString()} 點`, true),
      ],
      notes: [
        `固定時段會先預扣點數，每次 ${pts} 點，最多一個月 4 次（${(pts * 4).toLocaleString()} 點）。`,
        "如需請假，請在上課前事先告知小編，或從 LINE 預約頁自行取消，取消的那次不扣點。",
        `沒有事先取消、當天未到課，該次仍會扣除 ${pts} 點。`,
      ].join("\n"),
      footer: "Otto2 ARTCLUB 藝術工作室",
    });

    await push(uid, [
      { type: "flex", altText: `固定時段已保留：每週${wd} ${slots}，共 ${dates.length} 次`, contents: bubble },
    ]);
    console.log("固定時段推播成功 →", uid.slice(0, 8) + "...", dates.join(","));
    res.json({ ok: true });
  } catch (e) {
    console.error("固定時段推播失敗：", e.message);
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

/* ══ 2.5 作品寄出（2026-09-30）══
   後台「寄送」按「已寄出」時呼叫。客人不用再私訊問「寄了沒」，
   單號直接在卡片上，超商取件的另外提醒要看取件簡訊。
   內部備註、運費這些不會傳過來，只推客人需要知道的。 */
app.post("/notify/shipment", async (req, res) => {
  try {
    const s = req.body || {};
    const uid = s.lineUserId;
    if (!uid) return res.json({ ok: false, skip: "無 LINE 身分" });

    const rows = [
      row("寄送方式", s.wayName || "—", true),
      ...(s.carrier ? [row("物流", s.carrier)] : []),
      ...(s.trackingNo ? [row("單號", s.trackingNo, true)] : []),
      row("收件人", s.recipient || "—"),
      ...(s.dest ? [row(s.isStore ? "取件門市" : "地址", s.dest)] : []),
      ...(s.items ? [row("內容", s.items)] : []),
      ...(s.shippedDate ? [row("寄出日期", dateLabel(s.shippedDate))] : []),
    ];
    const bubble = card({
      tag: "作品寄出",
      tagColor: GOLD,
      title: "你的作品已經寄出囉 📦",
      rows,
      notes: s.isStore
        ? "送達門市後會收到超商的取件簡訊，記得在期限內去領取。收到後有任何問題，歡迎直接私訊小編。"
        : "一般 1–3 天會送達。收到後有任何問題，歡迎直接私訊小編。",
      footer: "Otto2 ARTCLUB 藝術工作室",
    });

    await push(uid, [
      { type: "flex", altText: `作品已寄出${s.trackingNo ? "，單號 " + s.trackingNo : ""}`, contents: bubble },
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

    const notifySettings = (await fbGet("settings/notify").catch(() => null)) || {};
    const reminderCfg = notifySettings.reminder || {};
    if (reminderCfg.enabled === false) {
      return res.json({ ok: true, skip: "預約提醒目前已停用" });
    }
    const daysBefore = Number.isFinite(reminderCfg.daysBefore) ? reminderCfg.daysBefore : 1;

    // 以台灣時間算「N 天後」
    const now = new Date(Date.now() + 8 * 3600 * 1000);
    now.setUTCDate(now.getUTCDate() + daysBefore);
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

/* ══ 訂單逾時提醒 ══
   訂金掛著沒付、又還沒被 /cron/release 釋放掉的訂單，主動推一次提醒，
   給客人一個機會在真的被釋放前補款。跟 /cron/remind 同一套「設定開關 +
   已發過就不再發」的邏輯，只是這裡看的是 booking.ts（下單時間，跟
   /cron/release 用的是同一個欄位）而不是上課日期。
   用法：/cron/overdue-remind?key=xxx，要另外在 Railway 開一條 Cron Job。 */
app.get("/cron/overdue-remind", async (req, res) => {
  try {
    if (req.query.key !== CRON_KEY) return res.status(403).json({ ok: false });

    const notifySettings = (await fbGet("settings/notify").catch(() => null)) || {};
    const overdueCfg = notifySettings.overdue || {};
    if (overdueCfg.enabled === false) {
      return res.json({ ok: true, skip: "訂單逾時提醒目前已停用" });
    }
    const hoursAfter = Number.isFinite(overdueCfg.hoursAfter) ? overdueCfg.hoursAfter : 12;
    const cutoff = Date.now() - hoursAfter * 3600 * 1000;

    const data = await fbGet("bookings");
    const list = Object.entries(data || {})
      .map(([id, v]) => ({ id, ...v }))
      .filter(
        (b) =>
          b.deposit?.status !== "paid" &&
          b.status !== "cancelled" &&
          b.status !== "expired" &&
          b.status !== "confirmed" &&
          b.line?.userId &&
          !b.overdueRemindedAt &&
          new Date(b.ts || 0).getTime() < cutoff
      );

    let sent = 0;
    const failed = [];
    for (const b of list) {
      const dep = b.deposit || {};
      const depName =
        dep.name ||
        (dep.method === "points" ? "儲值金扣點" : dep.method === "transfer" ? "銀行匯款" : dep.method === "card" ? "現場刷卡" : "LINE Pay 訂金");

      const bubble = card({
        tag: "訂單逾時提醒",
        tagColor: "#C0392B",
        title: "Otto2 ARTCLUB 旗艦館",
        rows: [
          row("日期", dateLabel(b.date), true),
          row("時段", b.actualTime || b.slot, true),
          row("課程", itemLines(b.items).join("\n") || "—"),
          row("訂金方式", depName),
        ],
        notes: "這筆預約的訂金還沒收到，請儘快完成付款保留位置，逾期名額可能會被釋放。",
        footer: "Otto2 ARTCLUB 藝術工作室",
      });

      try {
        await push(b.line.userId, [
          { type: "flex", altText: `訂單逾時提醒：${b.date} ${b.slot}`, contents: bubble },
        ]);
        await fbPatch(`bookings/${b.id}`, { overdueRemindedAt: new Date().toISOString() });
        sent++;
      } catch (e) {
        failed.push({ id: b.id, error: e.message });
      }
    }
    res.json({ ok: true, hoursAfter, total: list.length, sent, failed });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ══ 手動廣播 ══
   後台「通知設定」頁的手動廣播用。只有 otto2-admin.html 登入後拿到的
   Firebase idToken 驗證得過，才讓打——驗證方式是拿 idToken 去問 Firebase
   Auth 本人是誰，跟後台登入用的是同一組 Firebase 專案，不用另外管一套密碼。
   收件人＝目前 bookings 裡出現過、留有 LINE 身分的不重複使用者。 */
const FIREBASE_API_KEY = process.env.FIREBASE_API_KEY || "AIzaSyDgPVrHEYScDfuIPyvsBNNEdSROKJBgHqY";

async function verifyAdminIdToken(idToken) {
  if (!idToken) return false;
  const r = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${FIREBASE_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idToken }),
    }
  );
  if (!r.ok) return false;
  const j = await r.json();
  return !!(j.users && j.users[0]);
}

/* LINE multicast：一次最多 500 人，超過就切批次 */
async function multicast(uids, messages) {
  if (!LINE_TOKEN) throw new Error("缺少 LINE_TOKEN");
  const batches = [];
  for (let i = 0; i < uids.length; i += 500) batches.push(uids.slice(i, i + 500));
  for (const to of batches) {
    const res = await fetch("https://api.line.me/v2/bot/message/multicast", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${LINE_TOKEN}`,
      },
      body: JSON.stringify({ to, messages }),
    });
    if (!res.ok) throw new Error(`LINE multicast ${res.status}: ${await res.text()}`);
  }
}

app.post("/admin/broadcast", async (req, res) => {
  try {
    const { idToken, text } = req.body || {};
    if (!text || !text.trim()) return res.status(400).json({ ok: false, error: "缺少廣播內容" });
    if (!(await verifyAdminIdToken(idToken))) {
      return res.status(401).json({ ok: false, error: "登入已過期，請重新整理後台再試一次" });
    }

    const data = await fbGet("bookings");
    const uids = [...new Set(Object.values(data || {}).map((b) => b.line?.userId).filter(Boolean))];

    if (!uids.length) return res.json({ ok: true, recipients: 0 });
    await multicast(uids, [{ type: "text", text }]);
    console.log(`手動廣播 → ${uids.length} 人`);
    res.json({ ok: true, recipients: uids.length });
  } catch (e) {
    console.error("廣播失敗：", e.message);
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
  const json = parseBigIntSafeJson(await res.text().catch(() => ""));
  console.log(`LINE Pay ${method} ${uri} →`, json.returnCode, json.returnMessage || "");
  return json;
}

/* ══ 4. 建立付款：金額一律從資料庫取，bookingId 兩邊共用 ══
   /notify/booking（預約成功當下）跟 /payment/create（前端手動補付）都會呼叫這支，
   邏輯只寫一份，避免兩邊各自兜一份 request payload 之後跑掉。 */
async function createPaymentOrder(bookingId) {
  const b = await fbGet(`bookings/${bookingId}`);
  if (!b) { const e = new Error("找不到這筆預約"); e.code = "NOT_FOUND"; throw e; }
  if (b.status === "cancelled") { const e = new Error("這筆預約已取消"); e.code = "CANCELLED"; throw e; }
  if (b.deposit?.status === "paid") return { already: true };

  const amount = Number(b.deposit?.amount || 0);
  if (!amount) { const e = new Error("這筆預約沒有訂金金額"); e.code = "NO_AMOUNT"; throw e; }

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

  if (r.returnCode !== "0000") {
    const e = new Error(`LINE Pay ${r.returnCode}：${r.returnMessage}`);
    e.code = "LINEPAY_ERROR";
    throw e;
  }

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

  /* r.info.paymentUrl 是 {web, app} 物件，不是純網址字串。
     這個連結永遠是在 LINE 生態圈裡被點開的（LINE 聊天室的 Flex 按鈕、
     或 LIFF 預約頁），用 web 版會被 LINE 內建瀏覽器包住，LINE Pay 認不出
     環境、卡在「請用預設瀏覽器」那頁打不開。改用 app 版（line://pay/...），
     直接在 LINE App 內開啟 LINE Pay，不會跳瀏覽器。 */
  return { orderId, paymentUrl: r.info.paymentUrl.app, transactionId: r.info.transactionId, amount };
}

app.post("/payment/create", async (req, res) => {
  try {
    const bookingId = (req.body || {}).bookingId;
    if (!bookingId) return res.status(400).json({ ok: false, error: "缺少 bookingId" });

    const order = await createPaymentOrder(bookingId);
    if (order.already) return res.json({ ok: true, already: true, message: "訂金已付款" });

    res.json({ ok: true, ...order });
  } catch (e) {
    console.error("建立付款失敗：", e.message);
    const status = e.code === "NOT_FOUND" ? 404 : e.code === "CANCELLED" ? 409 : e.code === "LINEPAY_ERROR" ? 502 : 500;
    res.status(status).json({ ok: false, error: e.message });
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

    /* 推播：通知店家有客人付了訂金（客人的推播只有客人自己看得到，店家要另外通知） */
    const custName = (b.customer && b.customer.name) || "";
    const custPhone = (b.customer && b.customer.phone) || "";
    pushOwner(
      `💰 訂金已付款\n` +
        `${custName || "（未填姓名）"}${custPhone ? "　" + custPhone : ""}\n` +
        `${dateLabel(b.date)}　${b.actualTime || b.slot}\n` +
        `NT$${amount.toLocaleString()}`
    ).catch((e) => console.error("店家付款通知失敗：", e.message));

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

/* ══ 單一會員完整資料（員工限定，2026-10-04）══
   members 的 .read 要關掉，後台原本直接讀 /members/{phone} 的地方改問這裡。
   body: { token, phone }，回 { member: 整筆資料或 null } */
app.post("/staff/member", async (req, res) => {
  const s = await requireStaff(req, res);
  if (!s) return;
  try {
    const phone = String((req.body || {}).phone || "").replace(/[^0-9]/g, "").replace(/^886/, "0");
    if (!phone) return res.json({ ok: true, member: null });
    res.json({ ok: true, member: (await fbGet(`members/${phone}`)) || null });
  } catch (e) {
    console.error("/staff/member 失敗：", e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ══ 找回會員的 LINE（2026-10-04）══
   大熊回報：客人明明用 LINE 開過預約頁，後台卻說「還沒綁定 LINE」。
   原因：/liff/member 只有在會員檔案「已經存在」時才寫 lineUserId；
   第一次來的新客開頁面時還沒建檔，LINE 只記在 lineIndex／liffProfiles／預約單，
   之後行政幫他建檔，會員檔案就永遠缺 lineUserId。
   後台看到沒綁定時打這支：從 lineIndex 反查、再看他的線上預約單，
   找到就補寫回會員檔案（只補空的，不蓋掉已綁的）。
   lineIndex 規則鎖住了，瀏覽器讀不到，所以要伺服器來查。
   body: { token, phone } */
app.post("/staff/member-line", async (req, res) => {
  const s = await requireStaff(req, res);
  if (!s) return;
  try {
    const phone = String((req.body || {}).phone || "").replace(/[^0-9]/g, "").replace(/^886/, "0");
    if (!/^0\d{8,10}$/.test(phone)) return res.json({ ok: true, lineUserId: "" });
    const m = await fbGet(`members/${phone}`);
    if (m && m.lineUserId) return res.json({ ok: true, lineUserId: m.lineUserId });
    let uid = "";
    const idx = await fbGet("lineIndex");
    for (const u in (idx || {})) { if (idx[u] === phone) { uid = u; break; } }
    if (!uid) {
      const bk = await fbGet("bookings");
      for (const k in (bk || {})) {
        const b = bk[k];
        if (!b || !b.line || !b.line.userId) continue;
        const p = String(b.memberPhone || (b.customer && b.customer.phone) || "")
          .replace(/[^0-9]/g, "").replace(/^886/, "0");
        if (p === phone) { uid = b.line.userId; break; }
      }
    }
    if (uid && m) await fbPatch(`members/${phone}`, { lineUserId: uid });
    res.json({ ok: true, lineUserId: uid });
  } catch (e) {
    console.error("/staff/member-line 失敗：", e.message);
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
/* ══ 先收訂金、還沒排課（2026-10-04）══
   後台「＋先收訂金（還沒約時間）」記在 otto2-2026/deposits（hold:true、bookingId 空）。
   以前只有後台看得到，家長自己查不到，忘了就沒人提醒排時間。
   /liff/hold      預約頁打電話時問：這支電話有沒有待排課的訂金（只回金額、日期，不回姓名）
   /liff/hold/use  客人線上約好之後，把訂金掛到那筆預約上（跟後台「排時間」寫的欄位一樣） */
async function holdsOf(phone) {
  const all = (await staffGet("deposits")) || {};
  return Object.keys(all).map((id) => ({ id, ...(all[id] || {}) }))
    .filter((h) => h.hold && !h.bookingId && !h.voided && normPhone(h.phone) === phone)
    .sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")));
}
app.post("/liff/hold", async (req, res) => {
  try {
    const phone = normPhone((req.body || {}).phone);
    if (!/^0\d{8,10}$/.test(phone)) return res.json({ ok: true, holds: [] });
    const list = await holdsOf(phone);
    res.json({ ok: true, holds: list.map((h) => ({
      id: h.id, amount: Number(h.amount) || 0, date: h.date || "",
      people: (Number(h.adults) || 0) + (Number(h.kids) || 0),
    })) });
  } catch (e) {
    console.error("/liff/hold 失敗：", e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});
app.post("/liff/hold/use", async (req, res) => {
  try {
    const { holdId, bookingId } = req.body || {};
    if (!holdId || !bookingId) return res.status(400).json({ ok: false, error: "缺少資料" });
    const b = await fbGet(`bookings/${bookingId}`);
    if (!b) return res.status(404).json({ ok: false, error: "找不到預約" });
    const h = await staffGet(`deposits/${holdId}`);
    if (!h || !h.hold || h.voided) return res.status(404).json({ ok: false, error: "找不到這筆訂金" });
    if (h.bookingId) return res.json({ ok: h.bookingId === bookingId, error: "這筆訂金已經用在別的預約" });
    /* 一定要同一支電話，不然拿別人的電話就能把人家的訂金挪來用 */
    if (normPhone(h.phone) !== normPhone((b.customer && b.customer.phone) || b.memberPhone)) {
      return res.status(403).json({ ok: false, error: "電話對不上" });
    }
    const now = new Date().toISOString();
    const wayName = { linepay: "LINE Pay", transfer: "銀行匯款", cash: "現金", card: "刷卡" }[h.way] || h.wayName || h.way || "";
    await fbPatch(`bookings/${bookingId}/deposit`, {
      method: h.way || "other", name: wayName, amount: Number(h.amount) || 0,
      status: "paid", paidWay: h.way || "", paidDate: h.date || "", paidAt: h.at || now,
      last5: h.last5 || "", by: h.by || "", logId: holdId, hold: true,
    });
    await fetch(staffUrl(`deposits/${holdId}`), {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bookingId, classDate: b.date || "", slot: b.slot || "",
        scheduledAt: now, scheduledBy: "客人線上預約" }),
    });
    res.json({ ok: true });
  } catch (e) {
    console.error("/liff/hold/use 失敗：", e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

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
    /* liffProfiles、lineIndex 都沒有的話，回頭從 members 反查
       誰的 lineUserId 是這個人——老客人是後台手動綁的，只有正向連結，
       沒有這段會一直被當陌生人、每次都要重新輸入電話。
       順便把反向連結補回去，下次就不用再查一次全部會員。 */
    if (!phone) {
      const mem = await fbGet("members");
      for (const p in (mem || {})) {
        if (mem[p] && mem[p].lineUserId === uid) {
          phone = p;
          name = name || mem[p].name || "";
          fbPut(`lineIndex/${uid}`, phone);
          fbPatch(`liffProfiles/${uid}`, { phone, name });
          break;
        }
      }
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
        /* 自訂時段（例如後台手動登記加開的 09:30-11:30）要歸進最接近的
           那一場才算得準——跟下面 /liff/availability 用同一套 bkBase()，
           不然這裡沒歸併，客人端會看到「還有位子」，其實那個時段已經
           被加開時段的人佔掉了，容量算少，造成超收。 */
        const base = bkBase(sl) || (BK_SLOTS.includes(sl) || sl === BK_EVE_SLOT ? sl : "");
        if (!base) continue;
        if (!out[d]) out[d] = {};
        out[d][base] = (out[d][base] || 0) + seats;
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
      const cap = sl === BK_EVE_SLOT ? eveCapOf(sched, date) : (sl === "10:00-12:00" ? capOf(sched, date) : (sl === "16:00-18:00" ? capOfPM2(sched, date) : capOfPM(sched, date)));
      const usedN = used[sl] || 0;
      return { slot: sl, used: usedN, cap, left: Math.max(0, cap - usedN), full: usedN >= cap };
    });

    res.json({ ok: true, date, teachers: teachersOn(sched, date), teachersPM: teachersOnPM(sched, date), eveTeachers, slots });
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

/* ══ 客人自己查詢／取消預約（2026-08-18）══════════════════
   以前客人完全看不到自己約了哪天哪個時段，想改想取消只能私訊小編，
   小編也常常忘了通知客人異動。這裡只開「查自己的」「取消自己的」，
   不開「改時段」——改時段直接請客人取消這筆、用「我要預約課程」
   重新走一次完整精靈，名額檢查、佔位、連堂這些邏輯才不用另外複製一份。 */

/* 今天的日期字串（台灣時區），跟 /cron/remind 用同一個算法 */
function todayStr() {
  const t = new Date(Date.now() + 8 * 3600 * 1000);
  return `${t.getUTCFullYear()}/${String(t.getUTCMonth() + 1).padStart(2, "0")}/${String(t.getUTCDate()).padStart(2, "0")}`;
}
function normPhone(raw) {
  const d = String(raw || "").replace(/[^0-9]/g, "");
  return d.replace(/^886/, "0");
}
/* 這支電話／這個 LINE 帳號是不是這筆預約真正的主人，兩條路都比對，
   有一條符合就算數——手動登記可能只留電話、客人自己約的兩個都有 */
function ownsBooking(b, phone, userId) {
  if (userId && b.line && b.line.userId && b.line.userId === userId) return true;
  if (phone) {
    const bp = normPhone((b.customer && b.customer.phone) || b.memberPhone || "");
    if (bp && bp === phone) return true;
  }
  return false;
}

/* 查自己的預約清單。只回顯示需要的欄位，不把 customer/memberPhone
   等其他欄位整包丟出去——這支電話底下可能不只一筆，但終究只有他自己看得到。
   body: { phone, userId? } */
app.post("/liff/mybookings", async (req, res) => {
  try {
    const phone = normPhone((req.body || {}).phone);
    const userId = String((req.body || {}).userId || "").trim();
    if (!phone && !userId) return res.status(400).json({ ok: false, error: "缺少電話或 LINE 身分" });

    const today = todayStr();
    const from = todayStr(); // 過去的不用列，客人查也改不了
    const all = await fbGet("bookings");
    const list = Object.entries(all || {})
      .map(([id, b]) => ({ id, ...b }))
      .filter((b) => b && b.date && ownsBooking(b, phone, userId) && b.status !== "expired")
      .filter((b) => b.date >= from)
      .sort((a, b) => a.date.localeCompare(b.date) || String(a.slot).localeCompare(String(b.slot)))
      .map((b) => ({
        id: b.id,
        date: b.date,
        dateLabel: dateLabel(b.date),
        slot: b.actualTime || b.slot || "",
        items: itemLines(b.items),
        people: b.people || 0,
        status: b.status === "cancelled" ? "cancelled" : "active",
        canCancel: b.status !== "cancelled" && !b.checkout && b.date > today,
      }));
    res.json({ ok: true, bookings: list });
  } catch (e) {
    console.error("/liff/mybookings 失敗：", e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* 客人自己取消。防呆順序照抄後台 bkCancel 的邏輯：
   核銷過的不給取消（怕點數/材料已經扣了）、當天的不給線上取消
   （跟首頁「當日課程無法線上預約」是同一個規則，太臨時要請客人直接聯繫），
   一定要驗證身分才能動別人的預約。
   body: { phone, userId?, bookingId, reason? } */
app.post("/liff/cancelBooking", async (req, res) => {
  try {
    const phone = normPhone((req.body || {}).phone);
    const userId = String((req.body || {}).userId || "").trim();
    const bookingId = String((req.body || {}).bookingId || "").trim();
    const reason = String((req.body || {}).reason || "").trim();
    if (!bookingId) return res.status(400).json({ ok: false, error: "缺少預約編號" });
    if (!phone && !userId) return res.status(400).json({ ok: false, error: "缺少電話或 LINE 身分" });

    const b = await fbGet(`bookings/${bookingId}`);
    if (!b) return res.status(404).json({ ok: false, error: "找不到這筆預約" });
    if (!ownsBooking(b, phone, userId)) return res.status(403).json({ ok: false, error: "這筆不是你的預約" });
    if (b.status === "cancelled") return res.json({ ok: true, already: true });
    if (b.checkout) return res.status(400).json({ ok: false, error: "這筆已經核銷過了，請直接私訊小編處理" });
    const today = todayStr();
    if (b.date <= today) return res.status(400).json({ ok: false, error: "當天的預約無法線上取消，請直接私訊小編" });

    const now = new Date().toISOString();
    await fbPatch(`bookings/${bookingId}`, {
      status: "cancelled",
      cancelledAt: now,
      cancelReason: reason || "客人自行取消",
      cancelledBy: "customer",
    });

    if (b.line && b.line.userId) {
      const bubble = card({
        tag: "取消成功", tagColor: SOFT, title: "這筆預約已經幫你取消",
        rows: [
          row("日期", dateLabel(b.date), true),
          row("時段", b.actualTime || b.slot, true),
          row("課程", itemLines(b.items).join("\n") || "—"),
        ],
        notes: "如果是改時段，歡迎點選圖文選單的「線上預約」重新約一次。",
        footer: "Otto2 ARTCLUB 藝術工作室",
      });
      push(b.line.userId, [{ type: "flex", altText: "預約取消成功", contents: bubble }]).catch(() => {});
    }
    res.json({ ok: true });
  } catch (e) {
    console.error("/liff/cancelBooking 失敗：", e.message);
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

    const [catalog, addons, closedNote] = await Promise.all([loadCourseCatalog(), loadAddonCatalog(), closedDaysNote()]);
    const today = new Date();
    const todayStr = `${today.getFullYear()}/${String(today.getMonth() + 1).padStart(2, "0")}/${String(today.getDate()).padStart(2, "0")}`;

    const systemPrompt =
      `你是 Otto2 ARTCLUB 畫室的預約小幫手，用聊天的方式幫客人在網頁上完成預約。今天是 ${todayStr}。\n\n` +
      `課程清單（只能推薦這裡面真實存在的課程、規格、加購，價格與文字都要照抄，不可以自己編、猜測或翻譯；` +
      `清單裡沒寫的資訊，例如某項加購實際能不能用在某個規格上，就老實說不確定，請客人到現場或預約後跟老師確認，不要編答案）：\n` +
      `${courseCatalogText(catalog, addons)}\n\n` +
      `開課日期：${closedNote}\n\n` +
      `你的任務：\n` +
      `1. 用輕鬆口語的繁體中文對話，一次通常只問一個問題，不要一次列一堆問題轟炸客人。\n` +
      `2. 幫客人搞清楚：這次總共幾位大人、幾位小孩、想上哪個課程（可以不只一種課程或人數，也可以加購），想約哪一天，時段（上午／下午／晚上）如果客人主動講就記下來，沒講不用刻意追問。問課程規格、尺寸這類問題時，只問「想要哪一種」，不要順便把價格也講出來。\n` +
      `3. 這個系統跟一般「填表單等專人回電」不一樣：客人選好日期之後，馬上就能看到那一天真正還有空的時段、自己點選——不是登記需求、不是等人工確認、也不需要「專人聯繫」。所以客人問「什麼時候可以約」「還有什麼時段」，正確的回法是「你想約哪一天呢？選好我直接帶你看那天實際還有哪些空位可以選」，绝对不要說「會有專人確認」「幫你登記需求」這類話，這裡講的不是事實。\n` +
      `4. 價格是敏感資訊，客人沒有主動問「多少錢」「費用」之類的問題之前，絕對不要自己提金額——連在問規格、確認課程、聊加購的時候都不要順便帶到價格。只有客人明確問價錢，或是第 5 點要做最後總結確認時，才可以講金額，而且只講清單裡給你的那個數字就好，不要自己再分會員價／體驗價／原價這些等級，也不要問客人是不是會員——這件事客人送出預約、填手機時系統會自己核對，不用你來判斷。\n` +
      `5. 資訊收齊之後，先完整覆述一次（哪一天、幾位、上什麼課、有沒有加購、大概金額）給客人確認，客人明確答應（例如「對」「好」「可以」「沒問題」）之後，才在這句回覆的最後另起一段，輸出下面這個格式的區塊（這段是給系統看的，不是給客人看的說明文字，客人不會看到）：\n\n` +
      "<<<BOOKING>>>\n" +
      `{"adults":1,"kids":0,"date":"2026/08/20","slotPreference":"afternoon","items":[{"courseName":"創作繪畫","spec":"單次原價","qty":1,"addons":["加購名稱"]}]}\n` +
      "<<<END>>>\n\n" +
      `slotPreference 只能填 morning、afternoon、evening、any 其中一個字。courseName、spec、addons 裡的名稱必須跟課程清單裡的原始文字完全一致，沒有加購就不要放 addons 這個欄位。客人資訊還沒收齊、或客人還沒明確同意送出之前，絕對不要輸出這個區塊——寧可多問一句，也不要在資訊不齊全時就送出。`;

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

/* ══ 十月黑熊扭蛋活動（2026-09-30）══════════════════════════
   客人在預約頁首頁點「十月黑熊扭蛋」卡片就能玩，每天一次；當天有來上課、
   當天用線上預約系統約了課，各多一次。目的是讓家長養成打開預約頁、
   看自己點數的習慣。

   ── 為什麼抽獎一定要在這裡抽，不能在網頁上抽 ──
   網頁上的程式客人改得到，在瀏覽器抽等於讓客人自己決定中什麼。
   所以網頁只負責播動畫，這裡抽完把結果傳回去。

   ── 怎麼確認是本人 ──
   LINE userId 不是秘密，只收 userId 等於誰都能冒充別人來抽。
   改收 LIFF 的 access token，拿去問 LINE 這張 token 是不是發給我們
   這個 LIFF（client_id 對得上）、是誰的。一個 LINE 帳號只能綁一支電話，
   一支電話也只能被一個 LINE 帳號綁，綁過就改不了（要改請小編到後台處理）。

   ── 資料放哪裡（otto2-booking-f9ef7）──
   gacha/config          活動設定、獎品，後台「扭蛋活動」分頁改的就是這份
   gacha/players/{電話}   每個人玩了哪幾天、拿了多少紅利、中過什麼
   gacha/log/{自動編號}   每一次抽獎的紀錄
   gacha/stock/{獎品id}   限量獎品已經送出幾份
   gacha/bind/{userId}   LINE 帳號綁的電話

   送出去的東西直接寫進會員資料，跟賣方案、核銷走同一套帳：
   紅利 → members/{電話}/ledger 加一筆 type:bonus，再重算 cache
   票券 → members/{電話}/tickets 加一張，帶 src:"gacha"
          （後台今日排課判斷「會員」時會排除這種票券，
            不然新客抽到一張折價券就被當成會員了）
   ══════════════════════════════════════════════════════════ */

/* 這個 LIFF 所屬的 LINE Login channel。LIFF ID 開頭那串數字就是它 */
const GACHA_CHANNEL = process.env.GACHA_CHANNEL_ID || String(LIFF_URL.match(/(\d{8,})-/)?.[1] || "2010906803");

const GACHA_DEFAULT = {
  title: "世界藝術日・畢卡索扭扭樂",
  start: "2026-10-03",
  end: "2026-10-31",
  cap: 30,                     /* 每人整個活動期間，每日扭蛋最多拿幾點紅利（集章保底另外算） */
  expiry: "2026-11-30",        /* 抽到的票券用到哪天 */
  testPhones: [],              /* 活動開始前可以先玩的電話（自己人測試用） */
  demoPhones: [],              /* 活動期間無限次示範（不入帳）的電話 */
  demoStaff: true,             /* 活動期間員工名單的人自動是示範模式 */
  doubleDays: ["2026-10-25"],  /* 這幾天多一次機會，而且一定中（10/25 畢卡索生日） */
  doubleLabel: "畢卡索生日加碼",
  lotteryName: "月底大抽獎券",
  /* 會員（手上有點數或堂數）跟新朋友抽不同的獎池（2026-09-30 大熊定）：
     會員紅利 1/3/5/10、會員限定課程券；新朋友紅利 1/2/3、下次上課折抵券。
     grp 相同的獎品算同一組，每人整組最多中 per 張（新朋友折抵券整個活動最多 1 張）。 */
  prizes: [
    { id: "b1",   ic: "✨", nm: "紅利 1 點",  sub: "",               who: "mem", type: "bonus",  v: 1,  w: 580 },
    { id: "b3",   ic: "🌟", nm: "紅利 3 點",  sub: "",               who: "mem", type: "bonus",  v: 3,  w: 120 },
    { id: "b5",   ic: "💫", nm: "紅利 5 點",  sub: "",               who: "mem", type: "bonus",  v: 5,  w: 40 },
    { id: "b10",  ic: "💎", nm: "紅利 10 點", sub: "超幸運",          who: "mem", type: "bonus",  v: 10, w: 20, qty: 20 },
    { id: "upg",  ic: "🖼️", nm: "材料升級券", sub: "畫布升一號",      who: "mem", type: "ticket", kind: "goods",  w: 17, qty: 30, per: 1 },
    { id: "free", ic: "🎨", nm: "免費加一堂課", sub: "會員限定",       who: "mem", type: "ticket", kind: "bundle", w: 3,  qty: 5,  per: 1 },
    { id: "n1",   ic: "✨", nm: "紅利 1 點",  sub: "",               who: "new", type: "bonus",  v: 1,  w: 600 },
    { id: "n2",   ic: "🌟", nm: "紅利 2 點",  sub: "",               who: "new", type: "bonus",  v: 2,  w: 110 },
    { id: "n3",   ic: "💫", nm: "紅利 3 點",  sub: "",               who: "new", type: "bonus",  v: 3,  w: 50 },
    { id: "c50",  ic: "🎟️", nm: "下次上課折抵 $50",  sub: "一次限用一張・體驗價課程不適用", who: "new", type: "ticket", kind: "cash", w: 15, qty: 30, per: 1, grp: "coupon" },
    { id: "c100", ic: "🎟️", nm: "下次上課折抵 $100", sub: "一次限用一張・體驗價課程不適用", who: "new", type: "ticket", kind: "cash", w: 5,  qty: 10, per: 1, grp: "coupon" },
    { id: "none", ic: "🍀", nm: "明天再來",   sub: "今天的集章照樣算", who: "all", type: "none",   w: 220 },
  ],
  milestones: [
    { d: 7,  type: "bonus",  v: 3, nm: "紅利 3 點" },
    { d: 14, type: "bonus",  v: 5, nm: "紅利 5 點" },
    { d: 21, type: "ticket", kind: "goods", nm: "材料升級券" },
    { d: 28, type: "ticket", kind: "goods", nm: "6 號畫布一塊（全勤禮）" },
  ],
};

/* 台灣時間的今天，gacha 這邊一律用 2026-10-03 這種寫法
   （Firebase 的 key 不能有斜線）；預約資料用的是 2026/10/03 */
const gDay = () => todayStr().replace(/\//g, "-");
const gValidPhone = (p) => /^09\d{8}$/.test(p);
const gMask = (name) => {
  const s = String(name || "").trim();
  if (!s) return "一位家長";
  return s.length <= 1 ? s + "**" : s[0] + "*".repeat(Math.min(2, s.length - 1)) + (s.length > 3 ? s.slice(3) : "");
};
const fbPost = async (path, value) =>
  (await fetch(fbUrl(path), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(value),
  })).json();

async function gConfig() {
  const c = await fbGet("gacha/config");
  if (!c || typeof c !== "object" || !Array.isArray(c.prizes)) return GACHA_DEFAULT;
  const cfg = { ...GACHA_DEFAULT, ...c };
  /* 十月改成畢卡索季：後台名稱還是舊的「黑熊」時，一律用新名稱（畫面、紅利明細都是） */
  if (cfg.bearTitle && /黑熊/.test(cfg.title || "")) cfg.title = "世界藝術日・畢卡索扭扭樂";
  return cfg;
}

/* 一次只讓一個人抽——限量獎品的庫存、同一個人連點兩下，
   都靠這個排隊避免重複送。Railway 只跑一台，記憶體裡排隊就夠。 */
let gQueue = Promise.resolve();
function gSerial(fn) {
  const run = gQueue.then(fn, fn);
  gQueue = run.catch(() => {});
  return run;
}

/* access token → LINE userId。同一張 token 十分鐘內不重複問 LINE */
const gTokCache = new Map();
/* 店內體驗平板（park.html?kiosk=1）沒有 LINE 登入，用固定的 "kiosk" 當身分。
   只有扭蛋的 state/spin/quiz/memory 認它，而且一律走示範模式（不入帳、不扣限量），
   其他功能（作品島、走格子、綁電話）傳 "kiosk" 一樣當成沒登入 */
const KIOSK_PHONE = "0900000000";
const KIOSK_WHO = { uid: "kiosk", displayName: "店內體驗", kiosk: true };
async function gBound(who) {
  if (who.kiosk) return KIOSK_PHONE;
  return fbGet(`gacha/bind/${who.uid}`);
}
async function gWho(accessToken, allowKiosk) {
  const tok = String(accessToken || "");
  if (tok === "kiosk") {
    if (allowKiosk) return KIOSK_WHO;
    throw Object.assign(new Error("請從 LINE 打開預約頁再玩"), { code: "NO_LINE" });
  }
  if (!tok) throw Object.assign(new Error("請從 LINE 打開預約頁再玩"), { code: "NO_LINE" });
  const hit = gTokCache.get(tok);
  if (hit && hit.until > Date.now()) return hit.who;
  const vr = await fetch("https://api.line.me/oauth2/v2.1/verify?access_token=" + encodeURIComponent(tok));
  const vj = await vr.json().catch(() => ({}));
  if (!vr.ok || String(vj.client_id) !== GACHA_CHANNEL || !(vj.expires_in > 0)) {
    throw Object.assign(new Error("LINE 登入已過期，請關掉頁面重新打開"), { code: "BAD_TOKEN" });
  }
  const pr = await fetch("https://api.line.me/v2/profile", { headers: { Authorization: "Bearer " + tok } });
  const pj = await pr.json().catch(() => ({}));
  if (!pr.ok || !pj.userId) throw Object.assign(new Error("讀不到 LINE 身分，請重新打開頁面"), { code: "BAD_TOKEN" });
  const who = { uid: pj.userId, displayName: pj.displayName || "" };
  gTokCache.set(tok, { who, until: Date.now() + 10 * 60000 });
  if (gTokCache.size > 2000) gTokCache.clear();
  return who;
}

/* 預約整包很大，抽獎只需要「今天」的，快取一分鐘 */
let gBkCache = { at: 0, data: null };
async function gBookings() {
  if (gBkCache.data && Date.now() - gBkCache.at < 60000) return gBkCache.data;
  gBkCache = { at: Date.now(), data: (await fbGet("bookings")) || {} };
  return gBkCache.data;
}

/* 跟後台 bkBuildIndex 同一個定義：手上還有點數、堂數，
   或沒過期、數量大於 0 的票券（扭蛋送的票券不算） */
function gIsMember(m) {
  if (!m) return false;
  const c = m.cache || {};
  if (Number(c.points) > 0 || Number(c.sessions) > 0) return true;
  const today = gDay();
  let t = m.tickets || [];
  if (!Array.isArray(t)) t = Object.values(t);
  return t.some((x) => x && x.src !== "gacha" && Number(x.qty) > 0 &&
    !(x.expiry && String(x.expiry).replace(/\//g, "-") < today));
}

/* 今天有幾次機會、每一次是因為什麼 */
async function gChances(cfg, phone, uid, day, p, m) {
  const today = gDay(), todaySlash = todayStr();
  const reasons = [{ why: "daily", label: "每日一次" }];
  /* 登錄禮（10/1–10/14）：第一次登錄電話的人送 1 次，會員必中、新朋友一般；
     放在第 2 格，用掉那天記在 players.welcome，當天整天都還在（次數才不會亂掉），隔天起就沒有了 */
  const wEnd = cfg.welcomeEnd || "2026-10-14";
  if (p && today <= wEnd && (!p.welcome || p.welcome === today)) {
    const mem = gIsMember(m);
    reasons.push(mem ? { why: "welcome", label: "會員登錄禮（必中）", sure: true } : { why: "welcome", label: "新朋友登錄禮" });
  }
  const all = await gBookings();
  let cls = false, book = false;
  for (const k in all) {
    const b = all[k];
    if (!b || b.status === "cancelled" || !ownsBooking(b, phone, uid)) continue;
    if (b.date === todaySlash && (b.checkout || b.attend === "in")) cls = true;
    if (b.source === "web" && b.ts) {
      const t = new Date(new Date(b.ts).getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10);
      if (t === today) book = true;
    }
  }
  if (cls) reasons.push({ why: "class", label: "今天有來上課", sure: true });
  if (book) reasons.push({ why: "book", label: "今天線上預約" });
  const gm = cfg.games || {};
  if (gm.quiz && day && day.quiz && day.quiz.ok) reasons.push({ why: "quiz", label: "答對今日問答" });
  if (gm.memory && day && day.memory) reasons.push({ why: "memory", label: "翻牌過關" });
  if (day && day.dupeX) reasons.push({ why: "dupe", label: "重複公仔換 1 次" });
  if ((cfg.doubleDays || []).includes(today)) reasons.push({ why: "double", label: cfg.doubleLabel || "加碼日", sure: true });
  return reasons.slice(0, Math.max(1, Number(cfg.maxDaily) || 5));
}

function gPublicPrizes(cfg, stock) {
  return cfg.prizes.map((p) => ({
    id: p.id, ic: p.ic, nm: p.nm, sub: p.sub || "", who: p.who, type: p.type,
    left: p.qty != null ? Math.max(0, p.qty - (Number(stock[p.id]) || 0)) : null,
  }));
}

/* 扭蛋綁的電話順便寫回會員檔案（2026-10-01）。
   後台登記預約要推通知，看的是 members/{phone}/lineUserId；以前扭蛋只記在
   gacha/bind，家長綁了電話、後台約課還是收不到通知，活動的目的就落空了。
   跟 /liff/member 同一套規矩：會員檔案已經綁了別的 LINE 就不動、
   沒有這個會員也不新建。同一個 LINE 這次開機後只檢查一次。 */
const gLinked = new Set();
async function gLinkMember(uid, phone) {
  if (!uid || !phone || gLinked.has(uid)) return;
  gLinked.add(uid);
  try {
    const idx = await fbGet(`lineIndex/${uid}`);
    if (!idx) await fbPut(`lineIndex/${uid}`, phone);
    const m = await fbGet(`members/${phone}`);
    if (m && !m.lineUserId) await fbPatch(`members/${phone}`, { lineUserId: uid });
  } catch (e) {
    gLinked.delete(uid);
    console.error("gLinkMember", e.message);
  }
}

/* 找出這個 LINE 帳號綁的電話；還沒綁的話，身上帶了電話就綁上去 */
async function gResolvePhone(who, body) {
  if (who.kiosk) return { phone: KIOSK_PHONE };
  let phone = await fbGet(`gacha/bind/${who.uid}`);
  if (typeof phone === "string" && gValidPhone(phone)) { gLinkMember(who.uid, phone); return { phone }; }
  const want = normPhone(body.phone || "");
  if (!want) {
    /* 預約頁以前記過的電話，拿來預先填好 */
    let guess = "";
    const idx = await fbGet(`lineIndex/${who.uid}`);
    if (typeof idx === "string" && gValidPhone(idx)) guess = idx;
    return { phone: "", guess };
  }
  if (!gValidPhone(want)) throw Object.assign(new Error("手機號碼格式不對，請輸入 09 開頭的 10 碼"), { code: "BAD_PHONE" });
  const pl = await fbGet(`gacha/players/${want}`);
  if (pl && pl.uid && pl.uid !== who.uid) {
    throw Object.assign(new Error("這支電話已經被另一個 LINE 帳號用來玩過了。如果是你本人，請私訊小編幫你處理"), { code: "PHONE_TAKEN" });
  }
  const name = String(body.name || "").trim().slice(0, 20);
  await fbPut(`gacha/bind/${who.uid}`, want);
  await fbPatch(`gacha/players/${want}`, {
    uid: who.uid,
    name: name || (pl && pl.name) || who.displayName || "",
    lineName: who.displayName || "",
    first: (pl && pl.first) || new Date().toISOString(),
  });
  gLinkMember(who.uid, want);
  return { phone: want };
}

/* ── 活動開始前的測試模式 ──
   員工名單裡的人（後台登入用的 LINE 跟預約頁是同一個身分）和後台設定的測試電話，
   活動開始前可以無限次玩，但一律「不入帳」：紅利、票券不寫進會員資料，
   限量獎品也不扣庫存。玩的紀錄放在 gacha/testplayers，跟正式的 gacha/players 分開，
   活動一開始就自動改讀正式的，測試資料不會影響任何人的上限或集章。
   每轉一次就當成集滿一天，方便測到 7、14、21、28 天的保底。 */
const gStaffCache = new Map();
async function gIsStaff(uid) {
  const hit = gStaffCache.get(uid);
  if (hit && hit.until > Date.now()) return hit.v;
  let v = false;
  try { const st = await staffGet(`staff/${encodeURIComponent(uid)}`); v = !!(st && st.active !== false); } catch (e) {}
  gStaffCache.set(uid, { v, until: Date.now() + 5 * 60000 });
  return v;
}
async function gSim(cfg, phone, uid) {
  if (uid === "kiosk" && phone === KIOSK_PHONE) return true;
  const today = gDay();
  if (today < cfg.start) return (cfg.testPhones || []).includes(phone) || (await gIsStaff(uid));
  if (today > cfg.end) return false;
  /* 活動期間的「示範模式」：老師示範用，無限次、不入帳（跟開始前的測試模式同一套）。
     後台設定的示範電話，加上 demoStaff 打開時員工名單裡的人 */
  return (cfg.demoPhones || []).includes(phone) || (cfg.demoStaff !== false && (await gIsStaff(uid)));
}
const gShiftDay = (d, n) => { const t = new Date(d + "T00:00:00Z"); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const fbDel = (path) => fetch(fbUrl(path), { method: "DELETE" });

async function gState(cfg, who, phone) {
  const sim = await gSim(cfg, phone, who.uid);
  const [pl, m, stock, logs] = await Promise.all([
    fbGet(`gacha/${sim ? "testplayers" : "players"}/${phone}`),
    fbGet(`members/${phone}`),
    fbGet("gacha/stock"),
    fbGet("gacha/log", { orderBy: '"$key"', limitToLast: "40" }),
  ]);
  const p = pl || {};
  const today = gDay();
  const day = (p.days || {})[today] || {};
  const reasons = sim ? [{ why: "test", label: gDay() < cfg.start ? "測試模式" : "示範模式" }] : await gChances(cfg, phone, who.uid, day, p, m);
  const used = sim ? Number(p.spins) || 0 : Number(day.n) || 0;
  const c = (m && m.cache) || {};
  const gm = cfg.games || {};
  let quiz = null;
  if (gm.quiz) {
    const list = await gQuizList();
    const dq = sim ? null : day.quiz;
    const qi = dq ? dq.qi % list.length : gQuizIndex(list, phone, today, sim ? new Set() : gAsked(p, today), sim ? p.quizN : 0);
    const S = gQuizShow(list[qi], qi);
    quiz = { q: S.q, o: S.o, lv: S.lv, answered: !!dq };
    if (dq) Object.assign(quiz, { ok: !!dq.ok, c: dq.c, a: S.a, t: S.t });
  }
  const newOnly = new Set(cfg.prizes.filter((x) => x.who === "new").map((x) => x.id));
  const ticker = Object.values(logs || {})
    .filter((l) => l && l.type !== "none" && !l.test && !newOnly.has(l.pid))
    .sort((a, b) => String(b.at).localeCompare(String(a.at)))
    .slice(0, 12)
    .map((l) => ({ who: gMask(l.name), nm: l.nm, ic: l.ic, at: l.at }));
  return {
    title: cfg.title, start: cfg.start, end: cfg.end, today, expiry: cfg.expiry, sim,
    cap: gIsMember(m) ? cfg.cap : (cfg.capNew != null ? Number(cfg.capNew) : cfg.cap),
    status: today < cfg.start ? (sim ? "test" : "soon") : today > cfg.end ? "ended" : "on",
    me: {
      name: p.name || (m && m.name) || who.displayName || "",
      phone: phone.slice(0, 4) + "-***-" + phone.slice(7),
      member: gIsMember(m),
      points: Number(c.points) || 0, sessions: Number(c.sessions) || 0,
      bonus: (Number(c.bonus) || 0) + (sim ? (Number(p.bonus) || 0) + (Number(p.msBonus) || 0) : 0),
      gotBonus: Number(p.bonus) || 0, lottery: Number(p.lottery) || 0,
    },
    chances: sim ? { total: used + 1, used, reasons: Array(used + 1).fill(reasons[0]) } : { total: reasons.length, used, reasons },
    days: Object.keys(p.days || {}).filter((d) => d >= cfg.start && d <= cfg.end),
    milestones: (cfg.milestones || []).map((x) => ({ d: x.d, nm: x.nm, got: !!(p.ms || {})[x.d] })),
    prizes: gPublicPrizes(cfg, stock || {}),
    ticker,
    doubleToday: (cfg.doubleDays || []).includes(today),
    doubleLabel: cfg.doubleLabel || "加碼日",
    halloween: (cfg.halloweenDays || []).includes(today),
    quiz,
    memory: gm.memory ? { done: !sim && !!day.memory } : null,
    bears: gm.collect ? {
      list: (cfg.bears || []).map((b) => ({ id: b.id, nm: b.nm, rare: !!b.rare, hidden: !!b.hidden })),
      title: cfg.bearTitle || "", unit: cfg.bearUnit || "", img: cfg.bearImg || "",
      have: p.bears || {}, dupes: Number(p.dupes) || 0, done: !!p.collected, reward: (cfg.collectReward || {}).nm || "",
      limit: Number(cfg.collectLimit) || 0,
      left: Number(cfg.collectLimit) ? Math.max(0, Number(cfg.collectLimit) - (Number((stock || {}).collect) || 0)) : null,
    } : null,
    bonusToday: Number((p.bday || {})[today]) || 0, maxDaily: Number(cfg.maxDaily) || 5,
    bonusDaily: gIsMember(m) ? Number(cfg.bonusDaily) || 2 : (cfg.bonusDailyNew != null ? Number(cfg.bonusDailyNew) : 1),
  };
}

/* 紅利寫進會員明細，順便重算餘額（跟後台 mbSum 同一個算法） */
async function gAddBonus(phone, name, v, reason) {
  await gEnsureMember(phone, name);
  const key = `gacha_${gDay()}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  await fbPut(`members/${phone}/ledger/${key}`, {
    at: new Date().toISOString(), by: "扭蛋活動", delta: v, type: "bonus", reason, src: "gacha",
  });
  const l = (await fbGet(`members/${phone}/ledger`)) || {};
  const sum = { points: 0, sessions: 0, bonus: 0, voucher: 0 };
  for (const k in l) {
    const r = l[k]; if (!r) continue;
    const d = Number(r.delta) || 0;
    if (r.type in sum) sum[r.type] += d;
  }
  await fbPut(`members/${phone}/cache`, sum);
}
async function gAddTicket(phone, name, t, cfg, gid) {
  await gEnsureMember(phone, name);
  let list = (await fbGet(`members/${phone}/tickets`)) || [];
  if (!Array.isArray(list)) list = Object.values(list);
  list.push({
    name: t.nm, qty: 1, expiry: cfg.expiry, kind: t.kind || "other",
    raw: `${cfg.title}・${t.nm}`, batch: "gacha-" + cfg.start.slice(0, 7),
    at: new Date().toISOString(), by: "扭蛋活動", src: "gacha", gid,
  });
  await fbPut(`members/${phone}/tickets`, list);
}
/* 從來沒建檔的新客，幫他建一筆（沒有任何方案，後台還是顯示新客） */
async function gEnsureMember(phone, name) {
  const m = await fbGet(`members/${phone}`, { shallow: "true" });
  if (m) return;
  /* 新建檔時順手掛上玩扭蛋的 LINE（2026-10-04）。以前只在「會員檔已存在」時綁，
     第一次來的新客輸入電話當下還沒有會員檔，等抽到東西才建檔，LINE 就漏掉了。 */
  const pl = await fbGet(`gacha/players/${phone}`);
  const rec = {
    phone, name: name || "", createdAt: new Date().toISOString(),
    cache: { points: 0, sessions: 0, bonus: 0 }, source: "gacha", note: "扭蛋活動自動建立",
  };
  if (pl && pl.uid) rec.lineUserId = pl.uid;
  await fbPut(`members/${phone}`, rec);
}

function gPick(pool) {
  const tot = pool.reduce((a, b) => a + (Number(b.w) || 0), 0);
  let r = Math.random() * tot;
  for (const x of pool) { if ((r -= Number(x.w) || 0) < 0) return x; }
  return pool[pool.length - 1];
}

function gErr(res, e) {
  const code = e.code || "";
  if (!code) console.error("扭蛋失敗：", e);
  res.status(code ? 400 : 500).json({ ok: false, error: e.message, code });
}

/* 公開的活動狀態（沒有個資）：給遊樂島顯示「幾號開始」、也方便確認後台設定有沒有生效 */
app.get("/gacha/info", async (req, res) => {
  try {
    const cfg = await gConfig(), today = gDay();
    res.json({ ok: true, today, start: cfg.start, end: cfg.end, title: cfg.title,
      status: today < cfg.start ? "soon" : today > cfg.end ? "ended" : "on",
      bears: (cfg.bears || []).length, img: cfg.bearImg || "", migr: !!cfg.migrPicasso1001, reset: String(cfg.migrReset1001 || "").split(" ")[0], reset2: String(cfg.migrReset1001b || "").split(" ")[0] });
  } catch (e) { gErr(res, e); }
});

app.post("/gacha/state", async (req, res) => {
  try {
    const body = req.body || {};
    const who = await gWho(body.accessToken, true);
    const cfg = await gConfig();
    const r = await gResolvePhone(who, body);
    if (!r.phone) return res.json({ ok: true, needPhone: true, guess: r.guess || "", lineName: who.displayName, title: cfg.title, start: cfg.start, end: cfg.end });
    res.json({ ok: true, ...(await gState(cfg, who, r.phone)) });
  } catch (e) { gErr(res, e); }
});

app.post("/gacha/spin", async (req, res) => {
  try {
    const who = await gWho((req.body || {}).accessToken, true);
    const out = await gSerial(async () => {
      const cfg = await gConfig();
      const phone = await gBound(who);
      if (typeof phone !== "string" || !gValidPhone(phone)) throw Object.assign(new Error("請先輸入電話"), { code: "NEED_PHONE" });
      const today = gDay();
      const sim = await gSim(cfg, phone, who.uid);
      const base = sim ? "gacha/testplayers" : "gacha/players";
      if (today > cfg.end) throw Object.assign(new Error("活動已經結束囉，謝謝你的參與！"), { code: "ENDED" });
      if (today < cfg.start && !sim) throw Object.assign(new Error(`活動 ${cfg.start.slice(5).replace("-", "/")} 才開始喔`), { code: "SOON" });

      const [pl, m, stock] = await Promise.all([
        fbGet(`${base}/${phone}`), fbGet(`members/${phone}`), fbGet("gacha/stock"),
      ]);
      let p = pl || {};
      /* 店內體驗平板大家輪流玩：轉滿 30 次（圖鑑、集章都跑完了）就清空重來 */
      if (who.kiosk && (Number(p.spins) || 0) >= 30) { await fbDel(`${base}/${phone}`); p = {}; }
      const reasons = sim ? [{ why: "test", label: gDay() < cfg.start ? "測試模式" : "示範模式" }] : await gChances(cfg, phone, who.uid, (p.days || {})[today], p, m);
      const used = sim ? Number(p.spins) || 0 : Number((p.days || {})[today]?.n) || 0;
      if (!sim && used >= reasons.length) throw Object.assign(new Error("今天的機會用完了，明天再來轉！"), { code: "NO_CHANCE" });
      const reason = sim ? reasons[0] : reasons[used];
      const sure = !!reason.sure || (cfg.doubleDays || []).includes(today);
      const member = gIsMember(m);
      const won = p.won || {};
      const st = stock || {};

      let pool = cfg.prizes.filter((x) =>
        (x.who === "all" || x.who === (member ? "mem" : "new")) &&
        (x.qty == null || (Number(st[x.id]) || 0) < x.qty) &&
        (x.per == null || (Number(won[x.id]) || 0) < x.per) &&
        (!x.grp || !cfg.prizes.some((y) => y.grp === x.grp && (Number(won[y.id]) || 0) > 0)) &&
        (Number(x.w) || 0) > 0);
      /* 一天最多中 bonusDaily 次紅利：中滿之後，紅利那幾格改成「送一隻造型小黑熊」，機率不變 */
      const bToday = Number((p.bday || {})[today]) || 0;
      const bMax = member ? Number(cfg.bonusDaily) || 2 : (cfg.bonusDailyNew != null ? Number(cfg.bonusDailyNew) : 1);
      if (bToday >= bMax) {
        const bw = pool.filter((x) => x.type === "bonus").reduce((a, x) => a + (Number(x.w) || 0), 0);
        pool = pool.filter((x) => x.type !== "bonus");
        if (bw > 0 && (cfg.games || {}).collect) pool.push({ id: "bearonly", ic: "🐻", nm: cfg.bearUnit || "造型小黑熊", sub: "", type: "bear", w: bw });
      }
      if (sure) pool = pool.filter((x) => x.type !== "none");
      if (!pool.length) pool = cfg.prizes.filter((x) => x.type === "none");
      const hit = gPick(pool);
      const name = p.name || (m && m.name) || who.displayName || "";

      /* 紅利領滿上限之後，改送月底大抽獎券 */
      let prize = { id: hit.id, ic: hit.ic, nm: hit.nm, sub: hit.sub || "", type: hit.type, v: hit.v || 0 };
      const gotBonus = Number(p.bonus) || 0;
      if (hit.type === "bonus") {
        const room = (member ? cfg.cap : (cfg.capNew != null ? Number(cfg.capNew) : cfg.cap)) - gotBonus;
        if (room <= 0) prize = { id: "lottery", ic: "🎫", nm: cfg.lotteryName, sub: "紅利已經領滿，改送抽獎券", type: "lottery", v: 0 };
        else if (hit.v > room) prize = { ...prize, v: room, nm: `紅利 ${room} 點` };
      }

      /* 黑熊圖鑑：每轉一次另外送一隻造型小黑熊，萬聖節當天南瓜熊比較容易出現 */
      const patch = {};
      let bear = null, collect = null;
      const bearList = (cfg.games || {}).collect && Array.isArray(cfg.bears) ? cfg.bears : [];
      if (bearList.length) {
        const hw = (cfg.halloweenDays || []).includes(today);
        /* boostDays 那幾天（例如 10/25），boostBear 那一款機率乘 boostX */
        const boost = (cfg.boostDays || []).includes(today) ? cfg.boostBear : null;
        const b = gPick(bearList.map((x) => ({ ...x, w: (Number(x.w) || 0) * (hw && x.id === "pumpkin" ? 3 : 1) * (boost && x.id === boost ? (Number(cfg.boostX) || 2) : 1) })));
        const have = p.bears || {};
        bear = { id: b.id, nm: b.nm, rare: !!b.rare, hidden: !!b.hidden, isNew: !(Number(have[b.id]) > 0) };
        patch[`bears/${b.id}`] = (Number(have[b.id]) || 0) + 1;
        /* 重複的公仔湊滿 3 隻，自動換 1 次扭蛋（每天最多換 1 次），家長不用另外操作 */
        if (have[b.id] > 0) {
          const dupes = (Number(p.dupes) || 0) + 1;
          const dayKey = sim ? gShiftDay(cfg.start, Object.keys(p.days || {}).length) : today;
          if (dupes >= 3 && !((p.days || {})[dayKey] || {}).dupeX) { patch.dupes = dupes - 3; patch[`days/${dayKey}/dupeX`] = true; bear && (bear.swap = true) }
          else patch.dupes = dupes;
        }
        const owned = new Set(Object.keys(have).filter((k) => Number(have[k]) > 0).concat(b.id));
        /* 隱藏版不算在集滿條件裡 */
        const regular = bearList.filter((x) => !x.hidden);
        if (!p.collected && regular.every((x) => owned.has(x.id))) {
          collect = { ...(cfg.collectReward || { type: "ticket", kind: "goods", nm: "圖鑑集滿禮" }) };
          patch.collected = true;
          /* 集滿禮限量：送完之後一樣算集滿，只是不送東西（測試模式不扣名額） */
          const lim = Number(cfg.collectLimit) || 0;
          const used2 = Number(st.collect) || 0;
          if (lim && used2 >= lim) collect.soldOut = true;
          else if (!sim) await fbPut("gacha/stock/collect", used2 + 1);
        }
        bear.count = regular.filter((x) => owned.has(x.id)).length; bear.total = regular.length;
      }

      const logRef = await fbPost("gacha/log", {
        at: new Date().toISOString(), date: today, phone, name, uid: who.uid,
        pid: prize.id, nm: prize.nm, ic: prize.ic, type: prize.type, v: prize.v, why: reason.why,
        bear: bear ? bear.id : undefined,
        test: (sim || today < cfg.start) || undefined, sim: sim || undefined,
      });
      const gid = logRef && logRef.name;

      if (collect && !collect.soldOut) {
        if (!sim) {
          if (collect.type === "bonus") await gAddBonus(phone, name, Number(collect.v) || 0, `${cfg.title}・圖鑑集滿`);
          else await gAddTicket(phone, name, collect, cfg, gid + "-col");
        }
        await fbPost("gacha/log", {
          at: new Date().toISOString(), date: today, phone, name, uid: who.uid,
          pid: "collect", nm: `圖鑑集滿・${collect.nm}`, ic: "📖", type: collect.type || "ticket", v: Number(collect.v) || 0, why: "collect",
          test: (sim || today < cfg.start) || undefined, sim: sim || undefined,
        });
      }

      if (prize.type === "bonus") {
        if (!sim) await gAddBonus(phone, name, prize.v, `${cfg.title}・紅利 ${prize.v} 點`);
        patch.bonus = gotBonus + prize.v;
        patch[`bday/${today}`] = bToday + 1;
      } else if (prize.type === "ticket") {
        if (!sim) await gAddTicket(phone, name, hit, cfg, gid);
      } else if (prize.type === "lottery") {
        patch.lottery = (Number(p.lottery) || 0) + 1;
      }
      if (prize.type !== "lottery" && prize.type !== "bear" && prize.id !== "none") {
        patch[`won/${prize.id}`] = (Number(won[prize.id]) || 0) + 1;
      }
      if (!sim && hit.qty != null && prize.type !== "lottery") {
        await fbPut(`gacha/stock/${hit.id}`, (Number(st[hit.id]) || 0) + 1);
      }
      /* 測試模式每轉一次就當成多集一天，從活動第一天往後蓋章 */
      const simDays = Object.keys(p.days || {}).length;
      if (sim) { patch.spins = used + 1; patch[`days/${gShiftDay(cfg.start, simDays)}/n`] = 1; }
      else patch[`days/${today}/n`] = used + 1;
      /* 轉到登錄禮那一格（或更後面）就算用掉了；今天剛開始送的時候已經轉過好幾次的人也一樣 */
      const wi = reasons.findIndex((r) => r.why === "welcome");
      if (!sim && wi >= 0 && used >= wi && !p.welcome) patch.welcome = today;

      /* 集章：今天第一次玩才算新的一天，達標就發保底（不佔紅利上限） */
      let milestone = null;
      if (sim || used === 0) {
        const days = sim ? simDays + 1
          : Object.keys(p.days || {}).filter((d) => d >= cfg.start && d <= cfg.end && d !== today).length + 1;
        const ms = (cfg.milestones || []).find((x) => x.d === days && !(p.ms || {})[x.d]);
        if (ms) {
          milestone = { d: ms.d, nm: ms.nm, type: ms.type };
          if (sim) { if (ms.type === "bonus") patch.msBonus = (Number(p.msBonus) || 0) + (Number(ms.v) || 0); }
          else if (ms.type === "bonus") await gAddBonus(phone, name, Number(ms.v) || 0, `${cfg.title}・集章 ${ms.d} 天`);
          else await gAddTicket(phone, name, ms, cfg, gid + "-ms");
          patch[`ms/${ms.d}`] = true;
          await fbPost("gacha/log", {
            at: new Date().toISOString(), date: today, phone, name, uid: who.uid,
            pid: "ms" + ms.d, nm: `集章 ${ms.d} 天・${ms.nm}`, ic: "🏅", type: ms.type, v: Number(ms.v) || 0, why: "milestone",
            test: (sim || today < cfg.start) || undefined, sim: sim || undefined,
          });
        }
      }
      await fbPatch(`${base}/${phone}`, patch);
      return { prize, milestone, bear, collect, sure, why: reason.why, gid, cfg, phone };
    });
    const state = await gState(out.cfg, who, out.phone);
    res.json({ ok: true, prize: out.prize, milestone: out.milestone, bear: out.bear, collect: out.collect, sure: out.sure, why: out.why, state });
  } catch (e) { gErr(res, e); }
});


/* ══ 扭蛋第二波：藝術小問答、翻牌配對、黑熊圖鑑、萬聖節造型（2026-09-30）══
   - 小問答：每天一題（每個人同一題），答對當天多一次扭蛋，一天只能答一次
   - 翻牌配對：60 秒內配完 6 對，當天多一次扭蛋，一天只算一次
     （過關是網頁自己回報的，改得到網頁的人可以直接拿這一次，最多也就每天一次，可以接受）
   - 黑熊圖鑑：每轉一次扭蛋，另外隨機得到一隻造型小黑熊，集滿全部送圖鑑禮（不佔紅利上限）
   - 萬聖節造型：halloweenDays 那幾天扭蛋機換裝，南瓜熊比較容易出現 */
Object.assign(GACHA_DEFAULT, {
  games: { quiz: true, memory: true, collect: true },
  halloweenDays: [],
  bears: [
    { id: "paint",   nm: "繪畫熊", w: 20 },
    { id: "sketch",  nm: "素描熊", w: 20 },
    { id: "pour",    nm: "流動熊", w: 20 },
    { id: "yarn",    nm: "毛線熊", w: 20 },
    { id: "crystal", nm: "水晶熊", w: 15 },
    { id: "aroma",   nm: "擴香熊", w: 15 },
    { id: "picasso", nm: "畢卡索熊", w: 6, rare: true },
    { id: "gold",    nm: "金色熊", w: 4, rare: true },
  ],
  collectReward: { type: "ticket", kind: "goods", nm: "23cm 流動熊（圖鑑集滿禮）" },
  collectLimit: 5,   /* 圖鑑集滿禮只送前幾位 */
  capNew: 15,        /* 新朋友整個活動期間，扭蛋最多拿幾點紅利（會員是 cap） */
  bonusDailyNew: 1,  /* 新朋友一天最多中幾次紅利（會員是 bonusDaily） */
  maxDaily: 5,       /* 一天最多轉幾次（不管拿到幾種加碼） */
  bonusDaily: 2,     /* 一天最多中幾次紅利，超過改送造型小黑熊 */
});

/* 預設題庫。後台「小遊戲」分頁存過之後，就以 gacha/quiz 為準。
   a 是正確答案在 o 裡的位置（從 0 開始）。 */
const GACHA_QUIZ = [
  /* ── 簡單有趣（43 題）── */
  { lv: 1, q: "紅色加黃色，會變成什麼顏色？", o: ["綠色", "橙色", "紫色", "咖啡色"], a: 1, t: "紅和黃混在一起是橙色，像夕陽的顏色。" },
  { lv: 1, q: "藍色加黃色，會變成什麼顏色？", o: ["綠色", "紫色", "橙色", "灰色"], a: 0, t: "藍 + 黃 = 綠，畫草地樹葉就靠它。" },
  { lv: 1, q: "紅色加藍色，會變成什麼顏色？", o: ["橙色", "咖啡色", "紫色", "綠色"], a: 2, t: "紅 + 藍 = 紫，紅多一點偏紫紅，藍多一點偏藍紫。" },
  { lv: 1, q: "顏料的三原色是哪三個？", o: ["紅、綠、藍", "黑、白、灰", "橙、綠、紫", "紅、黃、藍"], a: 3, t: "紅黃藍是顏料的三原色，其他顏色幾乎都能用它們調出來。" },
  { lv: 1, q: "白色加上哪一個顏色，會變成粉紅色？", o: ["藍色", "黃色", "綠色", "紅色"], a: 3, t: "紅色加白色會變淡，就是粉紅色。" },
  { lv: 1, q: "黑色加白色，會變成什麼顏色？", o: ["咖啡色", "灰色", "藍色", "紫色"], a: 1, t: "黑白混合是灰色，白多一點就是淺灰。" },
  { lv: 1, q: "藍色加白色，會變成什麼顏色？", o: ["淺藍色", "深藍色", "綠色", "紫色"], a: 0, t: "加白色會讓顏色變淺、變亮，像天空的淺藍。" },
  { lv: 1, q: "下面哪一組是「冷色」？", o: ["紅色、橙色", "黃色、橙色", "藍色、綠色", "咖啡色、紅色"], a: 2, t: "藍色、綠色讓人想到水和森林，感覺比較涼，叫冷色。" },
  { lv: 1, q: "下面哪一組是「暖色」？", o: ["藍色、紫色", "紅色、橙色、黃色", "綠色、藍色", "黑色、灰色"], a: 1, t: "紅橙黃讓人想到太陽和火，感覺溫暖，叫暖色。" },
  { lv: 1, q: "紅、黃、藍三個顏色全部混在一起，最可能變成什麼顏色？", o: ["白色", "粉紅色", "深咖啡色", "亮綠色"], a: 2, t: "三原色全部混在一起會變得很深、很濁，接近深咖啡或黑色。" },
  { lv: 1, q: "一般說的彩虹有幾種顏色？", o: ["5 種", "6 種", "7 種", "8 種"], a: 2, t: "紅、橙、黃、綠、藍、靛、紫，一共七種。" },
  { lv: 1, q: "畫陰影的時候，通常會用比原本顏色更怎樣的顏色？", o: ["更深", "更淺", "更亮", "一模一樣"], a: 0, t: "陰影是光照不到的地方，所以要用比較深的顏色。" },
  { lv: 1, q: "一個顏色加越多白色，它的「明度」會怎樣？", o: ["越低", "不會變", "越高", "變成黑色"], a: 2, t: "明度就是明亮程度，加白變亮、加黑變暗。" },
  { lv: 1, q: "畫家用來調顏料的板子叫什麼？", o: ["調色盤", "畫架", "畫布", "洗筆筒"], a: 0, t: "調色盤可以把顏料擠在上面，慢慢調出想要的顏色。" },
  { lv: 1, q: "畫畫時用來撐住畫布或畫板的架子叫什麼？", o: ["書架", "畫架", "衣架", "腳架"], a: 1, t: "畫架可以讓畫布立起來，畫家站著或坐著都好畫。" },
  { lv: 1, q: "畫水彩時，主要用什麼把顏料調開？", o: ["油", "膠水", "水", "牛奶"], a: 2, t: "水彩顧名思義是用水調開，水越多顏色越淡越透明。" },
  { lv: 1, q: "想在畫布上畫很細的線，最適合用哪一種工具？", o: ["大平刷", "海綿", "細的圓頭畫筆", "滾筒"], a: 2, t: "細圓頭畫筆的筆尖小，適合畫細線和小細節。" },
  { lv: 1, q: "素描鉛筆上的「B」越多，代表什麼？", o: ["筆芯越軟、畫起來越黑", "筆芯越硬、越淡", "筆越長", "筆越貴"], a: 0, t: "B 代表黑（Black），6B 比 2B 軟、顏色更深；H 則是越硬越淡。" },
  { lv: 1, q: "畫素描時，橡皮擦除了擦掉錯誤，還可以用來做什麼？", o: ["加深陰影", "擦出亮的地方", "幫畫上色", "削鉛筆"], a: 1, t: "用橡皮擦輕輕擦，可以擦出反光、亮面，讓東西看起來更立體。" },
  { lv: 1, q: "蠟筆主要是用什麼做成的？", o: ["木頭", "蠟和色料", "石頭", "紙"], a: 1, t: "蠟筆是把色料和蠟混在一起做成的，所以畫起來滑滑的。" },
  { lv: 1, q: "畫筆用完之後，最好怎麼做？", o: ["直接丟著", "洗乾淨再晾乾", "泡在顏料裡", "放進冰箱"], a: 1, t: "畫筆洗乾淨、筆毛整理好再晾乾，才能用很久。" },
  { lv: 1, q: "用鉛筆先輕輕畫出大概的形狀，叫做什麼？", o: ["打草稿", "上色", "裱框", "簽名"], a: 0, t: "先打草稿抓好位置和比例，後面上色才不容易畫歪。" },
  { lv: 1, q: "壓克力顏料乾了以後，還容易用水洗掉嗎？", o: ["很容易", "很難洗掉", "會自己消失", "會變成水彩"], a: 1, t: "壓克力顏料乾了會形成一層防水的膜，沾到衣服要趁濕趕快洗。" },
  { lv: 1, q: "流動畫，是讓什麼顏料在畫布上流動出圖案？", o: ["蠟筆", "壓克力顏料", "粉彩", "墨汁"], a: 1, t: "流動畫用調稀的壓克力顏料，傾斜畫布讓顏色自己流出花紋。" },
  { lv: 1, q: "畫靜物時，「光從哪裡來」會影響什麼？", o: ["畫紙的大小", "物體的明暗和影子", "顏料會不會乾", "畫筆的長短"], a: 1, t: "光源決定哪裡亮、哪裡暗，影子會落在光的反方向。" },
  { lv: 1, q: "「自畫像」畫的是誰？", o: ["畫家的朋友", "畫家自己", "國王", "陌生人"], a: 1, t: "自畫像就是畫家畫自己，梵谷就畫過很多幅自畫像。" },
  { lv: 1, q: "「靜物畫」通常畫什麼？", o: ["奔跑的動物", "水果、花瓶這類不會動的東西", "下雨的街道", "運動比賽"], a: 1, t: "靜物畫的主角是擺好不動的東西，最適合練習觀察光影。" },
  { lv: 1, q: "「風景畫」主要畫什麼？", o: ["山、海、田野等景色", "人的臉", "卡通人物", "數學題目"], a: 0, t: "風景畫描繪大自然或城市的景色，莫內就很愛畫戶外風景。" },
  { lv: 1, q: "「抽象畫」有什麼特色？", o: ["一定要畫得跟照片一樣", "只能用黑白色", "不一定畫出真實東西，用顏色線條表達感覺", "只能畫動物"], a: 2, t: "抽象畫不追求像不像，而是用色彩、線條、形狀傳達感受。" },
  { lv: 1, q: "雕塑和繪畫最大的不同是什麼？", o: ["雕塑是立體的", "雕塑一定是紅色的", "雕塑只能放在水裡", "雕塑不能摸"], a: 0, t: "繪畫是平面的，雕塑有長、寬、高，可以繞著它看。" },
  { lv: 1, q: "陶土作品放進窯裡用高溫燒，是為了什麼？", o: ["讓它變硬、變堅固", "讓它變軟", "讓它變香", "讓它變輕"], a: 0, t: "高溫燒製會讓陶土變硬，才能拿來裝東西、長久保存。" },
  { lv: 1, q: "「拼貼」是什麼樣的創作方式？", o: ["只用鉛筆畫", "把紙、布等材料剪貼組合成作品", "用手指沾顏料畫", "用黏土捏"], a: 1, t: "拼貼可以用報紙、包裝紙、布料，組合出很有層次的作品。" },
  { lv: 1, q: "版畫是怎麼做出來的？", o: ["直接在牆上畫", "先在版上做出圖案，再把顏料印到紙上", "用相機拍", "用黏土捏"], a: 1, t: "版畫做好一塊版，就能印出好幾張一樣的作品。" },
  { lv: 1, q: "漫畫裡一格一格的框，是用來做什麼的？", o: ["裝飾用", "把故事分成一幕一幕", "讓紙變硬", "寫作者名字"], a: 1, t: "分格就像電影鏡頭，讓讀者照順序看懂故事。" },
  { lv: 1, q: "想把畫畫在衣服上，最適合用哪一種顏料？", o: ["水彩", "布料專用顏料", "粉筆", "鉛筆"], a: 1, t: "布用顏料乾了之後比較耐洗，衣服洗了圖案也不容易掉。" },
  { lv: 1, q: "《星夜》是哪一位畫家的作品？", o: ["梵谷", "莫內", "畢卡索", "達文西"], a: 0, t: "梵谷在 1889 年畫了《星夜》，旋轉的星空超有名。" },
  { lv: 1, q: "《蒙娜麗莎》是誰畫的？", o: ["米開朗基羅", "達文西", "拉斐爾", "梵谷"], a: 1, t: "達文西畫的《蒙娜麗莎》，現在收藏在法國羅浮宮。" },
  { lv: 1, q: "梵谷畫過好幾幅很有名的哪一種花？", o: ["玫瑰", "鬱金香", "向日葵", "櫻花"], a: 2, t: "梵谷的《向日葵》系列有好幾幅，黃色用得超大膽。" },
  { lv: 1, q: "莫內畫了很多幅的系列作品，主角是什麼？", o: ["睡蓮", "向日葵", "馬", "高山"], a: 0, t: "莫內在自家花園的池塘畫了兩百多幅睡蓮。" },
  { lv: 1, q: "《吶喊》是哪一位畫家的作品？", o: ["梵谷", "孟克", "莫內", "塞尚"], a: 1, t: "孟克畫的《吶喊》，扭曲的天空表現出強烈的不安。" },
  { lv: 1, q: "草間彌生最有名的圖案是什麼？", o: ["條紋", "圓點", "格子", "愛心"], a: 1, t: "日本藝術家草間彌生最愛圓點，南瓜上也滿滿都是點點。" },
  { lv: 1, q: "有名的「羅浮宮」博物館在哪個城市？", o: ["倫敦", "紐約", "羅馬", "巴黎"], a: 3, t: "羅浮宮在法國巴黎，門口有一座玻璃金字塔。" },
  { lv: 1, q: "國立故宮博物院在哪一個城市？", o: ["台北", "台中", "台南", "高雄"], a: 0, t: "故宮在台北士林，嘉義還有一座南部院區。" },

  /* ── 中等（13 題）── */
  { lv: 2, q: "在色相環上，紅色的「互補色」是什麼？", o: ["綠色", "橙色", "粉紅色", "黃色"], a: 0, t: "互補色在色相環上正對面，紅配綠放在一起特別顯眼。" },
  { lv: 2, q: "黃色的互補色是什麼？", o: ["橙色", "藍綠色", "紅色", "紫色"], a: 3, t: "黃和紫是互補色，放在一起會讓兩個顏色都更亮。" },
  { lv: 2, q: "畢卡索跟哪一個畫派最有關係？", o: ["印象派", "立體派", "浪漫派", "寫實派"], a: 1, t: "畢卡索和布拉克一起開創了立體派，把東西拆成很多面來畫。" },
  { lv: 2, q: "「印象派」這個名字，來自哪一幅畫？", o: ["《星夜》", "《吶喊》", "《蒙娜麗莎》", "《印象・日出》"], a: 3, t: "莫內的《印象・日出》被評論家拿來取笑，結果變成畫派的名字。" },
  { lv: 2, q: "《戴珍珠耳環的少女》是誰畫的？", o: ["林布蘭", "達文西", "維梅爾", "雷諾瓦"], a: 2, t: "荷蘭畫家維梅爾的作品，少女回頭的眼神超經典。" },
  { lv: 2, q: "用許多小色點組成畫面的「點描法」，代表畫家是誰？", o: ["秀拉", "梵谷", "莫內", "塞尚"], a: 0, t: "秀拉的《大碗島的星期天下午》整幅畫都是用小點點出來的。" },
  { lv: 2, q: "《最後的晚餐》是哪一位畫家的作品？", o: ["米開朗基羅", "拉斐爾", "達文西", "波提切利"], a: 2, t: "達文西把《最後的晚餐》畫在義大利米蘭一間修道院的牆上。" },
  { lv: 2, q: "梵蒂岡西斯汀禮拜堂的天花板壁畫，是誰畫的？", o: ["達文西", "米開朗基羅", "林布蘭", "莫內"], a: 1, t: "米開朗基羅花了大約四年，仰著頭畫完整片天花板。" },
  { lv: 2, q: "莫內是哪一國的畫家？", o: ["義大利", "西班牙", "法國", "荷蘭"], a: 2, t: "莫內是法國印象派最重要的畫家之一。" },
  { lv: 2, q: "梵谷是哪一國人？", o: ["荷蘭", "法國", "德國", "比利時"], a: 0, t: "梵谷出生在荷蘭，後來在法國畫出很多代表作。" },
  { lv: 2, q: "畫風景時，離我們越遠的東西，通常會畫得怎樣？", o: ["越大", "越小", "一樣大", "越紅"], a: 1, t: "這就是「透視」：近大遠小，畫面才會有深度。" },
  { lv: 2, q: "有名的浮世繪《神奈川沖浪裏》，來自哪一個國家？", o: ["中國", "韓國", "日本", "泰國"], a: 2, t: "日本畫家葛飾北齋的版畫，巨浪後面還有小小的富士山。" },
  { lv: 2, q: "傳統水墨畫最主要使用的顏料是什麼？", o: ["油彩", "墨", "壓克力", "蠟筆"], a: 1, t: "水墨畫用墨加水調出濃淡，一種顏色就能畫出層次。" },

  /* ── 有難度（3 題）── */
  { lv: 3, q: "畫《吶喊》的孟克，是哪一國人？", o: ["瑞典", "丹麥", "挪威", "芬蘭"], a: 2, t: "孟克是挪威畫家，《吶喊》畫了好幾個版本。" },
  { lv: 3, q: "常聽到的「黃金比例」，大約是多少？", o: ["1 : 1", "1 : 1.618", "1 : 2", "1 : 3.14"], a: 1, t: "黃金比例約 1 : 1.618，常被用在構圖和建築上。" },
  { lv: 3, q: "《夜巡》是哪一位荷蘭畫家的作品？", o: ["維梅爾", "梵谷", "林布蘭", "蒙德里安"], a: 2, t: "林布蘭擅長明暗對比，《夜巡》是他最大、最有名的畫之一。" },

  /* ── 超難（3 題）── */
  { lv: 4, q: "達文西的《蒙娜麗莎》，是畫在什麼材料上？", o: ["畫布", "白楊木板", "石牆", "銅板"], a: 1, t: "《蒙娜麗莎》畫在一塊白楊木板上，不是畫布喔！" },
  { lv: 4, q: "形容強烈明暗對比的美術名詞「Chiaroscuro」，原本是哪一國的語言？", o: ["法文", "德文", "西班牙文", "義大利文"], a: 3, t: "Chiaroscuro 是義大利文，chiaro 是亮、scuro 是暗。" },
  { lv: 4, q: "法國畫家塞尚，常被後人稱為什麼？", o: ["現代繪畫之父", "印象派之母", "立體派之王", "野獸派之父"], a: 0, t: "塞尚把物體看成圓柱、球體、圓錐，深深影響了畢卡索和後來的畫家。" },
  /* ── 畢卡索生日週（10/25 前後，pic: true 的題目優先出）── */
  { lv: 1, pic: true, q: "畢卡索的生日是哪一天？", o: ["10 月 25 日", "12 月 25 日", "7 月 4 日", "1 月 1 日"], a: 0, t: "畢卡索 1881 年 10 月 25 日出生，所以這天是我們的加碼日！" },
  { lv: 1, pic: true, q: "畢卡索是哪一國人？", o: ["法國", "義大利", "西班牙", "荷蘭"], a: 2, t: "畢卡索出生在西班牙的馬拉加，後來大半輩子住在法國。" },
  { lv: 1, pic: true, q: "立體派的畫，常常把臉畫成什麼樣子？", o: ["跟照片一模一樣", "同時看到正面和側面", "只畫輪廓不上色", "全部用圓點組成"], a: 1, t: "立體派把不同角度看到的樣子拼在同一張畫裡，所以會同時看到正面和側面。" },
  { lv: 2, pic: true, q: "畢卡索有一段時期幾乎都用藍色作畫，叫做什麼？", o: ["藍色時期", "海洋時期", "憂鬱派", "冷色派"], a: 0, t: "藍色時期大約在 1901–1904 年，之後還有溫暖的「玫瑰時期」。" },
  { lv: 2, pic: true, q: "跟畢卡索一起開創立體派的畫家是誰？", o: ["莫內", "布拉克", "達利", "梵谷"], a: 1, t: "畢卡索和布拉克一起發展出立體派，兩個人當時幾乎天天討論作品。" },
  { lv: 3, pic: true, q: "畢卡索為了抗議戰爭轟炸，畫了哪一幅巨大的黑白灰作品？", o: ["《格爾尼卡》", "《亞維農的少女》", "《哭泣的女人》", "《夢》"], a: 0, t: "《格爾尼卡》寬將近 8 公尺，只用黑、白、灰，現在收藏在西班牙馬德里。" },
];

async function gQuizList() {
  const q = await fbGet("gacha/quiz");
  const list = Array.isArray(q) ? q.filter((x) => x && x.q && Array.isArray(x.o)) : [];
  return list.length ? list : GACHA_QUIZ;
}
/* 隨機出題：每個人每天抽一題，抽過的題目不會再出現（62 題夠整個活動不重複）。
   用「電話＋日期」算出來的亂數，所以同一天重開頁面還是同一題。
   題庫裡難易度本來就是 70% 簡單、20% 中等、5% 難、5% 超難，均勻抽就會照這個比例出現。
   測試模式每答一題就換下一題。 */
function gHash(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
  return h;
}
function gQuizIndex(list, phone, day, asked, n) {
  let pool = [];
  for (let i = 0; i < list.length; i++) if (!asked.has(i)) pool.push(i);
  /* 畢卡索生日週（10/22～10/28）優先出畢卡索題目，出完了再回到一般題庫 */
  const md = String(day || "").slice(5);
  if (md >= "10-22" && md <= "10-28") { const pic = pool.filter((i) => list[i] && list[i].pic); if (pic.length) pool = pic; }
  const from = pool.length ? pool : list.map((_, i) => i);
  return from[gHash(`${phone}|${day}|${Number(n) || 0}`) % from.length];
}
/* 之前幾天答過的題號 */
function gAsked(p, today) {
  const set = new Set();
  for (const d in p.days || {}) if (d !== today && p.days[d] && p.days[d].quiz) set.add(Number(p.days[d].quiz.qi));
  return set;
}
/* 選項順序也打亂（每題固定一種順序），正確答案不會老是在同一個位置 */
function gQuizShow(Q, qi) {
  const idx = [0, 1, 2, 3];
  let seed = gHash("opt" + qi + Q.q);
  for (let i = 3; i > 0; i--) { seed = (seed * 1103515245 + 12345) >>> 0; const j = seed % (i + 1); [idx[i], idx[j]] = [idx[j], idx[i]]; }
  return { q: Q.q, o: idx.map((k) => Q.o[k]), a: idx.indexOf(Number(Q.a)), t: Q.t || "", lv: Number(Q.lv) || 1 };
}
function gOpen(cfg, sim) {
  const today = gDay();
  if (sim) return;
  if (today > cfg.end) throw Object.assign(new Error("活動已經結束囉，謝謝你的參與！"), { code: "ENDED" });
  if (today < cfg.start) throw Object.assign(new Error(`活動 ${cfg.start.slice(5).replace("-", "/")} 才開始喔`), { code: "SOON" });
}

app.post("/gacha/quiz", async (req, res) => {
  try {
    const who = await gWho((req.body || {}).accessToken, true);
    const out = await gSerial(async () => {
      const cfg = await gConfig();
      if (!(cfg.games || {}).quiz) throw Object.assign(new Error("小問答目前沒有開放"), { code: "OFF" });
      const phone = await gBound(who);
      if (typeof phone !== "string" || !gValidPhone(phone)) throw Object.assign(new Error("請先輸入電話"), { code: "NEED_PHONE" });
      const sim = await gSim(cfg, phone, who.uid);
      gOpen(cfg, sim);
      const base = sim ? "gacha/testplayers" : "gacha/players";
      const today = gDay();
      const [p0, list] = await Promise.all([fbGet(`${base}/${phone}`), gQuizList()]);
      const p = p0 || {};
      if (!sim && ((p.days || {})[today] || {}).quiz) throw Object.assign(new Error("今天已經答過囉，明天再來挑戰！"), { code: "DONE" });
      const qi = gQuizIndex(list, phone, today, sim ? new Set() : gAsked(p, today), sim ? p.quizN : 0);
      const Q = gQuizShow(list[qi], qi);
      const choice = Number((req.body || {}).choice);
      const correct = choice === Q.a;
      if (sim) await fbPatch(`${base}/${phone}`, { quizN: (Number(p.quizN) || 0) + 1 });
      else await fbPatch(`${base}/${phone}`, { [`days/${today}/quiz`]: { qi, c: choice, ok: correct } });
      return { correct, a: Number(Q.a), t: Q.t || "", cfg, phone };
    });
    const state = await gState(out.cfg, who, out.phone);
    res.json({ ok: true, correct: out.correct, a: out.a, t: out.t, state });
  } catch (e) { gErr(res, e); }
});

app.post("/gacha/memory", async (req, res) => {
  try {
    const who = await gWho((req.body || {}).accessToken, true);
    const out = await gSerial(async () => {
      const cfg = await gConfig();
      if (!(cfg.games || {}).memory) throw Object.assign(new Error("翻牌遊戲目前沒有開放"), { code: "OFF" });
      const phone = await gBound(who);
      if (typeof phone !== "string" || !gValidPhone(phone)) throw Object.assign(new Error("請先輸入電話"), { code: "NEED_PHONE" });
      const sim = await gSim(cfg, phone, who.uid);
      gOpen(cfg, sim);
      const today = gDay();
      let first = true;
      if (!sim) {
        const d = await fbGet(`gacha/players/${phone}/days/${today}/memory`);
        first = !d;
        if (first) await fbPut(`gacha/players/${phone}/days/${today}/memory`, true);
      }
      return { first, cfg, phone };
    });
    const state = await gState(out.cfg, who, out.phone);
    res.json({ ok: true, first: out.first, state });
  } catch (e) { gErr(res, e); }
});

app.post("/staff/gacha/quiz", async (req, res) => {
  const s = await requireStaff(req, res);
  if (!s) return;
  try {
    const list = (req.body || {}).quiz;
    if (!Array.isArray(list) || !list.length) throw Object.assign(new Error("題庫是空的"), { code: "BAD" });
    const clean = list.map((x, i) => {
      const o = (x.o || []).map((v) => String(v || "").trim());
      if (!String(x.q || "").trim()) throw Object.assign(new Error(`第 ${i + 1} 題沒有題目`), { code: "BAD" });
      if (o.length !== 4 || o.some((v) => !v)) throw Object.assign(new Error(`第 ${i + 1} 題要填滿 4 個選項`), { code: "BAD" });
      const a = Number(x.a);
      if (!(a >= 0 && a <= 3)) throw Object.assign(new Error(`第 ${i + 1} 題沒有選正確答案`), { code: "BAD" });
      return { q: String(x.q).trim(), o, a, t: String(x.t || "").trim(), lv: Math.min(4, Math.max(1, Number(x.lv) || 1)) };
    });
    await fbPut("gacha/quiz", clean);
    res.json({ ok: true, quiz: clean });
  } catch (e) { gErr(res, e); }
});

/* ── 後台「扭蛋活動」分頁用 ── */
app.post("/staff/gacha", async (req, res) => {
  const s = await requireStaff(req, res);
  if (!s) return;
  try {
    const [cfg, stock, players, log] = await Promise.all([
      gConfig(), fbGet("gacha/stock"), fbGet("gacha/players"),
      fbGet("gacha/log", { orderBy: '"$key"', limitToLast: "1500" }),
    ]);
    const saved = await fbGet("gacha/config", { shallow: "true" });
    const qs = await fbGet("gacha/quiz", { shallow: "true" });
    res.json({ ok: true, cfg, isDefault: !saved, stock: stock || {}, players: players || {}, log: log || {}, today: gDay(),
      quiz: await gQuizList(), quizDefault: !qs });
  } catch (e) { gErr(res, e); }
});

app.post("/staff/gacha/config", async (req, res) => {
  const s = await requireStaff(req, res);
  if (!s) return;
  try {
    const c = (req.body || {}).cfg;
    if (!c || !Array.isArray(c.prizes) || !c.prizes.length) throw Object.assign(new Error("獎品清單是空的"), { code: "BAD" });
    const ids = new Set();
    for (const p of c.prizes) {
      if (!p.id || !p.nm) throw Object.assign(new Error("每個獎品都要有名稱"), { code: "BAD" });
      if (ids.has(p.id)) throw Object.assign(new Error("獎品編號重複：" + p.id), { code: "BAD" });
      ids.add(p.id);
      if (!["bonus", "ticket", "none"].includes(p.type)) throw Object.assign(new Error("獎品類型不對：" + p.nm), { code: "BAD" });
      if (!["all", "mem", "new"].includes(p.who)) throw Object.assign(new Error("誰能抽不對：" + p.nm), { code: "BAD" });
      p.w = Math.max(0, Number(p.w) || 0);
      if (p.type === "bonus") p.v = Math.max(1, Math.round(Number(p.v) || 1));
      if (p.qty === "" || p.qty == null) delete p.qty; else p.qty = Math.max(0, Math.round(Number(p.qty) || 0));
      if (p.per === "" || p.per == null) delete p.per; else p.per = Math.max(1, Math.round(Number(p.per) || 1));
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(c.start || "") || !/^\d{4}-\d{2}-\d{2}$/.test(c.end || "")) {
      throw Object.assign(new Error("活動日期格式不對"), { code: "BAD" });
    }
    c.cap = Math.max(0, Math.round(Number(c.cap) || 0));
    c.testPhones = (c.testPhones || []).map(normPhone).filter(gValidPhone);
    c.demoPhones = (c.demoPhones || []).map(normPhone).filter(gValidPhone);
    c.demoStaff = c.demoStaff !== false;
    c.updatedAt = new Date().toISOString();
    c.updatedBy = (s.staff && s.staff.name) || s.uid;
    await fbPut("gacha/config", c);
    res.json({ ok: true, cfg: c });
  } catch (e) { gErr(res, e); }
});

/* 活動開始前清空所有測試紀錄：測試模式的遊玩紀錄、抽獎紀錄、庫存計數，
   還有活動開始前在正式區玩過的次數。綁好的電話保留，不用重新綁。
   已經寫進會員明細的紅利不會動（要收回請到會員分頁調整）。 */
app.post("/staff/gacha/reset-test", async (req, res) => {
  const s = await requireStaff(req, res);
  if (!s) return;
  try {
    const cfg = await gConfig();
    /* 活動開始之後也能按，但只清測試資料（測試模式的遊玩紀錄、標成測試的抽獎紀錄），
       正式玩家的次數、限量獎品的數量一律不動。 */
    const started = gDay() >= cfg.start;
    const [players, log] = await Promise.all([fbGet("gacha/players"), fbGet("gacha/log")]);
    await fbDel("gacha/testplayers");
    const pp = {};
    let real = 0;
    if (!started) {
      /* 還沒開始的話，抽獎紀錄全部清掉（含提前正式玩到的），跑馬燈才不會出現開始前的紀錄 */
      real = Object.keys(log || {}).filter((k) => log[k] && !log[k].test).length;
      await fbDel("gacha/log");
      await fbDel("gacha/stock");
      for (const ph in players || {}) {
        const p = players[ph] || {};
        pp[ph] = { uid: p.uid || null, name: p.name || "", lineName: p.lineName || "", first: p.first || null };
      }
      if (Object.keys(pp).length) await fbPatch("gacha/players", pp);
    }
    const lp = {};
    for (const k in log || {}) if (log[k] && log[k].test) lp[k] = null;
    if (Object.keys(lp).length) await fbPatch("gacha/log", lp);
    res.json({ ok: true, players: Object.keys(pp).length, logs: Object.keys(lp).length + real });
  } catch (e) { gErr(res, e); }
});

/* 客人拿抽到的券來用，後台按「已使用」 */
app.post("/staff/gacha/redeem", async (req, res) => {
  const s = await requireStaff(req, res);
  if (!s) return;
  try {
    const phone = normPhone((req.body || {}).phone);
    const gid = String((req.body || {}).gid || "");
    const undo = !!(req.body || {}).undo;
    let list = (await fbGet(`members/${phone}/tickets`)) || [];
    if (!Array.isArray(list)) list = Object.values(list);
    const t = list.find((x) => x && x.gid === gid);
    if (!t) throw Object.assign(new Error("找不到這張券，可能已經被刪掉了"), { code: "BAD" });
    if (undo) { t.qty = 1; delete t.usedAt; delete t.usedBy; }
    else { t.qty = 0; t.usedAt = new Date().toISOString(); t.usedBy = (s.staff && s.staff.name) || s.uid; }
    await fbPut(`members/${phone}/tickets`, list);
    res.json({ ok: true, ticket: t });
  } catch (e) { gErr(res, e); }
});

/* 後台查某個人手上扭蛋券的使用狀態 */
app.post("/staff/gacha/tickets", async (req, res) => {
  const s = await requireStaff(req, res);
  if (!s) return;
  try {
    const phones = [...new Set(((req.body || {}).phones || []).map(normPhone).filter(gValidPhone))].slice(0, 300);
    const out = {};
    await Promise.all(phones.map(async (p) => {
      let list = (await fbGet(`members/${p}/tickets`)) || [];
      if (!Array.isArray(list)) list = Object.values(list);
      out[p] = list.filter((x) => x && x.src === "gacha")
        .map((x) => ({ gid: x.gid, name: x.name, qty: x.qty, usedAt: x.usedAt || "", usedBy: x.usedBy || "", expiry: x.expiry }));
    }));
    res.json({ ok: true, tickets: out });
  } catch (e) { gErr(res, e); }
});

app.get("/", (_, res) => res.send("Otto2 notify service is running."));

/* 自我檢測：確認 token 是否有效 */
/* 部署版本標記。
   ── 為什麼要有這個 ──
   /health 原本那幾項舊版就有，全部 true 只證明服務活著，
   證明不了跑的是哪一版程式。2026-08-09 那次就是這樣誤判的：
   health 全綠，但 Railway 上其實還是舊檔，/staff/list 回 404。
   以後改完 server.js 就把日期往下加一版，部署後打開 /health 對一眼。 */
const SERVER_VERSION = "2026-10-03-fixed-slot";

app.get("/health", async (_, res) => {
  const out = {
    version: SERVER_VERSION,
    hasCalendarFeed: true,   /* 這個欄位存在，就代表 /cron/bookings 在 */
    hasGacha: true,          /* 十月扭蛋活動 /gacha/state、/gacha/spin、/staff/gacha */
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

/* ───────── 聖誕走格子（11–12 月）─────────
   資料放在 xmas/（跟 gacha/ 完全分開）：
     xmas/config                設定（開始結束日、獎勵、獎池…），沒設就用 XMAS_DEFAULT
     xmas/players/{phone}       正式玩家進度
     xmas/world/{tree,forest,lots}   全體共用：聖誕樹點燈數、森林（每人一棵）、空地小屋
     xmas/stock                 限量票券的發放數
     xmas/testplayers、xmas/testworld   示範模式（員工、示範電話）用，跟正式的完全分開
   身分沿用扭蛋：LINE access token → gWho；電話綁定 → gResolvePhone（同一個 gacha/bind）。
   紅利、票券寫進會員檔案，格式跟扭蛋一樣（src:"gacha"，後台判斷會員時會排除），by 標「聖誕走格子」。
   示範模式一律不入帳（不寫紅利、不寫票券、不扣庫存）。 */
const XMAS_DEFAULT = {
  start: "2026-11-01", end: "2026-12-25",
  testPhones: [], demoStaff: true,
  tiles: [34, 16],                       // 第一層、第二層格數
  daily: [1, 1],                         // 每層每天可擲次數
  maxExtraDay: 5,                        // 「再擲一次」每天最多加幾次
  giftGainDay: 60,                       // 每人每天最多靠存檔增加幾個禮物（防亂送）
  // 聖誕樹
  layers: [150, 400, 700, 1050, 1500],   // 每層累積幾盞燈
  lights: { open: 1, roll: 3, gift: 10, klass: 10 },
  lightsDay: 80,                         // 每人每天最多點幾盞
  treePts: [2, 2, 2, 2, 5],              // 每層亮起，參與過的會員各領幾點紅利
  // 全體共用森林／小屋
  forestMax: 251, plantDayMax: 4,
  lotIdx: [1, 5, 11, 17, 20, 30, 32], lotCost: 3, lotUpg: [0, 4, 6], lotMax: 1, visitDayMax: 10,
  // 吊飾集滿（三選一）
  ornGift: 5, ornPoint: 3, ornTicket: { nm: "材料升級券", kind: "upgrade" },
  // 每人整個活動從走格子拿到的紅利總上限
  pointCap: 20,
  expiry: "2026-12-31",
  // 扭蛋機格獎池
  gachaDayMax: 3, gachaRealDay: 1,
  gachaPool: [
    { id: "g1", nm: "1 個禮物", type: "gift", n: 1, w: 560 },
    { id: "g2", nm: "2 個禮物", type: "gift", n: 2, w: 250 },
    { id: "g3", nm: "3 個禮物", type: "gift", n: 3, w: 100 },
    { id: "b1", nm: "紅利 1 點", type: "bonus", v: 1, w: 60 },
    { id: "b2", nm: "紅利 2 點", type: "bonus", v: 2, w: 20 },
    { id: "t1", nm: "材料升級券", type: "ticket", kind: "upgrade", w: 10, qty: 30 },
  ],
};
async function xConfig() {
  const c = await fbGet("xmas/config");
  return { ...XMAS_DEFAULT, ...(c && typeof c === "object" ? c : {}) };
}
async function xSim(cfg, phone, uid) {
  return (cfg.testPhones || []).includes(phone) || (cfg.demoStaff !== false && (await gIsStaff(uid)));
}
const xStatus = (cfg, today, sim) => (today < cfg.start ? (sim ? "test" : "soon") : today > cfg.end ? "ended" : "on");
const xBase = (sim) => (sim ? "xmas/testplayers" : "xmas/players");
const xWorld = (sim) => (sim ? "xmas/testworld" : "xmas/world");
const xErr = (msg, code) => Object.assign(new Error(msg), { code });

/* 今天或之後有沒有預約（沒取消的）→ 可以玩第二層；今天有沒有來上課 */
async function xBookInfo(phone, uid) {
  const todaySlash = todayStr();
  const all = await gBookings();
  let booked = false, klass = false;
  for (const k in all) {
    const b = all[k];
    if (!b || b.status === "cancelled" || !ownsBooking(b, phone, uid)) continue;
    if (String(b.date || "") >= todaySlash) booked = true;
    if (b.date === todaySlash && (b.checkout || b.attend === "in")) klass = true;
  }
  return { booked, klass };
}

/* 玩家資料整理成固定格式；新的一天把今天的計數歸零 */
function xNorm(p, today) {
  p = p && typeof p === "object" ? p : {};
  const same = p.day === today;
  const arr2 = (a) => [Number(a && a[0]) || 0, Number(a && a[1]) || 0];
  const orn = Array.isArray(p.orn) ? p.orn : [];
  const dayN = (o) => (o && o.day === today ? Number(o.n) || 0 : 0);
  return {
    uid: p.uid || "", name: p.name || "", first: p.first || "",
    gifts: Math.max(0, Math.floor(Number(p.gifts) || 0)),
    orn: [0, 1, 2, 3].map((i) => !!orn[i]),
    pos: [Math.max(0, Math.floor(Number(p.pos && p.pos[0]) || 0)), Math.max(0, Math.floor(Number(p.pos && p.pos[1]) || 0))],
    day: today,
    used: same ? arr2(p.used) : [0, 0],
    extra: same ? arr2(p.extra) : [0, 0],
    arc: p.arc && typeof p.arc === "object" ? p.arc : { best: {}, n: 0, day: today },
    lights: Math.max(0, Math.floor(Number(p.lights) || 0)),
    openDay: p.openDay || "", classDay: p.classDay || "",
    layers: p.layers && typeof p.layers === "object" ? p.layers : {},
    pts: Number(p.pts) || 0, ornRounds: Number(p.ornRounds) || 0, ornReal: Number(p.ornReal) || 0,
    tickets: p.tickets && typeof p.tickets === "object" ? p.tickets : {},
    tree: p.tree && Number.isFinite(Number(p.tree.s)) ? { s: Number(p.tree.s), lv: Math.max(1, Math.min(5, Number(p.tree.lv) || 1)) } : null,
    lot: Number.isFinite(Number(p.lot)) && p.lot !== null && p.lot !== "" ? Number(p.lot) : null,
    plantN: dayN(p.plantD), plantD: { day: today, n: dayN(p.plantD) },
    gachaN: dayN(p.gachaD), gachaD: { day: today, n: dayN(p.gachaD) },
    gachaReal: dayN(p.gachaRealD), gachaRealD: { day: today, n: dayN(p.gachaRealD) },
    giftGain: dayN(p.giftGainD), giftGainD: { day: today, n: dayN(p.giftGainD) },
    lightDay: dayN(p.lightD), lightD: { day: today, n: dayN(p.lightD) },
    visitD: p.visitD && p.visitD.day === today && p.visitD.set ? p.visitD : { day: today, set: {}, n: 0 },
  };
}
const xLeft = (p, cfg, booked, sim, lv) => {
  if (sim) return 99;
  const base = lv === 0 ? Number(cfg.daily[0]) || 1 : booked ? Number(cfg.daily[1]) || 1 : 0;
  return Math.max(0, base + p.extra[lv] - p.used[lv]);
};
/* 這個玩家這次還能領哪些獎 */
function xClaims(cfg, p, treeLights) {
  const layers = [];
  (cfg.layers || []).forEach((t, k) => { if (treeLights >= t && !p.layers[k] && p.lights > 0) layers.push(k); });
  return { layers, orn: p.orn.every(Boolean) };
}
function xPublic(cfg, who, phone, p, booked, sim, today, extra) {
  return {
    status: xStatus(cfg, today, sim), today, start: cfg.start, end: cfg.end, sim, booked,
    me: { name: p.name || who.displayName || "", phone: phone.slice(0, 4) + "-***-" + phone.slice(7) },
    p: {
      gifts: p.gifts, orn: p.orn, pos: p.pos, left: [xLeft(p, cfg, booked, sim, 0), xLeft(p, cfg, booked, sim, 1)],
      arc: p.arc, lights: p.lights, pts: p.pts, pointCap: cfg.pointCap, tree: p.tree, lot: p.lot,
    },
    ...(extra || {}),
  };
}
async function xLoad(cfg, who, phone) {
  const sim = await xSim(cfg, phone, who.uid);
  const today = gDay();
  const [raw, bk] = await Promise.all([fbGet(`${xBase(sim)}/${phone}`), xBookInfo(phone, who.uid)]);
  const p = xNorm(raw, today);
  p.uid = who.uid;
  if (!p.name) p.name = who.displayName || "";
  if (!p.first) p.first = new Date().toISOString();
  return { sim, today, booked: bk.booked, klass: bk.klass, p };
}
const xPut = (L, phone) => {
  const p = { ...L.p };
  p.plantD = { day: L.today, n: p.plantN }; delete p.plantN;
  p.gachaD = { day: L.today, n: p.gachaN }; delete p.gachaN;
  p.gachaRealD = { day: L.today, n: p.gachaReal }; delete p.gachaReal;
  p.giftGainD = { day: L.today, n: p.giftGain }; delete p.giftGain;
  p.lightD = { day: L.today, n: p.lightDay }; delete p.lightDay;
  return fbPut(`${xBase(L.sim)}/${phone}`, p);
};
async function xReady(who, body, needOpen) {
  const cfg = await xConfig();
  const r = await gResolvePhone(who, body || {});
  if (!r.phone) throw xErr("請先輸入手機號碼", "NEED_PHONE");
  const L = await xLoad(cfg, who, r.phone);
  const st = xStatus(cfg, L.today, L.sim);
  if (needOpen && (st === "soon" || st === "ended")) throw xErr(st === "soon" ? "聖誕走格子還沒開始" : "聖誕走格子已經結束", "CLOSED");
  return { cfg, phone: r.phone, L };
}

/* 紅利、票券寫進會員檔案（格式同扭蛋；示範模式不呼叫） */
async function xAddBonus(phone, name, v, reason) {
  await gEnsureMember(phone, name);
  const key = `gacha_${gDay()}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  await fbPut(`members/${phone}/ledger/${key}`, {
    at: new Date().toISOString(), by: "聖誕走格子", delta: v, type: "bonus", reason, src: "gacha",
  });
  const l = (await fbGet(`members/${phone}/ledger`)) || {};
  const sum = { points: 0, sessions: 0, bonus: 0, voucher: 0 };
  for (const k in l) {
    const r = l[k]; if (!r) continue;
    const d = Number(r.delta) || 0;
    if (r.type in sum) sum[r.type] += d;
  }
  await fbPut(`members/${phone}/cache`, sum);
}
async function xAddTicket(phone, name, nm, kind, cfg, gid) {
  await gEnsureMember(phone, name);
  let list = (await fbGet(`members/${phone}/tickets`)) || [];
  if (!Array.isArray(list)) list = Object.values(list);
  list.push({
    name: nm, qty: 1, expiry: cfg.expiry, kind: kind || "other",
    raw: `聖誕走格子・${nm}`, batch: "xmas-" + cfg.start.slice(0, 7),
    at: new Date().toISOString(), by: "聖誕走格子", src: "gacha", gid,
  });
  await fbPut(`members/${phone}/tickets`, list);
}
/* 發點數（受每人總上限限制）。回傳實際發的點數 */
async function xGivePts(cfg, L, phone, v, reason) {
  const can = Math.max(0, Math.min(v, (Number(cfg.pointCap) || 0) - L.p.pts));
  if (can <= 0) return 0;
  if (!L.sim) await xAddBonus(phone, L.p.name, can, reason);
  L.p.pts += can;
  return can;
}

app.get("/xmas/info", async (req, res) => {
  try {
    const cfg = await xConfig(), today = gDay();
    res.json({ ok: true, today, start: cfg.start, end: cfg.end, status: today < cfg.start ? "soon" : today > cfg.end ? "ended" : "on", tiles: cfg.tiles });
  } catch (e) { gErr(res, e); }
});

/* 打開遊戲：讀進度；每天第一次順便加「打開遊戲 +1 燈」「今天有來上課 +10 燈」 */
app.post("/xmas/state", async (req, res) => {
  try {
    const body = req.body || {};
    const who = await gWho(body.accessToken);
    const cfg0 = await xConfig();
    const r0 = await gResolvePhone(who, body);
    if (!r0.phone) return res.json({ ok: true, needPhone: true, guess: r0.guess || "", lineName: who.displayName });
    const out = await gSerial(async () => {
      const { cfg, phone, L } = await xReady(who, {}, false);
      const gain = { open: 0, klass: 0 };
      const st = xStatus(cfg, L.today, L.sim);
      if (st === "on" || st === "test") {
        const W = xWorld(L.sim);
        let add = 0;
        const room = () => Math.max(0, (Number(cfg.lightsDay) || 80) - L.p.lightDay);
        if (L.p.openDay !== L.today) { const n = Math.min(room(), cfg.lights.open); gain.open = n; add += n; L.p.lightDay += n; L.p.openDay = L.today; }
        if (L.klass && L.p.classDay !== L.today) { const n = Math.min(room(), cfg.lights.klass); gain.klass = n; add += n; L.p.lightDay += n; L.p.classDay = L.today; }
        if (add) {
          const t = (await fbGet(`${W}/tree`)) || {};
          await fbPut(`${W}/tree`, { lights: (Number(t.lights) || 0) + add });
          L.p.lights += add;
        }
        await xPut(L, phone);
      }
      return { ...xPublic(cfg, who, phone, L.p, L.booked, L.sim, L.today), gain };
    });
    res.json({ ok: true, ...out });
  } catch (e) { gErr(res, e); }
});

/* 全體共用：聖誕樹、森林、小屋，加上我現在可以領的獎 */
app.post("/xmas/world", async (req, res) => {
  try {
    const body = req.body || {};
    const who = await gWho(body.accessToken);
    const { cfg, phone, L } = await xReady(who, body, false);
    const W = xWorld(L.sim);
    const [tree, forest, lots] = await Promise.all([fbGet(`${W}/tree`), fbGet(`${W}/forest`), fbGet(`${W}/lots`)]);
    const lights = Number((tree || {}).lights) || 0;
    const fl = [];
    for (const s in forest || {}) {
      const f = forest[s]; if (!f) continue;
      fl.push({ s: Number(s), n: f.phone === phone ? "你" : gMask(f.n), lv: Number(f.lv) || 1, me: f.phone === phone });
    }
    const ll = {};
    for (const i in lots || {}) {
      const l = lots[i]; if (!l) continue;
      ll[i] = { n: l.phone === phone ? "你" : gMask(l.n), lv: Number(l.lv) || 1, me: l.phone === phone };
    }
    res.json({ ok: true, tree: { lights, layers: cfg.layers }, forest: fl, lots: ll, claim: xClaims(cfg, L.p, lights), treePts: cfg.treePts,
      ornPick: { gift: cfg.ornGift, point: cfg.ornPoint, ticket: (cfg.ornTicket || {}).nm || "" }, lotIdx: cfg.lotIdx, lotCost: cfg.lotCost, lotUpg: cfg.lotUpg });
  } catch (e) { gErr(res, e); }
});

/* 擲骰子：次數和點數都在伺服器決定，前端只負責演；擲一次順便幫聖誕樹點 3 盞燈 */
app.post("/xmas/roll", async (req, res) => {
  try {
    const body = req.body || {};
    const who = await gWho(body.accessToken);
    const lv = body.lv === 1 ? 1 : 0;
    const out = await gSerial(async () => {
      const { cfg, phone, L } = await xReady(who, {}, true);
      if (lv === 1 && !L.booked && !L.sim) throw xErr("預約上課才能打開第二層", "NEED_BOOKING");
      if (xLeft(L.p, cfg, L.booked, L.sim, lv) <= 0) throw xErr("今天的次數用完了，明天再來", "NO_LEFT");
      if (!L.sim) L.p.used[lv] += 1;
      const W = xWorld(L.sim);
      const room = Math.max(0, (Number(cfg.lightsDay) || 80) - L.p.lightDay);
      const n = Math.min(room, Number(cfg.lights.roll) || 3);
      let lightsNow = 0;
      if (n > 0) {
        const t = (await fbGet(`${W}/tree`)) || {};
        lightsNow = (Number(t.lights) || 0) + n;
        await fbPut(`${W}/tree`, { lights: lightsNow });
        L.p.lights += n; L.p.lightDay += n;
      }
      const v = 1 + Math.floor(Math.random() * 6);
      L.p.lastRoll = { at: new Date().toISOString(), lv, v };
      await xPut(L, phone);
      return { ...xPublic(cfg, who, phone, L.p, L.booked, L.sim, L.today), v, lightAdd: n };
    });
    res.json({ ok: true, ...out });
  } catch (e) { gErr(res, e); }
});

/* 走完一步之後把結果存起來：位置、禮物、吊飾、小遊戲最高分。
   禮物放寬一點但有每人每天上限；「再擲一次」要靠 extraAdd 通知，每天有上限。 */
app.post("/xmas/save", async (req, res) => {
  try {
    const body = req.body || {};
    const who = await gWho(body.accessToken);
    const s = body.state && typeof body.state === "object" ? body.state : {};
    const out = await gSerial(async () => {
      const { cfg, phone, L } = await xReady(who, {}, true);
      const p = L.p;
      if (Number.isFinite(Number(s.gifts))) {
        const want = Math.max(0, Math.floor(Number(s.gifts)));
        if (want <= p.gifts) p.gifts = want;
        else {
          const room = Math.max(0, (Number(cfg.giftGainDay) || 60) - p.giftGain);
          const add = Math.min(want - p.gifts, room);
          p.gifts += add; p.giftGain += add;
        }
      }
      if (Array.isArray(s.orn)) {
        const next = [0, 1, 2, 3].map((i) => !!s.orn[i]);
        /* 吊飾只能多不能少（清空只有領獎才會做） */
        p.orn = p.orn.map((o, i) => o || next[i]);
      }
      if (Array.isArray(s.pos)) {
        [0, 1].forEach((i) => {
          const n = Number(cfg.tiles[i]) || 1, v = Math.floor(Number(s.pos[i]));
          if (Number.isFinite(v) && v >= 0 && v < n) p.pos[i] = v;
        });
      }
      const ea = [0, 1].map((i) => Math.max(0, Math.min(1, Math.floor(Number(s.extraAdd && s.extraAdd[i]) || 0))));
      [0, 1].forEach((i) => { if (ea[i] && !L.sim && p.extra[i] < (Number(cfg.maxExtraDay) || 5)) p.extra[i] += ea[i]; });
      if (s.arc && typeof s.arc === "object") {
        const best = {};
        const src = s.arc.best && typeof s.arc.best === "object" ? s.arc.best : {};
        for (const k of Object.keys(src).slice(0, 12)) {
          const b = src[k];
          if (b && Number.isFinite(Number(b.s))) best[String(k).slice(0, 12)] = { s: Number(b.s), lbl: String(b.lbl || "").slice(0, 24) };
        }
        p.arc = { best, n: Math.max(0, Math.min(9, Math.floor(Number(s.arc.n) || 0))), day: L.today };
      }
      await xPut(L, phone);
      return xPublic(cfg, who, phone, p, L.booked, L.sim, L.today);
    });
    res.json({ ok: true, ...out });
  } catch (e) { gErr(res, e); }
});

/* 送禮物點亮聖誕樹：1 個禮物 = 10 盞（每人每天有上限） */
app.post("/xmas/light", async (req, res) => {
  try {
    const who = await gWho((req.body || {}).accessToken);
    const n = Math.max(1, Math.min(3, Math.floor(Number((req.body || {}).n) || 1)));
    const out = await gSerial(async () => {
      const { cfg, phone, L } = await xReady(who, {}, true);
      if (L.p.gifts < n) throw xErr("禮物不夠", "NO_GIFT");
      const per = Number(cfg.lights.gift) || 10;
      const room = Math.max(0, (Number(cfg.lightsDay) || 80) - L.p.lightDay);
      const add = Math.min(room, n * per);
      if (add <= 0) throw xErr("今天幫聖誕樹點的燈夠多了，明天再來！", "LIGHT_CAP");
      const used = Math.ceil(add / per);
      L.p.gifts -= used; L.p.lights += add; L.p.lightDay += add;
      const W = xWorld(L.sim);
      const t = (await fbGet(`${W}/tree`)) || {};
      const lightsNow = (Number(t.lights) || 0) + add;
      await fbPut(`${W}/tree`, { lights: lightsNow });
      await xPut(L, phone);
      return { ...xPublic(cfg, who, phone, L.p, L.booked, L.sim, L.today), lightAdd: add, usedGifts: used, tree: { lights: lightsNow } };
    });
    res.json({ ok: true, ...out });
  } catch (e) { gErr(res, e); }
});

/* 種樹／長大：每人一棵，位置由前端建議（離小熊最近的空位），伺服器確認沒被佔走 */
app.post("/xmas/plant", async (req, res) => {
  try {
    const who = await gWho((req.body || {}).accessToken);
    const pref = Math.floor(Number((req.body || {}).pref));
    const out = await gSerial(async () => {
      const { cfg, phone, L } = await xReady(who, {}, true);
      const W = xWorld(L.sim), p = L.p;
      if (p.plantN >= (Number(cfg.plantDayMax) || 4)) throw xErr("今天種樹／澆水的次數用完了，明天再來", "PLANT_CAP");
      const forest = (await fbGet(`${W}/forest`)) || {};
      const max = Number(cfg.forestMax) || 251;
      let result;
      if (!p.tree) {
        let slot = -1;
        if (Number.isFinite(pref) && pref >= 0 && pref < max && !forest[pref]) slot = pref;
        else {
          const start = Math.floor(Math.random() * max);
          for (let k = 0; k < max; k++) { const s = (start + k) % max; if (!forest[s]) { slot = s; break; } }
        }
        if (slot < 0) { p.gifts += 1; p.plantN += 1; await xPut(L, phone); return { ...xPublic(cfg, who, phone, p, L.booked, L.sim, L.today), full: true }; }
        await fbPut(`${W}/forest/${slot}`, { phone, n: p.name, lv: 1 });
        p.tree = { s: slot, lv: 1 };
        result = { kind: "new", s: slot, lv: 1 };
      } else if (p.tree.lv >= 5) {
        p.gifts += 1;
        result = { kind: "max", s: p.tree.s, lv: 5 };
      } else {
        p.tree.lv += 1;
        await fbPut(`${W}/forest/${p.tree.s}`, { phone, n: p.name, lv: p.tree.lv });
        result = { kind: "grow", s: p.tree.s, lv: p.tree.lv };
      }
      p.plantN += 1;
      await xPut(L, phone);
      return { ...xPublic(cfg, who, phone, p, L.booked, L.sim, L.today), plant: result };
    });
    res.json({ ok: true, ...out });
  } catch (e) { gErr(res, e); }
});

/* 空地小屋：認領／升級／拜訪 */
app.post("/xmas/lot", async (req, res) => {
  try {
    const who = await gWho((req.body || {}).accessToken);
    const idx = Math.floor(Number((req.body || {}).idx)), op = String((req.body || {}).op || "");
    const out = await gSerial(async () => {
      const { cfg, phone, L } = await xReady(who, {}, true);
      if (!(cfg.lotIdx || []).includes(idx)) throw xErr("這不是空地", "BAD_LOT");
      const W = xWorld(L.sim), p = L.p;
      const lot = await fbGet(`${W}/lots/${idx}`);
      let result = {};
      if (op === "claim") {
        if (lot) throw xErr("這塊地剛剛被別人認領了", "LOT_TAKEN");
        if (p.lot !== null && p.lot !== undefined) throw xErr("你已經有一間聖誕小屋了", "LOT_MAX");
        const cost = Number(cfg.lotCost) || 3;
        if (p.gifts < cost) throw xErr("禮物不夠", "NO_GIFT");
        p.gifts -= cost; p.lot = idx;
        await fbPut(`${W}/lots/${idx}`, { phone, n: p.name, lv: 1, at: new Date().toISOString() });
        result = { kind: "claim", lv: 1 };
      } else if (op === "upgrade") {
        if (!lot || lot.phone !== phone) throw xErr("這不是你的小屋", "NOT_YOURS");
        const lv = Number(lot.lv) || 1;
        if (lv >= 3) throw xErr("已經是最高級了", "LOT_MAXLV");
        const cost = Number((cfg.lotUpg || [0, 4, 6])[lv]) || 4;
        if (p.gifts < cost) throw xErr("禮物不夠", "NO_GIFT");
        p.gifts -= cost;
        await fbPut(`${W}/lots/${idx}/lv`, lv + 1);
        result = { kind: "upgrade", lv: lv + 1 };
      } else if (op === "visit") {
        if (!lot) throw xErr("這塊地還沒有主人", "NO_LOT");
        if (lot.phone === phone) throw xErr("這是你自己的小屋", "OWN_LOT");
        const lv = Number(lot.lv) || 1;
        const vd = p.visitD;
        const again = !!vd.set[idx];
        const room = Math.max(0, (Number(cfg.visitDayMax) || 10) - (Number(vd.n) || 0));
        const g = again || room <= 0 ? 0 : Math.min(lv, room);
        if (g > 0) {
          p.gifts += g; vd.set[idx] = true; vd.n = (Number(vd.n) || 0) + g; p.visitD = vd;
          const owner = (await fbGet(`${xBase(L.sim)}/${lot.phone}`)) || {};
          const ow = xNorm(owner, L.today);
          ow.gifts += g;
          const ownerPut = { ...owner, gifts: ow.gifts };
          await fbPut(`${xBase(L.sim)}/${lot.phone}`, ownerPut);
          if (!L.sim && ow.uid) {
            push(ow.uid, [{ type: "text", text: `🎄 有人拜訪了你的聖誕小屋！${gMask(p.name)} 來玩囉，你們各拿到 ${g} 個禮物。打開預約頁的聖誕走格子看看吧～` }]).catch(() => {});
          }
        }
        result = { kind: "visit", gift: g, owner: gMask(lot.n), lv, again };
      } else throw xErr("不明的操作", "BAD_OP");
      await xPut(L, phone);
      return { ...xPublic(cfg, who, phone, p, L.booked, L.sim, L.today), lotRes: result };
    });
    res.json({ ok: true, ...out });
  } catch (e) { gErr(res, e); }
});

/* 領獎：聖誕樹某一層（參與過的會員各領）／吊飾集滿（禮物、紅利、材料升級券三選一） */
app.post("/xmas/claim", async (req, res) => {
  try {
    const who = await gWho((req.body || {}).accessToken);
    const kind = String((req.body || {}).kind || "");
    const out = await gSerial(async () => {
      const { cfg, phone, L } = await xReady(who, {}, true);
      const W = xWorld(L.sim), p = L.p;
      let result = {};
      if (kind === "tree") {
        const k = Math.floor(Number((req.body || {}).layer));
        const t = (await fbGet(`${W}/tree`)) || {};
        const lights = Number(t.lights) || 0;
        if (!(k >= 0 && k < cfg.layers.length) || lights < cfg.layers[k]) throw xErr("這一層還沒亮", "NOT_YET");
        if (p.layers[k]) throw xErr("這一層的獎你已經領過了", "CLAIMED");
        if (!(p.lights > 0)) throw xErr("先幫聖誕樹點個燈，才領得到喔", "NO_PART");
        const want = Number(cfg.treePts[k]) || 0;
        const got = await xGivePts(cfg, L, phone, want, `聖誕樹第 ${k + 1} 層亮了`);
        p.layers[k] = true;
        result = { kind: "tree", layer: k, want, pts: got, capped: got < want };
      } else if (kind === "orn") {
        if (!p.orn.every(Boolean)) throw xErr("吊飾還沒集滿", "NOT_FULL");
        const pick = String((req.body || {}).pick || "gift");
        let got = { pick: "gift", gift: Number(cfg.ornGift) || 5 };
        if ((pick === "point" || pick === "ticket") && p.ornReal < 1) {
          if (pick === "point") {
            const pts = await xGivePts(cfg, L, phone, Number(cfg.ornPoint) || 3, "集滿四個聖誕吊飾");
            if (pts > 0) { got = { pick: "point", pts }; p.ornReal += 1; }
          } else {
            const tk = cfg.ornTicket || {};
            if (!L.sim) await xAddTicket(phone, p.name, tk.nm || "材料升級券", tk.kind || "upgrade", cfg, "orn");
            got = { pick: "ticket", nm: tk.nm || "材料升級券" }; p.ornReal += 1;
          }
        }
        if (got.pick === "gift") p.gifts += got.gift;
        p.orn = [false, false, false, false]; p.ornRounds += 1;
        result = { kind: "orn", got, firstOnly: pick !== "gift" && got.pick === "gift" };
      } else throw xErr("不明的領獎", "BAD_KIND");
      await xPut(L, phone);
      return { ...xPublic(cfg, who, phone, p, L.booked, L.sim, L.today), claimRes: result };
    });
    res.json({ ok: true, ...out });
  } catch (e) { gErr(res, e); }
});

/* 扭蛋機格：依獎池抽一個。真獎勵（紅利、票券）每人每天最多一個、受總上限、限量與「同票券每人一張」限制，
   不符合就改抽禮物。示範模式只演不入帳。 */
app.post("/xmas/gacha", async (req, res) => {
  try {
    const who = await gWho((req.body || {}).accessToken);
    const out = await gSerial(async () => {
      const { cfg, phone, L } = await xReady(who, {}, true);
      const W = xWorld(L.sim), p = L.p;
      if (p.gachaN >= (Number(cfg.gachaDayMax) || 3)) throw xErr("今天的扭蛋機轉完了，明天再來", "GACHA_CAP");
      const stock = L.sim ? {} : (await fbGet("xmas/stock")) || {};
      const realOk = (x) => {
        if (x.type === "gift") return true;
        if (p.gachaReal >= (Number(cfg.gachaRealDay) || 1)) return false;
        if (x.type === "bonus") return p.pts + (Number(x.v) || 0) <= (Number(cfg.pointCap) || 0);
        if (x.type === "ticket") return !p.tickets[x.id] && (x.qty == null || (Number(stock[x.id]) || 0) < Number(x.qty));
        return false;
      };
      const pool = (cfg.gachaPool || []).filter(realOk);
      const prize = gPick(pool.length ? pool : (cfg.gachaPool || []).filter((x) => x.type === "gift"));
      const result = { id: prize.id, nm: prize.nm, type: prize.type };
      if (prize.type === "gift") { p.gifts += Number(prize.n) || 1; result.n = Number(prize.n) || 1; }
      else if (prize.type === "bonus") {
        const got = await xGivePts(cfg, L, phone, Number(prize.v) || 1, "扭蛋機：" + prize.nm);
        result.pts = got; p.gachaReal += 1;
      } else if (prize.type === "ticket") {
        if (!L.sim) { await xAddTicket(phone, p.name, prize.nm, prize.kind, cfg, "gacha-" + prize.id); await fbPut(`xmas/stock/${prize.id}`, (Number(stock[prize.id]) || 0) + 1); }
        p.tickets[prize.id] = true; p.gachaReal += 1;
      }
      p.gachaN += 1;
      await xPut(L, phone);
      return { ...xPublic(cfg, who, phone, p, L.booked, L.sim, L.today), gachaRes: result };
    });
    res.json({ ok: true, ...out });
  } catch (e) { gErr(res, e); }
});



/* ── 後台：聖誕走格子 ── */
app.post("/staff/xmas", async (req, res) => {
  const s = await requireStaff(req, res);
  if (!s) return;
  try {
    const [cfg, saved, players, tree, forest, lots, stock] = await Promise.all([
      xConfig(), fbGet("xmas/config", { shallow: "true" }), fbGet("xmas/players"), fbGet("xmas/world/tree"),
      fbGet("xmas/world/forest"), fbGet("xmas/world/lots"), fbGet("xmas/stock"),
    ]);
    const list = Object.entries(players || {}).map(([phone, p]) => ({
      phone, name: p.name || "", gifts: Number(p.gifts) || 0, lights: Number(p.lights) || 0, pts: Number(p.pts) || 0,
      layers: Object.keys(p.layers || {}).length, ornRounds: Number(p.ornRounds) || 0, tree: p.tree ? p.tree.lv : 0, lot: p.lot,
      tickets: Object.keys(p.tickets || {}).length, day: p.day || "",
    })).sort((a, b) => b.pts - a.pts || b.lights - a.lights);
    res.json({ ok: true, cfg, isDefault: !saved, today: gDay(), tree: tree || { lights: 0 },
      stats: { players: list.length, pts: list.reduce((a, b) => a + b.pts, 0), trees: Object.keys(forest || {}).length, lots: Object.keys(lots || {}).length },
      stock: stock || {}, players: list.slice(0, 300) });
  } catch (e) { gErr(res, e); }
});
app.post("/staff/xmas/config", async (req, res) => {
  const s = await requireStaff(req, res);
  if (!s) return;
  try {
    const c = (req.body || {}).cfg || {};
    const num = (v, d, min, max) => Math.max(min, Math.min(max, Math.round(Number(v)) || d));
    const out = {
      start: /^\d{4}-\d{2}-\d{2}$/.test(c.start || "") ? c.start : XMAS_DEFAULT.start,
      end: /^\d{4}-\d{2}-\d{2}$/.test(c.end || "") ? c.end : XMAS_DEFAULT.end,
      expiry: /^\d{4}-\d{2}-\d{2}$/.test(c.expiry || "") ? c.expiry : XMAS_DEFAULT.expiry,
      testPhones: (c.testPhones || []).map(normPhone).filter(gValidPhone),
      demoStaff: c.demoStaff !== false,
      pointCap: num(c.pointCap, 20, 0, 500),
      layers: (Array.isArray(c.layers) && c.layers.length === 5 ? c.layers : XMAS_DEFAULT.layers).map((x, i) => num(x, XMAS_DEFAULT.layers[i], 1, 100000)),
      treePts: (Array.isArray(c.treePts) && c.treePts.length === 5 ? c.treePts : XMAS_DEFAULT.treePts).map((x, i) => num(x, XMAS_DEFAULT.treePts[i], 0, 100)),
      ornGift: num(c.ornGift, 5, 0, 100), ornPoint: num(c.ornPoint, 3, 0, 100),
      ornTicket: { nm: String((c.ornTicket || {}).nm || "材料升級券").slice(0, 20), kind: String((c.ornTicket || {}).kind || "upgrade").slice(0, 12) },
      gachaDayMax: num(c.gachaDayMax, 3, 1, 20), gachaRealDay: num(c.gachaRealDay, 1, 0, 10),
      giftGainDay: num(c.giftGainDay, 60, 0, 1000), lightsDay: num(c.lightsDay, 80, 0, 1000),
      plantDayMax: num(c.plantDayMax, 4, 1, 50), visitDayMax: num(c.visitDayMax, 10, 0, 100),
      daily: [num((c.daily || [])[0], 1, 1, 20), num((c.daily || [])[1], 1, 0, 20)],
    };
    const pool = Array.isArray(c.gachaPool) ? c.gachaPool : XMAS_DEFAULT.gachaPool;
    const ids = new Set();
    out.gachaPool = pool.map((x) => {
      if (!x.id || !x.nm) throw Object.assign(new Error("每個獎品都要有名稱"), { code: "BAD" });
      if (ids.has(x.id)) throw Object.assign(new Error("獎品編號重複：" + x.id), { code: "BAD" });
      ids.add(x.id);
      if (!["gift", "bonus", "ticket"].includes(x.type)) throw Object.assign(new Error("獎品類型不對：" + x.nm), { code: "BAD" });
      const r = { id: String(x.id).slice(0, 12), nm: String(x.nm).slice(0, 24), type: x.type, w: Math.max(0, Number(x.w) || 0) };
      if (x.type === "gift") r.n = num(x.n, 1, 1, 50);
      if (x.type === "bonus") r.v = num(x.v, 1, 1, 100);
      if (x.type === "ticket") { r.kind = String(x.kind || "upgrade").slice(0, 12); if (x.qty !== "" && x.qty != null) r.qty = num(x.qty, 0, 0, 100000); }
      return r;
    });
    if (!out.gachaPool.some((x) => x.type === "gift" && x.w > 0)) throw Object.assign(new Error("獎池至少要有一個會抽到的禮物"), { code: "BAD" });
    out.updatedAt = new Date().toISOString();
    out.updatedBy = (s.staff && s.staff.name) || s.uid;
    await fbPut("xmas/config", out);
    res.json({ ok: true, cfg: { ...XMAS_DEFAULT, ...out } });
  } catch (e) { gErr(res, e); }
});
/* 清掉示範資料（員工測試用的 testplayers／testworld），正式玩家與正式森林、小屋、樹不動 */
app.post("/staff/xmas/reset-test", async (req, res) => {
  const s = await requireStaff(req, res);
  if (!s) return;
  try {
    await fbDel("xmas/testplayers");
    await fbDel("xmas/testworld");
    res.json({ ok: true });
  } catch (e) { gErr(res, e); }
});

/* ══════════════════════════════════════════════════════════
   作品島（2026-10-02，大熊定的規則）
   - 大家都可以逛：GET /island/data 公開，只給名字、作品，不給電話、LINE
   - 只有會員可以搬進來、上傳；每支電話一間小屋，只能放進自己家
   - 員工（後台員工名單）可以幫任何一間放作品，也可以放大樹相簿
   照片不放在 island/houses 裡（薪資系統 base64 拖慢開頁的教訓）：
   另外存在 island/img/{id}/{f|t}，大圖長邊 1280、縮圖 360，
   透過 /island/img/{id}/{f|t} 給瀏覽器，一年快取，伺服器也記住最近的縮圖。
   資料：island/houses/{hid} = {phone, uid, name, style, since, ts, works:{wid:{title,date,by,ts}}}
         island/owner/{phone} = hid
         island/album/{wid} = {title,date,by,ts}
   ══════════════════════════════════════════════════════════ */
const ISL_STYLES = ["stack", "wing"];
const ISL_MAX = Number(process.env.ISLAND_MAX) || 58;
const islErr = (msg, code) => Object.assign(new Error(msg), { code });
let islCache = { at: 0, data: null };
const islDirty = () => { islCache = { at: 0, data: null }; };

async function islWho(body) {
  const who = await gWho(body.accessToken);
  const staff = await gIsStaff(who.uid);
  /* 先找這個 LINE 綁過的電話：扭蛋綁定 → 預約頁記過的 */
  let phone = await fbGet(`gacha/bind/${who.uid}`);
  if (!(typeof phone === "string" && gValidPhone(phone))) {
    phone = await fbGet(`lineIndex/${who.uid}`);
    if (!(typeof phone === "string" && gValidPhone(phone))) phone = "";
  }
  /* 小屋的鑰匙：會員用電話；工作人員沒有綁電話就用 LINE 身分（2026-10-03 大熊要工作人員也能有小屋） */
  const key = phone || (staff ? "staff_" + who.uid : "");
  return { who, staff, phone, key };
}

/* 會員：手上有點數／堂數／票券；或曾經買過方案、儲過值（ledger 有紀錄，扭蛋紅利不算） */
function islIsMember(m) {
  if (!m) return false;
  if (gIsMember(m)) return true;
  let l = m.ledger || [];
  if (!Array.isArray(l)) l = Object.values(l);
  return l.some((x) => x && x.src !== "gacha" && (x.type === "points" || x.type === "sessions") && Number(x.delta) > 0);
}

function islPublic(raw) {
  const houses = Object.entries(raw.houses || {}).filter(([, h]) => h && h.name).map(([id, h]) => ({
    id, name: h.name, style: h.style, since: h.since, ts: h.ts || 0, staff: !!h.staff,
    works: Object.entries(h.works || {}).map(([wid, w]) => ({ id: wid, title: w.title || "", date: w.date || "", by: w.by || "", ts: w.ts || 0,
      cm: w.cm && w.cm.a && w.cm.t ? { a: w.cm.a, t: w.cm.t } : null, rx: islRxCount(w.rx) }))
      .sort((a, b) => a.ts - b.ts),
  })).sort((a, b) => a.ts - b.ts);
  const album = Object.entries(raw.album || {}).map(([wid, w]) => ({ id: wid, title: w.title || "", date: w.date || "", ts: w.ts || 0 }))
    .sort((a, b) => a.ts - b.ts);
  return { houses, album };
}
async function islData() {
  if (islCache.data && Date.now() - islCache.at < 20000) return islCache.data;
  const [houses, album] = await Promise.all([fbGet("island/houses"), fbGet("island/album")]);
  islCache = { at: Date.now(), data: islPublic({ houses, album }) };
  return islCache.data;
}

app.get("/island/data", async (req, res) => {
  try { res.set("Cache-Control", "no-store"); res.json({ ok: true, ...(await islData()) }); } catch (e) { gErr(res, e); }
});

/* 照片：縮圖記在記憶體（最多 400 張），大圖每次跟資料庫拿，瀏覽器快取一年 */
const islThumbs = new Map();
app.get("/island/img/:id/:s", async (req, res) => {
  try {
    const id = String(req.params.id), s = req.params.s === "f" ? "f" : "t";
    if (!/^[\w-]{6,40}$/.test(id)) return res.sendStatus(404);
    let data = s === "t" ? islThumbs.get(id) : null;
    if (!data) {
      data = await fbGet(`island/img/${id}/${s}`);
      if (typeof data !== "string" || !data.startsWith("data:image/jpeg;base64,")) return res.sendStatus(404);
      if (s === "t") { islThumbs.set(id, data); if (islThumbs.size > 400) islThumbs.delete(islThumbs.keys().next().value); }
    }
    res.set("Content-Type", "image/jpeg");
    res.set("Cache-Control", "public, max-age=31536000, immutable");
    res.send(Buffer.from(data.slice(23), "base64"));
  } catch (e) { res.sendStatus(500); }
});

/* 我是誰：有沒有小屋、是不是會員、是不是員工 */
app.post("/island/me", async (req, res) => {
  try {
    const { who, staff, phone, key } = await islWho(req.body || {});
    let hid = key ? await fbGet(`island/owner/${key}`) : null;
    const m = phone ? await fbGet(`members/${phone}`) : null;
    res.json({ ok: true, staff, house: typeof hid === "string" ? hid : null, member: staff || islIsMember(m), hasPhone: !!phone || staff,
      lineName: who.displayName, suggest: (m && m.name) || "" });
  } catch (e) { gErr(res, e); }
});

/* 搬進來：只有會員；一支電話一間 */
app.post("/island/join", async (req, res) => {
  try {
    const body = req.body || {};
    const { who, staff, phone: bound, key: sKey } = await islWho(body);
    let phone = bound, key = sKey;
    if (!staff) {
      if (!phone) {
        phone = normPhone(body.phone || "");
        if (!gValidPhone(phone)) throw islErr("請輸入上課登記的手機號碼（09 開頭 10 碼）", "BAD_PHONE");
        key = phone;
      }
      const m = await fbGet(`members/${phone}`);
      if (!islIsMember(m)) throw islErr("作品島目前只開放給 OTTO2 會員。如果你是會員卻搬不進來，請私訊小編", "NOT_MEMBER");
      if (m.lineUserId && m.lineUserId !== who.uid) throw islErr("這支電話已經綁定另一個 LINE 帳號。如果是你本人，請私訊小編幫你處理", "PHONE_TAKEN");
    }
    const had = await fbGet(`island/owner/${key}`);
    if (typeof had === "string") return res.json({ ok: true, house: had, existed: true });
    const name = String(body.name || "").trim().slice(0, 8);
    if (!name) throw islErr("請寫一個門牌名字", "NO_NAME");
    /* 島上目前蓋得下 58 間（art.html 的 HSPOTS），住滿就先擋下，免得房子疊在一起 */
    const all = await fbGet("island/houses", { shallow: "true" });
    if (all && Object.keys(all).length >= ISL_MAX) throw islErr("作品島目前住滿了，我們正在擴建，請私訊小編登記", "FULL");
    const style = ISL_STYLES.includes(body.style) ? body.style : "stack";
    const hid = "h" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    await fbPut(`island/houses/${hid}`, { phone: phone || "", uid: who.uid, name, style, since: Number(String(gDay()).slice(0, 4)), ts: Date.now(), staff: !!staff, works: {} });
    await fbPut(`island/owner/${key}`, hid);
    if (phone && !bound) await fbPut(`lineIndex/${who.uid}`, phone);
    if (phone) gLinkMember(who.uid, phone);
    islDirty();
    res.json({ ok: true, house: hid });
  } catch (e) { gErr(res, e); }
});

/* 上傳：會員只能放自己家；員工可以放任何一間或大樹相簿。一個人一天最多 30 張 */
const islDaily = new Map();
app.post("/island/upload", async (req, res) => {
  try {
    const body = req.body || {};
    const { who, staff, key } = await islWho(body);
    const f = String(body.full || ""), t = String(body.thumb || "");
    const okImg = (s, max) => s.startsWith("data:image/jpeg;base64,") && s.length < max;
    if (!okImg(f, 900000) || !okImg(t, 120000)) throw islErr("照片格式不對，請換一張再試", "BAD_IMG");
    const dk = who.uid + "|" + gDay(), n = (islDaily.get(dk) || 0) + 1;
    if (n > 30 && !staff) throw islErr("今天上傳很多了，明天再繼續放吧", "TOO_MANY");
    let path;
    if (body.target === "album") {
      if (!staff) throw islErr("只有老師可以放大樹相簿", "NOT_STAFF");
      path = "island/album";
    } else {
      const mine = key ? await fbGet(`island/owner/${key}`) : null;
      const hid = String(body.target || "") || mine;
      if (!hid || typeof hid !== "string") throw islErr("先搬進你的小屋，才能放作品", "NO_HOUSE");
      if (hid !== mine && !staff) throw islErr("只能把作品放進自己的小屋", "NOT_YOURS");
      const h = await fbGet(`island/houses/${hid}/name`);
      if (!h) throw islErr("找不到這間小屋", "NO_HOUSE");
      path = `island/houses/${hid}/works`;
    }
    const wid = "w" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    await fbPut(`island/img/${wid}`, { f, t });
    const d = gDay();
    await fbPut(`${path}/${wid}`, { title: String(body.title || "").trim().slice(0, 30), date: d.slice(0, 7).replace("-", "/"),
      by: body.target === "album" ? "老師" : (staff && body.target ? "老師" : "本人"), uid: who.uid, ts: Date.now() });
    islDaily.set(dk, n);
    if (islDaily.size > 5000) islDaily.clear();
    islDirty();
    res.json({ ok: true, id: wid });
  } catch (e) { gErr(res, e); }
});

/* 刪作品：自己家的、或員工 */
app.post("/island/delete", async (req, res) => {
  try {
    const body = req.body || {};
    const { staff, key } = await islWho(body);
    const wid = String(body.id || "");
    if (!/^w[\w]{4,30}$/.test(wid)) throw islErr("找不到這張照片", "BAD_ID");
    let path = null;
    if (body.album) { if (!staff) throw islErr("只有老師可以刪大樹相簿", "NOT_STAFF"); path = `island/album/${wid}`; }
    else {
      const mine = key ? await fbGet(`island/owner/${key}`) : null;
      const hid = String(body.house || "");
      if (!hid || (hid !== mine && !staff)) throw islErr("只能刪自己小屋裡的作品", "NOT_YOURS");
      path = `island/houses/${hid}/works/${wid}`;
    }
    await fbDel(path);
    await fbDel(`island/img/${wid}`);
    islThumbs.delete(wid);
    islDirty();
    res.json({ ok: true });
  } catch (e) { gErr(res, e); }
});

/* ══════════════════════════════════════════════════════════
   作品島：藝術家島民看作品說話（2026-10-05 大熊要的）
   - 家長上傳作品後，前端呼叫 /island/comment；伺服器把縮圖給 Claude 看，
     挑一位風格最像的島民（挑不出來就隨機），用那位藝術家的口吻講一兩句話
   - 存在 island/houses/{hid}/works/{wid}/cm = {a, t, ai, ts}，之後大家點開作品都看得到
   - 一件作品只講一次；只有屋主或員工能請藝術家來看（免得被亂按花錢）
   - AI 連不上、拒答、格式不對 → 改用固定台詞，不讓家長卡住
   - 大樹相簿不講話（大熊說不用）
   ══════════════════════════════════════════════════════════ */
const ISL_ARTISTS = [
  { n: "梵谷", s: "後印象派；旋轉有力的筆觸、星空、向日葵、濃烈的藍和黃" },
  { n: "莫內", s: "印象派；光線、水面倒影、花園、睡蓮、柔和的粉彩色" },
  { n: "達利", s: "超現實主義；夢境、奇怪的組合、會融化的東西、天馬行空" },
  { n: "克林姆", s: "金色裝飾、圖案花紋、華麗閃亮" },
  { n: "米羅", s: "簡單的符號、星星、線條、紅藍黃黑的鮮豔色塊、像童話" },
  { n: "卡蘿", s: "自畫像、人物、花、動物、鮮豔的墨西哥色彩" },
  { n: "慕夏", s: "新藝術；優雅的線條、花環、圓形光圈、女孩、海報感" },
  { n: "畢卡索", s: "立體派；幾何形狀、拼貼、從不同角度看的臉、大膽變形" },
  { n: "林布蘭", s: "光影明暗、深色背景、人像、溫暖的光" },
  { n: "草間彌生", s: "圓點點、重複的圖案、南瓜、強烈對比色" },
  { n: "奈良美智", s: "可愛的大頭小孩、動物角色、簡單乾淨的卡通風" },
  { n: "葛飾北齋", s: "浮世繪；海浪、山、風景、藍色、線條清楚" },
];
const ISL_FALLBACK = [
  (t) => `${t}的顏色好有精神，我站在旁邊看了好久！`,
  (t) => `我很喜歡${t}，看得出來你畫得很用心。`,
  (t) => `${t}讓我也想拿起畫筆了，繼續畫下去吧！`,
  (t) => `這張好特別！${t}裡藏著你自己的想法，真棒。`,
];
function islFallbackComment(title) {
  const a = ISL_ARTISTS[Math.floor(Math.random() * ISL_ARTISTS.length)].n;
  const t = title ? `《${title}》` : "這件作品";
  return { a, t: ISL_FALLBACK[Math.floor(Math.random() * ISL_FALLBACK.length)](t), ai: false };
}
const ISL_CM_SYSTEM = `你是 OTTO2 兒童美術教室「作品島」上的藝術家島民。小朋友（或大人學員）上傳了一件自己的作品照片，請你：
1. 從下面的島民裡，挑一位「風格、主題、顏色」跟這件作品最像的藝術家來看這幅畫。真的看不出像誰，就挑你覺得最適合鼓勵他的。
${ISL_ARTISTS.map((x) => `- ${x.n}：${x.s}`).join("\n")}
2. 用那位藝術家的口吻（第一人稱「我」），對作品說一到兩句話，繁體中文，40～70 個字。
規則：
- 具體講到畫裡看得到的東西（顏色、形狀、主題、筆觸），可以連結到這位藝術家自己的作品或習慣，讓人會心一笑。
- 只稱讚和鼓勵；最多加一個很溫和的小建議（例如「下次可以試試…」），不要批評、不要打分數、不要比較。
- 小朋友聽得懂的口語，溫暖、有點俏皮，不要說教，不用表情符號。
- 畫出來的人像可以講畫法、顏色和表情，但不要猜畫的是誰；照片裡真實的人、名字、學校、電話等個人資訊完全不要提。
- 如果照片看起來不是作品（例如自拍、截圖、風景照），isArt 給 false，comment 寫一句通用的鼓勵（不要描述照片內容）。`;
const ISL_CM_SCHEMA = {
  type: "object",
  properties: {
    artist: { type: "string", enum: ISL_ARTISTS.map((x) => x.n) },
    comment: { type: "string" },
    isArt: { type: "boolean" },
  },
  required: ["artist", "comment", "isArt"],
  additionalProperties: false,
};
async function islAskClaude(body, withFallback) {
  const headers = { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" };
  if (withFallback) { headers["anthropic-beta"] = "server-side-fallback-2026-07-01"; body = { ...body, fallbacks: "default" }; }
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 45000);
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers, body: JSON.stringify(body), signal: ctl.signal });
    return { status: r.status, ok: r.ok, j: await r.json() };
  } finally { clearTimeout(timer); }
}
async function islAiComment(thumb, title) {
  if (!ANTHROPIC_API_KEY) return islFallbackComment(title);
  const body = {
    model: "claude-opus-5-5",
    max_tokens: 4000,
    system: ISL_CM_SYSTEM,
    output_config: { effort: "low", format: { type: "json_schema", schema: ISL_CM_SCHEMA } },
    messages: [{ role: "user", content: [
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: thumb.slice(23) } },
      { type: "text", text: `作品名稱：${title || "（沒有寫）"}` },
    ] }],
  };
  try {
    let r = await islAskClaude(body, true);
    if (r.status === 400) r = await islAskClaude(body, false); /* 萬一 fallbacks 跟結構化輸出不能一起用，就不帶再試一次 */
    if (!r.ok) { islAiLastErr = JSON.stringify(r.j).slice(0, 300); console.error("作品島藝術家留言失敗：", islAiLastErr); return islFallbackComment(title); }
    if (r.j.stop_reason === "refusal" || r.j.stop_reason === "max_tokens") { islAiLastErr = "stop_reason=" + r.j.stop_reason; return islFallbackComment(title); }
    const txt = (r.j.content || []).filter((c) => c.type === "text").map((c) => c.text).join("");
    const o = JSON.parse(txt);
    const a = ISL_ARTISTS.some((x) => x.n === o.artist) ? o.artist : ISL_ARTISTS[Math.floor(Math.random() * ISL_ARTISTS.length)].n;
    const t = String(o.comment || "").replace(/\s+/g, " ").trim().slice(0, 90);
    if (!t) return islFallbackComment(title);
    return { a, t, ai: true };
  } catch (e) {
    islAiLastErr = e.message; console.error("作品島藝術家留言錯誤：", e.message);
    return islFallbackComment(title);
  }
}
let islAiLastErr = "";
const islCmBusy = new Set(), islCmDaily = new Map();
/* 部署後確認 AI 真的有回應：每次開機只跑一次（拿島上第一件作品的縮圖，不存檔），之後都回同一個結果，不會被亂按花錢 */
let islAiCheck = null;
app.get("/island/ai-check", async (req, res) => {
  try {
    if (!islAiCheck) islAiCheck = (async () => {
      const hs = await fbGet("island/houses");
      let wid = null, title = "";
      for (const h of Object.values(hs || {})) { const e = Object.entries((h && h.works) || {})[0]; if (e) { wid = e[0]; title = e[1].title || ""; break; } }
      if (!wid) return { ok: false, error: "島上還沒有作品" };
      const thumb = await fbGet(`island/img/${wid}/t`);
      const cm = await islAiComment(String(thumb || ""), title);
      return { ok: true, ai: cm.ai, a: cm.a, t: cm.t, err: cm.ai ? "" : islAiLastErr, keySet: !!ANTHROPIC_API_KEY };
    })();
    res.set("Cache-Control", "no-store"); res.json(await islAiCheck);
  } catch (e) { gErr(res, e); }
});
app.post("/island/comment", async (req, res) => {
  try {
    const body = req.body || {};
    const { who, staff, key } = await islWho(body);
    const wid = String(body.id || ""), hid = String(body.house || "");
    if (!/^w[\w]{4,30}$/.test(wid) || !/^h[\w]{4,30}$/.test(hid)) throw islErr("找不到這件作品", "BAD_ID");
    const mine = key ? await fbGet(`island/owner/${key}`) : null;
    if (hid !== mine && !staff) throw islErr("只有屋主可以請藝術家來看", "NOT_YOURS");
    const w = await fbGet(`island/houses/${hid}/works/${wid}`);
    if (!w) throw islErr("找不到這件作品", "BAD_ID");
    if (w.cm && w.cm.a && w.cm.t) return res.json({ ok: true, a: w.cm.a, t: w.cm.t, existed: true });
    if (islCmBusy.has(wid)) throw islErr("藝術家正在看這件作品，等一下再看看", "BUSY");
    const dk = who.uid + "|" + gDay(), n = (islCmDaily.get(dk) || 0) + 1;
    if (n > 40 && !staff) throw islErr("今天藝術家們看了很多作品，明天再來請他們看吧", "TOO_MANY");
    islCmBusy.add(wid);
    try {
      const thumb = await fbGet(`island/img/${wid}/t`);
      const cm = typeof thumb === "string" && thumb.startsWith("data:image/jpeg;base64,") ? await islAiComment(thumb, w.title || "") : islFallbackComment(w.title || "");
      await fbPut(`island/houses/${hid}/works/${wid}/cm`, { ...cm, ts: Date.now() });
      islCmDaily.set(dk, n); if (islCmDaily.size > 5000) islCmDaily.clear();
      islDirty();
      res.json({ ok: true, a: cm.a, t: cm.t });
    } finally { islCmBusy.delete(wid); }
  } catch (e) { gErr(res, e); }
});
/* 員工刪掉不適合的藝術家留言（刪了之後屋主可以再請一次） */
app.post("/island/comment/del", async (req, res) => {
  try {
    const body = req.body || {};
    const { staff } = await islWho(body);
    if (!staff) throw islErr("只有老師可以刪留言", "NOT_STAFF");
    const wid = String(body.id || ""), hid = String(body.house || "");
    if (!/^w[\w]{4,30}$/.test(wid) || !/^h[\w]{4,30}$/.test(hid)) throw islErr("找不到這件作品", "BAD_ID");
    await fbDel(`island/houses/${hid}/works/${wid}/cm`);
    islDirty();
    res.json({ ok: true });
  } catch (e) { gErr(res, e); }
});

/* ══════════════════════════════════════════════════════════
   作品小屋：訪客按讚／愛心／小花（2026-10-05 大熊要的）
   - 每件作品三種，有 LINE 登入的人才能按；每人每件每種一次，再按一次取消
   - 大家只看到數字；屋主（和老師）點開看得到是誰按的（有小屋就顯示小屋名字，沒有就用 LINE 名字）
   - 存在 island/houses/{hid}/works/{wid}/rx/{uid} = {l, h, f, n, ts}
   ══════════════════════════════════════════════════════════ */
const ISL_RX = ["l", "h", "f"];
function islRxCount(rx) {
  const c = { l: 0, h: 0, f: 0 };
  Object.values(rx || {}).forEach((r) => { if (r) ISL_RX.forEach((k) => { if (r[k]) c[k]++; }); });
  return c;
}
async function islRxView(hid, wid, uid, canSee) {
  const rx = (await fbGet(`island/houses/${hid}/works/${wid}/rx`)) || {};
  const me = rx[uid] || {};
  const out = { ok: true, rx: islRxCount(rx), mine: { l: !!me.l, h: !!me.h, f: !!me.f } };
  if (canSee) out.who = Object.values(rx).filter((r) => r && (r.l || r.h || r.f)).sort((a, b) => (b.ts || 0) - (a.ts || 0))
    .map((r) => ({ n: r.n || "訪客", l: !!r.l, h: !!r.h, f: !!r.f }));
  return out;
}
async function islRxCtx(body) {
  const { who, staff, key } = await islWho(body);
  const wid = String(body.id || ""), hid = String(body.house || "");
  if (!/^w[\w]{4,30}$/.test(wid) || !/^h[\w]{4,30}$/.test(hid)) throw islErr("找不到這件作品", "BAD_ID");
  const mine = key ? await fbGet(`island/owner/${key}`) : null;
  return { who, staff, wid, hid, mine: typeof mine === "string" ? mine : null, canSee: staff || hid === mine };
}
/* 打開作品時拿：數字、我按過哪些、（屋主）誰按的 */
app.post("/island/rx/get", async (req, res) => {
  try {
    const c = await islRxCtx(req.body || {});
    res.json(await islRxView(c.hid, c.wid, c.who.uid, c.canSee));
  } catch (e) { gErr(res, e); }
});
const islRxDaily = new Map();
app.post("/island/rx", async (req, res) => {
  try {
    const body = req.body || {};
    const k = String(body.k || "");
    if (!ISL_RX.includes(k)) throw islErr("不認得這個按鈕", "BAD_KIND");
    const c = await islRxCtx(body);
    const dk = c.who.uid + "|" + gDay(), n = (islRxDaily.get(dk) || 0) + 1;
    if (n > 600) throw islErr("今天按太多次了，明天再來", "TOO_MANY");
    islRxDaily.set(dk, n); if (islRxDaily.size > 5000) islRxDaily.clear();
    if (!(await fbGet(`island/houses/${c.hid}/works/${c.wid}/ts`))) throw islErr("找不到這件作品", "BAD_ID");
    const path = `island/houses/${c.hid}/works/${c.wid}/rx/${c.who.uid}`;
    const cur = (await fbGet(path)) || {};
    let name = c.who.displayName || "訪客";
    if (c.mine) { const hn = await fbGet(`island/houses/${c.mine}/name`); if (typeof hn === "string" && hn) name = hn; }
    const next = { l: !!cur.l, h: !!cur.h, f: !!cur.f, n: String(name).slice(0, 30), ts: Date.now() };
    next[k] = !next[k];
    if (!next.l && !next.h && !next.f) await fbDel(path); else await fbPut(path, next);
    islDirty();
    res.json(await islRxView(c.hid, c.wid, c.who.uid, c.canSee));
  } catch (e) { gErr(res, e); }
});

const PORT = process.env.PORT || 3000;
/* 2026-10-01 一次性：扭蛋改成畢卡索季並提前今天開始（大熊決定）。
   後台 Chrome 操作暫時連不上，改由伺服器開機時寫一次設定；寫過會記 migr 旗標，不會重複。
   只動這幾個欄位，其他設定（獎品、機率、上限、測試名單）維持後台原本的。 */
async function gMigratePicasso1001() {
  try {
    const c = await fbGet("gacha/config");
    if (!c || typeof c !== "object" || !Array.isArray(c.prizes)) return;
    if (c.migrPicasso1001) return;
    const next = {
      ...c,
      start: "2026-10-01",
      title: "世界藝術日・畢卡索扭扭樂",
      doubleDays: ["2026-10-25"], doubleLabel: "畢卡索生日加碼", halloweenDays: [],
      bears: [
        { id: "p01", nm: "經典條紋", w: 170 }, { id: "p02", nm: "和平鴿", w: 170 }, { id: "p06", nm: "花冠少年", w: 170 },
        { id: "p05", nm: "藍色吉他", w: 120 }, { id: "p03", nm: "哭泣的女人", w: 120 }, { id: "p04", nm: "自畫像", w: 120 },
        { id: "p07", nm: "彩色劍客", w: 50, rare: true }, { id: "p08", nm: "幾何面具", w: 50, rare: true },
        { id: "hbear", nm: "黑熊畢卡索", w: 20, rare: true, hidden: true }, { id: "hgold", nm: "金色和平鴿", w: 10, rare: true, hidden: true },
      ],
      bearTitle: "畢卡索圖鑑", bearUnit: "畢卡索公仔", bearImg: "gacha/picasso2/",
      boostDays: ["2026-10-25"], boostBear: "hgold", boostX: 2,
      migrPicasso1001: new Date().toISOString(), updatedAt: new Date().toISOString(), updatedBy: "畢卡索季設定（自動）",
    };
    await fbPut("gacha/config", next);
    console.log("gacha config: Picasso season applied, start 2026-10-01");
  } catch (e) { console.error("gMigratePicasso1001", e && e.message) }
}

/* 2026-10-01 大熊要求：把他自己今天轉過的次數歸零，讓他從頭再玩一次（只動今天那天的紀錄；
   抽到的紅利、公仔都保留）。電話不寫進公開 repo，用雜湊比對 testPhones；做過一次就不再做。 */
/* flag：每要重置一次就換一個新名字（大熊測試動畫要再轉，2026-10-01 晚第二次） */
async function gResetOwnerToday1001(flag) {
  try {
    if (gDay() !== "2026-10-01") return;
    const c = await fbGet("gacha/config");
    if (!c || typeof c !== "object" || c[flag]) return;
    const H = "86d6d0b805decee8a25769836ccfabe4fdc008accff085d2078bc22e6f3950ef";
    const phone = (c.testPhones || []).find((ph) => crypto.createHash("sha256").update(String(ph)).digest("hex") === H);
    let note = "not-found";
    if (phone) {
      const d = "2026-10-01";
      const p = (await fbGet(`gacha/players/${phone}`)) || {};
      await fbPost("gacha/adminlog", { at: new Date().toISOString(), what: "reset-today", day: d, before: { day: (p.days || {})[d] || null, bday: (p.bday || {})[d] || null } });
      await fbDel(`gacha/players/${phone}/days/${d}`);
      await fbDel(`gacha/players/${phone}/bday/${d}`);
      note = "done";
    }
    await fbPatch("gacha/config", { [flag]: note + " " + new Date().toISOString() });
    console.log("gacha: owner today reset", note);
  } catch (e) { console.error("gResetOwnerToday1001", e && e.message) }
}

app.listen(PORT, () => { console.log(`otto2-notify on ${PORT}`); gMigratePicasso1001().then(() => gResetOwnerToday1001("migrReset1001")).then(() => gResetOwnerToday1001("migrReset1001b")) });
