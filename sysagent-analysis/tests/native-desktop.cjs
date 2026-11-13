const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { clickText, snapshot } = require('./acceptance.cjs');

async function connectMainInspector(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let nextId = 0;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (!pending.has(message.id)) return;
    pending.get(message.id)(message);
    pending.delete(message.id);
  });
  async function evaluate(expression) {
    const id = ++nextId;
    const response = new Promise((resolve) => pending.set(id, resolve));
    socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }));
    const message = await response;
    assert(!message.error && !message.result.exceptionDetails, JSON.stringify(message));
    return message.result.result.value;
  }
  const modulePath = path.resolve(__dirname, '../../sysagent-idc/electron/main.cjs');
  const electron = `process.getBuiltinModule('module').createRequire(${JSON.stringify(modulePath)})('electron')`;
  return {
    async state() {
      return evaluate(`(() => { const e = ${electron}; return {
        screens: e.screen.getAllDisplays(), primaryId: e.screen.getPrimaryDisplay().id,
        windows: e.BrowserWindow.getAllWindows().map(w => ({
          id: w.id, bounds: w.getBounds(), visible: w.isVisible(), alwaysOnTop: w.isAlwaysOnTop(),
          floating: w.getTitle() === 'SysAgent 小管家',
          handle: w.getNativeWindowHandle().readUInt32LE(0),
        })),
      }; })()`);
    },
    minimize() {
      return evaluate(`${electron}.BrowserWindow.getAllWindows().find(w => w.getTitle() === 'SysAgent管家').minimize()`);
    },
    waitForHome() {
      return evaluate(`new Promise((resolve, reject) => {
        const w = ${electron}.BrowserWindow.getAllWindows().find(w => w.getTitle() === 'SysAgent管家');
        const deadline = Date.now() + 5000;
        const timer = setInterval(() => {
          if (w.isVisible() && !w.isMinimized() && w.isFocused()) { clearInterval(timer); resolve(true); }
          else if (Date.now() > deadline) { clearInterval(timer); reject(new Error('Home did not become visible and focused: ' + JSON.stringify({visible:w.isVisible(), minimized:w.isMinimized(), focused:w.isFocused()}))); }
        }, 20);
      })`);
    },
    close() { socket.close(); },
  };
}

