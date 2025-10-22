/**
 * index.js - Razorpay + Appwrite Function
 *
 * Required environment variables (set in Appwrite function settings):
 * - RAZORPAY_KEY_ID
 * - RAZORPAY_KEY_SECRET
 * - APPWRITE_ENDPOINT
 * - APPWRITE_PROJECT
 * - APPWRITE_API_KEY
 * - APPWRITE_DATABASE_ID
 * - APPWRITE_ORDERS_COLLECTION_ID
 *
 * This function returns a canonical JSON result on success:
 * { ok: true, orderId, razorpayOrderId, amount, currency, razorpayKeyId }
 *
 * and on failure:
 * { ok: false, error: "..." }
 */

const { Client, Databases, ID } = require("node-appwrite");
const Razorpay = require("razorpay");
const crypto = require("crypto");

const env = process.env;

/* ---------- Utilities ---------- */
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
  if (missing.length) throw new Error("Missing env: " + missing.join(", "));
}

function tryParseJSON(s) {
  if (typeof s !== "string") return null;
  try { return JSON.parse(s); } catch { return null; }
}

function bufferToString(obj) {
  if (!obj || !Array.isArray(obj.data)) return null;
  try { return Buffer.from(obj.data).toString("utf8"); } catch { return null; }
}

function getAppwrite() {
  const client = new Client();
  client
    .setEndpoint(env.APPWRITE_ENDPOINT)
    .setProject(env.APPWRITE_PROJECT)
    .setKey(env.APPWRITE_API_KEY);
  const databases = new Databases(client);
  return { client, databases };
}

function toPaise(amount) {
  const n = Number(amount ?? 0);
  if (Number.isNaN(n)) return 0;
  // if likely rupees (< 1e6) convert to paise
  if (n > 0 && n < 1e6 && Math.abs(n - Math.round(n)) < 1e-9) return Math.round(n * 100);
  return Math.round(n);
}

function generateSignature(orderId, paymentId, secret) {
  const h = crypto.createHmac("sha256", secret);
  h.update(`${orderId}|${paymentId}`);
  return h.digest("hex");
}

/* ---------- Allowed fields for Appwrite 'orders' collection ---------- */
const allowedFields = [
  "userId",
  "items",
  "subtotal",
  "totalAmount",
  "currency",
  "shippingAddress",
  "paymentStatus",
  "paymentProvider",
  "paymentReference",
  "razorpayOrderId",
  "razorpayOrderObj",
  "razorpayPaymentId",
  "razorpaySignature",
];

