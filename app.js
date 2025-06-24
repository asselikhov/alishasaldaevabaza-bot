const express = require('express');
const ExcelJS = require('exceljs');
const { bot, sendInviteLink } = require('./services/telegram');
const { processPayment } = require('./controllers/botController');
const { handleYookassaWebhook } = require('./controllers/webhookController');
const { getSettings } = require('./services/settings');
const User = require('./models/User');
const { getPayment } = require('./services/yookassa');
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

app.get('/', (req, res) => res.send('Это API бота alishasaldaevabaza-bot. Используйте /health или /ping для проверки статуса или обратитесь к боту в Telegram.'));

app.get('/return', async (req, res) => {
  console.log('Received /return request with query:', req.query);
  const { paymentId: localPaymentId } = req.query;
  if (localPaymentId) {
    try {
      const user = await User.findOne({ localPaymentId });
      if (user) {
        const payment = await getPayment(user.paymentId);
        if (payment.status === 'succeeded') {
          if (!user.joinedChannel && !user.processed) {
            await sendInviteLink(user, { chat: { id: user.chatId } }, user.paymentId);
            await User.updateOne({ userId: user.userId }, { processed: true });
            res.send('Оплата успешно подтверждена! Ссылка на канал отправлена в чат.');
          } else {
            res.send('Оплата уже обработана. Ссылка на канал была отправлена ранее.');
          }
        } else {
          await bot.telegram.sendMessage(user.chatId, `Оплата ещё не подтверждена. Статус: ${payment.status}. Попробуйте /checkpayment позже.`);
          res.send('Оплата ещё не подтверждена.');
        }
      } else {
        console.warn(`No user found for localPaymentId: ${localPaymentId}`);
        res.status(404).send('Пользователь не найден.');
      }
    } catch (error) {
      console.error('Error processing /return:', error.stack);
      res.status(500).send('Ошибка при обработке платежа.');
    }
  } else {
    res.status(400).send('Отсутствует paymentId.');
  }
});

app.get('/health', (req, res) => res.sendStatus(200));

app.post('/webhook/yookassa', handleYookassaWebhook);

const PORT = process.env.PORT || 10000;
console.log(`Starting server on port ${PORT}`);
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));