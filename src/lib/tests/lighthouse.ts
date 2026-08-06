import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import lighthouse from 'lighthouse';
import { launch as launchChrome } from 'chrome-launcher';
import { chromium } from 'playwright';
import type { Reporter } from '../live';
import type { RunOutcome } from '../runner';
import { artifactsRoot } from '../store';
import { messageOf } from '../types';
import type { RunArtifact, Site } from '../types';
import { screencastExistingBrowser } from './screencast';

/**
 * Lighthouse audits, runnable per category, with enough detail extracted to
 * answer "why did this fail, and which element?".
 *
 * Chrome is started by chrome-launcher (a Lighthouse dependency, pinned to the
 * same range) rather than Playwright, because Lighthouse wants a CDP port and
 * chrome-launcher already handles finding a free one and waiting for readiness.
 * The binary it launches is Playwright's Chromium, so there is one browser in
 * the image.
 */

export const CATEGORIES = [
  'performance',
  'accessibility',
  'best-practices',
  'seo',
] as const;

export type Category = (typeof CATEGORIES)[number];

export const CATEGORY_LABELS: Record<Category, string> = {
  performance: 'Performance',
  accessibility: 'Accessibility',
  'best-practices': 'Best practices',
  seo: 'SEO',
};

export const isCategory = (value: string): value is Category =>
  (CATEGORIES as readonly string[]).includes(value);

export type FormFactor = 'desktop' | 'mobile';

/** Audit id -> the short key we report it under. */
const METRIC_AUDITS: Record<string, string> = {
  'first-contentful-paint': 'fcp',
  'largest-contentful-paint': 'lcp',
  'total-blocking-time': 'tbt',
  'cumulative-layout-shift': 'cls',
  'speed-index': 'si',
  interactive: 'tti',
};

/**
 * Lighthouse 13 moved the LCP explanation into "insight" audits. The older ids
 * (largest-contentful-paint-element, prioritize-lcp-image, lcp-lazy-loaded) do
 * not exist any more — verified against 13.4, where they are absent entirely.
 * These two are rendered in a dedicated LCP panel, so they are kept out of the
 * general findings list to avoid saying the same thing twice.
 */
const LCP_BREAKDOWN_AUDIT = 'lcp-breakdown-insight';
const LCP_DISCOVERY_AUDIT = 'lcp-discovery-insight';

const MAX_FINDINGS = 40;
const MAX_ROWS_PER_FINDING = 15;
const MAX_NODES_PER_FINDING = 8;

// --- Shapes we read out of the Lighthouse result ---------------------------

interface LhNode {
  type: 'node';
  lhId?: string;
  path?: string;
  selector?: string;
  snippet?: string;
  nodeLabel?: string;
  explanation?: string;
  boundingRect?: Rect;
}

interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

interface LhHeading {
  key: string | null;
  label?: string;
  valueType?: string;
  granularity?: number;
}

interface LhDetails {
  type?: string;
  headings?: LhHeading[];
  items?: unknown;
  overallSavingsMs?: number;
  overallSavingsBytes?: number;
}

interface LhAudit {
  id?: string;
  title: string;
  description?: string;
  score: number | null;
  scoreDisplayMode: string;
  displayValue?: string;
  numericValue?: number;
  metricSavings?: Record<string, number>;
  details?: LhDetails;
}

interface Lhr {
  requestedUrl?: string;
  finalDisplayedUrl?: string;
  categories: Record<
    string,
    { title: string; score: number | null; auditRefs?: { id: string }[] }
  >;
  audits: Record<string, LhAudit>;
  fullPageScreenshot?: {
    screenshot?: { data?: string; width?: number; height?: number };
    /** lhId -> rect, in SCREENSHOT coordinate space. */
    nodes?: Record<string, Rect>;
  };
}

// --- What we hand to the UI ------------------------------------------------

