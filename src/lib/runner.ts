import {
  createLive,
  finishLive,
  logOf,
  pushLine,
  reporterFor,
  setStatus,
} from './live';
import type { Reporter } from './live';
import { newRunId, saveRun } from './store';
import { messageOf } from './types';
import type {
  RunArtifact,
  RunKind,
  RunRecord,
  RunStatus,
  Site,
} from './types';

export interface RunOutcome {
  /** Defaults to 'passed' when the work returns without throwing. */
  status?: RunStatus;
  summary?: Record<string, unknown>;
  artifacts?: RunArtifact[];
  detail?: unknown;
}

export type RunWork = (
  run: RunRecord,
  reporter: Reporter,
) => Promise<RunOutcome>;

/**
 * Browser jobs run one at a time.
 *
 * Each one launches a Chromium; several at once on a laptop is the quickest way
 * to exhaust memory and get a confusing crash instead of a result. Serialising
 * through a promise chain keeps it simple and predictable — a run started while
 * another is in flight sits in 'queued' until its turn.
 */
let queue: Promise<void> = Promise.resolve();

const now = () => new Date().toISOString();

/**
 * Register a run, hand back its record immediately, and do the work in the
 * background. The HTTP request that starts a run must not wait for it: an audit
 * or a video capture takes far longer than any sensible request timeout.
 *
 * Progress goes out over the live bus as it happens, and the finished log is
 * copied onto the saved record so it survives once the live entry is gone.
 */
export const startRun = async (
  site: Site,
  kind: RunKind,
  label: string,
  watch: boolean,
  work: RunWork,
): Promise<RunRecord> => {
  const queued: RunRecord = {
    id: newRunId(kind),
    siteSlug: site.slug,
    kind,
    label,
    status: 'queued',
    startedAt: now(),
  };

  createLive(queued.id, site.slug, label);
  pushLine(queued.id, `Queued: ${label}`);
  await saveRun(queued);

  queue = queue
    .then(async () => {
      const startedAt = now();
      const started = Date.now();
      const running: RunRecord = { ...queued, status: 'running', startedAt };

      setStatus(queued.id, 'running');
      await saveRun(running);

      const reporter = reporterFor(queued.id, watch);

      try {
        const outcome = await work(running, reporter);
        const status = outcome.status ?? 'passed';
        reporter.line(`Finished: ${status}`);

        await saveRun({
          ...running,
          ...outcome,
          status,
          log: logOf(queued.id),
          finishedAt: now(),
          durationMs: Date.now() - started,
        });

        finishLive(queued.id, status);
      } catch (error) {
        const message = messageOf(error);
        reporter.line(`Failed: ${message}`);

        await saveRun({
          ...running,
          status: 'error',
          error: message,
          log: logOf(queued.id),
          finishedAt: now(),
          durationMs: Date.now() - started,
        });

        finishLive(queued.id, 'error');
      }
    })
    // Never let one failed run break the chain for everything queued behind it.
    .catch(() => undefined);

  return queued;
};

export const isInFlight = (run: RunRecord): boolean =>
  run.status === 'queued' || run.status === 'running';

export type { RunArtifact, Reporter };
