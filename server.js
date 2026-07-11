import express from "express";
import Anthropic from "@anthropic-ai/sdk";
import fs from "fs";

const app = express();
app.use(express.json());

// Loại BỎ mọi ký tự không phải ASCII in được (khoảng trắng, \r, \n, ký tự ẩn...)
// khỏi key/token — tránh lỗi "not a legal HTTP header value" khi copy-paste biến
// môi trường dính ký tự rác (kể cả nằm giữa chuỗi). Key/token/ID đều thuần ASCII,
// không có dấu cách hợp lệ, nên cắt sạch là an toàn.
const clean = (v) => (typeof v === "string" ? v.replace(/[^\x21-\x7E]/g, "") : v);
const WHATSAPP_TOKEN = clean(process.env.WHATSAPP_TOKEN);     // token truy cập từ Meta
const PHONE_NUMBER_ID = clean(process.env.PHONE_NUMBER_ID);   // ID số WhatsApp (từ Meta)
const VERIFY_TOKEN = clean(process.env.VERIFY_TOKEN);         // chuỗi tùy ý mình đặt, verify webhook
const ANTHROPIC_API_KEY = clean(process.env.ANTHROPIC_API_KEY); // API key Claude
const PORT = process.env.PORT || 3000;

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

// Bộ đệm sự kiện gần đây để chẩn đoán (chỉ trong RAM, tối đa 20).
const recentEvents = [];
function logEvent(ev) {
  recentEvents.push({ t: new Date().toISOString(), ...ev });
  if (recentEvents.length > 20) recentEvents.shift();
  console.log("[webhook]", JSON.stringify(ev));
}

// --- Nhận tin nhắn đến ---
app.post("/webhook", async (req, res) => {
  res.sendStatus(200); // trả 200 ngay để Meta không gửi lại
  try {
    const value = req.body?.entry?.[0]?.changes?.[0]?.value;
    const msg = value?.messages?.[0];
    if (!msg) {
      // status update (sent/delivered/read) hoặc payload khác — ghi lại để debug
      logEvent({ kind: value?.statuses ? "status:" + value.statuses[0].status : "non-message" });
      return;
    }
    if (msg.type !== "text") { logEvent({ kind: "non-text", type: msg.type }); return; }

    const from = msg.from;          // số điện thoại khách
    const text = msg.text.body;     // nội dung khách nhắn
    logEvent({ kind: "message-in", from, text });

    let reply;
    try {
      reply = await askClaude(from, text);
    } catch (e) {
      logEvent({ kind: "claude-error", name: e?.name, status: e?.status, message: String(e?.message || e).slice(0, 150), cause: String(e?.cause?.code || e?.cause?.message || "").slice(0, 120) });
      throw e;
    }

    if (reply) {
      try {
        await sendWhatsApp(from, reply);
        logEvent({ kind: "reply-sent", from, reply: reply.slice(0, 80) });
      } catch (e) {
        logEvent({ kind: "whatsapp-send-error", message: String(e?.message || e).slice(0, 150), cause: String(e?.cause?.code || "").slice(0, 120) });
        throw e;
      }
    }
  } catch (e) {
    console.error("Handler error:", e);
  }
});

// Endpoint debug: xem sự kiện gần đây. Bảo vệ bằng verify token.
app.get("/debug", (req, res) => {
  if (req.query.token !== VERIFY_TOKEN) return res.sendStatus(403);
  res.json({ count: recentEvents.length, events: recentEvents });
});

// Tự-test: gọi thử Claude từ chính Railway để chẩn đoán kết nối ra ngoài.
app.get("/debug/ping", async (req, res) => {
  if (req.query.token !== VERIFY_TOKEN) return res.sendStatus(403);
  const out = {
    version: "sanitize-v3",
    lengths: {
      ANTHROPIC_API_KEY: (ANTHROPIC_API_KEY || "").length,   // đúng: 108
      WHATSAPP_TOKEN: (WHATSAPP_TOKEN || "").length,          // đúng: 199
      PHONE_NUMBER_ID: (PHONE_NUMBER_ID || "").length,        // đúng: 16
      VERIFY_TOKEN: (VERIFY_TOKEN || "").length,              // đúng: 41
    },
  };
  try {
    const r = await anthropic.messages.create({
      model: MODEL, max_tokens: 10, messages: [{ role: "user", content: "ping" }],
    });
    out.ok = true;
    out.reply = r.content.map((b) => b.text).join("");
  } catch (e) {
    out.ok = false;
    out.name = e?.name;
    out.status = e?.status;
    out.message = String(e?.message || e).slice(0, 200);
    out.cause = String(e?.cause?.code || e?.cause?.message || "").slice(0, 150);
  }
  res.json(out);
});

app.get("/", (_, res) => res.send("MP Beauty WhatsApp bot is running."));
app.listen(PORT, () => console.log(`Listening on :${PORT}`));
