import { useSettingsStore } from '../stores/settingsStore';
import type { AppLanguage } from '../stores/settingsStore';

// ─── Translation dictionaries ───────────────────────────────────────────────

const en = {
  // Navigation & tabs
  'tab.alerts': 'Alerts',
  'tab.commands': 'Commands',
  'tab.equipment': 'Equipment',
  'tab.checks': 'Checks',
  'tab.engineer': 'Engineer',
  'tab.more': 'More',

  // Status labels
  'status.connected': 'Connected',
  'status.disconnected': 'Disconnected',
  'status.offAir': 'Off Air',
  'status.live': 'LIVE',
  'status.recording': 'Recording',
  'status.stopped': 'Stopped',
  'status.streaming': 'Streaming',
  'status.muted': 'MUTED',
  'status.silence': 'Silence Detected',

  // Severity
  'severity.emergency': 'EMERGENCY',
  'severity.critical': 'CRITICAL',
  'severity.warning': 'WARNING',
  'severity.info': 'INFO',

  // Equipment categories
  'category.switching': 'Switching',
  'category.streaming': 'Streaming',
  'category.recording': 'Recording',
  'category.presentation': 'Presentation',
  'category.audio': 'Audio',
  'category.network': 'Network & Control',
  'category.system': 'System',

  // Common labels
  'label.devices': 'DEVICES',
  'label.stream': 'STREAM',
  'label.uptime': 'UPTIME',
  'label.viewers': 'VIEWERS',
  'label.bitrate': 'BITRATE',
  'label.fps': 'FPS',
  'label.health': 'Health',
  'label.model': 'Model',
  'label.firmware': 'Firmware',
  'label.version': 'Version',
  'label.program': 'Program',
  'label.preview': 'Preview',
  'label.scene': 'Scene',
  'label.cpu': 'CPU',
  'label.ram': 'RAM',
  'label.disk': 'Disk',
  'label.channels': 'Channels',
  'label.cameras': 'Cameras',
  'label.platform': 'Platform',
  'label.resolution': 'Resolution',
  'label.framerate': 'Framerate',
  'label.type': 'Type',
  'label.room': 'Room',
  'label.power': 'Power',
  'label.slide': 'Slide',
  'label.presentation': 'Presentation',
  'label.timer': 'Timer',
  'label.grade': 'Grade',
  'label.duration': 'Duration',
  'label.incidents': 'Incidents',

  // Friendly metric descriptions (for simple mode)
  'friendly.bitrate': 'Bitrate',
  'friendly.fps': 'Frame Rate',
  'friendly.cpu': 'Processor Load',
  'friendly.ram': 'Memory Usage',
  'friendly.disk': 'Storage',
  'friendly.dropped': 'Skipped Frames',
  'friendly.congestion': 'Network Congestion',
  'friendly.strain': 'Processor Strain',
  'friendly.cacheUsed': 'Buffer Usage',

  // Health labels
  'health.excellent': 'Excellent',
  'health.fair': 'Fair',
  'health.poor': 'Poor',

  // Actions
  'action.startStream': 'Start Stream',
  'action.stopStream': 'Stop Stream',
  'action.startRec': 'Start Rec',
  'action.stopRec': 'Stop Rec',
  'action.cut': 'CUT',
  'action.auto': 'AUTO',
  'action.previous': 'Previous',
  'action.next': 'Next',
  'action.tryAgain': 'Try Again',
  'action.retry': 'Retry',
  'action.signIn': 'Sign In',
  'action.signOut': 'Sign Out',
  'action.switchRoom': 'Switch Room',

  // Banners & messages
  'banner.noInternet': 'No internet connection',
  'banner.reconnecting': 'Reconnecting...',
  'banner.connected': 'Connected',
  'banner.updateAvailable': 'Update available -- tap to restart',
  'error.somethingWrong': 'Something went wrong',
  'error.appCrash': 'The app ran into an unexpected error. Our team has been notified.',
  'empty.noDevices': 'No devices configured',
  'empty.connecting': 'Connecting to room...',
  'empty.allNormal': 'All Systems Normal',
  'label.systemResources': 'System Resources',
  'label.cameraTally': 'Camera Tally',
  'label.quickActions': 'Quick Actions',

  // Settings
  'settings.appearance': 'APPEARANCE',
  'settings.theme': 'Theme',
  'settings.notifications': 'NOTIFICATIONS',
  'settings.pushNotifications': 'Push Notifications',
  'settings.alertSounds': 'Alert Sounds',
  'settings.alertSoundsDesc': 'Play sound for critical alerts',
  'settings.connection': 'CONNECTION',
  'settings.server': 'Server',
  'settings.about': 'ABOUT',
  'settings.viewMode': 'VIEW MODE',
  'settings.simple': 'Simple',
  'settings.advanced': 'Advanced',
  'settings.simpleDesc': 'Essential status info only',
  'settings.advancedDesc': 'Full technical details',
  'settings.language': 'LANGUAGE',
  'settings.english': 'English',
  'settings.spanish': 'Spanish',

  // Time
  'time.justNow': 'just now',
  'time.mAgo': '{{m}}m ago',
  'time.hAgo': '{{h}}h ago',
  'time.dAgo': '{{d}}d ago',
  'time.sAgo': '{{s}}s ago',
  'time.mayBeStale': 'may be stale',
} as const;

