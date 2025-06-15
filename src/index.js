const { Telegraf } = require('telegraf');
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
});

const User = mongoose.model('User', UserSchema);

// Инициализация бота
console.log('Initializing Telegraf bot with token:', process.env.BOT_TOKEN ? 'Token present' : 'Token missing');
const bot = new Telegraf(process.env.BOT_TOKEN);
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
const { createPayment, checkPayment } = require('./yookassa');

// Задержка для избежания лимитов Telegram API
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Установка команд главного меню
const setMainMenu = async (userId) => {
  try {
    console.log(`Setting main menu for userId: ${userId}`);
    await delay(100);
    const adminIds = (process.env.ADMIN_CHAT_IDS || '').split(',').map(id => id.trim());
    const isAdmin = adminIds.includes(userId);
    const commands = [
      { command: 'buy', description: 'Оплатить доступ к каналу' },
      { command: 'check_payment', description: 'Проверить статус оплаты' },
      { command: 'renew_link', description: 'Обновить ссылку на канал' },
    ];
    if (isAdmin) {
      commands.push({ command: 'admin', description: 'Админ панель' });
    }
    await bot.telegram.setMyCommands(commands, { scope: { type: 'chat', chat_id: userId } });
    console.log(`Main menu set successfully for userId: ${userId}`);
  } catch (error) {
    console.error(`Error setting main menu for userId ${userId}:`, error.stack);
  }
};

// Установка меню поддержки
const setSupportMenu = async (userId) => {
  try {
    console.log(`Setting support menu for userId: ${userId}`);
    await delay(100);
    const adminIds = (process.env.ADMIN_CHAT_IDS || '').split(',').map(id => id.trim());
    const isAdmin = adminIds.includes(userId);
    const commands = [
      { command: 'support', description: 'Связаться с поддержкой' },
      { command: 'renew_link', description: 'Обновить ссылку на канал' },
    ];
    if (isAdmin) {
      commands.push({ command: 'admin', description: 'Админ панель' });
    }
    await bot.telegram.setMyCommands(commands, { scope: { type: 'chat', chat_id: userId } });
    console.log(`Support menu set successfully for userId: ${userId}`);
  } catch (error) {
    console.error(`Error setting support menu for userId ${userId}:`, error.stack);
  }
};

