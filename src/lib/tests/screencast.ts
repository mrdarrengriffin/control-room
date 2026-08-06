import type { Page } from 'playwright';
import type { Reporter } from '../live';

/**
 * Stream what a page looks like, using the CDP screencast API.
 *
 * Every frame MUST be acknowledged with Page.screencastFrameAck — Chromium
 * waits for the ack before sending the next one, so forgetting it doesn't slow
 * the stream down, it stops it dead after one frame.
 *
 * Frames are capped in size here rather than on the client: sending a 3x-DPR
 * mobile viewport at full resolution is megabytes per second for a picture
 * displayed a few hundred pixels wide.
 */
export const startScreencast = async (
  page: Page,
  reporter: Reporter,
): Promise<() => Promise<void>> => {
  if (!reporter.watch) return async () => undefined;

  const session = await page.context().newCDPSession(page);

  session.on('Page.screencastFrame', (params: unknown) => {
    const frame = params as { data?: string; sessionId?: number };
    if (frame.data) reporter.frame(`data:image/jpeg;base64,${frame.data}`);
    if (frame.sessionId !== undefined) {
      void session
        .send('Page.screencastFrameAck', { sessionId: frame.sessionId })
        .catch(() => undefined);
    }
  });

  await session.send('Page.startScreencast', {
    format: 'jpeg',
    quality: 55,
    maxWidth: 900,
    maxHeight: 700,
    everyNthFrame: 2,
  });

  return async () => {
    await session.send('Page.stopScreencast').catch(() => undefined);
    await session.detach().catch(() => undefined);
  };
};

/**
 * Screencast a browser we did not launch ourselves — specifically the Chrome
 * that chrome-launcher starts for Lighthouse.
 *
 * Playwright attaches over the existing CDP port as a second client. Lighthouse
 * creates its own tab partway through, so this watches for pages appearing as
 * well as attaching to whatever already exists.
 */
export const screencastExistingBrowser = async (
  cdpUrl: string,
  reporter: Reporter,
): Promise<() => Promise<void>> => {
  if (!reporter.watch) return async () => undefined;

  const { chromium } = await import('playwright');
  const browser = await chromium.connectOverCDP(cdpUrl);
  const stops: (() => Promise<void>)[] = [];

  const attach = (page: Page) => {
    void startScreencast(page, reporter)
      .then((stop) => stops.push(stop))
      .catch(() => undefined);
  };

  for (const context of browser.contexts()) {
    for (const page of context.pages()) attach(page);
    context.on('page', attach);
  }

  return async () => {
    for (const stop of stops) await stop().catch(() => undefined);
    // Close only our observing connection; the browser belongs to its launcher.
    await browser.close().catch(() => undefined);
  };
};
