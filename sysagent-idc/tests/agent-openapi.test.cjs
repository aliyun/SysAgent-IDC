const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const clientRequest = http.request;
const crypto = require('node:crypto');
const ts = require('typescript');

const root = path.resolve(__dirname, '..');
const spec = JSON.parse(fs.readFileSync(path.join(root, 'openapi-contract.json'), 'utf8'));
const token = crypto.randomUUID();
const route = '/openapi/v1/agent-diagnostics';
const sampledAt = '2026-11-11T12:00:00.123Z';
const ms = Date.parse(sampledAt);
const ns = ms * 1e6; // Upstream number precision is deliberately display-only.
const MiB = 1024 * 1024;
let forbiddenCalls = 0;
const forbidden = () => { forbiddenCalls++; throw new Error('External or process action forbidden'); };

// Same TS transpilation/vm pattern as existing UI tests, without bundles or output files.
// Only loopback server creation and crypto are exposed to the real service module.
const modules = new Map();
function load(filename) {
  const absolute = path.resolve(filename);
  if (modules.has(absolute)) return modules.get(absolute).exports;
  const module = { exports: {} };
  modules.set(absolute, module);
  if (absolute.endsWith('.json')) module.exports = JSON.parse(fs.readFileSync(absolute, 'utf8'));
  else {
    const compiled = ts.transpileModule(fs.readFileSync(absolute, 'utf8'), {
      fileName: absolute,
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
    }).outputText;
    const execute = vm.runInThisContext(`(function(require,module,exports,fetch){${compiled}\n})`, { filename: absolute });
    execute(id => {
      if (id === 'node:crypto') return crypto;
      if (id === 'node:http') return { createServer: http.createServer, request: forbidden, get: forbidden };
      if (!id.startsWith('.')) return forbidden();
      const target = path.resolve(path.dirname(absolute), id);
      assert(target.startsWith(`${root}${path.sep}`), 'Only real project modules may load');
      return load(path.extname(target) ? target : `${target}.ts`);
    }, module, module.exports, forbidden);
  }
  return module.exports;
}
const { startMockOpenApi } = load(path.join(root, 'openapi-service.ts'));
const { parseAgentDiagnostic } = load(path.join(root, 'agent-diagnostics.ts'));
const source = (data, status = 'available', reason = '') => ({ status, reason, data });
const processRow = (overrides = {}) => ({ pid: 12, agent_name: 'fixture', role: 'cli', status: 'healthy', ports: [8080], last_check_time: ms, latency_ms: 0, parent_pid: null, has_crash: false, ...overrides });
const sessionRow = (overrides = {}) => ({ session_id: 'session-1', conversation_count: 0, first_seen_ns: ns, last_seen_ns: ns, total_input_tokens: 0, total_output_tokens: 0, agent_name: null, model: null, ...overrides });
const eventRow = (overrides = {}) => ({ interruption_id: 'event-1', session_id: null, call_id: null, pid: null, agent_name: null, interruption_type: 'tool_error', severity: 'low', occurred_at_ns: ns, resolved: false, ...overrides });
const countRow = (total = 0, critical = 0, high = 0) => ({ total, by_severity: { critical, high, medium: 0, low: total - critical - high } });
const latencyRow = (overrides = {}) => ({ agent_name: null, call_count: 0, streaming_call_count: 0, ttft_ms: null, tps_tokens_per_second: null, tpot_ms_per_token: null, e2e_latency_ms: null, ...overrides });
function payload() {
  return {
    schema_version: '1.0', request_id: crypto.randomUUID(), device_id: crypto.randomUUID(),
    raw_snapshot: {
      schema_version: '1.0', source: 'agentsight', sampled_at: sampledAt,
      window: { start: '2026-11-10T12:00:00.123Z', end: sampledAt },
      sources: {
        processes: source({ agents: [processRow()], last_scan_time: ms, filtered_count: 0 }),
        sessions: source([sessionRow()]), interruptions: source([]), interruptionCounts: source(countRow()), latency: source([latencyRow()]),
      },
    },
  };
}
function sysak(deviceId = crypto.randomUUID(), operation = 'snapshot', parameters = {}) {
  const requestId = crypto.randomUUID();
  return {
    schema_version: '1.0', request_id: requestId, device_id: deviceId, operation, parameters,
    raw_snapshot: {
      schema_version: '1.0', request_id: requestId, collector: { name: 'sysak' }, device: {},
      collection: { profile: operation === 'inspect' ? 'inspection' : 'resources', status: 'partial', finished_at: sampledAt },
      resources: {}, configuration: {}, diagnostics: {}, capabilities: { read_only: true },
    },
  };
}
function matches(schema, value, at = '$') {
  if (schema.$ref) matches(schema.$ref.slice(2).split('/').reduce((item, key) => item[key], spec), value, at);
  if (Object.hasOwn(schema, 'const')) assert.deepEqual(value, schema.const, at);
  if (schema.enum) assert(schema.enum.includes(value), `${at}: enum`);
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    assert(types.some(type => type === 'null' ? value === null : type === 'array' ? Array.isArray(value) :
      type === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value) :
      type === 'integer' ? Number.isInteger(value) : type === 'number' ? typeof value === 'number' && Number.isFinite(value) : typeof value === type), `${at}: type`);
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined) assert([...value].length >= schema.minLength, at);
    if (schema.maxLength !== undefined) assert([...value].length <= schema.maxLength, at);
    if (schema.pattern) assert(new RegExp(schema.pattern).test(value), `${at}: pattern`);
    if (schema.format === 'date-time') assert(Number.isFinite(Date.parse(value)), at);
    if (schema.format === 'uuid') assert.match(value, new RegExp(spec.components.schemas.UUID.pattern));
  }
  if (typeof value === 'number') {
    assert(Number.isFinite(value), at);
    if (schema.minimum !== undefined) assert(value >= schema.minimum, at);
    if (schema.maximum !== undefined) assert(value <= schema.maximum, at);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined) assert(value.length >= schema.minItems, at);
    if (schema.maxItems !== undefined) assert(value.length <= schema.maxItems, at);
    if (schema.uniqueItems) assert.equal(new Set(value.map(item => JSON.stringify(item))).size, value.length, at);
    if (schema.items) value.forEach((item, i) => matches(schema.items, item, `${at}[${i}]`));
  } else if (value !== null && typeof value === 'object') {
    for (const key of schema.required ?? []) assert(Object.hasOwn(value, key), `${at}: missing ${key}`);
    for (const [key, item] of Object.entries(value)) {
      if (schema.properties && Object.hasOwn(schema.properties, key)) matches(schema.properties[key], item, `${at}.${key}`);
      else if (schema.additionalProperties === false) assert.fail(`${at}: unexpected ${key}`);
    }
  }
}
function parse(body = payload()) {
  const original = structuredClone(body);
  const report = parseAgentDiagnostic(body.raw_snapshot);
  assert.deepEqual(body, original, 'Parser must not mutate raw evidence');
  matches(spec.components.schemas.AgentDiagnostic, report);
  return report;
}
function exchange(api, url = route, { method = 'GET', body, text, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const bytes = text !== undefined ? text : body !== undefined ? JSON.stringify(body) : undefined;
    const request = clientRequest(`${api.baseUrl}${url}`, {
      method, headers: { Authorization: `Bearer ${token}`, ...(bytes !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => {
        try {
          assert.equal(response.headers['cache-control'], 'no-store');
          assert.equal(response.headers['access-control-allow-origin'], undefined);
          assert.equal(response.headers['access-control-allow-credentials'], undefined);
          assert.match(response.headers['content-type'], /^application\/json/);
          const json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (response.statusCode >= 400) matches(spec.components.schemas.ErrorResponse, json);
          resolve({ status: response.statusCode, headers: response.headers, json });
        } catch (error) { reject(error); }
      });
    });
    request.on('error', reject);
    request.end(bytes);
  });
}
const post = (api, body, options = {}) => exchange(api, route, { method: 'POST', body, ...options });
async function accepted(api, body = payload()) {
  const result = await post(api, body);
  assert.equal(result.status, 200, JSON.stringify(result.json));
  matches(spec.components.schemas.AgentDiagnosticResponse, result.json);
  assert.equal(result.json.request_id, body.request_id);
  assert.equal(result.json.task.id, result.json.task_id);
  assert.equal(result.json.task.operation, 'agent-diagnose');
  assert.equal(result.json.task.status, 'completed');
  assert.equal(result.json.task.simulated, false);
  assert.equal(result.json.read_only, true);
  assert.equal(result.json.raw_snapshot, undefined);
  assert.equal(result.json.state, undefined);
  assert.equal(result.json.receipt, undefined);
  assert.deepEqual(result.json.report, parse(body));
  return result.json;
}
async function rejected(api, body, status = 400, code = 'invalid_request', options = {}) {
  const result = await post(api, body, options);
  assert.equal(result.status, status, JSON.stringify(result.json));
  assert.equal(result.json.error.code, code);
  return result;
}
async function withServer(run) {
  const api = await startMockOpenApi({ token });
  try { return await run(api); } finally { await api.close(); }
}
const coverage = (report, key) => report.coverage.find(item => item.key === key);

