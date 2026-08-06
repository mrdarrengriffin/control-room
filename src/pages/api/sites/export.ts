import type { APIRoute } from 'astro';
import { loadRegistry } from '../../../lib/sites';
import { exportDomains } from '../../../lib/transfer';

/**
 * Download the site list as plain text, one domain per line.
 *
 * Domains only: identifiers belong to the account they came from, so there is
 * nothing else worth carrying to another install.
 */
export const GET: APIRoute = async () => {
  const { sites } = await loadRegistry();

  return new Response(exportDomains(sites), {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': 'attachment; filename="control-room-sites.txt"',
      // Always a fresh read of the registry; a cached copy would be misleading.
      'Cache-Control': 'no-store',
    },
  });
};
