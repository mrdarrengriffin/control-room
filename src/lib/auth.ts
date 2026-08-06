import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { statSync } from 'node:fs';
import path from 'node:path';
import {
  COOKIE_NAME,
  SESSION_MAX_AGE_MS,
  parseCookies,
  readAuthFile,
  signSession,
  verifySession,
} from '../../server/session.mjs';
import { dataDirectory } from './env';
import { writeJsonFile } from './store';

/**
 * Single-admin authentication, in the style of a self-hosted app.
 *
 * The password is stored only as an scrypt hash, alongside a per-install session
 * secret, in data/auth.json. Node's crypto has everything needed, so this adds
 * no dependency.
 */

export { COOKIE_NAME, SESSION_MAX_AGE_MS };

interface AuthFile {
  passwordHash: string;
  salt: string;
  sessionSecret: string;
  createdAt: string;
}

const SCRYPT = { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEY_LENGTH = 64;

const authPath = () => path.join(dataDirectory(), 'auth.json');

let cache: { mtimeMs: number; auth: AuthFile } | undefined;

/**
 * Current auth config, cached against the file's mtime — this is read on every
 * request by the middleware, so re-parsing each time would be wasteful, while a
 * TTL would leave a window where a just-set password isn't recognised.
 */
export const authConfig = (): AuthFile | undefined => {
  const file = authPath();

  let info;
  try {
    info = statSync(file);
  } catch {
    cache = undefined;
    return undefined;
  }

  if (cache && cache.mtimeMs === info.mtimeMs) return cache.auth;

  const parsed = readAuthFile(dataDirectory()) as AuthFile | undefined;
  if (!parsed?.passwordHash || !parsed.salt || !parsed.sessionSecret) {
    return undefined;
  }

  cache = { mtimeMs: info.mtimeMs, auth: parsed };
  return parsed;
};

export const isConfigured = (): boolean => authConfig() !== undefined;

const derive = (password: string, salt: string): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_LENGTH, SCRYPT, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });

export const setPassword = async (password: string): Promise<void> => {
  const salt = randomBytes(16).toString('hex');
  const hash = await derive(password, salt);

  const auth: AuthFile = {
    passwordHash: hash.toString('hex'),
    salt,
    // Rotated whenever the password is set, so changing it ends every session.
    sessionSecret: randomBytes(32).toString('hex'),
    createdAt: new Date().toISOString(),
  };

  await writeJsonFile(authPath(), auth);
  cache = undefined;
};

export const checkPassword = async (password: string): Promise<boolean> => {
  const auth = authConfig();
  if (!auth) return false;

  const candidate = await derive(password, auth.salt);
  const stored = Buffer.from(auth.passwordHash, 'hex');

  // Length check first: timingSafeEqual throws when they differ.
  return (
    candidate.length === stored.length && timingSafeEqual(candidate, stored)
  );
};

export const newSessionCookie = (): string => {
  const auth = authConfig();
  if (!auth) throw new Error('No auth configured');
  return signSession(auth.sessionSecret);
};

/** Is this request carrying a valid session? */
export const isAuthenticated = (request: Request): boolean => {
  const auth = authConfig();
  if (!auth) return false;

  const cookies = parseCookies(request.headers.get('cookie'));
  return verifySession(cookies[COOKIE_NAME], auth.sessionSecret);
};
