import { invalidate } from './cache';
import { ZONES_CACHE_KEY, listZones } from './providers/cloudflare';
import { loadRegistry, slugFromDomain } from './sites';

/**
 * Which domains does Cloudflare know about that aren't here yet?
 *
 * Cloudflare only. The others were tried and dropped: Netlify's site list comes
 * back empty for a token that cannot enumerate the teams the sites live in; a
 * self-hosted Plausible does not mount the token-authenticated /api/v1/sites at
 * all; and GitHub could offer nothing better than repository homepage links,
 * which produced 54 domains of mostly other people's projects against 24 real
 * ones. The zone list is authoritative and answers in half a second.
 *
 * There is no scheduler behind "periodically". The zone list is cached for an
 * hour with stale-while-revalidate and the add-site page re-renders on its own
 * timer, so the scan refreshes itself in the background with no job to run or
 * supervise.
 */

export interface ScanResult {
  status: 'ok' | 'unconfigured' | 'error';
  /** Why there is nothing to show, when there is nothing to show. */
  detail?: string;
  /** Zones not already in the registry. */
  candidates: string[];
  /** Zones already in the registry. Shown, but not offered again. */
  alreadyAdded: string[];
  /** Total zones the token can see. */
  total: number;
}

/** Drop the cached zone list so the next scan really asks Cloudflare. */
export const forgetScan = (): void => invalidate(ZONES_CACHE_KEY);

export const scanCloudflare = async (): Promise<ScanResult> => {
  const zones = await listZones();

  if (zones.status !== 'ok') {
    return {
      status: zones.status === 'unconfigured' ? 'unconfigured' : 'error',
      detail: zones.reason,
      candidates: [],
      alreadyAdded: [],
      total: 0,
    };
  }

  const { sites } = await loadRegistry();
  const taken = new Set<string>();
  for (const site of sites) {
    taken.add(site.slug);
    if (site.plausible?.domain) taken.add(slugFromDomain(site.plausible.domain));
  }

  const candidates: string[] = [];
  const alreadyAdded: string[] = [];

  for (const zone of zones.data) {
    const domain = zone.name.toLowerCase();
    if (taken.has(slugFromDomain(domain))) alreadyAdded.push(domain);
    else candidates.push(domain);
  }

  candidates.sort();
  alreadyAdded.sort();

  return { status: 'ok', candidates, alreadyAdded, total: zones.data.length };
};
