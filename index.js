const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");

const db = require("./db");
const byl = require("./byl");
const msg = require("./messenger");
const bank = require("./bank");

// --- SAFETY NET ---
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
const BANK_WEBHOOK_SECRET = process.env.BANK_WEBHOOK_SECRET;

// Railway Volume mount path — set this same path when you create the
// Volume in Railway's dashboard (Settings → Volumes → Mount path).
const VOLUME_PATH = process.env.VOLUME_PATH || "/data";
const EXCEL_FILE_PATH = path.join(VOLUME_PATH, "excel-400.zip");

// Converts a Dropbox share link (?dl=0) into a direct-download link (?dl=1).
function toDropboxDirectLink(url) {
  if (url.includes("dl=0")) return url.replace("dl=0", "dl=1");
  if (!url.includes("dl=1") && url.includes("dropbox.com")) {
    return url + (url.includes("?") ? "&dl=1" : "?dl=1");
  }
  return url;
}

const EXCEL_SOURCE_URL = toDropboxDirectLink(
  process.env.EXCEL_SOURCE_URL ||
    "https://www.dropbox.com/scl/fi/geoi61ohgvwlpc9qyrxwf/400.zip?rlkey=y50kvv3iv8f068dx6n7se50d8&st=5gqwkleg&dl=0"
);

// --- PRODUCTS ---
// Add more products here later by following the same shape.
const PRODUCTS = {
  ppt: {
    priceMnt: 12000,
    triggers: [
      "хөдөлгөөнт ppt авах",
      "хөдөлгөөнт багц",
      "хөдөлгөөнт ppt багц",
      "хөдөлгөөнт ppt",
      "powerpoint",
      "ppt",
    ],
    invoiceDescription: "Mongolbee - Хөдөлгөөнт PPT багц",
    paymentText: (p) =>
      `1,000 слайд, 66 төрлийн Хөдөлгөөнт PPT багц — ${p.priceMnt.toLocaleString()}₮. Хэрхэн төлөх вэ?`,
    deliveryText: "Таны Хөдөлгөөнт PPT багцыг татаж авах холбоос доор байна. Компьютер дээр татаж аваад, PowerPoint дээр нээгээд ашиглаж эхлээрэй:",
    getDownloadUrl: () => "https://drive.google.com/file/d/1fMp-vFpijrGw3Rv4dty1O0tOcMw00Mca/view",
  },
  excel400: {
    priceMnt: 49000,
    triggers: ["400", "excel file", "файл", "400 файл", "400 excel"],
    invoiceDescription: "Mongolbee - 400 Excel файл",
    paymentText: (p) =>
      `400 Excel файлын багц — ${p.priceMnt.toLocaleString()}₮. Хэрхэн төлөх вэ?`,
    deliveryText: "Таны 400 Excel файлын багцыг татаж авах холбоос доор байна:",
    getDownloadUrl: (req) => `${getPublicBaseUrl(req)}/downloads/excel-400.zip`,
  },
};

function getPublicBaseUrl(req) {
  return process.env.PUBLIC_BASE_URL || `https://${req.get("host")}`;
}

function matchProduct(text) {
  const t = (text || "").trim().toLowerCase();
  for (const [key, product] of Object.entries(PRODUCTS)) {
    if (product.triggers.includes(t)) return key;
  }
  return null;
}

// Sends the download link for a paid product. Used by both byl (QPay) and bank-transfer payments.
async function deliverProduct(senderId, productKey, req) {
  const product = PRODUCTS[productKey] || PRODUCTS.ppt; // fallback for safety
  const downloadUrl = product.getDownloadUrl(req);

  if (productKey === "ppt") {
    await msg.sendButtons(senderId, product.deliveryText, [
      { title: "Татаж авах", url: downloadUrl },
      { title: "Excel файл үзэх", url: "https://mongolbee.beez.mn/" },
    ]);
  } else {
    await msg.sendButton(senderId, product.deliveryText, downloadUrl, "Татаж авах");
  }
}

