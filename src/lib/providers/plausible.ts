import { TTL, cached, cachedBy } from '../cache';
import {
  hostOf as debugHost,
  record as recordDebug,
  truncate as truncateDebug,
} from '../debug';
import { env, envValue } from '../env';
import { HttpError, bearer, fetchJson } from '../http';
import { failed, messageOf, ok, unconfigured } from '../types';
import type { PanelResult, Site } from '../types';

/**
 * Plausible Stats API v2 (`POST /api/v2/query`).
 *
 * v2 replaces the v1 GET endpoints with a single query endpoint: you name the
 * metrics you want, an optional list of dimensions to group by, and a date
 * range. Results come back as rows of positional arrays — `metrics[i]` lines up
 * with the i-th metric you asked for — which is why everything here goes
 * through `pick()` rather than reading fields by name.
 */

export const DATE_RANGES = [
  'day',
  '7d',
  '28d',
  '30d',
  '91d',
  'month',
  '6mo',
  '12mo',
  'year',
  'all',
] as const;

export type DateRange = (typeof DATE_RANGES)[number];

export const isDateRange = (value: string): value is DateRange =>
  (DATE_RANGES as readonly string[]).includes(value);

export const DATE_RANGE_LABELS: Record<DateRange, string> = {
  day: 'Today',
  '7d': 'Last 7 days',
  '28d': 'Last 28 days',
  '30d': 'Last 30 days',
  '91d': 'Last 91 days',
  month: 'This month',
  '6mo': 'Last 6 months',
  '12mo': 'Last 12 months',
  year: 'This year',
  all: 'All time',
};

interface QueryResponse {
  results: { metrics: (number | null)[]; dimensions: string[] }[];
}

const isoDate = (date: Date): string => date.toISOString().slice(0, 10);

const shiftDays = (days: number): Date => {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return date;
};

const shiftMonths = (months: number): Date => {
  const date = new Date();
  date.setUTCMonth(date.getUTCMonth() - months);
  return date;
};

const startOfMonth = (): string => {
  const now = new Date();
  return isoDate(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)));
};

const startOfYear = (): string => {
  const now = new Date();
  return isoDate(new Date(Date.UTC(now.getUTCFullYear(), 0, 1)));
};

/**
 * Translate our range keys into an explicit window ending TODAY.
 *
 * Plausible's relative presets deliberately stop at yesterday: asking for "7d"
 * on 2026-08-04 returns the window 2026-07-28T00:00 → 2026-08-03T23:59. On a
 * live control dashboard that reads as a broken page — today's traffic is
 * invisible and the headline number doesn't move until midnight. Sending an
 * explicit [start, today] pair instead cost nothing and made the difference
 * between 540 and 1,670 on the day this was found.
 *
 * Dates are computed in UTC, which is what the Plausible instance echoed back as
 * the window timezone. A site configured in a non-UTC timezone could be off by
 * one boundary day.
 */
const toApiDateRange = (range: DateRange): string | [string, string] => {
  const today = isoDate(new Date());

  switch (range) {
    case 'all':
      return 'all';
    case 'day':
      return [today, today];
    case '7d':
      return [isoDate(shiftDays(6)), today];
    case '28d':
      return [isoDate(shiftDays(27)), today];
    case '30d':
      return [isoDate(shiftDays(29)), today];
    case '91d':
      return [isoDate(shiftDays(90)), today];
    case '6mo':
      return [isoDate(shiftMonths(6)), today];
    case '12mo':
      return [isoDate(shiftMonths(12)), today];
    case 'month':
      return [startOfMonth(), today];
    case 'year':
      return [startOfYear(), today];
  }
};

interface QueryInput {
  site_id: string;
  metrics: string[];
  dateRange: DateRange;
  dimensions?: string[];
  order_by?: [string, 'asc' | 'desc'][];
  pagination?: { limit: number; offset?: number };
  filters?: unknown[];
}

