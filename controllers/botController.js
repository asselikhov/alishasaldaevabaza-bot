const { bot, sendInviteLink, getSettings, getWelcomeMessage, getPaidWelcomeMessage, resetSettingsCache } = require('../services/telegram');
const escape = require('markdown-escape');
const { createPayment, getPayment } = require('../services/yookassa');
const User = require('../models/User');
const Settings = require('../models/Settings');

const adminIds = new Set((process.env.ADMIN_CHAT_IDS || '').split(',').map(id => id.trim()));

async function processPayment(ctx, userId, chatId) {
  try {
    console.log(`[PAYMENT] Processing payment for user ${userId}, YOOKASSA_SHOP_ID: ${process.env.YOOKASSA_SHOP_ID}, YOOKASSA_SECRET_KEY: ${process.env.YOOKASSA_SECRET_KEY ? 'present' : 'missing'}`);
    const user = await User.findOne({ userId });
    if (user?.paymentStatus === 'succeeded' && user.inviteLink) {
      return ctx.reply('Вы уже оплатили доступ! Вот ваша одноразовая ссылка:', {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: 'Присоединиться', url: user.inviteLink }]] },
      });
    }

    const settings = await getSettings();
    const localPaymentId = require('uuid').v4();
    console.log(`[PAYMENT] Creating payment for user ${userId}, localPaymentId: ${localPaymentId}`);
    const payment = await Promise.race([
      createPayment({
        amount: settings.paymentAmount,
        description: 'Доступ к закрытому Telegram каналу',
        paymentId: localPaymentId,
        userId,
        returnUrl: `${process.env.RETURN_URL}?paymentId=${localPaymentId}`,
        email: user.email,
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout waiting for Yookassa response')), 15000)),
    ]);

    await User.updateOne({ userId }, { paymentId: payment.id, localPaymentId, paymentStatus: 'pending', chatId, lastActivity: new Date() }, { upsert: true });
    console.log(`[PAYMENT] Saved paymentId ${payment.id} for user ${userId}`);

    await ctx.reply('Перейдите по ссылке для оплаты:', {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [[{ text: 'Оплатить', url: payment.confirmation.confirmation_url }]] },
    });
  } catch (error) {
    console.error(`[PAYMENT] Error for user ${userId}:`, error.message);
    await ctx.reply('Ошибка при создании платежа. Попробуйте позже или свяжитесь с поддержкой.', {
      reply_markup: { inline_keyboard: [[{ text: '💬 Техподдержка', url: (await getSettings()).supportLink }]] },
    });
  }
}

bot.command('checkpayment', async (ctx) => {
  const userId = String(ctx.from.id);
  try {
    console.log(`[CHECKPAYMENT] Processing for user ${userId}`);
    await User.updateOne({ userId }, { lastActivity: new Date() });
    const user = await User.findOne({ userId });
    if (!user || !user.paymentId) return ctx.reply('У вас нет активных платежей.');

    if (user.paymentStatus === 'succeeded' && user.inviteLink) {
      await ctx.reply(await getPaidWelcomeMessage(), {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '💬 Техподдержка', url: (await getSettings()).supportLink }],
            [{ text: '💡 О канале', callback_data: 'about' }],
          ],
        },
      });
      await ctx.reply('Ваша уникальная одноразовая ссылка для вступления в закрытый канал:', {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: 'Присоединиться', url: user.inviteLink }]] },
      });
      return;
    }

    const payment = await getPayment(user.paymentId);
    if (payment.status === 'succeeded') await sendInviteLink(user, ctx, user.paymentId);
    else await ctx.reply(`Статус вашего платежа: ${payment.status}. Пожалуйста, завершите оплату или свяжитесь с поддержкой.`, {
      reply_markup: { inline_keyboard: [[{ text: '💬 Техподдержка', url: (await getSettings()).supportLink }]] },
    });
  } catch (error) {
    console.error(`[CHECKPAYMENT] Error for user ${userId}:`, error.message);
    await ctx.reply('Ошибка при проверке статуса платежа. Попробуйте позже или свяжитесь с поддержкой.', {
      reply_markup: { inline_keyboard: [[{ text: '💬 Техподдержка', url: (await getSettings()).supportLink }]] },
    });
  }
});

