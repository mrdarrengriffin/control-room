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

/*
 * Both callers get sent back where they came from. Whitelisted rather than
 * echoed: a redirect target taken from a form field is an open redirect unless
 * it can only ever be one of these.
 */
const RETURN_TO: Record<string, string> = {
  import: '/sites/import',
  new: '/sites/new',
};

const back = (status: 'ok' | 'error', message: string, from = 'import') =>
  new Response(null, {
    status: 303,
    headers: {
      Location: `${RETURN_TO[from] ?? RETURN_TO.import}?flash=${status}&message=${encodeURIComponent(message)}`,
    },
  });

/** "a, b and c" — up to `max`, then a count. */
const list = (items: string[], max = 6): string => {
  if (items.length <= max) return items.join(', ');
  return `${items.slice(0, max).join(', ')} and ${items.length - max} more`;
};

export const POST: APIRoute = async ({ request }) => {
  // Outside the try: the catch below redirects too, and would otherwise be
  // referring to a binding that never came into scope.
  let from = 'import';

  try {
    const form = await request.formData();
    from = String(form.get('from') ?? 'import');

    /*
     * Two callers, one endpoint: the textarea on this page posts `payload`, and
     * the Discover checkboxes on /sites/new post one `domains` value each.
     * Joining them into the same newline-separated text keeps a single path for
     * "add several sites", however they were chosen.
     */
    const checked = form
      .getAll('domains')
      .map((value) => String(value).trim())
      .filter((value) => value !== '');
    const raw = [String(form.get('payload') ?? ''), ...checked]
      .filter((part) => part.trim() !== '')
      .join('\n');

    if (raw.trim() === '') {
      return back('error', 'Nothing to add — paste a list or tick a domain.', from);
    }

    const parsed = parseImport(raw);

    if (parsed.sites.length === 0) {
      return back(
        'error',
        parsed.problems.length > 0
          ? `Nothing could be read. ${list(parsed.problems, 3)}`
          : 'Nothing could be read from that.',
        from,
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
      from,
    );
  } catch (error) {
    return back('error', messageOf(error), from);
  }
};
