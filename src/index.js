const { Telegraf, session: telegrafSession } = require('telegraf');
const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');
const express = require('express');
const ExcelJS = require('exceljs');
require('dotenv').config();

const app = express();
app.use(express.json());

// Логирование всех запросов
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] Received ${req.method} request at ${req.path}`);
  console.log('Request body:', JSON.stringify(req.body));
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
      bot.use(telegrafSession());
    });

// Инициализация бота
const bot = new Telegraf(process.env.BOT_TOKEN);
bot.catch((err, ctx) => {
  console.error('Telegraf global error for update', ctx.update, ':', err.message);
  if (ctx) ctx.reply('Произошла ошибка. Попробуйте позже.');
});

// Используем in-memory сессии временно
bot.use(telegrafSession());

// Схема пользователя
const UserSchema = new mongoose.Schema({
  userId: String,
  chatId: String,
  paymentStatus: { type: String, default: 'pending' },
  paymentId: String,
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
});

const Settings = mongoose.model('Settings', SettingsSchema);

// Определение администраторов
const adminIds = new Set((process.env.ADMIN_CHAT_IDS || '').split(',').map(id => id.trim()));
console.log('Parsed adminIds:', [...adminIds]);

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

// Функция для создания и отправки одноразовой ссылки
async function sendInviteLink(user, ctx, paymentId) {
  try {
    if (user.inviteLink) {
      console.log(`User ${user.userId} already has a valid invite link: ${user.inviteLink}`);
      await bot.telegram.sendMessage(
          user.chatId,
          'Оплата прошла успешно! 🎉 Ваша одноразовая ссылка для вступления в закрытый канал уже отправлена ранее:',
          {
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [[{ text: 'Присоединиться', url: user.inviteLink }]],
            },
          }
      );
      return;
    }

    const chatInvite = await bot.telegram.createChatInviteLink(
        process.env.CHANNEL_ID,
        {
          name: `Invite for user_${user.userId}`,
          member_limit: 1,
          creates_join_request: false,
        }
    );

    const paymentText = `Платежный документ\n` +
        `ID транзакции: ${paymentId}\n` +
        `Сумма: 399.00 RUB\n` +
        `Дата: ${new Date().toLocaleString('ru-RU')}\n` +
        `Статус: succeeded\n` +
        `Пользователь: ${user.userId}`;
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
    const paymentDocument = `https://t.me/c/${process.env.PAYMENT_GROUP_ID.replace('-100', '')}/${paymentDoc.message_id}`;

    await User.updateOne(
        { userId: user.userId, paymentId },
        {
          paymentStatus: 'succeeded',
          joinedChannel: true,
          inviteLink: chatInvite.invite_link,
          inviteLinkExpires: null,
          paymentDate: new Date(),
          paymentDocument,
          lastActivity: new Date(),
        }
    );

    await bot.telegram.sendMessage(
        user.chatId,
        'Оплата прошла успешно! 🎉 Вот ваша одноразовая ссылка для вступления в закрытый канал:',
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [[{ text: 'Присоединиться', url: chatInvite.invite_link }]],
          },
        }
    );

    for (const adminId of adminIds) {
      await bot.telegram.sendMessage(
          adminId,
          `Новый успешный платёж от user_${user.userId} (paymentId: ${paymentId}). Ссылка отправлена: ${chatInvite.invite_link}`
      );
    }
  } catch (error) {
    console.error(`Error sending invite link for user ${user.userId}:`, error.message);
    await bot.telegram.sendMessage(
        user.chatId,
        'Ошибка при создании одноразовой ссылки на канал. Пожалуйста, свяжитесь с поддержкой.',
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
      return ctx.reply('Ваш платёж уже подтверждён! Вот ваша одноразовая ссылка:', {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[{ text: 'Присоединиться', url: user.inviteLink }]],
        },
      });
    }

    const payment = await getPayment(user.paymentId);
    if (payment.status === 'succeeded') {
      await sendInviteLink(user, ctx, payment.id);
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
    ctx.session = ctx.session || {};
    ctx.session.navHistory = ctx.session.navHistory || [];
    const replyMarkup = {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '🔥 Купить за 399р.', callback_data: 'buy' },
            { text: '💬 Техподдержка', url: settings.supportLink },
          ],
          ...(adminIds.has(userId) ? [[
            { text: '👑 Админка', callback_data: 'admin_panel' },
            { text: '💡 О канале', callback_data: 'about' },
          ]] : [[{ text: '💡 О канале', callback_data: 'about' }]]),
        ],
      },
    };
    await ctx.replyWithMarkdown(await getWelcomeMessage(), replyMarkup);
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
➖➖➖➖➖➖➖➖➖➖➖
Пользователей: ${totalUsers} | Подписчиков: ${paidUsers}

