const mongoose = require('mongoose');

const promotionSchema = new mongoose.Schema({
  type: { type: String, enum: ['campaign', 'ad'], required: true },
  seller: { type: String, required: true }, // username
  productId: { type: String }, // for ads
  name: { type: String }, // campaign name
  headline: { type: String }, // ad headline
  budget: { type: Number, default: 0 },
  days: { type: Number, default: 0 },
  reach: { type: Number, default: 0 },
  status: { type: String, enum: ['Pending', 'Approved', 'Rejected'], default: 'Pending' },
  // Simple performance metrics
  impressions: { type: Number, default: 0 },
  clicks: { type: Number, default: 0 },
  conversions: { type: Number, default: 0 },
  spend: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

promotionSchema.index({ seller: 1, type: 1, status: 1 });

promotionSchema.pre('save', function(next){
  this.updatedAt = new Date();
  next();
});

module.exports = mongoose.model('Promotion', promotionSchema);