/* ---------- createOrder ---------- */
async function createOrderAction(payload) {
  const { userId } = payload || {};
  if (!userId) return { ok: false, error: "userId required" };

  const items = payload.items ?? [];
  const shippingAddress = payload.shippingAddress ?? {};
  const currency = payload.currency ?? "INR";
  const subtotal = payload.subtotal ?? 0;
  const total = payload.totalAmount ?? subtotal;

  // init razorpay
  const razorpay = new Razorpay({
    key_id: env.RAZORPAY_KEY_ID,
    key_secret: env.RAZORPAY_KEY_SECRET,
  });

  const amountPaise = toPaise(total);
  if (!amountPaise || amountPaise <= 0) return { ok: false, error: "Invalid amount" };

  // Create order on Razorpay
  let rOrder;
  try {
    const orderOptions = {
      amount: amountPaise,
      currency,
      receipt: `rcpt_${Date.now()}`,
      partial_payment: false,
    };
    console.log("Razorpay create order options:", orderOptions);
    rOrder = await razorpay.orders.create(orderOptions);
    console.log("Razorpay order created:", rOrder && rOrder.id ? { id: rOrder.id, status: rOrder.status } : rOrder);
  } catch (err) {
    console.error("Razorpay order create error:", err && err.message ? err.message : err);
    return { ok: false, error: "Razorpay order creation failed: " + (err?.message || String(err)) };
  }

  if (!rOrder || !rOrder.id) return { ok: false, error: "Razorpay did not return an order id" };

  // Prepare document for Appwrite. stringify items/address so Appwrite column can be string
  const rawDocPayload = {
    userId,
    items: typeof items === "string" ? items : JSON.stringify(items),
    subtotal: Number(subtotal),
    totalAmount: Number(total),
    currency,
    shippingAddress: typeof shippingAddress === "string" ? shippingAddress : JSON.stringify(shippingAddress),
    paymentStatus: "created",
    paymentProvider: "razorpay",
    paymentReference: null,
    razorpayOrderId: rOrder.id,
    razorpayOrderObj: JSON.stringify(rOrder),
    razorpayPaymentId: null,
    razorpaySignature: null,
  };

  // Keep only allowed fields (avoids Unknown attribute errors)
  const docPayload = {};
  Object.keys(rawDocPayload).forEach((k) => {
    if (allowedFields.includes(k)) docPayload[k] = rawDocPayload[k];
  });

  try {
    const { databases } = getAppwrite();
    console.log("Creating Appwrite document with payload (filtered):", { ...docPayload, razorpayOrderObj: "[omitted]" });
    const doc = await databases.createDocument(
      env.APPWRITE_DATABASE_ID,
      env.APPWRITE_ORDERS_COLLECTION_ID,
      ID.unique(),
      docPayload
    );
    console.log("Appwrite createDocument result:", { $id: doc.$id });

    // Return canonical response for client. Include razorpayKeyId for client usage (non-secret).
    return {
      ok: true,
      orderId: doc.$id,
      razorpayOrderId: rOrder.id,
      amount: amountPaise,
      currency,
      razorpayKeyId: env.RAZORPAY_KEY_ID || null,
    };
  } catch (err) {
    console.error("Appwrite createDocument error:", err && err.message ? err.message : err);
    return { ok: false, error: "Appwrite save order failed: " + (err?.message || String(err)) };
  }
}

/* ---------- verifyPayment ---------- */
async function verifyPaymentAction(payload) {
  const { orderId, razorpayPaymentId, razorpayOrderId, razorpaySignature } = payload || {};
  if (!orderId || !razorpayPaymentId || !razorpayOrderId || !razorpaySignature) {
    return { ok: false, error: "Missing verification fields" };
  }

  const expected = generateSignature(razorpayOrderId, razorpayPaymentId, env.RAZORPAY_KEY_SECRET);
  if (expected !== razorpaySignature) return { ok: false, error: "Invalid signature" };

  try {
    const { databases } = getAppwrite();
    const update = {
      paymentStatus: "paid",
      paymentReference: razorpayPaymentId,
      razorpayPaymentId,
      razorpaySignature,
    };
    const updated = await databases.updateDocument(
      env.APPWRITE_DATABASE_ID,
      env.APPWRITE_ORDERS_COLLECTION_ID,
      orderId,
      update
    );
    console.log("Appwrite updateDocument success:", { $id: updated.$id });
    return { ok: true, orderId: updated.$id, razorpayPaymentId, message: "Payment verified" };
  } catch (err) {
    console.error("Appwrite updateDocument error:", err);
    return { ok: false, error: "Failed to update order: " + (err?.message || String(err)) };
  }
}

/* ---------- Router ---------- */
async function handleAction(body) {
  const actionFromBody = (body && (body.action || (body.payload && body.payload.action))) || null;
  const payload = (body && body.payload) || body || {};

  const act =
    (actionFromBody ||
      payload.action ||
      (payload.razorpayPaymentId ? "verifyPayment" : "createOrder") ||
      "createOrder"
    )
      .toString()
      .toLowerCase();

  if (act === "createorder") return await createOrderAction(payload);
  if (act === "verifypayment") return await verifyPaymentAction(payload);
  if (payload.razorpayPaymentId) return await verifyPaymentAction(payload);
  return await createOrderAction(payload);
}

