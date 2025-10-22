// index.js - Razorpay / Appwrite function (async-friendly, quick-response)
// Required env vars:
// - RAZORPAY_KEY_ID
// - RAZORPAY_KEY_SECRET
// - APPWRITE_ENDPOINT
// - APPWRITE_PROJECT
// - APPWRITE_API_KEY
// - APPWRITE_DATABASE_ID
// - APPWRITE_ORDERS_COLLECTION_ID

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
  client.setEndpoint(env.APPWRITE_ENDPOINT).setProject(env.APPWRITE_PROJECT).setKey(env.APPWRITE_API_KEY);
  const databases = new Databases(client);
  return { client, databases };
}

/**
 * Convert a numeric value to paise.
 * If value looks like rupees (reasonable size), multiply by 100.
 * If value already looks like paise (large number), return as-is.
 */
function toPaise(amount) {
  const n = Number(amount ?? 0);
  if (Number.isNaN(n)) return 0;
  // treat < 1e6 as rupees (safe heuristic)
  if (n > 0 && n < 1e6 && Math.abs(n - Math.round(n)) < 1e-9) {
    return Math.round(n * 100);
  }
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

/* ---------- Helpers ---------- */

/**
 * Safely compute order total from items if client didn't provide totals.
 * Accepts item objects in payload like { productId, quantity, price }.
 * If item.price is present use it; otherwise fallback to 0.
 */
function computeTotalFromItems(items) {
  if (!items || !Array.isArray(items)) return 0;
  let total = 0;
  for (const it of items) {
    const qty = Number(it.quantity ?? it.q ?? it.qty ?? 0) || 0;
    const price = Number(it.price ?? it.unitPrice ?? it.pricePerUnit ?? 0) || 0;
    total += qty * price;
  }
  return total;
}

/* ---------- Action: createOrder ---------- */
async function createOrderAction(payload) {
  const { userId } = payload || {};
  if (!userId) return { ok: false, error: "userId required" };

  const items = payload.items ?? [];
  const shippingAddress = payload.shippingAddress ?? {};
  const currency = payload.currency ?? "INR";
  const subtotalProvided = payload.subtotal;
  const totalProvided = payload.totalAmount;

  // If totals not provided, compute from items (client should provide price fields)
  let totalToUse = null;
  if (totalProvided != null && !Number.isNaN(Number(totalProvided))) {
    totalToUse = Number(totalProvided);
  } else if (subtotalProvided != null && !Number.isNaN(Number(subtotalProvided))) {
    totalToUse = Number(subtotalProvided);
  } else {
    const computed = computeTotalFromItems(items);
    totalToUse = computed || 0;
  }

  // If still zero or invalid, fail with clear message
  if (!totalToUse || Number(totalToUse) <= 0) {
    return { ok: false, error: "Invalid amount: pass subtotal/totalAmount or include item.price fields" };
  }

  // Razorpay instance
  const razorpay = new Razorpay({
    key_id: env.RAZORPAY_KEY_ID,
    key_secret: env.RAZORPAY_KEY_SECRET,
  });

  const amountPaise = toPaise(totalToUse);
  if (!amountPaise || amountPaise <= 0) {
    return { ok: false, error: "Invalid amount after conversion to paise" };
  }

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

  if (!rOrder || !rOrder.id) {
    console.error("Razorpay order missing id:", rOrder);
    return { ok: false, error: "Razorpay did not return an order id" };
  }

  // Prepare doc payload (stringify items/shippingAddress if needed)
  const rawDocPayload = {
    userId,
    items: typeof items === "string" ? items : JSON.stringify(items),
    subtotal: Number(subtotalProvided ?? totalToUse),
    totalAmount: Number(totalToUse),
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

  // Filter docPayload to only allowed fields (prevents "Unknown attribute" errors)
  const docPayload = {};
  for (const k of Object.keys(rawDocPayload)) {
    if (allowedFields.includes(k)) docPayload[k] = rawDocPayload[k];
  }

  // NON-BLOCKING: create Appwrite document in background (fire-and-forget)
  try {
    const { databases } = getAppwrite();
    console.log("Creating Appwrite document (non-blocking):", { ...docPayload, razorpayOrderObj: "[omitted]" });

    // call but do NOT await — let it finish in the background
    databases.createDocument(
      env.APPWRITE_DATABASE_ID,
      env.APPWRITE_ORDERS_COLLECTION_ID,
      ID.unique(),
      docPayload
    ).then((doc) => {
      console.log("Appwrite createDocument result (async):", { $id: doc.$id });
    }).catch((err) => {
      console.error("Appwrite createDocument async error:", err && err.message ? err.message : err);
    });
  } catch (err) {
    // Log the non-fatal error, but do not block response
    console.error("Failed to start async createDocument:", err && err.message ? err.message : err);
  }

  // Return response immediately for frontend so app won't timeout
  return {
    ok: true,
    // Because DB create is async, we cannot return its $id here. Use a temporary client-visible id if needed:
    orderId: "temp_" + Date.now(),
    razorpayOrderId: rOrder.id,
    amount: amountPaise,
    currency,
  };
}

/* ---------- Action: verifyPayment ---------- */
async function verifyPaymentAction(payload) {
  const { orderId, razorpayPaymentId, razorpayOrderId, razorpaySignature } = payload || {};
  if (!orderId || !razorpayPaymentId || !razorpayOrderId || !razorpaySignature) {
    return { ok: false, error: "Missing verification fields" };
  }

  const expected = generateSignature(razorpayOrderId, razorpayPaymentId, env.RAZORPAY_KEY_SECRET);
  if (expected !== razorpaySignature) {
    return { ok: false, error: "Invalid signature" };
  }

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
    console.error("Appwrite updateDocument error:", err && err.message ? err.message : err);
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
  if (req && typeof req === "object" && req.req && typeof req.req === "object") {
    req = req.req;
    res = rawArg.res || res;
    console.log("Unwrapped wrapper: using req = rawArg.req");
  }

  // ensure env
  try { checkEnv(); } catch (err) {
    console.error("ENV missing:", err && err.message ? err.message : err);
    const out = { ok: false, error: "Missing env vars: " + (err.message || String(err)) };
    if (res && typeof res.status === "function") return res.status(500).json(out);
    console.log(JSON.stringify(out));
    return out;
  }

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

  try {
    const result = await handleAction(input);

    if (res && typeof res.json === "function") {
      const status = result && result.ok === false ? 400 : 200;
      try { return res.json(result, status); } catch (e) { console.warn("res.json failed, falling back:", e); }
    }

    if (res && typeof res.status === "function") {
      if (result && result.ok === false) return res.status(400).json(result);
      return res.status(200).json(result);
    }

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

/* ---------- Export handler ---------- */
module.exports = async function (req, res) {
  return runHandler(req, res);
};

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