bot.start(async (ctx) => {
  const userId = String(ctx.from.id);
  const chatId = String(ctx.chat.id);
  const { first_name: firstName, username, phone_number: phoneNumber } = ctx.from;

  try {
    console.log(`[START] Received /start command from user ${userId}`);
    let user = await User.findOne({ userId });
    console.log(`[START] User ${userId} found or to be created: ${user ? 'exists' : 'new'}`);
    if (!user) {
      user = await User.create({ userId, chatId, firstName, username, phoneNumber, lastActivity: new Date() });
      console.log(`[START] User created: ${JSON.stringify(user)}`);
    } else {
      await User.updateOne({ userId }, { lastActivity: new Date() });
    }

    const settings = await getSettings();
    console.log(`[START] Sending reply to ${userId}`);
    ctx.session = ctx.session || {};
    ctx.session.navHistory = ctx.session.navHistory || [];
    const inlineKeyboard = [
      [
        ...(user.paymentStatus === 'succeeded' ? [] : [{ text: `🔥 Купить за ${settings.paymentAmount}р.`, callback_data: 'buy' }]),
        { text: '💬 Техподдержка', url: settings.supportLink },
      ],
      ...(adminIds.has(userId) ? [[{ text: '👑 Админка', callback_data: 'admin_panel' }, { text: '💡 О канале', callback_data: 'about' }]] : [[{ text: '💡 О канале', callback_data: 'about' }]]),
    ].filter(row => row.length > 0); // Удаляем пустые строки

    const sentMessage = await ctx.replyWithMarkdown(
        user.paymentStatus === 'succeeded' ? await getPaidWelcomeMessage() : await getWelcomeMessage(),
        {
          reply_markup: { inline_keyboard: inlineKeyboard },
        }
    );
    ctx.session.currentMessageId = sentMessage.message_id;
    console.log(`[START] Reply sent to ${userId}, stored message_id: ${ctx.session.currentMessageId}`);
  } catch (error) {
    console.error(`[START] Error for user ${userId}:`, error.message);
    await ctx.reply('Произошла ошибка. Попробуй снова или свяжитесь с нами.');
  }
});

