const mongoose = require('mongoose');

const subscriptionPlanSchema = new mongoose.Schema({
  id: { type: String, unique: true, required: true },
  name: { type: String, required: true },
  description: { type: String },
  price: { type: Number, required: true },
  interval: { type: String, required: true }, // 'monthly', 'yearly', etc.
  features: [{ type: String }],
  limits: { type: mongoose.Schema.Types.Mixed },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('SubscriptionPlan', subscriptionPlanSchema);