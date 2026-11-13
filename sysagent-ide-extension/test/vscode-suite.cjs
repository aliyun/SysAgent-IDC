const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');
const childProcess = require('node:child_process');
const net = require('node:net');
const rootUnavailableOnly = process.env.SYSOM_ROOT_UNAVAILABLE_ONLY === '1';
const version = require(path.resolve(__dirname, '../../package.json')).version;

const signals = process.env.SYSOM_SIGNALS;
assert(signals, 'isolated test signals directory is required');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(check, label, timeout = 70000) {
  const end = Date.now() + timeout;
  while (!(await check())) {
    if (Date.now() > end) throw new Error(`timeout: ${label}`);
    await sleep(100);
  }
}
function collectorEvidence(info, profile) {
  assert.equal(info.mode, 'collected');
  assert.match(info.statusText, /SysAgent (?:[\d.]+分|\d+ 项告警)/);
  assert(info.collector.installed && info.collector.enabled && info.collector.read_only);
  assert.equal(info.collector.last_task.simulated, false);
  assert(info.collector.last_task.raw_bytes > 0);
  assert(['ok', 'partial'].includes(info.collector.last_task.collection_status));
  assert.equal(info.collector.last_task.profile, profile);
  assert.equal(info.collector.inspection_interval_minutes, 5);
  assert(Number.isFinite(Date.parse(info.collector.next_inspection_at)));
}

