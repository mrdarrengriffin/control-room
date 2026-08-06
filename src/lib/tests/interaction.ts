import type { Page } from 'playwright';
import { contextOptionsFor, launchBrowser, VIEWPORTS } from './browser';
import type { ViewportKey } from './browser';
import type { Reporter } from '../live';
import type { RunOutcome } from '../runner';
import type { Site } from '../types';
import { startScreencast } from './screencast';

/**
 * Scroll-performance measurement, aimed at the scroll-driven image-sequence
 * sections on the product pages.
 *
 * An honest caveat, because it changes how the numbers should be read: frame
 * rate measured in headless Chromium is *indicative, not a device measurement*.
 * There is no real compositor or display refresh here, so the FPS figure should
 * be used for comparison between runs of the same page, never quoted as "what
 * users get".
 *
 * The trustworthy signal is main-thread blocking: long tasks and long frames
 * during scroll are what actually make an image-sequence scroller feel bad, and
 * those reproduce reliably in headless.
 */

/** Heuristics, deliberately explicit so they can be argued with. */
const P95_FRAME_BUDGET_MS = 50;
const BLOCKING_BUDGET_MS = 1_500;

const percentile = (sorted: number[], fraction: number): number => {
  if (sorted.length === 0) return 0;
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(fraction * sorted.length) - 1),
  );
  return sorted[index];
};

interface RawScrollStats {
  frames: number[];
  longTasks: number[];
  scrollHeight: number;
  viewportHeight: number;
  imageCount: number;
  /** Images that finished loading during the scroll, not before it. */
  imagesLoadedDuringScroll: number;
}

const measure = (page: Page): Promise<RawScrollStats> =>
  page.evaluate(async () => {
    const sleep = (ms: number) =>
      new Promise((resolve) => setTimeout(resolve, ms));

    let frames: number[] = [];
    let last = performance.now();
    let running = true;

    const tick = (time: number) => {
      frames.push(time - last);
      last = time;
      if (running) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);

    const longTasks: number[] = [];
    let observer: PerformanceObserver | undefined;
    try {
      observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) longTasks.push(entry.duration);
      });
      observer.observe({ entryTypes: ['longtask'] });
    } catch {
      // longtask is unsupported in some contexts; the frame data still stands.
    }

    const before = performance
      .getEntriesByType('resource')
      .filter((entry) => (entry as PerformanceResourceTiming).initiatorType === 'img')
      .length;

    // Let the page settle, then discard warm-up frames so first-paint work does
    // not get counted as scroll jank.
    await sleep(400);
    frames = [];
    last = performance.now();

    const step = Math.max(30, Math.round(window.innerHeight * 0.08));
    const limit = document.documentElement.scrollHeight - window.innerHeight;

    for (let y = 0; y <= limit; y += step) {
      window.scrollTo(0, y);
      await sleep(60);
    }

    await sleep(400);
    running = false;
    observer?.disconnect();

    const after = performance
      .getEntriesByType('resource')
      .filter((entry) => (entry as PerformanceResourceTiming).initiatorType === 'img')
      .length;

    return {
      frames,
      longTasks,
      scrollHeight: document.documentElement.scrollHeight,
      viewportHeight: window.innerHeight,
      imageCount: document.images.length,
      imagesLoadedDuringScroll: Math.max(0, after - before),
    };
  });

export interface PageInteraction {
  url: string;
  frameCount: number;
  avgFrameMs: number;
  p50FrameMs: number;
  p95FrameMs: number;
  maxFrameMs: number;
  /** Derived from avgFrameMs — indicative only, see the note at the top. */
  indicativeFps: number;
  longFrames: number;
  longTaskCount: number;
  blockingMs: number;
  scrollHeight: number;
  imageCount: number;
  imagesLoadedDuringScroll: number;
  withinBudget: boolean;
}

