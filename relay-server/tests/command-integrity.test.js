/**
 * command-integrity.test.js
 *
 * Cross-layer validation tests that catch drift between:
 *   1. CMD_SIGS (what the AI is told exists)
 *   2. FALLBACK_COMMANDS (static safety net)
 *   3. commandHandlers (what actually executes)
 *   4. smartParse (fast-path routing)
 *
 * These tests don't need hardware — they verify the wiring is correct
 * so that when hardware IS connected, commands actually dispatch.
 */

import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { commandHandlers } = require('../../church-client/src/commands/index');
const { buildSystemPrompt, getAvailableCommandNames } = require('../src/ai-parser.js');
const { smartParse } = require('../src/smart-parser.js');

// ─── Helpers ─────────────────────────────────────────────────────────────────

const HANDLER_NAMES = Object.keys(commandHandlers).sort();

/**
 * Extract command names from a CMD_SIGS prompt string.
 * Matches patterns like: commandName(params) or commandName()
 * Prefixed by the device block header.
 */
function extractCommandNamesFromPrompt(prompt) {
  const names = new Set();
  // Match "device: cmd(..." or "device (label):\n  cmd(..."
  // The prompt has lines like:
  //   atem: cut(input:N), setPreview(input:N), ...
  //   atem (Fairlight audio ...):
  //     setFairlightAudioSourceProps(index:N,...)
  const blocks = prompt.split(/\n(?=\S)/);
  for (const block of blocks) {
    // Extract device prefix from header
    const headerMatch = block.match(/^(\w+)(?:\s*\([^)]*\))?:/);
    if (!headerMatch) continue;
    const device = headerMatch[1];
    // Skip non-device headers
    if (['AVAILABLE', 'OUTPUT', 'STREAMING', 'RECORDING', 'AUDIO', 'RULES', 'Classic', 'Single', 'Multi', 'If', 'When', 'Return', 'You', 'No'].includes(device)) continue;

    // Find all function-call patterns: name(...)
    const funcPattern = /(\w+)\(/g;
    let match;
    while ((match = funcPattern.exec(block)) !== null) {
      const funcName = match[1];
      // Skip generic words, enum values, and non-commands
      if (['bool', 'N', 'X', 'true', 'false', 'source', 'input', 'if', 'is', 'use', 'type',
           'command', 'params', 'steps', 'text', 'default', 'off', 'on', 'AFV'].includes(funcName)) continue;
      // Skip JSON example fragments
      if (funcName === 'atem' || funcName === 'camera' || funcName === 'mixer' ||
          funcName === 'obs' || funcName === 'vmix' || funcName === 'encoder' ||
          funcName === 'hyperdeck' || funcName === 'ptz' || funcName === 'videohub' ||
          funcName === 'propresenter' || funcName === 'resolume' || funcName === 'companion' ||
          funcName === 'blackmagic' || funcName === 'epiphan' || funcName === 'ecamm' ||
          funcName === 'aja' || funcName === 'ndi' || funcName === 'dante') continue;
      names.add(`${device}.${funcName}`);
    }
  }
  return [...names].sort();
}

// ─── 1. Every AI-advertised command has a real handler ───────────────────────

describe('AI-advertised commands all exist in handler registry', () => {
  const prompt = buildSystemPrompt({
    atem: { connected: true },
    obs: { connected: true },
    encoder: { connected: true },
    vmix: { connected: true },
    hyperdeck: { connected: true },
    mixer: { connected: true },
    proPresenter: { connected: true },
    resolume: { connected: true },
    ptz: [{ connected: true }],
    companion: { connected: true },
    ecamm: { connected: true },
    aja: { connected: true },
    epiphan: { connected: true },
    ndi: { connected: true },
    videohub: { connected: true },
    dante: { connected: true },
    webPresenter: { connected: true },
  });

  const advertisedNames = extractCommandNamesFromPrompt(prompt);

  // Some commands use special prefixes or aliases in the prompt
  const KNOWN_ALIASES = {
    'other.system': 'system.preServiceCheck',       // "other: system.preServiceCheck()"
    'other.status': 'status',                        // "other: status()"
    'preset.save': 'preset.save',
    'preset.list': 'preset.list',
    'preset.recall': 'preset.recall',
    'preset.delete': 'preset.delete',
    'preview.snap': 'preview.snap',
  };

  // Virtual commands handled by the dispatcher, not in commandHandlers
  const VIRTUAL_COMMANDS = new Set([
    'system.wait',                   // Handled inline by dispatch loop
    'other.preServiceCheck',         // Actually system.preServiceCheck, extracted oddly from "other: system.preServiceCheck()"
  ]);

  for (const name of advertisedNames) {
    if (VIRTUAL_COMMANDS.has(name)) continue;
    const resolved = KNOWN_ALIASES[name] || name;
    it(`"${name}" has a handler`, () => {
      expect(
        HANDLER_NAMES.includes(resolved),
        `AI signature advertises "${name}" (resolved: "${resolved}") but no handler exists.\nAvailable: ${HANDLER_NAMES.filter(h => h.startsWith(resolved.split('.')[0])).join(', ')}`
      ).toBe(true);
    });
  }
});

// ─── 2. FALLBACK_COMMANDS stays in sync with runtime registry ────────────────

