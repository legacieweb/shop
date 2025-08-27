require("dotenv").config();
const nodemailer = require("nodemailer");

const transporter = nodemailer.createTransport({
  host: "smtp.gmail.com",
  port: 587,
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
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

module.exports.sendMail = async ({ to, subject, html, shopName = "iyonicorp" }) => {
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

// Test email function for admin
module.exports.testEmail = async (testRecipient) => {
  try {
    return await module.exports.sendMail({
      to: testRecipient,
      subject: "🧪 Email System Test - iyonicorp Admin",
      html: `
        <div style="font-family:sans-serif;max-width:600px;margin:auto;padding:20px;">
          <h2>Email System Test</h2>
          <p>This is a test email to verify that the email system is working correctly.</p>
          <p><strong>Timestamp:</strong> ${new Date().toISOString()}</p>
          <p><strong>Recipient:</strong> ${testRecipient}</p>
          <hr style="margin:20px 0;">
          <p style="color:#666;font-size:14px;">This test was sent from the iyonicorp Admin Panel.</p>
        </div>
      `,
      shopName: "iyonicorp Admin"
    });
  } catch (error) {
    console.error("❌ Test email failed:", error);
    throw error;
  }
};
