const mongoose = require('mongoose');

const productSchema = new mongoose.Schema({
  id: { type: String, unique: true, required: true },
  name: { type: String, required: true },
  description: { type: String },
  // New: rich specifications field. Flexible to accept string, array, or key-value map
  specifications: { type: mongoose.Schema.Types.Mixed, default: null },
  price: { type: Number, required: true },
  seller: { type: String, required: true },
  image: { type: String },
  media: [{ type: String }],
  gallery: [{ type: String }],
  category: { type: String },
  inventory: { type: Number },
  variants: [{ type: mongoose.Schema.Types.Mixed }],
  colorVariants: [{ type: mongoose.Schema.Types.Mixed }],
  strikeThroughPrice: { type: Number },
  shipping: { type: String },
  tags: [{ type: String }],
  featured: { type: Boolean, default: false },
  marketplacePush: { type: Boolean, default: false },
  marketplacePushDate: { type: Date },
  views: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Product', productSchema);