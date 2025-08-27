const mongoose = require('mongoose');

const orderSchema = new mongoose.Schema({
  id: { type: String, unique: true, required: true },
  orderId: { type: String, unique: true, required: true },
  productId: { type: String, required: true },
  productName: { type: String },
  productImage: { type: String },
  seller: { type: String, required: true },
  buyer: { type: mongoose.Schema.Types.Mixed, required: true },
  quantity: { type: Number, required: true },
  subtotal: { type: Number },
  total: { type: Number },
  status: { type: String, default: 'Pending' },
  currency: { type: String, default: 'USD' },
  variant: { type: mongoose.Schema.Types.Mixed },
  color: { type: mongoose.Schema.Types.Mixed },
  delivery: { type: mongoose.Schema.Types.Mixed },
  shopSettings: { type: mongoose.Schema.Types.Mixed },
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Order', orderSchema);