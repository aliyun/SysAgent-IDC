const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

require.extensions['.ts'] = (module, filename) => {
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
    fileName: filename,
  });
  module._compile(output.outputText, filename);
};
require.extensions['.tsx'] = require.extensions['.ts'];
global.window = { setTimeout, location: { protocol: 'http:' }, requestAnimationFrame: callback => callback() };
global.document = { querySelector: () => null };

const data = require('../src/health-data.ts');
const gpu = require('../src/gpu-diagnostics-data.ts');

function device(overrides = {}) {
  return {
    index: 0, name: 'NVIDIA actual GPU', uuid: 'GPU-actual', busId: '0000:01:00.0',
    utilization: null, memoryUtilization: null, memoryUsedBytes: null, memoryTotalBytes: null,
    temperatureCelsius: null, powerWatts: null, powerLimitWatts: null,
    eccCorrected: null, eccUncorrected: null, pcieGeneration: null, pcieMaxGeneration: null, pcieWidth: null,
    ...overrides,
  };
}
function diagnostic(overrides = {}) {
  return {
    status: 'not_run', outcome: 'unknown', sampledAt: null, source: 'sysak ai',
    complete: false, gpuCount: null, architectures: [], devices: [], summary: '尚未检查', findings: [],
    ...overrides,
  };
}
function jobProcess(overrides = {}) {
  return {
    pid: 701, starttime: 1001, name: 'actual-worker', state: 'S', cpuPercent: null, rssBytes: null,
    gpuIndices: [], smUtilization: null, memoryUtilization: null, status: 'partial', findings: [],
    ...overrides,
  };
}
function jobAnalysis(overrides = {}) {
  return {
    status: 'partial', source: 'sysak ai', sampledAt: '2026-11-11T00:00:00Z',
    sampleWindowSeconds: 1, complete: false, reason: 'GX partial evidence', processes: [],
    ...overrides,
  };
}
function state(overrides = {}) {
  const snapshot = data.createInitialState();
  snapshot.mode = 'collected';
  snapshot.sampledAt = '2026-11-10T00:00:00Z';
  snapshot.resources.gpu = {
    ...snapshot.resources.gpu, usage: null, source: 'sysak', status: 'unavailable',
    note: 'IDC 按需 nvidia-smi GPU 快照：驱动或采集权限不可用', sampledAt: snapshot.sampledAt, gpuDevices: undefined,
  };
  return { ...snapshot, ...overrides };
}

// Substitute hooks to exercise Promise state without adding renderer dependencies.
function harness(filename, firstState, mocks = {}) {
  const slots = [];
  let cursor = 0;
  const hooks = {
    ...React,
    useState(initial) {
      const index = cursor++;
      if (!Object.hasOwn(slots, index)) slots[index] = index === 0 ? firstState : typeof initial === 'function' ? initial() : initial;
      return [slots[index], value => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; }];
    },
    useRef(initial) {
      const index = cursor++;
      if (!Object.hasOwn(slots, index)) slots[index] = { current: initial };
      return slots[index];
    },
    useEffect() { cursor++; },
  };
  const absolute = path.resolve(__dirname, filename);
  const source = fs.readFileSync(absolute, 'utf8').replaceAll('import.meta.env', '({ VITE_SYSAGENT_VERSION: "test" })');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
    fileName: absolute,
  }).outputText;
  const localRequire = createRequire(absolute);
  const module = { exports: {} };
  const execute = vm.runInThisContext(`(function(require,module,exports){${compiled}\n})`, { filename: absolute });
  execute(id => id === 'react' ? hooks : Object.hasOwn(mocks, id) ? mocks[id] : localRequire(id), module, module.exports);
  const component = module.exports.GpuDiagnostics || module.exports.default;
  return { render(props) { cursor = 0; return component(props); } };
}
function elements(element, predicate) {
  if (Array.isArray(element)) return element.flatMap(child => elements(child, predicate));
  if (!React.isValidElement(element)) return [];
  return [...(predicate(element) ? [element] : []), ...elements(element.props.children, predicate)];
}
function text(element) {
  if (Array.isArray(element)) return element.map(text).join('');
  if (React.isValidElement(element)) return text(element.props.children);
  return element == null ? '' : String(element);
}
function button(tree, label) {
  const result = elements(tree, node => node.type === 'button' && text(node).includes(label))[0];
  assert(result, `Missing button: ${label}`);
  return result;
}
function uiProps(healthState = state(), overrides = {}) {
  return { healthState, onRefresh: async () => {}, onDiagnose: async () => {}, onNotify: () => {}, ...overrides };
}
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('GPU tabs keep four columns in order, with real diagnosis second and independent demos', () => {
  const h = harness('../src/GpuDiagnostics.tsx', 'overview');
  const tree = h.render(uiProps());
  const tabs = elements(tree, node => node.props.role === 'tab').map(node => text(node.props.children[0]));
  assert.deepEqual(tabs, ['GPU 概览', 'GPU 诊断', '异常事件分析', '作业级深度剖析']);
  const html = renderToStaticMarkup(tree);
  assert.match(html, /本机.*OpenAPI/);
  assert.doesNotMatch(html, /8 节点 × 8 卡|512|90\.7|NVIDIA A100/);
  for (const [tab, mode] of [['events', 'collected'], ['profiling', 'demo']]) {
    const demoHtml = renderToStaticMarkup(harness('../src/GpuDiagnostics.tsx', tab).render(uiProps(state({ mode }))));
    assert.match(demoHtml, /独立演示：使用内置样例/);
    assert.match(demoHtml, /不执行真实分析/);
  }
  const realHtml = renderToStaticMarkup(harness('../src/GpuDiagnostics.tsx', 'profiling').render(uiProps()));
  assert.match(realHtml, /作业级深度剖析/);
  assert.match(realHtml, /本机 AI · 进程资源与异常证据/);
  assert.match(realHtml, /采集本机作业证据/);
  assert.doesNotMatch(realHtml, /独立演示：使用内置样例|28416|gpu-node-03|北京|15 分钟|240 steps|NVIDIA A100|开始演示 Profiling/);
  assert.match(gpu.problemNavigation[2].evidence, /sysak ai/);
  assert.doesNotMatch(gpu.problemNavigation[2].evidence, /Timeline|Kernel 耗时/);
});

