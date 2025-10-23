// index.js - Appwrite Function: createOrder (sync) + verifyPayment
//
// Required env vars (function-level):
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
  // If amount looks like rupees (not huge integer), convert to paise
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
/*                 Robust input parsing (Appwrite wrapper aware)              */
/* -------------------------------------------------------------------------- */
function extractInput(rawArg) {
  try {
    if (rawArg?.bodyJson && typeof rawArg.bodyJson === "object") return rawArg.bodyJson;
    if (rawArg?.body && typeof rawArg.body === "object") return rawArg.body;
    if (rawArg?.body && typeof rawArg.body === "string") {
      const parsed = tryParseJSON(rawArg.body);
      if (parsed) return parsed;
    }
    if (rawArg?.req && typeof rawArg.req === "object") {
      const rb = rawArg.req.body;
      if (typeof rb === "string") {
        const parsed = tryParseJSON(rb);
        if (parsed) return parsed;
      } else if (typeof rb === "object" && rb) {
        return rb;
      }
    }
    if (typeof rawArg === "string") {
      const parsed = tryParseJSON(rawArg);
      if (parsed) return parsed;
    }
    if (process.env.APPWRITE_FUNCTION_DATA) {
      const parsed = tryParseJSON(process.env.APPWRITE_FUNCTION_DATA);
      if (parsed) return parsed;
      return process.env.APPWRITE_FUNCTION_DATA;
    }
  } catch (e) {
    console.warn("extractInput parsing error:", e && e.message ? e.message : e);
  }
  return {};
}

/* -------------------------------------------------------------------------- */
/*                          ORDER CREATION (UPDATED)                          */
/* -------------------------------------------------------------------------- */
async function createOrderAction(payload) {
  // payload might be nested, handle common shapes
  const p = payload?.payload ?? payload ?? {};
  const userId = p.userId ?? p.user_id ?? null;
  if (!userId) return { ok: false, error: "userId required" };

  let items = p.items ?? [];
  const shippingAddress = p.shippingAddress ?? p.shipping_address ?? p.shipping ?? {};
  const currency = p.currency ?? "INR";

  // normalize items array (accept stringified array or various shapes)
  if (!Array.isArray(items)) {
    if (typeof items === "string") {
      const parsed = tryParseJSON(items);
      items = Array.isArray(parsed) ? parsed : [];
    } else items = [];
  }
  if (items.length === 0) return { ok: false, error: "items array required" };

  const { databases } = getAppwrite();
  const productsColl = env.APPWRITE_PRODUCTS_COLLECTION_ID;

  let computedTotal = 0;
  const simplifiedItems = []; // <- this will hold the simplified shape you requested

  for (const itRaw of items) {
    let it = itRaw;
    if (typeof it === "string") {
      it = { productId: it, quantity: 1 };
    } else if (typeof it === "object" && it !== null) {
      const pid = it.productId ?? it.product_id ?? it.product ?? it.id ?? it.$id ?? null;
      const qty = Number(it.quantity ?? it.qty ?? it.q ?? 1) || 1;
      it = { productId: pid, quantity: qty };
    } else {
      return { ok: false, error: "Invalid item shape" };
    }

    if (!it.productId) return { ok: false, error: "each item must include productId" };

    // fetch product doc to compute price and get name/category
    let productDoc = null;
    try {
      productDoc = await databases.getDocument(env.APPWRITE_DATABASE_ID, productsColl, String(it.productId));
    } catch (err) {
      console.error("Product fetch failed:", it.productId, err && err.message ? err.message : err);
      productDoc = null;
    }
    if (!productDoc) return { ok: false, error: `Product not found: ${it.productId}` };

    const unitPrice = Number(productDoc.price ?? productDoc.pricePerPiece ?? productDoc.price_per_piece ?? 0) || 0;
    const qty = Number(it.quantity ?? 1) || 1;
    const lineTotal = unitPrice * qty;
    computedTotal += lineTotal;

    // simplified item format requested by you:
    simplifiedItems.push({
      $id: String(productDoc.$id),
      productName: productDoc.productName ?? productDoc.name ?? null,
      category: productDoc.category ?? null,
      lineTotal: Number(lineTotal),
      // note: intentionally NOT including quantity/unitPrice/productSnapshot per your request
    });
  }

  const totalToUse = computedTotal;
  if (!totalToUse || Number(totalToUse) <= 0) return { ok: false, error: "Invalid total computed from products" };

  // create razorpay order
  const razorpay = new Razorpay({
    key_id: env.RAZORPAY_KEY_ID,
    key_secret: env.RAZORPAY_KEY_SECRET,
  });

  const amountPaise = toPaise(totalToUse);
  if (!amountPaise || amountPaise <= 0) return { ok: false, error: "Invalid amount after paise conversion" };

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
    console.log("Razorpay order created:", rOrder && rOrder.id ? rOrder.id : JSON.stringify(rOrder));
  } catch (err) {
    console.error("Razorpay order create error:", err && err.message ? err.message : err);
    return { ok: false, error: "Razorpay create failed: " + (err?.message || String(err)) };
  }

  // save order doc in Appwrite with simplified items array (stringified)
  const rawDocPayload = {
    userId,
    items: JSON.stringify(simplifiedItems), // store as string field (orders collection expects string type)
    subtotal: Number(totalToUse),
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
    console.error("Appwrite createDocument error:", err && err.message ? err.message : err);
    return {
      ok: false,
      error: "Appwrite save failed: " + (err?.message || String(err)),
      raw: { razorpayOrderId: rOrder.id, amount: amountPaise, currency },
    };
  }
}

