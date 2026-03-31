export const colors = {
  // Backgrounds
  bg: '#0a0a0a',
  surface: '#1a1a1a',
  surfaceElevated: '#222222',
  border: '#2a2a2a',
  borderLight: '#333333',

  // Text
  text: '#ffffff',
  textSecondary: '#999999',
  textMuted: '#666666',

  // Tally
  tallyProgram: '#ef4444',
  tallyPreview: '#22c55e',
  tallyOff: '#333333',

  // Status
  online: '#22c55e',
  offline: '#ef4444',
  warning: '#f59e0b',
  info: '#3b82f6',

  // Severity
  emergency: '#dc2626',
  critical: '#ef4444',
  warningAlert: '#f59e0b',
  infoAlert: '#3b82f6',

  // Brand
  accent: '#6366f1',
  accentLight: '#818cf8',

  // Stream
  live: '#ef4444',
  liveGlow: 'rgba(239, 68, 68, 0.2)',

  // Misc
  white: '#ffffff',
  black: '#000000',
  transparent: 'transparent',
} as const;

export type ColorName = keyof typeof colors;
