import { WebSocketServer } from 'ws';
import {
  COOKIE_NAME,
  parseCookies,
  readAuthFile,
  verifySession,
} from './session.mjs';

/**
 * The WebSocket side of live runs.
 *
 * Attached to whichever HTTP server is in play — the production server in
 * server/index.mjs, or Vite's dev server via the plugin in astro.config.mjs — so
 * /ws is same-origin on the same port in both dev and production.
 *
 * This file is plain Node and is NOT part of Astro's bundle, which is exactly
 * why the bus hangs off globalThis: importing src/lib/live.ts here would create
 * a second, unconnected copy of the registry. The shape below must stay in step
 * with the Bus interface in src/lib/live.ts.
 */

const WS_PATH = '/ws';
const HEARTBEAT_MS = 30_000;

const bus = (globalThis.__controlRoomLive ??= {
  entries: new Map(),
  taps: new Set(),
});

/**
 * The socket needs the same gate as the pages.
 *
 * Astro's middleware only covers HTTP routes — an upgrade request never reaches
 * it — so without this check /ws would stream live run output and screencast
 * frames to anyone who could reach the port.
 */
const authorised = (request) => {
  const auth = readAuthFile(process.env.CONTROL_ROOM_DATA_DIR ?? 'data');
  if (!auth?.sessionSecret) return false;

  const cookies = parseCookies(request.headers.cookie);
  return verifySession(cookies[COOKIE_NAME], auth.sessionSecret);
};

const send = (socket, payload) => {
  if (socket.readyState !== 1) return; // 1 === OPEN
  try {
    socket.send(JSON.stringify(payload));
  } catch {
    // Socket died between the readyState check and the send; nothing to do.
  }
};

export const attachWebSockets = (httpServer) => {
  // Vite can call configureServer more than once across restarts; attaching the
  // same listeners twice would double every message.
  if (httpServer.__controlRoomWsAttached) return;
  httpServer.__controlRoomWsAttached = true;

  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (request, socket, head) => {
    let pathname;
    try {
      pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    } catch {
      return;
    }

    // Return WITHOUT destroying the socket for anything that isn't ours: in dev
    // Vite's HMR client upgrades on this same event, and killing the socket here
    // breaks hot reload.
    if (pathname !== WS_PATH) return;

    // This one IS ours, so an unauthenticated client is a real rejection rather
    // than something to pass along.
    if (!authorised(request)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  });

  wss.on('connection', (socket) => {
    socket.watched = new Set();
    socket.alive = true;
    socket.on('pong', () => {
      socket.alive = true;
    });

    send(socket, { type: 'hello' });

    socket.on('message', (raw) => {
      let message;
      try {
        message = JSON.parse(String(raw));
      } catch {
        return;
      }

      if (message?.type === 'watch' && typeof message.runId === 'string') {
        socket.watched.add(message.runId);

        // Catch a late joiner up on everything that already happened, so opening
        // the page mid-run shows the log so far rather than starting blank.
        const entry = bus.entries.get(message.runId);
        if (entry) {
          send(socket, {
            type: 'snapshot',
            runId: entry.runId,
            siteSlug: entry.siteSlug,
            label: entry.label,
            status: entry.status,
            done: entry.done,
            lines: entry.lines,
            frame: entry.frame,
          });
        } else {
          // Unknown run: either finished long ago or lost to a restart. Say so
          // rather than leaving the client waiting forever.
          send(socket, { type: 'unknown', runId: message.runId });
        }
      }

      if (message?.type === 'unwatch' && typeof message.runId === 'string') {
        socket.watched.delete(message.runId);
      }
    });
  });

  const tap = ({ runId, siteSlug, label, event }) => {
    for (const socket of wss.clients) {
      const watching = socket.watched?.has(runId);

      // Frames and log lines only go to sockets that asked for that run — frames
      // especially are far too heavy to broadcast. Lifecycle events go to
      // everyone, so any open page can refresh its runs table.
      if (event.type === 'frame' || event.type === 'line') {
        if (!watching) continue;
      }

      send(socket, { type: event.type, runId, siteSlug, label, ...event });
    }
  };

  bus.taps.add(tap);

  const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
      if (socket.alive === false) {
        socket.terminate();
        continue;
      }
      socket.alive = false;
      try {
        socket.ping();
      } catch {
        socket.terminate();
      }
    }
  }, HEARTBEAT_MS);
  heartbeat.unref?.();

  httpServer.on('close', () => {
    clearInterval(heartbeat);
    bus.taps.delete(tap);
    for (const socket of wss.clients) socket.terminate();
  });

  return wss;
};
