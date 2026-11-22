// Manual bank-transfer verification.
//
// Flow:
//  - Gmail Apps Script posts each real TDB deposit to /webhook/bank  -> addDeposit / onDeposit
//  - Customer sends a screenshot                                      -> handleScreenshot
//  - A screenshot only counts if it matches a real, unclaimed deposit (same amount, close in time).
//  - If the bank email hasn't arrived yet, the customer is put on a waiting list and is
//    served automatically as soon as the matching deposit arrives.
//
// Data lives in a JSON file on the Railway Volume (same Volume you already use).

const fs = require("fs");
const path = require("path");
const axios = require("axios");
const Anthropic = require("@anthropic-ai/sdk");

const VOLUME_PATH = process.env.VOLUME_PATH || "/data";
const STORE_PATH = path.join(VOLUME_PATH, "bank-store.json");

const MODEL = process.env.CLAUDE_MODEL || "claude-haiku-5-5";
// Digits of YOUR account as shown on a customer's receipt (recipient side).
const ACCOUNT_DIGITS = process.env.RECEIPT_ACCOUNT_DIGITS || "416075929";
const OWNER_PSID = process.env.OWNER_PSID || ""; // optional: your own Messenger ID for alerts

const MIN = 60 * 1000;
const TOLERANCE_MS = Number(process.env.TIME_TOLERANCE_MIN || 10) * MIN; // receipt time vs email time
const MAX_RECEIPT_AGE_MS = Number(process.env.MAX_RECEIPT_AGE_MIN || 60) * MIN; // reject old screenshots
const WAIT_EXPIRY_MS = 60 * MIN;
const PENDING_EXPIRY_MS = 48 * 60 * MIN;
const DEPOSIT_KEEP_MS = 7 * 24 * 60 * MIN;

let ctx = null; // { msg, products, deliver }
function init(context) {
  ctx = context;
}

// ---------- storage ----------
function load() {
  try {
    const s = JSON.parse(fs.readFileSync(STORE_PATH, "utf8"));
    s.deposits = s.deposits || {};
    s.pending = s.pending || {};
    s.waiting = s.waiting || {};
    return s;
  } catch {
    return { deposits: {}, pending: {}, waiting: {} };
  }
}

function save(s) {
  const now = Date.now();
  for (const [k, d] of Object.entries(s.deposits)) if (now - d.receivedAt > DEPOSIT_KEEP_MS) delete s.deposits[k];
  for (const [k, p] of Object.entries(s.pending)) if (now - p.createdAt > PENDING_EXPIRY_MS) delete s.pending[k];
  for (const [k, w] of Object.entries(s.waiting)) if (now - w.createdAt > WAIT_EXPIRY_MS) delete s.waiting[k];
  fs.mkdirSync(VOLUME_PATH, { recursive: true });
  const tmp = STORE_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(s));
  fs.renameSync(tmp, STORE_PATH);
}

// Customer pressed "Дансаар шилжүүлэх".
function setPending(senderId, productKey) {
  const s = load();
  s.pending[senderId] = { productKey, createdAt: Date.now() };
  save(s);
}

// Returns false if this deposit id was already stored.
function addDeposit({ id, amount, receivedAt }) {
  const s = load();
  if (s.deposits[id]) return false;
  s.deposits[id] = { id, amount, receivedAt, claimedBy: null, claimedAt: null };
  save(s);
  return true;
}

// Finds the closest unclaimed deposit and claims it. Synchronous on purpose,
// so two requests can never claim the same deposit.
function claimDeposit(entry) {
  const s = load();
  const ref = entry.receiptAt ?? entry.createdAt;
  const tol = entry.receiptAt ? TOLERANCE_MS : TOLERANCE_MS * 3; // no time on receipt -> looser
  let best = null;
  let bestDiff = Infinity;
  for (const d of Object.values(s.deposits)) {
    if (d.claimedBy || d.amount !== entry.amount) continue;
    const diff = Math.abs(d.receivedAt - ref);
    if (diff <= tol && diff < bestDiff) {
      best = d;
      bestDiff = diff;
    }
  }
  if (!best) return null;
  best.claimedBy = entry.senderId;
  best.claimedAt = Date.now();
  save(s);
  return best;
}