test('real modules type-check against the unchanged shared AgentDiagnostic interface without emission', () => {
  const program = ts.createProgram([path.join(root, 'agent-diagnostics.ts'), path.join(root, 'openapi-service.ts')], {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, strict: true, noEmit: true,
    resolveJsonModule: true, esModuleInterop: true, skipLibCheck: true, types: ['node'],
    typeRoots: [path.join(root, 'node_modules/@types')],
  });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.equal(diagnostics.length, 0, ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: name => name, getCurrentDirectory: () => root, getNewLine: () => '\n',
  }));
});

test('contract references resolve, independent capability is explicit and authenticated HTTP returns the real contract', async () => withServer(async api => {
  function walk(value) {
    if (value === null || typeof value !== 'object') return;
    for (const key of ['$ref', 'x-valid-data-schema']) if (value[key]) {
      assert(value[key].slice(2).split('/').reduce((item, name) => item?.[name], spec), `Unresolved ${value[key]}`);
    }
    Object.values(value).forEach(walk);
  }
  walk(spec);
  assert.equal(Object.keys(spec.paths).length, 6);
  assert.deepEqual(spec.security, [{ BearerAuth: [] }]);
  assert.equal(spec.paths[route].post.operationId, 'submitAgentDiagnostics');
  for (const code of ['200', '400', '401', '403', '405', '409', '413', '415', '503']) assert(spec.paths[route].post.responses[code]);
  matches(spec.components.schemas.AgentDiagnosticRequest, payload());
  const capabilities = (await exchange(api, '/openapi/v1/capabilities')).json;
  matches(spec.components.schemas.Capabilities, capabilities);
  assert.deepEqual(capabilities.collection_operations, ['snapshot', 'reset', 'inspect']);
  assert.equal(capabilities.collection.collector, 'sysak');
  assert.deepEqual(capabilities.agent_diagnostics, {
    route, method: 'POST', source: 'agentsight', operation: 'agent-diagnose', independent_evidence: true,
    requires_sysak_snapshot: false, requires_revision: false, mutates_sysak_snapshot: false,
    analyzer: 'local-rules', external_calls: false,
    source_limits: { processes: 256, sessions: 500, interruptions: 200, interruptionCounts: 1, latency: 256 },
  });
  assert.deepEqual((await exchange(api, '/openapi/v1/openapi.json')).json, spec);
}));

test('latency contract is an array of strict agent-group rows bounded at 256', () => {
  const schema = spec.components.schemas.AgentRawLatency;
  assert.equal(schema.type, 'array');
  assert.equal(schema.maxItems, 256);
  assert.deepEqual(schema.items, { $ref: '#/components/schemas/AgentRawLatencyRow' });
  assert.equal(spec.components.schemas.AgentDiagnostic.properties.latency.maxItems, 256);
  matches(schema, []);
  matches(schema, [latencyRow()]);
  matches(schema, [latencyRow(), latencyRow({ agent_name: 'agent-a' })]);
  matches(schema, Array.from({ length: 256 }, (_, i) => latencyRow({ agent_name: `agent-${i}` })));
  assert.throws(() => matches(schema, latencyRow()));
  assert.throws(() => matches(schema, Array.from({ length: 257 }, (_, i) => latencyRow({ agent_name: `agent-${i}` }))));
  assert.throws(() => matches(schema, [latencyRow({ extra: 'private-field' })]));
});

