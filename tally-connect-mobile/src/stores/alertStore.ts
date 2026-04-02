import { create } from 'zustand';
import { api } from '../api/client';
import type { Alert } from '../ws/types';

interface AlertState {
  alerts: Alert[];
  unreadCount: number;
  isLoading: boolean;

  fetchAlerts: () => Promise<void>;
  addAlert: (alert: Alert) => void;
  markAllRead: () => void;
  reset: () => void;
}

export const useAlertStore = create<AlertState>((set, get) => ({
  alerts: [],
  unreadCount: 0,
  isLoading: false,

  fetchAlerts: async () => {
    set({ isLoading: true });
    try {
      const data = await api<{ alerts: Alert[] }>('/api/church/alerts');
      const alerts = (data.alerts || []).slice(0, 100);
      set({ alerts, isLoading: false });
    } catch {
      set({ isLoading: false });
    }
  },

  addAlert: (alert) => {
    set((state) => ({
      alerts: [alert, ...state.alerts].slice(0, 100),
      unreadCount: state.unreadCount + 1,
    }));
  },

  markAllRead: () => set({ unreadCount: 0 }),

  reset: () => set({ alerts: [], unreadCount: 0, isLoading: false }),
}));
