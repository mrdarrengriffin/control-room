import { stat } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import path from 'node:path';
import { dataRoot, readJsonFile, writeJsonFile } from './store';
import type { Site } from './types';

interface SitesFile {
  sites?: unknown;
  /**
   * Shorthand: a flat list of domains, one per Plausible site. Every entry
   * becomes its own site — subdomains included, since Plausible treats each as a
   * separate property. Paste the list from your Plausible dashboard and go; use
   * the `sites` array instead when an entry needs Cloudflare/Netlify/GitHub ids.
   */
  domains?: unknown;
}

export interface Registry {
  sites: Site[];
  /**
   * Whether a registry was loaded at all. 'missing' is the normal state of a
   * new install, not an error — the dashboard shows its empty state.
   */
  source: 'registry' | 'missing';
  problems: string[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const optionalString = (
  container: Record<string, unknown>,
  key: string,
): string | undefined => {
  const value = container[key];
  return typeof value === 'string' && value.trim() !== ''
    ? value.trim()
    : undefined;
};

const optionalStringArray = (
  container: Record<string, unknown>,
  key: string,
): string[] | undefined => {
  const value = container[key];
  if (!Array.isArray(value)) return undefined;
  const items = value.filter(
    (item): item is string => typeof item === 'string' && item.trim() !== '',
  );
  return items.length > 0 ? items.map((item) => item.trim()) : undefined;
};

const nestedString = (
  container: Record<string, unknown>,
  key: string,
  field: string,
): string | undefined => {
  const nested = container[key];
  return isRecord(nested) ? optionalString(nested, field) : undefined;
};

/**
 * Parse one entry, collecting problems rather than throwing. A single malformed
 * site shouldn't take down the whole dashboard, so bad entries are reported and
 * skipped.
 */
const parseSite = (
  raw: unknown,
  index: number,
  problems: string[],
): Site | undefined => {
  if (!isRecord(raw)) {
    problems.push(`sites[${index}] is not an object`);
    return undefined;
  }

  const slug = optionalString(raw, 'slug');
  const url = optionalString(raw, 'url');
  const name = optionalString(raw, 'name');

  if (!slug) {
    problems.push(`sites[${index}] is missing "slug"`);
    return undefined;
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
    problems.push(
      `sites[${index}] slug "${slug}" must be lowercase letters, numbers and hyphens`,
    );
    return undefined;
  }
  if (!url) {
    problems.push(`"${slug}" is missing "url"`);
    return undefined;
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    problems.push(`"${slug}" has an invalid url: ${url}`);
    return undefined;
  }

  const zoneId = nestedString(raw, 'cloudflare', 'zoneId');
  const netlifySiteId = nestedString(raw, 'netlify', 'siteId');
  const githubRepo = nestedString(raw, 'github', 'repo');
  const plausibleDomain =
    nestedString(raw, 'plausible', 'domain') ?? parsedUrl.hostname;
  const plausibleBaseUrl = nestedString(raw, 'plausible', 'baseUrl');
  const plausibleKeyEnv = nestedString(raw, 'plausible', 'keyEnv');

  if (githubRepo && !/^[^/\s]+\/[^/\s]+$/.test(githubRepo)) {
    problems.push(
      `"${slug}" github.repo should be "owner/repo", got "${githubRepo}"`,
    );
  }

  return {
    slug,
    name: name ?? slug,
    url: url.replace(/\/+$/, ''),
    description: optionalString(raw, 'description'),
    tags: optionalStringArray(raw, 'tags'),
    cloudflare: zoneId ? { zoneId } : undefined,
    netlify: netlifySiteId ? { siteId: netlifySiteId } : undefined,
    plausible: {
      domain: plausibleDomain,
      baseUrl: plausibleBaseUrl,
      keyEnv: plausibleKeyEnv,
    },
    github: githubRepo ? { repo: githubRepo } : undefined,
    testPages: optionalStringArray(raw, 'testPages') ?? ['/'],
    interactivePages: optionalStringArray(raw, 'interactivePages'),
  };
};

/** Derive a stable slug from a domain: developers.example.io -> developers-example-io */
export const slugFromDomain = (domain: string): string =>
  domain
    .toLowerCase()
    .replace(/^www\./, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

/**
 * Expand a bare domain into a full site. Everything is derived, so a Plausible
 * site list can be pasted in wholesale and refined later.
 */
const siteFromDomain = (
  raw: unknown,
  problems: string[],
): Site | undefined => {
  if (typeof raw !== 'string') {
    problems.push('domains entries must be strings');
    return undefined;
  }

  // Tolerate a pasted URL as well as a bare domain.
  const domain = raw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '');

  if (domain === '') return undefined;

  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain)) {
    problems.push(`"${raw}" does not look like a domain`);
    return undefined;
  }

  return {
    slug: slugFromDomain(domain),
    name: domain.replace(/^www\./, ''),
    url: `https://${domain}`,
    plausible: { domain },
    testPages: ['/'],
  };
};

