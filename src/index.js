const { Telegraf, session } = require('telegraf');
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
  if (req.body) console.log('Request body:', JSON.stringify(req.body));
  next();
});

// Подключение к MongoDB
mongoose.connect(process.env.MONGODB_URI)
    .then(() => console.log('Connected to MongoDB'))
    .catch(err => console.error('MongoDB connection error:', err.stack));

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
  paymentDate: Date,
  paymentDocument: { type: String, default: null },
  lastActivity: { type: Date, default: Date.now },
});

const User = mongoose.model('User', UserSchema);

// Схема настроек
const SettingsSchema = new mongoose.Schema({
  channelDescription: { type: String, default: 'Добро пожаловать в наш магазин! Мы предлагаем стильную одежду по доступным ценам с быстрой доставкой. Подписывайтесь на канал для эксклюзивных предложений! 😊' },
  supportLink: { type: String, default: 'https://t.me/Eagleshot' },
});

const Settings = mongoose.model('Settings', SettingsSchema);

// Определение администраторов
const adminIds = (process.env.ADMIN_CHAT_IDS || '').split(',').map(id => String(id.trim()));
console.log('Parsed adminIds:', adminIds);

// Инициализация бота
console.log('Initializing Telegraf bot with token:', process.env.BOT_TOKEN ? 'Token present' : 'Token missing');
const bot = new Telegraf(process.env.BOT_TOKEN);
bot.use(session());
bot.catch((err, ctx) => {
  console.error('Telegraf global error for update', ctx?.update, ':', err.stack);
  if (ctx) ctx.reply('Произошла ошибка. Попробуйте позже.');
});

// Явная настройка вебхука
app.post(`/bot${process.env.BOT_TOKEN}`, async (req, res) => {
  console.log(`[${new Date().toISOString()}] Webhook endpoint hit with body:`, JSON.stringify(req.body));
  try {
    await bot.handleUpdate(req.body);
    res.status(200).send('OK');
  } catch (err) {
    console.error('Error handling webhook update:', err.stack);
    res.status(500).send('Error processing webhook');
  }
});

// Эндпоинт для пинга от UptimeRobot
app.all('/ping', (req, res) => {
  console.log(`[${new Date().toISOString()}] Received ${req.method} ping from UptimeRobot or other service`);
  res.status(200).send('Bot is awake!');
});

// ЮKassa конфигурация
const { createPayment } = require('./yookassa');

// Кэшированные настройки
let cachedSettings = null;

async function getSettings() {
  if (!cachedSettings) {
    cachedSettings = await Settings.findOne() || new Settings();
  }
  return cachedSettings;
}

// Установка главного меню
const setMainMenu = async (ctx) => {
  try {
    const userId = String(ctx.from.id);
    console.log(`Setting main menu for userId: ${userId}, adminIds: ${JSON.stringify(adminIds)}, isAdmin: ${adminIds.includes(userId)}`);
    const isAdmin = adminIds.includes(userId);

    if (isAdmin) {
      const keyboard = {
        reply_markup: {
          keyboard: [[{ text: '👑 Админ панель' }]],
          resize_keyboard: true,
          persistent: true,
        },
      };
      console.log(`Sending keyboard to user ${userId}:`, JSON.stringify(keyboard));
      await ctx.reply('Главное меню:', keyboard);
    } else {
      await ctx.reply('Главное меню:', {
        reply_markup: {
          remove_keyboard: true,
        },
      });
    }
    console.log(`Main menu set successfully for userId: ${userId}`);
  } catch (error) {
    console.error(`Error setting main menu for userId ${userId}:`, error.stack);
    await ctx.reply('Ошибка при установке меню.');
  }
};

// Команда для принудительного обновления меню администратора
bot.command('adminmenu', async (ctx) => {
  const userId = String(ctx.from.id);
  if (!adminIds.includes(userId)) {
    return ctx.reply('Доступ запрещён.');
  }
  await setMainMenu(ctx);
  await ctx.reply('Меню администратора обновлено.');
});

