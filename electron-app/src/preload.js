const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Synchronous platform detection — avoids relying on navigator.platform which
  // returns "" on Apple Silicon in Electron 35+
  getPlatform: () => process.platform,
  getConfig: () => ipcRenderer.invoke('get-config'),
  saveConfig: (config) => ipcRenderer.invoke('save-config', config),
  getStatus: () => ipcRenderer.invoke('get-status'),
  startAgent: () => ipcRenderer.invoke('start-agent'),
  stopAgent: () => ipcRenderer.invoke('stop-agent'),
  isRunning: () => ipcRenderer.invoke('is-running'),
  testConnection: (payload) => ipcRenderer.invoke('test-connection', payload),
  churchAuthLogin: (payload) => ipcRenderer.invoke('church-auth-login', payload),
  exportTestLogs: () => ipcRenderer.invoke('export-test-logs'),
  testEquipmentConnection: (params) => ipcRenderer.invoke('test-equipment-connection', params),
  scanNetwork: (options = {}) => ipcRenderer.invoke('scan-network', options),
  getNetworkInterfaces: () => ipcRenderer.invoke('get-network-interfaces'),
  saveEquipment: (config) => ipcRenderer.invoke('save-equipment', config),
  getEquipment: () => ipcRenderer.invoke('get-equipment'),
  switchRoom: (fromRoom, toRoom, toRoomId) => ipcRenderer.invoke('switch-room', { fromRoom, toRoom, toRoomId }),
  getRooms: () => ipcRenderer.invoke('get-rooms'),
  createRoom: (name, description) => ipcRenderer.invoke('create-room', { name, description }),
  assignRoom: (roomId) => ipcRenderer.invoke('assign-room', { roomId }),
  validateToken: () => ipcRenderer.invoke('validate-token'),
  signOut: () => ipcRenderer.invoke('sign-out'),
  factoryReset: () => ipcRenderer.invoke('factory-reset'),
  copyToClipboard: (text) => ipcRenderer.invoke('copy-to-clipboard', text),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  onStatus: (cb) => ipcRenderer.on('status', (_, data) => cb(data)),
  onAuthInvalid: (cb) => ipcRenderer.on('auth-invalid', () => cb()),
  onSignedOut: (cb) => ipcRenderer.on('signed-out', () => cb()),
  onLog: (cb) => ipcRenderer.on('log', (_, data) => cb(data)),
  onUpdateReady: (cb) => ipcRenderer.on('update-ready', () => cb()),
  onScanProgress: (cb) => {
    const listener = (_, data) => cb(data);
    ipcRenderer.on('scan-progress', listener);
    return () => ipcRenderer.removeListener('scan-progress', listener);
  },
  // Chat
  sendChat: (payload) => ipcRenderer.invoke('send-chat', payload),
  getChat: (opts) => ipcRenderer.invoke('get-chat', opts),
  onChatMessage: (cb) => ipcRenderer.on('chat-message', (_, data) => cb(data)),
  // File upload (for setup assistant: patch lists, camera plots, images)
  pickFile: () => ipcRenderer.invoke('pick-file'),
  uploadChatFile: (payload) => ipcRenderer.invoke('upload-chat-file', payload),
  // Engineer profile
  saveEngineerProfile: (profile) => ipcRenderer.invoke('save-engineer-profile', profile),
  // Stream platform OAuth
  oauthYouTubeConnect: () => ipcRenderer.invoke('oauth-youtube-connect'),
  oauthFacebookConnect: () => ipcRenderer.invoke('oauth-facebook-connect'),
  oauthFacebookSelectPage: (opts) => ipcRenderer.invoke('oauth-facebook-select-page', opts),
  oauthFacebookListPages: () => ipcRenderer.invoke('oauth-facebook-list-pages'),
  oauthYouTubeDisconnect: () => ipcRenderer.invoke('oauth-youtube-disconnect'),
  oauthFacebookDisconnect: () => ipcRenderer.invoke('oauth-facebook-disconnect'),
  oauthStatus: () => ipcRenderer.invoke('oauth-status'),
  oauthStreamKeys: () => ipcRenderer.invoke('oauth-stream-keys'),
  onOauthUpdate: (cb) => ipcRenderer.on('oauth-update', (_, data) => cb(data)),
  // Pre-Service Status (readiness widget)
  getPreServiceStatus: () => ipcRenderer.invoke('preservice-status'),
  // Session Recap
  getSessionLatest: () => ipcRenderer.invoke('get-session-latest'),
  // Auto-Start Config
  getAutoStart: () => ipcRenderer.invoke('get-autostart'),
  setAutoStart: (enabled) => ipcRenderer.invoke('set-autostart', enabled),
  // Pre-Service Check
  getPreServiceCheck: () => ipcRenderer.invoke('get-preservice-check'),
  runPreServiceCheck: () => ipcRenderer.invoke('run-preservice-check'),
  fixAllPreService: () => ipcRenderer.invoke('fix-all-preservice'),
  // Rundown
  getActiveRundown: () => ipcRenderer.invoke('get-active-rundown'),
  executeRundownStep: () => ipcRenderer.invoke('execute-rundown-step'),
  advanceRundownStep: () => ipcRenderer.invoke('advance-rundown-step'),
  jumpToRundownStep: (idx) => ipcRenderer.invoke('jump-to-rundown-step', idx),
  deactivateRundown: () => ipcRenderer.invoke('deactivate-rundown'),
  // Problem Finder
  pfAnalyze: () => ipcRenderer.invoke('pf-analyze'),
  pfGoNoGo: (opts) => ipcRenderer.invoke('pf-go-no-go', opts),
  pfRunHistory: () => ipcRenderer.invoke('pf-run-history'),
  pfFeedback: (fb) => ipcRenderer.invoke('pf-feedback', fb),
  pfGetConfig: () => ipcRenderer.invoke('pf-get-config'),
  pfSimulateFix: (simId) => ipcRenderer.invoke('pf-simulate-fix', simId),
  pfAvailable: () => ipcRenderer.invoke('pf-available'),
  pfSetCamerasVerified: (v) => ipcRenderer.invoke('pf-set-cameras-verified', v),
  pfGetCamerasVerified: () => ipcRenderer.invoke('pf-get-cameras-verified'),
  onPfUpdate: (cb) => ipcRenderer.on('pf-update', (_, data) => cb(data)),
  // Signal Failover
  getFailoverConfig: () => ipcRenderer.invoke('get-failover-config'),
  saveFailoverConfig: (config) => ipcRenderer.invoke('save-failover-config', config),
  getFailoverState: () => ipcRenderer.invoke('get-failover-state'),
  getFailoverSources: () => ipcRenderer.invoke('get-failover-sources'),
  onFailoverStateChange: (cb) => ipcRenderer.on('failover-state', (_, data) => cb(data)),
  // Window visibility (pause polling when hidden to tray)
  onWindowVisibility: (cb) => ipcRenderer.on('window-visibility', (_, visible) => cb(visible)),
  // Onboarding chat
  onboardingChat: (payload) => ipcRenderer.invoke('onboarding-chat', payload),
  onboardingConfirm: (payload) => ipcRenderer.invoke('onboarding-confirm', payload),
  onboardingState: () => ipcRenderer.invoke('onboarding-state'),
  // Send command to relay (used by troubleshooter auto-actions)
  sendCommand: (cmd, params) => ipcRenderer.invoke('send-command', cmd, params),
  // Diagnostic Bundle
  sendDiagnosticBundle: () => ipcRenderer.invoke('send-diagnostic-bundle'),
  // Portable config export / import
  exportPortableConfig: () => ipcRenderer.invoke('export-portable-config'),
  importPortableConfig: () => ipcRenderer.invoke('import-portable-config'),
  // i18n
  getLocaleData: () => ipcRenderer.invoke('get-locale-data'),
  setLocale: (locale) => ipcRenderer.invoke('set-locale', locale),
  // Update events
  onUpdateNotAvailable: (cb) => ipcRenderer.on('update-not-available', () => cb()),
  onUpdateError: (cb) => ipcRenderer.on('update-error', (_, msg) => cb(msg)),
  onUpdateProgress: (cb) => ipcRenderer.on('update-progress', (_, data) => cb(data)),
  onWhatsNew: (cb) => ipcRenderer.on('whats-new', (_, data) => cb(data)),
  // Connection quality
  onConnectionQuality: (cb) => ipcRenderer.on('connection-quality', (_, data) => cb(data)),
  // Deep link config update
  onConfigUpdated: (cb) => ipcRenderer.on('config-updated', () => cb()),
});
