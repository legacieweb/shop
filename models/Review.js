const mongoose = require("mongoose");

const reviewSchema = new mongoose.Schema({
  seller: {
    type: String,
    required: true,
    index: true
  },
  productId: {
    type: String,
    required: true,
    index: true
  },
  productName: {
    type: String,
    required: true
  },
  productImage: {
    type: String
  },
  orderId: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  buyerEmail: {
    type: String,
    required: true
  },
  buyerName: {
    type: String
  },
  rating: {
    type: Number,
    required: true,
    min: 1,
    max: 5
  },
  text: {
    type: String,
    required: true,
    maxlength: 2000
  },
  published: {
    type: Boolean,
    default: false
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
});

// Compound indexes for efficient queries
reviewSchema.index({ seller: 1, productId: 1 });
reviewSchema.index({ seller: 1, published: 1 });
reviewSchema.index({ productId: 1, seller: 1, published: 1 });

// Update the updatedAt field before saving
reviewSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  next();
});

module.exports = mongoose.model("Review", reviewSchema);