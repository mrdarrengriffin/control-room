import { parseSite, siteFromDomain } from './sites';
import type { Site } from './types';

/**
 * Moving a site list between installs.
 *
 * Two shapes are accepted on the way in, because two are genuinely useful: the
 * JSON this exports (which carries zone ids, repos and test pages), and a plain
 * list of domains typed or pasted from somewhere else. Requiring JSON for the
 * second case would be busywork.
 *
 * Nothing here touches credentials. A site list names infrastructure; tokens
 * live in data/secrets.json and are never part of an export.
 */

export interface ParsedImport {
  sites: Site[];
  problems: string[];
  /** How the input was read, so the UI can say what it understood. */
  format: 'json' | 'domains' | 'empty';
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Strip a site down to what is worth carrying to another install.
 *
 * Deliberately omits nothing except undefined keys: a colleague importing this
 * should get the same dashboard, integration ids included. Those ids are not
 * secrets — they identify resources, they do not grant access to them.
 */
const forExport = (site: Site): Record<string, unknown> => {
  const out: Record<string, unknown> = {
    slug: site.slug,
    name: site.name,
    url: site.url,
  };

  if (site.description) out.description = site.description;
  if (site.tags?.length) out.tags = site.tags;
  if (site.cloudflare?.zoneId) out.cloudflare = { zoneId: site.cloudflare.zoneId };

  if (site.netlify) {
    const netlify: Record<string, unknown> = {};
    if (site.netlify.siteId) netlify.siteId = site.netlify.siteId;
    if (site.netlify.enabled === false) netlify.enabled = false;
    if (Object.keys(netlify).length > 0) out.netlify = netlify;
  }

  if (site.plausible?.domain) {
    const plausible: Record<string, unknown> = { domain: site.plausible.domain };
    if (site.plausible.baseUrl) plausible.baseUrl = site.plausible.baseUrl;
    // The name of the variable, never its value.
    if (site.plausible.keyEnv) plausible.keyEnv = site.plausible.keyEnv;
    out.plausible = plausible;
  }

  if (site.github?.repo) out.github = { repo: site.github.repo };

  // '/' is the default, so carrying it adds noise to every entry.
  const pages = site.testPages ?? [];
  if (pages.length > 0 && !(pages.length === 1 && pages[0] === '/')) {
    out.testPages = pages;
  }
  if (site.interactivePages?.length) {
    out.interactivePages = site.interactivePages;
  }

  return out;
};

/**
 * The full export: valid `data/sites.json`, so it can be pasted into a file as
 * well as into the import box.
 */
export const exportJson = (sites: Site[]): string =>
  `${JSON.stringify({ sites: sites.map(forExport) }, null, 2)}\n`;

/** Just the domains, for when the other install should discover its own ids. */
export const exportDomains = (sites: Site[]): string =>
  `${sites
    .map((site) => site.plausible?.domain ?? new URL(site.url).hostname)
    .join('\n')}\n`;

/** Split a pasted list on newlines or commas, dropping blanks and comments. */
const listItems = (text: string): string[] =>
  text
    .split(/[\r\n,]+/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));

export const parseImport = (raw: string): ParsedImport => {
  const text = raw.trim();
  if (text === '') return { sites: [], problems: [], format: 'empty' };

  const problems: string[] = [];

  // JSON if it looks like JSON. Anything else is treated as a domain list,
  // which means a stray brace produces a parse error rather than a pile of
  // "does not look like a domain".
  if (text.startsWith('{') || text.startsWith('[')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      return {
        sites: [],
        problems: [`That is not valid JSON: ${(error as Error).message}`],
        format: 'json',
      };
    }

    const entries: unknown[] = Array.isArray(parsed)
      ? parsed
      : isRecord(parsed) && Array.isArray(parsed.sites)
        ? parsed.sites
        : [];

    const domains: unknown[] =
      isRecord(parsed) && Array.isArray(parsed.domains) ? parsed.domains : [];

    if (entries.length === 0 && domains.length === 0) {
      return {
        sites: [],
        problems: [
          'No sites found. Expected an array of sites, or an object with a "sites" array or "domains" list.',
        ],
        format: 'json',
      };
    }

    const sites: Site[] = [];
    entries.forEach((entry, index) => {
      const site = parseSite(entry, index, problems);
      if (site) sites.push(site);
    });
    domains.forEach((domain) => {
      const site = siteFromDomain(domain, problems);
      if (site) sites.push(site);
    });

    return { sites, problems, format: 'json' };
  }

  const sites: Site[] = [];
  for (const item of listItems(text)) {
    const site = siteFromDomain(item, problems);
    if (site) sites.push(site);
  }

  return { sites, problems, format: 'domains' };
};

/**
 * Last one wins on a repeated slug within a single paste, and it is reported.
 * Silently keeping the first would hide a real mistake in the input.
 */
export const dedupe = (
  sites: Site[],
): { sites: Site[]; duplicates: string[] } => {
  const bySlug = new Map<string, Site>();
  const duplicates: string[] = [];

  for (const site of sites) {
    if (bySlug.has(site.slug)) duplicates.push(site.slug);
    bySlug.set(site.slug, site);
  }

  return { sites: [...bySlug.values()], duplicates };
};