test('Bearer, Origin, POST-only, media and compression restrictions apply before evidence parsing', async () => withServer(async api => {
  for (const Authorization of ['', 'Basic x', 'Bearer wrong']) {
    const result = await rejected(api, payload(), 401, 'unauthorized', { headers: { Authorization } });
    assert.equal(result.headers['www-authenticate'], 'Bearer');
  }
  for (const Origin of ['null', api.baseUrl, 'https://invalid.example']) await rejected(api, payload(), 403, 'origin_not_allowed', { headers: { Origin } });
  for (const method of ['GET', 'PUT', 'OPTIONS']) {
    const result = await exchange(api, route, { method });
    assert.equal(result.status, 405);
    assert.equal(result.headers.allow, 'POST');
  }
  await rejected(api, payload(), 415, 'unsupported_media_type', { headers: { 'Content-Type': 'text/plain' } });
  await rejected(api, payload(), 415, 'unsupported_media_type', { headers: { 'Content-Encoding': 'gzip' } });
  await accepted(api);
}));

test('request shapes and ISO calendar/window boundaries fail closed without tasks or snapshots', async () => withServer(async api => {
  const invalidators = [
    body => { body.request_id = 'bad'; }, body => { body.device_id = null; }, body => { body.schema_version = '2.0'; },
    body => { body.parameters = { revision: 1 }; }, body => { body.operation = 'agent-diagnose'; }, body => { body.revision = 1; },
    body => { body.raw_snapshot = null; }, body => { body.raw_snapshot.schema_version = '2.0'; }, body => { body.raw_snapshot.source = 'sysak'; },
    body => { body.raw_snapshot.sources = []; }, body => { body.raw_snapshot.sources.other = source([]); },
    body => { body.raw_snapshot.sampled_at = '2026-02-31T12:00:00Z'; }, body => { body.raw_snapshot.sampled_at = '2026-11-11T24:00:00Z'; },
    body => { body.raw_snapshot.sampled_at = '2026-11-11T12:00:00'; }, body => { body.raw_snapshot.sampled_at = ms; },
    body => { body.raw_snapshot.window.start = 'bad'; }, body => { body.raw_snapshot.window.end = '2026-11-12T12:00:00Z'; },
    body => { body.raw_snapshot.window.start = '2026-11-12T12:00:00Z'; }, body => { body.raw_snapshot.window.extra = true; },
  ];
  for (const invalidate of invalidators) {
    const body = payload(); invalidate(body);
    await rejected(api, body);
    if (typeof body.device_id === 'string') assert.equal((await exchange(api, `/openapi/v1/devices/${body.device_id}/snapshot`)).status, 404);
  }
  for (const text of ['null', '[]', '1', '{', '"text"']) await rejected(api, undefined, 400, 'invalid_request', { text });
  await rejected(api, undefined, 400, 'invalid_request', { text: Buffer.from([0xff]) });
  const body = payload();
  await rejected(api, undefined, 400, 'invalid_request', { text: JSON.stringify(body).replace('{', '{"schema_version":"2.0",') });
  await accepted(api, body); // Rejected duplicate-envelope request was not cached.
}));

test('exact 10 MiB request and 8 MiB raw whitespace boundaries, Content-Length and chunked overflow', async () => withServer(async api => {
  const body = payload();
  let text = JSON.stringify(body);
  text += ' '.repeat(10 * MiB - Buffer.byteLength(text));
  assert.equal((await post(api, undefined, { text, headers: { 'Content-Length': 10 * MiB } })).status, 200);
  await rejected(api, undefined, 413, 'request_too_large', { text: `${text} `, headers: { 'Content-Length': 10 * MiB + 1 } });
  await rejected(api, undefined, 413, 'request_too_large', { text: `${text} `, headers: { 'Transfer-Encoding': 'chunked' } });
  const next = payload();
  const raw = JSON.stringify(next.raw_snapshot);
  const exact = `{${' '.repeat(8 * MiB - Buffer.byteLength(raw))}${raw.slice(1)}`;
  text = JSON.stringify(next).replace(raw, exact);
  assert.equal((await post(api, undefined, { text })).status, 200);
  const overflow = payload();
  const overflowRaw = JSON.stringify(overflow.raw_snapshot);
  text = JSON.stringify(overflow).replace(overflowRaw, `{${' '.repeat(8 * MiB)}${overflowRaw.slice(1)}`);
  await rejected(api, undefined, 413, 'raw_snapshot_too_large', { text });
}));

test('zero, null, ns/ms timestamps and complete observations preserve upstream semantics', async () => withServer(async api => {
  const body = payload();
  body.raw_snapshot.sources.latency = source([latencyRow({ call_count: 2, streaming_call_count: 1, ttft_ms: { p50: 0, p95: 12.5, p99: 15 }, tps_tokens_per_second: { p50: 0, p95: 1, p99: 2 }, e2e_latency_ms: { p50: 0, p95: 0, p99: 0 } })]);
  const { report } = await accepted(api, body);
  assert.equal(report.status, 'ok'); assert.equal(report.outcome, 'observed');
  assert.deepEqual(report.totals, { sessions: 1, inputTokens: 0, outputTokens: 0, unresolved: 0, critical: 0, high: 0 });
  assert.equal(report.lastScanAt, sampledAt);
  assert.equal(report.processes[0].lastCheckAt, sampledAt);
  assert.equal(report.processes[0].latencyMs, 0); assert.equal(report.processes[0].parentPid, null);
  assert.equal(report.sessions[0].firstSeenAt, new Date(ns / 1e6).toISOString());
  assert.equal(report.sessions[0].agent, null); assert.equal(report.sessions[0].model, null);
  assert.deepEqual(report.latency[0], { agent: null, calls: 2, streamingCalls: 1, ttftP95Ms: 12.5, e2eP95Ms: 0, tpsP50: 0, tpotP95Ms: null });
  assert.match(report.summary, /已采集会话/); assert.match(report.summary, /HTTP 任意状态响应/);
  assert.match(report.summary, /完整调用/); assert.match(report.summary, /包含辅助调用/);
  assert.match(report.summary, /不是会话终身累计/); assert.match(report.summary, /输入包含缓存用量/);
  assert.match(report.summary, /已采集列表/); assert.match(report.summary, /未报告 usage 的调用可能以零记录/);
  assert.doesNotMatch(report.summary, /默认排除辅助调用/);
  assert.deepEqual(Object.keys(report.totals).sort(), ['sessions', 'inputTokens', 'outputTokens', 'unresolved', 'critical', 'high'].sort(),
    'Historical unreported usage must not fabricate a missing-usage metric');
  body.request_id = crypto.randomUUID();
  body.raw_snapshot.window = { start: '1970-01-01T00:00:00.000Z', end: '1970-01-01T00:00:00.000Z' };
  body.raw_snapshot.sources.sessions.data[0] = sessionRow({ first_seen_ns: 0, last_seen_ns: 0 });
  const zero = (await accepted(api, body)).report;
  assert.equal(coverage(zero, 'sessions').status, 'available');
  assert.equal(zero.sessions[0].firstSeenAt, '1970-01-01T00:00:00.000Z');
  assert.equal(zero.sessions[0].lastSeenAt, '1970-01-01T00:00:00.000Z');
  assert.deepEqual([zero.totals.sessions, zero.totals.inputTokens, zero.totals.outputTokens], [1, 0, 0]);
}));

