const { Telegraf, session: telegrafSession } = require('telegraf');
const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');
const express = require('express');
const ExcelJS = require('exceljs');
const crypto = require('crypto');
require('dotenv').config();

const app = express();

// Middleware для получения raw body для вебхука YooKassa
app.use('/webhook/yookassa', express.raw({ type: 'application/json' }));
app.use(express.json());

// Логирование всех запросов
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] Received ${req.method} request at ${req.path}`);
  console.log('Request body:', req.body ? JSON.stringify(req.body) : 'No body');
  next();
});

// Проверка переменных окружения
const requiredEnvVars = ['BOT_TOKEN', 'MONGODB_URI', 'YOOKASSA_SHOP_ID', 'YOOKASSA_SECRET_KEY', 'CHANNEL_ID', 'PAYMENT_GROUP_ID', 'ADMIN_CHAT_IDS', 'RETURN_URL'];
for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    console.error(`${envVar} is not defined in environment variables`);
    process.exit(1);
  }
}
console.log('All required environment variables are set');

// Настройка Mongoose
mongoose.set('strictQuery', true);
mongoose.connect(process.env.MONGODB_URI)
    .then(() => console.log('Connected to MongoDB via Mongoose'))
    .catch(err => {
      console.error('MongoDB connection error:', err.message);
      console.warn('Falling back to in-memory session storage');
    });

// Инициализация бота
const bot = new Telegraf(process.env.BOT_TOKEN);
bot.catch((err, ctx) => {
  console.error('Telegraf global error for update', ctx.update, ':', err.message);
  if (ctx) ctx.reply('Произошла ошибка. Попробуйте позже.');
});

// Используем in-memory сессии
bot.use(telegrafSession());

// Схема пользователя
const UserSchema = new mongoose.Schema({
  userId: String,
  chatId: String,
  paymentStatus: { type: String, default: 'pending' },
  paymentId: String,
  localPaymentId: String, // Новое поле для локального ID
  joinedChannel: { type: Boolean, default: false },
  inviteLink: String,
  inviteLinkExpires: Number,
  firstName: String,
  username: String,
  phoneNumber: String,
  email: String,
  paymentDate: Date,
  paymentDocument: { type: String, default: null },
  lastActivity: { type: Date, default: Date.now },
});

const User = mongoose.model('User', UserSchema);

// Схема настроек
const SettingsSchema = new mongoose.Schema({
  channelDescription: { type: String, default: 'Добро пожаловать в наш магазин! Мы предлагаем стильную одежду по доступным ценам с быстрой доставкой. Подписывайтесь на канал для эксклюзивных предложений! 😊' },
  supportLink: { type: String, default: 'https://t.me/Eagleshot' },
  welcomeMessage: { type: String, default: 'ЙОУ ЧИКСЫ 😎\n\nЯ рада видеть вас здесь, лютые модницы 💅\n\nДержите меня семеро, потому что я вас научу пипэц как выгодно брать шмотьё🤭🤫\n\nЖду вас в своём клубе шаболятниц 🤝❤️' },
  paymentAmount: { type: Number, default: 399 }, // Добавлено поле для суммы оплаты
  paidWelcomeMessage: { type: String, default: '🎉 Добро пожаловать в закрытый клуб модниц! 🎉\n\nВы успешно оплатили доступ к эксклюзивному контенту. Наслаждайтесь шопингом и стильными находками! 💃\n\nЕсли есть вопросы, я всегда рядом!' }, // Новое поле для приветствия после оплаты
});

const Settings = mongoose.model('Settings', SettingsSchema);

// Определение администраторов
const adminIds = new Set((process.env.ADMIN_CHAT_IDS || '').split(',').map(id => id.trim()));
console.log('Parsed adminIds:', [...adminIds]);

// Функция валидации вебхука YooKassa (временное отключение проверки подписи)
function validateYookassaWebhook(req) {
  console.log('[WEBHOOK] Raw body (buffer):', req.body);
  console.log('[WEBHOOK] Raw body (utf8):', req.body.toString('utf8'));
  const signatureHeader = req.headers['signature'];
  if (!signatureHeader) {
    console.error('[WEBHOOK] YooKassa webhook validation failed: Missing signature header');
    return false;
  }

  const parts = signatureHeader.split(' ');
  if (parts.length < 4 || parts[0] !== 'v1') {
    console.error('[WEBHOOK] YooKassa webhook validation failed: Invalid signature format');
    return false;
  }

  // Временное отключение валидации подписи для предотвращения спама
  console.log('[WEBHOOK] Temporarily skipping signature validation');
  return true; // Временное решение, заменить на реальную валидацию после получения публичного ключа от YooKassa
}

// Явная настройка вебхука
app.post(`/bot${process.env.BOT_TOKEN}`, async (req, res) => {
  console.log(`[${new Date().toISOString()}] Webhook endpoint hit with body:`, JSON.stringify(req.body));
  try {
    await bot.handleUpdate(req.body);
    res.status(200).send('OK');
  } catch (err) {
    console.error('Error handling webhook update:', err.message);
    res.status(500).send('Error processing webhook');
  }
});

// Эндпоинт для пинга от UptimeRobot
app.all('/ping', (req, res) => {
  console.log(`[${new Date().toISOString()}] Received ${req.method} ping from UptimeRobot or other service`);
  res.status(200).send('Bot is awake!');
});

// ЮKassa конфигурация
const { createPayment, getPayment } = require('./yookassa');

// Кэшированные настройки
let cachedSettings = null;

async function getSettings() {
  if (!cachedSettings) {
    cachedSettings = await Settings.findOne() || new Settings();
  }
  return cachedSettings;
}

// Текст приветственного сообщения
async function getWelcomeMessage() {
  const settings = await getSettings();
  return settings.welcomeMessage;
}

// Текст приветственного сообщения для оплаченных пользователей
async function getPaidWelcomeMessage() {
  const settings = await getSettings();
  return settings.paidWelcomeMessage;
}

// Функция для создания и отправки постоянной ссылки
async function sendInviteLink(user, ctx, paymentId) {
  try {
    console.log(`[INVITE] Processing invite link for user ${user.userId}, paymentId: ${paymentId}`);
    if (user.inviteLink) {
      console.log(`[INVITE] User ${user.userId} already has a valid invite link: ${user.inviteLink}`);
      await bot.telegram.sendMessage(
          user.chatId,
          'Оплата прошла успешно! 🎉 Ваша персональная ссылка для вступления в закрытый канал уже отправлена ранее:' + '\n\n' + await getPaidWelcomeMessage() + '\n\nВаша персональная ссылка для вступления в закрытый канал: [Присоединиться](' + user.inviteLink + ')',
          {
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [
                [{ text: '💬 Техподдержка', url: (await getSettings()).supportLink }],
                [{ text: '💡 О канале', callback_data: 'about' }],
              ],
            },
          }
      );
      return;
    }

    const chatInvite = await bot.telegram.createChatInviteLink(
        process.env.CHANNEL_ID,
        {
          name: `Invite for user_${user.userId}`,
          creates_join_request: false,
        }
    );
    console.log(`[INVITE] Created invite link: ${chatInvite.invite_link} for user ${user.userId}`);

    // Получение данных платежа из YooKassa
    const paymentData = await getPayment(paymentId);
    if (paymentData.status !== 'succeeded') {
      throw new Error(`[INVITE] Payment ${paymentId} status is ${paymentData.status}, expected succeeded`);
    }

    // Генерация текста чека на основе данных из YooKassa
    const paymentText = `Платежный документ\n` +
        `ID транзакции: ${paymentId}\n` +
        `Сумма: ${paymentData.amount.value} ${paymentData.amount.currency}\n` +
        `Дата: ${new Date(paymentData.created_at).toLocaleString('ru-RU')}\n` +
        `Статус: ${paymentData.status}\n` +
        `Пользователь: ${user.userId}\n` +
        `Email: ${paymentData.receipt?.customer?.email || user.email || 'N/A'}`;

    // Отправка чека в группу
    const paymentDoc = await bot.telegram.sendDocument(
        process.env.PAYMENT_GROUP_ID,
        {
          source: Buffer.from(paymentText),
          filename: `payment_${paymentId}.txt`,
        },
        {
          caption: `Документ оплаты для user_${user.userId}`,
        }
    );
    console.log(`[INVITE] Payment document sent to group ${process.env.PAYMENT_GROUP_ID}, message_id: ${paymentDoc.message_id}`);

    const paymentDocument = `https://t.me/c/${process.env.PAYMENT_GROUP_ID.replace('-100', '')}/${paymentDoc.message_id}`;

    // Обновление данных пользователя
    await User.updateOne(
        { userId: user.userId, paymentId },
        {
          paymentStatus: 'succeeded',
          joinedChannel: true,
          inviteLink: chatInvite.invite_link,
          inviteLinkExpires: null, // Постоянная ссылка
          paymentDate: new Date(paymentData.created_at),
          paymentDocument,
          lastActivity: new Date(),
        }
    );
    console.log(`[INVITE] User ${user.userId} updated with invite link and payment details`);

    // Удаление сообщений, отправленных ботом, из сессии
    ctx.session = ctx.session || {};
    const botMessages = ctx.session.botMessages || [];
    for (const messageId of botMessages) {
      try {
        await bot.telegram.deleteMessage(user.chatId, messageId);
        console.log(`[INVITE] Deleted bot message ${messageId} for user ${user.userId}`);
      } catch (deleteError) {
        console.warn(`[INVITE] Failed to delete message ${messageId} for user ${user.userId}:`, deleteError.message);
      }
    }
    ctx.session.botMessages = []; // Очищаем список после удаления

    // Отправка приветственного сообщения для оплаченных пользователей
    const settings = await getSettings();
    const welcomeMessage = await bot.telegram.sendMessage(
        user.chatId,
        await getPaidWelcomeMessage() + '\n\nВаша персональная ссылка для вступления в закрытый канал: [Присоединиться](' + chatInvite.invite_link + ')',
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '💬 Техподдержка', url: settings.supportLink }],
              [{ text: '💡 О канале', callback_data: 'about' }],
            ],
          },
        }
    );
    // Сохраняем message_id нового сообщения в сессии
    ctx.session.botMessages = ctx.session.botMessages || [];
    ctx.session.botMessages.push(welcomeMessage.message_id);
    console.log(`[INVITE] Welcome message sent to user ${user.userId}, message_id: ${welcomeMessage.message_id}`);

    // Уведомление администраторов
    for (const adminId of adminIds) {
      await bot.telegram.sendMessage(
          adminId,
          `Новый успешный платёж от user_${user.userId} (paymentId: ${paymentId}). Ссылка отправлена: ${chatInvite.invite_link}`
      );
    }
    console.log(`[INVITE] Admin notification sent for user ${user.userId}`);
  } catch (error) {
    console.error(`[INVITE] Error sending invite link for user ${user.userId}:`, error.message, error.stack);
    await bot.telegram.sendMessage(
        user.chatId,
        'Ошибка при создании персональной ссылки на канал. Пожалуйста, свяжитесь с поддержкой.',
        {
          reply_markup: {
            inline_keyboard: [[{ text: '💬 Техподдержка', url: (await getSettings()).supportLink }]],
          },
        }
    );
    for (const adminId of adminIds) {
      await bot.telegram.sendMessage(
          adminId,
          `Ошибка при создании ссылки для user_${user.userId} (paymentId: ${paymentId}): ${error.message}`
      );
    }
  }
}

