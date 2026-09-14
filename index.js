const express = require("express");
const axios = require("axios");

const db = require("./db");
const byl = require("./byl");
const msg = require("./messenger");

// --- SAFETY NET ---
// A single failed Facebook/byl.mn request should never take the whole bot down.
// This must be registered before anything else runs.
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection (not crashing):", reason?.message || reason);
});

process.on("uncaughtException", (err) => {
  console.error("Uncaught exception (not crashing):", err?.message || err);
});

const app = express();
app.use(express.json());

const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "mongolbee_verify";
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;

// --- PPT PRODUCT ---
const PPT_PRICE_MNT = 12000;
const PPT_DOWNLOAD_URL = "https://drive.google.com/file/d/1fMp-vFpijrGw3Rv4dty1O0tOcMw00Mca/view";

// Any of these typed exactly (after trim/lowercase) triggers the purchase flow.
const PPT_TRIGGERS = [
  "хөдөлгөөнт ppt авах",
  "хөдөлгөөнт багц",
  "хөдөлгөөнт ppt багц",
  "хөдөлгөөнт ppt",
  "powerpoint",
  "ppt",
];

function isPptTrigger(text) {
  const t = (text || "").trim().toLowerCase();
  return PPT_TRIGGERS.includes(t);
}

// --- WEBHOOK VERIFICATION (unchanged) ---
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("✅ Webhook verified!");
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// --- RECEIVE MESSAGES ---
app.post("/webhook", async (req, res) => {
  const body = req.body;
  if (body.object !== "page") return res.sendStatus(404);

  for (const entry of body.entry) {
    for (const event of entry.messaging) {
      const senderId = event.sender.id;
      const text = event.message?.text || "";

      // PPT purchase trigger
      if (isPptTrigger(text)) {
        try {
          await handlePptPurchase(senderId);
        } catch (err) {
          console.error("PPT purchase error:", err.response?.data || err.message);
          try {
            await msg.sendText(senderId, "Уучлаарай, алдаа гарлаа. Түр хүлээгээд дахин оролдоно уу.");
          } catch (sendErr) {
            console.error("Also failed to notify sender:", sendErr.response?.data || sendErr.message);
          }
        }
        continue;
      }

      // Anything not recognized by the purchase flow is now simply ignored
      // (fallback menu removed).
    }
  }

  res.status(200).send("EVENT_RECEIVED");
});

async function handlePptPurchase(senderId) {
  const invoice = await byl.createInvoice(PPT_PRICE_MNT, "Mongolbee - Хөдөлгөөнт PPT багц");
  await db.createOrder(senderId, invoice.id, invoice.number);

  await msg.sendButton(
    senderId,
    `1,000 слайд, 66 төрлийн Хөдөлгөөнт PPT багц — ${PPT_PRICE_MNT.toLocaleString()}₮. Төлбөр төлөгдмөгц таны чат руу илгээх болно:`,
    invoice.url,
    "QPAY төлөх"
  );

  await msg.sendText(
    senderId,
    `Хэрэв дээрх товч ажиллахгүй бол энэ холбоос дээр удаан дараад "Нээх Safari-аар" сонголтыг хийнэ үү:\n${invoice.url}`
  );
}

