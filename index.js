// index.js - Appwrite Function: createOrder (sync) + verifyPayment (robust)
// Requires env vars:
// RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, APPWRITE_ENDPOINT, APPWRITE_PROJECT, APPWRITE_API_KEY,
// APPWRITE_DATABASE_ID, APPWRITE_ORDERS_COLLECTION_ID

const { Client, Databases, ID, Query } = require("node-appwrite");
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

const allowedFields = [
  "userId","items","subtotal","totalAmount","currency","shippingAddress",
  "paymentStatus","paymentProvider","paymentReference","razorpayOrderId",
  "razorpayOrderObj","razorpayPaymentId","razorpaySignature",
];

function computeTotalFromItems(items) {
  if (!items || !Array.isArray(items)) return 0;
  let total = 0;
  for (const it of items) {
    const qty = Number(it.quantity ?? it.q ?? it.qty ?? 0) || 0;
    const price = Number(it.price ?? it.unitPrice ?? 0) || 0;
    total += qty * price;
  }
  return total;
}

/* ---------- createOrder (synchronous DB save) ---------- */
async function createOrderAction(payload) {
  const { userId } = payload || {};
  if (!userId) return { ok: false, error: "userId required" };

  const items = payload.items ?? [];
  const shippingAddress = payload.shippingAddress ?? {};
  const currency = payload.currency ?? "INR";
  const subtotalProvided = payload.subtotal;
  const totalProvided = payload.totalAmount;

  let totalToUse = null;
  if (totalProvided != null && !Number.isNaN(Number(totalProvided))) totalToUse = Number(totalProvided);
  else if (subtotalProvided != null && !Number.isNaN(Number(subtotalProvided))) totalToUse = Number(subtotalProvided);
  else {
    const computed = computeTotalFromItems(items);
    totalToUse = computed || 0;
  }

  if (!totalToUse || Number(totalToUse) <= 0) {
    return { ok: false, error: "Invalid amount: pass subtotal/totalAmount or include item.price fields" };
  }

  const razorpay = new Razorpay({ key_id: env.RAZORPAY_KEY_ID, key_secret: env.RAZORPAY_KEY_SECRET });
  const amountPaise = toPaise(totalToUse);
  if (!amountPaise || amountPaise <= 0) return { ok: false, error: "Invalid amount after conversion to paise" };

  let rOrder;
  try {
    const opts = { amount: amountPaise, currency, receipt: `rcpt_${Date.now()}`, partial_payment: false };
    console.log("Razorpay create order options:", opts);
    rOrder = await razorpay.orders.create(opts);
    console.log("Razorpay order created:", rOrder && rOrder.id ? { id: rOrder.id, status: rOrder.status } : rOrder);
  } catch (err) {
    console.error("Razorpay order create error:", err && err.message ? err.message : err);
    return { ok: false, error: "Razorpay order creation failed: " + (err?.message || String(err)) };
  }

  if (!rOrder || !rOrder.id) {
    console.error("Razorpay order missing id:", rOrder);
    return { ok: false, error: "Razorpay did not return an order id" };
  }

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

  const docPayload = {};
  for (const k of Object.keys(rawDocPayload)) {
    if (allowedFields.includes(k)) docPayload[k] = rawDocPayload[k];
  }

  try {
    const { databases } = getAppwrite();
    console.log("Creating Appwrite document (sync):", { ...docPayload, razorpayOrderObj: "[omitted]" });

    const doc = await databases.createDocument(
      env.APPWRITE_DATABASE_ID,
      env.APPWRITE_ORDERS_COLLECTION_ID,
      ID.unique(),
      docPayload
    );

    console.log("Appwrite createDocument result:", { $id: doc.$id });

    return {
      ok: true,
      orderId: doc.$id,
      razorpayOrderId: rOrder.id,
      amount: amountPaise,
      currency,
    };
  } catch (err) {
    console.error("Appwrite createDocument error (sync):", err && err.message ? err.message : err);
    return {
      ok: false,
      error: "Appwrite save order failed: " + (err?.message || String(err)),
      raw: { razorpayOrderId: rOrder.id, amount: amountPaise, currency },
    };
  }
}