// ---------- screenshot reading (Claude vision) ----------
const RECEIPT_PROMPT = `This image may be a screenshot of a Mongolian bank app showing a money transfer result.
Return ONLY a JSON object, nothing else:
{"is_bank_receipt": boolean, "success": boolean, "amount_mnt": number or null, "datetime": "YYYY-MM-DD HH:mm" or null, "recipient_account": string or null}
- is_bank_receipt: true only if it clearly is a bank transfer result screen.
- success: true only if it says the transaction was successful (Гүйлгээ амжилттай).
- amount_mnt: the transferred amount as a plain number (12,000.00 MNT -> 12000).
- datetime: the date and time printed on the screen.
- recipient_account: the receiving account number / IBAN exactly as printed (Хүлээн авагч).`;

async function extractReceipt(imageUrl) {
  const resp = await axios.get(imageUrl, {
    responseType: "arraybuffer",
    timeout: 20000,
    maxContentLength: 10 * 1024 * 1024,
  });
  let mediaType = String(resp.headers["content-type"] || "image/jpeg").split(";")[0];
  if (!["image/jpeg", "image/png", "image/gif", "image/webp"].includes(mediaType)) mediaType = "image/jpeg";

  const client = new Anthropic(); // reads ANTHROPIC_API_KEY
  const r = await client.messages.create({
    model: MODEL,
    max_tokens: 300,
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mediaType, data: Buffer.from(resp.data).toString("base64") } },
          { type: "text", text: RECEIPT_PROMPT },
        ],
      },
    ],
  });
  const text = r.content.find((b) => b.type === "text")?.text || "";
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("No JSON in vision reply");
  return JSON.parse(m[0]);
}

// Receipt times are Mongolian local time (UTC+8).
function parseReceiptTime(dt) {
  if (!dt) return null;
  const t = new Date(String(dt).trim().replace(" ", "T") + ":00+08:00").getTime();
  return Number.isNaN(t) ? null : t;
}

// ---------- helpers ----------
const seenMids = new Set();
function seenBefore(mid) {
  if (!mid) return false;
  if (seenMids.has(mid)) return true;
  seenMids.add(mid);
  if (seenMids.size > 500) seenMids.delete(seenMids.values().next().value);
  return false;
}

async function notifyOwner(text) {
  if (!OWNER_PSID) return;
  try {
    await ctx.msg.sendText(OWNER_PSID, text);
  } catch (e) {
    console.error("notifyOwner failed:", e.response?.data || e.message);
  }
}

// Claim a deposit for this entry; on success pay out. Returns true if delivered.
async function tryResolve(entry, req) {
  const deposit = claimDeposit(entry);
  if (!deposit) return false;

  const s = load();
  delete s.waiting[entry.senderId];
  delete s.pending[entry.senderId];
  save(s);

  console.log(`[bank] ${entry.senderId} matched deposit ${deposit.id} (${entry.amount} MNT)`);
  try {
    await ctx.msg.sendText(entry.senderId, "Төлбөр баталгаажлаа ✅ Баярлалаа!");
    await ctx.deliver(entry.senderId, entry.productKey, req);
  } catch (e) {
    console.error("[bank] delivery failed:", e.response?.data || e.message);
    await notifyOwner(`Bank payment matched but delivery failed for ${entry.senderId} (${entry.amount} MNT).`);
    try {
      await ctx.msg.sendText(
        entry.senderId,
        "Татаж авах холбоосыг илгээхэд алдаа гарлаа. Манай тусламжийн баг тантай удахгүй холбогдоно."
      );
    } catch {}
  }
  return true;
}