bank.init({ msg, products: PRODUCTS, deliver: deliverProduct });

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
      const quickReplyPayload = event.message?.quick_reply?.payload || event.postback?.payload || null;

      // A photo (not a sticker / like button) = possible bank-transfer receipt.
      // Not awaited on purpose: reading the screenshot takes a few seconds and
      // Messenger expects this webhook to answer quickly.
      const imageAttachment = event.message?.attachments?.find(
        (a) => a.type === "image" && !a.payload?.sticker_id
      );
      if (imageAttachment && !event.message?.is_echo) {
        if (!bank.seenBefore(event.message.mid)) {
          bank
            .handleScreenshot({ senderId, imageUrl: imageAttachment.payload.url, req })
            .catch((err) => console.error("handleScreenshot error:", err.response?.data || err.message));
        }
        continue;
      }

      let productKey = matchProduct(text);

      if (!productKey && quickReplyPayload?.startsWith("RESTART_PRODUCT|")) {
        productKey = quickReplyPayload.split("|")[1];
      }

      // A recognized product trigger goes straight to the payment options —
      // QPAY button is already the real payment link, no extra click needed.
      if (productKey && PRODUCTS[productKey]) {
        try {
          await offerPayment(senderId, productKey, req);
        } catch (err) {
          console.error("offerPayment error:", err.response?.data || err.message);
          try {
            await msg.sendText(senderId, "Уучлаарай, алдаа гарлаа. Түр хүлээгээд дахин оролдоно уу.");
          } catch (sendErr) {
            console.error("Also failed to notify sender:", sendErr.response?.data || sendErr.message);
          }
        }
        continue;
      }

      if (quickReplyPayload?.startsWith("PAY_QPAY|")) {
        const key = quickReplyPayload.split("|")[1];
        if (PRODUCTS[key]) {
          try {
            await sendQpayLink(senderId, key);
          } catch (err) {
            console.error("sendQpayLink error:", err.response?.data || err.message);
            try {
              await msg.sendText(senderId, "Уучлаарай, алдаа гарлаа. Түр хүлээгээд дахин оролдоно уу.");
            } catch (sendErr) {
              console.error("Also failed to notify sender:", sendErr.response?.data || sendErr.message);
            }
          }
        }
        continue;
      }

      if (quickReplyPayload?.startsWith("PAY_BANK|")) {
        const key = quickReplyPayload.split("|")[1];
        try {
          bank.setPending(senderId, key);
          await sendBankTransferInfo(senderId, key);
        } catch (err) {
          console.error("sendBankTransferInfo error:", err.response?.data || err.message);
        }
        continue;
      }

      // Anything not recognized by a product trigger is now simply ignored.
    }
  }

  res.status(200).send("EVENT_RECEIVED");
});

// --- BANK TRANSFER (verified against the real bank email) ---
const BANK_TRANSFER_INFO = {
  bankName: "Худалдаа хөгжлийн банк",
  accountNumber: "416075929",
  accountName: "Хулан",
  iban: "MN270004000416075929",
};

// Creates the invoice immediately and presents QPAY (direct link) and bank
// transfer (postback) as two buttons in one message — no extra "which
// payment method?" step before reaching the real payment link.
async function offerPayment(senderId, productKey, req) {
  const product = PRODUCTS[productKey];

  // No invoice yet — it is only created if the customer chooses QPAY.
  await msg.sendButtons(senderId, product.paymentText(product), [
    { title: "QPAY-ээр төлөх", payload: `PAY_QPAY|${productKey}` },
    { title: "Дансаар шилжүүлэх", payload: `PAY_BANK|${productKey}` },
  ]);
}

// Customer chose QPAY: create the byl invoice now and send the payment link.
async function sendQpayLink(senderId, productKey) {
  const product = PRODUCTS[productKey];
  const invoice = await byl.createInvoice(product.priceMnt, product.invoiceDescription);
  await db.createOrder(senderId, invoice.id, invoice.number, productKey);

  await msg.sendButton(senderId, "Доорх товчийг дарж QPAY-ээр төлнө үү:", invoice.url, "QPAY-ээр төлөх");

  await msg.sendText(
    senderId,
    `Хэрэв дээрх товч ажиллахгүй бол энэ холбоос дээр удаан дараад "Нээх Safari-аар" сонголтыг хийнэ үү:\n${invoice.url}`
  );

  await msg.sendQuickReplies(senderId, "Төлбөр амжилтгүй болсон уу?", [
    { title: "Дахин эхлэх", payload: `RESTART_PRODUCT|${productKey}` },
  ]);
}

