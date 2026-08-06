/**
 * One site under management. Secrets never live here — only the identifiers
 * that say *which* Cloudflare zone or Netlify site a given domain maps to.
 * Tokens come from .env.
 */
export interface Site {
  slug: string;
  name: string;
  url: string;
  description?: string;
  tags?: string[];

  cloudflare?: { zoneId: string };
  netlify?: {
    /** Explicit id or domain. Omit to resolve from the site's own hostname. */
    siteId?: string;
    /** Set false for sites that are not deployed on Netlify at all. */
    enabled?: boolean;
  };
  plausible?: {
    domain: string;
    /**
     * Override the Plausible instance for this site. Needed when sites are
     * split across more than one Plausible install, which a single global
     * PLAUSIBLE_BASE_URL cannot express.
     */
    baseUrl?: string;
    /** Name of the env var holding this instance's API key, if not the default. */
    keyEnv?: string;
  };
  /** owner/repo — consumed by the gh CLI. */
  github?: { repo: string };

  /** Paths audited and captured by default. Defaults to ['/'] when omitted. */
  testPages?: string[];
  /**
   * Paths with scroll-driven behaviour (image sequences on the product pages),
   * which are the ones worth pointing the interaction/jank test at.
   */
  interactivePages?: string[];
}

/**
 * Every provider call returns this instead of throwing, so one missing token
 * degrades a single panel to "not configured" rather than blanking the page.
 * The three states are visually distinct in the UI and mean different things:
 * unconfigured is your setup to finish, error is something to investigate.
 */
export type PanelResult<T> =
  | { status: 'ok'; data: T }
  | { status: 'unconfigured'; reason: string }
  | { status: 'error'; reason: string };

export const ok = <T>(data: T): PanelResult<T> => ({ status: 'ok', data });

export const unconfigured = <T>(reason: string): PanelResult<T> => ({
  status: 'unconfigured',
  reason,
});

export const failed = <T>(reason: string): PanelResult<T> => ({
  status: 'error',
  reason,
});

/** Narrow an unknown thrown value to something printable. */
export const messageOf = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

export type RunKind = 'audit' | 'capture' | 'interaction';

/**
 * 'queued' matters because browser runs are serialised — a second run started
 * while one is in flight waits its turn, and the UI should say so rather than
 * claiming it is already working.
 */
export type RunStatus = 'queued' | 'running' | 'passed' | 'failed' | 'error';

export interface RunArtifact {
  kind: 'screenshot' | 'video' | 'json' | 'html';
  label: string;
  /** Path relative to the artifacts root, as stored on disk. */
  path: string;
  bytes?: number;
}

export interface RunRecord {
  id: string;
  siteSlug: string;
  kind: RunKind;
  label: string;
  status: RunStatus;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  /** Small, display-ready numbers for the run list. */
  summary?: Record<string, unknown>;
  artifacts?: RunArtifact[];
  error?: string;
  /** Progress log, copied off the live bus when the run ends. */
  log?: string[];
  /** Full result payload; can be large. */
  detail?: unknown;
}
