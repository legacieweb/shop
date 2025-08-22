const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const os = require("os");
const nodemailer = require("nodemailer");
const crypto = require("crypto");
const bcrypt = require("bcrypt");
const dotenv = require("dotenv");

// Load environment variables
dotenv.config();

// Import Mongoose models
const User = require("./models/User");
const Product = require("./models/Product");
const Order = require("./models/Order");
const Cart = require("./models/Cart");
const Wishlist = require("./models/Wishlist");
const Coupon = require("./models/Coupon");
const SubscriptionPlan = require("./models/SubscriptionPlan");
const Image = require("./models/Image");

// Import email service
const emailService = require("./email");

const TRIAL_DAYS = 4;

const app = express();
const PORT = 3000;
const HOST = "0.0.0.0";

// -------------------------------
// 📁 Directory Setup
// -------------------------------
const uploadsFolder = path.join(__dirname, "public", "uploads");
if (!fs.existsSync(uploadsFolder)) {
  fs.mkdirSync(uploadsFolder, { recursive: true });
}

// -------------------------------
// 📦 Multer Upload Setup
// -------------------------------
// Default disk storage (still used for non-product image uploads like hero/category if desired)
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsFolder),
  filename: (req, file, cb) => {
    const unique = Date.now() + "-" + Math.floor(Math.random() * 1e9);
    const ext = path.extname(file.originalname);
    cb(null, `${unique}${ext}`);
  }
});
const upload = multer({ storage });

// Separate memory storage for product image persistence into MongoDB
const memoryUpload = multer({ storage: multer.memoryStorage() });

// -------------------------------
// 🔐 Middleware
// -------------------------------
app.use(cors());
app.use(express.json({ limit: "500mb" }));

// ✅ Serve static files under /public (CSS, JS) and legacy uploads
app.use("/uploads", express.static(path.join(__dirname, "public", "uploads")));
app.use(express.static(path.join(__dirname, "public")));

// Serve images stored in MongoDB by ID
app.get('/images/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const img = await Image.findById(id);
    if (!img) return res.status(404).send('Not found');
    res.set('Content-Type', img.contentType || 'application/octet-stream');
    return res.send(img.data);
  } catch (e) {
    console.error('Fetch image error:', e);
    return res.status(400).send('Invalid image id');
  }
});

// ✅ Serve dashboard, themes, and shop HTML files
app.get("/dashboard", (req, res) => {
  res.sendFile(path.join(__dirname, "dashboard", "index.html"));
});

app.get("/themes", (req, res) => {
  res.sendFile(path.join(__dirname, "themes", "index.html"));
});

app.get("/shop", (req, res) => {
  res.sendFile(path.join(__dirname, "shop", "index.html"));
});

app.get("/customer", (req, res) => {
  res.sendFile(path.join(__dirname, "customer", "index.html"));
});

app.get("/admin-panel", (req, res) => {
  res.sendFile(path.join(__dirname, "admin-panel.html"));
});

// -------------------------------
// 🛠️ Helper: Subscription Limits
// -------------------------------
function getSubscriptionLimits(plan) {
  const plans = {
    free: { maxProducts: 10, coupons: false, inventoryTracking: false },
    basic: { maxProducts: 50, coupons: false, inventoryTracking: true },
    pro: { maxProducts: 100, coupons: true, inventoryTracking: true },
    premium: { maxProducts: -1, coupons: true, inventoryTracking: true }
  };
  const normalizedPlan = (plan || 'free').toLowerCase();
  return plans[normalizedPlan] || plans.free;
}

// -------------------------------
// 🗄️ Database Connection
// -------------------------------
mongoose.connect(process.env.MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
});

const db = mongoose.connection;
db.on('error', console.error.bind(console, 'MongoDB connection error:'));
db.once('open', () => {
  console.log('✅ Connected to MongoDB database with Mongoose');
});

// -------------------------------
// ✅ API ROUTES (Must come BEFORE static catch-all)
// -------------------------------

