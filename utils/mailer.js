const nodemailer = require('nodemailer');

function isEmailConfigured() {
  return !!(process.env.SMTP_HOST && process.env.SMTP_FROM);
}

function buildTransport() {
  const port = process.env.SMTP_PORT ? parseInt(process.env.SMTP_PORT, 10) : 587;
  const secure = String(process.env.SMTP_SECURE || '').toLowerCase() === 'true' || port === 465;
  const pass = (process.env.SMTP_PASS || '').trim();

  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure,
    auth: process.env.SMTP_USER
      ? {
          user: process.env.SMTP_USER,
          pass
        }
      : undefined
  });
}

async function sendMail({ to, subject, html, text }) {
  if (!isEmailConfigured()) return false;

  const transporter = buildTransport();
  // This does not guarantee final delivery, but confirms SMTP acceptance.
  const info = await transporter.sendMail({
    from: process.env.SMTP_FROM,
    to,
    subject,
    html,
    text
  });

  console.log('[Mailer] sent', {
    to,
    subject,
    messageId: info?.messageId,
    response: info?.response
  });

  return true;
}

module.exports = {
  isEmailConfigured,
  sendMail
};
