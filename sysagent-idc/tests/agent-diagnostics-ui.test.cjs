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
const shared = require('../src/agent-diagnostics-data.ts');
const absolute = path.resolve(__dirname, '../src/AgentDiagnostics.tsx');
const source = fs.readFileSync(absolute, 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  fileName: absolute,
}).outputText;

function diagnostic(overrides = {}) {
  return {
    source: 'agentsight', analyzer: 'sysom-openapi', sampledAt: '2026-11-11T12:00:00Z',
    window: { start: '2026-11-10T12:00:00Z', end: '2026-11-11T12:00:00Z' },
    status: 'ok', outcome: 'observed', summary: 'actual report summary', lastScanAt: null,
    filteredProcesses: null,
    coverage: Object.keys(shared.agentSourceLabels).map(key => ({ key, status: 'available', reason: `actual-${key}` })),
    totals: { sessions: null, inputTokens: null, outputTokens: null, unresolved: null, critical: null, high: null },
    findings: [], processes: [], sessions: [], interruptions: [], latency: [],
    ...overrides,
  };
}
test('service strip distinguishes collection state from data-service connectivity without disclosing deployment or messages', async () => {
  const labels = [['running', '采集中'], ['disabled', '采集停用'], ['failed', '采集失败'], ['unavailable', '采集不可用']];
  const actualLabels = [];
  for (const [state] of labels) {
    const h = harness(undefined, { fetchCollectorStatus: async () => ({ agent_sight: {
      state: 'running', message: 'API 服务可用',
      collection: { state, enabled: state === 'running', scope: state === 'running' ? 'host' : 'none', trace_running: state === 'running', api_running: true, message: `actual collection ${state}` },
    } }) });
    h.render(); h.mount(); await settle();
    const tree = h.render();
    const status = elements(tree, node => node.props.role === 'status' && node.props['aria-label'] === '真实调用采集状态')[0];
    assert(status, 'collection has an accessible status, independent of report outcome');
    const collection = elements(status, node => node.props.className?.split(' ').includes('ad-service-state'))[0];
    assert(collection);
    actualLabels.push([state, text(collection)]);
    assert.match(text(status), /数据服务 可用/);
    assert.doesNotMatch(text(collection), /API|采集完成|\(observed\)/);
    const disclosure = collectionDetails(tree);
    assert.match(text(disclosure), /缺失数据不代表正常.*— 表示未知/);
    assert.match(text(disclosure), /Token 为来源已记录用量，未报告用量可能未计入/);
    assert.equal(text(disclosure).includes('采集停用，当前显示历史记录。'), state === 'disabled');
    assert.doesNotMatch(renderToStaticMarkup(tree), /--enable-agent-collection|主机级采集|本地会话内容保存|actual collection|API 服务可用|SYSOM_AGENTSIGHT_|127\.0\.0\.1:739[67]|CAP_SYS_ADMIN|systemd/);
    assertCompactShell(tree);
    h.unmount();
  }
  for (const fetchCollectorStatus of [async () => ({}), async () => { throw new Error('collector status unavailable'); }]) {
    const h = harness(undefined, { fetchCollectorStatus });
    h.render(); h.mount(); await settle();
    assert.match(text(outsideDetails(h.render())), /采集状态未知/);
    assert.doesNotMatch(text(h.render()), /诊断请求失败/);
    h.unmount();
  }
  assert.deepEqual(actualLabels, labels, 'strip uses the confirmed short collection-state labels');
});

function processEvidence(overrides = {}) {
  return { pid: 801, name: 'actual-cli', role: 'worker', status: 'healthy', ports: [8001], lastCheckAt: null, latencyMs: null, parentPid: null, hasCrash: false, ...overrides };
}
function sessionEvidence(overrides = {}) {
  return { id: 'actual-session', agent: 'actual-agent', model: 'actual-model', conversations: 0, inputTokens: 0, outputTokens: 0, firstSeenAt: null, lastSeenAt: null, ...overrides };
}
function interruption(overrides = {}) {
  return { id: 'actual-event', sessionId: null, callId: null, pid: null, agent: null, type: 'llm_error', severity: 'high', occurredAt: null, resolved: false, ...overrides };
}
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function settle() { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); }

// Load the actual TSX with hook slots, effects and cleanup; no additional renderer dependency.
function harness(fetchAgentDiagnostic = async () => diagnostic(), options = {}) {
  const slots = [];
  const effects = new Map();
  const pendingEffects = [];
  const calls = [];
  const collectorCalls = [];
  const unexpectedClientAccess = [];
  const notifications = [];
  let cursor = 0;
  let writes = 0;
  const hooks = {
    ...React,
    useState(initial) {
      const index = cursor++;
      if (!Object.hasOwn(slots, index)) slots[index] = typeof initial === 'function' ? initial() : initial;
      return [slots[index], value => {
        writes++;
        slots[index] = typeof value === 'function' ? value(slots[index]) : value;
      }];
    },
    useRef(initial) {
      const index = cursor++;
      if (!Object.hasOwn(slots, index)) slots[index] = { current: initial };
      return slots[index];
    },
    useEffect(setup, dependencies) {
      const index = cursor++;
      const previous = effects.get(index);
      if (!previous || !dependencies || dependencies.some((value, i) => !Object.is(value, previous.dependencies[i]))) {
        const effect = { setup, dependencies, cleanup: previous?.cleanup };
        effects.set(index, effect);
        pendingEffects.push(effect);
      }
    },
  };
  const MockModal = ({ title, subtitle, children }) => React.createElement('section', { role: 'dialog' }, React.createElement('h2', null, title), subtitle, children);
  const demoPoison = {
    get agentSummary() { throw new Error('Live UI accessed Demo summary'); },
    formatNumber() { throw new Error('Live UI accessed Demo formatter'); },
  };
  const localRequire = createRequire(absolute);
  const module = { exports: {} };
  const execute = vm.runInThisContext(`(function(require,module,exports){${compiled}\n})`, { filename: absolute });
  execute(id => {
    if (id === 'react') return hooks;
    if (id === './components') return { Modal: MockModal };
    if (id === './idc-client') return new Proxy({
      fetchAgentDiagnostic: refresh => { calls.push(refresh); return fetchAgentDiagnostic(refresh); },
      fetchCollectorStatus: (...args) => { collectorCalls.push(args); return (options.fetchCollectorStatus || (async () => ({})))(...args); },
    }, {
      get(client, key) {
        if (Object.hasOwn(client, key)) return client[key];
        unexpectedClientAccess.push(String(key));
        throw new Error(`Live UI accessed an unauthorized client resource: ${String(key)}`);
      },
    });
    if (id === './agent-summary' && !options.demo) return demoPoison;
    return localRequire(id);
  }, module, module.exports);
  const props = { onNotify: message => notifications.push(message) };
  return {
    calls, collectorCalls, notifications,
    render(overrides = {}) {
      cursor = 0;
      const tree = module.exports.LiveAgentDiagnostics({ ...props, ...overrides });
      assert.deepEqual(unexpectedClientAccess, [], 'live diagnostics may only access report and collector status, never conversation/session or destructive resources');
      return tree;
    },
    renderDemo() { cursor = 0; return module.exports.AgentDiagnostics({ recovered: false, onRestart() {}, ...props }); },
    mount() { for (const effect of pendingEffects.splice(0)) { effect.cleanup?.(); effect.cleanup = effect.setup(); } },
    replayEffects() { for (const effect of effects.values()) { effect.cleanup?.(); effect.cleanup = effect.setup(); } },
    unmount() { for (const effect of effects.values()) effect.cleanup?.(); },
    writes() { return writes; },
  };
}
function elements(element, predicate) {
  if (Array.isArray(element)) return element.flatMap(child => elements(child, predicate));
  if (!React.isValidElement(element)) return [];
  return [...(predicate(element) ? [element] : []), ...elements(element.props.children, predicate)];
}
function text(element) {
  if (Array.isArray(element)) return element.map(text).join('');
  if (React.isValidElement(element)) return text(element.props.children);
  return element == null || typeof element === 'boolean' ? '' : String(element);
}
function button(tree, label) {
  const result = elements(tree, node => node.type === 'button' && (text(node).includes(label) || node.props['aria-label'] === label))[0];
  assert(result, `Missing button: ${label}`);
  return result;
}
function region(tree, label) {
  const result = elements(tree, node => node.props.role === 'region' && node.props['aria-label'] === label)[0];
  assert(result, `Missing region: ${label}`);
  return result;
}
function collectionDetails(tree) {
  const result = elements(tree, node => node.type === 'details' && node.props.className?.split(' ').includes('ad-collection-details'))[0];
  assert(result, 'collection disclosure must be a native details element');
  assert.equal(elements(result, node => node.type === 'summary').length, 1);
  assert.equal(text(elements(result, node => node.type === 'summary')[0]), '数据范围');
  assert(!result.props.open && result.props.defaultOpen !== true, 'data scope is folded by default');
  const ordered = elements(tree, () => true);
  const panel = elements(tree, node => node.props.role === 'tabpanel')[0];
  assert(panel && ordered.indexOf(result) > ordered.indexOf(panel), 'data scope follows the active tab panel');
  assert(!elements(panel, node => node === result).length, 'data scope is not inside the tab panel');
  return result;
}
function outsideDetails(tree) {
  if (Array.isArray(tree)) return tree.map(outsideDetails);
  if (!React.isValidElement(tree)) return tree;
  if (tree.type === 'details') return null;
  return React.cloneElement(tree, {}, outsideDetails(tree.props.children));
}
function stats(tree) {
  const matches = elements(tree, node => node.props.className === 'ad-stats');
  assert.equal(matches.length, 1, 'four metrics exist even before any report');
  const cards = React.Children.toArray(matches[0].props.children);
  assert.equal(cards.length, 4);
  return cards;
}
function statsValues(tree) {
  return stats(tree).map(card => text(elements(card, node => node.type === 'strong')[0]));
}
function tab(tree, label) {
  const result = elements(tree, node => node.props.role === 'tab' && text(node) === label)[0];
  assert(result, `Missing tab: ${label}`);
  assert.equal(typeof result.props.onClick, 'function');
  return result;
}
function selectTab(h, label) {
  tab(h.render(), label).props.onClick();
  const tree = h.render();
  for (const name of ['总览', '会话', '中断', '延迟']) assert.equal(tab(tree, name).props['aria-selected'], name === label);
  const panels = elements(tree, node => node.props.role === 'tabpanel');
  assert.equal(panels.length, 1, 'only the active tab panel is rendered');
  assert.equal(tab(tree, label).props['aria-controls'], panels[0].props.id);
  assert.equal(panels[0].props['aria-labelledby'], tab(tree, label).props.id);
  return tree;
}
function tableRows(tree) {
  return elements(tree, node => node.type === 'tr' && elements(node, cell => cell.type === 'td' && !cell.props.colSpan).length > 0);
}
function assertCompactShell(tree) {
  assert.match(text(tree), /本机 Agent 诊断/);
  stats(tree);
  const all = elements(tree, () => true);
  const beforeMetrics = all.slice(0, all.findIndex(node => node.props.className === 'ad-stats'));
  assert.equal(beforeMetrics.filter(node => node.type === 'p').length, 0, 'no wall of copy ahead of metrics');
  collectionDetails(tree);
  assert.deepEqual(elements(tree, node => node.props.role === 'tab').map(text), ['总览', '会话', '中断', '延迟']);
}
async function loaded(report) {
  const h = harness(async () => report);
  h.render();
  h.mount();
  await settle();
  return h;
}

