// @ts-check
const { test, expect, loginToPortal } = require('../fixtures/auth');

test.describe('Engineer view', () => {
  test.beforeEach(async ({ page }) => {
    await loginToPortal(page);
  });

  /**
   * Regression coverage for PR #60: clicking the AI Assistant / Engineer nav
   * tab caused a blank screen for some users. Verify the page renders with
   * its core elements and no fatal JS errors during navigation.
   */
  test('engineer page loads with no blank screen and no console errors', async ({ page }) => {
    const consoleErrors = [];
    page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(`console: ${msg.text()}`);
    });

    const navItem = page.locator('.nav-item[data-page="engineer"]');
    await expect(navItem).toBeVisible();
    await navItem.click();

    // Page becomes active and core elements render.
    await expect(page.locator('#page-engineer')).toHaveClass(/active/, { timeout: 15_000 });
    await expect(page.locator('#page-engineer .page-title')).toBeVisible();
    // The chat input is the central interactive element on this page.
    await expect(page.locator('#engineer-chat-input')).toBeVisible({ timeout: 15_000 });

    // The page must have meaningful content — guard against blank-screen regression.
    const text = (await page.locator('#page-engineer').innerText()).trim();
    expect(text.length).toBeGreaterThan(20);

    // Filter known noisy-but-harmless console errors (e.g. 4xx from
    // unrelated polling endpoints in production). We only fail on errors
    // that look fatal (Uncaught exceptions, ReferenceError, TypeError).
    const fatal = consoleErrors.filter((m) =>
      /Uncaught|ReferenceError|TypeError|SyntaxError/i.test(m)
    );
    expect(fatal, fatal.join('\n')).toEqual([]);
  });
});
