import { TTL, cached } from '../cache';
import { env } from '../env';
import { HttpError, bearer, fetchJson } from '../http';
import { failed, messageOf, ok, unconfigured } from '../types';
import type { PanelResult, Site } from '../types';

const API = 'https://api.netlify.com/api/v1';

/** Raw shape from Netlify, narrowed to the fields we actually use. */
interface NetlifySite {
  id: string;
  name: string;
  custom_domain?: string | null;
  domain_aliases?: string[];
  ssl_url?: string;
  url?: string;
  admin_url?: string;
  account_name?: string;
  build_settings?: { repo_url?: string };
  published_deploy?: NetlifyDeploy & { review_id?: number | null };
}

interface NetlifyDeploy {
  id: string;
  state: string;
  name?: string;
  admin_url?: string;
  deploy_ssl_url?: string;
  deploy_url?: string;
  created_at?: string;
  published_at?: string | null;
  title?: string | null;
  context?: string;
  deploy_time?: number | null;
  error_message?: string | null;
  branch?: string;
  commit_ref?: string | null;
  commit_url?: string | null;
}

export type DeployHealth = 'building' | 'ready' | 'error' | 'cancelled' | 'other';

export interface Deploy {
  id: string;
  state: string;
  health: DeployHealth;
  title?: string;
  context?: string;
  branch?: string;
  commitRef?: string;
  commitUrl?: string;
  createdAt?: string;
  publishedAt?: string;
  deploySeconds?: number;
  errorMessage?: string;
  previewUrl?: string;
  /**
   * Deep link to the build log in Netlify's UI.
   *
   * Netlify publishes no documented API for build log text, so this links out
   * rather than half-scraping an undocumented route.
   */
  logUrl?: string;
}

const HEALTH: Record<string, DeployHealth> = {
  new: 'building',
  pending_review: 'building',
  accepted: 'building',
  enqueued: 'building',
  building: 'building',
  uploading: 'building',
  uploaded: 'building',
  preparing: 'building',
  prepared: 'building',
  processing: 'building',
  retrying: 'building',
  ready: 'ready',
  current: 'ready',
  error: 'error',
  cancelled: 'cancelled',
  skipped: 'cancelled',
};

const logUrlFor = (deploy: NetlifyDeploy): string | undefined => {
  if (deploy.admin_url) return `${deploy.admin_url}/deploys/${deploy.id}`;
  if (deploy.name) {
    return `https://app.netlify.com/sites/${deploy.name}/deploys/${deploy.id}`;
  }
  return undefined;
};

const normalise = (deploy: NetlifyDeploy): Deploy => ({
  id: deploy.id,
  state: deploy.state,
  health: HEALTH[deploy.state] ?? 'other',
  title: deploy.title ?? undefined,
  context: deploy.context,
  branch: deploy.branch,
  commitRef: deploy.commit_ref ?? undefined,
  commitUrl: deploy.commit_url ?? undefined,
  createdAt: deploy.created_at,
  publishedAt: deploy.published_at ?? undefined,
  deploySeconds: deploy.deploy_time ?? undefined,
  errorMessage: deploy.error_message ?? undefined,
  previewUrl: deploy.deploy_ssl_url ?? deploy.deploy_url,
  logUrl: logUrlFor(deploy),
});

// --- Resolving which Netlify site a URL corresponds to ---------------------

const bareHost = (value: string): string =>
  value.replace(/^www\./i, '').toLowerCase();

/**
 * Candidate identifiers to try, so no site id has to be pasted in by hand.
 * Netlify accepts a UUID or a domain, and the www variant matters: some sites
 * are registered bare, others only under www.
 */
const candidatesFor = (hostname: string): string[] => [
  hostname,
  hostname.startsWith('www.') ? hostname.slice(4) : `www.${hostname}`,
];

/**
 * Does this Netlify site actually serve the domain we asked about?
 *
 * This check is NOT paranoia. Looking up `home-assistant.io` returned a site in
 * an unrelated third party's account whose only domain was www.home-assistant.ru,
 * last deployed in 2018 — Netlify's identifier lookup matches more loosely than
 * "this domain belongs to this site". Without verifying, the dashboard happily
 * showed a stranger's deploy history under our site.
 */
