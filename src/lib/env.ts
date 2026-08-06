import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * Configuration access, resolved at call time so edits take effect without a
 * rebuild.
 *
 * There are three layers, highest priority first:
 *
 *   1. data/secrets.json  — written by the settings page
 *   2. process.env        — compose / env_file / real environment variables
 *   3. the .env FILE      — parsed directly
 *
 * Layer 1 wins because it is the thing the user most recently clicked "save" on.
 * Layer 3 exists because Docker only reads `env_file` when a container is
 * *created*, so a long-running dev container otherwise keeps a stale environment
 * and every panel insists the token is missing — a trap that cost real debugging
 * time three separate times. Since the project is bind-mounted, reading the file
 * fixes it with no recreate.
 *
 * Because "which of these is actually in effect" is genuinely confusing,
 * `sourceOf()` reports it and the settings page displays it per key.
 */

export type ConfigSource = 'settings' | 'environment' | 'env-file' | 'unset';

interface FileCache<T> {
  mtimeMs: number;
  values: T;
}

const clean = (value: string | undefined): string | undefined => {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
};

// --- Layer 3: the .env file ------------------------------------------------

let envFileCache: FileCache<Map<string, string>> | undefined;

const envFileValues = (): Map<string, string> => {
  const file = path.resolve('.env');

  let info;
  try {
    info = statSync(file);
  } catch {
    envFileCache = undefined;
    return new Map();
  }

  if (envFileCache && envFileCache.mtimeMs === info.mtimeMs) {
    return envFileCache.values;
  }

  const values = new Map<string, string>();
  try {
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed === '' || trimmed.startsWith('#')) continue;

      const separator = trimmed.indexOf('=');
      if (separator <= 0) continue;

      const key = trimmed.slice(0, separator).trim();
      let value = trimmed.slice(separator + 1).trim();

      const quoted =
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"));
      if (quoted && value.length >= 2) value = value.slice(1, -1);

      if (key !== '') values.set(key, value);
    }
  } catch {
    return new Map();
  }

  envFileCache = { mtimeMs: info.mtimeMs, values };
  return values;
};

/**
 * process.env then .env — deliberately NOT consulting the settings file.
 *
 * The settings file lives inside the data directory, so resolving where that
 * directory is must not depend on the settings file. Keeping this reader
 * separate is what stops that from being a circular lookup.
 */
const readEnvOnly = (key: string): string | undefined =>
  clean(process.env[key]) ?? clean(envFileValues().get(key));

export const dataDirectory = (): string =>
  readEnvOnly('CONTROL_ROOM_DATA_DIR') ?? 'data';

// --- Layer 1: data/secrets.json -------------------------------------------

let secretsCache: FileCache<Record<string, string>> | undefined;

const secretsPath = (): string =>
  path.resolve(dataDirectory(), 'secrets.json');

const secretsValues = (): Record<string, string> => {
  const file = secretsPath();

  let info;
  try {
    info = statSync(file);
  } catch {
    secretsCache = undefined;
    return {};
  }

  if (secretsCache && secretsCache.mtimeMs === info.mtimeMs) {
    return secretsCache.values;
  }

  let values: Record<string, string> = {};
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      values = Object.fromEntries(
        Object.entries(parsed as Record<string, unknown>)
          .filter(([, value]) => typeof value === 'string')
          .map(([key, value]) => [key, value as string]),
      );
    }
  } catch {
    // A corrupt secrets file must not take the whole app down.
    return {};
  }

  secretsCache = { mtimeMs: info.mtimeMs, values };
  return values;
};

// --- Combined lookup ------------------------------------------------------

const read = (key: string): string | undefined =>
  clean(secretsValues()[key]) ?? readEnvOnly(key);

/** Where the effective value for a key is coming from. */
export const sourceOf = (key: string): ConfigSource => {
  if (clean(secretsValues()[key]) !== undefined) return 'settings';
  if (clean(process.env[key]) !== undefined) return 'environment';
  if (clean(envFileValues().get(key)) !== undefined) return 'env-file';
  return 'unset';
};

/** Length only — never any part of the value itself. */
export const lengthOf = (key: string): number => (read(key) ?? '').length;

/**
 * Read an arbitrary key by name. Used for per-site Plausible keys, where the
 * variable name comes from data/sites.json rather than being known up front.
 */
export const envValue = (name: string): string | undefined => read(name);

export const env = {
  cloudflareToken: () => read('CLOUDFLARE_API_TOKEN'),
  netlifyToken: () => read('NETLIFY_AUTH_TOKEN'),
  /** GH_TOKEN is what the gh CLI itself looks for; accept either name. */
  githubToken: () => read('GITHUB_TOKEN') ?? read('GH_TOKEN'),
  plausibleKey: () => read('PLAUSIBLE_API_KEY'),
  plausibleBaseUrl: () =>
    (read('PLAUSIBLE_BASE_URL') ?? 'https://plausible.io').replace(/\/+$/, ''),
  dataDir: dataDirectory,
};
