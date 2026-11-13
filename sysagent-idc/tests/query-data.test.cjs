'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { datasetCatalog, queryDataset, QueryError, openApiContract } = require('../electron/query-data.cjs');

const TIME = '2026-11-01T12:00:00.000Z';
const params = text => new URLSearchParams(text);
const query = (view, name, text = '', id) => queryDataset(view, name, params(text), id);
function fixture() {
  const cpuRows = Array.from({ length: 24 }, (_, index) => ({
    id: `process-${100 + index}-${9000 + index}`, name: `Worker ${index}`, detail: index === 17 ? 'Nested evidence target' : 'normalized process',
    usage: index, cleanable: false, defaultSelected: false, effect: 'display only',
    quantity: { value: index * 1024, unit: 'B' }, pid: 100 + index, starttime: 9000 + index,
    ...(index % 2 === 0 ? { agentKind: 'Qoder', agentId: `agent-${index}` } : {}),
    ...(index === 17 ? { sessions: [{ id: 'nested', name: 'Deep session text', status: 'idle', usage: 0, cleanable: false, defaultSelected: false }] } : {}),
  }));
  const resources = Object.fromEntries(['cpu', 'energy', 'memory', 'disk', 'gpu'].map(id => [id, {
    id, label: id.toUpperCase(), usage: id === 'energy' ? null : 0, capacity: null,
    unit: '%', source: 'sysak', status: id === 'energy' ? 'unavailable' : 'available',
    note: id === 'energy' ? 'No power evidence' : '', sampledAt: TIME, rankLabel: 'Processes', rankUnit: '%',
    rows: id === 'cpu' ? cpuRows : id === 'memory' ? structuredClone(cpuRows.slice(0, 12)) : [],
  }]));
  resources.memory.quantity = { value: 0, unit: 'B', total: 8192, available: 8192 };
  resources.disk.rankUnit = 'B/s';
  resources.disk.rows = [{ ...cpuRows[0], quantity: { value: 0, unit: 'B/s' } }];
  resources.gpu.gpuDevices = [{ index: 0, name: 'GPU', uuid: 'GPU-123', busId: '0000:01:00.0', utilization: 0, memoryUtilization: null, memoryUsedBytes: 0, memoryTotalBytes: 4096, temperatureCelsius: 30, powerWatts: 0, powerLimitWatts: null, eccCorrected: 0, eccUncorrected: 0, pcieGeneration: 4, pcieMaxGeneration: 4, pcieWidth: 16 }];
  const processes = Array.from({ length: 23 }, (_, index) => ({ pid: 200 + index, name: `Agent ${index}`, role: 'main', status: index % 2 ? 'unknown' : 'healthy', ports: [8000 + index], lastCheckAt: index === 0 ? null : TIME, latencyMs: index === 0 ? null : index === 1 ? 0 : index, parentPid: index === 0 ? null : 0, hasCrash: false }));
  const sessions = Array.from({ length: 22 }, (_, index) => ({ id: `session-${index}`, agent: index === 0 ? null : 'Qoder', model: null, conversations: index, inputTokens: 0, outputTokens: index, firstSeenAt: index === 0 ? null : `2026-11-01T${String(index).padStart(2, '0')}:00:00Z`, lastSeenAt: TIME }));
  const findings = [{ check: 'hardware', severity: 'OK', message: 'Overall hardware', suggestion: 'observe' }];
  const job = { pid: 123, starttime: 456, name: 'training', state: 'S', cpuPercent: 0, rssBytes: 0, gpuIndices: [0], smUtilization: null, memoryUtilization: 0, status: 'partial', findings: [{ check: 'job', severity: 'WARN', message: 'Job short window' }] };
  return {
    status: { schema_version: '1.0', mode: 'mock', read_only: true, device_id: 'device', installed: false, enabled: false, phase: 'disabled', api_version: '1.0', last_task: null, inspection_interval_minutes: 5, next_inspection_at: null, error: null },
    state: {
      mode: 'collected', hasGpu: true, revision: 7, sampledAt: TIME, resources,
      inspections: [{ id: 'root', label: 'Root', important: true, phase: 1, status: 'normal', usage: 0, detail: 'cached evidence', evidence: ['no action'], execution: 'complete' }, { id: 'gpu', label: 'GPU', important: false, phase: 1, status: 'unchecked', usage: null, detail: 'not checked', evidence: [], execution: 'unavailable' }],
      optimizations: [{ id: 'recommendation', inspection: 'root', title: 'Review', action: 'Never execute this text', effect: 'suggestion only' }],
      operations: [
        { id: 'late', kind: 'inspect', names: ['cached'], time: '2026-11-01T12:00:00+02:00', revision: 7 },
        { id: 'early', kind: 'inspect', names: ['cached'], time: '2026-11-01T10:30:00Z', revision: 6 },
        { id: 'older', kind: 'inspect', names: [], time: '2026-10-31T23:00:00Z', revision: 5 },
      ],
      gpuDiagnostic: { status: 'ok', outcome: 'normal', sampledAt: TIME, source: 'sysak ai', complete: true, gpuCount: 1, architectures: ['test'], devices: ['GPU'], summary: 'hardware sample', findings, jobAnalysis: { status: 'partial', source: 'sysak ai', sampledAt: '2026-11-01T12:05:00Z', sampleWindowSeconds: 1, complete: false, reason: 'limited window', processes: [job, { ...structuredClone(job), pid: 124, starttime: null, findings: [] }] } },
    },
    agent: {
      source: 'agentsight', analyzer: 'sysom-openapi', sampledAt: '2026-11-01T13:00:00Z', window: { start: '2026-10-31T13:00:00Z', end: '2026-11-01T13:00:00Z' }, status: 'partial', outcome: 'unknown', summary: 'limited cache', lastScanAt: TIME, filteredProcesses: 4,
      coverage: [
        { key: 'processes', status: 'available', reason: '' }, { key: 'sessions', status: 'available', reason: '' },
        { key: 'interruptions', status: 'unavailable', reason: 'Source offline' }, { key: 'interruptionCounts', status: 'invalid', reason: 'Bad summary' }, { key: 'latency', status: 'truncated', reason: 'Bounded rows' },
      ],
      totals: { sessions: 22, inputTokens: 0, outputTokens: 231, unresolved: null, critical: null, high: null },
      findings: [{ severity: 'warning', title: 'Coverage', detail: 'Missing interruptions', suggestion: 'Inspect separately' }],
      processes, sessions, interruptions: [], latency: [{ agent: null, calls: 0, streamingCalls: 0, ttftP95Ms: null, e2eP95Ms: 0, tpsP50: 0, tpotP95Ms: null }, { agent: 'Qoder', calls: 42, streamingCalls: 41, ttftP95Ms: 100, e2eP95Ms: 300, tpsP50: 10, tpotP95Ms: 20 }],
    },
    tasks: [{ id: 'task-one', request_id: 'request-one', operation: 'snapshot', status: 'completed', profile: 'resources', collection_status: 'partial', raw_bytes: 0, collected_at: TIME, simulated: false }],
  };
}
function rejects(view, name, text, status = 400, id) {
  assert.throws(() => query(view, name, text, id), error => error instanceof QueryError && error.status === status && typeof error.code === 'string');
}
function deepFreeze(value) {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}

