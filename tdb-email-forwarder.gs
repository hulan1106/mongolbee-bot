/**
 * TDB deposit email -> Railway bot
 *
 * Runs every minute inside your Gmail account. Finds new TDB "Орлого" (income)
 * emails, reads the amount, and sends it to your bot at /webhook/bank.
 *
 * SETUP
 *  1. Go to script.google.com -> New project -> paste this file.
 *  2. Fill in CONFIG below (WEBHOOK_URL, SECRET, SENDER).
 *  3. Run `installTrigger` once (approve the permissions it asks for).
 *  4. Run `checkBankEmails` once by hand and look at View -> Logs.
 */

const CONFIG = {
  // Your Railway URL + /webhook/bank
  WEBHOOK_URL: "https://YOUR-APP.up.railway.app/webhook/bank",

  // Must be identical to BANK_WEBHOOK_SECRET in Railway variables.
  SECRET: "PUT-A-LONG-RANDOM-STRING-HERE",

  // The exact address TDB sends from. Open the bank email -> the three dots ->
  // "Show original" and copy the From address.
  SENDER: "PUT-TDB-SENDER-ADDRESS-HERE",

  // Optional: only accept deposits into this account number (as printed in the
  // email, e.g. "4003312175"). Leave "" to accept any account.
  ACCOUNT: "",
};

function checkBankEmails() {
  const props = PropertiesService.getScriptProperties();
  const lastTs = Number(props.getProperty("lastTs") || 0);

  const threads = GmailApp.search("in:inbox from:" + CONFIG.SENDER + " newer_than:2d");
  const messages = [];
  threads.forEach(function (t) {
    t.getMessages().forEach(function (m) {
      messages.push(m);
    });
  });
  messages.sort(function (a, b) {
    return a.getDate().getTime() - b.getDate().getTime();
  });

  for (var i = 0; i < messages.length; i++) {
    var m = messages[i];
    var ts = m.getDate().getTime();
    // Already handled. (Messages in the same second are re-sent; the bot ignores duplicates.)
    if (ts < lastTs) continue;

    // Only trust mail that really comes from the bank address.
    if (m.getFrom().toLowerCase().indexOf(CONFIG.SENDER.toLowerCase()) === -1) continue;

    var body = m.getPlainBody();
    var isIncome = /Төрөл\s*[:\-]?\s*Орлого/i.test(body);
    var amountMatch = body.match(/Дүн\s*[:\-]?\s*([\d,]+(?:\.\d+)?)\s*MNT/i);
    var accountMatch = body.match(/Дансны\s+дугаар\s*[:\-]?\s*(\d+)/i);

    if (!isIncome || !amountMatch) {
      // Not a deposit (or format changed). Skip it, but say so in the logs.
      console.log("Skipped email " + m.getId() + " (not income or amount not found)");
      props.setProperty("lastTs", String(ts));
      continue;
    }

    var account = accountMatch ? accountMatch[1] : "";
    if (CONFIG.ACCOUNT && account !== CONFIG.ACCOUNT) {
      props.setProperty("lastTs", String(ts));
      continue;
    }

    var amount = parseFloat(amountMatch[1].replace(/,/g, ""));

    var res = UrlFetchApp.fetch(CONFIG.WEBHOOK_URL, {
      method: "post",
      contentType: "application/json",
      headers: { "x-bank-secret": CONFIG.SECRET },
      payload: JSON.stringify({ id: m.getId(), amount: amount, receivedAt: ts, account: account }),
      muteHttpExceptions: true,
    });

    if (res.getResponseCode() >= 300) {
      // Stop here and retry on the next run, so no deposit is skipped.
      console.error("Webhook failed (" + res.getResponseCode() + "): " + res.getContentText());
      return;
    }

    console.log("Sent deposit " + amount + " MNT from " + m.getId());
    props.setProperty("lastTs", String(ts));
  }
}

function installTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === "checkBankEmails") ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger("checkBankEmails").timeBased().everyMinutes(1).create();
}