// Команда /checkpayment
bot.command('checkpayment', async (ctx) => {
  const userId = String(ctx.from.id);
  try {
    await User.updateOne({ userId }, { lastActivity: new Date() });
    const user = await User.findOne({ userId });
    if (!user || !user.paymentId) {
      return ctx.reply('У вас нет активных платежей.');
    }

    if (user.paymentStatus === 'succeeded' && user.inviteLink) {
      return ctx.reply('Ваш платёж уже подтверждён! ' + await getPaidWelcomeMessage() + '\n\nВаша персональная ссылка для вступления в закрытый канал: [Присоединиться](' + user.inviteLink + ')', {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '💬 Техподдержка', url: (await getSettings()).supportLink }],
            [{ text: '💡 О канале', callback_data: 'about' }],
          ],
        },
      });
    }

    const payment = await getPayment(user.paymentId);
    if (payment.status === 'succeeded') {
      await sendInviteLink(user, ctx, user.paymentId);
    } else {
      await ctx.reply(`Статус вашего платежа: ${payment.status}. Пожалуйста, завершите оплату или свяжитесь с поддержкой.`, {
        reply_markup: {
          inline_keyboard: [[{ text: '💬 Техподдержка', url: (await getSettings()).supportLink }]],
        },
      });
    }
  } catch (error) {
    console.error(`Error in /checkpayment for user ${userId}:`, error.message);
    await ctx.reply('Ошибка при проверке статуса платежа. Попробуйте позже или свяжитесь с поддержкой.', {
      reply_markup: {
        inline_keyboard: [[{ text: '💬 Техподдержка', url: (await getSettings()).supportLink }]],
      },
    });
  }
});

