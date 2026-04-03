import * as SecureStore from 'expo-secure-store';
import { Alert } from 'react-native';

const RELAY_URL_KEY = 'relay_url';
const AUTH_TOKEN_KEY = 'auth_token';
const CHURCH_ID_KEY = 'church_id';

let cachedUrl: string | null = null;
let cachedToken: string | null = null;
let cachedChurchId: string | null = null;

// Registered by authStore at startup to avoid circular-import dynamic loading on 401.
let _forceLogout: (() => Promise<void>) | null = null;
let _logoutInProgress = false;

export function registerAuthHandler(fn: () => Promise<void>): void {
  _forceLogout = fn;
}

export async function getRelayUrl(): Promise<string> {
  if (cachedUrl) return cachedUrl;
  cachedUrl = await SecureStore.getItemAsync(RELAY_URL_KEY);
  return cachedUrl || 'https://api.tallyconnect.app';
}

export async function setRelayUrl(url: string): Promise<void> {
  cachedUrl = url;
  await SecureStore.setItemAsync(RELAY_URL_KEY, url);
}

export async function getAuthToken(): Promise<string | null> {
  if (cachedToken) return cachedToken;
  cachedToken = await SecureStore.getItemAsync(AUTH_TOKEN_KEY);
  return cachedToken;
}

export async function setAuthToken(token: string): Promise<void> {
  cachedToken = token;
  await SecureStore.setItemAsync(AUTH_TOKEN_KEY, token);
}

export async function getChurchId(): Promise<string | null> {
  if (cachedChurchId) return cachedChurchId;
  cachedChurchId = await SecureStore.getItemAsync(CHURCH_ID_KEY);
  return cachedChurchId;
}

export async function setChurchId(id: string): Promise<void> {
  cachedChurchId = id;
  await SecureStore.setItemAsync(CHURCH_ID_KEY, id);
}

export async function clearAuth(): Promise<void> {
  cachedToken = null;
  cachedChurchId = null;
  cachedUrl = null;
  await SecureStore.deleteItemAsync(AUTH_TOKEN_KEY);
  await SecureStore.deleteItemAsync(CHURCH_ID_KEY);
}

interface ApiOptions {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

export async function api<T = unknown>(path: string, options: ApiOptions = {}): Promise<T> {
  const baseUrl = await getRelayUrl();
  const token = await getAuthToken();

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    ...options.headers,
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  // TODO(security): Certificate pinning (MITM protection)
  // The plain fetch() below is vulnerable to MITM attacks on compromised
  // WiFi networks (e.g. a church guest network). Implementing SSL pinning
  // requires a native module and cannot be done as a JS-only change.
  //
  // Recommended approach:
  //   1. Add `expo-ssl-pinning` (or `react-native-ssl-pinning`)
  //      and run `expo prebuild` to apply native changes.
  //   2. Replace fetch() calls with the library's `fetch` wrapper,
  //      supplying the server's expected certificate hashes:
  //
  //      import { fetch as pinnedFetch } from 'expo-ssl-pinning';
  //      pinnedFetch(`${baseUrl}${path}`, {
  //        ...options,
  //        sslPinning: { certs: ['cert-hash-1', 'cert-hash-2'] },
  //      });
  //
  //   3. Rotate pinned certs before they expire and ship a new build.
  //
  // References:
  //   - https://github.com/MaxToyberman/react-native-ssl-pinning
  //   - https://owasp.org/www-community/controls/Certificate_and_Public_Key_Pinning
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method || 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: options.signal,
  });

  if (response.status === 401) {
    // Debounce: only one logout call at a time to prevent race conditions
    // when multiple requests 401 simultaneously.
    if (!_logoutInProgress) {
      _logoutInProgress = true;
      try {
        if (_forceLogout) {
          await _forceLogout();
        } else {
          // Fallback for the rare case registerAuthHandler hasn't been called yet.
          const { useAuthStore } = await import('../stores/authStore');
          await useAuthStore.getState().forceLogout();
        }
      } finally {
        _logoutInProgress = false;
      }
    }
    throw new AuthError('Session expired');
  }

  if (!response.ok) {
    const text = await response.text();
    throw new ApiError(response.status, text);
  }

  const contentType = response.headers.get('content-type');
  if (contentType?.includes('application/json')) {
    return response.json() as Promise<T>;
  }
  return response.text() as unknown as T;
}

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}
