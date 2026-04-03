import { create } from 'zustand';
import { api } from '../api/client';
import { useStatusStore } from './statusStore';
import type { ChatMessage } from '../ws/types';

/** Normalize a server chat row (snake_case) to the mobile ChatMessage shape. */
function normalizeMessage(raw: Record<string, unknown>): ChatMessage {
  return {
    id: (raw.id as string) || '',
    churchId: (raw.churchId ?? raw.church_id ?? '') as string,
    senderName: (raw.senderName ?? raw.sender_name ?? '') as string,
    senderRole: (raw.senderRole ?? raw.sender_role ?? 'system') as ChatMessage['senderRole'],
    message: (raw.message as string) || '',
    source: (raw.source as string) || '',
    timestamp: (raw.timestamp as string) || '',
    roomId: (raw.roomId ?? raw.room_id ?? null) as string | null,
  };
}

const NO_ROOM = '__no_room__';

function roomKey(roomId: string | null | undefined): string {
  return roomId || NO_ROOM;
}

interface ChatState {
  messagesByRoom: Record<string, ChatMessage[]>;
  isLoading: boolean;
  isSending: boolean;

  fetchMessages: () => Promise<void>;
  sendMessage: (text: string, roomId?: string) => Promise<boolean>;
  addMessage: (msg: ChatMessage) => void;
  /** Clear messages for the current active room only. */
  clearMessages: () => void;
  /** Clear messages for all rooms (use on logout). */
  clearAllMessages: () => void;
}

export const useChatStore = create<ChatState>((set, get) => ({
  messagesByRoom: {},
  isLoading: false,
  isSending: false,

  fetchMessages: async () => {
    const roomId = useStatusStore.getState().activeRoomId;
    const key = roomKey(roomId);
    const existing = get().messagesByRoom[key] ?? [];
    const wasEmpty = existing.length === 0;
    if (wasEmpty) set({ isLoading: true });
    try {
      const params = new URLSearchParams({ latest: 'true' });
      if (roomId) params.set('roomId', roomId);
      const data = await api<{ messages: Record<string, unknown>[] }>(
        `/api/church/chat?${params.toString()}`,
      );
      const incoming = (data.messages || []).map(normalizeMessage);
      const current = get().messagesByRoom[key] ?? [];

      // Only update state if messages actually changed (avoids flicker)
      if (
        incoming.length !== current.length ||
        (incoming.length > 0 && current.length > 0 &&
          incoming[incoming.length - 1]?.id !== current[current.length - 1]?.id)
      ) {
        set((state) => ({
          messagesByRoom: { ...state.messagesByRoom, [key]: incoming },
          isLoading: false,
        }));
      } else if (wasEmpty) {
        set((state) => ({
          messagesByRoom: { ...state.messagesByRoom, [key]: incoming },
          isLoading: false,
        }));
      } else {
        set({ isLoading: false });
      }
    } catch {
      set({ isLoading: false });
    }
  },

  sendMessage: async (text, roomId) => {
    set({ isSending: true });
    try {
      const saved = await api<Record<string, unknown>>('/api/church/chat', {
        method: 'POST',
        body: { message: text, roomId: roomId || null },
      });
      const msg = normalizeMessage(saved);
      const key = roomKey(msg.roomId ?? roomId);
      set((state) => ({
        messagesByRoom: {
          ...state.messagesByRoom,
          [key]: [...(state.messagesByRoom[key] ?? []), msg],
        },
        isSending: false,
      }));
      return true;
    } catch {
      set({ isSending: false });
      return false;
    }
  },

  addMessage: (msg) => {
    const key = roomKey(msg.roomId);
    set((state) => ({
      messagesByRoom: {
        ...state.messagesByRoom,
        [key]: [...(state.messagesByRoom[key] ?? []), msg],
      },
    }));
  },

  clearMessages: () => {
    const roomId = useStatusStore.getState().activeRoomId;
    const key = roomKey(roomId);
    set((state) => ({
      messagesByRoom: { ...state.messagesByRoom, [key]: [] },
    }));
  },

  clearAllMessages: () => {
    set({ messagesByRoom: {}, isLoading: false, isSending: false });
  },
}));