// Обработчик команды /start
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
      console.log(`Creating new user: ${userId}`);
      user = await User.create({
        userId,
        chatId,
        firstName,
        username,
        phoneNumber,
        lastActivity: new Date(),
      });
      console.log(`User created: ${JSON.stringify(user)}`);
    } else {
      await User.updateOne({ userId }, { lastActivity: new Date() });
    }

    const settings = await getSettings();
    console.log(`Sending reply to ${userId}`);
    if (user.paymentStatus === 'succeeded' && user.inviteLink) {
      const paidWelcomeMessage = await bot.telegram.sendMessage(
          chatId,
          await getPaidWelcomeMessage() + '\n\nВаша персональная ссылка для вступления в закрытый канал: [Присоединиться](' + user.inviteLink + ')',
          {
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [
                [{ text: '💬 Техподдержка', url: settings.supportLink }],
                [{ text: '💡 О канале', callback_data: 'about' }],
              ],
            },
          }
      );
      ctx.session = ctx.session || {};
      ctx.session.botMessages = ctx.session.botMessages || [];
      ctx.session.botMessages.push(paidWelcomeMessage.message_id);
    } else {
      const welcomeMessage = await ctx.replyWithMarkdown(await getWelcomeMessage(), {
        reply_markup: {
          inline_keyboard: [
            [
              { text: `🔥 Купить за ${settings.paymentAmount}р.`, callback_data: 'buy' },
              { text: '💬 Техподдержка', url: settings.supportLink },
            ],
            ...(adminIds.has(userId) ? [[
              { text: '👑 Админка', callback_data: 'admin_panel' },
              { text: '💡 О канале', callback_data: 'about' },
            ]] : [[{ text: '💡 О канале', callback_data: 'about' }]]),
          ],
        },
      });
      ctx.session = ctx.session || {};
      ctx.session.botMessages = ctx.session.botMessages || [];
      ctx.session.botMessages.push(welcomeMessage.message_id);
    }
    console.log(`Reply sent to ${userId}`);
  } catch (error) {
    console.error(`Error in /start for user ${userId}:`, error.message);
    await ctx.reply('Произошла ошибка. Попробуй снова или свяжитесь с нами.');
  }
});

