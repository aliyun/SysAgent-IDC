const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '../..');
const guard = path.join(root, 'sysagent-idc');
const resolveGuard = name => require.resolve(name, { paths: [guard] });
const ts = require(resolveGuard('typescript'));
const puppeteer = require(require.resolve('puppeteer-core', { paths: [path.join(root, 'sysagent-analysis/tests')] }));
const output = path.join(root, 'docs/assets/user-guide');
assert(fs.statSync(output).isDirectory());
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }, fileName: filename,
}).outputText, filename);
const { createInitialState } = require(path.join(guard, 'src/health-data.ts'));
const sampledAt = '2026-11-12T08:00:00Z';
const health = createInitialState(true);
Object.assign(health, { mode: 'collected', sampledAt, revision: 12, optimizations: [], operations: [] });
for (const [id, usage, quantity] of [
  ['cpu', 42, undefined], ['energy', null, { value: 38.5, unit: 'W' }],
  ['memory', 65, { value: 20.8 * 1024 ** 3, total: 32 * 1024 ** 3, unit: 'B' }],
  ['disk', 92, { value: 460 * 1024 ** 3, total: 500 * 1024 ** 3, available: 40 * 1024 ** 3, unit: 'B' }],
  ['gpu', 74, undefined],
]) {
  const bytes = id === 'memory';
  Object.assign(health.resources[id], { usage, capacity: null, source: 'sysak', status: 'available', sampledAt,
    unit: id === 'energy' ? 'W' : '%', quantity,
    rankUnit: bytes ? 'B' : id === 'disk' ? 'B/s' : id === 'energy' ? 'W' : '%',
    rankLabel: id === 'disk' ? '进程 I/O 速率' : '进程资源排行', note: '文档人工构造的样例证据，不是本机测量',
    rows: id === 'energy' ? [] : Array.from({ length: 12 }, (_, i) => {
      const amount = bytes ? (3 - i * 0.2) * 1024 ** 3 : id === 'disk' ? (12 - i) * 1024 ** 2 : 18 - i;
      return { id: `process-${41001 + i}-100${i}`, pid: 41001 + i, starttime: 1000 + i,
        name: i === 0 ? 'qoder-cli' : i === 1 ? 'claude' : `sample-worker-${i}`, detail: '文档样例进程，不对应真实 PID',
        usage: amount, quantity: bytes ? { value: amount, unit: 'B' } : id === 'disk' ? { value: amount, unit: 'B/s' } : undefined,
        cleanable: i < 2, defaultSelected: false, effect: '结束整个进程，不清理文件', agentKind: i < 2 ? (i ? 'Claude Code' : 'Qoder CLI') : undefined };
    }),
  });
}
health.inspections = health.inspections.map(item => ({ ...item, usage: null, status: 'unchecked', execution: 'unavailable',
  detail: '尚无完整证据，不能判定正常', evidence: ['文档样例；未提供真实检查证据'] }));
for (const [id, usage] of [['root', 92], ['memory', 65], ['fd', 24]]) {
  const item = health.inspections.find(item => item.id === id);
  if (item) Object.assign(item, { usage, status: usage > 90 ? 'abnormal' : 'normal', execution: 'complete',
    detail: id === 'root' ? '样例：根分区使用率超过 90%，应核对可用空间' : '样例：当前检查项未达到异常阈值', evidence: ['sysAK IDC 格式的人工样例证据'] });
}
const card = { index: 0, name: 'NVIDIA 文档样例 GPU', uuid: 'GPU-DOCUMENT-SAMPLE', busId: '0000:01:00.0',
  utilization: 74, memoryUtilization: 35, memoryUsedBytes: 8 * 1024 ** 3, memoryTotalBytes: 24 * 1024 ** 3,
  temperatureCelsius: 67, powerWatts: 155, powerLimitWatts: 250, eccCorrected: 0, eccUncorrected: null,
  pcieGeneration: 4, pcieMaxGeneration: 4, pcieWidth: 16 };
