import { create } from 'zustand';
import { api } from '../api/client';
import type { ChatMessage } from '../ws/types';

interface ChatState {
  messages: ChatMessage[];
  isLoading: boolean;
  isSending: boolean;

  fetchMessages: () => Promise<void>;
  sendMessage: (text: string, roomId?: string) => Promise<boolean>;
  addMessage: (msg: ChatMessage) => void;
  clearMessages: () => void;
}

export const useChatStore = create<ChatState>((set, get) => ({
  messages: [],
  isLoading: false,
  isSending: false,

  fetchMessages: async () => {
    const wasEmpty = get().messages.length === 0;
    if (wasEmpty) set({ isLoading: true });
    try {
      const data = await api<{ messages: ChatMessage[] }>('/api/church/chat');
      const incoming = data.messages || [];
      const existing = get().messages;

      // Only update state if messages actually changed (avoids flicker)
      if (
        incoming.length !== existing.length ||
        (incoming.length > 0 && existing.length > 0 &&
          incoming[incoming.length - 1]?.id !== existing[existing.length - 1]?.id)
      ) {
        set({ messages: incoming, isLoading: false });
      } else if (wasEmpty) {
        set({ messages: incoming, isLoading: false });
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
      const saved = await api<ChatMessage>('/api/church/chat', {
        method: 'POST',
        body: { message: text, roomId: roomId || null },
      });
      set((state) => ({
        messages: [...state.messages, saved],
        isSending: false,
      }));
      return true;
    } catch {
      set({ isSending: false });
      return false;
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