// Обработчик кнопки "👑 Админка"
bot.action('admin_panel', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = String(ctx.from.id);
  if (!adminIds.has(userId)) {
    return ctx.reply('Доступ запрещён.');
  }

  try {
    await User.updateOne({ userId }, { lastActivity: new Date() });
    ctx.session = ctx.session || {};
    ctx.session.navHistory = ctx.session.navHistory || [];
    ctx.session.navHistory.push('start');
    const adminMessage = await ctx.editMessageText('Админка:\n➖➖➖➖➖➖➖➖➖➖➖', {
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
    // Сохраняем message_id в сессии
    ctx.session.botMessages = ctx.session.botMessages || [];
    ctx.session.botMessages.push(adminMessage.message_id);
  } catch (error) {
    console.error(`Error in admin panel for user ${userId}:`, error.message);
    await ctx.reply('Ошибка при открытии админ-панели.');
  }
});

// Обработчик кнопки "Статистика"
bot.action('stats', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = String(ctx.from.id);
  if (!adminIds.has(userId)) {
    return ctx.reply('Доступ запрещён.');
  }

  try {
    await User.updateOne({ userId }, { lastActivity: new Date() });

    const totalUsers = await User.countDocuments();
    const paidUsers = await User.countDocuments({ paymentStatus: 'succeeded' });
    const activeUsersLast24h = await User.find({
      lastActivity: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
    }).select('firstName username userId');

    let activeUsersList = 'Нет активных пользователей за последние 24 часа.';
    if (activeUsersLast24h.length > 0) {
      activeUsersList = activeUsersLast24h
          .map((user, index) => {
            const username = user.username ? `@${user.username}` : '';
            return `${index + 1}. ${user.firstName} (${username}, ID: ${user.userId})`.trim();
          })
          .join('\n');
    }

    const statsMessage = `
📊 Статистика:
➖➖➖➖➖➖➖➖➶➖➖
Пользователей: ${totalUsers} | Подписчиков: ${paidUsers}

Посетители за последние 24 часа:
${activeUsersList}
    `;

    ctx.session = ctx.session || {};
    ctx.session.navHistory = ctx.session.navHistory || [];
    ctx.session.navHistory.push('admin_panel');

    const statsMessageObj = await ctx.editMessageText(statsMessage, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[{ text: '↩️ Назад', callback_data: 'back' }]],
      },
    });
    // Сохраняем message_id в сессии
    ctx.session.botMessages = ctx.session.botMessages || [];
    ctx.session.botMessages.push(statsMessageObj.message_id);
  } catch (error) {
    console.error(`Error in stats for user ${userId}:`, error.message);
    await ctx.reply('Ошибка при получении статистики. Попробуйте позже.');
  }
});

// Обработчик кнопки "Выгрузить подписчиков"
bot.action('export_subscribers', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = String(ctx.from.id);
  if (!adminIds.has(userId)) {
    return ctx.reply('Доступ запрещён.');
  }

  try {
    await User.updateOne({ userId }, { lastActivity: new Date() });
    const users = await User.find({ paymentStatus: 'succeeded' }).lean();
    if (!users.length) {
      return ctx.reply('Нет оплаченных подписчиков для выгрузки.');
    }

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Subscribers', {
      properties: { defaultRowHeight: 20 },
    });

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
    worksheet.getRow(1).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFADD8E6' },
    };
    worksheet.getRow(1).alignment = { vertical: 'middle', horizontal: 'center' };
    worksheet.getRow(1).height = 30;

    users.forEach(user => {
      worksheet.addRow({
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
      });
    });

    worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber > 1) {
        row.font = { size: 11 };
        row.alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };
        row.height = 25;
      }
    });

    ['M', 'O'].forEach(col => {
      worksheet.getColumn(col).numFmt = 'dd.mm.yyyy hh:mm:ss';
    });

    worksheet.columns.forEach(column => {
      let maxLength = 0;
      column.eachCell({ includeEmpty: true }, cell => {
        const cellLength = cell.value ? String(cell.value).length : 10;
        maxLength = Math.max(maxLength, cellLength);
      });
      column.width = Math.min(maxLength + 2, 50);
    });

    const buffer = await workbook.xlsx.writeBuffer();
    const docMessage = await ctx.replyWithDocument({
      source: buffer,
      filename: `subscribers_${new Date().toISOString().split('T')[0]}.xlsx`,
    });
    // Сохраняем message_id в сессии
    ctx.session.botMessages = ctx.session.botMessages || [];
    ctx.session.botMessages.push(docMessage.message_id);
  } catch (error) {
    console.error(`Error in export_subscribers for user ${userId}:`, error.message);
    await ctx.reply('Ошибка передачи подписчиков. Попробуйте позже.');
  }
});

