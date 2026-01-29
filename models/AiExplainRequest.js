// Mongoose model for ai_explain_requests collection
const mongoose = require('mongoose');

const AiExplainRequestSchema = new mongoose.Schema({
  created_at: { 
    type: Date, 
    required: true, 
    default: Date.now,
    index: true 
  },
  ip: { 
    type: String, 
    required: true 
  },
  user_id: { 
    type: String, 
    default: null 
  },
  quiz_id: { 
    type: String, 
    default: null 
  },
  question_id: { 
    type: String, 
    default: null 
  },
  explanation_level: { 
    type: String, 
    required: true, 
    enum: ['short', 'long'], 
    default: 'short' 
  },
  cached: { 
    type: Boolean, 
    required: true, 
    default: false 
  },
  provider_http_status: { 
    type: Number, 
    default: null 
  },
  provider_status: { 
    type: String, 
    default: null 
  },
  provider_message: { 
    type: String, 
    default: null 
  }
}, { 
  collection: 'ai_explain_requests',
  timestamps: false 
});

// Compound indexes for analytics
AiExplainRequestSchema.index({ ip: 1, created_at: 1 });
AiExplainRequestSchema.index({ user_id: 1, created_at: 1 });
AiExplainRequestSchema.index({ quiz_id: 1, created_at: 1 });

module.exports = mongoose.model('AiExplainRequest', AiExplainRequestSchema);
