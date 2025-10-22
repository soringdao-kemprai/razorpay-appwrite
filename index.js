/**
 * Razorpay Appwrite Function - index.js
 *
 * Robust universal handler that handles Appwrite's various execution payload shapes:
 * - wrapper object: { req: { body, bodyJson, bodyText, ... }, res: {} }
 * - direct (req, res)
 * - single-arg raw body
 * - uses APPWRITE_FUNCTION_DATA fallback
 *
 * Required env vars (set in Function settings):
 * - RAZORPAY_KEY_ID
 * - RAZORPAY_KEY_SECRET
 * - APPWRITE_ENDPOINT
 * - APPWRITE_PROJECT
 * - APPWRITE_API_KEY
 * - APPWRITE_DATABASE_ID
 * - APPWRITE_ORDERS_COLLECTION_ID
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

function tryParseJSON(str) {
  if (typeof str !== "string") return null;
  try { return JSON.parse(str); } catch { return null; }
}

function bufferToString(bufObj) {
  // bufObj is likely { type: 'Buffer', data: [..] }
  try {
    if (!bufObj || !Array.isArray(bufObj.data)) return null;
    return Buffer.from(bufObj.data).toString("utf8");
  } catch (e) {
    return null;
  }
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

  if (act === "createorder") return await createOrderAction(payload);
  if (act === "verifypayment") return await verifyPaymentAction(payload);

  if (payload.razorpayPaymentId) return await verifyPaymentAction(payload);
  return await createOrderAction(payload);
}

/* -------------------------
   Robust input parsing + universal handler
   ------------------------- */

async function runHandler(rawArg, rawRes) {
  // log entry briefly
  try {
    console.log("=== runHandler entry ===");
  } catch (e) {}

  let req = rawArg;
  let res = rawRes;

  // Unwrap Appwrite wrapper: sometimes Appwrite passes { req: {...}, res: {...} }
  if (req && typeof req === "object" && req.req && typeof req.req === "object") {
    // often rawArg looks like { req: { body: "...", bodyJson: {...}, ... }, res: {} }
    req = req.req;
    // res may be rawArg.res
    res = rawArg.res || res;
  }

  // Edge: if Appwrite passed (req, res) typical, we keep as-is.

  // Validate env early
  try { checkEnv(); } catch (err) {
    const out = { ok: false, error: "Missing environment variables: " + (err.message || String(err)) };
    if (res && typeof res.status === "function") return res.status(500).json(out);
    console.error("ENV ERROR:", err);
    console.log(JSON.stringify(out));
    return out;
  }

  // Try to resolve input payload from many possible shapes
  let input = {};

  try {
    // 1) If request already has parsed bodyJson (Appwrite sometimes provides this)
    if (req && req.bodyJson && typeof req.bodyJson === "object") {
      input = req.bodyJson;
      console.log("input <- req.bodyJson");
    }
    // 2) If req.body is an object (already parsed)
    else if (req && req.body && typeof req.body === "object") {
      input = req.body;
      console.log("input <- req.body (object)");
    }
    // 3) If req.body is a string that contains JSON
    else if (req && req.body && typeof req.body === "string") {
      const parsed = tryParseJSON(req.body);
      if (parsed) { input = parsed; console.log("input <- parsed req.body string"); }
      else { console.log("req.body string exists but JSON.parse failed"); }
    }
    // 4) If req.bodyText exists (string)
    else if (req && req.bodyText && typeof req.bodyText === "string") {
      const p = tryParseJSON(req.bodyText);
      if (p) { input = p; console.log("input <- parsed req.bodyText"); }
      else { console.log("req.bodyText present but parse failed"); }
    }
    // 5) If req.bodyRaw exists and is string
    else if (req && req.bodyRaw && typeof req.bodyRaw === "string") {
      const p = tryParseJSON(req.bodyRaw);
      if (p) { input = p; console.log("input <- parsed req.bodyRaw"); }
    }
    // 6) If req.bodyBinary provided (Buffer-like)
    else if (req && req.bodyBinary && req.bodyBinary.data && Array.isArray(req.bodyBinary.data)) {
      const s = bufferToString(req.bodyBinary);
      const p = tryParseJSON(s);
      if (p) { input = p; console.log("input <- parsed bodyBinary -> string"); }
    }
    // 7) If top-level rawArg was a string (very rare)
    else if (typeof rawArg === "string") {
      const p = tryParseJSON(rawArg);
      if (p) { input = p; console.log("input <- parsed rawArg string"); }
    }
    // 8) If APPWRITE_FUNCTION_DATA provided
    else if (process.env.APPWRITE_FUNCTION_DATA) {
      const p = tryParseJSON(process.env.APPWRITE_FUNCTION_DATA);
      input = p ? p : process.env.APPWRITE_FUNCTION_DATA;
      console.log("input <- APPWRITE_FUNCTION_DATA fallback");
    }
    // 9) If none of the above, maybe req itself contains payload fields (rare)
    else if (req && (req.action || req.payload || req.userId)) {
      input = req;
      console.log("input <- req as fallback");
    } else {
      input = {};
      console.log("input <- empty fallback");
    }
  } catch (e) {
    console.error("Error resolving input:", e);
    input = {};
  }

  // Log final input for debugging (Appwrite captures stdout)
  try { console.log("FINAL input:", JSON.stringify(input)); } catch (e) { console.log("FINAL input (non-serializable)"); }

  // Execute requested action
  try {
    const result = await handleAction(input);

    if (res && typeof res.status === "function") {
      if (result && result.ok === false) return res.status(400).json(result);
      return res.status(200).json(result);
    }

    // No res available — print result for Executions UI and return it
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

/* Export handler for Appwrite */
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
