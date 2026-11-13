'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { startLocalQueryApi } = require('../electron/local-query-api.cjs');
const { createIdcController } = require('../electron/idc-controller.cjs');
const { startMockOpenApi, summarizeHealth, buildHealthReport } = require('../electron/generated/openapi.cjs');

function state() {
  return { mode: 'collected', hasGpu: false, revision: 7, sampledAt: '2026-11-11T10:00:00Z',
    resources: Object.fromEntries(['cpu', 'energy', 'memory', 'disk', 'gpu'].map(id => [id, {
      id, label: id, usage: id === 'gpu' ? null : 12, capacity: null, unit: '%', source: 'sysak',
      status: id === 'gpu' ? 'unavailable' : 'available', rows: [],
    }])), inspections: [], optimizations: [], operations: [] };
}
function request(endpoint, route, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(endpoint.base_url, { path: route, method: options.method || 'GET',
      headers: { authorization: `Bearer ${endpoint.token}`, ...options.headers } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers,
        body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null }));
    });
    req.on('error', reject);
    req.end(options.body);
  });
}
async function fixture(t, view = { status: { device_id: 'fixture' }, state: null, agent: null, tasks: [] }) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sysom-query-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  view.status = { schema_version: '1.0', mode: 'mock', read_only: true, installed: false, enabled: true,
    phase: 'error', api_version: '1.0', last_task: null, inspection_interval_minutes: 5,
    next_inspection_at: null, error: null, ...view.status };
  let calls = 0;
  const api = await startLocalQueryApi({ queryView: () => { calls++; return structuredClone(view); },
    discoveryDirectory: path.join(directory, 'local-api'), hostKind: 'test', summarizeHealth, buildHealthReport });
  t.after(() => api.close());
  return { api, view, calls: () => calls, endpoint: JSON.parse(fs.readFileSync(api.discoveryFile, 'utf8')) };
}

test('private discovery contains an independent token and disappears on idempotent close', async t => {
  const { api, endpoint } = await fixture(t);
  assert.match(endpoint.token, /^[a-f0-9]{64}$/);
  assert.equal(endpoint.read_only, true);
  assert.equal(endpoint.base_url, api.baseUrl);
  assert.equal(fs.statSync(api.discoveryFile).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(api.discoveryFile)).mode & 0o777, 0o700);
  assert.equal((await request(endpoint, '/api/v1/status')).status, 200);
  await Promise.all([api.close(), api.close()]);
  assert.equal(fs.existsSync(api.discoveryFile), false);
  await assert.rejects(request(endpoint, '/api/v1/status'));
});

test('authentication, Host, Origin, methods, bodies and ingestion paths are rejected without reading caches', async t => {
  const f = await fixture(t);
  const before = f.calls();
  for (const [route, options, status] of [
    ['/api/v1/status', { headers: { authorization: '' } }, 401],
    ['/api/v1/status', { headers: { authorization: 'Bearer not-the-query-token' } }, 401],
    ['/api/v1/status', { headers: { host: 'attacker.example' } }, 403],
    ['/api/v1/status', { headers: { host: `localhost:${new URL(f.api.baseUrl).port}` } }, 403],
    ['/api/v1/status', { headers: { origin: 'null' } }, 403],
    ['/api/v1/status', { headers: { origin: '' } }, 403],
    ['/api/v1/status', { method: 'POST', body: '{}' }, 405],
    ['/api/v1/status', { method: 'OPTIONS' }, 405],
    ['/api/v1/status', { method: 'HEAD' }, 405],
    ['/api/v1/status', { body: 'x', headers: { 'content-length': '1' } }, 400],
    ['/api/v1/%2e%2e/status', {}, 400],
    ['/api/v1/datasets/gpu-devices/%2fetc%2fpasswd', {}, 400],
        ['/api/v1/%ZZ', {}, 400],
    ['/api//v1/status', {}, 400],
    ['/api/v1/status?refresh=true', {}, 400],
  ]) {
    const response = await request(f.endpoint, route, options);
    assert.equal(response.status, status, `${options.method || 'GET'} ${route}`);
    assert.equal(response.headers['access-control-allow-origin'], undefined);
    assert.equal(response.headers['cache-control'], 'no-store');
  }
  assert.equal(f.calls(), before);
  assert.equal((await request(f.endpoint, '/openapi/v1/collections')).status, 404);
  assert.equal((await request(f.endpoint, '/api/v1/process-execute')).status, 404);
  f.view.state = state();
  assert.equal((await request(f.endpoint, '/api/v1/datasets/gpu-devices/%252e%252e')).status, 404);
});

