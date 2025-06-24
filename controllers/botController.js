const { bot, sendInviteLink, getSettings, getWelcomeMessage, getPaidWelcomeMessage } = require('../services/telegram');
const { createPayment, getPayment } = require('../services/yookassa');
const User = require('../models/User');

const adminIds = new Set((process.env.ADMIN_CHAT_IDS || '').split(',').map(id => id.trim()));

async function processPayment(ctx, userId, chatId) {
  try {
    console.log(`YOOKASSA_SHOP_ID: ${process.env.YOOKASSA_SHOP_ID}, YOOKASSA_SECRET_KEY: ${process.env.YOOKASSA_SECRET_KEY ? 'present' : 'missing'}`);
    const user = await User.findOne({ userId });
    if (user?.paymentStatus === 'succeeded' && user.inviteLink) {
      return ctx.reply('Вы уже оплатили доступ! Вот ваша одноразовая ссылка:', {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: 'Присоединиться', url: user.inviteLink }]] },
      });
    }

    const settings = await getSettings();
    const localPaymentId = require('uuid').v4();
    console.log(`Creating payment for user ${userId}, localPaymentId: ${localPaymentId}`);
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
    console.error(`Payment error for user ${userId}:`, error.message);
    await ctx.reply('Ошибка при создании платежа. Попробуйте позже или свяжитесь с поддержкой.', {
      reply_markup: { inline_keyboard: [[{ text: '💬 Техподдержка', url: (await getSettings()).supportLink }]] },
    });
  }
}

bot.command('checkpayment', async (ctx) => {
  const userId = String(ctx.from.id);
  try {
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
    console.error(`Error in /checkpayment for user ${userId}:`, error.message);
    await ctx.reply('Ошибка при проверке статуса платежа. Попробуйте позже или свяжитесь с поддержкой.', {
      reply_markup: { inline_keyboard: [[{ text: '💬 Техподдержка', url: (await getSettings()).supportLink }]] },
    });
  }
});

bot.start(async (ctx) => {
  console.log(`Received /start command from ${ctx.from.id}`);
  const userId = String(ctx.from.id);
  const chatId = String(ctx.chat.id);
  const { first_name: firstName, username, phone_number: phoneNumber } = ctx.from;

  try {
    console.log(`Processing /start for userId: ${userId}`);
    let user = await User.findOne({ userId });
    console.log(`User found or to be created: ${user ? 'exists' : 'new'}`);
    if (!user) {
      user = await User.create({ userId, chatId, firstName, username, phoneNumber, lastActivity: new Date() });
      console.log(`User created: ${JSON.stringify(user)}`);
    } else await User.updateOne({ userId }, { lastActivity: new Date() });

    const settings = await getSettings();
    console.log(`Sending reply to ${userId}`);
    if (user.paymentStatus === 'succeeded') {
      await ctx.replyWithMarkdown(await getPaidWelcomeMessage(), {
        reply_markup: {
          inline_keyboard: [
            [{ text: '💬 Техподдержка', url: settings.supportLink }],
            [{ text: '💡 О канале', callback_data: 'about' }],
          ],
        },
      });
    } else {
      await ctx.replyWithMarkdown(await getWelcomeMessage(), {
        reply_markup: {
          inline_keyboard: [
            [
              { text: `🔥 Купить за ${settings.paymentAmount}р.`, callback_data: 'buy' },
              { text: '💬 Техподдержка', url: settings.supportLink },
            ],
            ...(adminIds.has(userId) ? [[{ text: '👑 Админка', callback_data: 'admin_panel' }, { text: '💡 О канале', callback_data: 'about' }]] : [[{ text: '💡 О канале', callback_data: 'about' }]]),
          ],
        },
      });
    }
    console.log(`Reply sent to ${userId}`);
  } catch (error) {
    console.error(`Error in /start for user ${userId}:`, error.message);
    await ctx.reply('Произошла ошибка. Попробуй снова или свяжитесь с нами.');
  }
});

