import { readJsonFile, writeJsonFile } from './store';
import { dataRoot } from './store';
import path from 'node:path';
import type { Site } from './types';

/**
 * Site document titles, for labelling the navigation consistently.
 *
 * Cached to disk rather than memory because the sidebar renders on every page:
 * an in-memory cache would re-fetch every site's HTML after each restart, and
 * titles change about as often as the site is redesigned.
 */

const TTL_MS = 7 * 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8_000;
const MAX_TITLE_LENGTH = 42;

interface MetaEntry {
  title?: string;
  fetchedAt: number;
}

type MetaFile = Record<string, MetaEntry>;

const metaFile = () => path.join(dataRoot(), 'site-meta.json');

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': ' ',
};

const decode = (value: string): string =>
  value
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&[a-z]+;|&#39;/gi, (entity) => ENTITIES[entity.toLowerCase()] ?? entity);

/**
 * Drop the tagline from a page title.
 *
 * Real titles measured on these sites are mostly "Name: marketing sentence" —
 * "BTHome: Open standard for broadcasting sensor data over Bluetooth" — which is
 * useless in a narrow sidebar. Splitting on the first colon, pipe or dash-type
 * separator recovers the name.
 *
 * A plain hyphen is deliberately NOT a separator: it appears inside real names,
 * and on one site here the title is "Sign In - OHF Employee Handbook" (the
 * handbook sits behind auth), where splitting would leave the useless "Sign In".
 */
const trimTagline = (title: string): string => {
  const cut = title.search(/\s*[:|–—]\s*/);
  if (cut <= 1) return title;

  const head = title.slice(0, cut).trim();
  return head.length >= 2 ? head : title;
};

const extractTitle = (html: string): string | undefined => {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (!match) return undefined;

  const raw = decode(match[1]).replace(/\s+/g, ' ').trim();
  if (raw === '') return undefined;

  const title = trimTagline(raw);

  return title.length > MAX_TITLE_LENGTH
    ? `${title.slice(0, MAX_TITLE_LENGTH - 1).trimEnd()}…`
    : title;
};

const fetchTitle = async (site: Site): Promise<string | undefined> => {
  try {
    const response = await fetch(site.url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      redirect: 'follow',
      headers: { Accept: 'text/html' },
    });
    if (!response.ok) return undefined;
    // The title is in the head; no need to read a whole documentation page.
    return extractTitle((await response.text()).slice(0, 100_000));
  } catch {
    return undefined;
  }
};

/**
 * Titles for every site, keyed by slug. Missing entries simply mean the title
 * could not be read, and callers fall back to the configured name.
 */
export const titlesFor = async (sites: Site[]): Promise<Map<string, string>> => {
  const file = metaFile();
  const stored = (await readJsonFile<MetaFile>(file)) ?? {};
  const now = Date.now();

  const stale = sites.filter((site) => {
    const entry = stored[site.slug];
    return !entry || now - entry.fetchedAt > TTL_MS;
  });

  if (stale.length > 0) {
    const fetched = await Promise.all(
      stale.map(async (site) => ({
        slug: site.slug,
        title: await fetchTitle(site),
      })),
    );

    for (const { slug, title } of fetched) {
      // Record the attempt either way, so an unreachable site isn't retried on
      // every single page load.
      stored[slug] = { title, fetchedAt: now };
    }

    // One write after all fetches: doing it per site would race under Promise.all.
    await writeJsonFile(file, stored).catch(() => undefined);
  }

  const titles = new Map<string, string>();
  for (const site of sites) {
    const title = stored[site.slug]?.title;
    if (title) titles.set(site.slug, title);
  }

  return titles;
};

export type SiteLabelMode = 'title' | 'domain';

/** Bare hostname, used for the 'domain' labelling mode. */
export const domainOf = (site: Site): string => {
  try {
    return new URL(site.url).hostname.replace(/^www\./, '');
  } catch {
    return site.name;
  }
};
