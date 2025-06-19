const { v4: uuidv4 } = require('uuid');
const fetch = require('node-fetch');

const SHOP_ID = process.env.YOOKASSA_SHOP_ID;
const SECRET_KEY = process.env.YOOKASSA_SECRET_KEY;

const createPayment = async ({ amount, description, paymentId, userId, returnUrl, email }) => {
  try {
    console.log(`Creating payment for user ${userId}, paymentId: ${paymentId}`);
    const body = {
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
        customer: { email: email || 'default@example.com' }, // Используем переданный email
        items: [
          {
            description,
            quantity: 1,
            amount: { value: amount.toFixed(2), currency: 'RUB' },
            vat_code: 2, // Без НДС
            payment_subject: 'service', // Тип услуги
            payment_method: 'full_payment', // Полная оплата
          },
        ],
      },
    };
    console.log('Request body to Yookassa:', JSON.stringify(body, null, 2));
    const response = await fetch('https://api.yookassa.ru/v3/payments', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${Buffer.from(`${SHOP_ID}:${SECRET_KEY}`).toString('base64')}`,
        'Idempotence-Key': uuidv4(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const responseText = await response.text();
    console.log('Yookassa response:', responseText);
    if (!response.ok) {
      throw new Error(`Yookassa API error: ${response.statusText}, details: ${responseText}`);
    }
    const result = JSON.parse(responseText);
    console.log(`Payment created for user ${userId}: ${JSON.stringify(result)}`);
    return result;
  } catch (error) {
    console.error(`Error creating payment for user ${userId}:`, error.stack);
    throw error;
  }
};

const checkPayment = async (paymentId) => {
  try {
    console.log(`Checking payment with paymentId: ${paymentId}`);
    const response = await fetch(`https://api.yookassa.ru/v3/payments/${paymentId}`, {
      headers: {
        'Authorization': `Basic ${Buffer.from(`${SHOP_ID}:${SECRET_KEY}`).toString('base64')}`,
      },
    });
    const responseText = await response.text();
    console.log('Yookassa check payment response:', responseText);
    if (!response.ok) {
      throw new Error(`Yookassa API error: ${response.statusText}, details: ${responseText}`);
    }
    const result = JSON.parse(responseText);
    console.log(`Payment check result for paymentId ${paymentId}: ${JSON.stringify(result)}`);
    return result;
  } catch (error) {
    console.error(`Error checking payment with paymentId ${paymentId}:`, error.stack);
    throw error;
  }
};

module.exports = { createPayment, checkPayment };