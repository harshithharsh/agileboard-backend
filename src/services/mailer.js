import nodemailer from 'nodemailer';

// Outgoing email through the SMTP server in .env (SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM,
// SMTP_SECURE). The password stays in .env: it is never stored in the database or shown in the app.
// SMTP_HOST=log writes emails to the server log instead of sending them (for local testing).
let transport = null;

export function emailStatus() {
  const host = process.env.SMTP_HOST;
  if (!host) return { configured: false };
  return { configured: true, host: host === 'log' ? 'server log (test mode)' : host, from: fromAddress() };
}

const fromAddress = () => process.env.SMTP_FROM || process.env.SMTP_USER || 'agilemetrix@localhost';

function getTransport() {
  if (transport) return transport;
  const host = process.env.SMTP_HOST;
  if (!host) throw new Error('Email is not set up: add SMTP_HOST and the other SMTP_* settings to the backend .env');
  transport = host === 'log'
    ? nodemailer.createTransport({ jsonTransport: true })
    : nodemailer.createTransport({
      host,
      port: Number(process.env.SMTP_PORT || 587),
      secure: process.env.SMTP_SECURE === 'true', // true for port 465; 587 upgrades with STARTTLS
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
    });
  return transport;
}

export async function sendEmail({ to, subject, text, html }) {
  const info = await getTransport().sendMail({ from: `AgileMetrix <${fromAddress()}>`, to, subject, text, html });
  if (process.env.SMTP_HOST === 'log') console.log(`[email, test mode] to ${[].concat(to).join(', ')}: ${subject}`);
  return info;
}
