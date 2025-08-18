const mongoose = require('mongoose');

const wishlistSchema = new mongoose.Schema({
  buyer: { type: String, required: true },
  productId: { type: String, required: true },
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Wishlist', wishlistSchema);