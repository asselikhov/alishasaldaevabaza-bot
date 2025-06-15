const { Telegraf } = require('telegraf');
const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');
const express = require('express');
const ExcelJS = require('exceljs');
require('dotenv').config();

const app = express();
app.use(express.json());

// Подключение к MongoDB
mongoose.connect(process.env.MONGODB_URI)
    .then(() => console.log('Connected to MongoDB'))
    .catch(err => console.error('MongoDB connection error:', err));

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
  paymentDocument: { type: String, default: null }, // Изменено на String для хранения ссылки
});

const User = mongoose.model('User', UserSchema);

// Инициализация бота
const bot = new Telegraf(process.env.BOT_TOKEN);

// ЮKassa конфигурация
const { createPayment, checkPayment } = require('./yookassa');

// Установка команд главного меню
const setMainMenu = async (userId) => {
  const isAdmin = userId === process.env.ADMIN_CHAT_ID;
  const commands = [];
  if (isAdmin) {
    commands.push({ command: 'admin', description: 'Админ панель' });
  }
  await bot.telegram.setMyCommands(commands, { scope: { type: 'chat', chat_id: userId } });
};

const setSupportMenu = async (userId) => {
  const isAdmin = userId === process.env.ADMIN_CHAT_ID;
  const commands = [];
  if (isAdmin) {
    commands.push({ command: 'admin', description: 'Админ панель' });
  }
  await bot.telegram.setMyCommands(commands, { scope: { type: 'chat', chat_id: userId } });
};

// Обработка возврата от ЮKassa
app.get('/return', async (req, res) => {
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
  const { event, object } = req.body;
  console.log(`Received Yookassa webhook: ${event}`);

  if (event === 'payment.succeeded') {
    const user = await User.findOne({ paymentId: object.id });
    if (user && !user.joinedChannel) {
      try {
        const expireDate = Math.floor(Date.now() / 1000) + 24 * 60 * 60; // 24 часа
        const chatInvite = await bot.telegram.createChatInviteLink(
            process.env.CHANNEL_ID,
            {
              name: `Invite for user_${user.userId}`,
              member_limit: 1,
              creates_join_request: false,
              expire_date: expireDate,
            }
        );

        // Создание текстового документа с данными платежа
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
        const paymentDocument = `https://t.me/c/${process.env.PAYMENT_GROUP_ID.split('-100')[1]}/${paymentDoc.message_id}`; // Ссылка на сообщение

        await User.findOneAndUpdate(
            { userId: user.userId, paymentId: object.id },
            {
              paymentStatus: 'succeeded',
              joinedChannel: true,
              inviteLink: chatInvite.invite_link,
              inviteLinkExpires: expireDate,
              paymentDate: new Date(),
              paymentDocument, // Сохранение ссылки на документ
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
        await bot.telegram.sendMessage(
            process.env.ADMIN_CHAT_ID,
            `Новый успешный платёж от user_${user.userId} (paymentId: ${object.id})`
        );
        // Обновляем меню для пользователя
        await setSupportMenu(userId);
      } catch (error) {
        console.error('Error processing webhook:', error);
        await bot.telegram.sendMessage(
            user.chatId,
            'Ошибка при создании ссылки на канал. Пожалуйста, свяжитесь с поддержкой.'
        );
      }
    }
  }
  res.sendStatus(200);
});

// Автоматическое приветствие при первом сообщении
bot.on('message', async (ctx) => {
  const userId = ctx.from.id.toString();
  const chatId = ctx.chat.id.toString();
  const { first_name, username, phone_number } = ctx.from;

  // Проверяем, существует ли пользователь в базе
  let user = await User.findOne({ userId });
  if (!user) {
    try {
      user = await User.findOneAndUpdate(
          { userId },
          { userId, chatId, firstName: first_name, username, phoneNumber: phone_number },
          { upsert: true, new: true }
      );

      await setMainMenu(userId);
      await ctx.replyWithMarkdown(
          `*Привет!* Я очень рада видеть тебя тут! 😊  
Если ты лютая модница и устала переплачивать за шмотки, жду тебя в моем *закрытом тг канале*!  
Давай экономить вместе ❤️

**Почему это выгодно?**
- 🚚 *Быстрая доставка*
- 💸 *Ооооочеень низкие цены*
- 📱 *Все заказы можно сделать через Вконтакте*`,
          {
            reply_markup: {
              inline_keyboard: [
                ...(userId === process.env.ADMIN_CHAT_ID ? [[{ text: 'Админ панель', callback_data: 'admin' }]] : []),
              ],
            },
          }
      );
    } catch (error) {
      console.error('Error in first message:', error);
      await ctx.reply('Произошла ошибка. Попробуйте позже или свяжитесь с поддержкой.');
    }
  } else if (user.paymentStatus === 'succeeded' && user.joinedChannel) {
    await setSupportMenu(userId);
    await ctx.replyWithMarkdown(
        `*Привет!* Я очень рада видеть тебя тут! 😊  
Если ты лютая модница и устала переплачивать за шмотки, жду тебя в моем *закрытом тг канале*!  
Давай экономить вместе ❤️

**Почему это выгодно?**
- 🚚 *Быстрая доставка*
- 💸 *Ооооочеень низкие цены*
- 📱 *Все заказы можно сделать через Вконтакте*`,
        {
          reply_markup: {
            inline_keyboard: [
              [
                { text: 'Техподдержка', callback_data: 'support' },
                { text: 'О магазине', callback_data: 'about' },
              ],
            ],
          },
        }
    );
  }
});

// Обработка команды /start (для совместимости)
bot.start(async (ctx) => {
  await bot.on('message')(ctx);
});

// Обработка нажатий на кнопки
bot.action('admin', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id.toString();
  if (userId !== process.env.ADMIN_CHAT_ID) {
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
    console.error('Error in /admin:', error);
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
    console.error('Error in /support:', error);
    await ctx.reply('Произошла ошибка. Попробуйте позже.');
  }
});

bot.action('about', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.replyWithMarkdown(
      'Добро пожаловать в наш магазин! Мы предлагаем стильную одежду по доступным ценам с быстрой доставкой. Подписывайтесь на канал для эксклюзивных предложений! 😊'
  );
});

