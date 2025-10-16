// index.js — LINE 晚餐輪盤（Google Sheets 永久保存版）
// 需求：express, @line/bot-sdk, googleapis

const express = require("express");
const { Client, validateSignature } = require("@line/bot-sdk");
const { google } = require("googleapis");

// ====== 環境變數 ======
const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const SPREADSHEET_ID = process.env.GOOGLE_SHEET_ID;
const SHEET_TAB = process.env.GOOGLE_SHEET_TAB || "Sheet1";

// ====== Google Sheets Auth ======
const sheets = google.sheets("v4");
const auth = new google.auth.JWT(
  process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
  null,
  (process.env.GOOGLE_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
  ["https://www.googleapis.com/auth/spreadsheets"]
);

// 啟動授權（重要，能提早發現 key/權限問題）
(async () => {
  try {
    await auth.authorize();
    console.log("[Sheets] Authorized OK");
  } catch (e) {
    console.error("[Sheets] authorize() failed:", e);
  }
})();

// ====== 小工具 ======
function getChatKey(source) {
  if (source.type === "user") return `user:${source.userId}`;
  if (source.type === "group") return `group:${source.groupId}`;
  if (source.type === "room") return `room:${source.roomId}`;
  return "unknown";
}

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function quickReply() {
  return {
    items: [
      { type: "action", action: { type: "message", label: "再抽一次", text: "吃什麼" } },
      { type: "action", action: { type: "message", label: "看清單", text: "清單" } },
      { type: "action", action: { type: "message", label: "教我用", text: "說明" } },
    ],
  };
}

// ====== Google Sheets 讀/寫 ======
async function getMenu(chatKey) {
  try {
    const res = await sheets.spreadsheets.values.get({
      auth,
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_TAB}!A:B`,
    });
    const rows = res.data.values || [];
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (row[0] === chatKey) {
        return row[1] ? row[1].split(",").map(s => s.trim()).filter(Boolean) : [];
      }
    }
    return [];
  } catch (e) {
    console.error("[Sheets] getMenu error:", e && e.response ? e.response.data : e);
    throw e;
  }
}

async function setMenu(chatKey, menu) {
  try {
    const res = await sheets.spreadsheets.values.get({
      auth,
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_TAB}!A:B`,
    });
    const rows = res.data.values || [];

    let rowIndex = -1;
    for (let i = 0; i < rows.length; i++) {
      if (rows[i][0] === chatKey) { rowIndex = i; break; }
    }

    if (rowIndex >= 0) {
      await sheets.spreadsheets.values.update({
        auth,
        spreadsheetId: SPREADSHEET_ID,
        range: `${SHEET_TAB}!B${rowIndex + 1}:B${rowIndex + 1}`,
        valueInputOption: "RAW",
        requestBody: { values: [[ menu.join(", ") ]] },
      });
      console.log(`[Sheets] updated row ${rowIndex + 1} for ${chatKey}`);
    } else {
      await sheets.spreadsheets.values.append({
        auth,
        spreadsheetId: SPREADSHEET_ID,
        range: `${SHEET_TAB}!A:B`,
        valueInputOption: "RAW",
        insertDataOption: "INSERT_ROWS",
        requestBody: { values: [[ chatKey, menu.join(", ") ]] },
      });
      console.log(`[Sheets] appended new row for ${chatKey}`);
    }
  } catch (e) {
    console.error("[Sheets] setMenu error:", e && e.response ? e.response.data : e);
    throw e;
  }
}

// ====== Express 應用 ======
const app = express();

// LINE 需要原始字串計算簽章，因此用 text 讀 body
app.use(express.text({ type: "*/*" }));

// 健康檢查
app.get("/", (_, res) => res.send("OK"));

