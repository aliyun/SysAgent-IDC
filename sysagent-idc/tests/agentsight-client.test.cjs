const assert = require('node:assert/strict');
const { test } = require('node:test');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');
const ts = require('typescript');
const { collectAgentEvidence, agentSightUrl } = require('../electron/agentsight-client.cjs');
const { createIdcController } = require('../electron/idc-controller.cjs');

async function fixture(t, handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  return `http://127.0.0.1:${server.address().port}`;
}

function dataFor(now = Date.now()) {
  const ns = Number(BigInt(now) * 1000000n);
  return {
    '/api/agent-process-health': { agents: [
      { pid: 101, agent_name: 'Fixture Agent', role: 'gateway', status: 'healthy', ports: [9000], last_check_time: now,
        latency_ms: 0, has_crash: false, restart_cmd: ['fixture-secret-not-real'], exe_path: '/fixture/private', workspace_path: '/fixture/private' },
      { pid: 102, agent_name: 'Fixture CLI', role: 'client', status: 'no_port', ports: [], last_check_time: now,
        latency_ms: null, parent_pid: 101, has_crash: false },
    ], last_scan_time: now, filtered_count: 1 },
    '/api/sessions': [{ session_id: 'fixture-session', conversation_count: 2, first_seen_ns: ns - 1000000000,
      last_seen_ns: ns, total_input_tokens: 0, total_output_tokens: 45, agent_name: 'Fixture Agent', model: 'fixture-model',
      first_user_query: 'fixture-private-query', last_user_query: 'fixture-private-query' }],
    '/api/interruptions': [{ interruption_id: 'fixture-interruption', session_id: null, call_id: null, pid: null, agent_name: null,
      interruption_type: 'llm_error', severity: 'high', occurred_at_ns: ns, resolved: false, detail: 'fixture-private-detail' }],
    '/api/interruptions/count': { total: 1, by_severity: { critical: 0, high: 1, medium: 0, low: 0 } },
    '/api/metrics/latency': [
      { agent_name: null, call_count: 2, streaming_call_count: 1, ttft_ms: null,
        tps_tokens_per_second: { p50: 0, p95: 0, p99: 0, detail: 'fixture-private-quantile' },
        tpot_ms_per_token: null, e2e_latency_ms: { p50: 10, p95: 20, p99: 30 }, detail: 'fixture-private-latency' },
      { agent_name: 'Fixture Agent', call_count: 1, streaming_call_count: 0, ttft_ms: null,
        tps_tokens_per_second: null, tpot_ms_per_token: null,
        e2e_latency_ms: { p50: 0, p95: 0, p99: 0, prompt: 'fixture-private-second-quantile' },
        prompt: 'fixture-private-second-latency', exe_path: '/fixture/private' },
    ],
  };
}

const send = (response, data) => { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(data)); };

// Interpret real TS modules in memory without bundling, emission or external actions.
const projectRoot = path.resolve(__dirname, '..');
const testModules = new Map();
function loadTestModule(filename) {
  const absolute = path.resolve(filename);
  if (testModules.has(absolute)) return testModules.get(absolute).exports;
  assert(absolute.startsWith(`${projectRoot}${path.sep}`), 'Only project modules may load');
  const module = { exports: {} };
  testModules.set(absolute, module);
  if (absolute.endsWith('.json')) module.exports = JSON.parse(fs.readFileSync(absolute, 'utf8'));
  else {
    const compiled = ts.transpileModule(fs.readFileSync(absolute, 'utf8'), {
      fileName: absolute,
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
    }).outputText;
    const forbidden = () => assert.fail('OpenAPI/parser must not perform external, model or process actions');
    const execute = vm.runInThisContext(`(function(require,module,exports,fetch){${compiled}\n})`, { filename: absolute });
    execute(id => {
      if (id === 'node:crypto') return crypto;
      if (id === 'node:http') return { createServer: http.createServer, request: forbidden, get: forbidden };
      if (!id.startsWith('.')) return forbidden();
      const target = path.resolve(path.dirname(absolute), id);
      return loadTestModule(path.extname(target) ? target : `${target}.ts`);
    }, module, module.exports, forbidden);
  }
  return module.exports;
}
const loadOpenApi = () => loadTestModule(path.join(projectRoot, 'openapi-service.ts')).startMockOpenApi;
const parseEvidence = raw => loadTestModule(path.join(projectRoot, 'agent-diagnostics.ts')).parseAgentDiagnostic(raw);

function fakeAgentScheduler(now) {
  return {
    time: now,
    now() { return this.time; },
    setTimeout() { assert.fail('Missing SysAK fixture must not schedule inspections'); },
    clearTimeout() { assert.fail('No inspection timer should exist'); },
  };
}

test('AgentSight URL accepts only fixed local origins without embedded credentials', () => {
  assert.equal(agentSightUrl('http://127.0.0.1:7396'), 'http://127.0.0.1:7396');
  assert.equal(agentSightUrl('https://[::1]:7396/'), 'https://[::1]:7396');
  for (const url of ['file:///etc/passwd', 'http://example.test', 'http://127.0.0.1@remote.test', 'http://test:password@localhost',
    'http://localhost/path', 'http://localhost?token=fixture', 'http://localhost/#fragment', 'invalid']) {
    assert.throws(() => agentSightUrl(url), { code: 'INVALID_AGENTSIGHT_URL' });
  }
});

test('collects only allowlisted GET endpoints with exact ns window and strips sensitive fields', async t => {
  const now = 1794369600123;
  const data = dataFor(now);
  const seen = [];
  const baseUrl = await fixture(t, (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    seen.push({ method: request.method, url, auth: request.headers.authorization });
    send(response, data[url.pathname]);
  });
  const raw = await collectAgentEvidence({ baseUrl, token: 'fixture-token', now });
  assert.equal(seen.length, 5);
  assert(seen.every(item => item.method === 'GET' && item.auth === 'Bearer fixture-token'));
  for (const item of seen.filter(item => item.url.pathname !== '/api/agent-process-health')) {
    assert.equal(item.url.searchParams.get('end_ns'), String(BigInt(now) * 1000000n));
    assert.equal(item.url.searchParams.get('start_ns'), String(BigInt(now - 86400000) * 1000000n));
  }
  assert.deepEqual(raw.window, { start: new Date(now - 86400000).toISOString(), end: new Date(now).toISOString() });
  const sessions = seen.find(item => item.url.pathname === '/api/sessions').url;
  const latency = seen.find(item => item.url.pathname === '/api/metrics/latency').url;
  assert.equal(sessions.searchParams.get('include_auxiliary'), 'true');
  assert.equal(latency.searchParams.get('include_auxiliary'), null, 'Latency defaults to all calls');
  assert.deepEqual(['start_ns', 'end_ns'].map(key => sessions.searchParams.get(key)),
    ['start_ns', 'end_ns'].map(key => latency.searchParams.get(key)));
  const list = seen.find(item => item.url.pathname === '/api/interruptions').url;
  assert.equal(list.searchParams.get('resolved'), 'false');
  assert.equal(list.searchParams.get('limit'), '200');
  const count = seen.find(item => item.url.pathname === '/api/interruptions/count').url;
  assert.equal(count.searchParams.get('resolved'), null);
  assert.equal(count.searchParams.get('limit'), null);
  assert.equal(raw.sources.processes.data.agents[0].latency_ms, 0);
  assert.equal(raw.sources.processes.data.agents[0].parent_pid, null);
  assert(Date.parse(raw.sampled_at) >= Date.parse(raw.window.end));
  assert.equal(raw.sources.latency.status, 'available');
  assert.deepEqual(raw.sources.latency.data, [
    { agent_name: null, call_count: 2, streaming_call_count: 1, ttft_ms: null,
      tps_tokens_per_second: { p50: 0, p95: 0, p99: 0 }, tpot_ms_per_token: null, e2e_latency_ms: { p50: 10, p95: 20, p99: 30 } },
    { agent_name: 'Fixture Agent', call_count: 1, streaming_call_count: 0, ttft_ms: null,
      tps_tokens_per_second: null, tpot_ms_per_token: null, e2e_latency_ms: { p50: 0, p95: 0, p99: 0 } },
  ]);
  assert.equal(raw.sources.sessions.data[0].total_input_tokens, 0);
  assert(!JSON.stringify(raw).includes('fixture-secret-not-real'));
  assert(!JSON.stringify(raw).includes('/fixture/private'));
  assert(!JSON.stringify(raw).includes('fixture-private-query'));
  assert(!JSON.stringify(raw).includes('fixture-private-detail'));
  assert.doesNotMatch(JSON.stringify(raw), /fixture-private-(?:latency|quantile|second-latency|second-quantile)/);
});

test('real HTTP includes main and auxiliary sessions in the latency window without adding cached tokens twice', async t => {
  const now = 1794369600123;
  const data = dataFor(now);
  const kinds = ['main', 'recap', 'web_search', 'analyzer'];
  const input = [120, 60, 90, 45];
  const output = [11, 22, 33, 44];
  const cache = [100, 50, 80, 40];
  const sessions = kinds.map((kind, index) => ({ ...data['/api/sessions'][0],
    session_id: `fixture-${kind}`, conversation_count: 1, total_input_tokens: input[index], total_output_tokens: output[index],
    call_type: kind, cache_read_input_tokens: cache[index], cache_creation_input_tokens: 5,
  }));
  const latency = [{ ...data['/api/metrics/latency'][0], call_count: 4, streaming_call_count: 0 }];
  const seen = [];
  const baseUrl = await fixture(t, (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    assert.equal(request.method, 'GET');
    assert(Object.hasOwn(data, url.pathname), 'No conversation, body or additional endpoint may be requested');
    seen.push(url);
    if (url.pathname === '/api/sessions') {
      // This wrapper models upstream's default exclusion; the shared UI fixture stays untouched.
      send(response, url.searchParams.get('include_auxiliary') === 'true' ? sessions : sessions.slice(0, 1));
    } else send(response, url.pathname === '/api/metrics/latency' ? latency : data[url.pathname]);
  });
  const raw = await collectAgentEvidence({ baseUrl, token: 'fixture-token', now });
  assert.equal(seen.length, 5);
  assert.deepEqual(seen.map(url => url.pathname).sort(), Object.keys(data).sort());
  const sessionUrl = seen.find(url => url.pathname === '/api/sessions');
  const latencyUrl = seen.find(url => url.pathname === '/api/metrics/latency');
  assert.equal(sessionUrl.searchParams.get('include_auxiliary'), 'true');
  assert.equal(latencyUrl.searchParams.get('include_auxiliary'), null);
  for (const url of [sessionUrl, latencyUrl]) {
    assert.equal(url.searchParams.get('start_ns'), String(BigInt(now - 86400000) * 1000000n));
    assert.equal(url.searchParams.get('end_ns'), String(BigInt(now) * 1000000n));
  }
  assert.deepEqual(raw.sources.sessions.data.map(row => row.session_id), kinds.map(kind => `fixture-${kind}`));
  assert.deepEqual(raw.sources.sessions.data.map(row => row.total_input_tokens), input);
  assert.deepEqual(raw.sources.sessions.data.map(row => row.total_output_tokens), output);
  assert.doesNotMatch(JSON.stringify(raw), /cache_read_input_tokens|cache_creation_input_tokens|call_type|fixture-private-query/);
  const report = parseEvidence(raw);
  assert.equal(report.coverage.find(item => item.key === 'sessions').status, 'available');
  assert.deepEqual([report.totals.sessions, report.totals.inputTokens, report.totals.outputTokens], [4, 315, 110]);
  assert.equal(report.latency[0].calls, 4);
  assert.match(report.summary, /包含辅助调用/);
  assert.match(report.summary, /不是会话终身累计/);
  assert.match(report.summary, /输入包含缓存用量/);

  for (const auxiliary of [null, 'false']) {
    const url = new URL(`${sessionUrl.pathname}${sessionUrl.search}`, baseUrl);
    assert.equal(url.origin, baseUrl, 'Control queries must stay on the ephemeral HTTP fixture');
    if (auxiliary === null) url.searchParams.delete('include_auxiliary');
    else url.searchParams.set('include_auxiliary', auxiliary);
    const response = await fetch(url, { redirect: 'error' });
    assert.equal(response.status, 200);
    const excluded = await response.json();
    assert.deepEqual(excluded.map(row => row.session_id), ['fixture-main']);
    assert.equal(excluded[0].total_input_tokens, 120);
  }
});

test('latency endpoint accepts empty and single-group arrays but rejects a legacy object', async t => {
  const data = dataFor();
  const baseUrl = await fixture(t, (request, response) => send(response, data[new URL(request.url, 'http://localhost').pathname]));
  data['/api/metrics/latency'] = [];
  let raw = await collectAgentEvidence({ baseUrl });
  assert.deepEqual(raw.sources.latency, { status: 'available', reason: '', data: [] });
  const row = { agent_name: 'Single Agent', call_count: 0, streaming_call_count: 0,
    ttft_ms: null, tps_tokens_per_second: null, tpot_ms_per_token: null, e2e_latency_ms: null };
  data['/api/metrics/latency'] = [row];
  raw = await collectAgentEvidence({ baseUrl });
  assert.equal(raw.sources.latency.status, 'available');
  assert.deepEqual(raw.sources.latency.data, [row]);
  data['/api/metrics/latency'] = row;
  raw = await collectAgentEvidence({ baseUrl });
  assert.equal(raw.sources.latency.status, 'invalid');
  assert.equal(raw.sources.latency.data, null);
});

test('caps lists and keeps aggregate interruption counts distinct from returned rows', async t => {
  const now = 1794369600123;
  const data = dataFor(now);
  data['/api/sessions'] = Array.from({ length: 501 }, (_, index) => ({ ...data['/api/sessions'][0], session_id: `fixture-${index}` }));
  data['/api/metrics/latency'] = Array.from({ length: 257 }, (_, index) => ({ ...data['/api/metrics/latency'][0], agent_name: `fixture-agent-${index}` }));
  data['/api/interruptions/count'] = { total: 250, by_severity: { critical: 10, high: 240, medium: 0, low: 0 } };
  const baseUrl = await fixture(t, (request, response) => send(response, data[new URL(request.url, 'http://localhost').pathname]));
  const raw = await collectAgentEvidence({ baseUrl, now, token: 'fixture-token' });
  assert.equal(raw.sources.sessions.status, 'truncated');
  assert.match(raw.sources.sessions.reason, /500/);
  assert.equal(raw.sources.sessions.data.length, 500);
  assert.equal(raw.sources.sessions.data[499].session_id, 'fixture-499');
  const report = parseEvidence(raw);
  assert.equal(report.coverage.find(item => item.key === 'sessions').status, 'truncated');
  assert.equal(report.sessions.length, 500);
  assert.equal(report.sessions[0].inputTokens, 0);
  assert.equal(report.sessions[0].outputTokens, 45);
  assert.deepEqual([report.totals.sessions, report.totals.inputTokens, report.totals.outputTokens], [null, null, null],
    '501 rows must not turn the displayed 500 rows into complete session/token totals');
  assert.equal(raw.sources.latency.status, 'truncated');
  assert.match(raw.sources.latency.reason, /256/);
  assert.equal(raw.sources.latency.data.length, 256);
  assert.equal(raw.sources.latency.data[255].agent_name, 'fixture-agent-255');
  assert(raw.sources.latency.data.every(row => !Object.hasOwn(row, 'detail') && !Object.hasOwn(row.tps_tokens_per_second, 'detail')));
  assert.equal(raw.sources.interruptions.status, 'truncated');
  assert.equal(raw.sources.interruptionCounts.data.total, 250);
});

