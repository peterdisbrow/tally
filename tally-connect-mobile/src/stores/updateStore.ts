import { create } from 'zustand';

interface UpdateState {
  /** An update has been downloaded and is ready to apply */
  updateReady: boolean;
  setUpdateReady: (ready: boolean) => void;
}

export const useUpdateStore = create<UpdateState>((set) => ({
  updateReady: false,
  setUpdateReady: (ready) => set({ updateReady: ready }),
}));
