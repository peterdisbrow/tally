import React, { useEffect } from 'react';
import {
  View, Text, ScrollView, StyleSheet, RefreshControl,
} from 'react-native';
import { useStatusStore, useActiveRoomStatus } from '../../src/stores/statusStore';
import { usePolling } from '../../src/hooks/usePolling';
import { StatusCard } from '../../src/components/StatusCard';
import { TallyIndicator } from '../../src/components/TallyIndicator';
import { DeviceRow } from '../../src/components/DeviceRow';
import { StreamStats } from '../../src/components/StreamStats';
import { colors } from '../../src/theme/colors';
import { spacing, borderRadius, fontSize } from '../../src/theme/spacing';
import { api } from '../../src/api/client';
import type { DeviceStatus } from '../../src/ws/types';

export default function DashboardScreen() {
  const refreshAll = useStatusStore((s) => s.refreshAll);
  const isRefreshing = useStatusStore((s) => s.isRefreshing);
  const dashboardStats = useStatusStore((s) => s.dashboardStats);
  const activeRoomId = useStatusStore((s) => s.activeRoomId);
  const rooms = useStatusStore((s) => s.rooms);
  const instanceStatus = useStatusStore((s) => s.instanceStatus);
  const roomInstanceMap = useStatusStore((s) => s.roomInstanceMap);
  const updateInstanceStatus = useStatusStore((s) => s.updateInstanceStatus);

  const status = useActiveRoomStatus();

  // Initial fetch
  useEffect(() => {
    refreshAll();
  }, []);

  // Poll mobile summary every 5 seconds
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
      // Also update dashboard stats from the same endpoint
      useStatusStore.getState().fetchDashboardStats();
    } catch {
      // Will retry next poll
    }
  }, 5000);

  const healthScore = dashboardStats.healthScore;
  const healthColor = healthScore != null
    ? healthScore >= 80 ? colors.online
      : healthScore >= 50 ? colors.warning
        : colors.critical
    : colors.textMuted;

  // Build device list from status
  const devices = buildDeviceList(status);

  // Build tally inputs from ATEM
  const atem = status?.atem;
  const inputs = atem?.inputs || {};
  const tallyInputs = Object.entries(inputs)
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
      {/* Room Name + Connection Status */}
      <View style={styles.roomRow}>
        <Text style={styles.roomLabel}>
          {rooms.find((r) => r.id === activeRoomId)?.name || 'No Room Selected'}
        </Text>
        <View style={[
          styles.connectionDot,
          { backgroundColor: status?.connected !== false ? colors.online : colors.offline },
        ]} />
      </View>

      {/* Stats Cards */}
      <View style={styles.statsRow}>
        <StatusCard
          title="Health"
          value={healthScore != null ? `${healthScore}` : '--'}
          subtitle="/100"
          color={healthColor}
        />
        <View style={{ width: spacing.md }} />
        <StatusCard
          title="Session"
          value={dashboardStats.activeSession?.grade || '--'}
          subtitle={dashboardStats.activeSession?.active ? 'In Progress' : 'No session'}
          color={dashboardStats.activeSession?.active ? colors.online : colors.textMuted}
        />
      </View>

      {/* Tally Indicators */}
      {tallyInputs.length > 0 && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>TALLY</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            {tallyInputs.map((input) => (
              <TallyIndicator
                key={input.number}
                inputNumber={input.number}
                inputName={input.name}
                isProgram={input.isProgram}
                isPreview={input.isPreview}
              />
            ))}
          </ScrollView>
        </View>
      )}

      {/* Stream Stats */}
      {status && <StreamStats status={status} />}

      {/* Devices */}
      <View style={[styles.section, styles.devicesSection]}>
        <Text style={styles.sectionTitle}>DEVICES</Text>
        {devices.length === 0 ? (
          <Text style={styles.emptyText}>
            {status ? 'No devices configured' : 'Waiting for data...'}
          </Text>
        ) : (
          devices.map((d, i) => (
            <DeviceRow
              key={i}
              name={d.name}
              type={d.type}
              connected={d.connected}
              detail={d.detail}
            />
          ))
        )}
      </View>

      {/* System Info */}
      {status?.system && (
        <View style={styles.systemRow}>
          <SystemStat label="CPU" value={status.system.cpu} unit="%" />
          <SystemStat label="RAM" value={status.system.memory} unit="%" />
          <SystemStat label="Disk" value={status.system.disk} unit="%" />
        </View>
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
  if (status.encoder) {
    devices.push({
      name: status.encoder.name || status.encoder.type || 'Hardware Encoder',
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
  if (status.ptz) {
    if (status.ptz.cameras?.length) {
      for (const cam of status.ptz.cameras) {
        devices.push({
          name: cam.name || 'PTZ Camera',
          type: 'ptz',
          connected: cam.connected,
        });
      }
    } else {
      devices.push({
        name: 'PTZ Controller',
        type: 'ptz',
        connected: status.ptz.connected,
      });
    }
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
  statsRow: {
    flexDirection: 'row',
    marginBottom: spacing.lg,
  },
  section: {
    marginBottom: spacing.lg,
  },
  sectionTitle: {
    fontSize: fontSize.xs,
    color: colors.textSecondary,
    textTransform: 'uppercase',
    letterSpacing: 1,
    fontWeight: '600',
    marginBottom: spacing.md,
  },
  devicesSection: {
    backgroundColor: colors.surface,
    borderRadius: borderRadius.md,
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: colors.border,
    marginTop: spacing.lg,
  },
  emptyText: {
    fontSize: fontSize.md,
    color: colors.textMuted,
    textAlign: 'center',
    paddingVertical: spacing.xl,
  },
  systemRow: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    backgroundColor: colors.surface,
    borderRadius: borderRadius.md,
    padding: spacing.lg,
    marginTop: spacing.lg,
    borderWidth: 1,
    borderColor: colors.border,
  },
});

const systemStyles = StyleSheet.create({
  stat: {
    alignItems: 'center',
  },
  label: {
    fontSize: fontSize.xs,
    color: colors.textSecondary,
    marginBottom: spacing.xs,
  },
  value: {
    fontSize: fontSize.lg,
    fontWeight: '700',
  },
});
