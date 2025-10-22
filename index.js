/**
 * Razorpay Appwrite Function - index.js
 *
 * Universal handler supporting:
 * - Appwrite HTTP (req, res)
 * - Appwrite single-arg runtime (raw body)
 *
 * This version includes instrumented logging in runHandler to inspect the exact
 * payload shape Appwrite passes to the function during Executions.
 *
 * Required environment variables (Function settings):
 * - RAZORPAY_KEY_ID
 * - RAZORPAY_KEY_SECRET
 * - APPWRITE_ENDPOINT
 * - APPWRITE_PROJECT
 * - APPWRITE_API_KEY
 * - APPWRITE_DATABASE_ID
 * - APPWRITE_ORDERS_COLLECTION_ID
 *
 * Usage example (Execute / createExecution payload):
 * {
 *   "action":"createOrder",
 *   "payload": { "userId":"test", "items":[{"productId":"p1","quantity":1}], "subtotal":199, "totalAmount":199 }
 * }
 */

const { Client, Databases, ID } = require("node-appwrite");
const Razorpay = require("razorpay");
const crypto = require("crypto");

const env = process.env;

/* -------------------------
   Helpers
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
  return Math.round(Number(amountNumber) * 100);
}

/* -------------------------
   Actions
   ------------------------- */

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
    console.error("Razorpay order create error:", err);
    return { ok: false, error: "Razorpay order creation failed: " + (err?.message || String(err)) };
  }

  // Save to Appwrite DB
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

    console.log("createPayload:", createPayload);

    const doc = await databases.createDocument(
      env.APPWRITE_DATABASE_ID,
      env.APPWRITE_ORDERS_COLLECTION_ID,
      ID.unique(),
      createPayload
    );

    console.log("createDocument response:", doc);

    return {
      ok: true,
      orderId: doc.$id,
      razorpayOrderId: rOrder.id,
      amount: amountPaise,
      currency,
      razorpayKeyId: env.RAZORPAY_KEY_ID
    };
  } catch (err) {
    console.error("Appwrite createDocument error:", err);
    return { ok: false, error: "Appwrite save order failed: " + (err?.message || String(err)) };
  }
}

async function verifyPaymentAction(payload) {
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

    console.log("updateDocument response:", updated);

    return { ok: true, orderId: updated.$id, razorpayPaymentId, message: "Payment verified and order updated" };
  } catch (err) {
    console.error("Appwrite updateDocument error:", err);
    return { ok: false, error: "Failed to update order: " + (err?.message || String(err)) };
  }
}

async function handleAction(body) {
  const actionFromBody = (body && (body.action || (body.payload && body.payload.action))) || null;
  const payload = (body && body.payload) || body || {};

  const act = (actionFromBody || payload.action || (payload.razorpayPaymentId ? "verifyPayment" : "createOrder") || "createOrder").toString().toLowerCase();

  if (act === "createorder" || act === "createorder") return await createOrderAction(payload);
  if (act === "verifypayment" || act === "verifypayment") return await verifyPaymentAction(payload);

  if (payload.razorpayPaymentId) return await verifyPaymentAction(payload);
  return await createOrderAction(payload);
}

/* -------------------------
   Instrumented runHandler — replace previous runHandler
   ------------------------- */

async function runHandler(reqArg, resArg) {
  // Log raw incoming argument types (helps debug how Appwrite passes data)
  try {
    console.log("=== ENTRY: runHandler ===");
    console.log("raw reqArg type:", typeof reqArg);
    // try to stringify safely
    try { console.log("raw reqArg:", JSON.stringify(reqArg)); } catch (e) { console.log("raw reqArg (non-serializable):", reqArg); }
    console.log("APPWRITE_FUNCTION_DATA present:", !!process.env.APPWRITE_FUNCTION_DATA);
    if (process.env.APPWRITE_FUNCTION_DATA) {
      try { console.log("APPWRITE_FUNCTION_DATA:", process.env.APPWRITE_FUNCTION_DATA); } catch (e) { console.log("APPWRITE_FUNCTION_DATA not stringifiable"); }
    }
  } catch (e) {
    console.error("Error logging entry data:", e);
  }

  let req = reqArg;
  let res = resArg;

  // If Appwrite passes a single object w/o headers/body, treat that as the body
  if (!res && reqArg && typeof reqArg === "object" && !("headers" in reqArg) && !("body" in reqArg)) {
    req = { body: reqArg };
  }

  try {
    checkEnv();
  } catch (err) {
    const out = { ok: false, error: "Missing environment variables: " + (err.message || String(err)) };
    if (res && typeof res.status === "function") return res.status(500).json(out);
    console.error("ENV ERROR:", err);
    console.log(JSON.stringify(out));
    return out;
  }

  // Resolve input from possible sources (improved parsing)
  let input = {};
  try {
    if (req && req.body && Object.keys(req.body).length > 0) {
      input = req.body;
      console.log("parsed input from req.body");
    } else if (typeof req === "string") {
      // Appwrite may pass raw JSON string as req
      try {
        input = JSON.parse(req);
        console.log("parsed input from req string");
      } catch (e) {
        console.log("req is string but JSON.parse failed:", e);
        input = {};
      }
    } else if (req && req.payload && req.payload.userId) {
      // Sometimes Appwrite nests the payload directly
      input = req;
      console.log("parsed input from req.payload");
    } else if (process.env.APPWRITE_FUNCTION_DATA) {
      try {
        input = JSON.parse(process.env.APPWRITE_FUNCTION_DATA);
        console.log("parsed input from APPWRITE_FUNCTION_DATA");
      } catch {
        input = process.env.APPWRITE_FUNCTION_DATA;
        console.log("used raw APPWRITE_FUNCTION_DATA (not JSON)");
      }
    } else {
      input = req || {};
      console.log("used fallback req as input");
    }
  } catch (e) {
    console.error("Failed to parse input:", e);
    input = {};
  }

  // Log final input object for inspection
  try {
    try { console.log("FINAL input object:", JSON.stringify(input)); } catch (e) { console.log("FINAL input (non-serializable):", input); }
  } catch (e) {
    console.error("Error logging final input:", e);
  }

  try {
    const result = await handleAction(input);

    if (res && typeof res.status === "function") {
      if (result && result.ok === false) return res.status(400).json(result);
      return res.status(200).json(result);
    }

    // No res -> log & return (Appwrite captures stdout)
    console.log(JSON.stringify(result));
    return result;
  } catch (err) {
    console.error("ACTION ERROR:", err);
    const out = { ok: false, error: err.message || String(err) };
    if (res && typeof res.status === "function") return res.status(500).json(out);
    console.log(JSON.stringify(out));
    return out;
  }
}

/* Export for Appwrite */
module.exports = async function (req, res) {
  return runHandler(req, res);
};

/* Local-run fallback for debugging */
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