describe('FALLBACK_COMMANDS vs runtime commandHandlers', () => {
  const runtimeNames = getAvailableCommandNames();

  it('runtime registry has handlers (monorepo require works)', () => {
    expect(runtimeNames.length).toBeGreaterThan(100);
  });

  it('every FALLBACK entry exists in the runtime handler registry', () => {
    // This catches stale entries left in FALLBACK after a handler is removed
    const missing = runtimeNames.filter(name => !HANDLER_NAMES.includes(name));
    // Allow system commands that aren't in the normal handler map
    const filtered = missing.filter(n => !['system.wait', 'system.preServiceCheck'].includes(n));
    expect(filtered, `Commands in AVAILABLE list but not in handlers: ${filtered.join(', ')}`).toEqual([]);
  });

  it('every runtime handler is in the AVAILABLE list', () => {
    // This catches handlers added to a domain file but not to FALLBACK_COMMANDS
    const missing = HANDLER_NAMES.filter(name => !runtimeNames.includes(name));
    expect(missing, `Handlers exist but not in AVAILABLE list: ${missing.join(', ')}`).toEqual([]);
  });
});

// ─── 3. Smart parser only emits commands that actually exist ─────────────────

describe('Smart parser commands are valid handler names', () => {
  const scenarios = [
    { text: 'go live', status: { atem: { connected: true } } },
    { text: 'go live', status: { encoder: { connected: true } } },
    { text: 'go live', status: { obs: { connected: true } } },
    { text: 'go live', status: { vmix: { connected: true } } },
    { text: 'stop streaming', status: { encoder: { connected: true } } },
    { text: 'start recording', status: { atem: { connected: true } } },
    { text: 'start recording', status: { obs: { connected: true } } },
    { text: 'start recording', status: { hyperdeck: { connected: true } } },
    { text: 'start recording', status: { encoder: { connected: true } } },
    { text: 'stop recording', status: { hyperdeck: { connected: true } } },
    { text: 'stop recording', status: { encoder: { connected: true } } },
    { text: 'stop streaming', status: { atem: { connected: true } } },
    { text: 'start recording', status: { vmix: { connected: true } } },
    { text: 'stop recording', status: { vmix: { connected: true } } },
    { text: 'mute headphone mix', status: { atem: { connected: true } } },
    { text: 'unmute headphone mix', status: { atem: { connected: true } } },
    { text: 'mute monitor', status: { atem: { connected: true } } },
    { text: 'unmute monitor output', status: { atem: { connected: true } } },
    { text: 'status', status: { atem: { connected: true } } },
    { text: "we're done", status: { atem: { connected: true, streaming: true, recording: true } } },
    { text: 'start all streams', status: { encoder: { connected: true }, obs: { connected: true } } },
    { text: 'stop all recordings', status: { obs: { connected: true }, hyperdeck: { connected: true } } },
  ];

  for (const { text, status } of scenarios) {
    it(`"${text}" → valid command(s)`, () => {
      const result = smartParse(text, status);
      if (!result || result.type === 'chat') return; // chat replies are fine

      if (result.type === 'command') {
        // preServiceCheck is a special system command
        if (result.command === 'preServiceCheck') return;
        expect(
          HANDLER_NAMES.includes(result.command),
          `Smart parser emitted "${result.command}" but no handler exists`
        ).toBe(true);
      }

      if (result.type === 'commands') {
        for (const step of result.steps) {
          expect(
            HANDLER_NAMES.includes(step.command),
            `Smart parser emitted "${step.command}" in multi-step but no handler exists`
          ).toBe(true);
        }
      }
    });
  }
});

// ─── 4. Handler functions have correct signatures ────────────────────────────

describe('Command handlers are valid async functions', () => {
  for (const [name, handler] of Object.entries(commandHandlers)) {
    it(`${name} is a function`, () => {
      expect(typeof handler).toBe('function');
    });
  }

  // Spot-check that critical handlers accept (agent, params)
  it('atem.cut handler has 2 parameters', () => {
    // async function atemCut(agent, params)
    expect(commandHandlers['atem.cut'].length).toBeLessThanOrEqual(2);
  });

  it('atem.setClassicAudioMonitorProps handler has 2 parameters', () => {
    expect(commandHandlers['atem.setClassicAudioMonitorProps'].length).toBeLessThanOrEqual(2);
  });

  it('camera.setIris handler has 2 parameters', () => {
    expect(commandHandlers['camera.setIris'].length).toBeLessThanOrEqual(2);
  });
});

// ─── 5. Critical command names aren't typo'd between layers ──────────────────

describe('Critical command name consistency across layers', () => {
  // These are the commands most likely to cause bugs if misnamed
  const criticalCommands = [
    // Headphone mute fix
    'atem.setClassicAudioMonitorProps',
    'atem.setClassicAudioHeadphonesProps',
    'atem.setClassicAudioResetPeaks',
    // Core switching
    'atem.cut',
    'atem.auto',
    'atem.setProgram',
    'atem.setPreview',
    'atem.fadeToBlack',
    // Streaming
    'atem.startStreaming',
    'atem.stopStreaming',
    'atem.startRecording',
    'atem.stopRecording',
    // Fairlight
    'atem.setFairlightAudioSourceProps',
    'atem.setFairlightAudioMasterProps',
    'atem.setFairlightAudioMonitorProps',
    // Camera
    'camera.setIris',
    'camera.autoFocus',
    'camera.resetColorCorrection',
    // Mixer
    'mixer.mute',
    'mixer.unmute',
    // OBS
    'obs.startStream',
    'obs.stopStream',
    // Encoder (generic)
    'encoder.startStream',
    'encoder.stopStream',
    'encoder.startRecording',
    'encoder.stopRecording',
    'encoder.status',
    // Blackmagic Web Presenter
    'blackmagic.getActivePlatform',
    'blackmagic.setActivePlatform',
    'blackmagic.getPlatforms',
    'blackmagic.getPlatformConfig',
    'blackmagic.getVideoFormat',
    'blackmagic.setVideoFormat',
    'blackmagic.getSupportedVideoFormats',
    'blackmagic.getAudioSources',
    'blackmagic.setAudioSource',
  ];

  const prompt = buildSystemPrompt({
    atem: { connected: true },
    mixer: { connected: true },
    obs: { connected: true },
    encoder: { connected: true },
    webPresenter: { connected: true },
  });

  for (const cmd of criticalCommands) {
    it(`"${cmd}" exists in handler registry`, () => {
      expect(HANDLER_NAMES).toContain(cmd);
    });

    // Check the signature name (without device prefix) appears in prompt
    const sigName = cmd.split('.').slice(1).join('.');
    it(`"${sigName}" appears in AI prompt`, () => {
      expect(prompt).toContain(sigName);
    });
  }
});