// Обработчик команды /start
bot.start(async (ctx) => {
  console.log(`Received /start command from ${ctx.from.id}`);
  const userId = ctx.from.id.toString();
  const chatId = ctx.chat.id.toString();
  const { first_name, username, phone_number } = ctx.from;

  try {
    console.log(`Processing /start for userId: ${userId}`);
    let user = await User.findOne({ userId });
    console.log(`User found or to be created: ${user ? 'exists' : 'new'}`);
    if (!user) {
      console.log(`Creating new user: ${userId}`);
      user = await User.findOneAndUpdate(
          { userId },
          { userId, chatId, firstName: first_name, username, phoneNumber: phone_number },
          { upsert: true, new: true }
      );
      console.log(`User created: ${JSON.stringify(user)}`);
      await setMainMenu(userId);
    } else if (user.paymentStatus === 'succeeded' && user.joinedChannel) {
      await setSupportMenu(userId);
    }

    console.log(`Sending reply to ${userId}`);
    await ctx.replyWithMarkdown(
        `Привет! Я очень рада видеть тебя тут! Если ты лютая модница и устала переплачивать за шмотки, жду тебя в моем закрытом тг канале! Давай экономить вместе❤️

ПОЧЕМУ ЭТО ВЫГОДНО?

- быстрая доставка
- ооооочеень низкие цены
- все заказы можно сделать через Вконтакте`,
        {
          reply_markup: {
            inline_keyboard: [
              [
                { text: '🔥 Купить', callback_data: 'buy' },
                { text: '💬 Техподдержка', url: 'https://t.me/Eagleshot' }
              ],
              [{ text: '💡 О канале', callback_data: 'about' }],
              ...(adminIds.includes(userId) ? [[{ text: 'Админ панель', callback_data: 'admin' }]] : []),
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

// Обработчик сообщений
bot.on('message', async (ctx) => {
  const userId = ctx.from.id.toString();
  const chatId = ctx.chat.id.toString();
  const { first_name, username, phone_number } = ctx.from;
  console.log(`Received message from ${userId} in chat ${chatId}, text: ${ctx.message?.text}`);

  try {
    let user = await User.findOne({ userId });
    console.log(`User found or to be created: ${user ? 'exists' : 'new'}`);
    if (!user) {
      console.log(`Creating new user: ${userId}`);
      user = await User.findOneAndUpdate(
          { userId },
          { userId, chatId, firstName: first_name, username, phoneNumber: phone_number },
          { upsert: true, new: true }
      );
      console.log(`User created: ${JSON.stringify(user)}`);
      await setMainMenu(userId);
    } else if (user.paymentStatus === 'succeeded' && user.joinedChannel) {
      console.log(`User ${userId} is a paid subscriber`);
      await setSupportMenu(userId);
    }

    console.log(`Sending reply to ${userId}`);
    await ctx.replyWithMarkdown(
        `Привет! Я очень рада видеть тебя тут! Если ты лютая модница и устала переплачивать за шмотки, жду тебя в моем закрытом тг канале! Давай экономить вместе❤️

ПОЧЕМУ ЭТО ВЫГОДНО?

- быстрая доставка
- ооооочеень низкие цены
- все заказы можно сделать через Вконтакте`,
        {
          reply_markup: {
            inline_keyboard: [
              [
                { text: '🔥 Купить', callback_data: 'buy' },
                { text: '💬 Техподдержка', url: 'https://t.me/Eagleshot' }
              ],
              [{ text: '💡 О канале', callback_data: 'about' }],
              ...(adminIds.includes(userId) ? [[{ text: 'Админ панель', callback_data: 'admin' }]] : []),
            ],
          },
        }
    );
    console.log(`Reply sent to ${userId}`);
  } catch (error) {
    console.error(`Error in message handler for user ${userId}:`, error.stack);
    await ctx.reply('Произошла ошибка. Попробуйте позже или свяжитесь с поддержкой.');
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
        const adminIds = (process.env.ADMIN_CHAT_IDS || '').split(',').map(id => id.trim());
        for (const adminId of adminIds) {
          await bot.telegram.sendMessage(
              adminId,
              `Новый успешный платёж от user_${user.userId} (paymentId: ${object.id})`
          );
        }
        await setSupportMenu(user.userId);
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

// Обработка нажатий на кнопки
bot.action('admin', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id.toString();
  const adminIds = (process.env.ADMIN_CHAT_IDS || '').split(',').map(id => id.trim());
  if (!adminIds.includes(userId)) {
    return ctx.reply('Доступ запрещён. Эта команда только для администратора.');
  }

  try {
    await ctx.reply('Админ-панель:', {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[{ text: 'Выгрузить подписчиков', callback_data: 'export_subscribers' }]],
      },
    });
  } catch (error) {
    console.error(`Error in /admin for user ${userId}:`, error.stack);
    await ctx.reply('Ошибка при открытии админ-панели.');
  }
});

bot.action('support', async (ctx) => {
  await ctx.answerCbQuery();
  try {
    await ctx.replyWithMarkdown(
        'Если у вас возникли вопросы или проблемы, напишите в техническую поддержку: @YourSupportUsername или свяжитесь через [почту](mailto:support@example.com).'
    );
  } catch (error) {
    console.error(`Error in /support for user ${ctx.from.id}:`, error.stack);
    await ctx.reply('Произошла ошибка. Попробуйте позже.');
  }
});

bot.action('about', async (ctx) => {
  await ctx.answerCbQuery();
  try {
    await ctx.replyWithMarkdown(
        'Добро пожаловать в наш магазин! Мы предлагаем стильную одежду по доступным ценам с быстрой доставкой. Подписывайтесь на канал для эксклюзивных предложений! 😊'
    );
  } catch (error) {
    console.error(`Error in /about for user ${ctx.from.id}:`, error.stack);
    await ctx.reply('Произошла ошибка. Попробуйте позже.');
  }
});

bot.action('buy', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id.toString();
  const chatId = ctx.chat.id.toString();

  try {
    const user = await User.findOne({ userId });
    if (user?.paymentStatus === 'succeeded' && user.inviteLink) {
      const now = Math.floor(Date.now() / 1000);
      await setSupportMenu(userId);
      if (user.inviteLinkExpires > now) {
        return ctx.reply('Вы уже оплатили доступ! Вот ваша ссылка:', {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [[{ text: 'Присоединиться', url: user.inviteLink }]],
          },
        });
      } else {
        return ctx.reply('Ваша ссылка истекла. Используйте /renew_link для получения новой.');
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
        { paymentId, paymentStatus: 'pending', chatId },
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

// Проверка статуса оплаты
bot.command('check_payment', async (ctx) => {
  const userId = ctx.from.id.toString();
  try {
    const user = await User.findOne({ userId });
    if (!user) {
      return ctx.reply('Вы ещё не начинали процесс оплаты.');
    }
    if (user.paymentStatus === 'succeeded' && user.inviteLink) {
      const now = Math.floor(Date.now() / 1000);
      if (user.inviteLinkExpires > now) {
        return ctx.reply('Ваш платёж успешен! Вот ваша ссылка:', {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [[{ text: 'Присоединиться', url: user.inviteLink }]],
          },
        });
      } else {
        return ctx.reply('Ваша ссылка истекла. Используйте /renew_link для получения новой.');
      }
    }
    return ctx.reply('Платёж ещё не завершён или возникла ошибка. Попробуйте позже.');
  } catch (error) {
    console.error(`Error in /check_payment for user ${userId}:`, error.stack);
    await ctx.reply('Произошла ошибка при проверке статуса. Попробуйте позже.');
  }
});

// Обновление истёкшей ссылки
bot.command('renew_link', async (ctx) => {
  const userId = ctx.from.id.toString();
  try {
    const user = await User.findOne({ userId, paymentStatus: 'succeeded' });
    if (!user) {
      return ctx.reply('Вы ещё не оплатили доступ или платёж не подтверждён.');
    }
    const now = Math.floor(Date.now() / 1000);
    if (user.inviteLink && user.inviteLinkExpires > now) {
      return ctx.reply('Ваша текущая ссылка всё ещё действительна:', {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[{ text: 'Присоединиться', url: user.inviteLink }]],
        },
      });
    }
    const expireDate = Math.floor(Date.now() / 1000) + 24 * 60 * 60;
    const chatInvite = await ctx.telegram.createChatInviteLink(
        process.env.CHANNEL_ID,
        {
          name: `Invite for user_${userId}`,
          member_limit: 1,
          creates_join_request: false,
          expire_date: expireDate,
        }
    );
    await User.findOneAndUpdate(
        { userId },
        { inviteLink: chatInvite.invite_link, inviteLinkExpires: expireDate },
        { new: true }
    );
    return ctx.reply('Ваша новая ссылка сгенерирована (действует 24 часа):', {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[{ text: 'Присоединиться', url: chatInvite.invite_link }]],
      },
    });
  } catch (error) {
    console.error(`Error in /renew_link for user ${userId}:`, error.stack);
    await ctx.reply('Ошибка при обновлении ссылки. Свяжитесь с поддержкой.');
  }
});

// Обработка выгрузки подписчиков
bot.action('export_subscribers', async (ctx) => {
  const userId = ctx.from.id.toString();
  const adminIds = (process.env.ADMIN_CHAT_IDS || '').split(',').map(id => id.trim());
  if (!adminIds.includes(userId)) {
    return ctx.reply('Доступ запрещён.');
  }

  try {
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