test('source HTTP, malformed JSON, shape, size and timeout failures remain unavailable or invalid', async t => {
  const baseUrl = await fixture(t, (request, response) => {
    const route = new URL(request.url, 'http://localhost').pathname;
    if (route === '/api/agent-process-health') { response.writeHead(401); response.end('fixture-private-error'); }
    else if (route === '/api/sessions') send(response, {});
    else if (route === '/api/interruptions') { response.writeHead(200, { 'content-type': 'application/json' }); response.end('{'); }
    else if (route === '/api/interruptions/count') { response.writeHead(200, { 'content-type': 'application/json', 'content-length': 3 * 1024 * 1024 }); response.end('{}'); }
  });
  const raw = await collectAgentEvidence({ baseUrl, timeoutMs: 40 });
  assert.equal(raw.sources.processes.status, 'unavailable');
  assert.match(raw.sources.processes.reason, /鉴权/);
  assert.equal(raw.sources.sessions.status, 'invalid');
  assert.equal(raw.sources.interruptions.status, 'invalid');
  assert.equal(raw.sources.interruptionCounts.status, 'invalid');
  assert.match(raw.sources.latency.reason, /超时/);
  assert(!JSON.stringify(raw).includes('fixture-private-error'));
});

test('does not follow redirects or permit canceled collection to become an empty success', async t => {
  let targetCalls = 0;
  const target = await fixture(t, (_request, response) => { targetCalls++; send(response, {}); });
  const baseUrl = await fixture(t, (_request, response) => { response.writeHead(302, { location: target }); response.end(); });
  const raw = await collectAgentEvidence({ baseUrl });
  assert(Object.values(raw.sources).every(source => source.status === 'unavailable'));
  assert.equal(targetCalls, 0);
  const signal = AbortSignal.abort();
  await assert.rejects(collectAgentEvidence({ baseUrl, signal }), { code: 'COLLECTION_CANCELLED' });
});

test('controller routes AgentSight through real OpenAPI without requiring SysAK installation and caches separately', async t => {
  const data = dataFor();
  let requests = 0;
  const baseUrl = await fixture(t, (request, response) => {
    requests++;
    send(response, data[new URL(request.url, 'http://localhost').pathname]);
  });
  const controller = await createIdcController({ bundleRoot: path.join(__dirname, 'missing-sysak-fixture'), startMockOpenApi: loadOpenApi(), agentSight: { baseUrl } });
  t.after(() => controller.close());
  assert.equal(controller.status().installed, false);
  const [first, second] = await Promise.all([controller.agentSnapshot(), controller.agentSnapshot(true)]);
  assert.equal(requests, 5);
  assert.equal(first.source, 'agentsight');
  assert.equal(first.analyzer, 'sysom-openapi');
  assert.equal(first.totals.unresolved, 1);
  assert.equal(first.outcome, 'abnormal');
  assert.equal(first.totals.inputTokens, 0);
  assert.equal(first.latency[0].ttftP95Ms, null);
  assert.equal(first.latency[0].tpsP50, 0);
  assert.deepEqual(first.latency, [
    { agent: null, calls: 2, streamingCalls: 1, ttftP95Ms: null, e2eP95Ms: 20, tpsP50: 0, tpotP95Ms: null },
    { agent: 'Fixture Agent', calls: 1, streamingCalls: 0, ttftP95Ms: null, e2eP95Ms: 0, tpsP50: null, tpotP95Ms: null },
  ]);
  assert.equal(first.processes[0].latencyMs, 0);
  assert.equal(first.interruptions[0].sessionId, null);
  assert.deepEqual(second, first);
  first.sessions.length = 0;
  const cached = await controller.agentSnapshot();
  assert.equal(cached.sessions.length, 1);
  assert.equal(requests, 5);
  await controller.agentSnapshot(true);
  assert.equal(requests, 10);
  const view = controller.queryView();
  assert.equal(view.state, null);
  assert.equal(view.agent.sessions.length, 1);
  assert.equal(view.tasks.length, 2);
  assert.equal(view.tasks[0].operation, 'agent-diagnose');
  assert.equal(view.tasks[0].simulated, false);
  view.agent.sessions.length = 0;
  view.tasks.length = 0;
  assert.equal(controller.queryView().agent.sessions.length, 1);
  assert.equal(controller.queryView().tasks.length, 2);
  assert.equal(requests, 10);
  await assert.rejects(controller.snapshot(), /sysAK/);
  await assert.rejects(controller.agentSnapshot('true'), { code: 'INVALID_PARAMETERS' });
  controller.setEnabled(false);
  await assert.rejects(controller.agentSnapshot(), { code: 'COLLECTOR_DISABLED' });
});

test('fake scheduler reuses through 59999 ms, expires at 60000 ms and deduplicates five-endpoint recollection', async t => {
  const scheduler = fakeAgentScheduler(1794369600123);
  let requests = 0;
  let roundData;
  let hold = false;
  let reached;
  const held = [];
  const paths = [];
  const baseUrl = await fixture(t, (request, response) => {
    if (requests % 5 === 0) roundData = dataFor(scheduler.now());
    requests++;
    const route = new URL(request.url, 'http://localhost').pathname;
    paths.push(route);
    assert(Object.hasOwn(roundData, route));
    const value = roundData[route];
    if (hold) {
      held.push(() => send(response, value));
      if (held.length === 5) reached();
    } else {
      // The first successful collection finishes later than its query-window start.
      if (requests === 5) scheduler.time += 2500;
      send(response, value);
    }
  });
  const controller = await createIdcController({ bundleRoot: path.join(__dirname, 'missing-sysak-fixture'),
    startMockOpenApi: loadOpenApi(), scheduler, agentSight: { baseUrl, token: 'fixture-token' },
    processActionImpl: () => assert.fail('No process action may run') });
  t.after(() => controller.close());
  const first = await controller.agentSnapshot(false);
  const cachedAt = scheduler.now();
  assert.equal(first.window.end, new Date(cachedAt - 2500).toISOString());
  assert.equal(requests, 5);
  assert.deepEqual(await controller.agentSnapshot(false), first); // age = 0
  scheduler.time = cachedAt + 59999;
  assert.deepEqual(await controller.agentSnapshot(false), first);
  assert.equal(requests, 5, 'TTL must start at successful completion, not at collection start');

  scheduler.time = cachedAt + 60000;
  hold = true;
  const allRequested = new Promise(resolve => { reached = resolve; });
  const pending = Array.from({ length: 8 }, () => controller.agentSnapshot(false));
  await allRequested;
  assert.equal(requests, 10, 'Concurrent expired reads must issue only one round of five GETs');
  assert.equal(controller.queryView().tasks.length, 1, 'No report is committed while collection is held');
  hold = false;
  held.splice(0).forEach(release => release());
  const reports = await Promise.all(pending);
  const second = reports[0];
  assert.notEqual(second.window.end, first.window.end);
  assert.equal(second.window.end, new Date(scheduler.now()).toISOString());
  for (const report of reports) assert.deepEqual(report, second);
  assert.notEqual(reports[0], reports[1], 'Each caller receives an independent clone');
  assert.equal(controller.queryView().tasks.length, 2);
  for (let index = 0; index < paths.length; index += 5) {
    assert.deepEqual(paths.slice(index, index + 5).sort(), Object.keys(roundData).sort());
  }

  const renewedAt = scheduler.now();
  scheduler.time = renewedAt + 59999;
  assert.deepEqual(await controller.agentSnapshot(false), second);
  assert.equal(requests, 10, 'Successful recollection resets the cache timestamp');
  scheduler.time = renewedAt + 60000;
  const third = await controller.agentSnapshot(false);
  assert.equal(requests, 15);
  assert.notEqual(third.window.end, second.window.end);
  await controller.agentSnapshot(true);
  assert.equal(requests, 20, 'Manual refresh recollects even at cache age zero');
  assert.equal(controller.queryView().tasks.length, 4);
});

test('fake scheduler clock rollback forces recollection and never treats a negative cache age as fresh', async t => {
  const scheduler = fakeAgentScheduler(1794369600123);
  let requests = 0;
  const baseUrl = await fixture(t, (request, response) => {
    requests++;
    send(response, dataFor(scheduler.now())[new URL(request.url, 'http://localhost').pathname]);
  });
  const controller = await createIdcController({ bundleRoot: path.join(__dirname, 'missing-sysak-fixture'),
    startMockOpenApi: loadOpenApi(), scheduler, agentSight: { baseUrl, token: 'fixture-token' } });
  t.after(() => controller.close());
  const first = await controller.agentSnapshot(false);
  scheduler.time--;
  const rolledBack = await controller.agentSnapshot(false);
  assert.equal(requests, 10);
  assert.notEqual(rolledBack.window.end, first.window.end);
  assert.equal(rolledBack.window.end, new Date(scheduler.now()).toISOString());
  assert.deepEqual(await controller.agentSnapshot(false), rolledBack);
  assert.equal(requests, 10, 'Successful rollback recollection establishes a new age-zero cache');
  await controller.agentSnapshot(true);
  assert.equal(requests, 15);
  assert.equal(controller.queryView().tasks.length, 3);
});

test('probe observations made during requests use collection completion time and remain fresh', async t => {
  const baseUrl = await fixture(t, (request, response) => {
    setTimeout(() => send(response, dataFor()[new URL(request.url, 'http://localhost').pathname]), 30);
  });
  const controller = await createIdcController({ bundleRoot: path.join(__dirname, 'missing-sysak-fixture'),
    startMockOpenApi: loadOpenApi(), agentSight: { baseUrl } });
  t.after(() => controller.close());
  const report = await controller.agentSnapshot();
  assert.equal(report.coverage.find(source => source.key === 'processes').status, 'available');
  assert.equal(report.processes[0].status, 'healthy');
  assert.equal(report.processes[1].status, 'no_port');
  assert(Date.parse(report.sampledAt) >= Date.parse(report.lastScanAt));
});

test('closing the controller aborts pending AgentSight requests without committing a report', async t => {
  let firstRequest;
  const requested = new Promise(resolve => { firstRequest = resolve; });
  const baseUrl = await fixture(t, () => firstRequest());
  const controller = await createIdcController({ bundleRoot: path.join(__dirname, 'missing-sysak-fixture'),
    startMockOpenApi: loadOpenApi(), agentSight: { baseUrl } });
  const pending = controller.agentSnapshot();
  const rejected = assert.rejects(pending, { code: 'COLLECTION_CANCELLED' });
  await requested;
  await controller.close();
  await rejected;
  await assert.rejects(controller.agentSnapshot(), { code: 'COLLECTOR_DISABLED' });
});

test('controller failure preserves prior analysis without extending TTL; expired and manual reads retry without process actions', async t => {
  const scheduler = fakeAgentScheduler(1794369600123);
  let requests = 0;
  let submissions = 0;
  const baseUrl = await fixture(t, (request, response) => {
    requests++;
    send(response, dataFor(scheduler.now())[new URL(request.url, 'http://localhost').pathname]);
  });
  let unavailable = false;
  const realStart = loadOpenApi();
  let observedBody;
  const controller = await createIdcController({ bundleRoot: path.join(__dirname, 'missing-sysak-fixture'), scheduler, agentSight: { baseUrl, token: 'fixture-token' },
    processActionImpl: () => assert.fail('Agent diagnosis must never act on a process'),
    startMockOpenApi: async ({ token }) => {
      const real = await realStart({ token });
      const proxy = await fixture(t, (request, response) => {
        const chunks = [];
        request.on('data', chunk => chunks.push(chunk));
        request.on('end', async () => {
          submissions++;
          assert.equal(request.method, 'POST');
          assert.equal(request.url, '/openapi/v1/agent-diagnostics');
          observedBody = JSON.parse(Buffer.concat(chunks).toString());
          if (unavailable) { response.writeHead(503, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: { code: 'fixture_failed', message: 'Fixture OpenAPI failure' } })); return; }
          const result = await fetch(`${real.baseUrl}${request.url}`, { method: request.method, headers: { authorization: request.headers.authorization, 'content-type': 'application/json' }, body: JSON.stringify(observedBody) });
          response.writeHead(result.status, { 'content-type': 'application/json' });
          response.end(await result.text());
        });
      });
      return { baseUrl: proxy, close: real.close };
    } });
  t.after(() => controller.close());
  const first = await controller.agentSnapshot();
  assert.equal(observedBody.raw_snapshot.source, 'agentsight');
  assert.equal(observedBody.raw_snapshot.collector, undefined);
  assert(!JSON.stringify(observedBody).includes('fixture-private-query'));
  assert.equal(requests, 5);
  assert.equal(submissions, 1);
  const cachedAt = scheduler.now();
  scheduler.time = cachedAt + 59999;
  unavailable = true;
  await assert.rejects(controller.agentSnapshot(true), { code: 'fixture_failed' });
  assert.deepEqual(await controller.agentSnapshot(false), first);
  assert.equal(requests, 10, 'A failed fresh manual refresh still permits the original unexpired cache');
  assert.equal(submissions, 2);

  for (const age of [60000, 60001]) {
    scheduler.time = cachedAt + age;
    await assert.rejects(controller.agentSnapshot(false), { code: 'fixture_failed' });
    assert.deepEqual(controller.queryView().agent, first, 'Failed recollection preserves original cached evidence');
    assert.equal(controller.queryView().tasks.length, 1, 'Failures must not append successful tasks');
  }
  assert.equal(requests, 20, 'Neither failure may extend cache age or suppress the next expired retry');
  assert.equal(submissions, 4);
  await assert.rejects(controller.agentSnapshot(true), { code: 'fixture_failed' });
  assert.equal(requests, 25, 'Manual refresh always retries, even after repeated failures');
  assert.equal(submissions, 5);
  assert.deepEqual(controller.queryView().agent, first);

  unavailable = false;
  const recovered = await controller.agentSnapshot(false);
  assert.equal(requests, 30);
  assert.equal(submissions, 6);
  assert.notEqual(recovered.window.end, first.window.end);
  assert.equal(controller.queryView().tasks.length, 2);
  const recoveredAt = scheduler.now();
  scheduler.time = recoveredAt + 59999;
  assert.deepEqual(await controller.agentSnapshot(false), recovered);
  assert.equal(requests, 30, 'Only successful recovery renews the TTL');
  scheduler.time = recoveredAt + 60000;
  await controller.agentSnapshot(false);
  assert.equal(requests, 35);
  assert.equal(submissions, 7);
});

// Startup-management fixtures never touch an installed binary, config or credentials.
const { createAgentSightService } = require('../electron/agentsight-client.cjs');
const { EventEmitter: ServiceEventEmitter } = require('node:events');
const { constants: serviceFsConstants } = require('node:fs');
const SERVICE_BINARY = '/fixture/agentsight/bin/agentsight';
const SERVICE_CONFIG = '/fixture/agentsight/config.json';
const SERVICE_SECRET = 'fixture-service-secret-never-display';
const SERVICE_PRIVATE = 'fixture-service-private-error-body';

