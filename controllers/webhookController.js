function validateYookassaWebhook(req) {
  console.log('[WEBHOOK] Validation skipped, returning true');
  return true;
}

async function handleYookassaWebhook(req, res) {
  try {
    console.log(`[WEBHOOK] Received YooKassa webhook at ${new Date().toISOString()} with headers:`, req.headers);
    if (!validateYookassaWebhook(req)) {
      console.error('[WEBHOOK] Webhook validation failed');
      return res.sendStatus(400);
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