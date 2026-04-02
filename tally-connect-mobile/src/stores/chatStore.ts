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

interface ChatState {
  messages: ChatMessage[];
  isLoading: boolean;
  isSending: boolean;

  fetchMessages: () => Promise<void>;
  sendMessage: (text: string, roomId?: string) => Promise<void>;
  addMessage: (msg: ChatMessage) => void;
  clearMessages: () => void;
}

export const useChatStore = create<ChatState>((set, get) => ({
  messages: [],
  isLoading: false,
  isSending: false,

  fetchMessages: async () => {
    set({ isLoading: true });
    try {
      const roomId = useStatusStore.getState().activeRoomId;
      const params = new URLSearchParams({ latest: 'true' });
      if (roomId) params.set('roomId', roomId);
      const data = await api<{ messages: Record<string, unknown>[] }>(
        `/api/church/chat?${params.toString()}`,
      );
      set({
        messages: (data.messages || []).map(normalizeMessage),
        isLoading: false,
      });
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
      set((state) => ({
        messages: [...state.messages, normalizeMessage(saved)],
        isSending: false,
      }));
    } catch {
      set({ isSending: false });
    }
  },

  addMessage: (msg) => {
    set((state) => ({
      messages: [...state.messages, msg],
    }));
  },

  clearMessages: () => {
    set({ messages: [], isLoading: false, isSending: false });
  },
}));
