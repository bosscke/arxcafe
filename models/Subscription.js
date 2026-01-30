const mongoose = require('mongoose');

const subscriptionSchema = new mongoose.Schema({
  user_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  stripe_customer_id: {
    type: String,
    required: true
  },
  stripe_subscription_id: {
    type: String,
    required: true
  },
  status: {
    type: String,
    enum: ['active', 'canceled', 'past_due', 'trialing', 'incomplete'],
    required: true
  },
  current_period_end: {
    type: Date,
    required: true
  },
  created_at: {
    type: Date,
    default: Date.now
  },
  updated_at: {
    type: Date,
    default: Date.now
  }
});

// Index for efficient lookups
subscriptionSchema.index({ user_id: 1 });
subscriptionSchema.index({ stripe_customer_id: 1 });
subscriptionSchema.index({ stripe_subscription_id: 1 });

module.exports = mongoose.model('Subscription', subscriptionSchema);