bot.action('admin_panel', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = String(ctx.from.id);
  if (!adminIds.has(userId)) return ctx.reply('Доступ запрещён.');

  try {
    await User.updateOne({ userId }, { lastActivity: new Date() });
    ctx.session = ctx.session || {};
    ctx.session.navHistory = ctx.session.navHistory || [];
    ctx.session.navHistory.push('start');
    await ctx.editMessageText('Админка:\n➖➖➖➖➖➖➖➖➖➖➖', {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: 'Редактировать', callback_data: 'edit' }],
          [{ text: 'Выгрузить подписчиков', callback_data: 'export_subscribers' }],
          [{ text: 'Статистика', callback_data: 'stats' }],
          [{ text: '↩️ Назад', callback_data: 'back' }],
        ],
      },
    });
  } catch (error) {
    console.error(`Error in admin panel for user ${userId}:`, error.message);
    await ctx.reply('Ошибка при открытии админ-панели.');
  }
});

bot.action('stats', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = String(ctx.from.id);
  if (!adminIds.has(userId)) return ctx.reply('Доступ запрещён.');

  try {
    await User.updateOne({ userId }, { lastActivity: new Date() });
    const totalUsers = await User.countDocuments();
    const paidUsers = await User.countDocuments({ paymentStatus: 'succeeded' });
    const activeUsersLast24h = await User.find({ lastActivity: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } }).select('firstName username userId');
    let activeUsersList = 'Нет активных пользователей за последние 24 часа.';
    if (activeUsersLast24h.length > 0) activeUsersList = activeUsersLast24h.map((user, index) => `${index + 1}. ${user.firstName} (${user.username ? `@${user.username}` : ''}, ID: ${user.userId})`.trim()).join('\n');

    const statsMessage = `📊 Статистика:\n➖➖➖➖➖➖➖➖➖➖➖➖➖\nПользователей: ${totalUsers} | Подписчиков: ${paidUsers}\n\nПосетители за последние 24 часа:\n${activeUsersList}`;
    ctx.session = ctx.session || {};
    ctx.session.navHistory = ctx.session.navHistory || [];
    ctx.session.navHistory.push('admin_panel');
    await ctx.editMessageText(statsMessage, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [[{ text: '↩️ Назад', callback_data: 'back' }]] },
    });
  } catch (error) {
    console.error(`Error in stats for user ${userId}:`, error.message);
    await ctx.reply('Ошибка при получении статистики. Попробуйте позже.');
  }
});

bot.action('export_subscribers', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = String(ctx.from.id);
  if (!adminIds.has(userId)) return ctx.reply('Доступ запрещён.');

  try {
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
    console.error(`Error in export_subscribers for user ${userId}:`, error.message);
    await ctx.reply('Ошибка передачи подписчиков. Попробуйте позже.');
  }
});

bot.action('back', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = String(ctx.from.id);
  try {
    await User.updateOne({ userId }, { lastActivity: new Date() });
    ctx.session = ctx.session || {};
    ctx.session.navHistory = ctx.session.navHistory || [];
    const lastAction = ctx.session.navHistory.pop() || 'start';

    if (lastAction === 'start') {
      const settings = await getSettings();
      const user = await User.findOne({ userId });
      const replyMarkup = {
        reply_markup: {
          inline_keyboard: [
            [
              { text: `🔥 Купить за ${settings.paymentAmount}р.`, callback_data: 'buy' },
              { text: '💬 Техподдержка', url: settings.supportLink },
            ],
            ...(adminIds.has(userId) ? [[{ text: '👑 Админка', callback_data: 'admin_panel' }, { text: '💡 О канале', callback_data: 'about' }]] : [[{ text: '💡 О канале', callback_data: 'about' }]]),
          ],
        },
      };
      if (user.paymentStatus === 'succeeded' && user.inviteLink) {
        await ctx.editMessageText(await getPaidWelcomeMessage(), {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '💬 Техподдержка', url: settings.supportLink }],
              [{ text: '💡 О канале', callback_data: 'about' }],
            ],
          },
        });
      } else await ctx.editMessageText(await getWelcomeMessage(), { parse_mode: 'Markdown', reply_markup: replyMarkup.reply_markup });
    } else if (lastAction === 'admin_panel') {
      await ctx.editMessageText('Админка:\n➖➖➖➖➖➖➖➖➖➖➖', {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: 'Редактировать', callback_data: 'edit' }],
            [{ text: 'Выгрузить подписчиков', callback_data: 'export_subscribers' }],
            [{ text: 'Статистика', callback_data: 'stats' }],
            [{ text: '↩️ Назад', callback_data: 'back' }],
          ],
        },
      });
    }
  } catch (error) {
    console.error(`Error in back for user ${userId}:`, error.stack);
    await ctx.reply('Произошла ошибка. Попробуйте снова.');
  }
});