// ─── 6. No duplicate command registrations ───────────────────────────────────

describe('No duplicate command names', () => {
  it('handler names are unique', () => {
    const seen = new Set();
    const dupes = [];
    for (const name of HANDLER_NAMES) {
      if (seen.has(name)) dupes.push(name);
      seen.add(name);
    }
    expect(dupes, `Duplicate handlers: ${dupes.join(', ')}`).toEqual([]);
  });
});

// ─── 7. Device domain coverage — every device prefix has handlers ────────────

describe('Device domain coverage', () => {
  const expectedPrefixes = [
    'atem', 'camera', 'mixer', 'obs', 'vmix', 'hyperdeck',
    'ptz', 'propresenter', 'resolume', 'videohub',
    'encoder', 'companion', 'ecamm', 'aja', 'epiphan', 'ndi', 'dante',
    'blackmagic', 'preset', 'preview', 'status', 'system',
  ];

  for (const prefix of expectedPrefixes) {
    it(`"${prefix}" domain has at least one handler`, () => {
      const count = HANDLER_NAMES.filter(n => n === prefix || n.startsWith(`${prefix}.`)).length;
      expect(count, `No handlers found with prefix "${prefix}"`).toBeGreaterThan(0);
    });
  }
});

// ─── 8. Smart parser device priority is correct ──────────────────────────────

describe('Smart parser device priority', () => {
  // Streaming priority: encoder > obs > vmix > atem
  it('streaming: encoder beats obs', () => {
    const r = smartParse('go live', { encoder: { connected: true }, obs: { connected: true } });
    expect(r.command).toBe('encoder.startStream');
  });

  it('streaming: obs beats vmix', () => {
    const r = smartParse('go live', { obs: { connected: true }, vmix: { connected: true } });
    expect(r.command).toBe('obs.startStream');
  });

  it('streaming: vmix beats atem', () => {
    const r = smartParse('go live', { vmix: { connected: true }, atem: { connected: true } });
    expect(r.command).toBe('vmix.startStream');
  });

  // Recording priority: hyperdeck > atem > encoder > vmix > obs
  it('recording: hyperdeck beats atem', () => {
    const r = smartParse('start recording', { hyperdeck: { connected: true }, atem: { connected: true } });
    expect(r.command).toBe('hyperdeck.record');
  });

  it('recording: atem beats encoder', () => {
    const r = smartParse('start recording', { atem: { connected: true }, encoder: { connected: true } });
    expect(r.command).toBe('atem.startRecording');
  });

  it('recording: encoder beats vmix', () => {
    const r = smartParse('start recording', { encoder: { connected: true }, vmix: { connected: true } });
    expect(r.command).toBe('encoder.startRecording');
  });

  it('recording: vmix beats obs', () => {
    const r = smartParse('start recording', { vmix: { connected: true }, obs: { connected: true } });
    expect(r.command).toBe('vmix.startRecording');
  });
});

// ─── 9. End-of-service only stops things that are actually running ───────────

describe('End-of-service workflow correctness', () => {
  it('does NOT stop encoder stream if encoder is not streaming', () => {
    const r = smartParse("we're done", { encoder: { connected: true, live: false }, atem: { connected: true } });
    const cmds = r.steps.map(s => s.command);
    expect(cmds).not.toContain('encoder.stopStream');
  });

  it('does NOT stop OBS recording if OBS is not recording', () => {
    const r = smartParse("we're done", { obs: { connected: true, streaming: true, recording: false } });
    const cmds = r.steps.map(s => s.command);
    expect(cmds).toContain('obs.stopStream');
    expect(cmds).not.toContain('obs.stopRecording');
  });

  it('does NOT include stopRecording for device that is only streaming', () => {
    const r = smartParse("we're done", { atem: { connected: true, streaming: true, recording: false } });
    const cmds = r.steps.map(s => s.command);
    expect(cmds).toContain('atem.fadeToBlack');
    expect(cmds).toContain('atem.stopStreaming');
    expect(cmds).not.toContain('atem.stopRecording');
  });

  it('fadeToBlack is always the FIRST step when ATEM is connected', () => {
    const r = smartParse("we're done", {
      atem: { connected: true, streaming: true },
      obs: { connected: true, streaming: true },
    });
    expect(r.steps[0].command).toBe('atem.fadeToBlack');
  });
});

// ─── 10. Headphone mute: the original bug can't regress ─────────────────────