// --- SAFARI ESCAPE PAGE (for iPhone users stuck in Messenger's in-app browser) ---
// QPay/bank apps can't open properly inside Facebook Messenger's built-in
// browser on iOS. This page tries an automatic escape trick (x-safari-https://,
// unreliable inside Meta's own apps but harmless to attempt) and — regardless
// of whether that works — always shows clear manual instructions plus a
// direct link, so nobody gets stuck on a blank screen.
app.get("/pay-redirect", (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl || !targetUrl.startsWith("http")) {
    return res.status(400).send("Missing or invalid url parameter");
  }

  const safariAttemptUrl = "x-safari-" + targetUrl.replace(/^https?:\/\//, "https://");
  const safeTargetUrl = targetUrl.replace(/"/g, "&quot;");
  const safeSafariUrl = safariAttemptUrl.replace(/"/g, "&quot;");

  res.status(200).send(`<!DOCTYPE html>
<html lang="mn">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Төлбөр рүү шилжиж байна...</title>
<style>
  body { font-family: -apple-system, sans-serif; background: #fff7fa; margin: 0; padding: 24px 16px; color: #101018; }
  .card { max-width: 480px; margin: 0 auto; background: #fff; border: 1px solid #ffd0dd; border-radius: 16px; padding: 24px; }
  h1 { font-size: 20px; margin: 0 0 12px; }
  p { font-size: 15px; line-height: 1.6; color: #444; }
  .steps { background: #fafafa; border: 1px solid #eee; border-radius: 12px; padding: 16px; margin: 16px 0; }
  .steps ol { margin: 0; padding-left: 20px; }
  .steps li { margin-bottom: 8px; font-size: 15px; }
  .btn { display: block; text-align: center; background: #f71355; color: #fff; text-decoration: none;
         padding: 14px; border-radius: 10px; font-weight: 700; font-size: 15px; margin-top: 8px; }
  .badge { display: inline-block; background: #fff0f5; border: 1px solid #ffb8cc; border-radius: 999px;
           color: #f71355; font-size: 12px; font-weight: 800; padding: 6px 10px; margin-bottom: 12px; }
</style>
</head>
<body>
  <div class="card">
    <div class="badge">ТӨЛБӨРИЙН ХОЛБООС</div>
    <h1>Банкны апп нээгдэхгүй бол энэ алхмуудыг хийнэ үү</h1>
    <p>Дараагийн хуудсанд орж, банкаа сонгож дарахад заримдаа юу ч болохгүй байж болно. Ийм тохиолдолд:</p>
    <div class="steps">
      <ol>
        <li>Доорх товч дээр дарж төлбөрийн хуудсанд орно уу</li>
        <li>Банкаа сонгоод дарахад юу ч болохгүй бол дэлгэцийн дээд буланд байгаа <strong>"•••"</strong> товч дээр дарна уу</li>
        <li><strong>"Нээх Safari-аар"</strong> сонголтыг дарж, дараа нь банкаа дахин сонгоно уу</li>
      </ol>
    </div>
    <a class="btn" href="${safeTargetUrl}">Төлбөрийн хуудас руу очих →</a>
  </div>
  <script>
    // Best-effort automatic attempt — silently does nothing if unsupported.
    try {
      window.location.href = "${safeSafariUrl}";
    } catch (e) {}
  </script>
</body>
</html>`);
});

// --- byl.mn PAYMENT WEBHOOK ---
// Configure this URL (https://<your-mongolbee-railway-domain>/webhook/byl) as
// the project webhook in the byl.mn dashboard, subscribed to invoice.paid.
app.post("/webhook/byl", async (req, res) => {
  res.status(200).send("OK"); // ack immediately, do the work after

  const event = req.body;
  if (event.type !== "invoice.paid") return;

  const invoice = event.data?.object;
  if (!invoice) return;

  const order = await db.getOrderByInvoiceId(invoice.id);
  if (!order) {
    console.warn("No PPT order found for paid invoice", invoice.id);
    return;
  }

  try {
    await db.markOrderPaid(invoice.id);
    await msg.sendText(order.sender_id, "Төлбөр хүлээн авлаа ✅ Баярлалаа!");
    await msg.sendButtons(
      order.sender_id,
      "Таны Хөдөлгөөнт PPT багцыг татаж авах холбоос доор байна. Компьютер дээр татаж аваад, PowerPoint дээр нээгээд ашиглаж эхлээрэй:",
      [
        { title: "Татаж авах", url: PPT_DOWNLOAD_URL },
        { title: "Excel файл үзэх", url: "https://mongolbee.beez.mn/" },
      ]
    );
  } catch (err) {
    console.error("PPT delivery failed:", err.response?.data || err.message);
    try {
      await msg.sendText(
        order.sender_id,
        "Татаж авах холбоосыг илгээхэд алдаа гарлаа. Манай тусламжийн баг тантай удахгүй холбогдоно."
      );
    } catch (sendErr) {
      console.error("Also failed to notify sender of delivery error:", sendErr.response?.data || sendErr.message);
    }
  }
});

// --- START SERVER ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🐝 Mongolbee bot running on port ${PORT}`));