bot.action('edit', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = String(ctx.from.id);
  if (!adminIds.has(userId)) return ctx.reply('Доступ запрещён.');

  try {
    await User.updateOne({ userId }, { lastActivity: new Date() });
    ctx.session = ctx.session || {};
    ctx.session.navHistory = ctx.session.navHistory || [];
    ctx.session.navHistory.push('admin_panel');
    await ctx.editMessageText('Выберите, что редактировать:', {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: 'О канале', callback_data: 'edit_channel' }],
          [{ text: 'Техподдержка', callback_data: 'edit_support' }],
          [{ text: 'Приветствие', callback_data: 'edit_welcome' }],
          [{ text: 'Сумма оплаты', callback_data: 'edit_payment_amount' }],
          [{ text: 'Приветствие после оплаты', callback_data: 'edit_paid_welcome' }],
          [{ text: '↩️ Назад', callback_data: 'back' }],
        ],
      },
    });
  } catch (error) {
    console.error(`Error in edit for user ${userId}:`, error.stack);
    await ctx.reply('Ошибка при выборе редактирования.');
  }
});

bot.action('edit_channel', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = String(ctx.from.id);
  if (!adminIds.has(userId)) return ctx.reply('Доступ запрещён.');

  try {
    await User.updateOne({ userId }, { lastActivity: new Date() });
    ctx.session = ctx.session || {};
    ctx.session.editing = 'channelDescription';
    await ctx.reply('Введите новое описание канала:');
  } catch (error) {
    console.error(`Error in edit_channel for user ${userId}:`, error.stack);
    await ctx.reply('Ошибка при запросе описания канала.');
  }
});

bot.action('edit_support', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = String(ctx.from.id);
  if (!adminIds.has(userId)) return ctx.reply('Доступ запрещён.');

  try {
    await User.updateOne({ userId }, { lastActivity: new Date() });
    ctx.session = ctx.session || {};
    ctx.session.editing = 'supportLink';
    await ctx.reply('Введите новый Telegram-username (например, @Username) или URL техподдержки:');
  } catch (error) {
    console.error(`Error in edit_support for user ${userId}:`, error.stack);
    await ctx.reply('Ошибка при запросе ссылки техподдержки.');
  }
});

bot.action('edit_welcome', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = String(ctx.from.id);
  if (!adminIds.has(userId)) return ctx.reply('Доступ запрещён.');

  try {
    await User.updateOne({ userId }, { lastActivity: new Date() });
    ctx.session = ctx.session || {};
    ctx.session.editing = 'welcomeMessage';
    await ctx.reply('Введите новое приветственное сообщение:');
  } catch (error) {
    console.error(`Error in edit_welcome for user ${userId}:`, error.stack);
    await ctx.reply('Ошибка при запросе приветственного сообщения.');
  }
});

bot.action('edit_payment_amount', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = String(ctx.from.id);
  if (!adminIds.has(userId)) return ctx.reply('Доступ запрещён.');

  try {
    await User.updateOne({ userId }, { lastActivity: new Date() });
    ctx.session = ctx.session || {};
    ctx.session.editing = 'paymentAmount';
    await ctx.reply('Введите новую сумму оплаты в рублях (например, 499):');
  } catch (error) {
    console.error(`Error in edit_payment_amount for user ${userId}:`, error.stack);
    await ctx.reply('Ошибка при запросе суммы оплаты.');
  }
});