/**
 * Which Plausible install a site's stats come from. Per-site rather than global
 * because sites can be spread across more than one Plausible instance, and a
 * single PLAUSIBLE_BASE_URL cannot express that.
 */
interface Instance {
  baseUrl: string;
  apiKey: string;
}

/**
 * Every Plausible read goes through here, which makes it the one place worth
 * caching: summary, timeseries and all four breakdowns are covered at once, and
 * the request body is a perfect cache key. A rejected request is not cached —
 * the throw propagates before anything is stored — so failures surface straight
 * away and retry on the next render.
 */
const query = async (
  { dateRange, ...rest }: QueryInput,
  instance: Instance,
): Promise<QueryResponse> => {
  const body = JSON.stringify({
    ...rest,
    date_range: toApiDateRange(dateRange),
  });

  return cached(
    `plausible:query:${instance.baseUrl}:${body}`,
    TTL.analytics,
    () =>
      fetchJson<QueryResponse>(`${instance.baseUrl}/api/v2/query`, {
        method: 'POST',
        headers: {
          ...bearer(instance.apiKey),
          'Content-Type': 'application/json',
        },
        body,
        timeoutMs: 20_000,
        /*
         * Plausible answers 401 "Invalid API key or site ID" for both a bad key
         * and a site the key cannot see. Recording which instance and which
         * site id were used is what tells those two apart.
         */
        debug: {
          provider: 'plausible',
          context: {
            instance: instance.baseUrl,
            site: String(rest.site_id ?? '(none)'),
            keyChars: String(instance.apiKey.length),
          },
        },
      }),
  );
};

/** Read one metric out of a positional result row. */
const pick = (
  row: QueryResponse['results'][number] | undefined,
  metrics: string[],
  name: string,
): number | undefined => {
  if (!row) return undefined;
  const index = metrics.indexOf(name);
  if (index < 0) return undefined;
  const value = row.metrics[index];
  return typeof value === 'number' ? value : undefined;
};

interface Ready {
  domain: string;
  instance: Instance;
}

const preflight = (site: Site): PanelResult<Ready> => {
  const keyEnvName = site.plausible?.keyEnv;
  const apiKey = keyEnvName ? envValue(keyEnvName) : env.plausibleKey();
  if (!apiKey) {
    return unconfigured(`${keyEnvName ?? 'PLAUSIBLE_API_KEY'} is not set in .env`);
  }

  const domain = site.plausible?.domain;
  if (!domain) {
    return unconfigured(`No plausible.domain for "${site.slug}"`);
  }

  const baseUrl = (site.plausible?.baseUrl ?? env.plausibleBaseUrl()).replace(
    /\/+$/,
    '',
  );

  return ok({ domain, instance: { baseUrl, apiKey } });
};

const translate = (error: unknown, domain: string): PanelResult<never> => {
  if (error instanceof HttpError) {
    if (error.isAuthFailure) {
      return failed(
        'Plausible rejected the API key, or it has no access to this site.',
      );
    }
    if (error.status === 404) {
      return failed(`Plausible has no site "${domain}".`);
    }
    if (error.status === 400) {
      return failed(`Plausible rejected the query: ${error.message}`);
    }
  }
  return failed(messageOf(error));
};

// --- Aggregate --------------------------------------------------------------

export interface Summary {
  visitors: number;
  visits: number;
  pageviews: number;
  bounceRate?: number;
  /** Mean visit length in seconds. */
  visitDuration?: number;
  viewsPerVisit?: number;
}

const SUMMARY_METRICS = [
  'visitors',
  'visits',
  'pageviews',
  'bounce_rate',
  'visit_duration',
  'views_per_visit',
];