function unavailableEvidence(info) {
  assert.equal(info.mode, undefined);
  assert.equal(info.revision, undefined);
  assert.equal(info.statusText, '$(warning) SysAgent 采集不可用');
  assert.equal(info.collector.installed, false);
  assert.equal(info.collector.mode, 'mock');
  assert.equal(info.collector.phase, 'error');
  assert.equal(info.collector.read_only, true);
  assert.equal(info.collector.error.code, 'ROOT_COLLECTOR_UNAVAILABLE');
  assert.match(info.collector.error.message, /管理员安装并启用.*sysAK IDC 服务.*授权当前用户/);
  assert.equal(info.collector.last_task, null);
  assert.equal(info.collector.next_inspection_at, null);
  assert.equal(info.collector.inspection_interval_minutes, 5);
}
function guardUnavailableHost() {
  const attempts = [];
  const undo = [];
  // Force missing installation evidence without touching the actual root service.
  const lstat = fs.lstatSync;
  fs.lstatSync = function (file, ...args) {
    if (file === '/opt/SysAgent管家') throw Object.assign(new Error('Unavailable installation fixture'), { code: 'ENOENT' });
    return lstat.call(this, file, ...args);
  };
  undo.push(() => { fs.lstatSync = lstat; });
  for (const method of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
    const original = childProcess[method];
    childProcess[method] = () => { attempts.push(method); throw new Error(`root-unavailable host must not call ${method}`); };
    undo.push(() => { childProcess[method] = original; });
  }
  const kill = process.kill;
  process.kill = () => { attempts.push('signal'); throw new Error('root-unavailable host must not send signals'); };
  undo.push(() => { process.kill = kill; });
  const connect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...args) {
    const options = args[0];
    const host = typeof options === 'object' ? options.host : typeof args[1] === 'string' ? args[1] : undefined;
    if (options?.path === '/run/sysom-idc/idc.sock') {
      attempts.push('root-service'); throw new Error('unavailable fixture must not contact the actual root service');
    }
    if (host && !['127.0.0.1', '::1', 'localhost'].includes(host)) {
      attempts.push('external-network'); throw new Error('root-unavailable host must not access external network');
    }
    return connect.apply(this, args);
  };
  undo.push(() => { net.Socket.prototype.connect = connect; });
  return { attempts, restore: () => undo.reverse().forEach((restore) => restore()) };
}
async function runUnavailable(extension, checks, record) {
  const guard = guardUnavailableHost();
  try {
    const api = await extension.activate();
    assert(extension.isActive && typeof api.inspect === 'function');
    const commands = await vscode.commands.getCommands(true);
    for (const id of ['sysagent.openHome', 'sysagent.inspect']) assert(commands.includes(id), id);
    for (const id of ['sysagent.alertDemo', 'sysagent.resetDemo']) assert(!commands.includes(id), id);
    await waitFor(() => api.inspect().statusText.includes('采集不可用'), 'actual unavailable status');
    unavailableEvidence(api.inspect());
    const queryStatus = api.inspect().collector.query_api;
    assert.equal(queryStatus.enabled, true, JSON.stringify(queryStatus));
    const discovery = path.join(path.dirname(signals), 'user-data', 'User', 'globalStorage',
      'sysagent-local.sysagent-ide', 'local-api', `${queryStatus.instance_id}.json`);
    const endpoint = JSON.parse(fs.readFileSync(discovery, 'utf8'));
    assert.equal(fs.statSync(discovery).mode & 0o777, 0o600);
    assert.equal(endpoint.base_url, queryStatus.base_url);
    const snapshotResponse = await fetch(`${endpoint.base_url}/api/v1/snapshot`, {
      headers: { authorization: `Bearer ${endpoint.token}` },
    });
    assert.equal(snapshotResponse.status, 200);
    const queried = await snapshotResponse.json();
    assert.equal(queried.meta.host_kind, 'ide');
    assert.equal(queried.meta.cache_only, true);
    assert.equal(queried.data.state, null);
    assert.deepEqual(queried.data.tasks, []);
    assert.equal((await fetch(`${endpoint.base_url}/api/v1/status`)).status, 401);
    assert.equal((await fetch(`${endpoint.base_url}/api/v1/status`, {
      method: 'POST', headers: { authorization: `Bearer ${endpoint.token}` },
    })).status, 405);
    assert(!api.inspect().panelOpen);
    record('actual IDE local HTTP: private discovery, authenticated cache-only GET, missing evidence preserved, unauthenticated/write rejected');
    record(`cached VS Code ${vscode.version}: real v${version} activation, installed=false/ROOT_COLLECTOR_UNAVAILABLE, no demo/score/task`);
    await vscode.commands.executeCommand('sysagent.openHome');
    await waitFor(() => api.inspect().panelOpen && api.inspect().webviewCalls >= 2, 'real unavailable Webview RPC');
    const calls = api.inspect().webviewCalls;
    await waitFor(() => api.inspect().webviewCalls > calls, 'unavailable shared client polling');
    fs.writeFileSync(path.join(signals, 'panel-ready'), '');
    await waitFor(() => fs.existsSync(path.join(signals, 'inspected')), 'unavailable DevTools acceptance', 120000);
    const home = JSON.parse(fs.readFileSync(path.join(signals, 'webview.json'), 'utf8'));
    assert.equal(home.ok, true, JSON.stringify(home));
    assert.equal(home.mode, 'root-unavailable');
    assert.equal(home.version, `v${version}`);
    assert.deepEqual(home.errors, []);
    assert.equal(home.foreignRequests.length, 0);
    assert.equal(home.processTargetCreated, false);
    assert(home.retryFailed && home.unknownRpcRejected && home.periodDisabled);
    unavailableEvidence(api.inspect());
    record('actual strict-CSP shared Webview: snapshot/retry fail, root install authorization stated, no process selection/Session/overflow/scripts/external requests; unknown RPC rejected');
    await assert.rejects(vscode.commands.executeCommand('sysagent.inspect'), (error) => error.code === 'ROOT_COLLECTOR_UNAVAILABLE');
    unavailableEvidence(api.inspect());
    fs.writeFileSync(path.join(signals, 'inspection-ready'), '');
    await waitFor(() => fs.existsSync(path.join(signals, 'inspection-inspected')), 'unavailable inspect evidence', 120000);
    const inspected = JSON.parse(fs.readFileSync(path.join(signals, 'webview.json'), 'utf8'));
    assert.equal(inspected.ok, true, JSON.stringify(inspected));
    assert.equal(inspected.inspection.code, 'ROOT_COLLECTOR_UNAVAILABLE');
    assert.deepEqual(inspected.errors, []);
    record('inspect command rejects ROOT_COLLECTOR_UNAVAILABLE without producing a revision/task or ordinary-user fallback');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await waitFor(() => !api.inspect().panelOpen, 'unavailable panel disposal');
    await assert.rejects(vscode.commands.executeCommand('sysagent.inspect'), (error) => error.code === 'ROOT_COLLECTOR_UNAVAILABLE');
    unavailableEvidence(api.inspect());
    assert(!api.inspect().panelOpen);
    await vscode.commands.executeCommand('sysagent.openHome');
    await waitFor(() => api.inspect().panelOpen, 'unavailable panel reopen');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await waitFor(() => !api.inspect().panelOpen, 'reopened panel disposal');
    assert.deepEqual(guard.attempts, []);
    record('isolated profile/extensions: closed/reopened panel stays unavailable; zero host subprocess/signal/external-network attempts');
    fs.writeFileSync(path.join(signals, 'checks.json'), JSON.stringify(checks));
  } finally { guard.restore(); }
}

