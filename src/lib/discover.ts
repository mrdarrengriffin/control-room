import { parseJsonOutput, runCommand } from './exec';
import { env } from './env';
import { listZones } from './providers/cloudflare';
import { findSiteForHost } from './providers/netlify';
import { summary } from './providers/plausible';
import { loadRegistry, slugFromDomain } from './sites';
import { messageOf } from './types';
import type { Site } from './types';

/**
 * Given nothing but a URL, work out what this site is on each connected service.
 *
 * Ordering matters and is cheapest-and-most-authoritative first. In particular
 * Netlify is asked before GitHub, because a Netlify site records the repository
 * it builds from — that is a far better answer than searching GitHub by name,
 * which is guesswork. Guessed values are always reported as guesses so they can
 * be corrected before saving.
 */

export type FindingStatus = 'found' | 'not-found' | 'unavailable';

export interface Finding<T> {
  status: FindingStatus;
  value?: T;
  /** Human-readable explanation, shown next to the field. */
  detail: string;
}

export interface Discovery {
  url: string;
  hostname: string;
  slug: string;
  name: string;
  cloudflare: Finding<{ zoneId: string; zoneName: string }>;
  netlify: Finding<{ siteId: string; siteName: string }>;
  plausible: Finding<{
    domain: string;
    visitors: number;
    baseUrl?: string;
    keyEnv?: string;
  }>;
  github: Finding<{ repo: string; certain: boolean }>;
  /** Alternatives when the repo had to be guessed. */
  githubCandidates: string[];
}

const unavailable = (detail: string): Finding<never> => ({
  status: 'unavailable',
  detail,
});

/**
 * A hostname and its www counterpart. Services disagree about which they know a
 * site by: Netlify has openhomefoundation.org under `www.`, while
 * handbook.openhomefoundation.org has no www at all.
 */
const hostCandidates = (hostname: string): string[] => {
  const toggled = hostname.startsWith('www.')
    ? hostname.slice(4)
    : `www.${hostname}`;
  return [hostname, toggled];
};

/** owner/repo out of a git URL, tolerating dots in the repo name. */
export const parseRepoUrl = (url: string): string | undefined => {
  // Repo names here genuinely contain dots — openhomefoundation.org, bthome.io —
  // so the name segment must not stop at a dot.
  const match = /github\.com[:/]([^/]+)\/(.+?)(?:\.git)?\/?$/.exec(url.trim());
  if (!match) return undefined;
  const [, owner, name] = match;
  return owner && name ? `${owner}/${name}` : undefined;
};

const discoverCloudflare = async (
  hostname: string,
): Promise<Discovery['cloudflare']> => {
  const zones = await listZones();

  if (zones.status === 'unconfigured') return unavailable(zones.reason);
  if (zones.status === 'error') return unavailable(zones.reason);

  // Longest match wins, so a.b.example.com prefers zone b.example.com over
  // example.com if both are present.
  const matches = zones.data
    .filter(
      (zone) => hostname === zone.name || hostname.endsWith(`.${zone.name}`),
    )
    .sort((a, b) => b.name.length - a.name.length);

  const zone = matches[0];
  if (!zone) {
    return {
      status: 'not-found',
      detail: `No Cloudflare zone covers ${hostname} (${zones.data.length} zones checked)`,
    };
  }

  return {
    status: 'found',
    value: { zoneId: zone.id, zoneName: zone.name },
    detail:
      zone.name === hostname
        ? `Zone ${zone.name}`
        : `Inside zone ${zone.name} — purging everything affects the whole zone`,
  };
};

const discoverNetlify = async (
  siteUrl: string,
): Promise<{ finding: Discovery['netlify']; repoUrl?: string }> => {
  // The provider does the www toggling and, importantly, verifies the site it
  // finds actually serves the domain — a bare-hostname lookup can otherwise
  // return an unrelated site in someone else's account.
  const result = await findSiteForHost(siteUrl);

  if (result.status === 'unconfigured') {
    return { finding: { status: 'not-found', detail: result.reason } };
  }
  if (result.status === 'error') {
    return { finding: unavailable(result.reason) };
  }

  return {
    finding: {
      status: 'found',
      value: { siteId: result.data.id, siteName: result.data.name },
      detail: `Netlify site "${result.data.name}" serving ${result.data.matchedBy}`,
    },
    repoUrl: result.data.repoUrl,
  };
};

const discoverPlausible = async (
  hostname: string,
): Promise<Discovery['plausible']> => {
  const { sites } = await loadRegistry();

  // The default instance, plus every other instance already in use — so a site
  // on a second Plausible install is found without being told about it.
  const instances: { baseUrl?: string; keyEnv?: string }[] = [{}];
  for (const site of sites) {
    const baseUrl = site.plausible?.baseUrl;
    const keyEnv = site.plausible?.keyEnv;
    if (!baseUrl && !keyEnv) continue;
    const seen = instances.some(
      (instance) => instance.baseUrl === baseUrl && instance.keyEnv === keyEnv,
    );
    if (!seen) instances.push({ baseUrl, keyEnv });
  }

  const domains = hostCandidates(hostname);
  let sawUnconfigured: string | undefined;

  for (const instance of instances) {
    for (const domain of domains) {
      const probe: Site = {
        slug: 'discovery-probe',
        name: 'discovery probe',
        url: `https://${domain}`,
        plausible: { domain, baseUrl: instance.baseUrl, keyEnv: instance.keyEnv },
      };

      const result = await summary(probe, '7d');

      if (result.status === 'ok') {
        return {
          status: 'found',
          value: {
            domain,
            visitors: result.data.visitors,
            baseUrl: instance.baseUrl,
            keyEnv: instance.keyEnv,
          },
          detail: `${result.data.visitors} visitors in the last 7 days${
            instance.baseUrl ? ` on ${instance.baseUrl}` : ''
          }`,
        };
      }

      if (result.status === 'unconfigured') sawUnconfigured = result.reason;
    }
  }

  if (sawUnconfigured) return unavailable(sawUnconfigured);

  return {
    status: 'not-found',
    detail: `No Plausible site for ${domains.join(' or ')} on ${instances.length} instance(s). It may be on another Plausible install.`,
  };
};