// 🔹 INSERT: Add to collection
app.post("/insert", async (req, res) => {
  try {
    const collection = req.body.collection || "default";
    const data = { ...req.body.payload };

    if (!data || typeof data !== "object") {
      return res.status(400).json({ success: false, message: "Invalid payload" });
    }

    let result;

    // User validation
    if (collection === "users" && data.email) {
      const exists = await User.findOne({ email: data.email });
      if (exists) {
        return res.status(409).json({ success: false, message: "Email already registered" });
      }
    }

    // Product validation
    if (collection === "products") {
      const required = ["name", "price", "seller"];
      for (const field of required) {
        if (!data[field]) {
          return res.status(400).json({ success: false, message: `Missing required field: ${field}` });
        }
      }

      const seller = await User.findOne({ username: data.seller });
      if (seller) {
        const limits = getSubscriptionLimits(seller.plan);
        const currentCount = await Product.countDocuments({ seller: data.seller });
        if (limits.maxProducts !== -1 && currentCount >= limits.maxProducts) {
          return res.status(403).json({
            success: false,
            message: "Product limit reached",
            data: {
              limit: limits.maxProducts,
              current: currentCount
            }
          });
        }
      }
      data.createdAt = new Date();
    }

    // Coupon validation
    if (collection === "coupons") {
      const seller = await User.findOne({ username: data.seller });
      if (seller) {
        const limits = getSubscriptionLimits(seller.plan);
        console.log(`Coupon creation attempt: user=${data.seller}, plan=${seller.plan}, couponsAllowed=${limits.coupons}`);
        if (!limits.coupons) {
          console.log(`Coupon creation blocked for user ${data.seller} on plan ${seller.plan}`);
          return res.status(403).json({ 
            success: false, 
            message: `Coupon creation not allowed on your plan (${seller.plan}). Upgrade to Pro or higher.`,
            requiredPlan: "pro",
            currentPlan: seller.plan
          });
        }
      } else {
        console.log(`Seller not found: ${data.seller}`);
        return res.status(404).json({ 
          success: false, 
          message: "Seller not found. Please ensure the user exists."
        });
      }
    }

    // Insert based on collection type
    switch (collection) {
      case "users":
        // Generate unique ID if not provided
        if (!data.id) {
          data.id = `user_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        }
        result = await User.create(data);
        break;
      case "products":
        // Generate unique ID if not provided
        if (!data.id) {
          data.id = `prod_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        }
        // Normalize any image paths that might already be absolute server paths
        if (typeof data.image === 'string') {
          // Accept '/images/<id>', 'images/<id>', '/uploads/<file>', 'uploads/<file>' as-is
          if (data.image.startsWith('http')) {
            // leave absolute URLs
          } else if (data.image.startsWith('/images/') || data.image.startsWith('images/')) {
            data.image = data.image.startsWith('/') ? data.image : '/' + data.image;
          } else if (data.image.startsWith('/uploads/') || data.image.startsWith('uploads/')) {
            data.image = data.image.startsWith('/') ? data.image : '/' + data.image;
          }
        }
        if (Array.isArray(data.gallery)) {
          data.gallery = data.gallery.map(x => {
            if (typeof x !== 'string') return x;
            if (x.startsWith('http')) return x;
            if (x.startsWith('/images/') || x.startsWith('images/')) return x.startsWith('/') ? x : '/' + x;
            if (x.startsWith('/uploads/') || x.startsWith('uploads/')) return x.startsWith('/') ? x : '/' + x;
            return x;
          });
        }
        if (Array.isArray(data.media)) {
          data.media = data.media.map(x => {
            if (typeof x !== 'string') return x;
            if (x.startsWith('http')) return x;
            if (x.startsWith('/images/') || x.startsWith('images/')) return x.startsWith('/') ? x : '/' + x;
            if (x.startsWith('/uploads/') || x.startsWith('uploads/')) return x.startsWith('/') ? x : '/' + x;
            return x;
          });
        }
        result = await Product.create(data);
        break;
      case "orders":
        result = await Order.create(data);
        break;
      case "cart":
        result = await Cart.create(data);
        break;
      case "wishlist":
        result = await Wishlist.create(data);
        break;
      case "coupons":
        // Generate unique ID if not provided
        if (!data.id) {
          data.id = `coupon_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        }
        result = await Coupon.create(data);
        break;
      case "subscription-plans":
        result = await SubscriptionPlan.create(data);
        break;
      default:
        return res.status(400).json({ success: false, message: "Invalid collection" });
    }

    res.status(201).json({ success: true, data: result });
  } catch (error) {
    console.error("Insert error:", error);
    console.error("Error details:", {
      name: error.name,
      message: error.message,
      code: error.code,
      collection: req.body.collection
    });
    res.status(500).json({ 
      success: false, 
      message: "Server error during insert",
      error: error.message 
    });
  }
});

// 🔹 FIND: Query collection (Always returns an array)
app.get("/find", async (req, res) => {
  try {
    const collectionName = req.query.collection || "default";

    // Copy query params but remove 'collection'
    const query = { ...req.query };
    delete query.collection;

    // Optional: Type conversion for booleans/numbers
    Object.keys(query).forEach(key => {
      if (query[key] === "true") query[key] = true;
      else if (query[key] === "false") query[key] = false;
      else if (!isNaN(query[key])) query[key] = Number(query[key]);
    });

    let result = [];

    switch (collectionName) {
      case "users":
        result = await User.find(query);
        break;
      case "products":
        result = await Product.find(query);
        break;
      case "orders":
        result = await Order.find(query);
        break;
      case "cart":
        result = await Cart.find(query);
        break;
      case "wishlist":
        result = await Wishlist.find(query);
        break;
      case "coupons":
        result = await Coupon.find(query);
        break;
      case "subscription-plans":
        result = await SubscriptionPlan.find(query);
        break;
      default:
        return res.status(400).json({ success: false, message: "Invalid collection" });
    }

    // ✅ Always return an array
    res.status(200).json({ success: true, data: Array.isArray(result) ? result : [] });
  } catch (error) {
    console.error("Find error:", error);
    res.status(500).json({ success: false, message: "Server error during find" });
  }
});

// 🔹 FIND ONE: By ID
app.get("/find-one", async (req, res) => {
  try {
    const { collection, id } = req.query;
    if (!collection || !id) {
      return res.status(400).json({ success: false, message: "Missing collection or id" });
    }

    let result;

    switch (collection) {
      case "users":
        result = await User.findById(id);
        break;
      case "products":
        result = await Product.findById(id);
        break;
      case "orders":
        result = await Order.findById(id);
        break;
      case "cart":
        result = await Cart.findById(id);
        break;
      case "wishlist":
        result = await Wishlist.findById(id);
        break;
      case "coupons":
        result = await Coupon.findById(id);
        break;
      case "subscription-plans":
        result = await SubscriptionPlan.findById(id);
        break;
      default:
        return res.status(400).json({ success: false, message: "Invalid collection" });
    }

    if (!result) {
      return res.status(404).json({ success: false, message: "Item not found" });
    }

    res.json({ success: true, data: result });
  } catch (error) {
    console.error("FindOne error:", error);
    res.status(500).json({ success: false, message: "Server error during findOne" });
  }
});

// 🔹 UPDATE
app.post("/update", async (req, res) => {
  try {
    const { collection, query, updates } = req.body;
    if (!collection || !query || !updates) {
      return res.status(400).json({ success: false, message: "Missing required fields" });
    }

    let result;

    switch (collection) {
      case "users":
        result = await User.updateMany(query, updates);
        break;
      case "products":
        // Normalize image fields if present in updates
        if (updates && updates.$set) {
          const s = updates.$set;
          if (typeof s.image === 'string') {
            if (!s.image.startsWith('http')) {
              if (s.image.startsWith('/images/') || s.image.startsWith('images/')) s.image = s.image.startsWith('/') ? s.image : '/' + s.image;
              else if (s.image.startsWith('/uploads/') || s.image.startsWith('uploads/')) s.image = s.image.startsWith('/') ? s.image : '/' + s.image;
            }
          }
          if (Array.isArray(s.gallery)) {
            s.gallery = s.gallery.map(x => (typeof x === 'string' && !x.startsWith('http'))
              ? (x.startsWith('/images/') || x.startsWith('images/') || x.startsWith('/uploads/') || x.startsWith('uploads/'))
                ? (x.startsWith('/') ? x : '/' + x)
                : x
              : x);
          }
          if (Array.isArray(s.media)) {
            s.media = s.media.map(x => (typeof x === 'string' && !x.startsWith('http'))
              ? (x.startsWith('/images/') || x.startsWith('images/') || x.startsWith('/uploads/') || x.startsWith('uploads/'))
                ? (x.startsWith('/') ? x : '/' + x)
                : x
              : x);
          }
        }
        result = await Product.updateMany(query, updates);
        break;
      case "orders":
        result = await Order.updateMany(query, updates);
        break;
      case "cart":
        result = await Cart.updateMany(query, updates);
        break;
      case "wishlist":
        result = await Wishlist.updateMany(query, updates);
        break;
      case "coupons":
        result = await Coupon.updateMany(query, updates);
        break;
      case "subscription-plans":
        result = await SubscriptionPlan.updateMany(query, updates);
        break;
      default:
        return res.status(400).json({ success: false, message: "Invalid collection" });
    }

    if (result.modifiedCount === 0) {
      return res.status(404).json({ success: false, message: "No matching document found" });
    }

    res.json({ success: true, data: { updated: result.modifiedCount } });
  } catch (error) {
    console.error("Update error:", error);
    res.status(500).json({ success: false, message: "Server error during update" });
  }
});

// 🔹 DELETE
app.post("/delete", async (req, res) => {
  try {
    const { collection, query } = req.body;
    if (!collection || !query) {
      return res.status(400).json({ success: false, message: "Missing collection or query" });
    }

    let result;

    switch (collection) {
      case "users":
        result = await User.deleteMany(query);
        break;
      case "products":
        result = await Product.deleteMany(query);
        break;
      case "orders":
        result = await Order.deleteMany(query);
        break;
      case "cart":
        result = await Cart.deleteMany(query);
        break;
      case "wishlist":
        result = await Wishlist.deleteMany(query);
        break;
      case "coupons":
        result = await Coupon.deleteMany(query);
        break;
      case "subscription-plans":
        result = await SubscriptionPlan.deleteMany(query);
        break;
      default:
        return res.status(400).json({ success: false, message: "Invalid collection" });
    }

    if (result.deletedCount === 0) {
      return res.status(404).json({ success: false, message: "Not found" });
    }

    res.json({ success: true, data: { deleted: result.deletedCount } });
  } catch (error) {
    console.error("Delete error:", error);
    res.status(500).json({ success: false, message: "Server error during delete" });
  }
});

// 🔹 Check seller availability
app.post("/check-seller", async (req, res) => {
  try {
    const { email, storeName } = req.body;
    if (!email || !storeName) {
      return res.status(400).json({ success: false, message: "Email and store name required" });
    }

    const users = await User.find({});
    const exists = users.some(u => u.email === email || u.username === storeName);

    res.json({ success: true, data: { available: !exists } });
  } catch (error) {
    console.error("Check seller error:", error);
    res.status(500).json({ success: false, message: "Server error during seller check" });
  }
});

// -------------------------------
// 🖼️ Upload Files (Products) -> Persist images in MongoDB
// -------------------------------
app.post("/upload-files", memoryUpload.fields([
  { name: "main", maxCount: 1 },
  { name: "media_0", maxCount: 1 },
  { name: "media_1", maxCount: 1 },
  { name: "media_2", maxCount: 1 },
  { name: "media_3", maxCount: 1 },
  { name: "media_4", maxCount: 1 },
]), async (req, res) => {
  try {
    const files = req.files || {};
    const main = files.main?.[0] || null;
    const media = Object.keys(files)
      .filter(k => k.startsWith("media_"))
      .flatMap(k => files[k] || []);

    // Helper to save a single file buffer to Mongo and return URL
    const saveToMongo = async (f) => {
      const doc = await Image.create({
        filename: f.originalname,
        contentType: f.mimetype,
        data: f.buffer,
        metadata: { fieldname: f.fieldname, size: f.size },
      });
      return `/images/${doc._id.toString()}`;
    };

    const mainImageURL = main ? await saveToMongo(main) : "";
    const mediaURLs = [];
    for (const f of media) {
      mediaURLs.push(await saveToMongo(f));
    }

    // Optionally: persist to Product if productId is provided
    if (req.body?.productId) {
      const updates = { $set: { updatedAt: new Date() } };
      if (mainImageURL) updates.$set.image = mainImageURL;
      if (mediaURLs.length > 0) {
        updates.$push = { gallery: { $each: mediaURLs } };
        updates.$set.media = mediaURLs; // also persist in media array
      }
      await Product.updateOne(
        { id: req.body.productId },
        updates
      );
    }

    return res.json({ success: true, data: { mainImageURL, mediaURLs } });
  } catch (err) {
    console.error("Image upload (Mongo) error:", err);
    return res.status(500).json({ success: false, message: "Server error during image upload" });
  }
});

// -------------------------------
// 🧩 Layout Templates
// -------------------------------
const allowedLayouts = [
  "classic", "modern", "cyber", "vintage", "minimalist",
  "nature", "elegant", "luxury", "artistic", "bold",
  "professional", "freestyle", "futuristic"
];

// ✅ Serve layout HTML files securely
app.get("/layouts/:layoutName", (req, res) => {
  const layoutName = req.params.layoutName;

  if (!layoutName || typeof layoutName !== 'string') {
    return res.status(400).json({ success: false, message: "Invalid layout name" });
  }

  if (!allowedLayouts.includes(layoutName)) {
    return res.status(400).json({ success: false, message: "Invalid layout" });
  }

  const layoutPath = path.join(__dirname, "layouts", `${layoutName}.html`);
  if (!fs.existsSync(layoutPath)) {
    return res.status(404).json({ success: false, message: "Layout file not found" });
  }

  // Return JSON instead of HTML
  const htmlContent = fs.readFileSync(layoutPath, "utf8");
  res.json({ success: true, data: { html: htmlContent } });
});

// ✅ Upload hero image and save to user theme
app.post("/upload-hero-image", upload.single("heroImage"), async (req, res) => {
  try {
    const { username, imageType = "heroImage" } = req.body;
    
    if (!username) {
      return res.status(400).json({ success: false, message: "Username is required" });
    }

    if (!req.file) {
      return res.status(400).json({ success: false, message: "No image file provided" });
    }

    const imageUrl = `/uploads/${req.file.filename}`;
    
    const user = await User.findOne({ username });
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    const currentTheme = user.customTheme || {};
    
    const updatedTheme = {
      ...currentTheme,
      [imageType]: imageUrl,
      lastUpdated: new Date().toISOString()
    };

    const updatedUser = await User.findByIdAndUpdate(
      user._id,
      { customTheme: updatedTheme },
      { new: true }
    );

    if (!updatedUser) {
      return res.status(500).json({ success: false, message: "Failed to save image to user theme" });
    }

    console.log(`✅ Hero image uploaded for ${username}: ${imageUrl}`);
    
    res.json({
      success: true,
      data: {
        imageUrl,
        message: "Hero image uploaded and saved successfully"
      }
    });

  } catch (err) {
    console.error("Hero image upload error:", err);
    res.status(500).json({ success: false, message: "Server error during image upload" });
  }
});

// ✅ Upload category hero background image
app.post("/upload-category-hero", upload.single("categoryImage"), async (req, res) => {
  try {
    const { username, categoryName } = req.body;
    
    if (!username || !categoryName) {
      return res.status(400).json({ success: false, message: "Username and category name are required" });
    }

    if (!req.file) {
      return res.status(400).json({ success: false, message: "No image file provided" });
    }

    const imageUrl = `/uploads/${req.file.filename}`;
    
    const user = await User.findOne({ username });
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    const currentTheme = user.customTheme || {};
    const categoryHeroes = currentTheme.categoryHeroes || {};
    
    categoryHeroes[categoryName] = {
      ...categoryHeroes[categoryName],
      backgroundImage: imageUrl
    };

    const updatedTheme = {
      ...currentTheme,
      categoryHeroes,
      lastUpdated: new Date().toISOString()
    };

    const updatedUser = await User.findByIdAndUpdate(
      user._id,
      { customTheme: updatedTheme },
      { new: true }
    );

    if (!updatedUser) {
      return res.status(500).json({ success: false, message: "Failed to save category image to user theme" });
    }

    console.log(`✅ Category hero image uploaded for ${username} (${categoryName}): ${imageUrl}`);
    
    res.json({
      success: true,
      data: {
        imageUrl,
        categoryName,
        message: "Category hero image uploaded and saved successfully"
      }
    });
  } catch (err) {
    console.error("Category hero image upload error:", err);
    res.status(500).json({ success: false, message: "Server error during category image upload" });
  }
});

// ✅ Change user password
app.post("/change-password", async (req, res) => {
  try {
    const { username, current, newPass } = req.body;
    if (!username || !current || !newPass) {
      return res.status(400).json({ success: false, message: "Missing fields" });
    }

    const user = await User.findOne({ username });
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    // Compare current password with stored password
    let passwordMatch = false;
    if (user.password.startsWith('$2b$')) {
      // Password is hashed, use bcrypt to compare
      passwordMatch = await bcrypt.compare(current, user.password);
    } else {
      // Password is plain text (for backward compatibility)
      passwordMatch = user.password === current;
    }
    
    if (!passwordMatch) {
      return res.status(401).json({ success: false, message: "Current password incorrect" });
    }

    // Hash the new password
    const hashedNewPassword = await bcrypt.hash(newPass, 10);
    
    const updatedUser = await User.findByIdAndUpdate(
      user._id,
      { password: hashedNewPassword },
      { new: true }
    );
    
    if (!updatedUser) {
      return res.status(500).json({ success: false, message: "Failed to update password" });
    }

    res.json({ success: true, message: "Password updated successfully" });
  } catch (error) {
    console.error("Change password error:", error);
    res.status(500).json({ success: false, message: "Server error during password change" });
  }
});

// ✅ Update user email
app.post("/update-account", async (req, res) => {
  try {
    const { username, email } = req.body;
    if (!username || !email) {
      return res.status(400).json({ success: false, message: "Missing username or email" });
    }

    const user = await User.findOne({ username });
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    const updatedUser = await User.findByIdAndUpdate(
      user._id,
      { email },
      { new: true }
    );
    
    if (!updatedUser) {
      return res.status(500).json({ success: false, message: "Failed to update account" });
    }

    res.json({ success: true, message: "Account updated successfully" });
  } catch (error) {
    console.error("Update account error:", error);
    res.status(500).json({ success: false, message: "Server error during account update" });
  }
});

function getCurrencySymbol(code) {
  const symbols = {
    USD: "$",
    EUR: "€",
    GBP: "£",
    INR: "₹",
    NGN: "₦",
    KES: "Ksh",
    GHS: "₵",
    ZAR: "R",
    CAD: "C$",
    AUD: "A$"
  };
  return symbols[code] || code + " ";
}

app.post("/place-order", async (req, res) => {
  try {
    const order = req.body;

    if (
      !order ||
      !order.productId ||
      !order.buyer?.name ||
      !order.buyer?.email ||
      !order.seller
    ) {
      return res.status(400).json({ success: false, message: "❌ Incomplete order data." });
    }

    // Generate unique IDs for the order
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 10);
    order.id = `order_${timestamp}_${random}`;
    order.orderId = `ORD-${timestamp}-${random.toUpperCase()}`;
    
    order.status = "Pending";
    order.createdAt = new Date();

    // Find the product to check inventory
    const product = await Product.findOne({ id: order.productId });
    if (!product) {
      return res.status(404).json({ success: false, message: "Product not found." });
    }

    // Check if seller has inventory tracking enabled
    const seller = await User.findOne({ username: order.seller });
    if (!seller) {
      return res.status(404).json({ success: false, message: "Seller not found." });
    }

    const shopName = seller.customTheme?.name || seller.username || "Iyonicorp";
    const limits = getSubscriptionLimits(seller.plan);
    
    // Check inventory if enabled
    if (limits.inventoryTracking && product.inventory !== undefined) {
      if (product.inventory < order.quantity) {
        return res.status(400).json({ success: false, message: "Insufficient inventory." });
      }
      
      // Reduce inventory
      const newInventory = product.inventory - order.quantity;
      await Product.updateOne({ id: order.productId }, { inventory: newInventory });
    }

    const result = await Order.create(order);

    const currency = order?.shopSettings?.storeCurrency || "USD";
    const symbol = getCurrencySymbol(currency);

    const buyerDashboardUrl = `https://api.iyonicorp.com/dashboard.html?email=${encodeURIComponent(order.buyer.email)}`;

    // 📧 Email to Buyer
    await emailService.sendMail({
      to: order.buyer.email,
      subject: `🧾 Your order from ${shopName} is confirmed!`,
      html: `
        <div style="font-family:sans-serif;max-width:600px;margin:auto;">
          <h2>Hi ${order.buyer.name}, your order is confirmed! ✅</h2>
          <p>Thanks for shopping with <strong>${shopName}</strong>.</p>
          <img src="${order.productImage}" alt="${order.productName}" style="width:100%;max-width:300px;margin-top:10px;border-radius:8px;" />
          <table style="margin-top:20px;width:100%;border-collapse:collapse;">
            <tr><td><strong>Order ID:</strong></td><td>${order.orderId}</td></tr>
            <tr><td><strong>Product:</strong></td><td>${order.productName}</td></tr>
            <tr><td><strong>Quantity:</strong></td><td>${order.quantity}</td></tr>
            <tr><td><strong>Total:</strong></td><td><strong>${symbol}${order.total}</strong></td></tr>
            <tr><td><strong>Status:</strong></td><td style="color:#f97316;"><strong>Pending</strong></td></tr>
          </table>
          <p style="margin-top:20px;">🧭 Track your order:</p>
          <a href="${buyerDashboardUrl}" style="display:inline-block;padding:10px 20px;background:#4f46e5;color:#fff;text-decoration:none;border-radius:6px;">📋 View Order Dashboard</a>
        </div>
      `,
      shopName
    });

    // 📧 Email to Seller
    await emailService.sendMail({
      to: seller.email,
      subject: `📦 New Order Received: ${order.productName}`,
      html: `
        <div style="font-family:sans-serif;max-width:600px;margin:auto;">
          <h2>📬 New Order from ${order.buyer.name}</h2>
          <p><strong>${shopName}</strong> just received a new order.</p>
          <img src="${order.productImage}" alt="${order.productName}" style="width:100%;max-width:300px;margin-top:10px;border-radius:8px;" />
          <table style="margin-top:20px;width:100%;border-collapse:collapse;">
            <tr><td><strong>Order ID:</strong></td><td>${order.orderId}</td></tr>
            <tr><td><strong>Product:</strong></td><td>${order.productName}</td></tr>
            <tr><td><strong>Quantity:</strong></td><td>${order.quantity}</td></tr>
            <tr><td><strong>Total:</strong></td><td><strong>${symbol}${order.total}</strong></td></tr>
            <tr><td><strong>Buyer Email:</strong></td><td>${order.buyer.email}</td></tr>
            <tr><td><strong>Status:</strong></td><td style="color:#f97316;"><strong>Pending</strong></td></tr>
          </table>
        </div>
      `,
      shopName
    });

    return res.status(201).json({ success: true, data: { order: result } });
  } catch (err) {
    console.error("❌ Failed to save order:", err);
    return res.status(500).json({ success: false, message: "Server error while saving order." });
  }
});

app.patch("/order-status", async (req, res) => {
  try {
    const id = req.body.id || req.query.id;
    const status = req.body.status || req.query.status;
    if (!id || !status) return res.status(400).json({ success: false, message: "Missing id or status" });

    const validStatuses = ["Confirmed", "Ready", "Delivered", "Cancelled", "Declined"];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ success: false, message: "Invalid status value." });
    }

    const order = await Order.findOne({ id });
    if (!order) return res.status(404).json({ success: false, message: "Order not found" });

    await Order.updateOne({ id }, { status });

    const seller = await User.findOne({ username: order.seller });
    const shopName = seller?.customTheme?.name || seller?.username || "Iyonicorp";

    const currency = order?.shopSettings?.storeCurrency || "USD";
    const symbol = getCurrencySymbol(currency);
    const buyerEmail = order?.buyer?.email;
    const buyerName = order?.buyer?.name;
    const productName = order.productName || "Unnamed Product";

    const statusMessages = {
      Confirmed: "✅ Your order has been confirmed!",
      Ready: "📦 Your order is ready for pickup/delivery!",
      Delivered: "🎉 Your order has been delivered!",
      Cancelled: "⚠️ Your order was cancelled.",
      Declined: "❌ Your order was declined."
    };

    const dashboardLink = `https://api.iyonicorp.com/dashboard.html?email=${encodeURIComponent(buyerEmail)}`;

    if (buyerEmail) {
      await emailService.sendMail({
        to: buyerEmail,
        subject: `📢 Order Update: "${status}"`,
        html: `
          <div style="font-family:sans-serif;max-width:600px;margin:auto;">
            <h2>Hi ${buyerName},</h2>
            <p>${statusMessages[status]}</p>
            <img src="${order.productImage}" alt="${productName}" style="width:100%;max-width:300px;border-radius:8px;margin-top:10px;" />
            <p style="margin-top:20px;">Track your order:</p>
            <a href="${dashboardLink}" style="padding:10px 20px;background:#4f46e5;color:#fff;text-decoration:none;border-radius:6px;">📋 View Dashboard</a>
          </div>
        `,
        shopName
      });
    }

    res.json({ success: true, message: `Order status updated to ${status}.` });
  } catch (error) {
    console.error("Order status update error:", error);
    res.status(500).json({ success: false, message: "Server error during order status update" });
  }
});