Посетители за последние 24 часа:
${activeUsersList}
    `;

    ctx.session = ctx.session || {};
    ctx.session.navHistory = ctx.session.navHistory || [];
    ctx.session.navHistory.push('admin_panel');

    await ctx.editMessageText(statsMessage, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[{ text: '↩️ Назад', callback_data: 'back' }]],
      },
    });
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
      { header: 'Вступил в Канал', key: 'joinedChannel', width: 15 },
      { header: 'Ссылка Приглашения', key: 'inviteLink', width: 40 },
      { header: 'Срок Ссылки', key: 'inviteLinkExpires', width: 15 },
      { header: 'Имя', key: 'firstName', width: 20 },
      { header: 'Username', key: 'username', width: 20 },
      { header: 'Телефон', key: 'phoneNumber', width: 15 },
      { header: 'Email', key: 'email', width: 30 },
      { header: 'Дата Платежа', key: 'paymentDate', width: 20 },
      { header: 'Документ Платежа', key: 'paymentDocument', width: 40 },
      { header: 'Последняя Активность', key: 25 },
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
    }));

    worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber > 1)) {
        row.font = { size: 11 };
        row.alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };
      };
    }));

    ['L', 'N'].forEach(col => {
      worksheet.getColumn(col).numFmt = 'dd.mm.yyyy hh:mm:ss';
    }));

    worksheet.columns.forEach(column => {
      let maxLength = 0;
      column.eachCell({ includeEmpty: true }, cell => {
        const cellLength = cell.value ? String(cell.value).length : 10;
        maxLength = Math.max(maxLength, cellLength);
      });
      column.width = Math.min(maxLength + 2, 50);
    }));

    const buffer = await workbook.xlsx.writeBuffer();
    await ctx.replyWithDocument({
      source: buffer,
      filename: `subscribers_${new Date().toISOString().split('T')[0]0}.xlsx`,
    });
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
      const replyMarkup = {
        reply_markup: {
          inline_keyboard: [
            [[
              { text: '🔥 Купить за 399р.', callback_data: 'buy' },
              { text: '💬 Техподдержка', url: settings.supportLink },
            ]],
            ...(adminIds.has(userId) ? [[
              { text: '👑 Админка', callback_data: 'admin_panel' },
              { text: '💡 О канале', callback_data: 'about' },
            ]] : [[{ text: '💡 О канале', callback_data: 'about' }]]),
          ],
        },
      };
      await ctx.editMessageText(await getWelcomeMessage(), {
        parse_mode: 'Markdown',
        reply_markup: replyMarkup.reply_markup,
      });
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
    await ctx.editMessageText('Выберите, что редактировать:', {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: 'О канал', callback_data: 'edit_channel' }],
          [{ text: 'Техподдержка', callback_data: 'edit_support' }],
          [{ text: 'Приветствие', callback_data: 'edit_welcome' }],
          [{ text: '↩️ Назад', callback_data: 'back' }],
        ],
      },
    });
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
    await ctx.reply('Введите новое описание канала:');
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
    await ctx.reply('Введите новый Telegram-username (например, @Username) или URL техподдержки:');
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
    await ctx.reply('Введите новое приветственное сообщение:');
  } catch (error) {
    console.error(`Error in edit_welcome for user ${userId}:`, error.stack);
    await ctx.reply('Ошибка при запросе приветственного сообщения.');
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
        return ctx.reply('Пожалуйста, введите действительный email (например, user@example.com):');
      }
      await User.updateOne({ userId }, { email: text });
      ctx.session.waitingForEmail = false;
      await ctx.reply('Email сохранён! Перехожу к созданию платежа...');
      return await processPayment(ctx, userId, String(ctx.chat.id));
    }

    if (!adminIds.has(userId) || !ctx.session.editing) {
      return;
    }

    if (ctx.session.editing === 'channelDescription') {
      if (text.length < 10) {
        return ctx.reply('Описание должно быть не короче 10 символов. Попробуйте снова:');
      }
      cachedSettings = await Settings.findOneAndUpdate(
          {},
          { channelDescription: text },
          { upsert: true, new: true }
      );
      ctx.session.editing = null;
      await ctx.reply('Описание канала обновлено!');
    } else if (ctx.session.editing === 'supportLink') {
      let supportLink = text;
      if (supportLink.startsWith('@')) {
        supportLink = `https://t.me/${supportLink.slice(1)}`;
      } else if (!supportLink.match(/^https?:\/\//)) {
        return ctx.reply('Введите действительный URL или Telegram-username (например, @Username). Попробуйте снова:');
      }
      cachedSettings = await Settings.findOneAndUpdate(
          {},
          { supportLink },
          { upsert: true, new: true }
      );
      ctx.session.editing = null;
      await ctx.reply('Ссылка на техподдержку обновлена!');
    } else if (ctx.session.editing === 'welcomeMessage') {
      if (text.length < 10) {
        return ctx.reply('Приветственное сообщение должно быть не короче 10 символов. Попробуйте снова:');
      }
      cachedSettings = await Settings.findOneAndUpdate(
          {},
          { welcomeMessage: text },
          { upsert: true, new: true }
      );
      ctx.session.editing = null;
      await ctx.reply('Приветственное сообщение обновлено!');
    }
  } catch (error) {
    console.error(`Error processing text input for user ${userId}:`, error.stack);
    await ctx.reply('Ошибка при сохранении изменений. Попробуйте снова.');
  }
});