function control(tree, label) {
  const matches = elements(tree, node => ['input', 'select'].includes(node.type) && node.props['aria-label'] === label);
  assert.equal(matches.length, 1, `Missing or duplicate control: ${label}`);
  return matches[0];
}
function change(h, label, value) {
  control(h.render(), label).props.onChange({ target: { value } });
  return h.render();
}
function processNames(tree) {
  return tableRows(region(tree, '已采集进程探活')).map(row => text(elements(row, node => node.type === 'strong')[0]));
}
function assertProcessPage(tree, page, pages, expected) {
  const pagination = elements(tree, node => node.props['aria-label'] === '进程探活分页')[0];
  assert(pagination);
  assert.match(text(pagination), new RegExp(`第 ${page} / ${pages} 页 · 每页 20 条`));
  assert.equal(button(pagination, '上一页').props.disabled, page === 1);
  assert.equal(button(pagination, '下一页').props.disabled, page === pages);
  assert.deepEqual(processNames(tree), expected.map(process => process.name));
}
function freezeEvidence(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeEvidence(child);
    Object.freeze(value);
  }
  return value;
}
function assertLocalOnly(h, report) {
  const original = structuredClone(report);
  const calls = [...h.calls];
  const collectorCalls = structuredClone(h.collectorCalls);
  const notifications = [...h.notifications];
  const stable = tree => [
    statsValues(tree), text(collectionDetails(tree)),
    text(elements(tree, node => node.props['aria-label'] === '诊断结论')[0]),
    text(elements(tree, node => node.props['aria-label'] === '真实调用采集状态')[0]),
  ];
  const baseline = stable(h.render());
  return () => {
    assert.deepEqual(stable(h.render()), baseline, 'local controls never alter global KPI, conclusion, service state or data scope');
    assert.deepEqual(h.calls, calls, 'local controls do not fetch or refresh the report');
    assert.deepEqual(h.collectorCalls, collectorCalls, 'local controls do not reload service status');
    assert.deepEqual(h.notifications, notifications);
    assert.deepEqual(report, original, 'local controls must not mutate source evidence');
  };
}
function fortyFiveProcesses(overrides = {}) {
  const statuses = Object.keys(shared.agentProcessLabels);
  return Array.from({ length: 45 }, (_, index) => processEvidence({
    pid: 9100 + index, name: `Agent-${String(index + 1).padStart(2, '0')}-${index % 2 ? 'Beta' : 'Alpha'}`,
    role: ['worker', 'supervisor', 'cli'][index % 3], status: statuses[Math.floor(index / 3) % statuses.length],
    hasCrash: index % 4 === 0, ...overrides,
  }));
}

function assertNoDemo(html) {
  assert.doesNotMatch(html, /Cosh|qwen-plus|qwen3\.5|6731|7118|6716d2b5|140740|Demo 模拟|总输入 Token|重启进程|Resolve|Hide/);
}

test('only mounting Live loads cache once; Demo remains independent and live never reads demo summary', async () => {
  const demo = harness(undefined, { demo: true });
  assert.match(renderToStaticMarkup(demo.renderDemo()), /Demo 数据/);
  assert.deepEqual(demo.calls, []);
  const waiting = deferred();
  const h = harness(() => waiting.promise);
  const firstTree = h.render();
  assert.deepEqual(h.calls, []);
  assertCompactShell(firstTree);
  assert.deepEqual(statsValues(firstTree), ['—', '—', '—', '—']);
  assert.equal(tab(firstTree, '总览').props['aria-selected'], true);
  assertNoDemo(renderToStaticMarkup(firstTree));
  h.mount();
  assert.deepEqual(h.calls, [false]);
  await button(firstTree, '开始诊断').props.onClick();
  assert.deepEqual(h.calls, [false], 'a stale button cannot race the mount fetch');
  assert.equal(button(h.render(), '正在更新诊断').props.disabled, true);
  h.render({ onNotify() {} });
  h.mount();
  assert.deepEqual(h.calls, [false], 'parent rerenders do not refetch');
  waiting.resolve(diagnostic());
  await settle();
  assert.match(text(collectionDetails(h.render())), /更新时间2026\/11\/11 20:00:00/);
  assert.doesNotMatch(text(h.render()), /actual report summary/);
  assert.equal(h.notifications.length, 0, 'cached mount is not a manual diagnostic notification');
  assertNoDemo(renderToStaticMarkup(h.render()));
});

test('effect replay shares the component request lock and uses the returned real report', async () => {
  const waiting = deferred();
  const h = harness(() => waiting.promise);
  h.render(); h.mount(); h.replayEffects();
  assert.deepEqual(h.calls, [false]);
  waiting.resolve(diagnostic({ sampledAt: '2026-11-11T05:00:00.000Z', totals: { sessions: 8, inputTokens: 0, outputTokens: 0, unresolved: 0, critical: 0, high: 0 } }));
  await settle();
  assert.match(text(collectionDetails(h.render())), /2026\/11\/11 13:00:00/);
  assert.deepEqual(statsValues(h.render()), ['8', '0', '0', '0']);
  assert.equal(button(h.render(), '刷新诊断').props.disabled, false);
});

test('execution and outcome stay separate; front-loaded conclusion is evidence-scoped and data scope shows only time and five Chinese source states', async () => {
  for (const status of ['ok', 'partial', 'unavailable']) {
    for (const outcome of ['observed', 'abnormal', 'unknown']) {
      const h = await loaded(diagnostic({ status, outcome, lastScanAt: 'actual scan timestamp' }));
      const tree = h.render();
      const details = collectionDetails(tree);
      const output = text(details);
      assertCompactShell(tree);
      const strip = elements(tree, node => node.props['aria-label'] === '真实调用采集状态')[0];
      assert(text(strip).includes({ ok: '采集完成', partial: '部分采集', unavailable: '采集不可用' }[status]));
      const conclusion = elements(tree, node => node.props['aria-label'] === '诊断结论')[0];
      assert(conclusion);
      assert.equal(text(elements(conclusion, node => node.type === 'strong')[0]), outcome === 'abnormal' ? '发现需关注事件' : status === 'ok' && outcome === 'observed' ? '本次证据未发现异常' : '证据不足，暂无法判断');
      if (status === 'ok' && outcome === 'observed') assert.match(text(conclusion), /仅依据本次已采集记录，不代表业务整体正常/);
      const ordered = elements(tree, () => true);
      assert(ordered.indexOf(conclusion) < ordered.findIndex(node => node.props.role === 'tablist'), 'conclusion precedes navigation and evidence');
      assert.deepEqual(elements(details, node => node.type === 'dt').map(text), ['统计时间', '更新时间']);
      assert.match(output, /统计时间2026\/11\/10 20:00:00 — 2026\/11\/11 20:00:00更新时间2026\/11\/11 20:00:00/);
      assert.doesNotMatch(text(outsideDetails(tree)), /2026\/11\/10 20:00:00/);
      const coverage = elements(details, node => node.props.className === 'ad-live-coverage')[0];
      assert.equal(elements(coverage, node => node.type === 'li').length, 5);
      for (const label of Object.values(shared.agentSourceLabels)) assert(output.includes(`${label}：可用`));
      assert.doesNotMatch(text(tree), /actual-|sysom-openapi|agentsight|sampledAt|lastScanAt|执行状态|观测结果|\(observed\)|\(abnormal\)|\(unknown\)|诊断请求失败|业务健康正常/);
      assertNoDemo(renderToStaticMarkup(h.render()));
    }
  }
});

test('zero metrics stay zero and null totals, timestamps and complete-call latency remain missing', async () => {
  const h = await loaded(diagnostic({
    totals: { sessions: 0, inputTokens: null, outputTokens: 0, unresolved: 42, critical: 0, high: null },
    processes: [processEvidence({ latencyMs: 0 })],
    sessions: [sessionEvidence()],
    latency: [{ agent: null, calls: 0, streamingCalls: 0, ttftP95Ms: 0, e2eP95Ms: null, tpsP50: 0, tpotP95Ms: null }],
  }));
  let tree = h.render();
  const cards = stats(tree);
  assert.deepEqual(statsValues(tree), ['0', '—', '0', '42']);
  assert.match(text(cards[3]), /严重 0高危 —/);
  assert.doesNotMatch(text(collectionDetails(tree)), /lastScanAt|已过滤进程/);
  assert.match(text(tree), /匹配 1 \/ 已采集 1 条/);
  const process = tableRows(tree).find(row => text(row).includes('actual-cli'));
  assert(process, 'overview contains actual process evidence in a table');
  assert(elements(process, node => node.type === 'td').some(cell => /(?:^|\s)0 ms$/.test(text(cell))));
  tree = selectTab(h, '会话');
  const sessionCells = elements(tableRows(region(tree, '已采集会话列表'))[0], node => node.type === 'td').map(text);
  assert.deepEqual(sessionCells.slice(1, 8), ['actual-session', 'actual-agent', 'actual-model', '0', '0', '0', '—']);
  button(tree, '展开会话 actual-session').props.onClick();
  assert.match(text(elements(h.render(), node => node.props.className === 'ad-interruption-panel')[0]), /首次出现 — · 最后活跃 —/);
  tree = selectTab(h, '延迟');
  const latency = region(tree, '完整 LLM 调用延迟');
  assert.match(text(latency), /TTFT p95E2E p95TPS p50TPOT p95/);
  const cells = elements(latency, node => node.type === 'td').map(text);
  assert.deepEqual(cells, ['未关联', '0', '0', '0 ms', '— · 未采集', '0 Token/s', '— · 未采集']);
  assert.match(text(tree), /仅统计完整调用.*首 Token 与单 Token 耗时仅针对流式调用/);
  assert.doesNotMatch(text(latency), /故障阈值|业务健康正常/);
  tree = selectTab(h, '中断');
  assert.match(text(tree), /近 24h 未处理 42 · 匹配 0 \/ 已取得明细 0/);
  assert.match(text(tree), /没有已采集的中断明细，不代表全窗口无中断/);
  assert.deepEqual(statsValues(tree), ['0', '—', '0', '42']);
  const allNull = await loaded(diagnostic());
  assert.deepEqual(statsValues(allNull.render()), ['—', '—', '—', '—']);
});

