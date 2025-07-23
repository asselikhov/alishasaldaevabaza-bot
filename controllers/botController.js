const { bot, sendInviteLink, getSettings, getWelcomeMessage, getPaidWelcomeMessage, resetSettingsCache } = require('../services/telegram');
const { createPayment, getPayment } = require('../services/yookassa');
const User = require('../models/User');
const Settings = require('../models/Settings');
const { createCanvas } = require('canvas');
const Chart = require('chart.js/auto');

const adminIds = new Set((process.env.ADMIN_CHAT_IDS || '').split(',').map(id => id.trim()));

async function processPayment(ctx, userId, chatId) {
  try {
    const user = await User.findOne({ userId });
    if (user?.paymentStatus === 'succeeded' && user.inviteLink) {
      return ctx.reply('Вы уже оплатили доступ! Вот ваша одноразовая ссылка:', {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: 'Присоединиться', url: user.inviteLink }]] },
      });
    }

    const settings = await getSettings();
    const localPaymentId = require('uuid').v4();
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
            [{ text: '💬 Техподдержка', url: (await getSettings()).supportLink }, { text: '💡 О канале', callback_data: 'about' }],
          ],
        },
      });
      await ctx.reply('Ваша уникальная одноразовая ссылка для вступления в закрытый канал:', {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: 'Присоединиться', url: user.inviteLink }]] },
      });
      console.log(`[CHECKPAYMENT] Sent existing invite link for user ${userId}: ${user.inviteLink}`);
      return;
    }

    const payment = await getPayment(user.paymentId);
    if (payment.status === 'succeeded') {
      const inviteLink = await sendInviteLink(user, ctx, user.paymentId);
      await ctx.reply(await getPaidWelcomeMessage(), {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '💬 Техподдержка', url: (await getSettings()).supportLink }, { text: '💡 О канале', callback_data: 'about' }],
          ],
        },
      });
      await ctx.reply('Ваша уникальная одноразовая ссылка для вступления в закрытый канал:', {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: 'Присоединиться', url: inviteLink }]] },
      });
      console.log(`[CHECKPAYMENT] Sent new invite link for user ${userId}: ${inviteLink}`);
    } else {
      await ctx.reply(`Статус вашего платежа: ${payment.status}. Пожалуйста, завершите оплату или свяжитесь с поддержкой.`, {
        reply_markup: { inline_keyboard: [[{ text: '💬 Техподдержка', url: (await getSettings()).supportLink }]] },
      });
    }
  } catch (error) {
    console.error(`[CHECKPAYMENT] Error for user ${userId}:`, error.message);
    await ctx.reply('Ошибка при проверке статуса платежа. Попробуйте позже или свяжитесь с поддержкой.', {
      reply_markup: { inline_keyboard: [[{ text: '💬 Техподдержка', url: (await getSettings()).supportLink }]] },
    });
  }
});