/* -------------------------------------------------------------------------- */
/*                             VERIFY PAYMENT                                 */
/* -------------------------------------------------------------------------- */
async function verifyPaymentAction(payload) {
  const p = payload?.payload ?? payload ?? {};
  const orderId = p.orderId ?? p.order_id ?? null;
  const razorpayPaymentId = p.razorpayPaymentId ?? p.razorpay_payment_id ?? null;
  const razorpayOrderId = p.razorpayOrderId ?? p.razorpay_order_id ?? null;
  const razorpaySignature = p.razorpaySignature ?? p.razorpay_signature ?? null;

  if (!razorpayPaymentId || !razorpayOrderId || !razorpaySignature) {
    return { ok: false, error: "Missing razorpayPaymentId, razorpayOrderId or razorpaySignature" };
  }

  const expected = generateSignature(razorpayOrderId, razorpayPaymentId, env.RAZORPAY_KEY_SECRET);
  if (expected !== razorpaySignature) return { ok: false, error: "Invalid signature" };

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

    if (!docIdToUpdate) return { ok: false, error: "Order not found for verification" };

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
    console.error("verifyPaymentAction error:", err && err.message ? err.message : err);
    return { ok: false, error: err?.message ?? String(err) };
  }
}

/* -------------------------------------------------------------------------- */
/*                               MAIN HANDLER                                 */
/* -------------------------------------------------------------------------- */
async function handleAction(body) {
  const b = body || {};
  const actionFromBody = (b.action || (b.payload && b.payload.action) || null) || null;
  const action = actionFromBody ? String(actionFromBody).toLowerCase() : null;
  if (action === "verifypayment" || action === "verifyPayment") return await verifyPaymentAction(b);
  return await createOrderAction(b);
}

/* -------------------------------------------------------------------------- */
/*                               ENTRY POINT                                  */
/* -------------------------------------------------------------------------- */
async function runHandler(rawArg, rawRes) {
  console.log("=== Razorpay Function Start ===");
  try {
    const keys = Object.keys(process.env || {}).filter(k => /APPWRITE|RAZORPAY/i.test(k));
    console.log("DEBUG: available env keys (filtered):", keys);
    console.log("DEBUG: APPWRITE_PRODUCTS_COLLECTION_ID value:", process.env.APPWRITE_PRODUCTS_COLLECTION_ID);
  } catch (e) { console.warn("DEBUG env listing error:", e && e.message ? e.message : e); }

  try { checkEnv(); } catch (err) {
    console.error("ENV missing:", err && err.message ? err.message : err);
    const out = { ok: false, error: "Missing env vars: " + (err && err.message ? err.message : String(err)) };
    if (rawRes?.json) return rawRes.json(out, 500);
    console.log(JSON.stringify(out));
    return out;
  }

  let input = {};
  try {
    input = extractInput(rawArg) || {};
  } catch (e) {
    console.error("Failed to parse input:", e && e.message ? e.message : e);
    input = {};
  }

  console.log("Input preview:", JSON.stringify(input).slice(0, 1000));

  try {
    const result = await handleAction(input);
    if (rawRes?.json) {
      const status = result?.ok === false ? 400 : 200;
      return rawRes.json(result, status);
    }
    console.log(JSON.stringify(result));
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
}

// Local testing support
if (require.main === module) {
  (async () => {
    const raw = process.env.APPWRITE_FUNCTION_DATA || "{}";
    const body = tryParseJSON(raw) || {};
    const out = await handleAction(body);
    console.log(JSON.stringify(out, null, 2));
  })();
}
