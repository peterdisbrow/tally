import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';

const ALERT_SOUNDS_KEY = 'settings:alertSounds';

interface SettingsState {
  alertSounds: boolean;
  _loaded: boolean;
  loadSettings: () => Promise<void>;
  setAlertSounds: (enabled: boolean) => void;
}

export const useSettingsStore = create<SettingsState>((set) => ({
  alertSounds: true,
  _loaded: false,

  loadSettings: async () => {
    try {
      const value = await AsyncStorage.getItem(ALERT_SOUNDS_KEY);
      if (value !== null) {
        set({ alertSounds: value === 'true' });
      }
    } catch {
      // Use defaults
    }
    set({ _loaded: true });
  },

  setAlertSounds: (enabled) => {
    set({ alertSounds: enabled });
    AsyncStorage.setItem(ALERT_SOUNDS_KEY, String(enabled)).catch(() => {});
  },
}));
