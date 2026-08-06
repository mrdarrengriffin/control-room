import { defineMiddleware } from 'astro:middleware';
import { isAuthenticated, isConfigured } from './lib/auth';

/**
 * Gate on every request.
 *
 * Until now the security model was "it only listens on 127.0.0.1". Once this is
 * reachable from the network that is not enough — the app shells out to gh,
 * drives a browser, and has a one-click cache purge, so an unauthenticated
 * visitor could do real damage.
 */

/** Reachable without a session, for obvious reasons. */
const OPEN_PATHS = new Set([
  '/login',
  '/setup',
  '/api/auth',
  '/api/health',
  '/favicon.svg',
  '/favicon.ico',
]);

export const onRequest = defineMiddleware(async (context, next) => {
  const { pathname } = context.url;

  if (OPEN_PATHS.has(pathname)) return next();

  // No password set yet: everything funnels into first-run setup.
  if (!isConfigured()) {
    return context.redirect('/setup', 303);
  }

  if (isAuthenticated(context.request)) return next();

  /*
   * API routes get a 401 rather than a redirect. A redirect would hand back the
   * login page's HTML with a 200, which the auto-refresh would cheerfully splice
   * into the page instead of noticing it had been logged out.
   */
  if (pathname.startsWith('/api/')) {
    return new Response('Unauthorised', {
      status: 401,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }

  const next_ = `${context.url.pathname}${context.url.search}`;
  return context.redirect(
    `/login?next=${encodeURIComponent(next_)}`,
    303,
  );
});
