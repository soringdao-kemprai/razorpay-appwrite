// index.js - Appwrite Function: createOrder + verifyPayment (product-linked)
// Requires env vars:
// RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET,
// APPWRITE_ENDPOINT, APPWRITE_PROJECT, APPWRITE_API_KEY,
// APPWRITE_DATABASE_ID, APPWRITE_PRODUCTS_COLLECTION_ID, APPWRITE_ORDERS_COLLECTION_ID

const { Client, Databases, ID, Query } = require("node-appwrite");
const Razorpay = require("razorpay");
const crypto = require("crypto");

const env = process.env;

/* -------------------------------------------------------------------------- */
/*                              ENV VALIDATION                                */
/* -------------------------------------------------------------------------- */
function checkEnv() {
  const required = [
    "RAZORPAY_KEY_ID",
    "RAZORPAY_KEY_SECRET",
    "APPWRITE_ENDPOINT",
    "APPWRITE_PROJECT",
    "APPWRITE_API_KEY",
    "APPWRITE_DATABASE_ID",
    "APPWRITE_ORDERS_COLLECTION_ID",
    "APPWRITE_PRODUCTS_COLLECTION_ID",
  ];
  const missing = required.filter((k) => !env[k]);
  if (missing.length) throw new Error("Missing env: " + missing.join(", "));
}

/* -------------------------------------------------------------------------- */
/*                              UTIL FUNCTIONS                                */
/* -------------------------------------------------------------------------- */
function tryParseJSON(s) {
  if (typeof s !== "string") return null;
  try { return JSON.parse(s); } catch { return null; }
}