test('latency stays grouped by agent and an available empty array does not fabricate a measurement row', async () => {
  const report = diagnostic({ latency: [
    { agent: null, calls: 0, streamingCalls: 0, ttftP95Ms: null, e2eP95Ms: null, tpsP50: null, tpotP95Ms: null },
    { agent: 'actual-agent-a', calls: 2, streamingCalls: 1, ttftP95Ms: 0, e2eP95Ms: 12, tpsP50: 0, tpotP95Ms: null },
    { agent: 'actual-agent-b', calls: 3, streamingCalls: 0, ttftP95Ms: null, e2eP95Ms: 0, tpsP50: null, tpotP95Ms: null },
  ] });
  const original = structuredClone(report);
  const h = await loaded(report);
  const latency = region(selectTab(h, '延迟'), '完整 LLM 调用延迟');
  const rows = elements(latency, node => node.type === 'tr' && elements(node, cell => cell.type === 'td').length > 0);
  assert.deepEqual(rows.map(row => elements(row, node => node.type === 'td').map(text)), [
    ['未关联', '0', '0', '— · 未采集', '— · 未采集', '— · 未采集', '— · 未采集'],
    ['actual-agent-a', '2', '1', '0 ms', '12 ms', '0 Token/s', '— · 未采集'],
    ['actual-agent-b', '3', '0', '— · 未采集', '0 ms', '— · 未采集', '— · 未采集'],
  ]);
  assert.deepEqual(report, original);
  assert.deepEqual(h.calls, [false]);
  assertNoDemo(renderToStaticMarkup(h.render()));
  const empty = await loaded(diagnostic({ outcome: 'unknown' }));
  const tree = selectTab(empty, '延迟');
  const coverage = elements(tree, node => node.props.className === 'ad-live-coverage')[0];
  const latencySource = elements(coverage, node => node.type === 'li').find(node => text(node).includes(shared.agentSourceLabels.latency));
  assert(latencySource);
  assert.match(text(latencySource), /可用/);
  assert.match(text(tree), /未采集到完整调用的延迟指标/);
  assert.equal(elements(tree, node => node.props.role === 'region' && node.props['aria-label'] === '完整 LLM 调用延迟').length, 0);
  assert.match(text(elements(tree, node => node.props['aria-label'] === '诊断结论')[0]), /证据不足，暂无法判断/);
});

test('latency chart exposes the confirmed accessible metric labels and value keys', async () => {
  const h = await loaded(diagnostic());
  const tree = selectTab(h, '延迟');
  const select = elements(tree, node => node.type === 'select' && node.props['aria-label'] === '对比指标')[0];
  assert(select);
  assert.deepEqual(elements(select, node => node.type === 'option').map(option => [option.props.value, text(option)]), [
    ['e2eP95Ms', '总耗时 P95'], ['ttftP95Ms', '首 Token P95'], ['tpsP50', '生成速度 P50'],
  ]);
});

test('latency chart switches real per-agent measurements locally, preserves null versus zero and scales numeric widths', async () => {
  const report = diagnostic({ latency: [
    { agent: null, calls: 0, streamingCalls: 0, ttftP95Ms: null, e2eP95Ms: null, tpsP50: null, tpotP95Ms: null },
    { agent: 'actual-agent-a', calls: 2, streamingCalls: 1, ttftP95Ms: 0, e2eP95Ms: 40, tpsP50: 8, tpotP95Ms: null },
    { agent: 'actual-agent-b', calls: 3, streamingCalls: 0, ttftP95Ms: 20, e2eP95Ms: 10, tpsP50: 0, tpotP95Ms: 0 },
    { agent: 'actual-agent-c', calls: 1, streamingCalls: 1, ttftP95Ms: 5, e2eP95Ms: 0, tpsP50: null, tpotP95Ms: 2 },
  ] });
  const original = structuredClone(report);
  const h = await loaded(report);
  const baselineCollectorCalls = h.collectorCalls.length;
  let tree = selectTab(h, '延迟');
  const select = () => elements(h.render(), node => node.type === 'select' && node.props['aria-label'] === '对比指标')[0];
  assert(select(), 'chart has an accessible metric select');
  assert.equal(select().props.value, 'e2eP95Ms');
  assert.deepEqual(elements(select(), node => node.type === 'option').map(option => option.props.value), ['e2eP95Ms', 'ttftP95Ms', 'tpsP50']);
  const originalTable = elements(region(tree, '完整 LLM 调用延迟'), node => node.type === 'td').map(text);
  const expected = [
    ['e2eP95Ms', ['— · 未采集', '40 ms', '10 ms', '0 ms'], [0, 100, 25, 0]],
    ['ttftP95Ms', ['— · 未采集', '0 ms', '20 ms', '5 ms'], [0, 0, 100, 25]],
    ['tpsP50', ['— · 未采集', '8 Token/s', '0 Token/s', '— · 未采集'], [0, 100, 0, 0]],
  ];
  for (const [metric, measurements, widths] of expected) {
    select().props.onChange({ target: { value: metric } });
    tree = h.render();
    assert.equal(select().props.value, metric);
    const chart = elements(tree, node => node.props.className?.split(' ').includes('ad-latency-chart'))[0];
    assert(chart);
    const rows = elements(chart, node => node.props.className === 'ad-bar-row');
    assert.equal(rows.length, report.latency.length, 'one independent row per reported Agent, including unassociated evidence');
    assert.deepEqual(rows.map(row => text(elements(row, node => node.type === 'strong')[0])), ['未关联', 'actual-agent-a', 'actual-agent-b', 'actual-agent-c']);
    for (const [index, row] of rows.entries()) {
      assert(text(row).endsWith(measurements[index]));
      const bars = elements(row, node => node.props.style && Object.hasOwn(node.props.style, 'width'));
      if (report.latency[index][metric] === null && bars.length === 0) continue;
      assert.equal(bars.length, 1);
      assert.match(bars[0].props.style.width, /^\d+(?:\.\d+)?%$/);
      assert.equal(Number.parseFloat(bars[0].props.style.width), widths[index], 'width derives only from the selected measurement');
    }
    assert.deepEqual(elements(region(tree, '完整 LLM 调用延迟'), node => node.type === 'td').map(text), originalTable, 'chart selection never modifies seven-column evidence');
    assert.deepEqual(statsValues(tree), ['—', '—', '—', '—']);
  }
  tree = selectTab(h, '总览');
  assert.equal(select().props.value, 'tpsP50', 'local chart choice remains on returning to overview');
  assert.deepEqual(h.calls, [false]);
  assert.equal(h.collectorCalls.length, baselineCollectorCalls);
  assert.deepEqual(h.notifications, []);
  assert.deepEqual(report, original);
  assertNoDemo(renderToStaticMarkup(tree));
  const zeros = await loaded(diagnostic({ latency: [{ agent: 'zero-agent', calls: 0, streamingCalls: 0, ttftP95Ms: 0, e2eP95Ms: 0, tpsP50: 0, tpotP95Ms: 0 }] }));
  const zeroChart = elements(selectTab(zeros, '延迟'), node => node.props.className?.split(' ').includes('ad-latency-chart'))[0];
  assert.match(text(zeroChart), /zero-agent0 ms/);
  assert.deepEqual(elements(zeroChart, node => node.props.style && Object.hasOwn(node.props.style, 'width')).map(node => node.props.style.width), ['0%'], 'all-zero data never divides by zero or invents a positive bar');
});

test('process evidence does not equate HTTP response with business health, CLI with failure, offline with crash or timeout with loops', async () => {
  const h = await loaded(diagnostic({ processes: Object.keys(shared.agentProcessLabels).map((status, index) => processEvidence({
    pid: 801 + index, name: `actual-${status}`, status, ports: status === 'no_port' ? [] : [8100],
    hasCrash: status === 'unhealthy', lastCheckAt: '2026-11-11T02:00:00.000Z',
  })) }));
  const tree = h.render();
  assert.equal(elements(tree, node => node.type === 'section' && node.props.className?.includes('ad-live-process')).length, 0, 'old process cards are not the compact live UI');
  const notes = {
    healthy: '仅表示 HTTP 有响应，不代表业务健康。',
    unhealthy: '端口不可达，未推断具体业务故障。',
    hung: '仅表示 HTTP 响应超时，不等同于死循环。',
    unknown: '暂无探活结果，不能判定业务健康。',
    no_port: '正常 CLI 可无监听端口，不据此判定故障。',
    offline: '进程已退出，不能仅据此判定崩溃。',
  };
  const rows = tableRows(tree).filter(row => text(row).includes('actual-'));
  assert.equal(rows.length, 6);
  for (const [index, status] of Object.keys(shared.agentProcessLabels).entries()) {
    const row = rows.find(item => text(item).includes(`actual-${status}`));
    assert(row);
    const tooltip = elements(row, node => typeof node.props.title === 'string' && node.props.title.includes(notes[status]))[0];
    assert(tooltip, `process ${status} has its liveProcessNotes tooltip`);
    assert(text(tooltip).includes(shared.agentProcessLabels[status]));
    assert(text(row).includes(String(801 + index)));
    assert.match(text(row), /未关联.*— · 未采集.*2026\/11\/11 10:00:00/);
    assert.equal(elements(row, node => node.type === 'button').length, 0);
    assert.doesNotMatch(text(row), /业务健康正常|死循环检测|进程崩溃|lastCheckAt|hasCrash/);
    assert(!text(row).includes(notes[status]), 'health interpretation stays in the tooltip, not repeated in every row');
    assert.equal(text(row).includes('有崩溃记录'), status === 'unhealthy', 'only reported true hasCrash is displayed');
  }
  assert.match(text(rows.find(row => text(row).includes('actual-no_port'))), /无/);
  assert.match(text(rows.find(row => text(row).includes('actual-unhealthy'))), /有崩溃记录/);
  assert.doesNotMatch(text(rows.find(row => text(row).includes('actual-offline'))), /有崩溃记录|false|未报告崩溃证据/);
});