test('catalog exposes all 15 static datasets, full field lists, availability and honest limitations', () => {
  const view = fixture();
  const catalog = datasetCatalog(view);
  assert.equal(catalog.schema_version, '1.0');
  assert.equal(catalog.read_only, true);
  assert.equal(catalog.cache_only, true);
  assert.equal(catalog.datasets.length, 15);
  assert.ok(catalog.datasets.every(item => item.cached && item.fields.length > 0 && item.meta.limitations.length > 0));
  const rows = catalog.datasets.find(item => item.name === 'resource-rows');
  assert.equal(rows.detail_id_field, 'queryId');
  assert.ok(rows.fields.some(field => field.name === 'starttime' && field.filter && field.range));
  assert.ok(rows.fields.some(field => field.name === 'sessions' && !field.filter && !field.sort));
  assert.ok(rows.meta.limitations.some(text => text.includes('top20 + agent20')));
  assert.ok(rows.meta.limitations.some(text => text.includes('B/s')));
  assert.ok(catalog.datasets.find(item => item.name === 'agent-sessions').meta.limitations.some(text => text.includes('24h')));
  assert.equal(catalog.datasets.find(item => item.name === 'agent-processes').id_scope, 'snapshot');
  assert.ok(catalog.datasets.find(item => item.name === 'gpu-jobs').meta.limitations.some(text => text.includes('10 seconds')));
  assert.ok(catalog.datasets.find(item => item.name === 'tasks').meta.limitations.some(text => text.includes('100 successful')));
});

test('resources retain every typed original field and every cached row, not UI Top10', () => {
  const view = fixture();
  const result = query(view, 'resources');
  assert.equal(result.total, 5);
  assert.deepEqual(result.items[0], view.state.resources.cpu);
  assert.equal(result.items[0].rows.length, 24);
  assert.deepEqual(result.items.find(item => item.id === 'gpu').gpuDevices, view.state.resources.gpu.gpuDevices);
  assert.deepEqual(result.items.find(item => item.id === 'memory').quantity, { value: 0, unit: 'B', total: 8192, available: 8192 });
  assert.equal(result.meta.status, 'partial');
  assert.equal(result.meta.source, 'sysak');
  assert.equal(result.meta.sampled_at, TIME);
  assert.equal(result.meta.revision, 7);
  assert.equal(result.meta.coverage.sources.find(item => item.key === 'energy').status, 'unavailable');
});

test('resource-rows returns full union, preserving PID/starttime and original ids', () => {
  const view = fixture();
  const result = query(view, 'resource-rows');
  assert.equal(result.total, 37);
  assert.equal(result.items.filter(item => item.resource === 'cpu').length, 24);
  assert.equal(new Set(result.items.map(item => item.queryId)).size, 37);
  const row = result.items[17];
  assert.equal(row.id, view.state.resources.cpu.rows[17].id);
  assert.equal(row.pid, 117);
  assert.equal(row.starttime, 9017);
  assert.deepEqual(query(view, 'resource-rows', '', row.queryId).item, row);
  rejects(view, 'resource-rows', '', 404, row.id);
  assert.equal(result.items.find(item => item.resource === 'disk').quantity.unit, 'B/s');
});

