import { chromium } from 'playwright';
import type { Browser } from 'playwright';

/**
 * Shared browser setup for every test runner.
 *
 * The container runs as root, where Chromium's setuid sandbox refuses to start,
 * so --no-sandbox is required. That is an acceptable trade here: this browser
 * only ever loads our own sites, on a machine that is not accepting outside
 * traffic. /dev/shm is sized to 1GB by the compose files, so the usual
 * --disable-dev-shm-usage workaround is not needed.
 */
export const launchBrowser = (): Promise<Browser> =>
  chromium.launch({ args: ['--no-sandbox'] });

export const VIEWPORTS = {
  desktop: {
    label: 'Desktop',
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    isMobile: false,
    userAgent: undefined as string | undefined,
  },
  mobile: {
    label: 'Mobile',
    width: 390,
    height: 844,
    // 3x matches a modern phone, so text rendering and image selection reflect
    // what a real visitor gets rather than a downscaled desktop page.
    deviceScaleFactor: 3,
    isMobile: true,
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  },
} as const;

export type ViewportKey = keyof typeof VIEWPORTS;

export const isViewportKey = (value: string): value is ViewportKey =>
  Object.keys(VIEWPORTS).includes(value);

/** Context options for a viewport, in the shape Playwright expects. */
export const contextOptionsFor = (key: ViewportKey) => {
  const viewport = VIEWPORTS[key];
  return {
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: viewport.deviceScaleFactor,
    isMobile: viewport.isMobile,
    hasTouch: viewport.isMobile,
    ...(viewport.userAgent ? { userAgent: viewport.userAgent } : {}),
  };
};

/**
 * Resolve the site-relative paths configured in data/sites.json into absolute
 * URLs. Shared so audits, captures and interaction tests all agree on what
 * "the test pages" means.
 */
export const resolvePages = (baseUrl: string, paths: string[]): string[] =>
  paths.map((path) => new URL(path, `${baseUrl}/`).href);
