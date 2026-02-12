const mongoose = require('mongoose');

const domainStatSchema = new mongoose.Schema(
  {
    domain: { type: String, required: true },
    correct: { type: Number, required: true },
    total: { type: Number, required: true }
  },
  { _id: false }
);

const quizAttemptSchema = new mongoose.Schema({
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
  phase: {
    type: Number,
    default: null,
    index: true
  },
  score: {
    type: Number,
    required: true
  },
  total: {
    type: Number,
    required: true
  },
  percentage: {
    type: Number,
    required: true,
    index: true
  },
  domain_stats: {
    type: [domainStatSchema],
    default: []
  },
  created_at: {
    type: Date,
    default: Date.now,
    index: true
  }
});

quizAttemptSchema.index({ user_id: 1, quiz_id: 1, created_at: -1 });

module.exports = mongoose.model('QuizAttempt', quizAttemptSchema);
