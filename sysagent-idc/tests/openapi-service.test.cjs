const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const esbuild = require('esbuild');

const root = path.resolve(__dirname, '..');
const spec = JSON.parse(fs.readFileSync(path.join(root, 'openapi-contract.json'), 'utf8'));
const token = randomUUID();
const MiB = 1024 * 1024;
let temporary;
let startMockOpenApi;
let parseCollectedState;
before(async () => {
  temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'sysom-openapi-test-'));
  try {
    await esbuild.build({
      entryPoints: { service: path.join(root, 'openapi-service.ts'), collected: path.join(root, 'collected-state.ts') },
      outdir: temporary, bundle: true, platform: 'node', format: 'cjs', target: 'node18', logLevel: 'silent',
    });
    ({ startMockOpenApi } = require(path.join(temporary, 'service.js')));
    ({ parseCollectedState } = require(path.join(temporary, 'collected.js')));
  } catch (error) {
    fs.rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
});
after(() => { if (temporary) fs.rmSync(temporary, { recursive: true, force: true }); });

function evidence(content, source = 'fixture', status = 'ok', sampledAt = '2026-11-01T12:34:56.200+00:00') {
  return { status, source, content, sampled_at: sampledAt };
}
function processEvidence(pid, starttime, utime, stime, rss_bytes, read_bytes, write_bytes) {
  return { pid, starttime, comm: `fixture-${pid}`, utime, stime, rss_bytes, io_status: 'ok', io: { read_bytes, write_bytes } };
}
function zone(name, energy_uj, max_energy_range_uj = 100000000) {
  return { path: `/sys/class/powercap/${name}`, name, energy_uj, max_energy_range_uj };
}
function payload(operation = 'snapshot', parameters = {}, deviceId = randomUUID()) {
  const requestId = randomUUID();
  const profile = operation === 'inspect' ? 'inspection' : 'resources';
  const startedAt = '2026-11-01T12:34:56.000+00:00';
  const finishedAt = '2026-11-01T12:34:56.200+00:00';
  const gpu = evidence(gpuSnapshot([
    gpuDevice({ name: 'Fixture A', uuid: 'GPU-a', util: '40', mem_total: '8192', mem_used: '2048', power_draw: '75', temp: '60' }),
    gpuDevice({ index: 1, name: 'Fixture B', uuid: 'GPU-b', util: '70', mem_total: '4096', mem_used: '1024', power_draw: '40', temp: '50' }),
  ]), { argv: ['nvidia-smi', '--query-gpu=index,uuid,pci.bus_id,name,utilization.gpu,utilization.memory,memory.used,memory.total,temperature.gpu,power.draw,power.limit,ecc.errors.corrected.volatile.total,ecc.errors.uncorrected.volatile.total,pcie.link.gen.max,pcie.link.gen.current,pcie.link.width.current', '--format=csv,noheader,nounits'] });
  return {
    schema_version: '1.0', request_id: requestId, device_id: deviceId, operation, parameters,
    raw_snapshot: {
      schema_version: '1.0', request_id: requestId,
      collector: { name: 'sysak', command: 'idc', version: '1.0.0' },
      device: { platform: 'Linux', machine: 'x86_64', hostname: 'mock-device', scope: 'local' },
      collection: {
        profile, started_at: startedAt, finished_at: finishedAt, duration_ms: 200, status: 'ok', sample_ms: 200,
      },
      resources: {
        cpu: [
          evidence('cpu 100 20 30 400 50 5 5 10 70 10\ncpu0 1 0 0 99 0 0 0 0\n', '/proc/stat', 'ok', startedAt),
          evidence('cpu 140 30 50 450 60 10 10 20 500 1000\n', '/proc/stat'),
        ],
        meminfo: evidence('MemTotal: 1000 kB\nMemAvailable: 250 kB\nMemFree: 100 kB\nCached: 500 kB\n', '/proc/meminfo'),
        root_filesystem: evidence({ f_bsize: 8192, f_frsize: 4096, f_blocks: 1000, f_bfree: 200, f_bavail: 150 }, 'statvfs:/'),
        cpu_count: evidence(4, 'sysconf:SC_NPROCESSORS_ONLN'),
        processes: evidence({ clock_ticks: 100, samples: [
          { monotonic_seconds: 10, processes: [processEvidence(101, 10, 100, 50, 256000, 1000, 2000), processEvidence(202, 20, 50, 10, 128000, 100, 200)] },
          { monotonic_seconds: 12, processes: [processEvidence(202, 20, 90, 50, 128000, 2100, 6200), processEvidence(101, 10, 200, 50, 256000, 5000, 6000)] },
        ] }, '/proc/[pid]/{stat,status,io}'),
        energy_uj: evidence({ samples: [
          { monotonic_seconds: 10, zones: [zone('package-0', 10000000), zone('package-1', 20000000)] },
          { monotonic_seconds: 12, zones: [zone('package-0', 30000000), zone('package-1', 26000000)] },
        ] }, '/sys/class/powercap'),
        gpu,
      },
      configuration: {},
      diagnostics: profile === 'inspection' ? {
        resource_anomaly: evidence({ mode: 'idc', read_only: true,
          root: { status: 'ok', total_bytes: 1000, used_bytes: 950, scan: { complete: false, reason: 'entry_limit' }, directories: [{ path: '/fixture', allocated_bytes: 128 }] },
          fd: { status: 'partial', allocated: 80, file_max: 100, coverage: { complete: false, observed_processes: 2, denied_processes: 1, truncated: false, reason: 'permission_denied' },
            processes: [{ pid: 101, name: 'fixture-101', fd_count: 95, soft_limit: 100, usage_pct: 95 }] },
        }, { argv: ['sysak', 'resource_anomaly', '--idc'] }),
        memgraph: evidence({ version: '2.0', mode: 'native', tool: 'memgraph', status: 'partial', unit: 'KiB',
          graph: { total: 1000, free: 50, used: 950, avaliable: 100, userUsed: 500, kernelUsed: 100, shmem: 20 },
          coverage: { native_plugin_coverage_unknown: true },
        }, { argv: ['sysak', 'memgraph', '--graph', '--jsonstdout'] }, 'partial'),
        gpu,
      } : {},
      capabilities: { read_only: true, supported_profiles: ['resources', 'inspection'], unsupported_actions: ['cleanup', 'optimize', 'process-kill'] },
    },
  };
}
function exchange(api, route, { method = 'GET', body, text, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const bytes = text !== undefined ? text : body !== undefined ? JSON.stringify(body) : undefined;
    const request = http.request(`${api.baseUrl}${route}`, {
      method, headers: { Authorization: `Bearer ${token}`, ...(bytes !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => {
        try {
          assert.equal(response.headers['cache-control'], 'no-store');
          assert.match(response.headers['content-type'], /^application\/json/);
          assert.equal(response.headers['access-control-allow-origin'], undefined);
          assert.equal(response.headers['access-control-allow-credentials'], undefined);
          const result = { status: response.statusCode, headers: response.headers, json: JSON.parse(Buffer.concat(chunks).toString('utf8')) };
          if (result.status >= 400) matches(spec.components.schemas.ErrorResponse, result.json);
          resolve(result);
        } catch (error) { reject(error); }
      });
    });
    request.on('error', reject);
    request.end(bytes);
  });
}
const post = (api, body, options = {}) => exchange(api, '/openapi/v1/collections', { method: 'POST', body, ...options });
const snapshot = (api, deviceId) => exchange(api, `/openapi/v1/devices/${deviceId}/snapshot`);
async function success(api, body) {
  const originalRaw = structuredClone(body.raw_snapshot);
  matches(spec.components.schemas.CollectionRequest, body);
  const result = await post(api, body);
  assert.equal(result.status, 200, JSON.stringify(result.json));
  matches(spec.components.schemas.CollectionResponse, result.json);
  assert.equal(result.json.task_id, result.json.task.id);
  assert.equal(result.json.request_id, body.request_id);
  assert.equal(result.json.task.operation, body.operation);
  assert.equal(result.json.mode, 'mock', 'outer mode describes local deployment, not synthetic data');
  assert.equal(result.json.read_only, true);
  assert.equal(result.json.state.mode, 'collected');
  assert.equal(result.json.task.simulated, false);
  assert.equal(result.json.task.read_only, true);
  assert.equal(result.json.receipt.collected_at, originalRaw.collection.finished_at);
  assert.deepEqual(result.json.receipt.device, { id: body.device_id });
  assert.equal(result.json.receipt.raw_bytes, Buffer.byteLength(JSON.stringify(originalRaw)));
  assert.deepEqual(body.raw_snapshot, originalRaw);
  assert.equal(result.json.raw_snapshot, undefined);
  return result.json;
}
async function rejected(api, body, status = 400, code = 'invalid_request', options = {}) {
  const result = await post(api, body, options);
  assert.equal(result.status, status, JSON.stringify(result.json));
  assert.equal(result.json.error.code, code);
  assert.equal(result.json.error.retryable, status === 503);
  return result.json;
}
async function withServer(run) {
  const api = await startMockOpenApi({ token });
  try { return await run(api); } finally { await api.close(); }
}
function parsed(body = payload(), previous, inspect = body.operation === 'inspect', reset = body.operation === 'reset') {
  const original = structuredClone(body.raw_snapshot);
  const prior = previous && structuredClone(previous);
  const state = parseCollectedState(body.raw_snapshot, previous, inspect, reset);
  assert.deepEqual(body.raw_snapshot, original, 'parsing must not mutate evidence');
  assert.deepEqual(previous, prior, 'parsing must not mutate prior state');
  return state;
}
function realRows(state) {
  assert.equal(state.mode, 'collected');
  assert.deepEqual(state.optimizations, []);
  for (const resource of Object.values(state.resources)) {
    assert.equal(resource.source, 'sysak');
    assert.equal(resource.capacity, null, 'collected quantities must not use demo GB capacities');
    for (const row of resource.rows) {
      assert.equal(row.cleanable, false);
      assert.equal(row.defaultSelected, false);
      assert.equal(Object.hasOwn(row, 'agentId'), false);
      assert.equal(Object.hasOwn(row, 'sessions'), false);
      assert(Number.isFinite(row.usage) && row.usage >= 0);
    }
  }
}
function allUnknown(state) {
  for (const resource of Object.values(state.resources)) {
    assert.equal(resource.usage, null);
    assert.equal(resource.quantity, undefined);
    assert.deepEqual(resource.rows, []);
    assert.equal(resource.status, 'unavailable');
  }
  realRows(state);
}
const inspection = (state, id) => {
  const item = state.inspections.find((entry) => entry.id === id);
  assert(item, `missing inspection ${id}`);
  return item;
};

// Fixture checks keep this contract's schema vocabulary dependency-free.
function resolveRef(ref) {
  assert.match(ref, /^#\//);
  return ref.slice(2).split('/').reduce((value, key) => {
    assert(value && Object.hasOwn(value, key), `Unresolved reference: ${ref}`);
    return value[key];
  }, spec);
}
function valid(schema, value) { try { matches(schema, value); return true; } catch { return false; } }
function matches(schema, value, at = '$') {
  if (schema.$ref) matches(resolveRef(schema.$ref), value, at);
  if (schema.const !== undefined) assert.deepEqual(value, schema.const, at);
  if (schema.enum) assert(schema.enum.some((item) => valid({ const: item }, value)), `${at}: enum`);
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const fits = (type) => type === 'null' ? value === null : type === 'array' ? Array.isArray(value) :
      type === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value) :
      type === 'integer' ? Number.isInteger(value) : type === 'number' ? typeof value === 'number' && Number.isFinite(value) : typeof value === type;
    assert(types.some(fits), `${at}: type ${types}`);
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined) assert([...value].length >= schema.minLength, `${at}: minLength`);
    if (schema.maxLength !== undefined) assert([...value].length <= schema.maxLength, `${at}: maxLength`);
    if (schema.pattern) assert(new RegExp(schema.pattern).test(value), `${at}: pattern`);
    if (schema.format === 'uuid') assert.match(value, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    if (schema.format === 'date-time') assert(Number.isFinite(Date.parse(value)), `${at}: date-time`);
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined) assert(value >= schema.minimum, `${at}: minimum`);
    if (schema.maximum !== undefined) assert(value <= schema.maximum, `${at}: maximum`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined) assert(value.length >= schema.minItems, `${at}: minItems`);
    if (schema.maxItems !== undefined) assert(value.length <= schema.maxItems, `${at}: maxItems`);
    if (schema.uniqueItems) assert.equal(new Set(value.map((item) => JSON.stringify(item))).size, value.length, `${at}: uniqueItems`);
    if (schema.items) value.forEach((item, index) => matches(schema.items, item, `${at}[${index}]`));
  } else if (value !== null && typeof value === 'object') {
    for (const name of schema.required ?? []) assert(Object.hasOwn(value, name), `${at}: required ${name}`);
    for (const [name, item] of Object.entries(value)) {
      if (schema.propertyNames) matches(schema.propertyNames, name, at);
      if (schema.properties && Object.hasOwn(schema.properties, name)) matches(schema.properties[name], item, `${at}.${name}`);
      else if (schema.additionalProperties === false) assert.fail(`${at}: extra ${name}`);
    }
  }
  for (const child of schema.allOf ?? []) matches(child, value, at);
  if (schema.if) {
    const branch = valid(schema.if, value) ? schema.then : schema.else;
    if (branch) matches(branch, value, at);
  }
}