test('truncated, invalid and unavailable sources retain distinct Chinese states without exposing reasons or inventing evidence', async () => {
  const h = await loaded(diagnostic({ status: 'unavailable', outcome: 'unknown',
    coverage: Object.keys(shared.agentSourceLabels).map((key, i) => ({ key, status: ['unavailable', 'truncated', 'invalid'][i % 3], reason: `limited-${key}` })),
  }));
  const tree = h.render();
  const output = text(tree);
  const disclosure = text(collectionDetails(tree));
  assert.match(disclosure, /进程探活：未取得数据/);
  assert.match(disclosure, /会话与 Token：明细不完整/);
  assert.match(disclosure, /中断明细：数据无法使用/);
  assert.doesNotMatch(output, /limited-|\(unavailable\)|\(truncated\)|\(invalid\)/);
  assert.match(output, /没有已采集的进程记录/);
  assert.match(text(selectTab(h, '会话')), /没有已采集的会话记录/);
  assert.match(text(selectTab(h, '中断')), /没有已采集的中断明细/);
  assert.match(text(selectTab(h, '延迟')), /未采集到完整调用的延迟指标/);
  assert.match(output, /证据不足，暂无法判断/);
  assert.match(disclosure, /缺失数据不代表正常/);
  assert.doesNotMatch(output, /诊断请求失败/);
  assertNoDemo(renderToStaticMarkup(tree));
  const missing = await loaded(diagnostic({ coverage: [] }));
  const list = elements(missing.render(), node => node.props.className === 'ad-live-coverage')[0];
  assert.equal(elements(list, node => node.type === 'li').length, 5);
  assert.equal(elements(list, node => node.type === 'li').filter(node => text(node).includes('数据范围未知')).length, 5);
});

test('available-but-empty sources remain distinct from unavailable sources and neither fabricates evidence', async () => {
  for (const available of [true, false]) {
    const report = diagnostic({ status: available ? 'ok' : 'unavailable', outcome: 'unknown',
      coverage: Object.keys(shared.agentSourceLabels).map(key => ({ key, status: available ? 'available' : 'unavailable', reason: available ? `empty-success-${key}` : `not-running-${key}` })),
    });
    const h = await loaded(report);
    const baselineCollectorCalls = h.collectorCalls.length;
    const details = collectionDetails(h.render());
    const coverage = elements(details, node => node.props.className === 'ad-live-coverage')[0];
    for (const key of Object.keys(shared.agentSourceLabels)) {
      const item = elements(coverage, node => node.type === 'li').find(node => text(elements(node, child => child.type === 'strong')[0]) === shared.agentSourceLabels[key]);
      assert(item);
      assert.equal(text(elements(item, node => node.type === 'span')[0]), `${shared.agentSourceLabels[key]}：${available ? '可用' : '未取得数据'}`);
      assert.doesNotMatch(text(item), /empty-success|not-running/);
    }
    for (const label of ['总览', '会话', '中断', '延迟']) {
      const tree = selectTab(h, label);
      assert.deepEqual(statsValues(tree), ['—', '—', '—', '—']);
      assert.doesNotMatch(text(tree), /业务健康正常|本次未发现异常|诊断请求失败/);
      assertNoDemo(renderToStaticMarkup(tree));
    }
    assert.equal(elements(h.render(), node => node.props['aria-label'] === '完整 LLM 调用延迟').length, 0);
    assert.deepEqual(h.calls, [false]);
    assert.equal(h.collectorCalls.length, baselineCollectorCalls);
  }
  for (const status of ['available', 'unavailable']) {
    const h = await loaded(diagnostic({ coverage: Object.keys(shared.agentSourceLabels).map(key => ({ key, status, reason: '' })) }));
    const coverage = elements(collectionDetails(h.render()), node => node.props.className === 'ad-live-coverage')[0];
    assert.equal(elements(coverage, node => node.type === 'li').filter(node => text(node).includes(status === 'available' ? '：可用' : '：未取得数据')).length, 5);
    assert.doesNotMatch(text(coverage), /原因|available|unavailable/);
  }
});

test('sessions search Agent, ID and Model locally, sort by last activity, and expand only linked interruption metadata', async () => {
  const report = diagnostic({ totals: { sessions: 99, inputTokens: 1000, outputTokens: 200, unresolved: 73, critical: 50, high: 23 },
    sessions: [
      sessionEvidence({ id: 'older-id', agent: 'Older-Agent', model: 'older-model', lastSeenAt: '2026-11-10T13:00:00Z' }),
      sessionEvidence({ id: 'unknown-time', agent: null, model: null }),
      sessionEvidence({ id: 'newer-id', agent: 'Newer-Agent', model: 'newer-model', lastSeenAt: '2026-11-11T11:00:00Z' }),
    ],
    interruptions: [interruption({ id: 'linked-new', sessionId: 'newer-id' }), interruption({ id: 'linked-old', sessionId: 'older-id' }), interruption({ id: 'unlinked-event' })],
  });
  const h = await loaded(report);
  let tree = selectTab(h, '会话');
  const initialStats = statsValues(tree);
  const initialCollectorCalls = h.collectorCalls.length;
  const ids = elements(region(tree, '已采集会话列表'), node => node.type === 'tr' && node.props.className !== undefined).map(row => text(row.props.children[1]));
  assert.deepEqual(ids, ['newer-id', 'older-id', 'unknown-time']);
  const search = () => elements(h.render(), node => node.type === 'input' && node.props.type === 'search')[0];
  for (const query of ['NEWER-AGENT', 'newer-id', 'newer-model']) {
    search().props.onChange({ target: { value: query } });
    tree = h.render();
    const list = region(tree, '已采集会话列表');
    assert.match(text(list), /newer-id/);
    assert.doesNotMatch(text(list), /older-id|unknown-time/);
    assert.match(text(tree), /已采集会话数.*输入 Token/);
    assert.deepEqual(statsValues(tree), initialStats, 'filtering never recalculates aggregate totals');
    assert.deepEqual(statsValues(tree), ['99', '1,000', '200', '73']);
  }
  search().props.onChange({ target: { value: '' } });
  button(h.render(), '展开会话 newer-id').props.onClick();
  tree = h.render();
  const panel = elements(tree, node => node.props.className === 'ad-interruption-panel')[0];
  assert.match(text(panel), /linked-new/);
  assert.doesNotMatch(text(panel), /linked-old|unlinked-event/);
  assert.equal(button(tree, '收起会话 newer-id').props['aria-expanded'], true);
  button(tree, '展开会话 unknown-time').props.onClick();
  assert.match(text(elements(h.render(), node => node.props.className === 'ad-interruption-panel')[0]), /无此会话关联事件，不代表全窗口无中断/);
  search().props.onChange({ target: { value: 'not-found' } });
  assert.match(text(h.render()), /没有匹配的会话/);
  assert.deepEqual(statsValues(h.render()), initialStats);
  assert.deepEqual(h.calls, [false], 'search and expand never fetch session or conversation resources');
  assert.equal(h.collectorCalls.length, initialCollectorCalls, 'local search and expansion do not reload collector status');
  assert.deepEqual(report.sessions.map(item => item.id), ['older-id', 'unknown-time', 'newer-id'], 'sorting must not mutate report');
});

test('incident tab groups five compact columns and keeps full linkage in read-only evidence', async () => {
  const h = await loaded(diagnostic({ interruptions: [
    interruption({ id: 'compact-linked-event', sessionId: 'unknown-session', agent: 'actual-agent', occurredAt: '2026-11-11T03:30:00.000Z', callId: 'modal-only-call', pid: 812 }),
    interruption({ id: 'compact-unlinked-event', type: 'user_cancel', severity: 'low' }),
  ] }));
  const list = region(selectTab(h, '中断'), '已采集中断元数据');
  const headers = elements(list, node => node.type === 'th').map(text);
  assert.equal(headers.length, 5);
  assert.deepEqual(headers, ['事件 / Agent', '严重度', '处理状态', '发生时间', '证据']);
  const rows = tableRows(list);
  assert.equal(rows.length, 2);
  assert(rows.every(row => elements(row, node => node.type === 'td').length === 5));
  const cells = rows.map(row => elements(row, node => node.type === 'td').map(text));
  assert.match(cells[0][0], /模型调用错误.*actual-agent.*compact-linked-event/);
  assert.deepEqual(cells[0].slice(1, 4), ['高危', '未处理', '2026/11/11 11:30:00']);
  assert.match(cells[1][0], /用户取消.*未关联/);
  assert.deepEqual(cells[1].slice(1, 4), ['低', '未处理', '—']);
  assert.doesNotMatch(text(list), /modal-only-call|812|unknown-session/, 'verbose evidence fields stay in the existing Modal');
  button(list, '查看中断证据 compact-linked-event').props.onClick();
  const modal = elements(h.render(), node => node.props.subtitle === '本地报告已有证据 · 只读')[0];
  assert.match(text(modal), /unknown-session.*modal-only-call.*812/);
  button(list, '查看中断证据 compact-unlinked-event');
});