test('all Agent process/session/latency and coverage caches remain uncapped by UI', () => {
  const view = fixture();
  assert.equal(query(view, 'agent-processes').total, 23);
  assert.equal(query(view, 'agent-sessions').total, 22);
  const process = query(view, 'agent-processes').items[22];
  assert.equal(process.pid, 222);
  assert.equal(ownProperty(process, 'starttime'), false);
  assert.equal(query(view, 'agent-latency').items[0].calls, 0);
  assert.equal(query(view, 'agent-coverage').total, 5);
  assert.equal(query(view, 'agent-findings').items[0].title, 'Coverage');
});
function ownProperty(value, key) { return Object.hasOwn(value, key); }

test('same-field equality is OR, different fields and bounds are AND', () => {
  const result = query(fixture(), 'resource-rows', 'filter.resource=cpu&filter.pid=101&filter.pid=117&filter.cleanable=false&min.usage=1&max.usage=17&sort=-pid&fields=id,pid,starttime,resource');
  assert.equal(result.total, 2);
  assert.deepEqual(result.items.map(item => item.pid), [117, 101]);
  assert.deepEqual(Object.keys(result.items[0]), ['id', 'pid', 'starttime', 'resource']);
  assert.equal(query(fixture(), 'resource-rows', 'filter.resource=cpu&min.pid=101.5&max.pid=102.5').items[0].pid, 102);
  assert.equal(query(fixture(), 'resource-rows', 'filter.resource=cpu&filter.agentKind=Qoder').total, 12);
});

test('scalar array filters support ports, GPU indices and evidence membership without sorting objects', () => {
  const view = fixture();
  assert.equal(query(view, 'agent-processes', 'filter.ports=8001&filter.ports=8002').total, 2);
  assert.equal(query(view, 'gpu-jobs', 'filter.gpuIndices=0').total, 2);
  assert.equal(query(view, 'inspections', 'filter.evidence=no%20action').total, 1);
  assert.equal(query(view, 'agent-processes', 'filter.ports=0').total, 0);
  rejects(view, 'agent-processes', 'filter.ports=invalid');
  rejects(view, 'agent-processes', 'sort=ports');
  rejects(view, 'resources', 'filter.rows=x');
  const fields = datasetCatalog(view).datasets.find(item => item.name === 'agent-processes').fields;
  assert.equal(fields.find(item => item.name === 'ports').filter, true);
});

test('pagination occurs after filtering/sorting/projection, with correct total and next_offset', () => {
  const view = fixture();
  const first = query(view, 'resource-rows', 'filter.resource=cpu&sort=-usage,pid&fields=id,usage&offset=2&limit=3');
  assert.equal(first.total, 24);
  assert.equal(first.offset, 2);
  assert.equal(first.limit, 3);
  assert.deepEqual(first.items.map(item => item.usage), [21, 20, 19]);
  assert.equal(first.next_offset, 5);
  const last = query(view, 'resource-rows', 'filter.resource=cpu&sort=-usage&offset=22&limit=3');
  assert.deepEqual(last.items.map(item => item.usage), [1, 0]);
  assert.equal(last.next_offset, null);
  const beyond = query(view, 'resource-rows', `offset=${Number.MAX_SAFE_INTEGER}&limit=1000`);
  assert.equal(beyond.total, 37);
  assert.deepEqual(beyond.items, []);
  assert.equal(beyond.next_offset, null);
  assert.equal(query(view, 'agent-sessions').limit, 100);
  assert.equal(query(view, 'agent-sessions', 'limit=1000').items.length, 22);
});

test('stable multi-key ordering uses original order on ties and keeps null last in either direction', () => {
  const view = fixture();
  view.agent.processes = [
    { ...view.agent.processes[0], pid: 1, latencyMs: null },
    { ...view.agent.processes[0], pid: 4, latencyMs: 0 },
    { ...view.agent.processes[0], pid: 2, latencyMs: 0 },
    { ...view.agent.processes[0], pid: 3, latencyMs: 2 },
  ];
  assert.deepEqual(query(view, 'agent-processes', 'sort=latencyMs,pid').items.map(item => item.pid), [2, 4, 3, 1]);
  assert.deepEqual(query(view, 'agent-processes', 'sort=-latencyMs,-pid').items.map(item => item.pid), [3, 4, 2, 1]);
  assert.deepEqual(query(view, 'agent-processes', 'sort=latencyMs').items.map(item => item.pid), [4, 2, 3, 1]);
});