health.resources.gpu.gpuDevices = [card];
health.gpuDiagnostic = { status: 'partial', outcome: 'abnormal', sampledAt, source: 'sysak ai', complete: false,
  gpuCount: 1, architectures: ['文档样例'], devices: [card.name], summary: '样例：检测到资源风险，部分检查缺少证据。',
  findings: [{ check: 'RESOURCE', severity: 'WARN', message: '样例作业显存压力偏高', suggestion: '结合批量大小和并发核对；未自动调整参数' }],
  jobAnalysis: { status: 'partial', source: 'sysak ai', sampledAt, sampleWindowSeconds: null, complete: false,
    reason: '文档人工样例；指标窗口未提供，不能覆盖完整作业', processes: [{ pid: 41001, starttime: null, name: '', state: 'S',
      cpuPercent: null, rssBytes: 3 * 1024 ** 3, gpuIndices: [0], smUtilization: null, memoryUtilization: null, status: 'partial', findings: [] }] } };
const agent = { source: 'agentsight', analyzer: 'sysom-openapi', sampledAt,
  window: { start: '2026-11-11T08:00:00Z', end: sampledAt }, status: 'ok', outcome: 'abnormal',
  summary: '文档样例：发现一条模型调用错误。以下全部为人工构造元数据，不是用户会话。', lastScanAt: sampledAt, filteredProcesses: 2,
  coverage: ['processes', 'sessions', 'interruptions', 'interruptionCounts', 'latency'].map(key => ({ key, status: 'available', reason: '文档样例来源可用' })),
  totals: { sessions: 2, inputTokens: 12000, outputTokens: 1800, unresolved: 1, critical: 0, high: 1 },
  findings: [{ severity: 'warning', title: '模型调用中断（样例）', detail: '一个已采集调用返回错误；并非自动修复结果', suggestion: '核对该调用的模型服务和错误时间' }],
  processes: [{ pid: 41001, name: 'qoder-cli', role: 'worker', status: 'healthy', ports: [8001], lastCheckAt: sampledAt, latencyMs: 12, parentPid: null, hasCrash: false },
    { pid: 41002, name: 'claude', role: 'worker', status: 'no_port', ports: [], lastCheckAt: sampledAt, latencyMs: null, parentPid: null, hasCrash: false }],
  sessions: [{ id: 'doc-session-001', agent: 'Qoder CLI', model: 'sample-model-A', conversations: 4, inputTokens: 8000, outputTokens: 1200,
    firstSeenAt: '2026-11-12T07:00:00Z', lastSeenAt: sampledAt }, { id: 'doc-session-002', agent: 'Claude Code', model: 'sample-model-B', conversations: 2,
    inputTokens: 4000, outputTokens: 600, firstSeenAt: '2026-11-12T06:00:00Z', lastSeenAt: '2026-11-12T07:30:00Z' }],
  interruptions: [{ id: 'doc-event-001', sessionId: 'doc-session-001', callId: 'doc-call-001', pid: 41001, agent: 'Qoder CLI',
    type: 'llm_error', severity: 'high', occurredAt: '2026-11-12T07:50:00Z', resolved: false }],
  latency: [{ agent: 'Qoder CLI', calls: 4, streamingCalls: 4, ttftP95Ms: 820, e2eP95Ms: 4200, tpsP50: 42, tpotP95Ms: 28 },
    { agent: 'Claude Code', calls: 2, streamingCalls: 1, ttftP95Ms: null, e2eP95Ms: 2800, tpsP50: 35, tpotP95Ms: null }] };
const status = { schema_version: '1.0', mode: 'mock', read_only: true, device_id: 'documentation-instance', installed: true, enabled: true,
  inspection_interval_minutes: 5, next_inspection_at: '2026-11-12T08:05:00Z', phase: 'idle', api_version: '1.0', last_task: null, error: null,
  agent_sight: { state: 'running', message: '文档样例 API 状态', collection: { state: 'disabled', enabled: false, scope: 'none', trace_running: false,
    api_running: true, message: '文档样例：真实采集未启用；仅展示人工构造报告' } } };