describe('Headphone mute regression guard', () => {
  const prompt = buildSystemPrompt({ atem: { connected: true } });

  it('AI prompt does NOT suggest using setClassicAudioHeadphonesProps for mute', () => {
    // The annotation should explicitly say "no mute here"
    const headphoneSection = prompt.substring(
      prompt.indexOf('setClassicAudioHeadphonesProps'),
      prompt.indexOf('setClassicAudioResetPeaks')
    );
    expect(headphoneSection).toContain('no mute here');
    expect(headphoneSection).not.toContain('mute:bool');
  });

  it('AI prompt does NOT suggest using setClassicAudioResetPeaks for unmute', () => {
    const resetSection = prompt.substring(
      prompt.indexOf('setClassicAudioResetPeaks'),
      prompt.indexOf('setClassicAudioResetPeaks') + 200
    );
    expect(resetSection).toContain('never use for unmute');
  });

  it('setClassicAudioMonitorProps IS the command with mute:bool', () => {
    const monitorSection = prompt.substring(
      prompt.indexOf('setClassicAudioMonitorProps'),
      prompt.indexOf('setClassicAudioHeadphonesProps')
    );
    expect(monitorSection).toContain('mute:bool');
    expect(monitorSection).toContain('mute/unmute headphone or monitor');
  });

  it('smart parser mute command produces params the handler can use', () => {
    const result = smartParse('mute headphone mix', { atem: { connected: true } });
    // Verify the params shape matches what the handler reads
    expect(result.params).toHaveProperty('mute');
    expect(typeof result.params.mute).toBe('boolean');
  });

  it('smart parser unmute command produces params the handler can use', () => {
    const result = smartParse('unmute headphones', { atem: { connected: true } });
    expect(result.params).toHaveProperty('mute');
    expect(result.params.mute).toBe(false);
  });
});

// ─── 11. Blackmagic Web Presenter / Encoder integrity ────────────────────────

describe('Blackmagic Web Presenter command integrity', () => {
  const BLACKMAGIC_COMMANDS = [
    'blackmagic.getActivePlatform',
    'blackmagic.setActivePlatform',
    'blackmagic.getPlatforms',
    'blackmagic.getPlatformConfig',
    'blackmagic.getVideoFormat',
    'blackmagic.setVideoFormat',
    'blackmagic.getSupportedVideoFormats',
    'blackmagic.getAudioSources',
    'blackmagic.setAudioSource',
  ];

  for (const cmd of BLACKMAGIC_COMMANDS) {
    it(`"${cmd}" exists in handler registry`, () => {
      expect(HANDLER_NAMES).toContain(cmd);
    });

    it(`"${cmd}" handler is a function`, () => {
      expect(typeof commandHandlers[cmd]).toBe('function');
    });
  }

  it('AI prompt includes all blackmagic signatures when webPresenter connected', () => {
    const prompt = buildSystemPrompt({ webPresenter: { connected: true } });
    for (const cmd of BLACKMAGIC_COMMANDS) {
      const sigName = cmd.split('.')[1];
      expect(prompt).toContain(sigName);
    }
  });

  it('AI prompt does NOT include blackmagic signatures when only encoder connected', () => {
    const prompt = buildSystemPrompt({ encoder: { connected: true } });
    expect(prompt).not.toContain('getActivePlatform');
    expect(prompt).not.toContain('blackmagic (Web Presenter)');
  });

  it('blackmagic handlers are under the correct domain prefix', () => {
    const blackmagicHandlers = HANDLER_NAMES.filter(n => n.startsWith('blackmagic.'));
    expect(blackmagicHandlers).toHaveLength(9);
  });
});

describe('Encoder generic command integrity', () => {
  const ENCODER_COMMANDS = [
    'encoder.startStream',
    'encoder.stopStream',
    'encoder.startRecording',
    'encoder.stopRecording',
    'encoder.status',
  ];

  for (const cmd of ENCODER_COMMANDS) {
    it(`"${cmd}" exists in handler registry`, () => {
      expect(HANDLER_NAMES).toContain(cmd);
    });

    it(`"${cmd}" handler is a function`, () => {
      expect(typeof commandHandlers[cmd]).toBe('function');
    });
  }

  it('AI prompt includes all encoder signatures when encoder connected', () => {
    const prompt = buildSystemPrompt({ encoder: { connected: true } });
    expect(prompt).toContain('encoder: startStream()');
    expect(prompt).toContain('stopStream()');
    expect(prompt).toContain('startRecording()');
    expect(prompt).toContain('stopRecording()');
    expect(prompt).toContain('status()');
  });

  it('encoder handlers are under the correct domain prefix', () => {
    const encoderHandlers = HANDLER_NAMES.filter(n => n.startsWith('encoder.'));
    expect(encoderHandlers).toHaveLength(5);
  });
});

// ─── 12. Encoder smart parser routing ────────────────────────────────────────