export const summary = async (
  site: Site,
  dateRange: DateRange = '7d',
): Promise<PanelResult<Summary>> => {
  const ready = preflight(site);
  if (ready.status !== 'ok') return ready;
  const { domain, instance } = ready.data;

  try {
    const response = await query(
      { site_id: domain, metrics: SUMMARY_METRICS, dateRange },
      instance,
    );

    const row = response.results[0];
    return ok({
      visitors: pick(row, SUMMARY_METRICS, 'visitors') ?? 0,
      visits: pick(row, SUMMARY_METRICS, 'visits') ?? 0,
      pageviews: pick(row, SUMMARY_METRICS, 'pageviews') ?? 0,
      bounceRate: pick(row, SUMMARY_METRICS, 'bounce_rate'),
      visitDuration: pick(row, SUMMARY_METRICS, 'visit_duration'),
      viewsPerVisit: pick(row, SUMMARY_METRICS, 'views_per_visit'),
    });
  } catch (error) {
    return translate(error, domain);
  }
};

// --- Timeseries -------------------------------------------------------------

export interface TimeseriesPoint {
  date: string;
  visitors: number;
  pageviews: number;
}

const SERIES_METRICS = ['visitors', 'pageviews'];

/**
 * Group by day, or by month for ranges long enough that daily points would be
 * unreadable in a sparkline.
 */
const bucketFor = (dateRange: DateRange): string =>
  dateRange === '6mo' || dateRange === '12mo' || dateRange === 'all'
    ? 'time:month'
    : dateRange === 'day'
      ? 'time:hour'
      : 'time:day';

export const timeseries = async (
  site: Site,
  dateRange: DateRange = '7d',
): Promise<PanelResult<TimeseriesPoint[]>> => {
  const ready = preflight(site);
  if (ready.status !== 'ok') return ready;
  const { domain, instance } = ready.data;

  try {
    const response = await query(
      {
        site_id: domain,
        metrics: SERIES_METRICS,
        dateRange,
        dimensions: [bucketFor(dateRange)],
      },
      instance,
    );

    return ok(
      response.results.map((row) => ({
        date: row.dimensions[0] ?? '',
        visitors: pick(row, SERIES_METRICS, 'visitors') ?? 0,
        pageviews: pick(row, SERIES_METRICS, 'pageviews') ?? 0,
      })),
    );
  } catch (error) {
    return translate(error, domain);
  }
};

// --- Breakdowns -------------------------------------------------------------

export const BREAKDOWNS = {
  pages: { dimension: 'event:page', label: 'Top pages' },
  sources: { dimension: 'visit:source', label: 'Top sources' },
  /* ISO alpha-2 rather than the country name, so the UI can show a flag. */
  countries: { dimension: 'visit:country', label: 'Countries' },
  devices: { dimension: 'visit:device', label: 'Devices' },
  browsers: { dimension: 'visit:browser', label: 'Browsers' },
} as const;

export type BreakdownKey = keyof typeof BREAKDOWNS;

export interface BreakdownRow {
  label: string;
  visitors: number;
  pageviews: number;
}

export const breakdown = async (
  site: Site,
  key: BreakdownKey,
  dateRange: DateRange = '7d',
  limit = 10,
): Promise<PanelResult<BreakdownRow[]>> => {
  const ready = preflight(site);
  if (ready.status !== 'ok') return ready;
  const { domain, instance } = ready.data;

  try {
    const response = await query(
      {
        site_id: domain,
        metrics: SERIES_METRICS,
        dateRange,
        dimensions: [BREAKDOWNS[key].dimension],
        order_by: [['visitors', 'desc']],
        pagination: { limit, offset: 0 },
      },
      instance,
    );

    return ok(
      response.results.map((row) => ({
        // Plausible reports an empty string for "no referrer" and similar.
        label: row.dimensions[0] || '(none)',
        visitors: pick(row, SERIES_METRICS, 'visitors') ?? 0,
        pageviews: pick(row, SERIES_METRICS, 'pageviews') ?? 0,
      })),
    );
  } catch (error) {
    return translate(error, domain);
  }
};

// --- Goals -----------------------------------------------------------------

export interface GoalRow {
  name: string;
  visitors: number;
  events: number;
}

const GOAL_METRICS = ['visitors', 'events'];