/* ---------- Robust input parsing + response handling ---------- */
async function runHandler(rawArg, rawRes) {
  console.log("=== runHandler start ===");

  let req = rawArg;
  let res = rawRes;
  // Appwrite may wrap: { req: {...}, res: {...} }
  if (req && typeof req === "object" && req.req && typeof req.req === "object") {
    req = req.req;
    res = rawArg.res || res;
    console.log("Unwrapped wrapper: using req = rawArg.req");
  }

  // validate env
  try { checkEnv(); } catch (err) {
    console.error("ENV missing:", err && err.message ? err.message : err);
    const out = { ok: false, error: "Missing env vars: " + (err.message || String(err)) };
    if (res && typeof res.status === "function") return res.status(500).json(out);
    console.log(JSON.stringify(out));
    return out;
  }

  // parse input: many shapes
  let input = {};
  try {
    if (req && req.bodyJson && typeof req.bodyJson === "object") {
      input = req.bodyJson;
      console.log("Input <- req.bodyJson");
    } else if (req && req.body && typeof req.body === "object") {
      input = req.body;
      console.log("Input <- req.body (object)");
    } else if (req && req.body && typeof req.body === "string") {
      const p = tryParseJSON(req.body);
      if (p) { input = p; console.log("Input <- parsed req.body string"); } else console.log("req.body string present but parse failed");
    } else if (req && req.bodyText && typeof req.bodyText === "string") {
      const p = tryParseJSON(req.bodyText);
      if (p) { input = p; console.log("Input <- parsed req.bodyText"); } else console.log("req.bodyText parse failed");
    } else if (req && req.bodyRaw && typeof req.bodyRaw === "string") {
      const p = tryParseJSON(req.bodyRaw);
      if (p) { input = p; console.log("Input <- parsed req.bodyRaw"); }
    } else if (req && req.bodyBinary && req.bodyBinary.data) {
      const s = bufferToString(req.bodyBinary);
      const p = tryParseJSON(s);
      if (p) { input = p; console.log("Input <- parsed bodyBinary"); }
    } else if (process.env.APPWRITE_FUNCTION_DATA) {
      const p = tryParseJSON(process.env.APPWRITE_FUNCTION_DATA);
      input = p ? p : process.env.APPWRITE_FUNCTION_DATA;
      console.log("Input <- APPWRITE_FUNCTION_DATA");
    } else if (typeof rawArg === "string") {
      const p = tryParseJSON(rawArg);
      if (p) { input = p; console.log("Input <- rawArg string"); }
    } else {
      input = req || {};
      console.log("Input <- fallback req");
    }
  } catch (e) {
    console.error("Failed to parse input:", e);
    input = {};
  }

  try {
    console.log("FINAL input preview:", JSON.stringify(input).slice(0, 200));
  } catch (e) { console.log("FINAL input (non-serializable)"); }

  // execute action and respond
  try {
    const result = await handleAction(input);

    // Appwrite new runtime: res.json(result, status)
    if (res && typeof res.json === "function") {
      const status = result && result.ok === false ? 400 : 200;
      try { return res.json(result, status); } catch (e) { console.warn("res.json failed, falling back:", e); }
    }

    // older express-like res
    if (res && typeof res.status === "function") {
      if (result && result.ok === false) return res.status(400).json(result);
      return res.status(200).json(result);
    }

    // fallback console
    console.log(JSON.stringify(result));
    return result;
  } catch (err) {
    console.error("ACTION ERROR:", err);
    const out = { ok: false, error: err.message || String(err) };
    if (res && typeof res.json === "function") {
      try { return res.json(out, 500); } catch (e) { console.warn("res.json error in catch:", e); }
    }
    if (res && typeof res.status === "function") return res.status(500).json(out);
    console.log(JSON.stringify(out));
    return out;
  }
}

/* Export */
module.exports = async function (req, res) {
  return runHandler(req, res);
};

/* Local execution support for testing */
if (require.main === module) {
  (async () => {
    try {
      const raw = process.env.APPWRITE_FUNCTION_DATA || "{}";
      const body = tryParseJSON(raw) || {};
      const out = await handleAction(body);
      console.log(JSON.stringify(out, null, 2));
    } catch (e) {
      console.error(e);
    }
  })();
}
