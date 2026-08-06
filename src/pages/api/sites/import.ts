import type { APIRoute } from 'astro';
import { appendSites } from '../../../lib/sites';
import { dedupe, parseImport } from '../../../lib/transfer';
import { messageOf } from '../../../lib/types';

/**
 * Bulk add. Accepts the JSON this app exports or a plain list of domains.
 *
 * Adding sites is cheap and reversible — a site can be removed from its own
 * page — so this commits in one step and reports precisely what it did, rather
 * than making you walk a preview wizard for the common case of pasting a list
 * you already trust.
 */

const back = (status: 'ok' | 'error', message: string) =>
  new Response(null, {
    status: 303,
    headers: {
      Location: `/sites/import?flash=${status}&message=${encodeURIComponent(message)}`,
    },
  });

/** "a, b and c" — up to `max`, then a count. */
const list = (items: string[], max = 6): string => {
  if (items.length <= max) return items.join(', ');
  return `${items.slice(0, max).join(', ')} and ${items.length - max} more`;
};

export const POST: APIRoute = async ({ request }) => {
  try {
    const form = await request.formData();
    const raw = String(form.get('payload') ?? '');

    const parsed = parseImport(raw);

    if (parsed.format === 'empty') {
      return back('error', 'Nothing to import — paste a list or some JSON.');
    }

    if (parsed.sites.length === 0) {
      return back(
        'error',
        parsed.problems.length > 0
          ? `Nothing could be read. ${list(parsed.problems, 3)}`
          : 'Nothing could be read from that.',
      );
    }

    const { sites, duplicates } = dedupe(parsed.sites);
    const { added, skipped } = await appendSites(sites);

    /*
     * One message covering everything that happened. Partial success is the
     * normal outcome when someone pastes a list overlapping what they have, and
     * it should not read as a failure.
     */
    const parts: string[] = [];
    if (added.length > 0) {
      parts.push(`Added ${added.length} site${added.length === 1 ? '' : 's'}: ${list(added)}.`);
    }
    if (skipped.length > 0) {
      parts.push(`Skipped ${skipped.length} already present: ${list(skipped)}.`);
    }
    if (duplicates.length > 0) {
      parts.push(`Ignored repeats within the paste: ${list(duplicates, 4)}.`);
    }
    if (parsed.problems.length > 0) {
      parts.push(`Could not read: ${list(parsed.problems, 3)}`);
    }

    return back(
      added.length > 0 ? 'ok' : 'error',
      parts.join(' ') || 'Nothing to do.',
    );
  } catch (error) {
    return back('error', messageOf(error));
  }
};
