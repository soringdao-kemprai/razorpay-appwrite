/**
 * index.js - Appwrite Function (Node 18)
 *
 * Exports an HTTP handler for Appwrite to call.
 * Also supports running via APPWRITE_FUNCTION_DATA (legacy).
 *
 * Required environment variables in Function settings:
 * - RAZORPAY_KEY_ID
 * - RAZORPAY_KEY_SECRET
 * - APPWRITE_ENDPOINT
 * - APPWRITE_PROJECT
 * - APPWRITE_API_KEY
 * - APPWRITE_DATABASE_ID
 * - APPWRITE_ORDERS_COLLECTION_ID
 *
 * Usage:
 * - Appwrite will call this as an HTTP handler.
 * - Or you can run locally with APPWRITE_FUNCTION_DATA set to a JSON string.
 */

const { Client, Databases, ID } = require("node-appwrite");
const Razorpay = require("razorpay");
const crypto = require("crypto");

const env = process.env;

function checkEnv() {
  const required = [
    "RAZORPAY_KEY_ID",
    "RAZORPAY_KEY_SECRET",
    "APPWRITE_ENDPOINT",
    "APPWRITE_PROJECT",
    "APPWRITE_API_KEY",
    "APPWRITE_DATABASE_ID",
    "APPWRITE_ORDERS_COLLECTION_ID",
  ];
  const missing = required.filter((k) => !env[k]);
  if (missing.length) throw new Error("Missing environment variables: " + missing.join(", "));
}

function jsonSafeParse(s) {
  try { return typeof s === "string" ? JSON.parse(s) : s; } catch { return s; }
}

function getAppwrite() {
  const client = new Client();
  client
    .setEndpoint(env.APPWRITE_ENDPOINT)
    .setProject(env.APPWRITE_PROJECT)
    .setKey(env.APPWRITE_API_KEY);
  return { client, databases: new Databases(client) };
}

function generateSignature(orderId, paymentId, secret) {
  const hmac = crypto.createHmac("sha256", secret);
  hmac.update(`${orderId}|${paymentId}`);
  return hmac.digest("hex");
}

function toPaise(amountNumber) {
  return Math.round(Number(amountNumber) * 100);
}

/* Action implementations */
async function createOrderAction(payload) {
  const { items = [], userId, shippingAddress = {}, currency = "INR", receiptPrefix = "rcpt_" } = payload;
  const subtotal = Number(payload.subtotal ?? 0);
  const total = Number(payload.totalAmount ?? subtotal);

  if (!userId) return { ok: false, error: "userId required" };

  const razorpay = new Razorpay({
    key_id: env.RAZORPAY_KEY_ID,
    key_secret: env.RAZORPAY_KEY_SECRET,
  });

  const amountPaise = toPaise(total || subtotal || 0);

  const orderOptions = { amount: amountPaise, currency, receipt: `${receiptPrefix}${Date.now()}`, partial_payment: false };

  let rOrder;
  try { rOrder = await razorpay.orders.create(orderOptions); }
  catch (err) { return { ok: false, error: "Razorpay order creation failed: " + (err.message || err) }; }

  try {
    const { databases } = getAppwrite();
    const createPayload = {
      userId,
      items: JSON.stringify(items),
      subtotal: Number(subtotal),
      totalAmount: Number(total),
      currency,
      shippingAddress: JSON.stringify(shippingAddress),
      paymentStatus: "created",
      paymentProvider: "razorpay",
      paymentReference: null,
      razorpayOrderId: rOrder.id,
      razorpayOrderObj: JSON.stringify(rOrder),
      razorpayPaymentId: null,
      razorpaySignature: null
    };

    const doc = await databases.createDocument(
      env.APPWRITE_DATABASE_ID,
      env.APPWRITE_ORDERS_COLLECTION_ID,
      ID.unique(),
      createPayload
    );

    return { ok: true, orderId: doc.$id, razorpayOrderId: rOrder.id, amount: amountPaise, currency, razorpayKeyId: env.RAZORPAY_KEY_ID };
  } catch (err) {
    return { ok: false, error: "Appwrite save order failed: " + (err.message || err) };
  }
}

async function verifyPaymentAction(payload) {
  const { orderId, razorpayPaymentId, razorpayOrderId, razorpaySignature } = payload;
  if (!orderId || !razorpayPaymentId || !razorpayOrderId || !razorpaySignature) {
    return { ok: false, error: "Missing verification fields" };
  }

  const expected = generateSignature(razorpayOrderId, razorpayPaymentId, env.RAZORPAY_KEY_SECRET);
  if (expected !== razorpaySignature) return { ok: false, error: "Invalid signature" };

  try {
    const { databases } = getAppwrite();

    const updatePayload = {
      paymentStatus: "paid",
      paymentReference: razorpayPaymentId,
      razorpayPaymentId,
      razorpaySignature
    };

    const updated = await databases.updateDocument(
      env.APPWRITE_DATABASE_ID,
      env.APPWRITE_ORDERS_COLLECTION_ID,
      orderId,
      updatePayload
    );

    return { ok: true, orderId: updated.$id, razorpayPaymentId, message: "Payment verified and order updated" };
  } catch (err) {
    return { ok: false, error: "Failed to update order: " + (err.message || err) };
  }
}

/* Main executor: determines action and runs it */
async function handleAction(body) {
  // body may be: { action, payload } or payload directly
  const actionName = (body && (body.action || body?.payload?.action)) || (body?.payload?.action) || null;
  const payload = (body && body.payload) || body || {};
  const act = (body.action || payload.action || (payload.razorpayPaymentId ? "verifyPayment" : "createOrder") || "createOrder").toString().toLowerCase();

  if (act === "createorder" || act === "createorder") return await createOrderAction(payload);
  if (act === "verifypayment" || act === "verifypayment") return await verifyPaymentAction(payload);

  // catch-all: guess based on fields
  if (payload.razorpayPaymentId) return await verifyPaymentAction(payload);
  return await createOrderAction(payload);
}

/* Exported HTTP handler Appwrite will call */
module.exports = async function (req, res) {
  try {
    checkEnv();
  } catch (err) {
    console.error("ENV ERROR:", err.message || err);
    res.status(500).json({ ok: false, error: err.message || String(err) });
    return;
  }

  // Accept input from either HTTP request body (Appwrite) or old APPWRITE_FUNCTION_DATA
  let input = {};
  if (req && req.body && Object.keys(req.body).length > 0) {
    input = req.body;
  } else if (process.env.APPWRITE_FUNCTION_DATA) {
    try { input = JSON.parse(process.env.APPWRITE_FUNCTION_DATA); } catch { input = process.env.APPWRITE_FUNCTION_DATA; }
  }

  try {
    const result = await handleAction(input);
    // If result is object, respond with JSON and 200/400
    if (result && result.ok === false) {
      res.status(400).json(result);
    } else {
      res.status(200).json(result);
    }
  } catch (err) {
    console.error("ACTION ERROR:", err);
    res.status(500).json({ ok: false, error: err.message || String(err) });
  }
};

/* Also allow running locally with APPWRITE_FUNCTION_DATA (node index.js won't be called by Appwrite),
   but Appwrite won't call this path — it uses exported handler above. */
if (require.main === module) {
  // Running as standalone script (not exported). Useful for local debugging:
  (async () => {
    try {
      checkEnv();
      const raw = process.env.APPWRITE_FUNCTION_DATA || "{}";
      const body = jsonSafeParse(raw);
      const out = await handleAction(body);
      console.log(JSON.stringify(out, null, 2));
    } catch (e) {
      console.error(e);
    }
  })();
}
