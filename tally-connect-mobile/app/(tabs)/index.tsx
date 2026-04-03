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

/** Check if a device object represents an actually-configured device vs a default placeholder.
 *  The church-client sends all device keys with { connected: false } even when unconfigured.
 *  A configured device is either connected or has identifying data (model, name, type, etc). */
function isDevicePresent(device: Record<string, unknown> | undefined | null): boolean {
  if (!device) return false;
  if (device.connected) return true;
  for (const [key, val] of Object.entries(device)) {
    if (key === 'connected') continue;
    if (val == null || val === false || val === 0 || val === '') continue;
    if (Array.isArray(val) && val.length === 0) continue;
    if (typeof val === 'object' && !Array.isArray(val) && Object.keys(val as Record<string, unknown>).length === 0) continue;
    return true;
  }
  return false;
}

function buildDeviceCards(status: DeviceStatus | null): DeviceCard[] {
  if (!status) return [];
  const cards: DeviceCard[] = [];

  // ATEM Switcher
  if (status.atem && isDevicePresent(status.atem)) {
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

  // ATEM Streaming Encoder (built-in encoder on ATEM Mini Extreme, etc.)
  if (status.atem && isDevicePresent(status.atem) && (status.atem.streaming || status.atem.streamingBitrate || status.atem.streamingService)) {
    const a = status.atem;
    const bitrateKbps = a.streamingBitrate ? Math.round(a.streamingBitrate / 1000) : undefined;
    const health = healthLabel(bitrateKbps);
    const metrics: DeviceCard['metrics'] = [];
    if (a.streamingService) metrics.push({ label: 'Platform', value: a.streamingService });
    metrics.push({ label: 'Status', value: a.streaming ? 'LIVE' : 'Idle', color: a.streaming ? colors.online : colors.textMuted });
    if (bitrateKbps != null) {
      metrics.push({ label: 'Bitrate', value: formatBitrate(bitrateKbps), color: health.color });
      metrics.push({ label: 'Health', value: health.text, color: health.color });
    }
    if (a.streamingCacheUsed != null) {
      const cacheMB = (a.streamingCacheUsed / (1024 * 1024)).toFixed(1);
      metrics.push({ label: 'Cache Used', value: `${cacheMB} MB` });
    }
    cards.push({
      id: 'atem-encoder',
      name: `${a.model || 'ATEM'} Encoder`,
      category: 'streaming',
      connected: a.connected,
      statusLabel: streamStatusLabel(a.connected, a.streaming),
      statusColor: streamStatusColor(a.connected, a.streaming),
      metrics,
    });
  }

  // OBS Studio
  if (status.obs && isDevicePresent(status.obs)) {
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
  if (status.vmix && isDevicePresent(status.vmix)) {
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
  if (status.encoder && isDevicePresent(status.encoder) && !isDevicePresent(status.obs)) {
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
    if (e.cpuUsage != null) metrics.push({ label: 'CPU', value: formatPercent(e.cpuUsage), color: percentColor(e.cpuUsage) });
    if (e.congestion != null && e.congestion > 0) metrics.push({ label: 'Congestion', value: formatPercent(e.congestion), color: percentColor(e.congestion) });
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
    if (yt.healthStatus) {
      const hColor = yt.healthStatus === 'good' ? colors.online : yt.healthStatus === 'ok' ? colors.warning : colors.critical;
      metrics.push({ label: 'Health', value: yt.healthStatus, color: hColor });
    }
    if (yt.resolution) metrics.push({ label: 'Resolution', value: yt.resolution });
    if (yt.framerate != null) metrics.push({ label: 'Framerate', value: `${yt.framerate} fps` });
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
    if (fb.healthStatus) {
      const hColor = fb.healthStatus === 'good' ? colors.online : fb.healthStatus === 'ok' ? colors.warning : colors.critical;
      metrics.push({ label: 'Health', value: fb.healthStatus, color: hColor });
    }
    if (fb.resolution) metrics.push({ label: 'Resolution', value: fb.resolution });
    if (fb.framerate != null) metrics.push({ label: 'Framerate', value: `${fb.framerate} fps` });
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

  // HyperDeck(s)
  if (status.hyperdeck && isDevicePresent(status.hyperdeck)) {
    const h = status.hyperdeck;
    if (h.hyperdecks && h.hyperdecks.length > 0) {
      h.hyperdecks.forEach((deck, i) => {
        const metrics: DeviceCard['metrics'] = [];
        if (deck.recording != null) {
          metrics.push({ label: 'Status', value: deck.recording ? 'Recording' : 'Idle', color: deck.recording ? colors.critical : colors.textMuted });
        }
        if (deck.diskSpace) {
          if (deck.diskSpace.percentUsed != null) metrics.push({ label: 'Disk Used', value: `${Math.round(deck.diskSpace.percentUsed)}%`, color: percentColor(deck.diskSpace.percentUsed) });
          if (deck.diskSpace.freeGB != null) metrics.push({ label: 'Free', value: `${deck.diskSpace.freeGB.toFixed(1)} GB` });
          if (deck.diskSpace.minutesRemaining != null) metrics.push({ label: 'Time Left', value: `${Math.round(deck.diskSpace.minutesRemaining)} min`, color: deck.diskSpace.minutesRemaining < 30 ? colors.warning : colors.online });
        }
        cards.push({
          id: `hyperdeck-${i}`,
          name: deck.name || `HyperDeck ${i + 1}`,
          category: 'recording',
          connected: deck.connected,
          statusLabel: deck.connected ? (deck.recording ? 'Recording' : 'Connected') : 'Offline',
          statusColor: deck.connected ? (deck.recording ? colors.critical : colors.online) : colors.offline,
          metrics,
        });
      });
    } else {
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
  }

  // ATEM Recording (separate card when no HyperDeck)
  if (status.atem?.recording && !isDevicePresent(status.hyperdeck)) {
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
  if (status.propresenter && isDevicePresent(status.propresenter)) {
    const p = status.propresenter;
    const metrics: DeviceCard['metrics'] = [];
    if (p.currentPresentation) metrics.push({ label: 'Presentation', value: p.currentPresentation });
    if (p.slideIndex != null && p.totalSlides != null) {
      metrics.push({ label: 'Slide', value: `${p.slideIndex + 1} / ${p.totalSlides}` });
    } else if (p.currentSlide) {
      metrics.push({ label: 'Slide', value: p.currentSlide });
    }
    if (p.activeLook) metrics.push({ label: 'Active Look', value: p.activeLook });
    if (p.timers && p.timers.length > 0) {
      p.timers.forEach(t => {
        metrics.push({ label: t.name || 'Timer', value: t.value, color: t.state === 'running' ? colors.online : colors.textMuted });
      });
    }
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
  if (status.mixer && isDevicePresent(status.mixer)) {
    const m = status.mixer;
    const hasWarning = m.mainMuted || status.audio?.silenceDetected;
    const metrics: DeviceCard['metrics'] = [];
    if (m.model) metrics.push({ label: 'Model', value: m.model });
    if (m.mainMuted) metrics.push({ label: 'Main Bus', value: 'MUTED', color: colors.warning });
    if (status.audio?.silenceDetected) metrics.push({ label: 'Audio', value: 'SILENCE DETECTED', color: colors.critical });
    if (m.channels && m.channels.length > 0) {
      const mutedCount = m.channels.filter(c => c.muted).length;
      metrics.push({ label: 'Channels', value: `${m.channels.length}` });
      if (mutedCount > 0) {
        metrics.push({ label: 'Ch. Muted', value: `${mutedCount}`, color: colors.warning });
      }
    }
    cards.push({
      id: 'mixer',
      name: m.model || 'Audio Mixer',
      category: 'audio',
      connected: m.connected,
      statusLabel: hasWarning ? (m.mainMuted ? 'MUTED' : 'Silence') : (m.connected ? 'Connected' : 'Offline'),
      statusColor: hasWarning ? colors.warning : (m.connected ? colors.online : colors.offline),
      metrics,
    });
  }

  // PTZ Cameras (support both ptz.cameras and top-level ptzCameras)
  {
    const cameras = (status.ptz?.cameras || []).concat(status.ptzCameras || []);
    if (cameras.length > 0) {
      const connectedCount = cameras.filter(c => c.connected).length;
      const metrics: DeviceCard['metrics'] = [];
      metrics.push({ label: 'Cameras', value: `${connectedCount}/${cameras.length} online` });
      cameras.forEach(cam => {
        metrics.push({
          label: cam.name || 'Camera',
          value: cam.connected ? 'Online' : 'Offline',
          color: cam.connected ? colors.online : colors.offline,
        });
      });
      cards.push({
        id: 'ptz',
        name: 'PTZ Cameras',
        category: 'network',
        connected: connectedCount > 0,
        statusLabel: `${connectedCount}/${cameras.length}`,
        statusColor: connectedCount > 0 ? colors.online : colors.offline,
        metrics,
      });
    } else if (status.ptz && isDevicePresent(status.ptz)) {
      cards.push({
        id: 'ptz',
        name: 'PTZ Cameras',
        category: 'network',
        connected: status.ptz.connected,
        statusLabel: status.ptz.connected ? 'Connected' : 'Offline',
        statusColor: status.ptz.connected ? colors.online : colors.offline,
        metrics: [],
      });
    }
  }

  // Companion
  if (status.companion && isDevicePresent(status.companion)) {
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

  // Smart Plugs
  if (status.smartPlugs && status.smartPlugs.length > 0) {
    status.smartPlugs.forEach((plug, i) => {
      const metrics: DeviceCard['metrics'] = [
        { label: 'Power', value: plug.on ? 'ON' : 'OFF', color: plug.on ? colors.online : colors.offline },
      ];
      if (plug.watts != null) metrics.push({ label: 'Watts', value: `${plug.watts} W` });
      cards.push({
        id: `smartplug-${i}`,
        name: plug.name || `Smart Plug ${i + 1}`,
        category: 'network',
        connected: plug.on,
        statusLabel: plug.on ? 'ON' : 'OFF',
        statusColor: plug.on ? colors.online : colors.offline,
        metrics,
      });
    });
  }

  // VideoHubs
  if (status.videohubs && status.videohubs.length > 0) {
    status.videohubs.forEach((vh, i) => {
      const metrics: DeviceCard['metrics'] = [];
      if (vh.inputs != null && vh.outputs != null) {
        metrics.push({ label: 'I/O', value: `${vh.inputs} in / ${vh.outputs} out` });
      }
      cards.push({
        id: `videohub-${i}`,
        name: vh.name || `VideoHub ${i + 1}`,
        category: 'switching',
        connected: vh.connected,
        statusLabel: vh.connected ? 'Connected' : 'Offline',
        statusColor: vh.connected ? colors.online : colors.offline,
        metrics,
      });
    });
  }

  // Resolume
  if (status.resolume && isDevicePresent(status.resolume)) {
    const r = status.resolume;
    const metrics: DeviceCard['metrics'] = [];
    if (r.version) metrics.push({ label: 'Version', value: r.version });
    cards.push({
      id: 'resolume',
      name: 'Resolume',
      category: 'presentation',
      connected: r.connected,
      statusLabel: r.connected ? 'Connected' : 'Offline',
      statusColor: r.connected ? colors.online : colors.offline,
      metrics,
    });
  }

  // Backup Encoder
  if (status.backupEncoder && isDevicePresent(status.backupEncoder)) {
    const b = status.backupEncoder;
    const health = healthLabel(b.bitrate);
    const metrics: DeviceCard['metrics'] = [];
    if (b.type) metrics.push({ label: 'Type', value: b.type });
    if (b.streaming != null) {
      metrics.push({ label: 'Status', value: b.streaming ? 'LIVE' : 'Standby', color: b.streaming ? colors.online : colors.textMuted });
    }
    if (b.bitrate != null) {
      metrics.push({ label: 'Bitrate', value: formatBitrate(b.bitrate), color: health.color });
    }
    cards.push({
      id: 'backup-encoder',
      name: b.name || 'Backup Encoder',
      category: 'streaming',
      connected: b.connected,
      statusLabel: streamStatusLabel(b.connected, b.streaming),
      statusColor: streamStatusColor(b.connected, b.streaming),
      metrics,
    });
  }

  // System
  if (status.system) {
    const s = status.system;
    const metrics: DeviceCard['metrics'] = [];
    if (s.appVersion) metrics.push({ label: 'Version', value: s.appVersion });
    if (s.roomName) metrics.push({ label: 'Room', value: s.roomName });
    const cpuVal = typeof s.cpu === 'object' ? s.cpu?.usage : s.cpu;
    const memVal = typeof s.memory === 'object' ? s.memory?.usage : s.memory;
    const diskVal = typeof s.disk === 'object' ? s.disk?.usage : s.disk;
    if (cpuVal != null) metrics.push({ label: 'CPU', value: formatPercent(cpuVal), color: percentColor(cpuVal) });
    if (memVal != null) metrics.push({ label: 'RAM', value: formatPercent(memVal), color: percentColor(memVal) });
    if (diskVal != null) metrics.push({ label: 'Disk', value: formatPercent(diskVal), color: percentColor(diskVal) });
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

function SystemStat({ label, value, unit }: { label: string; value?: number; unit: string }) {
  const v = value != null ? Math.round(value) : null;
  const color = v != null
    ? v >= 85 ? colors.critical
      : v >= 70 ? colors.warning
        : colors.online
    : colors.textMuted;

  return (
    <View style={systemStyles.stat}>
      <Text style={systemStyles.label}>{label}</Text>
      <Text style={[systemStyles.value, { color }]}>
        {v != null ? `${v}${unit}` : '--'}
      </Text>
    </View>
  );
}

interface DeviceInfo {
  name: string;
  type: string;
  connected: boolean;
  detail?: string;
}

function buildDeviceList(status: DeviceStatus | null): DeviceInfo[] {
  if (!status) return [];
  const devices: DeviceInfo[] = [];

  if (status.atem) {
    devices.push({
      name: status.atem.model || 'ATEM Switcher',
      type: 'atem',
      connected: status.atem.connected,
      detail: status.atem.streaming ? 'Streaming' : undefined,
    });
  }
  if (status.obs) {
    devices.push({
      name: 'OBS Studio',
      type: 'obs',
      connected: status.obs.connected,
      detail: status.obs.streaming ? `Streaming ${status.obs.currentScene ? `- ${status.obs.currentScene}` : ''}` : status.obs.currentScene,
    });
  }
  if (status.vmix) {
    devices.push({
      name: 'vMix',
      type: 'vmix',
      connected: status.vmix.connected,
    });
  }
  if (status.encoder && !status.obs) {
    devices.push({
      name: status.encoder.name || status.encoder.type || 'Streaming Encoder',
      type: 'encoder',
      connected: status.encoder.connected,
      detail: status.encoder.streaming ? 'Streaming' : undefined,
    });
  }
  if (status.mixer) {
    devices.push({
      name: status.mixer.model || 'Audio Mixer',
      type: 'mixer',
      connected: status.mixer.connected,
    });
  }
  if (status.propresenter) {
    devices.push({
      name: 'ProPresenter',
      type: 'propresenter',
      connected: status.propresenter.connected,
      detail: status.propresenter.currentSlide,
    });
  }
  if (status.companion) {
    devices.push({
      name: 'Companion',
      type: 'companion',
      connected: status.companion.connected,
    });
  }
  if (status.hyperdeck) {
    devices.push({
      name: 'HyperDeck',
      type: 'hyperdeck',
      connected: status.hyperdeck.connected,
      detail: status.hyperdeck.recording ? 'Recording' : undefined,
    });
  }

  return devices;
}

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