// Buyer and seller order routes
app.get("/buyer-orders", async (req, res) => {
  try {
    const { buyer } = req.query;
    if (!buyer) return res.status(400).json({ success: false, message: "Missing buyer email or ID" });

    const orders = await Order.find({ "buyer.email": buyer });
    res.json({ success: true, data: orders });
  } catch (error) {
    console.error("Buyer orders error:", error);
    res.status(500).json({ success: false, message: "Server error during buyer orders fetch" });
  }
});

app.get("/seller-orders", async (req, res) => {
  try {
    const { seller } = req.query;
    if (!seller) return res.status(400).json({ success: false, message: "Missing seller name" });

    const orders = await Order.find({ seller });
    const products = await Product.find({ seller });

    // Add product name if missing
    orders.forEach(o => {
      if (!o.productName) {
        const prod = products.find(p => p.id === o.productId);
        o.productName = prod?.name || "Unknown Product";
      }
    });

    res.json({ success: true, data: orders });
  } catch (error) {
    console.error("Seller orders error:", error);
    res.status(500).json({ success: false, message: "Server error during seller orders fetch" });
  }
});

app.post("/add-wishlist", async (req, res) => {
  try {
    const { buyer, productId } = req.body;
    if (!buyer || !productId) {
      return res.status(400).json({ success: false, message: "Missing buyer or productId" });
    }

    const result = await Wishlist.create({ buyer, productId, createdAt: new Date() });
    res.status(201).json({ success: true, data: result });
  } catch (error) {
    console.error("Add wishlist error:", error);
    res.status(500).json({ success: false, message: "Server error during wishlist add" });
  }
});

// Track product views
app.post("/api/track-view", (req, res) => {
  try {
    const { productId, seller } = req.body;
    // Simple view tracking - in production you'd store this in database
    console.log(`📊 Product view tracked: ${productId} by seller: ${seller}`);
    res.json({ success: true, message: "View tracked" });
  } catch (error) {
    console.error("Track view error:", error);
    res.status(500).json({ success: false, message: "Server error during view tracking" });
  }
});

app.post("/add-cart", async (req, res) => {
  try {
    const { buyer, id: productId, qty, seller, variant, color, price, name, image } = req.body;

    if (!buyer || !productId || !seller) {
      return res.status(400).json({ success: false, message: "Missing buyer, productId, or seller" });
    }

    const entry = {
      buyer,
      productId,
      seller,
      name,
      price,
      image,
      variant,
      color,
      quantity: qty || 1,
      createdAt: new Date()
    };

    const result = await Cart.create(entry);
    res.status(201).json({ success: true, data: result });
  } catch (error) {
    console.error("Add cart error:", error);
    res.status(500).json({ success: false, message: "Server error during cart add" });
  }
});

app.get("/current-user", (req, res) => {
  if (req.session && req.session.user) {
    res.json({ loggedIn: true, user: req.session.user });
  } else {
    res.json({ loggedIn: false, user: null });
  }
});

app.get("/buyer-cart", async (req, res) => {
  try {
    const { buyer } = req.query;
    if (!buyer) return res.status(400).json({ success: false, message: "Missing buyer" });

    const cart = await Cart.find({ buyer });
    res.json({ success: true, data: cart });
  } catch (error) {
    console.error("Buyer cart error:", error);
    res.status(500).json({ success: false, message: "Server error during buyer cart fetch" });
  }
});

app.get("/buyer-wishlist", async (req, res) => {
  try {
    const { buyer } = req.query;
    if (!buyer) return res.status(400).json({ success: false, message: "Missing buyer" });

    const wishes = await Wishlist.find({ buyer });
    res.json({ success: true, data: wishes });
  } catch (error) {
    console.error("Buyer wishlist error:", error);
    res.status(500).json({ success: false, message: "Server error during buyer wishlist fetch" });
  }
});

app.get("/order-summary", async (req, res) => {
  try {
    const { buyer } = req.query;
    if (!buyer) return res.status(400).json({ success: false, message: "Missing buyer" });

    const orders = await Order.find({ "buyer.email": buyer });
    const totalOrders = orders.length;
    const totalSpent = orders.reduce((sum, o) => sum + parseFloat(o.total || 0), 0);
    const statusMap = {};

    orders.forEach(o => {
      statusMap[o.status] = (statusMap[o.status] || 0) + 1;
    });

    res.json({
      success: true,
      data: {
        totalOrders,
        totalSpent: totalSpent.toFixed(2),
        statusBreakdown: statusMap
      }
    });
  } catch (error) {
    console.error("Order summary error:", error);
    res.status(500).json({ success: false, message: "Server error during order summary fetch" });
  }
});

app.get("/sales-summary", async (req, res) => {
  try {
    const { seller } = req.query;
    if (!seller) return res.status(400).json({ success: false, message: "Missing seller" });

    const orders = await Order.find({ seller });
    const products = await Product.find({ seller });

    // Top product logic
    const frequency = {};
    orders.forEach(o => {
      frequency[o.productId] = (frequency[o.productId] || 0) + 1;
    });

    const topProductId = Object.entries(frequency)
      .sort((a, b) => b[1] - a[1])[0]?.[0];

    const topProduct = products.find(p => p.id === topProductId) || null;

    const wishlist = await Wishlist.find({});
    const cart = await Cart.find({});

    res.json({
      success: true,
      data: {
        orders,
        topProduct,
        wishlistCount: wishlist.filter(w => w.productId && products.some(p => p.id === w.productId)).length,
        cartCount: cart.filter(c => c.productId && products.some(p => p.id === c.productId)).length
      }
    });
  } catch (error) {
    console.error("Sales summary error:", error);
    res.status(500).json({ success: false, message: "Server error during sales summary fetch" });
  }
});

app.post("/update-shop-settings", async (req, res) => {
  try {
    const { username, settings } = req.body;
    if (!username || !settings || typeof settings !== "object") {
      return res.status(400).json({ success: false, message: "Missing username or settings" });
    }

    const { paymentMethod, paymentSystems, deliveryRegions, storeCurrency } = settings;
    if (!paymentMethod || !Array.isArray(paymentSystems) || !Array.isArray(deliveryRegions) || !storeCurrency) {
      return res.status(400).json({ success: false, message: "Incomplete settings" });
    }

    const user = await User.findOne({ username });
    if (!user) return res.status(404).json({ success: false, message: "Seller not found" });

    const limits = getSubscriptionLimits(user.plan);
    const premiumGateways = ['square', 'iyzipay', 'wise', 'revolut'];

    const filteredPaymentSystems = limits.premiumGateways
      ? paymentSystems
      : paymentSystems.filter(g => !premiumGateways.includes(g));

    const filteredSettings = {
      ...settings,
      paymentSystems: filteredPaymentSystems
    };

    const updatedUser = await User.findByIdAndUpdate(
      user._id,
      { shopSettings: filteredSettings },
      { new: true }
    );
    
    if (!updatedUser) return res.status(500).json({ success: false, message: "Failed to update settings" });

    res.json({
      success: true,
      message: "Settings saved",
      data: {
        filtered: filteredPaymentSystems.length !== paymentSystems.length
      }
    });
  } catch (err) {
    console.error("Update settings error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

app.delete("/delete", async (req, res) => {
  try {
    const { collection, id } = req.query;
    if (!collection || !id) {
      return res.status(400).json({ success: false, message: "Missing collection or id" });
    }

    let result;
    
    switch (collection) {
      case "users":
        result = await User.deleteOne({ _id: id });
        break;
      case "products":
        result = await Product.deleteOne({ _id: id });
        break;
      case "orders":
        result = await Order.deleteOne({ _id: id });
        break;
      case "cart":
        result = await Cart.deleteOne({ _id: id });
        break;
      case "wishlist":
        result = await Wishlist.deleteOne({ _id: id });
        break;
      case "coupons":
        result = await Coupon.deleteOne({ _id: id });
        break;
      case "subscription-plans":
        result = await SubscriptionPlan.deleteOne({ _id: id });
        break;
      default:
        return res.status(400).json({ success: false, message: "Invalid collection" });
    }

    if (result.deletedCount === 0) {
      return res.status(404).json({ success: false, message: "Not found" });
    }
    
    res.json({ success: true, data: { deleted: result.deletedCount } });
  } catch (err) {
    console.error("Delete error:", err);
    res.status(500).json({ success: false, message: "Delete failed" });
  }
});

app.post("/signup", async (req, res) => {
  try {
    const { username, email, password } = req.body;
    const sellerUsername = req.query.seller;

    if (!username || !email || !password) {
      return res.status(400).json({ success: false, message: "Missing fields" });
    }

    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(409).json({ success: false, message: "Email already used" });
    }

    // Hash password and generate required ID
    const hashedPassword = await bcrypt.hash(password, 10);
    const user = new User({
      id: crypto.randomUUID(),
      username,
      email,
      password: hashedPassword,
      role: "buyer",
      createdAt: new Date()
    });
    
    const savedUser = await user.save();

    let shopName = "Iyonicorp";
    let shopUrl = `https://api.iyonicorp.com`;

    if (sellerUsername) {
      const seller = await User.findOne({ username: sellerUsername, role: "seller" });
      if (seller) {
        shopName = seller.customTheme?.name || seller.username;
        shopUrl = `https://api.iyonicorp.com/shop.html?seller=${encodeURIComponent(sellerUsername)}`;
      }
    }

    try {
      await emailService.sendMail({
        to: email,
        subject: `🎉 Welcome to ${shopName}!`,
        html: `
          <h2>Welcome, ${username}!</h2>
          <p>Thanks for joining <strong>${shopName}</strong>.</p>
          <a href="${shopUrl}" style="color:#4f46e5">🛍️ Visit Store</a>
        `,
        shopName
      });
    } catch (err) {
      console.warn("Email failed:", err.message);
    }

    // Remove sensitive fields from response
    const userResponse = savedUser.toObject();
    delete userResponse.password;
    
    res.status(201).json({ success: true, data: { user: userResponse } });
  } catch (error) {
    console.error("Signup error:", error);
    res.status(500).json({ success: false, message: "Server error during signup" });
  }
});

// server.js (or index.js)
app.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ success: false, message: "Email and password are required" });
    }

    const user = await User.findOne({ email });
    if (!user) {
      return res.status(404).json({ success: false, message: "No account found" });
    }

    // Compare hashed password
    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid) {
      return res.status(401).json({ success: false, message: "Incorrect password" });
    }

    if (user.status === "suspended") {
      return res.status(403).json({ success: false, message: "Account suspended" });
    }

    // Remove sensitive fields from response
    const userObject = user.toObject();
    delete userObject.password;

    res.json({ success: true, user: userObject });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// Check user status endpoint
app.post("/check-user-status", async (req, res) => {
  try {
    const { username } = req.body;
    if (!username) {
      return res.status(400).json({ success: false, message: "Username is required" });
    }

    const user = await User.findOne({ username });
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    // Check if force logout is active based on timestamp
    let forceLogout = false;
    if (user.forceLogoutAt) {
      const forceLogoutTime = new Date(user.forceLogoutAt).getTime();
      const now = Date.now();
      // Force logout is active if it was set within the last 5 minutes
      forceLogout = (now - forceLogoutTime) < (5 * 60 * 1000);
      
      // Clear the force logout flag after it's been checked
      if (forceLogout) {
        await User.updateOne({ username }, { forceLogoutAt: null });
      }
    }

    res.json({
      success: true,
      status: user.status || 'active',
      suspended: user.status === 'suspended',
      forceLogout: forceLogout,
      role: user.role
    });
  } catch (error) {
    console.error("Check user status error:", error);
    res.status(500).json({ success: false, message: "Server error during status check" });
  }
});


app.post("/signup-seller", async (req, res) => {
  try {
    let { username, email, password, plan, product_type } = req.body;

    // Normalize inputs
    username = username?.trim();
    email = email?.trim().toLowerCase();
    plan = plan?.trim();
    product_type = product_type?.trim();

    if (!username || !email || !password || !plan || !product_type) {
      return res.status(400).json({ success: false, message: "Missing one or more required fields." });
    }

    // Validate basic plan/product type
    const allowedProductTypes = ["physical", "digital", "service"];
    if (!allowedProductTypes.includes(product_type.toLowerCase())) {
      return res.status(400).json({ success: false, message: "Invalid product type." });
    }

    // Check if email or username already exists
    const [existingEmailUser, existingUsernameUser] = await Promise.all([
      User.findOne({ email }),
      User.findOne({ username: new RegExp(`^${username}$`, "i") })
    ]);
    if (existingEmailUser) return res.status(409).json({ success: false, message: "Email already taken." });
    if (existingUsernameUser) return res.status(409).json({ success: false, message: "Store/Business name already taken." });

    // Hash password before saving
    const hashedPassword = await bcrypt.hash(password, 10);

    // Trial eligibility
    const now = new Date();
    const isTrial = !plan.toLowerCase().includes("free");

    const seller = new User({
      id: crypto.randomUUID(),
      username,
      email,
      password: hashedPassword,
      plan,
      product_type,
      role: "seller",
      status: "active",
      createdAt: now,
      shopSettings: {},
      trialUsed: isTrial,
      trial: isTrial ? `${TRIAL_DAYS}-day` : "none",
      trialActive: isTrial,
      trialEndsAt: isTrial ? new Date(now.getTime() + TRIAL_DAYS * 86400000).toISOString() : null,
      nextPaymentDate: isTrial ? new Date(now.getTime() + TRIAL_DAYS * 86400000).toISOString() : null,
      subscriptionPayments: isTrial
        ? [{
            plan,
            type: "trial",
            amount: 0,
            date: now.toISOString(),
            paymentRef: "trial-signup"
          }]
        : []
    });

    const savedSeller = await seller.save();

    res.status(201).json({ success: true, data: { seller: { id: savedSeller.id, username, email, plan, product_type } } });

  } catch (err) {
    console.error("❌ Seller signup failed:", err);
    res.status(500).json({ success: false, message: "Failed to register seller." });
  }
});