describe('Encoder smart parser routing', () => {
  it('"go live" with encoder only → encoder.startStream', () => {
    const r = smartParse('go live', { encoder: { connected: true } });
    expect(r.command).toBe('encoder.startStream');
  });

  it('"stop streaming" with encoder only → encoder.stopStream', () => {
    const r = smartParse('stop streaming', { encoder: { connected: true } });
    expect(r.command).toBe('encoder.stopStream');
  });

  it('"start recording" with encoder only → encoder.startRecording', () => {
    const r = smartParse('start recording', { encoder: { connected: true } });
    expect(r.command).toBe('encoder.startRecording');
  });

  it('"stop recording" with encoder only → encoder.stopRecording', () => {
    const r = smartParse('stop recording', { encoder: { connected: true } });
    expect(r.command).toBe('encoder.stopRecording');
  });

  it('encoder is highest streaming priority', () => {
    const r = smartParse('go live', {
      encoder: { connected: true },
      obs: { connected: true },
      vmix: { connected: true },
      atem: { connected: true },
    });
    expect(r.command).toBe('encoder.startStream');
  });

  it('encoder is 3rd recording priority (after hyperdeck, atem)', () => {
    // encoder beats vmix for recording
    const r1 = smartParse('start recording', { encoder: { connected: true }, vmix: { connected: true } });
    expect(r1.command).toBe('encoder.startRecording');

    // but hyperdeck beats encoder
    const r2 = smartParse('start recording', { encoder: { connected: true }, hyperdeck: { connected: true } });
    expect(r2.command).toBe('hyperdeck.record');

    // and atem beats encoder
    const r3 = smartParse('start recording', { encoder: { connected: true }, atem: { connected: true } });
    expect(r3.command).toBe('atem.startRecording');
  });

  it('end-of-service stops encoder stream when live', () => {
    const r = smartParse("we're done", { encoder: { connected: true, live: true } });
    const cmds = r.steps.map(s => s.command);
    expect(cmds).toContain('encoder.stopStream');
  });

  it('end-of-service stops encoder recording when recording', () => {
    const r = smartParse("we're done", { encoder: { connected: true, recording: true } });
    const cmds = r.steps.map(s => s.command);
    expect(cmds).toContain('encoder.stopRecording');
  });

  it('end-of-service does NOT stop encoder stream when idle', () => {
    const r = smartParse("we're done", { encoder: { connected: true, live: false } });
    // Should return chat since nothing is active
    if (r.type === 'chat') {
      expect(r.text).toMatch(/already stopped/i);
    } else {
      const cmds = r.steps.map(s => s.command);
      expect(cmds).not.toContain('encoder.stopStream');
    }
  });

  it('"start all streams" includes encoder', () => {
    const r = smartParse('start all streams', { encoder: { connected: true }, obs: { connected: true } });
    const cmds = r.steps.map(s => s.command);
    expect(cmds).toContain('encoder.startStream');
    expect(cmds).toContain('obs.startStream');
  });

  it('"start all recordings" includes encoder', () => {
    const r = smartParse('start all recordings', { encoder: { connected: true }, obs: { connected: true } });
    const cmds = r.steps.map(s => s.command);
    expect(cmds).toContain('encoder.startRecording');
    expect(cmds).toContain('obs.startRecording');
  });

  it('"are we live?" with encoder live → positive reply mentioning encoder', () => {
    const r = smartParse('are we live?', { encoder: { connected: true, live: true } });
    expect(r.type).toBe('chat');
    expect(r.text).toMatch(/yes/i);
    expect(r.text).toContain('encoder');
  });

  it('"are we live?" with encoder streaming → positive reply', () => {
    const r = smartParse('are we live?', { encoder: { connected: true, streaming: true } });
    expect(r.type).toBe('chat');
    expect(r.text).toMatch(/yes/i);
  });
});

// ─── 13. OBS command integrity ──────────────────────────────────────────────

describe('OBS command integrity', () => {
  const OBS_COMMANDS = [
    'obs.startStream', 'obs.stopStream', 'obs.startRecording', 'obs.stopRecording',
    'obs.setScene', 'obs.getScenes', 'obs.getInputList', 'obs.setInputVolume',
    'obs.setInputMute', 'obs.setTransition', 'obs.setTransitionDuration',
    'obs.getSourceFilters', 'obs.setSourceFilterEnabled', 'obs.setStudioMode',
    'obs.setPreviewScene', 'obs.toggleVirtualCam', 'obs.pauseRecording',
    'obs.resumeRecording', 'obs.getSceneItems', 'obs.setSceneItemEnabled',
    'obs.reduceBitrate', 'obs.configureMonitorStream',
  ];

  for (const cmd of OBS_COMMANDS) {
    it(`"${cmd}" exists in handler registry`, () => {
      expect(HANDLER_NAMES).toContain(cmd);
    });
  }

  it('OBS handler count is correct', () => {
    const obsHandlers = HANDLER_NAMES.filter(n => n.startsWith('obs.'));
    expect(obsHandlers.length).toBeGreaterThanOrEqual(22);
  });

  it('smart parser routes "go live" to obs.startStream', () => {
    const r = smartParse('go live', { obs: { connected: true } });
    expect(r.command).toBe('obs.startStream');
  });

  it('smart parser routes "start recording" to obs.startRecording', () => {
    const r = smartParse('start recording', { obs: { connected: true } });
    expect(r.command).toBe('obs.startRecording');
  });

  it('end-of-service stops OBS stream and recording', () => {
    const r = smartParse("we're done", { obs: { connected: true, streaming: true, recording: true } });
    const cmds = r.steps.map(s => s.command);
    expect(cmds).toContain('obs.stopStream');
    expect(cmds).toContain('obs.stopRecording');
  });
});

// ─── 14. vMix command integrity ─────────────────────────────────────────────

