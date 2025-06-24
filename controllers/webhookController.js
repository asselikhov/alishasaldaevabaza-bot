const { bot, sendInviteLink, getSettings } = require('../services/telegram');
const { getPayment } = require('../services/yookassa');
const User = require('../models/User');
const crypto = require('crypto');

function validateYookassaWebhook(req) {
  console.log('[WEBHOOK] Raw body (buffer):', req.body);
  console.log('[WEBHOOK] Raw body (utf8):', req.body.toString('utf8'));
  const signatureHeader = req.headers['signature'];
  if (!signatureHeader) {
    console.error('[WEBHOOK] YooKassa webhook validation failed: Missing signature header');
    return false;
  }

  const signatures = signatureHeader.split(' ');
  if (signatures.length < 2 || signatures[0] !== 'v1') {
    console.error('[WEBHOOK] YooKassa webhook validation failed: Invalid signature format');
    return false;
  }

  const signature = signatures[1]; // Используем только значение после 'v1'
  const hmac = crypto.createHmac('sha256', process.env.YOOKASSA_SECRET_KEY)
      .update(Buffer.from(req.body)) // Убеждаемся, что используем буфер
      .digest('base64');
  console.log('[WEBHOOK] Calculated HMAC:', hmac);
  console.log('[WEBHOOK] Received signature:', signature);

  if (hmac !== signature) {
    console.error('[WEBHOOK] YooKassa webhook validation failed: Signature mismatch');
    return false;
  }

  return true;
}

async function handleYookassaWebhook(req, res) {
  try {
    console.log(`[WEBHOOK] Received YooKassa webhook at ${new Date().toISOString()} with headers:`, req.headers);
    if (!validateYookassaWebhook(req)) {
      console.error('[WEBHOOK] Invalid YooKassa webhook signature');
      return res.status(200).send('OK');
    }

    const body = JSON.parse(req.body.toString('utf8'));
    console.log('[WEBHOOK] Parsed YooKassa webhook body:', JSON.stringify(body));

    const { event, object } = body;
    if (event === 'payment.succeeded') {
      console.log(`[WEBHOOK] Processing payment.succeeded for paymentId: ${object.id}`);
      let user = await User.findOne({ paymentId: object.id });
      if (!user) {
        console.warn(`[WEBHOOK] No user found for paymentId: ${object.id}, searching by metadata or creating...`);
        const metadataUserId = object.metadata?.userId;
        if (metadataUserId) user = await User.findOne({ userId: metadataUserId });
        if (!user) {
          user = await User.create({
            userId: metadataUserId || `unknown_${object.id}`,
            chatId: null,
            paymentId: object.id,
            paymentStatus: 'pending',
            lastActivity: new Date(),
          });
          console.log(`[WEBHOOK] Created temporary user: ${user.userId} for paymentId ${object.id}`);
        }
      }

      console.log(`[WEBHOOK] Found user ${user.userId} for paymentId ${object.id}, joinedChannel: ${user.joinedChannel}, processed: ${user.processed}`);
      if (!user.joinedChannel && !user.processed) {
        console.log(`[WEBHOOK] Sending invite link for user ${user.userId}`);
        await sendInviteLink(user, { chat: { id: user.chatId || (await getSettings()).supportLink } }, object.id);
        await User.updateOne({ paymentId: object.id }, { processed: true });
      } else console.log(`[WEBHOOK] User ${user.userId} already processed or joined, skipping invite link`);
    } else console.log(`[WEBHOOK] Received unhandled event: ${event}`);
    res.sendStatus(200);
  } catch (error) {
    console.error('[WEBHOOK] Error in Yookassa webhook:', error.message, error.stack);
    res.sendStatus(200);
  }
}

module.exports = { handleYookassaWebhook };