// Webhook
app.post("/webhook", async (req, res) => {
  const signature = req.headers["x-line-signature"];

  // 1) 驗簽
  const ok = validateSignature(req.body, config.channelSecret, signature);
  if (!ok) {
    return res.status(401).send("Invalid signature");
  }

  // 2) LINE 的 Verify 會傳純文字 'test'，不是 JSON → 直接 200
  if (typeof req.body === "string") {
    try {
      JSON.parse(req.body);
    } catch {
      return res.status(200).send("OK");
    }
  }

  // 3) 事件處理
  let body;
  try {
    body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  } catch (e) {
    // 保險：避免重試風暴
    console.error("[Webhook] JSON parse error:", e);
    return res.status(200).send("OK");
  }

  const client = new Client(config);
  const events = body.events || [];

  await Promise.all(events.map(async (event) => {
    // 進群打招呼（可選）
    if (event.type === "join" || event.type === "memberJoined") {
      return client.replyMessage(event.replyToken, {
        type: "text",
        text: "大家好～輸入「吃什麼」幫你們決定晚餐 🍱",
      });
    }

    if (event.type !== "message" || event.message.type !== "text") return;
    const replyToken = event.replyToken;
    const text = (event.message.text || "").trim();
    const chatKey = getChatKey(event.source);

    // /id：顯示目前聊天室 ID
    if (text === "/id") {
      return client.replyMessage(replyToken, { type: "text", text: `chatKey: ${chatKey}` });
    }

    // /debug：強制寫入一筆 DEBUG項目 到 Google Sheet
    if (text === "/debug") {
      try {
        let menu = await getMenu(chatKey);
        if (!menu.includes("DEBUG項目")) menu.push("DEBUG項目");
        await setMenu(chatKey, menu);
        return client.replyMessage(replyToken, { type: "text", text: "Debug：已嘗試寫入 Google Sheet ✅" });
      } catch (e) {
        const msg = e && e.response && e.response.data ? JSON.stringify(e.response.data) : (e.message || String(e));
        return client.replyMessage(replyToken, { type: "text", text: `Debug 寫入失敗：${msg}` });
      }
    }

    // 一般功能
    try {
      if (text === "吃什麼" || text === "/吃什麼") {
        let menu = await getMenu(chatKey);
        if (!menu.length) {
          return client.replyMessage(replyToken, {
            type: "text",
            text: "清單是空的，先用「/加 牛肉麵」加入幾個吧！",
            quickReply: quickReply(),
          });
        }
        const choice = pickRandom(menu);
        return client.replyMessage(replyToken, [
          { type: "text", text: `今晚吃：${choice} 🍽️`, quickReply: quickReply() },
        ]);
      }

      if (text === "清單" || text === "/清單") {
        let menu = await getMenu(chatKey);
        const list = menu.length ? menu.join("、") : "（目前沒有項目）";
        return client.replyMessage(replyToken, {
          type: "text",
          text: `目前清單：\n${list}`,
          quickReply: quickReply(),
        });
      }

      if (text.startsWith("/加 ")) {
        const item = text.replace("/加", "").trim();
        if (!item) {
          return client.replyMessage(replyToken, { type: "text", text: "輸入格式：/加 品項名" });
        }
        let menu = await getMenu(chatKey);
        if (!menu.includes(item)) menu.push(item);
        await setMenu(chatKey, menu);
        return client.replyMessage(replyToken, {
          type: "text",
          text: `已加入：${item}\n目前共 ${menu.length} 項。`,
          quickReply: quickReply(),
        });
      }

      if (text.startsWith("/刪 ")) {
        const item = text.replace("/刪", "").trim();
        if (!item) {
          return client.replyMessage(replyToken, { type: "text", text: "輸入格式：/刪 品項名" });
        }
        let menu = await getMenu(chatKey);
        menu = menu.filter(x => x !== item);
        await setMenu(chatKey, menu);
        return client.replyMessage(replyToken, {
          type: "text",
          text: `已刪除：${item}\n目前共 ${menu.length} 項。`,
          quickReply: quickReply(),
        });
      }

      if (text === "說明" || text === "/說明" || text.toLowerCase() === "help") {
        return client.replyMessage(replyToken, {
          type: "text",
          text:
            "用法：\n" +
            "・輸入「吃什麼」→ 隨機抽一個\n" +
            "・/清單 → 查看清單\n" +
            "・/加 品項名 → 加入清單（例：/加 牛肉麵）\n" +
            "・/刪 品項名 → 從清單移除（例：/刪 拉麵）\n" +
            "・/id → 顯示這個聊天室的 ID\n" +
            "・/debug → 測試寫入 Google Sheet",
          quickReply: quickReply(),
        });
      }

      // 非指令：提示
      return client.replyMessage(replyToken, {
        type: "text",
        text: "輸入「吃什麼」來抽晚餐 🎲；或打「/說明」看用法。",
        quickReply: quickReply(),
      });
    } catch (e) {
      console.error("[Handler] error:", e);
      // 回一個通用錯誤訊息，避免 LINE 重試
      return client.replyMessage(replyToken, {
        type: "text",
        text: "抱歉，我這邊出了一點狀況，等一下再試一次 ><",
      });
    }
  }));

  res.status(200).end();
});

// ====== 啟動 ======
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Listening on ${port}`));