test('HTTP session window includes both boundaries and rejects an entire source with any out-of-window row', async () => withServer(async api => {
  const body = payload();
  const startNs = Number(BigInt(Date.parse(body.raw_snapshot.window.start)) * 1000000n);
  const endNs = Number(BigInt(Date.parse(body.raw_snapshot.window.end)) * 1000000n);
  // Use a whole ms offset: upstream numeric ns precision is display-only, not an exact ns identity.
  const oneMs = 1000000;
  const bounds = [[startNs, startNs], [endNs, endNs], [startNs, endNs], [startNs + oneMs, endNs - oneMs]];
  body.raw_snapshot.sources.sessions.data = bounds.map(([first_seen_ns, last_seen_ns], index) =>
    sessionRow({ session_id: `boundary-${index}`, first_seen_ns, last_seen_ns, total_input_tokens: index, total_output_tokens: index * 2 }));
  const inclusive = (await accepted(api, body)).report;
  assert.equal(coverage(inclusive, 'sessions').status, 'available');
  assert.equal(inclusive.sessions.length, 4);
  assert.equal(inclusive.sessions[0].firstSeenAt, body.raw_snapshot.window.start);
  assert.equal(inclusive.sessions[0].lastSeenAt, body.raw_snapshot.window.start);
  assert.equal(inclusive.sessions[1].firstSeenAt, body.raw_snapshot.window.end);
  assert.equal(inclusive.sessions[1].lastSeenAt, body.raw_snapshot.window.end);
  assert.deepEqual([inclusive.totals.sessions, inclusive.totals.inputTokens, inclusive.totals.outputTokens], [4, 6, 12]);

  const point = payload();
  point.raw_snapshot.window.start = point.raw_snapshot.window.end;
  const pointReport = (await accepted(api, point)).report;
  assert.equal(coverage(pointReport, 'sessions').status, 'available');
  assert.deepEqual([pointReport.totals.sessions, pointReport.totals.inputTokens, pointReport.totals.outputTokens], [1, 0, 0]);

  const outside = [
    [startNs - oneMs, startNs], [startNs - oneMs, startNs - oneMs],
    [startNs, endNs + oneMs], [endNs + oneMs, endNs + oneMs],
    [startNs - oneMs, endNs + oneMs],
  ];
  for (const [first_seen_ns, last_seen_ns] of outside) {
    for (const position of ['head', 'tail', 'past-cap']) {
      const invalid = payload();
      const valid = Array.from({ length: position === 'past-cap' ? 500 : 1 }, (_, index) =>
        sessionRow({ session_id: `valid-${index}`, total_input_tokens: 7, total_output_tokens: 9 }));
      const bad = sessionRow({ session_id: 'outside', first_seen_ns, last_seen_ns, total_input_tokens: 10, total_output_tokens: 20 });
      invalid.raw_snapshot.sources.sessions.data = position === 'head' ? [bad, ...valid] : [...valid, bad];
      const report = (await accepted(api, invalid)).report;
      assert.equal(coverage(report, 'sessions').status, 'invalid', `${position}: ${first_seen_ns}..${last_seen_ns}`);
      assert.match(coverage(report, 'sessions').reason, /整个来源/);
      assert.deepEqual(report.sessions, [], 'Do not silently discard only out-of-window rows, even after the 500-row cap');
      assert.deepEqual([report.totals.sessions, report.totals.inputTokens, report.totals.outputTokens], [null, null, null]);
      assert.equal(report.status, 'partial');
      assert.equal(report.outcome, 'unknown');
      assert.equal(coverage(report, 'processes').status, 'available', 'Other valid sources remain usable');
    }
  }
}));

test('HTTP 500 rows are complete but 501 rows or upstream truncation keep all three session totals unknown', async () => withServer(async api => {
  const body = payload();
  const rows = Array.from({ length: 501 }, (_, index) => sessionRow({ session_id: `session-${index}`, total_input_tokens: 2, total_output_tokens: 3 }));
  body.raw_snapshot.sources.sessions = source(rows.slice(0, 500));
  let report = (await accepted(api, body)).report;
  assert.equal(coverage(report, 'sessions').status, 'available');
  assert.deepEqual([report.totals.sessions, report.totals.inputTokens, report.totals.outputTokens], [500, 1000, 1500]);
  for (const sessions of [source(rows), source(rows.slice(0, 500), 'truncated', 'upstream limit'), source([], 'truncated', 'upstream limit')]) {
    body.request_id = crypto.randomUUID();
    body.raw_snapshot.sources.sessions = sessions;
    report = (await accepted(api, body)).report;
    assert.equal(coverage(report, 'sessions').status, 'truncated');
    assert.match(coverage(report, 'sessions').reason, /500.*不代表完整覆盖/);
    assert.equal(report.sessions.length, Math.min(sessions.data.length, 500));
    assert.deepEqual([report.totals.sessions, report.totals.inputTokens, report.totals.outputTokens], [null, null, null]);
    if (report.sessions.length) assert.deepEqual([report.sessions[0].inputTokens, report.sessions[0].outputTokens], [2, 3]);
    assert.equal(report.status, 'partial');
    assert.equal(report.outcome, 'unknown');
    assert.equal(report.totals.unresolved, 0, 'Unknown session totals do not overwrite recorded interruption zero');
  }
}));

