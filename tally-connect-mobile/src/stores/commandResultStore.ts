import { create } from 'zustand';

interface CommandResultEntry {
  success: boolean;
  error?: string;
  data?: unknown;
}

interface CommandResultState {
  results: Record<string, CommandResultEntry>;
  addResult: (messageId: string, result: CommandResultEntry) => void;
  getResult: (messageId: string) => CommandResultEntry | undefined;
  clearResult: (messageId: string) => void;
}

export const useCommandResultStore = create<CommandResultState>((set, get) => ({
  results: {},

  addResult: (messageId, result) => {
    set((state) => ({
      results: { ...state.results, [messageId]: result },
    }));
  },

  getResult: (messageId) => {
    return get().results[messageId];
  },

  clearResult: (messageId) => {
    set((state) => {
      const { [messageId]: _, ...rest } = state.results;
      return { results: rest };
    });
  },
}));