test('contract is OpenAPI 3.1, references resolve, all routes are secured and fixtures follow conditional schemas', async () => {
  assert.equal(spec.openapi, '3.1.0');
  assert.equal(spec.jsonSchemaDialect, 'https://json-schema.org/draft/2020-12/schema');
  assert.deepEqual(spec.security, [{ BearerAuth: [] }]);
  assert.equal(spec.components.securitySchemes.BearerAuth.scheme, 'bearer');
  const identifiers = new Set();
  for (const [route, item] of Object.entries(spec.paths)) {
    assert.match(route, /^\/openapi\/v1\//);
    for (const operation of Object.values(item)) {
      assert(!identifiers.has(operation.operationId));
      identifiers.add(operation.operationId);
      assert(operation.responses['200'] && operation.responses['401']);
      assert.equal(operation.security, undefined); // Inherits mandatory global auth.
      for (const name of route.match(/\{([^}]+)\}/g) ?? []) {
        assert(operation.parameters.some((parameter) => parameter.in === 'path' && parameter.required && `{${parameter.name}}` === name));
      }
    }
  }
  assert.equal(identifiers.size, 6);
  assert.equal(spec.paths['/openapi/v1/agent-diagnostics'].post.operationId, 'submitAgentDiagnostics');
  for (const status of ['400', '401', '409', '413', '415', '503']) assert(spec.paths['/openapi/v1/collections'].post.responses[status]);
  function walk(value) {
    if (!value || typeof value !== 'object') return;
    if (value.$ref) resolveRef(value.$ref);
    for (const child of Object.values(value)) walk(child);
  }
  walk(spec);
  const bad = payload('cleanup');
  assert(!valid(spec.components.schemas.CollectionRequest, bad));
  bad.parameters = { revision: 1, resource: 'cpu', ids: ['cpu-2'] };
  assert(valid(spec.components.schemas.CollectionRequest, bad));
  bad.parameters.command = 'anything';
  assert(!valid(spec.components.schemas.CollectionRequest, bad));
  await withServer(async (api) => {
    const response = await exchange(api, '/openapi/v1/openapi.json');
    assert.equal(response.status, 200);
    assert.deepEqual(response.json, spec);
    const capabilities = await exchange(api, '/openapi/v1/capabilities');
    matches(spec.components.schemas.Capabilities, capabilities.json);
    assert.equal(capabilities.json.mode, 'mock');
    assert.equal(capabilities.json.read_only, true);
    assert.deepEqual(capabilities.json.demo_operations, []);
    assert.deepEqual(capabilities.json.collection_operations, ['snapshot', 'reset', 'inspect']);
    assert.equal(capabilities.json.collection_operations.includes('configuration'), false);
    assert.deepEqual(capabilities.json.collection.profiles, ['resources', 'inspection']);
    assert.equal(capabilities.json.destructive_actions_enabled, false);
    assert.equal(capabilities.json.collection.arbitrary_commands, false);
  });
});