async function run() {
  assert.equal(vscode.version, '1.145.2');
  const checks = [];
  const record = (check) => { checks.push(check); console.log(`PASS vscode: ${check}`); };
  const extension = vscode.extensions.getExtension('sysagent-local.sysagent-ide');
  assert(extension, 'extension not loaded');
  assert.equal(extension.packageJSON.version, process.env.SYSOM_EXPECTED_VERSION);
  assert.equal(extension.packageJSON.version, version);
  assert.equal(fs.realpathSync(extension.extensionPath), fs.realpathSync(process.env.SYSOM_EXTENSION_PATH));
  assert.deepEqual(extension.packageJSON.contributes.commands.map((command) => command.command).sort(), ['sysagent.inspect', 'sysagent.openHome']);
  if (rootUnavailableOnly) return runUnavailable(extension, checks, record);
  const api = await extension.activate();
  assert(extension.isActive && typeof api.inspect === 'function');
  const commands = await vscode.commands.getCommands(true);
  for (const id of ['sysagent.openHome', 'sysagent.inspect']) assert(commands.includes(id), id);
  for (const id of ['sysagent.alertDemo', 'sysagent.resetDemo']) assert(!commands.includes(id), id);
  await waitFor(() => api.inspect().mode === 'collected' && !api.inspect().statusText.includes('spin'), 'actual collection/status');
  collectorEvidence(api.inspect(), 'resources');
  assert(!api.inspect().panelOpen);
  record(`cached VS Code ${vscode.version} activates the actual extension, registers only home/inspect and displays collected status`);

  await vscode.commands.executeCommand('sysagent.openHome');
  await waitFor(() => api.inspect().panelOpen, 'panel open');
  await waitFor(() => api.inspect().webviewCalls >= 2, 'real bridge RPC');
  const calls = api.inspect().webviewCalls;
  await waitFor(() => api.inspect().webviewCalls > calls, 'shared client polling');
  fs.writeFileSync(path.join(signals, 'panel-ready'), '');
  await waitFor(() => fs.existsSync(path.join(signals, 'inspected')), 'DevTools shared UI inspection', 120000);
  const home = JSON.parse(fs.readFileSync(path.join(signals, 'webview.json'), 'utf8'));
  assert.equal(home.ok, true, JSON.stringify(home));
  assert.equal(home.mode, 'collected');
  assert.deepEqual(home.errors, []);
  assert(home.bridgeMethods.includes('healthSnapshot') && home.bridgeMethods.includes('executeProcessCleanup'));
  record('strict-CSP webview uses real window.sysomDesktop/shared idc-client, dynamic resource evidence and no Session controls');

  const before = api.inspect();
  await vscode.commands.executeCommand('sysagent.inspect');
  await waitFor(() => api.inspect().revision > before.revision && api.inspect().collector.last_task.operation === 'inspect', 'inspect command actual diagnostics');
  collectorEvidence(api.inspect(), 'inspection');
  assert.notEqual(api.inspect().collector.last_task.id, before.collector.last_task.id);
  fs.writeFileSync(path.join(signals, 'inspection-ready'), '');
  await waitFor(() => fs.existsSync(path.join(signals, 'inspection-inspected')), 'DevTools diagnostic inspection', 120000);
  const inspected = JSON.parse(fs.readFileSync(path.join(signals, 'webview.json'), 'utf8'));
  assert.equal(inspected.ok, true, JSON.stringify(inspected));
  assert.equal(inspected.inspection.operation, 'inspect');
  assert.deepEqual(inspected.inspection.ids, ['root', 'memory', 'fd']);
  assert.deepEqual(inspected.errors, []);
  record('inspect command produces real root/memory/FD evidence, preserving null/unchecked for unavailable FD');

  await vscode.commands.executeCommand('sysagent.openHome');
  assert(api.inspect().panelOpen);
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  await waitFor(() => !api.inspect().panelOpen, 'panel disposed');
  assert.equal(api.inspect().mode, 'collected');
  assert(api.inspect().collector.enabled);
  await vscode.commands.executeCommand('sysagent.inspect');
  await waitFor(() => api.inspect().revision > inspected.inspection.revision, 'inspection with closed panel');
  collectorEvidence(api.inspect(), 'inspection');
  assert(!api.inspect().panelOpen);
  record('closing editors disposes the panel while collected status and independent inspect command continue working');
  fs.writeFileSync(path.join(signals, 'checks.json'), JSON.stringify(checks));
}

module.exports = { run };