test('null, zero, false and missing fields are not conflated in filters or projections', () => {
  const view = fixture();
  assert.deepEqual(query(view, 'agent-latency', 'filter.calls=0&fields=agent,calls,e2eP95Ms,ttftP95Ms').items, [{ agent: null, calls: 0, e2eP95Ms: 0, ttftP95Ms: null }]);
  assert.equal(query(view, 'agent-processes', 'filter.latencyMs=null').total, 1);
  assert.equal(query(view, 'agent-processes', 'min.latencyMs=0&max.latencyMs=0').total, 1);
  assert.equal(query(view, 'agent-processes', 'filter.hasCrash=false').total, 23);
  assert.equal(query(view, 'resources', 'filter.usage=null').items[0].id, 'energy');
  const result = query(view, 'resources', 'fields=id,quantity.value,quantity.available');
  assert.deepEqual(result.items[0], { id: 'cpu' });
  assert.deepEqual(result.items.find(item => item.id === 'memory'), { id: 'memory', quantity: { value: 0, available: 8192 } });
  assert.equal(query(view, 'resource-rows', 'filter.pid=0').total, 0);
  rejects(view, 'resource-rows', 'filter.pid=null');
});

test('numeric bounds use raw units and accept finite decimal/exponent bounds', () => {
  const result = query(fixture(), 'resource-rows', 'filter.resource=cpu&min.quantity.value=1024&max.quantity.value=2.048e3&sort=quantity.value&fields=quantity');
  assert.equal(result.total, 2);
  assert.deepEqual(result.items, [{ quantity: { value: 1024, unit: 'B' } }, { quantity: { value: 2048, unit: 'B' } }]);
});

test('ISO time bounds are inclusive and sort/filter compare instants rather than strings', () => {
  const view = fixture();
  assert.deepEqual(query(view, 'operations', 'sort=time').items.map(item => item.id), ['older', 'late', 'early']);
  assert.deepEqual(query(view, 'operations', 'min.time=2026-11-01T10:00:00Z&max.time=2026-11-01T10:30:00Z&sort=-time').items.map(item => item.id), ['early', 'late']);
  assert.equal(query(view, 'operations', 'filter.time=2026-11-01T10:00:00Z').items[0].id, 'late');
  assert.equal(query(view, 'operations', 'min.time=2026-11-01').total, 2);
  assert.equal(query(view, 'agent-sessions', 'min.firstSeenAt=2026-11-01T20:00:00Z').total, 2);
  assert.equal(query(view, 'agent-processes', 'filter.lastCheckAt=null').total, 1);
  assert.equal(query(view, 'agent-processes', 'min.lastCheckAt=2026-11-01T12:00:00Z').total, 22);
  view.agent.sessions[1].firstSeenAt = 'invalid cached date';
  assert.equal(query(view, 'agent-sessions', 'min.firstSeenAt=2026-11-01').total, 20);
});

test('q searches nested string values literally, not numeric values, JSON keys or executable expressions', () => {
  const view = fixture();
  assert.equal(query(view, 'resources', 'q=DEEP%20SESSION%20TEXT').items[0].id, 'cpu');
  assert.equal(query(view, 'resource-rows', 'filter.resource=cpu&q=nested%20evidence%20target').total, 1);
  view.state.resources.cpu.rows[0].usage = 987654321;
  assert.equal(query(view, 'resources', 'q=987654321').total, 0);
  assert.equal(query(view, 'resource-rows', 'q=defaultSelected').total, 0);
  delete globalThis.__queryDataExecuted;
  assert.equal(query(view, 'resources', 'q=globalThis.__queryDataExecuted%3Dtrue').total, 0);
  assert.equal(globalThis.__queryDataExecuted, undefined);
  assert.equal(query(view, 'resource-rows', 'q=__proto__').total, 0);
  assert.equal(query(view, 'resource-rows', 'q=').total, 37);
});

test('uncached health/Agent/tasks return 503, while catalog remains usable', () => {
  const view = { status: { phase: 'disabled' }, state: null, agent: null, tasks: [] };
  for (const name of ['resources', 'inspections', 'gpu-devices', 'gpu-jobs', 'gpu-findings', 'agent-processes', 'agent-coverage']) rejects(view, name, '', 503);
  rejects({}, 'tasks', '', 503);
  const taskResult = query(view, 'tasks');
  assert.equal(taskResult.total, 0);
  assert.equal(taskResult.meta.status, 'available');
  assert.equal(taskResult.meta.revision, null);
  const catalog = datasetCatalog(view);
  assert.equal(catalog.datasets.find(item => item.name === 'resources').meta.status, 'not_cached');
  assert.equal(catalog.datasets.find(item => item.name === 'resources').cached, false);
  assert.equal(catalog.datasets.find(item => item.name === 'agent-processes').meta.source, 'agentsight');
  assert.equal(datasetCatalog().datasets.length, 15);
  rejects(view, 'resources', 'unknown=1', 400); // validation still runs before cache checks.
});

test('cached unavailable/truncated/invalid Agent sources return honest status, window and timestamps', () => {
  const view = fixture();
  const result = query(view, 'agent-interruptions');
  assert.deepEqual(result.items, []);
  assert.equal(result.meta.status, 'unavailable');
  assert.equal(result.meta.source, 'agentsight');
  assert.equal(result.meta.sampled_at, view.agent.sampledAt);
  assert.deepEqual(result.meta.coverage.window, view.agent.window);
  assert.equal(result.meta.coverage.filteredProcesses, 4);
  assert.equal(result.meta.coverage.lastScanAt, TIME);
  assert.equal(result.meta.coverage.report_status, 'partial');
  assert.equal(result.meta.coverage.sources.find(item => item.key === 'interruptions').reason, 'Source offline');
  assert.equal(query(view, 'agent-latency').meta.status, 'truncated');
  view.agent.coverage[0].status = 'invalid';
  view.agent.processes = [];
  assert.equal(query(view, 'agent-processes').meta.status, 'invalid');
  view.agent.status = 'unavailable';
  assert.equal(query(view, 'agent-findings').meta.status, 'unavailable');
});

