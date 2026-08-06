import type { APIRoute } from 'astro';
import { fallbackIcon, faviconFor } from '../../../lib/favicon';
import { findSite } from '../../../lib/sites';

/**
 * Serve a site's favicon from the local cache, fetching it once if needed.
 *
 * Always returns an image — a lettered square when the real icon can't be had —
 * so the sidebar never shows a broken-image placeholder.
 */
export const GET: APIRoute = async ({ params }) => {
  const slug = params.slug ?? '';
  const site = await findSite(slug);

  const icon = site ? await faviconFor(site) : fallbackIcon(slug || '?');

  return new Response(new Uint8Array(icon.body), {
    headers: {
      'Content-Type': icon.contentType,
      // Short browser cache; the durable cache is on disk with its own TTL.
      'Cache-Control': 'private, max-age=3600',
    },
  });
};
