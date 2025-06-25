const mongoose = require('mongoose');
require('dotenv').config();

// Установка strictQuery для устранения предупреждения Mongoose
mongoose.set('strictQuery', true);

mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
})
    .then(() => console.log('Connected to MongoDB:', process.env.MONGODB_URI.replace(/\/\/.*@/, '//[hidden]@')))
    .catch(err => console.error('MongoDB connection error:', err.message, err.stack));

module.exports = mongoose;