/**
 * Tally Electron App — Comprehensive E2E Tests
 *
 * Uses Playwright's Electron support to launch the real app
 * and exercise window creation, security, IPC, and UI flows.
 *
 * All tests share a single Electron instance to avoid repeated
 * launch/teardown overhead and port conflicts.
 */
const { test, expect } = require('playwright/test');
const { launchApp, closeApp, EXPECTED_API_METHODS } = require('./helpers');

/** @type {import('playwright').ElectronApplication} */
let electronApp;
/** @type {import('playwright').Page} */
let page;

// ─── Shared lifecycle: launch once, close once ──────────────────────────────

test.beforeAll(async () => {
  ({ electronApp, page } = await launchApp());
  // Allow the renderer init() to run (token validation, view routing, etc.)
  await page.waitForTimeout(3000);
});

test.afterAll(async () => {
  await closeApp(electronApp);
});

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 1: App Launch & Window
// ─────────────────────────────────────────────────────────────────────────────
test.describe('App Launch & Window', () => {
  test('app launches successfully', async () => {
    expect(electronApp).toBeTruthy();
  });

  test('window is created and visible', async () => {
    const isVisible = await electronApp.evaluate(async ({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      return win ? win.isVisible() : false;
    });
    expect(isVisible).toBe(true);
  });

  test('window has correct title', async () => {
    const title = await page.title();
    // The HTML <title> is "Tally Connect"
    expect(title).toContain('Tally');
  });

  test('window has expected dimensions', async () => {
    const { width, height } = await electronApp.evaluate(async ({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      const bounds = win.getBounds();
      return { width: bounds.width, height: bounds.height };
    });
    // Main.js sets width: 580, height: 820, minWidth: 520, minHeight: 720
    expect(width).toBeGreaterThanOrEqual(520);
    expect(height).toBeGreaterThanOrEqual(720);
  });

  test('context isolation is enabled', async () => {
    const hasRequire = await page.evaluate(() => typeof window.require);
    expect(hasRequire).toBe('undefined');
  });

  test('electronAPI is exposed on window object', async () => {
    const hasApi = await page.evaluate(() => typeof window.electronAPI);
    expect(hasApi).toBe('object');
  });

  test('only one BrowserWindow exists', async () => {
    const count = await electronApp.evaluate(async ({ BrowserWindow }) => {
      return BrowserWindow.getAllWindows().length;
    });
    expect(count).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 2: Security
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Security', () => {
  test('window.require is undefined (nodeIntegration is off)', async () => {
    const result = await page.evaluate(() => typeof window.require);
    expect(result).toBe('undefined');
  });

  test('window.process is undefined (context isolation works)', async () => {
    const result = await page.evaluate(() => typeof window.process);
    expect(result).toBe('undefined');
  });

  test('window.module is undefined (sandbox enabled)', async () => {
    const result = await page.evaluate(() => typeof window.module);
    expect(result).toBe('undefined');
  });

  test('electronAPI does not expose ipcRenderer directly', async () => {
    const apiKeys = await page.evaluate(() => Object.keys(window.electronAPI).sort());
    expect(apiKeys).not.toContain('ipcRenderer');
    expect(apiKeys).not.toContain('send');
    expect(apiKeys).not.toContain('invoke');
    expect(apiKeys).not.toContain('on');
  });

  test('electronAPI exposes at least the expected method set', async () => {
    const apiKeys = await page.evaluate(() => Object.keys(window.electronAPI).sort());
    const expected = [...EXPECTED_API_METHODS].sort();
    for (const key of expected) {
      expect(apiKeys).toContain(key);
    }
  });

  test('all electronAPI members are functions', async () => {
    const types = await page.evaluate(() => {
      const result = {};
      for (const key of Object.keys(window.electronAPI)) {
        result[key] = typeof window.electronAPI[key];
      }
      return result;
    });
    for (const [key, type] of Object.entries(types)) {
      expect(type, `electronAPI.${key} should be a function`).toBe('function');
    }
  });

  test('webPreferences has contextIsolation enabled', async () => {
    const contextIsolation = await electronApp.evaluate(async ({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      return win.webContents.getLastWebPreferences().contextIsolation;
    });
    expect(contextIsolation).toBe(true);
  });

  test('webPreferences has sandbox enabled', async () => {
    const sandbox = await electronApp.evaluate(async ({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      return win.webContents.getLastWebPreferences().sandbox;
    });
    expect(sandbox).toBe(true);
  });

  test('webPreferences has nodeIntegration disabled', async () => {
    const nodeIntegration = await electronApp.evaluate(async ({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      return win.webContents.getLastWebPreferences().nodeIntegration;
    });
    expect(nodeIntegration).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 3: IPC — Config Management
// ─────────────────────────────────────────────────────────────────────────────
test.describe('IPC -- Config Management', () => {
  test('getConfig() returns an object', async () => {
    const config = await page.evaluate(() => window.electronAPI.getConfig());
    expect(config).toBeTruthy();
    expect(typeof config).toBe('object');
  });

  test('getConfig() does not expose raw sensitive tokens', async () => {
    const config = await page.evaluate(() => window.electronAPI.getConfig());
    // loadConfigForUI deletes these keys and replaces with *Set booleans
    const rawSensitive = ['youtubeApiKey', 'facebookAccessToken', 'rtmpStreamKey', 'twitchStreamKey', 'obsPassword', 'churchToken'];
    for (const field of rawSensitive) {
      expect(config).not.toHaveProperty(field);
    }
  });

  test('saveConfig() persists a value and getConfig() returns it', async () => {
    const testName = `e2e-test-${Date.now()}`;
    await page.evaluate((name) => window.electronAPI.saveConfig({ name }), testName);
    const config = await page.evaluate(() => window.electronAPI.getConfig());
    expect(config.name).toBe(testName);
  });

  test('getStatus() returns a status object with core keys', async () => {
    const status = await page.evaluate(() => window.electronAPI.getStatus());
    expect(status).toBeTruthy();
    expect(typeof status).toBe('object');
    expect(status).toHaveProperty('relay');
    expect(status).toHaveProperty('atem');
  });

  test('isRunning() returns a boolean', async () => {
    const running = await page.evaluate(() => window.electronAPI.isRunning());
    expect(typeof running).toBe('boolean');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 4: IPC — Equipment Management
// ─────────────────────────────────────────────────────────────────────────────
test.describe('IPC -- Equipment Management', () => {
  test('getEquipment() returns an object', async () => {
    const equip = await page.evaluate(() => window.electronAPI.getEquipment());
    expect(equip).toBeTruthy();
    expect(typeof equip).toBe('object');
  });

  test('saveEquipment() and getEquipment() round-trip', async () => {
    const original = await page.evaluate(() => window.electronAPI.getEquipment());
    const testIp = '10.0.0.42';
    await page.evaluate((ip) => window.electronAPI.saveEquipment({ atemIp: ip }), testIp);

    const updated = await page.evaluate(() => window.electronAPI.getEquipment());
    expect(updated.atemIp).toBe(testIp);

    // Restore original value
    if (original.atemIp !== undefined) {
      await page.evaluate((ip) => window.electronAPI.saveEquipment({ atemIp: ip }), original.atemIp);
    }
  });

  test('getNetworkInterfaces() returns an array', async () => {
    const interfaces = await page.evaluate(() => window.electronAPI.getNetworkInterfaces());
    expect(Array.isArray(interfaces)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 5: UI — View Routing
// ─────────────────────────────────────────────────────────────────────────────
test.describe('UI -- View Routing', () => {
  test('one of the three main views is active', async () => {
    const activeView = await page.evaluate(() => {
      const signIn = document.getElementById('sign-in');
      const wizard = document.getElementById('wizard');
      const dashboard = document.getElementById('dashboard');
      return {
        signIn: signIn ? signIn.classList.contains('active') : false,
        wizard: wizard ? wizard.classList.contains('active') : false,
        dashboard: dashboard ? dashboard.classList.contains('active') : false,
      };
    });
    const anyActive = activeView.signIn || activeView.wizard || activeView.dashboard;
    expect(anyActive).toBe(true);
  });

  test('all three view containers exist in DOM', async () => {
    await expect(page.locator('#sign-in')).toHaveCount(1);
    await expect(page.locator('#wizard')).toHaveCount(1);
    await expect(page.locator('#dashboard')).toHaveCount(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 6: UI — Sign-in Screen Elements
// ─────────────────────────────────────────────────────────────────────────────
test.describe('UI -- Sign-in Screen Elements', () => {
  test('email and password fields exist', async () => {
    await expect(page.locator('#si-email')).toHaveCount(1);
    await expect(page.locator('#si-password')).toHaveCount(1);
  });

  test('email input has type="email"', async () => {
    const type = await page.locator('#si-email').getAttribute('type');
    expect(type).toBe('email');
  });

  test('password input has type="password"', async () => {
    const type = await page.locator('#si-password').getAttribute('type');
    expect(type).toBe('password');
  });

  test('sign-in button exists', async () => {
    await expect(page.locator('#si-btn')).toHaveCount(1);
  });

  test('sign-in screen does not expose relay URL field', async () => {
    await expect(page.locator('#sign-in code')).toHaveCount(0);
    await expect(page.locator('#sign-in input[id*="relay"]')).toHaveCount(0);
  });

  test('create account link exists', async () => {
    const link = page.locator('#sign-in .ext-link');
    const count = await link.count();
    expect(count).toBeGreaterThanOrEqual(1);
  });

  test('sign-in message area exists for error display', async () => {
    await expect(page.locator('#si-message')).toHaveCount(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 7: UI — Dashboard Structure
// ─────────────────────────────────────────────────────────────────────────────
test.describe('UI -- Dashboard Structure', () => {
  test('dashboard element exists in DOM', async () => {
    await expect(page.locator('#dashboard')).toHaveCount(1);
  });

  test('dashboard has STATUS, EQUIPMENT, and TALLY ENGINEER tabs', async () => {
    const tabTexts = await page.locator('#dashboard .tab-btn').allTextContents();
    const normalized = tabTexts.map((t) => t.trim().toUpperCase());
    expect(normalized).toContain('STATUS');
    expect(normalized).toContain('EQUIPMENT');
    expect(normalized).toContain('TALLY ENGINEER');
  });

  test('dashboard has status chip dots for Relay, ATEM, Encoder, Companion', async () => {
    await expect(page.locator('#dot-relay')).toHaveCount(1);
    await expect(page.locator('#dot-atem')).toHaveCount(1);
    await expect(page.locator('#dot-encoder')).toHaveCount(1);
    await expect(page.locator('#dot-companion')).toHaveCount(1);
  });

  test('status tab content area exists', async () => {
    await expect(page.locator('#tab-status')).toHaveCount(1);
  });

  test('equipment tab content area exists', async () => {
    await expect(page.locator('#tab-equipment')).toHaveCount(1);
  });

  test('engineer tab content area exists', async () => {
    await expect(page.locator('#tab-engineer')).toHaveCount(1);
  });

  test('LIVE badge element exists', async () => {
    await expect(page.locator('#live-badge')).toHaveCount(1);
  });

  test('activity log exists in status tab', async () => {
    await expect(page.locator('#alerts-log')).toHaveCount(1);
  });

  test('ATEM info cards exist in status tab', async () => {
    await expect(page.locator('#val-atem-model')).toHaveCount(1);
    await expect(page.locator('#val-program')).toHaveCount(1);
    await expect(page.locator('#val-preview')).toHaveCount(1);
  });

  test('encoder info cards exist in status tab', async () => {
    await expect(page.locator('#val-stream')).toHaveCount(1);
    await expect(page.locator('#val-fps')).toHaveCount(1);
    await expect(page.locator('#val-bitrate')).toHaveCount(1);
  });

});

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 8: UI — Equipment Tab Structure
// ─────────────────────────────────────────────────────────────────────────────
test.describe('UI -- Equipment Tab Structure', () => {
  test.beforeAll(async () => {
    await page.evaluate(async () => {
      if (typeof loadEquipment === 'function') await loadEquipment();
    });
  });

  test('equipment catalog and scan controls exist', async () => {
    await expect(page.locator('#equip-catalog')).toHaveCount(1);
    await expect(page.locator('#scan-nic')).toHaveCount(1);
    await expect(page.locator('#scan-btn')).toHaveCount(1);
  });

  test('encoder config exposes expected encoder options after expanding Streaming Encoder', async () => {
    await page.evaluate(() => {
      if (typeof expandDeviceCard === 'function') expandDeviceCard('encoder');
    });
    const options = await page.locator('select[data-device="encoder"][data-field="encoderType"] option').allTextContents();
    const normalized = options.map((o) => o.trim().toLowerCase());
    expect(normalized).toContain('obs studio');
    expect(normalized).toContain('blackmagic web presenter / streaming encoder');
    expect(normalized).toContain('atem mini (built-in streaming)');
  });

  test('ATEM card exposes IP field after expanding', async () => {
    await page.evaluate(() => {
      if (typeof expandDeviceCard === 'function') expandDeviceCard('atem');
    });
    await expect(page.locator('input[data-device="atem"][data-field="ip"]')).toHaveCount(1);
  });

  test('Companion card exposes host and port fields after expanding', async () => {
    await page.evaluate(() => {
      if (typeof expandDeviceCard === 'function') expandDeviceCard('companion');
    });
    await expect(page.locator('input[data-device="companion"][data-field="host"]')).toHaveCount(1);
    await expect(page.locator('input[data-device="companion"][data-field="port"]')).toHaveCount(1);
  });

  test('Save Equipment Config button exists', async () => {
    const saveBtn = page.locator('#tab-equipment button', { hasText: 'Save Equipment Config' });
    await expect(saveBtn).toHaveCount(1);
  });

  test('equipment catalog categories exist: Core, Recording, Presentation, Audio', async () => {
    const catTexts = await page.locator('#equip-catalog .equip-catalog-category-title').allTextContents();
    const normalized = catTexts.map((t) => t.trim().toUpperCase());
    expect(normalized).toContain('CORE');
    expect(normalized).toContain('RECORDING & PLAYBACK');
    expect(normalized).toContain('PRESENTATION & VIDEO');
    expect(normalized).toContain('AUDIO');
  });

  test('mixer type dropdown exists after expanding Audio Console', async () => {
    await page.evaluate(() => {
      if (typeof expandDeviceCard === 'function') expandDeviceCard('mixer');
    });
    await expect(page.locator('select[data-device="mixer"][data-field="type"]')).toHaveCount(1);
  });

  test('NDI decoder is NOT in the encoder dropdown', async () => {
    await page.evaluate(() => {
      if (typeof expandDeviceCard === 'function') expandDeviceCard('encoder');
    });
    const options = await page.locator('select[data-device="encoder"][data-field="encoderType"] option').allTextContents();
    const normalized = options.map((o) => o.trim().toLowerCase());
    expect(normalized).not.toContain('ndi decoder (monitor)');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 9: UI — Chat Tab Structure
// ─────────────────────────────────────────────────────────────────────────────
test.describe('UI -- Chat Tab Structure', () => {
  test('chat messages container exists', async () => {
    await expect(page.locator('#chat-messages')).toHaveCount(1);
  });

  test('chat input field exists', async () => {
    await expect(page.locator('#chat-input')).toHaveCount(1);
  });

  test('chat send button exists', async () => {
    const sendBtn = page.locator('#tab-engineer button', { hasText: 'Send' });
    await expect(sendBtn).toHaveCount(1);
  });

  test('chat input has placeholder text', async () => {
    const placeholder = await page.locator('#chat-input').getAttribute('placeholder');
    expect(placeholder).toBeTruthy();
    expect(placeholder.toLowerCase()).toContain('tally engineer');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 10: UI — Wizard Structure
// ─────────────────────────────────────────────────────────────────────────────
test.describe('UI -- Wizard Structure', () => {
  test('wizard element exists in DOM', async () => {
    await expect(page.locator('#wizard')).toHaveCount(1);
  });

  test('wizard has 4 progress stages', async () => {
    const stages = await page.locator('#wizard .ob-stage').count();
    expect(stages).toBe(4);
  });

  test('stage 1 is gear', async () => {
    const text = await page.locator('#wizard .ob-stage[data-stage="gear"]').textContent();
    expect(text).toContain('Gear');
  });

  test('stage 2 is schedule', async () => {
    const text = await page.locator('#wizard .ob-stage[data-stage="schedule"]').textContent();
    expect(text).toContain('Schedule');
  });

  test('stage 3 is team', async () => {
    const text = await page.locator('#wizard .ob-stage[data-stage="tds"]').textContent();
    expect(text).toContain('Team');
  });

  test('stage 4 is stream', async () => {
    const text = await page.locator('#wizard .ob-stage[data-stage="stream"]').textContent();
    expect(text).toContain('Stream');
  });

  test('wizard chat input exists', async () => {
    await expect(page.locator('#ob-input')).toHaveCount(1);
  });

  test('wizard messages container exists', async () => {
    await expect(page.locator('#ob-messages')).toHaveCount(1);
  });

  test('wizard scroll container exists', async () => {
    await expect(page.locator('#ob-scroll')).toHaveCount(1);
  });

  test('wizard send button exists', async () => {
    await expect(page.locator('#ob-send')).toHaveCount(1);
  });

  test('wizard progress bar exists', async () => {
    await expect(page.locator('#ob-progress')).toHaveCount(1);
  });

  test('wizard skip link exists', async () => {
    await expect(page.locator('.ob-skip a')).toHaveCount(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 11: Main Process Behavior
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Main Process', () => {
  test('app name is set', async () => {
    const name = await electronApp.evaluate(async ({ app }) => app.getName());
    // In dev mode Electron returns "Electron"; in packaged builds it returns the productName.
    // Either is valid — just verify it returns a non-empty string.
    expect(typeof name).toBe('string');
    expect(name.length).toBeGreaterThan(0);
  });

  test('app version is a valid semver string', async () => {
    const version = await electronApp.evaluate(async ({ app }) => app.getVersion());
    // In dev mode this is the Electron version; in packaged builds it is the package version.
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
  });

  test('window.close is intercepted (minimize to tray)', async () => {
    const countBefore = await electronApp.evaluate(async ({ BrowserWindow }) => {
      return BrowserWindow.getAllWindows().length;
    });

    // close() is intercepted by the app — it hides instead of destroying
    await electronApp.evaluate(async ({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      win.close();
    });

    const countAfter = await electronApp.evaluate(async ({ BrowserWindow }) => {
      return BrowserWindow.getAllWindows().length;
    });
    expect(countAfter).toBe(countBefore);
  });

  test('window can be shown again after hide', async () => {
    await electronApp.evaluate(async ({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      win.show();
    });

    const isVisible = await electronApp.evaluate(async ({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      return win.isVisible();
    });
    expect(isVisible).toBe(true);
  });
});
