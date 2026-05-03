// @ts-check
const { test, expect, loginToPortal } = require('../fixtures/auth');

test.describe('Stream protection', () => {
  test.beforeEach(async ({ page }) => {
    await loginToPortal(page);
  });

  test('stream-protection card exists in the DOM (even when inactive)', async ({ page }) => {
    // The card lives on the overview page. It's hidden until stream protection
    // engages, but the element must be present so it can be shown reactively.
    await expect(page.locator('#page-overview')).toHaveClass(/active/);
    const card = page.locator('#stream-protection-card');
    await expect(card).toBeAttached();
    // Restart action button is also part of the card markup.
    await expect(page.locator('#sp-restart-btn')).toBeAttached();
  });
});
