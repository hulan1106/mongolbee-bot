const express = require("express");
const axios = require("axios");

const db = require("./db");
const byl = require("./byl");
const msg = require("./messenger");

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
          await msg.sendText(senderId, "Уучлаарай, алдаа гарлаа. Түр хүлээгээд дахин оролдоно уу.");
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
    `Хөдөлгөөнт PPT багц — ${PPT_PRICE_MNT.toLocaleString()}₮. Төлбөрөө төлж татаж авах холбоосоо шууд аваарай:`,
    invoice.url,
    "Төлбөр төлөх"
  );
}

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
    await msg.sendText(
      order.sender_id,
      "Татаж авах холбоосыг илгээхэд алдаа гарлаа. Манай тусламжийн баг тантай удахгүй холбогдоно."
    );
  }
});

// --- START SERVER ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🐝 Mongolbee bot running on port ${PORT}`));
