const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const normalize = (text) => text.replace(/\s+/g, '');
async function clickText(page, text, scope = 'body') {
  const clicked = await page.evaluate((text, scope) => {
    const normalize = (value) => (value || '').replace(/\s+/g, '');
    const buttons = [...document.querySelectorAll(`${scope} button`)];
    const button = buttons.find((item) => !item.disabled && !item.closest('[hidden]') && normalize(item.textContent) === normalize(text));
    if (!button) return false;
    button.click();
    return true;
  }, text, scope);
  assert(clicked, `Button not found or disabled: ${text}`);
}
async function textAppears(page, text, scope = 'body') {
  await page.waitForFunction((text, scope) => (document.querySelector(scope)?.innerText || '').replace(/\s+/g, '').includes(text.replace(/\s+/g, '')), {}, text, scope);
}
async function closeDialog(page) {
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('dialog[open]'));
}
async function navigate(page, text) {
  await page.waitForFunction((text) => [...document.querySelectorAll('nav button')].some((button) => !button.disabled && button.textContent.replace(/\s+/g, '').startsWith(text.replace(/\s+/g, ''))), {}, text);
  await page.evaluate((text) => [...document.querySelectorAll('nav button')].find((button) => button.textContent.replace(/\s+/g, '').startsWith(text.replace(/\s+/g, ''))).click(), text);
  await page.waitForFunction((text) => document.querySelector('nav button.active')?.textContent.replace(/\s+/g, '').startsWith(text.replace(/\s+/g, '')), {}, text);
}
async function openHome(page) {
  if (await page.evaluate(() => window.sysomDesktop?.isElectron && !window.sysomDesktop.isFloating)) {
    await page.evaluate(() => window.sysomDesktop.openHome());
  } else {
    await page.waitForSelector('button[aria-label="打开SysAgent管家"]');
    await page.click('button[aria-label="打开SysAgent管家"]');
  }
  await page.waitForSelector('.sh-resource-card');
  await page.evaluate(() => document.fonts.ready);
}
async function reloadHome(page, hooks) {
  if (hooks.reload) await hooks.reload(page);
  else await page.reload({ waitUntil: 'load' });
  await openHome(page);
}
async function snapshot(page) {
  return page.evaluate(() => ({
    score: parseFloat(document.querySelector('.sh-score-ring strong').textContent),
    resources: [...document.querySelectorAll('.sh-resource-card .sh-resource-value')].map((item) => Number(item.getAttribute('aria-label').match(/([\d.]+)%/)[1])),
    versions: [...new Set([...document.querySelectorAll('[data-version]')].map((item) => item.dataset.version))],
    badge: document.querySelector('nav button.active')?.textContent.replace(/\s+/g, ''),
  }));
}
async function acceptance(page, outputDir, name, { screenshots = true, responsive = true, hooks = {} } = {}) {
  const result = { name, checks: [] };
  const record = (check) => { result.checks.push(check); console.log(`PASS ${name}: ${check}`); };
  await page.setViewport({ width: 1440, height: 960 });
  const native = await page.evaluate(() => window.sysomDesktop?.isElectron === true);
  if (!native) {
    await page.waitForSelector('button[aria-label="打开SysAgent管家"]');
    assert.equal(await page.$('.guard-desktop'), null);
    const mascot = await page.$('button[aria-label="打开SysAgent管家"]');
    const bounds = await mascot.boundingBox();
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    await page.mouse.down();
    await page.mouse.move(bounds.x - 80, bounds.y - 50, { steps: 8 });
    await page.mouse.up();
    assert.equal(await page.$('.guard-desktop'), null);
    await page.focus('button[aria-label="打开SysAgent管家"]');
    await page.keyboard.press('Enter');
  }
  await page.waitForSelector('.sh-resource-card');
  await page.evaluate(() => document.fonts.ready);
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), '关闭主页并收回悬浮球');
  let state = await snapshot(page);
  assert.equal(state.score, 10);
  assert.deepEqual(state.resources, [93, 84, 94, 96, 92]);
  assert.equal(state.versions.length, 1);
  assert(state.badge.endsWith('9'));
  record('launcher drag/keyboard/focus and initial score/resources/badge');
  if (screenshots) await page.screenshot({ path: path.join(outputDir, `${name}-overview.png`) });

  for (const label of ['CPU 利用率', '能耗', '系统内存', '系统磁盘', 'GPU 利用率']) {
    await page.click(`button[aria-label="查看${label}详情"]`);
    await page.waitForSelector('dialog[open] .sh-rank-table');
    assert.equal(await page.$$eval('dialog[open] .sh-rank-table tbody > tr:not(.sh-session-container)', (rows) => rows.length), 10);
    assert.equal(await page.$$eval('dialog[open] .sh-rank-table input:checked', (inputs) => inputs.length), 3);
    await page.click('input[aria-label="全选可清理排行项"]');
    assert.equal(await page.$$eval('dialog[open] .sh-rank-table input:checked', (inputs) => inputs.length), 0);
    await page.click('input[aria-label="全选可清理排行项"]');
    await clickText(page, '只看 Agent 2', 'dialog[open]');
    assert.equal(await page.$$eval('dialog[open] .sh-agent-sessions', (panels) => panels.length), 1);
    assert.equal(await page.$$eval('dialog[open] .sh-session-row.protected input', (inputs) => inputs.filter((input) => input.disabled).length), 1);
    await page.click('button[aria-label="展开Coding Agent的Sessions"]');
    assert.equal(await page.$$eval('dialog[open] .sh-agent-sessions', (panels) => panels.length), 2);
    await closeDialog(page);
  }
  record('all five Top10/default selections/Agent filter/multiple sessions/protected active');

  await page.click('button[aria-label="查看CPU 利用率详情"]');
  await page.waitForSelector('dialog[open]');
  await clickText(page, '只看 Agent 2', 'dialog[open]');
  await clickText(page, '清理 2 个 Session', '.sh-agent-sessions');
  await textAppears(page, 'Session 清理完成', 'dialog[open]');
  assert.equal(await page.$$eval('dialog[open] .sh-session-row', (rows) => rows.length), 2);
  assert.equal(await page.$$eval('dialog[open] .sh-rank-table tbody > tr:not(.sh-session-container) input', (items) => items.length), 0);
  await closeDialog(page);
  state = await snapshot(page);
  assert.equal(state.resources[3], 96);
  assert(state.resources[0] < 93 && state.resources[1] < 84 && state.resources[2] < 94 && state.resources[4] < 92);
  assert.equal(state.versions.length, 1);
  record('runtime Session cleanup updates full snapshot, does not change disk');

  await reloadHome(page, hooks);
  await page.click('button[aria-label="查看系统磁盘详情"]');
  await page.waitForSelector('dialog[open]');
  await clickText(page, '只看 Agent 2', 'dialog[open]');
  await clickText(page, '清理 2 个 Session', '.sh-agent-sessions');
  await textAppears(page, 'Session 清理完成', 'dialog[open]');
  await closeDialog(page);
  state = await snapshot(page);
  assert.deepEqual([state.resources[0], state.resources[1], state.resources[2], state.resources[4]], [93, 84, 94, 92]);
  assert(state.resources[3] < 96);
  record('disk Session cleanup leaves runtime resources unchanged');

  await reloadHome(page, hooks);
  await page.click('.sh-optimize-button');
  await page.waitForSelector('dialog[open]');
  assert.equal(await page.$$eval('dialog[open] .sh-optimization-list input:checked', (inputs) => inputs.length), 5);
  await clickText(page, '优化 5 项', 'dialog[open]');
  await textAppears(page, '当前优化建议已处理完成', 'dialog[open]');
  await closeDialog(page);
  assert.equal((await snapshot(page)).score, 100);
  assert.equal(await page.$eval('.sh-optimize-button', (button) => button.disabled), true);
  await page.click('button[aria-label="查看全部 10 项体检项目"]');
  await page.waitForSelector('dialog[open]');
  assert.equal(await page.$$eval('dialog[open] .sh-inspection.unchecked', (items) => items.length), 4);
  await closeDialog(page);
  record('full optimization reaches 100 and phase-two items remain unchecked');

  await navigate(page, '日志分析');
  const pause = await page.evaluate(() => [...document.querySelectorAll('main button')].some((button) => button.textContent.trim() === '暂停'));
  if (pause) await clickText(page, '暂停', 'main');
  const before = await page.$eval('.task-detail-row', (row) => row.innerText);
  await navigate(page, '设备管理');
  await navigate(page, '日志分析');
  assert.equal(await page.$eval('.task-detail-row', (row) => row.innerText), before);
  await page.type('input[aria-label="搜索日志内容"]', 'no-match-2026');
  await textAppears(page, '没有匹配日志');
  await page.click('input[aria-label="搜索日志内容"]', { clickCount: 3 });
  await page.keyboard.press('Backspace');
  assert.equal(await page.$$eval('.log-table tbody tr', (rows) => rows.length), 8);
  await page.click('button[aria-label="设置分析路由"]');
  await page.waitForSelector('dialog[open]');
  await closeDialog(page);
  await page.click('button[aria-label="关闭主页并收回悬浮球"]');
  if (!native) assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), '打开SysAgent管家');
  await (hooks.reopen ? hooks.reopen(page) : openHome(page));
  assert.equal((await snapshot(page)).score, 100);
  assert((await snapshot(page)).badge.startsWith('体检首页'));
  record('log state survives navigation; empty/restore/privacy; collapse preserves snapshot and opens home');

  await reloadHome(page, hooks);
  await navigate(page, 'Agent 管家');
  await clickText(page, '重启进程', 'main');
  await textAppears(page, '7218', 'main');
  await navigate(page, '体检首页');
  await textAppears(page, '2 / 2 正常', '.sh-agent-overview');
  record('Agent restart updates PID and global recovery snapshot');

  await navigate(page, '研发运维');
  await clickText(page, '开始模拟部署', 'main');
  await page.waitForSelector('dialog[open]');
  await textAppears(page, '确认模拟部署', 'dialog[open]');
  await clickText(page, '确认模拟部署', 'dialog[open]');
  await textAppears(page, '示例流程完成', 'main');
  record('deployment requires confirmation and completes four simulated stages');

  await navigate(page, 'GPU 诊断');
  await page.select('select[aria-label="选择诊断设备"]', 'mini-dev');
  await textAppears(page, '这台设备未配备独立 GPU');
  await page.select('select[aria-label="选择诊断设备"]', 'micro-edge');
  await navigate(page, 'Agent 管家');
  await textAppears(page, '这台设备暂时离线');
  await navigate(page, 'GPU 诊断');
  await page.select('select[aria-label="选择诊断设备"]', 'dc-02');
  await clickText(page, '异常事件分析 报错、HANG 与退出', 'main');
  await clickText(page, '运行自主分析', 'main');
  await textAppears(page, 'fused_rope_fwd_kernel<bf16>', '.gd-report');
  await clickText(page, '作业 Profiling 性能时间线与热点', 'main');
  const pidSelector = '.gd-profile-form input[inputmode="numeric"]';
  await page.click(pidSelector, { clickCount: 3 });
  await page.keyboard.type('0');
  await clickText(page, '开始 Profiling', 'main');
  await textAppears(page, '请输入有效的正整数 PID。');
  await page.click(pidSelector, { clickCount: 3 });
  await page.keyboard.type('28416');
  await clickText(page, '开始 Profiling', 'main');
  await textAppears(page, 'CPU / GPU Timeline');
  await textAppears(page, 'AGENT 性能解释');
  await clickText(page, '资源效率巡检 集群效率与健康', 'main');
  await page.select('select[aria-label="任务状态筛选"]', '全部任务');
  await page.type('input[aria-label="搜索任务"]', '基础模型组');
  await textAppears(page, 'pretrain-70b');
  await clickText(page, '生成今日模拟日报', 'main');
  await page.waitForSelector('dialog[open]');
  await textAppears(page, '418', 'dialog[open]');
  await closeDialog(page);
  record('GPU no-card/offline/events/profiling/PID validation/owner filter/daily report');

  await reloadHome(page, hooks);
  await clickText(page, '动态告警演示');
  await clickText(page, '开始演示', '.resource-demo-panel');
  await textAppears(page, '正常 80%', '.resource-demo-stage');
  await clickText(page, '停止', '.resource-demo-panel');
  await textAppears(page, '已停止后续演示');
  await page.waitForFunction(() => document.querySelector('.resource-demo-reading')?.textContent.includes('80%'));
  await new Promise((resolve) => setTimeout(resolve, 3000));
  assert.equal((await snapshot(page)).resources[1], 80);
  await clickText(page, '开始演示', '.resource-demo-panel');
  await textAppears(page, '演示完成', '.resource-demo-stage');
  assert.equal((await snapshot(page)).resources[1], 96);
  assert.equal(await page.$eval('.mascot-alert-card', (card) => card.getAttribute('role')), 'alert');
  assert.equal(await page.$eval('.mascot-launcher', (item) => getComputedStyle(item).zIndex), '65');
  await page.click('button[aria-label="关闭资源告警"]');
  record('alert cancellation prevents late 96; completed alert is visible over main window');

  if (responsive) {
    for (const width of [1440, 1100, 768, 390]) {
      await page.setViewport({ width, height: 960 });
      for (const label of ['体检首页', '设备管理', 'GPU 诊断', 'Agent 管家', '研发运维', '日志分析']) {
        const buttonText = await page.evaluate((label) => [...document.querySelectorAll('nav button')].find((button) => button.textContent.includes(label)).textContent, label);
        await clickText(page, buttonText, 'nav');
        const overflow = await page.evaluate(() => ({ outer: document.documentElement.scrollWidth - innerWidth, main: document.querySelector('main').scrollWidth - document.querySelector('main').clientWidth }));
        assert(overflow.outer <= 1 && overflow.main <= 1, `${label} width ${width} overflow ${JSON.stringify(overflow)}`);
        if (screenshots && (width === 1440 || width === 390)) await page.screenshot({ path: path.join(outputDir, `${name}-${label}-${width}.png`) });
      }
    }
    record('six pages at 390/768/1100/1440 without horizontal overflow');
  }
  fs.writeFileSync(path.join(outputDir, `${name}-acceptance.json`), JSON.stringify(result, null, 2));
  return result;
}
async function noGpuAcceptance(page, outputDir, name) {
  const result = { name, checks: [] };
  const record = (check) => { result.checks.push(check); console.log(`PASS ${name}: ${check}`); };
  await page.setViewport({ width: 1440, height: 960 });
  if (!(await page.$('.sh-resource-card'))) await openHome(page);
  await page.waitForSelector('.sh-resource-card');
  const state = await snapshot(page);
  assert.equal(state.score, 10);
  assert.deepEqual(state.resources, [93, 84, 94, 96]);
  assert(state.badge.endsWith('8'));
  assert.equal(await page.$('button[aria-label="查看GPU 利用率详情"]'), null);
  const navLabels = await page.$$eval('nav button', (buttons) => buttons.map((button) => button.textContent.replace(/\s+/g, '')));
  assert(!navLabels.some((label) => label.includes('GPU')), navLabels.join(','));
  await textAppears(page, '未检测到硬件 GPU', '.side-device-info');
  record('no-GPU score/resources/badge, GPU nav and resource card hidden');

  await page.click('button[aria-label="查看全部 9 项体检项目"]');
  await page.waitForSelector('dialog[open]');
  assert(!(await page.$eval('dialog[open]', (dialog) => dialog.innerText)).includes('GPU 诊断'));
  await clickText(page, '性能监视', 'dialog[open]');
  await page.waitForSelector('.hg-resource-tabs');
  const tabs = await page.$$eval('.hg-resource-tabs button', (buttons) => buttons.map((button) => button.textContent.trim()));
  assert.deepEqual(tabs, ['CPU', '能耗', '内存', '磁盘']);
  assert(!(await page.$eval('.hg-resource-details', (details) => details.innerText)).includes('GPU'));
  await closeDialog(page);
  record('inspection list and performance monitor omit GPU');

  await clickText(page, '动态告警演示');
  const targets = await page.$$eval('select[aria-label="告警演示对象"] option', (options) => options.map((option) => option.value));
  assert.deepEqual(targets, ['cpu', 'energy', 'memory', 'root', 'fd']);
  await page.click('.resource-demo-panel button[aria-label="关闭演示设置"]');
  record('alert demo targets omit GPU');

  await navigate(page, '设备管理');
  await page.evaluate(() => document.querySelector('.local-tag').closest('tr').querySelector('button').click());
  await page.waitForSelector('dialog[open] .detail-meters');
  assert.deepEqual(await page.$$eval('dialog[open] .detail-meters > div > span', (labels) => labels.map((label) => label.textContent.trim())), ['CPU', '内存']);
  await closeDialog(page);
  record('local device detail omits the GPU meter');
  await navigate(page, '体检首页');
  if (outputDir) await page.screenshot({ path: path.join(outputDir, `${name}-overview.png`) });
  return result;
}
module.exports = { acceptance, clickText, navigate, noGpuAcceptance, normalize, openHome, snapshot };
