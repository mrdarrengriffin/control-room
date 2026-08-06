// @ts-check
import { defineConfig } from 'astro/config';
import node from '@astrojs/node';
import { attachWebSockets } from './server/websocket.mjs';

// Every page reads live data from Cloudflare/Netlify/GitHub/Plausible, so there
// is nothing worth prerendering: 'server' makes on-demand rendering the default.
//
// The adapter is in 'middleware' mode rather than 'standalone' so that
// server/index.mjs owns the HTTP server and can handle the WebSocket upgrade.
// Standalone mode never exposes its server, which leaves nowhere to put /ws.
export default defineConfig({
  output: 'server',
  adapter: node({ mode: 'middleware' }),
  server: { host: true, port: 4321 },
  vite: {
    ssr: {
      // Server-only, heavy, and unhappy when bundled — Lighthouse and Playwright
      // resolve their own assets from node_modules at runtime.
      external: ['lighthouse', 'playwright', 'chrome-launcher'],
    },
    plugins: [
      {
        name: 'control-room-websocket',
        // In dev the app is served by Vite, not by server/index.mjs, so the same
        // WebSocket handler is attached to Vite's HTTP server. That keeps /ws on
        // the same origin and port in both dev and production.
        configureServer(server) {
          if (server.httpServer) attachWebSockets(server.httpServer);
        },
      },
    ],
    server: {
      watch: {
        // Docker Desktop on Windows does not forward inotify events across a
        // bind mount, so the file lands in the container but the watcher never
        // fires and hot reload silently stops working. Polling is the fix; it
        // costs a little CPU and is the reason edits show up at all in the
        // devcontainer. Ignored by the production build.
        usePolling: true,
        interval: 400,
      },
    },
  },
});
