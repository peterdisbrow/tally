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
    protocolVersion?: string;
    inputs?: Record<string, { name: string; type: string }>;
    streamingBitrate?: number | null;   // bps from ATEM SDK
    streamingCacheUsed?: number | null;  // bytes
    streamingService?: string | null;    // e.g. "YouTube", "Facebook"
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
    version?: string;
  };
  vmix?: {
    connected: boolean;
    streaming?: boolean;
    recording?: boolean;
    version?: string;
    edition?: string;
  };
  encoder?: {
    connected: boolean;
    streaming?: boolean;
    bitrate?: number;
    fps?: number;
    type?: string;
    name?: string;
    cpuUsage?: number;
    congestion?: number;
    firmwareVersion?: string;
    details?: string;
  };
  mixer?: {
    connected: boolean;
    model?: string;
    firmware?: string;
    mainMuted?: boolean;
    channels?: Array<{
      name: string;
      level: number;
      muted: boolean;
    }>;
  };
  audio?: {
    silenceDetected?: boolean;
  };
  propresenter?: {
    connected: boolean;
    currentSlide?: string;
    currentPresentation?: string;
    slideIndex?: number;
    totalSlides?: number;
    timers?: Array<{
      name: string;
      value: string;
      state: string;
    }>;
    activeLook?: string;
    version?: string;
  };
  companion?: {
    connected: boolean;
  };
  hyperdeck?: {
    connected: boolean;
    recording?: boolean;
    diskRemaining?: number;
    protocolVersion?: string;
    hyperdecks?: Array<{
      name?: string;
      connected: boolean;
      recording?: boolean;
      diskSpace?: {
        percentUsed?: number;
        freeGB?: number;
        minutesRemaining?: number;
      };
    }>;
  };
  ptz?: {
    connected: boolean;
    cameras?: Array<{
      name: string;
      connected: boolean;
    }>;
  };
  ptzCameras?: Array<{
    name: string;
    connected: boolean;
  }>;
  smartPlugs?: Array<{
    name: string;
    on: boolean;
    watts?: number;
  }>;
  videohubs?: Array<{
    name: string;
    connected: boolean;
    inputs?: number;
    outputs?: number;
  }>;
  resolume?: {
    connected: boolean;
    version?: string;
  };
  backupEncoder?: {
    connected: boolean;
    streaming?: boolean;
    bitrate?: number;
    name?: string;
    type?: string;
    firmwareVersion?: string;
    details?: string;
  };
  system?: {
    cpu?: number | { usage: number; cores?: number };
    memory?: number | { usage: number; total?: number; used?: number; free?: number };
    disk?: number | { usage: number; total?: number; used?: number; free?: number };
    hostname?: string;
    platform?: string;
    uptime?: number;
    roomId?: string;
    roomName?: string;
    appVersion?: string;
  };
  streamHealth?: {
    youtube?: {
      status: string;
      viewers?: number;
      healthStatus?: string;
      resolution?: string;
      framerate?: number;
    };
    facebook?: {
      status: string;
      viewers?: number;
      healthStatus?: string;
      resolution?: string;
      framerate?: number;
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
