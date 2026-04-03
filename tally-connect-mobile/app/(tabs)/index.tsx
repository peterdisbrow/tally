import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View, Text, ScrollView, StyleSheet, RefreshControl,
  TouchableOpacity, LayoutAnimation, Platform, UIManager, Animated, ActivityIndicator,
} from 'react-native';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useStatusStore, useActiveRoomStatus } from '../../src/stores/statusStore';
import { useAlertStore } from '../../src/stores/alertStore';
import { usePolling } from '../../src/hooks/usePolling';
import { useThemeColors, type ThemeColors } from '../../src/theme/ThemeContext';
import { spacing, borderRadius, fontSize } from '../../src/theme/spacing';
import { api } from '../../src/api/client';
import { PulseDot } from '../../src/components/PulseDot';
import { GlassCard } from '../../src/components/GlassCard';
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

function percentColor(v: number | undefined, colors: ThemeColors): string {
  if (v == null) return colors.textMuted;
  if (v >= 85) return colors.critical;
  if (v >= 70) return colors.warning;
  return colors.online;
}

function healthLabel(kbps: number | undefined, colors: ThemeColors): { text: string; color: string } {
  if (kbps == null) return { text: '--', color: colors.textMuted };
  if (kbps >= 4000) return { text: 'Excellent', color: colors.online };
  if (kbps >= 2000) return { text: 'Fair', color: colors.warning };
  return { text: 'Poor', color: colors.critical };
}