// Текст приветственного сообщения
const getWelcomeMessage = () => {
  return `Привет! Я очень рада видеть тебя тут! Если ты лютая модница и устала переплачивать за шмотки, жду тебя в моем закрытом тг канале! Давай экономить вместе❤️

ПОЧЕМУ ЭТО ВЫГОДНО?

- быстрая доставка
- ооооочеень низкие цены
- все заказы можно сделать через Вконтакте`;
};

// Обработчик команды /start
bot.start(async (ctx) => {
  console.log(`Received /start command from ${ctx.from.id}`);
  const userId = String(ctx.from.id);
  const chatId = String(ctx.chat.id);
  const { first_name, username, phone_number } = ctx.from;

  try {
    console.log(`Processing /start for userId: ${userId}`);
    let user = await User.findOne({ userId });
    console.log(`User found or to be created: ${user ? 'exists' : 'new'}`);
    if (!user) {
      console.log(`Creating new user: ${userId}`);
      user = await User.findOneAndUpdate(
          { userId },
          { userId, chatId, firstName: first_name, username, phoneNumber: phone_number, lastActivity: new Date() },
          { upsert: true, new: true }
      );
      console.log(`User created: ${JSON.stringify(user)}`);
    } else {
      await User.findOneAndUpdate({ userId }, { lastActivity: new Date() });
    }
    await setMainMenu(ctx);

    const settings = await getSettings();
    console.log(`Sending reply to ${userId}`);
    await ctx.replyWithMarkdown(
        getWelcomeMessage(),
        {
          reply_markup: {
            inline_keyboard: [
              [
                { text: '🔥 Купить', callback_data: 'buy' },
                { text: '💬 Техподдержка', url: settings.supportLink },
              ],
              [{ text: '💡 О канале', callback_data: 'about' }],
            ],
          },
        }
    );
    console.log(`Reply sent to ${userId}`);
  } catch (error) {
    console.error(`Error in /start for user ${userId}:`, error.stack);
    await ctx.reply('Произошла ошибка. Попробуйте позже или свяжитесь с поддержкой.');
  }
});

// Обработчик кнопки "👑 Админ панель"
bot.hears('👑 Админ панель', async (ctx) => {
  const userId = String(ctx.from.id);
  if (!adminIds.includes(userId)) {
    return ctx.reply('Доступ запрещён. Эта функция только для администраторов.');
  }

  try {
    await User.findOneAndUpdate({ userId }, { lastActivity: new Date() });
    await setMainMenu(ctx); // Переустанавливаем меню
    await ctx.reply('Админ-панель:', {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: 'Редактировать', callback_data: 'edit' }],
          [{ text: 'Выгрузить подписчиков', callback_data: 'export_subscribers' }],
          [{ text: 'Статистика', callback_data: 'stats' }],
        ],
      },
    });
  } catch (error) {
    console.error(`Error in admin panel for user ${userId}:`, error.stack);
    await ctx.reply('Ошибка при открытии админ-панели.');
  }
});