export interface NodeRef {
  lhId?: string;
  selector?: string;
  snippet?: string;
  label?: string;
  /** Element-specific reason, where the audit provides one. */
  explanation?: string;
  /**
   * Rect in FULL-PAGE SCREENSHOT space, for cropping.
   *
   * This comes from fullPageScreenshot.nodes, NOT from the item's boundingRect.
   * They are different coordinate spaces: for one element measured here,
   * boundingRect was top:334,left:8 while the screenshot rect was
   * top:256,left:90 — same size, different origin. Cropping with boundingRect
   * silently shows the wrong part of the page.
   */
  rect?: Rect;
}

export interface AuditRow {
  cells: { label: string; value: string }[];
  node?: NodeRef;
}

export interface ChecklistItem {
  label: string;
  passed: boolean;
}

export interface Subpart {
  label: string;
  ms: number;
}

export interface Finding {
  id: string;
  title: string;
  description: string;
  category: Category;
  score: number | null;
  scoreDisplayMode: string;
  displayValue?: string;
  /** Per-metric savings Lighthouse attributes to fixing this. */
  metricSavings?: Record<string, number>;
  savingsMs?: number;
  savingsBytes?: number;
  rows: AuditRow[];
  checklist: ChecklistItem[];
  nodes: NodeRef[];
  truncatedRows: number;
}

export interface LcpDetail {
  totalMs?: number;
  node?: NodeRef;
  subparts: Subpart[];
  checklist: ChecklistItem[];
  description?: string;
  /** True when Lighthouse scored the discovery insight as failing. */
  discoveryFailing: boolean;
}

export interface CategoryScore {
  key: Category;
  label: string;
  /** 0–100, or undefined when Lighthouse could not score it. */
  score: number | undefined;
}

export interface PageAudit {
  url: string;
  finalUrl?: string;
  scores: CategoryScore[];
  /** Core metrics in ms, except cls which is unitless. */
  metrics: Record<string, number | undefined>;
  screenshot?: { path: string; width: number; height: number };
  lcp?: LcpDetail;
  findings: Finding[];
}

/**
 * Lighthouse's own scoring bands are 0–49 red, 50–89 amber, 90–100 green, so
 * "below 50" is the natural definition of a failing run and matches what anyone
 * reading a Lighthouse report already expects.
 */
const FAIL_BELOW = 50;

// --- Extraction ------------------------------------------------------------

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const isNode = (value: unknown): value is LhNode =>
  isRecord(value) && value.type === 'node';

const bytes = (value: number): string =>
  value > 1_048_576
    ? `${(value / 1_048_576).toFixed(1)} MB`
    : `${Math.max(1, Math.round(value / 1024))} KB`;

/** Turn one table cell into display text, whatever Lighthouse put in it. */
const formatValue = (value: unknown, heading: LhHeading): string => {
  if (value === undefined || value === null || value === '') return '';

  if (isRecord(value)) {
    const type = value.type;
    if (type === 'url' || type === 'link') {
      return String(value.url ?? value.text ?? '');
    }
    if (type === 'code' || type === 'text') return String(value.value ?? '');
    if (type === 'source-location') return String(value.url ?? '');
    if (type === 'numeric') return String(value.value ?? '');
    return '';
  }

  if (typeof value === 'boolean') return value ? 'yes' : 'no';

  if (typeof value === 'number') {
    switch (heading.valueType) {
      case 'ms':
      case 'timespanMs':
        return `${Math.round(value)} ms`;
      case 'bytes':
        return bytes(value);
      case 'numeric': {
        const granularity = heading.granularity ?? 1;
        const digits = granularity < 1 ? String(granularity).split('.')[1]?.length ?? 2 : 0;
        return value.toFixed(digits);
      }
      default:
        return String(value);
    }
  }

  return String(value);
};

const nodeRefFrom = (
  node: LhNode,
  screenshotNodes: Record<string, Rect> | undefined,
): NodeRef => ({
  lhId: node.lhId,
  selector: node.selector,
  snippet: node.snippet,
  label: node.nodeLabel,
  explanation: node.explanation,
  rect: node.lhId ? screenshotNodes?.[node.lhId] : undefined,
});