test('missing coverage or resource status remains unknown, never fabricated available', () => {
  const view = fixture();
  view.agent.coverage = [];
  assert.equal(query(view, 'agent-processes').meta.status, 'unknown');
  for (const item of Object.values(view.state.resources)) delete item.status;
  assert.equal(query(view, 'resources').meta.status, 'unknown');
  assert.equal(query(view, 'resource-rows').meta.status, 'unknown');
  view.state.mode = 'demo';
  for (const item of Object.values(view.state.resources)) delete item.source;
  assert.equal(query(view, 'resources').meta.source, 'demo');
  assert.equal(query(view, 'resources').meta.status, 'demo');
});

test('GPU findings include both overall and per-job evidence with processPid/starttime', () => {
  const view = fixture();
  const result = query(view, 'gpu-findings');
  assert.equal(result.total, 2);
  assert.deepEqual(result.items.map(item => [item.scope, item.processPid, item.processStarttime]), [['overall', null, null], ['job', 123, 456]]);
  assert.equal(result.meta.source, 'sysak ai');
  assert.equal(result.meta.status, 'partial');
  assert.equal(result.meta.coverage.jobAnalysis.sampleWindowSeconds, 1);
  assert.equal(result.meta.coverage.jobAnalysis.sampled_at, '2026-11-01T12:05:00Z');
  const jobFinding = query(view, 'gpu-findings', 'filter.scope=job&filter.processPid=123').items[0];
  assert.equal(jobFinding.check, 'job');
  assert.deepEqual(query(view, 'gpu-findings', '', jobFinding.id).item, jobFinding);
  assert.equal(query(view, 'gpu-findings', 'filter.processPid=null').total, 1);
});

test('GPU jobs use PID+starttime; PID reuse changes identity and unknown starttime is scoped', () => {
  const view = fixture();
  const jobs = query(view, 'gpu-jobs');
  assert.equal(jobs.items[0].id, 'gpu-job:123:456');
  assert.equal(jobs.items[0].cpuPercent, 0);
  assert.deepEqual(jobs.items[0].gpuIndices, [0]);
  assert.equal(jobs.meta.sampled_at, '2026-11-01T12:05:00Z');
  assert.equal(jobs.meta.status, 'partial');
  assert.equal(jobs.items[1].starttime, null);
  assert.match(jobs.items[1].id, /unknown:/);
  assert.equal(query(view, 'gpu-jobs', '', jobs.items[0].id).item.pid, 123);
  view.state.gpuDiagnostic.jobAnalysis.processes[0].starttime = 457;
  rejects(view, 'gpu-jobs', '', 404, jobs.items[0].id);
  assert.equal(query(view, 'gpu-jobs').items[0].id, 'gpu-job:123:457');
  const previousUnknown = jobs.items[1].id;
  view.state.gpuDiagnostic.jobAnalysis.sampledAt = '2026-11-01T12:06:00Z';
  rejects(view, 'gpu-jobs', '', 404, previousUnknown);
});

test('GPU device cache is independent from diagnostic sampling; not-run/unavailable diagnostics stay honest', () => {
  const view = fixture();
  delete view.state.gpuDiagnostic;
  assert.equal(query(view, 'gpu-devices').total, 1);
  assert.equal(query(view, 'gpu-devices').meta.sampled_at, TIME);
  for (const name of ['gpu-jobs', 'gpu-findings']) {
    const result = query(view, name);
    assert.equal(result.total, 0);
    assert.equal(result.meta.status, 'not_run');
    assert.equal(result.meta.sampled_at, null);
    assert.equal(result.meta.coverage.complete, false);
  }
  view.state.gpuDiagnostic = { status: 'unavailable', source: 'sysak ai', outcome: 'unknown', complete: false, sampledAt: TIME, findings: [] };
  assert.equal(query(view, 'gpu-findings').meta.status, 'unavailable');
  view.state.resources.gpu.status = 'unavailable';
  view.state.resources.gpu.gpuDevices = [];
  assert.equal(query(view, 'gpu-devices').meta.status, 'unavailable');
});

test('tasks expose only up to 100 successful metadata records, including zero bytes/false', () => {
  const view = fixture();
  view.tasks = Array.from({ length: 120 }, (_, index) => ({ ...view.tasks[0], id: `task-${index}`, raw: { secret: 'hidden' }, token: 'hidden', system_path: '/private/path' }));
  const result = query(view, 'tasks', 'limit=1000');
  assert.equal(result.total, 100);
  assert.equal(result.items.length, 100);
  assert.equal(result.meta.coverage.retained, 100);
  assert.equal(result.items[0].raw_bytes, 0);
  assert.equal(result.items[0].simulated, false);
  assert.equal(result.items[0].raw, undefined);
  assert.equal(result.items[0].token, undefined);
  assert.equal(result.items[0].system_path, undefined);
  rejects(view, 'tasks', '', 404, 'task-100');
  assert.equal(query(view, 'tasks', '', 'task-99').item.id, 'task-99');
});

