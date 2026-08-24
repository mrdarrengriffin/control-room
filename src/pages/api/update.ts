import type { APIRoute } from 'astro';
import { triggerUpdate } from '../../lib/update';
import { messageOf } from '../../lib/types';

/**
 * Hand "update now" to the updater sidecar, as a plain form POST followed by a
 * redirect — same shape as the purge endpoint, and for the same reasons: it
 * works with no client-side JavaScript, and a refresh can't re-fire it.
 *
 * Auth comes from the middleware like every other API route; the sidecar's own
 * token never reaches the page.
 */
const back = (
  status: 'ok' | 'error',
  message: string,
  updating = false,
): Response =>
  new Response(null, {
    status: 303,
    headers: {
      Location: `/settings?flash=${status}&message=${encodeURIComponent(message)}${
        updating ? '&updating=1' : ''
      }#updates`,
    },
  });

export const POST: APIRoute = async () => {
  try {
    const result = await triggerUpdate();
    return result.status === 'ok'
      ? back('ok', result.data, true)
      : back('error', result.reason);
  } catch (error) {
    return back('error', messageOf(error));
  }
};
