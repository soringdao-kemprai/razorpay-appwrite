// index.js
const { Client, Databases, ID, Query } = require("node-appwrite");
const Razorpay = require("razorpay");
const crypto = require("crypto");

const env = process.env;
function getAppwrite() {
  const client = new Client()
    .setEndpoint(env.APPWRITE_ENDPOINT)
    .setProject(env.APPWRITE_PROJECT)
    .setKey(env.APPWRITE_API_KEY);
  return { databases: new Databases(client) };
}

function toPaise(v) { return Math.round(Number(v ?? 0) * 100); }
function signature(orderId, paymentId) {
  return crypto.createHmac("sha256", env.RAZORPAY_KEY_SECRET)
    .update(`${orderId}|${paymentId}`).digest("hex");
}

async function createOrder({ userId, items, shippingAddress }) {
  const { databases } = getAppwrite();
  const productColl = env.APPWRITE_PRODUCTS_COLLECTION_ID;

  let computedTotal = 0;
  const detailed = [];
  const productIds = [];

  for (const it of items) {
    const pid = it.productId ?? it.$id ?? it.id;
    const qty = Number(it.quantity ?? 1);
    const p = await databases.getDocument(env.APPWRITE_DATABASE_ID, productColl, pid);
    const unitPrice = Number(p.price ?? 0);
    const line = unitPrice * qty;
    computedTotal += line;
    detailed.push({
      $id: p.$id,
      productName: p.productName,
      category: p.category,
      quantity: qty,
      unitPrice,
      lineTotal: line,
    });
    productIds.push(p.$id);
  }

  const razor = new Razorpay({
    key_id: env.RAZORPAY_KEY_ID,
    key_secret: env.RAZORPAY_KEY_SECRET,
  });
  const rOrder = await razor.orders.create({
    amount: toPaise(computedTotal),
    currency: "INR",
    receipt: `rcpt_${Date.now()}`,
  });

  const doc = await databases.createDocument(
    env.APPWRITE_DATABASE_ID,
    env.APPWRITE_ORDERS_COLLECTION_ID,
    ID.unique(),
    {
      userId,
      items: JSON.stringify(detailed),
      products: JSON.stringify(productIds),
      subtotal: computedTotal,
      totalAmount: computedTotal,
      currency: "INR",
      shippingAddress: JSON.stringify(shippingAddress),
      paymentStatus: "created",
      paymentProvider: "razorpay",
      razorpayOrderId: rOrder.id,
      razorpayOrderObj: JSON.stringify(rOrder),
    }
  );

  return {
    ok: true,
    orderId: doc.$id,
    razorpayOrderId: rOrder.id,
    amount: toPaise(computedTotal),
    currency: "INR",
  };
}

async function verifyPayment({
  orderId,
  razorpayPaymentId,
  razorpayOrderId,
  razorpaySignature,
}) {
  if (signature(razorpayOrderId, razorpayPaymentId) !== razorpaySignature)
    return { ok: false, error: "Invalid signature" };

  const { databases } = getAppwrite();
  const res = await databases.updateDocument(
    env.APPWRITE_DATABASE_ID,
    env.APPWRITE_ORDERS_COLLECTION_ID,
    orderId,
    {
      paymentStatus: "paid",
      razorpayPaymentId,
      razorpaySignature,
      paymentReference: razorpayPaymentId,
    }
  );
  return { ok: true, orderId: res.$id };
}

module.exports = async function (req, res) {
  try {
    const body = JSON.parse(req.body);
    if (body.action === "verifyPayment") {
      return res.json(await verifyPayment(body.payload));
    } else {
      return res.json(await createOrder(body.payload));
    }
  } catch (e) {
    console.error("Function error:", e);
    res.json({ ok: false, error: e.message });
  }
};
