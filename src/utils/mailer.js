'use strict';
const nodemailer = require('nodemailer');
const QRCode = require('qrcode');

let transporter = null;

async function getTransporter() {
  if (transporter) return transporter;

  if (process.env.MAIL_USER && process.env.MAIL_PASS) {
    transporter = nodemailer.createTransport({
      host: process.env.MAIL_HOST || 'smtp.ethereal.email',
      port: parseInt(process.env.MAIL_PORT || '587'),
      secure: false,
      auth: {
        user: process.env.MAIL_USER,
        pass: process.env.MAIL_PASS
      }
    });
  } else {
    // Automatically generate an Ethereal sandbox test account for zero-config testing
    try {
      const testAccount = await nodemailer.createTestAccount();
      console.log(`[Email Sandbox] Created Ethereal test account: ${testAccount.user}`);
      transporter = nodemailer.createTransport({
        host: 'smtp.ethereal.email',
        port: 587,
        secure: false,
        auth: {
          user: testAccount.user,
          pass: testAccount.pass
        }
      });
    } catch (e) {
      console.warn('[Email Sandbox] Could not connect to Ethereal sandbox, falling back to mock logger.');
      transporter = {
        sendMail: async (opts) => {
          console.log(`[Email Mock] To: ${opts.to} | Subject: ${opts.subject}`);
          return { messageId: 'mock-id' };
        }
      };
    }
  }
  return transporter;
}

async function sendConfirmationEmail(reg, event) {
  const mailClient = await getTransporter();
  const appUrl = process.env.APP_URL || 'http://localhost:3000';
  const ticketUrl = `${appUrl}/ticket/${reg.ticket_code}?identifier=${encodeURIComponent(reg.email)}`;
  const qrDataUrl = await QRCode.toDataURL(reg.ticket_code);

  const html = `
    <h2>You're registered! 🎉</h2>
    <p>Hi <strong>${reg.full_name}</strong>,</p>
    <p>Your ticket for <strong>${event.title}</strong> is confirmed.</p>
    <table cellpadding="6" style="border-collapse:collapse; background:#f7fafc; border:1px solid #e2e8f0;">
      <tr><td><b>Event</b></td><td>${event.title}</td></tr>
      <tr><td><b>Venue</b></td><td>${event.venue}</td></tr>
      <tr><td><b>Starts</b></td><td>${event.starts_at}</td></tr>
      <tr><td><b>Ticket Code</b></td><td><code style="font-size:1.1em">${reg.ticket_code}</code></td></tr>
    </table>
    <p>Show this QR code at the door:</p>
    <p><img src="${qrDataUrl}" alt="QR Code" width="220" height="220" /></p>
    <p>Or open your ticket in browser: <a href="${ticketUrl}">${ticketUrl}</a></p>
  `;

  try {
    const info = await mailClient.sendMail({
      from: process.env.MAIL_FROM || 'EventReg <no-reply@eventreg.local>',
      to: reg.email,
      subject: `Your ticket for ${event.title}`,
      html
    });
    const previewUrl = nodemailer.getTestMessageUrl(info);
    if (previewUrl) {
      console.log(`[Email Preview] Registration email preview: ${previewUrl}`);
    }
  } catch (err) {
    console.error('[Email Error] Failed to send confirmation email:', err.message);
  }
}

async function sendWaitlistPromotionEmail(reg, event) {
  const mailClient = await getTransporter();
  const appUrl = process.env.APP_URL || 'http://localhost:3000';
  const ticketUrl = `${appUrl}/ticket/${reg.ticket_code}?identifier=${encodeURIComponent(reg.email)}`;
  const qrDataUrl = await QRCode.toDataURL(reg.ticket_code);

  const html = `
    <h2>Great news — you're in! 🎊</h2>
    <p>Hi <strong>${reg.full_name}</strong>,</p>
    <p>A spot opened up for <strong>${event.title}</strong> and you have been promoted from the waitlist.</p>
    <p>Your ticket is now <strong>Confirmed</strong>.</p>
    <table cellpadding="6" style="border-collapse:collapse; background:#f7fafc; border:1px solid #e2e8f0;">
      <tr><td><b>Event</b></td><td>${event.title}</td></tr>
      <tr><td><b>Venue</b></td><td>${event.venue}</td></tr>
      <tr><td><b>Starts</b></td><td>${event.starts_at}</td></tr>
      <tr><td><b>Ticket Code</b></td><td><code style="font-size:1.1em">${reg.ticket_code}</code></td></tr>
    </table>
    <p>Show this QR code at the door:</p>
    <p><img src="${qrDataUrl}" alt="QR Code" width="220" height="220" /></p>
    <p>Or open your ticket in browser: <a href="${ticketUrl}">${ticketUrl}</a></p>
  `;

  try {
    const info = await mailClient.sendMail({
      from: process.env.MAIL_FROM || 'EventReg <no-reply@eventreg.local>',
      to: reg.email,
      subject: `You're confirmed for ${event.title}!`,
      html
    });
    const previewUrl = nodemailer.getTestMessageUrl(info);
    if (previewUrl) {
      console.log(`[Email Preview] Waitlist promotion email preview: ${previewUrl}`);
    }
  } catch (err) {
    console.error('[Email Error] Failed to send promotion email:', err.message);
  }
}

module.exports = { sendConfirmationEmail, sendWaitlistPromotionEmail };
