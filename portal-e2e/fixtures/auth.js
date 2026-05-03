// @ts-check
const { test: base, expect } = require('@playwright/test');

const PORTAL_EMAIL = process.env.PORTAL_EMAIL;
const PORTAL_PASSWORD = process.env.PORTAL_PASSWORD;
const ADMIN_EMAIL = process.env.ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

function requirePortalCreds() {
  if (!PORTAL_EMAIL || !PORTAL_PASSWORD) {
    throw new Error(
      'PORTAL_EMAIL and PORTAL_PASSWORD env vars are required for this test. ' +
      'See portal-e2e/.env.example.'
    );
  }
}

function requireAdminCreds() {
  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
    throw new Error(
      'ADMIN_EMAIL and ADMIN_PASSWORD env vars are required for this test. ' +
      'See portal-e2e/.env.example.'
    );
  }
}

/**
 * Log in to the church portal via the form. Leaves the page on /church-portal.
 */
async function loginToPortal(page) {
  requirePortalCreds();
  await page.goto('/church-login', { waitUntil: 'domcontentloaded' });
  await page.fill('input[name="email"]', PORTAL_EMAIL);
  await page.fill('input[name="password"]', PORTAL_PASSWORD);
  await Promise.all([
    page.waitForURL('**/church-portal*', { timeout: 30_000 }),
    page.click('button[type="submit"]'),
  ]);
  // Wait for portal JS to initialize. The dashboard renders #page-overview.
  await page.waitForSelector('#page-overview, #page-rooms, .nav-item', { timeout: 30_000 });
}

/**
 * Log out by hitting the logout endpoint and clearing cookies.
 */
async function logoutFromPortal(page) {
  try {
    await page.evaluate(async () => {
      await fetch('/api/church/logout', { method: 'POST', credentials: 'include' });
    });
  } catch { /* noop */ }
  await page.context().clearCookies();
}

/**
 * Log in to the admin SPA. Stores the JWT in sessionStorage like LoginScreen does.
 * Returns the JWT.
 */
async function loginToAdmin(page) {
  requireAdminCreds();
  await page.goto('/admin/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('input[type="email"]', { timeout: 15_000 });
  await page.fill('input[type="email"]', ADMIN_EMAIL);
  await page.fill('input[type="password"]', ADMIN_PASSWORD);
  const [resp] = await Promise.all([
    page.waitForResponse(
      (r) => r.url().includes('/api/admin/login') && r.request().method() === 'POST',
      { timeout: 30_000 }
    ),
    page.click('button[type="submit"]'),
  ]);
  if (!resp.ok()) {
    throw new Error(`Admin login failed: ${resp.status()} ${await resp.text().catch(() => '')}`);
  }
  const body = await resp.json().catch(() => ({}));
  // Wait for the SPA to render the dashboard (sidebar nav)
  await page.waitForSelector('button, [role="navigation"]', { timeout: 15_000 });
  return body.token;
}

const test = base.extend({});

module.exports = {
  test,
  expect,
  loginToPortal,
  logoutFromPortal,
  loginToAdmin,
  requirePortalCreds,
  requireAdminCreds,
};
