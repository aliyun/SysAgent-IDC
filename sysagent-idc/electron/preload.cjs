const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, callback) {
  const listener = (_event, value) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('sysomDesktop', {
  isElectron: true,
  isFloating: process.argv.includes('--sysom-floating'),
  gpu: process.argv.includes('--sysom-gpu=1'),
  healthSnapshot: (refresh) => ipcRenderer.invoke('health:snapshot', refresh),
  agentDiagnostic: (refresh) => ipcRenderer.invoke('agent:diagnostic', refresh),
  healthReset: (parameters) => ipcRenderer.invoke('health:reset', parameters),
  healthOperation: (payload) => ipcRenderer.invoke('health:operation', payload),
  prepareProcessCleanup: (payload) => ipcRenderer.invoke('process:prepare-cleanup', payload),
  executeProcessCleanup: (payload) => ipcRenderer.invoke('process:execute-cleanup', payload),
  collectorStatus: () => ipcRenderer.invoke('collector:status'),
  setCollectorEnabled: (enabled) => ipcRenderer.invoke('collector:enabled', enabled),
  setInspectionInterval: (minutes) => ipcRenderer.invoke('collector:interval', minutes),
  minimize: () => ipcRenderer.invoke('window:minimize'),
  hideToLauncher: () => ipcRenderer.invoke('window:hide-to-launcher'),
  openHome: () => ipcRenderer.invoke('window:open-home'),
  close: () => ipcRenderer.invoke('window:close'),
  getLauncherState: () => ipcRenderer.invoke('launcher:state'),
  updateLauncherState: (state) => ipcRenderer.send('launcher:update', state),
  onLauncherState: (callback) => subscribe('launcher:updated', callback),
  onOpenHome: (callback) => subscribe('desktop:open-home', callback),
  onCollapsed: (callback) => subscribe('desktop:collapsed', callback),
  onDismissAlert: (callback) => subscribe('desktop:dismiss-alert', callback),
  dismissAlert: () => ipcRenderer.send('launcher:dismiss'),
  beginDrag: (x, y) => ipcRenderer.send('launcher:drag-start', x, y),
  moveDrag: (x, y) => ipcRenderer.send('launcher:drag-move', x, y),
  endDrag: () => ipcRenderer.send('launcher:drag-end'),
  showLauncherMenu: () => ipcRenderer.send('launcher:menu'),
});
