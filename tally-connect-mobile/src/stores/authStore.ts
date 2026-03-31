import { create } from 'zustand';
import { api, setAuthToken, setChurchId, clearAuth, getAuthToken, getChurchId, setRelayUrl, getRelayUrl } from '../api/client';

interface AuthState {
  isLoggedIn: boolean;
  isLoading: boolean;
  churchId: string | null;
  churchName: string | null;
  email: string | null;
  role: string | null;
  error: string | null;

  login: (email: string, password: string, serverUrl?: string) => Promise<boolean>;
  logout: () => Promise<void>;
  checkAuth: () => Promise<void>;
}

export const useAuthStore = create<AuthState>((set) => ({
  isLoggedIn: false,
  isLoading: true,
  churchId: null,
  churchName: null,
  email: null,
  role: null,
  error: null,

  login: async (email, password, serverUrl) => {
    set({ isLoading: true, error: null });
    try {
      if (serverUrl) {
        await setRelayUrl(serverUrl.replace(/\/$/, ''));
      }
      const baseUrl = await getRelayUrl();

      // Login via the mobile endpoint
      const response = await fetch(`${baseUrl}/api/church/mobile/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });

      if (!response.ok) {
        const text = await response.text();
        set({ isLoading: false, error: text || 'Login failed' });
        return false;
      }

      const body = await response.json();
      if (body.token) {
        await setAuthToken(body.token);
      } else {
        // Fallback: extract JWT from set-cookie header
        const cookies = response.headers.get('set-cookie') || '';
        const tokenMatch = cookies.match(/tally_church_session=([^;]+)/);
        if (tokenMatch) {
          await setAuthToken(tokenMatch[1]);
        }
      }

      if (body.churchId) {
        await setChurchId(body.churchId);
      }

      set({
        isLoggedIn: true,
        isLoading: false,
        churchId: body.churchId || null,
        churchName: body.churchName || body.name || null,
        email: email,
        role: body.role || 'admin',
        error: null,
      });
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Login failed';
      set({ isLoading: false, error: message });
      return false;
    }
  },

  logout: async () => {
    try {
      await api('/api/church/logout', { method: 'POST' });
    } catch {
      // Logout may fail if token already expired
    }
    await clearAuth();
    set({
      isLoggedIn: false,
      isLoading: false,
      churchId: null,
      churchName: null,
      email: null,
      role: null,
      error: null,
    });
  },

  checkAuth: async () => {
    set({ isLoading: true });
    try {
      const token = await getAuthToken();
      const churchId = await getChurchId();
      if (!token || !churchId) {
        set({ isLoggedIn: false, isLoading: false });
        return;
      }

      const profile = await api<{
        churchId: string;
        name: string;
        email: string;
        role?: string;
      }>('/api/church/me');

      set({
        isLoggedIn: true,
        isLoading: false,
        churchId: profile.churchId,
        churchName: profile.name,
        email: profile.email,
        role: profile.role || 'admin',
      });
    } catch {
      await clearAuth();
      set({ isLoggedIn: false, isLoading: false });
    }
  },
}));
