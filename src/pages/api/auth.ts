import type { APIRoute } from 'astro';
import {
  COOKIE_NAME,
  SESSION_MAX_AGE_MS,
  checkPassword,
  isConfigured,
  newSessionCookie,
  setPassword,
} from '../../lib/auth';
import { messageOf } from '../../lib/types';

/** Minimum that isn't actively negligent for something holding API tokens. */
const MIN_PASSWORD_LENGTH = 10;

const redirect = (location: string): Response =>
  new Response(null, { status: 303, headers: { Location: location } });

const backTo = (page: string, message: string, next?: string): Response => {
  const params = new URLSearchParams({ error: message });
  if (next) params.set('next', next);
  return redirect(`${page}?${params.toString()}`);
};

/** Only sensible destinations, so ?next= can't be turned into an open redirect. */
const safeNext = (value: string | null): string =>
  value && value.startsWith('/') && !value.startsWith('//') ? value : '/';

export const POST: APIRoute = async ({ request, cookies, url }) => {
  try {
    const form = await request.formData();
    const action = String(form.get('action') ?? '');
    const next = safeNext(String(form.get('next') ?? '') || null);

    const setSession = () => {
      cookies.set(COOKIE_NAME, newSessionCookie(), {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        maxAge: Math.floor(SESSION_MAX_AGE_MS / 1000),
        // Only meaningful behind TLS; harmless to omit on a plain-HTTP LAN.
        secure: url.protocol === 'https:',
      });
    };

    if (action === 'logout') {
      cookies.delete(COOKIE_NAME, { path: '/' });
      return redirect('/login');
    }

    if (action === 'setup') {
      // Guard against a second setup being posted once a password exists.
      if (isConfigured()) return backTo('/login', 'A password is already set.');

      const password = String(form.get('password') ?? '');
      const confirm = String(form.get('confirm') ?? '');

      if (password.length < MIN_PASSWORD_LENGTH) {
        return backTo(
          '/setup',
          `Use at least ${MIN_PASSWORD_LENGTH} characters.`,
        );
      }
      if (password !== confirm) {
        return backTo('/setup', 'The two passwords did not match.');
      }

      await setPassword(password);
      setSession();
      return redirect('/');
    }

    if (action === 'login') {
      if (!isConfigured()) return redirect('/setup');

      const password = String(form.get('password') ?? '');
      if (!(await checkPassword(password))) {
        return backTo('/login', 'Incorrect password.', next);
      }

      setSession();
      return redirect(next);
    }

    return backTo('/login', 'Unknown action.');
  } catch (error) {
    return backTo('/login', messageOf(error));
  }
};