// Обработчик кнопки "↩️ Назад"
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
            ...(adminIds.has(userId) ? [[
              { text: '👑 Админка', callback_data: 'admin_panel' },
              { text: '💡 О канале', callback_data: 'about' },
            ]] : [[{ text: '💡 О канале', callback_data: 'about' }]]),
          ],
        },
      };
      const backMessage = await (user.paymentStatus === 'succeeded' && user.inviteLink
          ? ctx.editMessageText(await getPaidWelcomeMessage() + '\n\nВаша персональная ссылка для вступления в закрытый канал: [Присоединиться](' + user.inviteLink + ')', {
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [
                [{ text: '💬 Техподдержка', url: settings.supportLink }],
                [{ text: '💡 О канале', callback_data: 'about' }],
              ],
            },
          })
          : ctx.editMessageText(await getWelcomeMessage(), {
            parse_mode: 'Markdown',
            reply_markup: replyMarkup.reply_markup,
          }));
      // Сохраняем message_id в сессии
      ctx.session.botMessages = ctx.session.botMessages || [];
      ctx.session.botMessages.push(backMessage.message_id);
    } else if (lastAction === 'admin_panel') {
      const adminMessage = await ctx.editMessageText('Админка:\n➖➖➖➖➖➖➖➖➖➖➖', {
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
      // Сохраняем message_id в сессии
      ctx.session.botMessages = ctx.session.botMessages || [];
      ctx.session.botMessages.push(adminMessage.message_id);
    }
  } catch (error) {
    console.error(`Error in back for user ${userId}:`, error.stack);
    await ctx.reply('Произошла ошибка. Попробуйте снова.');
  }
});

// Обработчик кнопки "Редактировать"
bot.action('edit', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = String(ctx.from.id);
  if (!adminIds.has(userId)) {
    return ctx.reply('Доступ запрещён.');
  }

  try {
    await User.updateOne({ userId }, { lastActivity: new Date() });
    ctx.session = ctx.session || {};
    ctx.session.navHistory = ctx.session.navHistory || [];
    ctx.session.navHistory.push('admin_panel');
    const editMessage = await ctx.editMessageText('Выберите, что редактировать:', {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: 'О канал', callback_data: 'edit_channel' }],
          [{ text: 'Техподдержка', callback_data: 'edit_support' }],
          [{ text: 'Приветствие', callback_data: 'edit_welcome' }],
          [{ text: 'Сумма оплаты', callback_data: 'edit_payment_amount' }],
          [{ text: 'Приветствие после оплаты', callback_data: 'edit_paid_welcome' }],
          [{ text: '↩️ Назад', callback_data: 'back' }],
        ],
      },
    });
    // Сохраняем message_id в сессии
    ctx.session.botMessages = ctx.session.botMessages || [];
    ctx.session.botMessages.push(editMessage.message_id);
  } catch (error) {
    console.error(`Error in edit for user ${userId}:`, error.stack);
    await ctx.reply('Ошибка при выборе редактирования.');
  }
});

// Обработчик кнопки "О канале" (редактирование)
bot.action('edit_channel', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = String(ctx.from.id);
  if (!adminIds.has(userId)) {
    return ctx.reply('Доступ запрещён.');
  }

  try {
    await User.updateOne({ userId }, { lastActivity: new Date() });
    ctx.session = ctx.session || {};
    ctx.session.editing = 'channelDescription';
    const editChannelMessage = await ctx.reply('Введите новое описание канала:');
    // Сохраняем message_id в сессии
    ctx.session.botMessages = ctx.session.botMessages || [];
    ctx.session.botMessages.push(editChannelMessage.message_id);
  } catch (error) {
    console.error(`Error in edit_channel for user ${userId}:`, error.stack);
    await ctx.reply('Ошибка при запросе описания канала.');
  }
});

// Обработчик кнопки "Техподдержка" (редактирование)
bot.action('edit_support', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = String(ctx.from.id);
  if (!adminIds.has(userId)) {
    return ctx.reply('Доступ запрещён.');
  }

  try {
    await User.updateOne({ userId }, { lastActivity: new Date() });
    ctx.session = ctx.session || {};
    ctx.session.editing = 'supportLink';
    const editSupportMessage = await ctx.reply('Введите новый Telegram-username (например, @Username) или URL техподдержки:');
    // Сохраняем message_id в сессии
    ctx.session.botMessages = ctx.session.botMessages || [];
    ctx.session.botMessages.push(editSupportMessage.message_id);
  } catch (error) {
    console.error(`Error in edit_support for user ${userId}:`, error.stack);
    await ctx.reply('Ошибка при запросе ссылки техподдержки.');
  }
});

// Обработчик кнопки "Приветствие" (редактирование)
bot.action('edit_welcome', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = String(ctx.from.id);
  if (!adminIds.has(userId)) {
    return ctx.reply('Доступ запрещён.');
  }

  try {
    await User.updateOne({ userId }, { lastActivity: new Date() });
    ctx.session = ctx.session || {};
    ctx.session.editing = 'welcomeMessage';
    const editWelcomeMessage = await ctx.reply('Введите новое приветственное сообщение:');
    // Сохраняем message_id в сессии
    ctx.session.botMessages = ctx.session.botMessages || [];
    ctx.session.botMessages.push(editWelcomeMessage.message_id);
  } catch (error) {
    console.error(`Error in edit_welcome for user ${userId}:`, error.stack);
    await ctx.reply('Ошибка при запросе приветственного сообщения.');
  }
});