function serviceResponse(data = { agents: [] }, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

function serviceNetworkError(code = 'ECONNREFUSED') {
  return new TypeError(`${SERVICE_PRIVATE}\n${SERVICE_SECRET}`, {
    cause: Object.assign(new Error(SERVICE_PRIVATE), { code }),
  });
}

function serviceChild({ exitOnKill = true, pid = 42424242 } = {}) {
  const child = new ServiceEventEmitter();
  Object.assign(child, { pid, exitCode: null, signalCode: null, killed: false, signals: [], unref() {} });
  child.finishExit = (code = 0, signal = null) => {
    child.exitCode = code;
    child.signalCode = signal;
    child.emit('exit', code, signal);
    child.emit('close', code, signal);
  };
  child.kill = signal => {
    child.signals.push(signal);
    child.killed = true;
    if (exitOnKill) setImmediate(() => child.finishExit(null, signal));
    return true;
  };
  return child;
}

function serviceFakeFs(entries = {
  [SERVICE_BINARY]: { executable: true },
  [SERVICE_CONFIG]: {},
}) {
  const calls = [];
  const lookup = filename => {
    const entry = entries[filename];
    if (!entry) throw Object.assign(new Error(SERVICE_PRIVATE), { code: 'ENOENT' });
    return entry;
  };
  const forbidden = () => assert.fail('Startup must not read config/credentials, scan processes, install or modify files');
  return {
    calls,
    impl: {
      constants: serviceFsConstants,
      statSync(filename) {
        calls.push({ operation: 'stat', filename });
        const entry = lookup(filename);
        return { isFile: () => !entry.directory, isDirectory: () => Boolean(entry.directory),
          mode: entry.directory ? 0o40755 : entry.executable ? 0o100755 : 0o100644 };
      },
      accessSync(filename, mode = serviceFsConstants.F_OK) {
        calls.push({ operation: 'access', filename, mode });
        const entry = lookup(filename);
        if ((mode & serviceFsConstants.X_OK) && !entry.executable) {
          throw Object.assign(new Error(SERVICE_PRIVATE), { code: 'EACCES' });
        }
      },
      readFileSync: forbidden, readFile: forbidden, readdirSync: forbidden, readdir: forbidden,
      writeFileSync: forbidden, writeFile: forbidden, mkdirSync: forbidden, unlinkSync: forbidden,
      promises: { readFile: forbidden, readdir: forbidden, writeFile: forbidden, mkdir: forbidden, unlink: forbidden },
    },
  };
}

async function serviceBounded(promise, timeoutMs = 1500) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('AgentSight fixture operation did not settle promptly')), timeoutMs);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

function serviceDeferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function serviceAbortableFetch(onRequest = () => {}) {
  return (_url, options) => new Promise((_resolve, reject) => {
    assert(options.signal instanceof AbortSignal, 'Every health probe must be abortable');
    const abort = () => reject(options.signal.reason || new DOMException('Aborted', 'AbortError'));
    if (options.signal.aborted) abort();
    else options.signal.addEventListener('abort', abort, { once: true });
    onRequest(options.signal);
  });
}

function serviceFixture(t, { options = {}, entries, fetchImpl = async () => serviceResponse(),
  child = serviceChild(), spawnImpl } = {}) {
  assert.equal(typeof createAgentSightService, 'function', 'agentsight-client.cjs must export createAgentSightService');
  const fs = serviceFakeFs(entries);
  const probes = [];
  const spawns = [];
  const service = createAgentSightService({
    baseUrl: 'http://127.0.0.1:7396', binary: SERVICE_BINARY, configPath: SERVICE_CONFIG,
    env: {}, platform: 'linux', readyTimeoutMs: 80, probeTimeoutMs: 20, pollIntervalMs: 2, stopTimeoutMs: 20,
    ...options,
    fsImpl: fs.impl,
    fetchImpl: (url, init) => { probes.push({ url: String(url), init }); return fetchImpl(url, init); },
    spawnImpl: (binary, args, init) => {
      spawns.push({ binary, args, init });
      if (spawnImpl) return spawnImpl(binary, args, init);
      setImmediate(() => child.emit('spawn'));
      return child;
    },
  });
  for (const method of ['ensure', 'status', 'close']) assert.equal(typeof service[method], 'function');
  t.after(() => serviceBounded(service.close()));
  return { service, probes, spawns, fsCalls: fs.calls, child };
}

function assertServiceStatus(status, state, managed) {
  assert(status && typeof status === 'object' && !Array.isArray(status));
  assert.equal(status.state, state);
  assert.equal(typeof status.managed, 'boolean');
  if (managed !== undefined) assert.equal(status.managed, managed);
  if (state !== 'unavailable') assert.equal(status.code, null);
  for (const field of state === 'unavailable' ? ['code', 'message'] : ['message']) {
    assert.equal(typeof status[field], 'string', `${field} must be a sanitized string`);
    assert.doesNotMatch(status[field], /[\u0000-\u001f\u007f]/);
    if (state === 'unavailable') assert(status[field].trim(), `Unavailable status needs a meaningful ${field}`);
  }
  assert(!JSON.stringify(status).includes(SERVICE_SECRET));
  assert(!JSON.stringify(status).includes(SERVICE_PRIVATE));
}

function assertServiceProbe(probe, origin, token) {
  assert.equal(probe.url, `${origin}/api/agent-process-health?include_clients=true`);
  assert.equal(probe.init.method, 'GET');
  assert(['error', 'manual'].includes(probe.init.redirect), 'Health probes must never follow redirects');
  assert(probe.init.signal instanceof AbortSignal);
  assert.equal(probe.init.body, undefined);
  const headers = new Headers(probe.init.headers);
  assert.equal(headers.get('authorization'), token ? `Bearer ${token}` : null);
}