/**
 * Load the registry. No sites means no sites.
 *
 * This used to fall back to a bundled example file so a fresh install looked
 * explorable. It was a mistake: nothing downstream checked where the sites came
 * from, so five fictional domains were fed to the live providers. A new install
 * fetched example.org's title and favicon, and asked Plausible about
 * blog.example.org on every render — which answers 401 "Invalid API key or site
 * ID", making a perfectly good API key look rejected.
 */
const loadRegistryUncached = async (): Promise<Registry> => {
  const problems: string[] = [];

  const file = await readJsonFile<SitesFile>(
    path.join(dataRoot(), 'sites.json'),
  );

  if (!file) {
    // Not a problem to report — it is simply what a new install looks like.
    // The dashboard renders its empty state instead.
    return { sites: [], source: 'missing', problems: [] };
  }

  const source: Registry['source'] = 'registry';

  const explicit = Array.isArray(file.sites) ? file.sites : [];
  const shorthand = Array.isArray(file.domains) ? file.domains : [];

  if (explicit.length === 0 && shorthand.length === 0) {
    return {
      sites: [],
      source,
      problems: ['Expected a top-level "sites" array or "domains" list.'],
    };
  }

  const sites: Site[] = [];
  const seen = new Set<string>();

  const add = (site: Site | undefined, reportDuplicate: boolean) => {
    if (!site) return;
    if (seen.has(site.slug)) {
      if (reportDuplicate) {
        problems.push(`Duplicate slug "${site.slug}" — only the first is used.`);
      }
      return;
    }
    seen.add(site.slug);
    sites.push(site);
  };

  // Explicit entries are added first so that a fully-configured site always wins
  // over the same domain appearing in the shorthand list.
  explicit.forEach((raw, index) => add(parseSite(raw, index, problems), true));
  shorthand.forEach((raw) => add(siteFromDomain(raw, problems), false));

  sites.sort((a, b) => a.name.localeCompare(b.name));

  return { sites, source, problems };
};

/** Drop undefined/empty members so the written JSON stays readable. */
const compact = (value: unknown): unknown => {
  if (Array.isArray(value)) return value;
  if (value === null || typeof value !== 'object') return value;

  const out: Record<string, unknown> = {};
  for (const [key, member] of Object.entries(value as Record<string, unknown>)) {
    if (member === undefined) continue;
    const cleaned = compact(member);
    if (
      cleaned === undefined ||
      (typeof cleaned === 'object' &&
        cleaned !== null &&
        !Array.isArray(cleaned) &&
        Object.keys(cleaned).length === 0)
    ) {
      continue;
    }
    out[key] = cleaned;
  }
  return out;
};

/**
 * Append a site to data/sites.json.
 *
 * The whole file is read and rewritten so that `$comment`, the `domains`
 * shorthand and any hand-written entries survive — the settings UI must never
 * silently drop something the user typed by hand.
 */
export const appendSite = async (
  site: Site,
): Promise<{ ok: boolean; reason?: string }> => {
  const file = path.join(dataRoot(), 'sites.json');
  const existing = (await readJsonFile<Record<string, unknown>>(file)) ?? {};
  const entries = Array.isArray(existing.sites) ? [...existing.sites] : [];

  const clash = entries.some(
    (entry) => isRecord(entry) && entry.slug === site.slug,
  );
  if (clash) {
    return { ok: false, reason: `A site with slug "${site.slug}" already exists.` };
  }

  entries.push(compact(site));
  await writeJsonFile(file, { ...existing, sites: entries });
  return { ok: true };
};

/** Set a key, or remove it entirely when the value is empty. */
const setOrDelete = (
  entry: Record<string, unknown>,
  key: string,
  value: unknown,
) => {
  if (value === undefined) delete entry[key];
  else entry[key] = value;
};

export interface SiteEdit {
  name: string;
  url: string;
  description?: string;
  tags?: string[];
  cloudflareZoneId?: string;
  netlifySiteId?: string;
  /** False marks a site as not deployed on Netlify at all. */
  netlifyEnabled?: boolean;
  plausibleDomain?: string;
  plausibleBaseUrl?: string;
  plausibleKeyEnv?: string;
  githubRepo?: string;
  testPages: string[];
  interactivePages: string[];
}

/**
 * Update everything about a site except its slug.
 *
 * The slug is deliberately immutable: saved runs live in `data/runs/<slug>/` and
 * artifacts in `data/artifacts/<slug>/`, so renaming it would orphan a site's
 * entire history. Unknown keys on the entry are preserved, so anything added to
 * sites.json by hand survives a save from the UI.
 */
