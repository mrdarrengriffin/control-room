import type { APIRoute } from 'astro';
import { isConfigured } from '../../lib/auth';

/**
 * Liveness probe for container orchestration.
 *
 * Unauthenticated by necessity — a healthcheck has no session — so it reports
 * only that the process is up and whether first-run setup is still pending.
 * Nothing here is useful to someone who shouldn't be looking.
 */
export const GET: APIRoute = async () =>
  new Response(
    JSON.stringify({
      status: 'ok',
      setupComplete: isConfigured(),
      uptimeSeconds: Math.round(process.uptime()),
    }),
    {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      },
    },
  );
