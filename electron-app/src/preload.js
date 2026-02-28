const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
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
  requestPreview: (action) => ipcRenderer.invoke('request-preview', action),
  scanNetwork: (options = {}) => ipcRenderer.invoke('scan-network', options),
  getNetworkInterfaces: () => ipcRenderer.invoke('get-network-interfaces'),
  saveEquipment: (config) => ipcRenderer.invoke('save-equipment', config),
  getEquipment: () => ipcRenderer.invoke('get-equipment'),
  validateToken: () => ipcRenderer.invoke('validate-token'),
  signOut: () => ipcRenderer.invoke('sign-out'),
  copyToClipboard: (text) => ipcRenderer.invoke('copy-to-clipboard', text),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  onStatus: (cb) => ipcRenderer.on('status', (_, data) => cb(data)),
  onAuthInvalid: (cb) => ipcRenderer.on('auth-invalid', () => cb()),
  onLog: (cb) => ipcRenderer.on('log', (_, data) => cb(data)),
  onPreviewFrame: (cb) => ipcRenderer.on('preview-frame', (_, data) => cb(data)),
  onUpdateReady: (cb) => ipcRenderer.on('update-ready', () => cb()),
  onScanProgress: (cb) => {
    const listener = (_, data) => cb(data);
    ipcRenderer.on('scan-progress', listener);
    return () => ipcRenderer.removeListener('scan-progress', listener);
  },
  // NDI monitoring
  probeNdi: (source) => ipcRenderer.invoke('probe-ndi', source),
  captureNdiFrame: (source) => ipcRenderer.invoke('capture-ndi-frame', source),
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
  oauthYouTubeDisconnect: () => ipcRenderer.invoke('oauth-youtube-disconnect'),
  oauthFacebookDisconnect: () => ipcRenderer.invoke('oauth-facebook-disconnect'),
  oauthStatus: () => ipcRenderer.invoke('oauth-status'),
  oauthStreamKeys: () => ipcRenderer.invoke('oauth-stream-keys'),
  onOauthUpdate: (cb) => ipcRenderer.on('oauth-update', (_, data) => cb(data)),
  // Problem Finder
  pfAnalyze: () => ipcRenderer.invoke('pf-analyze'),
  pfGoNoGo: (opts) => ipcRenderer.invoke('pf-go-no-go', opts),
  pfRunHistory: () => ipcRenderer.invoke('pf-run-history'),
  pfFeedback: (fb) => ipcRenderer.invoke('pf-feedback', fb),
  pfGetConfig: () => ipcRenderer.invoke('pf-get-config'),
  pfSimulateFix: (simId) => ipcRenderer.invoke('pf-simulate-fix', simId),
  pfAvailable: () => ipcRenderer.invoke('pf-available'),
  onPfUpdate: (cb) => ipcRenderer.on('pf-update', (_, data) => cb(data)),
});
