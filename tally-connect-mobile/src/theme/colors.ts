export const colors = {
  // Backgrounds
  bg: '#050508',
  surface: '#111116',
  surfaceElevated: '#1a1a22',
  border: '#222230',
  borderLight: '#333344',

  // Text
  text: '#ffffff',
  textSecondary: '#8888a0',
  textMuted: '#555568',

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
  accent: '#22c55e',
  accentLight: '#4ade80',

  // Stream
  live: '#ef4444',
  liveGlow: 'rgba(239, 68, 68, 0.2)',

  // Misc
  white: '#ffffff',
  black: '#000000',
  transparent: 'transparent',
} as const;

export type ColorName = keyof typeof colors;
