const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  id: { type: String, unique: true, required: true },
  username: { type: String, unique: true, required: true },
  email: { type: String, unique: true, required: true },
  password: { type: String, required: true },
  role: { type: String, default: 'buyer' },
  status: { type: String, default: 'active' },
  plan: { type: String },
  product_type: { type: String },
  createdAt: { type: Date, default: Date.now },
  shopSettings: { type: mongoose.Schema.Types.Mixed, default: {} },
  trialUsed: { type: Boolean, default: false },
  trial: { type: String, default: 'none' },
  trialActive: { type: Boolean, default: false },
  trialEndsAt: { type: Date },
  nextPaymentDate: { type: Date },
  subscriptionWeeks: { type: Number },
  subscriptionPayments: [{ type: mongoose.Schema.Types.Mixed }],
  customTheme: { type: mongoose.Schema.Types.Mixed },
  layoutTheme: { type: String },
  layoutHTML: { type: String },
  themeUpdatedAt: { type: Date },
  forceLogoutAt: { type: Date }
});

// Remove sensitive fields when converting to JSON
userSchema.methods.toJSON = function() {
  const user = this.toObject();
  delete user.password;
  delete user.forceLogoutAt;
  return user;
};

module.exports = mongoose.model('User', userSchema);