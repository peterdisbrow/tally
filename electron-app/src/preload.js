const { contextBridge, ipcRenderer, shell } = require('electron');

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
  getMockLabStatus: () => ipcRenderer.invoke('mock-lab-status'),
  startMockLab: (opts = {}) => ipcRenderer.invoke('mock-lab-start', opts),
  stopMockLab: (opts = {}) => ipcRenderer.invoke('mock-lab-stop', opts),
  saveEquipment: (config) => ipcRenderer.invoke('save-equipment', config),
  getEquipment: () => ipcRenderer.invoke('get-equipment'),
  copyToClipboard: (text) => ipcRenderer.invoke('copy-to-clipboard', text),
  openExternal: (url) => shell.openExternal(url),
  onStatus: (cb) => ipcRenderer.on('status', (_, data) => cb(data)),
  onLog: (cb) => ipcRenderer.on('log', (_, data) => cb(data)),
  onPreviewFrame: (cb) => ipcRenderer.on('preview-frame', (_, data) => cb(data)),
  onUpdateReady: (cb) => ipcRenderer.on('update-ready', () => cb()),
  onScanProgress: (cb) => {
    const listener = (_, data) => cb(data);
    ipcRenderer.on('scan-progress', listener);
    return () => ipcRenderer.removeListener('scan-progress', listener);
  },
});
