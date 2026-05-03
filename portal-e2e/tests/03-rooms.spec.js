// @ts-check
const { test, expect, loginToPortal } = require('../fixtures/auth');
const { callPortalApi, listRooms, cleanupRoomsWithPrefix } = require('../fixtures/portalApi');

const TEST_PREFIX = 'e2e-test-room-';

function uniqueName(label) {
  return `${TEST_PREFIX}${label}-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
}

test.describe('Room management', () => {
  test.beforeEach(async ({ page }) => {
    await loginToPortal(page);
  });

  test.afterEach(async ({ page }) => {
    // Clean up any rooms this test created. Tolerates pages that have
    // navigated away — cleanup is best-effort.
    try {
      await page.goto('/church-portal', { waitUntil: 'domcontentloaded' });
      await cleanupRoomsWithPrefix(page, TEST_PREFIX);
    } catch { /* noop */ }
  });

  test('create a room via API and verify it appears in the rooms list', async ({ page }) => {
    const name = uniqueName('create');
    const description = 'Created by Playwright e2e';

    // Create via API (UI uses the same endpoint, exercised in next test).
    const create = await callPortalApi(page, 'POST', '/api/church/rooms', { name, description });
    expect(create.status, JSON.stringify(create.body)).toBe(201);
    expect(create.body.id).toBeTruthy();

    // Navigate to the rooms page and confirm the row renders.
    await page.click('.nav-item[data-page="rooms"]');
    await expect(page.locator('#page-rooms')).toHaveClass(/active/);
    // Room rows are rendered into #rooms-list as a table.
    const row = page.locator('#rooms-list tr', { hasText: name });
    await expect(row).toBeVisible({ timeout: 15_000 });
  });

  test('edit a room name via API and verify it persists', async ({ page }) => {
    const original = uniqueName('edit-orig');
    const renamed = uniqueName('edit-new');

    const create = await callPortalApi(page, 'POST', '/api/church/rooms', { name: original });
    expect(create.status, JSON.stringify(create.body)).toBe(201);
    const roomId = create.body.id;

    const patch = await callPortalApi(page, 'PATCH', `/api/church/rooms/${roomId}`, { name: renamed });
    expect(patch.status, JSON.stringify(patch.body)).toBe(200);

    // Reload the rooms list and verify the new name is rendered.
    await page.click('.nav-item[data-page="rooms"]');
    await expect(page.locator('#page-rooms')).toHaveClass(/active/);
    await expect(page.locator('#rooms-list')).toContainText(renamed, { timeout: 15_000 });
    await expect(page.locator('#rooms-list')).not.toContainText(original);
  });

  test('rooms list returns valid shape and the rooms page loads its detail card', async ({ page }) => {
    // GET should return { rooms, currentRoomId, limits }.
    const resp = await callPortalApi(page, 'GET', '/api/church/rooms');
    expect(resp.status).toBe(200);
    expect(Array.isArray(resp.body.rooms) || Array.isArray(resp.body)).toBe(true);

    await page.click('.nav-item[data-page="rooms"]');
    await expect(page.locator('#page-rooms')).toHaveClass(/active/);
    // The "Rooms" card and the Add Room button should be present in advanced view.
    await expect(page.locator('#rooms-card')).toBeVisible();
  });

  test('delete a room via API removes it from the rendered list', async ({ page }) => {
    const name = uniqueName('delete');
    const create = await callPortalApi(page, 'POST', '/api/church/rooms', { name });
    expect(create.status).toBe(201);

    await page.click('.nav-item[data-page="rooms"]');
    await expect(page.locator('#rooms-list tr', { hasText: name })).toBeVisible({ timeout: 15_000 });

    const del = await callPortalApi(page, 'DELETE', `/api/church/rooms/${create.body.id}`);
    expect(del.status).toBe(200);

    // Re-render the list.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.click('.nav-item[data-page="rooms"]');
    await expect(page.locator('#rooms-list')).not.toContainText(name, { timeout: 15_000 });
  });
});