// Check user status endpoint (API version)
app.post("/api/check-user-status", async (req, res) => {
  try {
    const { username } = req.body;
    if (!username) {
      return res.status(400).json({ success: false, message: "Username is required" });
    }

    const user = await User.findOne({ username });
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    // Check if force logout is active based on timestamp
    let forceLogout = false;
    if (user.forceLogoutAt) {
      const forceLogoutTime = new Date(user.forceLogoutAt).getTime();
      const now = Date.now();
      // Force logout is active if it was set within the last 5 minutes
      forceLogout = (now - forceLogoutTime) < (5 * 60 * 1000);
      
      // Clear the force logout flag after it's been checked
      if (forceLogout) {
        await User.updateOne({ username }, { forceLogoutAt: null });
      }
    }

    res.json({
      success: true,
      status: user.status || 'active',
      suspended: user.status === 'suspended',
      forceLogout: forceLogout,
      role: user.role
    });
  } catch (error) {
    console.error("Check user status error:", error);
    res.status(500).json({ success: false, message: "Server error during status check" });
  }
});

// Subscription info endpoint
app.get("/api/subscription-info", async (req, res) => {
  try {
    const { username } = req.query;
    if (!username) {
      return res.status(400).json({ success: false, message: "Username is required" });
    }

    const user = await User.findOne({ username });
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    const limits = getSubscriptionLimits(user.plan);
    
    res.json({
      success: true,
      user: {
        plan: user.plan,
        nextPaymentDate: user.nextPaymentDate,
        subscriptionWeeks: user.subscriptionWeeks,
        trialActive: user.trialActive,
        trialEndsAt: user.trialEndsAt
      },
      limits
    });
  } catch (error) {
    console.error("Subscription info error:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

const otpMap = new Map(); // Replace with DB or Redis in production
const resetCodeMap = new Map(); // For password reset codes

app.post("/send-otp", async (req, res) => {
  try {
    const { email } = req.body;

    const exists = await User.findOne({ email });
    if (exists) {
      return res.status(400).json({ success: false, message: "Email already used" });
    }

    const otp = Math.floor(100000 + Math.random() * 900000);
    otpMap.set(email, { otp, expiresAt: Date.now() + 10 * 60 * 1000 }); // 10 min

    await emailService.sendMail({
      to: email,
      subject: "🔐 Your Iyonicorp OTP Code",
      html: `
        <div style="font-family:sans-serif;font-size:16px;">
          <p>Hi there,</p>
          <p>Your OTP code is:</p>
          <h2 style="color:#4f46e5;">${otp}</h2>
          <p>This code will expire in 10 minutes. Do not share it with anyone.</p>
          <hr />
          <p style="font-size:12px;color:#888;">If you didn't request this, please ignore this email.</p>
        </div>
      `,
      shopName: "Iyonicorp"
    });

    res.status(200).json({ success: true, message: "OTP sent" });
  } catch (emailErr) {
    console.error("❌ Failed to send OTP email:", emailErr);
    res.status(500).json({ success: false, message: "Failed to send email" });
  }
});

app.post("/verify-otp", (req, res) => {
  const { email, otp } = req.body;
  const record = otpMap.get(email);

  if (!record || parseInt(otp) !== record.otp || Date.now() > record.expiresAt) {
    return res.status(400).json({ error: "Invalid or expired OTP" });
  }

  otpMap.delete(email); // prevent reuse
  res.status(200).json({ success: true });
});

// Password reset endpoints
app.post("/auth/request-reset", async (req, res) => {
  try {
    const { email } = req.body;
    
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(404).json({ success: false, message: "No account found with this email" });
    }

    const resetCode = Math.floor(100000 + Math.random() * 900000);
    resetCodeMap.set(email, { code: resetCode, expiresAt: Date.now() + 15 * 60 * 1000 }); // 15 min

    await emailService.sendMail({
      to: email,
      subject: "🔐 Password Reset Code - Iyonicorp",
      html: `
        <div style="font-family:sans-serif;font-size:16px;">
          <p>Hi there,</p>
          <p>You requested a password reset. Your reset code is:</p>
          <h2 style="color:#4f46e5;">${resetCode}</h2>
          <p>This code will expire in 15 minutes. Do not share it with anyone.</p>
          <hr />
          <p style="font-size:12px;color:#888;">If you didn't request this, please ignore this email.</p>
        </div>
      `,
      shopName: "Iyonicorp"
    });

    res.status(200).json({ success: true, message: "Reset code sent" });
  } catch (error) {
    console.error("❌ Failed to send reset code:", error);
    res.status(500).json({ success: false, message: "Failed to send reset code" });
  }
});

app.post("/auth/verify-reset-code", (req, res) => {
  const { email, code } = req.body;
  const record = resetCodeMap.get(email);

  if (!record || parseInt(code) !== record.code || Date.now() > record.expiresAt) {
    return res.status(400).json({ success: false, message: "Invalid or expired reset code" });
  }

  res.status(200).json({ success: true, message: "Code verified" });
});

app.post("/auth/reset-password", async (req, res) => {
  try {
    const { email, code, newPassword } = req.body;
    const record = resetCodeMap.get(email);

    if (!record || parseInt(code) !== record.code || Date.now() > record.expiresAt) {
      return res.status(400).json({ success: false, message: "Invalid or expired reset code" });
    }

    const user = await User.findOne({ email });
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);
    await User.updateOne({ email }, { password: hashedPassword });

    resetCodeMap.delete(email); // prevent reuse
    res.status(200).json({ success: true, message: "Password updated successfully" });
  } catch (error) {
    console.error("❌ Failed to reset password:", error);
    res.status(500).json({ success: false, message: "Failed to reset password" });
  }
});

// Update shop settings endpoint
app.post("/api/update-shop-settings", async (req, res) => {
  try {
    const { username, settings } = req.body;
    
    if (!username || !settings) {
      return res.status(400).json({ success: false, message: "Username and settings are required" });
    }

    const user = await User.findOne({ username });
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    // Update user settings
    const updateData = {};
    if (settings.customTheme) updateData.customTheme = settings.customTheme;
    if (settings.shopSettings) updateData.shopSettings = settings.shopSettings;
    if (settings.businessInfo) updateData.businessInfo = settings.businessInfo;

    await User.updateOne({ username }, updateData);
    
    res.json({ success: true, message: "Shop settings updated successfully" });
  } catch (error) {
    console.error("Update shop settings error:", error);
    res.status(500).json({ success: false, message: "Failed to update shop settings" });
  }
});

// Add subscription weeks endpoint
app.post("/api/add-subscription-weeks", async (req, res) => {
  try {
    const { username, weeks } = req.body;
    
    if (!username || !weeks) {
      return res.status(400).json({ success: false, message: "Username and weeks are required" });
    }

    const user = await User.findOne({ username });
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    // Add weeks to subscription
    const currentWeeks = user.subscriptionWeeks || 0;
    const newWeeks = currentWeeks + parseInt(weeks);
    
    // Update next payment date
    const now = new Date();
    const nextPaymentDate = new Date(now.getTime() + (newWeeks * 7 * 24 * 60 * 60 * 1000));

    await User.updateOne({ username }, { 
      subscriptionWeeks: newWeeks,
      nextPaymentDate: nextPaymentDate.toISOString()
    });
    
    res.json({ success: true, message: `Added ${weeks} weeks to subscription` });
  } catch (error) {
    console.error("Add subscription weeks error:", error);
    res.status(500).json({ success: false, message: "Failed to add subscription weeks" });
  }
});

// Upgrade plan endpoint
app.post("/api/upgrade-plan", async (req, res) => {
  try {
    console.log("Upgrade plan request:", req.body);
    const { username, newPlan, plan } = req.body;
    const targetPlan = newPlan || plan; // Accept both newPlan and plan
    
    if (!username || !targetPlan) {
      console.log("Missing required fields:", { username: !!username, newPlan: !!newPlan, plan: !!plan });
      return res.status(400).json({ success: false, message: "Username and plan are required" });
    }

    const user = await User.findOne({ username });
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    // Update user plan
    await User.updateOne({ username }, { 
      plan: targetPlan,
      trialActive: false // End trial when upgrading
    });
    
    res.json({ success: true, message: `Plan upgraded to ${targetPlan}` });
  } catch (error) {
    console.error("Upgrade plan error:", error);
    res.status(500).json({ success: false, message: "Failed to upgrade plan" });
  }
});

// Seller analytics endpoint
app.get("/api/seller/analytics", async (req, res) => {
  try {
    const { seller, range = "day", start, end } = req.query;
    
    if (!seller) {
      return res.status(400).json({ success: false, message: "Seller parameter is required" });
    }

    // Get date range
    const now = new Date();
    let startDate, endDate;
    
    if (start && end) {
      startDate = new Date(start);
      endDate = new Date(end);
    } else {
      // Default ranges
      switch (range) {
        case "hour":
          startDate = new Date(now.getTime() - 24 * 60 * 60 * 1000); // Last 24 hours
          break;
        case "day":
          startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000); // Last 7 days
          break;
        case "week":
          startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000); // Last 30 days
          break;
        case "month":
          startDate = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000); // Last year
          break;
        case "year":
          startDate = new Date(now.getTime() - 3 * 365 * 24 * 60 * 60 * 1000); // Last 3 years
          break;
        default:
          startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      }
      endDate = now;
    }

    // Fetch data
    const [orders, products, cart, wishlist] = await Promise.all([
      Order.find({
        seller: seller,
        createdAt: { $gte: startDate, $lte: endDate }
      }).sort({ createdAt: 1 }),
      Product.find({ seller: seller }),
      Cart.find({}),
      Wishlist.find({})
    ]);



    // Helper functions
    function getTimeKey(date, range) {
      const d = new Date(date);
      switch (range) {
        case "hour": return d.toISOString().substring(0, 13) + ":00";
        case "day": return d.toISOString().substring(0, 10);
        case "week":
          const weekStart = new Date(d);
          weekStart.setDate(d.getDate() - d.getDay());
          return weekStart.toISOString().substring(0, 10);
        case "month": return d.toISOString().substring(0, 7);
        case "year": return d.getFullYear().toString();
        default: return d.toISOString().substring(0, 10);
      }
    }

    function groupByProductId(items) {
      const result = {};
      items.forEach(item => {
        const pid = item.productId || item.id;
        if (pid) {
          // Use the original product ID (don't convert to ObjectID)
          result[pid] = (result[pid] || 0) + (item.quantity || 1);
        }
      });
      return result;
    }

    // Initialize analytics
    const productMap = {};
    const customers = new Set();
    const customerOrders = {};
    const salesOverTime = {};
    const hourBuckets = Array(24).fill(0);
    const salesByCountry = {};
    let earnings = 0;

    // Create product image and cost maps (use both ObjectID and custom ID)
    const imageMap = {};
    const costMap = {};
    products.forEach(p => {
      const objId = p._id.toString();
      const customId = p.id;
      
      imageMap[objId] = p.image || p.images?.[0];
      costMap[objId] = parseFloat(p.deliveryFee || 0);
      
      if (customId) {
        imageMap[customId] = p.image || p.images?.[0];
        costMap[customId] = parseFloat(p.deliveryFee || 0);
      }
    });

    // Process orders
    for (const order of orders) {
      const pid = order.productId;
      const price = parseFloat(order.variant?.price || order.subtotal || order.totalAmount || order.price || 0);
      const quantity = order.quantity || 1;
      const deliveryFee = parseFloat(order.delivery?.fee || 0);
      const revenue = quantity * price + deliveryFee;

      const country = order.delivery?.country || order.buyer?.country || "Unknown";
      salesByCountry[country] = (salesByCountry[country] || 0) + revenue;

      if (!productMap[pid]) {
        productMap[pid] = {
          id: pid,
          name: order.productName || `Product ${pid}`,
          price: price / quantity,
          cost: deliveryFee / quantity,
          sold: 0,
          inCart: 0,
          inWishlist: 0,
          deliveryFees: 0,
          image: imageMap[pid] || order.productImage || null
        };
      }

      productMap[pid].sold += quantity;
      productMap[pid].deliveryFees += deliveryFee;
      earnings += revenue;

      const timeKey = getTimeKey(order.createdAt, range);
      salesOverTime[timeKey] = (salesOverTime[timeKey] || 0) + revenue;

      const hour = new Date(order.createdAt).getHours();
      hourBuckets[hour] += revenue;

      const buyerId = typeof order.buyer === "object" ? order.buyer.id : order.buyer;
      customers.add(buyerId);
      customerOrders[buyerId] = (customerOrders[buyerId] || 0) + 1;
    }

    // Get seller's products for cart filtering (use both ObjectID and custom ID)
    const sellerProductIds = products.map(p => p._id.toString());
    const sellerCustomIds = products.map(p => p.id).filter(Boolean);
    const allSellerIds = [...sellerProductIds, ...sellerCustomIds];
    
    // Process cart data (only for seller's products)
    const relevantCartItems = cart.filter(c => 
      allSellerIds.includes(c.productId) || 
      sellerProductIds.includes(c.productId) ||
      sellerCustomIds.includes(c.productId)
    );
    const cartCounts = groupByProductId(relevantCartItems);
    for (const pid in cartCounts) {
      if (!productMap[pid]) {
        const match = relevantCartItems.find(c => c.productId === pid);
        const product = products.find(p => p._id.toString() === pid || p.id === pid);
        productMap[pid] = {
          id: pid,
          name: product?.name || match?.name || `Product ${pid}`,
          price: parseFloat(product?.price || match?.variant?.price || match?.price || 0),
          cost: costMap[pid] || 0,
          sold: 0,
          inCart: 0,
          inWishlist: 0,
          deliveryFees: 0,
          image: imageMap[pid] || match?.image || null
        };
      }
      productMap[pid].inCart = cartCounts[pid];
    }

    // Process wishlist data (only for seller's products)
    const relevantWishlists = wishlist.filter(w => 
      allSellerIds.includes(w.productId) || 
      sellerProductIds.includes(w.productId) ||
      sellerCustomIds.includes(w.productId)
    );
    const wishlistCounts = groupByProductId(relevantWishlists);
    for (const pid in wishlistCounts) {
      if (!productMap[pid]) {
        const product = products.find(p => p._id.toString() === pid);
        productMap[pid] = {
          id: pid,
          name: product?.name || `Product ${pid}`,
          price: parseFloat(product?.price || 0),
          cost: costMap[pid] || 0,
          sold: 0,
          inCart: 0,
          inWishlist: 0,
          deliveryFees: 0,
          image: imageMap[pid] || null
        };
      }
      productMap[pid].inWishlist = wishlistCounts[pid];
    }

    const productsData = Object.values(productMap);
    const repeatCustomers = Object.values(customerOrders).filter(n => n > 1).length;

    // Sales over time data for charts
    const sortedKeys = Object.keys(salesOverTime).sort();
    const months = sortedKeys;
    const monthlySales = sortedKeys.map(k => salesOverTime[k]);

    // Best time to sell data
    const bestTimeLabels = [];
    const bestTimeSales = [];
    for (let i = 0; i < 24; i++) {
      bestTimeLabels.push(`${i}:00`);
      bestTimeSales.push(hourBuckets[i]);
    }

    // Sales by region data
    const salesByRegion = Object.entries(salesByCountry)
      .map(([country, amount]) => ({ country, amount }))
      .sort((a, b) => b.amount - a.amount);

    // Profit margins data
    const profitMargins = productsData
      .filter(p => p.sold > 0)
      .map(p => ({
        name: p.name,
        price: p.price,
        cost: p.cost,
        sold: p.sold
      }));

    // Format products for dashboard
    const formattedProducts = productsData
      .filter(p => p.sold > 0)
      .sort((a, b) => (b.sold * b.price + b.deliveryFees) - (a.sold * a.price + a.deliveryFees));

    // Customer insights
    const totalCustomers = customers.size;
    const newCustomers = totalCustomers - repeatCustomers;

    // Conversion funnel
    const totalViews = productsData.reduce((sum, p) => sum + (p.inCart + p.inWishlist + p.sold), 0);
    const totalAddedToCart = productsData.reduce((sum, p) => sum + p.inCart, 0);
    const totalCheckout = orders.length;
    const totalCompleted = orders.length;

    res.json({
      success: true,
      data: {
        products: formattedProducts,
        storeName: seller,
        earnings: earnings,
        totalOrders: orders.length,
        totalProducts: products.length,
        avgOrderValue: orders.length > 0 ? earnings / orders.length : 0,
        
        // Chart data
        months: months,
        monthlySales: monthlySales,
        
        // Best time to sell
        bestTimeToSell: {
          labels: bestTimeLabels,
          sales: bestTimeSales
        },
        
        // Regional data
        salesByRegion: salesByRegion,
        
        // Profit margins
        profitMargins: profitMargins,
        
        // Conversion funnel
        funnel: {
          views: totalViews,
          addedToCart: totalAddedToCart,
          checkout: totalCheckout,
          completed: totalCompleted
        },
        
        // Customer data
        customers: {
          total: totalCustomers,
          repeat: repeatCustomers,
          new: newCustomers
        },
        
        dateRange: { start: startDate, end: endDate },
        range: range
      }
    });

  } catch (error) {
    console.error("Seller analytics error:", error);
    res.status(500).json({ success: false, message: "Failed to fetch analytics data" });
  }
});