const serves = (site: NetlifySite, hostname: string): boolean => {
  const wanted = bareHost(hostname);

  const domains = [
    site.custom_domain ?? undefined,
    ...(site.domain_aliases ?? []),
    site.name ? `${site.name}.netlify.app` : undefined,
  ];

  for (const domain of domains) {
    if (domain && bareHost(domain) === wanted) return true;
  }

  for (const url of [site.ssl_url, site.url]) {
    if (!url) continue;
    try {
      if (bareHost(new URL(url).host) === wanted) return true;
    } catch {
      // Not a URL; ignore.
    }
  }

  return false;
};

interface Resolved {
  site: NetlifySite;
  /** True when an explicit siteId was configured rather than derived. */
  explicit: boolean;
}

type Resolution =
  | { kind: 'ok'; resolved: Resolved }
  | { kind: 'disabled' }
  | { kind: 'no-token' }
  | { kind: 'not-found'; detail: string }
  | { kind: 'error'; detail: string };

/**
 * Cached because this is the slowest upstream measured (~700ms) and resolution
 * may try two identifiers per site. A 404 is cached too — "no site here" is just
 * as worth remembering as a hit, and it is half of what resolution does.
 * Genuine failures throw and are never stored.
 */
const fetchSite = async (
  identifier: string,
  token: string,
): Promise<NetlifySite | undefined> =>
  cached(`netlify:site:${identifier}`, TTL.activity, async () => {
    try {
      return await fetchJson<NetlifySite>(
        `${API}/sites/${encodeURIComponent(identifier)}`,
        { headers: bearer(token), timeoutMs: 15_000 },
      );
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) return undefined;
      throw error;
    }
  });

const resolveSite = async (site: Site): Promise<Resolution> => {
  if (site.netlify?.enabled === false) return { kind: 'disabled' };

  const token = env.netlifyToken();
  if (!token) return { kind: 'no-token' };

  let hostname: string;
  try {
    hostname = new URL(site.url).hostname;
  } catch {
    return { kind: 'error', detail: `"${site.url}" is not a valid URL` };
  }

  try {
    // An explicit id is the user's decision — take it at face value.
    const configured = site.netlify?.siteId;
    if (configured) {
      const found = await fetchSite(configured, token);
      return found
        ? { kind: 'ok', resolved: { site: found, explicit: true } }
        : {
            kind: 'not-found',
            detail: `Netlify has no site "${configured}" visible to this token.`,
          };
    }

    const rejected: string[] = [];

    for (const candidate of candidatesFor(hostname)) {
      const found = await fetchSite(candidate, token);
      if (!found) continue;

      if (serves(found, hostname)) {
        return { kind: 'ok', resolved: { site: found, explicit: false } };
      }

      rejected.push(
        `"${found.name}"${found.account_name ? ` in ${found.account_name}` : ''}`,
      );
    }

    if (rejected.length > 0) {
      return {
        kind: 'not-found',
        detail: `Netlify matched ${rejected.join(' and ')} for ${hostname}, but neither serves that domain — ignored. Set netlify.siteId if one of them is right.`,
      };
    }

    return {
      kind: 'not-found',
      detail: `Not on Netlify — nothing serving ${candidatesFor(hostname).join(' or ')}.`,
    };
  } catch (error) {
    if (error instanceof HttpError && error.isAuthFailure) {
      return { kind: 'error', detail: 'Netlify rejected the token (NETLIFY_AUTH_TOKEN).' };
    }
    return { kind: 'error', detail: messageOf(error) };
  }
};

/** Turn a non-ok resolution into the right panel state. */
const asPanel = (resolution: Resolution): PanelResult<never> => {
  switch (resolution.kind) {
    case 'disabled':
      return unconfigured('Netlify is turned off for this site.');
    case 'no-token':
      return unconfigured('NETLIFY_AUTH_TOKEN is not set.');
    case 'not-found':
      // Not being on Netlify is a fact about the site, not a fault.
      return unconfigured(resolution.detail);
    default:
      return failed(resolution.detail);
  }
};

// --- Public API ------------------------------------------------------------

