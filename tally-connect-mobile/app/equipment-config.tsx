import React from 'react';
import {
  View, Text, ScrollView, StyleSheet, RefreshControl,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useStatusStore, useActiveRoomStatus } from '../src/stores/statusStore';
import { colors } from '../src/theme/colors';
import { spacing, borderRadius, fontSize } from '../src/theme/spacing';
import type { DeviceStatus } from '../src/ws/types';

// ─── Types ───────────────────────────────────────────────────────────────────

interface ConfigDevice {
  id: string;
  name: string;
  icon: string;
  connected: boolean;
  fields: { label: string; value: string; sensitive?: boolean }[];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isPresent(device: Record<string, unknown> | undefined | null): boolean {
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

function maskSensitive(value: string): string {
  if (!value || value.length <= 8) return '********';
  return value.slice(0, 4) + '****' + value.slice(-4);
}

// ─── Device Config Builder ──────────────────────────────────────────────────

function buildConfigDevices(status: DeviceStatus | null): ConfigDevice[] {
  if (!status) return [];
  const devices: ConfigDevice[] = [];

  // ATEM Switcher
  if (status.atem && isPresent(status.atem)) {
    const a = status.atem;
    const fields: ConfigDevice['fields'] = [];
    fields.push({ label: 'Type', value: 'Video Switcher' });
    if (a.model) fields.push({ label: 'Model', value: a.model });
    if (a.protocolVersion) fields.push({ label: 'Firmware', value: `v${a.protocolVersion}` });
    fields.push({ label: 'Status', value: a.connected ? 'Connected' : 'Offline' });

    // Input assignments
    const inputs = a.inputs || {};
    const inputNames = Object.entries(inputs);
    if (inputNames.length > 0) {
      fields.push({ label: 'Inputs', value: `${inputNames.length} configured` });
      inputNames.forEach(([id, input]) => {
        const typeLabel = input.type ? ` (${input.type})` : '';
        fields.push({ label: `  Input ${id}`, value: `${input.name}${typeLabel}` });
      });
    }

    if (a.streaming != null) {
      fields.push({ label: 'Built-in Streaming', value: a.streaming ? 'Active' : 'Idle' });
    }
    if (a.streamingService) {
      fields.push({ label: 'Stream Platform', value: a.streamingService });
    }
    if (a.recording != null) {
      fields.push({ label: 'Recording', value: a.recording ? 'Active' : 'Idle' });
    }

    devices.push({ id: 'atem', name: a.model || 'ATEM Switcher', icon: 'tv-outline', connected: a.connected, fields });
  }

  // OBS Studio
  if (status.obs && isPresent(status.obs)) {
    const o = status.obs;
    const fields: ConfigDevice['fields'] = [];
    fields.push({ label: 'Type', value: 'Streaming Software' });
    if (o.version) fields.push({ label: 'Version', value: `v${o.version}` });
    fields.push({ label: 'Status', value: o.connected ? 'Connected' : 'Offline' });
    if (o.currentScene) fields.push({ label: 'Current Scene', value: o.currentScene });
    if (o.streaming != null) fields.push({ label: 'Streaming', value: o.streaming ? 'Live' : 'Idle' });
    if (o.recording != null) fields.push({ label: 'Recording', value: o.recording ? 'Active' : 'Idle' });
    if (o.bitrate != null) fields.push({ label: 'Bitrate', value: `${o.bitrate >= 1000 ? (o.bitrate / 1000).toFixed(1) + ' Mbps' : o.bitrate + ' Kbps'}` });
    if (o.fps != null) fields.push({ label: 'Frame Rate', value: `${Math.round(o.fps)} fps` });
    if (o.droppedFrames != null) fields.push({ label: 'Dropped Frames', value: `${o.droppedFrames}` });
    devices.push({ id: 'obs', name: 'OBS Studio', icon: 'videocam-outline', connected: o.connected, fields });
  }

  // vMix
  if (status.vmix && isPresent(status.vmix)) {
    const v = status.vmix;
    const fields: ConfigDevice['fields'] = [];
    fields.push({ label: 'Type', value: 'Streaming Software' });
    if (v.version) fields.push({ label: 'Version', value: `${v.edition ? v.edition + ' ' : ''}v${v.version}` });
    fields.push({ label: 'Status', value: v.connected ? 'Connected' : 'Offline' });
    if (v.streaming != null) fields.push({ label: 'Streaming', value: v.streaming ? 'Live' : 'Idle' });
    if (v.recording != null) fields.push({ label: 'Recording', value: v.recording ? 'Active' : 'Idle' });
    devices.push({ id: 'vmix', name: 'vMix', icon: 'videocam-outline', connected: v.connected, fields });
  }

  // Encoder
  if (status.encoder && isPresent(status.encoder)) {
    const e = status.encoder;
    const fields: ConfigDevice['fields'] = [];
    fields.push({ label: 'Type', value: e.type || 'Encoder' });
    if (e.name) fields.push({ label: 'Name', value: e.name });
    if (e.firmwareVersion) fields.push({ label: 'Firmware', value: `v${e.firmwareVersion}` });
    else if (e.details) fields.push({ label: 'Details', value: e.details });
    fields.push({ label: 'Status', value: e.connected ? 'Connected' : 'Offline' });
    if (e.streaming != null) fields.push({ label: 'Streaming', value: e.streaming ? 'Live' : 'Idle' });
    if (e.bitrate != null) fields.push({ label: 'Bitrate', value: `${e.bitrate >= 1000 ? (e.bitrate / 1000).toFixed(1) + ' Mbps' : e.bitrate + ' Kbps'}` });
    if (e.fps != null) fields.push({ label: 'Frame Rate', value: `${Math.round(e.fps)} fps` });
    if (e.cpuUsage != null) fields.push({ label: 'CPU Usage', value: `${Math.round(e.cpuUsage)}%` });
    if (e.congestion != null) fields.push({ label: 'Congestion', value: `${Math.round(e.congestion * 100)}%` });
    devices.push({ id: 'encoder', name: e.name || e.type || 'Encoder', icon: 'cloud-upload-outline', connected: e.connected, fields });
  }

  // Backup Encoder
  if (status.backupEncoder && isPresent(status.backupEncoder)) {
    const be = status.backupEncoder;
    const fields: ConfigDevice['fields'] = [];
    fields.push({ label: 'Type', value: be.type || 'Backup Encoder' });
    if (be.name) fields.push({ label: 'Name', value: be.name });
    if (be.firmwareVersion) fields.push({ label: 'Firmware', value: `v${be.firmwareVersion}` });
    else if (be.details) fields.push({ label: 'Details', value: be.details });
    fields.push({ label: 'Status', value: be.connected ? 'Connected' : 'Offline' });
    if (be.streaming != null) fields.push({ label: 'Streaming', value: be.streaming ? 'Live' : 'Idle' });
    if (be.bitrate != null) fields.push({ label: 'Bitrate', value: `${be.bitrate >= 1000 ? (be.bitrate / 1000).toFixed(1) + ' Mbps' : be.bitrate + ' Kbps'}` });
    devices.push({ id: 'backup-encoder', name: be.name || 'Backup Encoder', icon: 'cloud-upload-outline', connected: be.connected, fields });
  }

  // Audio Mixer
  if (status.mixer && isPresent(status.mixer)) {
    const m = status.mixer;
    const fields: ConfigDevice['fields'] = [];
    fields.push({ label: 'Type', value: 'Audio Mixer' });
    if (m.model) fields.push({ label: 'Model', value: m.model });
    if (m.firmware) fields.push({ label: 'Firmware', value: `v${m.firmware}` });
    fields.push({ label: 'Status', value: m.connected ? 'Connected' : 'Offline' });
    if (m.mainMuted != null) fields.push({ label: 'Main Bus', value: m.mainMuted ? 'MUTED' : 'Active' });
    if (m.channels && m.channels.length > 0) {
      fields.push({ label: 'Channels', value: `${m.channels.length} configured` });
      m.channels.slice(0, 8).forEach((ch) => {
        const muteTag = ch.muted ? ' [MUTED]' : '';
        fields.push({ label: `  ${ch.name}`, value: `${Math.round(ch.level)}dB${muteTag}` });
      });
      if (m.channels.length > 8) {
        fields.push({ label: '', value: `+${m.channels.length - 8} more channels` });
      }
    }
    devices.push({ id: 'mixer', name: m.model || 'Audio Mixer', icon: 'volume-high-outline', connected: m.connected, fields });
  }

  // ProPresenter
  if (status.propresenter && isPresent(status.propresenter)) {
    const p = status.propresenter;
    const fields: ConfigDevice['fields'] = [];
    fields.push({ label: 'Type', value: 'Presentation Software' });
    if (p.version) fields.push({ label: 'Version', value: `v${p.version}` });
    fields.push({ label: 'Status', value: p.connected ? 'Connected' : 'Offline' });
    if (p.currentPresentation) fields.push({ label: 'Presentation', value: p.currentPresentation });
    if (p.slideIndex != null && p.totalSlides != null) {
      fields.push({ label: 'Slide', value: `${p.slideIndex + 1} of ${p.totalSlides}` });
    }
    if (p.activeLook) fields.push({ label: 'Active Look', value: p.activeLook });
    if (p.timers && p.timers.length > 0) {
      p.timers.forEach((t) => {
        fields.push({ label: `Timer: ${t.name}`, value: `${t.value} (${t.state})` });
      });
    }
    devices.push({ id: 'propresenter', name: 'ProPresenter', icon: 'easel-outline', connected: p.connected, fields });
  }

  // Resolume
  if (status.resolume && isPresent(status.resolume)) {
    const r = status.resolume;
    const fields: ConfigDevice['fields'] = [];
    fields.push({ label: 'Type', value: 'VJ Software' });
    fields.push({ label: 'Status', value: r.connected ? 'Connected' : 'Offline' });
    if (r.version) fields.push({ label: 'Version', value: r.version });
    devices.push({ id: 'resolume', name: 'Resolume Arena', icon: 'color-palette-outline', connected: r.connected, fields });
  }

  // Companion
  if (status.companion && isPresent(status.companion)) {
    const c = status.companion;
    const fields: ConfigDevice['fields'] = [];
    fields.push({ label: 'Type', value: 'Button Control' });
    fields.push({ label: 'Status', value: c.connected ? 'Connected' : 'Offline' });
    devices.push({ id: 'companion', name: 'Bitfocus Companion', icon: 'grid-outline', connected: c.connected, fields });
  }

  // HyperDecks
  if (status.hyperdeck) {
    const h = status.hyperdeck;
    if (h.hyperdecks && h.hyperdecks.length > 0) {
      h.hyperdecks.forEach((deck, i) => {
        const fields: ConfigDevice['fields'] = [];
        fields.push({ label: 'Type', value: 'HyperDeck Recorder' });
        if (h.protocolVersion) fields.push({ label: 'Firmware', value: `v${h.protocolVersion}` });
        fields.push({ label: 'Status', value: deck.connected ? 'Connected' : 'Offline' });
        if (deck.recording != null) fields.push({ label: 'Recording', value: deck.recording ? 'Active' : 'Idle' });
        if (deck.diskSpace) {
          if (deck.diskSpace.freeGB != null) fields.push({ label: 'Free Space', value: `${deck.diskSpace.freeGB.toFixed(1)} GB` });
          if (deck.diskSpace.minutesRemaining != null) fields.push({ label: 'Time Remaining', value: `${Math.round(deck.diskSpace.minutesRemaining)} min` });
          if (deck.diskSpace.percentUsed != null) fields.push({ label: 'Disk Used', value: `${Math.round(deck.diskSpace.percentUsed)}%` });
        }
        devices.push({ id: `hyperdeck-${i}`, name: deck.name || `HyperDeck ${i + 1}`, icon: 'disc-outline', connected: deck.connected, fields });
      });
    } else if (isPresent(h as any)) {
      const fields: ConfigDevice['fields'] = [];
      fields.push({ label: 'Type', value: 'HyperDeck Recorder' });
      if (h.protocolVersion) fields.push({ label: 'Firmware', value: `v${h.protocolVersion}` });
      fields.push({ label: 'Status', value: h.connected ? 'Connected' : 'Offline' });
      if (h.recording != null) fields.push({ label: 'Recording', value: h.recording ? 'Active' : 'Idle' });
      devices.push({ id: 'hyperdeck', name: 'HyperDeck', icon: 'disc-outline', connected: h.connected, fields });
    }
  }

  // PTZ Cameras
  const cameras = status.ptzCameras || status.ptz?.cameras || [];
  if (cameras.length > 0) {
    cameras.forEach((cam, i) => {
      const fields: ConfigDevice['fields'] = [];
      fields.push({ label: 'Type', value: 'PTZ Camera' });
      fields.push({ label: 'Status', value: cam.connected ? 'Connected' : 'Offline' });
      devices.push({ id: `ptz-${i}`, name: cam.name || `PTZ Camera ${i + 1}`, icon: 'camera-outline', connected: cam.connected, fields });
    });
  }

  // Smart Plugs
  if (status.smartPlugs && status.smartPlugs.length > 0) {
    status.smartPlugs.forEach((plug, i) => {
      const fields: ConfigDevice['fields'] = [];
      fields.push({ label: 'Type', value: 'Smart Plug' });
      fields.push({ label: 'Power', value: plug.on ? 'ON' : 'OFF' });
      if (plug.watts != null) fields.push({ label: 'Power Draw', value: `${Math.round(plug.watts)} W` });
      devices.push({ id: `plug-${i}`, name: plug.name || `Smart Plug ${i + 1}`, icon: 'flash-outline', connected: true, fields });
    });
  }

  // VideoHubs
  if (status.videohubs && status.videohubs.length > 0) {
    status.videohubs.forEach((hub, i) => {
      const fields: ConfigDevice['fields'] = [];
      fields.push({ label: 'Type', value: 'Video Router' });
      fields.push({ label: 'Status', value: hub.connected ? 'Connected' : 'Offline' });
      if (hub.inputs != null) fields.push({ label: 'Inputs', value: `${hub.inputs}` });
      if (hub.outputs != null) fields.push({ label: 'Outputs', value: `${hub.outputs}` });
      devices.push({ id: `videohub-${i}`, name: hub.name || `VideoHub ${i + 1}`, icon: 'git-network-outline', connected: hub.connected, fields });
    });
  }

  // System Info
  if (status.system && isPresent(status.system as any)) {
    const s = status.system;
    const fields: ConfigDevice['fields'] = [];
    if (s.hostname) fields.push({ label: 'Hostname', value: s.hostname });
    if (s.platform) fields.push({ label: 'Platform', value: platformLabel(s.platform) });
    if (s.appVersion) fields.push({ label: 'App Version', value: s.appVersion });
    if (s.roomName) fields.push({ label: 'Room', value: s.roomName });
    if (s.uptime != null) fields.push({ label: 'Uptime', value: formatUptime(s.uptime) });
    const cpuVal = typeof s.cpu === 'object' ? s.cpu?.usage : s.cpu;
    if (cpuVal != null) fields.push({ label: 'CPU Usage', value: `${Math.round(cpuVal)}%` });
    const memVal = typeof s.memory === 'object' ? s.memory?.usage : s.memory;
    if (memVal != null) fields.push({ label: 'Memory Usage', value: `${Math.round(memVal)}%` });
    const diskVal = typeof s.disk === 'object' ? s.disk?.usage : s.disk;
    if (diskVal != null) fields.push({ label: 'Disk Usage', value: `${Math.round(diskVal)}%` });
    devices.push({ id: 'system', name: s.hostname || 'System', icon: 'desktop-outline', connected: true, fields });
  }

  return devices;
}

function platformLabel(platform: string): string {
  switch (platform) {
    case 'darwin': return 'macOS';
    case 'win32': return 'Windows';
    case 'linux': return 'Linux';
    default: return platform;
  }
}

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

// ─── Components ─────────────────────────────────────────────────────────────

function DeviceConfigCard({ device }: { device: ConfigDevice }) {
  return (
    <View style={styles.card}>
      <View style={styles.cardHeader}>
        <Ionicons name={device.icon as any} size={20} color={colors.accent} />
        <Text style={styles.cardTitle} numberOfLines={1}>{device.name}</Text>
        <View style={[styles.statusDot, { backgroundColor: device.connected ? colors.online : colors.offline }]} />
        <Text style={[styles.statusText, { color: device.connected ? colors.online : colors.offline }]}>
          {device.connected ? 'Online' : 'Offline'}
        </Text>
      </View>
      <View style={styles.fieldList}>
        {device.fields.map((f, i) => (
          <View key={`${f.label}-${i}`} style={styles.fieldRow}>
            <Text style={styles.fieldLabel}>{f.label}</Text>
            <Text
              style={[styles.fieldValue, f.sensitive && styles.fieldSensitive]}
              numberOfLines={1}
            >
              {f.sensitive ? maskSensitive(f.value) : f.value}
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
}

function EmptyState() {
  return (
    <View style={styles.emptyState}>
      <Ionicons name="hardware-chip-outline" size={48} color={colors.textMuted} />
      <Text style={styles.emptyTitle}>No Equipment Detected</Text>
      <Text style={styles.emptySubtitle}>
        Equipment configuration will appear here when a desktop client is connected to this room.
      </Text>
    </View>
  );
}

// ─── Screen ─────────────────────────────────────────────────────────────────

export default function EquipmentConfigScreen() {
  const status = useActiveRoomStatus();
  const activeRoomId = useStatusStore((s) => s.activeRoomId);
  const rooms = useStatusStore((s) => s.rooms);
  const refreshAll = useStatusStore((s) => s.refreshAll);
  const isRefreshing = useStatusStore((s) => s.isRefreshing);

  const activeRoom = rooms.find((r) => r.id === activeRoomId);
  const devices = buildConfigDevices(status);

  const onlineCount = devices.filter((d) => d.connected).length;
  const totalCount = devices.length;

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
      {/* Room & Summary Header */}
      <View style={styles.headerCard}>
        <View style={styles.headerTop}>
          <View>
            <Text style={styles.headerRoom}>{activeRoom?.name || 'No Room Selected'}</Text>
            <Text style={styles.headerSubtitle}>Equipment Configuration</Text>
          </View>
          <View style={styles.countBadge}>
            <Text style={styles.countText}>
              {onlineCount}/{totalCount}
            </Text>
            <Text style={styles.countLabel}>online</Text>
          </View>
        </View>
      </View>

      {/* Device List */}
      {devices.length === 0 ? (
        <EmptyState />
      ) : (
        devices.map((d) => <DeviceConfigCard key={d.id} device={d} />)
      )}

      <View style={{ height: spacing.xxxl }} />
    </ScrollView>
  );
}

// ─── Styles ─────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  content: {
    padding: spacing.lg,
  },
  headerCard: {
    backgroundColor: colors.surface,
    borderRadius: borderRadius.md,
    padding: spacing.lg,
    marginBottom: spacing.xxl,
    borderWidth: 1,
    borderColor: colors.border,
  },
  headerTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  headerRoom: {
    fontSize: fontSize.lg,
    fontWeight: '700',
    color: colors.text,
  },
  headerSubtitle: {
    fontSize: fontSize.sm,
    color: colors.textSecondary,
    marginTop: 2,
  },
  countBadge: {
    alignItems: 'center',
    backgroundColor: colors.surfaceElevated,
    borderRadius: borderRadius.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  countText: {
    fontSize: fontSize.xl,
    fontWeight: '800',
    color: colors.accent,
  },
  countLabel: {
    fontSize: fontSize.xs,
    color: colors.textSecondary,
    marginTop: 1,
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: borderRadius.md,
    padding: spacing.lg,
    marginBottom: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: spacing.md,
    paddingBottom: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  cardTitle: {
    flex: 1,
    fontSize: fontSize.md,
    fontWeight: '700',
    color: colors.text,
    marginLeft: spacing.sm,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: spacing.xs,
  },
  statusText: {
    fontSize: fontSize.sm,
    fontWeight: '600',
  },
  fieldList: {},
  fieldRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: spacing.xs + 1,
  },
  fieldLabel: {
    fontSize: fontSize.sm,
    color: colors.textSecondary,
    flex: 1,
  },
  fieldValue: {
    fontSize: fontSize.sm,
    color: colors.text,
    fontWeight: '500',
    textAlign: 'right',
    flex: 1,
  },
  fieldSensitive: {
    fontFamily: 'Courier',
    color: colors.textMuted,
  },
  emptyState: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing.xxxl * 2,
    paddingHorizontal: spacing.xxl,
  },
  emptyTitle: {
    fontSize: fontSize.lg,
    fontWeight: '700',
    color: colors.text,
    marginTop: spacing.lg,
  },
  emptySubtitle: {
    fontSize: fontSize.sm,
    color: colors.textSecondary,
    textAlign: 'center',
    marginTop: spacing.sm,
    lineHeight: 20,
  },
});