/**
 * Configured goals and their completions. `events` counts every completion while
 * `visitors` counts distinct people, so the two differ and both are worth
 * showing — 840 outbound clicks from 603 visitors says more than either alone.
 */
export const goals = async (
  site: Site,
  dateRange: DateRange = '7d',
  limit = 10,
): Promise<PanelResult<GoalRow[]>> => {
  const ready = preflight(site);
  if (ready.status !== 'ok') return ready;
  const { domain, instance } = ready.data;

  try {
    const response = await query(
      {
        site_id: domain,
        metrics: GOAL_METRICS,
        dateRange,
        dimensions: ['event:goal'],
        order_by: [['visitors', 'desc']],
        pagination: { limit, offset: 0 },
      },
      instance,
    );

    return ok(
      response.results.map((row) => ({
        name: row.dimensions[0] || '(unnamed goal)',
        visitors: pick(row, GOAL_METRICS, 'visitors') ?? 0,
        events: pick(row, GOAL_METRICS, 'events') ?? 0,
      })),
    );
  } catch (error) {
    return translate(error, domain);
  }
};

// --- Composed views --------------------------------------------------------

export interface SiteAnalytics {
  summary: PanelResult<Summary>;
  timeseries: PanelResult<TimeseriesPoint[]>;
  pages: PanelResult<BreakdownRow[]>;
  sources: PanelResult<BreakdownRow[]>;
  /** Labels are ISO alpha-2 country codes. */
  countries: PanelResult<BreakdownRow[]>;
  devices: PanelResult<BreakdownRow[]>;
  goals: PanelResult<GoalRow[]>;
}

/** Everything the per-site analytics panel needs, fetched concurrently. */
export const siteAnalytics = async (
  site: Site,
  dateRange: DateRange = '7d',
): Promise<SiteAnalytics> => {
  const [summaryResult, series, pages, sources, countries, devices, goalRows] =
    await Promise.all([
      summary(site, dateRange),
      timeseries(site, dateRange),
      breakdown(site, 'pages', dateRange),
      breakdown(site, 'sources', dateRange),
      breakdown(site, 'countries', dateRange, 12),
      breakdown(site, 'devices', dateRange, 5),
      goals(site, dateRange),
    ]);

  return {
    summary: summaryResult,
    timeseries: series,
    pages,
    sources,
    countries,
    devices,
    goals: goalRows,
  };
};

// --- Realtime --------------------------------------------------------------

/**
 * Visitors on the site right now.
 *
 * This uses the **v1** endpoint on purpose, not an oversight: the v2 query API
 * has no realtime equivalent — `date_range: "realtime"` and `"30m"` are both
 * rejected with 400 "Invalid date range". v1 returns a bare integer.
 */
/**
 * Undefined on any problem, never an error: this renders in the sidebar on every
 * page, and a broken analytics call must not put an error in the navigation.
 *
 * The sidebar is on every page, so without caching each navigation would fire
 * one request per site. Failures are returned but not cached, so a site that
 * recovers shows up on the next render.
 */