function assertServiceSpawn(spawn, { binary = SERVICE_BINARY, config = SERVICE_CONFIG, host = '127.0.0.1', port = '7396' } = {}) {
  assert.equal(spawn.binary, binary);
  assert(path.isAbsolute(spawn.binary));
  assert.deepEqual(spawn.args, ['serve', '--config', config, '--host', host, '--port', port]);
  assert.equal(spawn.init.shell, false);
  assert.equal(spawn.init.detached, false);
  assert.equal(spawn.init.stdio, 'ignore');
  assert(spawn.init.env && typeof spawn.init.env === 'object');
  const safeKeys = new Set(['PATH', 'HOME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'TMP', 'TEMP', 'TZ', 'USER', 'LOGNAME']);
  for (const key of Object.keys(spawn.init.env)) assert(safeKeys.has(key), `Unexpected inherited environment key: ${key}`);
  assert(!JSON.stringify(spawn).includes(SERVICE_SECRET));
}

async function assertServiceUnavailable(fixture, { spawned = 0, managed } = {}) {
  const result = await serviceBounded(fixture.service.ensure());
  assertServiceStatus(result, 'unavailable', managed);
  assertServiceStatus(fixture.service.status(), 'unavailable', managed);
  assert.equal(fixture.spawns.length, spawned);
  return result;
}

const collectionFixture = (changes = {}) => ({ state: 'running', enabled: true, scope: 'host', trace_running: true, api_running: true, ...changes });
const managedOptions = { baseUrl: undefined, binary: undefined, configPath: undefined };

test('opted-in collection uses only its managed API and survives host disposal', async t => {
  const actions = [];
  const h = serviceFixture(t, { options: { ...managedOptions, collectionControlImpl: async action => { actions.push(action); return collectionFixture(); } } });
  const results = await Promise.all([h.service.ensure(), h.service.ensure()]);
  assert.equal(results[0].collection.state, 'running');
  assert.equal(results[0].managed, false);
  assert.equal(h.service.endpoint(), 'http://127.0.0.1:7397');
  assert.deepEqual(actions, ['ensure']);
  assert.equal(h.spawns.length, 0);
  assertServiceProbe(h.probes[0], 'http://127.0.0.1:7397');
  await h.service.close();
  assert.deepEqual(actions, ['ensure']);
  assert.deepEqual(h.child.signals, []);
});

test('managed API startup waits for readiness without launching another process', async t => {
  let probes = 0;
  let controls = 0;
  const h = serviceFixture(t, { options: { ...managedOptions, collectionControlImpl: async () => { controls++; return collectionFixture(); } },
    fetchImpl: async () => { if (++probes < 3) throw serviceNetworkError(); return serviceResponse(); } });
  const status = await h.service.ensure();
  assert.equal(status.state, 'running');
  assert.equal(status.collection.state, 'running');
  assert.equal(controls, 1);
  assert.equal(probes, 3);
  assert(h.probes.every(probe => probe.url.startsWith('http://127.0.0.1:7397/')));
  assert.equal(h.spawns.length, 0);
});

test('unconsented collection keeps the original API path without activating trace', async t => {
  const h = serviceFixture(t, { options: { ...managedOptions, collectionControlImpl: async action => {
    assert.equal(action, 'ensure');
    return collectionFixture({ state: 'disabled', enabled: false, scope: 'none', trace_running: false, api_running: false });
  } } });
  const status = await h.service.ensure();
  assert.equal(status.state, 'running');
  assert.equal(status.collection.state, 'disabled');
  assert.equal(h.service.endpoint(), 'http://127.0.0.1:7396');
  assert.equal(h.spawns.length, 0);
});

test('managed API failure never falls back to an unrelated database or user process', async t => {
  for (const apiRunning of [false, true]) await t.test(String(apiRunning), async sub => {
    const h = serviceFixture(sub, { options: { ...managedOptions, collectionControlImpl: async () => collectionFixture({ state: 'failed', api_running: apiRunning }) },
      fetchImpl: async () => { throw serviceNetworkError(); } });
    const result = await h.service.ensure();
    assert.equal(result.state, 'unavailable');
    assert.equal(result.code, 'AGENTSIGHT_COLLECTION_API_FAILED');
    assert.equal(h.spawns.length, 0);
    assert(h.probes.every(probe => probe.url.startsWith('http://127.0.0.1:7397/')));
  });
});

test('explicit AgentSight deployment stays authoritative and only checks collector status', async t => {
  const actions = [];
  const h = serviceFixture(t, { options: { collectionControlImpl: async action => { actions.push(action); return collectionFixture(); } } });
  assert.equal((await h.service.ensure()).state, 'running');
  assert.deepEqual(actions, ['status']);
  assert.equal(h.service.endpoint(), 'http://127.0.0.1:7396');
});

test('collection state is validated and arbitrary helper messages never reach the renderer', async t => {
  for (const result of [collectionFixture({ message: SERVICE_SECRET }), collectionFixture({ state: 'invented', message: SERVICE_SECRET }),
    collectionFixture({ enabled: false }), { state: 'running' }]) await t.test(JSON.stringify(result.state), async sub => {
    const h = serviceFixture(sub, { options: { ...managedOptions, collectionControlImpl: async () => result } });
    const status = await h.service.ensure();
    assert(!JSON.stringify(status).includes(SERVICE_SECRET));
    assert.equal(h.spawns.length, 0);
    if (result.message === SERVICE_SECRET && result.state === 'running' && result.enabled) assert.equal(status.collection.state, 'running');
    else assert.equal(status.collection.state, 'unavailable');
  });
});

test('fixed broker collection command strips private output and rejects arbitrary actions', async () => {
  const { controlAgentCollection } = require('../electron/agentsight-client.cjs');
  const { EventEmitter } = require('node:events');
  const { PassThrough } = require('node:stream');
  let seen;
  const launch = (binary, args) => {
    seen = { binary, args };
    const child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => {};
    child.stdin.on('finish', () => { child.stdout.end(JSON.stringify(collectionFixture({ token: SERVICE_SECRET }))); child.emit('close', 0); });
    return child;
  };
  const status = await controlAgentCollection(SERVICE_BINARY, 'ensure', launch);
  assert.deepEqual(seen, { binary: SERVICE_BINARY, args: ['idc', '--agent-collection', 'ensure'] });
  assert.equal(status.state, 'running');
  assert(!JSON.stringify(status).includes(SERVICE_SECRET));
  await assert.rejects(controlAgentCollection(SERVICE_BINARY, 'enable', launch), { code: 'INVALID_COLLECTION_ACTION' });
});

test('broker preserves opted-in failure state on nonzero exit instead of selecting the legacy API', async t => {
  const { controlAgentCollection } = require('../electron/agentsight-client.cjs');
  const { EventEmitter } = require('node:events');
  const { PassThrough } = require('node:stream');
  const launch = () => {
    const child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => {};
    child.stdin.on('finish', () => {
      child.stdout.end(JSON.stringify(collectionFixture({ state: 'failed', trace_running: false, api_running: false, message: SERVICE_SECRET })));
      child.emit('close', 1);
    });
    return child;
  };
  const h = serviceFixture(t, { options: { ...managedOptions,
    collectionControlImpl: action => controlAgentCollection(SERVICE_BINARY, action, launch) } });
  const status = await h.service.ensure();
  assert.equal(status.collection.enabled, true);
  assert.equal(status.collection.state, 'failed');
  assert.equal(status.code, 'AGENTSIGHT_COLLECTION_API_FAILED');
  assert.equal(h.service.endpoint(), 'http://127.0.0.1:7397');
  assert.equal(h.probes.length, 0);
  assert.equal(h.spawns.length, 0);
  assert(!JSON.stringify(status).includes(SERVICE_SECRET));
});

test('AgentSight service reuses an existing healthy API without requiring installed files or process ownership', async t => {
  const h = serviceFixture(t, { options: { token: SERVICE_SECRET },
    entries: {}, fetchImpl: async () => serviceResponse({ agents: [], detail: SERVICE_PRIVATE }) });
  assertServiceStatus(await serviceBounded(h.service.ensure()), 'running', false);
  assertServiceStatus(h.service.status(), 'running', false);
  assert.equal(h.spawns.length, 0);
  for (const probe of h.probes) assertServiceProbe(probe, 'http://127.0.0.1:7396', SERVICE_SECRET);
  const closed = h.service.close();
  assert.equal(typeof closed.then, 'function');
  await serviceBounded(closed);
  await serviceBounded(h.service.close());
  assertServiceStatus(h.service.status(), 'closed');
  assert.deepEqual(h.child.signals, []);
  const count = h.probes.length;
  assertServiceStatus(await serviceBounded(h.service.ensure()), 'closed');
  assert.equal(h.probes.length, count);
  assert.equal(h.spawns.length, 0);
});

test('AgentSight service deduplicates simultaneous ensures and starts only the installed API serve command', async t => {
  const firstProbe = serviceDeferred();
  let calls = 0;
  const env = { PATH: '/fixture/agentsight/bin', HOME: '/fixture/home', LANG: 'C.UTF-8', TMPDIR: '/fixture/tmp',
    SYSOM_AGENTSIGHT_TOKEN: SERVICE_SECRET, API_KEY: SERVICE_SECRET, AWS_SECRET_ACCESS_KEY: SERVICE_SECRET,
    SSH_AUTH_SOCK: SERVICE_SECRET, LD_PRELOAD: SERVICE_SECRET, LD_LIBRARY_PATH: SERVICE_SECRET,
    NODE_OPTIONS: SERVICE_SECRET, PYTHONPATH: SERVICE_SECRET, UNRELATED_SETTING: SERVICE_SECRET };
  const h = serviceFixture(t, { options: { token: SERVICE_SECRET, env },
    fetchImpl: async () => { if (++calls === 1) { await firstProbe.promise; throw serviceNetworkError(); } return serviceResponse(); } });
  const pending = Array.from({ length: 12 }, () => h.service.ensure());
  firstProbe.resolve();
  const statuses = await serviceBounded(Promise.all(pending));
  for (const status of statuses) assertServiceStatus(status, 'running', true);
  assert(statuses.every(status => JSON.stringify(status) === JSON.stringify(statuses[0])));
  assert.equal(h.spawns.length, 1);
  assert.equal(h.probes.length, 2, 'Concurrent callers share the absent-socket probe and readiness polling');
  assertServiceSpawn(h.spawns[0]);
  assert.notEqual(h.spawns[0].init.env, env);
  for (const probe of h.probes) assertServiceProbe(probe, 'http://127.0.0.1:7396', SERVICE_SECRET);
  assertServiceStatus(await serviceBounded(h.service.ensure()), 'running', true);
  assert.equal(h.spawns.length, 1);
  await serviceBounded(Promise.all([h.service.close(), h.service.close(), h.service.close()]));
  assert.deepEqual(h.child.signals, ['SIGTERM']);
  assertServiceStatus(h.service.status(), 'closed');
});

test('AgentSight service accepts only explicitly refused socket failures as startup permission', async t => {
  const refused = () => Object.assign(new Error(SERVICE_PRIVATE), { code: 'ECONNREFUSED' });
  for (const [name, error] of [
    ['fetch cause', serviceNetworkError()],
    ['aggregate cause', new TypeError(SERVICE_PRIVATE, { cause: new AggregateError([refused(), refused()], SERVICE_PRIVATE) })],
    ['aggregate error', new AggregateError([refused(), refused()], SERVICE_PRIVATE)],
  ]) await t.test(name, async sub => {
    let calls = 0;
    const h = serviceFixture(sub, { fetchImpl: async () => { if (++calls === 1) throw error; return serviceResponse(); } });
    assertServiceStatus(await serviceBounded(h.service.ensure()), 'running', true);
    assert.equal(h.spawns.length, 1);
    assertServiceSpawn(h.spawns[0]);
  });
});

test('AgentSight service treats ambiguous network failures and mixed aggregates as occupied, never spawning', async t => {
  const refused = Object.assign(new Error(SERVICE_PRIVATE), { code: 'ECONNREFUSED' });
  const errors = [
    ['generic fetch failure', new TypeError(SERVICE_PRIVATE)],
    ['message only', new Error(`ECONNREFUSED ${SERVICE_PRIVATE}`)],
    ['top-level code without fetch cause', Object.assign(new Error(SERVICE_PRIVATE), { code: 'ECONNREFUSED' })],
    ...['ETIMEDOUT', 'ENOTFOUND', 'EACCES', 'ECONNRESET', 'EHOSTUNREACH'].map(code => [code, serviceNetworkError(code)]),
    ['mixed aggregate', new TypeError(SERVICE_PRIVATE, { cause: new AggregateError([
      refused, Object.assign(new Error(SERVICE_PRIVATE), { code: 'EACCES' }),
    ], SERVICE_PRIVATE) })],
    ['empty aggregate', new TypeError(SERVICE_PRIVATE, { cause: new AggregateError([], SERVICE_PRIVATE) })],
    ['unknown aggregate member', new AggregateError([refused, new Error(SERVICE_PRIVATE)], SERVICE_PRIVATE)],
    ['abort', new DOMException(SERVICE_PRIVATE, 'AbortError')],
    ['timeout', new DOMException(SERVICE_PRIVATE, 'TimeoutError')],
  ];
  for (const [name, error] of errors) await t.test(name, async sub => {
    const h = serviceFixture(sub, { fetchImpl: async () => { throw error; } });
    await assertServiceUnavailable(h, { managed: false });
  });
});

test('AgentSight service never starts over authentication, redirects, other HTTP responses or invalid health JSON', async t => {
  const responses = [
    ...[401, 403, 404, 409, 500, 503].map(status => [`HTTP ${status}`, () => serviceResponse({ error: SERVICE_PRIVATE }, status)]),
    ['redirect', () => new Response(SERVICE_PRIVATE, { status: 302, headers: { location: `http://remote.test/${SERVICE_SECRET}` } })],
    ['non-JSON', () => new Response(SERVICE_PRIVATE, { headers: { 'content-type': 'text/html' } })],
    ['malformed JSON', () => new Response(`{${SERVICE_PRIVATE}`, { headers: { 'content-type': 'application/json' } })],
    ['null', () => serviceResponse(null)],
    ['array', () => serviceResponse([])],
    ['missing agents', () => serviceResponse({ detail: SERVICE_PRIVATE })],
    ['agents not a list', () => serviceResponse({ agents: {}, detail: SERVICE_PRIVATE })],
    ['agents null', () => serviceResponse({ agents: null })],
  ];
  for (const [name, response] of responses) await t.test(name, async sub => {
    const h = serviceFixture(sub, { fetchImpl: async () => response() });
    await assertServiceUnavailable(h, { managed: false });
    assert.equal(h.probes.length, 1);
    assertServiceProbe(h.probes[0], 'http://127.0.0.1:7396');
  });
});

test('AgentSight service bounds a hanging probe and never mistakes timeout for an absent socket', async t => {
  let signal;
  const h = serviceFixture(t, { fetchImpl: serviceAbortableFetch(value => { signal = value; }) });
  await assertServiceUnavailable(h, { managed: false });
  assert.equal(signal.aborted, true);
});

test('AgentSight service applies the probe deadline to the response body, not just response headers', async t => {
  let signal;
  const h = serviceFixture(t, { fetchImpl: async (_url, init) => {
    signal = init.signal;
    const body = new ReadableStream({ start(controller) {
      const abort = () => controller.error(init.signal.reason || new DOMException('Aborted', 'AbortError'));
      if (init.signal.aborted) abort();
      else init.signal.addEventListener('abort', abort, { once: true });
    } });
    return new Response(body, { headers: { 'content-type': 'application/json' } });
  } });
  await assertServiceUnavailable(h, { managed: false });
  assert.equal(signal.aborted, true);
});

test('AgentSight service uses environment defaults for URL, binary and config without passing them to the child', async t => {
  const binary = '/fixture/env/bin/agentsight';
  const config = '/fixture/env/config.json';
  let probes = 0;
  const h = serviceFixture(t, {
    options: { baseUrl: undefined, binary: undefined, configPath: undefined,
      env: { SYSOM_AGENTSIGHT_URL: 'http://localhost:7462', SYSOM_AGENTSIGHT_BIN: binary,
        SYSOM_AGENTSIGHT_CONFIG: config, API_KEY: SERVICE_SECRET } },
    entries: { [binary]: { executable: true }, [config]: {} },
    fetchImpl: async () => { if (++probes === 1) throw serviceNetworkError(); return serviceResponse(); },
  });
  assertServiceStatus(await serviceBounded(h.service.ensure()), 'running', true);
  assert.equal(h.spawns.length, 1);
  assertServiceSpawn(h.spawns[0], { binary, config, host: 'localhost', port: '7462' });
  for (const probe of h.probes) assertServiceProbe(probe, 'http://localhost:7462');
});

test('AgentSight service discovers installed executables only in absolute PATH entries and uses standard defaults', async t => {
  const binary = '/fixture/path with spaces/agentsight';
  let probes = 0;
  const h = serviceFixture(t, {
    options: { baseUrl: undefined, binary: undefined, configPath: undefined,
      env: { PATH: `.:relative-bin::/fixture/nonexec:/fixture/missing:/fixture/path with spaces` } },
    entries: { '/fixture/nonexec/agentsight': {}, [binary]: { executable: true }, '/etc/agentsight/config.json': {} },
    fetchImpl: async () => { if (++probes === 1) throw serviceNetworkError(); return serviceResponse(); },
  });
  assertServiceStatus(await serviceBounded(h.service.ensure()), 'running', true);
  assert.equal(h.spawns.length, 1);
  assertServiceSpawn(h.spawns[0], { binary, config: '/etc/agentsight/config.json' });
  assert(h.fsCalls.every(call => path.isAbsolute(call.filename)), 'Relative/empty PATH entries must never be inspected');
  for (const probe of h.probes) assertServiceProbe(probe, 'http://127.0.0.1:7396');
});

test('AgentSight explicit URL, executable and config override environment defaults', async t => {
  let calls = 0;
  const h = serviceFixture(t, { options: { env: {
    SYSOM_AGENTSIGHT_URL: `http://remote.test/${SERVICE_SECRET}`, SYSOM_AGENTSIGHT_BIN: SERVICE_SECRET,
    SYSOM_AGENTSIGHT_CONFIG: SERVICE_SECRET, PATH: 'relative-only',
  } }, fetchImpl: async () => { if (++calls === 1) throw serviceNetworkError(); return serviceResponse(); } });
  assertServiceStatus(await serviceBounded(h.service.ensure()), 'running', true);
  assert.equal(h.spawns.length, 1);
  assertServiceSpawn(h.spawns[0]);
  for (const probe of h.probes) assertServiceProbe(probe, 'http://127.0.0.1:7396');
});

test('AgentSight service handles missing/nonexecutable binaries and missing/nonregular configs without spawning', async t => {
  const cases = [
    ['no binary or PATH', { binary: undefined }, { [SERVICE_CONFIG]: {} }],
    ['binary missing', {}, { [SERVICE_CONFIG]: {} }],
    ['binary not executable', {}, { [SERVICE_BINARY]: {}, [SERVICE_CONFIG]: {} }],
    ['binary is a directory', {}, { [SERVICE_BINARY]: { executable: true, directory: true }, [SERVICE_CONFIG]: {} }],
    ['config missing', {}, { [SERVICE_BINARY]: { executable: true } }],
    ['config is a directory', {}, { [SERVICE_BINARY]: { executable: true }, [SERVICE_CONFIG]: { directory: true } }],
  ];
  for (const [name, options, entries] of cases) await t.test(name, async sub => {
    const h = serviceFixture(sub, { options, entries, fetchImpl: async () => { throw serviceNetworkError(); } });
    await assertServiceUnavailable(h, { managed: false });
  });
});

test('AgentSight service refuses nonabsolute explicit or environment paths instead of falling back to PATH', async t => {
  const cases = [
    ['relative explicit binary', { binary: './agentsight' }],
    ['bare explicit binary', { binary: 'agentsight' }],
    ['relative explicit config', { configPath: './config.json' }],
    ['relative environment binary', { binary: undefined, env: { SYSOM_AGENTSIGHT_BIN: './agentsight', PATH: '/fixture/agentsight/bin' } }],
    ['relative environment config', { configPath: undefined, env: { SYSOM_AGENTSIGHT_CONFIG: './config.json', PATH: '/fixture/agentsight/bin' } }],
  ];
  for (const [name, options] of cases) await t.test(name, async sub => {
    const h = serviceFixture(sub, { options, fetchImpl: async () => { throw serviceNetworkError(); } });
    await assertServiceUnavailable(h, { managed: false });
    assert(h.fsCalls.every(call => path.isAbsolute(call.filename)));
  });
});

test('AgentSight service rejects invalid/nonloopback URL origins without probing or spawning', async t => {
  const urls = ['invalid', 'file:///etc/passwd', 'http://example.test:7396', 'http://0.0.0.0:7396',
    `http://user:${SERVICE_SECRET}@localhost:7396`, `http://127.0.0.1:7396/${SERVICE_SECRET}`,
    `http://localhost:7396?token=${SERVICE_SECRET}`, `http://localhost:7396/#${SERVICE_SECRET}`,
    'http://127.0.0.1@remote.test:7396'];
  for (const [index, baseUrl] of urls.entries()) await t.test(`invalid origin ${index + 1}`, async sub => {
    const h = serviceFixture(sub, { options: { baseUrl }, fetchImpl: async () => assert.fail('Invalid URLs must not be fetched') });
    await assertServiceUnavailable(h, { managed: false });
    assert.equal(h.probes.length, 0);
  });
});

test('AgentSight service does not autostart HTTPS or non-Linux hosts but can reuse their existing API', async t => {
  for (const [name, options, origin] of [
    ['HTTPS', { baseUrl: 'https://127.0.0.1:7396' }, 'https://127.0.0.1:7396'],
    ['macOS', { platform: 'darwin' }, 'http://127.0.0.1:7396'],
    ['Windows', { platform: 'win32' }, 'http://127.0.0.1:7396'],
  ]) await t.test(name, async sub => {
    const unavailable = serviceFixture(sub, { options, fetchImpl: async () => { throw serviceNetworkError(); } });
    await assertServiceUnavailable(unavailable, { managed: false });
    const existing = serviceFixture(sub, { options, entries: {} });
    assertServiceStatus(await serviceBounded(existing.service.ensure()), 'running', false);
    assert.equal(existing.spawns.length, 0);
    for (const probe of existing.probes) assertServiceProbe(probe, origin);
  });
});

test('AgentSight service supplies loopback host and effective HTTP port as separate serve arguments', async t => {
  for (const [origin, host, port] of [
    ['http://localhost:7463', 'localhost', '7463'],
    ['http://127.0.0.1', '127.0.0.1', '80'],
    ['http://[::1]:7464', '::1', '7464'],
  ]) await t.test(origin, async sub => {
    let calls = 0;
    const h = serviceFixture(sub, { options: { baseUrl: origin },
      fetchImpl: async () => { if (++calls === 1) throw serviceNetworkError(); return serviceResponse(); } });
    assertServiceStatus(await serviceBounded(h.service.ensure()), 'running', true);
    assert.equal(h.spawns.length, 1);
    const actualHost = h.spawns[0].args[4];
    if (host === '::1') assert(['::1', '[::1]'].includes(actualHost));
    else assert.equal(actualHost, host);
    assertServiceSpawn(h.spawns[0], { host: actualHost, port });
    for (const probe of h.probes) assertServiceProbe(probe, origin);
  });
});

test('AgentSight service sanitizes synchronous spawn failures and never tries another command', async t => {
  const h = serviceFixture(t, { fetchImpl: async () => { throw serviceNetworkError(); },
    spawnImpl: () => { throw Object.assign(new Error(`${SERVICE_PRIVATE}\n${SERVICE_SECRET}`), { code: 'EACCES' }); } });
  await assertServiceUnavailable(h, { spawned: 1 });
  assertServiceSpawn(h.spawns[0]);
  await serviceBounded(h.service.close());
  assert.deepEqual(h.child.signals, []);
});

test('AgentSight service handles asynchronous child spawn errors promptly without killing an unspawned child', async t => {
  const child = serviceChild({ pid: undefined });
  // Explicitly model Node's missing pid after an unsuccessful spawn.
  child.pid = undefined;
  const h = serviceFixture(t, { child, options: { readyTimeoutMs: 10000 },
    fetchImpl: async () => { throw serviceNetworkError(); },
    spawnImpl: () => {
      setImmediate(() => child.emit('error', Object.assign(new Error(`${SERVICE_PRIVATE}\n${SERVICE_SECRET}`), { code: 'ENOENT' })));
      return child;
    } });
  await assertServiceUnavailable(h, { spawned: 1 });
  await serviceBounded(h.service.close());
  assert.deepEqual(child.signals, []);
});

test('AgentSight service detects an early child exit rather than waiting for the startup deadline', async t => {
  const child = serviceChild();
  const h = serviceFixture(t, { child, options: { readyTimeoutMs: 10000 },
    fetchImpl: async () => { throw serviceNetworkError(); },
    spawnImpl: () => { setImmediate(() => { child.emit('spawn'); child.finishExit(23); }); return child; } });
  await assertServiceUnavailable(h, { spawned: 1 });
  await serviceBounded(h.service.close());
  assert.deepEqual(child.signals, [], 'A child that already exited must never be signaled');
});

test('AgentSight service bounds startup readiness polling and close signals only its still-live child', async t => {
  const h = serviceFixture(t, { options: { readyTimeoutMs: 35 }, fetchImpl: async () => { throw serviceNetworkError(); } });
  await assertServiceUnavailable(h, { spawned: 1 });
  assertServiceSpawn(h.spawns[0]);
  await serviceBounded(h.service.close());
  assert.deepEqual(h.child.signals, ['SIGTERM']);
  await serviceBounded(h.service.close());
  assert.deepEqual(h.child.signals, ['SIGTERM']);
  assertServiceStatus(h.service.status(), 'closed');
});

test('AgentSight service does not spawn again when startup polling observes a port conflict', async t => {
  let calls = 0;
  const h = serviceFixture(t, { fetchImpl: async () => {
    if (++calls === 1) throw serviceNetworkError();
    return serviceResponse({ error: SERVICE_PRIVATE }, 409);
  } });
  await assertServiceUnavailable(h, { spawned: 1 });
  assertServiceSpawn(h.spawns[0]);
});

test('AgentSight close before ensure is terminal, idempotent and has no process side effects', async t => {
  const h = serviceFixture(t);
  await serviceBounded(Promise.all([h.service.close(), h.service.close()]));
  assertServiceStatus(h.service.status(), 'closed');
  assertServiceStatus(await serviceBounded(h.service.ensure()), 'closed');
  assert.equal(h.probes.length, 0);
  assert.equal(h.spawns.length, 0);
  assert.deepEqual(h.child.signals, []);
});

test('AgentSight close aborts an in-flight initial probe and prevents later startup', async t => {
  const requested = serviceDeferred();
  let signal;
  const h = serviceFixture(t, { options: { probeTimeoutMs: 10000, readyTimeoutMs: 10000 },
    fetchImpl: serviceAbortableFetch(value => { signal = value; requested.resolve(); }) });
  const pending = h.service.ensure();
  await serviceBounded(requested.promise);
  await serviceBounded(h.service.close());
  assert.equal(signal.aborted, true);
  assertServiceStatus(await serviceBounded(pending), 'closed');
  assertServiceStatus(h.service.status(), 'closed');
  assert.equal(h.spawns.length, 0);
  assert.deepEqual(h.child.signals, []);
});

test('AgentSight close aborts startup readiness waits, SIGTERMs its child once and prevents resurrection', async t => {
  const polling = serviceDeferred();
  let calls = 0;
  let signal;
  const hanging = serviceAbortableFetch(value => { signal = value; polling.resolve(); });
  const h = serviceFixture(t, { options: { probeTimeoutMs: 10000, readyTimeoutMs: 10000 },
    fetchImpl: (url, init) => { if (++calls === 1) return Promise.reject(serviceNetworkError()); return hanging(url, init); } });
  const pending = Array.from({ length: 4 }, () => h.service.ensure());
  await serviceBounded(polling.promise);
  await serviceBounded(Promise.all([h.service.close(), h.service.close()]));
  assert.equal(signal.aborted, true);
  for (const status of await serviceBounded(Promise.all(pending))) assertServiceStatus(status, 'closed');
  assert.deepEqual(h.child.signals, ['SIGTERM']);
  assert.equal(h.spawns.length, 1);
  h.child.emit('spawn');
  h.child.finishExit(0);
  assertServiceStatus(h.service.status(), 'closed');
  const probes = h.probes.length;
  assertServiceStatus(await serviceBounded(h.service.ensure()), 'closed');
  assert.equal(h.probes.length, probes);
  assert.equal(h.spawns.length, 1);
});

test('AgentSight close skips an owned child that has already exited after becoming ready', async t => {
  let calls = 0;
  const h = serviceFixture(t, { fetchImpl: async () => { if (++calls === 1) throw serviceNetworkError(); return serviceResponse(); } });
  assertServiceStatus(await serviceBounded(h.service.ensure()), 'running', true);
  h.child.finishExit(0);
  await serviceBounded(h.service.close());
  assert.deepEqual(h.child.signals, []);
  assertServiceStatus(h.service.status(), 'closed');
});

test('controller checks and starts AgentSight at host startup independently of SysAK, then closes only its child', async t => {
  const scheduler = fakeAgentScheduler(1794369600123);
  const child = serviceChild();
  const started = serviceDeferred();
  let requests = 0;
  let launches = 0;
  const controller = await createIdcController({ bundleRoot: path.join(__dirname, 'missing-sysak-fixture'),
    startMockOpenApi: loadOpenApi(), scheduler, agentSightService: true,
    agentSight: { binary: SERVICE_BINARY, configPath: SERVICE_CONFIG, env: {}, fsImpl: serviceFakeFs().impl,
      pollIntervalMs: 2, probeTimeoutMs: 20,
      fetchImpl: async url => {
        if (++requests === 1) throw serviceNetworkError();
        return serviceResponse(dataFor(scheduler.now())[new URL(url).pathname]);
      },
      spawnImpl: (binary, args, init) => {
        launches++;
        assertServiceSpawn({ binary, args, init });
        started.resolve();
        return child;
      } },
  });
  t.after(() => controller.close());
  await serviceBounded(started.promise);
  assert.equal(controller.status().installed, false);
  const report = await controller.agentSnapshot();
  assert.equal(report.source, 'agentsight');
  assert.equal(report.analyzer, 'sysom-openapi');
  assert(report.coverage.every(source => source.status === 'available'));
  await controller.agentSnapshot(true);
  assert.equal(launches, 1);
  await controller.close();
  assert.deepEqual(child.signals, ['SIGTERM']);
});

test('controller returns actionable missing dependency evidence rather than fabricated healthy data', async t => {
  const controller = await createIdcController({ bundleRoot: path.join(__dirname, 'missing-sysak-fixture'),
    startMockOpenApi: loadOpenApi(), agentSightService: true,
    agentSight: { binary: SERVICE_BINARY, configPath: SERVICE_CONFIG, env: {}, fsImpl: serviceFakeFs({}).impl,
      fetchImpl: async () => { throw serviceNetworkError(); }, spawnImpl: () => assert.fail('Missing binary must not launch') },
  });
  t.after(() => controller.close());
  const report = await controller.agentSnapshot();
  assert.equal(report.status, 'unavailable');
  assert.equal(report.outcome, 'unknown');
  assert(report.coverage.every(source => source.status === 'unavailable' && source.reason.includes('SYSOM_AGENTSIGHT_BIN')));
  assert.deepEqual(report.latency, []);
});

test('AgentSight close respects its stop deadline without SIGKILL, detached groups or repeated signals', async t => {
  const child = serviceChild({ exitOnKill: false });
  let calls = 0;
  const h = serviceFixture(t, { child, options: { stopTimeoutMs: 20 },
    fetchImpl: async () => { if (++calls === 1) throw serviceNetworkError(); return serviceResponse(); } });
  assertServiceStatus(await serviceBounded(h.service.ensure()), 'running', true);
  await serviceBounded(h.service.close());
  await serviceBounded(h.service.close());
  assert.deepEqual(child.signals, ['SIGTERM']);
  assertServiceStatus(h.service.status(), 'closed');
  assert.equal(h.spawns.length, 1);
});

// Deployment regression fixtures create and clean only their own mkdtemp tree; no binary is executed.
const deploymentFs = require('node:fs');
const deploymentOs = require('node:os');
const { createHash: deploymentHash } = require('node:crypto');
const { prepareAgentSight, agentSightHome } = require('../electron/agentsight-deployment.cjs');
const DEPLOYMENT_PRIVATE = 'fixture-deployment-private-error';
const DEPLOYMENT_SECRET = 'fixture-deployment-secret-never-display';
const deploymentHost = { skip: process.platform !== 'linux' || process.arch !== 'x64' };

function deploymentElf(label = 'fixture-binary-A') {
  // A minimal ELF64 header plus inert fixture bytes, not an executable program.
  const bytes = Buffer.alloc(96);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]);
  bytes.writeUInt16LE(2, 16);
  bytes.writeUInt16LE(62, 18);
  bytes.writeUInt32LE(1, 20);
  bytes.writeUInt16LE(64, 52);
  Buffer.from(label).copy(bytes, 64);
  return bytes;
}

