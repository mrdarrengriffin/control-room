import { failed, ok } from './types';
import type { PanelResult } from './types';

/**
 * Read a site's sitemap to suggest test pages.
 *
 * Parsed with a regex rather than an XML library on purpose: all that is needed
 * is the <loc> values, and pulling in an XML parser for that would be a
 * dependency to maintain and audit for no real gain.
 */

const LOC = /<loc>\s*([^<\s]+)\s*<\/loc>/gi;

const CANDIDATE_PATHS = ['/sitemap.xml', '/sitemap_index.xml', '/sitemap-index.xml'];

/** Cap the work: a large docs site can have tens of thousands of URLs. */
const MAX_CHILD_SITEMAPS = 5;
const MAX_PATHS = 300;

export interface SitemapPages {
  paths: string[];
  /** How many URLs the sitemap actually held, before the cap. */
  total: number;
  truncated: boolean;
  source: string;
}

const fetchText = async (url: string): Promise<string | undefined> => {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(15_000),
      headers: { Accept: 'application/xml, text/xml, */*' },
    });
    if (!response.ok) return undefined;
    return await response.text();
  } catch {
    return undefined;
  }
};

/**
 * Compare hosts ignoring `www.`.
 *
 * Without this the filter silently discards everything: home-assistant.io
 * redirects to www.home-assistant.io, so every <loc> in its sitemap carries the
 * www host while the configured url does not, and a strict comparison drops all
 * of them while reporting a perfectly valid sitemap as empty.
 */
const sameSite = (a: string, b: string): boolean =>
  a.replace(/^www\./i, '').toLowerCase() === b.replace(/^www\./i, '').toLowerCase();

const locsIn = (xml: string): string[] => {
  const found: string[] = [];
  for (const match of xml.matchAll(LOC)) {
    const value = match[1]?.trim();
    if (value) found.push(value);
  }
  return found;
};

export const loadSitemapPages = async (
  siteUrl: string,
): Promise<PanelResult<SitemapPages>> => {
  let host: string;
  try {
    host = new URL(siteUrl).host;
  } catch {
    return failed(`"${siteUrl}" is not a valid URL`);
  }

  let xml: string | undefined;
  let source = '';

  for (const candidate of CANDIDATE_PATHS) {
    const url = new URL(candidate, `${siteUrl}/`).href;
    xml = await fetchText(url);
    if (xml) {
      source = url;
      break;
    }
  }

  if (!xml) {
    return failed(
      `No sitemap found at ${CANDIDATE_PATHS.join(', ')} on ${host}`,
    );
  }

  let urls = locsIn(xml);

  // A sitemap index points at more sitemaps rather than listing pages.
  if (/<sitemapindex/i.test(xml)) {
    const children = urls.slice(0, MAX_CHILD_SITEMAPS);
    const collected: string[] = [];
    for (const child of children) {
      const childXml = await fetchText(child);
      if (childXml) collected.push(...locsIn(childXml));
    }
    urls = collected;
    source = `${source} (index, ${children.length} child sitemap(s))`;
  }

  const paths = new Set<string>();
  for (const raw of urls) {
    try {
      const parsed = new URL(raw);
      // Ignore anything pointing at a genuinely different site — sitemaps
      // sometimes do — but treat www and bare as the same site.
      if (!sameSite(parsed.host, host)) continue;
      paths.add(parsed.pathname);
    } catch {
      // Not a URL; skip rather than fail the whole import.
    }
  }

  const sorted = [...paths].sort((a, b) => {
    // Shallow pages first — they are the ones worth auditing by default.
    const depth = a.split('/').length - b.split('/').length;
    return depth !== 0 ? depth : a.localeCompare(b);
  });

  if (sorted.length === 0) {
    return failed(`Sitemap at ${source} contained no URLs for ${host}`);
  }

  return ok({
    paths: sorted.slice(0, MAX_PATHS),
    total: sorted.length,
    truncated: sorted.length > MAX_PATHS,
    source,
  });
};
