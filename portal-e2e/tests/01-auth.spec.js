// @ts-check
const { test, expect, loginToPortal, logoutFromPortal } = require('../fixtures/auth');

test.describe('Portal authentication', () => {
  test('unauthenticated /church-portal redirects to /church-login', async ({ page }) => {
    const resp = await page.goto('/church-portal', { waitUntil: 'domcontentloaded' });
    // Final URL after the redirect chain.
    expect(page.url()).toContain('/church-login');
    expect(resp?.ok()).toBeTruthy();
    await expect(page.locator('input[name="email"]')).toBeVisible();
    await expect(page.locator('input[name="password"]')).toBeVisible();
  });

  test('login form rejects bad credentials with 401 + error message', async ({ page }) => {
    await page.goto('/church-login', { waitUntil: 'domcontentloaded' });
    await page.fill('input[name="email"]', 'nobody-' + Date.now() + '@example.invalid');
    await page.fill('input[name="password"]', 'definitely-wrong-' + Date.now());
    const [resp] = await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes('/api/church/login') && r.request().method() === 'POST',
        { timeout: 30_000 }
      ),
      page.click('button[type="submit"]'),
    ]);
    expect(resp.status()).toBe(401);
    // The 401 body is the login HTML with an error block.
    await expect(page.locator('body')).toContainText(/invalid email or password/i);
    // No session cookie was set on the failed login.
    const cookies = await page.context().cookies();
    expect(cookies.some((c) => c.name === 'tally_church_session')).toBe(false);
  });

  test('login with valid creds lands on dashboard', async ({ page }) => {
    await loginToPortal(page);
    expect(page.url()).toContain('/church-portal');
    // Dashboard sidebar nav must render.
    await expect(page.locator('.nav-item').first()).toBeVisible();
    // Session cookie was issued.
    const cookies = await page.context().cookies();
    expect(cookies.some((c) => c.name === 'tally_church_session')).toBe(true);
  });

  test('logout clears the session and redirects to login', async ({ page }) => {
    await loginToPortal(page);
    await logoutFromPortal(page);
    const cookies = await page.context().cookies();
    expect(cookies.some((c) => c.name === 'tally_church_session')).toBe(false);
    // Re-visit portal — should redirect.
    await page.goto('/church-portal', { waitUntil: 'domcontentloaded' });
    expect(page.url()).toContain('/church-login');
  });
});
