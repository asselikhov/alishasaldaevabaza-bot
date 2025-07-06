const mongoose = require('mongoose');

const UserSchema = new mongoose.Schema({
  userId: String,
  chatId: String,
  paymentStatus: { type: String, default: 'pending' },
  paymentId: String,
  localPaymentId: String,
  joinedChannel: { type: Boolean, default: false },
  inviteLink: String,
  inviteLinkExpires: Number,
  inviteLinkUsed: { type: Boolean, default: false },
  firstName: String,
  username: String,
  phoneNumber: String,
  email: String,
  paymentDate: Date,
  paymentDocument: { type: String, default: null },
  lastActivity: { type: Date, default: Date.now },
  processed: { type: Boolean, default: false },
});

const User = mongoose.models.User || mongoose.model('User', UserSchema);

module.exports = User;