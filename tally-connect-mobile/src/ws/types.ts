// WebSocket message types matching relay-server protocol

export interface StatusUpdate {
  type: 'status_update';
  churchId: string;
  name: string;
  status: DeviceStatus;
  instance: string | null;
  instanceStatus: Record<string, DeviceStatus>;
  roomInstanceMap: Record<string, string>;
  timestamp: string;
  lastHeartbeat: number;
}

export interface AlertMessage {
  type: 'alert';
  churchId: string;
  name: string;
  severity: 'EMERGENCY' | 'CRITICAL' | 'WARNING' | 'INFO';
  message: string;
  instance: string | null;
  roomId: string | null;
  timestamp: string;
}

export interface CommandResult {
  type: 'command_result';
  churchId: string;
  name: string;
  messageId: string;
  result: unknown;
  error: string | null;
}

export interface ChurchConnected {
  type: 'church_connected';
  churchId: string;
  name: string;
  instance: string;
  roomId: string | null;
  timestamp: string;
  connected: true;
  status: DeviceStatus;
  roomInstanceMap: Record<string, string>;
}

export interface ChurchDisconnected {
  type: 'church_disconnected';
  churchId: string;
  name: string;
  connected: false;
  status: DeviceStatus;
}

export interface ViewerSnapshot {
  type: 'viewer_snapshot';
  churchId: string;
  youtube?: { viewers: number; chatMessages?: number };
  facebook?: { viewers: number };
}

export type ServerMessage =
  | StatusUpdate
  | AlertMessage
  | CommandResult
  | ChurchConnected
  | ChurchDisconnected
  | ViewerSnapshot
  | { type: string; [key: string]: unknown };

// Device status shape from church-client status_update
export interface DeviceStatus {
  connected?: boolean;
  _disconnectedAt?: number;
  atem?: {
    connected: boolean;
    programInput?: number;
    previewInput?: number;
    streaming?: boolean;
    recording?: boolean;
    model?: string;
    inputs?: Record<string, { name: string; type: string }>;
  };
  obs?: {
    connected: boolean;
    streaming?: boolean;
    recording?: boolean;
    bitrate?: number;
    fps?: number;
    droppedFrames?: number;
    strain?: number;
    currentScene?: string;
  };
  vmix?: {
    connected: boolean;
    streaming?: boolean;
    recording?: boolean;
  };
  encoder?: {
    connected: boolean;
    streaming?: boolean;
    bitrate?: number;
    fps?: number;
    type?: string;
    name?: string;
  };
  mixer?: {
    connected: boolean;
    model?: string;
    channels?: Array<{
      name: string;
      level: number;
      muted: boolean;
    }>;
  };
  propresenter?: {
    connected: boolean;
    currentSlide?: string;
    currentPresentation?: string;
  };
  companion?: {
    connected: boolean;
  };
  hyperdeck?: {
    connected: boolean;
    recording?: boolean;
    diskRemaining?: number;
  };
  ptz?: {
    connected: boolean;
    cameras?: Array<{
      name: string;
      connected: boolean;
    }>;
  };
  system?: {
    cpu?: number;
    memory?: number;
    disk?: number;
    roomId?: string;
    roomName?: string;
    appVersion?: string;
  };
  streamHealth?: {
    youtube?: {
      status: string;
      viewers?: number;
      healthStatus?: string;
    };
    facebook?: {
      status: string;
      viewers?: number;
    };
  };
}

export interface Room {
  id: string;
  name: string;
  status?: DeviceStatus;
  connected?: boolean;
}

export interface ChatMessage {
  id: string;
  churchId: string;
  senderName: string;
  senderRole: 'td' | 'system' | 'ai' | 'admin';
  message: string;
  source: string;
  timestamp: string;
  roomId?: string | null;
}

export interface Alert {
  id: string;
  severity: 'EMERGENCY' | 'CRITICAL' | 'WARNING' | 'INFO';
  message: string;
  roomId?: string | null;
  roomName?: string;
  timestamp: string;
  acknowledged?: boolean;
  diagnosis?: {
    likely_cause: string;
    confidence: number;
    steps: string[];
    canAutoFix: boolean;
  };
}

export interface ServiceSession {
  active: boolean;
  grade?: string;
  duration?: number;
  incidents?: number;
  startedAt?: string;
}

export interface DashboardStats {
  healthScore?: number;
  uptimePercent?: number;
  alertsToday?: number;
  activeSession?: ServiceSession;
}
