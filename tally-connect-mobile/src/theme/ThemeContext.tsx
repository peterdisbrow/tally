import React, { createContext, useContext, useEffect, useState, useMemo } from 'react';
import { useColorScheme } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

// ─── Color Palettes ─────────────────────────────────────────────────────────

export interface ThemeColors {
  // Backgrounds
  bg: string;
  surface: string;
  surfaceElevated: string;
  border: string;
  borderLight: string;

  // Text
  text: string;
  textSecondary: string;
  textMuted: string;

  // Tally
  tallyProgram: string;
  tallyPreview: string;
  tallyOff: string;

  // Status
  online: string;
  offline: string;
  warning: string;
  info: string;

  // Severity
  emergency: string;
  critical: string;
  warningAlert: string;
  infoAlert: string;

  // Brand
  accent: string;
  accentLight: string;

  // Stream
  live: string;
  liveGlow: string;

  // Misc
  white: string;
  black: string;
  transparent: string;

  // Theme-specific
  isDark: boolean;
  statusBarStyle: 'light' | 'dark';
  overlayBg: string;
  inputBg: string;
  cardShadowOpacity: number;
  trackColor: string;
}

export const darkColors: ThemeColors = {
  bg: '#050508',
  surface: '#111116',
  surfaceElevated: '#1a1a22',
  border: '#222230',
  borderLight: '#333344',

  text: '#ffffff',
  textSecondary: '#8888a0',
  textMuted: '#555568',

  tallyProgram: '#ef4444',
  tallyPreview: '#00E676',
  tallyOff: '#333333',

  online: '#00E676',
  offline: '#ef4444',
  warning: '#f59e0b',
  info: '#3b82f6',

  emergency: '#dc2626',
  critical: '#ef4444',
  warningAlert: '#f59e0b',
  infoAlert: '#3b82f6',

  accent: '#00E676',
  accentLight: '#69F0AE',

  live: '#ef4444',
  liveGlow: 'rgba(239, 68, 68, 0.2)',

  white: '#ffffff',
  black: '#000000',
  transparent: 'transparent',

  isDark: true,
  statusBarStyle: 'light',
  overlayBg: 'rgba(0,0,0,0.6)',
  inputBg: '#050508',
  cardShadowOpacity: 0.3,
  trackColor: 'rgba(255,255,255,0.06)',
};

export const lightColors: ThemeColors = {
  bg: '#f2f2f7',
  surface: '#ffffff',
  surfaceElevated: '#ffffff',
  border: '#e5e5ea',
  borderLight: '#d1d1d6',

  text: '#000000',
  textSecondary: '#6b7280',
  textMuted: '#9ca3af',

  tallyProgram: '#ef4444',
  tallyPreview: '#00E676',
  tallyOff: '#e5e5ea',

  online: '#00C853',
  offline: '#dc2626',
  warning: '#d97706',
  info: '#2563eb',

  emergency: '#dc2626',
  critical: '#dc2626',
  warningAlert: '#d97706',
  infoAlert: '#2563eb',

  accent: '#00E676',
  accentLight: '#00C853',

  live: '#dc2626',
  liveGlow: 'rgba(220, 38, 38, 0.15)',

  white: '#ffffff',
  black: '#000000',
  transparent: 'transparent',

  isDark: false,
  statusBarStyle: 'dark',
  overlayBg: 'rgba(0,0,0,0.4)',
  inputBg: '#f2f2f7',
  cardShadowOpacity: 0.08,
  trackColor: 'rgba(0,0,0,0.06)',
};

// ─── Context ────────────────────────────────────────────────────────────────

export type ThemePreference = 'system' | 'light' | 'dark';

interface ThemeContextType {
  colors: ThemeColors;
  preference: ThemePreference;
  setPreference: (pref: ThemePreference) => void;
  isDark: boolean;
}

const THEME_STORAGE_KEY = 'theme:preference';

const ThemeContext = createContext<ThemeContextType>({
  colors: darkColors,
  preference: 'system',
  setPreference: () => {},
  isDark: true,
});

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const systemColorScheme = useColorScheme();
  const [preference, setPreferenceState] = useState<ThemePreference>('system');
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    AsyncStorage.getItem(THEME_STORAGE_KEY)
      .then((val) => {
        if (val === 'light' || val === 'dark' || val === 'system') {
          setPreferenceState(val);
        }
      })
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, []);

  const setPreference = (pref: ThemePreference) => {
    setPreferenceState(pref);
    AsyncStorage.setItem(THEME_STORAGE_KEY, pref).catch(() => {});
  };

  const isDark = useMemo(() => {
    if (preference === 'system') return systemColorScheme !== 'light';
    return preference === 'dark';
  }, [preference, systemColorScheme]);

  const colors = isDark ? darkColors : lightColors;

  const value = useMemo(
    () => ({ colors, preference, setPreference, isDark }),
    [colors, preference, isDark],
  );

  // Don't render until we've loaded the stored preference to avoid flash
  if (!loaded) return null;

  return (
    <ThemeContext.Provider value={value}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeContext);
}

export function useThemeColors() {
  return useContext(ThemeContext).colors;
}
