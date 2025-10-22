/**
 * Razorpay Appwrite Function - index.js
 *
 * Exports a universal handler for Appwrite functions.
 * Supports both:
 * - Appwrite HTTP style: (req, res)
 * - Appwrite single-arg execution: module called with a single body object
 *
 * Required environment variables (set in Function settings):
 * - RAZORPAY_KEY_ID
 * - RAZORPAY_KEY_SECRET
 * - APPWRITE_ENDPOINT
 * - APPWRITE_PROJECT
 * - APPWRITE_API_KEY
 * - APPWRITE_DATABASE_ID
 * - APPWRITE_ORDERS_COLLECTION_ID
 *
 * Use `functions.createExecution(functionId, JSON.stringify(payload))` from frontend,
 * where payload = { action: "createOrder" | "verifyPayment", payload: {...} }
 *
 * Example createOrder payload:
 * {
 *   "action": "createOrder",
 *   "payload": {
 *     "userId": "user_123",
 *     "items": [{ "productId": "p1", "quantity": 1 }],
 *     "shippingAddress": { "text": "addr", "phone":"9999999999" },
 *     "subtotal": 100,
 *     "totalAmount": 100
 *   }
 * }
 *
 * Example verifyPayment payload:
 * {
 *   "action": "verifyPayment",
 *   "payload": {
 *     "orderId": "appwrite_doc_id",
 *     "razorpayPaymentId": "pay_XXXX",
 *     "razorpayOrderId": "order_XXXX",
 *     "razorpaySignature": "signature_hex"
 *   }
 * }
 */

const { Client, Databases, ID } = require("node-appwrite");
const Razorpay = require("razorpay");
const crypto = require("crypto");

const env = process.env;

/* -------------------------
   Helper utilities
   ------------------------- */

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
  if (missing.length) throw new Error(missing.join(", "));
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
  // amountNumber expected in rupees; returns integer paise
  return Math.round(Number(amountNumber) * 100);
}

/* -------------------------
   Action implementations
   ------------------------- */

async function createOrderAction(payload) {
  // payload: { items, userId, shippingAddress, subtotal, totalAmount, currency }
  const { items = [], userId, shippingAddress = {}, currency = "INR", receiptPrefix = "rcpt_" } = payload;
  const subtotal = Number(payload.subtotal ?? 0);
  const total = Number(payload.totalAmount ?? subtotal);

  if (!userId) return { ok: false, error: "userId required" };

  const razorpay = new Razorpay({
    key_id: env.RAZORPAY_KEY_ID,
    key_secret: env.RAZORPAY_KEY_SECRET,
  });

  const amountPaise = toPaise(total || subtotal || 0);
  if (!amountPaise || amountPaise <= 0) return { ok: false, error: "Invalid amount" };

  const orderOptions = {
    amount: amountPaise,
    currency,
    receipt: `${receiptPrefix}${Date.now()}`,
    partial_payment: false
  };

  let rOrder;
  try {
    rOrder = await razorpay.orders.create(orderOptions);
  } catch (err) {
    return { ok: false, error: "Razorpay order creation failed: " + (err?.message || String(err)) };
  }

  // Save to Appwrite
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

    return {
      ok: true,
      orderId: doc.$id,
      razorpayOrderId: rOrder.id,
      amount: amountPaise,
      currency,
      razorpayKeyId: env.RAZORPAY_KEY_ID
    };
  } catch (err) {
    return { ok: false, error: "Appwrite save order failed: " + (err?.message || String(err)) };
  }
}

async function verifyPaymentAction(payload) {
  // payload: { orderId, razorpayPaymentId, razorpayOrderId, razorpaySignature }
  const { orderId, razorpayPaymentId, razorpayOrderId, razorpaySignature } = payload;
  if (!orderId || !razorpayPaymentId || !razorpayOrderId || !razorpaySignature) {
    return { ok: false, error: "Missing verification fields" };
  }

  const expected = generateSignature(razorpayOrderId, razorpayPaymentId, env.RAZORPAY_KEY_SECRET);
  if (expected !== razorpaySignature) {
    return { ok: false, error: "Invalid signature" };
  }

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
    return { ok: false, error: "Failed to update order: " + (err?.message || String(err)) };
  }
}

/* decide which action to run */
async function handleAction(body) {
  // support multiple shapes: { action, payload } or { payload: { ... } } or raw payload
  const actionFromBody = (body && (body.action || (body.payload && body.payload.action))) || null;
  const payload = (body && body.payload) || body || {};

  // normalize action string
  const act = (actionFromBody || payload.action || (payload.razorpayPaymentId ? "verifyPayment" : "createOrder") || "createOrder").toString().toLowerCase();

  if (act === "createorder" || act === "createorder") {
    return await createOrderAction(payload);
  }
  if (act === "verifypayment" || act === "verifypayment") {
    return await verifyPaymentAction(payload);
  }

  // fallback by guessing fields
  if (payload.razorpayPaymentId) return await verifyPaymentAction(payload);
  return await createOrderAction(payload);
}

/* -------------------------
   Universal handler
   ------------------------- */

async function runHandler(reqArg, resArg) {
  let req = reqArg;
  let res = resArg;

  // If Appwrite passes a single object without headers/body, treat that as the body payload
  if (!res && reqArg && typeof reqArg === "object" && !("headers" in reqArg) && !("body" in reqArg)) {
    req = { body: reqArg };
  }

  try {
    checkEnv();
  } catch (err) {
    const out = { ok: false, error: "Missing environment variables: " + (err.message || String(err)) };
    if (res && typeof res.status === "function") {
      return res.status(500).json(out);
    }
    console.error("ENV ERROR:", err);
    console.log(JSON.stringify(out));
    return out;
  }

  // Resolve input from possible sources
  let input = {};
  try {
    if (req && req.body && Object.keys(req.body).length > 0) {
      input = req.body;
    } else if (process.env.APPWRITE_FUNCTION_DATA) {
      try { input = JSON.parse(process.env.APPWRITE_FUNCTION_DATA); } catch { input = process.env.APPWRITE_FUNCTION_DATA; }
    } else if (req && Object.keys(req).length > 0) {
      input = req;
    } else {
      input = {};
    }
  } catch (e) {
    input = {};
  }

  try {
    const result = await handleAction(input);

    if (res && typeof res.status === "function") {
      if (result && result.ok === false) return res.status(400).json(result);
      return res.status(200).json(result);
    }

    // No res -> log & return
    console.log(JSON.stringify(result));
    return result;
  } catch (err) {
    console.error("ACTION ERROR:", err);
    const out = { ok: false, error: err.message || String(err) };
    if (res && typeof res.status === "function") {
      return res.status(500).json(out);
    }
    console.log(JSON.stringify(out));
    return out;
  }
}

/* export handler for Appwrite */
module.exports = async function (req, res) {
  return runHandler(req, res);
};

/* local debugging if run as script */
if (require.main === module) {
  (async () => {
    try {
      const raw = process.env.APPWRITE_FUNCTION_DATA || "{}";
      const body = jsonSafeParse(raw);
      const out = await handleAction(body);
      console.log(JSON.stringify(out, null, 2));
    } catch (e) {
      console.error(e);
    }
  })();
}
