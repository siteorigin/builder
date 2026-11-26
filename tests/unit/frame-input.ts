import type { Frame, Page } from 'playwright';

/**
 * Wait until real mouse input over the page reaches this cross-origin frame. Chromium routes input into an
 * out-of-process frame only once the browser has hit-test data for it, which can arrive well after the frame's document
 * has loaded and run its scripts (on Windows it reliably does): until then a click over the frame lands on the host's
 * `<iframe>` element, and the frame never sees it. `at` is a point over the frame (in page coordinates) that is safe to
 * hover. For a test's `beforeAll`, where `expect.poll` is not available.
 */
export async function inputReachesFrame(page: Page, frame: Frame, at = { x: 1, y: 1 }, timeout = 10000): Promise<void> {
  await frame.evaluate(`window.__inputReached = false; addEventListener('pointermove', () => (window.__inputReached = true), { capture: true, once: true })`);
  const until = Date.now() + timeout;
  // Alternate between two points: a move to where the pointer already is fires nothing.
  for (let nudge = 0; ; nudge++) {
    await page.mouse.move(at.x, at.y + (nudge % 2));
    if (await frame.evaluate<boolean>(`window.__inputReached`)) return;
    if (Date.now() > until) throw new Error(`Mouse input never reached the frame within ${timeout} ms`);
    await page.waitForTimeout(50);
  }
}
