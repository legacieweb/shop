const mongoose = require("mongoose");

const reviewRequestSchema = new mongoose.Schema({
  seller: {
    type: String,
    required: true,
    index: true
  },
  orderId: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  productId: {
    type: String,
    required: true
  },
  productName: {
    type: String,
    required: true
  },
  productImage: {
    type: String
  },
  buyerEmail: {
    type: String,
    required: true
  },
  status: {
    type: String,
    enum: ['sent', 'reviewed', 'expired'],
    default: 'sent'
  },
  emailContent: {
    type: String
  },
  sentAt: {
    type: Date,
    default: Date.now
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
reviewRequestSchema.index({ seller: 1, status: 1 });
reviewRequestSchema.index({ seller: 1, createdAt: -1 });

// Update the updatedAt field before saving
reviewRequestSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  next();
});

module.exports = mongoose.model("ReviewRequest", reviewRequestSchema);