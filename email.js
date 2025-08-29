require("dotenv").config();
const nodemailer = require("nodemailer");

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || "mail.privateemail.com",
  port: process.env.SMTP_PORT || 587,
  secure: false, // TLS on port 587
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  },
  tls: {
    rejectUnauthorized: false // sometimes helps with self-signed certs
  }
});


// Verify transporter configuration
transporter.verify((error, success) => {
  if (error) {
    console.error("❌ Email transporter configuration error:", error);
  } else {
    console.log("✅ Email server is ready to send messages");
  }
});

module.exports.sendMail = async ({ to, subject, html, shopName = "ShopRight" }) => {
  try {
    // Validate email address
    if (!to || !to.includes('@')) {
      throw new Error('Invalid recipient email address');
    }

    // Validate required fields
    if (!subject || !html) {
      throw new Error('Subject and HTML content are required');
    }

    const mailOptions = {
      from: `"${shopName}" <${process.env.SMTP_USER}>`,
      to: to.trim(), // Ensure no whitespace issues
      subject,
      html
    };

    console.log(`📧 Sending email to: ${to}`);
    console.log(`📧 Subject: ${subject}`);
    
    const info = await transporter.sendMail(mailOptions);
    
    console.log("✅ Email sent successfully:", info.messageId);
    console.log("📧 Recipient:", to);
    
    return {
      success: true,
      messageId: info.messageId,
      recipient: to
    };
    
  } catch (error) {
    console.error("❌ Email sending failed:", error);
    throw error;
  }
};