export const updateSite = async (
  slug: string,
  edit: SiteEdit,
): Promise<{ ok: boolean; reason?: string }> => {
  const file = path.join(dataRoot(), 'sites.json');
  const existing = (await readJsonFile<Record<string, unknown>>(file)) ?? {};
  const entries = Array.isArray(existing.sites) ? [...existing.sites] : [];

  const index = entries.findIndex(
    (entry) => isRecord(entry) && entry.slug === slug,
  );
  if (index < 0) {
    return {
      ok: false,
      reason: `"${slug}" is not an entry in the "sites" array — it probably came from the "domains" shorthand. Move it into "sites" to edit it.`,
    };
  }

  const entry = { ...(entries[index] as Record<string, unknown>) };

  entry.name = edit.name;
  entry.url = edit.url;
  setOrDelete(entry, 'description', edit.description);
  setOrDelete(
    entry,
    'tags',
    edit.tags && edit.tags.length > 0 ? edit.tags : undefined,
  );
  setOrDelete(
    entry,
    'cloudflare',
    edit.cloudflareZoneId ? { zoneId: edit.cloudflareZoneId } : undefined,
  );
  const netlify: Record<string, unknown> = {};
  if (edit.netlifySiteId) netlify.siteId = edit.netlifySiteId;
  if (edit.netlifyEnabled === false) netlify.enabled = false;
  setOrDelete(
    entry,
    'netlify',
    Object.keys(netlify).length > 0 ? netlify : undefined,
  );
  setOrDelete(
    entry,
    'github',
    edit.githubRepo ? { repo: edit.githubRepo } : undefined,
  );
  setOrDelete(
    entry,
    'plausible',
    edit.plausibleDomain
      ? (compact({
          domain: edit.plausibleDomain,
          baseUrl: edit.plausibleBaseUrl,
          keyEnv: edit.plausibleKeyEnv,
        }) as Record<string, unknown>)
      : undefined,
  );

  entry.testPages = edit.testPages.length > 0 ? edit.testPages : ['/'];
  setOrDelete(
    entry,
    'interactivePages',
    edit.interactivePages.length > 0 ? edit.interactivePages : undefined,
  );

  entries[index] = entry;
  await writeJsonFile(file, { ...existing, sites: entries });
  return { ok: true };
};

/**
 * Remove a site from the registry.
 *
 * Saved runs and captured artifacts are left on disk on purpose — deleting a
 * registry entry should not silently destroy history that may still be wanted.
 */
export const removeSite = async (
  slug: string,
): Promise<{ ok: boolean; reason?: string }> => {
  const file = path.join(dataRoot(), 'sites.json');
  const existing = (await readJsonFile<Record<string, unknown>>(file)) ?? {};
  const entries = Array.isArray(existing.sites) ? [...existing.sites] : [];

  const remaining = entries.filter(
    (entry) => !(isRecord(entry) && entry.slug === slug),
  );

  if (remaining.length === entries.length) {
    return { ok: false, reason: `"${slug}" is not in the "sites" array.` };
  }

  await writeJsonFile(file, { ...existing, sites: remaining });
  return { ok: true };
};

/**
 * Replace a site's test-page lists in place.
 *
 * Only entries in the `sites` array can be edited — a site that came from the
 * `domains` shorthand has no object to update, which is reported rather than
 * silently creating a duplicate.
 */
export const updateSitePages = async (
  slug: string,
  testPages: string[],
  interactivePages: string[],
): Promise<{ ok: boolean; reason?: string }> => {
  const file = path.join(dataRoot(), 'sites.json');
  const existing = (await readJsonFile<Record<string, unknown>>(file)) ?? {};
  const entries = Array.isArray(existing.sites) ? [...existing.sites] : [];

  const index = entries.findIndex(
    (entry) => isRecord(entry) && entry.slug === slug,
  );

  if (index < 0) {
    return {
      ok: false,
      reason: `"${slug}" is not an entry in the "sites" array — it probably came from the "domains" shorthand. Move it into "sites" to edit its pages.`,
    };
  }

  const entry = { ...(entries[index] as Record<string, unknown>) };
  entry.testPages = testPages.length > 0 ? testPages : ['/'];

  if (interactivePages.length > 0) {
    entry.interactivePages = interactivePages;
  } else {
    delete entry.interactivePages;
  }

  entries[index] = entry;
  await writeJsonFile(file, { ...existing, sites: entries });
  return { ok: true };
};

let registryCache: { mtimeMs: number; registry: Registry } | undefined;

/**
 * The registry is read several times per render — the shell, the page, and some
 * components each ask for it — so the parse is cached against the file's mtime.
 * Keying on mtime rather than a TTL means an edit saved through the UI is
 * visible on the very next request, with no staleness window.
 */
export const loadRegistry = async (): Promise<Registry> => {
  const file = path.join(dataRoot(), 'sites.json');

  let info: Stats | undefined;
  try {
    info = await stat(file);
  } catch {
    // No registry yet. There is nothing to parse and nothing to cache.
    return loadRegistryUncached();
  }

  if (registryCache && registryCache.mtimeMs === info.mtimeMs) {
    return registryCache.registry;
  }

  const registry = await loadRegistryUncached();
  registryCache = { mtimeMs: info.mtimeMs, registry };
  return registry;
};

export const findSite = async (slug: string): Promise<Site | undefined> => {
  const { sites } = await loadRegistry();
  return sites.find((site) => site.slug === slug);
};

/** Absolute URLs for a site's configured test paths. */
export const testPageUrls = (site: Site): string[] =>
  (site.testPages ?? ['/']).map((page) => new URL(page, `${site.url}/`).href);
