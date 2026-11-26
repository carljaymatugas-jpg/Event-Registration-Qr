'use strict';
const nodemailer = require('nodemailer');
const QRCode = require('qrcode');
const { formatCebu, formatCebu12 } = require('./time');

let transporter = null;

function isConfiguredValue(val) {
  const s = (val || '').trim();
  return Boolean(s && s !== 'change-me' && !s.startsWith('your_'));
}

function isRealEmailConfigured() {
  return Boolean(
    isConfiguredValue(process.env.RESEND_API_KEY) ||
    (isConfiguredValue(process.env.MAILTRAP_USER) && isConfiguredValue(process.env.MAILTRAP_PASS)) ||
    (isConfiguredValue(process.env.MAIL_USER) && isConfiguredValue(process.env.MAIL_PASS))
  );
}

async function getTransporter() {
  if (transporter) return transporter;

  const smtpUser = isConfiguredValue(process.env.MAILTRAP_USER)
    ? process.env.MAILTRAP_USER
    : (isConfiguredValue(process.env.MAIL_USER) ? process.env.MAIL_USER : '');
  const smtpPass = isConfiguredValue(process.env.MAILTRAP_PASS)
    ? process.env.MAILTRAP_PASS
    : (isConfiguredValue(process.env.MAIL_PASS) ? process.env.MAIL_PASS : '');
  const smtpHost = isConfiguredValue(process.env.MAILTRAP_USER)
    ? (process.env.MAILTRAP_HOST || 'sandbox.smtp.mailtrap.io')
    : (process.env.MAIL_HOST || 'smtp.ethereal.email');
  const smtpPort = parseInt(
    isConfiguredValue(process.env.MAILTRAP_USER) ? (process.env.MAILTRAP_PORT || '587') : (process.env.MAIL_PORT || '587'),
    10
  );

  if (smtpUser && smtpPass) {
    transporter = nodemailer.createTransport({
      host: smtpHost,
      port: smtpPort,
      secure: smtpPort === 465,
      auth: { user: smtpUser, pass: smtpPass }
    });
  } else {
    try {
      const testAccount = await nodemailer.createTestAccount();
      console.log(`[Email Sandbox] Created Ethereal test account: ${testAccount.user}`);
      transporter = nodemailer.createTransport({
        host: 'smtp.ethereal.email',
        port: 587,
        secure: false,
        auth: { user: testAccount.user, pass: testAccount.pass }
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

async function sendViaResend({ from, to, subject, html, qrBuffer }) {
  const apiKey = process.env.RESEND_API_KEY;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from,
      to: [to],
      subject,
      html,
      attachments: qrBuffer ? [{
        filename: 'ticket-qr.png',
        content: qrBuffer.toString('base64')
      }] : undefined
    })
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Resend API error ${res.status}: ${errText}`);
  }
  return await res.json();
}

async function dispatchEmail({ to, subject, buildHtml, ticketCode }) {
  const from = process.env.MAIL_FROM || 'EventReg <onboarding@resend.dev>';
  const qrBuffer = await QRCode.toBuffer(ticketCode, { width: 240 });
  const qrDataUrl = `data:image/png;base64,${qrBuffer.toString('base64')}`;

  try {
    if (isConfiguredValue(process.env.RESEND_API_KEY)) {
      const html = buildHtml(qrDataUrl);
      await sendViaResend({ from, to, subject, html, qrBuffer });
      return { provider: 'resend' };
    }

    const mailClient = await getTransporter();
    const html = buildHtml('cid:ticketqr');
    const info = await mailClient.sendMail({
      from: process.env.MAIL_FROM || 'EventReg <no-reply@eventreg.local>',
      to,
      subject,
      html,
      attachments: [{
        filename: 'ticket-qr.png',
        content: qrBuffer,
        cid: 'ticketqr'
      }]
    });
    const previewUrl = nodemailer.getTestMessageUrl(info);
    if (previewUrl) {
      console.log(`[Email Preview] ${subject} -> ${previewUrl}`);
    }
    return { provider: 'smtp', previewUrl: previewUrl || null };
  } catch (err) {
    console.error('[Email Error] Failed to send email:', err && err.message);
    return { error: err && err.message };
  }
}

async function sendConfirmationEmail(reg, event) {
  const appUrl = process.env.APP_URL || 'http://localhost:3000';
  const ticketUrl = `${appUrl}/ticket/${reg.ticket_code}?identifier=${encodeURIComponent(reg.email)}`;
  const schedule = `${formatCebu(event.starts_at)} · ${formatCebu12(event.starts_at)} – ${formatCebu12(event.ends_at)} (Asia/Manila)`;

  return dispatchEmail({
    to: reg.email,
    subject: `Your ticket for ${event.title}`,
    ticketCode: reg.ticket_code,
    buildHtml: (qrSrc) => `
      <h2>You're registered! 🎉</h2>
      <p>Hi <strong>${reg.full_name}</strong>,</p>
      <p>Your ticket for <strong>${event.title}</strong> is confirmed.</p>
      <table cellpadding="6" style="border-collapse:collapse; background:#f7fafc; border:1px solid #e2e8f0;">
        <tr><td><b>Event</b></td><td>${event.title}</td></tr>
        <tr><td><b>Venue</b></td><td>${event.venue}</td></tr>
        <tr><td><b>Schedule</b></td><td>${schedule}</td></tr>
        <tr><td><b>Ticket Code</b></td><td><code style="font-size:1.1em">${reg.ticket_code}</code></td></tr>
      </table>
      <p>Show this QR code at the door:</p>
      <p><img src="${qrSrc}" alt="QR Code for ${reg.ticket_code}" width="220" height="220" /></p>
      <p>Or open your ticket online: <a href="${ticketUrl}">${ticketUrl}</a></p>
    `
  });
}

async function sendWaitlistPromotionEmail(reg, event) {
  const appUrl = process.env.APP_URL || 'http://localhost:3000';
  const ticketUrl = `${appUrl}/ticket/${reg.ticket_code}?identifier=${encodeURIComponent(reg.email)}`;
  const schedule = `${formatCebu(event.starts_at)} · ${formatCebu12(event.starts_at)} – ${formatCebu12(event.ends_at)} (Asia/Manila)`;

  return dispatchEmail({
    to: reg.email,
    subject: `You're confirmed for ${event.title}!`,
    ticketCode: reg.ticket_code,
    buildHtml: (qrSrc) => `
      <h2>Great news — you're in! 🎊</h2>
      <p>Hi <strong>${reg.full_name}</strong>,</p>
      <p>A spot opened up for <strong>${event.title}</strong> and you have been promoted from the waitlist.</p>
      <p>Your ticket is now <strong>Confirmed</strong>.</p>
      <table cellpadding="6" style="border-collapse:collapse; background:#f7fafc; border:1px solid #e2e8f0;">
        <tr><td><b>Event</b></td><td>${event.title}</td></tr>
        <tr><td><b>Venue</b></td><td>${event.venue}</td></tr>
        <tr><td><b>Schedule</b></td><td>${schedule}</td></tr>
        <tr><td><b>Ticket Code</b></td><td><code style="font-size:1.1em">${reg.ticket_code}</code></td></tr>
      </table>
      <p>Show this QR code at the door:</p>
      <p><img src="${qrSrc}" alt="QR Code for ${reg.ticket_code}" width="220" height="220" /></p>
      <p>Or open your ticket online: <a href="${ticketUrl}">${ticketUrl}</a></p>
    `
  });
}

module.exports = {
  isRealEmailConfigured,
  sendConfirmationEmail,
  sendWaitlistPromotionEmail,
};
