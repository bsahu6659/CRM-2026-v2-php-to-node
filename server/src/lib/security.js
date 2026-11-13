/**
 * Passwords, tokens, HMAC signatures, and symmetric encryption for secrets
 * that must be readable again (Meta page access tokens) rather than hashed.
 *
 * The encryption format and the TOTP implementation are byte-compatible with
 * the PHP edition on purpose: an existing database holds secrets written by
 * it, and changing either would make every stored Meta token unreadable and
 * invalidate every authenticator app already enrolled.
 */

import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import config from '../config/index.js';

export async function hashPassword(plain) {
  return bcrypt.hash(plain, 10);
}

export async function verifyPassword(plain, hash) {
  if (!hash) return false;
  try {
    // PHP's password_hash() emits the $2y$ prefix; bcryptjs understands it.
    return await bcrypt.compare(plain, hash);
  } catch {
    return false;
  }
}

/** Same policy across registration, reset and admin-set. */
export function checkPasswordStrength(password) {
  const problems = [];
  if (String(password).length < 8) problems.push('at least 8 characters');
  if (!/[a-z]/.test(password)) problems.push('a lowercase letter');
  if (!/[A-Z]/.test(password)) problems.push('an uppercase letter');
  if (!/[0-9]/.test(password)) problems.push('a number');
  if (problems.length) {
    return { ok: false, message: `Password must contain ${problems.join(', ')}.` };
  }
  return { ok: true };
}

export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

export function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

/** Constant-time comparison that cannot throw on length mismatch. */
export function safeEqual(a, b) {
  const bufA = Buffer.from(String(a ?? ''), 'utf8');
  const bufB = Buffer.from(String(b ?? ''), 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

export function signWebhookPayload(secret, body) {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

/** API keys: `gv_<random>`; only the SHA-256 hash is stored. */
export function generateApiKey() {
  const raw = 'gv_' + crypto.randomBytes(24).toString('base64url');
  return { raw, prefix: raw.slice(0, 11), hash: sha256(raw) };
}

// ---------------------------------------------------------------------------
// AES-256-GCM, keyed off APP_KEY. Layout: base64( iv[12] | tag[16] | cipher ).
// Changing APP_KEY makes every previously stored secret unreadable.
// ---------------------------------------------------------------------------
function encryptionKey() {
  return crypto.createHash('sha256').update(String(config.auth.appKey)).digest();
}

export function gvEncrypt(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString('base64');
}

export function gvDecrypt(encoded) {
  if (!encoded) return null;
  try {
    const raw = Buffer.from(String(encoded), 'base64');
    if (raw.length < 28) return null;
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const data = raw.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch {
    // A wrong APP_KEY, a truncated column or tampering all land here. Returning
    // null lets the caller report "reconnect this integration" instead of
    // crashing the request.
    return null;
  }
}

// ---------------------------------------------------------------------------
// TOTP (RFC 6238) — no external dependency, same algorithm as the PHP edition.
// ---------------------------------------------------------------------------
const TOTP_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function totpGenerateSecret(length = 20) {
  const bytes = crypto.randomBytes(length);
  let bits = '';
  for (const byte of bytes) bits += byte.toString(2).padStart(8, '0');
  let secret = '';
  for (let i = 0; i + 5 <= bits.length; i += 5) {
    secret += TOTP_ALPHABET[Number.parseInt(bits.slice(i, i + 5), 2)];
  }
  return secret;
}

export function totpBase32Decode(input) {
  const clean = String(input).toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = '';
  for (const char of clean) {
    const index = TOTP_ALPHABET.indexOf(char);
    if (index === -1) continue;
    bits += index.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(Number.parseInt(bits.slice(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}

export function totpHotp(secret, counter) {
  const key = totpBase32Decode(secret);
  const bin = Buffer.alloc(8);
  bin.writeBigUInt64BE(BigInt(counter));
  const hash = crypto.createHmac('sha1', key).update(bin).digest();
  const offset = hash[19] & 0x0f;
  const code =
    ((hash[offset] & 0x7f) << 24) |
    ((hash[offset + 1] & 0xff) << 16) |
    ((hash[offset + 2] & 0xff) << 8) |
    (hash[offset + 3] & 0xff);
  return String(code % 1000000).padStart(6, '0');
}

export function totpVerify(secret, token, window = 1) {
  const candidate = String(token ?? '').trim();
  if (!secret || !/^\d{6}$/.test(candidate)) return false;
  const counter = Math.floor(Date.now() / 1000 / 30);
  for (let drift = -window; drift <= window; drift++) {
    if (safeEqual(totpHotp(secret, counter + drift), candidate)) return true;
  }
  return false;
}

export function totpOtpauthUri(secret, account, issuer = 'Growvanta CRM') {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret, issuer, algorithm: 'SHA1', digits: '6', period: '30',
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
