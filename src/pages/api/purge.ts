import type { APIRoute } from 'astro';
import { purgeCache } from '../../lib/providers/cloudflare';
import { findSite } from '../../lib/sites';
import { messageOf } from '../../lib/types';

/**
 * Cache purge, as a plain form POST followed by a redirect.
 *
 * Deliberately not fetch-driven: a form submission works with no client-side
 * JavaScript, and the redirect means a refresh can't silently re-fire a purge.
 */

const back = (
  slug: string,
  status: 'ok' | 'error',
  message: string,
): Response => {
  const target = slug ? `/sites/${encodeURIComponent(slug)}` : '/';
  return new Response(null, {
    status: 303,
    headers: {
      Location: `${target}?flash=${status}&message=${encodeURIComponent(message)}`,
    },
  });
};

export const POST: APIRoute = async ({ request }) => {
  let slug = '';

  try {
    const form = await request.formData();
    slug = String(form.get('slug') ?? '').trim();
    const mode = String(form.get('mode') ?? '').trim();

    const site = await findSite(slug);
    if (!site) {
      return back('', 'error', `Unknown site "${slug}"`);
    }

    if (mode === 'everything') {
      const result = await purgeCache(site, { mode: 'everything' });
      return result.status === 'ok'
        ? back(slug, 'ok', `Purged the entire cache for ${site.name}.`)
        : back(slug, 'error', result.reason);
    }

    if (mode === 'files') {
      const raw = String(form.get('urls') ?? '');
      const entries = raw
        .split(/[\s,]+/)
        .map((entry) => entry.trim())
        .filter(Boolean);

      if (entries.length === 0) {
        return back(slug, 'error', 'Give at least one URL or path to purge.');
      }

      // Accept bare paths as well as absolute URLs, resolved against the site.
      const urls: string[] = [];
      for (const entry of entries) {
        try {
          urls.push(new URL(entry, `${site.url}/`).href);
        } catch {
          return back(slug, 'error', `"${entry}" is not a valid URL or path.`);
        }
      }

      const result = await purgeCache(site, { mode: 'files', urls });
      return result.status === 'ok'
        ? back(
            slug,
            'ok',
            `Purged ${urls.length} URL${urls.length === 1 ? '' : 's'} for ${site.name}.`,
          )
        : back(slug, 'error', result.reason);
    }

    return back(slug, 'error', `Unknown purge mode "${mode}".`);
  } catch (error) {
    return back(slug, 'error', messageOf(error));
  }
};