async function click(page, text, scope = 'body') {
  const found = await page.evaluate((text, scope) => {
    const button = [...document.querySelectorAll(`${scope} button`)].find(item => !item.disabled && item.textContent.replace(/\s/g, '').includes(text.replace(/\s/g, '')));
    if (!button) return false;
    button.click(); return true;
  }, text, scope);
  assert(found, `缺少按钮 ${text}`);
}
async function nav(page, text) { await click(page, text, 'nav'); await page.waitForFunction(text => document.querySelector('nav button.active')?.textContent.includes(text), {}, text); await page.$eval('main', node => { node.scrollTop = 0; }); }
(async () => {
  let server, browser;
  const errors = [], foreign = [], captures = [];
  try {
    const { createServer } = await import(pathToFileURL(resolveGuard('vite')).href);
    const react = (await import(pathToFileURL(resolveGuard('@vitejs/plugin-react')).href)).default;
    const reservation = require('node:net').createServer();
    await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
    const port = reservation.address().port;
    await new Promise(resolve => reservation.close(resolve));
    server = await createServer({ root: guard, configFile: false, plugins: [react()], base: './',
      define: { 'import.meta.env.VITE_SYSAGENT_VERSION': JSON.stringify(require(path.join(guard, 'package.json')).version) },
      server: { host: '127.0.0.1', port, strictPort: true } });
    await server.listen();
    const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
    browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--disable-dev-shm-usage'] });
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 1080 });
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.setRequestInterception(true);
    page.on('request', request => {
      if (request.url().startsWith(origin + '/') || /^(data:|blob:|about:)/.test(request.url())) request.continue();
      else { foreign.push(request.url().split('?')[0]); request.abort(); }
    });
    await page.evaluateOnNewDocument((health, agent, status) => {
      const ok = data => Promise.resolve({ ok: true, data: structuredClone(data) });
      const denied = () => Promise.resolve({ ok: false, error: { code: 'DOCUMENTATION_READ_ONLY', message: '文档截图不执行真实操作', status: 409, retryable: false } });
      window.__docUnavailable = sessionStorage.getItem('sysom-documentation-unavailable') === '1';
      window.sysomDesktop = { isElectron: false, gpuAvailable: true,
        healthSnapshot: () => window.__docUnavailable ? Promise.resolve({ ok: false, error: { code: 'ROOT_COLLECTOR_UNAVAILABLE', message: '需要管理员安装并启用与当前组件一致的 sysAK IDC 服务，且授权当前用户；不以普通用户回退执行', status: 503, retryable: true } }) : ok(health),
        agentDiagnostic: () => ok(agent), collectorStatus: () => ok(window.__docUnavailable ? { ...status, installed: false, phase: 'error' } : status),
        healthOperation: denied, healthReset: denied, executeProcessCleanup: denied,
        prepareProcessCleanup: ({ revision }) => ok({ token: 'documentation-only-not-a-real-credential', revision,
          expires_at: '2026-11-12T08:01:00Z', processes: [{ id: 'process-41001-1000', pid: 41001, starttime: 1000, name: 'qoder-cli（文档样例）' }] }),
        setCollectorEnabled: denied, setInspectionInterval: denied };
      document.addEventListener('DOMContentLoaded', () => {
        const tag = document.createElement('div');
        tag.textContent = '文档界面示例 · 人工构造证据 / 内置 Demo · 非本机实测 · 不执行真实操作';
        tag.style.cssText = 'position:fixed;bottom:0;left:0;right:0;z-index:2147483647;background:#173952;color:white;text-align:center;font:13px sans-serif;padding:7px;pointer-events:none';
        document.body.appendChild(tag);
      });
    }, health, agent, status);
    await page.goto(origin + '/?gpu=1', { waitUntil: 'networkidle0' });
    await page.click('button[aria-label="打开SysAgent管家"]');
    await page.waitForSelector('.sh-resource-card');
    await page.evaluate(() => document.fonts.ready);
    async function shot(name) {
      await page.evaluate(() => document.fonts.ready);
      await page.screenshot({ path: path.join(output, `${name}.png`) });
      captures.push({ file: `${name}.png`, headings: await page.$$eval('main h1,main h2,main h3,dialog[open] h2', nodes => nodes.map(node => node.textContent.trim())) });
    }
    await shot('01-home');
    await click(page, '巡检配置'); await page.waitForSelector('dialog[open]'); await shot('02-inspection-settings');
    await page.click('button[aria-label="设置巡检周期"]'); await page.waitForSelector('.sh-interval-form'); await shot('02b-inspection-interval');
    await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
    await page.click('button[aria-label="查看CPU 利用率详情"]'); await page.waitForSelector('dialog[open] .sh-rank-table'); await shot('03-cpu-ranking');
    await click(page, '只看 Agent', 'dialog[open]');
    const first = await page.$('dialog[open] tbody input[type="checkbox"]'); if (first) await first.click();
    await click(page, '清理所选进程', 'dialog[open]'); await page.waitForSelector('.sh-process-confirm'); await shot('04-cleanup-confirm'); await page.keyboard.press('Escape');
    await page.click(`button[aria-label="查看全部 ${health.inspections.length} 项体检项目"]`); await page.waitForSelector('dialog[open]'); await shot('05-inspections'); await page.keyboard.press('Escape');
    await click(page, '体检报告'); await page.waitForSelector('dialog[open]'); await shot('06-health-report'); await page.keyboard.press('Escape');
    await nav(page, 'GPU 诊断'); await shot('07-gpu-overview');
    await click(page, 'GPU 诊断', '[role="tablist"]'); await shot('08-gpu-diagnosis');
    await click(page, '作业级深度剖析', '[role="tablist"]'); await shot('09-gpu-jobs');
    await page.$eval('.gd-job-list', node => node.scrollIntoView({ block: 'center' })); await shot('09b-gpu-job-detail');
    await page.evaluate(() => { document.querySelector('main').scrollTop = 0; });
    await click(page, '异常事件分析', '[role="tablist"]'); await shot('10-gpu-events-demo');
    await nav(page, 'Agent 管家'); await page.waitForSelector('.ad-live-tabs'); await shot('11-agent-overview');
    await page.click('.ad-collection-details summary'); await shot('11b-agent-coverage'); await page.click('.ad-collection-details summary');
    await page.$eval('.ad-live-report table', node => node.scrollIntoView({ block: 'center' })); await shot('11c-agent-processes');
    await page.$eval('main', node => { node.scrollTop = 0; });
    await click(page, '会话', '.ad-live-tabs'); await shot('12-agent-sessions');
    await click(page, '中断', '.ad-live-tabs'); await shot('13-agent-interruptions');
    await click(page, '查看证据'); await page.waitForSelector('dialog[open]'); await shot('14-agent-evidence'); await page.keyboard.press('Escape');
    await click(page, '延迟', '.ad-live-tabs'); await shot('15-agent-latency');
    await nav(page, '设备管理'); await shot('16-devices-demo');
    await nav(page, '研发运维'); await shot('17-ops-demo');
    await nav(page, '日志分析'); await shot('18-logs-demo');
    await page.evaluate(() => { sessionStorage.setItem('sysom-documentation-unavailable', '1'); });
    await page.reload({ waitUntil: 'networkidle0' }); await page.click('button[aria-label="打开SysAgent管家"]');
    await page.waitForSelector('.sh-unavailable'); await shot('19-collector-unavailable');
    assert.deepEqual(errors, []); assert.deepEqual(foreign, []);
    fs.writeFileSync(path.join(output, 'capture-manifest.json'), JSON.stringify({
      source_version: require(path.join(guard, 'package.json')).version, captured_at: new Date().toISOString(),
      runtime: 'Current React source in isolated browser; no Electron/IDE host, no collector plugin',
      evidence: 'Artificial documentation fixtures and built-in Demo; not live host data',
      real_operations: false, errors, foreign_requests: foreign, captures,
    }, null, 2) + '\n');
    console.log(JSON.stringify({ screenshots: captures.length, errors, foreignRequests: foreign, version: require(path.join(guard, 'package.json')).version }));
  } finally {
    await browser?.close();
    await server?.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