function streamStatusColor(connected: boolean, streaming: boolean | undefined, colors: ThemeColors): string {
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

function buildDeviceCards(status: DeviceStatus | null, colors: ThemeColors): DeviceCard[] {
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
    ];
    if (a.protocolVersion) metrics.push({ label: 'Firmware', value: `v${a.protocolVersion}` });
    metrics.push(
      { label: 'Program', value: pgmName, color: colors.tallyProgram },
      { label: 'Preview', value: pvwName, color: colors.tallyPreview },
    );
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
    const health = healthLabel(bitrateKbps, colors);
    const metrics: DeviceCard['metrics'] = [];
    if (a.protocolVersion) metrics.push({ label: 'Firmware', value: `v${a.protocolVersion}` });
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
      statusColor: streamStatusColor(a.connected, a.streaming, colors),
      metrics,
    });
  }

  // OBS Studio
  if (status.obs && isDevicePresent(status.obs)) {
    const o = status.obs;
    const health = healthLabel(o.bitrate, colors);
    const metrics: DeviceCard['metrics'] = [];
    if (o.version) metrics.push({ label: 'Version', value: `v${o.version}` });
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
    if (o.strain != null) metrics.push({ label: 'CPU Load', value: `${Math.round(o.strain * 100)}%`, color: percentColor(o.strain * 100, colors) });
    cards.push({
      id: 'obs',
      name: 'OBS Studio',
      category: 'streaming',
      connected: o.connected,
      statusLabel: streamStatusLabel(o.connected, o.streaming, o.recording),
      statusColor: streamStatusColor(o.connected, o.streaming, colors),
      metrics,
    });
  }

  // vMix
  if (status.vmix && isDevicePresent(status.vmix)) {
    const v = status.vmix;
    const metrics: DeviceCard['metrics'] = [];
    if (v.version) metrics.push({ label: 'Version', value: `${v.edition ? v.edition + ' ' : ''}v${v.version}` });
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
      statusColor: streamStatusColor(v.connected, v.streaming, colors),
      metrics,
    });
  }

  // Generic Encoder (when OBS not present)
  if (status.encoder && isDevicePresent(status.encoder) && !isDevicePresent(status.obs)) {
    const e = status.encoder;
    const health = healthLabel(e.bitrate, colors);
    const metrics: DeviceCard['metrics'] = [];
    if (e.type) metrics.push({ label: 'Type', value: e.type });
    if (e.firmwareVersion) metrics.push({ label: 'Firmware', value: `v${e.firmwareVersion}` });
    if (e.streaming != null) {
      metrics.push({ label: 'Status', value: e.streaming ? 'LIVE' : 'Idle', color: e.streaming ? colors.online : colors.textMuted });
    }
    if (e.bitrate != null) {
      metrics.push({ label: 'Bitrate', value: formatBitrate(e.bitrate), color: health.color });
      metrics.push({ label: 'Health', value: health.text, color: health.color });
    }
    if (e.fps != null) metrics.push({ label: 'FPS', value: `${Math.round(e.fps)}` });
    if (e.cpuUsage != null) metrics.push({ label: 'CPU', value: formatPercent(e.cpuUsage), color: percentColor(e.cpuUsage, colors) });
    if (e.congestion != null && e.congestion > 0) metrics.push({ label: 'Congestion', value: formatPercent(e.congestion), color: percentColor(e.congestion, colors) });
    cards.push({
      id: 'encoder',
      name: e.name || e.type || 'Encoder',
      category: 'streaming',
      connected: e.connected,
      statusLabel: streamStatusLabel(e.connected, e.streaming),
      statusColor: streamStatusColor(e.connected, e.streaming, colors),
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
          if (deck.diskSpace.percentUsed != null) metrics.push({ label: 'Disk Used', value: `${Math.round(deck.diskSpace.percentUsed)}%`, color: percentColor(deck.diskSpace.percentUsed, colors) });
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
    if (p.version) metrics.push({ label: 'Version', value: `v${p.version}` });
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
    if (m.firmware) metrics.push({ label: 'Firmware', value: `v${m.firmware}` });
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
    const health = healthLabel(b.bitrate, colors);
    const metrics: DeviceCard['metrics'] = [];
    if (b.type) metrics.push({ label: 'Type', value: b.type });
    if (b.firmwareVersion) metrics.push({ label: 'Firmware', value: `v${b.firmwareVersion}` });
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
      statusColor: streamStatusColor(b.connected, b.streaming, colors),
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
    if (cpuVal != null) metrics.push({ label: 'CPU', value: formatPercent(cpuVal), color: percentColor(cpuVal, colors) });
    if (memVal != null) metrics.push({ label: 'RAM', value: formatPercent(memVal), color: percentColor(memVal, colors) });
    if (diskVal != null) metrics.push({ label: 'Disk', value: formatPercent(diskVal), color: percentColor(diskVal, colors) });
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

// ─── Icons for Device Categories ────────────────────────────────────────────

const DEVICE_ICONS: Record<string, { lib: 'ion' | 'mci'; name: string }> = {
  atem: { lib: 'mci', name: 'tune-variant' },
  'atem-encoder': { lib: 'ion', name: 'radio-outline' },
  obs: { lib: 'ion', name: 'desktop-outline' },
  vmix: { lib: 'mci', name: 'movie-open-outline' },
  encoder: { lib: 'ion', name: 'radio-outline' },
  youtube: { lib: 'ion', name: 'play-circle-outline' },
  facebook: { lib: 'ion', name: 'logo-facebook' },
  hyperdeck: { lib: 'mci', name: 'harddisk' },
  'atem-recording': { lib: 'mci', name: 'record-circle-outline' },
  propresenter: { lib: 'ion', name: 'tv-outline' },
  resolume: { lib: 'ion', name: 'color-palette-outline' },
  mixer: { lib: 'ion', name: 'volume-high-outline' },
  ptz: { lib: 'ion', name: 'camera-outline' },
  companion: { lib: 'ion', name: 'game-controller-outline' },
  system: { lib: 'ion', name: 'settings-outline' },
};

function DeviceIcon({ id, size = 16, color, colors }: { id: string; size?: number; color?: string; colors: ThemeColors }) {
  const iconColor = color ?? colors.textSecondary;
  let icon = DEVICE_ICONS[id];
  if (!icon) {
    if (id.startsWith('smartplug')) icon = { lib: 'mci', name: 'power-plug-outline' };
    else if (id.startsWith('videohub')) icon = { lib: 'mci', name: 'swap-horizontal' };
    else if (id.startsWith('hyperdeck')) icon = { lib: 'mci', name: 'harddisk' };
    else icon = { lib: 'ion', name: 'hardware-chip-outline' };
  }
  if (icon.lib === 'mci') return <MaterialCommunityIcons name={icon.name as any} size={size} color={iconColor} />;
  return <Ionicons name={icon.name as any} size={size} color={iconColor} />;
}

// ─── LIVE Badge Component ───────────────────────────────────────────────────

function LiveBadge({ startedAt, colors }: { startedAt?: string; colors: ThemeColors }) {
  const pulseAnim = useRef(new Animated.Value(0.7)).current;
  const [elapsed, setElapsed] = useState('');

  useEffect(() => {
    Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, { toValue: 1, duration: 800, useNativeDriver: true }),
        Animated.timing(pulseAnim, { toValue: 0.7, duration: 800, useNativeDriver: true }),
      ]),
    ).start();
  }, [pulseAnim]);

  useEffect(() => {
    if (!startedAt) return;
    const update = () => {
      const diff = Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000);
      const h = Math.floor(diff / 3600);
      const m = Math.floor((diff % 3600) / 60);
      const s = diff % 60;
      setElapsed(`${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`);
    };
    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, [startedAt]);

  return (
    <Animated.View style={[{
      position: 'absolute',
      top: 0,
      right: 0,
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: 'rgba(239, 68, 68, 0.9)',
      borderRadius: borderRadius.sm,
      paddingHorizontal: spacing.sm,
      paddingVertical: 4,
      gap: 4,
      shadowColor: colors.live,
      shadowOpacity: 0.5,
      shadowRadius: 8,
      shadowOffset: { width: 0, height: 2 },
    }, { opacity: pulseAnim }]}>
      <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: '#ffffff' }} />
      <Text style={{ fontSize: 10, fontWeight: '800', color: '#ffffff', letterSpacing: 1 }}>LIVE</Text>
      {elapsed ? <Text style={{ fontSize: 10, fontWeight: '600', color: 'rgba(255,255,255,0.8)' }}>{elapsed}</Text> : null}
    </Animated.View>
  );
}