// Обработчик кнопки "Редактировать"
bot.action('edit', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = String(ctx.from.id);
  if (!adminIds.includes(userId)) {
    return ctx.reply('Доступ запрещён.');
  }

  try {
    await User.findOneAndUpdate({ userId }, { lastActivity: new Date() });
    await ctx.reply('Выберите, что редактировать:', {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: 'О канале', callback_data: 'edit_channel' }],
          [{ text: 'Техподдержка', callback_data: 'edit_support' }],
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
  if (!adminIds.includes(userId)) {
    return ctx.reply('Доступ запрещён.');
  }

  try {
    await User.findOneAndUpdate({ userId }, { lastActivity: new Date() });
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
  if (!adminIds.includes(userId)) {
    return ctx.reply('Доступ запрещён.');
  }

  try {
    await User.findOneAndUpdate({ userId }, { lastActivity: new Date() });
    ctx.session = ctx.session || {};
    ctx.session.editing = 'supportLink';
    await ctx.reply('Введите новый Telegram-username (например, @Username) или URL техподдержки:');
  } catch (error) {
    console.error(`Error in edit_support for user ${userId}:`, error.stack);
    await ctx.reply('Ошибка при запросе ссылки техподдержки.');
  }
});

// Обработчик текстового ввода для редактирования
bot.on('text', async (ctx) => {
  const userId = String(ctx.from.id);
  if (!adminIds.includes(userId) || !ctx.session?.editing) {
    return;
  }

  try {
    await User.findOneAndUpdate({ userId }, { lastActivity: new Date() });
    const text = ctx.message.text.trim();
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
      } else if (!supportLink.startsWith('http://') && !supportLink.startsWith('https://')) {
        return ctx.reply('Введите действительный URL или Telegram-username (например, @Username). Попробуйте снова:');
      }
      cachedSettings = await Settings.findOneAndUpdate(
          {},
          { supportLink },
          { upsert: true, new: true }
      );
      ctx.session.editing = null;
      await ctx.reply('Ссылка на техподдержку обновлена!');
    }
  } catch (error) {
    console.error(`Error processing text input for user ${userId}:`, error.stack);
    await ctx.reply('Ошибка при сохранении изменений. Попробуйте снова.');
  }
});

// Обработчик кнопки "Выгрузить подписчиков"
bot.action('export_subscribers', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = String(ctx.from.id);
  if (!adminIds.includes(userId)) {
    return ctx.reply('Доступ запрещён.');
  }

  try {
    await User.findOneAndUpdate({ userId }, { lastActivity: new Date() });
    const subscribers = await User.find({ paymentStatus: 'succeeded', joinedChannel: true });

    if (!subscribers.length) {
      return ctx.reply('Нет оплаченных подписчиков для выгрузки.');
    }

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Subscribers');

    worksheet.columns = [
      { header: 'Telegram ID', key: 'userId', width: 20 },
      { header: 'Имя', key: 'firstName', width: 20 },
      { header: 'Telegram-имя', key: 'username', width: 20 },
      { header: 'Телефон', key: 'phoneNumber', width: 15 },
      { header: 'Дата оплаты', key: 'paymentDate', width: 20 },
      { header: 'Платежный документ', key: 'paymentDocument', width: 30 },
    ];

    worksheet.getRow(1).font = { bold: true };
    worksheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFADD8E6' } };
    worksheet.getRow(1).alignment = { vertical: 'middle', horizontal: 'center' };

    subscribers.forEach((sub) => {
      worksheet.addRow({
        userId: sub.userId,
        firstName: sub.firstName || 'Не указано',
        username: sub.username ? `@${sub.username}` : 'Не указано',
        phoneNumber: sub.phoneNumber || 'Не указано',
        paymentDate: sub.paymentDate ? sub.paymentDate.toLocaleString('ru-RU') : 'Не указано',
        paymentDocument: sub.paymentDocument || 'Не указано',
      });
    });

    worksheet.columns.forEach((column) => {
      let maxLength = 0;
      column.eachCell({ includeEmpty: true }, (cell) => {
        const columnLength = cell.value ? cell.value.toString().length : 10;
        if (columnLength > maxLength) {
          maxLength = columnLength;
        }
      });
      column.width = maxLength < 10 ? 10 : maxLength;
    });

    const buffer = await workbook.xlsx.write();
    const fileName = `Subscribers_${new Date().toISOString().slice(0, 10)}.xlsx`;

    await ctx.replyWithDocument(
        { source: buffer, filename: fileName },
        { caption: 'Список оплаченных подписчиков' }
    );
  } catch (error) {
    console.error(`Error exporting subscribers for user ${userId}:`, error.stack);
    await ctx.reply('Ошибка при выгрузке подписчиков. Попробуйте позже.');
  }
});

