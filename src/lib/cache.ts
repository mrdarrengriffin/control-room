import type { PanelResult } from './types';

/**
 * Stale-while-revalidate cache for upstream calls.
 *
 * Measured before writing this: a warm dashboard render was ~1.25s and a site
 * page ~0.6s, essentially all of it waiting on Plausible, Netlify and GitHub,
 * because nothing was cached. Meanwhile freshness finer than about a minute is
 * illusory for these sources — Plausible's realtime figure is a 5-minute window,
 * its stats are aggregated with delay, and deploys and pull requests move on the
 * order of minutes. So holding results briefly costs almost no accuracy.
 *
 * Stale entries are returned *immediately* and refreshed in the background, so a
 * page never waits for a refresh — only the very first call for a key blocks.
 */

interface Entry {
  value: unknown;
  freshUntil: number;
  /** Guards against firing several background refreshes for one key. */
  refreshing: boolean;
}

const store = new Map<string, Entry>();

/**
 * Loads in flight for a *cold* key, so concurrent callers share one request.
 *
 * The stale path already had this via `entry.refreshing`; the cold path did not,
 * and a page that fans out is exactly where it matters. A site page asks for
 * seven Plausible panels plus a site-id resolution at once — all eight wanting
 * the same resolution — and without this each one issued its own request, so the
 * first uncached render cost eight round trips to learn one fact.
 */
const inFlight = new Map<string, Promise<unknown>>();

/** A failing upstream is held briefly so it isn't retried on every render. */
const ERROR_TTL_MS = 15_000;

/** Crude bound; these entries are small and the app is single-user. */
const MAX_ENTRIES = 500;

/**
 * Drop everything. Called when credentials change, so a cached "not configured"
 * or auth failure doesn't outlive the fix.
 */
export const invalidateAll = (): void => {
  store.clear();
  /*
   * In-flight loads are dropped too, not awaited: one started before a token
   * changed would otherwise land afterwards and be cached as current.
   */
  inFlight.clear();
};

/**
 * @param ttlOf decides how long a given value stays fresh; returning undefined
 * means "don't cache this at all".
 */
export const cachedBy = async <T>(
  key: string,
  load: () => Promise<T>,
  ttlOf: (value: T) => number | undefined,
): Promise<T> => {
  const entry = store.get(key);

  if (entry) {
    if (Date.now() < entry.freshUntil) return entry.value as T;

    // Stale: hand back what we have and refresh out of band.
    if (!entry.refreshing) {
      entry.refreshing = true;
      void load()
        .then((value) => {
          const ttl = ttlOf(value);
          if (ttl === undefined) {
            store.delete(key);
            return;
          }
          store.set(key, {
            value,
            freshUntil: Date.now() + ttl,
            refreshing: false,
          });
        })
        .catch(() => {
          // Keep serving the stale value; just allow another attempt later.
          entry.refreshing = false;
        });
    }

    return entry.value as T;
  }

  const existing = inFlight.get(key);
  if (existing) return existing as Promise<T>;

  const pending = load()
    .then((value) => {
      const ttl = ttlOf(value);
      if (ttl !== undefined) {
        if (store.size >= MAX_ENTRIES) store.clear();
        store.set(key, {
          value,
          freshUntil: Date.now() + ttl,
          refreshing: false,
        });
      }
      return value;
    })
    .finally(() => {
      // Only if it is still ours: invalidateAll() may have cleared the map.
      if (inFlight.get(key) === pending) inFlight.delete(key);
    });

  inFlight.set(key, pending);
  return pending;
};

/** Fixed TTL for everything. */
export const cached = <T>(
  key: string,
  ttlMs: number,
  load: () => Promise<T>,
): Promise<T> => cachedBy(key, load, () => ttlMs);

/**
 * TTL by outcome for provider calls:
 *  - ok           cached for the full TTL
 *  - error        cached briefly, so a broken upstream isn't hammered
 *  - unconfigured never cached — it is computed locally with no network call,
 *                 and caching it would keep saying "not configured" for a
 *                 minute after the token is added
 */
export const cachedResult = <T>(
  key: string,
  ttlMs: number,
  load: () => Promise<PanelResult<T>>,
): Promise<PanelResult<T>> =>
  cachedBy(key, load, (result) => {
    if (result.status === 'ok') return ttlMs;
    if (result.status === 'error') return ERROR_TTL_MS;
    return undefined;
  });

/** Shared TTLs, in one place so they can be reasoned about together. */
export const TTL = {
  /** Analytics aggregates: Plausible itself is not more current than this. */
  analytics: 60_000,
  /** Visitors right now — the one figure worth keeping tight. */
  realtime: 20_000,
  /** Deploys and pull requests move on the order of minutes. */
  activity: 60_000,
  /** Cloudflare zones change when someone adds a domain. */
  zones: 60 * 60_000,
  /** Which Netlify site serves a domain effectively never changes. */
  resolution: 24 * 60 * 60_000,
} as const;