function deploymentDigest(bytes) {
  return deploymentHash('sha256').update(bytes).digest('hex');
}

function deploymentFixture(t) {
  const base = deploymentFs.mkdtempSync(path.join(deploymentOs.tmpdir(), 'sysom-agentsight-deployment-test-'));
  t.after(() => deploymentFs.rmSync(base, { recursive: true, force: true }));
  return { base, root: path.join(base, 'install'), packageDir: path.join(base, 'standalone-package') };
}

function deploymentPackage(directory, { bytes = deploymentElf(), manifest = {} } = {}) {
  deploymentFs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const binary = path.join(directory, 'agentsight');
  const manifestPath = path.join(directory, 'manifest.json');
  deploymentFs.writeFileSync(binary, bytes, { mode: 0o755 });
  deploymentFs.writeFileSync(manifestPath, JSON.stringify({ schemaVersion: 1, version: '0.16.0',
    platform: 'linux', arch: 'x64', sha256: deploymentDigest(bytes), ...manifest }), { mode: 0o600 });
  return { binary, manifestPath, bytes };
}

function deploymentTree(directory) {
  const entries = [];
  function visit(filename, relative) {
    const info = deploymentFs.lstatSync(filename);
    const entry = { path: relative, mode: info.mode & 0o777, ino: info.ino };
    if (info.isSymbolicLink()) entry.symlink = deploymentFs.readlinkSync(filename);
    else if (info.isDirectory()) entry.directory = true;
    else {
      assert(info.isFile(), 'Fixtures contain only regular files, directories and symlinks');
      entry.bytes = deploymentFs.readFileSync(filename).toString('hex');
      entry.mtimeMs = info.mtimeMs;
    }
    entries.push(entry);
    if (info.isDirectory()) for (const name of deploymentFs.readdirSync(filename).sort()) {
      visit(path.join(filename, name), path.join(relative, name));
    }
  }
  visit(directory, '.');
  return entries;
}

function deploymentExclusive(flags) {
  return typeof flags === 'string' ? flags.includes('x') :
    typeof flags === 'number' && Boolean(flags & deploymentFs.constants.O_EXCL) &&
      Boolean(flags & deploymentFs.constants.O_CREAT);
}

function deploymentObservedFs({ unreadable = [], onCall = () => {} } = {}) {
  const calls = [];
  const privatePaths = new Set(unreadable);
  const mutators = new Set(['mkdir', 'mkdtemp', 'writeFile', 'appendFile', 'copyFile', 'link', 'rename',
    'unlink', 'rm', 'rmdir', 'chmod', 'truncate', 'symlink']);
  function wrap(target, promises = false) {
    return new Proxy(target, { get(object, key) {
      if (!promises && key === 'promises') return wrap(deploymentFs.promises, true);
      const method = Reflect.get(object, key, object);
      if (typeof method !== 'function' || typeof key !== 'string') return method;
      return (...args) => {
        const operation = key.replace(/Sync$/, '');
        const filename = args[0] instanceof URL ? require('node:url').fileURLToPath(args[0]) : args[0];
        if (privatePaths.has(filename) && (operation === 'readFile' ||
          (operation === 'open' && !deploymentExclusive(args[1])))) {
          assert.fail('Deployment must not open/read an existing config or its credentials');
        }
        const write = mutators.has(operation) || (operation === 'open' &&
          (typeof args[1] === 'string' ? /[wa+]/.test(args[1]) :
            Boolean(args[1] & (deploymentFs.constants.O_WRONLY | deploymentFs.constants.O_RDWR |
              deploymentFs.constants.O_CREAT | deploymentFs.constants.O_TRUNC))));
        calls.push({ operation, args, write });
        onCall(operation, args);
        return Reflect.apply(method, object, args);
      };
    } });
  }
  return { impl: wrap(deploymentFs), calls };
}

async function deploymentRejected(promise) {
  await assert.rejects(promise, error => {
    assert(error instanceof Error);
    assert.equal(error.name, 'AgentSightDeploymentError');
    for (const field of ['code', 'message']) {
      assert.equal(typeof error[field], 'string');
      assert(error[field].trim(), `Deployment errors need a meaningful ${field}`);
      assert.doesNotMatch(error[field], /[\u0000-\u001f\u007f]/);
      assert(!error[field].includes(DEPLOYMENT_PRIVATE));
      assert(!error[field].includes(DEPLOYMENT_SECRET));
    }
    assert.match(error.code, /^[A-Z][A-Z0-9_]+$/);
    return true;
  });
}

function assertDeploymentConfig(configPath, root) {
  const config = JSON.parse(deploymentFs.readFileSync(configPath, 'utf8'));
  assert.equal(config.schema_version, 6);
  assert.equal(config.traceEnabled, false);
  assert.deepEqual(config.cmdline.allow, []);
  for (const feature of ['tokenizer', 'trajectory_collection']) {
    assert.equal(config.features[feature].enabled, false, `${feature} must be disabled in the generated config`);
  }
  for (const feature of ['reuse_llm_judge', 'sls_logtail']) {
    assert.equal(config.features[feature], false, `${feature} must be disabled in the generated config`);
  }
  assert.equal(config.deadloop.enabled, false);
  assert.equal(config.storage.base_path, path.join(root, 'data'));
  assert.equal(config.server.auth.enabled, true);
  assert.equal(deploymentFs.lstatSync(configPath).mode & 0o777, 0o600);
  const data = deploymentFs.lstatSync(path.join(root, 'data'));
  assert(data.isDirectory() && !data.isSymbolicLink());
  assert.equal(data.mode & 0o777, 0o700);
  assert.deepEqual(deploymentFs.readdirSync(path.join(root, 'data')), []);
}

function assertDeploymentInstalled(result, root, bytes) {
  assert.deepEqual(result, { binary: path.join(root, 'bin', 'agentsight'), configPath: path.join(root, 'config.json'), root });
  const info = deploymentFs.lstatSync(result.binary);
  assert(info.isFile() && !info.isSymbolicLink());
  assert.equal(info.mode & 0o777, 0o700);
  assert.deepEqual(deploymentFs.readFileSync(result.binary), bytes);
  assert.deepEqual(deploymentFs.readdirSync(path.join(root, 'bin')), ['agentsight'], 'No temporary binary may remain');
  assertDeploymentConfig(result.configPath, root);
}