// Обработчик кнопки "Статистика"
bot.action('stats', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = String(ctx.from.id);
  if (!adminIds.includes(userId)) {
    return ctx.reply('Доступ запрещён.');
  }

  try {
    await User.findOneAndUpdate({ userId }, { lastActivity: new Date() });
    const totalUsers = await User.countDocuments();
    const paidSubscribers = await User.countDocuments({ paymentStatus: 'succeeded', joinedChannel: true });
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const recentVisitors = await User.find({ lastActivity: { $gte: oneDayAgo } }).select('userId firstName username');

    let visitorsList = 'Список посетителей за последние 24 часа:\n';
    if (recentVisitors.length === 0) {
      visitorsList += 'Нет активности за последние сутки';
    } else {
      visitorsList += recentVisitors.map((visitor, index) =>
          `${index + 1}. ${visitor.firstName || 'Не указано'} (@${visitor.username || 'без username'}, ID: ${visitor.userId})`
      ).join('\n');
    }

    const statsMessage = `Статистика бота:\n` +
        `➖➖➖➖➖➖➖➖➖➖➖\n` +
        `Пользователей: ${totalUsers}\n` +
        `Подписчиков: ${paidSubscribers}\n` +
        `${visitorsList}`;

    await ctx.reply(statsMessage);
  } catch (error) {
    console.error(`Error in stats for user ${userId}:`, error.stack);
    await ctx.reply('Ошибка при получении статистики. Попробуйте позже.');
  }
});

// Обработчик кнопки "Купить"
bot.action('buy', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = String(ctx.from.id);
  const chatId = String(ctx.chat.id);

  try {
    await User.findOneAndUpdate({ userId }, { lastActivity: new Date() });
    const user = await User.findOne({ userId });
    if (user?.paymentStatus === 'succeeded' && user.inviteLink) {
      const now = Math.floor(Date.now() / 1000);
      if (user.inviteLinkExpires > now) {
        return ctx.reply('Вы уже оплатили доступ! Вот ваша ссылка:', {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [[{ text: 'Присоединиться', url: user.inviteLink }]],
          },
        });
      } else {
        return ctx.reply('Ваша ссылка истекла. Свяжитесь с поддержкой для получения новой.');
      }
    }

    const paymentId = uuidv4();
    const payment = await createPayment({
      amount: 399,
      description: 'Доступ к закрытому Telegram каналу',
      paymentId,
      userId,
      returnUrl: process.env.RETURN_URL,
    });

    await User.findOneAndUpdate(
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
    console.error(`Payment error for user ${userId}:`, error.stack);
    await ctx.reply('Произошла ошибка при создании платежа. Попробуйте позже или свяжитесь с поддержкой.');
  }
});

// Обработчик кнопки "О канале"
bot.action('about', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = String(ctx.from.id);
  try {
    await User.findOneAndUpdate({ userId }, { lastActivity: new Date() });
    const settings = await getSettings();
    try {
      await ctx.editMessageText(settings.channelDescription, {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[{ text: 'Назад', callback_data: 'back' }]],
        },
      });
    } catch (editError) {
      console.warn(`Failed to edit message for user ${userId}:`, editError.message);
      await ctx.replyWithMarkdown(settings.channelDescription, {
        reply_markup: {
          inline_keyboard: [[{ text: 'Назад', callback_data: 'back' }]],
        },
      });
    }
  } catch (error) {
    console.error(`Error in about for user ${userId}:`, error.stack);
    await ctx.reply('Произошла ошибка. Попробуйте позже.');
  }
});

// Обработчик кнопки "Назад"
bot.action('back', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = String(ctx.from.id);
  try {
    await User.findOneAndUpdate({ userId }, { lastActivity: new Date() });
    const settings = await getSettings();
    try {
      await ctx.editMessageText(getWelcomeMessage(), {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [
              { text: '🔥 Купить', callback_data: 'buy' },
              { text: '💬 Техподдержка', url: settings.supportLink },
            ],
            [{ text: '💡 О канале', callback_data: 'about' }],
          ],
        },
      });
    } catch (editError) {
      console.warn(`Failed to edit message for user ${userId}:`, editError.message);
      await ctx.replyWithMarkdown(getWelcomeMessage(), {
        reply_markup: {
          inline_keyboard: [
            [
              { text: '🔥 Купить', callback_data: 'buy' },
              { text: '💬 Техподдержка', url: settings.supportLink },
            ],
            [{ text: '💡 О канале', callback_data: 'about' }],
          ],
        },
      });
    }
  } catch (error) {
    console.error(`Error in back for user ${userId}:`, error.stack);
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
    const user = await User.findOne({ paymentId });
    if (user) {
      await bot.telegram.sendMessage(user.chatId, 'Оплата завершена! Пожалуйста, дождитесь подтверждения в боте.');
    }
  }
  res.send('Оплата обработана! Вы будете перенаправлены в Telegram.');
});

