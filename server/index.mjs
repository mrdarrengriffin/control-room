import http from 'node:http';
import { handler as astroHandler } from '../dist/server/entry.mjs';
import { serveStatic } from './static.mjs';
import { attachWebSockets } from './websocket.mjs';

/**
 * Production server.
 *
 * Astro runs in middleware mode rather than standalone because the standalone
 * entry owns its HTTP server and never exposes it, leaving nowhere to handle the
 * WebSocket upgrade. Owning the server here is what makes /ws possible — at the
 * cost of serving static files ourselves, which middleware mode does not do.
 */

const port = Number(process.env.PORT ?? 4321);
const host = process.env.HOST ?? '0.0.0.0';

const server = http.createServer((req, res) => {
  const notFound = () => {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end('Not found');
  };

  const toAstro = () => {
    try {
      astroHandler(req, res, notFound);
    } catch (error) {
      console.error('[control-room] render error', error);
      if (!res.headersSent) res.statusCode = 500;
      res.end('Internal error');
    }
  };

  serveStatic(req, res, toAstro).catch((error) => {
    console.error('[control-room] static error', error);
    if (!res.headersSent) res.statusCode = 500;
    res.end('Internal error');
  });
});

attachWebSockets(server);

server.listen(port, host, () => {
  console.log(`[control-room] listening on http://${host}:${port} (ws on /ws)`);
});

// tini forwards SIGTERM on `docker compose down`; close cleanly so in-flight
// responses and sockets are not cut mid-write.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    console.log(`[control-room] ${signal}, shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 4_000).unref();
  });
}