test('single and multiple latency groups preserve nulls and zeros without aggregate quantiles', async () => withServer(async api => {
  const body = payload();
  const groups = [
    latencyRow({ agent_name: 'agent-a', call_count: 2, streaming_call_count: 1,
      ttft_ms: { p50: 0, p95: 0, p99: 0 }, tps_tokens_per_second: { p50: 0, p95: 1, p99: 2 },
      tpot_ms_per_token: { p50: 0, p95: 0, p99: 0 }, e2e_latency_ms: { p50: 5, p95: 10, p99: 15 } }),
    latencyRow({ agent_name: 'agent-b', call_count: 3, e2e_latency_ms: { p50: 0, p95: 0, p99: 0 } }),
    latencyRow(),
  ];
  const expected = [
    { agent: 'agent-a', calls: 2, streamingCalls: 1, ttftP95Ms: 0, e2eP95Ms: 10, tpsP50: 0, tpotP95Ms: 0 },
    { agent: 'agent-b', calls: 3, streamingCalls: 0, ttftP95Ms: null, e2eP95Ms: 0, tpsP50: null, tpotP95Ms: null },
    { agent: null, calls: 0, streamingCalls: 0, ttftP95Ms: null, e2eP95Ms: null, tpsP50: null, tpotP95Ms: null },
  ];
  body.raw_snapshot.sources.latency.data = groups.slice(0, 1);
  let report = (await accepted(api, body)).report;
  assert.equal(coverage(report, 'latency').status, 'available');
  assert.deepEqual(report.latency, expected.slice(0, 1));
  body.request_id = crypto.randomUUID();
  body.raw_snapshot.sources.latency.data = groups;
  report = (await accepted(api, body)).report;
  assert.equal(coverage(report, 'latency').status, 'available');
  assert.deepEqual(report.latency, expected);
  const latencyOnly = payload();
  latencyOnly.raw_snapshot.sources = { latency: source([]) };
  report = (await accepted(api, latencyOnly)).report;
  assert.equal(report.status, 'partial');
  assert.equal(report.outcome, 'unknown');
  assert.equal(coverage(report, 'latency').status, 'available');
  assert.deepEqual(report.latency, []);
  assert(Object.values(report.totals).every(value => value === null));
}));

test('empty evidence, all unavailable and malformed sources never fabricate health or zero measurements', async () => withServer(async api => {
  const empty = payload();
  empty.raw_snapshot.sources.processes.data.agents = [];
  empty.raw_snapshot.sources.sessions.data = [];
  empty.raw_snapshot.sources.latency.data = [];
  let report = (await accepted(api, empty)).report;
  assert.equal(report.status, 'ok'); assert.equal(report.outcome, 'unknown');
  assert.equal(report.totals.sessions, 0); assert.deepEqual(report.latency, []);
  assert.equal(coverage(report, 'latency').status, 'available');
  assert.equal(report.findings.length, 0);
  const missing = payload(); missing.raw_snapshot.sources = {};
  report = (await accepted(api, missing)).report;
  assert.equal(report.status, 'unavailable'); assert.equal(report.outcome, 'unknown');
  assert(Object.values(report.totals).every(value => value === null));
  assert.equal(report.findings.length, 5);
  const unavailable = payload();
  unavailable.raw_snapshot.sources = Object.fromEntries(Object.keys(unavailable.raw_snapshot.sources).map(key => [key, source(null, 'unavailable', 'not running')]));
  report = (await accepted(api, unavailable)).report;
  assert.equal(report.status, 'unavailable'); assert.equal(report.lastScanAt, null);
  unavailable.request_id = crypto.randomUUID();
  for (const key of Object.keys(unavailable.raw_snapshot.sources)) unavailable.raw_snapshot.sources[key] = source('malformed', 'available');
  report = (await accepted(api, unavailable)).report;
  assert.equal(report.status, 'unavailable'); assert.equal(report.outcome, 'unknown');
  assert(report.coverage.every(item => item.status === 'invalid'));
}));

test('scan zero/stale/future and unchecked rows are unknown; fresh probe findings are not confirmed root causes', () => {
  for (const scan of [0, ms - 120001, ms + 1]) {
    const body = payload();
    body.raw_snapshot.sources.processes.data.last_scan_time = scan;
    body.raw_snapshot.sources.processes.data.agents = [processRow({ status: 'hung' }), processRow({ pid: 13, status: 'offline', has_crash: true })];
    const report = parse(body);
    assert.equal(report.outcome, 'unknown'); assert(report.processes.every(row => row.status === 'unknown'));
    assert.match(report.findings.map(item => item.detail).join(' '), /仅为探活新鲜度阈值/);
    if (scan === 0) assert.equal(report.lastScanAt, null);
  }
  for (const check of [0, ms - 120001, ms + 1]) {
    const body = payload(); body.raw_snapshot.sources.processes.data.agents[0].last_check_time = check;
    const report = parse(body); assert.equal(report.outcome, 'unknown'); assert.equal(report.processes[0].status, 'unknown');
  }
  for (const [status, has_crash, outcome] of [['healthy', false, 'observed'], ['no_port', false, 'observed'], ['offline', false, 'observed'], ['offline', true, 'abnormal'], ['hung', false, 'abnormal'], ['unhealthy', false, 'abnormal'], ['unknown', false, 'unknown']]) {
    const body = payload(); body.raw_snapshot.sources.processes.data.agents = [processRow({ status, has_crash })];
    const report = parse(body); assert.equal(report.outcome, outcome);
    if (outcome === 'abnormal') assert.match(report.findings[0].detail, /故障根因尚未确认/);
    else assert.equal(report.findings.length, 0);
  }
});

