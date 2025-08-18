const mongoose = require('mongoose');

const cartSchema = new mongoose.Schema({
  buyer: { type: String, required: true },
  productId: { type: String, required: true },
  seller: { type: String, required: true },
  name: { type: String },
  price: { type: Number },
  image: { type: String },
  variant: { type: mongoose.Schema.Types.Mixed },
  color: { type: String },
  quantity: { type: Number, default: 1 },
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Cart', cartSchema);