// Функция для экранирования специальных символов в MarkdownV2
function escapeMarkdownV2(text) {
  if (!text) return text;
  return text.replace(/([_*[\]()~`>#+\-=|{}\.!\\])/g, '\\$1');
}

bot.action('admin_panel', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = String(ctx.from.id);
  const chatId = String(ctx.chat.id);
  if (!adminIds.has(userId)) return ctx.reply('Доступ запрещён.');

  try {
    console.log(`[ADMIN_PANEL] Processing for user ${userId}`);
    await User.updateOne({ userId }, { lastActivity: new Date() });
    ctx.session = ctx.session || {};
    ctx.session.navHistory = ctx.session.navHistory || [];
    ctx.session.navHistory.push('start');

    const replyMarkup = {
      inline_keyboard: [
        [{ text: 'Редактировать', callback_data: 'edit' }],
        [{ text: 'Выгрузить подписчиков', callback_data: 'export_subscribers' }],
        [{ text: 'Статистика', callback_data: 'stats' }],
        [{ text: '↩️ Назад', callback_data: 'back' }],
      ],
    };

    let messageId = ctx.message?.message_id || ctx.session.currentMessageId;
    if (messageId) {
      try {
        await ctx.telegram.editMessageText(chatId, messageId, undefined, 'Админка:\n➖➖➖➖➖➖➖➖➖➖➖', {
          parse_mode: 'Markdown',
          reply_markup: replyMarkup,
        });
        ctx.session.currentMessageId = messageId;
        console.log(`[ADMIN_PANEL] Edited message ${messageId} for user ${userId}`);
      } catch (editError) {
        console.warn(`[ADMIN_PANEL] Failed to edit message ${messageId} for user ${userId}:`, editError.message);
        const sentMessage = await ctx.reply('Админка:\n➖➖➖➖➖➖➖➖➖➖➖', {
          parse_mode: 'Markdown',
          reply_markup: replyMarkup,
        });
        ctx.session.currentMessageId = sentMessage.message_id;
        console.log(`[ADMIN_PANEL] Sent new message ${ctx.session.currentMessageId} for user ${userId}`);
      }
    } else {
      console.warn(`[ADMIN_PANEL] No valid message_id for user ${userId}, sending new message`);
      const sentMessage = await ctx.reply('Админка:\n➖➖➖➖➖➖➖➖➖➖➖', {
        parse_mode: 'Markdown',
        reply_markup: replyMarkup,
      });
      ctx.session.currentMessageId = sentMessage.message_id;
      console.log(`[ADMIN_PANEL] Sent new message ${ctx.session.currentMessageId} for user ${userId}`);
    }
  } catch (error) {
    console.error(`[ADMIN_PANEL] Error for user ${userId}:`, error.stack);
    await ctx.reply('Ошибка при открытии админ-панели.');
  }
});

bot.action('stats', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = String(ctx.from.id);
  const chatId = String(ctx.chat.id);
  if (!adminIds.has(userId)) return ctx.reply('Доступ запрещён.');

  try {
    console.log(`[STATS] Processing for user ${userId}`);
    await User.updateOne({ userId }, { lastActivity: new Date() });
    const totalUsers = await User.countDocuments();
    const paidUsers = await User.countDocuments({ paymentStatus: 'succeeded' });
    const activeUsersLast24h = await User.find({
      lastActivity: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
    }).select('firstName username userId');

    let activeUsersList = 'Нет активных пользователей за последние 24 часа.';
    if (activeUsersLast24h.length > 0) {
      activeUsersList = activeUsersLast24h
          .map(
              (user, index) =>
                  `${escapeMarkdownV2(String(index + 1))}\\. ${escapeMarkdownV2(user.firstName)} \\(@${escapeMarkdownV2(user.username || 'без username')}, ID: ${escapeMarkdownV2(user.userId)}\\)`
          )
          .join('\n');
    }

    // Экранируем только те части, которые содержат специальные символы
    const statsMessage = `📊 Статистика:\n➖➖➖➖➖➖➖➖➖➖➖➖➖➖\nПользователей: ${totalUsers} \\| Подписчиков: ${paidUsers}\n\nПосетители за последние 24 часа:\n${activeUsersList}`;

    console.log(`[STATS] Generated statsMessage for user ${userId}: ${statsMessage}`);

    ctx.session = ctx.session || {};
    ctx.session.navHistory = ctx.session.navHistory || [];
    ctx.session.navHistory.push('admin_panel');

    let messageId = ctx.message?.message_id || ctx.session.currentMessageId;
    if (messageId) {
      try {
        await ctx.telegram.editMessageText(chatId, messageId, undefined, statsMessage, {
          parse_mode: 'MarkdownV2',
          reply_markup: { inline_keyboard: [[{ text: '↩️ Назад', callback_data: 'back' }]] },
        });
        ctx.session.currentMessageId = messageId;
        console.log(`[STATS] Edited message ${messageId} for user ${userId}`);
      } catch (editError) {
        console.warn(`[STATS] Failed to edit message ${messageId} for user ${userId}:`, editError.message);
        const sentMessage = await ctx.reply(statsMessage, {
          parse_mode: 'MarkdownV2',
          reply_markup: { inline_keyboard: [[{ text: '↩️ Назад', callback_data: 'back' }]] },
        });
        ctx.session.currentMessageId = sentMessage.message_id;
        console.log(`[STATS] Sent new message ${ctx.session.currentMessageId} for user ${userId}`);
      }
    } else {
      console.warn(`[STATS] No valid message_id for user ${userId}, sending new message`);
      const sentMessage = await ctx.reply(statsMessage, {
        parse_mode: 'MarkdownV2',
        reply_markup: { inline_keyboard: [[{ text: '↩️ Назад', callback_data: 'back' }]] },
      });
      ctx.session.currentMessageId = sentMessage.message_id;
      console.log(`[STATS] Sent new message ${ctx.session.currentMessageId} for user ${userId}`);
    }
  } catch (error) {
    console.error(`[STATS] Error for user ${userId}:`, error.message);
    await ctx.reply('Ошибка при получении статистики. Попробуйте позже.');
  }
});

bot.action('export_subscribers', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = String(ctx.from.id);
  if (!adminIds.has(userId)) return ctx.reply('Доступ запрещён.');

  try {
    console.log(`[EXPORT_SUBSCRIBERS] Processing for user ${userId}`);
    await User.updateOne({ userId }, { lastActivity: new Date() });
    const users = await User.find({ paymentStatus: 'succeeded' }).lean();
    if (!users.length) return ctx.reply('Нет оплаченных подписчиков для выгрузки.');

    const ExcelJS = require('exceljs');
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Subscribers', { properties: { defaultRowHeight: 20 } });
    worksheet.columns = [
      { header: 'ID Пользователя', key: 'userId', width: 20 },
      { header: 'ID Чата', key: 'chatId', width: 20 },
      { header: 'Статус Платежа', key: 'paymentStatus', width: 15 },
      { header: 'ID Платежа', key: 'paymentId', width: 30 },
      { header: 'Локальный ID Платежа', key: 'localPaymentId', width: 30 },
      { header: 'Вступил в Канал', key: 'joinedChannel', width: 15 },
      { header: 'Ссылка Приглашения', key: 'inviteLink', width: 40 },
      { header: 'Срок Ссылки', key: 'inviteLinkExpires', width: 15 },
      { header: 'Имя', key: 'firstName', width: 20 },
      { header: 'Username', key: 'username', width: 20 },
      { header: 'Телефон', key: 'phoneNumber', width: 15 },
      { header: 'Email', key: 'email', width: 30 },
      { header: 'Дата Платежа', key: 'paymentDate', width: 20 },
      { header: 'Документ Платежа', key: 'paymentDocument', width: 40 },
      { header: 'Последняя Активность', key: 'lastActivity', width: 20 },
    ];

    worksheet.getRow(1).font = { bold: true, size: 12 };
    worksheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFADD8E6' } };
    worksheet.getRow(1).alignment = { vertical: 'middle', horizontal: 'center' };
    worksheet.getRow(1).height = 30;

    users.forEach(user => worksheet.addRow({
      userId: user.userId || 'N/A',
      chatId: user.chatId || 'N/A',
      paymentStatus: user.paymentStatus || 'N/A',
      paymentId: user.paymentId || 'N/A',
      localPaymentId: user.localPaymentId || 'N/A',
      joinedChannel: user.joinedChannel ? 'Да' : 'Нет',
      inviteLink: user.inviteLink || 'N/A',
      inviteLinkExpires: user.inviteLinkExpires ? new Date(user.inviteLinkExpires).toLocaleString('ru-RU') : 'Без срока',
      firstName: user.firstName || 'N/A',
      username: user.username ? `@${user.username}` : 'N/A',
      phoneNumber: user.phoneNumber || 'N/A',
      email: user.email || 'N/A',
      paymentDate: user.paymentDate ? user.paymentDate.toLocaleString('ru-RU') : 'N/A',
      paymentDocument: user.paymentDocument || 'N/A',
      lastActivity: user.lastActivity ? user.lastActivity.toLocaleString('ru-RU') : 'N/A',
    }));

    worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber > 1) {
        row.font = { size: 11 };
        row.alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };
        row.height = 25;
      }
    });

    ['M', 'O'].forEach(col => worksheet.getColumn(col).numFmt = 'dd.mm.yyyy hh:mm:ss');
    worksheet.columns.forEach(column => {
      let maxLength = 0;
      column.eachCell({ includeEmpty: true }, cell => maxLength = Math.max(maxLength, cell.value ? String(cell.value).length : 10));
      column.width = Math.min(maxLength + 2, 50);
    });

    const buffer = await workbook.xlsx.writeBuffer();
    await ctx.replyWithDocument({ source: buffer, filename: `subscribers_${new Date().toISOString().split('T')[0]}.xlsx` });
  } catch (error) {
    console.error(`[EXPORT_SUBSCRIBERS] Error for user ${userId}:`, error.message);
    await ctx.reply('Ошибка передачи подписчиков. Попробуйте позже.');
  }
});

bot.action('back', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = String(ctx.from.id);
  const chatId = String(ctx.chat.id);
  try {
    console.log(`[BACK] Processing for user ${userId}`);
    await User.updateOne({ userId }, { lastActivity: new Date() });
    ctx.session = ctx.session || {};
    ctx.session.navHistory = ctx.session.navHistory || [];
    const lastAction = ctx.session.navHistory.pop() || 'start';

    if (lastAction === 'start') {
      const settings = await getSettings();
      const user = await User.findOne({ userId });
      const inlineKeyboard = [
        [
          ...(user.paymentStatus === 'succeeded' ? [] : [{ text: `🔥 Купить за ${settings.paymentAmount}р.`, callback_data: 'buy' }]),
          { text: '💬 Техподдержка', url: settings.supportLink },
        ],
        ...(adminIds.has(userId)
            ? [[{ text: '👑 Админка', callback_data: 'admin_panel' }, { text: '💡 О канале', callback_data: 'about' }]]
            : [[{ text: '💡 О канале', callback_data: 'about' }]]),
      ].filter(row => row.length > 0); // Удаляем пустые строки

      const newText = user.paymentStatus === 'succeeded' ? await getPaidWelcomeMessage() : await getWelcomeMessage();
      const messageId = ctx.message?.message_id || ctx.session.currentMessageId;

      if (!messageId) {
        console.warn(`[BACK] No message_id available for user ${userId}, sending new message`);
        const sentMessage = await ctx.replyWithMarkdown(newText, { reply_markup: { inline_keyboard: inlineKeyboard } });
        ctx.session.currentMessageId = sentMessage.message_id;
        console.log(`[BACK] Sent new message ${ctx.session.currentMessageId} for user ${userId}`);
        return;
      }

      try {
        await ctx.telegram.editMessageText(chatId, messageId, undefined, newText, {
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: inlineKeyboard },
        });
        console.log(`[BACK] Edited message ${messageId} for user ${userId}`);
      } catch (editError) {
        console.warn(`[BACK] Failed to edit message ${messageId} for user ${userId}:`, editError.message);
        if (editError.message.includes('message is not modified')) {
          console.log(`[BACK] Message ${messageId} not modified, keeping current state for user ${userId}`);
          return;
        }
        const sentMessage = await ctx.replyWithMarkdown(newText, { reply_markup: { inline_keyboard: inlineKeyboard } });
        ctx.session.currentMessageId = sentMessage.message_id;
        console.log(`[BACK] Sent new message ${ctx.session.currentMessageId} for user ${userId}`);
      }
    } else if (lastAction === 'admin_panel') {
      const messageId = ctx.message?.message_id || ctx.session.currentMessageId;
      const replyMarkup = {
        inline_keyboard: [
          [{ text: 'Редактировать', callback_data: 'edit' }],
          [{ text: 'Выгрузить подписчиков', callback_data: 'export_subscribers' }],
          [{ text: 'Статистика', callback_data: 'stats' }],
          [{ text: '↩️ Назад', callback_data: 'back' }],
        ],
      };

      if (!messageId) {
        console.warn(`[BACK] No message_id available for user ${userId}, sending new message`);
        const sentMessage = await ctx.reply('Админка:\n➖➖➖➖➖➖➖➖➖➖➖', {
          parse_mode: 'Markdown',
          reply_markup: replyMarkup,
        });
        ctx.session.currentMessageId = sentMessage.message_id;
        console.log(`[BACK] Sent new message ${ctx.session.currentMessageId} for user ${userId}`);
        return;
      }

      try {
        await ctx.telegram.editMessageText(chatId, messageId, undefined, 'Админка:\n➖➖➖➖➖➖➖➖➖➖➖', {
          parse_mode: 'Markdown',
          reply_markup: replyMarkup,
        });
        console.log(`[BACK] Edited message ${messageId} for user ${userId}`);
      } catch (editError) {
        console.warn(`[BACK] Failed to edit message ${messageId} for user ${userId}:`, editError.message);
        if (editError.message.includes('message is not modified')) {
          console.log(`[BACK] Message ${messageId} not modified, keeping current state for user ${userId}`);
          return;
        }
        const sentMessage = await ctx.reply('Админка:\n➖➖➖➖➖➖➖➖➖➖➖', {
          parse_mode: 'Markdown',
          reply_markup: replyMarkup,
        });
        ctx.session.currentMessageId = sentMessage.message_id;
        console.log(`[BACK] Sent new message ${ctx.session.currentMessageId} for user ${userId}`);
      }
    }
  } catch (error) {
    console.error(`[BACK] Error for user ${userId}:`, error.stack);
    await ctx.reply('Произошла ошибка. Попробуйте снова.');
  }
});

bot.action('edit', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = String(ctx.from.id);
  const chatId = String(ctx.chat.id);
  if (!adminIds.has(userId)) return ctx.reply('Доступ запрещён.');

  try {
    console.log(`[EDIT] Processing for user ${userId}`);
    await User.updateOne({ userId }, { lastActivity: new Date() });
    ctx.session = ctx.session || {};
    ctx.session.navHistory = ctx.session.navHistory || [];
    ctx.session.navHistory.push('admin_panel');

    const replyMarkup = {
      inline_keyboard: [
        [{ text: 'О канале', callback_data: 'edit_channel' }],
        [{ text: 'Техподдержка', callback_data: 'edit_support' }],
        [{ text: 'Приветствие', callback_data: 'edit_welcome' }],
        [{ text: 'Сумма оплаты', callback_data: 'edit_payment_amount' }],
        [{ text: 'Приветствие после оплаты', callback_data: 'edit_paid_welcome' }],
        [{ text: '↩️ Назад', callback_data: 'back' }],
      ],
    };

    let messageId = ctx.message?.message_id || ctx.session.currentMessageId;
    if (messageId) {
      try {
        await ctx.telegram.editMessageText(chatId, messageId, undefined, 'Выберите, что редактировать:', {
          parse_mode: 'Markdown',
          reply_markup: replyMarkup,
        });
        ctx.session.currentMessageId = messageId;
        console.log(`[EDIT] Edited message ${messageId} for user ${userId}`);
      } catch (editError) {
        console.warn(`[EDIT] Failed to edit message ${messageId} for user ${userId}:`, editError.message);
        const sentMessage = await ctx.reply('Выберите, что редактировать:', {
          parse_mode: 'Markdown',
          reply_markup: replyMarkup,
        });
        ctx.session.currentMessageId = sentMessage.message_id;
        console.log(`[EDIT] Sent new message ${ctx.session.currentMessageId} for user ${userId}`);
      }
    } else {
      console.warn(`[EDIT] No valid message_id for user ${userId}, sending new message`);
      const sentMessage = await ctx.reply('Выберите, что редактировать:', {
        parse_mode: 'Markdown',
        reply_markup: replyMarkup,
      });
      ctx.session.currentMessageId = sentMessage.message_id;
      console.log(`[EDIT] Sent new message ${ctx.session.currentMessageId} for user ${userId}`);
    }
  } catch (error) {
    console.error(`[EDIT] Error for user ${userId}:`, error.stack);
    await ctx.reply('Ошибка при выборе редактирования.');
  }
});

bot.action('edit_channel', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = String(ctx.from.id);
  if (!adminIds.has(userId)) return ctx.reply('Доступ запрещён.');

  try {
    console.log(`[EDIT_CHANNEL] Processing for user ${userId}`);
    await User.updateOne({ userId }, { lastActivity: new Date() });
    ctx.session = ctx.session || {};
    ctx.session.editing = 'channelDescription';
    await ctx.reply('Введите новое описание канала:');
  } catch (error) {
    console.error(`[EDIT_CHANNEL] Error for user ${userId}:`, error.stack);
    await ctx.reply('Ошибка при запросе описания канала.');
  }
});

bot.action('edit_support', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = String(ctx.from.id);
  if (!adminIds.has(userId)) return ctx.reply('Доступ запрещён.');

  try {
    console.log(`[EDIT_SUPPORT] Processing for user ${userId}`);
    await User.updateOne({ userId }, { lastActivity: new Date() });
    ctx.session = ctx.session || {};
    ctx.session.editing = 'supportLink';
    await ctx.reply('Введите новый Telegram-username (например, @Username) или URL техподдержки:');
  } catch (error) {
    console.error(`[EDIT_SUPPORT] Error for user ${userId}:`, error.stack);
    await ctx.reply('Ошибка при запросе ссылки техподдержки.');
  }
});

bot.action('edit_welcome', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = String(ctx.from.id);
  if (!adminIds.has(userId)) return ctx.reply('Доступ запрещён.');

  try {
    console.log(`[EDIT_WELCOME] Processing for user ${userId}`);
    await User.updateOne({ userId }, { lastActivity: new Date() });
    ctx.session = ctx.session || {};
    ctx.session.editing = 'welcomeMessage';
    await ctx.reply('Введите новое приветственное сообщение:');
  } catch (error) {
    console.error(`[EDIT_WELCOME] Error for user ${userId}:`, error.stack);
    await ctx.reply('Ошибка при запросе приветственного сообщения.');
  }
});

bot.action('edit_payment_amount', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = String(ctx.from.id);
  if (!adminIds.has(userId)) return ctx.reply('Доступ запрещён.');

  try {
    console.log(`[EDIT_PAYMENT_AMOUNT] Processing for user ${userId}`);
    await User.updateOne({ userId }, { lastActivity: new Date() });
    ctx.session = ctx.session || {};
    ctx.session.editing = 'paymentAmount';
    await ctx.reply('Введите новую сумму оплаты в рублях (например, 499):');
  } catch (error) {
    console.error(`[EDIT_PAYMENT_AMOUNT] Error for user ${userId}:`, error.stack);
    await ctx.reply('Ошибка при запросе суммы оплаты.');
  }
});

bot.action('edit_paid_welcome', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = String(ctx.from.id);
  if (!adminIds.has(userId)) return ctx.reply('Доступ запрещён.');

  try {
    console.log(`[EDIT_PAID_WELCOME] Processing for user ${userId}`);
    await User.updateOne({ userId }, { lastActivity: new Date() });
    ctx.session = ctx.session || {};
    ctx.session.editing = 'paidWelcomeMessage';
    await ctx.reply('Введите новое приветственное сообщение для пользователей после оплаты:');
  } catch (error) {
    console.error(`[EDIT_PAID_WELCOME] Error for user ${userId}:`, error.stack);
    await ctx.reply('Ошибка при запросе приветственного сообщения после оплаты.');
  }
});

bot.action('buy', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = String(ctx.from.id);
  const chatId = String(ctx.chat.id);

  try {
    console.log(`[BUY] Processing for user ${userId}`);
    await User.updateOne({ userId }, { lastActivity: new Date() });
    const user = await User.findOne({ userId });
    if (!user.email) {
      ctx.session = ctx.session || {};
      ctx.session.waitingForEmail = true;
      await ctx.reply('Пожалуйста, введите ваш email для оформления оплаты:');
      return;
    }
    await processPayment(ctx, userId, chatId);
  } catch (error) {
    console.error(`[BUY] Error for user ${userId}:`, error.message);
    await ctx.reply('Произошла ошибка. Попробуйте позже.');
  }
});

bot.action('about', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = String(ctx.from.id);
  const chatId = String(ctx.chat.id);
  try {
    console.log(`[ABOUT] Processing for user ${userId}`);
    await User.updateOne({ userId }, { lastActivity: new Date() });
    const settings = await getSettings();
    ctx.session = ctx.session || {};

    const replyMarkup = { inline_keyboard: [[{ text: '↩️ Назад', callback_data: 'back' }]] };
    let messageId = ctx.message?.message_id || ctx.session.currentMessageId;

    if (messageId) {
      try {
        await ctx.telegram.editMessageText(chatId, messageId, undefined, settings.channelDescription, {
          parse_mode: 'Markdown',
          reply_markup: replyMarkup,
        });
        ctx.session.currentMessageId = messageId;
        console.log(`[ABOUT] Edited message ${messageId} for user ${userId}`);
      } catch (editError) {
        console.warn(`[ABOUT] Failed to edit message ${messageId} for user ${userId}:`, editError.message);
        const sentMessage = await ctx.replyWithMarkdown(settings.channelDescription, { reply_markup: replyMarkup });
        ctx.session.currentMessageId = sentMessage.message_id;
        console.log(`[ABOUT] Sent new message ${ctx.session.currentMessageId} for user ${userId}`);
      }
    } else {
      console.warn(`[ABOUT] No valid message_id for user ${userId}, sending new message`);
      const sentMessage = await ctx.replyWithMarkdown(settings.channelDescription, { reply_markup: replyMarkup });
      ctx.session.currentMessageId = sentMessage.message_id;
      console.log(`[ABOUT] Sent new message ${ctx.session.currentMessageId} for user ${userId}`);
    }
  } catch (error) {
    console.error(`[ABOUT] Error for user ${userId}:`, error.stack);
    await ctx.reply('Произошла ошибка. Попробуйте позже.');
  }
});

bot.on('text', async (ctx) => {
  const userId = String(ctx.from.id);
  ctx.session = ctx.session || {};

  try {
    console.log(`[TEXT] Processing text input for user ${userId}: ${ctx.message.text}`);
    await User.updateOne({ userId }, { lastActivity: new Date() });
    const text = ctx.message.text.trim();

    if (ctx.session.waitingForEmail) {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(text)) return ctx.reply('Пожалуйста, введите действительный email (например, user@example.com):');
      await User.updateOne({ userId }, { email: text });
      ctx.session.waitingForEmail = false;
      await ctx.reply('Email сохранён! Перехожу к созданию платежа...');
      return await processPayment(ctx, userId, String(ctx.chat.id));
    }

    if (!adminIds.has(userId) || !ctx.session.editing) return;

    if (ctx.session.editing === 'channelDescription') {
      if (text.length < 10) return ctx.reply('Описание должно быть не короче 10 символов. Попробуйте снова:');
      await Settings.findOneAndUpdate({}, { channelDescription: text }, { upsert: true, new: true });
      await resetSettingsCache();
      console.log(`[SETTINGS] Updated channelDescription for user ${userId}`);
      ctx.session.editing = null;
      await ctx.reply('Описание канала обновлено!');
    } else if (ctx.session.editing === 'supportLink') {
      let supportLink = text;
      if (supportLink.startsWith('@')) supportLink = `https://t.me/${supportLink.slice(1)}`;
      else if (!supportLink.match(/^https?:\/\//)) return ctx.reply('Введите действительный URL или Telegram-username (например, @Username). Попробуйте снова:');
      await Settings.findOneAndUpdate({}, { supportLink }, { upsert: true, new: true });
      await resetSettingsCache();
      console.log(`[SETTINGS] Updated supportLink for user ${userId}`);
      ctx.session.editing = null;
      await ctx.reply('Ссылка на техподдержку обновлена!');
    } else if (ctx.session.editing === 'welcomeMessage') {
      if (text.length < 10) return ctx.reply('Приветственное сообщение должно быть не короче 10 символов. Попробуйте снова:');
      await Settings.findOneAndUpdate({}, { welcomeMessage: text }, { upsert: true, new: true });
      await resetSettingsCache();
      console.log(`[SETTINGS] Updated welcomeMessage for user ${userId}`);
      ctx.session.editing = null;
      await ctx.reply('Приветственное сообщение обновлено!');
    } else if (ctx.session.editing === 'paymentAmount') {
      const amount = parseFloat(text);
      if (isNaN(amount) || amount < 1 || amount > 100000) return ctx.reply('Сумма должна быть от 1 до 100000 рублей.');
      await Settings.findOneAndUpdate({}, { paymentAmount: amount }, { upsert: true, new: true });
      await resetSettingsCache();
      console.log(`[SETTINGS] Updated paymentAmount to ${amount} for user ${userId}`);
      ctx.session.editing = null;
      await ctx.reply(`Сумма оплаты обновлена на ${amount} руб.!`);
    } else if (ctx.session.editing === 'paidWelcomeMessage') {
      if (text.length < 10) return ctx.reply('Приветственное сообщение после оплаты должно быть не короче 10 символов. Попробуйте снова:');
      await Settings.findOneAndUpdate({}, { paidWelcomeMessage: text }, { upsert: true, new: true });
      await resetSettingsCache();
      console.log(`[SETTINGS] Updated paidWelcomeMessage for user ${userId}`);
      ctx.session.editing = null;
      await ctx.reply('Приветственное сообщение после оплаты обновлено!');
    }
  } catch (error) {
    console.error(`[TEXT] Error processing text input for user ${userId}:`, error.stack);
    await ctx.reply('Ошибка при сохранении изменений. Попробуйте снова.');
  }
});

module.exports = { processPayment };