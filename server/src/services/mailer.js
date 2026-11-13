/**
 * Outbound mail from the platform's own mailbox.
 *
 * This is the transport for system mail — invitations, password resets,
 * verification links and staff lead alerts — for every tenant, so it uses the
 * platform SMTP credentials and never a customer's. Per-tenant campaign email
 * is a separate concern and goes through the tenant's own email settings.
 *
 * When SMTP is not configured the call reports `{ ok: false, reason }` rather
 * than throwing: a missing mail server must not fail the business operation
 * that triggered the email, but the caller has to be able to say so honestly
 * instead of claiming a message was sent.
 */

import nodemailer from 'nodemailer';
import config from '../config/index.js';

let transporter;
let verified = null;

export function mailConfigured() {
  return Boolean(config.mail.host);
}

function getTransporter() {
  if (transporter) return transporter;

  const secure = String(config.mail.encryption).toUpperCase() === 'SSL' || config.mail.port === 465;
  transporter = nodemailer.createTransport({
    host: config.mail.host,
    port: config.mail.port,
    secure,
    // STARTTLS on 587; `secure: false` here means "upgrade", not "plaintext".
    requireTLS: !secure && String(config.mail.encryption).toUpperCase() === 'TLS',
    auth: config.mail.user ? { user: config.mail.user, pass: config.mail.pass } : undefined,
    pool: true,
    maxConnections: 3,
  });
  return transporter;
}

/**
 * Checks the SMTP settings without sending anything — this is what the
 * Integrations screen's "Test connection" button is for.
 */
export async function verifyMailer({ force = false } = {}) {
  if (!mailConfigured()) return { ok: false, reason: 'SMTP_NOT_CONFIGURED' };
  if (verified !== null && !force) return verified;
  try {
    await getTransporter().verify();
    verified = { ok: true };
  } catch (err) {
    verified = { ok: false, reason: 'SMTP_ERROR', message: err.message };
  }
  return verified;
}

/**
 * @param {{to:string, subject:string, text?:string, html?:string, replyTo?:string, cc?:string}} message
 * @returns {Promise<{ok:boolean, reason?:string, message?:string, messageId?:string}>}
 */
export async function sendSystemMail(message) {
  if (!mailConfigured()) return { ok: false, reason: 'SMTP_NOT_CONFIGURED' };
  if (!message?.to) return { ok: false, reason: 'NO_RECIPIENT' };

  try {
    const info = await getTransporter().sendMail({
      from: config.mail.from,
      to: message.to,
      cc: message.cc || undefined,
      replyTo: message.replyTo || undefined,
      subject: message.subject,
      text: message.text,
      html: message.html,
    });
    return { ok: true, messageId: info.messageId };
  } catch (err) {
    console.error('[mail] send failed:', err.message);
    return { ok: false, reason: 'SMTP_ERROR', message: err.message };
  }
}

export async function closeMailer() {
  if (transporter) {
    transporter.close();
    transporter = undefined;
    verified = null;
  }
}
