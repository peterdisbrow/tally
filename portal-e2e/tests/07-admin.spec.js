// @ts-check
const { test, expect, loginToAdmin } = require('../fixtures/auth');

test.describe('Admin panel', () => {
  test('admin login lands on the dashboard', async ({ page }) => {
    await loginToAdmin(page);
    expect(page.url()).toContain('/admin');
    // Sidebar nav buttons render after login.
    await expect(page.getByRole('button', { name: /Churches/i }).first()).toBeVisible({ timeout: 15_000 });
  });

  test('Emails tab shows the catalog with at least one entry', async ({ page }) => {
    await loginToAdmin(page);
    await page.getByRole('button', { name: /Emails/i }).first().click();

    // Default subtab is "Send History" — wait for the data fetch.
    const sendHistoryResp = await page.waitForResponse(
      (r) => r.url().includes('/api/admin/emails') && r.request().method() === 'GET',
      { timeout: 30_000 }
    );
    expect(sendHistoryResp.ok()).toBe(true);

    // Click into Templates subtab — that's the "catalog".
    await page.getByRole('button', { name: 'Templates' }).first().click();
    const templatesResp = await page.waitForResponse(
      (r) => r.url().includes('/api/admin/emails/templates') && r.request().method() === 'GET',
      { timeout: 30_000 }
    );
    expect(templatesResp.ok()).toBe(true);
    const templates = await templatesResp.json();
    expect(Array.isArray(templates)).toBe(true);
    expect(templates.length).toBeGreaterThan(0);

    // Each template renders as a card with Preview + Edit buttons.
    await expect(page.getByRole('button', { name: 'Preview' }).first()).toBeVisible({ timeout: 15_000 });
  });
});