test('all interruption types use mappings or escaped raw text, including prototype keys; unlinked evidence Modal stays read-only', async () => {
  const unsafe = '<script>alert("event")</script>';
  const h = await loaded(diagnostic({
    summary: '<b>summary & evidence</b>',
    findings: [{ severity: 'warning', title: '<img src=x onerror=1>', detail: '<svg>detail</svg>', suggestion: '<script>suggestion</script>' }],
    processes: [processEvidence({ name: '<b>actual-name</b>' })],
    interruptions: [
      ...Object.keys(shared.agentInterruptionLabels).map((type, index) => interruption({ type, id: `mapped-${index}`, severity: ['critical', 'high', 'medium', 'low'][index % 4] })),
      interruption({ id: 'unsafe-event', type: unsafe, agent: '<img>agent', sessionId: null, callId: null, pid: 0 }),
      ...['__proto__', 'constructor', 'toString', 'future-type'].map(type => interruption({ id: `raw-${type}`, type })),
      interruption({ id: 'not-in-session-list', sessionId: 'unknown-session' }),
    ],
  }));
  const overviewHtml = renderToStaticMarkup(h.render());
  let tree = selectTab(h, '中断');
  const list = region(tree, '已采集中断元数据');
  for (const label of Object.values(shared.agentInterruptionLabels)) assert(text(list).includes(label));
  for (const raw of ['__proto__', 'constructor', 'toString', 'future-type', unsafe]) assert(text(list).includes(raw));
  for (const [index, label] of ['严重', '高危', '中', '低'].entries()) {
    const row = tableRows(list).find(item => elements(item, node => node.props['aria-label'] === `查看中断证据 mapped-${index}`).length);
    assert(row);
    const severityCell = elements(row, node => node.type === 'td')[1];
    assert.equal(text(severityCell), label);
    assert.doesNotMatch(text(severityCell), /critical|high|medium|low/);
  }
  button(tree, '查看中断证据 unsafe-event').props.onClick();
  tree = h.render();
  const modal = elements(tree, node => typeof node.type === 'function' && node.props.subtitle === '本地报告已有证据 · 只读')[0];
  assert(modal);
  assert.equal(modal.props.title, `${unsafe} · 高危`);
  const fields = elements(modal, node => node.type === 'dt').map(text);
  const values = elements(modal, node => node.type === 'dd').map(text);
  assert.deepEqual(fields, ['事件 ID', '类型', '严重度', '发生时间', 'Session ID', 'Call ID', 'PID', 'Agent', '处理状态']);
  assert.deepEqual(values, ['unsafe-event', `${unsafe} (${unsafe})`, '高危', '—', '未关联', '未关联', '0', '<img>agent', '未处理']);
  assert.equal(text(elements(modal, node => node.props.className === 'ad-modal-note')[0]), '仅展示本次报告已有证据，未确认故障根因。');
  assert.deepEqual(elements(modal, node => node.type === 'button').map(text), ['关闭']);
  const html = renderToStaticMarkup(tree);
  assert.match(html, /&lt;script&gt;alert\(&quot;event&quot;\)&lt;\/script&gt;/);
  assert.doesNotMatch(html + overviewHtml, /summary &amp; evidence|img src=x onerror=1|svg&gt;detail|script&gt;suggestion/, 'summary and findings are not exposed even as escaped text');
  assert.match(overviewHtml, /&lt;b&gt;actual-name&lt;\/b&gt;/);
  assert.doesNotMatch(html + overviewHtml, /<script>|<img|<b>actual-name|<svg>detail/);
  assertNoDemo(html);
  assert.deepEqual(h.calls, [false]);
  button(modal, '关闭').props.onClick();
  assert.equal(elements(h.render(), node => node.props.subtitle === '本地报告已有证据 · 只读').length, 0);
  assert.doesNotMatch(text(collectionDetails(tree)), /对话|会话资源|部署|权限/);
  assert.match(text(modal), /仅展示本次报告已有证据，未确认故障根因/);
  assert.deepEqual(h.collectorCalls.length, 2, 'evidence viewing makes no conversation, session or service request');
});

test('default overview is compact; accessible tabs isolate session, incident and latency tables without requests', async () => {
  const report = diagnostic({
    processes: [processEvidence()], sessions: [sessionEvidence({ conversations: 7, inputTokens: 125, outputTokens: 64, lastSeenAt: '2026-11-11T04:00:00.000Z' })],
    interruptions: [interruption({ id: 'overview-event', agent: 'actual-agent', occurredAt: '2026-11-11T03:00:00.000Z' })],
    latency: [{ agent: 'actual-agent', calls: 3, streamingCalls: 2, ttftP95Ms: 12, e2eP95Ms: 24, tpsP50: 8, tpotP95Ms: 2 }],
  });
  const original = structuredClone(report);
  const h = await loaded(report);
  const baselineCollectorCalls = h.collectorCalls.length;
  let tree = h.render();
  assertCompactShell(tree);
  assert.equal(tab(tree, '总览').props['aria-selected'], true);
  assert.equal(elements(tree, node => node.type === 'input' && node.props['aria-label'] === '搜索进程名或 PID').length, 1);
  assert.equal(elements(tree, node => node.props['aria-label'] === '搜索会话 Agent / ID / Model').length, 0);
  assert.equal(elements(tree, node => node.props['aria-label'] === '已采集会话列表').length, 0);
  assert.equal(elements(tree, node => node.props['aria-label'] === '完整 LLM 调用延迟').length, 0);
  assert(tableRows(tree).some(row => text(row).includes('actual-cli')), 'overview contains a process table');
  const incident = button(tree, '查看事件证据 llm_error');
  assert.match(text(incident), /高危.*模型调用错误 · 1 条/);
  assert.doesNotMatch(text(incident), /overview-event|actual-agent|2026\/11\/11 11:00:00/);
  assert.equal(elements(incident, node => node.type === 'p').length, 0, 'overview incidents stay compact');
  assert(elements(tree, node => node.props.role === 'img' || node.type === 'svg' || node.props.className?.includes('chart')).length, 'overview contains a chart');
  tree = selectTab(h, '会话');
  const sessionList = region(tree, '已采集会话列表');
  const cells = elements(tableRows(sessionList)[0], node => node.type === 'td').map(text);
  assert(cells.includes('actual-session'));
  assert(cells.includes('7') && cells.includes('125') && cells.includes('64') && cells.includes('2026/11/11 12:00:00'));
  assert.equal(elements(tree, node => node.type === 'input' && node.props.type === 'search').length, 1);
  for (const label of ['中断', '延迟', '总览']) {
    tree = selectTab(h, label);
    assert.equal(elements(tree, node => node.props['aria-label'] === '已采集会话列表').length, 0);
    assert.equal(elements(tree, node => node.type === 'input' && node.props.type === 'search').length, label === '总览' ? 1 : 0);
    assertCompactShell(tree);
  }
  assert.deepEqual(report, original);
  assert.deepEqual(h.calls, [false]);
  assert.equal(h.collectorCalls.length, baselineCollectorCalls);
  assert.deepEqual(h.notifications, []);
});

test('incident Modal preserves existing evidence and navigates only to an actually collected linked session', async () => {
  const sessionId = 'linked-full-session-0123456789-abcdef';
  const event = interruption({ id: 'linked-evidence', sessionId, callId: 'actual-call-id', pid: 812, agent: 'actual-agent', occurredAt: '2026-11-11T01:00:00.000Z', resolved: true });
  const report = diagnostic({ sessions: [sessionEvidence({ id: sessionId }), sessionEvidence({ id: 'other-session' })], interruptions: [event, interruption({ id: 'missing-session-evidence', sessionId: 'missing-session' })] });
  const original = structuredClone(report);
  const h = await loaded(report);
  const baselineCollectorCalls = h.collectorCalls.length;
  let tree = selectTab(h, '中断');
  button(tree, '查看中断证据 linked-evidence').props.onClick();
  tree = h.render();
  let modal = elements(tree, node => node.props.subtitle === '本地报告已有证据 · 只读')[0];
  assert(modal);
  assert.deepEqual(elements(modal, node => node.type === 'dd').map(text), ['linked-evidence', '模型调用错误 (llm_error)', '高危', '2026/11/11 09:00:00', sessionId, 'actual-call-id', '812', 'actual-agent', '已处理（来源记录）']);
  button(modal, '查看关联会话').props.onClick();
  tree = h.render();
  assert.equal(tab(tree, '会话').props['aria-selected'], true);
  assert.equal(elements(tree, node => node.type === 'input' && node.props.type === 'search')[0].props.value, sessionId);
  assert.equal(button(tree, `收起会话 ${sessionId}`).props['aria-expanded'], true);
  assert.match(text(region(tree, '已采集会话列表')), /linked-evidence/);
  assert.doesNotMatch(text(region(tree, '已采集会话列表')), /other-session/);
  assert.equal(elements(tree, node => node.props.subtitle === '本地报告已有证据 · 只读').length, 0);
  tree = selectTab(h, '中断');
  button(tree, '查看中断证据 missing-session-evidence').props.onClick();
  modal = elements(h.render(), node => node.props.subtitle === '本地报告已有证据 · 只读')[0];
  assert(modal);
  assert.match(text(modal), /missing-session/);
  assert.equal(elements(modal, node => node.type === 'button' && text(node).includes('查看关联会话')).length, 0);
  assert.deepEqual(elements(modal, node => node.type === 'button').map(text), ['关闭']);
  button(modal, '关闭').props.onClick();
  assert.deepEqual(h.calls, [false]);
  assert.equal(h.collectorCalls.length, baselineCollectorCalls);
  assert.deepEqual(h.notifications, []);
  assert.deepEqual(report, original, 'viewing resolved evidence never changes source records');
});