interface Extracted {
  rows: AuditRow[];
  checklist: ChecklistItem[];
  nodes: NodeRef[];
  subparts: Subpart[];
}

const empty = (): Extracted => ({
  rows: [],
  checklist: [],
  nodes: [],
  subparts: [],
});

/**
 * Flatten a details blob. Lighthouse 13 nests things: an insight audit is a
 * 'list' whose items are a mix of tables, checklists and bare nodes, so this
 * recurses rather than assuming one table.
 */
const extractDetails = (
  details: LhDetails | undefined,
  screenshotNodes: Record<string, Rect> | undefined,
): Extracted => {
  const out = empty();
  if (!details) return out;

  const merge = (other: Extracted) => {
    out.rows.push(...other.rows);
    out.checklist.push(...other.checklist);
    out.nodes.push(...other.nodes);
    out.subparts.push(...other.subparts);
  };

  if (details.type === 'list') {
    for (const item of Array.isArray(details.items) ? details.items : []) {
      if (isNode(item)) {
        out.nodes.push(nodeRefFrom(item, screenshotNodes));
        continue;
      }
      if (isRecord(item)) {
        merge(extractDetails(item as LhDetails, screenshotNodes));
      }
    }
    return out;
  }

  if (details.type === 'checklist') {
    const items = isRecord(details.items) ? details.items : {};
    for (const value of Object.values(items)) {
      if (!isRecord(value)) continue;
      out.checklist.push({
        label: String(value.label ?? ''),
        passed: Boolean(value.value),
      });
    }
    return out;
  }

  if (details.type === 'table' || details.type === 'opportunity') {
    const headings = details.headings ?? [];
    const items = Array.isArray(details.items) ? details.items : [];

    // A duration-per-label table is a metric breakdown (the LCP subparts), which
    // is far more useful drawn as a bar than listed as rows.
    const isBreakdown =
      headings.some((heading) => heading.key === 'duration') &&
      headings.some((heading) => heading.key === 'label');

    for (const item of items) {
      if (!isRecord(item)) continue;

      if (isBreakdown) {
        out.subparts.push({
          label: String(item.label ?? ''),
          ms: typeof item.duration === 'number' ? item.duration : 0,
        });
        continue;
      }

      const cells: { label: string; value: string }[] = [];
      let node: NodeRef | undefined;

      for (const heading of headings) {
        if (!heading.key) continue;
        const raw = item[heading.key];

        if (isNode(raw)) {
          node = nodeRefFrom(raw, screenshotNodes);
          continue;
        }

        const text = formatValue(raw, heading);
        if (text !== '') {
          cells.push({ label: heading.label ?? heading.key, value: text });
        }
      }

      if (node) out.nodes.push(node);
      if (cells.length > 0 || node) out.rows.push({ cells, node });
    }
  }

  return out;
};

const auditOwner = (lhr: Lhr, categories: Category[]): Map<string, Category> => {
  const owner = new Map<string, Category>();
  for (const category of categories) {
    for (const ref of lhr.categories[category]?.auditRefs ?? []) {
      if (!owner.has(ref.id)) owner.set(ref.id, category);
    }
  }
  return owner;
};

const readLcp = (lhr: Lhr, screenshotNodes: Record<string, Rect> | undefined): LcpDetail | undefined => {
  const breakdown = lhr.audits[LCP_BREAKDOWN_AUDIT];
  const discovery = lhr.audits[LCP_DISCOVERY_AUDIT];
  if (!breakdown && !discovery) return undefined;

  const fromBreakdown = extractDetails(breakdown?.details, screenshotNodes);
  const fromDiscovery = extractDetails(discovery?.details, screenshotNodes);

  return {
    totalMs: lhr.audits['largest-contentful-paint']?.numericValue,
    node: fromBreakdown.nodes[0] ?? fromDiscovery.nodes[0],
    subparts: fromBreakdown.subparts,
    checklist: fromDiscovery.checklist,
    description: breakdown?.description ?? discovery?.description,
    discoveryFailing: (discovery?.score ?? 1) < 0.9,
  };
};

