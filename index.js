const express = require("express");
const axios = require("axios");

const db = require("./db");
const byl = require("./byl");
const msg = require("./messenger");

const app = express();
app.use(express.json());

const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "mongolbee_verify";
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;

const GRAPH_URL = "https://graph.facebook.com/v19.0/me/messages";

// --- PPT PRODUCT ---
const PPT_PRICE_MNT = 12000;
const PPT_DOWNLOAD_URL = "https://drive.google.com/file/d/1fMp-vFpijrGw3Rv4dty1O0tOcMw00Mca/view";

// Any of these typed exactly (after trim/lowercase) triggers the purchase flow.
const PPT_TRIGGERS = [
  "хөдөлгөөнт ppt авах",
  "хөдөлгөөнт багц",
  "хөдөлгөөнт ppt багц",
  "хөдөлгөөнт ppt",
];

function isPptTrigger(text) {
  const t = (text || "").trim().toLowerCase();
  return PPT_TRIGGERS.includes(t);
}

// --- PRODUCTS WITH BUTTONS (existing menu, unchanged) ---
const MENU = [
  {
    title: "Хөдөлгөөнт Powerpoint",
    url: "https://mongolbee.beez.mn/%D0%B1%D2%AF%D1%82%D1%8D%D1%8D%D0%B3%D0%B4%D1%8D%D1%85%D2%AF%D2%AF%D0%BD/%d1%85%d3%a9%d0%b4%d3%a9%d0%bb%d0%b3%d3%a9%d3%a9%d0%bd%d1%82-ppt-%d0%b1%d0%b0%d0%b3%d1%86-2/",
  },
  {
    title: "Бизнес тэмплэт",
    url: "https://mongolbee.beez.mn/",
  },
  {
    title: "Карьер оношилгоо",
    url: "https://mongolbee.beez.mn/%d0%b0%d0%b6%d0%b8%d0%bb-%d0%bc%d1%8d%d1%80%d0%b3%d1%8d%d0%b6%d0%bb%d0%b8%d0%b9%d0%bd-%d0%bd%d0%b0%d0%b2%d0%b8%d0%b3%d0%b0%d1%82%d0%be%d1%80-%d0%be%d0%bd%d0%be%d1%88%d0%b8%d0%bb%d0%b3%d0%be%d0%be/",
  },
  {
    title: "Бизнес KPI оношилгоо",
    url: "https://mongolbee.beez.mn/%d0%b0%d0%b6%d0%b8%d0%bb-%d0%bc%d1%8d%d1%80%d0%b3%d1%8d%d0%b6%d0%bb%d0%b8%d0%b9%d0%bd-%d0%bd%d0%b0%d0%b2%d0%b8%d0%b3%d0%b0%d1%82%d0%be%d1%80-%d0%be%d0%bd%d0%be%d1%88%d0%b8%d0%bb%d0%b3%d0%be%d0%be/",
  },
  {
    title: "Дата скрапер",
    url: "https://mongolbee.beez.mn/%d0%b1%d0%b8%d0%b7%d0%bd%d0%b5%d1%81-%d0%b4%d0%b0%d1%82%d0%b0/",
  },
  {
    title: "Beez QR Menu",
    url: "https://qrmenu.beez.mn/",
  },
];

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

      // NEW: PPT purchase trigger
      if (isPptTrigger(text)) {
        try {
          await handlePptPurchase(senderId);
        } catch (err) {
          console.error("PPT purchase error:", err.response?.data || err.message);
          await msg.sendText(senderId, "Уучлаарай, алдаа гарлаа. Түр хүлээгээд дахин оролдоно уу.");
        }
        continue;
      }

      // ORIGINAL BEHAVIOR: any other message or postback shows the menu.
      if (event.message || event.postback) {
        await sendGreeting(senderId);
        await sendButtonMenu(senderId);
      }
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
    await msg.sendButton(
      order.sender_id,
      "Таны Хөдөлгөөнт PPT багцыг татаж авах холбоос доор байна. Татаж аваад, PowerPoint дээр нээгээд ашиглаж эхлээрэй:",
      PPT_DOWNLOAD_URL,
      "Татаж авах"
    );
  } catch (err) {
    console.error("PPT delivery failed:", err.response?.data || err.message);
    await msg.sendText(
      order.sender_id,
      "Татаж авах холбоосыг илгээхэд алдаа гарлаа. Манай тусламжийн баг тантай удахгүй холбогдоно."
    );
  }
});

// --- GREETING MESSAGE (unchanged) ---
async function sendGreeting(recipientId) {
  await axios.post(
    GRAPH_URL,
    {
      recipient: { id: recipientId },
      message: {
        text: "Сайн байна уу! 👋 Mongolbee-д тавтай морилно уу!\nТа юугаар туслуулах вэ?",
      },
    },
    { params: { access_token: PAGE_ACCESS_TOKEN } }
  );
}

// --- BUTTON MENU (unchanged) ---
async function sendButtonMenu(recipientId) {
  const batch1 = MENU.slice(0, 3);
  const batch2 = MENU.slice(3);

  await sendButtons(recipientId, "🛍️ Манай бүтээгдэхүүнүүд:", batch1);

  if (batch2.length > 0) {
    await sendButtons(recipientId, "✨ Бусад бүтээгдэхүүнүүд:", batch2);
  }
}

async function sendButtons(recipientId, text, items) {
  const buttons = items.map((item) => ({
    type: "web_url",
    url: item.url,
    title: item.title,
    webview_height_ratio: "full",
  }));

  await axios.post(
    GRAPH_URL,
    {
      recipient: { id: recipientId },
      message: {
        attachment: {
          type: "template",
          payload: {
            template_type: "button",
            text: text,
            buttons: buttons,
          },
        },
      },
    },
    { params: { access_token: PAGE_ACCESS_TOKEN } }
  );
}

// --- START SERVER ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🐝 Mongolbee bot running on port ${PORT}`));
