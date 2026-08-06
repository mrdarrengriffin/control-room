import type { APIRoute } from 'astro';
import { invalidateAll } from '../../lib/cache';
import { clearSecret, isKnownKey, setSecret } from '../../lib/secrets';
import { messageOf } from '../../lib/types';

/**
 * Save or clear a configuration value. Form POST plus redirect, like the other
 * mutations, so it works without client-side JavaScript and a refresh cannot
 * silently re-submit.
 *
 * Values are only ever written, never read back into the page — see the settings
 * page, which reports length and source but not content.
 */

const back = (status: 'ok' | 'error', message: string): Response =>
  new Response(null, {
    status: 303,
    headers: {
      Location: `/settings?flash=${status}&message=${encodeURIComponent(message)}`,
    },
  });

export const POST: APIRoute = async ({ request }) => {
  try {
    const form = await request.formData();
    const action = String(form.get('action') ?? 'save');
    const key = String(form.get('key') ?? '').trim();

    if (!isKnownKey(key)) {
      return back('error', `Unknown setting "${key}".`);
    }

    if (action === 'clear') {
      await clearSecret(key);
      // Otherwise a cached auth failure would outlive the change by a minute.
      invalidateAll();
      return back('ok', `Cleared ${key} from settings.`);
    }

    const value = String(form.get('value') ?? '').trim();
    if (value === '') {
      return back(
        'error',
        `No value given for ${key}. Use Clear to remove it instead.`,
      );
    }

    await setSecret(key, value);
    invalidateAll();
    return back('ok', `Saved ${key}.`);
  } catch (error) {
    return back('error', messageOf(error));
  }
};
