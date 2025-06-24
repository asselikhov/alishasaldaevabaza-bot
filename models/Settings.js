const mongoose = require('../config/db');

const SettingsSchema = new mongoose.Schema({
  channelDescription: { type: String, default: 'Добро пожаловать в наш магазин! Мы предлагаем стильную одежду по доступным ценам с быстрой доставкой. Подписывайтесь на канал для эксклюзивных предложений! 😊' },
  supportLink: { type: String, default: 'https://t.me/Eagleshot' },
  welcomeMessage: { type: String, default: 'ЙОУ ЧИКСЫ 😎\n\nЯ рада видеть вас здесь, лютые модницы 💅\n\nДержите меня семеро, потому что я вас научу пипэц как выгодно брать шмотьё🤭🤫\n\nЖду вас в своём клубе шаболятниц 🤝❤️' },
  paymentAmount: { type: Number, default: 399 },
  paidWelcomeMessage: { type: String, default: '🎉 Добро пожаловать в закрытый клуб модниц! 🎉\n\nВы успешно оплатили доступ к эксклюзивному контенту. Наслаждайтесь шопингом и стильными находками! 💃\n\nЕсли есть вопросы, я всегда рядом!' },
});

module.exports = mongoose.model('Settings', SettingsSchema);