// Update seller currency settings
app.post("/api/seller/update-currency", async (req, res) => {
  try {
    const { seller, currency } = req.body;
    
    if (!seller || !currency) {
      return res.status(400).json({ success: false, message: "Missing seller or currency" });
    }
    
    const result = await User.updateOne(
      { username: seller },
      { 
        $set: { 
          "shopSettings.storeCurrency": currency,
          "shopSettings.updatedAt": new Date()
        } 
      }
    );
    
    if (result.modifiedCount === 0) {
      return res.status(404).json({ success: false, message: "Seller not found" });
    }
    
    res.json({ success: true, message: "Currency updated successfully" });
  } catch (error) {
    console.error("Update currency error:", error);
    res.status(500).json({ success: false, message: "Failed to update currency" });
  }
});

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({
    success: true,
    status: "Server is running",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    version: "1.0.0"
  });
});

// Debug endpoint to check orders
app.get("/debug/orders", async (req, res) => {
  try {
    const { seller } = req.query;
    const totalOrders = await Order.countDocuments();
    const sellerOrders = seller ? await Order.countDocuments({ seller }) : 0;
    const recentOrders = await Order.find({}).limit(5).sort({ createdAt: -1 });
    
    res.json({
      success: true,
      data: {
        totalOrders,
        sellerOrders,
        queriedSeller: seller,
        recentOrders: recentOrders.map(order => ({
          seller: order.seller,
          productName: order.productName,
          total: order.total,
          subtotal: order.subtotal,
          createdAt: order.createdAt
        }))
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ✅ GET subscription plans
app.get("/subscription-plans", (req, res) => {
  const type = req.query.type;
  if (!type) return res.status(400).json({ message: "Missing type query" });

  const plansFile = path.join(__dirname, "data", "subscription_plans.json");

  if (!fs.existsSync(plansFile)) {
    return res.status(500).json({ message: "Plans file not found" });
  }

  const plansRaw = fs.readFileSync(plansFile, "utf-8");
  const plans = JSON.parse(plansRaw);
  const filtered = plans.filter(p => p.type === type);
  res.json({ plans: filtered });
});

// ✅ Premium payment gateway validation
app.post("/validate-premium-gateway", async (req, res) => {
  try {
    const { username, gateway } = req.body;
    
    if (!username || !gateway) {
      return res.status(400).json({ success: false, message: "Missing username or gateway" });
    }
    
    const user = await User.findOne({ username });
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }
    
    const limits = getSubscriptionLimits(user.plan);
    const premiumGateways = ['square', 'iyzipay', 'wise', 'revolut'];
    
    if (premiumGateways.includes(gateway) && !limits.premiumGateways) {
      return res.status(403).json({
        success: false,
        message: "Premium gateway not available",
        gateway,
        plan: user.plan,
        requiredPlan: "Pro"
      });
    }
    
    res.json({
      success: true,
      allowed: true,
      gateway,
      plan: user.plan
    });
    
  } catch (err) {
    console.error("Gateway validation error:", err);
    res.status(500).json({ success: false, message: "Server error during gateway validation" });
  }
});

// ✅ Check feature access based on subscription
app.get("/check-feature-access", async (req, res) => {
  try {
    const { username, feature } = req.query;
    
    if (!username || !feature) {
      return res.status(400).json({ success: false, message: "Missing username or feature" });
    }
    
    const user = await User.findOne({ username });
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }
    
    const limits = getSubscriptionLimits(user.plan);
    
    const hasAccess = limits[feature] || false;
    
    res.json({
      success: true,
      data: {
        hasAccess,
        feature,
        plan: user.plan,
        limits
      }
    });
    
  } catch (err) {
    console.error("Feature access check error:", err);
    res.status(500).json({ success: false, message: "Server error during feature access check" });
  }
});

// ✅ Get user subscription info
app.get("/subscription-info", async (req, res) => {
  try {
    const { username } = req.query;
    
    if (!username) {
      return res.status(400).json({ success: false, message: "Missing username" });
    }
    
    const user = await User.findOne({ username });
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }
    
    const limits = getSubscriptionLimits(user.plan);
    const currentProductCount = await Product.countDocuments({ seller: username });
    
    res.json({
      success: true,
      data: {
        user: {
          username: user.username,
          plan: user.plan,
          email: user.email,
          nextPaymentDate: user.nextPaymentDate,
          subscriptionWeeks: user.subscriptionWeeks,
          trialActive: user.trialActive
        },
        limits,
        usage: {
          products: currentProductCount
        }
      }
    });
    
  } catch (err) {
    console.error("Subscription info error:", err);
    res.status(500).json({ success: false, message: "Server error while fetching subscription info" });
  }
});

// Add subscription weeks endpoint
app.post("/add-subscription-weeks", async (req, res) => {
  try {
    const { username, plan, weeks, paymentRef, totalAmount, type } = req.body;

    if (!username || !weeks || !paymentRef || type !== 'add_weeks') {
      return res.status(400).json({ success: false, message: "Missing required fields for adding weeks" });
    }

    const user = await User.findOne({ username });
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    const currentNextPayment = user.nextPaymentDate ? new Date(user.nextPaymentDate) : new Date();
    const newNextPaymentDate = new Date(currentNextPayment.getTime() + (weeks * 7 * 24 * 60 * 60 * 1000));

    const updates = {
      nextPaymentDate: newNextPaymentDate.toISOString(),
      subscriptionWeeks: (user.subscriptionWeeks || 1) + weeks,
      subscriptionPayments: [
        ...(user.subscriptionPayments || []),
        {
          plan: plan,
          weeks: weeks,
          amount: totalAmount,
          date: new Date().toISOString(),
          paymentRef,
          type: 'add_weeks'
        }
      ]
    };

    const updatedUser = await User.findByIdAndUpdate(user._id, updates, { new: true });

    if (!updatedUser) {
      return res.status(500).json({ success: false, message: "Failed to update subscription" });
    }

    // ✅ Send Email Notification
    try {
      await emailService.sendMail({
        to: user.email,
        subject: "✅ Subscription Weeks Added Successfully",
        html: `
          <p>Hello ${user.username},</p>
          <p>Thank you! You've successfully added <strong>${weeks}</strong> week(s) to your <strong>${plan}</strong> plan.</p>
          <p><strong>New Renewal Date:</strong> ${newNextPaymentDate.toDateString()}</p>
          <p><strong>Total Amount Paid:</strong> ${totalAmount.toFixed(2)}</p>
          <hr/>
          <p>If you did not authorize this change, please contact support immediately.</p>
          <p>– Your Team</p>
        `,
        shopName: "Iyonicorp"
      });
    } catch (emailErr) {
      console.error("❌ Failed to send confirmation email:", emailErr.message);
    }

    res.json({
      success: true,
      message: `Added ${weeks} week(s) to subscription`,
      data: {
        newNextPaymentDate: newNextPaymentDate.toISOString(),
        totalWeeks: updates.subscriptionWeeks
      }
    });
  } catch (error) {
    console.error("Add subscription weeks error:", error);
    res.status(500).json({ success: false, message: "Server error during subscription weeks addition" });
  }
});

// Update the existing upgrade-plan endpoint
app.post("/upgrade-plan", async (req, res) => {
  try {
    const { username, plan, paymentRef, nextPaymentDate, type } = req.body;

    console.log("🔧 Plan change request:", { username, plan, paymentRef, nextPaymentDate, type });

    if (!username || !plan || !nextPaymentDate) {
      console.log("❌ Missing required fields:", { username, plan, nextPaymentDate });
      return res.status(400).json({ success: false, message: "Missing required fields" });
    }

    const user = await User.findOne({ username });
    if (!user) {
      console.log("❌ User not found:", username);
      return res.status(404).json({ success: false, message: "User not found" });
    }

    console.log("👤 Current user data:", {
      id: user._id,
      username: user.username,
      currentPlan: user.plan,
      product_type: user.product_type,
      trialActive: user.trialActive,
      subscriptionWeeks: user.subscriptionWeeks
    });

    const plans = await SubscriptionPlan.find({}) || [];
    const matchedPlan = plans.find(p => p.name.toLowerCase() === plan.toLowerCase() && p.type === user.product_type);

    if (!matchedPlan) {
      console.log("❌ Invalid plan selected:", { plan, product_type: user.product_type, availablePlans: plans.map(p => ({ name: p.name, type: p.type })) });
      return res.status(400).json({ success: false, message: "Invalid plan selected" });
    }

    console.log("✅ Matched plan:", matchedPlan);

    // Calculate subscription weeks based on payment
    const now = new Date();
    const nextPayment = new Date(nextPaymentDate);
    const timeDiff = nextPayment.getTime() - now.getTime();
    const subscriptionWeeks = Math.ceil(timeDiff / (1000 * 60 * 60 * 24 * 7));

    console.log("📅 Date calculations:", {
      now: now.toISOString(),
      nextPayment: nextPayment.toISOString(),
      timeDiff: timeDiff,
      calculatedWeeks: subscriptionWeeks
    });

    // Remove trial status when paid subscription is activated
    const updates = {
      plan: matchedPlan.name.toLowerCase(),
      trial: "none", // Remove trial when paid subscription is activated
      trialActive: false, // End trial
      trialEndsAt: null, // Clear trial end date
      role: matchedPlan.role,
      nextPaymentDate,
      subscriptionWeeks: Math.max(1, subscriptionWeeks), // Ensure at least 1 week
      subscriptionPayments: [
        ...(user.subscriptionPayments || []),
        {
          plan: matchedPlan.name,
          amount: matchedPlan.price,
          date: new Date().toISOString(),
          paymentRef,
          type: type || 'plan_change'
        }
      ]
    };

    console.log("🔄 Updates to apply:", updates);

    const updatedUser = await User.findByIdAndUpdate(user._id, updates, { new: true });

    if (!updatedUser) {
      console.log("❌ Failed to update user in database");
      return res.status(500).json({ success: false, message: "Failed to update user" });
    }

    console.log("✅ User updated successfully");

    // Send confirmation email
    try {
      console.log("📧 Attempting to send email to:", user.email);
      
      await emailService.sendMail({
        to: user.email,
        subject: "✅ Subscription Plan Updated Successfully",
        html: `
          <p>Hello ${user.username},</p>
          <p>Your subscription has been successfully updated to <strong>${matchedPlan.name}</strong> plan!</p>
          <p><strong>New Renewal Date:</strong> ${nextPayment.toDateString()}</p>
          <p><strong>Weeks Remaining:</strong> ${updates.subscriptionWeeks}</p>
          <p><strong>Amount Paid:</strong> ${matchedPlan.price.toFixed(2)}</p>
          <hr/>
          <p>Thank you for choosing our platform!</p>
          <p>– Your Team</p>
        `,
        shopName: "Iyonicorp"
      });
      
      console.log("✅ Email sent successfully");
    } catch (emailErr) {
      console.error("❌ Failed to send confirmation email:", emailErr.message);
      console.error("Email error details:", emailErr);
    }

    res.json({
      success: true,
      data: {
        newPlan: matchedPlan.name,
        subscriptionWeeks: updates.subscriptionWeeks,
        nextPaymentDate: updates.nextPaymentDate
      }
    });
  } catch (error) {
    console.error("Upgrade plan error:", error);
    res.status(500).json({ success: false, message: "Server error during plan upgrade" });
  }
});

// Admin endpoint to update user subscription data
app.post("/admin/update-subscription", async (req, res) => {
  try {
    const { username, plan, subscriptionWeeks, nextPaymentDate, removeTrial } = req.body;

    console.log("🔧 Admin subscription update request:", { username, plan, subscriptionWeeks, nextPaymentDate, removeTrial });

    if (!username) {
      console.log("❌ Username is required");
      return res.status(400).json({ success: false, message: "Username is required" });
    }

    const user = await User.findOne({ username });
    if (!user) {
      console.log("❌ User not found:", username);
      return res.status(404).json({ success: false, message: "User not found" });
    }

    console.log("👤 Current user data:", {
      id: user._id,
      username: user.username,
      currentPlan: user.plan,
      trialActive: user.trialActive,
      subscriptionWeeks: user.subscriptionWeeks
    });

    const updates = {};

    // Update plan if provided
    if (plan) {
      updates.plan = plan.toLowerCase();
    }

    // Update subscription weeks if provided
    if (subscriptionWeeks !== undefined) {
      updates.subscriptionWeeks = parseInt(subscriptionWeeks);
    }

    // Update next payment date if provided
    if (nextPaymentDate) {
      updates.nextPaymentDate = nextPaymentDate;
    }

    // Remove trial status if requested
    if (removeTrial) {
      updates.trial = "none";
      updates.trialActive = false;
      updates.trialEndsAt = null;
    }

    console.log("🔄 Updates to apply:", updates);

    const updatedUser = await User.findByIdAndUpdate(user._id, updates, { new: true });

    if (!updatedUser) {
      console.log("❌ Failed to update user subscription in database");
      return res.status(500).json({ success: false, message: "Failed to update user subscription" });
    }

    console.log("✅ Admin subscription update successful");

    res.json({
      success: true,
      message: "Subscription updated successfully",
      data: { updatedUser }
    });
  } catch (error) {
    console.error("Admin subscription update error:", error);
    res.status(500).json({ success: false, message: "Server error during admin subscription update" });
  }
});

// ✅ Email Route
app.post("/send-reminder", async (req, res) => {
  try {
    console.log("🧾 Incoming request body:", req.body);

    const { to, subject, message } = req.body;

    if (!to || !subject || !message) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    await emailService.sendMail({
      to,
      subject,
      html: message,
      shopName: "Awesome Store"
    });
    res.json({ success: true });
  } catch (err) {
    console.error("❌ Email failed:", err);
    res.status(500).json({ error: "Internal error" });
  }
});

// --- UTILS ---

function groupByProductId(arr) {
  return arr.reduce((acc, item) => {
    acc[item.productId] = (acc[item.productId] || 0) + (item.quantity || 1);
    return acc;
  }, {});
}

function getTimeKey(date, range) {
  const d = new Date(date);
  switch (range) {
    case "hour": return d.toISOString().slice(0, 13); // YYYY-MM-DDTHH
    case "day": return d.toISOString().slice(0, 10);  // YYYY-MM-DD
    case "week": {
      const onejan = new Date(d.getFullYear(), 0, 1);
      const week = Math.ceil((((d - onejan) / 86400000) + onejan.getDay() + 1) / 7);
      return `${d.getFullYear()}-W${String(week).padStart(2, '0')}`;
    }
    case "month": return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    case "year": return `${d.getFullYear()}`;
    default: return d.toISOString().slice(0, 10);
  }
}

// --- ANALYTICS ROUTE ---

app.get("/seller/analytics", async (req, res) => {
  try {
    const seller = req.query.seller;
    const range = req.query.range || "month";
    if (!seller) return res.status(400).json({ success: false, message: "Missing seller parameter" });

    const ordersAll = await Order.find({});
    const cartAll = await Cart.find({});
    const wishlistAll = await Wishlist.find({});
    const productsAll = await Product.find({});

    const imageMap = {};
    const costMap = {};
    productsAll.forEach(p => {
      if (p.seller === seller) {
        imageMap[p.id] = p.image;
        costMap[p.id] = parseFloat(p.cost || 0);
      }
    });

    const orders = ordersAll.filter(o => o.seller === seller);
    const cart = cartAll.filter(c => c.seller === seller);
    const wishlist = wishlistAll;

    const productMap = {};
    const customers = new Set();
    const customerOrders = {};
    const salesOverTime = {};
    const hourBuckets = Array(24).fill(0);
    const salesByCountry = {}; // 📦 Country-wise revenue
    let earnings = 0;

    // Process orders
    for (const order of orders) {
      const pid = order.productId;
      const price = parseFloat(order.variant?.price || order.subtotal || 0);
      const quantity = order.quantity || 1;
      const deliveryFee = parseFloat(order.delivery?.fee || 0);
      const revenue = quantity * (price + deliveryFee);

      const country = order.delivery?.country || "Unknown";
      salesByCountry[country] = (salesByCountry[country] || 0) + revenue;

      if (!productMap[pid]) {
        productMap[pid] = {
          id: pid,
          name: order.productName,
          price,
          cost: deliveryFee,
          sold: 0,
          inCart: 0,
          inWishlist: 0,
          deliveryFees: 0,
          image: imageMap[pid] || order.productImage || null
        };
      }

      productMap[pid].sold += quantity;
      productMap[pid].deliveryFees += deliveryFee;
      earnings += revenue;

      const timeKey = getTimeKey(order.createdAt, range);
      salesOverTime[timeKey] = (salesOverTime[timeKey] || 0) + revenue;

      const hour = new Date(order.createdAt).getHours();
      hourBuckets[hour] += revenue;

      const buyerId = typeof order.buyer === "object" ? order.buyer.id : order.buyer;
      customers.add(buyerId);
      customerOrders[buyerId] = (customerOrders[buyerId] || 0) + 1;
    }

    // Cart
    const cartCounts = groupByProductId(cart);
    for (const pid in cartCounts) {
      if (!productMap[pid]) {
        const match = cart.find(c => c.productId === pid);
        productMap[pid] = {
          id: pid,
          name: match?.name || pid,
          price: parseFloat(match?.variant?.price || match?.price || 0),
          cost: costMap[pid] || 0,
          sold: 0,
          inCart: 0,
          inWishlist: 0,
          deliveryFees: 0,
          image: imageMap[pid] || match?.image || null
        };
      }
      productMap[pid].inCart = cartCounts[pid];
    }

    // Wishlist
    const relevantWishlists = wishlist.filter(w =>
      ordersAll.find(o => o.productId === w.productId && o.seller === seller)
    );
    const wishlistCounts = groupByProductId(relevantWishlists);
    for (const pid in wishlistCounts) {
      if (!productMap[pid]) {
        const match = orders.find(o => o.productId === pid);
        productMap[pid] = {
          id: pid,
          name: match?.productName || pid,
          price: parseFloat(match?.variant?.price || 0),
          cost: costMap[pid] || 0,
          sold: 0,
          inCart: 0,
          inWishlist: 0,
          deliveryFees: 0,
          image: imageMap[pid] || match?.productImage || null
        };
      }
      productMap[pid].inWishlist = wishlistCounts[pid];
    }

    const products = Object.values(productMap);
    const repeatCustomers = Object.values(customerOrders).filter(n => n > 1).length;

    const sortedKeys = Object.keys(salesOverTime).sort();
    const graphLabels = sortedKeys;
    const graphData = sortedKeys.map(k => salesOverTime[k]);

    // Best time to sell
    const bestTimeToSell = {
      labels: Array.from({ length: 24 }, (_, i) => `${i}:00`),
      sales: hourBuckets
    };

    // Profit margins
    const profitMargins = products.map(p => {
      const profitPerUnit = p.price - p.cost;
      const totalRevenue = p.sold * (p.price + p.cost);
      const totalProfit = profitPerUnit * p.sold;
      return {
        name: p.name,
        price: p.price,
        cost: p.cost,
        sold: p.sold,
        totalRevenue,
        profitPerUnit,
        totalProfit
      };
    });

    // Funnel
    const funnel = {
      views: productsAll.filter(p => p.seller === seller).reduce((sum, p) => sum + (p.views || 0), 0),
      addedToCart: cart.length,
      checkout: orders.length,
      completed: orders.length
    };

    // 🗺️ Final formatted sales by region
    const salesByRegion = Object.entries(salesByCountry)
      .map(([country, amount]) => ({ country, amount }))
      .sort((a, b) => b.amount - a.amount);

    res.json({
      success: true,
      data: {
        storeName: seller,
        products,
        earnings,
        customers: {
          total: customers.size,
          repeat: repeatCustomers
        },
        months: graphLabels,
        monthlySales: graphData,
        bestTimeToSell,
        profitMargins,
        funnel,
        salesByRegion
      }
    });

  } catch (err) {
    console.error("Analytics error:", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
});

app.post("/track-view", async (req, res) => {
  try {
    const { productId, seller } = req.body;
    if (!productId || !seller) {
      return res.status(400).json({ success: false, message: "Missing productId or seller" });
    }

    const updated = await Product.updateOne(
      { id: productId, seller },
      { $inc: { views: 1 } }
    );

    if (updated.modifiedCount === 0) {
      return res.status(404).json({ success: false, message: "Product not found" });
    }

    res.status(200).json({ success: true });
  } catch (err) {
    console.error("View tracking error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// Password reset functionality
const resetRequests = {}; // In production, use Redis or DB

// 1️⃣ Send reset code
app.post("/auth/request-reset", async (req, res) => {
  try {
    const { email } = req.body;
    const user = await User.findOne({ email });
    if (!user) return res.status(404).json({ success: false, message: "User not found." });

    const code = crypto.randomBytes(3).toString("hex").toUpperCase();
    const expires = Date.now() + 5 * 60 * 1000; // 5 mins

    resetRequests[email] = { code, expires };

    await emailService.sendMail({
      to: email,
      subject: "Your password reset code",
      html: `<p>Here is your password reset code: <strong>${code}</strong></p>`,
      shopName: "Iyonicorp"
    });

    return res.json({ success: true });
  } catch (err) {
    console.error("Password reset request error:", err);
    return res.status(500).json({ success: false, message: "Email failed to send." });
  }
});

// 2️⃣ Verify reset code
app.post("/auth/verify-reset-code", (req, res) => {
  const { email, code } = req.body;
  const record = resetRequests[email];
  if (!record || record.code !== code || Date.now() > record.expires) {
    return res.status(400).json({ success: false, message: "Invalid or expired code." });
  }
  return res.json({ success: true });
});

// 3️⃣ Reset password
app.post("/auth/reset-password", async (req, res) => {
  try {
    const { email, code, newPassword } = req.body;
    const record = resetRequests[email];
    if (!record || record.code !== code || Date.now() > record.expires) {
      return res.status(400).json({ success: false, message: "Invalid or expired code." });
    }

    const user = await User.findOne({ email });
    if (!user) return res.status(404).json({ success: false, message: "User not found." });

    const updatedUser = await User.findByIdAndUpdate(user._id, { password: newPassword }, { new: true });
    if (!updatedUser) {
      return res.status(500).json({ success: false, message: "Failed to update password." });
    }

    delete resetRequests[email];

    // ✅ Send confirmation email
    try {
      await emailService.sendMail({
        to: email,
        subject: "Your password was successfully changed",
        html: `
          <p>Hi,</p>
          <p>Your password has been successfully updated. If this wasn't you, please contact support immediately.</p>
          <p>Thank you,<br>Iyonicorp Support Team</p>
        `,
        shopName: "Iyonicorp"
      });
    } catch (emailErr) {
      console.error("Confirmation email failed:", emailErr);
      return res.json({ success: true, warning: "Password updated but confirmation email failed." });
    }

    return res.json({ success: true });
  } catch (error) {
    console.error("Password reset error:", error);
    res.status(500).json({ success: false, message: "Server error during password reset." });
  }
});






// (Removed older disk-based /upload-files route in favor of Mongo-backed route defined above)









// ✅ Coupon Management API Endpoints

// Get coupons for a seller
app.get("/coupons", async (req, res) => {
  try {
    const { seller } = req.query;
    if (!seller) return res.status(400).json({ success: false, message: "Missing seller parameter" });

    const coupons = await Coupon.find({ seller });
    res.json({ success: true, data: coupons });
  } catch (err) {
    console.error("Failed to fetch coupons:", err);
    res.status(500).json({ success: false, message: "Server error while fetching coupons" });
  }
});

// Validate and apply coupon
app.post("/validate-coupon", async (req, res) => {
  try {
    const { code, seller, orderTotal, productIds } = req.body;
    
    if (!code || !seller || !orderTotal) {
      return res.status(400).json({ success: false, message: "Missing required fields" });
    }

    const coupon = await Coupon.findOne({
      code: code.toUpperCase(),
      seller,
      status: "active"
    });
    
    if (!coupon) {
      return res.status(404).json({ success: false, message: "Invalid or inactive coupon code" });
    }

    // Check expiry date
    if (coupon.expiryDate && new Date(coupon.expiryDate) < new Date()) {
      return res.status(400).json({ success: false, message: "Coupon has expired" });
    }

    // Check usage limit
    if (coupon.usageLimit && (coupon.usedCount || 0) >= coupon.usageLimit) {
      return res.status(400).json({ success: false, message: "Coupon usage limit reached" });
    }

    // Check minimum order amount
    if (coupon.minOrderAmount && orderTotal < coupon.minOrderAmount) {
      return res.status(400).json({
        success: false,
        message: `Minimum order amount of ${getCurrencySymbol("USD")}${coupon.minOrderAmount} required`
      });
    }

    // Check product applicability
    if (coupon.applicableProducts === "specific" && productIds) {
      const hasApplicableProduct = productIds.some(id => coupon.productIds.includes(id));
      if (!hasApplicableProduct) {
        return res.status(400).json({ success: false, message: "Coupon not applicable to selected products" });
      }
    }

    // Calculate discount
    let discountAmount = 0;
    if (coupon.type === "percentage") {
      discountAmount = (orderTotal * coupon.value) / 100;
    } else {
      discountAmount = Math.min(coupon.value, orderTotal);
    }

    res.json({
      success: true,
      data: {
        valid: true,
        coupon: {
          id: coupon.id,
          code: coupon.code,
          type: coupon.type,
          value: coupon.value
        },
        discountAmount: parseFloat(discountAmount.toFixed(2)),
        finalTotal: parseFloat((orderTotal - discountAmount).toFixed(2))
      }
    });

  } catch (err) {
    console.error("Coupon validation error:", err);
    res.status(500).json({ success: false, message: "Server error during coupon validation" });
  }
});

// Apply coupon (increment usage count)
app.post("/apply-coupon", async (req, res) => {
  try {
    const { couponId, discountAmount } = req.body;
    
    if (!couponId || discountAmount === undefined) {
      return res.status(400).json({ success: false, message: "Missing coupon ID or discount amount" });
    }

    // Handle both Mongo _id and custom coupon.id
    let coupon = null;
    try {
      const isObjectId = require('mongoose').Types.ObjectId.isValid(couponId);
      coupon = isObjectId ? await Coupon.findById(couponId) : await Coupon.findOne({ id: couponId });
    } catch (e) {
      // Fallback to custom id query
      coupon = await Coupon.findOne({ id: couponId });
    }

    if (!coupon) {
      return res.status(404).json({ success: false, message: "Coupon not found" });
    }

    const discount = Number(discountAmount) || 0;
    const newUsedCount = (coupon.usedCount || 0) + 1;
    const newTotalSavings = parseFloat(((coupon.totalSavings || 0) + discount).toFixed(2));

    // Update by the same identifier type we resolved with
    const identifier = coupon._id ? { _id: coupon._id } : { id: couponId };
    const updatedCoupon = await Coupon.findOneAndUpdate(
      identifier,
      {
        usedCount: newUsedCount,
        totalSavings: newTotalSavings
      },
      { new: true }
    );

    if (!updatedCoupon) {
      return res.status(404).json({ success: false, message: "Failed to update coupon usage" });
    }

    res.json({
      success: true,
      message: "Coupon applied successfully",
      data: {
        usedCount: newUsedCount,
        totalSavings: newTotalSavings
      }
    });

  } catch (err) {
    console.error("Apply coupon error:", err);
    res.status(500).json({ success: false, message: "Server error while applying coupon" });
  }
});

// Admin Panel Backend Integration Endpoints

// Update any collection data (for admin panel) - RESTRICTED
app.post("/admin/update", async (req, res) => {
  try {
    const { type, orderId, status } = req.body;
    
    // Only allow order status updates
    if (type === 'order_status' && orderId && status) {
      const updated = await Order.updateOne({ orderId }, { status });
      
      if (updated.modifiedCount === 0) {
        return res.status(404).json({ success: false, message: "Order not found" });
      }

      res.json({
        success: true,
        message: `Order status updated to ${status}`,
        data: { updated: updated.modifiedCount }
      });

    } else {
      return res.status(403).json({ success: false, message: "Operation not allowed" });
    }
  } catch (err) {
    console.error("Admin update error:", err);
    res.status(500).json({ success: false, message: "Server error during admin update" });
  }
});

// Update order status endpoint for dashboard
app.patch("/order-status", async (req, res) => {
  try {
    const { id, status } = req.body;
    
    if (!id || !status) {
      return res.status(400).json({ 
        success: false, 
        message: "Missing required fields: id and status are required" 
      });
    }

    // Validate status values
    const validStatuses = ['Pending', 'Processing', 'Shipped', 'Delivered', 'Cancelled'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ 
        success: false, 
        message: `Invalid status value. Must be one of: ${validStatuses.join(', ')}` 
      });
    }

    // Try to find and update the order by the 'id' field (not MongoDB _id)
    const updated = await Order.updateOne({ id }, { status });
    
    if (updated.modifiedCount === 0) {
      // If not found by 'id', try by 'orderId' field as fallback
      const updatedByOrderId = await Order.updateOne({ orderId: id }, { status });
      
      if (updatedByOrderId.modifiedCount === 0) {
        return res.status(404).json({ 
          success: false, 
          message: "Order not found" 
        });
      }
    }

    // Find the updated order to get buyer information for email notification
    const order = await Order.findOne({ $or: [{ id }, { orderId: id }] });
    
    if (order && order.buyer) {
      try {
        // Send email notification to buyer
        const buyerEmail = typeof order.buyer === 'object' ? order.buyer.email : order.buyer;
        const statusText = status.toLowerCase();
        
        await emailService.sendMail({
          to: buyerEmail,
          subject: `Order Update - Your order is now ${statusText}`,
          html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
              <h2>Order Status Update</h2>
              <p>Hello,</p>
              <p>Your order <strong>#${order.orderId || order.id}</strong> status has been updated to <strong>${status}</strong>.</p>
              <div style="background: #f5f5f5; padding: 15px; border-radius: 5px; margin: 20px 0;">
                <p><strong>Product:</strong> ${order.productName}</p>
                <p><strong>Status:</strong> ${status}</p>
                <p><strong>Order ID:</strong> ${order.orderId || order.id}</p>
              </div>
              <p>Thank you for your business!</p>
            </div>
          `,
          shopName: order.seller || "Your Store"
        });
      } catch (emailError) {
        console.error("Failed to send order status email:", emailError);
        // Don't fail the request if email fails
      }
    }

    res.json({
      success: true,
      message: `Order status updated to ${status}`,
      data: { updated: true }
    });

  } catch (err) {
    console.error("Order status update error:", err);
    res.status(500).json({ 
      success: false, 
      message: "Server error during order status update",
      error: err.message 
    });
  }
});

// Change seller theme (for admin panel)
app.post("/admin/change-theme", async (req, res) => {
  try {
    const { username, theme } = req.body;
    
    if (!username || !theme) {
      return res.status(400).json({ success: false, message: "Missing username or theme" });
    }

    const allowedThemes = ['classic', 'modern', 'cyber', 'vintage', 'minimalist','elegant', 'nature'];
    if (!allowedThemes.includes(theme)) {
      return res.status(400).json({ success: false, message: "Invalid theme selected" });
    }

    // Load the layout HTML from the theme file
    const layoutPath = path.join(__dirname, "layouts", `${theme}.html`);
    if (!fs.existsSync(layoutPath)) {
      return res.status(404).json({ success: false, message: "Theme layout file not found" });
    }

    const layoutHTML = fs.readFileSync(layoutPath, "utf-8");

    const currentUser = await User.findOne({ username });
    if (!currentUser) {
      return res.status(404).json({ success: false, message: "Seller not found" });
    }
    
    // Check if user is actually a seller
    if (!currentUser.role || !currentUser.role.startsWith("seller")) {
      return res.status(400).json({ success: false, message: "User is not a seller" });
    }

    const existingTheme = currentUser.customTheme || {};

    // Update the theme layout while preserving custom theme settings
    const updatedTheme = {
      ...existingTheme,
      layout: theme
    };

    const updatedUser = await User.findByIdAndUpdate(
      currentUser._id,
      {
        layoutTheme: theme,
        layoutHTML: layoutHTML,
        customTheme: updatedTheme,
        themeUpdatedAt: new Date().toISOString()
      },
      { new: true }
    );
    
    if (!updatedUser) {
      return res.status(404).json({ success: false, message: "Failed to update seller theme" });
    }

    res.json({
      success: true,
      message: `Theme changed to ${theme} for ${username}`
    });

  } catch (err) {
    console.error("Theme change error:", err);
    res.status(500).json({ success: false, message: "Server error during theme change" });
  }
});

// Send subscription email notifications
app.post("/admin/send-subscription-email", async (req, res) => {
  try {
    const { username, emailType, customMessage } = req.body;
    
    if (!username || !emailType) {
      return res.status(400).json({ success: false, message: "Missing required fields" });
    }

    const seller = await User.findOne({ username });
    if (!seller) {
      return res.status(404).json({ success: false, message: "Seller not found" });
    }

    let subject, htmlContent;

    switch (emailType) {
      case 'expiring':
        subject = `⚠️ Your ${seller.plan} subscription expires soon`;
        htmlContent = `
          <div style="font-family:sans-serif;max-width:600px;margin:auto;">
            <h2>Hi ${seller.username},</h2>
            <p>Your <strong>${seller.plan}</strong> subscription will expire in ${seller.subscriptionWeeks || 0} week(s).</p>
            <p>To continue enjoying premium features, please renew your subscription.</p>
            ${customMessage ? `<p><strong>Additional message:</strong> ${customMessage}</p>` : ''}
            <a href="http://localhost:3000/dashboard.html?seller=${encodeURIComponent(seller.username)}"
               style="display:inline-block;padding:10px 20px;background:#4f46e5;color:#fff;text-decoration:none;border-radius:6px;">
              Renew Subscription
            </a>
            <hr style="margin:30px 0;border:none;border-top:1px solid #ccc;">
            <p style="font-size:0.9em;color:#888;">This is an automated notification from ShopRight Admin.</p>
          </div>
        `;
        break;
      case 'expired':
        subject = `❌ Your ${seller.plan} subscription has expired`;
        htmlContent = `
          <div style="font-family:sans-serif;max-width:600px;margin:auto;">
            <h2>Hi ${seller.username},</h2>
            <p>Your <strong>${seller.plan}</strong> subscription has expired.</p>
            <p>Your account has been downgraded to free tier. Renew now to restore premium features.</p>
            ${customMessage ? `<p><strong>Additional message:</strong> ${customMessage}</p>` : ''}
            <a href="http://localhost:3000/dashboard.html?seller=${encodeURIComponent(seller.username)}"
               style="display:inline-block;padding:10px 20px;background:#ef4444;color:#fff;text-decoration:none;border-radius:6px;">
              Renew Now
            </a>
            <hr style="margin:30px 0;border:none;border-top:1px solid #ccc;">
            <p style="font-size:0.9em;color:#888;">This is an automated notification from ShopRight Admin.</p>
          </div>
        `;
        break;
      case 'renewed':
        subject = `✅ Your ${seller.plan} subscription has been renewed`;
        htmlContent = `
          <div style="font-family:sans-serif;max-width:600px;margin:auto;">
            <h2>Hi ${seller.username},</h2>
            <p>Great news! Your <strong>${seller.plan}</strong> subscription has been renewed.</p>
            <p>You now have ${seller.subscriptionWeeks || 0} week(s) remaining.</p>
            ${customMessage ? `<p><strong>Additional message:</strong> ${customMessage}</p>` : ''}
            <a href="http://localhost:3000/dashboard.html?seller=${encodeURIComponent(seller.username)}"
               style="display:inline-block;padding:10px 20px;background:#10b981;color:#fff;text-decoration:none;border-radius:6px;">
              Go to Dashboard
            </a>
            <hr style="margin:30px 0;border:none;border-top:1px solid #ccc;">
            <p style="font-size:0.9em;color:#888;">This is an automated notification from ShopRight Admin.</p>
          </div>
        `;
        break;
      case 'plan_updated':
        subject = `🔄 Your subscription plan has been updated`;
        htmlContent = `
          <div style="font-family:sans-serif;max-width:600px;margin:auto;">
            <h2>Hi ${seller.username},</h2>
            <p>Your subscription plan has been updated to <strong>${seller.plan}</strong>.</p>
            <p>You have ${seller.subscriptionWeeks || 0} week(s) remaining on your new plan.</p>
            ${customMessage ? `<p><strong>Additional message:</strong> ${customMessage}</p>` : ''}
            <a href="http://localhost:3000/dashboard.html?seller=${encodeURIComponent(seller.username)}"
               style="display:inline-block;padding:10px 20px;background:#4f46e5;color:#fff;text-decoration:none;border-radius:6px;">
              View Dashboard
            </a>
            <hr style="margin:30px 0;border:none;border-top:1px solid #ccc;">
            <p style="font-size:0.9em;color:#888;">This is an automated notification from ShopRight Admin.</p>
          </div>
        `;
        break;
      default:
        return res.status(400).json({ success: false, message: "Invalid email type" });
    }

    await emailService.sendMail({
      to: seller.email,
      subject: subject,
      html: htmlContent,
      shopName: "ShopRight Admin"
    });

    res.json({
      success: true,
      message: `${emailType} email sent to ${seller.username}`
    });

  } catch (err) {
    console.error("Email sending error:", err);
    res.status(500).json({ success: false, message: "Server error while sending email" });
  }
});



// Push product to marketplace
app.post("/admin/push-to-marketplace", async (req, res) => {
  const { productId } = req.body;
  
  if (!productId) {
    return res.status(400).json({ success: false, message: "Missing product ID" });
  }

  try {
    const product = await Product.findOne({ id: productId });
    if (!product) {
      return res.status(404).json({ success: false, message: "Product not found" });
    }
    
    // Update product to be featured on marketplace
    const updatedProduct = await Product.findByIdAndUpdate(
      product._id,
      {
        featured: true,
        marketplacePush: true,
        marketplacePushDate: new Date().toISOString()
      },
      { new: true }
    );

    if (!updatedProduct) {
      return res.status(404).json({ success: false, message: "Failed to update product" });
    }

    res.json({
      success: true,
      message: `Product "${product.name}" pushed to marketplace successfully`
    });

  } catch (err) {
    console.error("Push to marketplace error:", err);
    res.status(500).json({ success: false, message: "Server error while pushing product" });
  }
});

// Delete product
app.post("/admin/delete-product", async (req, res) => {
  const { productId } = req.body;
  
  if (!productId) {
    return res.status(400).json({ success: false, message: "Missing product ID" });
  }

  try {
    const product = await Product.findOne({ id: productId });
    if (!product) {
      return res.status(404).json({ success: false, message: "Product not found" });
    }
    
    // Delete the product
    const deletedProduct = await Product.findByIdAndDelete(product._id);

    if (!deletedProduct) {
      return res.status(404).json({ success: false, message: "Failed to delete product" });
    }

    res.json({
      success: true,
      message: `Product "${product.name}" deleted successfully`
    });

  } catch (err) {
    console.error("Delete product error:", err);
    res.status(500).json({ success: false, message: "Server error while deleting product" });
  }
});

// Delete records (for admin panel) - RESTRICTED
app.post("/admin/delete", async (req, res) => {
  const { type, username, orderId } = req.body;
  
  if (!type) {
    return res.status(400).json({ success: false, message: "Missing type parameter" });
  }

  try {
    let result = null;
    let message = "";

    if (type === 'user' && username) {
      // Allow deletion of users
      result = await User.deleteOne({ username });
      message = `User "${username}" deleted successfully`;
    } else if (type === 'order' && orderId) {
      // Allow deletion of orders
      result = await Order.deleteOne({ orderId });
      message = `Order "${orderId}" deleted successfully`;
    } else {
      return res.status(400).json({ success: false, message: "Invalid delete operation" });
    }
    
    if (result.deletedCount === 0) {
      return res.status(404).json({ success: false, message: "No records deleted" });
    }

    res.json({
      success: true,
      message: message,
      data: { deleted: result.deletedCount }
    });

  } catch (err) {
    console.error("Admin delete error:", err);
    res.status(500).json({ success: false, message: "Server error during admin delete" });
  }
});

// Get all data for admin dashboard with currency separation
app.get("/admin/dashboard", async (req, res) => {
  const { type, username } = req.query;
  
  try {
    const users = await User.find({});
    const orders = await Order.find({});
    const products = await Product.find({});
    const coupons = await Coupon.find({});

    // Handle seller details request
    if (type === 'seller_details' && username) {
      const seller = users.find(u => u.username === username && u.role && u.role.startsWith("seller"));
      if (!seller) {
        return res.status(404).json({ success: false, message: "Seller not found" });
      }
      
      const sellerProducts = products.filter(p => p.seller === username);
      const sellerOrders = orders.filter(o => o.seller === username);
      
      return res.json({
        success: true,
        data: {
          seller,
          products: sellerProducts,
          orders: sellerOrders
        }
      });
    }

    // Calculate summary stats with currency separation
    const sellers = users.filter(u => u.role && u.role.startsWith("seller"));
    const buyers = users.filter(u => u.role === "buyer" || u.role === "user");
    
    // Group revenue by currency
    const revenueByCurrency = {};
    orders.forEach(order => {
      const currency = order.currency || 'USD';
      const total = parseFloat(order.total || 0);
      revenueByCurrency[currency] = (revenueByCurrency[currency] || 0) + total;
    });

    const activeCoupons = coupons.filter(c => c.status === "active");

    res.json({
      success: true,
      data: {
        summary: {
          totalUsers: users.length,
          totalSellers: sellers.length,
          totalBuyers: buyers.length,
          totalOrders: orders.length,
          totalProducts: products.length,
          revenueByCurrency,
          activeCoupons: activeCoupons.length
        },
        users,
        orders,
        products,
        coupons
      }
    });

  } catch (err) {
    console.error("Admin dashboard error:", err);
    res.status(500).json({ success: false, message: "Server error while fetching admin data" });
  }
});

// Suspend seller endpoint
app.post("/admin/suspend-seller", async (req, res) => {
  const { username, action } = req.body;
  
  if (!username || action !== 'suspend') {
    return res.status(400).json({ success: false, message: "Missing username or invalid action" });
  }

  try {
    const seller = await User.findOne({ username });
    if (!seller) {
      return res.status(404).json({ success: false, message: "Seller not found" });
    }
    
    // Check if user is actually a seller
    if (!seller.role || !seller.role.startsWith("seller")) {
      return res.status(400).json({ success: false, message: "User is not a seller" });
    }

    // Update seller status to suspended
    const updatedSeller = await User.findByIdAndUpdate(
      seller._id,
      {
        status: 'suspended',
        suspendedAt: new Date().toISOString(),
        suspendedBy: 'admin'
      },
      { new: true }
    );
    
    if (!updatedSeller) {
      return res.status(404).json({ success: false, message: "Failed to suspend seller" });
    }

    // Send suspension email notification
    try {
      await emailService.sendMail({
        to: seller.email,
        subject: `⚠️ Your ${seller.username} account has been suspended`,
        html: `
          <div style="font-family:sans-serif;max-width:600px;margin:auto;">
            <h2>Account Suspended</h2>
            <p>Dear ${seller.username},</p>
            <p>Your seller account has been suspended by the administrator.</p>
            <p>You will no longer be able to access your dashboard until your account is restored.</p>
            <p>If you believe this is an error, please contact support immediately.</p>
            <hr style="margin:30px 0;border:none;border-top:1px solid #ccc;">
            <p style="font-size:0.9em;color:#888;">This is an automated notification from ShopRight Admin.</p>
          </div>
        `,
        shopName: "ShopRight Admin"
      });
    } catch (emailErr) {
      console.error("Failed to send suspension email:", emailErr);
    }

    res.json({
      success: true,
      message: `Seller "${username}" has been suspended successfully`
    });

  } catch (err) {
    console.error("Suspend seller error:", err);
    res.status(500).json({ success: false, message: "Server error while suspending seller" });
  }
});

// Unsuspend seller endpoint
app.post("/admin/unsuspend-seller", async (req, res) => {
  const { username, action } = req.body;
  
  if (!username || action !== 'unsuspend') {
    return res.status(400).json({ success: false, message: "Missing username or invalid action" });
  }

  try {
    const seller = await User.findOne({ username });
    if (!seller) {
      return res.status(404).json({ success: false, message: "Seller not found" });
    }
    
    // Check if user is actually a seller
    if (!seller.role || !seller.role.startsWith("seller")) {
      return res.status(400).json({ success: false, message: "User is not a seller" });
    }

    // Update seller status to active
    const updatedSeller = await User.findByIdAndUpdate(
      seller._id,
      {
        status: 'active',
        unsuspendedAt: new Date().toISOString(),
        unsuspendedBy: 'admin',
        suspendedAt: null,
        suspendedBy: null
      },
      { new: true }
    );
    
    if (!updatedSeller) {
      return res.status(404).json({ success: false, message: "Failed to unsuspend seller" });
    }

    // Send unsuspension email notification
    try {
      await emailService.sendMail({
        to: seller.email,
        subject: `✅ Your ${seller.username} account has been restored`,
        html: `
          <div style="font-family:sans-serif;max-width:600px;margin:auto;">
            <h2>Account Restored</h2>
            <p>Dear ${seller.username},</p>
            <p>Good news! Your seller account has been restored by the administrator.</p>
            <p>You can now access your dashboard and continue managing your store.</p>
            <a href="http://localhost:3000/dashboard.html?seller=${encodeURIComponent(seller.username)}"
               style="display:inline-block;padding:10px 20px;background:#10b981;color:#fff;text-decoration:none;border-radius:6px;">
              Access Dashboard
            </a>
            <hr style="margin:30px 0;border:none;border-top:1px solid #ccc;">
            <p style="font-size:0.9em;color:#888;">This is an automated notification from ShopRight Admin.</p>
          </div>
        `,
        shopName: "ShopRight Admin"
      });
    } catch (emailErr) {
      console.error("Failed to send unsuspension email:", emailErr);
    }

    res.json({
      success: true,
      message: `Seller "${username}" has been unsuspended successfully`
    });

  } catch (err) {
    console.error("Unsuspend seller error:", err);
    res.status(500).json({ success: false, message: "Server error while unsuspending seller" });
  }
});

// Delete seller endpoint
app.post("/admin/delete-seller", async (req, res) => {
  const { username, action } = req.body;
  
  if (!username || action !== 'delete') {
    return res.status(400).json({ success: false, message: "Missing username or invalid action" });
  }

  try {
    const seller = await User.findOne({ username });
    if (!seller) {
      return res.status(404).json({ success: false, message: "Seller not found" });
    }
    
    // Check if user is actually a seller
    if (!seller.role || !seller.role.startsWith("seller")) {
      return res.status(400).json({ success: false, message: "User is not a seller" });
    }

    // Send deletion email notification before deleting
    try {
      await emailService.sendMail({
        to: seller.email,
        subject: `❌ Your ${seller.username} account has been deleted`,
        html: `
          <div style="font-family:sans-serif;max-width:600px;margin:auto;">
            <h2>Account Deleted</h2>
            <p>Dear ${seller.username},</p>
            <p>Your seller account has been permanently deleted by the administrator.</p>
            <p>All your data, including products, orders, and settings have been removed from our system.</p>
            <p>If you believe this is an error, please contact support immediately.</p>
            <hr style="margin:30px 0;border:none;border-top:1px solid #ccc;">
            <p style="font-size:0.9em;color:#888;">This is an automated notification from ShopRight Admin.</p>
          </div>
        `,
        shopName: "ShopRight Admin"
      });
    } catch (emailErr) {
      console.error("Failed to send deletion email:", emailErr);
    }

    // Delete seller's products
    const deletedProducts = await Product.deleteMany({ seller: username });

    // Delete seller's orders
    const deletedOrders = await Order.deleteMany({ seller: username });

    // Delete seller's coupons
    const deletedCoupons = await Coupon.deleteMany({ seller: username });

    // Finally delete the seller account
    const deletedUser = await User.deleteOne({ username });
    
    if (deletedUser.deletedCount === 0) {
      return res.status(404).json({ success: false, message: "Failed to delete seller" });
    }

    res.json({
      success: true,
      message: `Seller "${username}" and all associated data have been deleted successfully`,
      data: {
        deletedProducts: deletedProducts.deletedCount,
        deletedOrders: deletedOrders.deletedCount,
        deletedCoupons: deletedCoupons.deletedCount
      }
    });

  } catch (err) {
    console.error("Delete seller error:", err);
    res.status(500).json({ success: false, message: "Server error while deleting seller" });
  }
});

// ========== NEW: Force Logout - Admin Triggers Logout ==========
app.post("/admin/force-logout-seller", async (req, res) => {
  const { username } = req.body;
  if (!username) {
    return res.status(400).json({ success: false, message: "Username is required" });
  }

  const user = await User.findOne({ username });
  if (!user) {
    return res.status(404).json({ success: false, message: "Seller not found" });
  }

  // Set a forced logout timestamp
  const forceLogoutAt = new Date().toISOString();
  const updatedUser = await User.findByIdAndUpdate(
    user._id,
    { forceLogoutAt },
    { new: true }
  );

  if (updatedUser) {
    console.log(`🔐 Admin forced logout for seller: ${username} at ${forceLogoutAt}`);
    return res.json({ success: true, message: `Seller "${username}" has been logged out.` });
  } else {
    return res.status(500).json({ success: false, message: "Failed to update user" });
  }
});

app.post("/check-user-status", async (req, res) => {
  const { username } = req.body;
  if (!username) {
    return res.status(400).json({ success: false, message: "Username is required" });
  }

  const user = await User.findOne({ username });
  if (!user) {
    return res.status(404).json({ success: false, message: "User not found" });
  }

  // Check if force logout is active based on timestamp
  let forceLogout = false;
  if (user.forceLogoutAt) {
    const forceLogoutTime = new Date(user.forceLogoutAt).getTime();
    const now = Date.now();
    // Force logout is active if it was set within the last 5 minutes
    forceLogout = (now - forceLogoutTime) < (5 * 60 * 1000);
    
    // Clear the force logout flag after it's been checked
    if (forceLogout) {
      await User.findByIdAndUpdate(user._id, { forceLogoutAt: null });
    }
  }

  res.json({
    success: true,
    data: {
      status: user.status || 'active',
      suspended: user.status === 'suspended',
      forceLogout: forceLogout,
      role: user.role
    }
  });
});

// 🔹 PATCH individual order by ID
app.patch("/orders/:id", async (req, res) => {
  try {
    const orderId = req.params.id;
    const { status } = req.body;
    
    if (!status) {
      return res.status(400).json({ success: false, message: "Missing status in request body" });
    }

    const validStatuses = ["Confirmed", "Ready", "Delivered", "Cancelled", "Declined"];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ success: false, message: "Invalid status value." });
    }

    // Try to find order by MongoDB _id first, then by custom id field
    let order = await Order.findById(orderId);
    if (!order) {
      order = await Order.findOne({ id: orderId });
    }
    
    if (!order) {
      return res.status(404).json({ success: false, message: "Order not found" });
    }

    // Update the order status
    if (order._id) {
      await Order.updateOne({ _id: order._id }, { status });
    } else {
      await Order.updateOne({ id: orderId }, { status });
    }

    const seller = await User.findOne({ username: order.seller });
    const shopName = seller?.customTheme?.name || seller?.username || "Iyonicorp";

    const currency = order?.shopSettings?.storeCurrency || "USD";
    const symbol = getCurrencySymbol(currency);
    const buyerEmail = order?.buyer?.email;
    const buyerName = order?.buyer?.name;
    const productName = order.productName || "Unnamed Product";

    const statusMessages = {
      Confirmed: "✅ Your order has been confirmed!",
      Ready: "📦 Your order is ready for pickup/delivery!",
      Delivered: "🎉 Your order has been delivered!",
      Cancelled: "⚠️ Your order was cancelled.",
      Declined: "❌ Your order was declined."
    };

    const dashboardLink = `https://api.iyonicorp.com/dashboard.html?email=${encodeURIComponent(buyerEmail)}`;

    // Send email notification to buyer
    if (buyerEmail) {
      await emailService.sendMail({
        to: buyerEmail,
        subject: `📢 Order Update: "${status}"`,
        html: `
          <div style="font-family:sans-serif;max-width:600px;margin:auto;">
            <h2>Hi ${buyerName},</h2>
            <p>${statusMessages[status]}</p>
            <img src="${order.productImage}" alt="${productName}" style="width:100%;max-width:300px;border-radius:8px;margin-top:10px;" />
            <p style="margin-top:20px;">Track your order:</p>
            <a href="${dashboardLink}" style="display:inline-block;padding:10px 20px;background:#4f46e5;color:#fff;text-decoration:none;border-radius:6px;">📋 View Order Dashboard</a>
          </div>
        `,
        shopName
      });
    }

    return res.json({ 
      success: true, 
      message: "Order status updated successfully",
      data: { 
        orderId: orderId,
        status: status
      }
    });

  } catch (error) {
    console.error("Update order by ID error:", error);
    return res.status(500).json({ 
      success: false, 
      message: "Server error during order status update" 
    });
  }
});

// -------------------------------
// 🚀 Start Server
// -------------------------------
function getLocalIp() {
  const interfaces = os.networkInterfaces();
  for (const name in interfaces) {
    for (const iface of interfaces[name]) {
      if (iface.family === "IPv4" && !iface.internal) {
        return iface.address;
      }
    }
  }
  return "localhost";
}


// Initialize database and start server
async function startServer() {
  try {
    app.listen(PORT, HOST, () => {
      const localIp = getLocalIp();
      console.log(`✅ Server is running on:`);
      console.log(`   Local:    http://localhost:${PORT}`);
      console.log(`   Network:  http://${localIp}:${PORT}`);
    });
  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
}

// Start the server
startServer();