test('cache-only status, discovery, snapshot, summary, report and OpenAPI preserve real values and missing state', async t => {
  const f = await fixture(t);
  const snapshot = await request(f.endpoint, '/api/v1/snapshot');
  assert.equal(snapshot.body.data.state, null);
  assert.equal(snapshot.body.meta.cache_only, true);
  assert.equal((await request(f.endpoint, '/api/v1/summary')).status, 503);
  assert.equal((await request(f.endpoint, '/api/v1/report')).status, 503);
  f.view.state = state();
  const summary = await request(f.endpoint, '/api/v1/summary');
  assert.equal(summary.status, 200);
  assert.deepEqual(summary.body.data, summarizeHealth(f.view.state));
  const report = await request(f.endpoint, '/api/v1/report');
  assert.deepEqual(report.body.data.health, f.view.state);
  assert.match(report.body.data.health_text, /本机资源采集报告/);
  assert.equal(report.body.meta.revision, 7);
  const capabilities = await request(f.endpoint, '/api/v1/capabilities');
  assert.equal(capabilities.body.data.demo_data_exposed, false);
  assert.equal(capabilities.body.data.read_only, true);
  const contract = await request(f.endpoint, '/api/v1/openapi.json');
  assert.equal(contract.status, 200);
  assert.match(contract.body.openapi, /^3\.1/);
  assert.ok(contract.body.paths['/api/v1/datasets/{name}']);
  assert.equal(JSON.stringify(report.body).includes(f.endpoint.token), false);
});

function schemaMatches(value, schema, contract) {
  if (schema.$ref) return schemaMatches(value, contract.components.schemas[schema.$ref.split('/').at(-1)], contract);
  if (schema.oneOf) return schema.oneOf.filter(child => schemaMatches(value, child, contract)).length === 1;
  if (Object.hasOwn(schema, 'const') && value !== schema.const) return false;
  if (schema.enum && !schema.enum.includes(value)) return false;
  const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  if (schema.type && ![].concat(schema.type).some(type => type === actual || type === 'integer' && Number.isSafeInteger(value))) return false;
  if (actual === 'object') {
    if ((schema.required || []).some(key => !Object.hasOwn(value, key))) return false;
    if (schema.additionalProperties === false && Object.keys(value).some(key => !Object.hasOwn(schema.properties, key))) return false;
    if (Object.entries(value).some(([key, child]) => schema.properties?.[key] && !schemaMatches(child, schema.properties[key], contract))) return false;
  }
  if (actual === 'array' && schema.items && value.some(child => !schemaMatches(child, schema.items, contract))) return false;
  return true;
}

test('actual HTTP envelopes and encoded generated detail IDs match the served OpenAPI contract', async t => {
  const f = await fixture(t, { status: { device_id: 'fixture' }, state: state(), agent: {
    source: 'agentsight', analyzer: 'sysom-openapi', sampledAt: '2026-11-11T10:00:00Z',
    window: { start: '2026-11-10T10:00:00Z', end: '2026-11-11T10:00:00Z' }, status: 'partial',
    outcome: 'unknown', summary: 'fixture', lastScanAt: null, filteredProcesses: null,
    totals: { sessions: 0, inputTokens: 0, outputTokens: 0, unresolved: null, critical: null, high: null },
    coverage: [{ key: 'processes', status: 'unavailable', reason: 'fixture' }],
    findings: [], processes: [], sessions: [], interruptions: [], latency: [],
  }, tasks: [] });
  const contract = (await request(f.endpoint, '/api/v1/openapi.json')).body;
  for (const route of ['/api/v1/status', '/api/v1/capabilities', '/api/v1/snapshot', '/api/v1/summary', '/api/v1/report']) {
    const response = await request(f.endpoint, route);
    assert.equal(response.status, 200, route);
    const schema = contract.paths[route].get.responses['200'].content['application/json'].schema;
    assert.equal(schemaMatches(response.body, schema, contract), true, route);
    assert.equal(contract.paths[route].get.parameters.length, 0, route);
  }
  const list = await request(f.endpoint, '/api/v1/datasets/agent-coverage');
  assert.equal(list.status, 200);
  const id = list.body.items[0].id;
  assert.ok(id.includes('%'));
  const detail = await request(f.endpoint, `/api/v1/datasets/agent-coverage/${encodeURIComponent(id)}`);
  assert.equal(detail.status, 200);
  assert.deepEqual(detail.body.item, list.body.items[0]);
  assert.equal(schemaMatches(list.body, contract.components.schemas.DatasetList, contract), true);
  assert.equal(schemaMatches(detail.body, contract.components.schemas.DatasetDetail, contract), true);
  f.view.state = null;
  const agentReport = await request(f.endpoint, '/api/v1/report');
  assert.equal(agentReport.status, 200);
  assert.equal(schemaMatches(agentReport.body, contract.components.schemas.Report, contract), true);
  const unauthorized = await request(f.endpoint, '/api/v1/status', { headers: { authorization: '' } });
  assert.equal(schemaMatches(unauthorized.body, contract.components.schemas.Error, contract), true);
});

