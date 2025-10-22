/**
 * Appwrite Function: razorpay-appwrite
 *
 * Expects JSON string via functions.createExecution(functionId, JSON.stringify(payload))
 * payload = { action: "createOrder" | "verifyPayment", payload: {...} }
 *
 * createOrder payload: { items: [{ productId, quantity }], userId, shippingAddress: { text, phone } }
 * verifyPayment payload: { orderId, razorpayPaymentId, razorpayOrderId, razorpaySignature }
 *
 * Responses: { ok: true, ... } or { ok: false, error: "message" }
 *
 * IMPORTANT: Set environment variables in Appwrite Function settings:
 * - RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET (server-only)
 * - APPWRITE_ENDPOINT, APPWRITE_PROJECT, APPWRITE_API_KEY
 * - APPWRITE_DATABASE_ID, APPWRITE_ORDERS_COLLECTION_ID
 */

const { Client, Databases, ID } = require("node-appwrite");
const Razorpay = require("razorpay");
const crypto = require("crypto");

const env = process.env;

// Validate required env vars
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
  if (missing.length) {
    throw new Error("Missing environment variables: " + missing.join(", "));
  }
}

function jsonSafeParse(s) {
  try { return typeof s === "string" ? JSON.parse(s) : s; } catch { return s; }
}

// Build Appwrite client (server-side with API key)
function getAppwriteClient() {
  const client = new Client();
  client
    .setEndpoint(env.APPWRITE_ENDPOINT)
    .setProject(env.APPWRITE_PROJECT)
    .setKey(env.APPWRITE_API_KEY);
  return {
    client,
    databases: new Databases(client)
  };
}

// Utility to compute HMAC SHA256
function generateSignature(orderId, paymentId, secret) {
  const hmac = crypto.createHmac("sha256", secret);
  hmac.update(`${orderId}|${paymentId}`);
  return hmac.digest("hex");
}

// Calculate amount to send to Razorpay (paise)
function toPaise(amountNumber) {
  // amountNumber expected in rupees (float or integer). Convert to paise integer.
  return Math.round(Number(amountNumber) * 100);
}

async function createOrderAction(input) {
  const { items = [], userId, shippingAddress = {}, currency = "INR", receiptPrefix = "rcpt_" } = input;

  // Basic server-side total calculation (you can modify to compute from product prices)
  // Expectation: frontend sent subtotal/total? If not, compute a fallback approx.
  // For production: recompute prices from product catalog on server to prevent manipulation.
  const subtotal = Number(input.subtotal ?? 0);
  const total = Number(input.totalAmount ?? subtotal);

  if (!userId) return { ok: false, error: "userId required" };

  const razorpay = new Razorpay({
    key_id: env.RAZORPAY_KEY_ID,
    key_secret: env.RAZORPAY_KEY_SECRET,
  });

  const amountPaise = toPaise(total || subtotal || 0);

  // Create Razorpay order
  const orderOptions = {
    amount: amountPaise, // in paise
    currency: currency,
    receipt: `${receiptPrefix}${Date.now()}`,
    partial_payment: false
  };

  let rOrder;
  try {
    rOrder = await razorpay.orders.create(orderOptions);
  } catch (err) {
    return { ok: false, error: "Razorpay order creation failed: " + (err.message || err) };
  }

  // Save Appwrite order document
  try {
    const { databases } = getAppwriteClient();
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
    return { ok: false, error: "Appwrite save order failed: " + (err.message || err) };
  }
}

async function verifyPaymentAction(input) {
  const { orderId, razorpayPaymentId, razorpayOrderId, razorpaySignature } = input;
  if (!orderId || !razorpayPaymentId || !razorpayOrderId || !razorpaySignature) {
    return { ok: false, error: "Missing verification fields" };
  }

  // Verify signature
  const expected = generateSignature(razorpayOrderId, razorpayPaymentId, env.RAZORPAY_KEY_SECRET);
  if (expected !== razorpaySignature) {
    return { ok: false, error: "Invalid signature" };
  }

  // Update order in Appwrite to paid
  try {
    const { databases } = getAppwriteClient();

    // Find order doc by razorpayOrderId OR by custom orderId
    // If you saved the appwrite doc id as orderId (recommended), use that. Here we try direct doc update by $id.
    // If you use a different mapping, adjust lookup accordingly.
    const docId = orderId;

    // Update fields
    const updatePayload = {
      paymentStatus: "paid",
      paymentReference: razorpayPaymentId,
      razorpayPaymentId,
      razorpaySignature
    };

    // Merge update (partial)
    const updated = await databases.updateDocument(
      env.APPWRITE_DATABASE_ID,
      env.APPWRITE_ORDERS_COLLECTION_ID,
      docId,
      updatePayload
    );

    return { ok: true, orderId: updated.$id, razorpayPaymentId, message: "Payment verified and order updated" };
  } catch (err) {
    return { ok: false, error: "Failed to update order: " + (err.message || err) };
  }
}

// Entrypoint for Appwrite execution
(async function main() {
  try {
    checkEnv();
    const inputRaw = process.env.APPWRITE_FUNCTION_DATA || "";
    if (!inputRaw) {
      console.log("No input provided via APPWRITE_FUNCTION_DATA. Exiting.");
      console.log(JSON.stringify({ ok: false, error: "No input" }));
      return;
    }
    const body = jsonSafeParse(inputRaw);

    const action = (body.action || body?.payload?.action || body?.actionName) || (body.action && body.action);
    // Support different shapes: { action, payload } or { action: 'createOrder', payload: {...} } or payload passed directly
    const payload = body.payload || body.data || body;

    if (!action && payload && payload.action) {
      // allow payload.action
    }

    // newer structure: { action: 'createOrder', payload: {...} }
    const actualAction = body.action || (payload && payload.action) || (body?.a) || null;
    const effectiveAction = actualAction || (body?.type) || (body?.op) || (body?.action);

    const actionFinal = (body.action && body.action.toString()) || (payload && payload.action && payload.action.toString()) || effectiveAction;

    // If still missing, try body.actionName
    const actionNormalized = actionFinal ? actionFinal.toString() : (payload && payload.op) || null;

    // Determine which action to run
    let act = null;
    if (body.action) act = body.action;
    else if (payload && payload.action) act = payload.action;
    else if (payload && payload.orderId && payload.razorpayPaymentId) act = "verifyPayment";
    else act = "createOrder";

    const actionLower = act && act.toString().toLowerCase();

    if (actionLower === "createorder") {
      const resp = await createOrderAction(payload);
      console.log(JSON.stringify(resp));
      return;
    } else if (actionLower === "verifypayment") {
      const resp = await verifyPaymentAction(payload);
      console.log(JSON.stringify(resp));
      return;
    } else {
      // fallback guess
      if (payload && payload.razorpayPaymentId) {
        const resp = await verifyPaymentAction(payload);
        console.log(JSON.stringify(resp));
        return;
      } else {
        const resp = await createOrderAction(payload);
        console.log(JSON.stringify(resp));
        return;
      }
    }
  } catch (err) {
    console.error("Function error:", err);
    console.log(JSON.stringify({ ok: false, error: err.message || String(err) }));
    return;
  }
})();
