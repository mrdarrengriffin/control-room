import type { APIRoute } from 'astro';
import { loadRegistry } from '../../../lib/sites';
import { exportDomains, exportJson } from '../../../lib/transfer';

/**
 * Download the site list. `?format=domains` for a plain list, JSON otherwise.
 *
 * A file rather than a copy box because a long list is awkward to select, and
 * the JSON form is valid `data/sites.json` — so the download can be dropped
 * straight into another install's data directory.
 */
export const GET: APIRoute = async ({ url }) => {
  const { sites } = await loadRegistry();
  const domainsOnly = url.searchParams.get('format') === 'domains';

  const body = domainsOnly ? exportDomains(sites) : exportJson(sites);
  const filename = domainsOnly ? 'control-room-domains.txt' : 'sites.json';

  return new Response(body, {
    headers: {
      'Content-Type': domainsOnly
        ? 'text/plain; charset=utf-8'
        : 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      // Always a fresh read of the registry; a cached copy would be misleading.
      'Cache-Control': 'no-store',
    },
  });
};
