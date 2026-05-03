// @ts-check
/**
 * Portal API helpers — call /api/church/* endpoints from inside the
 * authenticated page context so the browser supplies cookies + CSRF header
 * automatically.
 */

/**
 * Returns the value of the `tally_csrf` cookie from document.cookie.
 * Must be called in page.evaluate context.
 */
const csrfReader = `() => {
  const m = document.cookie.match(/(?:^|;\\s*)tally_csrf=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : '';
}`;

async function callPortalApi(page, method, path, body) {
  return await page.evaluate(
    async ({ method, path, body }) => {
      const csrf = (() => {
        const m = document.cookie.match(/(?:^|;\s*)tally_csrf=([^;]+)/);
        return m ? decodeURIComponent(m[1]) : '';
      })();
      const opts = {
        method,
        headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrf },
        credentials: 'include',
      };
      if (body !== undefined && body !== null) opts.body = JSON.stringify(body);
      const res = await fetch(path, opts);
      const text = await res.text();
      let parsed = text;
      try { parsed = JSON.parse(text); } catch { /* keep raw */ }
      return { status: res.status, ok: res.ok, body: parsed };
    },
    { method, path, body }
  );
}

async function listRooms(page) {
  const r = await callPortalApi(page, 'GET', '/api/church/rooms');
  if (!r.ok) throw new Error(`listRooms failed: ${r.status} ${JSON.stringify(r.body)}`);
  return Array.isArray(r.body) ? r.body : r.body.rooms || [];
}

async function deleteRoom(page, roomId) {
  const r = await callPortalApi(page, 'DELETE', `/api/church/rooms/${encodeURIComponent(roomId)}`);
  if (!r.ok && r.status !== 404) {
    throw new Error(`deleteRoom failed: ${r.status} ${JSON.stringify(r.body)}`);
  }
  return r;
}

/**
 * Delete every room whose name starts with the given prefix. Used in
 * afterEach to clean up rooms that tests created.
 */
async function cleanupRoomsWithPrefix(page, prefix) {
  let rooms;
  try {
    rooms = await listRooms(page);
  } catch {
    return; // session expired or page navigated away — nothing to clean
  }
  for (const r of rooms) {
    if (typeof r?.name === 'string' && r.name.startsWith(prefix)) {
      try { await deleteRoom(page, r.id); } catch { /* best effort */ }
    }
  }
}

module.exports = { callPortalApi, listRooms, deleteRoom, cleanupRoomsWithPrefix };
