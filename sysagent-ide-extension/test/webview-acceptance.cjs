const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const childProcess = require('node:child_process');
const { spawn } = childProcess;
const crypto = require('node:crypto');
const net = require('node:net');

const fixtureRoot = path.resolve(__dirname, '..');
const root = process.env.SYSOM_EXTENSION_PATH ? path.resolve(process.env.SYSOM_EXTENSION_PATH) : fixtureRoot;
const rootUnavailableOnly = process.env.SYSOM_ROOT_UNAVAILABLE_ONLY === '1';
const analysis = path.resolve(fixtureRoot, '../sysagent-analysis/tests');
const puppeteer = require(require.resolve('puppeteer-core', { paths: [analysis] }));
const { clickText, navigate: navigateTo } = require(path.join(analysis, 'acceptance.cjs'));
const version = require(path.join(fixtureRoot, '../package.json')).version;
const packageManifest = require(path.join(root, 'package.json'));
assert.equal(packageManifest.version, version);
assert.deepEqual(packageManifest.contributes.commands.map((command) => command.command).sort(), ['sysagent.inspect', 'sysagent.openHome']);
const name = `ide-webview-v${version.replace(/\./g, '')}${rootUnavailableOnly ? '-root-unavailable' : ''}`;
const webviewRoot = path.join(root, 'dist', 'webview');

// Approximation of the default styles VS Code injects ahead of the extension's HTML.
const vscodeDefaultStyles = '<style id="_defaultStyles">body{background-color:transparent;color:#cccccc;font-family:monospace;font-weight:normal;font-size:13px;margin:0;padding:0 20px}img,video{max-width:100%;max-height:100%}a,a code{color:#3794ff}</style>';

const log = { warnings: [], infos: [], errors: [], statusMessages: [], clipboard: [], saveDialogs: [], hostMessages: [], requests: [], reveals: 0 };
const commands = {};
const plans = new Map();
let statusItem;
let page;
let origin;
let currentHtml = '';
let navigation = 0;
let owned;
let ownedIdentity;
let ownedClosed;
let ownedError;
const harness = { panel: undefined, loading: Promise.resolve(), saveTarget: undefined };

