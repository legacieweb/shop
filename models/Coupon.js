const mongoose = require('mongoose');

const couponSchema = new mongoose.Schema({
  id: { type: String, unique: true, required: true },
  code: { type: String, required: true },
  seller: { type: String, required: true },
  type: { type: String, required: true }, // 'percentage' or 'fixed'
  value: { type: Number, required: true },
  status: { type: String, default: 'active' },
  expiryDate: { type: Date },
  usageLimit: { type: Number },
  usedCount: { type: Number, default: 0 },
  totalSavings: { type: Number, default: 0 },
  minOrderAmount: { type: Number },
  applicableProducts: { type: String, default: 'all' }, // 'all' or 'specific'
  productIds: [{ type: String }],
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Coupon', couponSchema);