export const listDeploys = async (
  site: Site,
  limit = 10,
): Promise<PanelResult<Deploy[]>> => {
  const resolution = await resolveSite(site);
  if (resolution.kind !== 'ok') return asPanel(resolution);

  const token = env.netlifyToken();
  if (!token) return unconfigured('NETLIFY_AUTH_TOKEN is not set.');

  const siteId = resolution.resolved.site.id;

  try {
    const deploys = await cached(
      `netlify:deploys:${siteId}:${limit}`,
      TTL.activity,
      () =>
        fetchJson<NetlifyDeploy[]>(
          `${API}/sites/${siteId}/deploys?per_page=${limit}`,
          { headers: bearer(token), timeoutMs: 20_000 },
        ),
    );
    return ok(deploys.map(normalise));
  } catch (error) {
    if (error instanceof HttpError && error.isAuthFailure) {
      return failed('Netlify rejected the token (NETLIFY_AUTH_TOKEN).');
    }
    return failed(messageOf(error));
  }
};

export interface PublishedDeploy {
  state: string;
  health: DeployHealth;
  context?: string;
  branch?: string;
  title?: string;
  commitRef?: string;
  commitUrl?: string;
  publishedAt?: string;
  deploySeconds?: number;
  /** Pull request this deploy came from, where one can be determined. */
  pullRequest?: number;
  logUrl?: string;
}

export interface SiteStatus {
  name: string;
  url?: string;
  adminUrl?: string;
  deploy?: PublishedDeploy;
}

/**
 * Which PR a deploy came from.
 *
 * Deploy previews carry it in `review_id`. Production deploys do not, but their
 * title is the merge commit subject, which conventionally ends in "(#123)" —
 * e.g. "Add Plausible event for 404 (#102)".
 */
const pullRequestFor = (
  deploy: NetlifyDeploy & { review_id?: number | null },
): number | undefined => {
  if (typeof deploy.review_id === 'number' && deploy.review_id > 0) {
    return deploy.review_id;
  }
  const match = /\(#(\d+)\)\s*$/.exec(deploy.title ?? '');
  return match ? Number(match[1]) : undefined;
};

export const siteStatus = async (site: Site): Promise<PanelResult<SiteStatus>> => {
  const resolution = await resolveSite(site);
  if (resolution.kind !== 'ok') return asPanel(resolution);

  const info = resolution.resolved.site;
  const published = info.published_deploy;

  return ok({
    name: info.name,
    url: info.ssl_url ?? info.url,
    adminUrl: info.admin_url,
    deploy: published
      ? {
          state: published.state,
          health: HEALTH[published.state] ?? 'other',
          context: published.context,
          branch: published.branch,
          title: published.title ?? undefined,
          commitRef: published.commit_ref ?? undefined,
          commitUrl: published.commit_url ?? undefined,
          publishedAt: published.published_at ?? published.created_at,
          deploySeconds: published.deploy_time ?? undefined,
          pullRequest: pullRequestFor(published),
          logUrl: logUrlFor(published),
        }
      : undefined,
  });
};

export interface NetlifyIdentity {
  name: string;
}

/**
 * Credential check for the settings page.
 *
 * Deliberately hits /user rather than /sites: this token returns an EMPTY sites
 * array even though it can read individual sites, so an empty list would read as
 * a broken token when it is nothing of the kind.
 */
export const verifyToken = async (): Promise<PanelResult<NetlifyIdentity>> => {
  const token = env.netlifyToken();
  if (!token) return unconfigured('NETLIFY_AUTH_TOKEN is not set');

  try {
    const user = await fetchJson<{
      full_name?: string;
      slug?: string;
      email?: string;
    }>(`${API}/user`, { headers: bearer(token), timeoutMs: 12_000 });

    return ok({ name: user.full_name ?? user.slug ?? user.email ?? 'authenticated' });
  } catch (error) {
    if (error instanceof HttpError && error.isAuthFailure) {
      return failed('Netlify rejected the token (NETLIFY_AUTH_TOKEN).');
    }
    return failed(messageOf(error));
  }
};

/**
 * Look a site up for discovery, verifying it really serves the domain. Returns
 * the repo it builds from, which is a better source for the GitHub repo than
 * searching by name.
 */
export const findSiteForHost = async (
  siteUrl: string,
): Promise<
  PanelResult<{ id: string; name: string; repoUrl?: string; matchedBy: string }>
> => {
  const probe: Site = { slug: 'probe', name: 'probe', url: siteUrl };
  const resolution = await resolveSite(probe);

  if (resolution.kind !== 'ok') return asPanel(resolution);

  const info = resolution.resolved.site;
  return ok({
    id: info.id,
    name: info.name,
    repoUrl: info.build_settings?.repo_url,
    matchedBy: info.custom_domain ?? info.name,
  });
};
