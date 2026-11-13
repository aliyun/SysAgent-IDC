const { app, BrowserWindow, ipcMain, Menu, protocol, screen, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { detectGpu, hasRenderNode } = require('./gpu-detect.cjs');
const { createIdcController, CollectorError } = require('./idc-controller.cjs');
const { agentSightHome } = require('./agentsight-deployment.cjs');
const { startMockOpenApi, summarizeHealth, buildHealthReport } = require('./generated/openapi.cjs');

const isDev = !app.isPackaged && process.env.SYSOM_LOAD_DIST !== '1';
const DIST_ROOT = path.join(__dirname, '..', 'dist');
const APP_ORIGIN = 'sysom://app';
const gpuArgument = `--sysom-gpu=${detectGpu() ? 1 : 0}`;

// Virtual desktops without a DRM render node need software rendering.
if (process.platform === 'linux' && !hasRenderNode()) app.disableHardwareAcceleration();

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'sysom',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
  },
]);

const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

function registerAppProtocol() {
  protocol.handle('sysom', async (request) => {
    const { pathname } = new URL(request.url);
    const relative = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
    const filePath = path.normalize(path.join(DIST_ROOT, relative));
    if (filePath !== DIST_ROOT && !filePath.startsWith(`${DIST_ROOT}${path.sep}`)) {
      return new Response('Forbidden', { status: 403 });
    }
    try {
      const data = await fs.promises.readFile(filePath);
      return new Response(data, {
        headers: { 'content-type': contentTypes[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream' },
      });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
}

let mainWindow = null;
let launcherWindow = null;
let launcherReady = false;
let collapsed = false;
let quitting = false;
let drag = null;
let launcherState = { revision: 0, pulseRevision: null, items: [] };
let idcController = null;
let collectorClosing = false;

function localDeviceId() {
  const file = path.join(app.getPath('userData'), 'idc-device.json');
  if (fs.existsSync(file)) {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (typeof value.device_id !== 'string' || !/^[0-9a-f-]{36}$/i.test(value.device_id)) throw new Error('Invalid local device ID');
    return value.device_id;
  }
  const deviceId = crypto.randomUUID();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ device_id: deviceId }), { mode: 0o600 });
  return deviceId;
}

const iconPath = path.join(__dirname, '..', isDev ? 'public' : 'dist', 'icon.png');
const pageUrl = isDev ? 'http://127.0.0.1:5173' : `${APP_ORIGIN}/index.html`;

function clampBounds(bounds) {
  const workArea = screen.getDisplayNearestPoint({
    x: bounds.x + bounds.width - 72,
    y: bounds.y + bounds.height - 76,
  }).workArea;
  return {
    ...bounds,
    x: Math.round(Math.max(workArea.x, Math.min(workArea.x + workArea.width - bounds.width, bounds.x))),
    y: Math.round(Math.max(workArea.y, Math.min(workArea.y + workArea.height - bounds.height, bounds.y))),
  };
}

function resizeLauncher() {
  if (!launcherWindow) return;
  const bounds = launcherWindow.getBounds();
  const width = launcherState.items.length ? 360 : 144;
  const height = launcherState.items.length ? 258 + launcherState.items.length * 28 : 152;
  launcherWindow.setBounds(clampBounds({
    x: bounds.x + bounds.width - width,
    y: bounds.y + bounds.height - height,
    width,
    height,
  }));
}

function collapseWindow() {
  if (!mainWindow || !launcherWindow) return;
  if (mainWindow.isMinimized()) {
    // Clear the WM minimized state before hiding so restore cannot replay a stale minimize.
    mainWindow.once('restore', collapseWindow);
    mainWindow.restore();
    return;
  }
  collapsed = true;
  mainWindow.webContents.send('desktop:collapsed');
  mainWindow.hide();
  resizeLauncher();
  if (launcherReady) launcherWindow.showInactive();
}

function openHome() {
  if (!mainWindow) return;
  collapsed = false;
  drag = null;
  launcherWindow?.hide();
  const showHome = () => {
    mainWindow.show();
    mainWindow.focus();
    mainWindow.webContents.send('desktop:open-home');
  };
  if (mainWindow.isMinimized()) {
    mainWindow.once('restore', showHome);
    mainWindow.restore();
  } else {
    showHome();
  }
}

function trustedSender(event) {
  if (event.sender !== mainWindow?.webContents && event.sender !== launcherWindow?.webContents) return false;
  if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame) return false;
  try {
    const url = new URL(event.senderFrame.url);
    return isDev ? url.origin === new URL(pageUrl).origin : url.protocol === 'sysom:' && url.hostname === 'app';
  } catch { return false; }
}

async function healthReply(event, action) {
  if (!trustedSender(event) || event.sender !== mainWindow?.webContents) {
    return { ok: false, error: { code: 'UNTRUSTED_SENDER', message: '不允许的采集请求来源', status: 403, retryable: false } };
  }
  try {
    if (!idcController) throw new CollectorError('COLLECTOR_STARTING', '本地采集组件正在启动', 503, true);
    return { ok: true, data: await action(idcController) };
  } catch (error) {
    return { ok: false, error: { code: error.code || 'COLLECTOR_FAILED', message: error instanceof CollectorError ? error.message : '本地采集服务暂不可用',
      status: error.status || 503, retryable: error.retryable === true } };
  }
}

ipcMain.handle('health:snapshot', (event, refresh) => healthReply(event, (controller) => controller.snapshot(refresh)));
ipcMain.handle('agent:diagnostic', (event, refresh) => healthReply(event, (controller) => controller.agentSnapshot(refresh)));
ipcMain.handle('health:reset', (event, parameters) => healthReply(event, (controller) => controller.reset(parameters)));
ipcMain.handle('health:operation', (event, payload) => healthReply(event, (controller) => controller.operation(payload)));
ipcMain.handle('process:prepare-cleanup', (event, payload) => healthReply(event, (controller) => controller.prepareProcessCleanup(payload)));
ipcMain.handle('process:execute-cleanup', (event, payload) => healthReply(event, (controller) => controller.executeProcessCleanup(payload)));
ipcMain.handle('collector:status', (event) => healthReply(event, (controller) => controller.status()));
ipcMain.handle('collector:enabled', (event, enabled) => healthReply(event, (controller) => controller.setEnabled(enabled)));
ipcMain.handle('collector:interval', (event, minutes) => healthReply(event, (controller) => controller.setInspectionInterval(minutes)));

function validPoint(x, y) {
  return Number.isFinite(x) && Number.isFinite(y) && Math.abs(x) <= 1000000 && Math.abs(y) <= 1000000;
}

function createWindows() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 420,
    minHeight: 620,
    show: false,
    frame: false,
    backgroundColor: '#edf1f7',
    autoHideMenuBar: true,
    title: 'SysAgent管家',
    icon: iconPath,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      additionalArguments: [gpuArgument],
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  mainWindow.once('ready-to-show', () => { if (!collapsed) mainWindow?.show(); });
  mainWindow.on('minimize', collapseWindow);
  mainWindow.on('close', (event) => {
    if (!quitting) {
      event.preventDefault();
      collapseWindow();
    }
  });
  mainWindow.on('closed', () => { mainWindow = null; });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  const workArea = screen.getPrimaryDisplay().workArea;
  launcherWindow = new BrowserWindow({
    x: workArea.x + workArea.width - 158,
    y: workArea.y + workArea.height - 166,
    width: 144,
    height: 152,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    autoHideMenuBar: true,
    title: 'SysAgent 小管家',
    icon: iconPath,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      additionalArguments: ['--sysom-floating', gpuArgument],
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  launcherWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  launcherWindow.on('page-title-updated', (event) => event.preventDefault());
  launcherWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  launcherWindow.once('ready-to-show', () => {
    launcherReady = true;
    if (collapsed) launcherWindow.showInactive();
  });
  launcherWindow.on('closed', () => { launcherWindow = null; });
  screen.on('display-metrics-changed', () => {
    if (launcherWindow) launcherWindow.setBounds(clampBounds(launcherWindow.getBounds()));
  });
  screen.on('display-removed', () => {
    if (launcherWindow) launcherWindow.setBounds(clampBounds(launcherWindow.getBounds()));
  });
  mainWindow.loadURL(pageUrl);
  launcherWindow.loadURL(pageUrl);
}

ipcMain.handle('window:minimize', (event) => { if (trustedSender(event)) collapseWindow(); });
ipcMain.handle('window:hide-to-launcher', (event) => { if (trustedSender(event)) collapseWindow(); });
ipcMain.handle('window:open-home', (event) => { if (trustedSender(event)) openHome(); });
ipcMain.handle('window:close', (event) => { if (trustedSender(event)) app.quit(); });
ipcMain.handle('launcher:state', (event) => {
  if (trustedSender(event)) return launcherState;
});
ipcMain.on('launcher:update', (event, state) => {
  if (event.sender !== mainWindow?.webContents || !state || !Number.isInteger(state.revision) ||
      (state.pulseRevision !== null && !Number.isInteger(state.pulseRevision)) ||
      !Array.isArray(state.items) || state.items.length > 6 ||
      !state.items.every((item) => item && typeof item.label === 'string' && item.label.length <= 80 &&
        Number.isFinite(item.usage) && item.usage >= 0 && item.usage <= 100)) return;
  launcherState = state;
  resizeLauncher();
  launcherWindow?.webContents.send('launcher:updated', launcherState);
});
ipcMain.on('launcher:dismiss', (event) => {
  if (event.sender === launcherWindow?.webContents) mainWindow?.webContents.send('desktop:dismiss-alert');
});
ipcMain.on('launcher:drag-start', (event, x, y) => {
  if (event.sender === launcherWindow?.webContents && validPoint(x, y)) {
    drag = { x, y, bounds: launcherWindow.getBounds() };
  }
});
ipcMain.on('launcher:drag-move', (event, x, y) => {
  if (event.sender === launcherWindow?.webContents && drag && validPoint(x, y)) {
    launcherWindow.setBounds(clampBounds({
      ...drag.bounds,
      x: drag.bounds.x + x - drag.x,
      y: drag.bounds.y + y - drag.y,
    }));
  }
});
ipcMain.on('launcher:drag-end', (event) => {
  if (event.sender === launcherWindow?.webContents) drag = null;
});
ipcMain.on('launcher:menu', (event) => {
  if (event.sender !== launcherWindow?.webContents) return;
  Menu.buildFromTemplate([
    { label: '打开 SysAgent管家', click: openHome },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ]).popup({ window: launcherWindow });
});

app.on('before-quit', (event) => {
  quitting = true;
  if (idcController && !collectorClosing) {
    event.preventDefault();
    collectorClosing = true;
    idcController.close().finally(() => app.quit());
  }
});
app.whenReady().then(async () => {
  registerAppProtocol();
  idcController = await createIdcController({
    bundleRoot: app.isPackaged ? path.join(process.resourcesPath, 'sysak') : path.join(__dirname, '..', 'resources', 'sysak'),
    deviceId: localDeviceId(), startMockOpenApi, hasGpu: gpuArgument.endsWith('1'), agentSightService: true,
    agentSight: { deploymentRoot: agentSightHome(), packageDirectories: [
      path.join(path.dirname(process.env.APPIMAGE || process.execPath), 'agentsight-runtime'),
      path.join(process.resourcesPath, 'agentsight-runtime'),
    ] },
    settingsPath: path.join(app.getPath('userData'), 'idc-settings.json'),
    queryApi: { discoveryDirectory: path.join(app.getPath('userData'), 'local-api'), hostKind: 'electron',
      summarizeHealth, buildHealthReport },
  });
  createWindows();
  app.on('activate', openHome);
});
app.on('window-all-closed', () => app.quit());
