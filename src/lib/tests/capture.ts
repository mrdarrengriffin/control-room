import { mkdir, rename, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Page } from 'playwright';
import { artifactsRoot } from '../store';
import { contextOptionsFor, launchBrowser, VIEWPORTS } from './browser';
import type { ViewportKey } from './browser';
import type { Reporter } from '../live';
import type { RunOutcome } from '../runner';
import type { RunArtifact, Site } from '../types';
import { startScreencast } from './screencast';

/**
 * Screenshot and scroll-video capture.
 *
 * Artifacts are written straight into data/artifacts/<slug>/<run-id>/ rather
 * than to a temp dir and moved: that directory is a bind mount, so a cross-device
 * rename would fail with EXDEV. Playwright is told to record video there for the
 * same reason, and the file is only renamed *within* that directory.
 */

const settle = async (page: Page, url: string) => {
  await page.goto(url, { waitUntil: 'load', timeout: 45_000 });
  // Plenty of sites never go fully network-idle (analytics beacons, polling), so
  // treat idle as a nice-to-have rather than a requirement.
  await page
    .waitForLoadState('networkidle', { timeout: 12_000 })
    .catch(() => undefined);
};

/**
 * Walk the page top to bottom to trigger lazy-loaded images, then return to the
 * top. Without this a full-page screenshot of a lazy-loading site is a column of
 * empty placeholders.
 */
const primeLazyContent = async (page: Page) => {
  await page.evaluate(async () => {
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const step = Math.max(200, Math.round(window.innerHeight * 0.8));
    const limit = document.documentElement.scrollHeight;
    for (let y = 0; y < limit; y += step) {
      window.scrollTo(0, y);
      await sleep(90);
    }
    window.scrollTo(0, 0);
    await sleep(250);
  });
};

/** A filesystem-safe stem for a URL path: /blog/ -> blog, / -> home. */
const stemFor = (url: string): string => {
  try {
    const { pathname } = new URL(url);
    const cleaned = pathname.replace(/^\/+|\/+$/g, '').replace(/[^a-zA-Z0-9]+/g, '-');
    return cleaned === '' ? 'home' : cleaned.slice(0, 60).toLowerCase();
  } catch {
    return 'page';
  }
};

const sizeOf = async (file: string): Promise<number | undefined> => {
  try {
    return (await stat(file)).size;
  } catch {
    return undefined;
  }
};

export interface CaptureRequest {
  site: Site;
  runId: string;
  urls: string[];
  viewports: ViewportKey[];
}

export const runCapture = async (
  { site, runId, urls, viewports }: CaptureRequest,
  reporter: Reporter,
): Promise<RunOutcome> => {
  const outDir = path.join(artifactsRoot(), site.slug, runId);
  await mkdir(outDir, { recursive: true });

  reporter.line(
    `Launching browser · ${urls.length} page(s) × ${viewports.length} viewport(s)`,
  );

  const browser = await launchBrowser();
  const artifacts: RunArtifact[] = [];
  const failures: { url: string; viewport: string; error: string }[] = [];

  try {
    for (const viewport of viewports) {
      const dimensions = VIEWPORTS[viewport];
      reporter.line(
        `${dimensions.label} (${dimensions.width}×${dimensions.height})`,
      );
      const context = await browser.newContext(contextOptionsFor(viewport));

      try {
        for (const [index, url] of urls.entries()) {
          const page = await context.newPage();
          const stem = `${viewport}-${stemFor(url)}.png`;
          const file = path.join(outDir, stem);
          const stopWatching = await startScreencast(page, reporter);

          try {
            reporter.line(
              `    [${index + 1}/${urls.length}] loading ${new URL(url).pathname}`,
            );
            await settle(page, url);
            reporter.line('    scrolling to trigger lazy images');
            await primeLazyContent(page);
            await page.screenshot({ path: file, fullPage: true });

            const bytes = await sizeOf(file);
            reporter.line(
              `    captured ${stem}${bytes ? ` (${Math.round(bytes / 1024)}KB)` : ''}`,
            );

            artifacts.push({
              kind: 'screenshot',
              label: `${dimensions.label} · ${new URL(url).pathname}`,
              path: `${site.slug}/${runId}/${stem}`,
              bytes,
            });
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            reporter.line(`    failed: ${message}`);
            failures.push({ url, viewport, error: message });
          } finally {
            await stopWatching().catch(() => undefined);
            await page.close().catch(() => undefined);
          }
        }
      } finally {
        await context.close().catch(() => undefined);
      }
    }
  } finally {
    await browser.close().catch(() => undefined);
  }

  return {
    status: artifacts.length === 0 ? 'error' : failures.length > 0 ? 'failed' : 'passed',
    summary: {
      screenshots: artifacts.length,
      pages: urls.length,
      viewports: viewports.length,
      failed: failures.length,
    },
    artifacts,
    detail: { failures },
  };
};

export interface VideoRequest {
  site: Site;
  runId: string;
  url: string;
  viewport: ViewportKey;
}

/**
 * Record a scroll-through of one page. Scrolls in small increments with a pause
 * between each so the resulting video reads as a walkthrough rather than a jump
 * cut, which also exercises scroll-driven effects on the way down.
 */
export const runVideo = async (
  { site, runId, url, viewport }: VideoRequest,
  reporter: Reporter,
): Promise<RunOutcome> => {
  const outDir = path.join(artifactsRoot(), site.slug, runId);
  await mkdir(outDir, { recursive: true });

  const dimensions = VIEWPORTS[viewport];
  reporter.line(`Recording ${dimensions.label} · ${new URL(url).pathname}`);

  const browser = await launchBrowser();

  try {
    const context = await browser.newContext({
      ...contextOptionsFor(viewport),
      recordVideo: {
        dir: outDir,
        size: { width: dimensions.width, height: dimensions.height },
      },
    });

    const page = await context.newPage();
    const stopWatching = await startScreencast(page, reporter);
    reporter.line('Loading page');
    await settle(page, url);
    reporter.line('Scrolling top to bottom');

    await page.evaluate(async () => {
      const sleep = (ms: number) =>
        new Promise((resolve) => setTimeout(resolve, ms));
      const step = Math.max(40, Math.round(window.innerHeight * 0.12));
      const limit = document.documentElement.scrollHeight - window.innerHeight;
      await sleep(600);
      for (let y = 0; y <= limit; y += step) {
        window.scrollTo(0, y);
        await sleep(110);
      }
      await sleep(700);
    });

    const video = page.video();
    await stopWatching().catch(() => undefined);

    reporter.line('Finalising video');
    // The video file is only finalised when the context closes.
    await context.close();

    const recorded = await video?.path();
    if (!recorded) throw new Error('Playwright produced no video file');

    const stem = `${viewport}-${stemFor(url)}-scroll.webm`;
    const target = path.join(outDir, stem);
    await rename(recorded, target);

    const written = await sizeOf(target);
    reporter.line(
      `Saved ${stem}${written ? ` (${Math.round(written / 1024)}KB)` : ''}`,
    );

    return {
      status: 'passed',
      summary: {
        url,
        viewport: dimensions.label,
        sizeBytes: await sizeOf(target),
      },
      artifacts: [
        {
          kind: 'video',
          label: `${dimensions.label} scroll-through · ${new URL(url).pathname}`,
          path: `${site.slug}/${runId}/${stem}`,
          bytes: await sizeOf(target),
        },
      ],
    };
  } finally {
    await browser.close().catch(() => undefined);
  }
};