// Команда покупки (через текстовую команду для совместимости)
bot.command('buy', async (ctx) => {
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
      returnUrl: process.env.RETURN_URL, // Используем RETURN_URL из .env
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
    console.error('Payment error:', error);
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
    console.error('Error in /check_payment:', error);
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
    console.error('Error in /renew_link:', error);
    await ctx.reply('Ошибка при обновлении ссылки. Свяжитесь с поддержкой.');
  }
});

// Обработка выгрузки подписчиков
bot.action('export_subscribers', async (ctx) => {
  const userId = ctx.from.id.toString();
  if (userId !== process.env.ADMIN_CHAT_ID) {
    return ctx.reply('Доступ запрещён.');
  }

  try {
    const subscribers = await User.find({ paymentStatus: 'succeeded', joinedChannel: true });

    if (!subscribers.length) {
      return ctx.reply('Нет оплаченных подписчиков для выгрузки.');
    }

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Subscribers');

    // Настройка заголовков
    worksheet.columns = [
      { header: 'Telegram ID', key: 'userId', width: 20 },
      { header: 'Имя', key: 'firstName', width: 20 },
      { header: 'Telegram-имя', key: 'username', width: 20 },
      { header: 'Телефон', key: 'phoneNumber', width: 15 },
      { header: 'Дата оплаты', key: 'paymentDate', width: 20 },
      { header: 'Платежный документ', key: 'paymentDocument', width: 30 }, // Обновлённый столбец
    ];

    // Форматирование заголовков
    worksheet.getRow(1).font = { bold: true };
    worksheet.getRow(1).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFADD8E6' },
    };
    worksheet.getRow(1).alignment = { vertical: 'middle', horizontal: 'center' };

    // Добавление данных
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

    // Автонастройка ширины столбцов
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

    // Сохранение файла
    const buffer = await workbook.xlsx.write();
    const fileName = `Subscribers_${new Date().toISOString().slice(0, 10)}.xlsx`;

    // Отправка файла
    await ctx.replyWithDocument(
        { source: buffer, filename: fileName },
        { caption: 'Список оплаченных подписчиков' }
    );
  } catch (error) {
    console.error('Error exporting subscribers:', error);
    await ctx.reply('Ошибка при выгрузке подписчиков. Попробуйте позже.');
  }
});

// Запуск сервера
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);
  await bot.telegram.setWebhook(`https://${process.env.RENDER_URL}/bot${process.env.BOT_TOKEN}`);
  console.log('Webhook set');
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