const mongoose = require('mongoose');

// Stores raw image data in MongoDB
// Use for persistent product images that survive server restarts
const imageSchema = new mongoose.Schema(
  {
    filename: { type: String },
    contentType: { type: String, required: true },
    data: { type: Buffer, required: true },
    metadata: { type: Object },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Image', imageSchema);