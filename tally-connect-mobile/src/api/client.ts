import * as SecureStore from 'expo-secure-store';

const RELAY_URL_KEY = 'relay_url';
const AUTH_TOKEN_KEY = 'auth_token';
const CHURCH_ID_KEY = 'church_id';

let cachedUrl: string | null = null;
let cachedToken: string | null = null;
let cachedChurchId: string | null = null;

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
  await SecureStore.deleteItemAsync(AUTH_TOKEN_KEY);
  await SecureStore.deleteItemAsync(CHURCH_ID_KEY);
}

interface ApiOptions {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
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

  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method || 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  if (response.status === 401) {
    await clearAuth();
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