export const realtimeVisitors = async (
  site: Site,
): Promise<number | undefined> => {
  const ready = preflight(site);
  if (ready.status !== 'ok') return undefined;

  const { domain, instance } = ready.data;

  return cachedBy(
    `plausible:realtime:${instance.baseUrl}:${domain}`,
    async () => {
      try {
        const response = await fetch(
          `${instance.baseUrl}/api/v1/stats/realtime/visitors?site_id=${encodeURIComponent(domain)}`,
          {
            headers: bearer(instance.apiKey),
            signal: AbortSignal.timeout(8_000),
          },
        );

        if (!response.ok) {
          /*
           * Failures only, on purpose. This runs per site on every render, so
           * logging successes would push everything else out of a 300-entry
           * buffer within minutes. A silently-failing sidebar badge is exactly
           * the thing that needs a trace; a working one is not.
           */
          recordDebug({
            kind: 'http',
            provider: 'plausible',
            label: `GET /api/v1/stats/realtime/visitors`,
            target: debugHost(instance.baseUrl),
            status: response.status,
            ok: false,
            ms: 0,
            detail: truncateDebug(await response.text()),
            context: {
              instance: instance.baseUrl,
              site: domain,
              note: 'sidebar live count',
            },
          });
          return undefined;
        }

        const visitors = Number.parseInt((await response.text()).trim(), 10);
        return Number.isNaN(visitors) ? undefined : visitors;
      } catch (error) {
        recordDebug({
          kind: 'http',
          provider: 'plausible',
          label: 'GET /api/v1/stats/realtime/visitors',
          target: debugHost(instance.baseUrl),
          ok: false,
          ms: 0,
          detail: messageOf(error),
          context: { instance: instance.baseUrl, site: domain },
        });
        return undefined;
      }
    },
    (visitors) => (visitors === undefined ? undefined : TTL.realtime),
  );
};

/** Realtime counts keyed by site slug, fetched concurrently. */
export const realtimeForSites = async (
  sites: Site[],
): Promise<Map<string, number>> => {
  const counts = new Map<string, number>();

  await Promise.all(
    sites.map(async (site) => {
      const visitors = await realtimeVisitors(site);
      if (visitors !== undefined) counts.set(site.slug, visitors);
    }),
  );

  return counts;
};

export interface SiteSummary {
  site: Site;
  result: PanelResult<Summary>;
}

/** Cross-site comparison for the global dashboard. */
export const summaryForSites = async (
  sites: Site[],
  dateRange: DateRange = '7d',
): Promise<SiteSummary[]> =>
  Promise.all(
    sites.map(async (site) => ({ site, result: await summary(site, dateRange) })),
  );

/**
 * Every site on the default instance, from Plausible's Sites API.
 *
 * Separate from the Stats API and separately authorised: a stats-only key gets
 * 401 here even though it reads analytics fine. That is a permission gap rather
 * than a broken key, and the message says which scope is missing.
 */
export const listDomains = async (): Promise<PanelResult<string[]>> => {
  const apiKey = env.plausibleKey();
  if (!apiKey) return unconfigured('PLAUSIBLE_API_KEY is not set');

  const baseUrl = env.plausibleBaseUrl();

  try {
    const response = await cached(`plausible:sites:${baseUrl}`, TTL.zones, () =>
      fetchJson<{ sites?: Array<{ domain?: string }> }>(
        `${baseUrl}/api/v1/sites?limit=1000`,
        {
          headers: bearer(apiKey),
          timeoutMs: 20_000,
          debug: { provider: 'plausible', context: { instance: baseUrl } },
        },
      ),
    );

    const domains = (response?.sites ?? [])
      .map((site) => site.domain?.toLowerCase())
      .filter((domain): domain is string => Boolean(domain));

    return ok([...new Set(domains)].sort());
  } catch (error) {
    if (error instanceof HttpError) {
      if (error.isAuthFailure) {
        return failed(
          `${baseUrl} rejected the key for listing sites. The Sites API needs a key with "sites:read" — a stats-only key reads analytics fine but cannot enumerate.`,
        );
      }
      if (error.status === 404) {
        /*
         * Probed against a real Community Edition instance: /api/v1/sites is
         * not mounted and answers with the marketing page, so echoing the body
         * put a screenful of HTML in the UI. /api/sites does exist and does
         * list sites, but replies "You need to be logged in" — it is the
         * dashboard's own session-authenticated route, not usable with a token.
         */
        return failed(
          `${baseUrl} does not offer a token-authenticated way to list sites: /api/v1/sites is not mounted on this build, and the dashboard's own /api/sites needs a logged-in session. Analytics are unaffected.`,
        );
      }
      // Any other HTTP failure: status only. The body may be an HTML page.
      return failed(`${baseUrl} returned ${error.status} when listing sites.`);
    }
    return failed(messageOf(error));
  }
};
