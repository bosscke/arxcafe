// Mongoose model for ai_explanations_v2 collection
const mongoose = require('mongoose');

const AiExplanationV2Schema = new mongoose.Schema({
  cache_key: { 
    type: String, 
    required: true, 
    unique: true,
    index: true 
  },
  question_id: { 
    type: String, 
    required: true,
    index: true 
  },
  quiz_id: { 
    type: String, 
    default: null 
  },
  short_text: { 
    type: String, 
    required: true 
  },
  long_text: { 
    type: String, 
    required: true, 
    default: '' 
  },
  model: { 
    type: String, 
    required: true 
  },
  expandable: { 
    type: Boolean, 
    required: true, 
    default: true 
  },
  confidence: { 
    type: String, 
    required: true, 
    enum: ['complete', 'partial'], 
    default: 'complete' 
  },
  created_at: { 
    type: Date, 
    required: true, 
    default: Date.now 
  }
}, { 
  collection: 'ai_explanations_v2',
  timestamps: false 
});

module.exports = mongoose.model('AiExplanationV2', AiExplanationV2Schema);
