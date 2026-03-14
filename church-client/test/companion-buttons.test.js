const { describe, it, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const { CompanionBridge } = require('../src/companion');

/**
 * Helper: stub getButtonGrid to return controlled data without HTTP calls.
 */
function stubButtonGrid(bridge, gridByPage) {
  bridge.getButtonGrid = async (page) => {
    return gridByPage[page] || [];
  };
}

function makeButton(row, col, text, pressed = false, color = null) {
  return { row, col, text, color, pressed };
}

describe('CompanionBridge button state mirroring', () => {
  let bridge;

  beforeEach(() => {
    bridge = new CompanionBridge({ companionUrl: 'http://localhost:8888', buttonPollPages: [1] });
    bridge.connected = true; // pretend connected so pollButtonStates runs
  });

  describe('constructor', () => {
    it('initializes empty button state tracking', () => {
      const b = new CompanionBridge();
      const states = b.getButtonStates();
      assert.deepEqual(states, {});
      assert.deepEqual(b.getRecentButtonPresses(), []);
    });

    it('accepts custom buttonPollPages', () => {
      const b = new CompanionBridge({ buttonPollPages: [1, 2, 3] });
      assert.deepEqual(b._buttonPollPages, [1, 2, 3]);
    });
  });

  describe('pollButtonStates()', () => {
    it('populates button states from grid', async () => {
      stubButtonGrid(bridge, {
        1: [
          [makeButton(0, 0, 'Camera 1', false), makeButton(0, 1, 'Camera 2', true)],
          [makeButton(1, 0, '', false), makeButton(1, 1, 'Titles', false)],
        ],
      });

      await bridge.pollButtonStates();

      const states = bridge.getButtonStates();
      assert.equal(Object.keys(states).length, 4);
      assert.equal(states['1/0/0'].text, 'Camera 1');
      assert.equal(states['1/0/0'].pressed, false);
      assert.equal(states['1/0/1'].text, 'Camera 2');
      assert.equal(states['1/0/1'].pressed, true);
      assert.equal(states['1/0/1'].page, 1);
      assert.equal(states['1/0/1'].row, 0);
      assert.equal(states['1/0/1'].column, 1);
    });

    it('stores style/color info', async () => {
      stubButtonGrid(bridge, {
        1: [[makeButton(0, 0, 'Live', true, '#ff0000')]],
      });

      await bridge.pollButtonStates();
      const states = bridge.getButtonStates();
      assert.equal(states['1/0/0'].style, '#ff0000');
    });

    it('skips polling when not connected', async () => {
      bridge.connected = false;
      let called = false;
      bridge.getButtonGrid = async () => { called = true; return []; };

      await bridge.pollButtonStates();
      assert.equal(called, false);
    });

    it('handles getButtonGrid failure gracefully', async () => {
      bridge.getButtonGrid = async () => { throw new Error('API unavailable'); };

      // Should not throw
      await bridge.pollButtonStates();
      assert.deepEqual(bridge.getButtonStates(), {});
    });
  });

  describe('change detection and events', () => {
    it('emits companion_button_pressed when button transitions to pressed', async () => {
      stubButtonGrid(bridge, {
        1: [[makeButton(0, 0, 'Camera 1', false)]],
      });
      await bridge.pollButtonStates();

      const events = [];
      bridge.on('companion_button_pressed', (e) => events.push(e));

      // Now button becomes pressed
      stubButtonGrid(bridge, {
        1: [[makeButton(0, 0, 'Camera 1', true)]],
      });
      await bridge.pollButtonStates();

      assert.equal(events.length, 1);
      assert.equal(events[0].page, 1);
      assert.equal(events[0].row, 0);
      assert.equal(events[0].column, 0);
      assert.equal(events[0].text, 'Camera 1');
      assert.equal(events[0].pressed, true);
      assert.ok(events[0].timestamp > 0);
    });

    it('emits companion_button_released when button transitions to released', async () => {
      stubButtonGrid(bridge, {
        1: [[makeButton(0, 0, 'Camera 1', true)]],
      });
      await bridge.pollButtonStates();

      const events = [];
      bridge.on('companion_button_released', (e) => events.push(e));

      stubButtonGrid(bridge, {
        1: [[makeButton(0, 0, 'Camera 1', false)]],
      });
      await bridge.pollButtonStates();

      assert.equal(events.length, 1);
      assert.equal(events[0].pressed, false);
      assert.equal(events[0].text, 'Camera 1');
    });

    it('does not emit events when state is unchanged', async () => {
      stubButtonGrid(bridge, {
        1: [[makeButton(0, 0, 'Camera 1', true)]],
      });
      await bridge.pollButtonStates();

      const pressed = [];
      const released = [];
      bridge.on('companion_button_pressed', (e) => pressed.push(e));
      bridge.on('companion_button_released', (e) => released.push(e));

      // Poll again with same state
      await bridge.pollButtonStates();

      assert.equal(pressed.length, 0);
      assert.equal(released.length, 0);
    });

    it('emits pressed on first poll if button is already pressed', async () => {
      const events = [];
      bridge.on('companion_button_pressed', (e) => events.push(e));

      stubButtonGrid(bridge, {
        1: [[makeButton(0, 0, 'Live', true)]],
      });
      await bridge.pollButtonStates();

      assert.equal(events.length, 1);
      assert.equal(events[0].text, 'Live');
    });
  });

  describe('audit trail (recent button presses)', () => {
    it('records button press events', async () => {
      stubButtonGrid(bridge, {
        1: [[makeButton(0, 0, 'Camera 1', true)]],
      });
      await bridge.pollButtonStates();

      const recent = bridge.getRecentButtonPresses();
      assert.equal(recent.length, 1);
      assert.equal(recent[0].text, 'Camera 1');
      assert.ok(recent[0].timestamp > 0);
    });

    it('limits to 10 recent events by default', async () => {
      // Simulate 12 press/release cycles
      for (let i = 0; i < 12; i++) {
        stubButtonGrid(bridge, {
          1: [[makeButton(0, 0, `Button ${i}`, true)]],
        });
        await bridge.pollButtonStates();

        stubButtonGrid(bridge, {
          1: [[makeButton(0, 0, `Button ${i}`, false)]],
        });
        await bridge.pollButtonStates();
      }

      const recent = bridge.getRecentButtonPresses();
      assert.equal(recent.length, 10);
      // Oldest should be Button 2, newest Button 11
      assert.equal(recent[0].text, 'Button 2');
      assert.equal(recent[9].text, 'Button 11');
    });

    it('respects custom limit parameter', async () => {
      for (let i = 0; i < 5; i++) {
        stubButtonGrid(bridge, {
          1: [[makeButton(0, 0, `Btn ${i}`, true)]],
        });
        await bridge.pollButtonStates();
        stubButtonGrid(bridge, {
          1: [[makeButton(0, 0, `Btn ${i}`, false)]],
        });
        await bridge.pollButtonStates();
      }

      const recent = bridge.getRecentButtonPresses(3);
      assert.equal(recent.length, 3);
      assert.equal(recent[2].text, 'Btn 4');
    });

    it('returns copies of events (not references)', async () => {
      stubButtonGrid(bridge, {
        1: [[makeButton(0, 0, 'Test', true)]],
      });
      await bridge.pollButtonStates();

      const recent1 = bridge.getRecentButtonPresses();
      const recent2 = bridge.getRecentButtonPresses();
      assert.notEqual(recent1[0], recent2[0]);
      assert.deepEqual(recent1[0], recent2[0]);
    });
  });

  describe('getButtonStates()', () => {
    it('returns copies of state objects', async () => {
      stubButtonGrid(bridge, {
        1: [[makeButton(0, 0, 'Test', false)]],
      });
      await bridge.pollButtonStates();

      const s1 = bridge.getButtonStates();
      const s2 = bridge.getButtonStates();
      assert.notEqual(s1['1/0/0'], s2['1/0/0']);
      assert.deepEqual(s1['1/0/0'], s2['1/0/0']);
    });
  });

  describe('multi-page polling', () => {
    it('polls multiple pages', async () => {
      bridge._buttonPollPages = [1, 2];
      stubButtonGrid(bridge, {
        1: [[makeButton(0, 0, 'Page1Btn', true)]],
        2: [[makeButton(0, 0, 'Page2Btn', false)]],
      });

      await bridge.pollButtonStates();
      const states = bridge.getButtonStates();
      assert.equal(states['1/0/0'].text, 'Page1Btn');
      assert.equal(states['2/0/0'].text, 'Page2Btn');
    });
  });

  describe('getStatus() includes button data', () => {
    it('includes buttons section with tracked count', async () => {
      stubButtonGrid(bridge, {
        1: [
          [makeButton(0, 0, 'Cam 1', false), makeButton(0, 1, 'Cam 2', true)],
        ],
      });
      await bridge.pollButtonStates();

      const status = bridge.getStatus();
      assert.ok(status.buttons);
      assert.equal(status.buttons.tracked, 2);
      assert.equal(status.buttons.pressed.length, 1);
      assert.equal(status.buttons.pressed[0].text, 'Cam 2');
      assert.ok(Array.isArray(status.buttons.recentPresses));
    });

    it('returns empty buttons section when no polling has occurred', () => {
      const status = bridge.getStatus();
      assert.ok(status.buttons);
      assert.equal(status.buttons.tracked, 0);
      assert.deepEqual(status.buttons.pressed, []);
      assert.deepEqual(status.buttons.recentPresses, []);
    });
  });

  describe('startButtonPolling / stopButtonPolling', () => {
    it('starts and stops button polling timer', () => {
      bridge.startButtonPolling(5000);
      assert.ok(bridge._buttonPollTimer !== null);

      bridge.stopButtonPolling();
      assert.equal(bridge._buttonPollTimer, null);
    });

    it('stopPolling also stops button polling', () => {
      bridge.startButtonPolling(5000);
      assert.ok(bridge._buttonPollTimer !== null);

      bridge.stopPolling();
      assert.equal(bridge._buttonPollTimer, null);
      assert.equal(bridge._pollTimer, null);
    });
  });

  describe('connection failure handling', () => {
    it('handles missing API gracefully during button poll', async () => {
      bridge.getButtonGrid = async () => {
        const err = new Error('ECONNREFUSED');
        err.code = 'ECONNREFUSED';
        throw err;
      };

      await bridge.pollButtonStates();
      assert.deepEqual(bridge.getButtonStates(), {});
    });

    it('continues polling other pages when one page fails', async () => {
      bridge._buttonPollPages = [1, 2];
      let page2Called = false;
      bridge.getButtonGrid = async (page) => {
        if (page === 1) throw new Error('timeout');
        page2Called = true;
        return [[makeButton(0, 0, 'Working', false)]];
      };

      await bridge.pollButtonStates();
      assert.ok(page2Called);
      const states = bridge.getButtonStates();
      assert.equal(states['2/0/0'].text, 'Working');
    });
  });

  // ─── NEW: Multiple pages (3+) ──────────────────────────────────────────────

  describe('three or more pages', () => {
    it('polls 3 pages and tracks all button states independently', async () => {
      bridge._buttonPollPages = [1, 2, 3];
      stubButtonGrid(bridge, {
        1: [
          [makeButton(0, 0, 'Camera 1', true), makeButton(0, 1, 'Camera 2', false)],
          [makeButton(1, 0, 'Graphics', false), makeButton(1, 1, 'Lower Third', false)],
        ],
        2: [
          [makeButton(0, 0, 'Scene A', false), makeButton(0, 1, 'Scene B', true)],
        ],
        3: [
          [makeButton(0, 0, 'Audio 1', false), makeButton(0, 1, 'Audio 2', false)],
          [makeButton(1, 0, 'Master', true), makeButton(1, 1, 'Mute All', false)],
        ],
      });

      await bridge.pollButtonStates();
      const states = bridge.getButtonStates();

      // Page 1: 4 buttons
      assert.equal(states['1/0/0'].text, 'Camera 1');
      assert.equal(states['1/0/0'].pressed, true);
      assert.equal(states['1/1/1'].text, 'Lower Third');

      // Page 2: 2 buttons
      assert.equal(states['2/0/1'].text, 'Scene B');
      assert.equal(states['2/0/1'].pressed, true);

      // Page 3: 4 buttons
      assert.equal(states['3/1/0'].text, 'Master');
      assert.equal(states['3/1/0'].pressed, true);

      // Total tracked
      assert.equal(Object.keys(states).length, 10);
    });

    it('emits events from different pages independently', async () => {
      bridge._buttonPollPages = [1, 2, 3];
      stubButtonGrid(bridge, {
        1: [[makeButton(0, 0, 'Btn1', false)]],
        2: [[makeButton(0, 0, 'Btn2', false)]],
        3: [[makeButton(0, 0, 'Btn3', false)]],
      });
      await bridge.pollButtonStates();

      const events = [];
      bridge.on('companion_button_pressed', (e) => events.push(e));

      // Press buttons on pages 1 and 3, leave page 2 unchanged
      stubButtonGrid(bridge, {
        1: [[makeButton(0, 0, 'Btn1', true)]],
        2: [[makeButton(0, 0, 'Btn2', false)]],
        3: [[makeButton(0, 0, 'Btn3', true)]],
      });
      await bridge.pollButtonStates();

      assert.equal(events.length, 2);
      assert.equal(events[0].page, 1);
      assert.equal(events[0].text, 'Btn1');
      assert.equal(events[1].page, 3);
      assert.equal(events[1].text, 'Btn3');
    });

    it('handles 5 pages with mixed failures', async () => {
      bridge._buttonPollPages = [1, 2, 3, 4, 5];
      let callLog = [];
      bridge.getButtonGrid = async (page) => {
        callLog.push(page);
        if (page === 2 || page === 4) throw new Error('timeout');
        return [[makeButton(0, 0, `P${page}`, false)]];
      };

      await bridge.pollButtonStates();
      // All 5 pages should be attempted
      assert.deepEqual(callLog, [1, 2, 3, 4, 5]);
      // Only pages 1, 3, 5 should have states
      const states = bridge.getButtonStates();
      assert.equal(states['1/0/0'].text, 'P1');
      assert.equal(states['3/0/0'].text, 'P3');
      assert.equal(states['5/0/0'].text, 'P5');
      assert.equal(states['2/0/0'], undefined);
      assert.equal(states['4/0/0'], undefined);
    });
  });

  // ─── NEW: Rapid state changes ───────────────────────────────────────────────

  describe('rapid state changes', () => {
    it('detects rapid press-release-press cycle', async () => {
      const pressed = [];
      const released = [];
      bridge.on('companion_button_pressed', (e) => pressed.push(e));
      bridge.on('companion_button_released', (e) => released.push(e));

      // Initial: not pressed
      stubButtonGrid(bridge, { 1: [[makeButton(0, 0, 'Flash', false)]] });
      await bridge.pollButtonStates();

      // Press
      stubButtonGrid(bridge, { 1: [[makeButton(0, 0, 'Flash', true)]] });
      await bridge.pollButtonStates();
      assert.equal(pressed.length, 1);

      // Release
      stubButtonGrid(bridge, { 1: [[makeButton(0, 0, 'Flash', false)]] });
      await bridge.pollButtonStates();
      assert.equal(released.length, 1);

      // Press again
      stubButtonGrid(bridge, { 1: [[makeButton(0, 0, 'Flash', true)]] });
      await bridge.pollButtonStates();
      assert.equal(pressed.length, 2);

      // Release again
      stubButtonGrid(bridge, { 1: [[makeButton(0, 0, 'Flash', false)]] });
      await bridge.pollButtonStates();
      assert.equal(released.length, 2);
    });

    it('handles multiple buttons changing state simultaneously', async () => {
      stubButtonGrid(bridge, {
        1: [
          [makeButton(0, 0, 'A', false), makeButton(0, 1, 'B', true), makeButton(0, 2, 'C', false)],
        ],
      });
      await bridge.pollButtonStates();

      const pressed = [];
      const released = [];
      bridge.on('companion_button_pressed', (e) => pressed.push(e));
      bridge.on('companion_button_released', (e) => released.push(e));

      // Swap states: A pressed, B released, C pressed
      stubButtonGrid(bridge, {
        1: [
          [makeButton(0, 0, 'A', true), makeButton(0, 1, 'B', false), makeButton(0, 2, 'C', true)],
        ],
      });
      await bridge.pollButtonStates();

      assert.equal(pressed.length, 2);
      assert.equal(released.length, 1);
      assert.equal(pressed[0].text, 'A');
      assert.equal(pressed[1].text, 'C');
      assert.equal(released[0].text, 'B');
    });

    it('tracks rapid sequential presses in audit trail correctly', async () => {
      // Simulate 5 rapid press events on different buttons
      for (let i = 0; i < 5; i++) {
        stubButtonGrid(bridge, {
          1: [[makeButton(0, 0, `Rapid ${i}`, true)]],
        });
        await bridge.pollButtonStates();

        stubButtonGrid(bridge, {
          1: [[makeButton(0, 0, `Rapid ${i}`, false)]],
        });
        await bridge.pollButtonStates();
      }

      const recent = bridge.getRecentButtonPresses();
      assert.equal(recent.length, 5);
      // All events should have timestamps
      for (const event of recent) {
        assert.ok(event.timestamp > 0);
        assert.equal(event.pressed, true);
      }
    });
  });

  // ─── NEW: Button text changes ───────────────────────────────────────────────

  describe('button text changes', () => {
    it('updates text when button label changes between polls', async () => {
      stubButtonGrid(bridge, {
        1: [[makeButton(0, 0, 'OFF', false)]],
      });
      await bridge.pollButtonStates();
      assert.equal(bridge.getButtonStates()['1/0/0'].text, 'OFF');

      stubButtonGrid(bridge, {
        1: [[makeButton(0, 0, 'ON', false)]],
      });
      await bridge.pollButtonStates();
      assert.equal(bridge.getButtonStates()['1/0/0'].text, 'ON');
    });

    it('text change + press triggers pressed event with new text', async () => {
      stubButtonGrid(bridge, {
        1: [[makeButton(0, 0, 'Idle', false)]],
      });
      await bridge.pollButtonStates();

      const events = [];
      bridge.on('companion_button_pressed', (e) => events.push(e));

      stubButtonGrid(bridge, {
        1: [[makeButton(0, 0, 'Active', true)]],
      });
      await bridge.pollButtonStates();

      assert.equal(events.length, 1);
      assert.equal(events[0].text, 'Active');
    });
  });

  // ─── NEW: getStatus with pressed buttons across pages ─────────────────────

  describe('getStatus with multi-page pressed buttons', () => {
    it('reports pressed buttons from all pages', async () => {
      bridge._buttonPollPages = [1, 2, 3];
      stubButtonGrid(bridge, {
        1: [[makeButton(0, 0, 'Cam1', true)]],
        2: [[makeButton(0, 0, 'Scene1', false)]],
        3: [[makeButton(0, 0, 'Audio1', true), makeButton(0, 1, 'Audio2', true)]],
      });
      await bridge.pollButtonStates();

      const status = bridge.getStatus();
      assert.equal(status.buttons.tracked, 4);
      assert.equal(status.buttons.pressed.length, 3);

      const pressedTexts = status.buttons.pressed.map(p => p.text).sort();
      assert.deepEqual(pressedTexts, ['Audio1', 'Audio2', 'Cam1']);
    });
  });

  // ─── NEW: Color/style changes ─────────────────────────────────────────────

  describe('color/style tracking', () => {
    it('tracks color changes between polls', async () => {
      stubButtonGrid(bridge, {
        1: [[makeButton(0, 0, 'Status', false, '#00ff00')]],
      });
      await bridge.pollButtonStates();
      assert.equal(bridge.getButtonStates()['1/0/0'].style, '#00ff00');

      stubButtonGrid(bridge, {
        1: [[makeButton(0, 0, 'Status', false, '#ff0000')]],
      });
      await bridge.pollButtonStates();
      assert.equal(bridge.getButtonStates()['1/0/0'].style, '#ff0000');
    });

    it('null color is stored as null', async () => {
      stubButtonGrid(bridge, {
        1: [[makeButton(0, 0, 'NoColor', false, null)]],
      });
      await bridge.pollButtonStates();
      assert.equal(bridge.getButtonStates()['1/0/0'].style, null);
    });
  });
});
