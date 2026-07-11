import express from "express";
import Anthropic from "@anthropic-ai/sdk";
import fs from "fs";

const app = express();
app.use(express.json());

const {
  WHATSAPP_TOKEN,     // token truy cập từ Meta
  PHONE_NUMBER_ID,    // ID số WhatsApp (từ Meta)
  VERIFY_TOKEN,       // chuỗi tùy ý mình đặt, dùng khi verify webhook
  ANTHROPIC_API_KEY,  // API key Claude
  PORT = 3000,
} = process.env;

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
const MODEL = "claude-haiku-4-5-20251001"; // model rẻ nhất, hợp chatbot
const SYSTEM_PROMPT = fs.readFileSync(new URL("./system-prompt.md", import.meta.url), "utf8");

// Lịch sử hội thoại theo số điện thoại (MVP: lưu trong RAM).
// Production nên thay bằng Redis/DB để không mất khi restart.
const history = new Map();
const MAX_TURNS = 10;

function getHistory(from) {
  if (!history.has(from)) history.set(from, []);
  return history.get(from);
}

async function askClaude(from, userText) {
  const msgs = getHistory(from);
  msgs.push({ role: "user", content: userText });

  const resp = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: [
      {
        type: "text",
        text: SYSTEM_PROMPT,
        // cache bộ hướng dẫn + bảng giá -> giảm ~90% chi phí input các lượt sau
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: msgs,
  });

  const reply = resp.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();

  msgs.push({ role: "assistant", content: reply });
  // giữ lịch sử gọn để tiết kiệm token
  if (msgs.length > MAX_TURNS * 2) msgs.splice(0, msgs.length - MAX_TURNS * 2);
  return reply;
}

async function sendWhatsApp(to, text) {
  const url = `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`;
  const r = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: text },
    }),
  });
  if (!r.ok) console.error("WhatsApp send error:", r.status, await r.text());
}

// --- Xác minh webhook: Meta gọi 1 lần khi mình cấu hình ---
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

// --- Nhận tin nhắn đến ---
app.post("/webhook", async (req, res) => {
  res.sendStatus(200); // trả 200 ngay để Meta không gửi lại
  try {
    const value = req.body?.entry?.[0]?.changes?.[0]?.value;
    const msg = value?.messages?.[0];
    if (!msg || msg.type !== "text") return; // MVP: chỉ xử lý tin text

    const from = msg.from;          // số điện thoại khách
    const text = msg.text.body;     // nội dung khách nhắn
    const reply = await askClaude(from, text);
    if (reply) await sendWhatsApp(from, reply);
  } catch (e) {
    console.error("Handler error:", e);
  }
});

app.get("/", (_, res) => res.send("MP Beauty WhatsApp bot is running."));
app.listen(PORT, () => console.log(`Listening on :${PORT}`));
