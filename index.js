// index.js - Appwrite Function: createOrder (sync) + verifyPayment (robust)
// Requires env vars:
// RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET,
// APPWRITE_ENDPOINT, APPWRITE_PROJECT, APPWRITE_API_KEY,
// APPWRITE_DATABASE_ID, APPWRITE_ORDERS_COLLECTION_ID, APPWRITE_PRODUCTS_COLLECTION_ID

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
    "APPWRITE_PRODUCTS_COLLECTION_ID", // NEW
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

function bufferToString(obj) {
  if (!obj || !Array.isArray(obj.data)) return null;
  try { return Buffer.from(obj.data).toString("utf8"); } catch { return null; }
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
/*                          ORDER CREATION (UPDATED)                          */
/* -------------------------------------------------------------------------- */
async function createOrderAction(payload) {
  const { userId } = payload || {};
  if (!userId) return { ok: false, error: "userId required" };

  const items = payload.items ?? [];
  const shippingAddress = payload.shippingAddress ?? {};
  const currency = payload.currency ?? "INR";

  if (!Array.isArray(items) || items.length === 0)
    return { ok: false, error: "items array required" };

  // validate shape
  for (const it of items) {
    if (!it.productId)
      return { ok: false, error: "each item must include productId" };
    if (!it.quantity || Number(it.quantity) <= 0)
      return { ok: false, error: "invalid quantity for item " + JSON.stringify(it) };
  }

  const { databases } = getAppwrite();
  const productsColl = env.APPWRITE_PRODUCTS_COLLECTION_ID;

  let computedTotal = 0;
  const enrichedItems = [];

  for (const it of items) {
    const pid = String(it.productId);
    let productDoc = null;
    try {
      productDoc = await databases.getDocument(env.APPWRITE_DATABASE_ID, productsColl, pid);
    } catch (err) {
      console.error("Product fetch failed:", pid, err.message);
      productDoc = null;
    }

    if (!productDoc)
      return { ok: false, error: `Product not found: ${pid}` };

    const unitPrice = Number(productDoc.price ?? productDoc.pricePerPiece ?? 0);
    const qty = Number(it.quantity ?? 0);
    const lineTotal = unitPrice * qty;
    computedTotal += lineTotal;

    enrichedItems.push({
      productId: pid,
      quantity: qty,
      unitPrice,
      lineTotal,
      productSnapshot: {
        $id: productDoc.$id,
        productName: productDoc.productName ?? productDoc.name ?? null,
        category: productDoc.category ?? null,
      },
    });
  }

  const totalToUse = computedTotal;
  if (!totalToUse || Number(totalToUse) <= 0)
    return { ok: false, error: "Invalid total computed from products" };

  const razorpay = new Razorpay({
    key_id: env.RAZORPAY_KEY_ID,
    key_secret: env.RAZORPAY_KEY_SECRET,
  });

  const amountPaise = toPaise(totalToUse);
  if (!amountPaise || amountPaise <= 0)
    return { ok: false, error: "Invalid amount after paise conversion" };

  let rOrder;
  try {
    const opts = {
      amount: amountPaise,
      currency,
      receipt: `rcpt_${Date.now()}`,
      partial_payment: false,
    };
    console.log("Creating Razorpay order:", opts);
    rOrder = await razorpay.orders.create(opts);
    console.log("Razorpay order created:", rOrder.id);
  } catch (err) {
    console.error("Razorpay order create error:", err.message);
    return { ok: false, error: "Razorpay create failed: " + err.message };
  }

  // Prepare Appwrite document payload
  const rawDocPayload = {
    userId,
    items: JSON.stringify(enrichedItems),
    subtotal: Number(totalToUse),
    totalAmount: Number(totalToUse),
    currency,
    shippingAddress: JSON.stringify(shippingAddress),
    paymentStatus: "created",
    paymentProvider: "razorpay",
    paymentReference: null,
    razorpayOrderId: rOrder.id,
    razorpayOrderObj: JSON.stringify(rOrder),
    razorpayPaymentId: null,
    razorpaySignature: null,
  };

  try {
    const doc = await databases.createDocument(
      env.APPWRITE_DATABASE_ID,
      env.APPWRITE_ORDERS_COLLECTION_ID,
      ID.unique(),
      rawDocPayload
    );
    console.log("Appwrite order doc created:", doc.$id);
    return {
      ok: true,
      orderId: doc.$id,
      razorpayOrderId: rOrder.id,
      amount: amountPaise,
      currency,
    };
  } catch (err) {
    console.error("Appwrite createDocument error:", err.message);
    return {
      ok: false,
      error: "Appwrite save failed: " + err.message,
      raw: { razorpayOrderId: rOrder.id, amount: amountPaise, currency },
    };
  }
}

/* -------------------------------------------------------------------------- */
/*                             VERIFY PAYMENT                                 */
/* -------------------------------------------------------------------------- */
async function verifyPaymentAction(payload) {
  const { orderId, razorpayPaymentId, razorpayOrderId, razorpaySignature } =
    payload || {};

  if (!razorpayPaymentId || !razorpayOrderId || !razorpaySignature)
    return {
      ok: false,
      error: "Missing razorpayPaymentId, razorpayOrderId or razorpaySignature",
    };

  const expected = generateSignature(
    razorpayOrderId,
    razorpayPaymentId,
    env.RAZORPAY_KEY_SECRET
  );
  if (expected !== razorpaySignature)
    return { ok: false, error: "Invalid signature" };

  try {
    const { databases } = getAppwrite();
    let docIdToUpdate = orderId ?? null;

    // fallback: find by razorpayOrderId
    if (!docIdToUpdate) {
      const res = await databases.listDocuments(
        env.APPWRITE_DATABASE_ID,
        env.APPWRITE_ORDERS_COLLECTION_ID,
        [Query.equal("razorpayOrderId", razorpayOrderId)]
      );
      if (res.documents?.length) docIdToUpdate = res.documents[0].$id;
    }

    if (!docIdToUpdate)
      return { ok: false, error: "Order not found for verification" };

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

    console.log("Order verified:", updated.$id);
    return { ok: true, orderId: updated.$id, message: "Payment verified" };
  } catch (err) {
    console.error("verifyPaymentAction error:", err.message);
    return { ok: false, error: err.message };
  }
}

/* -------------------------------------------------------------------------- */
/*                               MAIN HANDLER                                 */
/* -------------------------------------------------------------------------- */
async function handleAction(body) {
  const action =
    (body && (body.action || body.payload?.action))?.toString()?.toLowerCase?.() ??
    null;
  const payload = body?.payload || body || {};

  if (action === "verifypayment") return await verifyPaymentAction(payload);
  return await createOrderAction(payload);
}

/* -------------------------------------------------------------------------- */
/*                               ENTRY POINT                                  */
/* -------------------------------------------------------------------------- */
async function runHandler(rawArg, rawRes) {
  console.log("=== Appwrite Function: Razorpay Handler Start ===");
  try {
    checkEnv();
  } catch (err) {
    console.error("ENV missing:", err.message);
    const out = { ok: false, error: "Missing env vars: " + err.message };
    if (rawRes?.json) return rawRes.json(out, 500);
    console.log(JSON.stringify(out));
    return out;
  }

  // Parse input
  let input = {};
  try {
    if (rawArg?.bodyJson && typeof rawArg.bodyJson === "object")
      input = rawArg.bodyJson;
    else if (rawArg?.body && typeof rawArg.body === "object")
      input = rawArg.body;
    else if (typeof rawArg === "string") input = tryParseJSON(rawArg) || {};
    else if (process.env.APPWRITE_FUNCTION_DATA)
      input = tryParseJSON(process.env.APPWRITE_FUNCTION_DATA) || {};
  } catch (e) {
    console.error("Failed to parse input:", e);
  }

  console.log("Input preview:", JSON.stringify(input).slice(0, 300));

  try {
    const result = await handleAction(input);
    if (rawRes?.json) {
      const status = result?.ok === false ? 400 : 200;
      return rawRes.json(result, status);
    }
    console.log(JSON.stringify(result));
    return result;
  } catch (err) {
    console.error("Handler error:", err);
    const out = { ok: false, error: err.message };
    if (rawRes?.json) return rawRes.json(out, 500);
    console.log(JSON.stringify(out));
    return out;
  }
}

module.exports = async function (req, res) {
  return runHandler(req, res);
};

// Local testing
if (require.main === module) {
  (async () => {
    const raw = process.env.APPWRITE_FUNCTION_DATA || "{}";
    const body = tryParseJSON(raw) || {};
    const out = await handleAction(body);
    console.log(JSON.stringify(out, null, 2));
  })();
}
