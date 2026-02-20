const { contextBridge, ipcRenderer, shell } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  getConfig: () => ipcRenderer.invoke('get-config'),
  saveConfig: (config) => ipcRenderer.invoke('save-config', config),
  getStatus: () => ipcRenderer.invoke('get-status'),
  startAgent: () => ipcRenderer.invoke('start-agent'),
  stopAgent: () => ipcRenderer.invoke('stop-agent'),
  isRunning: () => ipcRenderer.invoke('is-running'),
  testConnection: (url) => ipcRenderer.invoke('test-connection', url),
  testEquipmentConnection: (params) => ipcRenderer.invoke('test-equipment-connection', params),
  scanNetwork: (options = {}) => ipcRenderer.invoke('scan-network', options),
  getNetworkInterfaces: () => ipcRenderer.invoke('get-network-interfaces'),
  saveEquipment: (config) => ipcRenderer.invoke('save-equipment', config),
  getEquipment: () => ipcRenderer.invoke('get-equipment'),
  copyToClipboard: (text) => ipcRenderer.invoke('copy-to-clipboard', text),
  openExternal: (url) => shell.openExternal(url),
  onStatus: (cb) => ipcRenderer.on('status', (_, data) => cb(data)),
  onLog: (cb) => ipcRenderer.on('log', (_, data) => cb(data)),
  onPreviewFrame: (cb) => ipcRenderer.on('preview-frame', (_, data) => cb(data)),
  onUpdateReady: (cb) => ipcRenderer.on('update-ready', () => cb()),
  onScanProgress: (cb) => ipcRenderer.on('scan-progress', (_, data) => cb(data)),
});
