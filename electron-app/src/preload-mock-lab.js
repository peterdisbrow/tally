const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  getMockLabStatus: () => ipcRenderer.invoke('mock-lab-status'),
  getNetworkInterfaces: () => ipcRenderer.invoke('mock-lab-get-network-interfaces'),
  getMockLabConfig: () => ipcRenderer.invoke('mock-lab-get-config'),
  saveMockLabConfig: (config) => ipcRenderer.invoke('mock-lab-save-config', config),
  startMockLab: (opts = {}) => ipcRenderer.invoke('mock-lab-start', opts),
  stopMockLab: () => ipcRenderer.invoke('mock-lab-stop'),
  openExternal: (url) => ipcRenderer.invoke('mock-lab-open-external', url),
  onMockLabLog: (cb) => {
    const listener = (_, line) => cb(line);
    ipcRenderer.on('mock-lab-log', listener);
    return () => ipcRenderer.removeListener('mock-lab-log', listener);
  },
});