describe('vMix command integrity', () => {
  const VMIX_COMMANDS = [
    'vmix.status', 'vmix.startStream', 'vmix.stopStream', 'vmix.startRecording',
    'vmix.stopRecording', 'vmix.cut', 'vmix.fade', 'vmix.setPreview',
    'vmix.setProgram', 'vmix.listInputs', 'vmix.setVolume', 'vmix.mute',
    'vmix.unmute', 'vmix.isRunning', 'vmix.function', 'vmix.startPlaylist',
    'vmix.stopPlaylist', 'vmix.audioLevels', 'vmix.fadeToBlack',
    'vmix.setInputVolume', 'vmix.muteInput', 'vmix.unmuteInput',
    'vmix.overlayInput', 'vmix.overlayOff', 'vmix.setText', 'vmix.replay',
  ];

  for (const cmd of VMIX_COMMANDS) {
    it(`"${cmd}" exists in handler registry`, () => {
      expect(HANDLER_NAMES).toContain(cmd);
    });
  }

  it('vMix handler count is correct', () => {
    const vmixHandlers = HANDLER_NAMES.filter(n => n.startsWith('vmix.'));
    expect(vmixHandlers.length).toBeGreaterThanOrEqual(27);
  });

  it('smart parser routes "go live" to vmix.startStream', () => {
    const r = smartParse('go live', { vmix: { connected: true } });
    expect(r.command).toBe('vmix.startStream');
  });

  it('end-of-service stops vMix stream and recording', () => {
    const r = smartParse("we're done", { vmix: { connected: true, streaming: true, recording: true } });
    const cmds = r.steps.map(s => s.command);
    expect(cmds).toContain('vmix.stopStream');
    expect(cmds).toContain('vmix.stopRecording');
  });
});

// ─── 15. HyperDeck command integrity ────────────────────────────────────────

describe('HyperDeck command integrity', () => {
  const HD_COMMANDS = [
    'hyperdeck.play', 'hyperdeck.stop', 'hyperdeck.record', 'hyperdeck.stopRecord',
    'hyperdeck.nextClip', 'hyperdeck.prevClip', 'hyperdeck.status',
    'hyperdeck.selectSlot', 'hyperdeck.setPlaySpeed', 'hyperdeck.goToClip',
    'hyperdeck.goToTimecode', 'hyperdeck.jog',
  ];

  for (const cmd of HD_COMMANDS) {
    it(`"${cmd}" exists in handler registry`, () => {
      expect(HANDLER_NAMES).toContain(cmd);
    });
  }

  it('HyperDeck handler count is 12', () => {
    const hdHandlers = HANDLER_NAMES.filter(n => n.startsWith('hyperdeck.'));
    expect(hdHandlers).toHaveLength(12);
  });

  it('smart parser routes "start recording" to hyperdeck.record', () => {
    const r = smartParse('start recording', { hyperdeck: { connected: true } });
    expect(r.command).toBe('hyperdeck.record');
  });

  it('smart parser routes "stop recording" to hyperdeck.stop', () => {
    const r = smartParse('stop recording', { hyperdeck: { connected: true } });
    expect(r.command).toBe('hyperdeck.stop');
  });
});

// ─── 16. PTZ command integrity ──────────────────────────────────────────────

describe('PTZ command integrity', () => {
  const PTZ_COMMANDS = [
    'ptz.pan', 'ptz.tilt', 'ptz.zoom', 'ptz.preset', 'ptz.stop', 'ptz.home',
    'ptz.setPreset', 'ptz.autoFocus', 'ptz.manualFocus', 'ptz.focusNear',
    'ptz.focusFar', 'ptz.focusStop', 'ptz.autoWhiteBalance',
    'ptz.indoorWhiteBalance', 'ptz.outdoorWhiteBalance', 'ptz.onePushWb',
    'ptz.backlightComp',
  ];

  for (const cmd of PTZ_COMMANDS) {
    it(`"${cmd}" exists in handler registry`, () => {
      expect(HANDLER_NAMES).toContain(cmd);
    });
  }

  it('PTZ handler count is 17', () => {
    const ptzHandlers = HANDLER_NAMES.filter(n => n.startsWith('ptz.'));
    expect(ptzHandlers).toHaveLength(17);
  });
});

// ─── 17. Camera control (via ATEM) integrity ────────────────────────────────

describe('Camera control integrity', () => {
  const CAM_COMMANDS = [
    'camera.setIris', 'camera.autoIris', 'camera.setGain', 'camera.setISO',
    'camera.setWhiteBalance', 'camera.autoWhiteBalance', 'camera.setShutter',
    'camera.setFocus', 'camera.autoFocus', 'camera.setLift', 'camera.setGamma',
    'camera.setColorGain', 'camera.setContrast', 'camera.setSaturation',
    'camera.resetColorCorrection',
  ];

  for (const cmd of CAM_COMMANDS) {
    it(`"${cmd}" exists in handler registry`, () => {
      expect(HANDLER_NAMES).toContain(cmd);
    });
  }

  it('Camera handler count >= 15', () => {
    const camHandlers = HANDLER_NAMES.filter(n => n.startsWith('camera.'));
    expect(camHandlers.length).toBeGreaterThanOrEqual(15);
  });

  it('Camera sigs require ATEM connection (not standalone)', () => {
    const prompt = buildSystemPrompt({ obs: { connected: true } });
    expect(prompt).not.toContain('camera: setIris');
    const prompt2 = buildSystemPrompt({ atem: { connected: true } });
    expect(prompt2).toContain('camera: setIris');
  });
});

// ─── 18. ProPresenter command integrity ─────────────────────────────────────

describe('ProPresenter command integrity', () => {
  const PP_COMMANDS = [
    'propresenter.next', 'propresenter.previous', 'propresenter.goToSlide',
    'propresenter.status', 'propresenter.playlist', 'propresenter.clearAll',
    'propresenter.clearSlide', 'propresenter.stageMessage', 'propresenter.clearMessage',
    'propresenter.getLooks', 'propresenter.setLook', 'propresenter.getTimers',
    'propresenter.startTimer', 'propresenter.stopTimer', 'propresenter.version',
    'propresenter.messages',
  ];

  for (const cmd of PP_COMMANDS) {
    it(`"${cmd}" exists in handler registry`, () => {
      expect(HANDLER_NAMES).toContain(cmd);
    });
  }

  it('ProPresenter handler count >= 16', () => {
    const ppHandlers = HANDLER_NAMES.filter(n => n.startsWith('propresenter.'));
    expect(ppHandlers.length).toBeGreaterThanOrEqual(16);
  });
});