test('revision guards list/detail and mismatch after refresh is 409', () => {
  const view = fixture();
  const original = query(view, 'agent-processes', 'revision=7').items[0];
  assert.equal(query(view, 'resources', 'revision=7').meta.revision, 7);
  assert.equal(query(view, 'agent-processes', 'revision=7', original.id).item.pid, 200);
  assert.equal(query(view, 'tasks', 'revision=7').meta.revision, 7);
  rejects(view, 'resources', 'revision=6', 409);
  view.state.revision = 8;
  rejects(view, 'resources', 'revision=7', 409);
  rejects(view, 'agent-processes', 'revision=7', 409, original.id);
  rejects(view, 'agent-processes', '', 404, original.id);
  view.state = null;
  assert.equal(query(view, 'agent-sessions').meta.revision, null);
  rejects(view, 'agent-sessions', 'revision=0', 409);
});

test('generated IDs are stable through sorting/filtering/projection in a snapshot, and independent scan changes invalidate them', () => {
  const view = fixture();
  for (const name of ['gpu-devices', 'gpu-findings', 'agent-processes', 'agent-latency', 'agent-findings', 'agent-coverage']) {
    const original = query(view, name).items[0];
    assert.deepEqual(query(view, name, '', original.id).item, original);
    assert.ok(query(view, name, 'sort=-id&fields=id').items.some(item => item.id === original.id));
    assert.deepEqual(query(structuredClone(view), name).items[0], original);
  }
  const old = query(view, 'agent-latency').items[0].id;
  view.agent.sampledAt = '2026-11-01T14:00:00Z';
  assert.equal(view.state.revision, 7); // Agent refresh does not pretend health revision changed.
  rejects(view, 'agent-latency', '', 404, old);
  const regenerated = query(view, 'agent-latency').items[0].id;
  assert.notEqual(old, regenerated);
});

test('native-ID detail supports projection, absent details are 404, ambiguous source IDs are 409', () => {
  const view = fixture();
  assert.deepEqual(query(view, 'agent-sessions', 'fields=id,agent,inputTokens&revision=7', 'session-0').item, { id: 'session-0', agent: null, inputTokens: 0 });
  assert.equal(query(view, 'resources', '', 'cpu').item.rows.length, 24);
  rejects(view, 'resources', '', 404, 'missing');
  rejects(view, 'resources', '', 404, '__proto__');
  rejects(view, 'resources', '', 400, '');
  assert.throws(() => queryDataset(view, 'resources', params(''), 1), QueryError);
  for (const text of ['offset=0', 'limit=1', 'sort=id', 'q=cpu', 'filter.id=cpu']) rejects(view, 'resources', text, 400, 'cpu');
  view.agent.sessions.push(structuredClone(view.agent.sessions[0]));
  rejects(view, 'agent-sessions', '', 409, 'session-0');
});

test('unknown datasets, query parameters and static fields cannot open arbitrary/prototype paths', () => {
  const view = fixture();
  for (const name of ['unknown', '__proto__', 'constructor', 'toString', 'resources.cpu']) rejects(view, name, '', 404);
  for (const text of [
    'refresh=true', 'execute=inspect', 'token=secret', 'raw=1', '__proto__=x', 'filter.__proto__=x',
    'filter.constructor=x', 'filter.constructor.prototype=x', 'filter.quantity.__proto__=x', 'filter.quantity.value.toString=x',
    'filter.rows.0.pid=100', 'fields=rows.__proto__', 'fields=constructor', 'fields=quantity.__proto__',
    'sort=-__proto__', 'sort=quantity.constructor', 'min.__proto__=0', 'max.usage.constructor=1',
    'filter.unknown=x', 'sort=unknown', 'fields=unknown', 'min.name=0', 'filter.sessions=x', 'sort=sessions',
  ]) rejects(view, 'resource-rows', text);
  assert.equal({}.polluted, undefined);
});

test('rejects repeated non-filter parameters, malformed projections and invalid scalars', () => {
  const view = fixture();
  const invalid = [
    'q=x&q=x', 'sort=id&sort=id', 'fields=id&fields=name', 'offset=0&offset=1', 'limit=1&limit=1', 'revision=7&revision=7',
    'min.usage=0&min.usage=0', 'max.usage=5&max.usage=5',
    'fields=', 'fields=id,', 'fields=id,id', 'fields=quantity,quantity.value', 'sort=', 'sort=id,-id', 'sort=--id',
    'filter.pid=NaN', 'filter.pid=Infinity', 'filter.pid=1.5', 'filter.pid=9007199254740992', 'filter.pid=',
    'filter.cleanable=0', 'filter.cleanable=TRUE', 'filter.resource=not-a-resource',
    'min.usage=', 'min.usage=NaN', 'min.usage=Infinity', 'min.usage=1e309', 'min.usage=%200', 'max.usage=0x10',
    'min.usage=3&max.usage=2',
  ];
  invalid.forEach(text => rejects(view, 'resource-rows', text));
  for (const key of ['offset', 'limit', 'revision']) for (const value of ['-1', '1.1', '1e2', 'NaN', 'Infinity', '', '01', '9007199254740992', '%200', '%2B1']) rejects(view, 'resources', `${key}=${value}`);
  for (const value of ['0', '1001']) rejects(view, 'resources', `limit=${value}`);
  assert.equal(query(view, 'resource-rows', 'filter.resource=cpu&filter.resource=cpu').total, 24);
  assert.throws(() => queryDataset(view, 'resources', { limit: 1 }), QueryError);
});