interface SearchHit {
  fullName: string;
}

/**
 * The account plus every org it belongs to.
 *
 * Searching GitHub for a domain returns a lot of unrelated third-party
 * repositories — "home-assistant.io" surfaces half a dozen community projects.
 * Restricting matches to owners the user actually belongs to turns a noisy list
 * into a useful one.
 */
const ownedOwners = async (): Promise<Set<string>> => {
  const owners = new Set<string>();
  const ghEnv = { GH_TOKEN: env.githubToken() };

  const login = await runCommand('gh', ['api', 'user', '--jq', '.login'], {
    timeoutMs: 20_000,
    env: ghEnv,
  });
  if (login.code === 0 && login.stdout.trim() !== '') {
    owners.add(login.stdout.trim().toLowerCase());
  }

  const orgs = await runCommand(
    'gh',
    ['api', 'user/orgs', '--paginate', '--jq', '.[].login'],
    { timeoutMs: 25_000, env: ghEnv },
  );
  if (orgs.code === 0) {
    for (const line of orgs.stdout.split(/\r?\n/)) {
      const value = line.trim();
      if (value !== '') owners.add(value.toLowerCase());
    }
  }

  return owners;
};

const discoverGithub = async (
  hostname: string,
  repoUrl: string | undefined,
): Promise<{ finding: Discovery['github']; candidates: string[] }> => {
  // Netlify already knows which repository builds the site — believe it.
  if (repoUrl) {
    const repo = parseRepoUrl(repoUrl);
    if (repo) {
      return {
        finding: {
          status: 'found',
          value: { repo, certain: true },
          detail: 'Taken from the Netlify site’s build settings',
        },
        candidates: [],
      };
    }
  }

  if (!env.githubToken()) {
    return { finding: unavailable('GITHUB_TOKEN is not set'), candidates: [] };
  }

  const bare = hostname.replace(/^www\./, '');

  try {
    const result = await runCommand(
      'gh',
      ['search', 'repos', bare, '--limit', '12', '--json', 'fullName'],
      { timeoutMs: 30_000, env: { GH_TOKEN: env.githubToken() } },
    );

    if (result.code !== 0) {
      return {
        finding: unavailable(result.stderr.trim() || `gh exited ${result.code}`),
        candidates: [],
      };
    }

    const hits = parseJsonOutput<SearchHit[]>(result, 'gh search repos').map(
      (hit) => hit.fullName,
    );

    const owners = await ownedOwners();
    const isOurs = (fullName: string) =>
      owners.has(fullName.split('/')[0]?.toLowerCase() ?? '');

    // Prefer repositories under an owner the user belongs to; only fall back to
    // the raw results if none of them are.
    const ours = hits.filter(isOurs);
    const pool = ours.length > 0 ? ours : hits;
    const restricted = ours.length > 0;

    const exact = pool.find(
      (name) => name.split('/')[1]?.toLowerCase() === bare.toLowerCase(),
    );

    if (exact) {
      return {
        finding: {
          status: 'found',
          value: { repo: exact, certain: false },
          detail: restricted
            ? `Exact name match in ${exact.split('/')[0]}, which you belong to — please confirm`
            : 'Repository named after the domain — please confirm',
        },
        candidates: pool.filter((name) => name !== exact).slice(0, 6),
      };
    }

    return {
      finding: {
        status: 'not-found',
        detail:
          pool.length > 0
            ? `No exact match${restricted ? ' in your orgs' : ''}; pick a suggestion or paste the repo`
            : `No repositories found for ${bare}`,
      },
      candidates: pool.slice(0, 6),
    };
  } catch (error) {
    return { finding: unavailable(messageOf(error)), candidates: [] };
  }
};

export const discoverSite = async (rawUrl: string): Promise<Discovery> => {
  const trimmed = rawUrl.trim();
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  const parsed = new URL(withScheme);
  const hostname = parsed.hostname.toLowerCase();

  // Cloudflare, Netlify and Plausible are independent; GitHub waits because
  // Netlify may hand it the answer.
  const [cloudflare, netlifyResult, plausible] = await Promise.all([
    discoverCloudflare(hostname),
    discoverNetlify(`${parsed.protocol}//${parsed.host}`),
    discoverPlausible(hostname),
  ]);

  const github = await discoverGithub(hostname, netlifyResult.repoUrl);

  return {
    url: `${parsed.protocol}//${parsed.host}`,
    hostname,
    slug: slugFromDomain(hostname),
    name: hostname.replace(/^www\./, ''),
    cloudflare,
    netlify: netlifyResult.finding,
    plausible,
    github: github.finding,
    githubCandidates: github.candidates,
  };
};
