// @ts-check
const { test, expect, loginToPortal } = require('../fixtures/auth');
const { callPortalApi, cleanupRoomsWithPrefix } = require('../fixtures/portalApi');

const TEST_PREFIX = 'e2e-test-equip-';

function uniqueName(label) {
  return `${TEST_PREFIX}${label}-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
}

/**
 * Build a representative equipment config touching every device type the
 * portal supports.
 */
function buildSampleEquipment() {
  return {
    atems: [{ ip: '192.0.2.10', role: 'primary', name: 'E2E ATEM' }],
    atemIp: '192.0.2.10',
    obsUrl: 'ws://localhost:4455',
    obsPassword: 'e2e-obs-test',
    companion: { host: '192.0.2.20', port: 8888 },
    companionUrl: 'http://192.0.2.20:8888',
    proPresenter: { host: '192.0.2.21', port: 1025 },
    videoHubs: [{ ip: '192.0.2.30', name: 'E2E Hub', port: 9990 }],
    mixer: { type: 'allenheath', host: '192.0.2.40', port: 51326 },
    encoders: [
      { encoderType: 'birddog', host: '192.0.2.50', port: 8080, name: 'E2E BirdDog' },
      { encoderType: 'teradek', host: '192.0.2.51', port: 80, name: 'E2E Teradek' },
    ],
    resolume: { host: '192.0.2.60', port: 8080 },
    tricaster: [{ host: '192.0.2.70', port: 5951, name: 'E2E TriCaster' }],
  };
}

test.describe('Equipment management', () => {
  let roomId;
  let roomName;

  test.beforeEach(async ({ page }) => {
    await loginToPortal(page);
    roomName = uniqueName('room');
    const create = await callPortalApi(page, 'POST', '/api/church/rooms', { name: roomName });
    expect(create.status, JSON.stringify(create.body)).toBe(201);
    roomId = create.body.id;
  });

  test.afterEach(async ({ page }) => {
    try {
      await page.goto('/church-portal', { waitUntil: 'domcontentloaded' });
      await cleanupRoomsWithPrefix(page, TEST_PREFIX);
    } catch { /* noop */ }
  });

  test('save equipment config with all device types and verify persistence', async ({ page }) => {
    const equipment = buildSampleEquipment();

    const put = await callPortalApi(page, 'PUT', '/api/church/config/equipment', {
      equipment,
      roomId,
    });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    expect(put.body.updatedAt).toBeTruthy();

    // Read back and assert each device type round-trips.
    const get = await callPortalApi(page, 'GET', `/api/church/config/equipment?roomId=${roomId}`);
    expect(get.status).toBe(200);
    const eq = get.body.equipment;

    expect(eq.atems?.[0]?.ip).toBe('192.0.2.10');
    expect(eq.obsUrl).toBe('ws://localhost:4455');
    expect(eq.companion?.host).toBe('192.0.2.20');
    expect(eq.proPresenter?.host).toBe('192.0.2.21');
    expect(eq.videoHubs?.[0]?.ip).toBe('192.0.2.30');
    expect(eq.mixer?.type).toBe('allenheath');
    expect(eq.mixer?.host).toBe('192.0.2.40');
    expect(eq.resolume?.host).toBe('192.0.2.60');
    expect(eq.tricaster?.[0]?.host).toBe('192.0.2.70');
    const encoderTypes = (eq.encoders || []).map((e) => e.encoderType).sort();
    expect(encoderTypes).toEqual(['birddog', 'teradek']);
  });

  test('edit a device config and verify the change persists', async ({ page }) => {
    const equipment = buildSampleEquipment();
    let put = await callPortalApi(page, 'PUT', '/api/church/config/equipment', { equipment, roomId });
    expect(put.status).toBe(200);

    // Mutate the ProPresenter host.
    equipment.proPresenter = { host: '192.0.2.99', port: 1025 };
    put = await callPortalApi(page, 'PUT', '/api/church/config/equipment', { equipment, roomId });
    expect(put.status).toBe(200);

    const get = await callPortalApi(page, 'GET', `/api/church/config/equipment?roomId=${roomId}`);
    expect(get.body.equipment.proPresenter.host).toBe('192.0.2.99');
  });

  test('remove a device by omitting it from the config', async ({ page }) => {
    const equipment = buildSampleEquipment();
    let put = await callPortalApi(page, 'PUT', '/api/church/config/equipment', { equipment, roomId });
    expect(put.status).toBe(200);

    // Drop one of the encoders.
    equipment.encoders = equipment.encoders.filter((e) => e.encoderType !== 'birddog');
    put = await callPortalApi(page, 'PUT', '/api/church/config/equipment', { equipment, roomId });
    expect(put.status).toBe(200);

    const get = await callPortalApi(page, 'GET', `/api/church/config/equipment?roomId=${roomId}`);
    const types = (get.body.equipment.encoders || []).map((e) => e.encoderType);
    expect(types).not.toContain('birddog');
    expect(types).toContain('teradek');
  });

  test('Equipment tab loads in the rooms page UI', async ({ page }) => {
    await page.click('.nav-item[data-page="rooms"]');
    await expect(page.locator('#page-rooms')).toHaveClass(/active/);
    // Switch to the Equipment subtab.
    await page.click('button[data-tab="tab-equipment"]');
    await expect(page.locator('#tab-equipment')).toHaveClass(/active/);
    // Either the form or the loading state must be present.
    await expect(
      page.locator('#equipment-form, #equipment-loading').first()
    ).toBeVisible({ timeout: 15_000 });
  });
});
