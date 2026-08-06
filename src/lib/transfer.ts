import { siteFromDomain } from './sites';
import type { Site } from './types';

/**
 * Moving a site list between installs — as a plain list of domains, nothing
 * more.
 *
 * An earlier version exported the whole registry: zone ids, Netlify site ids,
 * repositories, the name of the env var holding a second Plausible key. None of
 * that is any use to someone with their own accounts, and a list of what you
 * run and where you run it is not something to put on a clipboard by default.
 * The receiving install rediscovers its own identifiers.
 */

export interface ParsedImport {
  sites: Site[];
  problems: string[];
}

/** Split on newlines or commas, dropping blanks and # comments. */
const listItems = (text: string): string[] =>
  text
    .split(/[\r\n,]+/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));

/**
 * The export: one domain per line.
 *
 * Sorted, because the natural registry order is whatever things were added in,
 * and a diffable list is easier to eyeball against another install.
 */
export const exportDomains = (sites: Site[]): string => {
  const domains = sites.map((site) => {
    if (site.plausible?.domain) return site.plausible.domain;
    try {
      return new URL(site.url).hostname;
    } catch {
      return site.slug;
    }
  });
  return `${[...new Set(domains)].sort().join('\n')}\n`;
};

/**
 * Read a pasted list. Only domains — a leading `{` is far more likely to be
 * someone pasting the wrong thing than a format worth supporting, so say so
 * instead of half-parsing it.
 */
export const parseImport = (raw: string): ParsedImport => {
  const text = raw.trim();
  if (text === '') return { sites: [], problems: [] };

  if (text.startsWith('{') || text.startsWith('[')) {
    return {
      sites: [],
      problems: [
        'That looks like JSON. This takes a plain list of domains, one per line.',
      ],
    };
  }

  const problems: string[] = [];
  const sites: Site[] = [];

  for (const item of listItems(text)) {
    // siteFromDomain tolerates a full URL and reduces it to the hostname.
    const site = siteFromDomain(item, problems);
    if (site) sites.push(site);
  }

  return { sites, problems };
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
