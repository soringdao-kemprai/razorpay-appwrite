# Razorpay Appwrite Function

## Overview
This Appwrite function supports two actions:
- `createOrder`: create a Razorpay order and a corresponding Appwrite order doc.
- `verifyPayment`: verify Razorpay signature and mark the Appwrite order as paid.

## How to deploy from GitHub (Appwrite console)
1. Push this repository to GitHub.
2. In Appwrite Console -> Functions -> Create Function.
   - Runtime: Node.js (18).
   - Choose "Source" -> "GitHub" and link the repository & branch containing this folder.
   - Set build command: `npm install`
   - Set run command: `node index.js`
   - Set the entrypoint / source path to `functions/razorpay-appwrite`.
3. In the Function's Settings -> Environment Variables, add:
   - APPWRITE_ENDPOINT
   - APPWRITE_PROJECT
   - APPWRITE_API_KEY (server API key — keep secret)
   - APPWRITE_DATABASE_ID
   - APPWRITE_ORDERS_COLLECTION_ID
   - RAZORPAY_KEY_ID
   - RAZORPAY_KEY_SECRET
4. Save and deploy. Use the "Executions" tab to test.

## Usage (via Appwrite client from your frontend)
Call `functions.createExecution(functionId, JSON.stringify({ action: "createOrder", payload: {...} }))` or only pass payload object as the function expects. This function returns JSON with at least:
- For createOrder: `{ ok: true, orderId, razorpayOrderId, amount, currency, razorpayKeyId }`
- For verifyPayment: `{ ok: true, orderId, razorpayPaymentId }`

Frontend should send the server `orderId` returned by this function when calling verifyPayment.

## Security notes
- Keep RAZORPAY_KEY_SECRET & APPWRITE_API_KEY in the function environment only (server-side).
- DO NOT put RAZORPAY_KEY_SECRET on the client.

## Recommended improvements for production
- Recompute item prices on server instead of trusting the client.
- Use Appwrite security rules / indexes to allow the function to create documents.
- Add webhook handling for additional reconciliation & refunds.
