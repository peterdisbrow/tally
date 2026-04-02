import { create } from 'zustand';
import { api } from '../api/client';
import { useStatusStore } from './statusStore';
import type { Alert } from '../ws/types';

interface AlertState {
  alerts: Alert[];
  unreadCount: number;
  isLoading: boolean;
  /** IDs of alerts that have arrived since the user last viewed the tab */
  newAlertIds: Set<string>;

  fetchAlerts: () => Promise<void>;
  addAlert: (alert: Alert) => void;
  dismissAlert: (id: string) => void;
  acknowledgeAlert: (id: string) => void;
  markAllRead: () => void;
  reset: () => void;
}

export const useAlertStore = create<AlertState>((set, get) => ({
  alerts: [],
  unreadCount: 0,
  isLoading: false,
  newAlertIds: new Set(),

  fetchAlerts: async () => {
    set({ isLoading: true });
    try {
      const roomId = useStatusStore.getState().activeRoomId;
      const query = roomId ? `?roomId=${encodeURIComponent(roomId)}` : '';
      const data = await api<Record<string, unknown>[] | { alerts?: Record<string, unknown>[] }>(`/api/church/alerts${query}`);
      // Server may return an array directly or { alerts: [...] }
      const raw: Record<string, unknown>[] = Array.isArray(data) ? data : ((data as { alerts?: Record<string, unknown>[] }).alerts || []);
      // Map server DB fields to mobile Alert shape
      const alerts: Alert[] = raw.slice(0, 100).map((a) => {
        const context = (a.context && typeof a.context === 'object' ? a.context : {}) as Record<string, unknown>;
        const alertType = String(a.alert_type || a.alertType || '').replace(/_/g, ' ');
        return {
          id: String(a.id || ''),
          severity: (a.severity as Alert['severity']) || 'INFO',
          message: String(context.message || a.message || alertType || 'Alert'),
          timestamp: String(a.created_at || a.createdAt || a.timestamp || new Date().toISOString()),
          roomId: (a.room_id ?? a.roomId ?? null) as string | null,
          roomName: (a.roomName ?? context.roomName ?? '') as string,
          acknowledged: !!(a.acknowledged_at || a.acknowledgedAt),
        };
      });
      set({ alerts, isLoading: false });
    } catch {
      set({ isLoading: false });
    }
  },

  addAlert: (alert) => {
    set((state) => ({
      alerts: [alert, ...state.alerts].slice(0, 100),
      unreadCount: state.unreadCount + 1,
      newAlertIds: new Set(state.newAlertIds).add(alert.id),
    }));
  },

  dismissAlert: (id) => {
    set((state) => ({
      alerts: state.alerts.filter((a) => a.id !== id),
    }));
  },

  acknowledgeAlert: (id) => {
    set((state) => ({
      alerts: state.alerts.map((a) =>
        a.id === id ? { ...a, acknowledged: true } : a,
      ),
    }));
  },

  markAllRead: () => set({ unreadCount: 0, newAlertIds: new Set() }),

  reset: () => set({ alerts: [], unreadCount: 0, isLoading: false, newAlertIds: new Set() }),
}));