function event() {
  const listeners = new Set();
  const subscribe = (listener) => { listeners.add(listener); return { dispose: () => listeners.delete(listener) }; };
  subscribe.fire = (value) => listeners.forEach((listener) => listener(value));
  return subscribe;
}
class Uri {
  constructor(fsPath) { this.fsPath = fsPath; this.path = fsPath; this.scheme = 'file'; }
  toString() { return `file://${this.fsPath}`; }
  static file(value) { return new Uri(path.resolve(value)); }
  static joinPath(base, ...parts) { return new Uri(path.join(base.fsPath, ...parts)); }
}
function inside(base, file) {
  const relative = path.relative(base, file);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
function navigate(url) {
  const id = ++navigation;
  harness.loading = page.goto(url, { waitUntil: 'load' }).catch((error) => { if (id === navigation) throw error; });
}
function createWebviewPanel(viewType, title, column, options) {
  const received = event();
  const disposed = event();
  let html = '';
  const panel = {
    viewType, title, column, options, visible: true, disposed: false, iconPath: undefined,
    webview: {
      cspSource: origin,
      asWebviewUri(uri) {
        assert(options.localResourceRoots.some((base) => inside(fs.realpathSync(base.fsPath), fs.realpathSync(uri.fsPath))), `asset outside localResourceRoots: ${uri.fsPath}`);
        const relative = path.relative(webviewRoot, uri.fsPath).split(path.sep).join('/');
        return { toString: () => `${origin}/webview/${relative}` };
      },
      get html() { return html; },
      set html(value) { html = value; currentHtml = value; navigate(`${origin}/panel?n=${navigation + 1}`); },
      async postMessage(message) {
        log.hostMessages.push(message);
        if (message.type === 'rpc-result' && message.value?.ok && message.value.data?.token) plans.set(message.value.data.token, message.value.data);
        if (harness.panel !== panel || panel.disposed) return false;
        return page.evaluate((data) => { window.dispatchEvent(new MessageEvent('message', { data })); return true; }, message).catch(() => false);
      },
      onDidReceiveMessage: received,
    },
    reveal() { panel.visible = true; log.reveals++; },
    dispose() {
      if (panel.disposed) return;
      panel.disposed = true;
      panel.visible = false;
      if (harness.panel === panel) navigate('about:blank');
      disposed.fire();
    },
    onDidDispose: disposed,
    receive: received.fire,
  };
  harness.panel = panel;
  return panel;
}
const vscode = {
  Uri, StatusBarAlignment: { Left: 1, Right: 2 }, ViewColumn: { Active: -1 },
  ThemeColor: class { constructor(id) { this.id = id; } },
  MarkdownString: class {
    constructor(value = '', supportThemeIcons = false) { this.value = value; this.supportThemeIcons = supportThemeIcons; }
    appendMarkdown(value) { this.value += value; return this; }
  },
  window: {
    createStatusBarItem(id, alignment, priority) {
      statusItem = { id, alignment, priority, text: '', tooltip: undefined, backgroundColor: undefined, visible: false, disposed: false,
        show() { this.visible = true; }, dispose() { this.disposed = true; this.visible = false; } };
      return statusItem;
    },
    createWebviewPanel,
    showWarningMessage(message, ...items) { return new Promise((resolve) => log.warnings.push({ message, items, resolve })); },
    async showInformationMessage(message) { log.infos.push(message); },
    async showErrorMessage(message) { log.errors.push(message); },
    setStatusBarMessage(message, timeout) { log.statusMessages.push({ message, timeout }); return { dispose() {} }; },
    async showSaveDialog(options) { log.saveDialogs.push(options); const target = harness.saveTarget; harness.saveTarget = undefined; return target; },
  },
  workspace: { workspaceFolders: undefined, fs: { async writeFile(uri, bytes) { fs.writeFileSync(uri.fsPath, bytes); } } },
  env: { clipboard: { async writeText(text) { log.clipboard.push(text); } } },
  commands: { registerCommand(id, callback) { commands[id] = callback; return { dispose: () => delete commands[id] }; } },
};
async function waitFor(check, label, timeout = 70000) {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
function ownAlive() {
  if (!ownedIdentity || owned.exitCode !== null || owned.signalCode !== null || ownedError) return false;
  try {
    const stat = fs.readFileSync(`/proc/${owned.pid}/stat`, 'utf8');
    return Number(stat.slice(stat.lastIndexOf(')') + 2).split(/\s+/)[19]) === ownedIdentity.starttime;
  } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
function assertOwnedPlan(plan) {
  assert(plan && ownedIdentity, 'only this fixture can authorize a process confirmation');
  assert.deepEqual(plan.processes.map(({ pid, starttime }) => ({ pid, starttime })), [ownedIdentity], 'never signal another existing process');
  assert.equal(plan.processes[0].id, `process-${ownedIdentity.pid}-${ownedIdentity.starttime}`);
  assert.equal(plan.processes[0].name, 'workbuddy');
}
async function stopOwned() {
  if (!owned) return;
  if (owned.exitCode === null && owned.signalCode === null && !ownedError) {
    if (!ownedIdentity || ownAlive()) owned.kill('SIGTERM');
    await waitFor(() => owned.exitCode !== null || owned.signalCode !== null || ownedError, 'owned child exit', 10000);
  }
  await ownedClosed;
}
async function bridgeReply(method, ...args) {
  const reply = await page.evaluate((method, args) => window.sysomDesktop[method](...args), method, args);
  assert.equal(typeof reply.ok, 'boolean');
  return reply;
}
async function bridge(method, ...args) {
  const reply = await bridgeReply(method, ...args);
  assert.equal(reply.ok, true, JSON.stringify(reply));
  assert(Object.hasOwn(reply, 'data'));
  return reply.data;
}
function failure(reply, code, status = 409) {
  assert.equal(reply.ok, false, JSON.stringify(reply));
  assert.equal(reply.error.code, code);
  assert.equal(reply.error.status, status);
  assert.equal(typeof reply.error.message, 'string');
  assert.equal(typeof reply.error.retryable, 'boolean');
  assert(!Object.hasOwn(reply, 'data'));
}
let rawId = 1000000;
async function rawRpc(method, args) {
  const id = ++rawId;
  await page.evaluate((message) => window.__sysomToHost(message), { type: 'rpc', id, method, args });
  const message = await waitFor(() => log.hostMessages.find((item) => item.id === id), `raw RPC ${method}`);
  assert.deepEqual(Object.keys(message).sort(), ['id', 'type', 'value']);
  assert.equal(message.type, 'rpc-result');
  return message.value;
}
const ranking = (resource, agents) => resource.rows.filter((row) => !agents || row.agentKind).slice().sort((a, b) => b.usage - a.usage || (a.pid ?? 0) - (b.pid ?? 0)).slice(0, 10);
const rowIds = () => page.$$eval('dialog[open] tr[data-row-id]', (rows) => rows.map((row) => row.dataset.rowId));
async function closeDialog() { await page.keyboard.press('Escape'); await page.waitForFunction(() => !document.querySelector('dialog[open]')); }
async function agentFilter() {
  await page.evaluate(() => [...document.querySelectorAll('dialog[open] .sh-rank-filter button')].find((button) => button.textContent.includes('只看 Agent')).click());
}
async function noSessionControls() { assert.equal(await page.$$eval('.sh-agent-sessions, .sh-session-row, .ad-session-id, button[aria-label*="Session"], input[aria-label*="Session"]', (items) => items.length), 0, 'Session controls must not appear'); }
async function noOverflow() {
  const size = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
  assert(size.scroll <= size.width, JSON.stringify(size));
}
async function syncUi(snapshot) {
  await page.waitForFunction((revision) => [...document.querySelectorAll('.sh-resource-card')].length > 0 && [...document.querySelectorAll('.sh-resource-card')].every((card) => Number(card.dataset.version) === revision), {}, snapshot.revision);
  const important = snapshot.inspections.filter((item) => item.important);
  const others = snapshot.inspections.filter((item) => !item.important);
  const ids = ['cpu', 'energy', 'memory', 'disk', ...(snapshot.hasGpu ? ['gpu'] : [])];
  const measured = ids.map((id) => snapshot.resources[id].status === 'unavailable' ? null : snapshot.resources[id].usage).filter((value) => value !== null && Number.isFinite(value));
  const x = important.filter((item) => item.status !== 'unchecked' && item.usage !== null && item.usage > 90).length;
  const y = others.filter((item) => item.status === 'abnormal').length + measured.filter((value) => value > 90).length;
  const score = Math.max(0, Math.min(100, 100 - x * (important.length ? 80 / important.length : 0) - y * (others.length + measured.length ? 20 / (others.length + measured.length) : 0)));
  assert.equal(await page.$eval('.sh-score-ring strong', (item) => parseFloat(item.textContent)), Number(score.toFixed(1)));
  const tooltipScore = Number(statusItem.tooltip.value.match(/仅已知项评分 ([\d.]+)/)[1]);
  assert(Math.abs(tooltipScore - score) < 1e-9);
  const statusScore = statusItem.text.match(/SysAgent ([\d.]+)分/);
  if (statusScore) assert(Math.abs(Number(statusScore[1]) - score) < 1e-9);
}
function checkDiagnostics(snapshot) {
  for (const id of ['root', 'memory', 'fd']) {
    const item = snapshot.inspections.find((entry) => entry.id === id);
    assert(item && item.evidence.some((entry) => /sysak/i.test(entry)));
    assert.equal(item.status, item.usage === null ? 'unchecked' : item.usage > 90 ? 'abnormal' : 'normal');
    if (id !== 'fd') continue;
    assert.match(item.detail, /FD 压力快照，不是泄漏趋势检查/);
    if (!item.execution || item.execution === 'unavailable' || (item.execution === 'partial' && item.status !== 'abnormal')) {
      assert.equal(item.usage, null);
      assert.equal(item.status, 'unchecked');
    }
    if (item.status === 'normal') assert.equal(item.execution, 'complete');
  }
}

function unavailableStatus(status) {
  assert.equal(status.installed, false);
  assert.equal(status.phase, 'error');
  assert.equal(status.mode, 'mock');
  assert.equal(status.read_only, true);
  assert.equal(status.error.code, 'ROOT_COLLECTOR_UNAVAILABLE');
  assert.match(status.error.message, /管理员安装并启用.*sysAK IDC 服务.*授权当前用户/);
  assert.equal(status.last_task, null);
  assert.equal(status.next_inspection_at, null);
  assert.equal(status.inspection_interval_minutes, 5);
}
function verifyManifest() {
  const bundle = path.join(root, 'dist', 'sysak');
  const manifest = JSON.parse(fs.readFileSync(path.join(bundle, 'manifest.json'), 'utf8'));
  assert.equal(manifest.schema_version, '1.0');
  assert.equal(manifest.platform, 'linux');
  assert.equal(manifest.arch, process.arch);
  assert(manifest.commands.includes('idc') && manifest.files.sysak);
  for (const [relative, digest] of Object.entries(manifest.files)) {
    const file = path.resolve(bundle, relative);
    assert(inside(bundle, file) && inside(fs.realpathSync(bundle), fs.realpathSync(file)));
    assert.match(digest, /^[a-f0-9]{64}$/);
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'), digest, relative);
  }
  fs.accessSync(path.join(bundle, 'sysak'), fs.constants.X_OK);
  return { files: Object.keys(manifest.files).length, commands: manifest.commands };
}
// Observe real host behavior, but fail before any unauthorized subprocess/signal/network effect.
function guardUnavailableHost() {
  const attempts = [];
  const restore = [];
  for (const method of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
    const original = childProcess[method];
    childProcess[method] = () => { attempts.push(method); throw new Error(`root-unavailable host must not call ${method}`); };
    restore.push(() => { childProcess[method] = original; });
  }
  const kill = process.kill;
  process.kill = () => { attempts.push('signal'); throw new Error('root-unavailable host must not send signals'); };
  restore.push(() => { process.kill = kill; });
  const connect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...args) {
    const options = args[0];
    const host = typeof options === 'object' ? options.host : typeof args[1] === 'string' ? args[1] : undefined;
    if (host && !['127.0.0.1', '::1', 'localhost'].includes(host)) {
      attempts.push('external-network');
      throw new Error('root-unavailable host must not access external network');
    }
    return connect.apply(this, args);
  };
  restore.push(() => { net.Socket.prototype.connect = connect; });
  return { attempts, restore: () => restore.reverse().forEach((undo) => undo()) };
}
async function unavailableUi() {
  await page.waitForFunction(() => document.querySelector('.sh-unavailable h1')?.textContent.includes('整体数据暂不可用') && !document.querySelector('.sh-unavailable .hg-button')?.disabled);
  const text = await page.$eval('.sh-unavailable', (item) => item.textContent);
  assert.match(text, /管理员安装并启用.*sysAK IDC 服务.*授权当前用户/);
  assert.equal(await page.$('.sh-resource-card, .sh-score-ring, tr[data-row-id], .sh-collected-rankings, .sh-process-confirm, .sh-process-results'), null);
  assert.equal(await page.$('input[type="checkbox"]:enabled'), null);
  assert.equal(await page.$$eval('button', (buttons) => buttons.filter((button) => !button.disabled && /清理所选进程|确认结束进程/.test(button.textContent)).length), 0);
  await noSessionControls();
  await noOverflow();
  return text.trim();
}
async function acceptUnavailable({ api, extension, context, deviceId, dispose, record, checks, outputDir, errors, expectedResourceErrors, foreignRequests, hostGuard }) {
  const manifest = verifyManifest();
  assert.equal(await page.$eval('.sidebar-footer span:last-child', (item) => item.textContent), `v${version}`);
  assert.equal(await page.evaluate(() => document.documentElement.classList.contains('native-main')), true);
  const methods = ['healthSnapshot', 'agentDiagnostic', 'healthReset', 'healthOperation', 'prepareProcessCleanup', 'executeProcessCleanup', 'collectorStatus', 'setCollectorEnabled', 'setInspectionInterval'];
  assert.deepEqual(await page.evaluate((names) => names.filter((method) => typeof window.sysomDesktop[method] === 'function'), methods), methods);
  const status = await bridge('collectorStatus');
  unavailableStatus(status);
  const text = await unavailableUi();
  assert.equal(api.inspect().mode, undefined);
  assert.equal(api.inspect().revision, undefined);
  record(`root-unavailable: actual host/Webview v${version}, validated manifest (${manifest.files} digests), installed=false/ROOT_COLLECTOR_UNAVAILABLE, no demo score/resources`);
  for (const refresh of [false, true]) failure(await bridgeReply('healthSnapshot', refresh), 'ROOT_COLLECTOR_UNAVAILABLE', 503);
  failure(await bridgeReply('healthReset', { hasGpu: api.inspect().hasGpu }), 'ROOT_COLLECTOR_UNAVAILABLE', 503);
  failure(await bridgeReply('healthOperation', { operation: 'inspect', parameters: {} }), 'ROOT_COLLECTOR_UNAVAILABLE', 503);
  await assert.rejects(commands['sysagent.inspect'](), (error) => error.code === 'ROOT_COLLECTOR_UNAVAILABLE');
  const before = log.requests.filter((request) => request.method === 'healthSnapshot').length;
  await clickText(page, '重试加载', '.sh-unavailable');
  await waitFor(() => log.requests.filter((request) => request.method === 'healthSnapshot').length > before, 'UI retry reaches actual host');
  await unavailableUi();
  unavailableStatus(await bridge('collectorStatus'));
  record('snapshot, refresh, reset, inspect and UI retry fail 503 without demo fallback or a collected task');
  // Empty IDs/fake token deliberately reference no PID and cannot authorize a process action.
  failure(await bridgeReply('prepareProcessCleanup', { resource: 'memory', ids: [], revision: 1 }), 'ROOT_COLLECTOR_UNAVAILABLE', 503);
  failure(await bridgeReply('executeProcessCleanup', { token: '0'.repeat(64) }), 'ROOT_COLLECTOR_UNAVAILABLE', 503);
  await clickText(page, '巡检配置');
  await page.waitForSelector('.sh-inspection-config');
  assert(await page.$eval('button[aria-label="设置巡检周期"]', (button) => button.disabled && button.textContent.trim() === '5分钟'));
  assert(await page.$eval('.sh-inspection-toggle', (button) => button.disabled));
  assert.match(await page.$eval('.sh-inspection-config', (item) => item.textContent), /暂不可用.*暂无巡检/);
  await page.click('button[aria-label="设置巡检周期"]');
  assert.equal(await page.$('.sh-interval-form'), null);
  await page.setViewport({ width: 360, height: 800 });
  await noOverflow(); await closeDialog(); await unavailableUi();
  assert(!fs.existsSync(path.join(context.globalStorageUri.fsPath, 'inspection-settings.json')));
  record('no process selection/cleanup; prepare/execute fail closed; period/toggle disabled with no schedule or settings mutation');
  for (const method of ['constructor', '/api/idc/snapshot', 'extraRPC']) failure(await rawRpc(method, []), 'INVALID_PARAMETERS', 400);
  for (const operation of ['cleanup', 'optimize', 'sessions-cleanup', 'alert-sample']) failure(await bridgeReply('healthOperation', { operation, parameters: {} }), 'read_only');
  record('fixed RPC allowlist rejects unknown methods; legacy mutations remain read_only');
  await navigateTo(page, 'Agent 管家');
  await page.waitForSelector('.ad-live');
  await page.waitForFunction(() => document.querySelector('.ad-live')?.getAttribute('aria-busy') === 'false');
  const agent = await bridge('agentDiagnostic');
  assert.equal(agent.source, 'agentsight');
  assert.equal(agent.analyzer, 'sysom-openapi');
  assert.equal(agent.coverage.length, 5);
  assert.match(await page.$eval('.ad-live', (item) => item.textContent), /AgentSight.*OpenAPI/);
  assert.equal(await page.$$eval('.ad-live button', (buttons) => buttons.filter((button) => /重启|Resolve|Hide|自动修复/.test(button.textContent)).length), 0);
  for (const value of ['true', {}, 1]) failure(await bridgeReply('agentDiagnostic', value), 'INVALID_PARAMETERS', 400);
  failure(await rawRpc('agentDiagnostic', [true, false]), 'INVALID_PARAMETERS', 400);
  assert.equal((await bridge('collectorStatus')).installed, false);
  await noSessionControls(); await noOverflow();
  record('AgentSight report crosses actual IDE RPC/OpenAPI independently of missing SysAK; boolean validation, no process actions or demo fallback');
  await commands['sysagent.openHome'](); await unavailableUi();
  await page.screenshot({ path: path.join(outputDir, `${name}-360.png`) });
  await page.setViewport({ width: 1440, height: 960 }); await unavailableUi();
  await page.screenshot({ path: path.join(outputDir, `${name}-1440.png`) });
  await dispose(); await harness.loading;
  const restarted = await extension.activate(context);
  await waitFor(() => restarted.inspect().statusText.includes('采集不可用'), 'root-unavailable reactivation');
  assert.equal(context.globalState.get('sysagent.deviceId'), deviceId);
  unavailableStatus(restarted.inspect().collector);
  assert.equal(restarted.inspect().mode, undefined);
  await dispose();
  assert(statusItem.disposed);
  assert.deepEqual(hostGuard.attempts, []);
  assert.deepEqual(errors, []); assert.deepEqual(foreignRequests, []); assert.deepEqual(log.errors, []);
  record('home/Agent: no Session or 360/1440 overflow; isolated reactivation stays unavailable; zero scripts/external requests/subprocesses/signals');
  const result = { name, acceptanceMode: 'root-unavailable', version, extensionPath: root, manifest, checks, status, text,
    errors, expectedResourceErrors, foreignRequests: foreignRequests.length, unsafeHostAttempts: hostGuard.attempts, processTargetCreated: false, outputDir };
  return result;
}

(async () => {
  const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'sysom-ide-acceptance-'));
  const outputBase = path.join(analysis, 'output');
  fs.mkdirSync(outputBase, { recursive: true });
  const outputDir = fs.mkdtempSync(path.join(outputBase, `${name}-`));
  const globalState = new Map();
  const context = { extensionUri: Uri.file(root), globalStorageUri: Uri.file(path.join(storage, 'global-storage')), subscriptions: [],
    globalState: { get: (key, fallback) => globalState.has(key) ? globalState.get(key) : fallback,
      async update(key, value) { if (value === undefined) globalState.delete(key); else globalState.set(key, value); }, keys: () => [...globalState.keys()] } };
  const dispose = async () => { for (const item of context.subscriptions.splice(0)) await item.dispose(); };
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname === '/panel') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(currentHtml.replace('<head>', `<head>${vscodeDefaultStyles}`));
      return;
    }
    if (url.pathname === '/favicon.ico') { response.writeHead(204).end(); return; }
    let file;
    try { file = path.resolve(webviewRoot, decodeURIComponent(url.pathname.replace(/^\/webview\//, ''))); }
    catch { response.writeHead(400).end(); return; }
    if (!url.pathname.startsWith('/webview/') || !inside(webviewRoot, file) || !fs.existsSync(file) || !fs.statSync(file).isFile() ||
        !inside(fs.realpathSync(webviewRoot), fs.realpathSync(file))) { response.writeHead(404).end(); return; }
    const types = { '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.png': 'image/png', '.svg': 'image/svg+xml' };
    response.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(response);
  });
  let browser;
  const errors = [];
  const expectedResourceErrors = [];
  const foreignRequests = [];
  let hostGuard;
  const checks = [];
  const record = (check) => { checks.push(check); console.log(`PASS ${name}: ${check}`); };
  try {
    if (!rootUnavailableOnly) {
    owned = spawn('python3', ['-u', '-c', [
      'import ctypes, json, os, time',
      'assert ctypes.CDLL(None).prctl(15, b"workbuddy", 0, 0, 0) == 0',
      'memory = bytearray(160 * 1024 * 1024)',
      'fds = [os.open("/dev/null", os.O_RDONLY) for _ in range(80)]',
      'stat = open("/proc/self/stat").read()',
      'print(json.dumps({"pid": os.getpid(), "starttime": int(stat[stat.rfind(")") + 2:].split()[19])}), flush=True)',
      'while True: time.sleep(1)',
    ].join('\n')], { shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let ready = '';
    let stderr = '';
    owned.stdout.on('data', (chunk) => { ready += chunk; });
    owned.stderr.on('data', (chunk) => { stderr += chunk; });
    owned.on('error', (error) => { ownedError = error; });
    ownedClosed = new Promise((resolve) => owned.once('close', (code, signal) => resolve({ code, signal })));
    await waitFor(() => {
      if (ownedError || owned.exitCode !== null || owned.signalCode !== null) throw ownedError || new Error(`owned Python exited: ${stderr}`);
      return ready.includes('\n');
    }, 'owned workbuddy readiness', 10000);
    ownedIdentity = JSON.parse(ready.trim());
    assert.equal(ownedIdentity.pid, owned.pid);
    assert(ownAlive());
    assert(fs.readdirSync(`/proc/${owned.pid}/fd`).length >= 80);
    }
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    origin = `http://127.0.0.1:${server.address().port}`;
    browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--disable-dev-shm-usage'] });
    page = await browser.newPage();
    page.setDefaultTimeout(70000);
    await page.setViewport({ width: 1440, height: 960 });
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() !== 'error') return;
      const text = message.text();
      if (rootUnavailableOnly && /^Failed to load resource: the server responded with a status of 503\b/.test(text)) expectedResourceErrors.push(text);
      else errors.push(text);
    });
    if (rootUnavailableOnly) await page.setRequestInterception(true);
    page.on('request', (request) => {
      const foreign = /^https?:/.test(request.url()) && !request.url().startsWith(`${origin}/`);
      if (foreign) foreignRequests.push(new URL(request.url()).origin);
      if (rootUnavailableOnly) (foreign ? request.abort() : request.continue()).catch((error) => errors.push(error.message));
    });
    await page.exposeFunction('__sysomToHost', (message) => {
      if (!harness.panel || harness.panel.disposed) return;
      if (message.type === 'rpc' && message.method === 'executeProcessCleanup' && typeof message.args?.[0]?.token === 'string') {
        if (rootUnavailableOnly) {
          assert.equal(message.args[0].token, '0'.repeat(64), 'only a deliberately invalid token is allowed');
          assert.equal(plans.size, 0);
        } else assertOwnedPlan(plans.get(message.args[0].token));
      }
      log.requests.push(message);
      harness.panel.receive(message);
    });
    await page.evaluateOnNewDocument(() => {
      let acquired = false;
      window.acquireVsCodeApi = () => {
        if (acquired) throw new Error('acquireVsCodeApi called twice');
        acquired = true;
        return { postMessage: (message) => window.__sysomToHost(message), getState: () => undefined, setState: () => undefined };
      };
      document.addEventListener('securitypolicyviolation', (error) => console.error(`CSP violation: ${error.violatedDirective} ${error.blockedURI}`));
    });
    if (rootUnavailableOnly) hostGuard = guardUnavailableHost();
    const load = Module._load;
    let extension;
    try {
      Module._load = function loadWithVscode(request, ...rest) { return request === 'vscode' ? vscode : load.call(this, request, ...rest); };
      extension = require(path.join(root, 'dist', 'extension.js'));
    } finally { Module._load = load; }
    const api = await extension.activate(context);
    assert.deepEqual(Object.keys(commands).sort(), ['sysagent.inspect', 'sysagent.openHome']);
    if (rootUnavailableOnly) {
      await waitFor(() => api.inspect().statusText.includes('采集不可用'), 'actual root-unavailable activation');
      unavailableStatus(api.inspect().collector);
      assert.equal(statusItem.text, '$(warning) SysAgent 采集不可用');
      assert.match(statusItem.tooltip, /管理员安装并启用.*sysAK IDC 服务.*授权当前用户/);
    } else {
      await waitFor(() => api.inspect().mode === 'collected', 'actual collected activation');
      await waitFor(() => /^\$\(hubot\) SysAgent [\d.]+分$/.test(statusItem.text), 'actual status score');
      assert.match(statusItem.tooltip.value, /仅已知项评分.*未知不代表正常.*本机实际采集/s);
    }
    assert(statusItem.visible && statusItem.command === 'sysagent.openHome');
    assert(!api.inspect().panelOpen);
    const deviceId = globalState.get('sysagent.deviceId');
    assert.match(deviceId, /^[a-f0-9-]{36}$/i);
    assert.equal(api.inspect().collector.device_id, deviceId);
    assert.equal(api.inspect().collector.inspection_interval_minutes, 5);
    record(`async activation uses isolated storage/device identity and real ${rootUnavailableOnly ? 'root-unavailable' : 'collected'} status, not a fixed score`);

    await commands['sysagent.openHome']();
    await harness.loading;
    const panel = harness.panel;
    assert.equal(panel.viewType, 'sysagent.home');
    assert(panel.options.enableScripts && panel.options.retainContextWhenHidden);
    assert.deepEqual(panel.options.localResourceRoots.map((uri) => uri.fsPath), [webviewRoot]);
    assert.throws(() => panel.webview.asWebviewUri(Uri.file(path.join(root, 'package.json'))), /outside localResourceRoots/);
    assert.equal(panel.iconPath.fsPath, path.join(root, 'dist', 'icon.png'));
    const csp = currentHtml.match(/Content-Security-Policy" content="([^"]+)"/)[1];
    const nonce = csp.match(/'nonce-([^']+)'/)[1];
    assert(csp.startsWith("default-src 'none'") && !csp.includes('unsafe') && !csp.includes('connect-src'));
    assert(currentHtml.includes(`<script nonce="${nonce}" src="${origin}/webview/webview.js">`));
    await page.waitForSelector(rootUnavailableOnly ? '.sh-unavailable' : '.sh-resource-card');
    await page.evaluate(() => document.fonts.ready);
    const bodyStyle = await page.evaluate(() => { const style = getComputedStyle(document.body); return { padding: style.paddingLeft, font: style.fontFamily, color: style.color }; });
    assert.equal(bodyStyle.padding, '0px');
    assert(bodyStyle.font.startsWith('Inter'));
    assert.equal(bodyStyle.color, 'rgb(38, 50, 75)');
    record('real browser keeps strict nonce CSP/localResourceRoots and overrides injected VS Code body styles');

    if (rootUnavailableOnly) {
      const result = await acceptUnavailable({ api, extension, context, deviceId, dispose, record, checks, outputDir, errors, expectedResourceErrors, foreignRequests, hostGuard });
      fs.writeFileSync(path.join(outputDir, `${name}-ide.json`), JSON.stringify(result, null, 2));
      console.log(JSON.stringify(result));
      return;
    }

    let snapshot = await bridge('healthSnapshot');
    const collector = await bridge('collectorStatus');
    await syncUi(snapshot);
    assert.equal(snapshot.mode, 'collected');
    assert(collector.installed && collector.enabled && collector.read_only && collector.last_task.raw_bytes > 0);
    assert.equal(collector.last_task.simulated, false);
    assert.equal(collector.last_task.profile, 'resources');
    assert(['ok', 'partial'].includes(collector.last_task.collection_status));
    for (const resource of Object.values(snapshot.resources)) {
      assert.equal(resource.source, 'sysak');
      assert(resource.usage === null || (resource.usage >= 0 && resource.usage <= 100));
      assert(resource.rows.every((row) => row.defaultSelected === false && !row.sessions && !row.agentId));
    }
    assert.equal(snapshot.resources.memory.rankUnit, '%');
    assert.equal(snapshot.resources.disk.rankUnit, 'B/s');
    const memTotal = Number(fs.readFileSync('/proc/meminfo', 'utf8').match(/^MemTotal:\s+(\d+) kB$/m)[1]) * 1024;
    assert.equal(snapshot.resources.memory.quantity.total, memTotal);
    const statfs = fs.statfsSync('/');
    assert.equal(snapshot.resources.disk.quantity.total, statfs.blocks * statfs.bsize);
    const percent = (used, total) => Math.round(used / total * 1000) / 10;
    for (const id of ['memory', 'disk']) assert.equal(snapshot.resources[id].usage, percent(snapshot.resources[id].quantity.value, snapshot.resources[id].quantity.total));
    assert.equal(snapshot.resources.energy.usage, null);
    const ownId = `process-${owned.pid}-${ownedIdentity.starttime}`;
    const memoryRow = snapshot.resources.memory.rows.find((row) => row.id === ownId);
    if (memoryRow) {
      assert.equal(memoryRow.name, 'workbuddy');
      assert.equal(memoryRow.agentKind, 'WorkBuddy');
      assert(memoryRow.quantity.value >= 160 * 1024 * 1024);
      assert.equal(memoryRow.usage, percent(memoryRow.quantity.value, memTotal));
    }
    const visibleIds = ['cpu', 'energy', 'memory', 'disk', ...(snapshot.hasGpu ? ['gpu'] : [])];
    assert.deepEqual(await page.$$eval('.sh-resource-card', (cards) => cards.map((card) => card.dataset.resource)), visibleIds);
    for (const id of visibleIds) {
      const resource = snapshot.resources[id];
      await page.click(`button[aria-label="查看${resource.label}详情"]`);
      await page.waitForSelector('.sh-collected-rankings');
      assert.deepEqual(await rowIds(), ranking(resource, false).map((row) => row.id));
      assert.equal(await page.$$eval('dialog[open] input:checked', (inputs) => inputs.length), 0);
      await agentFilter();
      await waitFor(async () => JSON.stringify(await rowIds()) === JSON.stringify(ranking(resource, true).map((row) => row.id)), `${id} Agent-before-Top10`);
      await noSessionControls();
      await page.setViewport({ width: 360, height: 800 });
      await noOverflow();
      await closeDialog();
      await noOverflow();
      await page.setViewport({ width: 1440, height: 960 });
    }
    record('sysAK matches /proc memory/root totals; rankings sort by metric/PID and filter Agents before Top10 without Session controls');

    await clickText(page, '巡检配置');
    await page.waitForSelector('.sh-inspection-config');
    assert.equal(await page.$eval('button[aria-label="设置巡检周期"]', (button) => button.textContent.trim()), '5分钟');
    await page.click('button[aria-label="设置巡检周期"]');
    await clickText(page, '自定义', 'dialog[open]');
    const inputs = await page.$$('.sh-interval-inputs input');
    const editInput = async (input, value) => { await input.click({ clickCount: 3 }); await page.keyboard.press('Backspace'); await input.type(value); };
    for (const [hours, minutes] of [['0', '0'], ['24', '1']]) {
      await editInput(inputs[0], hours); await editInput(inputs[1], minutes);
      assert(await page.$eval('.sh-interval-actions button[type="submit"]', (button) => button.disabled));
    }
    await editInput(inputs[0], '1'); await editInput(inputs[1], '30');
    const beforeInterval = await bridge('collectorStatus');
    await clickText(page, '保存', 'dialog[open]');
    await page.waitForSelector('.sh-inspection-config');
    const intervalStatus = await bridge('collectorStatus');
    assert.equal(intervalStatus.inspection_interval_minutes, 90);
    assert.deepEqual(intervalStatus.last_task, beforeInterval.last_task);
    assert.equal((await bridge('healthSnapshot')).revision, snapshot.revision);
    const remaining = Date.parse(intervalStatus.next_inspection_at) - Date.now();
    assert(remaining > 89 * 60000 && remaining <= 90 * 60000);
    const settingsPath = path.join(context.globalStorageUri.fsPath, 'inspection-settings.json');
    assert.deepEqual(JSON.parse(fs.readFileSync(settingsPath, 'utf8')), { inspection_interval_minutes: 90 });
    for (const minutes of [0, 1441]) failure(await bridgeReply('setInspectionInterval', minutes), 'INVALID_INSPECTION_INTERVAL', 400);
    assert.equal((await bridge('collectorStatus')).inspection_interval_minutes, 90);
    assert.deepEqual(JSON.parse(fs.readFileSync(settingsPath, 'utf8')), { inspection_interval_minutes: 90 });
    await closeDialog();
    record('period defaults to 5; UI saves custom 90 without collection and persists it; UI/API reject 0/1441');

    const reset = await bridge('healthReset', { hasGpu: api.inspect().hasGpu });
    assert.equal(reset.mode, 'collected');
    assert(reset.revision > snapshot.revision);
    await commands['sysagent.inspect']();
    snapshot = await bridge('healthSnapshot');
    assert(snapshot.revision > reset.revision);
    const inspectionTask = await bridge('collectorStatus');
    assert.equal(inspectionTask.last_task.operation, 'inspect');
    assert.equal(inspectionTask.last_task.profile, 'inspection');
    assert.equal(inspectionTask.last_task.simulated, false);
    checkDiagnostics(snapshot);
    await syncUi(snapshot);
    await clickText(page, '重新体检');
    await page.waitForFunction(() => !document.querySelector('.sh-operation-state') && document.querySelector('.sh-operation-success')?.textContent.includes('体检完成'));
    snapshot = await bridge('healthSnapshot');
    assert.notEqual((await bridge('collectorStatus')).last_task.id, inspectionTask.last_task.id);
    checkDiagnostics(snapshot);
    await page.click('.sh-inspection-entry');
    await page.waitForSelector('dialog[open] [data-inspection="fd"]');
    const fd = snapshot.inspections.find((item) => item.id === 'fd');
    const fdUi = await page.$eval('[data-inspection="fd"]', (item) => ({ status: item.className, result: item.querySelector('.sh-inspection-result').textContent }));
    assert(fdUi.status.split(' ').includes(fd.status));
    if (fd.status === 'unchecked') assert(!fdUi.result.includes('正常'));
    await page.setViewport({ width: 360, height: 800 }); await noOverflow(); await closeDialog();
    await page.setViewport({ width: 1440, height: 960 });
    record('reset and command/UI inspection collect real root/memory/FD evidence; unavailable/partial FD is null/unchecked, never normal');

    for (const operation of ['cleanup', 'optimize', 'sessions-cleanup', 'alert-sample']) failure(await bridgeReply('healthOperation', { operation, parameters: { revision: snapshot.revision } }), 'read_only');
    for (const [method, args] of [
      ['constructor', []], ['/api/idc/snapshot', []], ['extraRPC', []], ['collectorStatus', [true]],
      ['healthSnapshot', [false, true]], ['healthSnapshot', ['../../sysak']], ['healthReset', [{}, {}]],
      ['healthOperation', [{ operation: 'inspect', parameters: {}, extra: true }]],
      ['prepareProcessCleanup', [{ resource: 'memory', ids: [ownId], revision: snapshot.revision, pid: owned.pid }]],
      ['setCollectorEnabled', [true, false]], ['setCollectorEnabled', ['yes']], ['setInspectionInterval', [90, 5]],
    ]) failure(await rawRpc(method, args), method === 'healthOperation' ? 'INVALID_OPERATION' : 'INVALID_PARAMETERS', 400);
    assert(ownAlive());
    record('legacy business mutations stay read_only; constructor/path/extraRPC and extra RPC parameters fail closed');

    let selectedResource = ['memory', 'cpu', 'disk'].find((id) => snapshot.resources[id].rows.some((row) => row.id === ownId && row.cleanable));
    let previousPlan;
    async function selectOwned() {
      await syncUi(snapshot);
      await page.click(`button[aria-label="查看${snapshot.resources[selectedResource].label}详情"]`);
      await page.waitForSelector('.sh-collected-rankings');
      if (!(await rowIds()).includes(ownId)) {
        await agentFilter();
        await page.waitForFunction(() => [...document.querySelectorAll('.sh-rank-filter button')].some((button) => button.textContent.includes('只看 Agent') && button.getAttribute('aria-pressed') === 'true'));
      }
      if (!(await rowIds()).includes(ownId)) { await closeDialog(); return false; }
      const selector = `dialog[open] tr[data-row-id="${ownId}"] input`;
      assert(!(await page.$eval(selector, (input) => input.disabled)));
      await page.click(selector);
      assert.deepEqual(await page.$$eval('dialog[open] tr[data-row-id] input:checked', (inputs) => inputs.map((input) => input.closest('tr').dataset.rowId)), [ownId]);
      return true;
    }
    if (selectedResource) {
      const uiTarget = await selectOwned();
      if (uiTarget) {
        const count = plans.size;
        const executes = log.requests.filter((item) => item.method === 'executeProcessCleanup').length;
        await clickText(page, '清理所选进程（1）', 'dialog[open]');
        await page.waitForSelector('.sh-process-confirm');
        await waitFor(() => plans.size > count, 'UI preflight plan');
        previousPlan = [...plans.values()].at(-1);
        assertOwnedPlan(previousPlan);
        assert(ownAlive());
        await clickText(page, '取消', '.sh-process-confirm');
        await page.waitForFunction(() => !document.querySelector('.sh-process-confirm'));
        assert(ownAlive());
        assert.equal(log.requests.filter((item) => item.method === 'executeProcessCleanup').length, executes);
        await closeDialog();
      } else {
        previousPlan = await bridge('prepareProcessCleanup', { resource: selectedResource, ids: [ownId], revision: snapshot.revision });
        assertOwnedPlan(previousPlan);
      }
      const replacement = await bridge('prepareProcessCleanup', { resource: selectedResource, ids: [ownId], revision: snapshot.revision });
      assertOwnedPlan(replacement);
      assert.notEqual(previousPlan.token, replacement.token);
      failure(await bridgeReply('executeProcessCleanup', { token: previousPlan.token }), 'INVALID_CLEANUP_PLAN');
      previousPlan = replacement;
      failure(await rawRpc('executeProcessCleanup', [{ token: previousPlan.token }, {}]), 'INVALID_PARAMETERS', 400);
      failure(await rawRpc('executeProcessCleanup', [{ token: previousPlan.token, pid: owned.pid }]), 'INVALID_PARAMETERS', 400);
      assert(ownAlive());
      record(`${uiTarget ? 'UI selection/preflight/cancel' : 'outside Top10: real bridge preflight'} never signals; replacement invalidates old token`);
    } else {
      failure(await bridgeReply('prepareProcessCleanup', { resource: 'memory', ids: [ownId], revision: snapshot.revision }), 'PROTECTED_PROCESS');
      record('owned target outside retained/eligible ranking: API rejects it without selecting another process');
    }

    await clickText(page, '巡检配置'); await page.waitForSelector('.sh-inspection-config');
    await clickText(page, '暂停巡检', 'dialog[open]');
    await waitFor(async () => !(await bridge('collectorStatus')).enabled, 'collector paused');
    const paused = await bridge('collectorStatus');
    assert.equal(paused.phase, 'disabled'); assert.equal(paused.next_inspection_at, null);
    failure(await bridgeReply('prepareProcessCleanup', { resource: 'memory', ids: [ownId], revision: snapshot.revision }), 'COLLECTOR_DISABLED');
    if (previousPlan) failure(await bridgeReply('executeProcessCleanup', { token: previousPlan.token }), 'COLLECTOR_DISABLED');
    await closeDialog();
    await page.click(`button[aria-label="查看${snapshot.resources.memory.label}详情"]`);
    await page.waitForSelector('.sh-collected-rankings');
    assert(await page.$$eval('dialog[open] .sh-collected-rankings input', (inputs) => inputs.length > 0 && inputs.every((input) => input.disabled)));
    assert(await page.$$eval('dialog[open] button', (buttons) => buttons.filter((button) => button.textContent.includes('清理所选进程')).every((button) => button.disabled)));
    await closeDialog(); assert(ownAlive());
    await clickText(page, '巡检配置'); await page.waitForSelector('.sh-inspection-config');
    await clickText(page, '开启巡检', 'dialog[open]');
    await waitFor(async () => { const status = await bridge('collectorStatus'); return status.enabled && status.phase === 'idle' && status.last_task.id !== paused.last_task.id; }, 'resume real collection');
    await page.waitForFunction(() => !document.querySelector('.sh-inspection-toggle')?.disabled);
    await closeDialog();
    if (previousPlan) failure(await bridgeReply('executeProcessCleanup', { token: previousPlan.token }), 'INVALID_CLEANUP_PLAN');
    snapshot = await bridge('healthSnapshot');
    selectedResource = ['memory', 'cpu', 'disk'].find((id) => snapshot.resources[id].rows.some((row) => row.id === ownId && row.cleanable));
    record('pause disables UI selection/prepare/execute and clears schedule/tokens; resume collects without reviving old plans');

    if (selectedResource) {
      const beforeConfirm = snapshot.revision;
      const ui = await selectOwned();
      let confirmedPlan;
      if (ui) {
        const count = plans.size;
        await clickText(page, '清理所选进程（1）', 'dialog[open]'); await page.waitForSelector('.sh-process-confirm');
        await waitFor(() => plans.size > count, 'fresh confirmation plan');
        confirmedPlan = [...plans.values()].at(-1);
        assertOwnedPlan(confirmedPlan); assert(ownAlive());
        await clickText(page, '确认结束进程', '.sh-process-confirm');
      } else {
        confirmedPlan = await bridge('prepareProcessCleanup', { resource: selectedResource, ids: [ownId], revision: snapshot.revision });
        assertOwnedPlan(confirmedPlan); assert(ownAlive());
        const result = await bridge('executeProcessCleanup', { token: confirmedPlan.token });
        assert(result.refresh_required);
        assert.deepEqual(result.results.map(({ pid, starttime, status }) => ({ pid, starttime, status })), [{ ...ownedIdentity, status: 'signalled' }]);
        await bridge('healthSnapshot', true);
      }
      await waitFor(() => owned.signalCode !== null || owned.exitCode !== null, 'owned child termination');
      assert.equal((await ownedClosed).signal, 'SIGTERM');
      if (ui) {
        await page.waitForFunction(() => document.querySelector('.sh-process-results')?.textContent.includes('已发送 SIGTERM') && document.querySelector('.sh-operation-success')?.textContent.includes('已刷新快照'));
        assert.match(await page.$eval('.sh-process-results', (item) => item.textContent), new RegExp(`PID ${owned.pid}`));
        await closeDialog();
      }
      snapshot = await bridge('healthSnapshot');
      assert(snapshot.revision > beforeConfirm);
      assert(Object.values(snapshot.resources).every((resource) => !resource.rows.some((row) => row.id === ownId)));
      failure(await bridgeReply('executeProcessCleanup', { token: confirmedPlan.token }), 'INVALID_CLEANUP_PLAN');
      record(`${ui ? 'UI golden path' : 'outside Top10: explicit fixture confirmation through bridge'} signals only owned workbuddy with SIGTERM, refreshes and rejects replay`);
    }

    await navigateTo(page, '日志分析'); await commands['sysagent.openHome']();
    await page.waitForFunction(() => document.querySelector('nav button.active')?.textContent.includes('体检首页'));
    assert(log.reveals >= 1);
    await navigateTo(page, 'Agent 管家');
    await page.waitForFunction(() => document.querySelector('.ad-live')?.getAttribute('aria-busy') === 'false');
    const agentReport = await bridge('agentDiagnostic');
    assert.equal(agentReport.source, 'agentsight');
    assert.equal(agentReport.analyzer, 'sysom-openapi');
    assert.equal(agentReport.coverage.length, 5);
    assert.equal(await page.$$eval('.ad-live-process', (items) => items.length), agentReport.processes.length);
    assert.match(await page.$eval('.ad-live', (item) => item.textContent), new RegExp(`全窗口未处理 ${agentReport.totals.unresolved ?? '—'}`));
    assert.equal(await page.$$eval('.ad-live button', (buttons) => buttons.filter((button) => /重启|Resolve|Hide|自动修复/.test(button.textContent)).length), 0);
    for (const value of ['true', {}, 1]) failure(await bridgeReply('agentDiagnostic', value), 'INVALID_PARAMETERS', 400);
    failure(await rawRpc('agentDiagnostic', [true, false]), 'INVALID_PARAMETERS', 400);
    await noSessionControls(); await noOverflow();
    record('AgentSight report crosses actual IDE RPC and OpenAPI; matching process/count evidence, read-only controls and strict boolean arguments');
    await page.setViewport({ width: 360, height: 800 }); await noOverflow();
    await commands['sysagent.openHome'](); await page.waitForSelector('.sh-resource-card');
    await noSessionControls(); await noOverflow();
    await page.screenshot({ path: path.join(outputDir, `${name}-360.png`) });
    await page.setViewport({ width: 1440, height: 960 });
    record('existing-panel command reveals home; Agent/home have no Session controls and 360px has no document overflow');

    harness.saveTarget = Uri.file(path.join(storage, 'report.txt'));
    await clickText(page, '体检报告'); await page.waitForSelector('dialog[open]');
    await clickText(page, '导出采集报告', 'dialog[open]');
    await waitFor(() => log.infos.some((message) => message.includes('已保存 report.txt')), 'report saved');
    assert.equal(path.basename(log.saveDialogs.at(-1).defaultUri.fsPath), 'sysom-health-collected-report.txt');
    assert.match(fs.readFileSync(path.join(storage, 'report.txt'), 'utf8'), /SysAgent.*本机资源采集报告/s);
    await closeDialog();
    const saveCount = log.saveDialogs.length;
    await page.evaluate(() => {
      navigator.clipboard.writeText('sysom-real-collector'); navigator.clipboard.writeText('x'.repeat(10020));
      window.__sysomToHost({ type: 'clipboard', text: 123 });
      window.__sysomToHost({ type: 'save', filename: '../../evil/../passwd', content: 'x' });
      window.__sysomToHost({ type: 'save', filename: 'oversized.txt', content: 'x'.repeat(5 * 1024 * 1024 + 1) });
      window.__sysomToHost({ type: 'save', filename: 123, content: 'x' });
    });
    await waitFor(() => log.clipboard.length === 2 && log.saveDialogs.length === saveCount + 1, 'clipboard/save boundary');
    assert.deepEqual(log.clipboard, ['sysom-real-collector', 'x'.repeat(10000)]);
    assert.equal(log.saveDialogs.at(-1).defaultUri.fsPath, path.join(os.homedir(), 'passwd'));
    assert(!fs.existsSync(path.join(storage, 'oversized.txt')));
    record('blob report/clipboard use host APIs; traversal filenames are sanitized and oversized/invalid saves ignored');

    await page.click('button[aria-label="关闭主页并收回悬浮球"]');
    await waitFor(() => !api.inspect().panelOpen, 'collapse disposes panel'); await harness.loading;
    const old = { calls: api.inspect().webviewCalls, messages: log.hostMessages.length, saves: log.saveDialogs.length };
    panel.receive({ type: 'rpc', id: ++rawId, method: 'setCollectorEnabled', args: [false] });
    panel.receive({ type: 'rpc', id: ++rawId, method: 'executeProcessCleanup', args: [{ token: previousPlan?.token || 'a'.repeat(64) }] });
    panel.receive({ type: 'save', filename: 'closed.txt', content: 'x' });
    panel.receive({ type: 'clipboard', text: 'closed' }); panel.receive({ type: 'open-home' });
    assert.equal(api.inspect().webviewCalls, old.calls); assert.equal(log.hostMessages.length, old.messages);
    assert.equal(log.saveDialogs.length, old.saves); assert.equal(log.clipboard.length, 2);
    assert(api.inspect().collector.enabled && !api.inspect().panelOpen);
    await commands['sysagent.openHome'](); await harness.loading; await page.waitForSelector('.sh-resource-card');
    panel.receive({ type: 'rpc', id: ++rawId, method: 'setCollectorEnabled', args: [false] });
    assert(api.inspect().collector.enabled);
    record('closed/replaced panel ignores stale RPC/save/clipboard/open messages and cannot signal or mutate the new panel');
    await dispose(); assert(statusItem.disposed && harness.panel.disposed); await harness.loading;
    const restarted = await extension.activate(context);
    await waitFor(() => restarted.inspect().mode === 'collected', 'reactivation collected');
    assert.equal(globalState.get('sysagent.deviceId'), deviceId);
    assert.equal(restarted.inspect().collector.device_id, deviceId);
    assert.equal(restarted.inspect().collector.inspection_interval_minutes, 90);
    await dispose(); assert(statusItem.disposed);
    record('reactivation preserves isolated deviceId/settings; disposal closes collector/status/panel');
    assert.equal(errors.length, 0, errors.join('\n')); assert.equal(foreignRequests.length, 0, foreignRequests.join('\n'));
    assert.deepEqual(log.errors, []);
    const result = { name, checks, errors, foreignRequests: foreignRequests.length, outputDir };
    fs.writeFileSync(path.join(outputDir, `${name}-ide.json`), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
  } catch (error) {
    if (rootUnavailableOnly) {
      const result = { name, acceptanceMode: 'root-unavailable', ok: false, checks, failure: error.stack || error.message,
        errors, expectedResourceErrors, foreignRequests, unsafeHostAttempts: hostGuard?.attempts || [], processTargetCreated: false, outputDir };
      if (page && !page.isClosed()) {
        result.sessionEvidence = await page.$$eval('.sh-agent-sessions, .sh-session-row, .ad-session-id, button[aria-label*="Session"], input[aria-label*="Session"]', (items) => items.map((item) => ({ tag: item.tagName, class: item.className, text: item.textContent.trim().slice(0, 160) }))).catch(() => []);
        await page.screenshot({ path: path.join(outputDir, `${name}-failure.png`) }).catch(() => undefined);
      }
      fs.writeFileSync(path.join(outputDir, `${name}-ide.json`), JSON.stringify(result, null, 2));
      console.error(JSON.stringify(result));
    }
    throw error;
  } finally {
    try { await dispose(); await harness.loading; }
    finally {
      hostGuard?.restore();
      try { await stopOwned(); }
      finally {
        try { if (browser) await browser.close(); }
        finally {
          if (server.listening) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
          fs.rmSync(storage, { recursive: true, force: true });
        }
      }
    }
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
