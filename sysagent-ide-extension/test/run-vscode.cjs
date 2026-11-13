const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const rootUnavailableOnly = process.env.SYSOM_ROOT_UNAVAILABLE_ONLY === '1';
const puppeteer = require(require.resolve('puppeteer-core', { paths: [path.resolve(__dirname, '../../sysagent-analysis')] }));

const root = path.resolve(__dirname, '..');
const extensionPath = process.env.SYSOM_EXTENSION_PATH ? path.resolve(process.env.SYSOM_EXTENSION_PATH) : root;
const { version } = JSON.parse(fs.readFileSync(path.join(root, '../package.json'), 'utf8'));
const packageManifest = JSON.parse(fs.readFileSync(path.join(extensionPath, 'package.json'), 'utf8'));
assert.equal(packageManifest.version, version);
assert.deepEqual(packageManifest.contributes.commands.map((command) => command.command).sort(), ['sysagent.inspect', 'sysagent.openHome']);
function verifyManifest() {
  const bundle = path.join(extensionPath, 'dist', 'sysak');
  const manifest = JSON.parse(fs.readFileSync(path.join(bundle, 'manifest.json'), 'utf8'));
  assert.equal(manifest.schema_version, '1.0');
  assert.equal(manifest.platform, 'linux');
  assert.equal(manifest.arch, process.arch);
  assert(manifest.commands.includes('idc') && manifest.files.sysak);
  for (const [relative, digest] of Object.entries(manifest.files)) {
    const file = path.resolve(bundle, relative);
    assert(file.startsWith(path.resolve(bundle) + path.sep), `manifest asset outside bundle: ${relative}`);
    assert(fs.realpathSync(file).startsWith(fs.realpathSync(bundle) + path.sep), `manifest symlink outside bundle: ${relative}`);
    assert.match(digest, /^[a-f0-9]{64}$/);
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'), digest, relative);
  }
  fs.accessSync(path.join(bundle, 'sysak'), fs.constants.X_OK);
  return { files: Object.keys(manifest.files).length, commands: manifest.commands };
}
const bundleManifest = rootUnavailableOnly ? verifyManifest() : undefined;
const cache = path.join(root, '.vscode-test');
const vscodeExecutablePath = path.join(cache, 'vscode-linux-x64-1.145.2', 'code');
fs.accessSync(vscodeExecutablePath, fs.constants.X_OK);
let stopping = false;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(check, label, timeout = 120000) {
  const end = Date.now() + timeout;
  for (;;) {
    if (stopping) throw new Error(`VS Code acceptance stopped: ${label}`);
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timeout: ${label}`);
    await sleep(200);
  }
}
async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
const rpcNames = ['healthSnapshot', 'healthReset', 'healthOperation', 'prepareProcessCleanup', 'executeProcessCleanup', 'collectorStatus', 'setCollectorEnabled', 'setInspectionInterval'];
function unwrap(reply) {
  assert.equal(reply.ok, true, JSON.stringify(reply));
  assert(Object.hasOwn(reply, 'data'));
  return reply.data;
}
function expectedScore(state) {
  const important = state.inspections.filter((item) => item.important);
  const others = state.inspections.filter((item) => !item.important);
  const ids = ['cpu', 'energy', 'memory', 'disk', ...(state.hasGpu ? ['gpu'] : [])];
  const measured = ids.map((id) => state.resources[id].status === 'unavailable' ? null : state.resources[id].usage).filter((value) => value !== null && Number.isFinite(value));
  const x = important.filter((item) => item.status !== 'unchecked' && item.usage !== null && item.usage > 90).length;
  const y = others.filter((item) => item.status === 'abnormal').length + measured.filter((value) => value > 90).length;
  return Number(Math.max(0, Math.min(100, 100 - x * (important.length ? 80 / important.length : 0) - y * (others.length + measured.length ? 20 / (others.length + measured.length) : 0))).toFixed(1));
}

function failure(reply, code = 'ROOT_COLLECTOR_UNAVAILABLE', status = 503) {
  assert.equal(reply.ok, false, JSON.stringify(reply));
  assert.equal(reply.error.code, code);
  assert.equal(reply.error.status, status);
  assert.equal(typeof reply.error.message, 'string');
  assert.equal(typeof reply.error.retryable, 'boolean');
  assert(!Object.hasOwn(reply, 'data'));
}
function unavailableStatus(status) {
  assert.equal(status.installed, false);
  assert.equal(status.mode, 'mock');
  assert.equal(status.phase, 'error');
  assert.equal(status.read_only, true);
  assert.equal(status.error.code, 'ROOT_COLLECTOR_UNAVAILABLE');
  assert.match(status.error.message, /管理员安装并启用.*sysAK IDC 服务.*授权当前用户/);
  assert.equal(status.last_task, null);
  assert.equal(status.next_inspection_at, null);
  assert.equal(status.inspection_interval_minutes, 5);
}
async function unavailableDom(frame) {
  await frame.waitForFunction(() => document.querySelector('.sh-unavailable h1')?.textContent.includes('整体数据暂不可用') && !document.querySelector('.sh-unavailable .hg-button')?.disabled);
  const dom = await frame.evaluate(() => ({
    text: document.querySelector('.sh-unavailable').textContent.trim(),
    resources: document.querySelectorAll('.sh-resource-card, .sh-score-ring, tr[data-row-id], .sh-collected-rankings, .sh-process-confirm, .sh-process-results').length,
    selectable: document.querySelectorAll('input[type="checkbox"]:enabled').length,
    cleanup: [...document.querySelectorAll('button')].filter((button) => !button.disabled && /清理所选进程|确认结束进程/.test(button.textContent)).length,
    sessions: document.querySelectorAll('.sh-agent-sessions, .sh-session-row, .ad-session-id, button[aria-label*="Session"], input[aria-label*="Session"]').length,
    width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth,
  }));
  assert.match(dom.text, /管理员安装并启用.*sysAK IDC 服务.*授权当前用户/);
  for (const key of ['resources', 'selectable', 'cleanup', 'sessions']) assert.equal(dom[key], 0, key);
  assert(dom.scroll <= dom.width, JSON.stringify(dom));
  return dom;
}
let rawId = 1000000;
async function rawRpc(frame, method) {
  const id = ++rawId;
  // Use the cached IDE's actual parent transport; do not replace acquireVsCodeApi or fake a host reply.
  await frame.evaluate((id) => {
    const replies = window.__sysomAcceptanceReplies ||= {};
    const listener = (event) => {
      if (event.data?.type === 'rpc-result' && event.data.id === id) {
        replies[id] = event.data;
        window.removeEventListener('message', listener);
      }
    };
    window.addEventListener('message', listener);
  }, id);
  const shell = frame.parentFrame();
  assert(shell, 'cached VS Code webview parent transport is unavailable');
  const sent = await shell.evaluate((message) => {
    if (typeof window.__vscode_post_message__ !== 'function') return false;
    window.__vscode_post_message__('onmessage', { message, transfer: [] });
    return true;
  }, { type: 'rpc', id, method, args: [] });
  assert(sent, 'cached VS Code parent harness API cannot send unknown RPC; do not substitute ordinary fallback');
  await frame.waitForFunction((id) => !!window.__sysomAcceptanceReplies[id], {}, id);
  const message = await frame.evaluate((id) => { const reply = window.__sysomAcceptanceReplies[id]; delete window.__sysomAcceptanceReplies[id]; return reply; }, id);
  assert.deepEqual(Object.keys(message).sort(), ['id', 'type', 'value']);
  return message.value;
}
async function inspectUnavailable(frame, workbench, info, result, errors, foreignRequests, write, signals, outputDir) {
  const status = unwrap(info.status);
  unavailableStatus(status);
  failure(info.snapshot);
  assert.deepEqual(info.bridgeMethods, rpcNames);
  assert.equal(info.version, `v${version}`);
  assert(info.native);
  assert(info.csp.startsWith("default-src 'none'") && /script-src 'nonce-/.test(info.csp) && !info.csp.includes('unsafe') && !info.csp.includes('connect-src'));
  const dom = await unavailableDom(frame);
  Object.assign(result, { mode: 'root-unavailable', version: info.version, manifest: bundleManifest, status, bridgeMethods: info.bridgeMethods,
    csp: info.csp, nav: info.nav, ...dom, processTargetCreated: false });
  for (const refresh of [false, true]) failure(await frame.evaluate((refresh) => window.sysomDesktop.healthSnapshot(refresh), refresh));
  failure(await frame.evaluate(() => window.sysomDesktop.healthReset({ hasGpu: window.sysomDesktop.gpu })));
  failure(await frame.evaluate(() => window.sysomDesktop.healthOperation({ operation: 'inspect', parameters: {} })));
  // Observe a real host reply after clicking the real retry control.
  await frame.evaluate(() => {
    window.__sysomRetryFailures = 0;
    window.__sysomRetryListener = (event) => {
      if (event.data?.type === 'rpc-result' && event.data.value?.error?.code === 'ROOT_COLLECTOR_UNAVAILABLE') window.__sysomRetryFailures++;
    };
    window.addEventListener('message', window.__sysomRetryListener);
    document.querySelector('.sh-unavailable .hg-button').click();
  });
  await frame.waitForFunction(() => window.__sysomRetryFailures > 0);
  await frame.evaluate(() => window.removeEventListener('message', window.__sysomRetryListener));
  await unavailableDom(frame);
  unavailableStatus(unwrap(await frame.evaluate(() => window.sysomDesktop.collectorStatus())));
  failure(await frame.evaluate(() => window.sysomDesktop.prepareProcessCleanup({ resource: 'memory', ids: [], revision: 1 })));
  failure(await frame.evaluate(() => window.sysomDesktop.executeProcessCleanup({ token: '0'.repeat(64) })));
  await frame.evaluate(() => document.querySelector('.sh-inspection-entry').click());
  await frame.waitForSelector('.sh-inspection-config');
  assert(await frame.$eval('button[aria-label="设置巡检周期"]', (button) => button.disabled && button.textContent.trim() === '5分钟'));
  assert(await frame.$eval('.sh-inspection-toggle', (button) => button.disabled));
  assert.match(await frame.$eval('.sh-inspection-config', (item) => item.textContent), /暂不可用.*暂无巡检/);
  await frame.click('button[aria-label="设置巡检周期"]');
  assert.equal(await frame.$('.sh-interval-form'), null);
  for (let attempt = 0; attempt < 3; attempt++) {
    const contentWidth = await frame.evaluate(() => document.documentElement.clientWidth);
    if (contentWidth === 360) break;
    const hostWidth = await workbench.evaluate(() => innerWidth);
    await workbench.setViewport({ width: hostWidth + 360 - contentWidth, height: 800 });
    await frame.waitForFunction(previous => document.documentElement.clientWidth !== previous, { polling: 100, timeout: 10000 }, contentWidth);
  }
  await frame.waitForFunction(() => document.documentElement.clientWidth === 360, { polling: 100, timeout: 10000 });
  const configSize = await frame.evaluate(() => ({ width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
  assert(configSize.scroll <= configSize.width, JSON.stringify(configSize));
  await frame.evaluate(() => document.querySelector('dialog[open]').dispatchEvent(new Event('cancel', { cancelable: true })));
  await frame.waitForFunction(() => !document.querySelector('dialog[open]'));
  await unavailableDom(frame);
  for (const method of ['constructor', '/api/idc/snapshot', 'extraRPC']) failure(await rawRpc(frame, method), 'INVALID_PARAMETERS', 400);
  for (const operation of ['cleanup', 'optimize', 'sessions-cleanup', 'alert-sample']) {
    failure(await frame.evaluate((operation) => window.sysomDesktop.healthOperation({ operation, parameters: {} }), operation), 'read_only', 409);
  }
  Object.assign(result, { retryFailed: true, unknownRpcRejected: true, periodDisabled: true, prepareExecuteRejected: true });
  await frame.evaluate(() => [...document.querySelectorAll('nav button')].find((button) => button.textContent.includes('Agent 管家')).click());
  await frame.waitForFunction(() => document.querySelector('nav button.active')?.textContent.includes('Agent 管家'));
  const agents = await frame.evaluate(() => ({
    sessions: document.querySelectorAll('.sh-agent-sessions, .sh-session-row, .ad-session-id, button[aria-label*="Session"], input[aria-label*="Session"]').length,
    width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth,
  }));
  assert.equal(agents.sessions, 0); assert(agents.scroll <= agents.width, JSON.stringify(agents));
  await frame.evaluate(() => window.sysomDesktop.openHome());
  await unavailableDom(frame);
  await workbench.screenshot({ path: path.join(outputDir, 'ide-vscode-root-unavailable-360.png') });
  await workbench.setViewport({ width: 1440, height: 960 });
  await unavailableDom(frame);
  await workbench.screenshot({ path: path.join(outputDir, 'ide-vscode-root-unavailable-1440.png') });
  assert.equal(errors.size, 0, [...errors].join('\n'));
  assert.equal(foreignRequests.size, 0, [...foreignRequests].join('\n'));
  Object.assign(result, { ok: true, mode: 'root-unavailable', version: info.version, manifest: bundleManifest, status, bridgeMethods: info.bridgeMethods,
    csp: info.csp, nav: info.nav, ...dom, retryFailed: true, unknownRpcRejected: true, periodDisabled: true, processTargetCreated: false });
  write();
  fs.writeFileSync(path.join(signals, 'inspected'), '');
  await waitFor(() => fs.existsSync(path.join(signals, 'inspection-ready')), 'root-unavailable inspect command');
  failure(await frame.evaluate(() => window.sysomDesktop.healthSnapshot()));
  unavailableStatus(unwrap(await frame.evaluate(() => window.sysomDesktop.collectorStatus())));
  await unavailableDom(frame);
  assert.equal(errors.size, 0, [...errors].join('\n'));
  assert.equal(foreignRequests.size, 0, [...foreignRequests].join('\n'));
  result.inspection = { code: 'ROOT_COLLECTOR_UNAVAILABLE', task: null, snapshotFailed: true };
  write();
  fs.writeFileSync(path.join(signals, 'inspection-inspected'), '');
  return result;
}

async function inspectWebview(signals, outputDir, port, owned, identity) {
  let browser;
  const errors = new Set();
  const expectedResourceErrors = [];
  const foreignRequests = new Set();
  const blockedIdeBackgroundRequests = new Set();
  const attached = new Set();
  let acceptedFrame;
  let acceptedWorkbench;
  const result = { ok: false, errors: [], bridgeMethods: [] };
  const write = () => {
    Object.assign(result, { errors: [...errors], expectedResourceErrors, foreignRequests: [...foreignRequests], blockedIdeBackgroundRequests: [...blockedIdeBackgroundRequests] });
    fs.writeFileSync(path.join(signals, 'webview.json'), JSON.stringify(result, null, 2));
  };
  const consoleError = (text) => {
    if (rootUnavailableOnly && /^Failed to load resource: the server responded with a status of 503\b/.test(text)) expectedResourceErrors.push(text);
    else errors.add(text);
  };
  try {
    await waitFor(async () => {
      try { return (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) })).ok; }
      catch { return false; }
    }, 'cached VS Code DevTools endpoint');
    browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}`, defaultViewport: null });
    async function attach(target) {
      if (attached.has(target) || !['page', 'other'].includes(target.type())) return;
      attached.add(target);
      try {
        const session = await target.createCDPSession();
        const contexts = new Set();
        session.on('Runtime.executionContextCreated', ({ context }) => { if (/vscode-webview/.test(context.origin)) contexts.add(context.id); });
        session.on('Runtime.consoleAPICalled', (event) => {
          if (event.type !== 'error') return;
          const frames = event.stackTrace?.callFrames || [];
          if (contexts.has(event.executionContextId) || frames.some((frame) => /webview\.js/.test(frame.url))) consoleError(event.args.map((arg) => arg.value ?? arg.description ?? '').join(' '));
        });
        session.on('Runtime.exceptionThrown', ({ exceptionDetails: detail }) => {
          if (contexts.has(detail.executionContextId) || /webview\.js/.test(detail.url || '') || detail.stackTrace?.callFrames.some((frame) => /webview\.js/.test(frame.url))) errors.add(detail.exception?.description || detail.text);
        });
        await session.send('Runtime.enable');
        const targetInfo = rootUnavailableOnly ? (await session.send('Target.getTargetInfo')).targetInfo : undefined;
        if (rootUnavailableOnly && ['page', 'iframe', 'webview'].includes(targetInfo.type)) {
          const webviewFrames = new Set();
          const noteFrame = (frame) => { if (/vscode-webview:/.test(frame.url)) webviewFrames.add(frame.id); };
          session.on('Page.frameNavigated', ({ frame }) => noteFrame(frame));
          await session.send('Page.enable');
          const tree = await session.send('Page.getFrameTree');
          const noteTree = (tree) => { noteFrame(tree.frame); (tree.childFrames || []).forEach(noteTree); };
          noteTree(tree.frameTree);
          const externalOrigin = (address) => {
            if (!/^https?:/.test(address)) return undefined;
            const url = new URL(address);
            // vscode-resource HTTPS authorities are the IDE's local-resource service-worker transport, not external hosts.
            if (['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.hostname.endsWith('.vscode-resource.vscode-cdn.net')) return undefined;
            return url.origin;
          };
          session.on('Network.requestWillBeSent', (event) => {
            const origin = externalOrigin(event.request.url);
            if (!origin) return;
            const fromWebview = webviewFrames.has(event.frameId) || event.initiator?.stack?.callFrames?.some((frame) => /webview\.js|vscode-webview:/.test(frame.url));
            (fromWebview ? foreignRequests : blockedIdeBackgroundRequests).add(origin);
          });
          // Stop all external Chromium requests, including the isolated IDE's unrelated gallery/CDN background probes.
          session.on('Fetch.requestPaused', (event) => {
            const origin = externalOrigin(event.request.url);
            if (origin) (webviewFrames.has(event.frameId) ? foreignRequests : blockedIdeBackgroundRequests).add(origin);
            session.send(origin ? 'Fetch.failRequest' : 'Fetch.continueRequest', origin ? { requestId: event.requestId, errorReason: 'BlockedByClient' } : { requestId: event.requestId }).catch((error) => { if (!stopping && !/closed|detached/i.test(error.message)) errors.add(error.message); });
          });
          await session.send('Fetch.enable', { patterns: [{ urlPattern: 'http://*' }, { urlPattern: 'https://*' }] });
          session.on('Log.entryAdded', ({ entry }) => {
            if (entry.level === 'error' && (/vscode-webview|vscode-resource/.test(entry.url || '') || /webview\.js/.test(entry.stackTrace?.callFrames?.map((item) => item.url).join(' ') || ''))) consoleError(entry.text);
          });
          await session.send('Network.enable');
          await session.send('Log.enable');
        }
      } catch (error) {
        if (!stopping && !/closed|detached/i.test(error.message)) throw error;
      }
    }
    browser.on('targetcreated', (target) => { attach(target).catch((error) => errors.add(error.message)); });
    await Promise.all(browser.targets().map(attach));
    await waitFor(() => fs.existsSync(path.join(signals, 'panel-ready')), 'extension panel-ready');
    let workbench;
    const frame = await waitFor(async () => {
      for (const candidate of await browser.pages()) {
        for (const child of candidate.frames()) {
          const found = await child.evaluate((unavailable) => !!window.sysomDesktop?.healthSnapshot && !!document.querySelector(unavailable ? '.sh-unavailable' : '.sh-resource-card'), rootUnavailableOnly).catch(() => false);
          if (found) { workbench = candidate; return child; }
        }
      }
      return false;
    }, 'actual shared UI in VS Code webview frames');
    acceptedFrame = frame;
    acceptedWorkbench = workbench;
    const info = await frame.evaluate(async (names) => ({
      snapshot: await window.sysomDesktop.healthSnapshot(), status: await window.sysomDesktop.collectorStatus(),
      bridgeMethods: names.filter((name) => typeof window.sysomDesktop[name] === 'function'),
      csp: document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content,
      version: document.querySelector('.sidebar-footer span:last-child')?.textContent,
      native: document.documentElement.classList.contains('native-main'),
      nav: [...document.querySelectorAll('nav button')].map((button) => button.textContent.trim()),
    }), rpcNames);
    if (rootUnavailableOnly) return await inspectUnavailable(frame, workbench, info, result, errors, foreignRequests, write, signals, outputDir);
    const state = unwrap(info.snapshot);
    const status = unwrap(info.status);
    assert.equal(state.mode, 'collected');
    assert(status.installed && status.enabled && status.read_only && status.last_task.raw_bytes > 0);
    assert.equal(status.last_task.simulated, false);
    assert.equal(status.inspection_interval_minutes, 5);
    assert.deepEqual(info.bridgeMethods, rpcNames);
    assert.equal(info.version, `v${version}`);
    assert(info.native);
    assert(info.csp.startsWith("default-src 'none'") && /script-src 'nonce-/.test(info.csp) && !info.csp.includes('unsafe'));
    const visibleIds = ['cpu', 'energy', 'memory', 'disk', ...(state.hasGpu ? ['gpu'] : [])];
    await frame.waitForFunction((revision) => [...document.querySelectorAll('.sh-resource-card')].every((card) => Number(card.dataset.version) === revision), {}, state.revision);
    const dom = await frame.evaluate(() => ({
      score: parseFloat(document.querySelector('.sh-score-ring strong').textContent),
      resources: [...document.querySelectorAll('.sh-resource-card')].map((card) => ({ id: card.dataset.resource, value: card.querySelector('.sh-resource-value').getAttribute('aria-label') })),
      sessions: document.querySelectorAll('.sh-agent-sessions, .sh-session-row, .ad-session-id, button[aria-label*="Session"], input[aria-label*="Session"]').length,
      width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth,
    }));
    assert.deepEqual(dom.resources.map((item) => item.id), visibleIds);
    assert.equal(dom.score, expectedScore(state));
    assert.equal(dom.sessions, 0);
    assert(dom.scroll <= dom.width);
    for (const { id, value } of dom.resources) {
      const resource = state.resources[id];
      assert.equal(resource.source, 'sysak');
      const formatted = resource.status === 'unavailable' ? '不可用' : resource.usage !== null ? `${Number(resource.usage.toFixed(1))}%` : resource.quantity?.unit === 'W' ? `${Number(resource.quantity.value.toFixed(1))} W` : '不可用';
      assert.equal(value, `${resource.label} ${formatted}`);
    }
    for (const operation of ['cleanup', 'sessions-cleanup', 'alert-sample']) {
      const reply = await frame.evaluate((operation) => window.sysomDesktop.healthOperation({ operation, parameters: {} }), operation);
      assert.equal(reply.ok, false);
      assert.equal(reply.error.code, 'read_only');
      assert.equal(reply.error.status, 409);
      assert.equal(typeof reply.error.retryable, 'boolean');
    }
    await frame.evaluate(() => [...document.querySelectorAll('nav button')].find((button) => button.textContent.includes('Agent 管家')).click());
    await frame.waitForFunction(() => document.querySelector('nav button.active')?.textContent.includes('Agent 管家'));
    assert.equal(await frame.evaluate(() => document.querySelectorAll('.sh-agent-sessions, .sh-session-row, .ad-session-id, button[aria-label*="Session"], input[aria-label*="Session"]').length), 0);
    await frame.evaluate(() => window.sysomDesktop.openHome());
    await frame.waitForSelector('.sh-resource-card');
    const targetId = `process-${identity.pid}-${identity.starttime}`;
    const targetRow = state.resources.memory.rows.find((row) => row.id === targetId);
    assert(targetRow?.cleanable && targetRow.agentKind === 'WorkBuddy', 'owned sibling fixture must be eligible');
    await frame.click(`button[aria-label="查看${state.resources.memory.label}详情"]`);
    await frame.waitForSelector('.sh-collected-rankings');
    await frame.evaluate(() => [...document.querySelectorAll('.sh-rank-filter button')].find((button) => button.textContent.includes('只看 Agent')).click());
    const selector = `dialog[open] tr[data-row-id="${targetId}"] input`;
    await frame.waitForSelector(selector);
    await frame.click(selector);
    await frame.evaluate(() => [...document.querySelectorAll('dialog[open] button')].find((button) => button.textContent.includes('清理所选进程（1）')).click());
    await frame.waitForSelector('.sh-process-confirm');
    await frame.evaluate(() => [...document.querySelectorAll('.sh-process-confirm button')].find((button) => button.textContent.trim() === '取消').click());
    await frame.waitForFunction(() => !document.querySelector('.sh-process-confirm'));
    assert.equal(owned.exitCode, null); assert.equal(owned.signalCode, null);
    const plan = unwrap(await frame.evaluate((payload) => window.sysomDesktop.prepareProcessCleanup(payload), { resource: 'memory', ids: [targetId], revision: state.revision }));
    assert.deepEqual(plan.processes.map(({ pid, starttime }) => ({ pid, starttime })), [identity]);
    unwrap(await frame.evaluate(() => window.sysomDesktop.healthSnapshot(true)));
    const stale = await frame.evaluate((token) => window.sysomDesktop.executeProcessCleanup({ token }), plan.token);
    assert.equal(stale.ok, false); assert.equal(stale.error.code, 'INVALID_CLEANUP_PLAN');
    await frame.evaluate(() => document.querySelector('dialog[open]').dispatchEvent(new Event('cancel', { cancelable: true })));
    await frame.waitForFunction(() => !document.querySelector('dialog[open]'));
    const current = unwrap(await frame.evaluate(() => window.sysomDesktop.healthSnapshot()));
    await frame.waitForFunction((revision) => Number(document.querySelector('.sh-resource-card')?.dataset.version) === revision, {}, current.revision);
    await frame.click(`button[aria-label="查看${current.resources.memory.label}详情"]`);
    await frame.waitForSelector('.sh-collected-rankings');
    await frame.evaluate(() => [...document.querySelectorAll('.sh-rank-filter button')].find((button) => button.textContent.includes('只看 Agent')).click());
    await frame.waitForSelector(selector); await frame.click(selector);
    await frame.evaluate(() => [...document.querySelectorAll('dialog[open] button')].find((button) => button.textContent.includes('清理所选进程（1）')).click());
    await frame.waitForSelector('.sh-process-confirm');
    assert.equal(owned.exitCode, null); assert.equal(owned.signalCode, null);
    await frame.evaluate(() => [...document.querySelectorAll('.sh-process-confirm button')].find((button) => button.textContent.trim() === '确认结束进程').click());
    await waitFor(() => owned.exitCode !== null || owned.signalCode !== null, 'owned sibling SIGTERM');
    assert.equal(owned.exitCode, 0);
    await frame.waitForFunction(() => document.querySelector('.sh-process-results')?.textContent.includes('已发送 SIGTERM') && document.querySelector('.sh-operation-success')?.textContent.includes('已刷新快照'));
    const after = unwrap(await frame.evaluate(() => window.sysomDesktop.healthSnapshot()));
    assert(!after.resources.memory.rows.some((row) => row.id === targetId));
    assert(after.operations.some((operation) => operation.kind === 'cleanup'));
    await frame.evaluate(() => document.querySelector('dialog[open]').dispatchEvent(new Event('cancel', { cancelable: true })));
    await frame.waitForFunction(() => !document.querySelector('dialog[open]'));
    assert.equal(errors.size, 0, [...errors].join('\n'));
    Object.assign(result, { ok: true, mode: state.mode, bridgeMethods: info.bridgeMethods, csp: info.csp, nav: info.nav, version: info.version, ...dom,
      processControl: { uiCancel: true, staleRejected: true, ownedOnly: true, signal: 'SIGTERM', exit: owned.exitCode, refreshed: true } });
    await workbench.screenshot({ path: path.join(outputDir, 'ide-vscode-real.png') });
    write();
    fs.writeFileSync(path.join(signals, 'inspected'), '');

    await waitFor(() => fs.existsSync(path.join(signals, 'inspection-ready')), 'actual inspect command');
    const inspectionState = unwrap(await frame.evaluate(() => window.sysomDesktop.healthSnapshot()));
    const inspectionStatus = unwrap(await frame.evaluate(() => window.sysomDesktop.collectorStatus()));
    assert.equal(inspectionStatus.last_task.operation, 'inspect');
    assert.equal(inspectionStatus.last_task.profile, 'inspection');
    assert.equal(inspectionStatus.last_task.simulated, false);
    const diagnostics = ['root', 'memory', 'fd'].map((id) => inspectionState.inspections.find((item) => item.id === id));
    for (const item of diagnostics) {
      assert(item && item.evidence.some((entry) => entry.includes('sysAK')));
      assert.equal(item.status, item.usage === null ? 'unchecked' : item.usage > 90 ? 'abnormal' : 'normal');
      if (item.id === 'fd') {
        if (!item.execution || item.execution === 'unavailable' || (item.execution === 'partial' && item.status !== 'abnormal')) {
          assert.equal(item.usage, null); assert.equal(item.status, 'unchecked');
        }
        if (item.status === 'normal') assert.equal(item.execution, 'complete');
        assert.match(item.detail, /FD 压力快照，不是泄漏趋势检查/);
      }
    }
    await frame.waitForFunction((revision) => Number(document.querySelector('.sh-resource-card')?.dataset.version) === revision, {}, inspectionState.revision);
    await frame.evaluate(() => document.querySelector('.sh-inspection-entry').click());
    await frame.waitForSelector('dialog[open] [data-inspection="fd"]');
    const fdResult = await frame.$eval('[data-inspection="fd"]', (item) => item.querySelector('.sh-inspection-result').textContent);
    if (diagnostics[2].status === 'unchecked') assert(!fdResult.includes('正常'));
    await frame.evaluate(() => document.querySelector('dialog[open]').dispatchEvent(new Event('cancel', { cancelable: true })));
    await frame.waitForFunction(() => !document.querySelector('dialog[open]'));
    assert.equal(errors.size, 0, [...errors].join('\n'));
    result.inspection = { operation: inspectionStatus.last_task.operation, revision: inspectionState.revision, ids: diagnostics.map((item) => item.id), diagnostics };
    write();
    fs.writeFileSync(path.join(signals, 'inspection-inspected'), '');
    return result;
  } catch (error) {
    result.ok = false;
    result.failure = error.stack || error.message;
    if (rootUnavailableOnly) {
      result.processTargetCreated = false;
      result.outputDir = outputDir;
      if (acceptedFrame) result.sessionEvidence = await Promise.resolve().then(() => acceptedFrame.$$eval('.sh-agent-sessions, .sh-session-row, .ad-session-id, button[aria-label*="Session"], input[aria-label*="Session"]', (items) => items.map((item) => ({ tag: item.tagName, class: item.className, text: item.textContent.trim().slice(0, 160) })))).catch(() => []);
      if (acceptedWorkbench) await acceptedWorkbench.screenshot({ path: path.join(outputDir, 'ide-vscode-root-unavailable-failure.png') }).catch(() => undefined);
      fs.writeFileSync(path.join(outputDir, 'ide-vscode-root-unavailable.json'), JSON.stringify({ ...result, errors: [...errors], expectedResourceErrors, foreignRequests: [...foreignRequests], blockedIdeBackgroundRequests: [...blockedIdeBackgroundRequests] }, null, 2));
    }
    write();
    fs.writeFileSync(path.join(signals, 'inspected'), '');
    fs.writeFileSync(path.join(signals, 'inspection-inspected'), '');
    throw error;
  } finally { if (browser) browser.disconnect(); }
}

(async () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sysom-vscode-1.145.2-'));
  const signals = path.join(runDir, 'signals');
  const userData = path.join(runDir, 'user-data');
  const extensions = path.join(runDir, 'extensions');
  for (const directory of [signals, userData, extensions]) fs.mkdirSync(directory);
  const outputBase = path.resolve(root, '../sysagent-analysis/tests/output');
  fs.mkdirSync(outputBase, { recursive: true });
  const outputDir = fs.mkdtempSync(path.join(outputBase, rootUnavailableOnly ? `ide-vscode-v${version}-root-unavailable-` : 'ide-vscode-real-'));
  const port = await reservePort();
  const owned = rootUnavailableOnly ? undefined : spawn('/usr/bin/python3', ['-u', '-c', [
    'import ctypes, json, os, signal, sys, time',
    'assert ctypes.CDLL(None).prctl(15, b"workbuddy", 0, 0, 0) == 0',
    'memory = bytearray(512 * 1024 * 1024)',
    'fds = [os.open("/dev/null", os.O_RDONLY) for _ in range(80)]',
    'signal.signal(signal.SIGTERM, lambda *args: sys.exit(0))',
    'stat = open("/proc/self/stat").read()',
    'print(json.dumps({"pid": os.getpid(), "starttime": int(stat[stat.rfind(")") + 2:].split()[19])}), flush=True)',
    'time.sleep(600)',
  ].join('\n')], { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  const ownedExit = owned ? new Promise((resolve) => owned.once('close', resolve)) : Promise.resolve();
  const ready = owned ? new Promise((resolve, reject) => {
    owned.once('error', reject);
    owned.stdout.once('data', (data) => { try { resolve(JSON.parse(data.toString())); } catch (error) { reject(error); } });
  }) : Promise.resolve(undefined);
  const logPath = path.join(outputDir, 'ide-vscode-root-unavailable.log');
  const logFd = rootUnavailableOnly ? fs.openSync(logPath, 'w') : undefined;
  if (rootUnavailableOnly) console.log(`VS Code root-unavailable evidence: ${outputDir}`);
  const child = spawn(vscodeExecutablePath, [
    `--user-data-dir=${userData}`, `--extensions-dir=${extensions}`,
    `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1',
    `--extensionDevelopmentPath=${extensionPath}`, `--extensionTestsPath=${path.join(__dirname, 'vscode-suite.cjs')}`,
    '--disable-extensions', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes',
    ...(rootUnavailableOnly ? ['--disable-updates', '--disable-telemetry', '--disable-background-networking', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1'] : []),
  ], { shell: false, stdio: rootUnavailableOnly ? ['ignore', logFd, logFd] : 'inherit', env: { ...process.env, SYSOM_SIGNALS: signals, SYSOM_EXPECTED_VERSION: version, SYSOM_EXTENSION_PATH: extensionPath } });
  let closed = false;
  const exited = new Promise((resolve) => child.once('close', (code, signal) => { closed = true; resolve({ code, signal }); }));
  const launched = new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  let webview;
  const timeout = setTimeout(() => { stopping = true; if (!closed) child.kill('SIGTERM'); }, 360000);
  try {
    await launched;
    const identity = await ready;
    if (owned) assert.equal(identity.pid, owned.pid);
    webview = inspectWebview(signals, outputDir, port, owned, identity);
    const vscode = exited.then(({ code, signal }) => { assert.equal(code, 0, `cached VS Code exited: ${code ?? signal}`); });
    const [, dom] = await Promise.all([vscode, webview]);
    assert(fs.existsSync(path.join(signals, 'checks.json')));
    console.log(JSON.stringify({ vscode: vscodeExecutablePath, extensionPath, runDir, outputDir, checks: JSON.parse(fs.readFileSync(path.join(signals, 'checks.json'), 'utf8')), webview: dom }));
  } finally {
    clearTimeout(timeout);
    stopping = true;
    if (!closed && child.pid) {
      child.kill('SIGTERM');
      await exited;
    }
    if (owned && owned.exitCode === null && owned.signalCode === null) owned.kill('SIGTERM');
    await ownedExit;
    if (webview) await webview.catch(() => undefined);
    if (logFd !== undefined) fs.closeSync(logFd);
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