async function sendBankTransferInfo(senderId, productKey) {
  const product = PRODUCTS[productKey];
  const productName = product.invoiceDescription.replace("Mongolbee - ", "");

  await msg.sendText(
    senderId,
    `${productName}\n\n` +
      `Банк: ${BANK_TRANSFER_INFO.bankName}\n` +
      `Дансны дугаар: ${BANK_TRANSFER_INFO.accountNumber}\n` +
      `Дансны нэр: ${BANK_TRANSFER_INFO.accountName}\n` +
      `Гүйлгээний утга: Имэйл хаяг\n` +
      `Дүн: ₮${product.priceMnt.toLocaleString()}\n` +
      `IBAN: ${BANK_TRANSFER_INFO.iban}\n\n` +
      `Шилжүүлсний дараа гүйлгээний баримтын зургийг (screenshot) энд илгээнэ үү. Төлбөр баталгаажмагц татаж авах холбоосыг автоматаар илгээнэ.`
  );
}

// --- BANK DEPOSIT WEBHOOK (called by the Gmail Apps Script) ---
app.post("/webhook/bank", async (req, res) => {
  if (!BANK_WEBHOOK_SECRET) return res.status(503).send("BANK_WEBHOOK_SECRET not set");
  if (req.get("x-bank-secret") !== BANK_WEBHOOK_SECRET) return res.sendStatus(401);

  const { id, amount, receivedAt } = req.body || {};
  if (!id || !Number.isFinite(Number(amount)) || !Number.isFinite(Number(receivedAt))) {
    return res.sendStatus(400);
  }

  res.status(200).send("OK");

  try {
    await bank.onDeposit({ id: String(id), amount: Number(amount), receivedAt: Number(receivedAt) }, req);
  } catch (err) {
    console.error("onDeposit error:", err.response?.data || err.message);
  }
});

// --- DOWNLOAD ROUTE (serves the cached Excel file from the Volume) ---
app.get("/downloads/excel-400.zip", (req, res) => {
  if (!fs.existsSync(EXCEL_FILE_PATH)) {
    return res.status(404).send("File not cached yet. Visit /admin/cache-excel first.");
  }
  res.download(EXCEL_FILE_PATH, "400-excel-files.zip");
});

// --- ADMIN: one-time fetch that caches the Excel file onto the Volume ---
app.get("/admin/cache-excel", async (req, res) => {
  try {
    fs.mkdirSync(VOLUME_PATH, { recursive: true });
    console.log(`[cache-excel] Downloading from ${EXCEL_SOURCE_URL} ...`);

    const response = await axios.get(EXCEL_SOURCE_URL, {
      responseType: "stream",
      maxRedirects: 5,
      timeout: 120000,
    });

    const writer = fs.createWriteStream(EXCEL_FILE_PATH);
    response.data.pipe(writer);

    writer.on("finish", () => {
      const sizeMb = (fs.statSync(EXCEL_FILE_PATH).size / (1024 * 1024)).toFixed(1);
      console.log(`[cache-excel] Done. Saved ${sizeMb} MB to ${EXCEL_FILE_PATH}`);
      res.status(200).send(`Done! Cached ${sizeMb} MB to ${EXCEL_FILE_PATH}. You can now test /downloads/excel-400.zip`);
    });

    writer.on("error", (err) => {
      console.error("[cache-excel] Write error:", err.message);
      res.status(500).send("Write error: " + err.message);
    });
  } catch (err) {
    console.error("[cache-excel] Fetch error:", err.response?.status, err.message);
    res.status(500).send("Fetch error: " + err.message);
  }
});

// --- byl.mn PAYMENT WEBHOOK ---
app.post("/webhook/byl", async (req, res) => {
  res.status(200).send("OK");

  const event = req.body;
  if (event.type !== "invoice.paid") return;

  const invoice = event.data?.object;
  if (!invoice) return;

  const order = await db.getOrderByInvoiceId(invoice.id);
  if (!order) {
    console.warn("No order found for paid invoice", invoice.id);
    return;
  }

  try {
    await db.markOrderPaid(invoice.id);
    await msg.sendText(order.sender_id, "Төлбөр хүлээн авлаа ✅ Баярлалаа!");
    await deliverProduct(order.sender_id, order.product_key, req);
  } catch (err) {
    console.error("Delivery failed:", err.response?.data || err.message);
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