bot.command('checkuser', async (ctx) => {
  const userId = String(ctx.from.id);
  if (!adminIds.has(userId)) return ctx.reply('Доступ запрещён.');
  const targetUserId = ctx.message.text.split(' ')[1];
  if (!targetUserId) return ctx.reply('Укажите ID пользователя: /checkuser <userId>');

  try {
    console.log(`[CHECKUSER] Checking user ${targetUserId} by admin ${userId}`);
    const user = await User.findOne({ userId: targetUserId });
    if (!user) return ctx.reply(`Пользователь ${targetUserId} не найден.`);

    const channelId = process.env.CHANNEL_ID;
    if (!channelId) return ctx.reply('Ошибка: ID канала не настроен.');

    const isMember = await checkChannelMembership(targetUserId, channelId);
    if (isMember && !user.joinedChannel) {
      await User.updateOne({ userId: targetUserId }, { joinedChannel: true, inviteLinkUsed: true });
      console.log(`[CHECKUSER] Updated joinedChannel to true for user ${targetUserId}`);
    }

    await ctx.reply(
        `Пользователь ${targetUserId}:\n` +
        `Имя: ${user.firstName || 'N/A'}\n` +
        `Username: ${user.username ? '@' + user.username : 'N/A'}\n` +
        `Статус платежа: ${user.paymentStatus || 'N/A'}\n` +
        `Вступил в канал: ${isMember ? 'Да' : 'Нет'}\n` +
        `Ссылка использована: ${user.inviteLinkUsed ? 'Да' : 'Нет'}\n` +
        `Ссылка: ${user.inviteLink || 'N/A'}`,
        { parse_mode: 'Markdown' }
    );
  } catch (error) {
    console.error(`[CHECKUSER] Error for user ${targetUserId}:`, error.message);
    await ctx.reply('Ошибка при проверке статуса пользователя.');
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
    const inlineKeyboard = user.paymentStatus === 'succeeded' ? [
      [
        { text: '💬 Техподдержка', url: settings.supportLink },
        { text: '💡 О канале', callback_data: 'about' },
        ...(adminIds.has(userId) ? [{ text: '👑 Админка', callback_data: 'admin_panel' }] : []),
      ],
    ] : [
      [
        { text: `🔥 Купить за ${settings.paymentAmount}р.`, callback_data: 'buy' },
        { text: '💬 Техподдержка', url: settings.supportLink },
      ],
      [
        { text: '💡 О канале', callback_data: 'about' },
        ...(adminIds.has(userId) ? [{ text: '👑 Админка', callback_data: 'admin_panel' }] : []),
      ],
    ];

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

// Улучшенная функция для экранирования специальных символов в MarkdownV2
function escapeMarkdownV2(text) {
  if (!text || typeof text !== 'string') return text || '';
  console.log(`[ESCAPE_MARKDOWNV2] Input: ${text}`);
  const escaped = text.replace(/([_*[\]()~`>#+\-=|{}\.!\\])/g, '\\$1').replace(/(?<!\d)\.(?!\d)/g, '\\.');
  console.log(`[ESCAPE_MARKDOWNV2] Output: ${escaped}`);
  return escaped;
}

async function generateActivityChart(dailyActivity) {
  try {
    console.log(`[GENERATE_ACTIVITY_CHART] Input data: ${JSON.stringify(dailyActivity)}`);
    if (!Array.isArray(dailyActivity) || dailyActivity.some(entry => !entry.date || typeof entry.count !== 'number')) {
      throw new Error('Invalid dailyActivity data format');
    }

    const canvas = createCanvas(800, 400);
    const ctx = canvas.getContext('2d');

    const labels = dailyActivity.map(entry => {
      const [year, month, day] = entry.date.split('-');
      return `${day}.${month}`;
    });
    const data = dailyActivity.map(entry => entry.count);

    console.log(`[GENERATE_ACTIVITY_CHART] Labels: ${JSON.stringify(labels)}, Data: ${JSON.stringify(data)}`);

    const gradient = ctx.createLinearGradient(0, 0, 0, 400);
    gradient.addColorStop(0, '#1E1E1E');
    gradient.addColorStop(1, '#2D2D2D');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 800, 400);

    new Chart(ctx, {
      type: 'line',
      data: {
        labels: labels,
        datasets: [{
          data: data,
          borderColor: '#3B82F6',
          borderWidth: 3,
          pointBackgroundColor: '#3B82F6',
          pointRadius: 4,
          pointHoverRadius: 6,
          tension: 0.4,
          fill: {
            target: 'origin',
            above: 'rgba(59, 130, 246, 0.1)',
          },
        }],
      },
      options: {
        responsive: true,
        animation: {
          duration: 1000,
          easing: 'easeOutQuart',
        },
        plugins: {
          legend: {
            display: false,
          },
          title: {
            display: true,
            text: 'Активность пользователей за Июль 2025',
            font: { size: 16, family: 'Inter, sans-serif', weight: '600' },
            color: '#A0AEC0',
            padding: { top: 10, bottom: 10 },
          },
        },
        scales: {
          x: {
            title: {
              display: true,
              text: 'Дата',
              font: { size: 12, family: 'Inter, sans-serif', weight: '500' },
              color: '#A0AEC0',
            },
            ticks: {
              color: '#A0AEC0',
              font: { size: 10, family: 'Inter, sans-serif' },
              maxRotation: 45,
              minRotation: 45,
            },
            grid: {
              color: 'rgba(255, 255, 255, 0.05)',
              borderColor: 'rgba(255, 255, 255, 0.2)',
              drawBorder: false,
            },
          },
          y: {
            title: {
              display: true,
              text: 'Пользователи',
              font: { size: 12, family: 'Inter, sans-serif', weight: '500' },
              color: '#A0AEC0',
            },
            ticks: {
              color: '#A0AEC0',
              font: { size: 10, family: 'Inter, sans-serif' },
              beginAtZero: true,
              stepSize: 1,
              precision: 0,
              callback: (value) => Number.isInteger(value) ? value : null,
            },
            grid: {
              color: 'rgba(255, 255, 255, 0.05)',
              borderColor: 'rgba(255, 255, 255, 0.2)',
              drawBorder: false,
            },
            min: 0,
            max: Math.max(...data, 10) + 5,
          },
        },
        elements: {
          line: {
            borderJoinStyle: 'round',
            borderCapStyle: 'round',
          },
          point: {
            hoverBorderWidth: 2,
          },
        },
      },
    });

    const buffer = canvas.toBuffer('image/png');
    console.log(`[GENERATE_ACTIVITY_CHART] Chart generated successfully for ${dailyActivity.length} data points`);
    return buffer;
  } catch (error) {
    console.error(`[GENERATE_ACTIVITY_CHART] Error: ${error.message}`, error.stack);
    throw error;
  }
}

async function checkChannelMembership(userId, channelId, retries = 3, delay = 1000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      console.log(`[CHECK_CHANNEL_MEMBERSHIP] Attempt ${attempt} for user ${userId}`);
      const chatMember = await bot.telegram.getChatMember(channelId, userId);
      const isMember = ['member', 'administrator', 'creator'].includes(chatMember.status);
      console.log(`[CHECK_CHANNEL_MEMBERSHIP] User ${userId} status: ${chatMember.status}, isMember: ${isMember}`);
      return isMember;
    } catch (error) {
      console.error(`[CHECK_CHANNEL_MEMBERSHIP] Attempt ${attempt} failed for user ${userId}: ${error.message}`);
      if (attempt < retries && error.message.includes('Too Many Requests')) {
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      return false;
    }
  }
  console.error(`[CHECK_CHANNEL_MEMBERSHIP] All ${retries} attempts failed for user ${userId}`);
  return false;
}

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

    const today = new Date();
    today.setHours(23, 59, 59, 999);
    const startOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
    startOfMonth.setHours(0, 0, 0, 0);

    const dailyActivity = await User.aggregate([
      {
        $match: {
          lastActivity: { $gte: startOfMonth, $lte: today },
        },
      },
      {
        $group: {
          _id: {
            $dateToString: { format: '%Y-%m-%d', date: '$lastActivity', timezone: 'Europe/Moscow' },
          },
          count: { $sum: 1 },
        },
      },
      {
        $sort: { '_id': 1 },
      },
    ]);

    const dateArray = [];
    let currentDate = new Date(startOfMonth);
    while (currentDate <= today) {
      const dateStr = currentDate.toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit' }).split('.').reverse().join('-');
      const found = dailyActivity.find(d => d._id === dateStr);
      dateArray.push({ date: dateStr, count: found ? found.count : 0 });
      currentDate.setDate(currentDate.getDate() + 1);
    }

    console.log(`[STATS] Generated dateArray: ${JSON.stringify(dateArray)}`);

    const chartBuffer = await generateActivityChart(dateArray);

    ctx.session = ctx.session || {};
    ctx.session.navHistory = ctx.session.navHistory || [];
    ctx.session.navHistory.push('admin_panel');

    const sentMessage = await ctx.replyWithPhoto(
        { source: chartBuffer },
        {
          caption: `📊 Статистика:\n➖➖➖➖➖➖➖➖➖➖➖➖➖➖\nПользователей: ${totalUsers} | Подписчиков: ${paidUsers}`,
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: [[{ text: '↩️ Назад', callback_data: 'back' }]] },
        }
    );
    ctx.session.currentMessageId = sentMessage.message_id;
    console.log(`[STATS] Sent photo with stats caption, message_id: ${sentMessage.message_id} for user ${userId}`);
  } catch (error) {
    console.error(`[STATS] Error for user ${userId}: ${error.message}`, error.stack);
    await ctx.reply('Ошибка при получении статистики. Попробуйте позже.');
  }
});

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
        [{ text: 'Обновить статусы вступления', callback_data: 'update_joined_status' }],
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

bot.action('update_joined_status', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = String(ctx.from.id);
  if (!adminIds.has(userId)) return ctx.reply('Доступ запрещён.');

  try {
    console.log(`[UPDATE_JOINED_STATUS] Processing for user ${userId}`);
    await User.updateOne({ userId }, { lastActivity: new Date() });

    const users = await User.find({ paymentStatus: 'succeeded' }).lean();
    if (!users.length) return ctx.reply('Нет оплаченных подписчиков для обновления.');

    const channelId = process.env.CHANNEL_ID;
    if (!channelId) {
      console.error(`[UPDATE_JOINED_STATUS] CHANNEL_ID not set`);
      return ctx.reply('Ошибка: ID канала не настроен.');
    }

    let updatedCount = 0;
    const notJoinedUsers = [];
    for (const user of users) {
      const isMember = await checkChannelMembership(user.userId, channelId);
      if (isMember && !user.joinedChannel) {
        await User.updateOne({ userId: user.userId }, { joinedChannel: true, inviteLinkUsed: true });
        updatedCount++;
        console.log(`[UPDATE_JOINED_STATUS] Updated user ${user.userId} to joinedChannel: true`);
      } else if (!isMember) {
        notJoinedUsers.push({ userId: user.userId, firstName: user.firstName, username: user.username });
      }
    }

    await ctx.reply(
        `Обновлено статусов вступления: ${updatedCount} пользователей.\n` +
        (notJoinedUsers.length > 0
            ? `Не вступили в канал:\n${notJoinedUsers.map(u => `${u.firstName} (@${u.username || 'без username'}, ID: ${u.userId})`).join('\n')}`
            : 'Все оплаченные пользователи вступили в канал.')
    );
    console.log(`[UPDATE_JOINED_STATUS] Updated ${updatedCount} users' joinedChannel status, not joined: ${JSON.stringify(notJoinedUsers)}`);
  } catch (error) {
    console.error(`[UPDATE_JOINED_STATUS] Error for user ${userId}:`, error.message);
    await ctx.reply('Ошибка при обновлении статусов вступления. Попробуйте позже.');
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

    const channelId = process.env.CHANNEL_ID;
    if (channelId) {
      for (const user of users) {
        const isMember = await checkChannelMembership(user.userId, channelId);
        if (isMember && !user.joinedChannel) {
          await User.updateOne({ userId: user.userId }, { joinedChannel: true, inviteLinkUsed: true });
          console.log(`[EXPORT_SUBSCRIBERS] Updated user ${user.userId} to joinedChannel: true`);
        }
      }
    } else {
      console.warn(`[EXPORT_SUBSCRIBERS] CHANNEL_ID not set, skipping membership check`);
    }

    console.log(`[EXPORT_SUBSCRIBERS] Raw users data: ${JSON.stringify(users.map(u => ({ userId: u.userId, firstName: u.firstName, username: u.username, inviteLink: u.inviteLink, joinedChannel: u.joinedChannel })))}`);

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
      { header: 'Ссылка Приглашения', key: 'inviteLink', width: 40 }, // Обновлено название ключа
      { header: 'Срок Ссылки', key: 'inviteLinkExpires', width: 20 },
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
      inviteLink: user.inviteLink || 'N/A', // Используем поле inviteLink из базы данных
      inviteLinkExpires: user.inviteLinkExpires ? new Date(user.inviteLinkExpires).toLocaleString('ru-RU') : 'N/A',
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
      const inlineKeyboard = user.paymentStatus === 'succeeded' ? [
        [
          { text: '💬 Техподдержка', url: settings.supportLink },
          { text: '💡 О канале', callback_data: 'about' },
          ...(adminIds.has(userId) ? [{ text: '👑 Админка', callback_data: 'admin_panel' }] : []),
        ],
      ] : [
        [
          { text: `🔥 Купить за ${settings.paymentAmount}р.`, callback_data: 'buy' },
          { text: '💬 Техподдержка', url: settings.supportLink },
        ],
        [
          { text: '💡 О канале', callback_data: 'about' },
          ...(adminIds.has(userId) ? [{ text: '👑 Админка', callback_data: 'admin_panel' }] : []),
        ],
      ];

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
          [{ text: 'Обновить статусы вступления', callback_data: 'update_joined_status' }],
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