/* ---------- verifyPayment (fallback lookup by razorpayOrderId) ---------- */
async function verifyPaymentAction(payload) {
  const { orderId, razorpayPaymentId, razorpayOrderId, razorpaySignature } = payload || {};

  if (!razorpayPaymentId || !razorpayOrderId || !razorpaySignature) {
    return { ok: false, error: "Missing verification fields (razorpayPaymentId, razorpayOrderId, razorpaySignature required)" };
  }

  const expected = generateSignature(razorpayOrderId, razorpayPaymentId, env.RAZORPAY_KEY_SECRET);
  if (expected !== razorpaySignature) return { ok: false, error: "Invalid signature" };

  try {
    const { databases } = getAppwrite();
    let docIdToUpdate = orderId ?? null;

    if (!docIdToUpdate) {
      try {
        const listRes = await databases.listDocuments(
          env.APPWRITE_DATABASE_ID,
          env.APPWRITE_ORDERS_COLLECTION_ID,
          [ Query.equal("razorpayOrderId", razorpayOrderId) ]
        );
        if (listRes && Array.isArray(listRes.documents) && listRes.documents.length > 0) {
          docIdToUpdate = listRes.documents[0].$id;
          console.log("Found order document by razorpayOrderId:", docIdToUpdate);
        } else {
          console.warn("No Appwrite order doc found for razorpayOrderId:", razorpayOrderId);
        }
      } catch (listErr) {
        console.error("Error listing documents by razorpayOrderId:", listErr);
      }
    }

    if (!docIdToUpdate) return { ok: false, error: "Order document not found for verification. Provide valid orderId or ensure DB contains razorpayOrderId." };

    const update = {
      paymentStatus: "paid",
      paymentReference: razorpayPaymentId,
      razorpayPaymentId,
      razorpaySignature,
    };

    const updated = await databases.updateDocument(
      env.APPWRITE_DATABASE_ID,
      env.APPWRITE_ORDERS_COLLECTION_ID,
      docIdToUpdate,
      update
    );

    console.log("Appwrite updateDocument success:", { $id: updated.$id });
    return { ok: true, orderId: updated.$id, razorpayPaymentId, message: "Payment verified" };
  } catch (err) {
    console.error("Appwrite updateDocument error:", err && err.message ? err.message : err);
    return { ok: false, error: "Failed to update order: " + (err?.message || String(err)) };
  }
}

/* ---------- Router & input parsing ---------- */
async function handleAction(body) {
  const actionFromBody = (body && (body.action || (body.payload && body.payload.action))) || null;
  const payload = (body && body.payload) || body || {};

  const act = (actionFromBody || payload.action || (payload.razorpayPaymentId ? "verifyPayment" : "createOrder") || "createOrder").toString().toLowerCase();

  if (act === "createorder") return await createOrderAction(payload);
  if (act === "verifypayment") return await verifyPaymentAction(payload);
  if (payload.razorpayPaymentId) return await verifyPaymentAction(payload);
  return await createOrderAction(payload);
}

async function runHandler(rawArg, rawRes) {
  console.log("=== runHandler start ===");

  let req = rawArg;
  let res = rawRes;
  if (req && typeof req === "object" && req.req && typeof req.req === "object") {
    req = req.req;
    res = rawArg.res || res;
    console.log("Unwrapped wrapper: using req = rawArg.req");
  }

  try { checkEnv(); } catch (err) {
    console.error("ENV missing:", err && err.message ? err.message : err);
    const out = { ok: false, error: "Missing env vars: " + (err.message || String(err)) };
    if (res && typeof res.status === "function") return res.status(500).json(out);
    console.log(JSON.stringify(out));
    return out;
  }

  let input = {};
  try {
    if (req && req.bodyJson && typeof req.bodyJson === "object") input = req.bodyJson;
    else if (req && req.body && typeof req.body === "object") input = req.body;
    else if (req && req.body && typeof req.body === "string") {
      const p = tryParseJSON(req.body); if (p) input = p;
    } else if (req && req.bodyBinary && req.bodyBinary.data) {
      const s = bufferToString(req.bodyBinary); const p = tryParseJSON(s); if (p) input = p;
    } else if (process.env.APPWRITE_FUNCTION_DATA) {
      const p = tryParseJSON(process.env.APPWRITE_FUNCTION_DATA); input = p ? p : process.env.APPWRITE_FUNCTION_DATA;
    } else if (typeof rawArg === "string") {
      const p = tryParseJSON(rawArg); if (p) input = p;
    } else input = req || {};
  } catch (e) { console.error("Failed to parse input:", e); input = {}; }

  try { console.log("FINAL input preview:", JSON.stringify(input).slice(0,200)); } catch (e) {}

  try {
    const result = await handleAction(input);
    if (res && typeof res.json === "function") {
      const status = result && result.ok === false ? 400 : 200;
      try { return res.json(result, status); } catch (e) { console.warn("res.json failed:", e); }
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

/* Export */
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