test('refresh is Promise-locked, retains the old report on API failure, then retries with refresh=true', async () => {
  const waiting = deferred();
  let stage = 0;
  const h = harness(async refresh => {
    if (!refresh) return diagnostic({ processes: [processEvidence({ name: 'retained actual evidence' })], totals: { sessions: 11, inputTokens: 0, outputTokens: null, unresolved: 4, critical: 1, high: 3 } });
    stage++;
    if (stage === 1) return waiting.promise;
    return diagnostic({ processes: [processEvidence({ name: 'new actual evidence' })], sampledAt: '2026-11-11T06:00:00.000Z', totals: { sessions: 12, inputTokens: 100, outputTokens: 0, unresolved: 0, critical: 0, high: 0 } });
  });
  h.render(); h.mount(); await settle();
  const trigger = button(h.render(), '刷新诊断');
  const pending = trigger.props.onClick();
  await trigger.props.onClick();
  assert.deepEqual(h.calls, [false, true]);
  assert.equal(button(h.render(), '正在更新诊断').props.disabled, true);
  assert.match(text(outsideDetails(h.render())), /以下为上次报告，尚未更新/);
  assert.match(text(region(h.render(), '已采集进程探活')), /retained actual evidence/);
  assert.deepEqual(statsValues(h.render()), ['11', '0', '—', '4']);
  const collectorCallsWhileBusy = h.collectorCalls.length;
  assert.deepEqual(statsValues(selectTab(h, '会话')), ['11', '0', '—', '4']);
  assert.deepEqual(statsValues(selectTab(h, '总览')), ['11', '0', '—', '4']);
  assert.equal(h.collectorCalls.length, collectorCallsWhileBusy, 'tabs are local even during refresh');
  waiting.reject(new Error('<script>OpenAPI unavailable</script>'));
  await pending;
  let tree = h.render();
  assert.match(text(outsideDetails(tree)), /旧结果：刷新失败/);
  assert.match(text(region(tree, '已采集进程探活')), /retained actual evidence/);
  assert.match(text(collectionDetails(tree)), /2026\/11\/11 20:00:00/);
  assert.deepEqual(statsValues(tree), ['11', '0', '—', '4']);
  assert.match(text(elements(tree, node => node.props.role === 'alert')[0]), /暂时无法更新诊断，请稍后重试/);
  assert.doesNotMatch(renderToStaticMarkup(tree), /OpenAPI unavailable|&lt;script&gt;/);
  assert.equal(button(tree, '刷新诊断').props.disabled, false);
  assertNoDemo(renderToStaticMarkup(tree));
  await button(tree, '刷新诊断').props.onClick();
  tree = h.render();
  assert.deepEqual(h.calls, [false, true, true]);
  assert.match(text(region(tree, '已采集进程探活')), /new actual evidence/);
  const refreshedCoverage = elements(collectionDetails(tree), node => node.props.className === 'ad-live-coverage')[0];
  assert.equal(elements(refreshedCoverage, node => node.type === 'li').length, 5);
  for (const label of Object.values(shared.agentSourceLabels)) assert(text(refreshedCoverage).includes(`${label}：可用`));
  assert.match(text(collectionDetails(tree)), /2026\/11\/11 14:00:00/);
  assert.deepEqual(statsValues(tree), ['12', '100', '0', '0']);
  assert.doesNotMatch(text(tree), /OpenAPI unavailable|旧结果|retained actual evidence/);
  assert.equal(h.notifications.length, 1);
});

test('API failure without a report gives only a fixed safe retry prompt without deployment details or Demo fallback', async () => {
  let fail = true;
  const h = harness(async () => {
    if (fail) throw new Error('OpenAPI connection refused');
    return diagnostic({ status: 'unavailable', outcome: 'unknown', summary: 'AgentSight unavailable report', coverage: Object.keys(shared.agentSourceLabels).map(key => ({ key, status: 'unavailable', reason: 'AgentSight not running' })) });
  });
  h.render(); h.mount(); await settle();
  let tree = h.render();
  assert.equal(text(elements(elements(tree, node => node.props.role === 'alert')[0], node => node.type === 'strong')[0]), '暂时无法更新诊断，请稍后重试。');
  const disclosure = collectionDetails(tree);
  assert.match(text(disclosure), /尚未取得诊断数据/);
  assert.doesNotMatch(renderToStaticMarkup(tree), /OpenAPI connection refused|127\.0\.0\.1:739[67]|SYSOM_AGENTSIGHT_|CAP_SYS_ADMIN|systemd|开机自启|\/var\/lib\/sysom-agentsight|root|50 MiB|WAL|未授权|用户配置|联网下载|模型调用/);
  assert.match(text(tree), /尚未取得本机报告/);
  assertCompactShell(tree);
  assert.deepEqual(statsValues(tree), ['—', '—', '—', '—']);
  assert.deepEqual(elements(tree, node => node.type === 'button' && node.props.role !== 'tab').map(text), ['重试诊断']);
  assertNoDemo(renderToStaticMarkup(tree));
  fail = false;
  await button(tree, '重试诊断').props.onClick();
  tree = h.render();
  assert.deepEqual(h.calls, [false, true]);
  assert.doesNotMatch(text(tree), /AgentSight unavailable report|AgentSight not running/);
  assert.match(text(tree), /采集不可用/);
  assert.match(text(tree), /证据不足，暂无法判断/);
  assert.doesNotMatch(text(tree), /诊断请求失败|connection refused/);
  assert.equal(elements(tree, node => node.props.className === 'ad-stats').length, 1);
});

test('empty or non-Error API failures still show a retryable error rather than hiding the failure', async () => {
  for (const failure of [new Error(''), '', null, { reason: 'transport rejected' }]) {
    const h = harness(async () => { throw failure; });
    h.render(); h.mount(); await settle();
    const tree = h.render();
    assert.equal(text(elements(elements(tree, node => node.props.role === 'alert')[0], node => node.type === 'strong')[0]), '暂时无法更新诊断，请稍后重试。');
    assert.doesNotMatch(renderToStaticMarkup(tree), /transport rejected|\[object Object\]|rawerror/);
    assert.equal(button(tree, '重试诊断').props.disabled, false);
    assertCompactShell(tree);
    assert.deepEqual(statsValues(tree), ['—', '—', '—', '—']);
    assertNoDemo(renderToStaticMarkup(tree));
  }
});

test('mount and refresh completions do not write state or notify after cleanup, whether resolved or rejected', async () => {
  for (const refresh of [false, true]) {
    for (const rejected of [false, true]) {
      const waiting = deferred();
      const h = harness(async isRefresh => refresh && !isRefresh ? diagnostic() : waiting.promise);
      h.render(); h.mount();
      let pending;
      if (refresh) {
        await settle();
        pending = button(h.render(), '刷新诊断').props.onClick();
      }
      const oldButton = button(h.render(), '正在更新诊断');
      h.unmount();
      const before = h.writes();
      if (rejected) waiting.reject(new Error('late failure'));
      else waiting.resolve(diagnostic({ summary: 'late report' }));
      if (pending) await pending;
      await settle();
      assert.equal(h.writes(), before, `post-cleanup state update: refresh=${refresh}, rejected=${rejected}`);
      assert.deepEqual(h.notifications, []);
      const beforeCalls = [...h.calls];
      await oldButton.props.onClick();
      assert.deepEqual(h.calls, beforeCalls, 'an unmounted component cannot start another request');
    }
  }
});

test('collector status resolution or failure cannot write state after unmount', async () => {
  for (const rejected of [false, true]) {
    const waiting = deferred();
    const h = harness(undefined, { fetchCollectorStatus: () => waiting.promise });
    h.render(); h.mount(); await settle();
    const beforeCalls = [...h.calls];
    h.unmount();
    const beforeWrites = h.writes();
    if (rejected) waiting.reject(new Error('late service failure'));
    else waiting.resolve({ agent_sight: { state: 'running', collection: { state: 'running', message: 'late service evidence' } } });
    await settle();
    assert.equal(h.writes(), beforeWrites);
    assert.deepEqual(h.calls, beforeCalls);
    assert.deepEqual(h.notifications, []);
  }
});

