const mongoose = require('mongoose');

const passwordResetTokenSchema = new mongoose.Schema({
  user_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  token_hash: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  expires_at: {
    type: Date,
    required: true,
    index: { expires: 0 }
  },
  used_at: {
    type: Date,
    default: null,
    index: true
  },
  created_at: {
    type: Date,
    default: Date.now,
    index: true
  }
});

module.exports = mongoose.model('PasswordResetToken', passwordResetTokenSchema);
