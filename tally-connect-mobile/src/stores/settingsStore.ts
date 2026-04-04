import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';

const ALERT_SOUNDS_KEY = 'settings:alertSounds';
const VIEW_MODE_KEY = 'settings:viewMode';
const LANGUAGE_KEY = 'settings:language';

export type ViewMode = 'simple' | 'advanced';
export type AppLanguage = 'en' | 'es';

interface SettingsState {
  alertSounds: boolean;
  viewMode: ViewMode;
  language: AppLanguage;
  _loaded: boolean;
  loadSettings: () => Promise<void>;
  setAlertSounds: (enabled: boolean) => void;
  setViewMode: (mode: ViewMode) => void;
  setLanguage: (lang: AppLanguage) => void;
}

export const useSettingsStore = create<SettingsState>((set) => ({
  alertSounds: true,
  viewMode: 'simple',
  language: 'en',
  _loaded: false,

  loadSettings: async () => {
    try {
      const [soundsVal, modeVal, langVal] = await Promise.all([
        AsyncStorage.getItem(ALERT_SOUNDS_KEY),
        AsyncStorage.getItem(VIEW_MODE_KEY),
        AsyncStorage.getItem(LANGUAGE_KEY),
      ]);
      const updates: Partial<SettingsState> = {};
      if (soundsVal !== null) updates.alertSounds = soundsVal === 'true';
      if (modeVal === 'simple' || modeVal === 'advanced') updates.viewMode = modeVal;
      if (langVal === 'en' || langVal === 'es') updates.language = langVal;
      set(updates);
    } catch {
      // Use defaults
    }
    set({ _loaded: true });
  },

  setAlertSounds: (enabled) => {
    set({ alertSounds: enabled });
    AsyncStorage.setItem(ALERT_SOUNDS_KEY, String(enabled)).catch(() => {});
  },

  setViewMode: (mode) => {
    set({ viewMode: mode });
    AsyncStorage.setItem(VIEW_MODE_KEY, mode).catch(() => {});
  },

  setLanguage: (lang) => {
    set({ language: lang });
    AsyncStorage.setItem(LANGUAGE_KEY, lang).catch(() => {});
  },
}));
