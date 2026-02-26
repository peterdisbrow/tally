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
    // The HTML <title> is "Tally by ATEM School"
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

  test('electronAPI exposes exactly the expected method set', async () => {
    const apiKeys = await page.evaluate(() => Object.keys(window.electronAPI).sort());
    const expected = [...EXPECTED_API_METHODS].sort();
    expect(apiKeys).toEqual(expected);
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

  test('sign-in screen shows relay URL', async () => {
    const relayText = await page.locator('#sign-in code').textContent();
    expect(relayText).toContain('wss://');
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

  test('dashboard has STATUS, EQUIPMENT, and CHAT tabs', async () => {
    const tabTexts = await page.locator('#dashboard .tab-btn').allTextContents();
    const normalized = tabTexts.map((t) => t.trim().toUpperCase());
    expect(normalized).toContain('STATUS');
    expect(normalized).toContain('EQUIPMENT');
    expect(normalized).toContain('CHAT');
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

  test('chat tab content area exists', async () => {
    await expect(page.locator('#tab-chat')).toHaveCount(1);
  });

  test('LIVE badge element exists', async () => {
    await expect(page.locator('#live-badge')).toHaveCount(1);
  });

  test('preview container exists in status tab', async () => {
    await expect(page.locator('#preview-container')).toHaveCount(1);
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

  test('NDI status section exists in DOM (hidden by default)', async () => {
    await expect(page.locator('#ndi-status-section')).toHaveCount(1);
    await expect(page.locator('#val-ndi-source')).toHaveCount(1);
    await expect(page.locator('#val-ndi-resolution')).toHaveCount(1);
    await expect(page.locator('#val-ndi-fps')).toHaveCount(1);
    await expect(page.locator('#val-ndi-codec')).toHaveCount(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 8: UI — Equipment Tab Structure
// ─────────────────────────────────────────────────────────────────────────────
test.describe('UI -- Equipment Tab Structure', () => {
  test('encoder type dropdown exists', async () => {
    await expect(page.locator('#equip-encoder-type')).toHaveCount(1);
  });

  test('encoder type dropdown has OBS, Blackmagic and ATEM Mini options', async () => {
    const options = await page.locator('#equip-encoder-type option').allTextContents();
    const normalized = options.map((o) => o.trim().toLowerCase());
    expect(normalized).toContain('obs studio');
    expect(normalized).toContain('blackmagic web presenter / streaming encoder');
    expect(normalized).toContain('atem mini (built-in streaming)');
  });

  test('ATEM IP field exists', async () => {
    await expect(page.locator('#equip-atem-ip')).toHaveCount(1);
  });

  test('companion URL field exists', async () => {
    await expect(page.locator('#equip-companion-url')).toHaveCount(1);
  });

  test('Save Equipment Config button exists', async () => {
    const saveBtn = page.locator('#tab-equipment button', { hasText: 'Save Equipment Config' });
    await expect(saveBtn).toHaveCount(1);
  });

  test('equipment groups exist: Core, Recording, Presentation, Monitoring, Audio', async () => {
    await expect(page.locator('.equip-group[data-group="core"]')).toHaveCount(1);
    await expect(page.locator('.equip-group[data-group="recording"]')).toHaveCount(1);
    await expect(page.locator('.equip-group[data-group="presentation"]')).toHaveCount(1);
    await expect(page.locator('.equip-group[data-group="monitoring"]')).toHaveCount(1);
    await expect(page.locator('.equip-group[data-group="audio"]')).toHaveCount(1);
  });

  test('mixer type dropdown exists in audio group', async () => {
    await expect(page.locator('#equip-mixer-type')).toHaveCount(1);
  });

  test('NDI decoder section exists in monitoring group', async () => {
    await expect(page.locator('#btn-add-ndi')).toHaveCount(1);
  });

  test('NDI decoder is NOT in the encoder dropdown', async () => {
    const options = await page.locator('#equip-encoder-type option').allTextContents();
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
    const sendBtn = page.locator('#tab-chat button', { hasText: 'Send' });
    await expect(sendBtn).toHaveCount(1);
  });

  test('chat input has placeholder text', async () => {
    const placeholder = await page.locator('#chat-input').getAttribute('placeholder');
    expect(placeholder).toBeTruthy();
    expect(placeholder.toLowerCase()).toContain('message');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 10: UI — Wizard Structure
// ─────────────────────────────────────────────────────────────────────────────
test.describe('UI -- Wizard Structure', () => {
  test('wizard element exists in DOM', async () => {
    await expect(page.locator('#wizard')).toHaveCount(1);
  });

  test('wizard has 4 steps', async () => {
    const steps = await page.locator('#wizard .wizard-step').count();
    expect(steps).toBe(4);
  });

  test('step 1 is ATEM discovery', async () => {
    const text = await page.locator('#wizard .wizard-step[data-step="1"]').textContent();
    expect(text).toContain('ATEM');
  });

  test('step 2 is encoder selection', async () => {
    const text = await page.locator('#wizard .wizard-step[data-step="2"]').textContent();
    expect(text).toContain('Encoder');
  });

  test('step 3 is optional devices', async () => {
    const text = await page.locator('#wizard .wizard-step[data-step="3"]').textContent();
    expect(text).toContain('Companion');
  });

  test('step 4 is completion', async () => {
    const text = await page.locator('#wizard .wizard-step[data-step="4"]').textContent();
    expect(text).toContain('All Set');
  });

  test('wizard ATEM IP input exists', async () => {
    await expect(page.locator('#wiz-atem')).toHaveCount(1);
  });

  test('wizard encoder type dropdown exists', async () => {
    await expect(page.locator('#wiz-encoder-type')).toHaveCount(1);
  });

  test('wizard network interface selector exists', async () => {
    await expect(page.locator('#wiz-scan-nic')).toHaveCount(1);
  });

  test('wizard auto-discover button exists', async () => {
    await expect(page.locator('#btn-scan')).toHaveCount(1);
  });

  test('wizard Next button exists', async () => {
    await expect(page.locator('#wiz-next')).toHaveCount(1);
  });

  test('wizard Back button exists', async () => {
    await expect(page.locator('#wiz-back')).toHaveCount(1);
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
