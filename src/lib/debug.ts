/**
 * A rolling log of every outbound call this server makes.
 *
 * This exists because of a real failure that took an afternoon to find: a valid
 * Plausible key looked invalid, and the UI could only say "401 Invalid API key
 * or site ID". The three facts needed to solve it — which instance was queried,
 * which site id was sent, and where the key came from — were all knowable and
 * none were shown. Answering "why did that fail" should not require a shell.
 *
 * In memory only, and deliberately so: it holds request metadata, it is most
 * useful for the thing that just happened, and writing it to disk would mean
 * one more file growing unbounded in the data directory.
 */

const LIMIT = 300;

export type DebugKind = 'http' | 'command';

export interface DebugEntry {
  id: number;
  at: number;
  kind: DebugKind;
  /** plausible | cloudflare | netlify | github | site | other */
  provider: string;
  /** Short description: "POST /api/v2/query", "gh pr list". */
  label: string;
  /** Host, or the binary name for a command. */
  target: string;
  /** HTTP status, or process exit code. */
  status?: number;
  ok: boolean;
  ms: number;
  /** Error message or response snippet, already truncated. */
  detail?: string;
  /** Anything that makes the call intelligible — site id, base url, key source. */
  context?: Record<string, string>;
}

interface Bus {
  entries: DebugEntry[];
  nextId: number;
}

/*
 * On globalThis for the same reason the live bus is: in dev, Vite can hand a
 * module a fresh copy on reload, and a log that resets when you edit a file is
 * useless precisely when you are debugging.
 */
const bus = (): Bus => {
  const g = globalThis as typeof globalThis & { __controlRoomDebug?: Bus };
  g.__controlRoomDebug ??= { entries: [], nextId: 1 };
  return g.__controlRoomDebug;
};

/** Hosts we can name without being told. */
const PROVIDER_HOSTS: Array<[RegExp, string]> = [
  [/(^|\.)cloudflare\.com$/, 'cloudflare'],
  [/(^|\.)netlify\.com$/, 'netlify'],
  [/(^|\.)github\.com$/, 'github'],
  [/(^|\.)plausible\.io$/, 'plausible'],
];

export const providerForHost = (host: string): string => {
  for (const [pattern, name] of PROVIDER_HOSTS) {
    if (pattern.test(host)) return name;
  }
  // A self-hosted Plausible is the common case and its host is arbitrary.
  if (/(^|\.)plausible\./.test(host)) return 'plausible';
  return 'other';
};

/**
 * Strip anything secret-shaped out of a URL before it is stored.
 *
 * Credentials travel in headers here, and headers are never logged — but a
 * provider could put one in a query string, and a debug page that leaks a token
 * is worse than no debug page.
 */
const SECRET_PARAMS = /^(auth|token|api_?key|key|secret|password|access_token)$/i;

export const redactUrl = (raw: string): string => {
  try {
    const url = new URL(raw);
    for (const name of [...url.searchParams.keys()]) {
      if (SECRET_PARAMS.test(name)) url.searchParams.set(name, '<redacted>');
    }
    return `${url.pathname}${url.search}`;
  } catch {
    return raw;
  }
};

export const hostOf = (raw: string): string => {
  try {
    return new URL(raw).host;
  } catch {
    return raw;
  }
};

export const truncate = (text: string, max = 400): string => {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
};

export const record = (entry: Omit<DebugEntry, 'id' | 'at'>): void => {
  const state = bus();
  state.entries.push({ ...entry, id: state.nextId++, at: Date.now() });
  // Ring buffer: drop oldest rather than growing without bound.
  if (state.entries.length > LIMIT) {
    state.entries.splice(0, state.entries.length - LIMIT);
  }
};

/** Newest first, which is the order anyone debugging wants. */
export const entries = (): DebugEntry[] => [...bus().entries].reverse();

export const clear = (): void => {
  const state = bus();
  state.entries.length = 0;
};

export interface DebugSummary {
  total: number;
  failures: number;
  byProvider: Array<{ provider: string; total: number; failures: number }>;
}

export const summary = (): DebugSummary => {
  const all = bus().entries;
  const counts = new Map<string, { total: number; failures: number }>();

  for (const entry of all) {
    const row = counts.get(entry.provider) ?? { total: 0, failures: 0 };
    row.total += 1;
    if (!entry.ok) row.failures += 1;
    counts.set(entry.provider, row);
  }

  return {
    total: all.length,
    failures: all.filter((entry) => !entry.ok).length,
    byProvider: [...counts.entries()]
      .map(([provider, row]) => ({ provider, ...row }))
      .sort((a, b) => b.total - a.total),
  };
};
