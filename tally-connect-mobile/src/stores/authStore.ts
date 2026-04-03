import { create } from 'zustand';
import { Alert } from 'react-native';
import { api, setAuthToken, setChurchId, clearAuth, getAuthToken, getChurchId, setRelayUrl, getRelayUrl } from '../api/client';
import { tallySocket } from '../ws/TallySocket';
import { useChatStore } from './chatStore';
import { useStatusStore } from './statusStore';
import { useAlertStore } from './alertStore';

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
  forceLogout: () => Promise<void>;
  checkAuth: () => Promise<void>;
}

function normalizeLoginError(err: unknown, status?: number): string {
  console.error('[Login error]', status !== undefined ? `HTTP ${status}:` : '', err);

  if (status !== undefined) {
    if (status === 401 || status === 403) return 'Invalid email or password.';
    if (status === 404) return 'Server not found. Check your server URL.';
    if (status === 429) return 'Too many attempts. Please wait a moment and try again.';
    if (status >= 500) return 'Something went wrong on our end. Please try again later.';
  }

  const message = typeof err === 'string' ? err : err instanceof Error ? err.message : '';
  const lower = message.toLowerCase();
  if (
    lower.includes('econnrefused') ||
    lower.includes('timeout') ||
    lower.includes('fetch failed') ||
    lower.includes('network request failed')
  ) {
    return 'Unable to reach the server. Check your internet connection and try again.';
  }

  return 'Login failed. Please try again.';
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
        set({ isLoading: false, error: normalizeLoginError(text, response.status) });
        return false;
      }

      const body = await response.json();
      if (!body.token) {
        set({ isLoading: false, error: 'No token in login response' });
        return false;
      }
      await setAuthToken(body.token);

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

      // WebSocket connection is managed by useTallySocket hook
      // which reacts to isLoggedIn changing to true

      return true;
    } catch (err) {
      set({ isLoading: false, error: normalizeLoginError(err) });
      return false;
    }
  },

  logout: async () => {
    tallySocket.disconnect();
    try {
      await api('/api/church/logout', { method: 'POST' });
    } catch {
      // Logout may fail if token already expired
    }
    await clearAuth();
    useChatStore.getState().clearAllMessages();
    useStatusStore.getState().reset();
    useAlertStore.getState().reset();
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

  forceLogout: async () => {
    tallySocket.disconnect();
    await clearAuth();
    useChatStore.getState().clearAllMessages();
    useStatusStore.getState().reset();
    useAlertStore.getState().reset();
    Alert.alert('Session Expired', 'Your session has expired. Please log in again.');
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
