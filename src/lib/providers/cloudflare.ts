import { TTL, cachedResult } from '../cache';
import { env } from '../env';
import { HttpError, bearer, fetchJson } from '../http';
import { failed, messageOf, ok, unconfigured } from '../types';
import type { PanelResult, Site } from '../types';

const API = 'https://api.cloudflare.com/client/v4';

/** Cloudflare wraps every response in this envelope, including failures. */
interface CloudflareEnvelope<T> {
  success: boolean;
  errors: { code: number; message: string }[];
  messages: { code: number; message: string }[];
  result: T;
}

/**
 * Cloudflare rejects a purge-by-URL request carrying more than 30 files.
 * Batching is the caller's problem to know about, so it's named here.
 */
export const PURGE_FILES_PER_REQUEST = 30;

export type PurgeTarget =
  | { mode: 'everything' }
  | { mode: 'files'; urls: string[] };

export interface PurgeOutcome {
  mode: 'everything' | 'files';
  /** How many URLs were submitted, for the files mode. */
  count?: number;
  purgeId?: string;
}

const envelopeError = (envelope: CloudflareEnvelope<unknown>) =>
  envelope.errors.map((error) => `${error.message} (${error.code})`).join('; ') ||
  'Cloudflare reported failure without saying why';

const chunk = <T>(items: T[], size: number): T[][] => {
  const batches: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size));
  }
  return batches;
};

/**
 * Purge a zone's cache, either wholesale or for specific URLs.
 *
 * This is the single most destructive-looking button on the dashboard, but a
 * cache purge is recoverable by definition — the origin refills it. The real
 * cost is a temporary spike in origin load, which is why purge-by-URL exists
 * and is offered alongside purge-everything.
 */
export const purgeCache = async (
  site: Site,
  target: PurgeTarget,
): Promise<PanelResult<PurgeOutcome>> => {
  const token = env.cloudflareToken();
  if (!token) {
    return unconfigured('CLOUDFLARE_API_TOKEN is not set in .env');
  }

  const zoneId = site.cloudflare?.zoneId;
  if (!zoneId) {
    return unconfigured(
      `No cloudflare.zoneId for "${site.slug}" in data/sites.json`,
    );
  }

  const bodies: unknown[] =
    target.mode === 'everything'
      ? [{ purge_everything: true }]
      : chunk(target.urls, PURGE_FILES_PER_REQUEST).map((files) => ({ files }));

  if (target.mode === 'files' && target.urls.length === 0) {
    return failed('No URLs given to purge');
  }

  try {
    let purgeId: string | undefined;

    for (const body of bodies) {
      const envelope = await fetchJson<CloudflareEnvelope<{ id: string }>>(
        `${API}/zones/${encodeURIComponent(zoneId)}/purge_cache`,
        {
          method: 'POST',
          headers: { ...bearer(token), 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          timeoutMs: 20_000,
        },
      );

      if (!envelope.success) return failed(envelopeError(envelope));
      purgeId ??= envelope.result?.id;
    }

    return ok({
      mode: target.mode,
      count: target.mode === 'files' ? target.urls.length : undefined,
      purgeId,
    });
  } catch (error) {
    if (error instanceof HttpError && error.isAuthFailure) {
      return failed(
        'Cloudflare rejected the token. It needs the Zone > Cache Purge > Purge permission for this zone.',
      );
    }
    return failed(messageOf(error));
  }
};

export interface Zone {
  id: string;
  name: string;
  status: string;
}

/** Exported so a "refresh now" action can drop just this entry. */
export const ZONES_CACHE_KEY = 'cloudflare:zones';

/**
 * Every zone the token can see. Used both by the dashboard and by "add site by
 * URL", which matches a hostname against these names to find its zone id.
 *
 * Paginated because the token may see more zones than one page holds — this
 * account has 24, but that is not a limit to rely on.
 */
export const listZones = async (): Promise<PanelResult<Zone[]>> => {
  const token = env.cloudflareToken();
  if (!token) return unconfigured('CLOUDFLARE_API_TOKEN is not set');

  return cachedResult(ZONES_CACHE_KEY, TTL.zones, () => loadZones(token));
};

const loadZones = async (token: string): Promise<PanelResult<Zone[]>> => {
  const zones: Zone[] = [];

  try {
    for (let page = 1; page <= 10; page += 1) {
      const envelope = await fetchJson<
        CloudflareEnvelope<Zone[]> & {
          result_info?: { total_pages?: number };
        }
      >(`${API}/zones?per_page=50&page=${page}`, {
        headers: bearer(token),
        timeoutMs: 15_000,
      });

      if (!envelope.success) return failed(envelopeError(envelope));

      zones.push(
        ...envelope.result.map((zone) => ({
          id: zone.id,
          name: zone.name,
          status: zone.status,
        })),
      );

      const totalPages = envelope.result_info?.total_pages ?? 1;
      if (page >= totalPages) break;
    }

    zones.sort((a, b) => a.name.localeCompare(b.name));
    return ok(zones);
  } catch (error) {
    if (error instanceof HttpError && error.isAuthFailure) {
      return failed(
        'Cloudflare rejected the token. Zone → Zone → Read is needed to list zones.',
      );
    }
    return failed(messageOf(error));
  }
};

export interface TokenStatus {
  status: string;
}

/** Cheap credential check used by the dashboard's status strip. */
export const verifyToken = async (): Promise<PanelResult<TokenStatus>> => {
  const token = env.cloudflareToken();
  if (!token) return unconfigured('CLOUDFLARE_API_TOKEN is not set in .env');

  try {
    const envelope = await fetchJson<CloudflareEnvelope<{ status: string }>>(
      `${API}/user/tokens/verify`,
      { headers: bearer(token), timeoutMs: 10_000 },
    );
    if (!envelope.success) return failed(envelopeError(envelope));
    return ok({ status: envelope.result.status });
  } catch (error) {
    if (error instanceof HttpError && error.isAuthFailure) {
      return failed('Cloudflare rejected the token.');
    }
    return failed(messageOf(error));
  }
};
