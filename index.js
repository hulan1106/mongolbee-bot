const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");

const db = require("./db");
const byl = require("./byl");
const msg = require("./messenger");

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
      "ppt"
      "хөдөлгөөнтэй PPT загвар",
    ],
    invoiceDescription: "Mongolbee - Хөдөлгөөнт PPT багц",
    paymentText: (p) =>
      `1,000 слайд, 66 төрлийн Хөдөлгөөнт PPT багц — ${p.priceMnt.toLocaleString()}₮. Төлбөр төлөгдмөгц таны чат руу илгээх болно:`,
    deliveryText: "Таны Хөдөлгөөнт PPT багцыг татаж авах холбоос доор байна. Компьютер дээр татаж аваад, PowerPoint дээр нээгээд ашиглаж эхлээрэй:",
    getDownloadUrl: () => "https://drive.google.com/file/d/1fMp-vFpijrGw3Rv4dty1O0tOcMw00Mca/view",
  },
  excel400: {
    priceMnt: 49000,
    triggers: ["400", "excel file", "файл", "400 файл", "400 excel"],
    invoiceDescription: "Mongolbee - 400 Excel файл",
    paymentText: (p) =>
      `400 Excel файлын багц — ${p.priceMnt.toLocaleString()}₮. Төлбөр төлөгдмөгц таны чат руу илгээх болно:`,
    deliveryText: "Таны 400 Excel файлын багцыг татаж авах холбоос доор байна. Та компьютер дээр татаж авна уу.:",
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

      let productKey = matchProduct(text);

      if (!productKey && quickReplyPayload?.startsWith("RESTART_PRODUCT|")) {
        productKey = quickReplyPayload.split("|")[1];
      }

      if (productKey && PRODUCTS[productKey]) {
        try {
          await handleProductPurchase(senderId, productKey, req);
        } catch (err) {
          console.error("Purchase error:", err.response?.data || err.message);
          try {
            await msg.sendText(senderId, "Уучлаарай, алдаа гарлаа. Түр хүлээгээд дахин оролдоно уу.");
          } catch (sendErr) {
            console.error("Also failed to notify sender:", sendErr.response?.data || sendErr.message);
          }
        }
        continue;
      }

      // Anything not recognized by a product trigger is now simply ignored.
    }
  }

  res.status(200).send("EVENT_RECEIVED");
});

async function handleProductPurchase(senderId, productKey, req) {
  const product = PRODUCTS[productKey];
  const invoice = await byl.createInvoice(product.priceMnt, product.invoiceDescription);
  await db.createOrder(senderId, invoice.id, invoice.number, productKey);

  await msg.sendButton(senderId, product.paymentText(product), invoice.url, "QPAY төлөх");

  await msg.sendText(
    senderId,
    `Хэрэв дээрх товч ажиллахгүй бол энэ холбоос дээр удаан дараад "Нээх Safari-аар" сонголтыг хийнэ үү:\n${invoice.url}`
  );

  await msg.sendQuickReplies(senderId, "Төлбөр амжилтгүй болсон уу?", [
    { title: "Дахин эхлэх", payload: `RESTART_PRODUCT|${productKey}` },
  ]);
}

// --- DOWNLOAD ROUTE (serves the cached Excel file from the Volume) ---
app.get("/downloads/excel-400.zip", (req, res) => {
  if (!fs.existsSync(EXCEL_FILE_PATH)) {
    return res.status(404).send("File not cached yet. Visit /admin/cache-excel first.");
  }
  res.download(EXCEL_FILE_PATH, "400-excel-files.zip");
});

// --- ADMIN: one-time fetch that caches the Excel file onto the Volume ---
// Visit this once after setting up the Volume. Safe to call again later if
// you ever need to re-fetch (e.g. you update the source file).
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

  const product = PRODUCTS[order.product_key] || PRODUCTS.ppt; // fallback for safety

  try {
    await db.markOrderPaid(invoice.id);
    await msg.sendText(order.sender_id, "Төлбөр хүлээн авлаа ✅ Баярлалаа!");

    const downloadUrl = product.getDownloadUrl(req);

    if (order.product_key === "ppt") {
      await msg.sendButtons(order.sender_id, product.deliveryText, [
        { title: "Татаж авах", url: downloadUrl },
        { title: "Excel файл үзэх", url: "https://mongolbee.beez.mn/" },
      ]);
    } else {
      await msg.sendButton(order.sender_id, product.deliveryText, downloadUrl, "Татаж авах");
    }
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
