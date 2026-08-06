import type { APIRoute } from 'astro';
import { updateSitePages } from '../../../lib/sites';
import { messageOf } from '../../../lib/types';

/**
 * Save a site's test-page lists. Form POST plus redirect, like every other
 * mutation here, so it works without client-side JavaScript.
 */

const back = (slug: string, status: 'ok' | 'error', message: string): Response =>
  new Response(null, {
    status: 303,
    headers: {
      Location: `/sites/${encodeURIComponent(slug)}?flash=${status}&message=${encodeURIComponent(message)}#pages`,
    },
  });

/**
 * Normalise a textarea into paths. Accepts full URLs as well as paths, because
 * pasting from a browser address bar is the obvious thing to do.
 */
const parsePaths = (raw: string): string[] => {
  const seen = new Set<string>();

  for (const line of raw.split(/[\r\n,]+/)) {
    let value = line.trim();
    if (value === '') continue;

    if (/^https?:\/\//i.test(value)) {
      try {
        value = new URL(value).pathname;
      } catch {
        continue;
      }
    }

    if (!value.startsWith('/')) value = `/${value}`;
    seen.add(value);
  }

  return [...seen];
};

export const POST: APIRoute = async ({ request }) => {
  let slug = '';

  try {
    const form = await request.formData();
    slug = String(form.get('slug') ?? '').trim();
    if (slug === '') return back('', 'error', 'Missing site.');

    const testPages = parsePaths(String(form.get('testPages') ?? ''));
    const interactivePages = parsePaths(
      String(form.get('interactivePages') ?? ''),
    );

    const result = await updateSitePages(slug, testPages, interactivePages);
    if (!result.ok) {
      return back(slug, 'error', result.reason ?? 'Could not save pages.');
    }

    const interactiveNote =
      interactivePages.length > 0
        ? `, ${interactivePages.length} interactive`
        : '';

    return back(
      slug,
      'ok',
      `Saved ${testPages.length} test page${testPages.length === 1 ? '' : 's'}${interactiveNote}.`,
    );
  } catch (error) {
    return back(slug, 'error', messageOf(error));
  }
};