test('real per-device metrics preserve zero and display missing measurements as unavailable', () => {
  const snapshot = state();
  snapshot.resources.gpu.status = 'partial';
  snapshot.resources.gpu.gpuDevices = [device({ utilization: 0, eccCorrected: 0, memoryUsedBytes: 1024 ** 3, memoryTotalBytes: 16 * 1024 ** 3 })];
  const html = renderToStaticMarkup(harness('../src/GpuDiagnostics.tsx', 'overview').render(uiProps(snapshot)));
  assert.match(html, /NVIDIA actual GPU/);
  assert.match(html, /GPU-actual/);
  assert.match(html, /0000:01:00.0/);
  assert.match(html, /0%/);
  assert.match(html, /1 GiB/);
  assert.match(html, /16 GiB/);
  assert.match(html, /N\/A · 不可用/);
  assert.doesNotMatch(html, /64°C|正常范围|svg[^>]*class="resource-chart/);
  const metrics = gpu.gpuDeviceMetrics(device());
  assert(metrics.every(item => item.value.includes('N/A')));
  assert.equal(gpu.gpuDeviceMetrics(device({ memoryUsedBytes: 1024 ** 2 }))[2].value, '1 MiB');
  assert.equal(gpu.gpuDeviceMetrics(device({ memoryUsedBytes: 1 }))[2].value, '1 B');
  assert.equal(gpu.gpuMetric(0), '0');
  assert.equal(gpu.gpuMetric(undefined), 'N/A · 不可用');
  assert.equal(gpu.gpuMetric(Number.NaN), 'N/A · 不可用');
});

test('IDC resource GPU reports render on-demand nvidia-smi evidence, independently of native AI', () => {
  const { parseCollectedState } = require('../collected-state.ts');
  const report = { schema_version: '1.0', tool: 'idc', mode: 'idc', read_only: true, status: 'ok', available: true, gpu_count: 1,
    devices: [{ index: 0, name: 'IDC fixture GPU', uuid: 'GPU-idc-fixture', bus_id: '0000:01:00.0', util: '0', mem_util_pct: '0',
      mem_used: '1024', mem_total: '16384', temp: '26', power_draw: '68.65', power_limit: '400', ecc_corr: '0', ecc_uncorr: '0',
      pcie_gen_max: '4', pcie_gen_cur: '1', pcie_width: '16' }] };
  const raw = { collection: { finished_at: '2026-11-10T00:00:00Z' }, resources: { gpu: { status: 'ok', content: report } } };
  const snapshot = parseCollectedState(raw, undefined, false, false);
  assert.equal(snapshot.resources.gpu.usage, 0);
  assert.equal(snapshot.gpuDiagnostic.status, 'not_run');
  assert.match(snapshot.resources.gpu.note, /IDC 按需 nvidia-smi/);
  const html = renderToStaticMarkup(harness('../src/GpuDiagnostics.tsx', 'overview').render(uiProps(snapshot)));
  assert.match(html, /IDC fixture GPU/);
  assert.match(html, /GPU-idc-fixture/);
  assert.match(html, /68\.65 W/);
  assert.doesNotMatch(html, /GPU 硬件状态正常|light_inspect/);
});

test('no GPU, denied permission, demo and absent diagnosis never imply a healthy device', () => {
  for (const snapshot of [state({ hasGpu: false }), state({ gpuDiagnostic: diagnostic({ status: 'permission_denied' }) }), state({ mode: 'demo' })]) {
    const html = renderToStaticMarkup(harness('../src/GpuDiagnostics.tsx', 'overview').render(uiProps(snapshot)));
    assert.match(html, /不可用|权限不足|未检测到 GPU/);
    assert.doesNotMatch(html, /GPU 硬件状态正常|基础健康检查通过|健康评分/);
  }
  const demo = state({ mode: 'demo', gpuDiagnostic: diagnostic({ status: 'ok', outcome: 'normal', complete: true }) });
  demo.resources.gpu.gpuDevices = [device({ name: 'DO NOT SHOW DEMO DEVICE' })];
  const tree = harness('../src/GpuDiagnostics.tsx', 'inspection').render(uiProps(demo));
  assert.equal(button(tree, '运行 GPU 检查').props.disabled, true);
  assert.match(text(tree), /Demo \/ 离线模式不能执行真实 GPU 诊断/);
  assert.match(text(tree), /未检查 · 无诊断结论/);
  assert.doesNotMatch(gpu.buildGpuReportHtml(demo), /DO NOT SHOW DEMO DEVICE|本次检查未发现异常/);
});

test('all diagnostic execution states and limited normal outcomes retain uncertainty', () => {
  for (const status of ['not_run', 'ok', 'partial', 'unavailable', 'error', 'timeout', 'truncated', 'permission_denied']) {
    const result = diagnostic({ status, outcome: 'normal', complete: status === 'ok', summary: `result-${status}` });
    const html = renderToStaticMarkup(harness('../src/GpuDiagnostics.tsx', 'inspection').render(uiProps(state({ gpuDiagnostic: result }))));
    assert(html.includes(gpu.gpuDiagnosticStatusLabel(result)));
    assert(html.includes(gpu.gpuDiagnosticOutcomeLabel(result)));
    assert(html.includes(`result-${status}`));
    if (status !== 'ok') assert.doesNotMatch(html, /本次检查未发现异常/);
  }
  assert.match(gpu.gpuDiagnosticOutcomeLabel(diagnostic({ status: 'ok', outcome: 'normal', complete: false })), /结论受限/);
  assert.equal(gpu.gpuDiagnosticOutcomeLabel(diagnostic({ status: 'partial', outcome: 'abnormal' })), '发现异常');
  assert.equal(gpu.gpuDiagnosticOutcomeLabel(diagnostic({ status: 'unavailable', outcome: 'no_gpu', gpuCount: 0 })), '未检测到 GPU');
});

test('findings search and severity filter work while report exports all escaped evidence', () => {
  const result = diagnostic({ status: 'partial', outcome: 'abnormal', sampledAt: '2026-01-02T03:04:05Z', gpuCount: 1,
    architectures: ['Ampere'], devices: ['NVIDIA actual GPU'],
    summary: '<script>alert("summary")</script>',
    findings: [
      { check: 'ECC', severity: 'WARN', message: 'corrected errors', suggestion: '<img src=x onerror=alert(1)>' },
      { check: 'PCIe', severity: 'ERROR', message: 'width decreased' },
      { check: 'temperature', severity: 'OK', message: 'observed temperature' },
    ],
  });
  const snapshot = state({ gpuDiagnostic: result });
  snapshot.resources.gpu.gpuDevices = [device({ name: '<b>device</b>', uuid: '"<&', busId: "'bus" })];
  const h = harness('../src/GpuDiagnostics.tsx', 'inspection');
  const props = uiProps(snapshot);
  let tree = h.render(props);
  assert.match(text(tree), /部分覆盖.*不代表正常/);
  assert.match(text(tree), /2026\/01\/02 11:04:05/);
  elements(tree, node => node.type === 'select' && node.props['aria-label'] === 'GPU 检查级别筛选')[0].props.onChange({ target: { value: 'ERROR' } });
  tree = h.render(props);
  assert.match(text(tree), /width decreased/);
  assert.doesNotMatch(text(tree), /corrected errors|observed temperature/);
  elements(tree, node => node.type === 'input' && node.props['aria-label'] === '搜索 GPU 检查项')[0].props.onChange({ target: { value: 'missing' } });
  assert.match(text(h.render(props)), /没有匹配的检查项/);
  const html = gpu.buildGpuReportHtml(snapshot);
  assert.match(html, /corrected errors/);
  assert.match(html, /width decreased/);
  assert.match(html, /observed temperature/);
  assert.match(html, /&lt;script&gt;alert\(&quot;summary&quot;\)&lt;\/script&gt;/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /&lt;b&gt;device&lt;\/b&gt;/);
  assert.doesNotMatch(html, /<script>|<img|<b>device/);
  assert.match(html, /sysak ai/);
  assert.match(html, /部分覆盖 \/ 未完成/);
});

test('diagnostic button follows the Promise, rejects duplicates, and retains failures', async () => {
  const waiting = deferred();
  let calls = 0;
  const h = harness('../src/GpuDiagnostics.tsx', 'inspection');
  let props = uiProps(state(), { onDiagnose: async () => { calls++; await waiting.promise; } });
  const trigger = button(h.render(props), '运行 GPU 检查');
  const running = trigger.props.onClick();
  await trigger.props.onClick();
  assert.equal(calls, 1);
  assert.equal(button(h.render(props), '运行中').props.disabled, true);
  assert.match(text(h.render(props)), /等待 OpenAPI 结果/);
  waiting.resolve();
  await running;
  props = { ...props, healthState: state({ gpuDiagnostic: diagnostic({ status: 'ok', outcome: 'normal', complete: true, summary: '真实结果' }) }) };
  assert.match(text(h.render(props)), /真实结果/);
  props = { ...props, onDiagnose: async () => { throw new Error('revision conflict'); } };
  await button(h.render(props), '重新检查 GPU').props.onClick();
  assert.match(text(h.render(props)), /revision conflict/);
  assert.match(text(h.render(props)), /上次已取得的快照/);
  assert.equal(button(h.render(props), '重新检查 GPU').props.disabled, false);
});

test('refresh awaits its Promise and reports rejection; external busy blocks actions', async () => {
  let calls = 0;
  const h = harness('../src/GpuDiagnostics.tsx', 'overview');
  const props = uiProps(state(), { onRefresh: async () => { calls++; throw new Error('OpenAPI unreachable'); } });
  await button(h.render(props), '刷新本机 GPU 资源').props.onClick();
  assert.equal(calls, 1);
  assert.match(text(h.render(props)), /OpenAPI unreachable/);
  const busyTree = h.render({ ...props, busy: true });
  assert.equal(button(busyTree, '刷新本机 GPU 资源').props.disabled, true);
  await button(busyTree, '刷新本机 GPU 资源').props.onClick();
  assert.equal(calls, 1);
});

test('real jobs preserve zero/null process measurements without copying device utilization', () => {
  const process = jobProcess({ cpuPercent: 0, smUtilization: 0, memoryUtilization: 0, rssBytes: 0, gpuIndices: [0, 2],
    findings: [{ check: 'HANG', severity: 'WARN', message: 'observed process blocked' }, { check: 'NCCL', severity: 'ERROR', message: 'actual communication evidence' }, { check: 'Xid', severity: 'ERROR', message: 'observed Xid 79' }],
  });
  const snapshot = state({ gpuDiagnostic: diagnostic({ status: 'partial', jobAnalysis: jobAnalysis({ processes: [process] }) }) });
  snapshot.resources.gpu.gpuDevices = [device({ utilization: 97, memoryUtilization: 88 })];
  const tree = harness('../src/GpuDiagnostics.tsx', 'profiling').render(uiProps(snapshot));
  const detail = elements(tree, node => node.props.className === 'gd-real-device gd-job-detail')[0];
  const output = text(detail);
  assert.match(output, /PID 701.*starttime：1001/);
  assert.match(output, /CPU 占用0%/);
  assert.match(output, /进程 SM 利用率0%/);
  assert.match(output, /进程显存活动利用率0%/);
  assert.match(output, /RSS 字节（系统内存，不是显存）0 B/);
  assert.match(output, /GPU indices0、2/);
  assert.match(output, /HANG.*observed process blocked.*NCCL.*actual communication evidence.*Xid.*observed Xid 79/);
  assert.doesNotMatch(output, /97%|88%/);
  const missing = gpu.gpuJobProcessMetrics(jobProcess({ starttime: null }));
  for (const metric of missing.slice(0, 5)) assert.match(metric.value, /N\/A/);
  assert.equal(gpu.gpuJobProcessMetrics(jobProcess({ rssBytes: 12345 }))[3].value, '12345 B');
  const unavailable = state({ gpuDiagnostic: diagnostic({ jobAnalysis: jobAnalysis({ sampleWindowSeconds: null, sampledAt: null, processes: [jobProcess({ starttime: null, name: '', state: '' })] }) }) });
  const html = renderToStaticMarkup(harness('../src/GpuDiagnostics.tsx', 'profiling').render(uiProps(unavailable)));
  assert.match(html, /starttime：N\/A · 不可用/);
  assert.match(html, /指标采样窗口<\/dt><dd>N\/A · 不可用/);
  assert.match(html, /采集时间<\/dt><dd>—/);
  assert.match(html, /展示原生进程资源及HANG\/NCCL\/Xid证据；指标窗口未提供.*缺少GX则ai不可用.*不提供完整CPU\/GPU时间线或Kernel热点/);
  assert.doesNotMatch(html, /CPU \/ GPU Timeline|耗时与调用热点|置信度|28416|15 分钟/);
});

test('native partial job UI and HTML preserve unavailable identity/window and never claim normal', () => {
  const snapshot = state({ gpuDiagnostic: diagnostic({ status: 'partial', outcome: 'unknown', gpuCount: 1,
    complete: false, architectures: [], devices: [], summary: '原生覆盖未知，不能判断整体正常',
    jobAnalysis: jobAnalysis({ sampleWindowSeconds: null, complete: false, processes: [
      jobProcess({ pid: 34001, starttime: null, name: '', state: '', cpuPercent: 0, rssBytes: 4096, gpuIndices: [0], smUtilization: 0 }),
    ] }),
  }) });
  snapshot.resources.gpu.status = 'partial';
  snapshot.resources.gpu.gpuDevices = [device({ name: '', uuid: '', busId: '', utilization: 0 })];
  const html = renderToStaticMarkup(harness('../src/GpuDiagnostics.tsx', 'profiling').render(uiProps(snapshot)));
  const report = gpu.buildGpuReportHtml(snapshot);
  for (const output of [html, report]) {
    assert.match(output, /PID 34001.*name：N\/A/);
    assert.match(output, /starttime：N\/A · 不可用/);
    assert.match(output, /指标窗口未提供/);
    assert.match(output, /原生.*证据/);
    assert.doesNotMatch(output, /当前扫描配置|AI 有界扫描|本次检查未发现异常|comm：|actual-worker|NVIDIA actual GPU|GPU-actual/);
  }
  assert.match(html, /指标采样窗口<\/dt><dd>N\/A · 不可用/);
  assert.match(html, /不能确认跨快照进程身份/);
  assert.match(html, /CPU 占用<\/dt><dd>0%/);
  assert.match(report, /指标窗口：N\/A · 不可用/);
});

test('job selection only views collected evidence and respects PID starttime identity', () => {
  let calls = 0;
  const snapshot = state({ gpuDiagnostic: diagnostic({ jobAnalysis: jobAnalysis({ processes: [
    jobProcess({ findings: [{ check: 'HANG', severity: 'WARN', message: 'first process evidence' }] }),
    jobProcess({ pid: 702, starttime: 1002, name: 'second-worker', cpuPercent: 12.5, findings: [{ check: 'NCCL', severity: 'ERROR', message: 'second process evidence' }] }),
  ] }) }) });
  const props = uiProps(snapshot, { onDiagnose: async () => { calls++; } });
  const h = harness('../src/GpuDiagnostics.tsx', 'profiling');
  let tree = h.render(props);
  button(tree, 'PID 702').props.onClick();
  tree = h.render(props);
  assert.equal(calls, 0);
  assert.equal(button(tree, 'PID 702').props['aria-pressed'], true);
  assert.match(text(tree), /CPU 占用12\.5%/);
  assert.match(text(tree), /second process evidence/);
  assert.doesNotMatch(text(tree), /first process evidence/);
  assert.equal(elements(tree, node => node.type === 'input' && node.props.inputMode === 'numeric').length, 0);
  elements(tree, node => node.props['aria-label'] === '搜索已采集作业进程')[0].props.onChange({ target: { value: 'absent' } });
  assert.match(text(h.render(props)), /没有匹配的进程/);
  button(h.render(props), '清除进程搜索').props.onClick();
  assert(button(h.render(props), 'PID 702'));
  const next = state({ gpuDiagnostic: diagnostic({ jobAnalysis: jobAnalysis({ processes: [jobProcess({ pid: 702, starttime: 9999 })] }) }) });
  tree = h.render({ ...props, healthState: next });
  assert.match(text(tree), /上次选择的 PID \+ starttime 已不在本次列表/);
  assert.doesNotMatch(text(tree), /second process evidence/);
  button(tree, 'PID 702').props.onClick();
  assert.match(text(h.render({ ...props, healthState: next })), /starttime：9999/);
});

test('job diagnosis reuses the Promise lock across tabs and retains evidence on failure then retries', async () => {
  const wait = deferred();
  let calls = 0;
  const snapshot = state({ gpuDiagnostic: diagnostic({ status: 'partial', jobAnalysis: jobAnalysis({ processes: [jobProcess({ findings: [{ check: 'HANG', severity: 'WARN', message: 'retained real evidence' }] })] }) }) });
  const h = harness('../src/GpuDiagnostics.tsx', 'profiling');
  let props = uiProps(snapshot, { onDiagnose: async (...args) => { assert.deepEqual(args, []); calls++; await wait.promise; } });
  const trigger = button(h.render(props), '重新采集本机作业证据');
  const pending = trigger.props.onClick();
  await trigger.props.onClick();
  let tree = h.render(props);
  assert.equal(calls, 1);
  assert.equal(button(tree, '本机 AI 采集中').props.disabled, true);
  assert.equal(button(tree, '导出本机作业诊断').props.disabled, true);
  assert.match(text(tree), /等待 OpenAPI 结果.*上次作业证据/);
  assert.match(text(tree), /retained real evidence/);
  elements(tree, node => node.props.role === 'tab' && text(node.props.children[0]) === 'GPU 诊断')[0].props.onClick();
  tree = h.render(props);
  assert.equal(button(tree, '运行中').props.disabled, true);
  await button(tree, '运行中').props.onClick();
  assert.equal(calls, 1);
  elements(tree, node => node.props.role === 'tab' && text(node.props.children[0]) === '作业级深度剖析')[0].props.onClick();
  wait.reject(new Error('AI timeout / permission failure'));
  await pending;
  tree = h.render(props);
  assert.match(text(tree), /AI timeout \/ permission failure/);
  assert.match(text(tree), /上次已取得的快照/);
  assert.match(text(tree), /retained real evidence/);
  assert.equal(button(tree, '重新采集本机作业证据').props.disabled, false);
  props = { ...props, onDiagnose: async () => { calls++; } };
  await button(h.render(props), '重新采集本机作业证据').props.onClick();
  assert.equal(calls, 2);
  assert.doesNotMatch(text(h.render(props)), /AI timeout \/ permission failure/);
  const busyTree = h.render({ ...props, busy: true });
  assert.equal(button(busyTree, '重新采集本机作业证据').props.disabled, true);
  await button(busyTree, '重新采集本机作业证据').props.onClick();
  assert.equal(calls, 2);
});

test('all job execution states and empty/no-GPU lists show limitations instead of invented results', () => {
  for (const status of ['not_run', 'ok', 'partial', 'unavailable', 'error', 'timeout', 'truncated', 'permission_denied']) {
    const job = jobAnalysis({ status, complete: status === 'ok', reason: `actual-${status}`, processes: [] });
    const snapshot = state({ gpuDiagnostic: diagnostic({ status, jobAnalysis: job }) });
    const html = renderToStaticMarkup(harness('../src/GpuDiagnostics.tsx', 'profiling').render(uiProps(snapshot)));
    assert(html.includes(gpu.gpuExecutionStatusLabel(status)));
    assert.match(html, new RegExp(`actual-${status}`));
    assert.match(html, /没有已采集的作业进程/);
    if (status !== 'ok') assert.match(html, /分析受限 \/ 不可用，不代表正常/);
    assert.doesNotMatch(html, /本次检查未发现异常|28416|gpu-node-03|NVIDIA A100|90\.7/);
  }
  for (const status of ['unavailable', 'permission_denied', 'error', 'timeout', 'truncated']) {
    const snapshot = state({ gpuDiagnostic: diagnostic({ status, summary: `native-wrapper-${status}` }) });
    const output = text(harness('../src/GpuDiagnostics.tsx', 'profiling').render(uiProps(snapshot)));
    assert.match(output, new RegExp(`native-wrapper-${status}`));
    assert(output.includes(gpu.gpuExecutionStatusLabel(status)));
    assert.match(output, /N\/A · 未取得列表/);
  }
  assert.match(gpu.gpuNvmlCoverage(state()), /N\/A · 未取得逐卡记录/);
  const snapshot = state({ hasGpu: false, gpuDiagnostic: diagnostic({ outcome: 'no_gpu', gpuCount: 0, jobAnalysis: jobAnalysis({ status: 'unavailable', reason: 'native AI: no GPU' }) }) });
  assert.match(text(harness('../src/GpuDiagnostics.tsx', 'profiling').render(uiProps(snapshot))), /未检测到 GPU.*native AI: no GPU/);
});

test('missing GX makes native AI unavailable; independent NVML snapshot is not AI evidence', () => {
  const snapshot = state({ gpuDiagnostic: diagnostic({ status: 'unavailable', jobAnalysis: jobAnalysis({ status: 'unavailable', sampleWindowSeconds: null, reason: 'GX 未安装，原生 ai 不可用', processes: [] }), findings: [{ check: 'gx', severity: 'WARN', message: 'GX library not installed' }] }) });
  snapshot.resources.gpu.status = 'available';
  snapshot.resources.gpu.gpuDevices = [device({ utilization: 21, memoryUtilization: 17 })];
  const html = renderToStaticMarkup(harness('../src/GpuDiagnostics.tsx', 'profiling').render(uiProps(snapshot)));
  assert.match(html, /GX 未安装，原生 ai 不可用/);
  assert.match(html, /NVML 资源指标覆盖/);
  assert.match(html, /21%/);
  assert.match(html, /17%/);
  assert.match(html, /没有已采集的作业进程/);
  assert.match(html, /GX library not installed/);
  assert.doesNotMatch(html, /本次检查未发现异常|本次返回覆盖标记为完成|进程 SM 利用率|native NVML available|硬件正常/);
  assert.match(gpu.buildGpuReportHtml(snapshot), /GX 未安装，原生 ai 不可用/);
});

test('real job HTML exports every process and finding, escaped and unaffected by selection/search', async () => {
  const snapshot = state({ gpuDiagnostic: diagnostic({ status: 'partial', sampledAt: '2026-11-11T01:00:00Z', findings: [{ check: 'NVML', severity: 'OK', message: 'all machine evidence' }], jobAnalysis: jobAnalysis({ reason: '<script>reason & "quote"</script>', processes: [
    jobProcess({ name: '<b>first & worker</b>', state: '<S>', rssBytes: 123, findings: [{ check: '<HANG>', severity: 'ERROR', message: '<script>job-one</script>', suggestion: '<img src=x onerror=1>' }] }),
    jobProcess({ pid: 702, starttime: 1002, name: 'second-worker', findings: [{ check: 'NCCL', severity: 'WARN', message: 'second-evidence' }] }),
  ] }) }) });
  const h = harness('../src/GpuDiagnostics.tsx', 'profiling');
  const props = uiProps(snapshot);
  button(h.render(props), 'PID 702').props.onClick();
  elements(h.render(props), node => node.props['aria-label'] === '搜索作业进程证据')[0].props.onChange({ target: { value: 'not-found' } });
  assert.match(text(h.render(props)), /没有匹配的进程证据/);
  const before = { document: global.document, create: URL.createObjectURL, revoke: URL.revokeObjectURL, timeout: window.setTimeout };
  let exported;
  let clicked;
  global.document = { querySelector: () => null, createElement: () => ({ click() { clicked = this; } }) };
  URL.createObjectURL = blob => { exported = blob; return 'blob:jobs'; };
  URL.revokeObjectURL = () => {};
  window.setTimeout = callback => { callback(); return 0; };
  try {
    button(h.render(props), '导出本机作业诊断 HTML 报告').props.onClick();
    const html = await exported.text();
    assert.equal(html, gpu.buildGpuReportHtml(snapshot));
    assert.equal(clicked.download, 'sysagent-gpu-collected-report.html');
    assert.match(html, /作业级深度剖析/);
    assert.match(html, /sysak ai/);
    assert.match(html, /2026\/11\/11 08:00:00/);
    assert.doesNotMatch(html, /2026-11-11T/);
    assert.match(html, /本机 sysak ai 原生证据.*指标窗口：1 s.*原生未提供统一指标窗口/);
    assert.match(html, /PID 701.*starttime：1001/);
    assert.match(html, /PID 702.*starttime：1002/);
    assert.match(html, /RSS 字节（系统内存，不是显存）：123 B/);
    assert.match(html, /&lt;script&gt;job-one&lt;\/script&gt;/);
    assert.match(html, /&lt;HANG&gt;/);
    assert.match(html, /&lt;img src=x onerror=1&gt;/);
    assert.match(html, /&lt;b&gt;first &amp; worker&lt;\/b&gt;/);
    assert.match(html, /&lt;script&gt;reason &amp; &quot;quote&quot;&lt;\/script&gt;/);
    assert.match(html, /second-evidence/);
    assert.match(html, /all machine evidence/);
    assert.doesNotMatch(html, /<script>|<img|<b>|CPU \/ GPU Timeline|演示采样/);
    const demoHtml = gpu.buildGpuReportHtml({ ...snapshot, mode: 'demo' });
    assert.doesNotMatch(demoHtml, /job-one|second-evidence|PID 701|PID 702/);
  } finally {
    global.document = before.document;
    URL.createObjectURL = before.create;
    URL.revokeObjectURL = before.revoke;
    window.setTimeout = before.timeout;
  }
});

function appHarness(snapshot, callbacks) {
  const GpuDiagnostics = () => null;
  const h = harness('../src/App.tsx', 'gpu', {
    './GpuDiagnostics': { GpuDiagnostics },
    './health-api': { optimizeHealth: async () => {}, runHealthInspection: async () => {} },
    './idc-client': { runGpuInspection: callbacks.runGpuInspection },
  });
  const props = {
    healthState: snapshot, snapshotLoading: false, snapshotError: '', demoRunning: false,
    mutationBusy: false, onActionBusy: callbacks.onActionBusy, onRefresh: callbacks.onRefresh, homeRequest: 0,
  };
  return { render: extra => h.render({ ...props, ...extra }), gpu(tree) { return elements(tree, node => node.type === GpuDiagnostics)[0]; } };
}

test('App exposes GPU for collected no-GPU machines and uses one local component', () => {
  const snapshot = state({ hasGpu: false });
  const h = appHarness(snapshot, { runGpuInspection: async () => {}, onActionBusy: () => {}, onRefresh: async () => snapshot });
  const tree = h.render();
  assert.equal(h.gpu(tree).props.healthState, snapshot);
  assert.match(text(tree), /本机 GPU/);
  assert(elements(tree, node => node.type === 'button' && node.props['aria-current'] === 'page' && text(node).includes('GPU')).length);
  assert.doesNotMatch(text(tree), /这台设备未配备独立 GPU|这台设备尚未连接|NVIDIA A100|GPU 健康评分/);
  assert.equal(elements(tree, node => node.type === 'select' && node.props['aria-label'] === '选择诊断设备').length, 0);
});

test('App uses the same GPU component for demo snapshots rather than hardcoded cards', () => {
  const snapshot = state({ mode: 'demo' });
  const h = appHarness(snapshot, { runGpuInspection: async () => {}, onActionBusy: () => {}, onRefresh: async () => snapshot });
  const tree = h.render();
  assert.equal(h.gpu(tree).props.healthState, snapshot);
  const main = elements(tree, node => node.type === 'main' && node.props.className === 'main-content')[0];
  assert.doesNotMatch(text(main), /NVIDIA A100|90\.7|GPU 健康评分|运行模拟诊断/);
  assert.match(text(main), /本机 GPU 未采集/);
});

test('App page export uses the real escaped report or labels unavailable demo evidence', async () => {
  const originalDocument = global.document;
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  const originalTimeout = window.setTimeout;
  let exported;
  let clicked;
  global.document = { querySelector: () => null, createElement: () => ({ click() { clicked = this; } }) };
  URL.createObjectURL = blob => { exported = blob; return 'blob:test'; };
  URL.revokeObjectURL = () => {};
  window.setTimeout = callback => { callback(); return 0; };
  try {
    for (const mode of ['collected', 'demo']) {
      const snapshot = state({ mode, gpuDiagnostic: diagnostic({ status: 'partial', outcome: 'abnormal', summary: '<script>bad</script>' }) });
      const h = appHarness(snapshot, { runGpuInspection: async () => {}, onActionBusy: () => {}, onRefresh: async () => snapshot });
      button(h.render(), '导出报告').props.onClick();
      assert.equal(await exported.text(), gpu.buildGpuReportHtml(snapshot));
      assert.equal(clicked.download, `sysagent-gpu-${mode === 'collected' ? 'collected' : 'unavailable'}-report.html`);
      assert.doesNotMatch(await exported.text(), /<script>|GPU 健康评分 98|90\.7/);
    }
  } finally {
    global.document = originalDocument;
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
    window.setTimeout = originalTimeout;
  }
});

test('App GPU operation uses current revision, locked inspect then non-refresh snapshot; manual refresh uses true', async () => {
  const snapshot = state({ revision: 42 });
  const waiting = deferred();
  const calls = [];
  const h = appHarness(snapshot, {
    runGpuInspection: async revision => { calls.push(['inspect', revision]); await waiting.promise; },
    onActionBusy: value => calls.push(['busy', value]),
    onRefresh: async value => { calls.push(['refresh', value]); return snapshot; },
  });
  const gpuProps = h.gpu(h.render()).props;
  const running = gpuProps.onDiagnose();
  await assert.rejects(gpuProps.onDiagnose(), /其他采集或操作正在执行/);
  assert.equal(h.gpu(h.render()).props.busy, true);
  assert.deepEqual(calls, [['busy', true], ['inspect', 42]]);
  waiting.resolve();
  await running;
  assert.deepEqual(calls, [['busy', true], ['inspect', 42], ['refresh', false], ['busy', false]]);
  calls.length = 0;
  await h.gpu(h.render()).props.onRefresh();
  assert.deepEqual(calls, [['busy', true], ['refresh', true], ['busy', false]]);
});

test('App releases action lock on API/refresh failures and blocks mutations with unavailable snapshots', async () => {
  const snapshot = state();
  const calls = [];
  let failApi = true;
  const h = appHarness(snapshot, {
    runGpuInspection: async () => { if (failApi) throw new Error('permission denied'); },
    onActionBusy: value => calls.push(value),
    onRefresh: async () => { throw new Error('snapshot failed'); },
  });
  await assert.rejects(h.gpu(h.render()).props.onDiagnose(), /permission denied/);
  assert.deepEqual(calls, [true, false]);
  failApi = false;
  await assert.rejects(h.gpu(h.render()).props.onDiagnose(), /snapshot failed/);
  assert.deepEqual(calls, [true, false, true, false]);
  assert.equal(h.gpu(h.render()).props.busy, false);
  await assert.rejects(h.gpu(h.render({ snapshotError: 'offline' })).props.onDiagnose(), /当前快照不可用/);
  await assert.rejects(h.gpu(h.render({ mutationBusy: true })).props.onDiagnose(), /其他采集或操作正在执行/);
});

test('offline client refuses GPU diagnosis without transport calls', async () => {
  const client = require('../src/idc-client.ts');
  const before = window.location.protocol;
  window.location.protocol = 'file:';
  try {
    await assert.rejects(async () => client.runGpuInspection(42), error => error.code === 'OFFLINE_DEMO');
  } finally {
    window.location.protocol = before;
  }
});