const readPage = (
  lhr: Lhr,
  url: string,
  categories: Category[],
  screenshot: PageAudit['screenshot'],
): PageAudit => {
  const scores: CategoryScore[] = categories.map((key) => {
    const raw = lhr.categories[key]?.score;
    return {
      key,
      label: CATEGORY_LABELS[key],
      score: typeof raw === 'number' ? Math.round(raw * 100) : undefined,
    };
  });

  const metrics: Record<string, number | undefined> = {};
  for (const [auditId, short] of Object.entries(METRIC_AUDITS)) {
    metrics[short] = lhr.audits[auditId]?.numericValue;
  }

  const screenshotNodes = lhr.fullPageScreenshot?.nodes;
  const owner = auditOwner(lhr, categories);
  const findings: Finding[] = [];

  for (const [id, audit] of Object.entries(lhr.audits)) {
    const category = owner.get(id);
    if (!category) continue;
    if (id === LCP_BREAKDOWN_AUDIT || id === LCP_DISCOVERY_AUDIT) continue;

    // binary/numeric are the scored modes; informative and notApplicable are not
    // failures and would otherwise flood the list.
    if (
      audit.scoreDisplayMode !== 'binary' &&
      audit.scoreDisplayMode !== 'numeric'
    ) {
      continue;
    }
    if (audit.score === null || audit.score >= 0.9) continue;

    const extracted = extractDetails(audit.details, screenshotNodes);

    findings.push({
      id,
      title: audit.title,
      description: audit.description ?? '',
      category,
      score: audit.score,
      scoreDisplayMode: audit.scoreDisplayMode,
      displayValue: audit.displayValue,
      metricSavings: audit.metricSavings,
      savingsMs: audit.details?.overallSavingsMs,
      savingsBytes: audit.details?.overallSavingsBytes,
      rows: extracted.rows.slice(0, MAX_ROWS_PER_FINDING),
      checklist: extracted.checklist,
      nodes: extracted.nodes.slice(0, MAX_NODES_PER_FINDING),
      truncatedRows: Math.max(0, extracted.rows.length - MAX_ROWS_PER_FINDING),
    });
  }

  findings.sort((a, b) => (a.score ?? 1) - (b.score ?? 1));

  return {
    url,
    finalUrl: lhr.finalDisplayedUrl,
    scores,
    metrics,
    screenshot,
    lcp: readLcp(lhr, screenshotNodes),
    findings: findings.slice(0, MAX_FINDINGS),
  };
};

/** Persist Lighthouse's full-page screenshot so element crops have a source. */
const saveScreenshot = async (
  lhr: Lhr,
  site: Site,
  runId: string,
  stem: string,
): Promise<{ screenshot: PageAudit['screenshot']; artifact?: RunArtifact }> => {
  const shot = lhr.fullPageScreenshot?.screenshot;
  const data = shot?.data;
  if (!data || !shot?.width || !shot?.height) return { screenshot: undefined };

  // Lighthouse hands it over as a data URI, WebP in 13.x.
  const match = /^data:image\/(\w+);base64,(.+)$/s.exec(data);
  if (!match) return { screenshot: undefined };

  const extension = match[1] === 'jpeg' ? 'jpg' : match[1];
  const file = `${stem}-fullpage.${extension}`;
  const outDir = path.join(artifactsRoot(), site.slug, runId);
  await mkdir(outDir, { recursive: true });

  const buffer = Buffer.from(match[2], 'base64');
  await writeFile(path.join(outDir, file), buffer);

  const relative = `${site.slug}/${runId}/${file}`;
  return {
    screenshot: { path: relative, width: shot.width, height: shot.height },
    artifact: {
      kind: 'screenshot',
      label: `Full page · ${stem}`,
      path: relative,
      bytes: buffer.byteLength,
    },
  };
};

