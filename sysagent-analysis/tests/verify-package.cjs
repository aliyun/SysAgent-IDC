const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const puppeteer = require('puppeteer-core');
const { acceptance, noGpuAcceptance, clickText } = require('./acceptance.cjs');
const { connectMainInspector, nativeDesktopAcceptance } = require('./native-desktop.cjs');
const version = require('../../sysagent-idc/package.json').version;
const outputDir = path.join(__dirname, 'output');
fs.mkdirSync(outputDir, { recursive: true });

const gpuProcessFailure = /Exiting GPU process due to errors during initialization/;
const rootUnavailable = process.argv.slice(2).includes('--unavailable');
const [executable, ...electronArgs] = process.argv.slice(2).filter(arg => arg !== '--unavailable');
const sandbox = '/opt/google/chrome/chrome-sandbox';
assert(executable, 'Usage: node verify-package.cjs <executable> [--unavailable] [Electron arguments]');
assert(typeof process.getuid === 'function' && process.getuid() !== 0, 'Run as an ordinary user, not root');
if (rootUnavailable) assert(!fs.existsSync('/run/sysom-idc/idc.sock'), 'Unavailable acceptance requires an absent IDC socket; isolate the test first');
assert(!electronArgs.some(arg => /^--(?:no-sandbox|disable-setuid-sandbox|user-data-dir)(?:=|$)/.test(arg)),
  'Sandbox bypasses and user-data-dir overrides are not allowed');

function localRequest(url) {
  const parsed = new URL(url);
  if (['about:', 'data:', 'blob:', 'file:'].includes(parsed.protocol)) return true;
  if (parsed.protocol === 'sysom:') return parsed.hostname === 'app';
  return ['http:', 'https:', 'ws:', 'wss:'].includes(parsed.protocol) &&
    /^(?:localhost|\[::1\]|127\.\d+\.\d+\.\d+)$/.test(parsed.hostname);
}

async function bounded(promise, milliseconds, label) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out`)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

function waitForExit(app, milliseconds) {
  const child = app.child;
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise(resolve => {
    const done = (exited) => { clearTimeout(timer); child.removeListener('exit', onExit); resolve(exited); };
    const onExit = () => done(true);
    const timer = setTimeout(() => done(false), milliseconds);
    child.once('exit', onExit);
  });
}

async function launch(gpu) {
  const app = { userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'sysom-package-')), output: '', errors: [], foreignRequests: [] };
  try {
    const child = app.child = spawn(executable, ['--remote-debugging-port=0', '--inspect=0',
      ...electronArgs, `--user-data-dir=${app.userDataDir}`], {
      env: { ...process.env, DISPLAY: process.env.DISPLAY || ':1', SYSOM_GPU: gpu, CHROME_DEVEL_SANDBOX: sandbox },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const endpoint = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Launch timed out: ${app.output}`)), 30000);
      const onData = (data) => {
        app.output += data.toString();
        const match = app.output.match(/DevTools listening on (ws:\/\/[^\s]+)/);
        if (match) {
          clearTimeout(timeout);
          resolve(match[1]);
        }
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      child.once('error', (error) => { clearTimeout(timeout); reject(error); });
      child.once('exit', (code, signal) => {
        clearTimeout(timeout);
        reject(new Error(`App exited before test (${code}, ${signal}): ${app.output}`));
      });
    });
    app.browser = await puppeteer.connect({ browserWSEndpoint: endpoint, defaultViewport: null });
    const monitored = new WeakSet();
    const monitor = (candidate) => {
      if (!candidate || monitored.has(candidate)) return;
      monitored.add(candidate);
      candidate.on('pageerror', (error) => app.errors.push(error.message));
      candidate.on('console', (message) => { if (message.type() === 'error') app.errors.push(message.text()); });
      candidate.on('requestfailed', (request) => app.errors.push(`${request.url()}: ${request.failure()?.errorText}`));
      candidate.on('request', (request) => { if (!localRequest(request.url())) app.foreignRequests.push(request.url()); });
    };
    app.browser.on('targetcreated', (target) => {
      if (target.type() === 'page') target.page().then(monitor).catch(error => app.errors.push(error.message));
    });
    for (const candidate of await app.browser.pages()) monitor(candidate);
    await app.browser.waitForTarget((target) => target.type() === 'page' && target.url().startsWith('sysom://app/'));
    for (const candidate of await app.browser.pages()) {
      monitor(candidate);
      if (!candidate.url().startsWith('sysom://app/')) continue;
      await candidate.waitForFunction(() => window.sysomDesktop);
      assert.equal(await candidate.evaluate(() => window.sysomDesktop.isElectron), true);
      if (await candidate.evaluate(() => window.sysomDesktop.isFloating)) app.pet = candidate;
      else app.page = candidate;
    }
    assert(app.page && app.pet);
    await app.page.waitForSelector(rootUnavailable ? '.sh-unavailable' : '.sh-resource-card');
    assert.equal(await app.page.evaluate(() => window.sysomDesktop.gpu), gpu === '1');
    assert.equal(await app.pet.evaluate(() => window.sysomDesktop.gpu), gpu === '1');
    if (rootUnavailable) unavailableStatus(await app.page.evaluate(() => window.sysomDesktop.collectorStatus()));
    return app;
  } catch (error) {
    await cleanup(app);
    throw error;
  }
}

