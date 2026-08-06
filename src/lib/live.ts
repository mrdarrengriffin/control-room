/**
 * In-memory live state for runs that are currently executing, plus the bus the
 * WebSocket server reads from.
 *
 * WHY globalThis: the WebSocket server (server/websocket.mjs) is plain Node and
 * is NOT part of Astro's bundle, so importing this module from there would give
 * it a second, separate copy of the registry — it would subscribe to a bus that
 * nothing ever publishes to. Hanging the bus off globalThis is what makes both
 * module graphs share one instance. Both sides create-if-absent, so load order
 * doesn't matter.
 *
 * None of this is persisted. The durable record is the RunRecord on disk, and
 * the log is copied into it when a run ends, so nothing that matters lives only
 * here. After a server restart the socket reports the run finished and the page
 * falls back to the saved record.
 */

export interface LiveLine {
  /** ms since the run's live entry was created. */
  at: number;
  text: string;
}

export type LiveEvent =
  | { type: 'line'; line: LiveLine }
  | { type: 'frame'; data: string }
  | { type: 'status'; status: string }
  | { type: 'done'; status: string };

interface LiveEntry {
  runId: string;
  siteSlug: string;
  label: string;
  createdAt: number;
  lines: LiveLine[];
  /** Latest screencast frame as a data URI. Only the newest is kept. */
  frame?: string;
  lastFrameAt: number;
  status: string;
  done: boolean;
}

/** What a global tap receives. Shape is shared with server/websocket.mjs. */
export interface BusMessage {
  runId: string;
  siteSlug: string;
  label: string;
  event: LiveEvent;
}

interface Bus {
  entries: Map<string, LiveEntry>;
  taps: Set<(message: BusMessage) => void>;
}

const globalRef = globalThis as typeof globalThis & {
  __controlRoomLive?: Bus;
};

const bus: Bus = (globalRef.__controlRoomLive ??= {
  entries: new Map(),
  taps: new Set(),
});

/** Keep a handful of finished runs around so a late page load still sees them. */
const MAX_ENTRIES = 24;
const MAX_LINES = 500;
/**
 * Frames are ~20–80KB of base64 each and Chromium will happily emit 30+/second,
 * which floods the socket for no benefit — 5/second already reads as live.
 */
const MIN_FRAME_GAP_MS = 200;

const prune = () => {
  if (bus.entries.size <= MAX_ENTRIES) return;
  const finished = [...bus.entries.values()]
    .filter((entry) => entry.done)
    .sort((a, b) => a.createdAt - b.createdAt);
  for (const entry of finished) {
    if (bus.entries.size <= MAX_ENTRIES) break;
    bus.entries.delete(entry.runId);
  }
};

const publish = (entry: LiveEntry, event: LiveEvent) => {
  const message: BusMessage = {
    runId: entry.runId,
    siteSlug: entry.siteSlug,
    label: entry.label,
    event,
  };
  for (const tap of bus.taps) {
    try {
      tap(message);
    } catch {
      // A broken listener must not break the run or the other listeners.
    }
  }
};

export const createLive = (
  runId: string,
  siteSlug: string,
  label: string,
): void => {
  bus.entries.set(runId, {
    runId,
    siteSlug,
    label,
    createdAt: Date.now(),
    lines: [],
    lastFrameAt: 0,
    status: 'queued',
    done: false,
  });
  prune();
};

export const pushLine = (runId: string, text: string): void => {
  const entry = bus.entries.get(runId);
  if (!entry) return;
  const line: LiveLine = { at: Date.now() - entry.createdAt, text };
  entry.lines.push(line);
  if (entry.lines.length > MAX_LINES) entry.lines.shift();
  publish(entry, { type: 'line', line });
};

export const pushFrame = (runId: string, data: string): void => {
  const entry = bus.entries.get(runId);
  if (!entry) return;
  const now = Date.now();
  if (now - entry.lastFrameAt < MIN_FRAME_GAP_MS) return;
  entry.lastFrameAt = now;
  entry.frame = data;
  publish(entry, { type: 'frame', data });
};

export const setStatus = (runId: string, status: string): void => {
  const entry = bus.entries.get(runId);
  if (!entry) return;
  entry.status = status;
  publish(entry, { type: 'status', status });
};

export const finishLive = (runId: string, status: string): void => {
  const entry = bus.entries.get(runId);
  if (!entry) return;
  entry.done = true;
  entry.status = status;
  publish(entry, { type: 'done', status });
};

export interface LiveSnapshot {
  runId: string;
  siteSlug: string;
  label: string;
  lines: LiveLine[];
  frame?: string;
  status: string;
  done: boolean;
}

export const snapshot = (runId: string): LiveSnapshot | undefined => {
  const entry = bus.entries.get(runId);
  if (!entry) return undefined;
  return {
    runId: entry.runId,
    siteSlug: entry.siteSlug,
    label: entry.label,
    lines: [...entry.lines],
    frame: entry.frame,
    status: entry.status,
    done: entry.done,
  };
};

/** Plain text log, for copying into the durable RunRecord when a run ends. */
export const logOf = (runId: string): string[] =>
  (bus.entries.get(runId)?.lines ?? []).map(
    (line) => `${(line.at / 1000).toFixed(1)}s  ${line.text}`,
  );

/**
 * What a runner is handed to talk to the outside world while it works.
 * `watch` tells it whether to bother attaching a screencast at all.
 */
export interface Reporter {
  line(text: string): void;
  frame(data: string): void;
  watch: boolean;
}

export const reporterFor = (runId: string, watch: boolean): Reporter => ({
  line: (text) => pushLine(runId, text),
  frame: (data) => pushFrame(runId, data),
  watch,
});
