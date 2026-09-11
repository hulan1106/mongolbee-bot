const axios = require("axios");

const BYL_TOKEN = process.env.BYL_TOKEN;
const BYL_PROJECT_ID = process.env.BYL_PROJECT_ID;
const BYL_BASE = "https://byl.mn/api/v1";

// Creates an invoice and returns { id, number, url, status }.
async function createInvoice(amountMnt, description) {
  const res = await axios.post(
    `${BYL_BASE}/projects/${BYL_PROJECT_ID}/invoices`,
    { amount: amountMnt, description },
    {
      headers: {
        Authorization: `Bearer ${BYL_TOKEN}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
    }
  );
  const invoice = res.data.data || res.data;
  return {
    id: invoice.id,
    number: invoice.number,
    url: invoice.url,
    status: invoice.status,
  };
}

module.exports = { createInvoice };