test('nullable IDs and count > 200 use whole-window count, never list length; resolved events are not abnormalities', async () => withServer(async api => {
  const body = payload();
  body.raw_snapshot.sources.interruptions = source(Array.from({ length: 200 }, (_, i) => eventRow({ interruption_id: `event-${i}`, severity: 'critical' })), 'truncated', 'limit200');
  body.raw_snapshot.sources.interruptionCounts = source(countRow(900, 400, 300));
  const report = (await accepted(api, body)).report;
  assert.equal(report.status, 'partial'); assert.equal(report.outcome, 'abnormal');
  assert.deepEqual([report.totals.unresolved, report.totals.critical, report.totals.high], [900, 400, 300]);
  assert.equal(report.interruptions.length, 200);
  assert.equal(report.interruptions[0].sessionId, null); assert.equal(report.interruptions[0].callId, null); assert.equal(report.interruptions[0].pid, null);
  assert.equal(report.interruptions[0].occurredAt, new Date(ns / 1e6).toISOString());
  assert.match(coverage(report, 'interruptions').reason, /200.*不代表完整覆盖/);
  const listOnly = payload(); listOnly.raw_snapshot.sources = { interruptions: source([eventRow()]) };
  const partial = (await accepted(api, listOnly)).report;
  assert.equal(partial.outcome, 'abnormal'); assert.equal(partial.totals.unresolved, null); assert.equal(partial.totals.critical, null);
  const countsOnly = payload(); countsOnly.raw_snapshot.sources = { interruptionCounts: source(countRow(700, 300, 200)) };
  assert.equal((await accepted(api, countsOnly)).report.outcome, 'abnormal');
  const resolved = payload(); resolved.raw_snapshot.sources.interruptions = source([eventRow({ resolved: true })]);
  assert.equal((await accepted(api, resolved)).report.outcome, 'observed');
}));

test('all list caps and upstream truncated flags remain partial; truncated session/count totals stay null', () => {
  const body = payload();
  body.raw_snapshot.sources.processes.data.agents = Array.from({ length: 257 }, (_, i) => processRow({ pid: i }));
  body.raw_snapshot.sources.sessions.data = Array.from({ length: 501 }, (_, i) => sessionRow({ session_id: `s-${i}`, total_input_tokens: 1, total_output_tokens: 2 }));
  body.raw_snapshot.sources.interruptions.data = Array.from({ length: 201 }, (_, i) => eventRow({ interruption_id: `i-${i}` }));
  body.raw_snapshot.sources.latency.data = Array.from({ length: 257 }, (_, i) => latencyRow({ agent_name: `agent-${i}` }));
  let report = parse(body);
  assert.deepEqual([report.processes.length, report.sessions.length, report.interruptions.length, report.latency.length], [256, 500, 200, 256]);
  for (const key of ['processes', 'sessions', 'interruptions', 'latency']) assert.equal(coverage(report, key).status, 'truncated');
  assert.equal(report.latency[255].agent, 'agent-255');
  assert.match(coverage(report, 'latency').reason, /256.*不代表完整覆盖/);
  assert.deepEqual([report.totals.sessions, report.totals.inputTokens, report.totals.outputTokens], [null, null, null]);
  const upstream = payload(); upstream.raw_snapshot.sources.sessions.status = 'truncated';
  upstream.raw_snapshot.sources.interruptionCounts = source(countRow(4, 1, 2), 'truncated', 'partial count');
  upstream.raw_snapshot.sources.latency.status = 'truncated';
  report = parse(upstream);
  assert.equal(report.status, 'partial'); assert.equal(report.outcome, 'abnormal');
  assert(Object.values(report.totals).every(value => value === null));
  assert.equal(coverage(report, 'latency').status, 'truncated');
});

test('malformed individual sources invalidate their entire evidence, including invalid rows past caps', async () => withServer(async api => {
  const cases = [
    ['processes', data => { data.agents = {}; }], ['processes', data => { data.agents.push(processRow({ pid: 13, latency_ms: -1 })); }],
    ['processes', data => { data.agents[0].status = 'normal'; }], ['processes', data => { data.agents[0].has_crash = 'false'; }],
    ['processes', data => { data.agents[0].parent_pid = '1'; }], ['processes', data => { data.agents[0].ports = [65536]; }],
    ['processes', data => { data.agents[0].last_check_time = 1.5; }], ['processes', data => { data.filtered_count = -1; }],
    ['sessions', data => { data.push(sessionRow({ session_id: 's-2', total_input_tokens: null })); }],
    ['sessions', data => { data[0].conversation_count = 1.1; }], ['sessions', data => { data[0].first_seen_ns = -1; }],
    ['sessions', data => { data[0].first_seen_ns = ns + 1e9; }], ['sessions', data => { delete data[0].model; }],
    ['sessions', data => { data.push(sessionRow()); }],
    ['interruptions', data => { data.push(eventRow({ resolved: 'false' })); }], ['interruptions', data => { data.push(eventRow({ severity: 'fatal' })); }],
    ['interruptionCounts', data => { data.total = 1; }], ['interruptionCounts', data => { data.by_severity.high = -1; }],
    ['latency', data => { data[0].ttft_ms = { p95: 12 }; }], ['latency', data => { data[0].streaming_call_count = 1; }],
    ['latency', data => { data[0].e2e_latency_ms = { p50: 2, p95: 1, p99: 3 }; }],
    ['latency', data => { data.push(null); }], ['latency', data => { data.push([]); }],
    ['latency', data => { data.push(latencyRow({ agent_name: 'bad-agent', call_count: -1 })); }],
    ['latency', data => { data[0].agent_name = ''; }], ['latency', data => { delete data[0].tpot_ms_per_token; }],
    ['latency', data => { data.push(latencyRow()); }],
    ['latency', data => { data[0].agent_name = 'duplicate'; data.push(latencyRow({ agent_name: 'duplicate', call_count: 1 })); }],
    ['latency', data => { data[0].detail = 'private-latency-field'; }],
    ['latency', data => { data[0].ttft_ms = { p50: 0, p95: 0, p99: 0, detail: 'private-quantile-field' }; }],
  ];
  for (const [key, mutate] of cases) {
    const body = payload(); mutate(body.raw_snapshot.sources[key].data);
    const report = (await accepted(api, body)).report;
    assert.equal(coverage(report, key).status, 'invalid', key); assert.equal(report.status, 'partial'); assert.equal(report.outcome, 'unknown');
    if (key === 'processes') assert.deepEqual(report.processes, []);
    if (key === 'sessions') { assert.deepEqual(report.sessions, []); assert.equal(report.totals.sessions, null); }
    if (key === 'interruptions') assert.deepEqual(report.interruptions, []);
    if (key === 'interruptionCounts') assert.equal(report.totals.unresolved, null);
    if (key === 'latency') assert.deepEqual(report.latency, []);
  }
  for (const malformed of [null, [], { status: 'healthy', reason: '', data: [] }, { status: 'available', data: [] }, source([], 'unavailable'), source(null), source(null, 'invalid', 'x'.repeat(513))]) {
    const body = payload(); body.raw_snapshot.sources.sessions = malformed;
    assert.equal(coverage((await accepted(api, body)).report, 'sessions').status, 'invalid');
  }
  const body = payload(); body.raw_snapshot.sources.latency.data = latencyRow();
  const objectReport = (await accepted(api, body)).report;
  assert.equal(coverage(objectReport, 'latency').status, 'invalid');
  assert.deepEqual(objectReport.latency, []);
  const beyond = payload();
  beyond.raw_snapshot.sources.sessions.data = Array.from({ length: 501 }, (_, i) => sessionRow({ session_id: `s-${i}` }));
  beyond.raw_snapshot.sources.sessions.data[500].total_output_tokens = -1;
  assert.deepEqual((await accepted(api, beyond)).report.sessions, []);
  for (const last of [null, latencyRow({ agent_name: 'bad-tail', call_count: -1 }), latencyRow({ agent_name: 'agent-0' })]) {
    const latencyBeyond = payload();
    latencyBeyond.raw_snapshot.sources.latency.data = [
      ...Array.from({ length: 256 }, (_, i) => latencyRow({ agent_name: `agent-${i}` })), last,
    ];
    const report = (await accepted(api, latencyBeyond)).report;
    assert.equal(coverage(report, 'latency').status, 'invalid');
    assert.deepEqual(report.latency, []);
  }
}));

