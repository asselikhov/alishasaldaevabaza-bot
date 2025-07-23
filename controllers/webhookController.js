const { bot, sendInviteLink, getSettings } = require('../services/telegram');
const User = require('../models/User');

// Проверка импорта модели User
console.log('[WEBHOOK] User model loaded:', typeof User === 'function' ? 'Success' : 'Failed');

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
      if (!User) {
        throw new Error('User model is not defined');
      }
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
      } else {
        console.log(`[WEBHOOK] User ${user.userId} already processed or joined, skipping invite link`);
      }
    } else {
      console.log(`[WEBHOOK] Received unhandled event: ${event}`);
    }
    res.sendStatus(200);
  } catch (error) {
    console.error('[WEBHOOK] Error in Yookassa webhook:', error.message, error.stack);
    res.sendStatus(200);
  }
}

bot.on('chat_member', async (ctx) => {
  try {
    const update = ctx.update.chat_member;
    const userId = String(update.new_chat_member.user.id);
    const channelId = String(update.chat.id);
    const expectedChannelId = process.env.CHANNEL_ID;

    console.log(`[CHAT_MEMBER] Received update for user ${userId} in chat ${channelId}`);

    if (channelId !== expectedChannelId) {
      console.log(`[CHAT_MEMBER] Ignoring update for unrelated chat ${channelId}`);
      return;
    }

    const user = await User.findOne({ userId, paymentStatus: 'succeeded' });
    if (!user) {
      console.log(`[CHAT_MEMBER] No paid user found for userId ${userId}`);
      return;
    }

    const isMember = ['member', 'administrator', 'creator'].includes(update.new_chat_member.status);
    if (isMember && !user.joinedChannel) {
      await User.updateOne(
          { userId },
          { joinedChannel: true, inviteLinkUsed: true, lastActivity: new Date() }
      );
      console.log(`[CHAT_MEMBER] Updated user ${userId} to joinedChannel: true, inviteLinkUsed: true`);
    } else if (!isMember && user.joinedChannel) {
      await User.updateOne(
          { userId },
          { joinedChannel: false, lastActivity: new Date() }
      );
      console.log(`[CHAT_MEMBER] Updated user ${userId} to joinedChannel: false`);
    }
  } catch (error) {
    console.error(`[CHAT_MEMBER] Error processing chat_member update for user ${userId}:`, error.message);
  }
});

module.exports = { handleYookassaWebhook };