function deploymentPublicationObserver(root) {
  const publications = [];
  const observed = deploymentObservedFs({ onCall(operation, args) {
    if (operation !== 'link' || args[1] !== path.join(root, 'bin', 'agentsight')) return;
    assert.equal(path.dirname(args[0]), path.join(root, 'bin'), 'Publish from a temporary copy on the same filesystem');
    assert.notEqual(args[0], args[1]);
    const info = deploymentFs.lstatSync(args[0]);
    assert(info.isFile() && !info.isSymbolicLink());
    assert.equal(info.mode & 0o777, 0o700, 'The binary must be private before the atomic hardlink publication');
    publications.push(deploymentFs.readFileSync(args[0]));
  } });
  return { ...observed, publications };
}

function assertDeploymentExclusiveConfig(calls, configPath) {
  assert(calls.some(({ operation, args }) =>
    (operation === 'link' && args[1] === configPath) ||
    (args[0] === configPath && operation === 'open' && deploymentExclusive(args[1])) ||
    (args[0] === configPath && operation === 'writeFile' && deploymentExclusive(args[2]?.flag))),
  'The generated config must be created exclusively, never with a truncating write');
}

test('AgentSight deployment home honors only absolute XDG_DATA_HOME, then HOME or os.homedir', () => {
  const home = path.join(deploymentOs.tmpdir(), 'fixture-agentsight-home');
  const dataHome = path.join(deploymentOs.tmpdir(), 'fixture-agentsight-xdg');
  const env = { XDG_DATA_HOME: dataHome, HOME: home };
  assert.equal(agentSightHome(env), path.join(dataHome, 'sysom', 'agentsight'));
  assert.deepEqual(env, { XDG_DATA_HOME: dataHome, HOME: home });
  for (const XDG_DATA_HOME of ['', 'relative-data', './relative-data']) {
    assert.equal(agentSightHome({ XDG_DATA_HOME, HOME: home }), path.join(home, '.local', 'share', 'sysom', 'agentsight'));
  }
  assert.equal(agentSightHome({ HOME: home }), path.join(home, '.local', 'share', 'sysom', 'agentsight'));
  assert.equal(agentSightHome({}), path.join(deploymentOs.homedir(), '.local', 'share', 'sysom', 'agentsight'));
  assert.equal(agentSightHome({ HOME: '' }), path.join(deploymentOs.homedir(), '.local', 'share', 'sysom', 'agentsight'));
});

test('AgentSight fresh deployment verifies and copies a standalone package with private atomic files', deploymentHost, async t => {
  const h = deploymentFixture(t);
  const source = deploymentPackage(h.packageDir);
  const before = deploymentTree(h.packageDir);
  const observed = deploymentPublicationObserver(h.root);
  const result = await prepareAgentSight({ root: h.root, packageDirectories: [h.packageDir], env: {}, fsImpl: observed.impl });
  assertDeploymentInstalled(result, h.root, source.bytes);
  assert.equal(observed.publications.length, 1, 'The binary must be published via an exclusive hardlink');
  assert.deepEqual(observed.publications[0], source.bytes);
  assertDeploymentExclusiveConfig(observed.calls, result.configPath);
  assert.notEqual(deploymentFs.lstatSync(result.binary).ino, deploymentFs.lstatSync(source.binary).ino,
    'Do not hardlink the mutable package source directly into the installation');
  assert.deepEqual(deploymentTree(h.packageDir), before);
});

test('AgentSight deployment selects an explicit package over candidates and supports root/package fallback', deploymentHost, async t => {
  for (const selection of ['explicit', 'root/package']) await t.test(selection, async sub => {
    const h = deploymentFixture(sub);
    const selected = selection === 'explicit' ? h.packageDir : path.join(h.root, 'package');
    const source = deploymentPackage(selected, { bytes: deploymentElf('fixture-selected-binary') });
    const decoy = path.join(h.base, 'decoy-package');
    deploymentPackage(decoy, { bytes: deploymentElf('fixture-decoy-binary') });
    const result = await prepareAgentSight({ root: h.root,
      packageDirectories: selection === 'explicit' ? [decoy] : [],
      env: selection === 'explicit' ? { SYSOM_AGENTSIGHT_PACKAGE: selected } : {} });
    assertDeploymentInstalled(result, h.root, source.bytes);
  });
});

test('AgentSight repeat preparation preserves binary, opaque config and existing data without reading config', deploymentHost, async t => {
  const h = deploymentFixture(t);
  deploymentPackage(h.packageDir);
  const first = await prepareAgentSight({ root: h.root, packageDirectories: [h.packageDir], env: {} });
  deploymentFs.writeFileSync(first.configPath, `${DEPLOYMENT_SECRET}\nnot JSON and must not be parsed`);
  deploymentFs.chmodSync(first.configPath, 0o640);
  deploymentFs.chmodSync(first.binary, 0o750);
  deploymentFs.chmodSync(path.join(h.root, 'data'), 0o750);
  deploymentFs.writeFileSync(path.join(h.root, 'data', 'operator-owned.data'), DEPLOYMENT_SECRET, { mode: 0o600 });
  const before = deploymentTree(h.root);
  deploymentFs.writeFileSync(path.join(h.packageDir, 'agentsight'), deploymentElf('fixture-changed-package'));
  deploymentFs.writeFileSync(path.join(h.packageDir, 'manifest.json'), '{invalid package must not replace installed binary');
  const observed = deploymentObservedFs({ unreadable: [first.configPath] });
  assert.deepEqual(await prepareAgentSight({ root: h.root, packageDirectories: [h.packageDir], env: {}, fsImpl: observed.impl }), first);
  assert.deepEqual(deploymentTree(h.root), before);
  deploymentFs.rmSync(h.packageDir, { recursive: true, force: true });
  assert.deepEqual(await prepareAgentSight({ root: h.root, env: {}, fsImpl: observed.impl }), first);
  assert.deepEqual(deploymentTree(h.root), before);
});

test('AgentSight an existing installed binary needs no package and receives only missing safe config/data', deploymentHost, async t => {
  const h = deploymentFixture(t);
  const binary = path.join(h.root, 'bin', 'agentsight');
  deploymentFs.mkdirSync(path.dirname(binary), { recursive: true, mode: 0o700 });
  deploymentFs.writeFileSync(binary, deploymentElf('fixture-installed-binary'), { mode: 0o750 });
  const before = deploymentTree(path.dirname(binary));
  const result = await prepareAgentSight({ root: h.root, env: {} });
  assert.deepEqual(result, { binary, configPath: path.join(h.root, 'config.json'), root: h.root });
  assert.deepEqual(deploymentTree(path.dirname(binary)), before);
  assertDeploymentConfig(result.configPath, h.root);
});

test('AgentSight an explicit independent config is preserved and never read while the package binary deploys', deploymentHost, async t => {
  const h = deploymentFixture(t);
  const source = deploymentPackage(h.packageDir);
  const configPath = path.join(h.base, `operator-${DEPLOYMENT_SECRET}.json`);
  deploymentFs.writeFileSync(configPath, `${DEPLOYMENT_SECRET}\nopaque operator-owned config`, { mode: 0o640 });
  const before = deploymentFs.readFileSync(configPath);
  const info = deploymentFs.lstatSync(configPath);
  const observed = deploymentObservedFs({ unreadable: [configPath] });
  const result = await prepareAgentSight({ root: h.root, packageDirectories: [h.packageDir], configPath, env: {}, fsImpl: observed.impl });
  assert.deepEqual(result, { binary: path.join(h.root, 'bin', 'agentsight'), configPath, root: h.root });
  assert.deepEqual(deploymentFs.readFileSync(result.binary), source.bytes);
  assert.deepEqual(deploymentFs.readFileSync(configPath), before);
  assert.equal(deploymentFs.lstatSync(configPath).ino, info.ino);
  assert.equal(deploymentFs.lstatSync(configPath).mode & 0o777, 0o640);
  assert.equal(deploymentFs.existsSync(path.join(h.root, 'config.json')), false, 'Do not create an unused default config');
});

test('AgentSight an explicit independent binary is preserved and works without a package', deploymentHost, async t => {
  const h = deploymentFixture(t);
  const binary = path.join(h.base, 'operator-bin', 'agentsight');
  deploymentFs.mkdirSync(path.dirname(binary), { mode: 0o700 });
  deploymentFs.writeFileSync(binary, deploymentElf('fixture-explicit-binary'), { mode: 0o750 });
  const before = deploymentTree(path.dirname(binary));
  const result = await prepareAgentSight({ root: h.root, binary, env: {} });
  assert.deepEqual(result, { binary, configPath: path.join(h.root, 'config.json'), root: h.root });
  assert.deepEqual(deploymentTree(path.dirname(binary)), before);
  assert.equal(deploymentFs.existsSync(path.join(h.root, 'bin', 'agentsight')), false);
  assertDeploymentConfig(result.configPath, h.root);
});

test('AgentSight invalid explicit config fails before any installation writes', deploymentHost, async t => {
  for (const kind of ['relative', 'missing', 'directory', 'symlink']) await t.test(kind, async sub => {
    const h = deploymentFixture(sub);
    deploymentPackage(h.packageDir);
    let configPath = path.join(h.base, `invalid-${DEPLOYMENT_SECRET}.json`);
    if (kind === 'relative') configPath = `./${DEPLOYMENT_SECRET}.json`;
    if (kind === 'directory') deploymentFs.mkdirSync(configPath, { mode: 0o700 });
    if (kind === 'symlink') {
      const real = path.join(h.base, 'real-operator-config.json');
      deploymentFs.writeFileSync(real, DEPLOYMENT_SECRET, { mode: 0o600 });
      deploymentFs.symlinkSync(real, configPath);
    }
    const before = deploymentTree(h.base);
    const observed = deploymentObservedFs({ unreadable: kind === 'relative' ? [] : [configPath] });
    await deploymentRejected(prepareAgentSight({ root: h.root, packageDirectories: [h.packageDir], configPath, env: {}, fsImpl: observed.impl }));
    assert.deepEqual(observed.calls.filter(call => call.write), [], 'Validate the explicit config before mkdir/copy/config writes');
    assert.deepEqual(deploymentTree(h.base), before);
  });
});

test('AgentSight an absent package is an actionable sanitized failure, not an empty installation', deploymentHost, async t => {
  for (const kind of ['absent', 'explicit missing', 'explicit relative']) await t.test(kind, async sub => {
    const h = deploymentFixture(sub);
    const options = { root: h.root, env: { SYSOM_AGENTSIGHT_PACKAGE: path.join(h.base, 'missing-package') } };
    if (kind !== 'absent') {
      deploymentPackage(h.packageDir);
      options.packageDirectories = [h.packageDir];
      options.env.SYSOM_AGENTSIGHT_PACKAGE = kind === 'explicit missing' ? path.join(h.base, DEPLOYMENT_SECRET) : `./${DEPLOYMENT_SECRET}`;
    }
    const before = deploymentTree(h.base);
    await deploymentRejected(prepareAgentSight(options));
    assert.deepEqual(deploymentTree(h.base), before, 'Do not silently fall back from an invalid explicit package');
  });
});

test('AgentSight rejects package digest, ELF, platform, architecture and manifest failures before deploying', deploymentHost, async t => {
  const cases = [
    ['digest mismatch', () => ({ manifest: { sha256: '0'.repeat(64) } })],
    ['malformed digest', () => ({ manifest: { sha256: DEPLOYMENT_SECRET } })],
    ['missing digest', () => ({ manifest: { sha256: undefined } })],
    ['empty binary', () => ({ bytes: Buffer.alloc(0) })],
    ['truncated ELF64 header', () => ({ bytes: deploymentElf().subarray(0, 63) })],
    ['non-ELF binary', () => ({ bytes: Buffer.alloc(96, 0x41) })],
    ['ELF32', () => { const bytes = deploymentElf(); bytes[4] = 1; return { bytes }; }],
    ['big-endian ELF', () => { const bytes = deploymentElf(); bytes[5] = 2; return { bytes }; }],
    ['non-x86_64 ELF', () => { const bytes = deploymentElf(); bytes.writeUInt16LE(183, 18); return { bytes }; }],
    ['non-Linux package', () => ({ manifest: { platform: 'darwin' } })],
    ['Windows package', () => ({ manifest: { platform: 'win32' } })],
    ['non-x64 package', () => ({ manifest: { arch: 'arm64' } })],
    ['x86 package', () => ({ manifest: { arch: 'ia32' } })],
    ['unsupported schema', () => ({ manifest: { schemaVersion: 2 } })],
    ['unsupported version', () => ({ manifest: { version: '0.15.0' } })],
  ];
  for (const [name, make] of cases) await t.test(name, async sub => {
    const h = deploymentFixture(sub);
    // ELF-invalid cases have matching digests, so they exercise header validation independently.
    deploymentPackage(h.packageDir, make());
    const before = deploymentTree(h.base);
    await deploymentRejected(prepareAgentSight({ root: h.root, packageDirectories: [h.packageDir], env: {} }));
    assert.deepEqual(deploymentTree(h.base), before, 'Validate the package before creating installation files');
  });
  await t.test('malformed manifest JSON', async sub => {
    const h = deploymentFixture(sub);
    const source = deploymentPackage(h.packageDir);
    deploymentFs.writeFileSync(source.manifestPath, `{${DEPLOYMENT_PRIVATE}\n${DEPLOYMENT_SECRET}`);
    const before = deploymentTree(h.base);
    await deploymentRejected(prepareAgentSight({ root: h.root, packageDirectories: [h.packageDir], env: {} }));
    assert.deepEqual(deploymentTree(h.base), before);
  });
});

test('AgentSight rejects symlinked package directory, manifest and binary sources', deploymentHost, async t => {
  for (const kind of ['package', 'manifest', 'binary']) await t.test(kind, async sub => {
    const h = deploymentFixture(sub);
    const source = deploymentPackage(h.packageDir);
    const external = path.join(h.base, 'source-symlink-destination');
    if (kind === 'package') {
      deploymentFs.renameSync(h.packageDir, external);
      deploymentFs.symlinkSync(external, h.packageDir);
    } else {
      const filename = kind === 'manifest' ? source.manifestPath : source.binary;
      deploymentFs.renameSync(filename, external);
      deploymentFs.symlinkSync(external, filename);
    }
    const before = deploymentTree(h.base);
    await deploymentRejected(prepareAgentSight({ root: h.root, packageDirectories: [h.packageDir], env: {} }));
    assert.deepEqual(deploymentTree(h.base), before);
  });
});

test('AgentSight refuses nonregular package manifest and binary sources', deploymentHost, async t => {
  for (const kind of ['manifest', 'binary']) await t.test(kind, async sub => {
    const h = deploymentFixture(sub);
    const source = deploymentPackage(h.packageDir);
    const filename = kind === 'manifest' ? source.manifestPath : source.binary;
    deploymentFs.unlinkSync(filename);
    deploymentFs.mkdirSync(filename, { mode: 0o700 });
    const before = deploymentTree(h.base);
    await deploymentRejected(prepareAgentSight({ root: h.root, packageDirectories: [h.packageDir], env: {} }));
    assert.deepEqual(deploymentTree(h.base), before);
  });
});