async function quit(app) {
  const exited = waitForExit(app, 10000);
  await bounded(app.page.evaluate(() => { window.sysomDesktop.close(); }), 5000, 'Quit request').catch((error) => {
    if (error.name !== 'TargetCloseError') throw error;
  });
  assert(await exited, `App did not exit: ${app.output}`);
  assert.equal(app.child.exitCode, 0);
  assert(!gpuProcessFailure.test(app.output), app.output);
}

async function cleanup(app) {
  if (!app) return;
  if (app.inspector) { app.inspector.close(); app.inspector = null; }
  if (app.browser) {
    await bounded(Promise.resolve(app.browser.disconnect()), 3000, 'Browser disconnect').catch(() => {});
    app.browser = null;
  }
  // Never signal a process group or production PID: only the Electron child created by this launch.
  if (app.child?.pid && app.child.exitCode === null && app.child.signalCode === null) {
    app.child.kill('SIGTERM');
    if (!await waitForExit(app, 5000)) {
      app.child.kill('SIGKILL');
      assert(await waitForExit(app, 5000), `Owned Electron child ${app.child.pid} did not exit`);
    }
  }
  if (app.userDataDir) {
    fs.rmSync(app.userDataDir, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
    app.userDataDir = null;
  }
}

function unavailableStatus(reply) {
  assert.equal(reply.ok, true, JSON.stringify(reply));
  const status = reply.data;
  assert.equal(status.installed, false);
  assert.equal(status.phase, 'error');
  assert.equal(status.read_only, true);
  assert.equal(status.error.code, 'ROOT_COLLECTOR_UNAVAILABLE');
  assert.match(status.error.message, /管理员安装并启用.*sysAK IDC 服务.*授权当前用户/);
  assert.match(status.error.message, /不以普通用户回退执行/);
  assert.equal(status.last_task, null);
  assert.equal(status.next_inspection_at, null);
  assert.equal(status.inspection_interval_minutes, 5);
  return status;
}

function unavailableFailure(reply, method) {
  assert.equal(reply.ok, false, `${method}: ${JSON.stringify(reply)}`);
  assert.equal(reply.error.code, 'ROOT_COLLECTOR_UNAVAILABLE', method);
  assert.equal(reply.error.status, 503, method);
  assert.match(reply.error.message, /管理员安装并启用.*sysAK IDC 服务.*授权当前用户/);
  assert.equal(typeof reply.error.retryable, 'boolean');
  assert(!Object.hasOwn(reply, 'data'), `${method} must not return fallback data or a cleanup plan`);
}

async function unavailableDom(page) {
  await page.waitForFunction(() => document.querySelector('.sh-unavailable h1')?.textContent === '整体数据暂不可用' &&
    document.querySelector('.sh-unavailable .hg-button')?.disabled === false);
  const dom = await page.evaluate(() => ({
    text: document.querySelector('.sh-unavailable').textContent.trim(),
    resources: document.querySelectorAll('.sh-resource-card, .sh-score-ring, tr[data-row-id], .sh-collected-rankings, .sh-process-confirm, .sh-process-results').length,
    selectable: document.querySelectorAll('input[type="checkbox"]:enabled').length,
    cleanup: [...document.querySelectorAll('button')].filter(button => !button.disabled && /清理所选进程|确认结束进程/.test(button.textContent)).length,
    sessions: document.querySelectorAll('.sh-agent-sessions, .sh-session-row, .ad-session-id, button[aria-label*="Session"], input[aria-label*="Session"]').length,
    badge: document.querySelector('nav button.active')?.textContent.replace(/\s+/g, ''),
  }));
  assert.match(dom.text, /管理员安装并启用.*sysAK IDC 服务.*授权当前用户/);
  assert.match(dom.text, /不以普通用户回退执行/);
  for (const key of ['resources', 'selectable', 'cleanup', 'sessions']) assert.equal(dom[key], 0, key);
  assert(dom.badge.startsWith('体检首页'));
  return dom;
}

async function unavailableAcceptance(page, outputDir, name) {
  const result = { name, mode: 'root-unavailable', gpu: await page.evaluate(() => window.sysomDesktop.gpu), checks: [], processTargetCreated: false };
  const record = (check) => { result.checks.push(check); console.log(`PASS ${name}: ${check}`); };
  result.status = unavailableStatus(await page.evaluate(() => window.sysomDesktop.collectorStatus()));
  result.dom = await unavailableDom(page);
  assert.equal(await page.evaluate(() => window.sysomDesktop.isElectron), true);
  record('real Electron bridge reports installed=false, error/ROOT_COLLECTOR_UNAVAILABLE; service installation/authorization text and no score/resources/processes/Session');

  // Empty identities and invalid tokens cannot authorize a real process action.
  for (const refresh of [false, true]) {
    unavailableFailure(await page.evaluate(refresh => window.sysomDesktop.healthSnapshot(refresh), refresh), `healthSnapshot(${refresh})`);
  }
  unavailableFailure(await page.evaluate(() => window.sysomDesktop.healthReset({ hasGpu: window.sysomDesktop.gpu })), 'healthReset');
  unavailableFailure(await page.evaluate(() => window.sysomDesktop.healthOperation({ operation: 'inspect', parameters: {} })), 'healthOperation(inspect)');
  unavailableFailure(await page.evaluate(() => window.sysomDesktop.prepareProcessCleanup({ resource: 'memory', ids: [], revision: 1 })), 'prepareProcessCleanup');
  unavailableStatus(await page.evaluate(() => window.sysomDesktop.collectorStatus()));
  unavailableFailure(await page.evaluate(() => window.sysomDesktop.executeProcessCleanup({ token: '0'.repeat(64) })), 'executeProcessCleanup');
  record('snapshot, refresh, reset, inspect and empty-target prepare/invalid-token execute all reject without ordinary-user fallback');

  // Observe the real retry button entering/leaving busy state, without replacing the bridge or fabricating replies.
  await page.evaluate(() => new Promise((resolve, reject) => {
    let busySeen = false;
    let timer;
    const observer = new MutationObserver(records => {
      const button = document.querySelector('.sh-unavailable .hg-button');
      busySeen ||= button?.disabled || records.some(record => record.type === 'attributes' &&
        record.attributeName === 'disabled' && record.oldValue !== null && record.target.matches('.sh-unavailable .hg-button'));
      if (busySeen && button?.disabled === false && document.querySelector('.sh-unavailable h1')?.textContent === '整体数据暂不可用') {
        observer.disconnect(); clearTimeout(timer); resolve();
      }
    });
    observer.observe(document.querySelector('.sh-unavailable'), { subtree: true, childList: true, attributes: true, attributeOldValue: true });
    timer = setTimeout(() => { observer.disconnect(); reject(new Error('Retry did not complete on the same unavailable page')); }, 10000);
    document.querySelector('.sh-unavailable .hg-button').click();
  }));
  await unavailableDom(page);
  unavailableStatus(await page.evaluate(() => window.sysomDesktop.collectorStatus()));
  record('retry completes and retains the same root-unavailable error page');

  await clickText(page, '巡检配置', '.sh-unavailable');
  await page.waitForSelector('.sh-inspection-config');
  await page.waitForFunction(() => document.querySelector('.sh-inspection-config time')?.textContent === '暂不可用');
  assert(await page.$eval('button[aria-label="设置巡检周期"]', button => button.disabled && button.textContent.trim() === '5分钟'));
  assert(await page.$eval('.sh-inspection-toggle', button => button.disabled));
  assert.match(await page.$eval('.sh-inspection-config', item => item.textContent), /暂不可用.*暂无巡检/);
  await page.click('button[aria-label="设置巡检周期"]');
  await page.click('.sh-inspection-toggle');
  assert.equal(await page.$('.sh-interval-form'), null);
  assert.deepEqual(unavailableStatus(await page.evaluate(() => window.sysomDesktop.collectorStatus())), result.status);
  await page.screenshot({ path: path.join(outputDir, `${name}-unavailable-config.png`) });
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('dialog[open]'));
  result.dom = await unavailableDom(page);
  record('inspection period and enable/disable controls are disabled; no task or next inspection is created');
  await page.screenshot({ path: path.join(outputDir, `${name}-unavailable.png`) });
  fs.writeFileSync(path.join(outputDir, `${name}-unavailable-acceptance.json`), JSON.stringify(result, null, 2));
  return result;
}

