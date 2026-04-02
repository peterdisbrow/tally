import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, ScrollView, StyleSheet, RefreshControl,
  TouchableOpacity, LayoutAnimation, Platform, UIManager,
} from 'react-native';
import { useStatusStore, useActiveRoomStatus } from '../../src/stores/statusStore';
import { usePolling } from '../../src/hooks/usePolling';
import { colors } from '../../src/theme/colors';
import { spacing, borderRadius, fontSize } from '../../src/theme/spacing';
import { api } from '../../src/api/client';
import type { DeviceStatus } from '../../src/ws/types';

if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

// ─── Types ───────────────────────────────────────────────────────────────────

interface DeviceCard {
  id: string;
  name: string;
  category: CategoryKey;
  connected: boolean;
  statusLabel: string;
  statusColor: string;
  metrics: { label: string; value: string; color?: string }[];
}

type CategoryKey = 'switching' | 'streaming' | 'recording' | 'presentation' | 'audio' | 'network' | 'system';

const CATEGORY_ORDER: CategoryKey[] = [
  'switching', 'streaming', 'recording', 'presentation', 'audio', 'network', 'system',
];

const CATEGORY_LABELS: Record<CategoryKey, string> = {
  switching: 'Switching',
  streaming: 'Streaming',
  recording: 'Recording',
  presentation: 'Presentation',
  audio: 'Audio',
  network: 'Network & Control',
  system: 'System',
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatBitrate(kbps?: number): string {
  if (kbps == null) return '--';
  return kbps >= 1000 ? `${(kbps / 1000).toFixed(1)} Mbps` : `${Math.round(kbps)} Kbps`;
}

function formatPercent(v?: number): string {
  return v != null ? `${Math.round(v)}%` : '--';
}

function percentColor(v?: number): string {
  if (v == null) return colors.textMuted;
  if (v >= 85) return colors.critical;
  if (v >= 70) return colors.warning;
  return colors.online;
}

function healthLabel(kbps?: number): { text: string; color: string } {
  if (kbps == null) return { text: '--', color: colors.textMuted };
  if (kbps >= 4000) return { text: 'Excellent', color: colors.online };
  if (kbps >= 2000) return { text: 'Fair', color: colors.warning };
  return { text: 'Poor', color: colors.critical };
}

function streamStatusColor(connected: boolean, streaming?: boolean): string {
  if (!connected) return colors.offline;
  if (streaming) return colors.online;
  return colors.warning;
}

function streamStatusLabel(connected: boolean, streaming?: boolean, recording?: boolean): string {
  if (!connected) return 'Offline';
  const parts: string[] = [];
  if (streaming) parts.push('Streaming');
  if (recording) parts.push('Recording');
  return parts.length > 0 ? parts.join(' + ') : 'Connected';
}

// ─── Device Card Builder ─────────────────────────────────────────────────────

function buildDeviceCards(status: DeviceStatus | null): DeviceCard[] {
  if (!status) return [];
  const cards: DeviceCard[] = [];

  // ATEM Switcher
  if (status.atem) {
    const a = status.atem;
    const inputs = a.inputs || {};
    const pgmName = a.programInput != null ? (inputs[a.programInput]?.name || `Input ${a.programInput}`) : '--';
    const pvwName = a.previewInput != null ? (inputs[a.previewInput]?.name || `Input ${a.previewInput}`) : '--';
    const metrics: DeviceCard['metrics'] = [
      { label: 'Model', value: a.model || 'ATEM' },
      { label: 'Program', value: pgmName, color: colors.tallyProgram },
      { label: 'Preview', value: pvwName, color: colors.tallyPreview },
    ];
    if (a.streaming != null) {
      metrics.push({ label: 'Streaming', value: a.streaming ? 'LIVE' : 'Off', color: a.streaming ? colors.online : colors.textMuted });
    }
    if (a.recording != null) {
      metrics.push({ label: 'Recording', value: a.recording ? 'REC' : 'Off', color: a.recording ? colors.critical : colors.textMuted });
    }
    cards.push({
      id: 'atem',
      name: a.model || 'ATEM Switcher',
      category: 'switching',
      connected: a.connected,
      statusLabel: a.connected ? 'Connected' : 'Offline',
      statusColor: a.connected ? colors.online : colors.offline,
      metrics,
    });
  }

  // OBS Studio
  if (status.obs) {
    const o = status.obs;
    const health = healthLabel(o.bitrate);
    const metrics: DeviceCard['metrics'] = [];
    if (o.currentScene) metrics.push({ label: 'Scene', value: o.currentScene });
    if (o.streaming != null || o.recording != null) {
      const parts: string[] = [];
      if (o.streaming) parts.push('LIVE');
      if (o.recording) parts.push('REC');
      metrics.push({ label: 'Status', value: parts.length > 0 ? parts.join(' + ') : 'Idle' });
    }
    if (o.bitrate != null) {
      metrics.push({ label: 'Bitrate', value: formatBitrate(o.bitrate), color: health.color });
      metrics.push({ label: 'Health', value: health.text, color: health.color });
    }
    if (o.fps != null) metrics.push({ label: 'FPS', value: `${Math.round(o.fps)}` });
    if (o.droppedFrames != null) metrics.push({ label: 'Dropped', value: `${o.droppedFrames}`, color: o.droppedFrames > 0 ? colors.warning : colors.online });
    if (o.strain != null) metrics.push({ label: 'CPU Load', value: `${Math.round(o.strain * 100)}%`, color: percentColor(o.strain * 100) });
    cards.push({
      id: 'obs',
      name: 'OBS Studio',
      category: 'streaming',
      connected: o.connected,
      statusLabel: streamStatusLabel(o.connected, o.streaming, o.recording),
      statusColor: streamStatusColor(o.connected, o.streaming),
      metrics,
    });
  }

  // vMix
  if (status.vmix) {
    const v = status.vmix;
    const metrics: DeviceCard['metrics'] = [];
    if (v.streaming != null || v.recording != null) {
      const parts: string[] = [];
      if (v.streaming) parts.push('LIVE');
      if (v.recording) parts.push('REC');
      metrics.push({ label: 'Status', value: parts.length > 0 ? parts.join(' + ') : 'Idle' });
    }
    cards.push({
      id: 'vmix',
      name: 'vMix',
      category: 'streaming',
      connected: v.connected,
      statusLabel: streamStatusLabel(v.connected, v.streaming, v.recording),
      statusColor: streamStatusColor(v.connected, v.streaming),
      metrics,
    });
  }

  // Generic Encoder (when OBS not present)
  if (status.encoder && !status.obs) {
    const e = status.encoder;
    const health = healthLabel(e.bitrate);
    const metrics: DeviceCard['metrics'] = [];
    if (e.type) metrics.push({ label: 'Type', value: e.type });
    if (e.streaming != null) {
      metrics.push({ label: 'Status', value: e.streaming ? 'LIVE' : 'Idle', color: e.streaming ? colors.online : colors.textMuted });
    }
    if (e.bitrate != null) {
      metrics.push({ label: 'Bitrate', value: formatBitrate(e.bitrate), color: health.color });
      metrics.push({ label: 'Health', value: health.text, color: health.color });
    }
    if (e.fps != null) metrics.push({ label: 'FPS', value: `${Math.round(e.fps)}` });
    cards.push({
      id: 'encoder',
      name: e.name || e.type || 'Encoder',
      category: 'streaming',
      connected: e.connected,
      statusLabel: streamStatusLabel(e.connected, e.streaming),
      statusColor: streamStatusColor(e.connected, e.streaming),
      metrics,
    });
  }

  // YouTube Stream Health
  if (status.streamHealth?.youtube) {
    const yt = status.streamHealth.youtube;
    const isLive = yt.status === 'live' || yt.status === 'active';
    const metrics: DeviceCard['metrics'] = [
      { label: 'Status', value: isLive ? 'LIVE' : yt.status || 'Unknown', color: isLive ? colors.online : colors.textMuted },
    ];
    if (yt.viewers != null) metrics.push({ label: 'Viewers', value: yt.viewers.toLocaleString() });
    if (yt.healthStatus) metrics.push({ label: 'Health', value: yt.healthStatus });
    cards.push({
      id: 'youtube',
      name: 'YouTube Live',
      category: 'streaming',
      connected: isLive,
      statusLabel: isLive ? 'LIVE' : 'Off-Air',
      statusColor: isLive ? colors.online : colors.textMuted,
      metrics,
    });
  }

  // Facebook Stream Health
  if (status.streamHealth?.facebook) {
    const fb = status.streamHealth.facebook;
    const isLive = fb.status === 'live' || fb.status === 'active';
    const metrics: DeviceCard['metrics'] = [
      { label: 'Status', value: isLive ? 'LIVE' : fb.status || 'Unknown', color: isLive ? colors.online : colors.textMuted },
    ];
    if (fb.viewers != null) metrics.push({ label: 'Viewers', value: fb.viewers.toLocaleString() });
    cards.push({
      id: 'facebook',
      name: 'Facebook Live',
      category: 'streaming',
      connected: isLive,
      statusLabel: isLive ? 'LIVE' : 'Off-Air',
      statusColor: isLive ? colors.online : colors.textMuted,
      metrics,
    });
  }

  // HyperDeck
  if (status.hyperdeck) {
    const h = status.hyperdeck;
    const metrics: DeviceCard['metrics'] = [];
    if (h.recording != null) {
      metrics.push({ label: 'Status', value: h.recording ? 'Recording' : 'Idle', color: h.recording ? colors.critical : colors.textMuted });
    }
    if (h.diskRemaining != null) {
      const gb = (h.diskRemaining / (1024 * 1024 * 1024)).toFixed(1);
      metrics.push({ label: 'Disk Free', value: `${gb} GB`, color: h.diskRemaining < 5e9 ? colors.warning : colors.online });
    }
    cards.push({
      id: 'hyperdeck',
      name: 'HyperDeck',
      category: 'recording',
      connected: h.connected,
      statusLabel: h.connected ? (h.recording ? 'Recording' : 'Connected') : 'Offline',
      statusColor: h.connected ? (h.recording ? colors.critical : colors.online) : colors.offline,
      metrics,
    });
  }

  // ATEM Recording (separate card when no HyperDeck)
  if (status.atem?.recording && !status.hyperdeck) {
    cards.push({
      id: 'atem-recording',
      name: 'ATEM Recording',
      category: 'recording',
      connected: true,
      statusLabel: 'Recording',
      statusColor: colors.critical,
      metrics: [{ label: 'Status', value: 'REC', color: colors.critical }],
    });
  }

  // ProPresenter
  if (status.propresenter) {
    const p = status.propresenter;
    const metrics: DeviceCard['metrics'] = [];
    if (p.currentPresentation) metrics.push({ label: 'Presentation', value: p.currentPresentation });
    if (p.currentSlide) metrics.push({ label: 'Slide', value: p.currentSlide });
    cards.push({
      id: 'propresenter',
      name: 'ProPresenter',
      category: 'presentation',
      connected: p.connected,
      statusLabel: p.connected ? 'Connected' : 'Offline',
      statusColor: p.connected ? colors.online : colors.offline,
      metrics,
    });
  }

  // Audio Mixer
  if (status.mixer) {
    const m = status.mixer;
    const metrics: DeviceCard['metrics'] = [];
    if (m.model) metrics.push({ label: 'Model', value: m.model });
    if (m.channels && m.channels.length > 0) {
      const mutedCount = m.channels.filter(c => c.muted).length;
      metrics.push({ label: 'Channels', value: `${m.channels.length}` });
      if (mutedCount > 0) {
        metrics.push({ label: 'Muted', value: `${mutedCount}`, color: colors.warning });
      }
    }
    cards.push({
      id: 'mixer',
      name: m.model || 'Audio Mixer',
      category: 'audio',
      connected: m.connected,
      statusLabel: m.connected ? 'Connected' : 'Offline',
      statusColor: m.connected ? colors.online : colors.offline,
      metrics,
    });
  }

  // PTZ Cameras
  if (status.ptz) {
    const p = status.ptz;
    const cameras = p.cameras || [];
    const connectedCount = cameras.filter(c => c.connected).length;
    const metrics: DeviceCard['metrics'] = [];
    if (cameras.length > 0) {
      metrics.push({ label: 'Cameras', value: `${connectedCount}/${cameras.length} online` });
      cameras.forEach(cam => {
        metrics.push({
          label: cam.name || 'Camera',
          value: cam.connected ? 'Online' : 'Offline',
          color: cam.connected ? colors.online : colors.offline,
        });
      });
    }
    cards.push({
      id: 'ptz',
      name: 'PTZ Cameras',
      category: 'network',
      connected: p.connected,
      statusLabel: cameras.length > 0 ? `${connectedCount}/${cameras.length}` : (p.connected ? 'Connected' : 'Offline'),
      statusColor: p.connected ? colors.online : colors.offline,
      metrics,
    });
  }

  // Companion
  if (status.companion) {
    const c = status.companion;
    cards.push({
      id: 'companion',
      name: 'Companion',
      category: 'network',
      connected: c.connected,
      statusLabel: c.connected ? 'Connected' : 'Offline',
      statusColor: c.connected ? colors.online : colors.offline,
      metrics: [],
    });
  }

  // System
  if (status.system) {
    const s = status.system;
    const metrics: DeviceCard['metrics'] = [];
    if (s.appVersion) metrics.push({ label: 'Version', value: s.appVersion });
    if (s.roomName) metrics.push({ label: 'Room', value: s.roomName });
    if (s.cpu != null) metrics.push({ label: 'CPU', value: formatPercent(s.cpu), color: percentColor(s.cpu) });
    if (s.memory != null) metrics.push({ label: 'RAM', value: formatPercent(s.memory), color: percentColor(s.memory) });
    if (s.disk != null) metrics.push({ label: 'Disk', value: formatPercent(s.disk), color: percentColor(s.disk) });
    cards.push({
      id: 'system',
      name: 'System',
      category: 'system',
      connected: true,
      statusLabel: 'Online',
      statusColor: colors.online,
      metrics,
    });
  }

  return cards;
}

// ─── Summary ─────────────────────────────────────────────────────────────────

interface Summary {
  totalDevices: number;
  onlineDevices: number;
  isStreaming: boolean;
  isRecording: boolean;
  streamPlatforms: string[];
  totalViewers: number;
}

function buildSummary(status: DeviceStatus | null, cards: DeviceCard[]): Summary {
  const totalDevices = cards.filter(c => c.category !== 'system').length;
  const onlineDevices = cards.filter(c => c.category !== 'system' && c.connected).length;

  const isStreaming = !!(
    status?.obs?.streaming ||
    status?.vmix?.streaming ||
    status?.encoder?.streaming ||
    status?.atem?.streaming
  );
  const isRecording = !!(
    status?.obs?.recording ||
    status?.vmix?.recording ||
    status?.atem?.recording ||
    status?.hyperdeck?.recording
  );

  const streamPlatforms: string[] = [];
  let totalViewers = 0;
  if (status?.streamHealth?.youtube) {
    const yt = status.streamHealth.youtube;
    if (yt.status === 'live' || yt.status === 'active') streamPlatforms.push('YouTube');
    totalViewers += yt.viewers || 0;
  }
  if (status?.streamHealth?.facebook) {
    const fb = status.streamHealth.facebook;
    if (fb.status === 'live' || fb.status === 'active') streamPlatforms.push('Facebook');
    totalViewers += fb.viewers || 0;
  }

  return { totalDevices, onlineDevices, isStreaming, isRecording, streamPlatforms, totalViewers };
}

// ─── Main Component ──────────────────────────────────────────────────────────

export default function DashboardScreen() {
  const refreshAll = useStatusStore((s) => s.refreshAll);
  const isRefreshing = useStatusStore((s) => s.isRefreshing);
  const dashboardStats = useStatusStore((s) => s.dashboardStats);
  const activeRoomId = useStatusStore((s) => s.activeRoomId);
  const rooms = useStatusStore((s) => s.rooms);
  const updateInstanceStatus = useStatusStore((s) => s.updateInstanceStatus);

  const status = useActiveRoomStatus();
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  useEffect(() => { refreshAll(); }, []);

  usePolling(async () => {
    try {
      const data = await api<{
        rooms: Array<{ id: string; name: string; connected: boolean }>;
        healthScore: number;
        alertsToday: number;
        activeSession: { active: boolean; grade?: string; duration?: number; incidents?: number; startedAt?: string } | null;
        instanceStatus: Record<string, DeviceStatus>;
        roomInstanceMap: Record<string, string>;
      }>('/api/church/mobile/summary');
      if (data.instanceStatus) {
        updateInstanceStatus(data.instanceStatus, data.roomInstanceMap || {});
      }
    } catch {
      // Will retry next poll
    }
  }, 5000);

  const cards = buildDeviceCards(status);
  const summary = buildSummary(status, cards);

  const toggleExpanded = useCallback((id: string) => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setExpandedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // Group cards by category
  const grouped = CATEGORY_ORDER
    .map(cat => ({
      key: cat,
      label: CATEGORY_LABELS[cat],
      cards: cards.filter(c => c.category === cat),
    }))
    .filter(g => g.cards.length > 0);

  const healthScore = dashboardStats.healthScore;
  const healthColor = healthScore != null
    ? healthScore >= 80 ? colors.online
      : healthScore >= 50 ? colors.warning
        : colors.critical
    : colors.textMuted;

  const session = dashboardStats.activeSession;
  const sessionDuration = session?.duration != null
    ? `${Math.floor(session.duration / 3600)}h ${Math.floor((session.duration % 3600) / 60)}m`
    : null;

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl
          refreshing={isRefreshing}
          onRefresh={refreshAll}
          tintColor={colors.accent}
        />
      }
    >
      {/* Room Header */}
      <View style={styles.roomRow}>
        <Text style={styles.roomLabel}>
          {rooms.find((r) => r.id === activeRoomId)?.name || 'No Room Selected'}
        </Text>
        <View style={[
          styles.connectionDot,
          { backgroundColor: status?.connected !== false ? colors.online : colors.offline },
        ]} />
      </View>

      {/* Summary Bar */}
      <View style={styles.summaryBar}>
        <View style={styles.summaryItem}>
          <Text style={[styles.summaryValue, { color: summary.onlineDevices === summary.totalDevices ? colors.online : colors.warning }]}>
            {summary.onlineDevices}/{summary.totalDevices}
          </Text>
          <Text style={styles.summaryLabel}>Devices</Text>
        </View>

        <View style={styles.summaryDivider} />

        <View style={styles.summaryItem}>
          {summary.isStreaming ? (
            <View style={styles.liveTag}>
              <Text style={styles.liveText}>LIVE</Text>
            </View>
          ) : (
            <Text style={[styles.summaryValue, { color: colors.textMuted }]}>OFF</Text>
          )}
          <Text style={styles.summaryLabel}>Stream</Text>
        </View>

        <View style={styles.summaryDivider} />

        <View style={styles.summaryItem}>
          {summary.isRecording ? (
            <View style={[styles.liveTag, { backgroundColor: colors.critical }]}>
              <Text style={styles.liveText}>REC</Text>
            </View>
          ) : (
            <Text style={[styles.summaryValue, { color: colors.textMuted }]}>--</Text>
          )}
          <Text style={styles.summaryLabel}>Record</Text>
        </View>

        <View style={styles.summaryDivider} />

        <View style={styles.summaryItem}>
          <Text style={[styles.summaryValue, { color: healthColor }]}>
            {healthScore != null ? healthScore : '--'}
          </Text>
          <Text style={styles.summaryLabel}>Health</Text>
        </View>
      </View>

      {/* Session + Viewers Row */}
      {(session?.active || summary.totalViewers > 0) && (
        <View style={styles.infoRow}>
          {session?.active && (
            <View style={styles.infoPill}>
              <View style={styles.infoDot} />
              <Text style={styles.infoText}>
                {session.grade ? `Grade: ${session.grade}` : 'Session Active'}
                {sessionDuration ? ` \u00b7 ${sessionDuration}` : ''}
                {session.incidents ? ` \u00b7 ${session.incidents} alert${session.incidents !== 1 ? 's' : ''}` : ''}
              </Text>
            </View>
          )}
          {summary.totalViewers > 0 && (
            <View style={styles.infoPill}>
              <Text style={styles.infoText}>
                {summary.totalViewers.toLocaleString()} viewer{summary.totalViewers !== 1 ? 's' : ''}
                {summary.streamPlatforms.length > 0 ? ` on ${summary.streamPlatforms.join(', ')}` : ''}
              </Text>
            </View>
          )}
        </View>
      )}

      {/* Device Categories */}
      {grouped.length === 0 ? (
        <View style={styles.emptyContainer}>
          <Text style={styles.emptyText}>
            {status ? 'No devices configured' : 'Waiting for data...'}
          </Text>
        </View>
      ) : (
        grouped.map(group => (
          <View key={group.key} style={styles.categorySection}>
            <Text style={styles.categoryTitle}>{group.label}</Text>
            {group.cards.map(card => (
              <TouchableOpacity
                key={card.id}
                activeOpacity={0.7}
                onPress={() => toggleExpanded(card.id)}
                style={styles.deviceCard}
              >
                {/* Card Header */}
                <View style={styles.cardHeader}>
                  <View style={[styles.statusDot, { backgroundColor: card.statusColor }]} />
                  <Text style={styles.cardName} numberOfLines={1}>{card.name}</Text>
                  <Text style={[styles.cardStatus, { color: card.statusColor }]}>
                    {card.statusLabel}
                  </Text>
                  <Text style={styles.chevron}>{expandedIds.has(card.id) ? '\u25B2' : '\u25BC'}</Text>
                </View>

                {/* Expanded Metrics */}
                {expandedIds.has(card.id) && card.metrics.length > 0 && (
                  <View style={styles.metricsGrid}>
                    {card.metrics.map((m, i) => (
                      <View key={i} style={styles.metricItem}>
                        <Text style={styles.metricLabel}>{m.label}</Text>
                        <Text style={[styles.metricValue, m.color ? { color: m.color } : null]} numberOfLines={1}>
                          {m.value}
                        </Text>
                      </View>
                    ))}
                  </View>
                )}
              </TouchableOpacity>
            ))}
          </View>
        ))
      )}

      <View style={{ height: spacing.xxxl }} />
    </ScrollView>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  content: {
    padding: spacing.lg,
  },
  roomRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.lg,
  },
  roomLabel: {
    fontSize: fontSize.lg,
    fontWeight: '700',
    color: colors.text,
  },
  connectionDot: {
    width: 12,
    height: 12,
    borderRadius: 6,
  },

  // Summary Bar
  summaryBar: {
    flexDirection: 'row',
    backgroundColor: colors.surface,
    borderRadius: borderRadius.md,
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: colors.border,
    marginBottom: spacing.md,
    alignItems: 'center',
  },
  summaryItem: {
    flex: 1,
    alignItems: 'center',
  },
  summaryValue: {
    fontSize: fontSize.xl,
    fontWeight: '700',
    color: colors.text,
  },
  summaryLabel: {
    fontSize: fontSize.xs,
    color: colors.textSecondary,
    marginTop: 4,
  },
  summaryDivider: {
    width: 1,
    height: 32,
    backgroundColor: colors.border,
  },
  liveTag: {
    backgroundColor: colors.live,
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    borderRadius: borderRadius.sm,
  },
  liveText: {
    fontSize: 10,
    fontWeight: '800',
    color: colors.white,
    letterSpacing: 1,
  },

  // Info Row
  infoRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginBottom: spacing.lg,
  },
  infoPill: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderRadius: borderRadius.full,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderWidth: 1,
    borderColor: colors.border,
  },
  infoDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.online,
    marginRight: spacing.sm,
  },
  infoText: {
    fontSize: fontSize.xs,
    color: colors.textSecondary,
  },

  // Categories
  categorySection: {
    marginBottom: spacing.lg,
  },
  categoryTitle: {
    fontSize: fontSize.xs,
    color: colors.textSecondary,
    textTransform: 'uppercase',
    letterSpacing: 1,
    fontWeight: '600',
    marginBottom: spacing.sm,
  },

  // Device Card
  deviceCard: {
    backgroundColor: colors.surface,
    borderRadius: borderRadius.md,
    borderWidth: 1,
    borderColor: colors.border,
    marginBottom: spacing.sm,
    overflow: 'hidden',
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: spacing.md,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: spacing.md,
  },
  cardName: {
    flex: 1,
    fontSize: fontSize.md,
    fontWeight: '600',
    color: colors.text,
  },
  cardStatus: {
    fontSize: fontSize.sm,
    fontWeight: '600',
    marginRight: spacing.sm,
  },
  chevron: {
    fontSize: 10,
    color: colors.textMuted,
  },

  // Metrics Grid
  metricsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingTop: spacing.md,
  },
  metricItem: {
    width: '50%',
    paddingVertical: spacing.xs,
    paddingRight: spacing.sm,
  },
  metricLabel: {
    fontSize: fontSize.xs,
    color: colors.textMuted,
    marginBottom: 2,
  },
  metricValue: {
    fontSize: fontSize.sm,
    fontWeight: '600',
    color: colors.text,
  },

  // Empty state
  emptyContainer: {
    paddingVertical: spacing.xxxl,
    alignItems: 'center',
  },
  emptyText: {
    fontSize: fontSize.md,
    color: colors.textMuted,
    textAlign: 'center',
  },
});