const es: Record<keyof typeof en, string> = {
  // Navigation & tabs
  'tab.alerts': 'Alertas',
  'tab.commands': 'Comandos',
  'tab.equipment': 'Equipos',
  'tab.checks': 'Chequeos',
  'tab.engineer': 'Ingeniero',
  'tab.more': 'M\u00e1s',

  // Status labels
  'status.connected': 'Conectado',
  'status.disconnected': 'Desconectado',
  'status.offAir': 'Fuera de aire',
  'status.live': 'EN VIVO',
  'status.recording': 'Grabando',
  'status.stopped': 'Detenido',
  'status.streaming': 'Transmitiendo',
  'status.muted': 'SILENCIADO',
  'status.silence': 'Silencio detectado',

  // Severity
  'severity.emergency': 'EMERGENCIA',
  'severity.critical': 'CR\u00cdTICO',
  'severity.warning': 'ADVERTENCIA',
  'severity.info': 'INFO',

  // Equipment categories
  'category.switching': 'Switcher',
  'category.streaming': 'Transmisi\u00f3n',
  'category.recording': 'Grabaci\u00f3n',
  'category.presentation': 'Presentaci\u00f3n',
  'category.audio': 'Audio',
  'category.network': 'Red y Control',
  'category.system': 'Sistema',

  // Common labels
  'label.devices': 'DISPOSITIVOS',
  'label.stream': 'TRANSMISI\u00d3N',
  'label.uptime': 'TIEMPO ACTIVO',
  'label.viewers': 'ESPECTADORES',
  'label.bitrate': 'BITRATE',
  'label.fps': 'FPS',
  'label.health': 'Estado',
  'label.model': 'Modelo',
  'label.firmware': 'Firmware',
  'label.version': 'Versi\u00f3n',
  'label.program': 'Programa',
  'label.preview': 'Previsualizaci\u00f3n',
  'label.scene': 'Escena',
  'label.cpu': 'CPU',
  'label.ram': 'RAM',
  'label.disk': 'Disco',
  'label.channels': 'Canales',
  'label.cameras': 'C\u00e1maras',
  'label.platform': 'Plataforma',
  'label.resolution': 'Resoluci\u00f3n',
  'label.framerate': 'Cuadros/seg',
  'label.type': 'Tipo',
  'label.room': 'Sala',
  'label.power': 'Encendido',
  'label.slide': 'Diapositiva',
  'label.presentation': 'Presentaci\u00f3n',
  'label.timer': 'Temporizador',
  'label.grade': 'Calificaci\u00f3n',
  'label.duration': 'Duraci\u00f3n',
  'label.incidents': 'Incidentes',

  // Friendly metric descriptions
  'friendly.bitrate': 'Bitrate',
  'friendly.fps': 'Cuadros por segundo',
  'friendly.cpu': 'Carga del procesador',
  'friendly.ram': 'Uso de memoria',
  'friendly.disk': 'Almacenamiento',
  'friendly.dropped': 'Cuadros perdidos',
  'friendly.congestion': 'Congesti\u00f3n de red',
  'friendly.strain': 'Carga del procesador',
  'friendly.cacheUsed': 'Uso del b\u00fafer',

  // Health labels
  'health.excellent': 'Excelente',
  'health.fair': 'Aceptable',
  'health.poor': 'Malo',

  // Actions
  'action.startStream': 'Iniciar transmisi\u00f3n',
  'action.stopStream': 'Detener transmisi\u00f3n',
  'action.startRec': 'Iniciar grabaci\u00f3n',
  'action.stopRec': 'Detener grabaci\u00f3n',
  'action.cut': 'CORTE',
  'action.auto': 'AUTO',
  'action.previous': 'Anterior',
  'action.next': 'Siguiente',
  'action.tryAgain': 'Reintentar',
  'action.retry': 'Reintentar',
  'action.signIn': 'Iniciar sesi\u00f3n',
  'action.signOut': 'Cerrar sesi\u00f3n',
  'action.switchRoom': 'Cambiar sala',

  // Banners & messages
  'banner.noInternet': 'Sin conexi\u00f3n a internet',
  'banner.reconnecting': 'Reconectando...',
  'banner.connected': 'Conectado',
  'banner.updateAvailable': 'Actualizaci\u00f3n disponible -- toca para reiniciar',
  'error.somethingWrong': 'Algo sali\u00f3 mal',
  'error.appCrash': 'La app tuvo un error inesperado. Nuestro equipo fue notificado.',
  'empty.noDevices': 'No hay equipos configurados',
  'empty.connecting': 'Conectando a la sala...',
  'empty.allNormal': 'Todos los sistemas normales',
  'label.systemResources': 'Recursos del sistema',
  'label.cameraTally': 'Tally de c\u00e1maras',
  'label.quickActions': 'Acciones r\u00e1pidas',

  // Settings
  'settings.appearance': 'APARIENCIA',
  'settings.theme': 'Tema',
  'settings.notifications': 'NOTIFICACIONES',
  'settings.pushNotifications': 'Notificaciones push',
  'settings.alertSounds': 'Sonidos de alerta',
  'settings.alertSoundsDesc': 'Reproducir sonido en alertas cr\u00edticas',
  'settings.connection': 'CONEXI\u00d3N',
  'settings.server': 'Servidor',
  'settings.about': 'ACERCA DE',
  'settings.viewMode': 'MODO DE VISTA',
  'settings.simple': 'Simple',
  'settings.advanced': 'Avanzado',
  'settings.simpleDesc': 'Solo informaci\u00f3n esencial',
  'settings.advancedDesc': 'Detalles t\u00e9cnicos completos',
  'settings.language': 'IDIOMA',
  'settings.english': 'English',
  'settings.spanish': 'Espa\u00f1ol',

  // Time
  'time.justNow': 'ahora',
  'time.mAgo': 'hace {{m}}m',
  'time.hAgo': 'hace {{h}}h',
  'time.dAgo': 'hace {{d}}d',
  'time.sAgo': 'hace {{s}}s',
  'time.mayBeStale': 'puede estar desactualizado',
};

// ─── Translation dictionaries map ──────────────────────────────────────────

const dictionaries: Record<AppLanguage, Record<string, string>> = { en, es };

export type TranslationKey = keyof typeof en;

// ─── Hook ──────────────────────────────────────────────────────────────────

export function useTranslation() {
  const language = useSettingsStore((s) => s.language);
  const dict = dictionaries[language] || en;

  function t(key: TranslationKey, params?: Record<string, string | number>): string {
    let value = dict[key] ?? en[key] ?? key;
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        value = value.replace(`{{${k}}}`, String(v));
      }
    }
    return value;
  }

  return { t, language };
}

// ─── Non-hook variant for class components ─────────────────────────────────

export function translate(key: TranslationKey, params?: Record<string, string | number>): string {
  const language = useSettingsStore.getState().language;
  const dict = dictionaries[language] || en;
  let value = dict[key] ?? en[key] ?? key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      value = value.replace(`{{${k}}}`, String(v));
    }
  }
  return value;
}