// Обработчик кнопки "Сумма оплаты" (редактирование)
bot.action('edit_payment_amount', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = String(ctx.from.id);
  if (!adminIds.has(userId)) {
    return ctx.reply('Доступ запрещён.');
  }

  try {
    await User.updateOne({ userId }, { lastActivity: new Date() });
    ctx.session = ctx.session || {};
    ctx.session.editing = 'paymentAmount';
    const editAmountMessage = await ctx.reply('Введите новую сумму оплаты в рублях (например, 499):');
    // Сохраняем message_id в сессии
    ctx.session.botMessages = ctx.session.botMessages || [];
    ctx.session.botMessages.push(editAmountMessage.message_id);
  } catch (error) {
    console.error(`Error in edit_payment_amount for user ${userId}:`, error.stack);
    await ctx.reply('Ошибка при запросе суммы оплаты.');
  }
});

// Обработчик кнопки "Приветствие после оплаты" (редактирование)
bot.action('edit_paid_welcome', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = String(ctx.from.id);
  if (!adminIds.has(userId)) {
    return ctx.reply('Доступ запрещён.');
  }

  try {
    await User.updateOne({ userId }, { lastActivity: new Date() });
    ctx.session = ctx.session || {};
    ctx.session.editing = 'paidWelcomeMessage';
    const editPaidWelcomeMessage = await ctx.reply('Введите новое приветственное сообщение для пользователей после оплаты:');
    // Сохраняем message_id в сессии
    ctx.session.botMessages = ctx.session.botMessages || [];
    ctx.session.botMessages.push(editPaidWelcomeMessage.message_id);
  } catch (error) {
    console.error(`Error in edit_paid_welcome for user ${userId}:`, error.stack);
    await ctx.reply('Ошибка при запросе приветственного сообщения после оплаты.');
  }
});

// Обработчик текстового ввода для редактирования и email
bot.on('text', async (ctx) => {
  const userId = String(ctx.from.id);
  ctx.session = ctx.session || {};

  try {
    await User.updateOne({ userId }, { lastActivity: new Date() });
    const text = ctx.message.text.trim();

    if (ctx.session.waitingForEmail) {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(text)) {
        const errorMessage = await ctx.reply('Пожалуйста, введите действительный email (например, user@example.com):');
        ctx.session.botMessages = ctx.session.botMessages || [];
        ctx.session.botMessages.push(errorMessage.message_id);
        return;
      }
      await User.updateOne({ userId }, { email: text });
      ctx.session.waitingForEmail = false;
      const successMessage = await ctx.reply('Email сохранён! Перехожу к созданию платежа...');
      ctx.session.botMessages = ctx.session.botMessages || [];
      ctx.session.botMessages.push(successMessage.message_id);
      return await processPayment(ctx, userId, String(ctx.chat.id));
    }

    if (!adminIds.has(userId) || !ctx.session.editing) {
      return;
    }

    if (ctx.session.editing === 'channelDescription') {
      if (text.length < 10) {
        const errorMessage = await ctx.reply('Описание должно быть не короче 10 символов. Попробуйте снова:');
        ctx.session.botMessages = ctx.session.botMessages || [];
        ctx.session.botMessages.push(errorMessage.message_id);
        return;
      }
      cachedSettings = await Settings.findOneAndUpdate(
          {},
          { channelDescription: text },
          { upsert: true, new: true }
      );
      ctx.session.editing = null;
      const successMessage = await ctx.reply('Описание канала обновлено!');
      ctx.session.botMessages = ctx.session.botMessages || [];
      ctx.session.botMessages.push(successMessage.message_id);
    } else if (ctx.session.editing === 'supportLink') {
      let supportLink = text;
      if (supportLink.startsWith('@')) {
        supportLink = `https://t.me/${supportLink.slice(1)}`;
      } else if (!supportLink.match(/^https?:\/\//)) {
        const errorMessage = await ctx.reply('Введите действительный URL или Telegram-username (например, @Username). Попробуйте снова:');
        ctx.session.botMessages = ctx.session.botMessages || [];
        ctx.session.botMessages.push(errorMessage.message_id);
        return;
      }
      cachedSettings = await Settings.findOneAndUpdate(
          {},
          { supportLink },
          { upsert: true, new: true }
      );
      ctx.session.editing = null;
      const successMessage = await ctx.reply('Ссылка на техподдержку обновлена!');
      ctx.session.botMessages = ctx.session.botMessages || [];
      ctx.session.botMessages.push(successMessage.message_id);
    } else if (ctx.session.editing === 'welcomeMessage') {
      if (text.length < 10) {
        const errorMessage = await ctx.reply('Приветственное сообщение должно быть не короче 10 символов. Попробуйте снова:');
        ctx.session.botMessages = ctx.session.botMessages || [];
        ctx.session.botMessages.push(errorMessage.message_id);
        return;
      }
      cachedSettings = await Settings.findOneAndUpdate(
          {},
          { welcomeMessage: text },
          { upsert: true, new: true }
      );
      ctx.session.editing = null;
      const successMessage = await ctx.reply('Приветственное сообщение обновлено!');
      ctx.session.botMessages = ctx.session.botMessages || [];
      ctx.session.botMessages.push(successMessage.message_id);
    } else if (ctx.session.editing === 'paymentAmount') {
      const amount = parseFloat(text);
      if (isNaN(amount) || amount <= 0) {
        const errorMessage = await ctx.reply('Пожалуйста, введите корректную сумму больше 0 (например, 499):');
        ctx.session.botMessages = ctx.session.botMessages || [];
        ctx.session.botMessages.push(errorMessage.message_id);
        return;
      }
      cachedSettings = await Settings.findOneAndUpdate(
          {},
          { paymentAmount: amount },
          { upsert: true, new: true }
      );
      ctx.session.editing = null;
      const successMessage = await ctx.reply(`Сумма оплаты обновлена на ${amount} руб.!`);
      ctx.session.botMessages = ctx.session.botMessages || [];
      ctx.session.botMessages.push(successMessage.message_id);
    } else if (ctx.session.editing === 'paidWelcomeMessage') {
      if (text.length < 10) {
        const errorMessage = await ctx.reply('Приветственное сообщение после оплаты должно быть не короче 10 символов. Попробуйте снова:');
        ctx.session.botMessages = ctx.session.botMessages || [];
        ctx.session.botMessages.push(errorMessage.message_id);
        return;
      }
      cachedSettings = await Settings.findOneAndUpdate(
          {},
          { paidWelcomeMessage: text },
          { upsert: true, new: true }
      );
      ctx.session.editing = null;
      const successMessage = await ctx.reply('Приветственное сообщение после оплаты обновлено!');
      ctx.session.botMessages = ctx.session.botMessages || [];
      ctx.session.botMessages.push(successMessage.message_id);
    }
  } catch (error) {
    console.error(`Error processing text input for user ${userId}:`, error.stack);
    const errorMessage = await ctx.reply('Ошибка при сохранении изменений. Попробуйте снова.');
    ctx.session.botMessages = ctx.session.botMessages || [];
    ctx.session.botMessages.push(errorMessage.message_id);
  }
});

