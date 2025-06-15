const { v4: uuidv4 } = require('uuid');
const fetch = require('node-fetch');

const SHOP_ID = process.env.YOOKASSA_SHOP_ID;
const SECRET_KEY = process.env.YOOKASSA_SECRET_KEY;

const createPayment = async ({ amount, description, paymentId, userId, returnUrl }) => {
  try {
    const response = await fetch('https://api.yookassa.ru/v3/payments', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${Buffer.from(`${SHOP_ID}:${SECRET_KEY}`).toString('base64')}`,
        'Idempotence-Key': uuidv4(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        amount: {
          value: amount.toFixed(2),
          currency: 'RUB',
        },
        capture: true,
        confirmation: {
          type: 'redirect',
          return_url: returnUrl || 'https://your-return-url.com',
        },
        description,
        metadata: { userId, paymentId },
        receipt: {
          customer: { email: 'customer@example.com' },
          items: [
            {
              description,
              quantity: 1,
              amount: { value: amount.toFixed(2), currency: 'RUB' },
              vat_code: 1,
            },
          ],
        },
      }),
    });

    if (!response.ok) {
      throw new Error(`Yookassa API error: ${response.statusText}`);
    }
    return await response.json();
  } catch (error) {
    console.error('Error creating payment:', error.stack);
    throw error;
  }
};

const checkPayment = async (paymentId) => {
  try {
    const response = await fetch(`https://api.yookassa.ru/v3/payments/${paymentId}`, {
      headers: {
        'Authorization': `Basic ${Buffer.from(`${SHOP_ID}:${SECRET_KEY}`).toString('base64')}`,
      },
    });

    if (!response.ok) {
      throw new Error(`Yookassa API error: ${response.statusText}`);
    }
    return await response.json();
  } catch (error) {
    console.error('Error checking payment:', error.stack);
    throw error;
  }
};

module.exports = { createPayment, checkPayment };