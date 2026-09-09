/**
 * Calm copy for admin Monitor / Sunday strip when the fleet is dark.
 * Keep these honest: 0 booths is not a broken HLS player.
 */

export function fleetEmptyState({
  sseConnected,
  churchCount,
  onlineCount = 0,
  filter = '',
  showOnlyOnline = false,
  reconnecting = false,
} = {}) {
  if (churchCount === 0) {
    if (!sseConnected) {
      return {
        title: reconnecting ? 'Reconnecting to live feed…' : 'Connecting to live feed…',
        body: 'Booths appear here once an agent connects. A dark preview is not a broken player.',
      };
    }
    return {
      title: 'No booths online',
      body: 'HLS preview stays dark until a church runs Tally Connect. Registered churches with no agent do not show a live player.',
    };
  }
  if (showOnlyOnline && onlineCount === 0 && !filter) {
    return {
      title: 'No booths online',
      body: 'Every church in this fleet is offline. Uncheck Online only to see registered churches.',
    };
  }
  return {
    title: 'No matching churches',
    body: 'Clear the search or Online-only filter to see the rest of the fleet.',
  };
}

export function hlsIdleState({ boothConnected } = {}) {
  if (!boothConnected) {
    return {
      badge: 'No ingest',
      title: 'No live stream',
      body: 'This booth is not connected. There is no HLS to play — that is expected, not a broken player.',
    };
  }
  return {
    badge: 'Idle',
    title: 'No RTMP ingest',
    body: 'The booth is online but not pushing video. Preview starts when ingest is live.',
  };
}

export const ZERO_CONNECTED_NOTE =
  'No booths connected. Monitor preview, agent logs, and live chips stay quiet until a church runs Tally Connect.';
