import { create } from 'zustand';
import { api } from '../api/client';
import type { ChatMessage } from '../ws/types';

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
      const data = await api<{ messages: ChatMessage[] }>('/api/church/chat');
      set({ messages: data.messages || [], isLoading: false });
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