// Health check для Render
app.get('/health', (req, res) => res.sendStatus(200));

// Вебхук для ЮKassa
app.post('/webhook/yookassa', async (req, res) => {
  console.log('Received Yookassa webhook with body:', req.body);
  const { event, object } = req.body;

  if (event === 'payment.succeeded') {
    const user = await User.findOne({ paymentId: object.id });
    if (user && !user.joinedChannel) {
      try {
        const expireDate = Math.floor(Date.now() / 1000) + 24 * 60 * 60;
        const chatInvite = await bot.telegram.createChatInviteLink(
            process.env.CHANNEL_ID,
            {
              name: `Invite for user_${user.userId}`,
              member_limit: 1,
              creates_join_request: false,
              expire_date: expireDate,
            }
        );

        const paymentText = `Платежный документ\n` +
            `ID транзакции: ${object.id}\n` +
            `Сумма: ${object.amount.value} ${object.amount.currency}\n` +
            `Дата: ${new Date(object.created_at).toLocaleString('ru-RU')}\n` +
            `Статус: ${object.status}\n` +
            `Пользователь: ${user.userId}`;
        const paymentDoc = await bot.telegram.sendDocument(
            process.env.PAYMENT_GROUP_ID,
            {
              source: Buffer.from(paymentText),
              filename: `payment_${object.id}.txt`,
            },
            {
              caption: `Документ оплаты для user_${user.userId}`,
            }
        );
        const paymentDocument = `https://t.me/c/${process.env.PAYMENT_GROUP_ID.split('-100')[1]}/${paymentDoc.message_id}`;

        await User.findOneAndUpdate(
            { userId: user.userId, paymentId: object.id },
            {
              paymentStatus: 'succeeded',
              joinedChannel: true,
              inviteLink: chatInvite.invite_link,
              inviteLinkExpires: expireDate,
              paymentDate: new Date(),
              paymentDocument,
              lastActivity: new Date(),
            },
            { new: true }
        );
        await bot.telegram.sendMessage(
            user.chatId,
            'Оплата прошла успешно! 🎉 Вот ваша персональная ссылка для входа в закрытый канал (действует 24 часа):',
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
              `Новый успешный платёж от user_${user.userId} (paymentId: ${object.id})`
          );
        }
      } catch (error) {
        console.error('Error processing webhook:', error.stack);
        await bot.telegram.sendMessage(
            user.chatId,
            'Ошибка при создании ссылки на канал. Пожалуйста, свяжитесь с поддержкой.'
        );
      }
    }
  }
  res.sendStatus(200);
});

// Запуск сервера
const PORT = process.env.PORT || 3000;
console.log(`Starting server on port ${PORT}`);
app.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);
  try {
    console.log('Setting webhook');
    await bot.telegram.setWebhook(`https://${process.env.RENDER_URL}/bot${process.env.BOT_TOKEN}`);
    console.log('Webhook set successfully');
    const webhookInfo = await bot.telegram.getWebhookInfo();
    console.log('Webhook info:', JSON.stringify(webhookInfo));
  } catch (error) {
    console.error('Failed to set webhook:', error.stack);
  }
});

// Обработка остановки
process.once('SIGINT', () => {
  console.log('SIGINT received, stopping bot');
  bot.stop('SIGINT');
});
process.once('SIGTERM', () => {
  console.log('SIGTERM received, stopping bot');
  bot.stop('SIGTERM');
});