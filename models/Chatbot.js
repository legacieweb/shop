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
    initialState: { type: String, enum: ['open', 'closed'], default: 'closed' },
    // Launcher button configuration (supports image stored in MongoDB)
    button: {
      type: { type: String, enum: ['text', 'image'], default: 'text' },
      imageUrl: { type: String, default: '' },
      text: { type: String, default: '' },
      emoji: { type: String, default: '💬' },
      textColor: { type: String, default: '#ffffff' },
      bgColor: { type: String, default: '#4f46e5' },
      radius: { type: Number, default: 999 },
      size: { type: String, enum: ['sm', 'md', 'lg'], default: 'md' },
      shadow: { type: Boolean, default: true }
    }
  },
  enabled: { type: Boolean, default: false }, // deployment flag
  training: {
    status: { type: String, enum: ['not_trained', 'training', 'trained', 'failed'], default: 'not_trained' },
    lastTrainedAt: { type: Date, default: null },
    // Capability toggles persisted from dashboard
    capabilities: {
      products: { type: Boolean, default: true },
      shipping: { type: Boolean, default: false },
      delivery: { type: Boolean, default: false },
      payments: { type: Boolean, default: false }
    },
    // Keyword rules only (simplified training)
    rules: [
      {
        id: { type: String, default: () => new mongoose.Types.ObjectId().toString() },
        pattern: { type: String, default: '' },
        match: { type: String, enum: ['contains', 'exact', 'regex'], default: 'contains' },
        response: { type: String, default: '' }
      }
    ],
    // Conversation examples (optional)
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