test('AgentSight refuses symlinked installation root, bin, binary, config and data targets without following them', deploymentHost, async t => {
  for (const kind of ['root', 'bin', 'binary', 'config', 'data']) await t.test(kind, async sub => {
    const h = deploymentFixture(sub);
    deploymentPackage(h.packageDir);
    const external = path.join(h.base, 'target-symlink-destination');
    const isFile = kind === 'binary' || kind === 'config';
    if (isFile) deploymentFs.writeFileSync(external, DEPLOYMENT_SECRET, { mode: 0o600 });
    else {
      deploymentFs.mkdirSync(external, { mode: 0o700 });
      deploymentFs.writeFileSync(path.join(external, 'operator-owned.data'), DEPLOYMENT_SECRET, { mode: 0o600 });
    }
    const target = kind === 'root' ? h.root : kind === 'binary' ? path.join(h.root, 'bin', 'agentsight') :
      path.join(h.root, kind === 'config' ? 'config.json' : kind);
    deploymentFs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    deploymentFs.symlinkSync(external, target);
    const before = deploymentTree(h.base);
    await deploymentRejected(prepareAgentSight({ root: h.root, packageDirectories: [h.packageDir], env: {} }));
    const after = deploymentTree(h.base);
    assert.deepEqual(after.filter(entry => entry.path.startsWith('target-symlink-destination')),
      before.filter(entry => entry.path.startsWith('target-symlink-destination')),
      'A symlink must never redirect writes into even a fixture-owned external target');
    assert(deploymentFs.lstatSync(target).isSymbolicLink(), 'Do not replace or unlink an existing symlink');
    assert.equal(deploymentFs.readlinkSync(target), external);
    if (kind !== 'binary') assert.equal(deploymentFs.existsSync(path.join(h.root, 'bin', 'agentsight')), false);
    if (kind !== 'config' && kind !== 'root') assert.equal(deploymentFs.existsSync(path.join(h.root, 'config.json')), false);
  });
});

test('AgentSight simultaneous preparations leave one complete atomic binary and one exclusive valid config', deploymentHost, async t => {
  const h = deploymentFixture(t);
  const source = deploymentPackage(h.packageDir);
  const observed = deploymentPublicationObserver(h.root);
  const options = { root: h.root, packageDirectories: [h.packageDir], env: {}, fsImpl: observed.impl };
  const results = await Promise.all(Array.from({ length: 8 }, () => prepareAgentSight(options)));
  assert.equal(results.length, 8);
  for (const result of results) assertDeploymentInstalled(result, h.root, source.bytes);
  assert(observed.publications.length >= 1, 'Concurrent creation must still use atomic hardlink publication');
  for (const published of observed.publications) assert.deepEqual(published, source.bytes, 'Never publish a partial binary');
  assertDeploymentExclusiveConfig(observed.calls, results[0].configPath);
  assert.deepEqual(deploymentFs.readdirSync(h.root).sort(), ['bin', 'config.json', 'data'], 'Clean temporary artifacts after races');
  const before = deploymentTree(h.root);
  const noRead = deploymentObservedFs({ unreadable: [results[0].configPath] });
  await Promise.all(Array.from({ length: 4 }, () => prepareAgentSight({ ...options, fsImpl: noRead.impl })));
  assert.deepEqual(deploymentTree(h.root), before);
});

test('AgentSight an already-aborted deployment performs no writes and exposes only a sanitized cancellation', deploymentHost, async t => {
  const h = deploymentFixture(t);
  deploymentPackage(h.packageDir);
  const before = deploymentTree(h.base);
  const observed = deploymentObservedFs();
  const signal = AbortSignal.abort(new Error(`${DEPLOYMENT_PRIVATE}\n${DEPLOYMENT_SECRET}`));
  await deploymentRejected(prepareAgentSight({ root: h.root, packageDirectories: [h.packageDir], env: {}, signal, fsImpl: observed.impl }));
  assert.deepEqual(observed.calls.filter(call => call.write), []);
  assert.deepEqual(deploymentTree(h.base), before);
});

test('AgentSight deployment sanitizes filesystem failures without exposing raw messages or credentials', deploymentHost, async t => {
  const h = deploymentFixture(t);
  deploymentPackage(h.packageDir);
  const before = deploymentTree(h.base);
  const observed = deploymentObservedFs({ onCall(_operation, args) {
    if (args[0] === h.root) throw Object.assign(new Error(`${DEPLOYMENT_PRIVATE}\n${DEPLOYMENT_SECRET}`), { code: 'EACCES' });
  } });
  await deploymentRejected(prepareAgentSight({ root: h.root, packageDirectories: [h.packageDir], env: {}, fsImpl: observed.impl }));
  assert.deepEqual(deploymentTree(h.base), before);
});

test('AgentSight fresh binary deployment preserves a preexisting default config and populated data', deploymentHost, async t => {
  const h = deploymentFixture(t);
  const source = deploymentPackage(h.packageDir);
  const configPath = path.join(h.root, 'config.json');
  const dataPath = path.join(h.root, 'data');
  deploymentFs.mkdirSync(dataPath, { recursive: true, mode: 0o750 });
  deploymentFs.writeFileSync(configPath, `${DEPLOYMENT_SECRET}\nopaque existing config`, { mode: 0o640 });
  deploymentFs.writeFileSync(path.join(dataPath, 'operator-owned.data'), DEPLOYMENT_SECRET, { mode: 0o600 });
  const before = deploymentTree(h.root);
  const observed = deploymentObservedFs({ unreadable: [configPath] });
  const result = await prepareAgentSight({ root: h.root, packageDirectories: [h.packageDir], env: {}, fsImpl: observed.impl });
  assert.deepEqual(result, { binary: path.join(h.root, 'bin', 'agentsight'), configPath, root: h.root });
  assert.deepEqual(deploymentFs.readFileSync(result.binary), source.bytes);
  assert.equal(deploymentFs.lstatSync(result.binary).mode & 0o777, 0o700);
  assert.deepEqual(deploymentFs.readdirSync(path.join(h.root, 'bin')), ['agentsight']);
  assert.deepEqual(deploymentTree(h.root).filter(entry => entry.path !== 'bin' && !entry.path.startsWith(`bin${path.sep}`)), before,
    'Deploying a missing binary must not reset an existing config, data contents, inodes or permissions');
});

test('AgentSight simultaneous desktop and IDE preparation starts one service and releases its startup lock', deploymentHost, async t => {
  const h = deploymentFixture(t);
  deploymentPackage(h.packageDir);
  let running = false;
  const spawns = [];
  const options = {
    deploymentRoot: h.root, packageDirectories: [h.packageDir], env: { HOME: h.base, PATH: '/fixture/missing' },
    readyTimeoutMs: 300, probeTimeoutMs: 20, pollIntervalMs: 2,
    fetchImpl: async () => { if (!running) throw serviceNetworkError(); return serviceResponse(); },
    spawnImpl: (binary, args, init) => {
      const child = serviceChild(); running = true;
      child.once('exit', () => { running = false; });
      spawns.push({ binary, args, init, child });
      return child;
    },
  };
  const first = createAgentSightService(options);
  const second = createAgentSightService(options);
  t.after(() => Promise.all([first.close(), second.close()]));
  const results = await Promise.all([first.ensure(), second.ensure()]);
  assert(results.every(result => result.state === 'running'));
  assert.equal(results.filter(result => result.managed).length, 1);
  assert.equal(spawns.length, 1);
  assertServiceSpawn(spawns[0], { binary: path.join(h.root, 'bin/agentsight'), config: path.join(h.root, 'config.json') });
  assert.equal(deploymentFs.existsSync(path.join(h.root, '.serve-lock')), false);
  const owner = results[0].managed ? first : second;
  const reused = results[0].managed ? second : first;
  await reused.close();
  assert(running);
  assert.deepEqual(spawns[0].child.signals, []);
  await owner.close();
  assert.deepEqual(spawns[0].child.signals, ['SIGTERM']);
});

test('AgentSight user preparation is skipped entirely when a ready independent API is reused', deploymentHost, async t => {
  const h = deploymentFixture(t);
  const service = createAgentSightService({ deploymentRoot: h.root, env: {}, fetchImpl: async () => serviceResponse(),
    spawnImpl: () => assert.fail('Reused API must not spawn') });
  t.after(() => service.close());
  assertServiceStatus(await service.ensure(), 'running', false);
  assert.equal(deploymentFs.existsSync(h.root), false);
});

test('AgentSight absent companion package fails truthfully without creating a config or starting a child', deploymentHost, async t => {
  const h = deploymentFixture(t);
  const service = createAgentSightService({ deploymentRoot: h.root, env: { HOME: h.base, PATH: '/fixture/missing', SYSOM_AGENTSIGHT_PACKAGE: path.join(h.base, 'missing-package') },
    fetchImpl: async () => { throw serviceNetworkError(); }, spawnImpl: () => assert.fail('Missing package must not spawn') });
  t.after(() => service.close());
  const result = await service.ensure();
  assertServiceStatus(result, 'unavailable', false);
  assert.equal(result.code, 'AGENTSIGHT_PACKAGE_MISSING');
  assert.match(result.message, /配套安装件/);
  assert.equal(deploymentFs.existsSync(h.root), false);
});

test('AgentSight separate installer package deploys safe user defaults and preserves an existing opaque config', deploymentHost, async t => {
  const h = deploymentFixture(t);
  const { packageAgentSight } = require('../scripts/package-agentsight.cjs');
  const source = deploymentPackage(h.packageDir);
  const license = path.join(h.base, 'fixture-license');
  deploymentFs.writeFileSync(license, 'Fixture license');
  const output = path.join(h.base, 'agentsight-runtime');
  const result = await packageAgentSight({ binary: source.binary, license, output, version: '0.16.0' });
  assert.equal(result.sha256, deploymentDigest(source.bytes));
  assert.deepEqual(deploymentFs.readdirSync(output).sort(), ['LICENSE', 'agentsight', 'agentsight-deployment.cjs', 'install.cjs', 'manifest.json']);
  const env = { HOME: h.base, XDG_DATA_HOME: path.join(h.base, 'user-data'), PATH: '/usr/bin:/bin' };
  const root = agentSightHome(env);
  const run = () => require('node:child_process').spawnSync(process.execPath, [path.join(output, 'install.cjs')], { env, encoding: 'utf8' });
  const first = run(); assert.equal(first.status, 0, first.stderr);
  assertDeploymentConfig(path.join(root, 'config.json'), root);
  const config = path.join(root, 'config.json');
  deploymentFs.writeFileSync(config, 'Opaque existing user config must not be parsed or overwritten');
  const before = deploymentTree(root);
  const second = run(); assert.equal(second.status, 0, second.stderr);
  assert.deepEqual(deploymentTree(root), before);
  assert(!deploymentFs.existsSync(path.join(root, '.serve-lock')), 'Installation must not start a service');
});

test('AgentSight package generation never overwrites an existing output directory', deploymentHost, async t => {
  const h = deploymentFixture(t);
  const { packageAgentSight } = require('../scripts/package-agentsight.cjs');
  const source = deploymentPackage(h.packageDir);
  const license = path.join(h.base, 'fixture-license');
  deploymentFs.writeFileSync(license, 'Fixture license');
  const output = path.join(h.base, 'agentsight-runtime');
  deploymentFs.mkdirSync(output, { mode: 0o700 });
  deploymentFs.writeFileSync(path.join(output, 'existing.data'), 'Preserve existing output');
  const before = deploymentTree(output);
  await assert.rejects(packageAgentSight({ binary: source.binary, license, output, version: '0.16.0' }));
  assert.deepEqual(deploymentTree(output), before);
});

const deploymentDebFiles = ['LICENSE', 'agentsight', 'agentsight-deployment.cjs', 'install.cjs', 'manifest.json'];

function deploymentDebAvailable(t) {
  const result = require('node:child_process').spawnSync('dpkg-deb', ['--version'], { encoding: 'utf8', timeout: 10000 });
  if (result.error?.code === 'ENOENT') {
    t.skip('dpkg-deb is unavailable');
    return false;
  }
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return true;
}

function deploymentDebProcess(command, args, options = {}) {
  const result = require('node:child_process').spawnSync(command, args,
    { encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024, ...options });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr?.toString());
  return result.stdout;
}

function deploymentDebEntries(listing) {
  return listing.trim().split('\n').map(line => {
    const match = /^(\S+)\s+(\S+)\s+\d+\s+\S+\s+\S+\s+(\.\/.*)$/.exec(line);
    assert(match, `Unexpected archive listing: ${line}`);
    return { mode: match[1], owner: match[2], path: match[3] };
  });
}

function deploymentDebNumericEntries(output, archive) {
  const input = deploymentDebProcess('dpkg-deb', [archive, output], { encoding: null });
  return deploymentDebEntries(deploymentDebProcess('tar', ['--numeric-owner', '--list', '--verbose', '--file', '-'], { input }));
}

async function deploymentDebFixture(t) {
  const h = deploymentFixture(t);
  const source = deploymentPackage(h.packageDir);
  const license = path.join(h.base, 'fixture-license');
  deploymentFs.writeFileSync(license, 'Dummy AgentSight fixture license\n', { mode: 0o600 });
  const directory = path.join(h.base, 'agentsight-runtime');
  const { packageAgentSight } = require('../scripts/package-agentsight.cjs');
  await packageAgentSight({ binary: source.binary, license, output: directory, version: '0.16.0' });
  // Same-prefix neighbors belong to the fixture, not to the packager's cleanup.
  deploymentFs.mkdirSync(path.join(h.base, '.agentsight-deb-keep'), { mode: 0o700 });
  deploymentFs.writeFileSync(path.join(h.base, '.agentsight-deb-keep', 'keep.data'), 'Keep staging neighbor');
  deploymentFs.writeFileSync(path.join(h.base, '.agentsight-keep.deb'), 'Keep temporary-file neighbor');
  return { ...h, source, license, directory, output: path.join(h.base, 'runtime.deb') };
}

function deploymentDebExtract(h) {
  const extracted = path.join(h.base, 'extracted');
  deploymentDebProcess('dpkg-deb', ['--extract', h.output, extracted]);
  return { extracted, shared: path.join(extracted, 'usr/share/sysom/agentsight-runtime') };
}