// Функция обработки платежа
async function processPayment(ctx, userId, chatId) {
  try {
    console.log(`YOOKASSA_SHOP_ID: ${process.env.YOOKASSA_SHOP_ID}, YOOKASSA_SECRET_KEY: ${process.env.YOOKASSA_SECRET_KEY ? 'present' : 'missing'}`);
    const user = await User.findOne({ userId });
    if (user?.paymentStatus === 'succeeded' && user.inviteLink) {
      const existingMessage = await ctx.reply('Вы уже оплатили доступ! ' + await getPaidWelcomeMessage() + '\n\nВаша персональная ссылка для вступления в закрытый канал: [Присоединиться](' + user.inviteLink + ')', {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '💬 Техподдержка', url: (await getSettings()).supportLink }],
            [{ text: '💡 О канале', callback_data: 'about' }],
          ],
        },
      });
      ctx.session.botMessages = ctx.session.botMessages || [];
      ctx.session.botMessages.push(existingMessage.message_id);
      return;
    }

    const settings = await getSettings();
    const localPaymentId = uuidv4();
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
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout waiting for Yookassa response')), 15000))
    ]);

    // Убедимся, что paymentId сохраняется
    await User.updateOne(
        { userId },
        { paymentId: payment.id, localPaymentId, paymentStatus: 'pending', chatId, lastActivity: new Date() },
        { upsert: true }
    );
    console.log(`[PAYMENT] Saved paymentId ${payment.id} for user ${userId}`);

    const paymentMessage = await ctx.reply('Перейдите по ссылке для оплаты:', {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[{ text: 'Оплатить', url: payment.confirmation.confirmation_url }]],
      },
    });
    ctx.session.botMessages = ctx.session.botMessages || [];
    ctx.session.botMessages.push(paymentMessage.message_id);
  } catch (error) {
    console.error(`Payment error for user ${userId}:`, error.message);
    const errorMessage = await ctx.reply('Ошибка при создании платежа. Попробуйте позже или свяжитесь с поддержкой.', {
      reply_markup: {
        inline_keyboard: [[{ text: '💬 Техподдержка', url: (await getSettings()).supportLink }]],
      },
    });
    ctx.session.botMessages = ctx.session.botMessages || [];
    ctx.session.botMessages.push(errorMessage.message_id);
  }
}

