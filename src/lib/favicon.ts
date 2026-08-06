import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { dataRoot } from './store';
import type { Site } from './types';

/**
 * Favicons, fetched and cached on this machine.
 *
 * Deliberately NOT using a third-party favicon service (Google's or
 * DuckDuckGo's): that would send the full list of sites being monitored to
 * someone else on every page load. For a dashboard whose whole premise is
 * local-first — and for an org running self-hosted analytics specifically to
 * avoid that — fetching them ourselves is the only consistent choice.
 */

const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_BYTES = 512 * 1024;
const FETCH_TIMEOUT_MS = 8_000;

const cacheDir = () => path.join(dataRoot(), 'favicons');

interface CacheMeta {
  contentType: string;
  fetchedAt: number;
}

export interface Favicon {
  body: Buffer;
  contentType: string;
}

const dataFile = (slug: string) => path.join(cacheDir(), `${slug}.bin`);
const metaFile = (slug: string) => path.join(cacheDir(), `${slug}.json`);

const readCache = async (slug: string): Promise<Favicon | undefined> => {
  try {
    const raw = await readFile(metaFile(slug), 'utf8');
    const meta = JSON.parse(raw) as CacheMeta;
    if (Date.now() - meta.fetchedAt > CACHE_TTL_MS) return undefined;
    return { body: await readFile(dataFile(slug)), contentType: meta.contentType };
  } catch {
    return undefined;
  }
};

const writeCache = async (slug: string, icon: Favicon): Promise<void> => {
  try {
    await mkdir(cacheDir(), { recursive: true });
    await writeFile(dataFile(slug), icon.body);
    const meta: CacheMeta = {
      contentType: icon.contentType,
      fetchedAt: Date.now(),
    };
    await writeFile(metaFile(slug), JSON.stringify(meta));
  } catch {
    // A cache write failure must not stop the icon being served this time.
  }
};

const fetchImage = async (url: string): Promise<Favicon | undefined> => {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      redirect: 'follow',
    });
    if (!response.ok) return undefined;

    const contentType = (response.headers.get('content-type') ?? '').split(';')[0].trim();
    // Some servers answer a missing icon with an HTML error page and a 200.
    if (!contentType.startsWith('image/')) return undefined;

    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength === 0 || buffer.byteLength > MAX_BYTES) return undefined;

    return { body: buffer, contentType };
  } catch {
    return undefined;
  }
};

interface IconCandidate {
  href: string;
  score: number;
}

/**
 * Pull icon links out of the page head. A regex is enough here — the goal is to
 * find href values on <link rel="...icon...">, not to understand the document.
 */
const iconsFromHtml = (html: string, baseUrl: string): string[] => {
  const candidates: IconCandidate[] = [];

  for (const tag of html.matchAll(/<link\s[^>]*>/gi)) {
    const element = tag[0];

    const rel = /rel\s*=\s*["']?([^"'>]+)/i.exec(element)?.[1]?.toLowerCase();
    if (!rel || !rel.includes('icon')) continue;

    const href = /href\s*=\s*["']([^"']+)/i.exec(element)?.[1];
    if (!href) continue;

    const sizes = /sizes\s*=\s*["']?(\d+)/i.exec(element)?.[1];
    const pixels = sizes ? Number.parseInt(sizes, 10) : 0;

    // Prefer scalable, then reasonably large, then anything. apple-touch-icon is
    // usually a clean high-resolution square, which suits a sidebar well.
    let score = 0;
    if (/\.svg(\?|$)/i.test(href)) score += 100;
    if (rel.includes('apple-touch')) score += 40;
    if (pixels >= 180) score += 35;
    else if (pixels >= 64) score += 25;
    else if (pixels >= 32) score += 15;
    if (/\.png(\?|$)/i.test(href)) score += 10;

    try {
      candidates.push({ href: new URL(href, baseUrl).href, score });
    } catch {
      // Unresolvable href; skip.
    }
  }

  return candidates
    .sort((a, b) => b.score - a.score)
    .map((candidate) => candidate.href);
};

/** A neutral lettered square, so a missing icon never shows as a broken image. */
export const fallbackIcon = (name: string): Favicon => {
  const letter = (name.trim()[0] ?? '?').toUpperCase();
  const safe = letter.replace(/[<>&"']/g, '');

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" role="img"><rect width="32" height="32" rx="7" fill="#c9c8c0"/><text x="16" y="22" font-family="system-ui,-apple-system,sans-serif" font-size="17" font-weight="600" text-anchor="middle" fill="#3a3a37">${safe}</text></svg>`;

  return { body: Buffer.from(svg, 'utf8'), contentType: 'image/svg+xml' };
};

/**
 * The site's favicon, from cache when fresh. Falls back to a lettered square, so
 * callers always get something renderable.
 */
export const faviconFor = async (site: Site): Promise<Favicon> => {
  const cached = await readCache(site.slug);
  if (cached) return cached;

  let origin: string;
  try {
    origin = new URL(site.url).origin;
  } catch {
    return fallbackIcon(site.name);
  }

  const urls: string[] = [];

  // Ask the page what its icon is before guessing at /favicon.ico.
  try {
    const response = await fetch(site.url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      redirect: 'follow',
      headers: { Accept: 'text/html' },
    });
    if (response.ok) {
      const html = (await response.text()).slice(0, 200_000);
      urls.push(...iconsFromHtml(html, response.url || site.url));
    }
  } catch {
    // Site unreachable; the /favicon.ico guess below may still work.
  }

  urls.push(new URL('/favicon.ico', origin).href);

  for (const url of urls.slice(0, 5)) {
    const icon = await fetchImage(url);
    if (icon) {
      await writeCache(site.slug, icon);
      return icon;
    }
  }

  const fallback = fallbackIcon(site.name);
  // Cache the fallback too, so an unreachable site isn't refetched every load.
  await writeCache(site.slug, fallback);
  return fallback;
};