test('live implementation uses only the report client, no direct transport, destructive controls or demo constants; small styles stay scoped', () => {
  const liveSource = source.slice(source.indexOf('const liveSeverityLabels'));
  assert.match(source, /import \{ fetchAgentDiagnostic, fetchCollectorStatus \} from '\.\/idc-client'/);
  assert.match(source, /import type \{ AgentDiagnostic, AgentInterruptionEvidence/);
  assert.match(liveSource, /fetchAgentDiagnostic\(refresh\)/);
  assert.match(liveSource, /loadReport\(false\)/);
  assert.doesNotMatch(liveSource, /dangerouslySetInnerHTML|\bfetch\s*\(|XMLHttpRequest|axios|agentSummary|formatNumber|navigator|setTimeout|restartProcess|resolvedIds|onRestart|exe_path|access_token/);
  assert.doesNotMatch(liveSource, /fetch(?:Session|Conversation)|get(?:Session|Conversation)|report\.(?:summary|findings)|coverage\.reason|collection\.message|service\??\.message|error\.message/);
  assert.doesNotMatch(liveSource, /Cosh|qwen-plus|6731|7118|140740|Resolve|Hide/);
  const css = fs.readFileSync(path.resolve(__dirname, '../src/styles/app.css'), 'utf8');
  const additions = css.slice(css.indexOf('/* Real Agent diagnostics:'));
  assert.match(additions, /\.ad-live \{[^}]*min-width: 0;[^}]*max-width: 100%;/);
  assert.match(additions, /\.ad-live \.ad-session-table \{[^}]*min-width: 0;[^}]*max-width: 100%;/);
  assert.match(css, /\.ad-session-table \{[^}]*overflow-x: auto;/);
  assert.match(additions, /\.ad-live \.ad-session-table th, \.ad-live \.ad-session-table td \{[^}]*white-space: normal;/);
  assert.match(additions, /\[aria-label="已采集会话列表"\] > table \{ min-width: 1000px; \}/);
  assert.match(additions, /\[aria-label="已采集会话列表"\] > table > thead > tr > th:first-child \{ width: 40px; \}/);
  assert.match(css, /@media \(max-width: 600px\) \{\s*body \{\s*min-width: 0;/);
  assert.match(additions, /\.ad-live-meta \{ grid-template-columns: 1fr; \}/);
});

test('45 processes paginate locally as 20, 20 and 5 rows; last-page clamping never duplicates or loses evidence', async () => {
  const report = freezeEvidence(diagnostic({
    processes: fortyFiveProcesses(),
    totals: { sessions: 99, inputTokens: 1000, outputTokens: 200, unresolved: 73, critical: 50, high: 23 },
  }));
  const h = await loaded(report);
  const unchanged = assertLocalOnly(h, report);
  const seen = [];
  for (let page = 1; page <= 3; page++) {
    const tree = h.render();
    assertProcessPage(tree, page, 3, report.processes.slice((page - 1) * 20, page * 20));
    seen.push(...processNames(tree));
    unchanged();
    if (page < 3) button(tree, '下一页').props.onClick();
  }
  assert.deepEqual(seen, report.processes.map(process => process.name));
  assert.equal(new Set(seen).size, 45);
  // Simulate a queued callback beyond the last page: display still clamps to the last real page.
  button(h.render(), '下一页').props.onClick();
  assertProcessPage(h.render(), 3, 3, report.processes.slice(40));
  button(h.render(), '上一页').props.onClick();
  assertProcessPage(h.render(), 2, 3, report.processes.slice(20, 40));
  button(h.render(), '上一页').props.onClick();
  assertProcessPage(h.render(), 1, 3, report.processes.slice(0, 20));
  selectTab(h, '会话');
  selectTab(h, '中断');
  selectTab(h, '延迟');
  assertProcessPage(selectTab(h, '总览'), 1, 3, report.processes.slice(0, 20));
  unchanged();
  assert.deepEqual(statsValues(h.render()), ['99', '1,000', '200', '73']);
  assert.deepEqual(h.calls, [false]);
});

test('process name/PID search, role and all six states plus attention combine without changing reports or global totals', async () => {
  const report = freezeEvidence(diagnostic({ processes: fortyFiveProcesses() }));
  const h = await loaded(report);
  const unchanged = assertLocalOnly(h, report);
  const options = elements(control(h.render(), '筛选探活状态'), node => node.type === 'option').map(node => [node.props.value, text(node)]);
  assert.deepEqual(options, [['', '全部状态'], ['attention', '需检查'], ...Object.entries(shared.agentProcessLabels)]);
  assert.deepEqual(elements(control(h.render(), '筛选进程角色'), node => node.type === 'option').map(node => node.props.value), ['', 'cli', 'supervisor', 'worker']);
  for (const status of Object.keys(shared.agentProcessLabels)) {
    const expected = report.processes.filter(process => process.status === status);
    assertProcessPage(change(h, '筛选探活状态', status), 1, 1, expected);
    unchanged();
  }
  change(h, '筛选探活状态', '');
  let expected = report.processes.filter(process => process.name.toLowerCase().includes('alpha'));
  let tree = change(h, '搜索进程名或 PID', '  ALPHA  ');
  assertProcessPage(tree, 1, 2, expected.slice(0, 20));
  button(tree, '下一页').props.onClick();
  assertProcessPage(h.render(), 2, 2, expected.slice(20));
  tree = change(h, '筛选进程角色', 'worker');
  expected = expected.filter(process => process.role === 'worker');
  assertProcessPage(tree, 1, 1, expected);
  tree = change(h, '筛选探活状态', 'hung');
  expected = expected.filter(process => process.status === 'hung');
  assert(expected.length > 0, 'combination fixture must actually contain a match');
  assertProcessPage(tree, 1, 1, expected);
  unchanged();
  button(tree, '清除筛选').props.onClick();
  tree = change(h, '搜索进程名或 PID', '  9134  ');
  assertProcessPage(tree, 1, 1, report.processes.filter(process => process.pid === 9134));
  tree = change(h, '筛选进程角色', 'worker');
  assertProcessPage(tree, 1, 1, []);
  assert.match(text(tree), /没有匹配的进程/);
  assert.doesNotMatch(text(tree), /没有已采集的进程记录/);
  button(tree, '清除筛选').props.onClick();
  tree = change(h, '筛选探活状态', 'attention');
  expected = report.processes.filter(process => ['unhealthy', 'hung'].includes(process.status) || (process.status === 'offline' && process.hasCrash === true));
  assertProcessPage(tree, 1, 1, expected);
  tree = change(h, '筛选进程角色', 'supervisor');
  expected = expected.filter(process => process.role === 'supervisor');
  assertProcessPage(tree, 1, 1, expected);
  tree = change(h, '搜索进程名或 PID', 'beta');
  assertProcessPage(tree, 1, 1, expected.filter(process => process.name.toLowerCase().includes('beta')));
  unchanged();
  button(tree, '清除筛选').props.onClick();
  assertProcessPage(h.render(), 1, 3, report.processes.slice(0, 20));
  unchanged();
});

test('every process-filter change and clear resets page 1 even when the matching data still spans three pages', async () => {
  const report = freezeEvidence(diagnostic({ processes: fortyFiveProcesses({ role: 'worker', status: 'healthy', hasCrash: false }) }));
  const h = await loaded(report);
  const unchanged = assertLocalOnly(h, report);
  function lastPage() {
    button(h.render(), '下一页').props.onClick();
    button(h.render(), '下一页').props.onClick();
    assertProcessPage(h.render(), 3, 3, report.processes.slice(40));
  }
  assert.equal(button(h.render(), '清除筛选').props.disabled, true);
  for (const [label, value] of [['搜索进程名或 PID', 'AGENT'], ['筛选进程角色', 'worker'], ['筛选探活状态', 'healthy']]) {
    lastPage();
    assertProcessPage(change(h, label, value), 1, 3, report.processes.slice(0, 20));
    unchanged();
  }
  lastPage();
  assert.equal(button(h.render(), '清除筛选').props.disabled, false);
  button(h.render(), '清除筛选').props.onClick();
  assertProcessPage(h.render(), 1, 3, report.processes.slice(0, 20));
  for (const label of ['搜索进程名或 PID', '筛选进程角色', '筛选探活状态']) assert.equal(control(h.render(), label).props.value, '');
  assert.equal(button(h.render(), '清除筛选').props.disabled, true);
  for (const [label, value] of [['搜索进程名或 PID', 'no-such-process'], ['筛选进程角色', 'worker'], ['筛选探活状态', 'unhealthy']]) change(h, label, value);
  assertProcessPage(h.render(), 1, 1, []);
  button(h.render(), '清除筛选').props.onClick();
  assertProcessPage(h.render(), 1, 3, report.processes.slice(0, 20));
  unchanged();
});

test('report refresh resets page 1 for unchanged-length and shortened process data; stale pagination clamps to new data', async () => {
  const reports = [45, 45, 7].map((count, index) => freezeEvidence(diagnostic({
    sampledAt: `2026-11-11T${String(7 + index).padStart(2, '0')}:00:00.000Z`,
    processes: fortyFiveProcesses({ role: 'worker', status: 'healthy', hasCrash: false }).slice(0, count).map(process => ({ ...process, name: `Agent-revision-${index}-${process.pid}` })),
    totals: { sessions: 30 + index, inputTokens: 1000, outputTokens: 200, unresolved: 73, critical: 50, high: 23 },
  })));
  let stage = 0;
  const h = harness(async () => reports[stage++]);
  h.render(); h.mount(); await settle();
  change(h, '搜索进程名或 PID', 'Agent');
  change(h, '筛选进程角色', 'worker');
  change(h, '筛选探活状态', 'healthy');
  for (let index = 1; index <= 2; index++) {
    button(h.render(), '下一页').props.onClick();
    button(h.render(), '下一页').props.onClick();
    assertProcessPage(h.render(), 3, 3, reports[index - 1].processes.slice(40));
    const staleNext = button(h.render(), '下一页');
    await button(h.render(), '刷新诊断').props.onClick();
    await settle();
    const tree = h.render();
    assertProcessPage(tree, 1, index === 1 ? 3 : 1, reports[index].processes.slice(0, 20));
    assert.equal(control(tree, '搜索进程名或 PID').props.value, 'Agent');
    assert.equal(control(tree, '筛选进程角色').props.value, 'worker');
    assert.equal(control(tree, '筛选探活状态').props.value, 'healthy');
    assert.deepEqual(statsValues(tree), [String(30 + index), '1,000', '200', '73']);
    assert.match(text(collectionDetails(tree)), new RegExp(`2026/11/11 ${String(15 + index).padStart(2, '0')}:00:00`));
    assert.deepEqual(h.calls, [false, ...Array(index).fill(true)]);
    if (index === 2) {
      const unchanged = assertLocalOnly(h, reports[index]);
      staleNext.props.onClick();
      assertProcessPage(h.render(), 1, 1, reports[index].processes);
      unchanged();
      button(h.render(), '清除筛选').props.onClick();
      assertProcessPage(h.render(), 1, 1, reports[index].processes);
      unchanged();
    }
  }
  assert.deepEqual(h.notifications, ['诊断已更新。', '诊断已更新。']);
});

test('attention includes unhealthy/hung regardless of crash and offline only with true crash; process card clears other filters', async () => {
  const processes = Object.keys(shared.agentProcessLabels).flatMap((status, index) => [false, true].map((hasCrash, offset) => processEvidence({
    pid: 9200 + index * 2 + offset, name: `fixture-${status}-${hasCrash}`, status, hasCrash, role: offset ? 'supervisor' : 'worker',
  })));
  const report = freezeEvidence(diagnostic({ outcome: 'abnormal', processes }));
  const h = await loaded(report);
  const unchanged = assertLocalOnly(h, report);
  const expected = processes.filter(process => ['unhealthy', 'hung'].includes(process.status) || (process.status === 'offline' && process.hasCrash === true));
  assert.equal(expected.length, 5);
  assertProcessPage(change(h, '筛选探活状态', 'attention'), 1, 1, expected);
  assert.doesNotMatch(text(region(h.render(), '已采集进程探活')), /fixture-no_port|fixture-healthy|fixture-unknown|fixture-offline-false/);
  change(h, '搜索进程名或 PID', 'missing');
  change(h, '筛选进程角色', 'supervisor');
  change(h, '筛选探活状态', 'healthy');
  assertProcessPage(h.render(), 1, 1, []);
  const card = button(h.render(), '查看异常进程证据');
  assert.match(text(card), /进程探活异常 · 5 个/);
  card.props.onClick();
  const tree = h.render();
  assert.equal(tab(tree, '总览').props['aria-selected'], true);
  assert.equal(control(tree, '搜索进程名或 PID').props.value, '');
  assert.equal(control(tree, '筛选进程角色').props.value, '');
  assert.equal(control(tree, '筛选探活状态').props.value, 'attention');
  assertProcessPage(tree, 1, 1, expected);
  assert.match(text(elements(tree, node => node.props['aria-label'] === '诊断结论')[0]), /进程需检查 5 个/);
  unchanged();
  const noPort = await loaded(diagnostic({ processes: [processEvidence({ status: 'no_port', ports: [], hasCrash: true })] }));
  assert.equal(elements(noPort.render(), node => node.props['aria-label'] === '查看异常进程证据').length, 0, 'a CLI with no port is not an inferred failure, even with a recorded crash flag');
});

test('overview groups only unresolved events by type, orders highest severity, caps four groups and opens locally filtered evidence', async () => {
  const events = [
    interruption({ id: 'llm-low', severity: 'low' }),
    interruption({ id: 'tool-medium', type: 'tool_error', severity: 'medium' }),
    interruption({ id: 'dead-medium', type: 'dead_loop', severity: 'medium' }),
    interruption({ id: 'context-high-1', type: 'context_overflow' }),
    interruption({ id: 'token-critical', type: 'token_limit', severity: 'critical' }),
    interruption({ id: 'llm-high' }),
    interruption({ id: 'dead-critical', type: 'dead_loop', severity: 'critical' }),
    interruption({ id: 'context-high-2', type: 'context_overflow' }),
    interruption({ id: 'context-low', type: 'context_overflow', severity: 'low' }),
    interruption({ id: 'user-low', type: 'user_cancel', severity: 'low' }),
    interruption({ id: 'llm-resolved-critical', severity: 'critical', resolved: true }),
    interruption({ id: 'crash-resolved', type: 'agent_crash', severity: 'critical', resolved: true }),
  ];
  const report = freezeEvidence(diagnostic({ outcome: 'abnormal', interruptions: events,
    totals: { sessions: 99, inputTokens: 1000, outputTokens: 200, unresolved: 73, critical: 50, high: 23 },
  }));
  const h = await loaded(report);
  const unchanged = assertLocalOnly(h, report);
  const cards = elements(h.render(), node => node.type === 'button' && node.props['aria-label']?.startsWith('查看事件证据 '));
  assert.deepEqual(cards.map(node => node.props['aria-label']), ['查看事件证据 dead_loop', '查看事件证据 token_limit', '查看事件证据 context_overflow', '查看事件证据 llm_error']);
  assert.deepEqual(cards.map(node => text(elements(node, child => child.type === 'strong')[0])), ['循环风险 · 2 条', 'Token 达到上限 · 1 条', '上下文超限 · 3 条', '模型调用错误 · 2 条']);
  assert.deepEqual(cards.map(node => text(elements(node, child => child.props.className?.includes('ad-badge'))[0])), ['严重', '严重', '高危', '高危']);
  assert.doesNotMatch(cards.map(text).join(''), /critical|high|medium|low|crash-resolved|llm-resolved/);
  for (const card of cards) {
    const type = card.props['aria-label'].slice('查看事件证据 '.length);
    card.props.onClick();
    let tree = h.render();
    assert.equal(tab(tree, '中断').props['aria-selected'], true);
    assert.equal(control(tree, '筛选中断类型').props.value, type);
    const expected = events.filter(event => event.type === type);
    const list = region(tree, '已采集中断元数据');
    const ids = elements(list, node => node.type === 'button').map(node => node.props['aria-label']);
    assert.deepEqual(ids, expected.map(event => `查看中断证据 ${event.id}`), 'type navigation preserves both resolved and unresolved source evidence of that type');
    assert.equal(elements(tree, node => node.props.subtitle === '本地报告已有证据 · 只读').length, 0);
    assert.match(text(tree), new RegExp(`近 24h 未处理 73 · 匹配 ${expected.length} / 已取得明细 12`));
    button(tree, `查看中断证据 ${expected[0].id}`).props.onClick();
    const modal = elements(h.render(), node => node.props.subtitle === '本地报告已有证据 · 只读')[0];
    assert.equal(text(elements(modal, node => node.type === 'dd')[0]), expected[0].id);
    assert.equal(elements(modal, node => node.type === 'dt').length, 9);
    button(modal, '关闭').props.onClick();
    selectTab(h, '总览');
    unchanged();
  }
  button(h.render(), '查看全部中断').props.onClick();
  assert.equal(control(h.render(), '筛选中断类型').props.value, '');
  assert.equal(tableRows(region(h.render(), '已采集中断元数据')).length, events.length);
  change(h, '筛选中断类型', 'tool_error');
  assert.equal(tableRows(region(h.render(), '已采集中断元数据')).length, 1, 'fifth-ranked type remains accessible from the full evidence tab');
  selectTab(h, '总览');
  button(h.render(), '查看全部中断').props.onClick();
  assert.equal(control(h.render(), '筛选中断类型').props.value, '');
  assert.equal(tableRows(region(h.render(), '已采集中断元数据')).length, events.length);
  unchanged();
});

test('summary, findings, source reasons, service messages and raw errors never disclose synthetic sensitive sentinels in any view', async () => {
  const sentinel = field => `SENSITIVE_${field}_SENTINEL_<script>synthetic-only</script>`;
  const report = freezeEvidence(diagnostic({
    summary: sentinel('SUMMARY'),
    findings: [{ severity: 'error', title: sentinel('TITLE'), detail: sentinel('DETAIL'), suggestion: sentinel('SUGGESTION') }],
    lastScanAt: sentinel('LAST_SCAN'),
    coverage: Object.keys(shared.agentSourceLabels).map((key, index) => ({ key, status: ['available', 'unavailable', 'invalid', 'truncated'][index % 4], reason: sentinel(`REASON_${key}`) })),
    processes: [processEvidence()], sessions: [sessionEvidence()],
    interruptions: [interruption({ sessionId: 'actual-session' })],
  }));
  const waiting = deferred();
  const h = harness(async refresh => refresh ? waiting.promise : report, { fetchCollectorStatus: async () => ({ agent_sight: {
    state: 'running', message: sentinel('SERVICE_MESSAGE'),
    collection: { state: 'disabled', enabled: false, scope: 'none', trace_running: false, api_running: true, message: sentinel('COLLECTION_MESSAGE') },
  } }) });
  h.render(); h.mount(); await settle();
  function noLeak() {
    const tree = h.render();
    assert.doesNotMatch(renderToStaticMarkup(tree) + text(tree) + h.notifications.join(''), /SENSITIVE_|synthetic-only|rawerror/);
    assertNoDemo(renderToStaticMarkup(tree));
  }
  noLeak();
  const unchanged = assertLocalOnly(h, report);
  for (const label of ['会话', '中断', '延迟', '总览']) {
    const tree = selectTab(h, label);
    collectionDetails(tree);
    noLeak();
    if (label === '会话') {
      button(tree, '展开会话 actual-session').props.onClick();
      noLeak();
    }
    if (label === '中断') {
      button(tree, '查看中断证据 actual-event').props.onClick();
      const modal = elements(h.render(), node => node.props.subtitle === '本地报告已有证据 · 只读')[0];
      assert.equal(text(elements(modal, node => node.props.className === 'ad-modal-note')[0]), '仅展示本次报告已有证据，未确认故障根因。');
      noLeak();
      button(modal, '关闭').props.onClick();
    }
    unchanged();
  }
  assert.match(text(collectionDetails(h.render())), /采集停用，当前显示历史记录/);
  const pending = button(h.render(), '刷新诊断').props.onClick();
  assert.equal(button(h.render(), '正在更新诊断').props.disabled, true);
  noLeak();
  waiting.reject(new Error(sentinel('RAW_ERROR')));
  await pending;
  noLeak();
  assert.equal(text(elements(elements(h.render(), node => node.props.role === 'alert')[0], node => node.type === 'strong')[0]), '暂时无法更新诊断，请稍后重试。');
  assert.deepEqual(h.calls, [false, true]);
  assert.deepEqual(h.notifications, []);
  assert.deepEqual(processNames(h.render()), ['actual-cli']);
  assert.match(text(collectionDetails(h.render())), /更新时间2026\/11\/11 20:00:00/);
});

test('all failure shapes use the same fixed prompt on mount and refresh while old last-page evidence and KPI remain intact', async () => {
  const failures = [new Error('SENSITIVE_ERROR_SENTINEL'), 'SENSITIVE_STRING_SENTINEL', { message: 'SENSITIVE_MESSAGE_SENTINEL', reason: 'SENSITIVE_REASON_SENTINEL' }, null, new Error('')];
  for (const failure of failures) {
    for (const hadReport of [false, true]) {
      const report = freezeEvidence(diagnostic({ processes: fortyFiveProcesses(), totals: { sessions: 45, inputTokens: 1000, outputTokens: 0, unresolved: 73, critical: 50, high: 23 } }));
      const h = harness(async refresh => {
        if (hadReport && !refresh) return report;
        throw failure;
      });
      h.render(); h.mount(); await settle();
      const original = structuredClone(report);
      if (hadReport) {
        button(h.render(), '下一页').props.onClick();
        button(h.render(), '下一页').props.onClick();
        assertProcessPage(h.render(), 3, 3, report.processes.slice(40));
        await button(h.render(), '刷新诊断').props.onClick();
      }
      const tree = h.render();
      const alert = elements(tree, node => node.props.role === 'alert');
      assert.equal(alert.length, 1);
      assert.equal(text(elements(alert[0], node => node.type === 'strong')[0]), '暂时无法更新诊断，请稍后重试。');
      assert.doesNotMatch(renderToStaticMarkup(tree) + h.notifications.join(''), /SENSITIVE_|\[object Object\]|rawerror/);
      if (hadReport) {
        assertProcessPage(tree, 3, 3, report.processes.slice(40));
        assert.deepEqual(statsValues(tree), ['45', '1,000', '0', '73']);
        assert.match(text(alert[0]), /保留上次报告，不代表本次状态/);
        assert.equal(button(tree, '刷新诊断').props.disabled, false);
      } else {
        assert.deepEqual(statsValues(tree), ['—', '—', '—', '—']);
        assert.equal(button(tree, '重试诊断').props.disabled, false);
      }
      assert.deepEqual(h.calls, hadReport ? [false, true] : [false]);
      assert.deepEqual(h.notifications, []);
      assert.deepEqual(report, original);
      assertCompactShell(tree);
      assertNoDemo(renderToStaticMarkup(tree));
      h.unmount();
    }
  }
});
