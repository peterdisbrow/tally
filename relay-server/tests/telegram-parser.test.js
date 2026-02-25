import { describe, it, expect } from 'vitest';

import telegramBotModule from '../src/telegramBot.js';

const { parseCommand } = telegramBotModule;

describe('telegramBot parseCommand', () => {
  it('routes explicit vMix preview commands to vmix.setPreview', () => {
    const parsed = parseCommand('vmix set preview to input 3');
    expect(parsed).toEqual({
      command: 'vmix.setPreview',
      params: { input: 3 },
    });
  });

  it('routes vMix program commands to vmix.setProgram', () => {
    const parsed = parseCommand('vMix set program to input 4');
    expect(parsed).toEqual({
      command: 'vmix.setProgram',
      params: { input: 4 },
    });
  });

  it('still parses ATEM preview commands with leading conversational text', () => {
    const parsed = parseCommand('please set preview to camera 2');
    expect(parsed).toEqual({
      command: 'atem.setPreview',
      params: { input: 2 },
    });
  });

  it('parses encoder control commands', () => {
    const parsed = parseCommand('start encoder stream');
    expect(parsed).toEqual({
      command: 'encoder.startStream',
      params: {},
    });
  });
});
