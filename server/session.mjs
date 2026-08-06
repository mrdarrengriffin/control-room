import { createHmac, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Session cookie signing, shared by the Astro app and the WebSocket server.
 *
 * Deliberately plain JavaScript in server/ rather than src/: the WebSocket
 * server is outside Astro's bundle, and both sides must agree exactly on how a
 * session is verified. Two copies of security-critical code is how one of them
 * quietly becomes wrong.
 *
 * Sessions are stateless: the cookie carries its issue time, signed with a
 * per-install secret. Nothing is stored server-side, so restarts don't log
 * anyone out — and rotating the secret logs everyone out at once.
 */

export const COOKIE_NAME = 'control_room_session';
export const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export const parseCookies = (header) => {
  const cookies = {};
  for (const part of String(header ?? '').split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    const name = part.slice(0, separator).trim();
    if (name === '') continue;
    try {
      cookies[name] = decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      // Malformed encoding; ignore this cookie rather than failing the request.
    }
  }
  return cookies;
};

export const signSession = (secret, issuedAt = Date.now()) => {
  const payload = Buffer.from(String(issuedAt), 'utf8').toString('base64url');
  const mac = createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${mac}`;
};

export const verifySession = (value, secret) => {
  if (typeof value !== 'string' || !secret) return false;

  const [payload, mac] = value.split('.');
  if (!payload || !mac) return false;

  const expected = createHmac('sha256', secret)
    .update(payload)
    .digest('base64url');

  const given = Buffer.from(mac);
  const want = Buffer.from(expected);
  // Length check first: timingSafeEqual throws on a mismatch.
  if (given.length !== want.length || !timingSafeEqual(given, want)) {
    return false;
  }

  const issuedAt = Number(Buffer.from(payload, 'base64url').toString('utf8'));
  if (!Number.isFinite(issuedAt)) return false;

  return Date.now() - issuedAt < SESSION_MAX_AGE_MS;
};

/** Read data/auth.json, or undefined when the install has no password yet. */
export const readAuthFile = (dataDir) => {
  try {
    const raw = readFileSync(path.join(dataDir, 'auth.json'), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : undefined;
  } catch {
    return undefined;
  }
};