// ─── 19. Resolume command integrity ─────────────────────────────────────────

describe('Resolume command integrity', () => {
  const RES_COMMANDS = [
    'resolume.playClip', 'resolume.stopClip', 'resolume.triggerColumn',
    'resolume.clearAll', 'resolume.setBpm', 'resolume.getBpm',
    'resolume.setLayerOpacity', 'resolume.setMasterOpacity',
    'resolume.getLayers', 'resolume.getColumns', 'resolume.isRunning',
    'resolume.version', 'resolume.status', 'resolume.playClipByName',
    'resolume.triggerColumnByName',
  ];

  for (const cmd of RES_COMMANDS) {
    it(`"${cmd}" exists in handler registry`, () => {
      expect(HANDLER_NAMES).toContain(cmd);
    });
  }

<<<<<<< Updated upstream
  it('Resolume handler count >= 15', () => {
    const resHandlers = HANDLER_NAMES.filter(n => n.startsWith('resolume.'));
    expect(resHandlers.length).toBeGreaterThanOrEqual(15);
  });
});

// ─── 20. Videohub command integrity ─────────────────────────────────────────

describe('Videohub command integrity', () => {
  const VH_COMMANDS = [
    'videohub.route', 'videohub.getRoutes', 'videohub.setInputLabel',
    'videohub.setOutputLabel', 'videohub.getInputLabels', 'videohub.getOutputLabels',
  ];

  for (const cmd of VH_COMMANDS) {
    it(`"${cmd}" exists in handler registry`, () => {
      expect(HANDLER_NAMES).toContain(cmd);
    });
  }

  it('Videohub handler count >= 6', () => {
    const vhHandlers = HANDLER_NAMES.filter(n => n.startsWith('videohub.'));
    expect(vhHandlers.length).toBeGreaterThanOrEqual(6);
  });
});

// ─── 21. Mixer command integrity ────────────────────────────────────────────

describe('Mixer command integrity', () => {
  const MIXER_COMMANDS = [
    'mixer.status', 'mixer.mute', 'mixer.unmute', 'mixer.channelStatus',
    'mixer.recallScene', 'mixer.clearSolos', 'mixer.setFader',
    'mixer.setChannelName', 'mixer.setHpf', 'mixer.setEq', 'mixer.setCompressor',
    'mixer.setGate', 'mixer.saveScene', 'mixer.setPreampGain', 'mixer.setPhantom',
    'mixer.setPan', 'mixer.setChannelColor', 'mixer.setChannelIcon',
    'mixer.setSendLevel', 'mixer.assignToBus', 'mixer.assignToDca',
    'mixer.getMeters', 'mixer.capabilities', 'mixer.muteDca', 'mixer.unmuteDca',
    'mixer.setDcaFader', 'mixer.activateMuteGroup', 'mixer.deactivateMuteGroup',
    'mixer.pressSoftKey',
  ];

  for (const cmd of MIXER_COMMANDS) {
    it(`"${cmd}" exists in handler registry`, () => {
      expect(HANDLER_NAMES).toContain(cmd);
    });
  }

  it('Mixer handler count >= 28', () => {
    const mixerHandlers = HANDLER_NAMES.filter(n => n.startsWith('mixer.'));
    expect(mixerHandlers.length).toBeGreaterThanOrEqual(28);
  });
});

// ─── 22. Companion command integrity ────────────────────────────────────────

describe('Companion command integrity', () => {
  const COMP_COMMANDS = [
    'companion.press', 'companion.pressNamed', 'companion.getGrid', 'companion.connections',
    'companion.getVariable', 'companion.getCustomVariable', 'companion.setCustomVariable',
    'companion.watchVariable', 'companion.getWatchedVariables',
  ];

  for (const cmd of COMP_COMMANDS) {
    it(`"${cmd}" exists in handler registry`, () => {
      expect(HANDLER_NAMES).toContain(cmd);
    });
  }

  it('Companion handler count is 9', () => {
    const compHandlers = HANDLER_NAMES.filter(n => n.startsWith('companion.'));
    expect(compHandlers).toHaveLength(9);
  });
});

// ─── 23. Dante command integrity ────────────────────────────────────────────

describe('Dante command integrity', () => {
  it('"dante.scene" exists in handler registry', () => {
    expect(HANDLER_NAMES).toContain('dante.scene');
  });

  it('Dante handler count is 1', () => {
    const danteHandlers = HANDLER_NAMES.filter(n => n.startsWith('dante.'));
    expect(danteHandlers).toHaveLength(1);
  });
});

// ─── 24. AJA HELO command integrity ─────────────────────────────────────────

describe('AJA HELO command integrity', () => {
  const AJA_COMMANDS = [
    'aja.setVideoInput', 'aja.setAudioInput', 'aja.setStreamProfile',
    'aja.setRecordProfile', 'aja.setMute', 'aja.recallPreset',
  ];

  for (const cmd of AJA_COMMANDS) {
    it(`"${cmd}" exists in handler registry`, () => {
      expect(HANDLER_NAMES).toContain(cmd);
    });
  }

  it('AJA handler count is 6', () => {
    const ajaHandlers = HANDLER_NAMES.filter(n => n.startsWith('aja.'));
    expect(ajaHandlers).toHaveLength(6);
  });
});

