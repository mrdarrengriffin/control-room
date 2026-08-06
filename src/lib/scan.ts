import { runCommand } from './exec';
import { env } from './env';
import { listZones } from './providers/cloudflare';
import { listDomains as listNetlifyDomains } from './providers/netlify';
import { listDomains as listPlausibleDomains } from './providers/plausible';
import { loadRegistry, slugFromDomain } from './sites';
import type { PanelResult } from './types';

/**
 * Ask every connected service which domains it knows about.
 *
 * The alternative is typing them one at a time, and the inventory already
 * exists — in Cloudflare's zone list, in Plausible's site list, in what Netlify
 * serves. Discovering it beats remembering it: the first time this was done by
 * hand against Cloudflare it turned up six analytics properties where three had
 * been guessed.
 *
 * Every source degrades on its own. One unconfigured or failing service must
 * not stop the others reporting, because the useful answer is usually the union
 * of whichever ones did work.
 */

export type ScanSourceId = 'cloudflare' | 'plausible' | 'netlify' | 'github';

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
  { id: 'plausible', name: 'Plausible', what: 'Sites on the default instance. Needs the Sites API, which self-hosted Community Edition does not expose.' },
  { id: 'github', name: 'GitHub', what: 'Homepage links on repositories you own. Broad, and picks up third-party links too.' },
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

/**
 * Domains named as the homepage of a repository you own.
 *
 * A weaker signal than the other three — a homepage can point anywhere — but it
 * catches sites whose DNS and analytics live somewhere this token cannot see.
 * Restricted to owners you belong to, or it would return the whole internet.
 */
const githubDomains = async (): Promise<PanelResult<string[]>> => {
  const token = env.githubToken();
  if (!token) {
    return { status: 'unconfigured', reason: 'GITHUB_TOKEN is not set' };
  }

  const ghEnv = { GH_TOKEN: token };

  const owners: string[] = [];
  const login = await runCommand('gh', ['api', 'user', '--jq', '.login'], {
    timeoutMs: 20_000,
    env: ghEnv,
  });
  if (login.code !== 0) {
    return {
      status: 'error',
      reason: login.stderr.trim() || 'gh could not authenticate',
    };
  }
  if (login.stdout.trim()) owners.push(login.stdout.trim());

  const orgs = await runCommand(
    'gh',
    ['api', 'user/orgs', '--paginate', '--jq', '.[].login'],
    { timeoutMs: 25_000, env: ghEnv },
  );
  if (orgs.code === 0) {
    for (const line of orgs.stdout.split(/\r?\n/)) {
      if (line.trim()) owners.push(line.trim());
    }
  }

  const domains = new Set<string>();

  /*
   * Sequential rather than parallel: this is several paginated calls per owner
   * and GitHub is the slowest thing here anyway. Running them at once mostly
   * buys secondary rate limiting.
   */
  for (const owner of owners) {
    const repos = await runCommand(
      'gh',
      [
        'api',
        `users/${owner}/repos?per_page=100&type=owner`,
        '--paginate',
        '--jq',
        '.[] | select(.homepage != null and .homepage != "") | .homepage',
      ],
      { timeoutMs: 45_000, env: ghEnv },
    );

    // An org needs the orgs endpoint; try it when the user one finds nothing.
    const output =
      repos.code === 0 && repos.stdout.trim() !== ''
        ? repos.stdout
        : (
            await runCommand(
              'gh',
              [
                'api',
                `orgs/${owner}/repos?per_page=100`,
                '--paginate',
                '--jq',
                '.[] | select(.homepage != null and .homepage != "") | .homepage',
              ],
              { timeoutMs: 45_000, env: ghEnv },
            )
          ).stdout;

    for (const line of output.split(/\r?\n/)) {
      const domain = cleanDomain(line);
      if (domain) domains.add(domain);
    }
  }

  return { status: 'ok', data: [...domains].sort() };
};

/**
 * Scan the chosen services only.
 *
 * Selectable because the sources are not equivalent: Cloudflare answers in half
 * a second and is authoritative, GitHub takes ten and is speculative, and a
 * self-hosted Plausible cannot answer at all. Being able to run just the useful
 * ones is the difference between a quick check and a slow one full of noise.
 */
export const scanServices = async (
  selected: ScanSourceId[],
): Promise<ScanResult> => {
  const wanted = new Set(selected);

  const run = async <T>(
    id: ScanSourceId,
    load: () => Promise<PanelResult<T>>,
  ): Promise<PanelResult<T> | undefined> =>
    wanted.has(id) ? load() : undefined;

  const [zones, plausible, netlify, github] = await Promise.all([
    run('cloudflare', listZones),
    run('plausible', listPlausibleDomains),
    run('netlify', listNetlifyDomains),
    run('github', githubDomains),
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
  if (github) results.push(['github', github]);

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

  // Most-corroborated first, then alphabetical: a domain three services agree
  // on is likelier to be one you actually run than a one-off homepage link.
  candidates.sort(
    (a, b) =>
      b.sources.length - a.sources.length || a.domain.localeCompare(b.domain),
  );

  return { sources, candidates, alreadyAdded: alreadyAdded.sort() };
};
