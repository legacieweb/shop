const mongoose = require('mongoose');

const ChatbotSchema = new mongoose.Schema({
  seller: { type: String, required: true, unique: true, index: true },
  botName: { type: String, default: 'Shop Assistant' },
  botTone: { type: String, enum: ['friendly', 'professional', 'playful', 'concise'], default: 'friendly' },
  welcomeMessage: { type: String, default: 'Hi! How can I help you today?' },
  knowledgeBase: { type: String, default: '' },
  widget: {
    theme: { type: String, default: 'indigo' },
    accentColor: { type: String, default: '#4f46e5' },
    position: { type: String, enum: ['left', 'right'], default: 'right' },
    initialState: { type: String, enum: ['open', 'closed'], default: 'closed' }
  },
  enabled: { type: Boolean, default: false }, // deployment flag
  training: {
    status: { type: String, enum: ['not_trained', 'training', 'trained', 'failed'], default: 'not_trained' },
    lastTrainedAt: { type: Date, default: null },
    conversation: [
      {
        role: { type: String, enum: ['system', 'user', 'assistant'], required: true },
        content: { type: String, required: true },
        ts: { type: Date, default: Date.now }
      }
    ]
  }
}, { timestamps: true });

module.exports = mongoose.model('Chatbot', ChatbotSchema);