// ---------- entry points ----------

// Customer sent an image. Do NOT await this from the Messenger webhook (it can take a few seconds).
async function handleScreenshot({ senderId, imageUrl, req }) {
  const { msg, products } = ctx;

  const s0 = load();
  const pending = s0.pending[senderId];
  if (!pending) return; // they never asked for a bank transfer -> ignore random photos

  let receipt;
  try {
    receipt = await extractReceipt(imageUrl);
  } catch (e) {
    console.error("[bank] extractReceipt failed:", e.response?.data || e.message);
    await msg.sendText(senderId, "Зургийг уншиж чадсангүй. Дахин, тод зураг илгээнэ үү.");
    return;
  }

  if (!receipt?.is_bank_receipt || !receipt.success || !Number(receipt.amount_mnt)) {
    await msg.sendText(
      senderId,
      "Гүйлгээний баримтын зургийг (screenshot) илгээнэ үү. Банкны апп дээрх «Гүйлгээ амжилттай» харагдаж байх ёстой."
    );
    return;
  }

  // Receiving account must be ours.
  const recipientDigits = String(receipt.recipient_account || "").replace(/\D/g, "");
  if (recipientDigits && !recipientDigits.includes(ACCOUNT_DIGITS)) {
    await msg.sendText(senderId, "Баримт дээрх хүлээн авагчийн данс манай данс биш байна. Дансны мэдээллээ шалгана уу.");
    return;
  }

  // Receipt must be recent (stops reuse of old screenshots).
  const receiptAt = parseReceiptTime(receipt.datetime);
  const now = Date.now();
  if (receiptAt && (now - receiptAt > MAX_RECEIPT_AGE_MS || receiptAt - now > TOLERANCE_MS)) {
    await msg.sendText(senderId, "Энэ баримт хуучин эсвэл цаг нь таарахгүй байна. Саяхан хийсэн гүйлгээний баримтыг илгээнэ үү.");
    return;
  }

  // Which product? Prefer the one they picked, otherwise match by price.
  const amount = Number(receipt.amount_mnt);
  let productKey = null;
  if (products[pending.productKey]?.priceMnt === amount) productKey = pending.productKey;
  else productKey = Object.keys(products).find((k) => products[k].priceMnt === amount) || null;

  if (!productKey) {
    await msg.sendText(
      senderId,
      `Баримт дээрх дүн (₮${amount.toLocaleString()}) сонгосон багцын үнэтэй таарахгүй байна. Яг үнийн дүнгээр шилжүүлнэ үү.`
    );
    return;
  }

  const entry = { senderId, productKey, amount, receiptAt, createdAt: now };

  // Save on the waiting list FIRST, so a deposit arriving right now can't be missed.
  const s = load();
  s.waiting[senderId] = entry;
  save(s);

  const ok = await tryResolve(entry, req);
  if (!ok) {
    await msg.sendText(
      senderId,
      "Баримтыг хүлээн авлаа. Банкны гүйлгээг шалгаж байна — баталгаажмагц файлыг энд автоматаар илгээнэ. 1 цагийн дотор ирэхгүй бол бидэнтэй холбогдоно уу."
    );
    await notifyOwner(`Waiting for deposit: ${amount} MNT from ${senderId} (${productKey}).`);
  }
}

// Bank email arrived (called by /webhook/bank).
async function onDeposit(deposit, req) {
  const isNew = addDeposit(deposit);
  if (!isNew) return; // duplicate post from the Apps Script

  const waiting = Object.values(load().waiting).sort((a, b) => a.createdAt - b.createdAt);
  for (const entry of waiting) {
    try {
      if (await tryResolve(entry, req)) break; // one deposit serves one customer
    } catch (e) {
      console.error("[bank] resolve waiting failed:", e.message);
    }
  }
}

module.exports = { init, setPending, handleScreenshot, onDeposit, seenBefore };
