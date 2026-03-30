export function createApi(getToken) {
  return async function api(path, opts = {}) {
    const method = opts.method || 'GET';
    const headers = { 'Content-Type': 'application/json' };
    const token = getToken();
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const res = await fetch(path, {
      method,
      headers,
      ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
    });
    const text = await res.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { error: text || `${method} ${path} failed` };
    }
    if (!res.ok) throw new Error(data.error || `${method} ${path} failed`);
    return data;
  };
}