const stemFor = (url: string): string => {
  try {
    const { pathname } = new URL(url);
    const cleaned = pathname.replace(/^\/+|\/+$/g, '').replace(/[^a-zA-Z0-9]+/g, '-');
    return cleaned === '' ? 'home' : cleaned.slice(0, 60).toLowerCase();
  } catch {
    return 'page';
  }
};

export interface AuditRequest {
  site: Site;
  runId: string;
  urls: string[];
  categories: Category[];
  formFactor: FormFactor;
}

export const runAudit = async (
  { site, runId, urls, categories, formFactor }: AuditRequest,
  reporter: Reporter,
): Promise<RunOutcome> => {
  reporter.line(
    `Launching Chrome · ${formFactor} · ${categories.map((c) => CATEGORY_LABELS[c]).join(', ')}`,
  );

  const chrome = await launchChrome({
    chromePath: chromium.executablePath(),
    chromeFlags: ['--headless=new', '--no-sandbox'],
  });

  let stopWatching: (() => Promise<void>) | undefined;
  if (reporter.watch) {
    try {
      stopWatching = await screencastExistingBrowser(
        `http://127.0.0.1:${chrome.port}`,
        reporter,
      );
      reporter.line(
        'Live view attached — note this adds work to the browser and can move performance timings',
      );
    } catch (error) {
      // Never fail an audit because the optional live view could not attach.
      reporter.line(`Live view unavailable: ${messageOf(error)}`);
    }
  }

  const pages: PageAudit[] = [];
  const artifacts: RunArtifact[] = [];

  try {
    for (const [index, url] of urls.entries()) {
      reporter.line(
        `[${index + 1}/${urls.length}] Auditing ${new URL(url).pathname}`,
      );

      const result = await lighthouse(
        url,
        {
          port: chrome.port,
          output: 'json',
          logLevel: 'error',
          onlyCategories: [...categories],
          formFactor,
          // Lighthouse defaults to mobile emulation; desktop needs saying.
          screenEmulation:
            formFactor === 'desktop'
              ? {
                  mobile: false,
                  width: 1350,
                  height: 940,
                  deviceScaleFactor: 1,
                  disabled: false,
                }
              : undefined,
        } as never,
      );

      if (!result?.lhr) {
        throw new Error(`Lighthouse returned no report for ${url}`);
      }

      const lhr = result.lhr as unknown as Lhr;
      const stem = stemFor(url);
      const { screenshot, artifact } = await saveScreenshot(
        lhr,
        site,
        runId,
        stem,
      );
      if (artifact) artifacts.push(artifact);

      const page = readPage(lhr, url, categories, screenshot);
      pages.push(page);

      reporter.line(
        `    ${page.scores.map((score) => `${score.label} ${score.score ?? 'n/a'}`).join(' · ')}`,
      );
      if (page.lcp?.node?.selector) {
        reporter.line(`    LCP element: ${page.lcp.node.selector}`);
      }
      if (page.findings.length > 0) {
        reporter.line(`    ${page.findings.length} findings with detail`);
      }
    }
  } finally {
    if (stopWatching) await stopWatching().catch(() => undefined);
    // Always reap Chrome — a leaked headless browser per run would pile up.
    // kill() is SYNCHRONOUS in chrome-launcher 1.x and returns void, so calling
    // .catch() on it throws a TypeError from inside this finally block and masks
    // the real audit result.
    try {
      chrome.kill();
    } catch {
      // Already gone; nothing to reap.
    }
  }

  // Worst score per category across every page audited.
  const worst: Record<string, number> = {};
  for (const page of pages) {
    for (const score of page.scores) {
      if (score.score === undefined) continue;
      worst[score.key] = Math.min(worst[score.key] ?? 100, score.score);
    }
  }

  const anyFailing = Object.values(worst).some((score) => score < FAIL_BELOW);

  return {
    status: anyFailing ? 'failed' : 'passed',
    summary: {
      pages: pages.length,
      formFactor,
      ...worst,
    },
    artifacts,
    detail: { pages },
  };
};
