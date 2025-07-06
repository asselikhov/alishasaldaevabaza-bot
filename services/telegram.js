const { Telegraf, session } = require('telegraf');
const { v4: uuidv4 } = require('uuid');
const User = require('../models/User');
const { getSettings, resetSettingsCache } = require('./settings');
require('dotenv').config();

const bot = new Telegraf(process.env.BOT_TOKEN);

// Настройка локального хранилища сессий
console.log('[SETUP] Initializing Telegraf session middleware');
bot.use(session());

bot.catch((err, ctx) => {
  console.error('[TELEGRAM_ERROR] Error for update', JSON.stringify(ctx.update), ':', err.stack);
  if (ctx && ctx.chat) {
    ctx.reply('Произошла ошибка. Попробуйте позже.');
  }
});

async function sendInviteLink(user, ctx, paymentId) {
  try {
    console.log(`[INVITE] Processing invite link for user ${user.userId}, paymentId: ${paymentId}`);
    if (user.inviteLink && user.joinedChannel && user.inviteLinkUsed) {
      console.log(`[INVITE] User ${user.userId} already used invite link: ${user.inviteLink}`);
      await bot.telegram.sendMessage(user.chatId, await getPaidWelcomeMessage(), {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '💬 Техподдержка', url: (await getSettings()).supportLink }],
            [{ text: '💡 О канале', callback_data: 'about' }],
          ],
        },
      });
      await bot.telegram.sendMessage(user.chatId, 'Вы уже вступили в канал по одноразовой ссылке. Свяжитесь с поддержкой, если нужна помощь.', {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: '💬 Техподдержка', url: (await getSettings()).supportLink }]] },
      });
      return;
    }

    const { getPayment } = require('./yookassa');
    const paymentData = await getPayment(paymentId);
    if (paymentData.status !== 'succeeded') {
      throw new Error(`[INVITE] Payment ${paymentId} status is ${paymentData.status}, expected succeeded`);
    }

    const expiresDate = Math.floor(Date.now() / 1000) + 24 * 60 * 60; // Срок действия 24 часа
    const chatInvite = await bot.telegram.createChatInviteLink(process.env.CHANNEL_ID, {
      name: `Invite for user_${user.userId}_${uuidv4()}`,
      member_limit: 1,
      creates_join_request: false,
      expires_date: expiresDate,
    });
    console.log(`[INVITE] Created unique invite link: ${chatInvite.invite_link} for user ${user.userId}`);

    const paymentText = `Платежный документ\nID транзакции: ${paymentId}\nСумма: ${paymentData.amount.value} ${paymentData.amount.currency}\nДата: ${new Date(paymentData.created_at).toLocaleString('ru-RU')}\nСтатус: ${paymentData.status}\nПользователь: ${user.userId}\nEmail: ${paymentData.receipt?.customer?.email || user.email || 'N/A'}`;
    const paymentDoc = await bot.telegram.sendDocument(process.env.PAYMENT_GROUP_ID, {
      source: Buffer.from(paymentText, 'utf8'),
      filename: `payment_${paymentId}.txt`,
    }, { caption: `Документ оплаты для user_${user.userId}` });
    console.log(`[INVITE] Payment document sent to group ${process.env.PAYMENT_GROUP_ID}, message_id: ${paymentDoc.message_id}`);

    const paymentDocument = `https://t.me/c/${process.env.PAYMENT_GROUP_ID.replace('-100', '')}/${paymentDoc.message_id}`;
    await User.updateOne({ userId: user.userId, paymentId }, {
      paymentStatus: 'succeeded',
      inviteLink: chatInvite.invite_link,
      inviteLinkExpires: expiresDate * 1000,
      inviteLinkUsed: false,
      paymentDate: new Date(paymentData.created_at),
      paymentDocument,
      lastActivity: new Date(),
    });
    console.log(`[INVITE] User ${user.userId} updated with invite link and payment details`);

    await bot.telegram.sendMessage(user.chatId, await getPaidWelcomeMessage(), {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '💬 Техподдержка', url: (await getSettings()).supportLink }],
          [{ text: '💡 О канале', callback_data: 'about' }],
        ],
      },
    });
    await bot.telegram.sendMessage(user.chatId, 'Ваша уникальная одноразовая ссылка для вступления в закрытый канал:', {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [[{ text: 'Присоединиться', url: chatInvite.invite_link }]] },
    });

    const adminIds = new Set((process.env.ADMIN_CHAT_IDS || '').split(',').map(id => id.trim()));
    for (const adminId of adminIds) {
      await bot.telegram.sendMessage(adminId, `Новый успешный платёж от user_${user.userId} (paymentId: ${paymentId}). Ссылка отправлена: ${chatInvite.invite_link}`);
    }
    console.log(`[INVITE] Admin notification sent for user ${user.userId}`);
  } catch (error) {
    console.error(`[INVITE] Error sending invite link for user ${user.userId}:`, error.message, error.stack);
    await bot.telegram.sendMessage(user.chatId, 'Ошибка при создании одноразовой ссылки на канал. Пожалуйста, свяжитесь с поддержкой.', {
      reply_markup: { inline_keyboard: [[{ text: '💬 Техподдержка', url: (await getSettings()).supportLink }]] },
    });
    const adminIds = new Set((process.env.ADMIN_CHAT_IDS || '').split(',').map(id => id.trim()));
    for (const adminId of adminIds) {
      await bot.telegram.sendMessage(adminId, `Ошибка при создании ссылки для user_${user.userId} (paymentId: ${paymentId}): ${error.message}`);
    }
  }
}

// Обработчик вступления в канал
bot.on('chat_member', async (ctx) => {
  try {
    const update = ctx.update.chat_member;
    if (update.chat.id.toString() === process.env.CHANNEL_ID && update.new_chat_member.status === 'member') {
      const userId = update.new_chat_member.user.id.toString();
      const user = await User.findOne({ userId, paymentStatus: 'succeeded', inviteLinkUsed: false });

      if (user && user.inviteLink) {
        console.log(`[INVITE] User ${userId} joined channel using invite link: ${user.inviteLink}`);
        await User.updateOne(
            { userId },
            { joinedChannel: true, inviteLinkUsed: true }
        );
        console.log(`[INVITE] Marked invite link as used for user ${userId}`);

        // Попытка отозвать ссылку
        try {
          await ctx.telegram.revokeChatInviteLink(process.env.CHANNEL_ID, user.inviteLink);
          console.log(`[INVITE] Invite link ${user.inviteLink} revoked for user ${userId}`);
        } catch (revokeError) {
          console.warn(`[INVITE] Failed to revoke invite link for user ${userId}:`, revokeError.message);
        }
      }
    }
  } catch (error) {
    console.error('[INVITE] Error processing chat_member update:', error.message, error.stack);
  }
});

async function getWelcomeMessage() {
  const settings = await getSettings();
  return settings.welcomeMessage;
}

async function getPaidWelcomeMessage() {
  const settings = await getSettings();
  return settings.paidWelcomeMessage;
}

module.exports = {
  bot,
  sendInviteLink,
  getSettings,
  getWelcomeMessage,
  getPaidWelcomeMessage,
  resetSettingsCache
};