test('mandatory token, loopback binding, timeout, all-route auth, no CORS, methods and idempotent close', async () => {
  for (const badToken of ['', 'with whitespace', '\n', undefined]) await assert.rejects(startMockOpenApi({ token: badToken }));
  for (const port of [-1, 65536, 1.5]) await assert.rejects(startMockOpenApi({ token, port }));
  const create = http.createServer;
  let server;
  http.createServer = (...args) => { server = create(...args); return server; };
  let api;
  try {
    api = await startMockOpenApi({ token });
    assert.equal(server.address().address, '127.0.0.1');
    assert.equal(server.requestTimeout, 30_000);
    assert.match(api.baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
    for (const route of ['/openapi/v1/collections', '/openapi/v1/capabilities', '/openapi/v1/openapi.json', `/openapi/v1/devices/${randomUUID()}/snapshot`, `/openapi/v1/tasks/${randomUUID()}`, '/unknown']) {
      for (const authorization of ['', 'Basic invalid', 'Bearer short', `Bearer ${'x'.repeat(1000)}`]) {
        const response = await exchange(api, route, { headers: { Authorization: authorization } });
        assert.equal(response.status, 401);
        assert.equal(response.headers['www-authenticate'], 'Bearer');
        assert.equal(response.json.error.code, 'unauthorized');
        assert(!JSON.stringify(response.json).includes(token));
      }
    }
    for (const origin of ['https://untrusted.invalid', api.baseUrl, 'null']) {
      assert.equal((await exchange(api, '/openapi/v1/capabilities', { headers: { Origin: origin } })).status, 403);
    }
    assert.equal((await exchange(api, '/openapi/v1/capabilities', { method: 'OPTIONS' })).status, 405);
    const method = await exchange(api, '/openapi/v1/collections');
    assert.equal(method.status, 405);
    assert.equal(method.headers.allow, 'POST');
    assert.equal((await exchange(api, '/unknown')).status, 404);
    await api.close();
    await api.close();
    await assert.rejects(exchange(api, '/openapi/v1/capabilities'));
  } finally {
    http.createServer = create;
    if (api) await api.close();
  }
});

test('initial actual evidence, fresh snapshot revisions, partial receipt and permission metadata, task retrieval', async () => {
  await withServer(async (api) => {
    const body = payload();
    const initial = await success(api, body);
    assert.deepEqual(initial.state, parsed(body));
    assert.equal(initial.state.revision, 1);
    assert.deepEqual(Object.fromEntries(Object.entries(initial.state.resources).map(([id, resource]) => [id, resource.usage])),
      { cpu: 60, energy: null, memory: 75, disk: 80, gpu: 70 });
    realRows(initial.state);
    assert.equal(initial.receipt.raw_bytes, Buffer.byteLength(JSON.stringify(body.raw_snapshot)));
    const partialBody = payload('snapshot', {}, body.device_id);
    partialBody.raw_snapshot.collection.status = 'partial';
    partialBody.raw_snapshot.collector.permissions = { status: 'partial', elevated: false, denied: ['gpu', 'kernel'] };
    partialBody.raw_snapshot.resources.secret = 'raw-not-to-be-returned';
    partialBody.raw_snapshot.collector.extra = 'collector-private-field';
    const partial = await success(api, partialBody);
    assert.equal(partial.receipt.collection_status, 'partial');
    assert.equal(partial.receipt.profile, 'resources');
    assert.equal(partial.receipt.collected_at, partialBody.raw_snapshot.collection.finished_at);
    assert.deepEqual(partial.receipt.collector.permissions, partialBody.raw_snapshot.collector.permissions);
    assert.deepEqual(partial.receipt.device, { id: body.device_id });
    assert(!JSON.stringify(partial).includes('raw-not-to-be-returned'));
    assert(!JSON.stringify(partial).includes('collector-private-field'));
    assert.equal(partial.raw_snapshot, undefined);
    assert.deepEqual(partial.state, parsed(partialBody, initial.state));
    assert.equal(partial.state.revision, 2);
    assert.deepEqual(partial.state.inspections, initial.state.inspections);
    const current = await snapshot(api, body.device_id.toUpperCase());
    assert.deepEqual(current.json, partial);
    const task = await exchange(api, `/openapi/v1/tasks/${partial.task_id}`);
    assert.equal(task.status, 200);
    matches(spec.components.schemas.TaskResponse, task.json);
    assert.deepEqual(task.json.task, partial.task);
    assert.equal((await exchange(api, `/openapi/v1/tasks/${randomUUID()}`)).status, 404);
    assert.equal((await snapshot(api, randomUUID())).status, 404);
  });
});

test('configuration operation is unsupported and inspection has no configuration evidence', async () => {
  await withServer(async (api) => {
    const body = payload();
    await success(api, body);
    const inspection = payload('inspect', { revision: 1 }, body.device_id);
    assert.deepEqual(inspection.raw_snapshot.configuration, {});
    assert.deepEqual(inspection.raw_snapshot.capabilities.supported_profiles, ['resources', 'inspection']);
    const current = await success(api, inspection);
    assert.equal(current.receipt.profile, 'inspection');

    const configuration = payload('configuration', {}, body.device_id);
    configuration.raw_snapshot.collection.profile = 'configuration';
    assert(!valid(spec.components.schemas.CollectionRequest, configuration));
    const error = await rejected(api, configuration);
    assert.equal(error.error.message, 'Unsupported operation');
    configuration.raw_snapshot.collection.profile = 'resources';
    const resourcesError = await rejected(api, configuration);
    assert.equal(resourcesError.error.message, 'Unsupported operation');
    assert.deepEqual((await snapshot(api, body.device_id)).json, current);
  });
});

test('sysAK metadata needs no raw device ID or collected_at; receipt uses the outer UUID and finished_at', async () => {
  const rawSchema = spec.components.schemas.RawSnapshot;
  assert(!rawSchema.required.includes('collected_at'));
  assert.equal(rawSchema.properties.collected_at, undefined);
  assert(rawSchema.required.includes('capabilities'));
  assert(rawSchema.properties.collection.required.includes('finished_at'));
  assert.equal(spec.components.schemas.Device.required, undefined);
  await withServer(async (api) => {
    const body = payload('snapshot', {}, randomUUID().toUpperCase());
    assert.deepEqual(Object.keys(body.raw_snapshot.device).sort(), ['hostname', 'machine', 'platform', 'scope']);
    assert.equal(Object.hasOwn(body.raw_snapshot.device, 'id'), false);
    assert.equal(Object.hasOwn(body.raw_snapshot, 'collected_at'), false);
    const initial = await success(api, body);
    assert.equal(initial.receipt.collector.version, '1.0.0');
    assert.equal(initial.receipt.collector.command, undefined);
    assert.equal(initial.receipt.collector.permissions, undefined);
    assert.deepEqual((await snapshot(api, body.device_id.toLowerCase())).json, initial);

    const extras = payload('snapshot', {}, body.device_id);
    extras.raw_snapshot.device.id = randomUUID();
    extras.raw_snapshot.collected_at = 'opaque-extra-not-the-completion-time';
    extras.raw_snapshot.collection.finished_at = '2026-11-01T13:34:56.200+01:00';
    const originalRaw = structuredClone(extras.raw_snapshot);
    const source = JSON.stringify(originalRaw, null, 2);
    const text = JSON.stringify(extras).replace(JSON.stringify(extras.raw_snapshot), source);
    matches(spec.components.schemas.CollectionRequest, extras);
    const accepted = await post(api, undefined, { text });
    assert.equal(accepted.status, 200);
    matches(spec.components.schemas.CollectionResponse, accepted.json);
    assert.equal(accepted.json.receipt.collected_at, extras.raw_snapshot.collection.finished_at);
    assert.deepEqual(accepted.json.receipt.device, { id: extras.device_id });
    assert.equal(accepted.json.receipt.raw_bytes, Buffer.byteLength(source));
    assert.deepEqual(extras.raw_snapshot, originalRaw);
    assert(!JSON.stringify(accepted.json).includes('opaque-extra-not-the-completion-time'));
    assert.deepEqual((await post(api, undefined, { text })).json, accepted.json);
    extras.raw_snapshot.resources.cpu[0].content += 'opaque evidence';
    await rejected(api, extras, 409, 'idempotency_conflict');

    const minimal = payload('snapshot', {}, body.device_id);
    minimal.raw_snapshot.device = {};
    minimal.raw_snapshot.capabilities = { read_only: true };
    const result = await success(api, minimal);
    assert.deepEqual(result.state, parsed(minimal, accepted.json.state));
    assert.equal(result.state.revision, 3);
  });
});

test('invalid JSON, UUIDs, schema versions, raw sections, metadata and profiles are rejected without state commit', async () => {
  await withServer(async (api) => {
    const seed = await success(api, payload());
    const deviceId = seed.receipt.device.id;
    const invalidators = [
      (body) => { body.request_id = 'not-a-uuid'; },
      (body) => { body.device_id = '00000000-0000-0000-0000-000000000000'; },
      (body) => { body.schema_version = '2.0'; },
      (body) => { body.raw_snapshot.schema_version = '2.0'; },
      (body) => { body.raw_snapshot.request_id = randomUUID(); },
      (body) => { body.raw_snapshot.device = null; },
      (body) => { body.raw_snapshot.device = []; },
      (body) => { body.raw_snapshot.device = 'mock-device'; },
      (body) => { body.raw_snapshot.collection = null; },
      (body) => { body.raw_snapshot.collection = []; },
      (body) => { delete body.raw_snapshot.collection; },
      (body) => { body.raw_snapshot.collection.profile = 'inspection'; },
      (body) => { body.raw_snapshot.collection.status = 'unknown'; },
      (body) => { body.raw_snapshot.collection.finished_at = 'bad-time'; },
      (body) => { body.raw_snapshot.collection.finished_at = '2026-02-31T12:34:56Z'; },
      (body) => { body.raw_snapshot.collection.finished_at = '2026-11-01T24:00:00Z'; },
      (body) => { body.raw_snapshot.collection.finished_at = '2026-11-01T12:34:56'; },
      (body) => { body.raw_snapshot.collection.finished_at = 1793536496200; },
      (body) => { delete body.raw_snapshot.collection.finished_at; },
      (body) => { body.raw_snapshot.collected_at = body.raw_snapshot.collection.finished_at; delete body.raw_snapshot.collection.finished_at; },
      (body) => { delete body.raw_snapshot.capabilities; },
      (body) => { body.raw_snapshot.capabilities = null; },
      (body) => { body.raw_snapshot.capabilities = []; },
      (body) => { body.raw_snapshot.capabilities = true; },
      (body) => { delete body.raw_snapshot.capabilities.read_only; },
      (body) => { body.raw_snapshot.capabilities.read_only = false; },
      (body) => { body.raw_snapshot.capabilities.read_only = 'true'; },
      (body) => { body.raw_snapshot.capabilities.read_only = 1; },
      (body) => { body.raw_snapshot.collector.name = 'shell'; },
      (body) => { body.raw_snapshot.collector.permissions = { status: 'unknown' }; },
      (body) => { body.raw_snapshot.resources = []; },
      (body) => { body.raw_snapshot.configuration = null; },
      (body) => { delete body.raw_snapshot.diagnostics; },
      (body) => { delete body.raw_snapshot.collector; },
      (body) => { delete body.raw_snapshot.device; },
      (body) => { body.parameters = []; },
      (body) => { body.parameters.hasGpu = 'false'; },
      (body) => { body.parameters.command = 'not allowed'; },
      (body) => { body.operation = 'exec'; },
    ];
    for (const invalidate of invalidators) {
      const body = payload('snapshot', {}, deviceId);
      invalidate(body);
      await rejected(api, body);
    }
    for (const text of ['{', '[]', 'null', '"string"']) await rejected(api, undefined, 400, 'invalid_request', { text });
    await rejected(api, undefined, 400, 'invalid_request', { text: Buffer.from([0xff]) });
    const duplicate = payload('snapshot', {}, deviceId);
    await rejected(api, undefined, 400, 'invalid_request', { text: JSON.stringify(duplicate).replace('{', '{"operation":"exec",') });
    for (const route of ['/openapi/v1/devices/bad/snapshot', '/openapi/v1/tasks/bad']) assert.equal((await exchange(api, route)).status, 400);
    const failed = payload('snapshot', {}, deviceId);
    failed.raw_snapshot.collection.status = 'error';
    const error = await rejected(api, failed, 503, 'collection_failed');
    assert.equal(error.request_id, failed.request_id);
    assert.deepEqual((await snapshot(api, deviceId)).json, seed);
    const inspect = payload('inspect', { revision: 1 }, deviceId);
    inspect.raw_snapshot.collection.profile = 'resources';
    await rejected(api, inspect);
    const inspection = payload('inspect', { revision: seed.state.revision }, deviceId);
    inspection.raw_snapshot.collection.profile = 'configuration';
    await rejected(api, inspection);
    assert.deepEqual((await snapshot(api, deviceId)).json, seed);
  });
});

test('media type, compression, exact raw 8 MiB and request 10 MiB limits including internal raw whitespace', async () => {
  await withServer(async (api) => {
    await rejected(api, payload(), 415, 'unsupported_media_type', { headers: { 'Content-Type': 'text/plain' } });
    await rejected(api, payload(), 415, 'unsupported_media_type', { headers: { 'Content-Encoding': 'gzip' } });
    const boundary = payload();
    boundary.raw_snapshot.resources.padding = '';
    boundary.raw_snapshot.resources.padding = 'a'.repeat(8 * MiB - Buffer.byteLength(JSON.stringify(boundary.raw_snapshot)));
    const accepted = await success(api, boundary);
    assert.equal(accepted.receipt.raw_bytes, 8 * MiB);
    boundary.request_id = randomUUID();
    boundary.raw_snapshot.request_id = boundary.request_id;
    boundary.raw_snapshot.resources.padding += 'a';
    await rejected(api, boundary, 413, 'raw_snapshot_too_large');
    const spaced = payload();
    let text = JSON.stringify(spaced);
    const rawText = JSON.stringify(spaced.raw_snapshot);
    text = text.replace(rawText, `{${' '.repeat(8 * MiB)}${rawText.slice(1)}`);
    await rejected(api, undefined, 413, 'raw_snapshot_too_large', { text });
    const exactRequest = payload();
    text = JSON.stringify(exactRequest);
    text += ' '.repeat(10 * MiB - Buffer.byteLength(text));
    assert.equal(Buffer.byteLength(text), 10 * MiB);
    const exact = await post(api, undefined, { text, headers: { 'Content-Length': Buffer.byteLength(text) } });
    assert.equal(exact.status, 200);
    await rejected(api, undefined, 413, 'request_too_large', { text: `${text} `, headers: { 'Content-Length': 10 * MiB + 1 } });
    await rejected(api, undefined, 413, 'request_too_large', { text: `${text} `, headers: { 'Transfer-Encoding': 'chunked' } });
    const unicode = payload();
    unicode.raw_snapshot.resources.label = '汉字𠀀';
    const result = await success(api, unicode);
    assert.equal(result.receipt.raw_bytes, Buffer.byteLength(JSON.stringify(unicode.raw_snapshot)));
  });
});

test('revision validation precedes read_only, which precedes action IDs and raw interpretation, without committing state', async () => {
  await withServer(async (api) => {
    const seed = await success(api, payload());
    const deviceId = seed.receipt.device.id;
    const writes = ['cleanup', 'optimize', 'sessions-cleanup', 'alert-sample'];
    for (const operation of ['inspect', ...writes]) {
      for (const revision of [undefined, 0, -1, 1.5, '1', null]) {
        await rejected(api, payload(operation, revision === undefined ? {} : { revision }, deviceId));
      }
    }
    for (const operation of writes) {
      for (const raw of [null, {}, 'private-raw-command', { collection: { status: 'error' } }]) {
        const body = payload(operation, { revision: 999, resource: 'bad', ids: ['protected'] }, deviceId);
        body.raw_snapshot = raw;
        await rejected(api, body, 409, 'revision_conflict');
        body.parameters.revision = 1;
        const error = await rejected(api, body, 409, 'read_only');
        assert(!JSON.stringify(error).includes('private-raw-command'));
        assert.deepEqual((await snapshot(api, deviceId)).json, seed);
        assert.equal((await exchange(api, `/openapi/v1/tasks/${seed.task_id}`)).json.task.simulated, false);
      }
      // Even missing, duplicate, protected, stale-demo or arbitrary IDs cannot turn writes into invalid-request/collection failures.
      for (const ids of [undefined, [], ['process-101-10'], ['cpu-0'], ['unknown'], ['cpu-2', 'cpu-2']]) {
        await rejected(api, payload(operation, { revision: 1, ids }, deviceId), 409, 'read_only');
      }
    }
    for (const operation of ['snapshot', 'reset', 'inspect']) {
      const body = payload(operation, { revision: 999 }, deviceId);
      body.raw_snapshot = null;
      await rejected(api, body, 409, 'revision_conflict');
    }
    assert.deepEqual((await snapshot(api, deviceId)).json, seed);
    // Rejected requests are not cached or committed: the same ID can be corrected into a collection.
    const repair = payload('cleanup', { revision: 1 }, deviceId);
    await rejected(api, repair, 409, 'read_only');
    repair.operation = 'snapshot';
    repair.parameters = {};
    const next = await success(api, repair);
    assert.equal(next.state.revision, 2);
    realRows(next.state);
  });
});

test('session cleanup cannot act on active, cross-Agent, cross-scope, duplicate, missing or formerly valid demo sessions', async () => {
  await withServer(async (api) => {
    const seed = await success(api, payload());
    const deviceId = seed.receipt.device.id;
    for (const [resource, agentId, sessionIds] of [
      ['cpu', 'agent-logs', ['agent-logs-session-1']],
      ['cpu', 'agent-logs', ['agent-coding-session-2']],
      ['cpu', 'unknown', ['agent-logs-session-2']],
      ['cpu', 'agent-logs', ['unknown']],
      ['cpu', 'agent-logs', []],
      ['cpu', 'agent-logs', ['agent-logs-session-2', 'agent-logs-session-2']],
      ['cpu', 'agent-logs', ['agent-logs-disk-2']],
      ['disk', 'agent-logs', ['agent-logs-session-2']],
      ['unknown', 'agent-logs', ['agent-logs-session-2']],
      ['cpu', 'agent-logs', ['agent-logs-session-2', 'agent-logs-session-3']],
      ['disk', 'agent-coding', ['agent-coding-disk-2']],
    ]) {
      const body = payload('sessions-cleanup', { revision: 1, resource, agentId, sessionIds }, deviceId);
      await rejected(api, body, 409, 'read_only');
      assert.deepEqual((await snapshot(api, deviceId)).json, seed);
    }
    realRows(seed.state);
  });
});

test('GPU presence follows evidence, inspections survive resources refresh, reset clears diagnostics without revision regression', async () => {
  await withServer(async (api) => {
    const body = payload('snapshot', { hasGpu: false });
    let current = await success(api, body);
    assert.equal(current.state.hasGpu, true, 'valid GPU evidence overrides the obsolete demo hint');
    const inspectBody = payload('inspect', { revision: 1 }, body.device_id);
    current = await success(api, inspectBody);
    assert.deepEqual(current.state, parsed(inspectBody, parsed(body)));
    assert.equal(current.state.revision, 2);
    assert.equal(inspection(current.state, 'root').status, 'abnormal');
    assert.equal(inspection(current.state, 'fd').status, 'abnormal');
    assert.equal(inspection(current.state, 'memory').status, 'normal');
    const records = structuredClone(current.state.inspections);
    const history = structuredClone(current.state.operations);
    const fresh = payload('snapshot', { hasGpu: true, revision: 2 }, body.device_id);
    fresh.raw_snapshot.resources.gpu.content = '';
    fresh.raw_snapshot.resources.meminfo.content = 'MemTotal: 1000 kB\nMemAvailable: 900 kB\n';
    fresh.raw_snapshot.collection.finished_at = '2026-11-01T12:35:56Z';
    current = await success(api, fresh);
    assert.equal(current.state.revision, 3);
    assert.equal(current.state.hasGpu, false, 'empty successful CSV confirms absence, irrespective of hint');
    assert.equal(current.state.resources.memory.usage, 10);
    assert.deepEqual(current.state.inspections, records);
    assert.deepEqual(current.state.operations, history);
    for (const [target, usage] of [['gpu', 96], ['cpu', 90], ['disk', 96], ['cpu', 80], ['energy', 96], ['memory', 80], ['root', 96], ['fd', 80]]) {
      await rejected(api, payload('alert-sample', { revision: 3, target, usage }, body.device_id), 409, 'read_only');
      assert.deepEqual((await snapshot(api, body.device_id)).json, current);
    }
    const reset = payload('reset', { revision: 3, hasGpu: false }, body.device_id);
    delete reset.raw_snapshot.resources.gpu;
    const cleared = await success(api, reset);
    assert.equal(cleared.state.revision, 4);
    assert.equal(cleared.state.hasGpu, true, 'missing GPU remains visible as unknown');
    assert.equal(cleared.state.resources.gpu.usage, null);
    assert(cleared.state.inspections.every((item) => item.status === 'unchecked' && item.usage === null));
    assert.deepEqual(cleared.state.operations, []);
    await rejected(api, payload('inspect', { revision: 3 }, body.device_id), 409, 'revision_conflict');
    const again = await success(api, payload('reset', {}, body.device_id));
    assert.equal(again.state.revision, 5);
    assert.equal(again.state.hasGpu, true);
  });
});

test('rejected writes on unknown devices never allocate snapshots, tasks or capacity', async () => {
  await withServer(async (api) => {
    for (let index = 0; index < 36; index++) {
      const body = payload(['cleanup', 'optimize', 'sessions-cleanup', 'alert-sample'][index % 4], { revision: 1 });
      body.raw_snapshot = null;
      await rejected(api, body, 409, 'read_only');
      assert.equal((await snapshot(api, body.device_id)).status, 404);
    }
    const initial = await success(api, payload());
    assert.equal(initial.state.revision, 1);
  });
});

test('first inspect accepts revision 1 without a prior snapshot and commits revision 2', async () => {
  await withServer(async (api) => {
    const body = payload('inspect', { revision: 1 });
    const first = await success(api, body);
    assert.deepEqual(first.state, parsed(body));
    assert.equal(first.state.revision, 2);
    assert.equal(first.state.operations.length, 1);
    assert.equal(first.state.operations[0].revision, 2);
    assert.deepEqual((await snapshot(api, body.device_id)).json, first);
  });
});

test('identical concurrent request IDs replay one immutable response; changed payload conflicts and replay never rolls back latest state', async () => {
  await withServer(async (api) => {
    const seed = await success(api, payload());
    const deviceId = seed.receipt.device.id;
    const body = payload('inspect', { revision: 1 }, deviceId);
    const responses = await Promise.all([post(api, body), post(api, body)]);
    assert(responses.every((result) => result.status === 200));
    assert.deepEqual(responses[0].json, responses[1].json);
    assert.equal(responses[0].json.state.revision, 2);
    assert.equal(responses[0].json.state.operations.length, 1);
    const changed = structuredClone(body);
    changed.raw_snapshot.diagnostics.memgraph.content.graph.avaliable = 10;
    await rejected(api, changed, 409, 'idempotency_conflict');
    changed.schema_version = '2.0';
    changed.operation = 'exec';
    await rejected(api, changed, 409, 'idempotency_conflict');
    await rejected(api, undefined, 409, 'idempotency_conflict', { text: JSON.stringify(body, null, 2) });
    const later = await success(api, payload('inspect', { revision: 2 }, deviceId));
    assert.deepEqual((await post(api, body)).json, responses[0].json);
    assert.deepEqual((await snapshot(api, deviceId)).json, later);
    assert.equal((await exchange(api, `/openapi/v1/tasks/${responses[0].json.task_id}`)).status, 200);
    const secondDevice = await success(api, payload());
    assert.equal(secondDevice.state.revision, 1);
    assert.deepEqual(secondDevice.state.resources, seed.state.resources);
    assert.deepEqual((await snapshot(api, deviceId)).json, later);
  });
});

test('different simultaneous inspections cannot both commit the same revision; inspect history is capped at 30', async () => {
  await withServer(async (api) => {
    const seed = await success(api, payload());
    const deviceId = seed.receipt.device.id;
    const responses = await Promise.all([post(api, payload('inspect', { revision: 1 }, deviceId)), post(api, payload('inspect', { revision: 1 }, deviceId))]);
    assert.deepEqual(responses.map((result) => result.status).sort(), [200, 409]);
    let current = responses.find((result) => result.status === 200).json;
    for (let index = 0; index < 35; index++) current = await success(api, payload('inspect', { revision: current.state.revision }, deviceId));
    assert.equal(current.state.operations.length, 30);
    assert.equal(current.state.revision, 37);
  });
});

test('unknown operations and opaque raw command strings never execute shell commands or leak private evidence', async () => {
  const childProcess = require('node:child_process');
  const methods = ['exec', 'execSync', 'execFile', 'execFileSync', 'spawn', 'spawnSync', 'fork'];
  const saved = Object.fromEntries(methods.map((method) => [method, childProcess[method]]));
  let executions = 0;
  for (const method of methods) childProcess[method] = () => { executions++; throw new Error('Forbidden command invocation'); };
  const marker = path.join(temporary, 'must-not-exist');
  try {
    await withServer(async (api) => {
      const seed = await success(api, payload());
      const deviceId = seed.receipt.device.id;
      for (const operation of ['exec', '__proto__', 'constructor', `snapshot; touch ${marker}`]) {
        const body = payload(operation, { revision: 1 }, deviceId);
        body.raw_snapshot.resources.command = `touch ${marker}`;
        await rejected(api, body);
      }
      assert.deepEqual((await snapshot(api, deviceId)).json, seed);
      const body = payload('snapshot', {}, deviceId);
      body.raw_snapshot.diagnostics.command = `touch ${marker}`;
      const safe = await success(api, body);
      assert(!JSON.stringify(safe).includes(marker));
      assert(!JSON.stringify(safe).includes(token));
      assert.deepEqual(safe.state, parsed(body, seed.state));
      assert.equal(safe.state.revision, 2);
      assert.equal(executions, 0);
      assert.equal(fs.existsSync(marker), false);
    });
  } finally { Object.assign(childProcess, saved); }
});

test('32-device capacity refuses new state without evicting existing devices', async () => {
  await withServer(async (api) => {
    const devices = [];
    for (let index = 0; index < 32; index++) devices.push(await success(api, payload()));
    const body = payload();
    await rejected(api, body, 503, 'device_capacity');
    assert.equal((await snapshot(api, body.device_id)).status, 404);
    for (const device of devices) assert.deepEqual((await snapshot(api, device.receipt.device.id)).json, device);
    const known = devices[0].receipt.device.id;
    const changed = await success(api, payload('inspect', { revision: 1 }, known));
    assert.equal(changed.state.revision, 2);
  });
});

test('task/replay cache is FIFO bounded to 100; replay access does not refresh retention and evicted stale inspection cannot run twice', async () => {
  await withServer(async (api) => {
    const seed = await success(api, payload());
    const deviceId = seed.receipt.device.id;
    const inspect = payload('inspect', { revision: 1 }, deviceId);
    const inspected = await success(api, inspect);
    const tasks = [];
    for (let index = 0; index < 98; index++) tasks.push(await success(api, payload('snapshot', {}, deviceId)));
    assert.deepEqual((await post(api, inspect)).json, inspected);
    for (let index = 98; index < 105; index++) tasks.push(await success(api, payload('snapshot', {}, deviceId)));
    assert.equal((await exchange(api, `/openapi/v1/tasks/${seed.task_id}`)).status, 404);
    assert.equal((await exchange(api, `/openapi/v1/tasks/${inspected.task_id}`)).status, 404);
    for (let index = 0; index < tasks.length; index++) {
      assert.equal((await exchange(api, `/openapi/v1/tasks/${tasks[index].task_id}`)).status, index < 5 ? 404 : 200);
    }
    await rejected(api, inspect, 409, 'revision_conflict');
    const latest = await snapshot(api, deviceId);
    assert.deepEqual(latest.json, tasks.at(-1));
    assert.equal(latest.json.state.revision, 107);
    assert.equal(latest.json.state.operations.length, 1);
    realRows(latest.json.state);
  });
});

test('actual parser computes eight-counter CPU delta, MemAvailable bytes, root statvfs, package watts and PID-paired rankings', () => {
  const body = payload();
  const state = parsed(body);
  assert.equal(state.revision, 1);
  assert.equal(state.sampledAt, body.raw_snapshot.collection.finished_at);
  assert.equal(state.resources.cpu.usage, 60); // Eight counters: busy 90 / total 150; guest fields are NOT added again.
  assert.equal(state.resources.memory.usage, 75);
  assert.deepEqual(state.resources.memory.quantity, { value: 768000, unit: 'B', total: 1024000, available: 256000 });
  assert.equal(state.resources.disk.usage, 80);
  assert.deepEqual(state.resources.disk.quantity, { value: 3276800, unit: 'B', total: 4096000, available: 614400 });
  assert.equal(state.resources.disk.rankUnit, 'B/s');
  assert.equal(state.resources.energy.usage, null);
  assert.equal(state.resources.energy.unit, 'W');
  assert.deepEqual(state.resources.energy.quantity, { value: 13, unit: 'W' });
  assert.deepEqual(state.resources.energy.rows.map((row) => row.quantity), [{ value: 10, unit: 'W' }, { value: 3, unit: 'W' }]);
  assert.equal(state.hasGpu, true);
  assert.equal(state.resources.gpu.usage, 70);
  assert.deepEqual(state.resources.gpu.rows.map((row) => row.usage), [70, 40]);
  assert.deepEqual(state.resources.gpu.quantity, { value: 3072 * MiB, unit: 'B', total: 12288 * MiB, available: 9216 * MiB });
  assert.deepEqual(state.resources.cpu.rows.map((row) => [row.id, row.pid, row.usage]), [['process-101-10', 101, 12.5], ['process-202-20', 202, 10]]);
  assert.deepEqual(state.resources.memory.rows.map((row) => [row.pid, row.usage, row.quantity]),
    [[101, 25, { value: 256000, unit: 'B' }], [202, 12.5, { value: 128000, unit: 'B' }]]);
  assert.deepEqual(state.resources.disk.rows.map((row) => [row.pid, row.usage, row.quantity]),
    [[101, 4000, { value: 4000, unit: 'B/s' }], [202, 4000, { value: 4000, unit: 'B/s' }]]);
  assert(state.inspections.every((item) => item.status === 'unchecked' && item.usage === null));
  assert.deepEqual(state.operations, []);
  realRows(state);
  const guestOnly = payload();
  guestOnly.raw_snapshot.resources.cpu[1].content = 'cpu 140 30 50 450 60 10 10 20 99999999 99999999\n';
  assert.equal(parsed(guestOnly).resources.cpu.usage, 60);
});

test('missing, denied and malformed evidence stays unknown, never filled from demo or direct usage/present shortcuts', async (t) => {
  for (const status of ['missing', 'unavailable', 'permission_denied', 'error', 'timeout']) await t.test(status, () => {
    const body = payload('snapshot', { hasGpu: false });
    body.raw_snapshot.resources = status === 'missing' ? {} : Object.fromEntries(
      Object.keys(body.raw_snapshot.resources).map((key) => [key, evidence('private-invalid-output', 'private-source', status)]));
    const state = parsed(body);
    allUnknown(state);
    assert.equal(state.hasGpu, true);
    assert(!JSON.stringify(state).includes('private-invalid-output'));
    assert(!JSON.stringify(state).includes('private-source'));
  });
  const body = payload();
  body.raw_snapshot.resources = { cpu: { usage: 99 }, memory: { usage: 99 }, disk: { usage: 99 },
    gpu: { present: false, usage: 99 }, energy: { watts: 999 }, processes: { content: 'private proc output' } };
  allUnknown(parsed(body));
  assert.equal(parsed(body).hasGpu, true);
});

test('CPU evidence rejects resets, zero delta, incomplete eight counters, invalid types and nonaggregate rows', async (t) => {
  const cases = [
    ['counter reset', (r) => { r.cpu[1].content = 'cpu 99 30 50 450 60 10 10 20\n'; }],
    ['zero delta', (r) => { r.cpu[1] = structuredClone(r.cpu[0]); }],
    ['only four counters', (r) => { r.cpu = [evidence('cpu 1 0 0 99\n'), evidence('cpu 2 0 0 198\n')]; }],
    ['negative', (r) => { r.cpu[1].content = 'cpu -1 30 50 450 60 10 10 20\n'; }],
    ['NaN', (r) => { r.cpu[1].content = 'cpu NaN 30 50 450 60 10 10 20\n'; }],
    ['infinity', (r) => { r.cpu[1].content = 'cpu Infinity 30 50 450 60 10 10 20\n'; }],
    ['nontext', (r) => { r.cpu[1].content = { usage: 90 }; }],
    ['single sample', (r) => { r.cpu.pop(); }],
    ['only per core', (r) => { r.cpu[1].content = 'cpu0 140 30 50 450 60 10 10 20\n'; }],
    ['failed second sample', (r) => { r.cpu[1].status = 'error'; }],
    ['nonfinite total delta', (r) => {
      r.cpu[0].content = 'cpu 0 0 0 0 0 0 0 0\n';
      r.cpu[1].content = `cpu ${Array(8).fill(Number.MAX_VALUE).join(' ')}\n`;
    }],
  ];
  for (const [name, mutate] of cases) await t.test(name, () => {
    const body = payload();
    mutate(body.raw_snapshot.resources);
    const cpu = parsed(body).resources.cpu;
    assert.equal(cpu.usage, null);
    assert.equal(cpu.status, 'unavailable');
  });
});

test('MemAvailable and statvfs validation are independent of process throughput and reject impossible capacities', async (t) => {
  const cases = [
    ['memory missing available', 'memory', (r) => { r.meminfo.content = 'MemTotal: 1000 kB\nMemFree: 100 kB\n'; }],
    ['memory zero total', 'memory', (r) => { r.meminfo.content = 'MemTotal: 0 kB\nMemAvailable: 0 kB\n'; }],
    ['memory over total', 'memory', (r) => { r.meminfo.content = 'MemTotal: 1000 kB\nMemAvailable: 1001 kB\n'; }],
    ['memory wrong units', 'memory', (r) => { r.meminfo.content = 'MemTotal: 1000 MB\nMemAvailable: 250 MB\n'; }],
    ['memory malformed', 'memory', (r) => { r.meminfo.content = 'MemTotal: NaN kB\nMemAvailable: 250 kB\n'; }],
    ['disk zero block size', 'disk', (r) => { r.root_filesystem.content.f_frsize = 0; }],
    ['disk zero capacity', 'disk', (r) => { r.root_filesystem.content.f_blocks = 0; }],
    ['disk free above total', 'disk', (r) => { r.root_filesystem.content.f_bfree = 1001; }],
    ['disk available above free', 'disk', (r) => { r.root_filesystem.content.f_bavail = 201; }],
    ['disk negative', 'disk', (r) => { r.root_filesystem.content.f_bavail = -1; }],
    ['disk string counter', 'disk', (r) => { r.root_filesystem.content.f_blocks = '1000'; }],
    ['disk nonfinite multiplication', 'disk', (r) => { r.root_filesystem.content.f_frsize = Number.MAX_VALUE; }],
  ];
  for (const [name, id, mutate] of cases) await t.test(name, () => {
    const body = payload();
    mutate(body.raw_snapshot.resources);
    const resource = parsed(body).resources[id];
    assert.equal(resource.usage, null);
    assert.equal(resource.quantity, undefined);
  });
  const body = payload();
  delete body.raw_snapshot.resources.root_filesystem;
  const state = parsed(body);
  assert.equal(state.resources.disk.usage, null);
  assert.equal(state.resources.disk.quantity, undefined);
  assert.equal(state.resources.disk.rows[0].quantity.value, 4000);
  const noIo = payload();
  delete noIo.raw_snapshot.resources.processes;
  const capacityOnly = parsed(noIo).resources.disk;
  assert.equal(capacityOnly.usage, 80);
  assert.deepEqual(capacityOnly.rows, []);
});

test('GPU missing/failed is visible unknown, only empty successful CSV proves absence, and malformed fields are not demo percentages', async (t) => {
  const cases = [
    ['empty success', evidence(''), false, null, 0],
    ['whitespace success', evidence(' \n'), false, null, 0],
    ['empty error', evidence('', 'gpu', 'error'), true, null, 0],
    ['empty partial', evidence('', 'gpu', 'partial'), true, null, 0],
    ['missing', undefined, true, null, 0],
    ['malformed CSV', evidence('private garbage'), true, null, 0],
    ['unknown utilization', evidence('Fixture, GPU-a, N/A, 8192, 0, N/A, N/A'), true, null, 0],
    ['over 100 utilization', evidence('Fixture, GPU-a, 101, 8192, 0, 10, 30'), true, null, 0],
    ['negative utilization', evidence('Fixture, GPU-a, -1, 8192, 0, 10, 30'), true, null, 0],
    ['partial valid', evidence('Fixture, GPU-a, 25, N/A, N/A, N/A, N/A', 'gpu', 'partial'), true, 25, 1],
    ['valid zero', evidence('Fixture, GPU-a, 0, 8192, 0, 10, 30'), true, 0, 1],
  ];
  for (const [name, gpu, present, usage, rows] of cases) await t.test(name, () => {
    const body = payload('snapshot', { hasGpu: !present });
    body.raw_snapshot.resources.gpu = gpu;
    const state = parsed(body);
    assert.equal(state.hasGpu, present);
    assert.equal(state.resources.gpu.usage, usage);
    assert.equal(state.resources.gpu.rows.length, rows);
    assert(!JSON.stringify(state).includes('private garbage'));
    realRows(state);
  });
});

function gpuSnapshot(devices = [gpuDevice()], overrides = {}) {
  return { schema_version: '1.0', tool: 'idc', mode: 'idc', read_only: true, status: 'ok', available: true, gpu_count: devices.length, devices, ...overrides };
}
function gpuDevice(overrides = {}) {
  return { index: 0, name: 'Fixture GPU', uuid: 'GPU-fixture', bus_id: '0000:00:00.0', util: '0', mem_util_pct: '0', mem_used: '1217', mem_total: '81920', temp: '26', power_draw: '68.65', power_limit: '400', ecc_corr: '0', ecc_uncorr: '0', pcie_gen_max: '4', pcie_gen_cur: '1', pcie_width: '16', ...overrides };
}
function gpuReport(overrides = {}) {
  return { schema_version: '1.0', tool: 'ai', mode: 'native', read_only: false, status: 'ok', gpu_count: 1, gpu_arch: ['Fixture architecture'], gpu_devices: ['Fixture GPU'], details: [{ check: 'ECC', severity: 'OK', message: 'No errors reported' }], coverage: { complete: true, reason: '' }, ...overrides };
}

test('structured GPU snapshots preserve zero and physical units without fabricated missing metrics', async () => withServer(async (api) => {
  const body = payload();
  body.raw_snapshot.resources.gpu = evidence(gpuSnapshot([gpuDevice(), gpuDevice({ index: 1, uuid: 'GPU-second', util: 'N/A', mem_used: '1', temp: 'N/A', ecc_uncorr: 'N/A' })]));
  const { state } = await success(api, body);
  assert.equal(state.hasGpu, true);
  assert.equal(state.resources.gpu.usage, 0);
  assert.equal(state.resources.gpu.status, 'partial');
  assert.equal(state.resources.gpu.rows.length, 1);
  assert.equal(state.resources.gpu.quantity.total, 163840 * MiB);
  assert.equal(state.resources.gpu.quantity.value, 1218 * MiB);
  const [first, second] = state.resources.gpu.gpuDevices;
  assert.equal(first.powerWatts, 68.65);
  assert.equal(first.eccUncorrected, 0);
  assert.equal(second.utilization, null);
  assert.equal(second.temperatureCelsius, null);
  assert.equal(second.eccUncorrected, null);
  assert.equal(state.gpuDiagnostic.status, 'not_run');
  assert.match(state.resources.gpu.note, /IDC 按需 nvidia-smi/);
  realRows(state);
}));

test('structured GPU absence requires complete success and invalid devices cannot become metrics', async (t) => {
  const cases = [
    ['confirmed absent', gpuSnapshot([]), 'ok', false],
    ['partial empty', gpuSnapshot([]), 'partial', true],
    ['unavailable', gpuSnapshot([], { status: 'unavailable', available: false }), 'ok', true],
    ['inconsistent count', gpuSnapshot([], { gpu_count: 1 }), 'ok', true],
    ['invalid identity', gpuSnapshot([gpuDevice({ index: -1 })]), 'ok', true],
    ['invalid protocol', gpuSnapshot([], { read_only: false }), 'ok', true],
    ['old light_inspect tool', gpuSnapshot([], { tool: 'light_inspect' }), 'ok', true],
    ['AI tool is not an IDC resource report', gpuSnapshot([], { tool: 'ai' }), 'ok', true],
    ['wrong mode', gpuSnapshot([], { mode: 'native' }), 'ok', true],
    ['wrong schema', gpuSnapshot([], { schema_version: '2.0' }), 'ok', true],
  ];
  for (const [name, raw, status, present] of cases) await t.test(name, () => {
    const body = payload();
    body.raw_snapshot.resources.gpu = evidence(raw, 'fixture', status);
    const state = parsed(body);
    assert.equal(state.hasGpu, present);
    assert.equal(state.resources.gpu.usage, null);
    matches(spec.components.schemas.HealthState, state);
  });
  const body = payload();
  body.raw_snapshot.resources.gpu = evidence(gpuSnapshot([gpuDevice({ util: '101', mem_used: '90000', power_draw: '-1' }), gpuDevice({ uuid: 'duplicate' })]));
  const state = parsed(body);
  assert.equal(state.resources.gpu.gpuDevices.length, 1);
  assert.equal(state.resources.gpu.gpuDevices[0].utilization, null);
  assert.equal(state.resources.gpu.gpuDevices[0].memoryUsedBytes, null);
  assert.equal(state.resources.gpu.gpuDevices[0].powerWatts, null);
  assert.equal(state.resources.gpu.quantity, undefined);
});

test('ai coverage and findings determine actual outcome, never fabricate a healthy result', async (t) => {
  const cases = [
    ['complete healthy', gpuReport(), 'ok', 'normal', 'ok', true],
    ['warning exit', gpuReport({ details: [{ check: 'ECC', severity: 'WARN', message: 'Corrected error observed', suggestion: 'Recheck hardware' }] }), 'ok', 'abnormal', 'ok', true],
    ['partial error', gpuReport({ status: 'partial', coverage: { complete: false, reason: 'missing tool' }, details: [{ check: 'XID', severity: 'ERROR', message: 'XID observed' }] }), 'partial', 'abnormal', 'partial', false],
    ['partial checks', gpuReport({ coverage: { complete: false, reason: 'permission denied' } }), 'ok', 'unknown', 'partial', false],
    ['coverage warning only', gpuReport({ status: 'partial', details: [{ check: 'coverage', severity: 'WARN', message: 'required tool missing' }], coverage: { complete: false, reason: 'required tool missing' } }), 'partial', 'unknown', 'partial', false],
    ['timeout with observed error', gpuReport({ status: 'timeout', details: [{ check: 'ECC', severity: 'ERROR', message: 'Uncorrected error observed' }], coverage: { complete: false, reason: 'deadline' } }), 'timeout', 'abnormal', 'timeout', false],
    ['missing count', gpuReport({ gpu_count: null }), 'ok', 'unknown', 'partial', false],
    ['missing findings', gpuReport({ details: [] }), 'ok', 'unknown', 'partial', false],
    ['missing device metadata', gpuReport({ gpu_devices: undefined }), 'ok', 'unknown', 'partial', false],
    ['inner timeout', gpuReport({ status: 'timeout', coverage: { complete: false, reason: 'deadline' } }), 'partial', 'unknown', 'timeout', false],
    ['invalid findings', gpuReport({ details: [{ check: 'invalid', severity: 'HEALTHY', message: 'private invalid' }] }), 'ok', 'unknown', 'partial', false],
    ['timeout', undefined, 'timeout', 'unknown', 'timeout', false],
    ['unavailable', undefined, 'unavailable', 'unknown', 'unavailable', false],
    ['malformed', { private: 'private garbage' }, 'ok', 'unknown', 'error', false],
    ['obsolete AI IDC metadata', gpuReport({ mode: 'idc', read_only: true }), 'ok', 'unknown', 'error', false],
    ['native falsely read-only', gpuReport({ read_only: true }), 'ok', 'unknown', 'error', false],
    ['IDC falsely native write flag', gpuReport({ mode: 'idc' }), 'ok', 'unknown', 'error', false],
    ['contradictory absence', gpuReport({ gpu_count: 0, gpu_devices: [], gpu_arch: [], details: [] }), 'ok', 'unknown', 'partial', false],
    ['absence', gpuReport({ gpu_count: 0, gpu_devices: [], gpu_arch: [], details: [] }), 'ok', 'no_gpu', 'ok', true],
  ];
  for (const [name, raw, wrapperStatus, outcome, status, complete] of cases) await t.test(name, () => {
    const body = payload('inspect', { revision: 1 });
    body.raw_snapshot.diagnostics.ai = evidence(raw, 'sysak ai', wrapperStatus);
    if (name === 'absence') body.raw_snapshot.resources.gpu = evidence(gpuSnapshot([]));
    const state = parsed(body);
    assert.equal(state.gpuDiagnostic.outcome, outcome);
    assert.equal(state.gpuDiagnostic.status, status);
    assert.equal(state.gpuDiagnostic.complete, complete);
    assert.equal(inspection(state, 'gpu').usage, null);
    assert.equal(inspection(state, 'gpu').status, outcome === 'normal' ? 'normal' : outcome === 'abnormal' ? 'abnormal' : 'unchecked');
    assert(!JSON.stringify(state).includes('private garbage'));
    matches(spec.components.schemas.HealthState, state);
  });
});

function aiMetric(overrides = {}) {
  return { index: 0, name: 'Fixture GPU', uuid: 'GPU-fixture', busId: '0000:01:00.0', utilization: 0, memoryUtilization: 0,
    memoryUsedBytes: 1024, memoryTotalBytes: 8192, temperatureCelsius: 26, powerWatts: 68.65, powerLimitWatts: null,
    eccCorrected: 0, eccUncorrected: null, pcieGeneration: 1, pcieMaxGeneration: 4, pcieWidth: 16, ...overrides };
}
function aiProcess(overrides = {}) {
  return { pid: 101, starttime: 100, name: 'python', state: 'S', cpu_percent: 0, rss_bytes: 1024, gpu_indices: [0],
    sm_utilization: 0, memory_utilization: null, status: 'ok', findings: [{ check: 'HANG', severity: 'OK', message: 'No HANG observed' }], ...overrides };
}
function aiJobs(overrides = {}) {
  return { status: 'ok', complete: true, reason: '', sample_window_seconds: 1, processes: [aiProcess()], ...overrides };
}

// These normalized fixtures intentionally model complete evidence, not native coverage.
test('AI normalized metrics and process evidence preserve zero, units, null and exclude private fields', async () => withServer(async (api) => {
  const body = payload('inspect', { revision: 1 });
  body.raw_snapshot.diagnostics.ai = evidence(gpuReport({ gpu_metrics: [aiMetric()], job_analysis: aiJobs({ processes: [aiProcess({ private: 'private-command-line' })] }) }));
  const { state } = await success(api, body);
  assert.equal(state.resources.gpu.usage, 0);
  assert.deepEqual(state.resources.gpu.quantity, { value: 1024, total: 8192, unit: 'B' });
  assert.equal(state.resources.gpu.gpuDevices[0].powerWatts, 68.65);
  assert.equal(state.resources.gpu.gpuDevices[0].eccUncorrected, null);
  assert.equal(state.resources.gpu.status, 'partial');
  const jobs = state.gpuDiagnostic.jobAnalysis;
  assert.equal(jobs.source, 'sysak ai');
  assert.equal(jobs.complete, true);
  assert.equal(jobs.sampleWindowSeconds, 1);
  assert.equal(jobs.processes[0].cpuPercent, 0);
  assert.equal(jobs.processes[0].smUtilization, 0);
  assert.equal(jobs.processes[0].memoryUtilization, null);
  assert.equal(jobs.processes[0].rssBytes, 1024);
  assert(!JSON.stringify(state).includes('private-command-line'));
  matches(spec.components.schemas.HealthState, state);
}));

// IDC-converted native evidence: no device identity, comm, starttime or shared
// sampling window is supplied by the original ai JSON. Do not fill from SMI/proc.
function nativeAiReport(overrides = {}) {
  return gpuReport({ status: 'partial', gpu_count: 2, gpu_arch: [], gpu_devices: [], details: [],
    coverage: { complete: false, reason: 'native coverage unknown; no stable device/process identity or metric window' },
    gpu_metrics: [aiMetric({ name: '', uuid: '', busId: '', utilization: 0 }),
      aiMetric({ index: 1, name: '', uuid: '', busId: '', utilization: 47 })],
    job_analysis: aiJobs({ status: 'partial', complete: false, sample_window_seconds: null,
      reason: 'native process evidence has no starttime/name or shared metric window', processes: [
        aiProcess({ pid: 34001, starttime: null, name: '', state: '', cmd: 'fixture-command --private-argument', cpu_percent: 3.5, rss_bytes: 4096, status: 'partial', findings: [] }),
        aiProcess({ pid: 34002, starttime: null, name: '', state: '', gpu_indices: [0, 1], sm_utilization: null, memory_utilization: null, status: 'partial', findings: [] }),
      ] }), ...overrides });
}

test('native partial AI survives OpenAPI without false health or cross-snapshot identity joins', async () => withServer(async (api) => {
  const body = payload('inspect', { revision: 1 });
  body.raw_snapshot.resources.gpu = evidence(gpuSnapshot([
    gpuDevice({ index: 1, name: 'SMI-other-card', uuid: 'SMI-uuid-1', bus_id: '0000:09:00.0', util: '91' }),
    gpuDevice({ index: 0, name: 'SMI-first-card', uuid: 'SMI-uuid-0', bus_id: '0000:08:00.0', util: '92' }),
  ]));
  body.raw_snapshot.diagnostics.ai = evidence(nativeAiReport(), 'sysak ai', 'partial');
  const { state } = await success(api, body);
  const report = state.gpuDiagnostic;
  assert.equal(report.source, 'sysak ai');
  assert.equal(report.status, 'partial');
  assert.equal(report.outcome, 'unknown');
  assert.equal(report.complete, false);
  assert.equal(report.gpuCount, 2);
  assert.deepEqual(report.architectures, []);
  assert.deepEqual(report.devices, []);
  assert.equal(inspection(state, 'gpu').status, 'unchecked');
  assert.equal(report.jobAnalysis.sampleWindowSeconds, null);
  assert.equal(report.jobAnalysis.status, 'partial');
  assert.equal(report.jobAnalysis.complete, false);
  assert.deepEqual(report.jobAnalysis.processes.map(p => [p.pid, p.starttime, p.name, p.state]), [[34001, null, '', ''], [34002, null, '', '']]);
  assert.doesNotMatch(JSON.stringify(state), /fixture-command|private-argument/);
  assert.equal(report.jobAnalysis.processes[0].cpuPercent, 3.5);
  assert.equal(report.jobAnalysis.processes[0].rssBytes, 4096);
  assert.equal(report.jobAnalysis.processes[0].smUtilization, 0);
  assert.equal(report.jobAnalysis.processes[1].smUtilization, null);
  assert.equal(report.jobAnalysis.processes[1].memoryUtilization, null);
  assert.deepEqual(state.resources.gpu.gpuDevices.map(d => [d.index, d.name, d.uuid, d.busId, d.utilization]), [[0, '', '', '', 0], [1, '', '', '', 47]]);
  assert.equal(state.resources.gpu.usage, 47);
  assert.equal(state.resources.gpu.gpuDevices[0].powerWatts, 68.65);
  assert.equal(state.resources.gpu.gpuDevices[0].temperatureCelsius, 26);
  assert.doesNotMatch(JSON.stringify(state.resources.gpu), /SMI-other-card|SMI-first-card|SMI-uuid|0000:0[89]:00/);
  matches(spec.components.schemas.HealthState, state);
}));

test('empty native NVML is unknown, not zero GPUs; native errors remain partial abnormal evidence', async () => withServer(async (api) => {
  for (const errors of [[], [{ check: 'Xid', severity: 'ERROR', message: 'Observed native Xid 79' }, { check: 'HANG', severity: 'WARN', message: 'Observed native HANG' }]]) {
    const body = payload('inspect', { revision: 1 });
    delete body.raw_snapshot.resources.gpu;
    body.raw_snapshot.diagnostics.ai = evidence(nativeAiReport({ gpu_count: null, gpu_metrics: [], details: errors,
      job_analysis: aiJobs({ status: 'unavailable', complete: false, sample_window_seconds: null, reason: 'native process evidence unavailable', processes: [] }) }), 'sysak ai', 'partial');
    const { state } = await success(api, body);
    assert.equal(state.hasGpu, true);
    assert.equal(state.gpuDiagnostic.gpuCount, null);
    assert.equal(state.gpuDiagnostic.status, 'partial');
    assert.equal(state.gpuDiagnostic.complete, false);
    assert.equal(state.gpuDiagnostic.outcome, errors.length ? 'abnormal' : 'unknown');
    assert.deepEqual(state.gpuDiagnostic.findings, errors);
    assert.equal(state.gpuDiagnostic.jobAnalysis.sampleWindowSeconds, null);
    assert.equal(state.gpuDiagnostic.jobAnalysis.complete, false);
    assert.equal(state.resources.gpu.usage, null);
    matches(spec.components.schemas.HealthState, state);
  }
}));

test('AI execution failures cannot become hardware abnormalities and observed job errors survive timeout', async (t) => {
  for (const check of ['coverage', 'nvml', 'gx', 'driver', 'smi_exists', 'collection', 'pci_inventory']) await t.test(check, () => {
    const body = payload('inspect', { revision: 1 });
    body.raw_snapshot.diagnostics.ai = evidence(gpuReport({ details: [{ check, severity: 'ERROR', message: 'Tool unavailable' }],
      gpu_metrics: [aiMetric()], job_analysis: aiJobs({ status: 'unavailable', complete: false, reason: 'gx_not_installed', processes: [aiProcess({ status: 'not_run', findings: [] })] }) }));
    const state = parsed(body);
    assert.equal(state.gpuDiagnostic.outcome, 'unknown');
    assert.equal(state.gpuDiagnostic.complete, false);
    assert.equal(state.resources.gpu.usage, 0);
    assert.equal(state.gpuDiagnostic.jobAnalysis.status, 'unavailable');
    assert.equal(state.gpuDiagnostic.jobAnalysis.processes[0].status, 'not_run');
  });
  const body = payload('inspect', { revision: 1 });
  body.raw_snapshot.diagnostics.ai = evidence(gpuReport({ status: 'timeout', coverage: { complete: false, reason: 'deadline' },
    details: [{ check: 'XID', severity: 'ERROR', message: 'Observed Xid' }],
    job_analysis: aiJobs({ status: 'timeout', complete: false, processes: [aiProcess({ status: 'partial', findings: [{ check: 'HANG', severity: 'ERROR', message: 'Observed HANG' }] })] }) }), 'sysak ai', 'timeout');
  const state = parsed(body);
  assert.equal(state.gpuDiagnostic.outcome, 'abnormal');
  assert.equal(state.gpuDiagnostic.jobAnalysis.status, 'timeout');
  assert.equal(state.gpuDiagnostic.jobAnalysis.processes[0].findings[0].severity, 'ERROR');
});

test('AI malformed, duplicate, oversized or missing process evidence never fabricates complete coverage', async (t) => {
  for (const [name, overrides] of [
    ['invalid utilization', { sm_utilization: 101 }], ['invalid RSS', { rss_bytes: -1 }],
    ['unsafe starttime', { starttime: Number.MAX_SAFE_INTEGER + 1 }], ['missing CPU', { cpu_percent: undefined }],
    ['duplicate GPU indices', { gpu_indices: [0, 0] }], ['foreign GPU index', { gpu_indices: [2] }],
    ['missing findings', { findings: undefined }], ['invalid findings', { findings: [{ check: 'bad', severity: 'HEALTHY', message: 'bad' }] }],
    ['invalid PID', { pid: 0 }],
  ]) await t.test(name, () => {
    const body = payload('inspect', { revision: 1 });
    body.raw_snapshot.diagnostics.ai = evidence(gpuReport({ job_analysis: aiJobs({ processes: [aiProcess(overrides)] }) }));
    const state = parsed(body);
    assert.equal(state.gpuDiagnostic.jobAnalysis.complete, false);
    assert.equal(state.gpuDiagnostic.jobAnalysis.status, 'partial');
    matches(spec.components.schemas.HealthState, state);
  });
  for (const processes of [[aiProcess(), aiProcess()], Array.from({ length: 129 }, (_, index) => aiProcess({ pid: index + 1 }))]) {
    const body = payload('inspect', { revision: 1 });
    body.raw_snapshot.diagnostics.ai = evidence(gpuReport({ job_analysis: aiJobs({ processes }) }));
    const state = parsed(body);
    assert.equal(state.gpuDiagnostic.jobAnalysis.complete, false);
    assert(state.gpuDiagnostic.jobAnalysis.processes.length <= 128);
  }
});

test('AI inconsistent device count and unsafe byte metrics cannot fabricate capacity or health', () => {
  const body = payload('inspect', { revision: 1 });
  body.raw_snapshot.diagnostics.ai = evidence(gpuReport({ gpu_count: 2, gpu_metrics: [aiMetric({ memoryUsedBytes: 1.5, memoryTotalBytes: Number.MAX_SAFE_INTEGER + 1, utilization: 101 })] }));
  const state = parsed(body);
  assert.equal(state.resources.gpu.usage, null);
  assert.equal(state.resources.gpu.quantity, undefined);
  assert.equal(state.resources.gpu.gpuDevices[0].memoryUsedBytes, null);
  assert.equal(state.resources.gpu.gpuDevices[0].memoryTotalBytes, null);
  assert.equal(state.gpuDiagnostic.outcome, 'unknown');
});

test('OpenAPI preserves last GPU diagnosis across refresh and clears it on reset', async () => withServer(async (api) => {
  const deviceId = randomUUID();
  const initial = await success(api, payload('snapshot', {}, deviceId));
  const body = payload('inspect', { revision: initial.state.revision }, deviceId);
  body.raw_snapshot.resources.gpu = evidence(gpuSnapshot());
  body.raw_snapshot.diagnostics.ai = evidence(gpuReport({ job_analysis: aiJobs() }));
  const diagnosed = await success(api, body);
  assert.equal(diagnosed.state.gpuDiagnostic.outcome, 'normal');
  const refreshed = await success(api, payload('snapshot', {}, deviceId));
  assert.deepEqual(refreshed.state.gpuDiagnostic, diagnosed.state.gpuDiagnostic);
  const reset = await success(api, payload('reset', { revision: refreshed.state.revision }, deviceId));
  assert.equal(reset.state.gpuDiagnostic.status, 'not_run');
}));

test('RAPL uses paired monotonic microjoules, valid range wrap, and excludes overlapping subdomains and duplicate zones', async (t) => {
  const body = payload();
  const samples = body.raw_snapshot.resources.energy_uj.content.samples;
  samples[0].zones = [zone('package-0', 90000000), zone('core', 1000000)];
  samples[1].zones = [zone('package-0', 10000000), zone('core', 9000000), zone('package-0', 10000000)];
  const energy = parsed(body).resources.energy;
  assert.equal(energy.usage, null);
  assert.deepEqual(energy.quantity, { value: 10, unit: 'W' });
  assert.equal(energy.rows.length, 1);
  assert.equal(energy.status, 'partial');
  const cases = [
    ['no range for reset', (s) => { s[0].zones[0].energy_uj = 90000000; delete s[1].zones[0].max_energy_range_uj; }],
    ['different ranges', (s) => { s[0].zones[0].energy_uj = 90000000; s[1].zones[0].max_energy_range_uj = 200000000; }],
    ['invalid range boundary', (s) => { s[0].zones[0].energy_uj = 100000000; }],
    ['missing previous', (s) => { s[0].zones = []; }],
    ['zero elapsed', (s) => { s[1].monotonic_seconds = s[0].monotonic_seconds; }],
    ['reverse elapsed', (s) => { s[1].monotonic_seconds = 9; }],
    ['negative energy', (s) => { s[1].zones[0].energy_uj = -1; }],
    ['nonfinite energy', (s) => { s[1].zones[0].energy_uj = Infinity; }],
  ];
  for (const [name, mutate] of cases) await t.test(name, () => {
    const invalid = payload();
    const pair = invalid.raw_snapshot.resources.energy_uj.content.samples;
    pair.forEach((sample) => { sample.zones = sample.zones.slice(0, 1); });
    mutate(pair);
    const resource = parsed(invalid).resources.energy;
    assert.equal(resource.usage, null);
    assert.equal(resource.quantity, undefined);
    assert.deepEqual(resource.rows, []);
  });
});

test('process pairing requires PID plus starttime, elapsed, clock ticks and CPU count; resets and denied IO cannot fabricate rates', async (t) => {
  const cases = [
    ['reused PID', (r, p) => { p.starttime = 999; }, false, false],
    ['CPU summed reset', (r, p) => { p.utime = 1; p.stime = 1; }, false, true],
    ['individual CPU counter reset despite larger sum', (r, p) => { p.stime = 1; }, false, true],
    ['IO reset', (r, p) => { p.io.read_bytes = 0; }, true, false],
    ['denied IO', (r, p) => { p.io_status = 'permission_denied'; }, true, false],
    ['missing ticks', (r) => { delete r.processes.content.clock_ticks; }, false, true],
    ['zero ticks', (r) => { r.processes.content.clock_ticks = 0; }, false, true],
    ['missing CPU count', (r) => { delete r.cpu_count; }, false, true],
    ['zero CPU count', (r) => { r.cpu_count.content = 0; }, false, true],
    ['zero elapsed', (r) => { r.processes.content.samples[1].monotonic_seconds = 10; }, false, false],
    ['reverse elapsed', (r) => { r.processes.content.samples[1].monotonic_seconds = 9; }, false, false],
    ['nonfinite CPU counter', (r, p) => { p.utime = NaN; }, false, true],
  ];
  for (const [name, mutate, cpuExpected, ioExpected] of cases) await t.test(name, () => {
    const body = payload();
    const resources = body.raw_snapshot.resources;
    const process = resources.processes.content.samples[1].processes.find((p) => p.pid === 101);
    mutate(resources, process);
    const state = parsed(body);
    assert.equal(state.resources.cpu.rows.some((row) => row.pid === 101), cpuExpected);
    assert.equal(state.resources.disk.rows.some((row) => row.pid === 101), ioExpected);
    assert.equal(state.resources.memory.rows.find((row) => row.pid === 101).quantity.value, 256000, 'RSS is a current gauge even for a reused PID');
    assert.equal(state.resources.cpu.usage, 60, 'per-process visibility does not replace host CPU');
    assert.equal(state.resources.disk.usage, 80, 'IO is not statvfs capacity');
  });
});

test('process top20 is deterministic descending with PID tie-breaks, partial visibility and byte-valued RSS/IO not clamped to percent', () => {
  const body = payload();
  const resources = body.raw_snapshot.resources;
  resources.processes.status = 'partial';
  resources.processes.content.samples.forEach((sample, index) => {
    sample.processes = Array.from({ length: 25 }, (_, n) => processEvidence(100 + n, 1000 + n,
      index ? (n + 1) * 10 : 0, 0, (n + 1) * 1024, index ? (n + 1) * 10000 : 0, 0)).reverse();
  });
  const state = parsed(body);
  for (const id of ['cpu', 'memory', 'disk']) {
    assert.equal(state.resources[id].rows.length, 20);
    assert.deepEqual(state.resources[id].rows.map((row) => row.pid), Array.from({ length: 20 }, (_, n) => 124 - n));
    assert.match(state.resources[id].note, /部分|权限|截断/);
  }
  assert.equal(state.resources.disk.rows[0].usage, 125000);
  assert.deepEqual(state.resources.disk.rows[0].quantity, { value: 125000, unit: 'B/s' });
  assert.deepEqual(state.resources.memory.rows[0].quantity, { value: 25600, unit: 'B' });
  realRows(state);
});

test('structured IDC root/FD and normalized native memgraph use real capacity without claiming complete plugin coverage', () => {
  const body = payload('inspect', { revision: 1 });
  body.raw_snapshot.configuration.private_evidence = { status: 'ok', content: { private: 'private-configuration-output' } };
  for (const value of Object.values(body.raw_snapshot.diagnostics)) {
    value.private = 'private-raw-field';
    if (value.content && typeof value.content === 'object') value.content.private = 'private-diagnostic-output';
  }
  const state = parsed(body);
  const rootItem = inspection(state, 'root');
  assert.equal(rootItem.usage, 95);
  assert.equal(rootItem.status, 'abnormal');
  assert.match(rootItem.evidence.join('\n'), /resource_anomaly --idc/);
  assert.match(rootItem.evidence.join('\n'), /部分|下界/);
  assert.match(rootItem.evidence.join('\n'), /128 B/);
  const fd = inspection(state, 'fd');
  assert.equal(fd.usage, 95);
  assert.equal(fd.status, 'abnormal', 'partial coverage still establishes a discovered abnormal process');
  assert.match(fd.evidence.join('\n'), /PID 101/);
  const memory = inspection(state, 'memory');
  assert.equal(memory.usage, 90, 'use avaliable, not free or raw used');
  assert.equal(memory.status, 'normal', 'exactly 90% is not abnormal');
  assert.equal(memory.execution, 'partial');
  assert.match(memory.evidence.join('\n'), /sysak memgraph --graph --jsonstdout/);
  assert.match(memory.evidence.join('\n'), /KiB/);
  assert.match(memory.evidence.join('\n'), /native_plugin_coverage_unknown/);
  assert.match(memory.detail, /不能推断完整内存诊断正常/);
  assert.doesNotMatch(memory.detail + memory.evidence.join('\n'), /未启用|--idc|proc-only/);
  for (const id of ['agents', 'logs', 'gpu', 'network', 'io']) assert.equal(inspection(state, id).status, 'unchecked');
  assert(!JSON.stringify(state).includes('private-'));
  realRows(state);
});

test('native graph pressure remains partial for zero/full available, abnormal pressure and large finite counters', () => {
  for (const [total, available, usage, status] of [
    [1000, 0, 100, 'abnormal'], [1000, 1000, 0, 'normal'],
    [1000, 90, 91, 'abnormal'], [Number.MAX_VALUE, Number.MAX_VALUE / 2, 50, 'normal'],
  ]) {
    const body = payload('inspect', { revision: 1 });
    body.raw_snapshot.diagnostics.memgraph.content.graph = { total, avaliable: available };
    const item = inspection(parsed(body), 'memory');
    assert.equal(item.usage, usage);
    assert.equal(item.status, status);
    assert.equal(item.execution, 'partial');
    assert.match(item.detail, /原生插件覆盖未知/);
    assert(!JSON.stringify(item).includes('null'), 'finite input must not overflow the pressure ratio');
  }
});

test('FD execution distinguishes partial pressure from complete visible coverage without claiming leak trends', async (t) => {
  const cases = [
    ['partial low process', false, 80, 85, null, 'unchecked'],
    ['partial at threshold', false, 90, 90, null, 'unchecked'],
    ['partial abnormal process', false, 20, 91, 91, 'abnormal'],
    ['partial abnormal global', false, 95, 20, 95, 'abnormal'],
    ['complete normal', true, 20, 80, 80, 'normal'],
    ['complete at threshold', true, 90, 80, 90, 'normal'],
    ['complete abnormal', true, 20, 91, 91, 'abnormal'],
  ];
  for (const [name, complete, allocated, usage, expected, status] of cases) await t.test(name, () => {
    const body = payload('inspect', { revision: 1 });
    const diagnostic = body.raw_snapshot.diagnostics.resource_anomaly;
    diagnostic.sampled_at = '2026-11-01T12:34:56.100+00:00';
    const fd = diagnostic.content.fd;
    fd.status = complete ? 'ok' : 'partial';
    if (complete) fd.coverage = { complete: true, observed_processes: 1, denied_processes: 0, truncated: false };
    fd.allocated = allocated;
    fd.processes[0].fd_count = usage;
    fd.processes[0].usage_pct = usage;
    const item = inspection(parsed(body), 'fd');
    assert.equal(item.usage, expected);
    assert.equal(item.status, status);
    assert.equal(item.execution, complete ? 'complete' : 'partial');
    const lines = item.evidence.join('\n');
    assert.match(lines, /来源 sysAK resource_anomaly --idc/);
    assert(lines.includes(diagnostic.sampled_at), 'use diagnostic sample time, not collection completion');
    assert.match(lines, new RegExp(`全局文件句柄 ${allocated}/100；占用 ${allocated}%`));
    assert.match(lines, new RegExp(`observed_processes=${complete ? 1 : 2}`));
    assert.match(lines, new RegExp(`denied_processes=${complete ? 0 : 1}`));
    assert.match(lines, /truncated=false/);
    assert.match(lines, complete ? /原因：无/ : /permission_denied/);
    assert.match(item.detail, /FD 压力快照，不是泄漏趋势检查/);
    assert.match(lines, /FD 压力快照，不是泄漏趋势检查/);
    if (!complete) assert.match(item.detail, /不能判断为正常|不能推断整体正常/);
  });
});

test('FD missing tool is unexecuted, while attempted failures and unusable reports are unavailable', async (t) => {
  const prior = parsed(payload('inspect', { revision: 1 }));
  assert.equal(inspection(prior, 'fd').execution, 'partial');
  const cases = [
    ['absent diagnostic', (d) => { delete d.resource_anomaly; }, undefined],
    ['uninstalled tool', (d) => { d.resource_anomaly = { status: 'unavailable', source: 'bundled:resource_anomaly:idc', content: null, reason: 'component_not_installed' }; }, undefined],
    ...['error', 'unavailable', 'permission_denied', 'timeout'].map((status) =>
      [status, (d) => { d.resource_anomaly.status = status; }, 'unavailable']),
    ['FD error', (d) => { d.resource_anomaly.content.fd.status = 'error'; }, 'unavailable'],
    ['FD unavailable', (d) => { d.resource_anomaly.content.fd.status = 'unavailable'; }, 'unavailable'],
    ['missing FD report', (d) => { delete d.resource_anomaly.content.fd; }, 'unavailable'],
    ['malformed report', (d) => { d.resource_anomaly.content = 'private-invalid-output'; }, 'unavailable'],
    ['malformed FD metrics', (d) => { d.resource_anomaly.content.fd = { status: 'ok', allocated: '95', file_max: 100, processes: [{ usage_pct: 99 }] }; }, 'unavailable'],
  ];
  for (const [name, mutate, execution] of cases) await t.test(name, () => {
    const body = payload('inspect', { revision: prior.revision });
    mutate(body.raw_snapshot.diagnostics);
    const item = inspection(parsed(body, prior), 'fd');
    assert.equal(item.execution, execution);
    assert.equal(Object.hasOwn(item, 'execution'), execution !== undefined, 'do not retain previous execution after absent evidence');
    assert.equal(item.status, 'unchecked');
    assert.equal(item.usage, null);
    assert.match(item.detail, execution ? /已尝试但不可用/ : /未执行/);
    assert.match(item.evidence.join('\n'), /全局文件句柄占用不可用|全局文件句柄/);
    assert(!JSON.stringify(item).includes('private-invalid-output'));
  });
});

test('FD validates counts, limits and supplied percentages together; malformed or contradictory coverage cannot establish normality', async (t) => {
  const cases = [
    ['percentage without counters', (fd) => { fd.processes = [{ pid: 101, usage_pct: 99 }]; }],
    ['fabricated percentage', (fd) => { fd.processes[0].usage_pct = 99; }],
    ['negative count', (fd) => { fd.processes[0].fd_count = -1; }],
    ['fractional count', (fd) => { fd.processes[0].fd_count = 20.5; }],
    ['string count', (fd) => { fd.processes[0].fd_count = '20'; }],
    ['unsafe count', (fd) => { fd.processes[0].fd_count = Number.MAX_SAFE_INTEGER + 1; }],
    ['zero limit', (fd) => { fd.processes[0].soft_limit = 0; }],
    ['negative limit', (fd) => { fd.processes[0].soft_limit = -1; }],
    ['unlimited limit', (fd) => { fd.processes[0].soft_limit = null; }],
    ['fractional limit', (fd) => { fd.processes[0].soft_limit = 100.5; }],
    ['string limit', (fd) => { fd.processes[0].soft_limit = '100'; }],
    ['infinite limit', (fd) => { fd.processes[0].soft_limit = Infinity; }],
    ['inconsistent count above limit', (fd) => { fd.processes[0].fd_count = 101; }],
    ['over 100 percent', (fd) => { fd.processes[0].usage_pct = 101; }],
    ['negative percent', (fd) => { fd.processes[0].usage_pct = -1; }],
    ['nonfinite percent', (fd) => { fd.processes[0].usage_pct = NaN; }],
    ['string percent', (fd) => { fd.processes[0].usage_pct = '20'; }],
    ['invalid PID', (fd) => { fd.processes[0].pid = 0; }],
    ['nonobject process', (fd) => { fd.processes.push(null); }],
    ['duplicate PID', (fd) => { fd.processes.push(structuredClone(fd.processes[0])); fd.coverage.observed_processes = 2; }],
    ['missing processes', (fd) => { delete fd.processes; }],
    ['invalid global count', (fd) => { fd.allocated = 100.5; }],
    ['global above limit', (fd) => { fd.allocated = 101; }],
    ['invalid global limit', (fd) => { fd.file_max = 0; }],
    ['missing coverage', (fd) => { delete fd.coverage; }],
    ['missing observed', (fd) => { delete fd.coverage.observed_processes; }],
    ['observed mismatch', (fd) => { fd.coverage.observed_processes = 2; }],
    ['denied despite complete flag', (fd) => { fd.coverage.denied_processes = 1; }],
    ['truncated despite complete flag', (fd) => { fd.coverage.truncated = true; fd.coverage.reason = 'fd_limit'; }],
    ['missing truncated flag', (fd) => { delete fd.coverage.truncated; }],
    ['reason despite complete flag', (fd) => { fd.coverage.reason = 'permission_denied'; }],
    ['partial despite complete flag', (fd) => { fd.status = 'partial'; }],
  ];
  for (const [name, mutate] of cases) await t.test(name, () => {
    const body = payload('inspect', { revision: 1 });
    const fd = body.raw_snapshot.diagnostics.resource_anomaly.content.fd;
    fd.status = 'ok';
    fd.allocated = 20;
    fd.processes[0].fd_count = 20;
    fd.processes[0].usage_pct = 20;
    fd.coverage = { complete: true, observed_processes: 1, denied_processes: 0, truncated: false };
    mutate(fd);
    const item = inspection(parsed(body), 'fd');
    assert.equal(item.usage, null);
    assert.equal(item.status, 'unchecked');
    assert.equal(item.execution, 'partial');
    assert.match(item.evidence.join('\n'), /部分覆盖/);
    assert(!item.evidence.some((line) => /PID .*99%|PID .*101%/.test(line)), 'invalid metrics must not fabricate pressure');
  });
  const body = payload('inspect', { revision: 1 });
  const fd = body.raw_snapshot.diagnostics.resource_anomaly.content.fd;
  fd.allocated = 'invalid';
  const abnormal = inspection(parsed(body), 'fd');
  assert.equal(abnormal.usage, 95, 'valid process pressure survives malformed global metrics');
  assert.equal(abnormal.execution, 'partial');
  assert.equal(abnormal.status, 'abnormal');
});

test('FD accepts sysAK two-decimal ratios, exact zero/empty visible coverage and preserves strictly over-90 pressure', () => {
  const body = payload('inspect', { revision: 1 });
  const fd = body.raw_snapshot.diagnostics.resource_anomaly.content.fd;
  fd.status = 'ok';
  fd.allocated = 0;
  fd.coverage = { complete: true, observed_processes: 1, denied_processes: 0, truncated: false };
  Object.assign(fd.processes[0], { fd_count: 1, soft_limit: 3, usage_pct: 33.33 });
  let item = inspection(parsed(body), 'fd');
  assert.equal(item.execution, 'complete');
  assert.equal(item.status, 'normal');
  assert(Math.abs(item.usage - 100 / 3) < 0.000001);
  Object.assign(fd.processes[0], { fd_count: 9001, soft_limit: 10000, usage_pct: 90.01 });
  item = inspection(parsed(body), 'fd');
  assert.equal(item.status, 'abnormal');
  assert(item.usage > 90);
  Object.assign(fd.processes[0], { fd_count: 101, soft_limit: 100, usage_pct: 101 });
  item = inspection(parsed(body), 'fd');
  assert.equal(item.execution, 'complete');
  assert.equal(item.status, 'abnormal', 'a lowered soft limit can leave an exact count above 100%');
  assert.equal(item.usage, 100, 'keep the scoring percentage bounded');
  assert.match(item.evidence.join('\n'), /FD 101\/100 · 101%/);
  fd.processes = [];
  fd.coverage.observed_processes = 0;
  item = inspection(parsed(body), 'fd');
  assert.equal(item.execution, 'complete');
  assert.equal(item.usage, 0);
  assert.equal(item.status, 'normal');
  fd.status = 'partial';
  fd.allocated = null;
  fd.coverage = { complete: false, observed_processes: 0, denied_processes: 0, truncated: true, reason: 'deadline' };
  item = inspection(parsed(body), 'fd');
  assert.equal(item.execution, 'partial', 'returned partial coverage is execution even without usable ratios');
  assert.equal(item.status, 'unchecked');
  assert.equal(item.usage, null);
});

test('diagnostics enforce distinct IDC/native contracts and reject malformed units/counters without interpreting private text', async (t) => {
  const cases = [
    ['missing', (d) => { delete d.resource_anomaly; delete d.memgraph; }, ['root', 'fd', 'memory']],
    ['raw strings', (d) => { d.resource_anomaly.content = 'private raw command output'; d.memgraph.content = '{"memgraph":{}} private'; }, ['root', 'fd', 'memory']],
    ['JSON strings instead of structured content', (d) => {
      d.resource_anomaly.content = JSON.stringify(d.resource_anomaly.content);
      d.memgraph.content = JSON.stringify(d.memgraph.content);
    }, ['root', 'fd', 'memory']],
    ['mixed stdout log plus JSON', (d) => {
      d.resource_anomaly.content = `private log\n${JSON.stringify(d.resource_anomaly.content)}`;
      d.memgraph.content = `private log\n${JSON.stringify(d.memgraph.content)}`;
    }, ['root', 'fd', 'memory']],
    ['wrong mode', (d) => { d.resource_anomaly.content.mode = 'demo'; d.memgraph.content.mode = 'demo'; }, ['root', 'fd', 'memory']],
    ['IDC write enabled', (d) => { d.resource_anomaly.content.read_only = false; }, ['root', 'fd']],
    ['native mode cannot authorize resource_anomaly', (d) => { d.resource_anomaly.content.mode = 'native'; }, ['root', 'fd']],
    ['proc-only IDC memgraph is not native', (d) => { d.memgraph.content.mode = 'idc'; d.memgraph.content.read_only = true; }, ['memory']],
    ['raw legacy memgraph is not normalized', (d) => { d.memgraph.content = { version: '2.0', memgraph: d.memgraph.content.graph }; }, ['memory']],
    ['wrong native tool', (d) => { d.memgraph.content.tool = 'resource_anomaly'; }, ['memory']],
    ['wrong native version', (d) => { d.memgraph.content.version = '1.0'; }, ['memory']],
    ['missing native coverage', (d) => { delete d.memgraph.content.coverage; }, ['memory']],
    ['invented native coverage', (d) => { d.memgraph.content.coverage = { complete: true }; }, ['memory']],
    ['invented full native status', (d) => { d.memgraph.content.status = 'ok'; }, ['memory']],
    ['failed evidence', (d) => { d.resource_anomaly.status = 'error'; d.memgraph.status = 'error'; }, ['root', 'fd', 'memory']],
    ['root over total', (d) => { d.resource_anomaly.content.root.used_bytes = 1001; }, ['root']],
    ['root zero total', (d) => { d.resource_anomaly.content.root.total_bytes = 0; }, ['root']],
    ['FD unavailable', (d) => { d.resource_anomaly.content.fd.status = 'error'; }, ['fd']],
    ['wrong memgraph units', (d) => { d.memgraph.content.unit = 'B'; }, ['memory']],
    ['missing available', (d) => { delete d.memgraph.content.graph.avaliable; }, ['memory']],
    ['available above total', (d) => { d.memgraph.content.graph.avaliable = 1001; }, ['memory']],
    ['negative available', (d) => { d.memgraph.content.graph.avaliable = -1; }, ['memory']],
    ['zero native total', (d) => { d.memgraph.content.graph.total = 0; }, ['memory']],
    ['boolean native total', (d) => { d.memgraph.content.graph.total = true; }, ['memory']],
    ['string native available', (d) => { d.memgraph.content.graph.avaliable = '100'; }, ['memory']],
    ['nonfinite native total', (d) => { d.memgraph.content.graph.total = Infinity; }, ['memory']],
    ['nonfinite native available', (d) => { d.memgraph.content.graph.avaliable = NaN; }, ['memory']],
    ['missing normalized graph', (d) => { delete d.memgraph.content.graph; }, ['memory']],
    ['native unavailable', (d) => { d.memgraph.content.status = 'unavailable'; }, ['memory']],
  ];
  for (const [name, mutate, ids] of cases) await t.test(name, () => {
    const body = payload('inspect', { revision: 1 });
    mutate(body.raw_snapshot.diagnostics);
    const state = parsed(body);
    for (const id of ids) {
      assert.equal(inspection(state, id).status, 'unchecked');
      assert.equal(inspection(state, id).usage, null);
    }
    assert(!JSON.stringify(state).includes('private raw'));
  });
});

test('HTTP partial/malformed resources replace old measurements with unknown while preserving inspection evidence, and failed collections are retryable without commit', async () => {
  await withServer(async (api) => {
    const first = await success(api, payload('inspect', { revision: 1 }));
    const deviceId = first.receipt.device.id;
    const missing = payload('snapshot', {}, deviceId);
    missing.raw_snapshot.collection.status = 'partial';
    missing.raw_snapshot.resources = {};
    const next = await success(api, missing);
    allUnknown(next.state);
    assert.equal(next.state.hasGpu, true);
    assert.equal(next.state.revision, 3);
    assert.deepEqual(next.state.inspections, first.state.inspections);
    const failed = payload('snapshot', {}, deviceId);
    failed.raw_snapshot.collection.status = 'error';
    await rejected(api, failed, 503, 'collection_failed');
    assert.deepEqual((await snapshot(api, deviceId)).json, next);
    failed.raw_snapshot.collection.status = 'ok';
    const retried = await success(api, failed);
    assert.equal(retried.state.revision, 4);
    assert.deepEqual(retried.state.inspections, first.state.inspections);
  });
});