// Функция обработки платежа
async function processPayment(ctx, userId, chatId) {
  try {
    console.log(`YOOKASSA_SHOP_ID: ${process.env.YOOKASSA_SHOP_ID}, YOOKASSA_SECRET_KEY: ${process.env.YOOKASSA_SECRET_KEY ? 'present' : 'missing'}`);
    const user = await User.findOne({ userId });
    if (user?.paymentStatus === 'succeeded' && user.inviteLink) {
      return ctx.reply('Вы уже оплатили доступ! Вот ваша одноразовая ссылка для вступления в канал:', {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[{ text: 'Присоединиться', url: user.inviteLink }]],
        },
      });
    }

    const paymentId = uuidv4();
    console.log(`Creating payment for user ${userId}, paymentId: ${paymentId}`);
    const payment = await Promise.race([
      createPayment({
        amount: 399,
        description: 'Доступ к закрытому Telegram каналу',
        paymentId,
        userId,
        returnUrl: process.env.RETURN_URL,
        email: user.email,
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout waiting for Yookassa response')), 15000))
    ]);

    await User.updateOne(
        { userId },
        { paymentId, paymentStatus: 'pending', chatId, lastActivity: new Date() },
        { upsert: true }
    );

    await ctx.reply('Перейдите по ссылке для оплаты:', {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[{ text: 'Оплатить', url: payment.confirmation.confirmation_url }]],
      },
    });
  } catch (error) {
    console.error(`Payment error for user ${userId}:`, error.message);
    await ctx.reply('Ошибка при создании платежа. Попробуйте позже или свяжитесь с поддержкой.');
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
      await ctx.reply('Пожалуйста, введите ваш email для оформления оплаты:');
      return;
    }
    await processPayment(ctx, userId, chatId);
  } catch (error) {
    console.error(`Error in buy for user ${userId}:`, error.message);
    await ctx.reply('Произошла ошибка. Попробуйте позже.');
  }
});

// Обработчик кнопки "О канале"
bot.action('about', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = String(ctx.from.id);
  try {
    await User.updateOne({ userId }, { lastActivity: new Date() });
    const settings = await getSettings();
    try {
      await ctx.editMessageText(settings.channelDescription, {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[{ text: '↩️ Назад', callback_data: 'back' }]],
        },
      });
    } catch (editError) {
      console.warn(`Failed to edit message for user ${userId}:`, editError.message);
      await ctx.replyWithMarkdown(settings.channelDescription, {
        reply_markup: {
          inline_keyboard: [[{ text: '↩️ Назад', callback_data: 'back' }]],
        },
      });
    }
  } catch (error) {
    console.error(`Error in about for user ${userId}:`, error.stack);
    await ctx.reply('Произошла ошибка. Попробуйте позже.');
  }
});

// Обработчик корневого пути
app.get('/', (req, res) => {
  res.send('Это API бота alishasaldaevabaza-bot. Используйте /health или /ping для проверки статуса или обратитесь к боту в Telegram.');
});

// Обработка возврата от ЮKassa
app.get('/return', async (req, res) => {
  console.log('Received /return request with query:', req.query);
  const { paymentId } = req.query;
  if (paymentId) {
    try {
      const user = await User.findOne({ paymentId });
      if (user) {
        const payment = await getPayment(paymentId);
        if (payment.status === 'succeeded') {
          await sendInviteLink(user, { chat: { id: user.chatId } }, paymentId);
        } else {
          await bot.telegram.sendMessage(user.chatId, `Оплата ещё не подтверждена. Статус: ${payment.status}. Попробуйте /checkpayment позже.`);
        }
      }
    } catch (error) {
      console.error('Error processing /return:', error.message);
    }
  }
  res.send('Оплата обработана! Вы будете перенаправлены в Telegram.');
});

// Health check для Render
app.get('/health', (req, res) => res.sendStatus(200));

// Вебхук для ЮKassa
app.post('/webhook/yookassa', async (req, res) => {
  try {
    console.log('Received Yookassa webhook with body:', JSON.stringify(req.body));
    const { event, object } = req.body;
    if (event === 'payment.succeeded') {
      console.log(`Processing payment.succeeded for paymentId: ${object.id}`);
      const user = await User.findOne({ paymentId: object.id });
      if (user && !user.joinedChannel) {
        console.log(`Sending invite link for user ${user.userId}`);
        await sendInviteLink(user, { chat: { id: user.chatId } }, object.id);
      } else if (!user) {
        console.warn(`No user found for paymentId: ${object.id}`);
        for (const adminId of adminIds) {
          await bot.telegram.sendMessage(
              adminId,
              `Ошибка: Пользователь не найден для paymentId: ${object.id}`
          );
        }
      }
    } else {
      console.log(`Received unhandled event: ${event}`);
    }
    res.sendStatus(200);
  } catch (error) {
    console.error('Error in Yookassa webhook:', error.message);
    res.sendStatus(200); // ЮKassa ожидает 200 даже при ошибке
  }
});

// Запуск сервера
const PORT = process.env.PORT || 5000;
console.log(`Starting server on port ${PORT}`);
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});