import type { APIRoute } from 'astro';
import { startRun } from '../../../lib/runner';
import { findSite } from '../../../lib/sites';
import { isViewportKey, resolvePages } from '../../../lib/tests/browser';
import type { ViewportKey } from '../../../lib/tests/browser';
import { runCapture, runVideo } from '../../../lib/tests/capture';
import { runInteraction } from '../../../lib/tests/interaction';
import { isCategory, runAudit } from '../../../lib/tests/lighthouse';
import type { Category, FormFactor } from '../../../lib/tests/lighthouse';
import { messageOf } from '../../../lib/types';
import type { Site } from '../../../lib/types';

/**
 * Start a browser test. Like the purge endpoint this is a form POST followed by
 * a redirect, so it works without client-side JavaScript.
 *
 * It returns as soon as the run is registered — a Lighthouse pass or a video
 * capture takes far longer than any reasonable request timeout. Progress then
 * arrives over the WebSocket, keyed by the run id handed back in the redirect.
 */

const back = (
  slug: string,
  status: 'ok' | 'error',
  message: string,
  runId?: string,
): Response => {
  const target = slug ? `/sites/${encodeURIComponent(slug)}` : '/';
  const params = new URLSearchParams({ flash: status, message });
  if (runId) params.set('watch', runId);
  return new Response(null, {
    status: 303,
    headers: { Location: `${target}?${params.toString()}#tests` },
  });
};

/**
 * Which pages a run covers. 'all' is the site's configured testPages and
 * 'interactive' is its interactivePages; anything else is treated as a single
 * path relative to the site root.
 */
const pagesFor = (site: Site, selection: string): string[] => {
  if (selection === 'all') {
    return resolvePages(site.url, site.testPages ?? ['/']);
  }
  if (selection === 'interactive') {
    const pages = site.interactivePages ?? site.testPages ?? ['/'];
    return resolvePages(site.url, pages);
  }
  return resolvePages(site.url, [selection]);
};

const viewportsFrom = (values: string[]): ViewportKey[] => {
  const keys = values.filter(isViewportKey);
  return keys.length > 0 ? keys : ['desktop'];
};

export const POST: APIRoute = async ({ request }) => {
  let slug = '';

  try {
    const form = await request.formData();
    slug = String(form.get('slug') ?? '').trim();
    const kind = String(form.get('kind') ?? '').trim();
    const selection = String(form.get('pages') ?? 'all').trim();
    const watch = form.get('watch') !== null;

    const site = await findSite(slug);
    if (!site) return back('', 'error', `Unknown site "${slug}"`);

    const urls = pagesFor(site, selection);
    if (urls.length === 0) {
      return back(slug, 'error', 'No pages configured to test.');
    }

    if (kind === 'audit') {
      const categories = form
        .getAll('categories')
        .map(String)
        .filter(isCategory) as Category[];

      if (categories.length === 0) {
        return back(slug, 'error', 'Pick at least one Lighthouse category.');
      }

      const formFactor: FormFactor =
        String(form.get('formFactor') ?? 'desktop') === 'mobile'
          ? 'mobile'
          : 'desktop';

      const label = `Lighthouse ${formFactor} · ${categories.length} categor${categories.length === 1 ? 'y' : 'ies'} · ${urls.length} page${urls.length === 1 ? '' : 's'}`;

      const run = await startRun(site, 'audit', label, watch, (r, reporter) =>
        runAudit(
          { site, runId: r.id, urls, categories, formFactor },
          reporter,
        ),
      );

      return back(slug, 'ok', `Started: ${label}`, run.id);
    }

    if (kind === 'capture') {
      const viewports = viewportsFrom(form.getAll('viewports').map(String));
      const label = `Screenshots · ${viewports.join(' + ')} · ${urls.length} page${urls.length === 1 ? '' : 's'}`;

      const run = await startRun(site, 'capture', label, watch, (r, reporter) =>
        runCapture({ site, runId: r.id, urls, viewports }, reporter),
      );

      return back(slug, 'ok', `Started: ${label}`, run.id);
    }

    if (kind === 'video') {
      const viewports = viewportsFrom(form.getAll('viewports').map(String));
      const viewport = viewports[0];
      // One page per video: a scroll-through of several pages in one file would
      // be unreviewable.
      const url = urls[0];
      const label = `Scroll video · ${viewport} · ${new URL(url).pathname}`;

      const run = await startRun(site, 'capture', label, watch, (r, reporter) =>
        runVideo({ site, runId: r.id, url, viewport }, reporter),
      );

      return back(slug, 'ok', `Started: ${label}`, run.id);
    }

    if (kind === 'interaction') {
      const viewports = viewportsFrom(form.getAll('viewports').map(String));
      const label = `Scroll performance · ${viewports[0]} · ${urls.length} page${urls.length === 1 ? '' : 's'}`;

      const run = await startRun(
        site,
        'interaction',
        label,
        watch,
        (_run, reporter) =>
          runInteraction({ site, urls, viewport: viewports[0] }, reporter),
      );

      return back(slug, 'ok', `Started: ${label}`, run.id);
    }

    return back(slug, 'error', `Unknown test kind "${kind}".`);
  } catch (error) {
    return back(slug, 'error', messageOf(error));
  }
};