// ─── System Resource Bar ────────────────────────────────────────────────────

function ResourceBar({ label, value, color, colors }: { label: string; value: number; color: string; colors: ThemeColors }) {
  return (
    <View style={{ marginBottom: spacing.sm }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 }}>
        <Text style={{ fontSize: fontSize.xs, color: colors.textSecondary, fontWeight: '600' }}>{label}</Text>
        <Text style={{ fontSize: fontSize.xs, fontWeight: '700', color }}>{Math.round(value)}%</Text>
      </View>
      <View style={{ height: 4, backgroundColor: colors.trackColor, borderRadius: 2, overflow: 'hidden' }}>
        <View style={{ height: 4, borderRadius: 2, width: `${Math.min(value, 100)}%`, backgroundColor: color }} />
      </View>
    </View>
  );
}

// ─── Mini Dashboard Components ──────────────────────────────────────────────

function MetricCard({ label, value, unit, valueColor, colors }: {
  label: string; value: string; unit: string; valueColor: string; colors: ThemeColors;
}) {
  return (
    <View style={[styles.metricCard, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <Text style={[styles.metricCardLabel, { color: colors.textMuted }]}>{label}</Text>
      <Text style={[styles.metricCardValue, { color: valueColor }]}>{value}</Text>
      {unit ? <Text style={[styles.metricCardUnit, { color: colors.textMuted }]}>{unit}</Text> : null}
    </View>
  );
}

function timeAgo(timestamp: string): string {
  const diff = Math.floor((Date.now() - new Date(timestamp).getTime()) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function statusTimeAgo(ts: number): string {
  if (!ts) return '';
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 5) return 'just now';
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  return `${Math.floor(diff / 3600)}h ago`;
}

function AlertBar({ alerts, colors }: { alerts: Array<{ id: string; severity: string; message: string; timestamp: string; roomName?: string }>; colors: ThemeColors }) {
  // Show the most recent unacknowledged alert, or "All Systems Normal"
  const activeAlerts = alerts.filter(a => a.severity === 'CRITICAL' || a.severity === 'EMERGENCY' || a.severity === 'WARNING').slice(0, 1);

  if (activeAlerts.length === 0) {
    return (
      <View style={[styles.alertBar, {
        backgroundColor: colors.isDark ? 'rgba(34,197,94,0.06)' : 'rgba(22,163,74,0.06)',
        borderColor: colors.isDark ? 'rgba(34,197,94,0.15)' : 'rgba(22,163,74,0.15)',
      }]}>
        <Ionicons name="checkmark-circle" size={14} color={colors.online} />
        <Text style={[styles.alertBarText, { color: colors.online }]}>All Systems Normal</Text>
      </View>
    );
  }

  const alert = activeAlerts[0];
  const isCritical = alert.severity === 'CRITICAL' || alert.severity === 'EMERGENCY';
  const dotColor = isCritical ? colors.critical : colors.warning;

  return (
    <View style={[styles.alertBar, {
      backgroundColor: isCritical
        ? (colors.isDark ? 'rgba(239,68,68,0.08)' : 'rgba(239,68,68,0.06)')
        : (colors.isDark ? 'rgba(245,158,11,0.06)' : 'rgba(245,158,11,0.05)'),
      borderColor: isCritical
        ? (colors.isDark ? 'rgba(239,68,68,0.2)' : 'rgba(239,68,68,0.15)')
        : (colors.isDark ? 'rgba(245,158,11,0.15)' : 'rgba(245,158,11,0.12)'),
    }]}>
      <View style={[styles.alertDot, { backgroundColor: dotColor }]} />
      <Text style={[styles.alertBarText, { color: colors.text }]} numberOfLines={1}>
        {alert.message}
      </Text>
      <Text style={[styles.alertBarTime, { color: colors.textMuted }]}>{timeAgo(alert.timestamp)}</Text>
    </View>
  );
}

// ─── Main Component ──────────────────────────────────────────────────────────

export default function DashboardScreen() {
  const colors = useThemeColors();

  const refreshAll = useStatusStore((s) => s.refreshAll);
  const isRefreshing = useStatusStore((s) => s.isRefreshing);
  const dashboardStats = useStatusStore((s) => s.dashboardStats);
  const activeRoomId = useStatusStore((s) => s.activeRoomId);
  const rooms = useStatusStore((s) => s.rooms);
  const updateInstanceStatus = useStatusStore((s) => s.updateInstanceStatus);
  const lastUpdate = useStatusStore((s) => s.lastUpdate);

  // Tick every 10s so relative "last updated" text stays current
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 10_000);
    return () => clearInterval(id);
  }, []);

  const status = useActiveRoomStatus();
  const alerts = useAlertStore((s) => s.alerts);
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

  const cards = buildDeviceCards(status, colors);
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

  const session = dashboardStats.activeSession;
  const sessionDuration = session?.duration != null
    ? `${Math.floor(session.duration / 3600)}h ${Math.floor((session.duration % 3600) / 60)}m`
    : null;

  // Stream stats
  const encoder = status?.encoder || status?.obs;
  const isStreaming = encoder?.streaming || status?.atem?.streaming;
  const bitrate = encoder?.bitrate;
  const fps = encoder?.fps;
  const ytViewers = status?.streamHealth?.youtube?.viewers;
  const fbViewers = status?.streamHealth?.facebook?.viewers;
  const totalViewers = (ytViewers || 0) + (fbViewers || 0);

  // System resources
  const sys = status?.system;
  const cpuVal = sys ? (typeof sys.cpu === 'object' ? sys.cpu?.usage : sys.cpu) : null;
  const memVal = sys ? (typeof sys.memory === 'object' ? sys.memory?.usage : sys.memory) : null;
  const diskVal = sys ? (typeof sys.disk === 'object' ? sys.disk?.usage : sys.disk) : null;

  // Tally cards from ATEM
  const atem = status?.atem;
  const atemInputs = atem?.inputs || {};
  const tallyCards = Object.entries(atemInputs)
    .filter(([, v]) => v.type === 'external')
    .map(([key, v]) => ({
      number: parseInt(key, 10),
      name: v.name || `Input ${key}`,
      isProgram: atem?.programInput === parseInt(key, 10),
      isPreview: atem?.previewInput === parseInt(key, 10),
    }))
    .sort((a, b) => a.number - b.number)
    .slice(0, 8);

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.bg }}
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl
          refreshing={isRefreshing}
          onRefresh={refreshAll}
          tintColor={colors.accent}
        />
      }
    >
      {/* Room Header with LIVE badge */}
      <View style={styles.roomRow}>
        <View style={styles.roomLeft}>
          <Text style={[styles.roomLabel, { color: colors.text }]}>
            {rooms.find((r) => r.id === activeRoomId)?.name || 'No Room Selected'}
          </Text>
          <PulseDot
            color={status?.connected !== false ? colors.online : colors.offline}
            size={10}
          />
        </View>
        {summary.isStreaming && <LiveBadge startedAt={session?.startedAt} colors={colors} />}
      </View>

      {/* Last updated timestamp */}
      {lastUpdate > 0 && (() => {
        const stale = Date.now() - lastUpdate > 60_000;
        return (
          <Text style={[styles.lastUpdatedText, { color: stale ? colors.warning : colors.textMuted }]}>
            Updated {statusTimeAgo(lastUpdate)}{stale ? ' · may be stale' : ''}
          </Text>
        );
      })()}

      {/* Mini Dashboard */}
      <View style={styles.metricRow}>
        <MetricCard
          label="DEVICES"
          value={summary.totalDevices > 0 ? `${summary.onlineDevices} / ${summary.totalDevices}` : '--'}
          unit={summary.totalDevices > 0 ? 'online' : ''}
          valueColor={
            summary.totalDevices === 0 ? colors.textMuted
              : summary.onlineDevices === summary.totalDevices ? colors.online
                : colors.warning
          }
          colors={colors}
        />
        <MetricCard
          label="STREAM"
          value={bitrate != null ? (bitrate / 1000).toFixed(1) : '--'}
          unit={bitrate != null ? 'Mbps' : ''}
          valueColor={
            bitrate == null ? colors.textMuted
              : bitrate >= 4000 ? colors.online
                : bitrate >= 2000 ? colors.warning
                  : colors.critical
          }
          colors={colors}
        />
        <MetricCard
          label="UPTIME"
          value={(() => {
            const dur = session?.duration;
            if (dur == null || !session?.active) return '--';
            const h = Math.floor(dur / 3600);
            const m = Math.floor((dur % 3600) / 60);
            return `${h}:${m.toString().padStart(2, '0')}`;
          })()}
          unit={session?.active && session?.duration != null ? 'hrs' : ''}
          valueColor={session?.active ? colors.online : colors.textMuted}
          colors={colors}
        />
      </View>

      {/* Alert Bar */}
      <AlertBar alerts={alerts} colors={colors} />

      {/* Session + Viewers Row */}
      {(session?.active || summary.totalViewers > 0) && (
        <View style={styles.infoRow}>
          {session?.active && (
            <View style={[styles.infoPill, { backgroundColor: colors.surface, borderColor: colors.border }]}>
              <PulseDot color={colors.online} size={6} />
              <Text style={[styles.infoText, { color: colors.textSecondary }]}>
                {sessionDuration || 'Active'}
                {session.incidents ? ` · ${session.incidents} alert${session.incidents !== 1 ? 's' : ''}` : ''}
              </Text>
            </View>
          )}
          {summary.totalViewers > 0 && (
            <View style={[styles.infoPill, { backgroundColor: colors.surface, borderColor: colors.border }]}>
              <Text style={[styles.infoText, { color: colors.textSecondary }]}>
                <Ionicons name="eye-outline" size={14} color={colors.textSecondary} /> {summary.totalViewers.toLocaleString()} viewer{summary.totalViewers !== 1 ? 's' : ''}
              </Text>
            </View>
          )}
        </View>
      )}

      {/* Stream Stats Card */}
      {isStreaming && (
        <GlassCard glowColor={colors.live} style={styles.streamCard}>
          <View style={styles.streamStatsRow}>
            {bitrate != null && (
              <View style={styles.streamStat}>
                <Text style={[styles.streamStatValue, { color: colors.text }]}>{(bitrate / 1000).toFixed(1)}</Text>
                <Text style={[styles.streamStatLabel, { color: colors.textSecondary }]}>BITRATE</Text>
              </View>
            )}
            {fps != null && (
              <View style={styles.streamStat}>
                <Text style={[styles.streamStatValue, { color: colors.text }]}>{Math.round(fps)}</Text>
                <Text style={[styles.streamStatLabel, { color: colors.textSecondary }]}>FPS</Text>
              </View>
            )}
            {totalViewers > 0 && (
              <View style={styles.streamStat}>
                <Text style={[styles.streamStatValue, { color: colors.text }]}>{totalViewers.toLocaleString()}</Text>
                <Text style={[styles.streamStatLabel, { color: colors.textSecondary }]}>VIEWERS</Text>
              </View>
            )}
            <View style={styles.platformTags}>
              {ytViewers != null && (
                <View style={[styles.platformTag, { backgroundColor: colors.isDark ? 'rgba(239,68,68,0.15)' : 'rgba(239,68,68,0.1)' }]}>
                  <Text style={[styles.platformTagText, { color: '#ef4444' }]}>YT</Text>
                </View>
              )}
              {fbViewers != null && (
                <View style={[styles.platformTag, { backgroundColor: colors.isDark ? 'rgba(59,130,246,0.15)' : 'rgba(59,130,246,0.1)' }]}>
                  <Text style={[styles.platformTagText, { color: '#3b82f6' }]}>FB</Text>
                </View>
              )}
            </View>
          </View>
        </GlassCard>
      )}

      {/* Camera Tally Cards */}
      {tallyCards.length > 0 && (
        <View style={styles.categorySection}>
          <Text style={[styles.categoryTitle, { color: colors.textSecondary }]}>Camera Tally</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            {tallyCards.map((input) => {
              const isPgm = input.isProgram;
              const isPvw = input.isPreview;
              return (
                <View
                  key={input.number}
                  style={[
                    styles.tallyCard,
                    isPgm && {
                      backgroundColor: 'rgba(239, 68, 68, 0.85)',
                      shadowColor: colors.tallyProgram,
                      shadowOpacity: 0.6,
                      shadowRadius: 12,
                      shadowOffset: { width: 0, height: 4 },
                      elevation: 8,
                    },
                    isPvw && {
                      backgroundColor: 'rgba(34, 197, 94, 0.7)',
                      shadowColor: colors.tallyPreview,
                      shadowOpacity: 0.4,
                      shadowRadius: 10,
                      shadowOffset: { width: 0, height: 4 },
                      elevation: 6,
                    },
                    !isPgm && !isPvw && {
                      backgroundColor: colors.surface,
                      borderWidth: 1,
                      borderColor: colors.border,
                    },
                  ]}
                >
                  <Text style={[styles.tallyNumber, { color: isPgm || isPvw ? '#ffffff' : colors.text }]}>{input.number}</Text>
                  <Text style={styles.tallyName} numberOfLines={1}>{input.name}</Text>
                  {(isPgm || isPvw) && (
                    <Text style={styles.tallyLabel}>{isPgm ? 'PGM' : 'PVW'}</Text>
                  )}
                </View>
              );
            })}
          </ScrollView>
        </View>
      )}

      {/* Device List -- single card with dividers */}
      {grouped.length === 0 ? (
        <View style={styles.emptyContainer}>
          {!status ? (
            <>
              <ActivityIndicator size="large" color={colors.accent} />
              <Text style={[styles.emptyText, { color: colors.textSecondary, marginTop: 12 }]}>
                Connecting to room...
              </Text>
            </>
          ) : (
            <Text style={[styles.emptyText, { color: colors.textMuted }]}>No devices configured</Text>
          )}
        </View>
      ) : (
        grouped.map(group => (
          <View key={group.key} style={styles.categorySection}>
            <Text style={[styles.categoryTitle, { color: colors.textSecondary }]}>{group.label}</Text>
            <View style={[styles.deviceListCard, { backgroundColor: colors.surface, borderColor: colors.border }]}>
              {group.cards.map((card, idx) => (
                <TouchableOpacity
                  key={card.id}
                  activeOpacity={0.7}
                  onPress={() => toggleExpanded(card.id)}
                >
                  <View style={[styles.deviceRow, idx < group.cards.length - 1 && { borderBottomWidth: 1, borderBottomColor: colors.border }]}>
                    {/* Card Header */}
                    <View style={styles.cardHeader}>
                      <DeviceIcon id={card.id} size={16} color={colors.textSecondary} colors={colors} />
                      <PulseDot color={card.statusColor} size={8} />
                      <Text style={[styles.cardName, { color: colors.text }]} numberOfLines={1}>{card.name}</Text>
                      <Text style={[styles.cardStatus, { color: card.statusColor }]}>
                        {card.statusLabel}
                      </Text>
                      <Ionicons name={expandedIds.has(card.id) ? 'chevron-up' : 'chevron-down'} size={14} color={colors.textMuted} />
                    </View>

                    {/* Expanded Metrics */}
                    {expandedIds.has(card.id) && card.metrics.length > 0 && (
                      <View style={[styles.metricsGrid, { borderTopColor: colors.border }]}>
                        {card.metrics.map((m, i) => (
                          <View key={i} style={styles.metricItem}>
                            <Text style={[styles.metricLabel, { color: colors.textMuted }]}>{m.label}</Text>
                            <Text style={[styles.metricValue, { color: colors.text }, m.color ? { color: m.color } : null]} numberOfLines={1}>
                              {m.value}
                            </Text>
                          </View>
                        ))}
                      </View>
                    )}
                  </View>
                </TouchableOpacity>
              ))}
            </View>
          </View>
        ))
      )}

      {/* System Resources */}
      {(cpuVal != null || memVal != null || diskVal != null) && (
        <View style={styles.categorySection}>
          <Text style={[styles.categoryTitle, { color: colors.textSecondary }]}>System Resources</Text>
          <GlassCard>
            {cpuVal != null && <ResourceBar label="CPU" value={cpuVal} color={percentColor(cpuVal, colors)} colors={colors} />}
            {memVal != null && <ResourceBar label="RAM" value={memVal} color={percentColor(memVal, colors)} colors={colors} />}
            {diskVal != null && <ResourceBar label="Disk" value={diskVal} color={percentColor(diskVal, colors)} colors={colors} />}
          </GlassCard>
        </View>
      )}

      <View style={{ height: spacing.xxxl }} />
    </ScrollView>
  );
}

