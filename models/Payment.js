const mongoose = require('mongoose');

const paymentSchema = new mongoose.Schema({
  seller: { type: String, required: true }, // username
  amount: { type: Number, required: true }, // major currency units (e.g., NGN)
  currency: { type: String, default: 'NGN' },
  gateway: { type: String, default: 'paystack' },
  reference: { type: String, required: true, unique: true },
  status: { type: String, enum: ['success', 'failed', 'pending'], default: 'pending' },
  meta: { type: Object, default: {} },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

paymentSchema.index({ seller: 1, status: 1, createdAt: -1 });

paymentSchema.pre('save', function(next){
  this.updatedAt = new Date();
  next();
});

module.exports = mongoose.model('Payment', paymentSchema);