test('nonfinite numbers, unsafe sums and duplicate identities do not become zeros or complete measurements', () => {
  for (const bad of [NaN, Infinity, -Infinity, -1, '0', null, Number.MAX_SAFE_INTEGER + 1]) {
    const body = payload(); body.raw_snapshot.sources.sessions.data[0].total_input_tokens = bad;
    const report = parse(body); assert.equal(coverage(report, 'sessions').status, 'invalid'); assert.equal(report.totals.inputTokens, null);
  }
  for (const bad of [NaN, Infinity, -Infinity, -1, '0', null]) {
    const body = payload();
    body.raw_snapshot.sources.latency.data[0] = latencyRow({ call_count: 1, ttft_ms: { p50: bad, p95: 0, p99: 0 } });
    const report = parse(body);
    assert.equal(coverage(report, 'latency').status, 'invalid');
    assert.deepEqual(report.latency, []);
  }
  for (const bad of [NaN, Infinity, -Infinity, -1, '0', null, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const body = payload(); body.raw_snapshot.sources.latency.data[0].call_count = bad;
    assert.equal(coverage(parse(body), 'latency').status, 'invalid');
  }
  for (const key of ['processes', 'sessions', 'interruptions', 'latency']) {
    const body = payload();
    if (key === 'processes') body.raw_snapshot.sources.processes.data.agents = [processRow(), processRow()];
    if (key === 'sessions') body.raw_snapshot.sources.sessions.data = [sessionRow(), sessionRow()];
    if (key === 'interruptions') body.raw_snapshot.sources.interruptions.data = [eventRow(), eventRow()];
    if (key === 'latency') body.raw_snapshot.sources.latency.data = [latencyRow(), latencyRow()];
    assert.equal(coverage(parse(body), key).status, 'invalid');
  }
  const overflow = payload();
  overflow.raw_snapshot.sources.sessions.data = [sessionRow({ total_input_tokens: Number.MAX_SAFE_INTEGER }), sessionRow({ session_id: 's-2', total_input_tokens: 1 })];
  const report = parse(overflow); assert.equal(coverage(report, 'sessions').status, 'invalid'); assert.deepEqual(report.sessions, []);
});

test('unknown interruption types remain safe text; severity/type suggestions never trigger actions or leak detail', async () => withServer(async api => {
  for (const interruption_type of ['constructor', '__proto__', '<script>touch /tmp/nope</script>\n', 'new_upstream_type', 'user_cancel', 'llm_error', 'dead_loop', 'sse_truncated', 'context_overflow', 'token_limit', 'agent_crash']) {
    const body = payload();
    body.raw_snapshot.sources.interruptions = source([eventRow({ interruption_type, severity: 'high' })]);
    body.raw_snapshot.sources.interruptionCounts = source(countRow(1, 0, 1));
    const report = (await accepted(api, body)).report;
    assert.equal(report.outcome, 'abnormal');
    const finding = report.findings.find(item => item.title.startsWith('未处理中断'));
    assert.equal(finding.severity, 'error'); assert.equal(typeof finding.suggestion, 'string');
    assert.doesNotMatch(JSON.stringify(finding), /<script>|function Object|native code/);
    if (['constructor', '__proto__', 'new_upstream_type'].includes(interruption_type)) {
      assert.equal(report.interruptions[0].type, interruption_type); assert.match(finding.title, /未知类型/);
    }
    if (interruption_type === 'user_cancel') assert.match(finding.suggestion, /不等于 Agent 故障/);
  }
  const privateBody = payload();
  privateBody.raw_snapshot.sources.interruptions = source([eventRow({ detail: 'secret-user-question-and-path' })]);
  const safe = (await accepted(api, privateBody)).report;
  assert.equal(coverage(safe, 'interruptions').status, 'invalid');
  assert(!JSON.stringify(safe).includes('secret-user-question-and-path'));
  assert.equal(forbiddenCalls, 0);
}));

test('real parsing performs no external HTTP, LLM/fetch, shell, restart or process actions', async () => {
  const childProcess = require('node:child_process');
  const https = require('node:https');
  const changes = [
    [globalThis, 'fetch'], [process, 'kill'], [http, 'request'], [http, 'get'], [https, 'request'], [https, 'get'],
    ...['exec', 'execSync', 'execFile', 'execFileSync', 'spawn', 'spawnSync', 'fork'].map(key => [childProcess, key]),
  ];
  const saved = changes.map(([owner, key]) => [owner, key, owner[key]]);
  for (const [owner, key] of changes) owner[key] = forbidden;
  try {
    await withServer(async api => {
      const body = payload();
      body.raw_snapshot.sources.processes.data.agents[0] = processRow({ status: 'offline', has_crash: true });
      body.raw_snapshot.sources.interruptions = source([eventRow({ interruption_type: 'llm_error', severity: 'critical' })]);
      body.raw_snapshot.sources.interruptionCounts = source(countRow(1, 1));
      const result = await accepted(api, body);
      assert.equal(result.report.outcome, 'abnormal');
      assert.deepEqual(await accepted(api, body), result);
      assert.equal((await exchange(api, `/openapi/v1/tasks/${result.task_id}`)).status, 200);
      await rejected(api, { ...payload(), command: 'restart; resolve; kill' });
      assert.equal(forbiddenCalls, 0);
    });
  } finally {
    for (const [owner, key, original] of saved) owner[key] = original;
  }
});

test('independent submission, replay bytes/route conflicts, synchronous tasks and SysAK snapshots/revisions are unchanged', async () => withServer(async api => {
  const body = payload();
  const concurrent = await Promise.all([accepted(api, body), accepted(api, body)]);
  assert.deepEqual(concurrent[0], concurrent[1]);
  assert.equal((await exchange(api, `/openapi/v1/devices/${body.device_id}/snapshot`)).status, 404);
  const task = await exchange(api, `/openapi/v1/tasks/${concurrent[0].task_id.toUpperCase()}`);
  assert.deepEqual(task.json.task, concurrent[0].task);
  matches(spec.components.schemas.TaskResponse, task.json);
  await rejected(api, undefined, 409, 'idempotency_conflict', { text: JSON.stringify(body, null, 2) });
  const changed = structuredClone(body); changed.raw_snapshot.sources.processes.data.filtered_count = 1;
  await rejected(api, changed, 409, 'idempotency_conflict');
  assert.equal((await exchange(api, '/openapi/v1/collections', { method: 'POST', body })).status, 409);
  const initialBody = sysak(body.device_id);
  const initial = await exchange(api, '/openapi/v1/collections', { method: 'POST', body: initialBody });
  assert.equal(initial.status, 200); matches(spec.components.schemas.CollectionResponse, initial.json);
  assert.equal(initial.json.state.revision, 1);
  const next = payload(); next.device_id = body.device_id;
  next.raw_snapshot.sources.processes.data.agents[0].status = 'hung';
  assert.equal((await accepted(api, next)).report.outcome, 'abnormal');
  assert.deepEqual((await exchange(api, `/openapi/v1/devices/${body.device_id}/snapshot`)).json, initial.json);
  assert.deepEqual((await accepted(api, body)), concurrent[0]);
  const inspect = sysak(body.device_id, 'inspect', { revision: 1 });
  const inspected = await exchange(api, '/openapi/v1/collections', { method: 'POST', body: inspect });
  assert.equal(inspected.status, 200); assert.equal(inspected.json.state.revision, 2);
  const stale = sysak(body.device_id, 'inspect', { revision: 1 });
  const conflict = await exchange(api, '/openapi/v1/collections', { method: 'POST', body: stale });
  assert.equal(conflict.status, 409); assert.equal(conflict.json.error.code, 'revision_conflict');
  await accepted(api, { ...payload(), device_id: body.device_id });
  assert.deepEqual((await exchange(api, `/openapi/v1/devices/${body.device_id}/snapshot`)).json, inspected.json);
  const legacyWrite = sysak(body.device_id, 'cleanup', { revision: 2 });
  assert.equal((await exchange(api, '/openapi/v1/collections', { method: 'POST', body: legacyWrite })).json.error.code, 'read_only');
  const wrongRoute = await post(api, initialBody);
  assert.equal(wrongRoute.status, 409); assert.equal(wrongRoute.json.error.code, 'idempotency_conflict');
  const wrongCollector = sysak(); wrongCollector.raw_snapshot = payload().raw_snapshot;
  assert.equal((await exchange(api, '/openapi/v1/collections', { method: 'POST', body: wrongCollector })).status, 400);
}));

test('shared FIFO retains at most 100 tasks/results without AgentSight consuming device capacity', async () => withServer(async api => {
  const deviceId = crypto.randomUUID();
  const old = sysak(deviceId);
  const initial = (await exchange(api, '/openapi/v1/collections', { method: 'POST', body: old })).json;
  const firstBody = payload();
  const first = await accepted(api, firstBody);
  const results = [];
  for (let i = 0; i < 98; i++) results.push(await accepted(api));
  assert.deepEqual(await accepted(api, firstBody), first); // Replay must not refresh FIFO.
  results.push(await accepted(api));
  assert.equal((await exchange(api, `/openapi/v1/tasks/${initial.task_id}`)).status, 404);
  assert.equal((await exchange(api, `/openapi/v1/tasks/${first.task_id}`)).status, 200);
  results.push(await accepted(api));
  assert.equal((await exchange(api, `/openapi/v1/tasks/${first.task_id}`)).status, 404);
  for (const result of results) assert.equal((await exchange(api, `/openapi/v1/tasks/${result.task_id}`)).status, 200);
  assert.deepEqual((await exchange(api, `/openapi/v1/devices/${deviceId}/snapshot`)).json, initial);
  const replayAfterEviction = await accepted(api, firstBody);
  assert.notEqual(replayAfterEviction.task_id, first.task_id);
  assert.equal((await exchange(api, `/openapi/v1/tasks/${results[0].task_id}`)).status, 404);
  for (let i = 0; i < 31; i++) assert.equal((await exchange(api, '/openapi/v1/collections', { method: 'POST', body: sysak() })).status, 200);
  assert.equal((await exchange(api, '/openapi/v1/collections', { method: 'POST', body: sysak() })).json.error.code, 'device_capacity');
  await accepted(api); // Independent route still accepts evidence at full SysAK device capacity.
  assert.equal(forbiddenCalls, 0);
}));