// ─── Static styles (no color references) ────────────────────────────────────

const styles = StyleSheet.create({
  content: {
    padding: spacing.lg,
  },
  roomRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.xs,
  },
  lastUpdatedText: {
    fontSize: fontSize.xs,
    marginBottom: spacing.md,
  },
  roomLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  roomLabel: {
    fontSize: fontSize.lg,
    fontWeight: '700',
  },

  // Mini Dashboard
  metricRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginBottom: spacing.sm,
  },
  metricCard: {
    flex: 1,
    borderRadius: 12,
    padding: spacing.md,
    borderWidth: 1,
  },
  metricCardLabel: {
    fontSize: 10,
    fontWeight: '600',
    letterSpacing: 0.8,
    marginBottom: 4,
    textTransform: 'uppercase',
  },
  metricCardValue: {
    fontSize: 20,
    fontWeight: '700',
  },
  metricCardUnit: {
    fontSize: 11,
    marginTop: 2,
  },
  // Alert Bar
  alertBar: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 10,
    borderWidth: 1,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2,
    marginBottom: spacing.lg,
    gap: spacing.sm,
  },
  alertDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  alertBarText: {
    fontSize: fontSize.xs,
    fontWeight: '600',
    flex: 1,
  },
  alertBarTime: {
    fontSize: 10,
  },

  // Stream Stats
  streamCard: {
    marginBottom: spacing.lg,
  },
  streamStatsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xl,
  },
  streamStat: {
    alignItems: 'center',
  },
  streamStatValue: {
    fontSize: fontSize.xl,
    fontWeight: '700',
  },
  streamStatLabel: {
    fontSize: 9,
    fontWeight: '600',
    letterSpacing: 0.5,
    marginTop: 2,
  },
  platformTags: {
    flexDirection: 'row',
    gap: spacing.xs,
    marginLeft: 'auto',
  },
  platformTag: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    borderRadius: borderRadius.sm,
  },
  platformTagText: {
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.5,
  },

  // Camera Tally
  tallyCard: {
    width: 76,
    height: 84,
    borderRadius: borderRadius.md,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: spacing.sm,
    overflow: 'hidden',
  },
  tallyNumber: {
    fontSize: fontSize.xl,
    fontWeight: '800',
  },
  tallyName: {
    fontSize: fontSize.xs,
    color: 'rgba(255,255,255,0.8)',
    marginTop: 2,
    maxWidth: 64,
    textAlign: 'center',
  },
  tallyLabel: {
    fontSize: 9,
    fontWeight: '700',
    color: 'rgba(255,255,255,0.9)',
    marginTop: 2,
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
    borderRadius: borderRadius.full,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderWidth: 1,
    gap: spacing.sm,
  },
  infoText: {
    fontSize: fontSize.xs,
  },

  // Categories
  categorySection: {
    marginBottom: spacing.lg,
  },
  categoryTitle: {
    fontSize: fontSize.xs,
    textTransform: 'uppercase',
    letterSpacing: 1,
    fontWeight: '600',
    marginBottom: spacing.sm,
  },

  // Device List (single card with dividers)
  deviceListCard: {
    borderRadius: borderRadius.md,
    borderWidth: 1,
    overflow: 'hidden',
  },
  deviceRow: {},
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: spacing.md,
    gap: spacing.sm,
  },
  cardName: {
    flex: 1,
    fontSize: fontSize.md,
    fontWeight: '600',
  },
  cardStatus: {
    fontSize: fontSize.sm,
    fontWeight: '600',
    marginRight: spacing.sm,
  },
  // Metrics Grid
  metricsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.md,
    borderTopWidth: 1,
    paddingTop: spacing.md,
  },
  metricItem: {
    width: '50%',
    paddingVertical: spacing.xs,
    paddingRight: spacing.sm,
  },
  metricLabel: {
    fontSize: fontSize.xs,
    marginBottom: 2,
  },
  metricValue: {
    fontSize: fontSize.sm,
    fontWeight: '600',
  },

  // Empty state
  emptyContainer: {
    paddingVertical: spacing.xxxl,
    alignItems: 'center',
  },
  emptyText: {
    fontSize: fontSize.md,
    textAlign: 'center',
  },
});