function assertNoErrors(app) {
  assert.equal(app.errors.length, 0, app.errors.join('\n'));
  assert.equal(app.foreignRequests.length, 0, app.foreignRequests.join('\n'));
}

(async () => {
  const name = `${executable.endsWith('.AppImage') || path.basename(path.dirname(executable)) === 'appimage' ? 'packaged-appimage' : 'packaged-desktop'}-v${version.replace(/\./g, '')}${rootUnavailable ? '-root-unavailable' : ''}`;
  let app;
  try {
    app = await launch('1');
    const { page, pet } = app;
    app.inspector = await connectMainInspector(app.output.match(/Debugger listening on (ws:\/\/[^\s]+)/)[1]);
    const iconBytes = await page.evaluate(async () => Array.from(new Uint8Array(await (await fetch(new URL('icon.png', location.href))).arrayBuffer())));
    assert.deepEqual(Buffer.from(iconBytes), fs.readFileSync(path.join(__dirname, '../../sysagent-idc/build/icon.png')));
    const icon = await page.evaluate(async () => {
      const image = new Image();
      image.src = new URL('icon.png', location.href).href;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext('2d');
      context.drawImage(image, 0, 0);
      return {
        width: image.naturalWidth,
        height: image.naturalHeight,
        cornerAlpha: context.getImageData(0, 0, 1, 1).data[3],
        favicon: document.querySelector('link[rel="icon"]').getAttribute('href'),
      };
    });
    assert.equal(icon.width, 1024);
    assert.equal(icon.height, 1024);
    assert.equal(icon.cornerAlpha, 0);
    assert.equal(icon.favicon, './icon.svg');
    console.log('ICON_OK:', JSON.stringify(icon));
    const nativeChecks = await nativeDesktopAcceptance(page, pet, app.inspector, outputDir, name, { rootUnavailable });
    app.inspector.close();
    app.inspector = null;
    const result = rootUnavailable ? await unavailableAcceptance(page, outputDir, name) : await acceptance(page, outputDir, name);
    assertNoErrors(app);
    console.log(JSON.stringify({ url: page.url(), preloadBridge: true, nativeChecks, ...result, errors: app.errors, foreignRequests: app.foreignRequests }));
    await quit(app);
    assertNoErrors(app);
    console.log('CLEAN_EXIT: 0');
    await cleanup(app);

    app = await launch('0');
    const noGpu = rootUnavailable ? await unavailableAcceptance(app.page, outputDir, `${name}-no-gpu`) :
      await noGpuAcceptance(app.page, outputDir, `${name}-no-gpu`);
    assertNoErrors(app);
    console.log(JSON.stringify({ ...noGpu, errors: app.errors, foreignRequests: app.foreignRequests }));
    await quit(app);
    assertNoErrors(app);
    console.log('NO_GPU_CLEAN_EXIT: 0');
  } finally {
    await cleanup(app);
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