// ─── 25. Epiphan Pearl command integrity ────────────────────────────────────

describe('Epiphan Pearl command integrity', () => {
  const EP_COMMANDS = [
    'epiphan.startPublisher', 'epiphan.stopPublisher', 'epiphan.getLayouts',
    'epiphan.setActiveLayout', 'epiphan.getStreamingParams', 'epiphan.setStreamingParams',
  ];

  for (const cmd of EP_COMMANDS) {
    it(`"${cmd}" exists in handler registry`, () => {
      expect(HANDLER_NAMES).toContain(cmd);
    });
  }

  it('Epiphan handler count is 6', () => {
    const epHandlers = HANDLER_NAMES.filter(n => n.startsWith('epiphan.'));
    expect(epHandlers).toHaveLength(6);
  });
});

// ─── 26. Ecamm Live command integrity ───────────────────────────────────────

describe('Ecamm Live command integrity', () => {
  const ECAMM_COMMANDS = [
    'ecamm.togglePause', 'ecamm.getScenes', 'ecamm.setScene', 'ecamm.nextScene',
    'ecamm.prevScene', 'ecamm.toggleMute', 'ecamm.getInputs', 'ecamm.setInput',
    'ecamm.togglePIP', 'ecamm.getOverlays',
  ];

  for (const cmd of ECAMM_COMMANDS) {
    it(`"${cmd}" exists in handler registry`, () => {
      expect(HANDLER_NAMES).toContain(cmd);
    });
  }

  it('Ecamm handler count is 10', () => {
    const ecammHandlers = HANDLER_NAMES.filter(n => n.startsWith('ecamm.'));
    expect(ecammHandlers).toHaveLength(10);
  });
});

// ─── 27. NDI command integrity ──────────────────────────────────────────────

describe('NDI command integrity', () => {
  const NDI_COMMANDS = ['ndi.getSource', 'ndi.setSource'];

  for (const cmd of NDI_COMMANDS) {
    it(`"${cmd}" exists in handler registry`, () => {
      expect(HANDLER_NAMES).toContain(cmd);
    });
  }

  it('NDI handler count is 2', () => {
    const ndiHandlers = HANDLER_NAMES.filter(n => n.startsWith('ndi.'));
    expect(ndiHandlers).toHaveLength(2);
  });
});

// ─── 28. Always-present commands (preset, preview, system) ──────────────────

describe('Always-present command integrity', () => {
  const PRESET_COMMANDS = ['preset.save', 'preset.list', 'preset.recall', 'preset.delete'];
  const PREVIEW_COMMANDS = ['preview.snap'];
  const SYSTEM_COMMANDS = ['system.preServiceCheck'];

  for (const cmd of [...PRESET_COMMANDS, ...PREVIEW_COMMANDS, ...SYSTEM_COMMANDS]) {
    it(`"${cmd}" exists in handler registry`, () => {
      expect(HANDLER_NAMES).toContain(cmd);
    });
  }

  it('preset handlers count is 4', () => {
    const presetHandlers = HANDLER_NAMES.filter(n => n.startsWith('preset.'));
    expect(presetHandlers).toHaveLength(4);
  });

  it('always-present sigs appear regardless of device config', () => {
    const prompt = buildSystemPrompt({ obs: { connected: true } });
    expect(prompt).toContain('preset: save(name:X)');
    expect(prompt).toContain('preview: snap()');
    expect(prompt).toContain('system.preServiceCheck()');
    expect(prompt).toContain('wait(seconds:N)');
  });
});

// ─── 29. Smart parser routing for all streaming/recording devices ───────────

describe('Smart parser routing covers all streaming devices', () => {
  const STREAM_DEVICES = [
    { status: { encoder: { connected: true } }, start: 'encoder.startStream', stop: 'encoder.stopStream' },
    { status: { obs: { connected: true } },     start: 'obs.startStream',     stop: 'obs.stopStream' },
    { status: { vmix: { connected: true } },    start: 'vmix.startStream',    stop: 'vmix.stopStream' },
    { status: { atem: { connected: true } },    start: 'atem.startStreaming',  stop: 'atem.stopStreaming' },
  ];

  for (const { status, start, stop } of STREAM_DEVICES) {
    const device = Object.keys(status)[0];
    it(`"go live" with ${device} → ${start}`, () => {
      expect(smartParse('go live', status).command).toBe(start);
    });
    it(`"stop streaming" with ${device} → ${stop}`, () => {
      expect(smartParse('stop streaming', status).command).toBe(stop);
    });
  }
});

describe('Smart parser routing covers all recording devices', () => {
  const RECORD_DEVICES = [
    { status: { hyperdeck: { connected: true } }, start: 'hyperdeck.record',       stop: 'hyperdeck.stop' },
    { status: { atem: { connected: true } },      start: 'atem.startRecording',    stop: 'atem.stopRecording' },
    { status: { encoder: { connected: true } },   start: 'encoder.startRecording', stop: 'encoder.stopRecording' },
    { status: { vmix: { connected: true } },      start: 'vmix.startRecording',    stop: 'vmix.stopRecording' },
    { status: { obs: { connected: true } },       start: 'obs.startRecording',     stop: 'obs.stopRecording' },
  ];

  for (const { status, start, stop } of RECORD_DEVICES) {
    const device = Object.keys(status)[0];
    it(`"start recording" with ${device} → ${start}`, () => {
      expect(smartParse('start recording', status).command).toBe(start);
    });
    it(`"stop recording" with ${device} → ${stop}`, () => {
      expect(smartParse('stop recording', status).command).toBe(stop);
    });
  }
});