test('real-host AgentSight status and collection evidence match strict status and snapshot schemas', async t => {
  const f = await fixture(t);
  const contract = (await request(f.endpoint, '/api/v1/openapi.json')).body;
  for (const serviceState of ['running', 'unavailable', 'closed']) {
    for (const collectionState of [undefined, 'running', 'disabled', 'failed', 'unavailable']) {
      const enabled = collectionState === 'running' || collectionState === 'failed';
      const service = { state: serviceState, managed: serviceState === 'running', code: serviceState === 'unavailable' ? 'AGENTSIGHT_NOT_CHECKED' : null, message: 'fixture service evidence' };
      if (collectionState) service.collection = { state: collectionState, enabled, scope: enabled ? 'host' : 'none', trace_running: collectionState === 'running', api_running: collectionState === 'running', message: 'fixture collection evidence' };
      f.view.status.agent_sight = service;
      for (const route of ['/api/v1/status', '/api/v1/snapshot']) {
        const response = await request(f.endpoint, route);
        assert.equal(response.status, 200);
        const schema = contract.paths[route].get.responses['200'].content['application/json'].schema;
        assert.equal(schemaMatches(response.body, schema, contract), true, `${route}: ${serviceState}/${collectionState}`);
        const status = route.endsWith('/snapshot') ? response.body.data.status : response.body.data;
        assert.deepEqual(status.agent_sight, service);
        assert.equal(schemaMatches({ ...status, agent_sight: { ...service, unexpected: true } }, contract.components.schemas.Status, contract), false);
      }
    }
  }
});

test('two instances have separate discovery, tokens and snapshots', async t => {
  const a = await fixture(t);
  const b = await fixture(t, { status: { device_id: 'other' }, state: state(), agent: null, tasks: [] });
  assert.notEqual(a.endpoint.token, b.endpoint.token);
  assert.notEqual(a.api.baseUrl, b.api.baseUrl);
  assert.notEqual(a.api.instanceId, b.api.instanceId);
  assert.equal((await request(a.endpoint, '/api/v1/status', { headers: { authorization: `Bearer ${b.endpoint.token}` } })).status, 401);
  assert.equal((await request(a.endpoint, '/api/v1/snapshot')).body.data.state, null);
  assert.equal((await request(b.endpoint, '/api/v1/snapshot')).body.data.state.revision, 7);
});

test('unsafe or shared discovery directories are refused without changing permissions', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sysom-query-path-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const shared = path.join(root, 'shared');
  fs.mkdirSync(shared, { mode: 0o755 });
  const linked = path.join(root, 'linked');
  fs.symlinkSync(shared, linked);
  const options = { queryView: () => ({ status: { device_id: 'fixture' } }), hostKind: 'test', summarizeHealth, buildHealthReport };
  await assert.rejects(startLocalQueryApi({ ...options, discoveryDirectory: shared }), /private/);
  await assert.rejects(startLocalQueryApi({ ...options, discoveryDirectory: linked }), /unsafe/);
  await assert.rejects(startLocalQueryApi({ ...options, discoveryDirectory: path.join(linked, 'child') }), /Unsafe/);
  assert.equal(fs.statSync(shared).mode & 0o777, 0o755);
  assert.deepEqual(fs.readdirSync(shared), []);
});

test('controller queryView and public GET never call collection, and service follows controller lifetime', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sysom-query-controller-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let launches = 0;
  const controller = await createIdcController({ bundleRoot: path.join(root, 'not-installed'), startMockOpenApi,
    launchImpl: () => { launches++; throw new Error('GET must not collect'); },
    queryApi: { discoveryDirectory: path.join(root, 'local-api'), hostKind: 'test', summarizeHealth, buildHealthReport } });
  t.after(() => controller.close());
  const view = controller.queryView();
  assert.equal(view.state, null);
  assert.equal(view.agent, null);
  assert.deepEqual(view.tasks, []);
  assert.equal(view.status.query_api.enabled, true);
  view.status.enabled = false;
  assert.equal(controller.queryView().status.enabled, true);
  const file = path.join(root, 'local-api', `${view.status.query_api.instance_id}.json`);
  const endpoint = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const route of ['/api/v1/status', '/api/v1/capabilities', '/api/v1/snapshot', '/api/v1/summary',
    '/api/v1/report', '/api/v1/datasets/resources', '/api/v1/datasets/agent-processes', '/api/v1/datasets/tasks']) {
    const response = await request(endpoint, route);
    assert.ok([200, 503].includes(response.status), route);
  }
  assert.equal(launches, 0);
  assert.equal(controller.queryView().state, null);
  await controller.close();
  assert.equal(fs.existsSync(file), false);
});