bot.action('edit_paid_welcome', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = String(ctx.from.id);
  if (!adminIds.has(userId)) return ctx.reply('Доступ запрещён.');

  try {
    await User.updateOne({ userId }, { lastActivity: new Date() });
    ctx.session = ctx.session || {};
    ctx.session.editing = 'paidWelcomeMessage';
    await ctx.reply('Введите новое приветственное сообщение для пользователей после оплаты:');
  } catch (error) {
    console.error(`Error in edit_paid_welcome for user ${userId}:`, error.stack);
    await ctx.reply('Ошибка при запросе приветственного сообщения после оплаты.');
  }
});

bot.action('buy', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = String(ctx.from.id);
  const chatId = String(ctx.chat.id);

  try {
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
    console.error(`Error in buy for user ${userId}:`, error.message);
    await ctx.reply('Произошла ошибка. Попробуйте позже.');
  }
});

bot.action('about', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = String(ctx.from.id);
  try {
    await User.updateOne({ userId }, { lastActivity: new Date() });
    const settings = await getSettings();
    try {
      await ctx.editMessageText(settings.channelDescription, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: '↩️ Назад', callback_data: 'back' }]] },
      });
    } catch (editError) {
      console.warn(`Failed to edit message for user ${userId}:`, editError.message);
      await ctx.replyWithMarkdown(settings.channelDescription, {
        reply_markup: { inline_keyboard: [[{ text: '↩️ Назад', callback_data: 'back' }]] },
      });
    }
  } catch (error) {
    console.error(`Error in about for user ${userId}:`, error.stack);
    await ctx.reply('Произошла ошибка. Попробуйте позже.');
  }
});

bot.on('text', async (ctx) => {
  const userId = String(ctx.from.id);
  ctx.session = ctx.session || {};

  try {
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
      cachedSettings = await Settings.findOneAndUpdate({}, { channelDescription: text }, { upsert: true, new: true });
      ctx.session.editing = null;
      await ctx.reply('Описание канала обновлено!');
    } else if (ctx.session.editing === 'supportLink') {
      let supportLink = text;
      if (supportLink.startsWith('@')) supportLink = `https://t.me/${supportLink.slice(1)}`;
      else if (!supportLink.match(/^https?:\/\//)) return ctx.reply('Введите действительный URL или Telegram-username (например, @Username). Попробуйте снова:');
      cachedSettings = await Settings.findOneAndUpdate({}, { supportLink }, { upsert: true, new: true });
      ctx.session.editing = null;
      await ctx.reply('Ссылка на техподдержку обновлена!');
    } else if (ctx.session.editing === 'welcomeMessage') {
      if (text.length < 10) return ctx.reply('Приветственное сообщение должно быть не короче 10 символов. Попробуйте снова:');
      cachedSettings = await Settings.findOneAndUpdate({}, { welcomeMessage: text }, { upsert: true, new: true });
      ctx.session.editing = null;
      await ctx.reply('Приветственное сообщение обновлено!');
    } else if (ctx.session.editing === 'paymentAmount') {
      const amount = parseFloat(text);
      if (isNaN(amount) || amount <= 0) return ctx.reply('Пожалуйста, введите корректную сумму больше 0 (например, 499):');
      cachedSettings = await Settings.findOneAndUpdate({}, { paymentAmount: amount }, { upsert: true, new: true });
      ctx.session.editing = null;
      await ctx.reply(`Сумма оплаты обновлена на ${amount} руб.!`);
    } else if (ctx.session.editing === 'paidWelcomeMessage') {
      if (text.length < 10) return ctx.reply('Приветственное сообщение после оплаты должно быть не короче 10 символов. Попробуйте снова:');
      cachedSettings = await Settings.findOneAndUpdate({}, { paidWelcomeMessage: text }, { upsert: true, new: true });
      ctx.session.editing = null;
      await ctx.reply('Приветственное сообщение после оплаты обновлено!');
    }
  } catch (error) {
    console.error(`Error processing text input for user ${userId}:`, error.stack);
    await ctx.reply('Ошибка при сохранении изменений. Попробуйте снова.');
  }
});

module.exports = { processPayment };