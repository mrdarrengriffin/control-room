import type { APIRoute } from 'astro';
import { clear } from '../../lib/debug';
import { messageOf } from '../../lib/types';

/**
 * Clear the debug log. POST plus redirect, like the other mutations, so it
 * works without client-side JavaScript and a refresh cannot re-submit it.
 */
export const POST: APIRoute = async ({ request }) => {
  try {
    const form = await request.formData();
    if (String(form.get('action') ?? '') !== 'clear') {
      return new Response('Unknown action', { status: 400 });
    }

    clear();

    return new Response(null, {
      status: 303,
      headers: { Location: '/debug?flash=ok&message=Debug+log+cleared.' },
    });
  } catch (error) {
    return new Response(null, {
      status: 303,
      headers: {
        Location: `/debug?flash=error&message=${encodeURIComponent(messageOf(error))}`,
      },
    });
  }
};
