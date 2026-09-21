const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("railway") ? { rejectUnauthorized: false } : false,
});

function query(text, params) {
  return pool.query(text, params);
}

async function createOrder(senderId, invoiceId, invoiceNumber, productKey) {
  await query(
    `INSERT INTO ppt_orders (sender_id, invoice_id, invoice_number, product_key, status)
     VALUES ($1, $2, $3, $4, 'AWAITING_PAYMENT')`,
    [senderId, String(invoiceId), invoiceNumber, productKey]
  );
}

async function getOrderByInvoiceId(invoiceId) {
  const { rows } = await query(
    `SELECT * FROM ppt_orders WHERE invoice_id = $1 OR invoice_number = $1`,
    [String(invoiceId)]
  );
  return rows[0] || null;
}

async function markOrderPaid(invoiceId) {
  await query(
    `UPDATE ppt_orders SET status = 'PAID' WHERE invoice_id = $1 OR invoice_number = $1`,
    [String(invoiceId)]
  );
}

module.exports = { pool, createOrder, getOrderByInvoiceId, markOrderPaid };