test('AgentSight deb publishes a root-owned runtime with fixed opted-in collection units and hooks', deploymentHost, async t => {
  if (!deploymentDebAvailable(t)) return;
  const h = await deploymentDebFixture(t);
  const { packageAgentSightDeb } = require('../scripts/package-agentsight.cjs');
  const dummySecret = 'fixture-deb-dummy-secret-never-package';
  deploymentFs.mkdirSync(path.join(h.directory, '.git'), { mode: 0o700 });
  for (const name of ['.env', '.git/config', 'config.json', 'arbitrary-token.txt']) {
    deploymentFs.writeFileSync(path.join(h.directory, name), dummySecret, { mode: 0o600 });
  }
  for (const name of deploymentDebFiles) deploymentFs.chmodSync(path.join(h.directory, name), name === 'agentsight' ? 0o700 : 0o600);
  const before = deploymentTree(h.base);
  const sourceBefore = deploymentTree(h.directory);
  const publications = [];
  const link = deploymentFs.promises.link.bind(deploymentFs.promises);
  t.mock.method(deploymentFs.promises, 'link', async (temporary, output) => {
    if (output !== h.output) return link(temporary, output);
    assert.equal(path.dirname(temporary), h.base, 'Publish a completed temporary deb on the same filesystem');
    assert.notEqual(temporary, output);
    assert.equal(deploymentFs.existsSync(output), false);
    const info = deploymentFs.lstatSync(temporary);
    assert(info.isFile() && !info.isSymbolicLink());
    assert.equal(info.mode & 0o777, 0o644);
    assert.equal(deploymentDebProcess('dpkg-deb', ['--field', temporary, 'Package']).trim(), 'sysom-agentsight-runtime');
    await link(temporary, output);
    const published = deploymentFs.lstatSync(output);
    assert.equal(published.ino, info.ino, 'The output must be the exclusive hardlink, not a second copy');
    assert.equal(published.dev, info.dev);
    assert.equal(published.nlink, 2);
    publications.push(temporary);
  });
  const result = await packageAgentSightDeb({ directory: h.directory, output: h.output });
  assert.deepEqual(result, { version: '0.16.0', sha256: deploymentDigest(deploymentFs.readFileSync(h.output)) });
  assert.equal(publications.length, 1);
  assert.equal(deploymentFs.existsSync(publications[0]), false);
  assert.equal(deploymentFs.lstatSync(h.output).nlink, 1);
  assert.equal(deploymentFs.lstatSync(h.output).mode & 0o777, 0o644);
  assert.deepEqual(deploymentTree(h.base).filter(entry => entry.path !== 'runtime.deb'), before,
    'Only the published deb may remain; source and unrelated staging/temp neighbors must be untouched');

  const control = deploymentDebProcess('dpkg-deb', ['--field', h.output]);
  const fields = Object.fromEntries(control.split('\n').filter(line => /^[A-Za-z][A-Za-z-]*:/.test(line)).map(line => {
    const colon = line.indexOf(':');
    return [line.slice(0, colon), line.slice(colon + 1).trim()];
  }));
  assert.equal(fields.Package, 'sysom-agentsight-runtime');
  assert.equal(fields.Version, '0.16.0');
  assert.equal(fields.Architecture, 'amd64');
  assert.equal(fields.Depends, 'libc6 (>= 2.38), libelf1, libgcc-s1, libstdc++6, zlib1g, python3, systemd');
  assert.match(fields.Description, /Independent AgentSight runtime/);
  assert(!Object.hasOwn(fields, 'Pre-Depends'));
  const controlDirectory = path.join(h.base, 'extracted-control');
  deploymentDebProcess('dpkg-deb', ['--control', h.output, controlDirectory]);
  assert.deepEqual(deploymentFs.readdirSync(controlDirectory).sort(), ['control', 'postinst', 'prerm']);
  for (const [name, source] of [['postinst', 'agentsight-postinst.sh'], ['prerm', 'agentsight-prerm.sh']]) {
    assert.deepEqual(deploymentFs.readFileSync(path.join(controlDirectory, name)), deploymentFs.readFileSync(path.join(__dirname, '../build', source)));
  }
  const controlEntries = deploymentDebNumericEntries(h.output, '--ctrl-tarfile');
  assert.deepEqual(controlEntries.map(entry => entry.path).sort(), ['./', './control', './postinst', './prerm']);
  for (const entry of controlEntries) {
    assert.equal(entry.owner, '0/0');
    assert.equal(entry.mode, entry.path === './' ? 'drwxr-xr-x' : entry.path === './control' ? '-rw-r--r--' : '-rwxr-xr-x');
  }

  const runtime = './usr/share/sysom/agentsight-runtime/';
  const copyright = './usr/share/doc/sysom-agentsight-runtime/copyright';
  const units = ['sysom-agentsight-trace.service', 'sysom-agentsight-api.service'];
  const directories = ['./', './usr/', './usr/share/', './usr/share/doc/', './usr/share/doc/sysom-agentsight-runtime/',
    './usr/share/sysom/', './usr/lib/', './usr/lib/systemd/', './usr/lib/systemd/system/', runtime];
  const expected = [...directories, ...deploymentDebFiles.map(name => runtime + name), runtime + 'agentsight-collection.py',
    ...units.map(name => './usr/lib/systemd/system/' + name), copyright].sort();
  const contents = deploymentDebEntries(deploymentDebProcess('dpkg-deb', ['--contents', h.output]));
  assert.deepEqual(contents.map(entry => entry.path).sort(), expected,
    'Only fixed runtime, service units and license files; no user config, credentials or links');
  for (const entry of contents) {
    assert.equal(entry.owner, 'root/root');
    assert.equal(entry.mode, directories.includes(entry.path) ? 'drwxr-xr-x' :
      [runtime + 'agentsight', runtime + 'agentsight-collection.py'].includes(entry.path) ? '-rwxr-xr-x' : '-rw-r--r--');
  }
  const numericContents = deploymentDebNumericEntries(h.output, '--fsys-tarfile');
  assert.deepEqual(numericContents, contents.map(entry => ({ ...entry, owner: '0/0' })), 'All data archive IDs must also be root/root');
  const { extracted, shared } = deploymentDebExtract(h);
  assert.deepEqual(deploymentFs.readdirSync(shared).sort(), [...deploymentDebFiles, 'agentsight-collection.py'].sort());
  let size = 0;
  for (const name of ['agentsight-collection.py', ...units]) {
    const target = name.endsWith('.service') ? path.join(extracted, 'usr/lib/systemd/system', name) : path.join(shared, name);
    assert.deepEqual(deploymentFs.readFileSync(target), deploymentFs.readFileSync(path.join(__dirname, '../build', name)));
    assert.equal(deploymentFs.lstatSync(target).mode & 0o777, name.endsWith('.py') ? 0o755 : 0o644);
    size += deploymentFs.lstatSync(target).size;
  }
  for (const name of deploymentDebFiles) {
    const installed = path.join(shared, name);
    const bytes = deploymentFs.readFileSync(installed);
    assert.deepEqual(bytes, deploymentFs.readFileSync(path.join(h.directory, name)));
    assert(!bytes.includes(dummySecret));
    const info = deploymentFs.lstatSync(installed);
    assert(info.isFile() && !info.isSymbolicLink());
    assert.equal(info.mode & 0o777, name === 'agentsight' ? 0o755 : 0o644);
    size += info.size;
  }
  const licenseFile = path.join(extracted, 'usr/share/doc/sysom-agentsight-runtime/copyright');
  assert.deepEqual(deploymentFs.readFileSync(licenseFile), deploymentFs.readFileSync(h.license));
  assert.equal(deploymentFs.lstatSync(licenseFile).mode & 0o777, 0o644);
  size += deploymentFs.lstatSync(licenseFile).size;
  assert.equal(fields['Installed-Size'], String(Math.ceil(size / 1024)));
  assert.deepEqual(deploymentTree(h.directory), sourceBefore);
});

test('AgentSight deb extracted shared runtime prepares private user defaults and preserves opaque existing config', deploymentHost, async t => {
  if (!deploymentDebAvailable(t)) return;
  const h = await deploymentDebFixture(t);
  const { packageAgentSightDeb } = require('../scripts/package-agentsight.cjs');
  await packageAgentSightDeb({ directory: h.directory, output: h.output });
  const { extracted, shared } = deploymentDebExtract(h);
  const sharedBefore = deploymentTree(extracted);
  const env = { HOME: h.base, XDG_DATA_HOME: path.join(h.base, 'user-data'), PATH: '/usr/bin:/bin' };
  const root = agentSightHome(env);
  const install = () => deploymentDebProcess(process.execPath, [path.join(shared, 'install.cjs')], { env, cwd: h.base });
  install();
  assertDeploymentInstalled({ binary: path.join(root, 'bin', 'agentsight'), configPath: path.join(root, 'config.json'), root }, root, h.source.bytes);
  const configPath = path.join(root, 'config.json');
  deploymentFs.writeFileSync(configPath, 'Opaque, non-JSON user config with fixture-deb-dummy-user-token\n');
  deploymentFs.chmodSync(configPath, 0o640);
  const before = deploymentTree(root);
  const observed = deploymentObservedFs({ unreadable: [configPath] });
  const extractedDeployment = require(path.join(shared, 'agentsight-deployment.cjs'));
  await extractedDeployment.prepareAgentSight({ root, packageDirectories: [shared], env, fsImpl: observed.impl });
  install();
  assert.deepEqual(deploymentTree(root), before, 'Existing config bytes, inode, mode and data must remain opaque and unchanged');
  assert.deepEqual(deploymentTree(extracted), sharedBefore, 'User setup must never write into the shared runtime');
  assert(!deploymentFs.existsSync(path.join(root, '.serve-lock')), 'Preparing the extracted package must not start a service');
});

test('AgentSight deb refuses a bad checksum and symlinked package inputs without staging leftovers', deploymentHost, async t => {
  if (!deploymentDebAvailable(t)) return;
  const { packageAgentSightDeb } = require('../scripts/package-agentsight.cjs');
  await t.test('bad checksum is rejected before copying', async sub => {
    const h = await deploymentDebFixture(sub);
    const manifestPath = path.join(h.directory, 'manifest.json');
    const manifest = JSON.parse(deploymentFs.readFileSync(manifestPath, 'utf8'));
    deploymentFs.writeFileSync(manifestPath, JSON.stringify({ ...manifest, sha256: '0'.repeat(64) }));
    const before = deploymentTree(h.base);
    sub.mock.method(deploymentFs.promises, 'copyFile', () => assert.fail('A bad source checksum must fail before any payload copy'));
    await assert.rejects(packageAgentSightDeb({ directory: h.directory, output: h.output }), { code: 'AGENTSIGHT_PACKAGE_CHECKSUM' });
    assert.deepEqual(deploymentTree(h.base), before);
  });
  for (const name of [...deploymentDebFiles, 'directory']) await t.test(`symlinked ${name}`, async sub => {
    const h = await deploymentDebFixture(sub);
    const source = name === 'directory' ? h.directory : path.join(h.directory, name);
    const target = path.join(h.base, 'dummy-symlink-target');
    deploymentFs.renameSync(source, target);
    deploymentFs.symlinkSync(target, source);
    const before = deploymentTree(h.base);
    await assert.rejects(packageAgentSightDeb({ directory: h.directory, output: h.output }));
    assert.deepEqual(deploymentTree(h.base), before, 'Never follow symlinks or leave staging copies, even for auxiliary helpers');
  });
});

test('AgentSight deb refuses relative, non-deb and existing outputs without overwriting or cleanup of neighbors', deploymentHost, async t => {
  if (!deploymentDebAvailable(t)) return;
  const { packageAgentSightDeb } = require('../scripts/package-agentsight.cjs');
  for (const kind of ['relative', 'non-deb', 'existing file', 'existing directory', 'dangling symlink']) await t.test(kind, async sub => {
    const h = await deploymentDebFixture(sub);
    let output = h.output;
    if (kind === 'relative') output = path.relative(process.cwd(), h.output);
    else if (kind === 'non-deb') output = path.join(h.base, 'runtime.tar');
    else if (kind === 'existing file') deploymentFs.writeFileSync(output, 'Existing dummy deb, never overwrite', { mode: 0o600 });
    else if (kind === 'existing directory') {
      deploymentFs.mkdirSync(output, { mode: 0o700 });
      deploymentFs.writeFileSync(path.join(output, 'keep.data'), 'Existing directory contents');
    } else deploymentFs.symlinkSync(path.join(h.base, 'absent-dummy-target'), output);
    const before = deploymentTree(h.base);
    await assert.rejects(packageAgentSightDeb({ directory: h.directory, output }),
      kind === 'relative' || kind === 'non-deb' ? /absolute \.deb output path/ : /already exists/);
    assert.deepEqual(deploymentTree(h.base), before, 'Refused outputs, sources and unrelated scratch entries must remain untouched');
  });
});

test('AgentSight deb rechecks copied payload before building and cleans corrupted staging', deploymentHost, async t => {
  if (!deploymentDebAvailable(t)) return;
  const h = await deploymentDebFixture(t);
  const { packageAgentSightDeb } = require('../scripts/package-agentsight.cjs');
  const before = deploymentTree(h.base);
  const copyFile = deploymentFs.promises.copyFile.bind(deploymentFs.promises);
  let corruptions = 0;
  t.mock.method(deploymentFs.promises, 'copyFile', async (source, target, flags) => {
    await copyFile(source, target, flags);
    if (source !== path.join(h.directory, 'agentsight')) return;
    assert.equal(flags, deploymentFs.constants.COPYFILE_EXCL);
    assert(path.relative(h.base, target).startsWith('.agentsight-deb-'));
    deploymentFs.writeFileSync(target, deploymentElf('fixture-corrupted-copy'));
    corruptions++;
  });
  await assert.rejects(packageAgentSightDeb({ directory: h.directory, output: h.output }), { code: 'AGENTSIGHT_PACKAGE_CHECKSUM' });
  assert.equal(corruptions, 1, 'Exercise verification after a real copy, not only the source checksum');
  assert.deepEqual(deploymentTree(h.base), before, 'Reject the changed payload without a deb, temporary file or staging directory');
});

test('AgentSight deb exclusive publication refuses a racing output and cleans its built temporary archive', deploymentHost, async t => {
  if (!deploymentDebAvailable(t)) return;
  const h = await deploymentDebFixture(t);
  const { packageAgentSightDeb } = require('../scripts/package-agentsight.cjs');
  const before = deploymentTree(h.base);
  const link = deploymentFs.promises.link.bind(deploymentFs.promises);
  let temporaryArchive;
  let competingOutput;
  t.mock.method(deploymentFs.promises, 'link', async (temporary, output) => {
    if (output !== h.output) return link(temporary, output);
    assert.equal(path.dirname(temporary), h.base);
    assert.notEqual(temporary, output);
    assert.equal(deploymentDebProcess('dpkg-deb', ['--field', temporary, 'Version']).trim(), '0.16.0', 'The real deb must already be built');
    temporaryArchive = temporary;
    deploymentFs.writeFileSync(output, 'Dummy competing publisher output', { flag: 'wx', mode: 0o600 });
    competingOutput = deploymentTree(output);
    return link(temporary, output);
  });
  await assert.rejects(packageAgentSightDeb({ directory: h.directory, output: h.output }), { code: 'EEXIST' });
  assert(temporaryArchive, 'Exercise the final exclusive publication after the initial output existence check');
  assert.equal(deploymentFs.existsSync(temporaryArchive), false);
  assert.deepEqual(deploymentTree(h.output), competingOutput, 'Never overwrite or delete another publisher\'s output');
  assert.deepEqual(deploymentTree(h.base).filter(entry => entry.path !== 'runtime.deb'), before,
    'Failed publication must clean its own staging and built temporary deb, preserving all unrelated entries');
});
