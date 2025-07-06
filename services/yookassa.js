const { v4: uuidv4 } = require('uuid');
const axios = require('axios');
require('dotenv').config();

const shopId = process.env.YOOKASSA_SHOP_ID;
const secretKey = process.env.YOOKASSA_SECRET_KEY;

async function createPayment({ amount, description, paymentId, userId, returnUrl, email }) {
  console.log(`[YOOKASSA] Creating payment for user ${userId}, paymentId: ${paymentId}`);
  const idempotenceKey = uuidv4();
  const requestBody = {
    amount: { value: amount.toFixed(2), currency: 'RUB' },
    capture: true,
    confirmation: { type: 'redirect', return_url: returnUrl },
    description,
    metadata: { userId, paymentId },
    receipt: {
      customer: { email },
      items: [{ description, quantity: 1, amount: { value: amount.toFixed(2), currency: 'RUB' }, vat_code: 2, payment_subject: 'service', payment_mode: 'full_payment', tax_system_code: 1 }],
    },
  };

  console.log('[YOOKASSA] Request body to Yookassa:', JSON.stringify(requestBody));
  try {
    const response = await axios.post('https://api.yookassa.ru/v3/payments', requestBody, {
      headers: { 'Idempotence-Key': idempotenceKey, 'Content-Type': 'application/json' },
      auth: { username: shopId, password: secretKey },
    });
    console.log(`[YOOKASSA] Response status: ${response.status} body:`, JSON.stringify(response.data));
    return response.data;
  } catch (error) {
    console.error('[YOOKASSA] Create payment error:', error.response?.data || error.message);
    throw error;
  }
}

async function getPayment(paymentId) {
  console.log(`[YOOKASSA] Fetching payment status for paymentId: ${paymentId}`);
  const idempotenceKey = uuidv4();
  try {
    const response = await axios.get(`https://api.yookassa.ru/v3/payments/${paymentId}`, {
      headers: { 'Idempotence-Key': idempotenceKey, 'Content-Type': 'application/json' },
      auth: { username: shopId, password: secretKey },
    });
    console.log(`[YOOKASSA] Get payment status: ${response.status} body:`, JSON.stringify(response.data));
    return response.data;
  } catch (error) {
    console.error('[YOOKASSA] Get payment error:', error.response?.data || error.message);
    throw error;
  }
}

module.exports = { createPayment, getPayment };