function getAppwrite() {
  const client = new Client()
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

/* -------------------------------------------------------------------------- */
/*                            CREATE ORDER ACTION                             */
/* -------------------------------------------------------------------------- */
async function createOrderAction(payload) {
  const { userId } = payload || {};
  if (!userId) return { ok: false, error: "userId required" };

  const items = payload.items ?? [];
  const shippingAddress = payload.shippingAddress ?? {};
  const currency = payload.currency ?? "INR";
  const { databases } = getAppwrite();

  if (!Array.isArray(items) || items.length === 0)
    return { ok: false, error: "items array required" };

  // Build enriched items by fetching product docs and computing price
  let computedTotal = 0;
  const enrichedItems = [];

  for (const it of items) {
    const productId = String(it.productId ?? it.id ?? "");
    if (!productId) return { ok: false, error: "productId required for each item" };
    const quantity = Number(it.quantity ?? 1);
    if (Number.isNaN(quantity) || quantity <= 0) return { ok: false, error: "invalid quantity for " + productId };

    let productDoc = null;
    try {
      productDoc = await databases.getDocument(env.APPWRITE_DATABASE_ID, env.APPWRITE_PRODUCTS_COLLECTION_ID, productId);
    } catch (err) {
      console.error("Product fetch failed for", productId, err && (err.message || err));
      return { ok: false, error: `Product not found: ${productId}` };
    }

    // Determine unit price from product doc fields (adapt to your product schema)
    const unitPrice = Number(productDoc.price ?? productDoc.pricePerPiece ?? productDoc.mrp ?? 0);
    const lineTotal = unitPrice * quantity;
    computedTotal += lineTotal;

    enrichedItems.push({
      productId,
      quantity,
      price: unitPrice,
      lineTotal,
      productSnapshot: {
        $id: productDoc.$id,
        productName: productDoc.productName ?? productDoc.name ?? null,
        category: productDoc.category ?? null,
      },
    });
  }

  if (computedTotal <= 0) return { ok: false, error: "Invalid total computed from products" };

  const razorpay = new Razorpay({
    key_id: env.RAZORPAY_KEY_ID,
    key_secret: env.RAZORPAY_KEY_SECRET,
  });

  const amountPaise = toPaise(computedTotal);
  let rOrder;
  try {
    const opts = { amount: amountPaise, currency, receipt: `rcpt_${Date.now()}`, partial_payment: false };
    console.log("Creating Razorpay order:", opts);
    rOrder = await razorpay.orders.create(opts);
    console.log("Razorpay order created:", rOrder && rOrder.id ? rOrder.id : JSON.stringify(rOrder));
  } catch (err) {
    console.error("Razorpay create error:", err && (err.message || err));
    return { ok: false, error: "Razorpay create failed: " + (err?.message || String(err)) };
  }

  const rawDocPayload = {
    userId,
    items: JSON.stringify(enrichedItems),
    subtotal: Number(computedTotal),
    totalAmount: Number(computedTotal),
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

  try {
    const doc = await databases.createDocument(env.APPWRITE_DATABASE_ID, env.APPWRITE_ORDERS_COLLECTION_ID, ID.unique(), rawDocPayload);
    console.log("Order doc created:", doc.$id);
    return { ok: true, orderId: doc.$id, razorpayOrderId: rOrder.id, amount: amountPaise, currency };
  } catch (err) {
    console.error("Appwrite save error:", err && (err.message || err));
    return { ok: false, error: "Appwrite save failed: " + (err?.message || String(err)) };
  }
}

/* -------------------------------------------------------------------------- */
/*                            VERIFY PAYMENT ACTION                           */
/* -------------------------------------------------------------------------- */
async function verifyPaymentAction(payload) {
  const { orderId, razorpayPaymentId, razorpayOrderId, razorpaySignature } = payload || {};

  if (!razorpayPaymentId || !razorpayOrderId || !razorpaySignature)
    return { ok: false, error: "Missing required Razorpay fields for verification" };

  const expected = generateSignature(razorpayOrderId, razorpayPaymentId, env.RAZORPAY_KEY_SECRET);
  if (expected !== razorpaySignature) return { ok: false, error: "Invalid signature" };

  try {
    const { databases } = getAppwrite();
    let docId = orderId ?? null;

    if (!docId) {
      const res = await databases.listDocuments(env.APPWRITE_DATABASE_ID, env.APPWRITE_ORDERS_COLLECTION_ID, [Query.equal("razorpayOrderId", razorpayOrderId)]);
      if (res.documents?.length) docId = res.documents[0].$id;
    }

    if (!docId) return { ok: false, error: "Order not found for verification" };

    const updated = await databases.updateDocument(env.APPWRITE_DATABASE_ID, env.APPWRITE_ORDERS_COLLECTION_ID, docId, {
      paymentStatus: "paid",
      paymentReference: razorpayPaymentId,
      razorpayPaymentId,
      razorpaySignature,
    });

    console.log("Payment verified:", updated.$id);
    return { ok: true, orderId: updated.$id, message: "Payment verified" };
  } catch (err) {
    console.error("verifyPaymentAction error:", err && (err.message || err));
    return { ok: false, error: err?.message ?? String(err) };
  }
}

/* -------------------------------------------------------------------------- */
/*                                MAIN HANDLER                                */
/* -------------------------------------------------------------------------- */
async function handleAction(body) {
  const action = (body && (body.action || body.payload?.action))?.toString()?.toLowerCase?.() ?? null;
  const payload = body?.payload || body || {};

  if (action === "verifypayment") return await verifyPaymentAction(payload);
  return await createOrderAction(payload);
}

async function runHandler(rawArg, rawRes) {
  console.log("=== Razorpay Function Start ===");
  try { checkEnv(); } catch (err) {
    console.error("ENV missing:", err && err.message ? err.message : err);
    const out = { ok: false, error: "Missing env vars: " + (err && err.message ? err.message : String(err)) };
    if (rawRes?.json) return rawRes.json(out, 500);
    console.log(JSON.stringify(out));
    return out;
  }

  // parse input similar to your previous function code
  let input = {};
  try {
    if (rawArg?.bodyJson && typeof rawArg.bodyJson === "object") input = rawArg.bodyJson;
    else if (rawArg?.body && typeof rawArg.body === "string") input = tryParseJSON(rawArg.body) || {};
    else if (typeof rawArg === "string") input = tryParseJSON(rawArg) || {};
    else if (process.env.APPWRITE_FUNCTION_DATA) input = tryParseJSON(process.env.APPWRITE_FUNCTION_DATA) || {};
    else input = rawArg || {};
  } catch (e) {
    console.error("Failed to parse input:", e && e.message ? e.message : e);
  }

  console.log("Input preview:", JSON.stringify(input).slice(0,300));

  try {
    const result = await handleAction(input);
    console.log("FUNCTION_RESULT:", JSON.stringify(result));
    if (rawRes?.json) {
      const status = result?.ok === false ? 400 : 200;
      return rawRes.json(result, status);
    }
    return result;
  } catch (err) {
    console.error("Handler error:", err && err.message ? err.message : err);
    const out = { ok: false, error: err && err.message ? err.message : String(err) };
    if (rawRes?.json) return rawRes.json(out, 500);
    console.log(JSON.stringify(out));
    return out;
  }
}

module.exports = async function (req, res) {
  return runHandler(req, res);
};
