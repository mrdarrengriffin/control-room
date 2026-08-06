import { listZones } from './providers/cloudflare';
import { listDomains as listNetlifyDomains } from './providers/netlify';
import { listDomains as listPlausibleDomains } from './providers/plausible';
import { loadRegistry, slugFromDomain } from './sites';
import type { PanelResult } from './types';

/**
 * Ask every connected service which domains it knows about.
 *
 * The alternative is typing them one at a time, and the inventory already
 * exists — in Cloudflare's zone list, in what Netlify serves. Discovering it
 * beats remembering it: the first time this was done by hand against Cloudflare
 * it turned up six analytics properties where three had been guessed.
 *
 * GitHub was a source here and was removed. It could only offer repository
 * homepage links, which meant 54 domains of which most were readthedocs, Ghost
 * and other people's projects — ten seconds of paging to produce mostly noise.
 *
 * Every source degrades on its own. One unconfigured or failing service must
 * not stop the others reporting, because the useful answer is usually the union
 * of whichever ones did work.
 */

export type ScanSourceId = 'cloudflare' | 'plausible' | 'netlify';

export interface ScanSource {
  id: ScanSourceId;
  name: string;
  status: 'ok' | 'unconfigured' | 'error';
  /** How many domains this source contributed, before de-duplication. */
  found: number;
  detail?: string;
}

export interface Candidate {
  domain: string;
  /** Which services reported it. More sources is weak evidence it matters. */
  sources: ScanSourceId[];
}

export interface ScanResult {
  sources: ScanSource[];
  candidates: Candidate[];
  /** Domains found but already in the registry — reported, not offered. */
  alreadyAdded: string[];
}

export const SCAN_SOURCES: Array<{
  id: ScanSourceId;
  name: string;
  what: string;
}> = [
  { id: 'cloudflare', name: 'Cloudflare', what: 'Every zone on the account. The most complete list of what you run.' },
  { id: 'netlify', name: 'Netlify', what: 'Custom domains and aliases of sites the token can enumerate.' },
  { id: 'plausible', name: 'Plausible', what: 'Sites on the default instance. Needs the API-key Sites endpoint, which self-hosted Community Edition does not mount.' },
];

const LABELS: Record<ScanSourceId, string> = Object.fromEntries(
  SCAN_SOURCES.map((source) => [source.id, source.name]),
) as Record<ScanSourceId, string>;

export const isScanSource = (value: string): value is ScanSourceId =>
  SCAN_SOURCES.some((source) => source.id === value);

/** A hostname is only interesting if it has a dot and no path or scheme left. */
const cleanDomain = (raw: string): string | undefined => {
  const value = raw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/:\d+$/, '');
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(value)) return undefined;
  return value;
};

export const scanServices = async (
  selected: ScanSourceId[],
): Promise<ScanResult> => {
  const wanted = new Set(selected);

  const run = async <T>(
    id: ScanSourceId,
    load: () => Promise<PanelResult<T>>,
  ): Promise<PanelResult<T> | undefined> =>
    wanted.has(id) ? load() : undefined;

  const [zones, plausible, netlify] = await Promise.all([
    run('cloudflare', listZones),
    run('plausible', listPlausibleDomains),
    run('netlify', listNetlifyDomains),
  ]);

  const results: Array<[ScanSourceId, PanelResult<string[]>]> = [];
  if (zones) {
    results.push([
      'cloudflare',
      zones.status === 'ok'
        ? { status: 'ok', data: zones.data.map((zone) => zone.name) }
        : zones,
    ]);
  }
  if (plausible) results.push(['plausible', plausible]);
  if (netlify) results.push(['netlify', netlify]);

  const sources: ScanSource[] = [];
  const bySource = new Map<string, Set<ScanSourceId>>();

  for (const [id, result] of results) {
    if (result.status !== 'ok') {
      sources.push({
        id,
        name: LABELS[id],
        status: result.status === 'unconfigured' ? 'unconfigured' : 'error',
        found: 0,
        detail: result.status === 'unconfigured' ? result.reason : result.reason,
      });
      continue;
    }

    let found = 0;
    for (const raw of result.data) {
      const domain = cleanDomain(raw);
      if (!domain) continue;
      found += 1;
      const set = bySource.get(domain) ?? new Set<ScanSourceId>();
      set.add(id);
      bySource.set(domain, set);
    }

    sources.push({
      id,
      name: LABELS[id],
      status: 'ok',
      found,
      detail:
        found === 0
          ? id === 'netlify'
            ? 'No sites this token can enumerate. Netlify hides sites in teams the token cannot list, so this does not mean there are none.'
            : 'Nothing reported.'
          : undefined,
    });
  }

  const { sites } = await loadRegistry();
  const taken = new Set<string>();
  for (const site of sites) {
    taken.add(site.slug);
    if (site.plausible?.domain) taken.add(slugFromDomain(site.plausible.domain));
  }

  const candidates: Candidate[] = [];
  const alreadyAdded: string[] = [];

  for (const [domain, ids] of bySource) {
    if (taken.has(slugFromDomain(domain))) {
      alreadyAdded.push(domain);
      continue;
    }
    candidates.push({ domain, sources: [...ids] });
  }

  // Most-corroborated first, then alphabetical: a domain two services agree on
  // is likelier to be one you actually run than a single mention.
  candidates.sort(
    (a, b) =>
      b.sources.length - a.sources.length || a.domain.localeCompare(b.domain),
  );

  return { sources, candidates, alreadyAdded: alreadyAdded.sort() };
};