test('invalid ISO dates/timezones and numeric-looking dates are rejected, including leap-day rollover', () => {
  const view = fixture();
  for (const time of ['1700000000000', '2026-02-29', '2026-11-31', '2026-13-01', '2026-00-01', '2026-11-00', '2026-11-01T24:00:00Z', '2026-11-01T12:60:00Z', '2026-11-01T12:00:60Z', '2026-11-01T12:00:00', '2026-11-01T12:00:00+25:00', '2026-11-01T12:00:00+01:60', 'not-a-date', '']) {
    rejects(view, 'operations', params([['min.time', time]]).toString());
    rejects(view, 'operations', params([['filter.time', time]]).toString());
  }
  assert.equal(query(view, 'operations', 'min.time=2024-02-29').total, 3);
  rejects(view, 'operations', 'min.time=2026-11-02&max.time=2026-11-01');
});

test('only schema-declared own properties are copied, including nested arrays, and no source is mutated', () => {
  const view = fixture();
  view.state.resources.cpu.raw = { password: 'secret' };
  view.state.resources.cpu.rows[17].sessions[0].raw = 'secret';
  view.state.resources.memory.quantity.system_path = '/private/path';
  view.agent.processes[0].name = { raw: 'not a valid typed string' };
  view.agent.sessions[1] = Object.assign(Object.create({ model: 'inherited secret', raw: 'secret' }), view.agent.sessions[1]);
  delete view.agent.sessions[1].model;
  const before = structuredClone(view);
  deepFreeze(view);
  const resource = query(view, 'resources').items[0];
  assert.equal(resource.raw, undefined);
  assert.equal(resource.rows[17].sessions[0].raw, undefined);
  assert.equal(query(view, 'resources').items[2].quantity.system_path, undefined);
  assert.equal(query(view, 'agent-processes').items[0].name, undefined);
  assert.equal(query(view, 'agent-sessions').items[1].model, undefined);
  assert.deepEqual(structuredClone(view), before);
  const result = query(view, 'resource-rows');
  result.items[0].name = 'changed';
  result.meta.coverage.sources[0].reason = 'changed';
  result.meta.limitations.push('changed');
  resource.rows[0].name = 'changed';
  const catalog = datasetCatalog(view);
  catalog.datasets[0].fields[0].enum.push('changed');
  catalog.datasets[0].meta.limitations.push('changed');
  assert.equal(view.state.resources.cpu.rows[0].name, 'Worker 0');
  assert.equal(query(view, 'resource-rows').items[0].name, 'Worker 0');
  assert.equal(datasetCatalog(view).datasets[0].fields[0].enum.includes('changed'), false);
});

// Small dependency-free validator for the JSON Schema vocabulary used by this contract.
function validSchema(value, schema, contract) {
  if (schema.$ref) return validSchema(value, contract.components.schemas[schema.$ref.split('/').at(-1)], contract);
  if (schema.oneOf) return schema.oneOf.filter(child => validSchema(value, child, contract)).length === 1;
  if (ownProperty(schema, 'const') && value !== schema.const) return false;
  if (schema.enum && !schema.enum.includes(value)) return false;
  const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  const types = schema.type ? [].concat(schema.type) : [];
  if (types.length && !types.some(type => type === actual || type === 'integer' && Number.isSafeInteger(value))) return false;
  if (typeof value === 'number' && (schema.minimum !== undefined && value < schema.minimum || schema.maximum !== undefined && value > schema.maximum)) return false;
  if (typeof value === 'string' && schema.minLength !== undefined && value.length < schema.minLength) return false;
  if (actual === 'object') {
    if ((schema.required ?? []).some(key => !ownProperty(value, key))) return false;
    if (schema.additionalProperties === false && Object.keys(value).some(key => !ownProperty(schema.properties, key))) return false;
    if (!Object.entries(value).every(([key, child]) => !schema.properties?.[key] || validSchema(child, schema.properties[key], contract))) return false;
  }
  if (actual === 'array' && schema.items && !value.every(child => validSchema(child, schema.items, contract))) return false;
  return true;
}

