# MP Beauty — WhatsApp Chatbot (Claude API)

Bot trả lời tin nhắn khách trên WhatsApp bằng Claude, dùng đúng bộ hướng dẫn CSKH và bảng giá của MP Beauty (`system-prompt.md`).

## Kiến trúc

```
Khách nhắn WhatsApp
      │
      ▼
WhatsApp Cloud API (Meta)  ──webhook──►  server.js (bot này)
      ▲                                        │
      │                                        ▼
      └────────── gửi trả lời ◄──────  Claude API (Haiku 4.5)
                                        (system prompt = hướng dẫn + bảng giá)
```

## Chuẩn bị (một lần)

### A. Bên Anthropic
1. Vào platform.claude.com → tạo **API key** → điền vào `ANTHROPIC_API_KEY`.

### B. Bên Meta (WhatsApp Cloud API)
1. Tạo **Meta Business account** và xác minh doanh nghiệp.
2. Tạo một **App** tại developers.facebook.com → thêm sản phẩm **WhatsApp**.
3. Lấy **Phone number ID** → điền `PHONE_NUMBER_ID`.
4. Tạo **access token** (khuyến nghị token vĩnh viễn qua System User) → điền `WHATSAPP_TOKEN`.
5. Tự đặt một chuỗi bất kỳ cho `VERIFY_TOKEN` (ví dụ `mpbeauty2026`).

> Số WhatsApp Business App hiện tại có thể dùng đồng thời với Cloud API (coexistence).

## Chạy thử local

```bash
npm install
cp .env.example .env    # rồi điền giá trị thật
npm start
```

Server chạy ở `http://localhost:3000`. Vì Meta cần URL HTTPS public, khi test local hãy dùng
`ngrok http 3000` để lấy một URL public tạm.

## Cấu hình webhook trên Meta

Trong App → WhatsApp → Configuration → Webhook:
- **Callback URL:** `https://<domain-cua-ban>/webhook`
- **Verify token:** đúng chuỗi đã đặt ở `VERIFY_TOKEN`
- Subscribe field: **messages**

Meta sẽ gọi `GET /webhook` để xác minh (code đã xử lý sẵn).

## Triển khai (chọn 1)

Bất kỳ nơi nào chạy được Node 18+ và cho URL HTTPS public:
- **Railway / Render / Fly.io** — deploy từ git, đặt các biến môi trường trong dashboard.
- Đặt `PORT` theo yêu cầu nền tảng (thường tự inject).

## Lưu ý vận hành

- **Cửa sổ 24h:** bot chỉ nên trả lời khi khách nhắn trước (miễn phí trong 24h). Muốn chủ động
  nhắn ra ngoài 24h phải dùng **template đã được Meta duyệt** (chưa có trong MVP này).
- **Lịch sử hội thoại** đang lưu trong RAM → mất khi restart. Production nên chuyển sang Redis/DB.
- **Prompt caching** đã bật cho system prompt → chi phí Claude API rất thấp (~$0.002/lượt).
- Bot chỉ xử lý **tin text** trong MVP. Ảnh/nút/định vị có thể bổ sung sau.

## Cập nhật bảng giá / hướng dẫn

Sửa nội dung trong `system-prompt.md` (phần dưới là bảng giá) rồi restart server.
