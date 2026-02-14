const mongoose = require('mongoose');

const quizProgressSchema = new mongoose.Schema(
  {
    user_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true
    },
    quiz_id: {
      type: String,
      required: true,
      index: true
    },
    progress: {
      type: mongoose.Schema.Types.Mixed,
      default: {}
    }
  },
  {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }
  }
);

quizProgressSchema.index({ user_id: 1, quiz_id: 1 }, { unique: true });

module.exports = mongoose.model('QuizProgress', quizProgressSchema);
