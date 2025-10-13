const express = require("express");
const { Client, middleware, validateSignature } = require("@line/bot-sdk");

// ====== 環境變數（稍後在 Vercel 填） ======
const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const app = express();

// LINE 驗簽需要原始字串，因此先用 text 取原始 body
app.use(express.text({ type: "*/*" }));

// ====== 超簡單儲存（重開機會清空，先讓你跑起來） ======
const menuByChat = new Map();
const defaultMenu = ["牛肉麵", "拉麵", "炒飯", "便當", "壽司", "鹽水雞", "水餃", "咖哩", "義大利麵", "越南河粉"];

function getChatKey(source) {
  if (source.type === "user") return `user:${source.userId}`;
  if (source.type === "group") return `group:${source.groupId}`;
  if (source.type === "room") return `room:${source.roomId}`;
  return "unknown";
}
function getMenuForChat(key) {
  if (!menuByChat.has(key)) menuByChat.set(key, [...defaultMenu]);
  return menuByChat.get(key);
}
function setMenuForChat(key, arr) {
  menuByChat.set(key, arr);
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
function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

app.post("/webhook", async (req, res) => {
  const signature = req.headers["x-line-signature"];
  if (!validateSignature(req.body, config.channelSecret, signature)) {
    return res.status(401).send("Invalid signature");
  }

  const body = JSON.parse(req.body);
  const client = new Client(config);
  const events = body.events || [];

  await Promise.all(events.map(async (event) => {
    if (event.type !== "message" || event.message.type !== "text") return;

    const chatKey = getChatKey(event.source);
    const menu = getMenuForChat(chatKey);
    const text = (event.message.text || "").trim();
    const replyToken = event.replyToken;

    if (text === "吃什麼" || text === "/吃什麼") {
      if (menu.length === 0) {
        return client.replyMessage(replyToken, {
          type: "text",
          text: "清單是空的，先用「/加 牛肉麵」加入幾個吧！",
          quickReply: quickReply(),
        });
      }
      const choice = pickRandom(menu);
      return client.replyMessage(replyToken, [
        {
          type: "flex",
          altText: `今晚吃：${choice}`,
          contents: {
            type: "bubble",
            body: {
              type: "box",
              layout: "vertical",
              contents: [
                { type: "text", text: "今晚吃這個 👇", weight: "bold", size: "md" },
                { type: "text", text: choice, weight: "bold", size: "xxl", margin: "md" },
                { type: "separator", margin: "lg" },
                { type: "text", text: "不滿意？點「再抽一次」", size: "sm", color: "#888888", margin: "md" },
              ],
            },
          },
        },
        { type: "text", text: `🎯 抽到：${choice}`, quickReply: quickReply() },
      ]);
    }

    if (text === "清單" || text === "/清單") {
      const list = menu.length ? menu.join("、") : "（目前沒有項目）";
      return client.replyMessage(replyToken, {
        type: "text",
        text: `目前清單：\n${list}\n\n指令：\n/加 牛肉麵\n/刪 拉麵\n/吃什麼（或「吃什麼」）`,
        quickReply: quickReply(),
      });
    }

    if (text === "說明" || text === "/說明" || text === "help") {
      return client.replyMessage(replyToken, {
        type: "text",
        text:
          "用法：\n" +
          "・輸入「吃什麼」→ 隨機抽一個\n" +
          "・/清單 → 查看清單\n" +
          "・/加 品項名 → 加入清單（例：/加 牛肉麵）\n" +
          "・/刪 品項名 → 從清單移除（例：/刪 拉麵）\n" +
          "・把機器人拉進群組就能一起用",
        quickReply: quickReply(),
      });
    }

    if (text.startsWith("/加 ")) {
      const item = text.replace("/加", "").trim();
      if (!item) {
        return client.replyMessage(replyToken, { type: "text", text: "輸入格式：/加 品項名" });
      }
      if (!menu.includes(item)) {
        menu.push(item);
        setMenuForChat(chatKey, menu);
      }
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
      const newMenu = menu.filter((x) => x !== item);
      setMenuForChat(chatKey, newMenu);
      return client.replyMessage(replyToken, {
        type: "text",
        text: `已刪除：${item}\n目前共 ${newMenu.length} 項。`,
        quickReply: quickReply(),
      });
    }

    return client.replyMessage(replyToken, {
      type: "text",
      text: "輸入「吃什麼」來抽晚餐 🎲；或打「/說明」看用法。",
      quickReply: quickReply(),
    });
  }));

  res.status(200).end();
});

// 健康檢查
app.get("/", (_, res) => res.send("OK"));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Listening on ${port}`));