async function nativeDesktopAcceptance(page, pet, inspector, outputDir, name, { rootUnavailable = false } = {}) {
  const results = [];
  const record = (value) => { results.push(value); console.log(`PASS ${name}: ${value}`); };
  const windows = (value) => ({ home: value.windows.find(item => !item.floating), pet: value.windows.find(item => item.floating) });
  await page.waitForSelector(rootUnavailable ? '.sh-unavailable' : '.sh-resource-card');
  if (rootUnavailable) await page.waitForFunction(() => document.querySelector('.sh-unavailable h1')?.textContent === '整体数据暂不可用');
  await pet.waitForSelector('.native-mascot');
  await page.evaluate(() => document.fonts.ready);
  let state = await inspector.state();
  let views = windows(state);
  console.log('NATIVE_INITIAL_STATE', JSON.stringify(state));
  assert(views.home.visible && !views.pet.visible);
  if (!rootUnavailable) assert.equal((await snapshot(page)).score, 10);
  await page.screenshot({ path: path.join(outputDir, `${name}-native-home.png`) });
  record('native application opens directly on home; floating window starts hidden');

  await page.click('button[aria-label="收起为悬浮球"]');
  await page.waitForFunction(() => document.querySelector('.desktop-window').hidden);
  state = await inspector.state();
  views = windows(state);
  assert(!views.home.visible && views.pet.visible && views.pet.alwaysOnTop);
  assert.deepEqual([views.pet.bounds.width, views.pet.bounds.height], [144, 152]);
  const area = state.screens.find(display => display.id === state.primaryId).workArea;
  assert(views.pet.bounds.x >= area.x && views.pet.bounds.x + views.pet.bounds.width <= area.x + area.width);
  assert(views.pet.bounds.y >= area.y && views.pet.bounds.y + views.pet.bounds.height <= area.y + area.height);
  assert.equal(await pet.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgba(0, 0, 0, 0)');
  const xid = `0x${views.pet.handle.toString(16)}`;
  let xWindow = '';
  for (let attempt = 0; attempt < 20 && !xWindow.includes('IsViewable'); attempt += 1) {
    if (attempt) await new Promise(resolve => setTimeout(resolve, 100));
    xWindow = execFileSync('xwininfo', ['-id', xid], { encoding: 'utf8' });
  }
  console.log('NATIVE_X_WINDOW', xWindow);
  assert(xWindow.includes('IsViewable'));
  assert.match(execFileSync('xprop', ['-id', xid, 'WM_CLASS'], { encoding: 'utf8' }), /"sysagent-idc"/);
  assert.match(execFileSync('xprop', ['-id', `0x${views.home.handle.toString(16)}`, 'WM_CLASS'], { encoding: 'utf8' }), /"sysagent-idc"/);
  await pet.screenshot({ path: path.join(outputDir, `${name}-native-floating.png`), omitBackground: true });
  record('collapse hides real main window and shows transparent always-on-top desktop mascot');

  const origin = views.pet.bounds;
  const button = await pet.$('button[aria-label="打开SysAgent管家"]');
  const bounds = await button.boundingBox();
  await pet.mouse.move(bounds.x + 48, bounds.y + 48);
  await pet.mouse.down();
  await pet.mouse.move(bounds.x - 32, bounds.y - 12, { steps: 10 });
  await pet.mouse.up();
  await pet.waitForFunction((x, y) => screenX !== x || screenY !== y, {}, origin.x, origin.y);
  views = windows(await inspector.state());
  assert(views.pet.bounds.x < origin.x && views.pet.bounds.y < origin.y);
  assert(views.pet.visible && !views.home.visible);
  const dragged = views.pet.bounds;
  await pet.screenshot({ path: path.join(outputDir, `${name}-native-dragged.png`), omitBackground: true });
  record('drag moves OS window without opening home');

  await pet.click('button[aria-label="打开SysAgent管家"]');
  await page.waitForFunction(() => !document.querySelector('.desktop-window').hidden);
  views = windows(await inspector.state());
  assert(views.home.visible && !views.pet.visible);
  if (rootUnavailable) {
    assert((await page.$eval('nav button.active', button => button.textContent.replace(/\s+/g, ''))).startsWith('体检首页'));
    await page.waitForSelector('.sh-unavailable');
  } else {
    assert((await snapshot(page)).badge.startsWith('体检首页'));
  }
  for (let index = 0; index < 5; index++) {
    await inspector.minimize();
    await page.waitForFunction(() => document.querySelector('.desktop-window').hidden);
    views = windows(await inspector.state());
    assert(!views.home.visible && views.pet.visible);
    assert.deepEqual(views.pet.bounds, dragged);
    await pet.focus('button[aria-label="打开SysAgent管家"]');
    await pet.keyboard.press('Enter');
    await page.waitForFunction(() => !document.querySelector('.desktop-window').hidden);
    await inspector.waitForHome();
    views = windows(await inspector.state());
    assert(views.home.visible && !views.pet.visible);
  }
  record('click/Enter restore home; OS minimize also collapses and retains dragged position');

  if (!rootUnavailable) {
    await clickText(page, '动态告警演示');
    await clickText(page, '开始演示', '.resource-demo-panel');
    await page.waitForFunction(() => document.querySelector('.resource-demo-stage')?.textContent.includes('正常 80%'));
    await page.click('button[aria-label="收起为悬浮球"]');
    await pet.waitForSelector('.mascot-launcher.alert-pulse');
    assert.equal(await pet.$eval('.mascot-button', item => getComputedStyle(item).animationName), 'mascot-alert-attention');
    assert(await pet.$eval('[role="alert"]', item => item.textContent.includes('96%')));
    views = windows(await inspector.state());
    assert(!views.home.visible && views.pet.visible);
    assert(views.pet.bounds.width > 144);
    assert.equal(await pet.evaluate(() => document.documentElement.scrollWidth - innerWidth), 0);
    await pet.evaluate(() => document.fonts.ready);
    await pet.screenshot({ path: path.join(outputDir, `${name}-native-alert.png`), omitBackground: true });
    await pet.waitForFunction(() => !document.querySelector('.mascot-launcher.alert-pulse'));
    assert(await pet.$('[role="alert"]'));
    await pet.click('button[aria-label="关闭资源告警"]');
    await pet.waitForFunction(() => !document.querySelector('[role="alert"]'));
    views = windows(await inspector.state());
    assert.deepEqual([views.pet.bounds.width, views.pet.bounds.height], [144, 152]);
    await pet.click('button[aria-label="打开SysAgent管家"]');
    await page.waitForFunction(() => !document.querySelector('.desktop-window').hidden);
    assert.equal((await snapshot(page)).resources[1], 96);
    record('hidden app keeps simulated monitoring; new anomaly shakes mascot and shows/dismisses alert');
  }

  await page.click('button[aria-label="关闭主页并收回悬浮球"]');
  await page.waitForFunction(() => document.querySelector('.desktop-window').hidden);
  const canceledBounds = await (await pet.$('.mascot-button')).boundingBox();
  await pet.mouse.move(canceledBounds.x + 48, canceledBounds.y + 48);
  await pet.mouse.down();
  await pet.evaluate(() => document.querySelector('.mascot-button').dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, pointerId: 1 })));
  await pet.mouse.up();
  views = windows(await inspector.state());
  assert(views.pet.visible && !views.home.visible);
  await pet.click('button[aria-label="打开SysAgent管家"]');
  await page.waitForFunction(() => !document.querySelector('.desktop-window').hidden);
  record('close-to-mascot and canceled drag retain state without accidental open');
  fs.writeFileSync(path.join(outputDir, `${name}-native-acceptance.json`), JSON.stringify({ checks: results }, null, 2));
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector(rootUnavailable ? '.sh-unavailable' : '.sh-resource-card');
  if (rootUnavailable) await page.waitForFunction(() => document.querySelector('.sh-unavailable h1')?.textContent === '整体数据暂不可用');
  return results;
}

module.exports = { connectMainInspector, nativeDesktopAcceptance };