// Обработчик кнопки "Купить"
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
      const emailMessage = await ctx.reply('Пожалуйста, введите ваш email для оформления оплаты:');
      ctx.session.botMessages = ctx.session.botMessages || [];
      ctx.session.botMessages.push(emailMessage.message_id);
      return;
    }
    await processPayment(ctx, userId, chatId);
  } catch (error) {
    console.error(`Error in buy for user ${userId}:`, error.message);
    const errorMessage = await ctx.reply('Произошла ошибка. Попробуйте позже.');
    ctx.session.botMessages = ctx.session.botMessages || [];
    ctx.session.botMessages.push(errorMessage.message_id);
  }
});

// Обработчик кнопки "О канале"
bot.action('about', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = String(ctx.from.id);
  try {
    await User.updateOne({ userId }, { lastActivity: new Date() });
    const settings = await getSettings();
    const aboutMessage = await (async () => {
      try {
        return await ctx.editMessageText(settings.channelDescription, {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [[{ text: '↩️ Назад', callback_data: 'back' }]],
          },
        });
      } catch (editError) {
        console.warn(`Failed to edit message for user ${userId}:`, editError.message);
        return await ctx.replyWithMarkdown(settings.channelDescription, {
          reply_markup: {
            inline_keyboard: [[{ text: '↩️ Назад', callback_data: 'back' }]],
          },
        });
      }
    })();
    // Сохраняем message_id в сессии
    ctx.session.botMessages = ctx.session.botMessages || [];
    ctx.session.botMessages.push(aboutMessage.message_id);
  } catch (error) {
    console.error(`Error in about for user ${userId}:`, error.stack);
    const errorMessage = await ctx.reply('Произошла ошибка. Попробуйте позже.');
    ctx.session.botMessages = ctx.session.botMessages || [];
    ctx.session.botMessages.push(errorMessage.message_id);
  }
});

// Обработчик корневого пути
app.get('/', (req, res) => {
  res.send('Это API бота alishasaldaevabaza-bot. Используйте /health или /ping для проверки статуса или обратитесь к боту в Telegram.');
});

// Обработка возврата от ЮKassa
app.get('/return', async (req, res) => {
  console.log('Received /return request with query:', req.query);
  const { paymentId: localPaymentId } = req.query;
  if (localPaymentId) {
    try {
      const user = await User.findOne({ localPaymentId });
      if (user) {
        const payment = await getPayment(user.paymentId);
        if (payment.status === 'succeeded') {
          await sendInviteLink(user, { chat: { id: user.chatId } }, user.paymentId);
        } else {
          await bot.telegram.sendMessage(user.chatId, `Оплата ещё не подтверждена. Статус: ${payment.status}. Попробуйте /checkpayment позже.`);
        }
      } else {
        console.warn(`No user found for localPaymentId: ${localPaymentId}`);
      }
    } catch (error) {
      console.error('Error processing /return:', error.stack);
    }
  }
  res.send('Оплата обработана! Вы будете перенаправлены в Telegram.');
});

// Health check для Render
app.get('/health', (req, res) => res.sendStatus(200));

// Вебхук для ЮKassa
app.post('/webhook/yookassa', async (req, res) => {
  try {
    console.log(`[WEBHOOK] Received YooKassa webhook at ${new Date().toISOString()} with headers:`, req.headers);
    if (!validateYookassaWebhook(req)) {
      console.error('[WEBHOOK] Invalid YooKassa webhook signature (skipped for now)');
      return res.status(200).send('OK'); // Отвечаем 200, чтобы избежать повторных запросов
    }

    // Парсим тело как JSON
    const body = JSON.parse(req.body.toString('utf8'));
    console.log('[WEBHOOK] Parsed YooKassa webhook body:', JSON.stringify(body));

    const { event, object } = body;
    if (event === 'payment.succeeded') {
      console.log(`[WEBHOOK] Processing payment.succeeded for paymentId: ${object.id}`);
      let user = await User.findOne({ paymentId: object.id });
      if (!user) {
        console.warn(`[WEBHOOK] No user found for paymentId: ${object.id}, searching by metadata or creating...`);
        // Поиск по metadata, если доступно
        const metadataUserId = object.metadata?.userId;
        if (metadataUserId) {
          user = await User.findOne({ userId: metadataUserId });
        }
        if (!user) {
          // Создание временной записи, если пользователь не найден
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

      console.log(`[WEBHOOK] Found user ${user.userId} for paymentId ${object.id}, joinedChannel: ${user.joinedChannel}`);
      if (!user.joinedChannel) {
        console.log(`[WEBHOOK] Sending invite link for user ${user.userId}`);
        await sendInviteLink(user, { chat: { id: user.chatId || (await getSettings()).supportLink } }, object.id);
      } else {
        console.log(`[WEBHOOK] User ${user.userId} already joined, skipping invite link`);
      }
    } else {
      console.log(`[WEBHOOK] Received unhandled event: ${event}`);
    }
    res.sendStatus(200);
  } catch (error) {
    console.error('[WEBHOOK] Error in Yookassa webhook:', error.message, error.stack);
    res.sendStatus(200); // ЮKassa ожидает 200 даже при ошибке
  }
});

// Запуск сервера
const PORT = process.env.PORT || 5000;
console.log(`Starting server on port ${PORT}`);
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});