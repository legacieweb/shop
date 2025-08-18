const cron = require('node-cron');
const nodemailer = require('nodemailer');
const db = require('./db'); // Adjust to your actual db utility path

// Email transporter
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: 'iyonicorp@gmail.com',
    pass: 'dikfirjarvijwskx'
  }
});

async function sendEmail(to, subject, html) {
  try {
    await transporter.sendMail({
      from: '"Subscription Team" <iyonicorp@gmail.com>',
      to,
      subject,
      html
    });
    console.log(`📧 Email sent to ${to}: ${subject}`);
  } catch (err) {
    console.error(`❌ Email to ${to} failed:`, err.message);
  }
}

// CRON runs daily at 12:00 AM
cron.schedule('0 0 * * *', async () => {
  const users = db.getAll("users");
  const now = new Date();

  const TARGET_REMINDER_MS = (2 * 24 + 1) * 60 * 60 * 1000; // 2 days + 1 hour in ms
  const REMINDER_WINDOW_MS = 15 * 60 * 1000; // 15-minute tolerance window
  const EXPIRATION_WINDOW_MS = 60 * 60 * 1000; // check up to 1 hour after expiry

  users.forEach(user => {
    if (!user.nextPaymentDate || !user.email) return;

    const nextPayment = new Date(user.nextPaymentDate);
    const timeLeft = nextPayment.getTime() - now.getTime();

    // 1. Check for EXACTLY 2d + 1h left (±15 mins)
    if (Math.abs(timeLeft - TARGET_REMINDER_MS) <= REMINDER_WINDOW_MS) {
      sendEmail(user.email, "⏳ Your subscription expires in 2 days + 1 hour", `
        <p>Hello ${user.username},</p>
        <p>Your subscription to the <strong>${user.plan}</strong> plan will expire in about <strong>2 days and 1 hour</strong>.</p>
        <p>Consider renewing soon to avoid interruption.</p>
        <p><a href="https://yourapp.com/renew">Renew Now</a></p>
      `);
    }

    // 2. Check for expired accounts (timeLeft <= 0 and not too far past)
    if (timeLeft <= 0 && Math.abs(timeLeft) <= EXPIRATION_WINDOW_MS) {
      sendEmail(user.email, "❌ Your subscription has expired", `
        <p>Hello ${user.username},</p>
        <p>Your subscription to the <strong>${user.plan}</strong> plan has <strong>expired</strong>.</p>
        <p>Please renew now to continue using your account without disruption.</p>
        <p><a href="https://yourapp.com/renew">Renew Now</a></p>
      `);
    }
  });
});
