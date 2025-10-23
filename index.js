// index.js - Appwrite Function: createOrder + verifyPayment (with product linkage)
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
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function bufferToString(obj) {
  if (!obj || !Array.isArray(obj.data)) return null;
  try {
    return Buffer.from(obj.data).toString("utf8");
  } catch {
    return null;
  }
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

  // Fetch products from Appwrite and attach snapshots
  let computedTotal = 0;
  const enrichedItems = [];

  for (const it of items) {
    const productId = String(it.productId ?? it.id ?? "");
    if (!productId) continue;

    let productDoc = null;
    try {
      productDoc = await databases.getDocument(
        env.APPWRITE_DATABASE_ID,
        env.APPWRITE_PRODUCTS_COLLECTION_ID,
        productId
      );
    } catch (err) {
      console.error(`⚠️ Product fetch failed for ${productId}:`, err.message);
    }

    const quantity = Number(it.quantity ?? 1);
    const price = Number(
      it.price ??
        (productDoc?.price ?? productDoc?.pricePerPiece ?? productDoc?.mrp ?? 0)
    );
    const lineTotal = quantity * price;
    computedTotal += lineTotal;

    enrichedItems.push({
      productId,
      quantity,
      price,
      productSnapshot: productDoc
        ? {
            $id: productDoc.$id,
            productName:
              productDoc.productName ?? productDoc.name ?? "Unnamed Product",
            category: productDoc.category ?? null,
          }
        : null,
    });
  }

  if (computedTotal <= 0)
    return { ok: false, error: "Invalid total computed from products" };

  const razorpay = new Razorpay({
    key_id: env.RAZORPAY_KEY_ID,
    key_secret: env.RAZORPAY_KEY_SECRET,
  });

  const amountPaise = toPaise(computedTotal);
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
  } catch (err) {
    console.error("Razorpay order create error:", err.message);
    return { ok: false, error: "Razorpay create failed: " + err.message };
  }

  const rawDocPayload = {
    userId,
    items: JSON.stringify(enrichedItems),
    subtotal: Number(computedTotal),
    totalAmount: Number(computedTotal),
    currency,
    shippingAddress:
      typeof shippingAddress === "string"
        ? shippingAddress
        : JSON.stringify(shippingAddress),
    paymentStatus: "created",
    paymentProvider: "razorpay",
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

    console.log("✅ Order saved:", doc.$id);

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
    };
  }
}

/* -------------------------------------------------------------------------- */
/*                            VERIFY PAYMENT ACTION                           */
/* -------------------------------------------------------------------------- */
async function verifyPaymentAction(payload) {
  const { orderId, razorpayPaymentId, razorpayOrderId, razorpaySignature } =
    payload || {};

  if (!razorpayPaymentId || !razorpayOrderId || !razorpaySignature)
    return {
      ok: false,
      error: "Missing required Razorpay fields for verification",
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
    let docId = orderId ?? null;

    if (!docId) {
      const res = await databases.listDocuments(
        env.APPWRITE_DATABASE_ID,
        env.APPWRITE_ORDERS_COLLECTION_ID,
        [Query.equal("razorpayOrderId", razorpayOrderId)]
      );
      if (res.documents?.length) docId = res.documents[0].$id;
    }

    if (!docId)
      return { ok: false, error: "Order not found for verification" };

    const updated = await databases.updateDocument(
      env.APPWRITE_DATABASE_ID,
      env.APPWRITE_ORDERS_COLLECTION_ID,
      docId,
      {
        paymentStatus: "paid",
        paymentReference: razorpayPaymentId,
        razorpayPaymentId,
        razorpaySignature,
      }
    );

    console.log("✅ Payment verified:", updated.$id);
    return { ok: true, orderId: updated.$id, message: "Payment verified" };
  } catch (err) {
    console.error("verifyPaymentAction error:", err.message);
    return { ok: false, error: err.message };
  }
}

/* -------------------------------------------------------------------------- */
/*                                MAIN HANDLER                                */
/* -------------------------------------------------------------------------- */
async function handleAction(body) {
  const action =
    (body && (body.action || body.payload?.action))?.toString()?.toLowerCase?.() ??
    null;
  const payload = body?.payload || body || {};

  if (action === "verifypayment") return await verifyPaymentAction(payload);
  return await createOrderAction(payload);
}

async function runHandler(req, res) {
  console.log("=== Razorpay Function Started ===");
  try {
    checkEnv();
  } catch (err) {
    const out = { ok: false, error: "Missing env vars: " + err.message };
    if (res?.json) return res.json(out, 500);
    console.log(JSON.stringify(out));
    return out;
  }

  let input = {};
  try {
    if (req?.bodyJson) input = req.bodyJson;
    else if (req?.body && typeof req.body === "string")
      input = tryParseJSON(req.body) || {};
    else if (typeof req === "string") input = tryParseJSON(req) || {};
    else if (process.env.APPWRITE_FUNCTION_DATA)
      input = tryParseJSON(process.env.APPWRITE_FUNCTION_DATA) || {};
  } catch (err) {
    console.error("Parse input error:", err.message);
  }

  console.log("Input preview:", JSON.stringify(input).slice(0, 250));

  try {
    const result = await handleAction(input);
    console.log("FUNCTION_RESULT:", JSON.stringify(result));
    if (res?.json) {
      const status = result.ok ? 200 : 400;
      return res.json(result, status);
    }
    return result;
  } catch (err) {
    console.error("Handler error:", err.message);
    const out = { ok: false, error: err.message };
    if (res?.json) return res.json(out, 500);
    console.log(JSON.stringify(out));
    return out;
  }
}

module.exports = async function (req, res) {
  return runHandler(req, res);
};