test('OpenAPI 3.1 describes every actual full GET route, Bearer/local security, errors and concrete response schemas', () => {
  const contract = openApiContract();
  assert.equal(contract.openapi, '3.1.0');
  assert.equal(contract.jsonSchemaDialect, 'https://json-schema.org/draft/2020-12/schema');
  assert.deepEqual(Object.keys(contract.paths), ['/api/v1/status', '/api/v1/capabilities', '/api/v1/snapshot', '/api/v1/summary', '/api/v1/report', '/api/v1/datasets/{name}', '/api/v1/datasets/{name}/{id}', '/api/v1/openapi.json']);
  assert.deepEqual(contract.security, [{ bearerAuth: [] }]);
  assert.equal(contract.components.securitySchemes.bearerAuth.scheme, 'bearer');
  assert.equal(contract['x-query-rules'].strict_host, true);
  assert.equal(contract['x-query-rules'].reject_origin, true);
  assert.deepEqual(contract['x-query-rules'].allowed_methods, ['GET']);
  for (const path of Object.values(contract.paths)) {
    assert.deepEqual(Object.keys(path), ['get']);
    assert.equal(path.get['x-cache-only'], true);
    for (const code of [200, 400, 401, 403, 404, 405, 409, 503]) assert.ok(path.get.responses[code].content['application/json'].schema);
  }
  const parameters = contract.paths['/api/v1/datasets/{name}'].get.parameters;
  assert.ok(parameters.some(item => item.name === 'filter.pid' && item.explode && item.schema.type === 'array'));
  assert.ok(parameters.some(item => item.name === 'min.occurredAt'));
  assert.ok(parameters.some(item => item.name === 'max.quantity.value'));
  assert.equal(parameters.find(item => item.name === 'limit').schema.maximum, 1000);
  assert.equal(parameters.find(item => item.name === 'offset').schema.maximum, Number.MAX_SAFE_INTEGER);
  assert.equal(new Set(parameters.map(item => `${item.in}:${item.name}`)).size, parameters.length);
  assert.deepEqual(contract.paths['/api/v1/datasets/{name}/{id}'].get.parameters.filter(item => item.in === 'query').map(item => item.name), ['revision', 'fields']);
  const visit = value => {
    if (!value || typeof value !== 'object') return;
    if (value.$ref) assert.ok(contract.components.schemas[value.$ref.split('/').at(-1)], value.$ref);
    Object.values(value).forEach(visit);
  };
  visit(contract);
  assert.equal(contract.components.schemas.DatasetList.oneOf.length, 15);
  assert.ok(contract.components.schemas.HealthState.properties.resources.properties.cpu.properties.rows.items.properties.starttime);
  assert.ok(contract.components.schemas.AgentDiagnostic.properties.totals.properties.inputTokens);
  assert.ok(contract.components.schemas.Meta.properties.coverage.properties.jobAnalysis.properties.sampleWindowSeconds);
  assert.ok(contract.components.schemas.HealthSummary.properties.band);
});

test('OpenAPI field annotations match the static catalog; all emitted lists/details/projections match schemas', () => {
  const view = fixture();
  const contract = openApiContract();
  const catalog = datasetCatalog(view);
  const parameters = contract.paths['/api/v1/datasets/{name}'].get.parameters;
  for (const dataset of catalog.datasets) {
    for (const field of dataset.fields) {
      if (field.filter) assert.ok(parameters.find(item => item.name === `filter.${field.name}`)['x-datasets'].some(use => use.dataset === dataset.name));
      if (field.range) for (const bound of ['min', 'max']) assert.ok(parameters.find(item => item.name === `${bound}.${field.name}`)['x-datasets'].some(use => use.dataset === dataset.name));
    }
    const list = query(view, dataset.name);
    assert.equal(validSchema(list, contract.components.schemas.DatasetList, contract), true, dataset.name);
    if (list.items.length) {
      const detail = query(view, dataset.name, '', list.items[0][dataset.detail_id_field]);
      assert.equal(validSchema(detail, contract.components.schemas.DatasetDetail, contract), true, `${dataset.name} detail`);
      const projected = query(view, dataset.name, 'fields=id');
      assert.equal(validSchema(projected, contract.components.schemas.DatasetList, contract), true, `${dataset.name} projection`);
    }
  }
  assert.equal(validSchema(query(view, 'resources', 'fields=id,quantity.value'), contract.components.schemas.DatasetList, contract), true);
  assert.equal(validSchema(catalog, contract.components.schemas.Capabilities, contract), true);
  assert.equal(validSchema(view.status, contract.components.schemas.Status, contract), true);
  assert.equal(validSchema(view.state, contract.components.schemas.HealthState, contract), true);
  assert.equal(validSchema(view.agent, contract.components.schemas.AgentDiagnostic, contract), true);
  assert.equal(validSchema(contract, contract.components.schemas.OpenAPI, contract), true);
});

test('OpenAPI is detached from static field definitions and pure-cache querying remains valid while disabled', () => {
  const contract = openApiContract();
  contract.components.schemas.resourcesItem.properties.id.enum.push('unsafe');
  contract.paths['/api/v1/status'].get.responses[200].description = 'modified';
  assert.equal(openApiContract().components.schemas.resourcesItem.properties.id.enum.includes('unsafe'), false);
  assert.equal(datasetCatalog().datasets[0].fields[0].enum.includes('unsafe'), false);
  const view = deepFreeze(fixture());
  assert.equal(view.status.enabled, false);
  assert.equal(view.status.installed, false);
  assert.equal(query(view, 'resource-rows').total, 37);
  assert.equal(query(view, 'agent-processes').total, 23);
});
