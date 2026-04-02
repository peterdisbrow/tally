import { create } from 'zustand';
import { api } from '../api/client';
import type { DeviceStatus, Room, DashboardStats, ServiceSession } from '../ws/types';

interface StatusState {
  rooms: Room[];
  activeRoomId: string | null;
  instanceStatus: Record<string, DeviceStatus>;
  roomInstanceMap: Record<string, string>;
  dashboardStats: DashboardStats;
  wsConnected: boolean;
  lastUpdate: number;
  isRefreshing: boolean;

  setActiveRoom: (roomId: string) => void;
  updateRoomStatus: (roomId: string, status: DeviceStatus) => void;
  updateInstanceStatus: (instanceStatus: Record<string, DeviceStatus>, roomInstanceMap: Record<string, string>) => void;
  removeInstance: (instanceName: string) => void;
  setWsConnected: (connected: boolean) => void;
  fetchRooms: () => Promise<void>;
  fetchDashboardStats: () => Promise<void>;
  refreshAll: () => Promise<void>;
  reset: () => void;
}

export const useStatusStore = create<StatusState>((set, get) => ({
  rooms: [],
  activeRoomId: null,
  instanceStatus: {},
  roomInstanceMap: {},
  dashboardStats: {},
  wsConnected: false,
  lastUpdate: 0,
  isRefreshing: false,

  setActiveRoom: (roomId) => set({ activeRoomId: roomId }),

  updateRoomStatus: (roomId, status) => {
    set((state) => {
      const rooms = state.rooms.map((r) =>
        r.id === roomId ? { ...r, status, connected: status.connected !== false } : r
      );
      return { rooms, lastUpdate: Date.now() };
    });
  },

  updateInstanceStatus: (newStatus, newRoomMap) => {
    set((state) => ({
      instanceStatus: { ...state.instanceStatus, ...newStatus },
      roomInstanceMap: { ...state.roomInstanceMap, ...newRoomMap },
      lastUpdate: Date.now(),
    }));
  },

  removeInstance: (instanceName) => {
    set((state) => {
      const { [instanceName]: _, ...remainingStatus } = state.instanceStatus;
      return { instanceStatus: remainingStatus, lastUpdate: Date.now() };
    });
  },

  setWsConnected: (connected) => set({ wsConnected: connected }),

  fetchRooms: async () => {
    try {
      const data = await api<{ rooms: Array<{ id: string; name: string; is_default?: boolean }> }>('/api/church/rooms');
      const rooms: Room[] = (data.rooms || []).map((r) => ({
        id: r.id,
        name: r.name,
      }));
      set((state) => ({
        rooms,
        activeRoomId: state.activeRoomId || rooms[0]?.id || null,
      }));
    } catch {
      // Will retry on next refresh
    }
  },

  fetchDashboardStats: async () => {
    try {
      const data = await api<{
        healthScore?: number;
        alertsToday?: number;
        activeSession?: ServiceSession;
        instanceStatus?: Record<string, DeviceStatus>;
        roomInstanceMap?: Record<string, string>;
      }>('/api/church/mobile/summary');
      set({
        dashboardStats: {
          healthScore: data.healthScore,
          alertsToday: data.alertsToday,
          activeSession: data.activeSession ?? undefined,
        },
      });
      if (data.instanceStatus) {
        get().updateInstanceStatus(data.instanceStatus, data.roomInstanceMap || {});
      }
    } catch {
      // Non-critical — dashboard still works with device status
    }
  },

  refreshAll: async () => {
    const { fetchRooms, fetchDashboardStats } = get();
    set({ isRefreshing: true });
    await Promise.all([fetchRooms(), fetchDashboardStats()]);
    set({ isRefreshing: false });
  },

  reset: () => set({
    rooms: [],
    activeRoomId: null,
    instanceStatus: {},
    roomInstanceMap: {},
    dashboardStats: {},
    wsConnected: false,
    lastUpdate: 0,
    isRefreshing: false,
  }),
}));

// Helper to get the active room's status
export function useActiveRoomStatus(): DeviceStatus | null {
  return useStatusStore((state) => {
    const { activeRoomId, rooms, instanceStatus, roomInstanceMap } = state;
    if (!activeRoomId) return null;

    // Try to find status via roomInstanceMap → instanceStatus
    const instanceName = roomInstanceMap[activeRoomId];
    if (instanceName && instanceStatus[instanceName]) {
      return instanceStatus[instanceName];
    }

    // Fallback to room-level status
    const room = rooms.find((r) => r.id === activeRoomId);
    return room?.status || null;
  });
}