const summarise = (url: string, raw: RawScrollStats): PageInteraction => {
  const sorted = [...raw.frames].sort((a, b) => a - b);
  const total = raw.frames.reduce((sum, value) => sum + value, 0);
  const avg = raw.frames.length > 0 ? total / raw.frames.length : 0;
  const p95 = percentile(sorted, 0.95);
  const blockingMs = raw.longTasks.reduce((sum, value) => sum + value, 0);

  return {
    url,
    frameCount: raw.frames.length,
    avgFrameMs: Number(avg.toFixed(1)),
    p50FrameMs: Number(percentile(sorted, 0.5).toFixed(1)),
    p95FrameMs: Number(p95.toFixed(1)),
    maxFrameMs: Number((sorted[sorted.length - 1] ?? 0).toFixed(1)),
    indicativeFps: avg > 0 ? Number((1000 / avg).toFixed(1)) : 0,
    longFrames: raw.frames.filter((frame) => frame > P95_FRAME_BUDGET_MS).length,
    longTaskCount: raw.longTasks.length,
    blockingMs: Math.round(blockingMs),
    scrollHeight: raw.scrollHeight,
    imageCount: raw.imageCount,
    imagesLoadedDuringScroll: raw.imagesLoadedDuringScroll,
    withinBudget: p95 <= P95_FRAME_BUDGET_MS && blockingMs <= BLOCKING_BUDGET_MS,
  };
};

export interface InteractionRequest {
  site: Site;
  urls: string[];
  viewport: ViewportKey;
}

export const runInteraction = async (
  { site, urls, viewport }: InteractionRequest,
  reporter: Reporter,
): Promise<RunOutcome> => {
  reporter.line(
    `Launching browser · ${VIEWPORTS[viewport].label} · ${urls.length} page(s)`,
  );
  if (reporter.watch) {
    reporter.line(
      'Live view attached — it adds browser work, so treat frame timings as indicative',
    );
  }

  const browser = await launchBrowser();
  const pages: PageInteraction[] = [];
  const failures: { url: string; error: string }[] = [];

  try {
    const context = await browser.newContext(contextOptionsFor(viewport));

    try {
      for (const [index, url] of urls.entries()) {
        const page = await context.newPage();
        const stopWatching = await startScreencast(page, reporter);
        try {
          reporter.line(
            `[${index + 1}/${urls.length}] loading ${new URL(url).pathname}`,
          );
          await page.goto(url, { waitUntil: 'load', timeout: 45_000 });
          await page
            .waitForLoadState('networkidle', { timeout: 12_000 })
            .catch(() => undefined);

          reporter.line('    measuring frames while scrolling');
          const result = summarise(url, await measure(page));
          pages.push(result);

          reporter.line(
            `    p95 frame ${result.p95FrameMs}ms · blocking ${result.blockingMs}ms · ${result.longFrames}/${result.frameCount} long frames · ${result.withinBudget ? 'within budget' : 'OVER budget'}`,
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          reporter.line(`    failed: ${message}`);
          failures.push({ url, error: message });
        } finally {
          await stopWatching().catch(() => undefined);
          await page.close().catch(() => undefined);
        }
      }
    } finally {
      await context.close().catch(() => undefined);
    }
  } finally {
    await browser.close().catch(() => undefined);
  }

  if (pages.length === 0) {
    return {
      status: 'error',
      summary: { pages: 0, failed: failures.length },
      detail: { failures },
    };
  }

  const worstP95 = Math.max(...pages.map((page) => page.p95FrameMs));
  const totalBlocking = pages.reduce((sum, page) => sum + page.blockingMs, 0);

  return {
    status: pages.every((page) => page.withinBudget) && failures.length === 0
      ? 'passed'
      : 'failed',
    summary: {
      pages: pages.length,
      viewport: VIEWPORTS[viewport].label,
      worstP95FrameMs: worstP95,
      blockingMs: totalBlocking,
      failed: failures.length,
    },
    detail: { pages, failures, budgets: { P95_FRAME_BUDGET_MS, BLOCKING_BUDGET_MS } },
  };
};
