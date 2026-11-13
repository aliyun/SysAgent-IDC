const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { createHash, randomUUID } = require('node:crypto');
const { CollectorError, collectRaw, createIdcController, verifyBundle, validState } = require('../electron/idc-controller.cjs');

const MiB = 1024 * 1024;
const timestamp = '2026-11-01T12:34:56.000Z';
const linux = { skip: process.platform !== 'linux', timeout: 5000 };
const turn = () => new Promise((resolve) => setImmediate(resolve));
// Only these legacy launch-injection tests bypass service verification; children remain inert.
const launchImpl = (binary, args, opts, spawnImpl) => spawnImpl(binary, args, opts);
const verifyExecutionImpl = () => {};
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
const minute = 60 * 1000;
// Only controller scheduling uses this clock; child and HTTP timeouts remain real.
function fakeClock(start = Date.parse(timestamp)) {
  let current = start;
  let sequence = 0;
  const timers = new Map();
  const history = [];
  const scheduler = {
    now: () => current,
    setTimeout(fn, delay) {
      assert(Number.isFinite(delay) && delay >= 0, 'scheduler delay must be nonnegative milliseconds');
      const timer = { handle: ++sequence, at: current + delay, fn };
      timers.set(timer.handle, timer);
      history.push(timer);
      return timer.handle;
    },
    clearTimeout(handle) { timers.delete(handle); },
  };
  return {
    scheduler, history,
    get now() { return current; },
    get pending() { return [...timers.values()].sort((a, b) => a.at - b.at || a.handle - b.handle); },
    isoAfter(ms) { return new Date(current + ms).toISOString(); },
    advance(ms) {
      assert(Number.isFinite(ms) && ms >= 0);
      const target = current + ms;
      let fired = 0;
      while (true) {
        const timer = [...timers.values()].filter((item) => item.at <= target)
          .sort((a, b) => a.at - b.at || a.handle - b.handle)[0];
        if (!timer) break;
        assert(++fired <= 1000, 'timer callbacks must not create a zero-delay loop');
        timers.delete(timer.handle);
        current = timer.at;
        timer.fn();
      }
      current = target;
    },
  };
}
async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 1000; attempt++) {
    if (predicate()) return;
    await turn();
  }
  assert.fail(message);
}
function scheduledIn(controller, clock, minutes) {
  assert.equal(controller.status().next_inspection_at, clock.isoAfter(minutes * minute));
  assert.equal(clock.pending.length, 1, 'exactly one scheduling timer must be armed');
  assert.equal(clock.pending[0].at, clock.now + minutes * minute);
}
async function autoFinished(controller, clock, operation = 'inspect') {
  await waitFor(() => controller.status().phase === 'idle' &&
    controller.status().last_task?.operation === operation && clock.pending.length === 1,
  'automatic work must finish and arm its next timer');
}
function rawSnapshot(profile, requestId) {
  return {
    schema_version: '1.0', request_id: requestId, collected_at: timestamp,
    collector: { name: 'sysak', version: '1.0', permissions: { status: 'granted', elevated: false, denied: [] } },
    collection: { profile, status: 'ok', started_at: timestamp, finished_at: timestamp },
    capabilities: { read_only: true },
    device: { hostname: 'fixture-only' },
    resources: {
      cpu: [
        { status: 'ok', source: '/proc/stat', content: 'cpu 100 0 0 900 0 0 0 0 0 0\n', sampled_at: timestamp },
        { status: 'ok', source: '/proc/stat', content: 'cpu 112 0 0 988 0 0 0 0 0 0\n', sampled_at: timestamp },
      ],
      gpu: { status: 'ok', source: { argv: ['nvidia-smi', '--format=csv,noheader,nounits'] },
        content: { schema_version: '1.0', tool: 'idc', mode: 'idc', read_only: true, status: 'ok', available: true, gpu_count: 0, devices: [] }, sampled_at: timestamp },
      meminfo: { status: 'ok', source: '/proc/meminfo', content: 'MemTotal: 1000 kB\nMemAvailable: 880 kB\n', sampled_at: timestamp },
    },
    configuration: {}, diagnostics: {},
  };
}
function healthState(revision = 1, hasGpu = false) {
  return {
    mode: 'collected', hasGpu, revision, sampledAt: timestamp,
    resources: Object.fromEntries(['cpu', 'energy', 'memory', 'disk', 'gpu'].map((id) => [id, {
      id, label: id, usage: id === 'energy' || (id === 'gpu' && !hasGpu) ? null : 12,
      capacity: null, unit: id === 'energy' ? 'W' : '%', source: 'sysak',
      status: id === 'gpu' && !hasGpu ? 'unavailable' : 'available', rows: [],
      ...(id === 'energy' ? { quantity: { value: 13, unit: 'W' }, rankUnit: 'W' } : {}),
    }])),
    inspections: [], optimizations: [], operations: [],
  };
}
function collectedRow(extra = {}) {
  return { id: 'process-101-1000', pid: 101, name: 'fixture-process', detail: 'PID 101',
    usage: 12, cleanable: false, defaultSelected: false, effect: 'read-only', ...extra };
}
function quantifiedState() {
  const state = healthState();
  state.resources.memory.quantity = { value: 768000, unit: 'B', total: 1024000, available: 256000 };
  state.resources.memory.rows = [collectedRow({ quantity: { value: 256000, unit: 'B' } })];
  state.resources.disk.quantity = { value: 3276800, unit: 'B', total: 4096000, available: 614400 };
  state.resources.disk.rankUnit = 'B/s';
  state.resources.disk.rows = [collectedRow({ usage: 4000, quantity: { value: 4000, unit: 'B/s' } })];
  state.resources.cpu.rows = [collectedRow()];
  state.resources.energy.rows = [collectedRow({ id: 'rapl-0', usage: 13, quantity: { value: 13, unit: 'W' } })];
  return state;
}
test('validState accepts unknown percentages and explicit real quantities, including rates above 100, without accepting nonfinite, negative or invalid-unit data', async (t) => {
  const good = quantifiedState();
  assert.equal(validState(good), true);
  const unknown = healthState();
  for (const resource of Object.values(unknown.resources)) {
    resource.usage = null;
    resource.status = 'unavailable';
    delete resource.quantity;
  }
  assert.equal(validState(unknown), true);
  for (const [name, mutate] of [
    ['negative percentage', (s) => { s.resources.cpu.usage = -1; }],
    ['NaN percentage', (s) => { s.resources.cpu.usage = NaN; }],
    ['infinite percentage', (s) => { s.resources.cpu.usage = Infinity; }],
    ['negative infinite percentage', (s) => { s.resources.cpu.usage = -Infinity; }],
    ['string percentage', (s) => { s.resources.cpu.usage = '12'; }],
    ['undefined percentage', (s) => { delete s.resources.cpu.usage; }],
    ['negative quantity', (s) => { s.resources.memory.quantity.value = -1; }],
    ['NaN quantity', (s) => { s.resources.memory.quantity.value = NaN; }],
    ['infinite quantity', (s) => { s.resources.energy.quantity.value = Infinity; }],
    ['string quantity', (s) => { s.resources.memory.quantity.value = '768000'; }],
    ['negative total', (s) => { s.resources.memory.quantity.total = -1; }],
    ['infinite available', (s) => { s.resources.memory.quantity.available = Infinity; }],
    ['invalid quantity unit', (s) => { s.resources.energy.quantity.unit = 'kWh'; }],
    ['invalid resource unit', (s) => { s.resources.memory.unit = 'bananas'; }],
    ['invalid rank unit', (s) => { s.resources.disk.rankUnit = 'MB/s'; }],
    ['negative row rate', (s) => { s.resources.disk.rows[0].usage = -1; }],
    ['NaN row usage', (s) => { s.resources.cpu.rows[0].usage = NaN; }],
    ['infinite row quantity', (s) => { s.resources.disk.rows[0].quantity.value = Infinity; }],
    ['negative row quantity', (s) => { s.resources.memory.rows[0].quantity.value = -1; }],
    ['invalid row unit', (s) => { s.resources.disk.rows[0].quantity.unit = 'MiB/s'; }],
    ['row collection is not array', (s) => { s.resources.cpu.rows = {}; }],
    ['missing resource', (s) => { delete s.resources.gpu; }],
    ['noninteger revision', (s) => { s.revision = 1.5; }],
  ]) await t.test(name, () => {
    const state = structuredClone(good);
    mutate(state);
    assert.equal(Boolean(validState(state)), false);
  });
});

test('validState validates parsed GPU device metrics and diagnostic reports at the API boundary', async (t) => {
  const state = quantifiedState();
  state.resources.gpu.gpuDevices = [{ index: 0, name: 'Fixture GPU', uuid: 'GPU-fixture', busId: '', utilization: 0, memoryUtilization: null,
    memoryUsedBytes: 1024, memoryTotalBytes: 8192, temperatureCelsius: 26, powerWatts: 68.65, powerLimitWatts: null,
    eccCorrected: 0, eccUncorrected: null, pcieGeneration: 1, pcieMaxGeneration: 4, pcieWidth: 16 }];
  state.gpuDiagnostic = { status: 'partial', outcome: 'unknown', sampledAt: timestamp, source: 'sysak ai', complete: false,
    gpuCount: 1, architectures: [], devices: ['Fixture GPU'], summary: 'Coverage limited', findings: [{ check: 'ECC', severity: 'OK', message: 'No errors observed' }],
    jobAnalysis: { source: 'sysak ai', status: 'partial', sampledAt: timestamp, sampleWindowSeconds: 1, complete: false, reason: 'gx_not_installed',
      processes: [{ pid: 101, starttime: 10, name: 'python', state: 'S', cpuPercent: 0, rssBytes: 1024, gpuIndices: [0],
        smUtilization: 0, memoryUtilization: null, status: 'not_run', findings: [] }] } };
  assert.equal(validState(state), true);
  for (const [name, mutate] of [
    ['invalid utilization', (s) => { s.resources.gpu.gpuDevices[0].utilization = 101; }],
    ['negative power', (s) => { s.resources.gpu.gpuDevices[0].powerWatts = -1; }],
    ['nonfinite memory', (s) => { s.resources.gpu.gpuDevices[0].memoryTotalBytes = Infinity; }],
    ['missing metric', (s) => { delete s.resources.gpu.gpuDevices[0].eccCorrected; }],
    ['invalid device index', (s) => { s.resources.gpu.gpuDevices[0].index = 0.5; }],
    ['oversized device list', (s) => { s.resources.gpu.gpuDevices = Array(33).fill(s.resources.gpu.gpuDevices[0]); }],
    ['invalid report status', (s) => { s.gpuDiagnostic.status = 'healthy'; }],
    ['invalid report date', (s) => { s.gpuDiagnostic.sampledAt = 'not a date'; }],
    ['invalid severity', (s) => { s.gpuDiagnostic.findings[0].severity = 'healthy'; }],
    ['negative gpu count', (s) => { s.gpuDiagnostic.gpuCount = -1; }],
    ['legacy source', (s) => { s.gpuDiagnostic.source = 'sysak gpudiag'; }],
    ['job source', (s) => { s.gpuDiagnostic.jobAnalysis.source = 'mock'; }],
    ['job window', (s) => { s.gpuDiagnostic.jobAnalysis.sampleWindowSeconds = 11; }],
    ['job nonfinite CPU', (s) => { s.gpuDiagnostic.jobAnalysis.processes[0].cpuPercent = Infinity; }],
    ['job invalid PID', (s) => { s.gpuDiagnostic.jobAnalysis.processes[0].pid = 0; }],
    ['job duplicate PID', (s) => { s.gpuDiagnostic.jobAnalysis.processes.push(s.gpuDiagnostic.jobAnalysis.processes[0]); }],
    ['job unsafe RSS', (s) => { s.gpuDiagnostic.jobAnalysis.processes[0].rssBytes = Number.MAX_SAFE_INTEGER + 1; }],
    ['job invalid SM', (s) => { s.gpuDiagnostic.jobAnalysis.processes[0].smUtilization = 101; }],
    ['job duplicate GPU', (s) => { s.gpuDiagnostic.jobAnalysis.processes[0].gpuIndices = [0, 0]; }],
    ['job oversize process list', (s) => { s.gpuDiagnostic.jobAnalysis.processes = Array(129).fill(s.gpuDiagnostic.jobAnalysis.processes[0]); }],
    ['job fabricated complete', (s) => { s.gpuDiagnostic.jobAnalysis.complete = true; }],
    ['job missing status', (s) => { delete s.gpuDiagnostic.jobAnalysis.processes[0].status; }],
  ]) await t.test(name, () => {
    const invalid = structuredClone(state);
    mutate(invalid);
    assert.equal(Boolean(validState(invalid)), false);
  });
});

function responseFor(body, state = healthState()) {
  const taskId = randomUUID();
  return {
    schema_version: '1.0', request_id: body.request_id, task_id: taskId,
    mode: 'mock', read_only: true, state,
    task: { id: taskId, operation: body.operation, status: 'completed', simulated: false, read_only: true },
  };
}
function errorIs(code, status = 503, retryable = false) {
  return (error) => {
    assert(error instanceof CollectorError);
    assert.equal(error.code, code);
    assert.equal(error.status, status);
    assert.equal(error.retryable, retryable);
    assert.equal(typeof error.message, 'string');
    return true;
  };
}

// No child process is ever started. Even termination only closes these streams.
function fakeProcesses(onSpawn = (call) => call.succeed()) {
  const calls = [];
  const kills = [];
  const started = new EventEmitter();
  const spawnImpl = (binary, argv, options) => {
    const child = new EventEmitter();
    child.pid = 900000 + calls.length;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    let closing = false;
    child.finish = (code = 0) => {
      if (closing) return;
      closing = true;
      child.stdout.end();
      child.stderr.end();
      setImmediate(() => child.emit('close', code));
    };
    child.kill = (signal) => { kills.push({ pid: child.pid, signal, fallback: true }); child.finish(null); return true; };
    const call = {
      binary, argv, options, child,
      profile: argv[2], requestId: argv[4],
      succeed(raw = rawSnapshot(argv[2], argv[4]), stderr = '') {
        if (stderr) child.stderr.write(stderr);
        child.stdout.write(JSON.stringify(raw));
        child.finish();
      },
    };
    calls.push(call);
    setImmediate(() => { started.emit('spawn', call); onSpawn(call); });
    return child;
  };
  // Accept the optional signal argument used by SIGKILL escalation implementations.
  const killGroup = (pid, signal = 'SIGTERM') => {
    kills.push({ pid, signal });
    const call = calls.find((item) => item.child.pid === pid);
    assert(call, 'termination must target a fake child');
    call.child.finish(null);
  };
  return {
    calls, kills, spawnImpl, launchImpl, verifyExecutionImpl, killGroup,
    nextSpawn: () => new Promise((resolve) => started.once('spawn', resolve)),
  };
}
function bundle(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sysom-idc-controller-test-'));
  // Executable permission is needed by verifyBundle, but this is deliberately not a program.
  fs.writeFileSync(path.join(root, 'sysak'), 'fixture only; must never be executed\n', { mode: 0o700 });
  fs.writeFileSync(path.join(root, 'collector.py'), '# inert hash fixture\n');
  const manifest = {
    schema_version: '1.0', platform: 'linux', arch: process.arch, commands: ['idc', 'resource_anomaly', 'memgraph'],
    files: Object.fromEntries(['sysak', 'collector.py'].map((name) => [name,
      createHash('sha256').update(fs.readFileSync(path.join(root, name))).digest('hex')])),
  };
  const writeManifest = () => fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify(manifest));
  writeManifest();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, manifest, writeManifest };
}
async function loopback(t, handler) {
  const requests = [];
  const failures = [];
  let server;
  let closed = false;
  let token;
  const startMockOpenApi = async (options) => {
    token = options.token;
    server = http.createServer(async (request, response) => {
      try {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const text = Buffer.concat(chunks).toString('utf8');
        const body = JSON.parse(text);
        const receipt = { method: request.method, url: request.url, headers: request.headers, text, body };
        requests.push(receipt);
        const result = handler ? await handler(body, requests.length, receipt) :
          { body: responseFor(body, healthState(requests.length, body.parameters.hasGpu ?? false)) };
        response.writeHead(result.status ?? 200, { 'content-type': 'application/json', connection: 'close' });
        response.end(result.text ?? JSON.stringify(result.body));
      } catch (error) {
        failures.push(error);
        response.writeHead(500, { 'content-type': 'application/json', connection: 'close' });
        response.end(JSON.stringify({ error: { code: 'STUB_FAILURE', message: error.message } }));
      }
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    assert.equal(server.address().address, '127.0.0.1');
    return { baseUrl: `http://127.0.0.1:${server.address().port}`, close };
  };
  async function close() {
    if (!server || closed) return;
    closed = true;
    const done = new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    server.closeAllConnections();
    await done;
  }
  t.after(async () => { await close(); assert.deepEqual(failures, [], 'loopback stub must not mask fixture failures'); });
  return { startMockOpenApi, requests, close, get token() { return token; }, get closed() { return closed; } };
}
async function controllerFixture(t, { onSpawn, handler, mutateBundle, ...options } = {}) {
  const files = bundle(t);
  if (mutateBundle) mutateBundle(files);
  const processes = fakeProcesses(onSpawn);
  const api = await loopback(t, handler);
  const clock = fakeClock();
  const controller = await createIdcController({
    bundleRoot: files.root, deviceId: randomUUID(), hasGpu: false,
    startMockOpenApi: api.startMockOpenApi, ...processes, scheduler: clock.scheduler, ...options,
  });
  t.after(() => controller.close());
  return { controller, processes, api, files, clock };
}
function rawFixture(t, onSpawn, timeoutMs = 1000) {
  const processes = fakeProcesses(onSpawn);
  const abort = new AbortController();
  t.after(() => abort.abort());
  const requestId = randomUUID();
  const run = () => collectRaw(path.join(os.tmpdir(), 'never-run-sysak'), 'resources', requestId, abort.signal,
    { ...processes, timeoutMs });
  return { ...processes, abort, requestId, run };
}

// EPERM tests never inspect a real bundle, start HTTP, or signal an OS process.
function watchdogProcesses(t) {
  const processes = fakeProcesses(() => {});
  processes.killGroup = (pid, signal) => {
    assert(processes.calls.some(call => call.child.pid === pid), 'must target a mock child');
    processes.kills.push({ pid, signal });
    throw Object.assign(new Error('mock root group permission denied'), { code: 'EPERM' });
  };
  t.after(() => { for (const call of processes.calls) call.child.finish(null); });
  return processes;
}
async function mockWatchdogController(t, processes) {
  const root = '/fixture/idc-controller';
  const bytes = Buffer.from('inert in-memory sysak');
  const manifest = { schema_version: '1.0', platform: 'linux', arch: process.arch,
    commands: ['idc'], files: { sysak: createHash('sha256').update(bytes).digest('hex') } };
  t.mock.method(fs, 'readFileSync', (file, encoding) => {
    if (file === path.join(root, 'manifest.json')) {
      assert.equal(encoding, 'utf8');
      return JSON.stringify(manifest);
    }
    assert.equal(file, path.join(root, 'sysak'), 'must read only the in-memory fixture');
    return bytes;
  });
  t.mock.method(fs, 'realpathSync', file => {
    assert([root, path.join(root, 'sysak')].includes(file), 'must resolve only the in-memory fixture');
    return file;
  });
  t.mock.method(fs, 'accessSync', (file, mode) => {
    assert.equal(file, path.join(root, 'sysak'));
    assert.equal(mode, fs.constants.X_OK);
  });
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'http://fixture.invalid/openapi/v1/collections');
    const body = JSON.parse(options.body);
    requests.push(body);
    return { ok: true, text: async () => JSON.stringify(responseFor(body)) };
  });
  let apiClosed = false;
  const controller = await createIdcController({
    bundleRoot: root, ...processes, scheduler: fakeClock().scheduler,
    startMockOpenApi: async () => ({ baseUrl: 'http://fixture.invalid', close: async () => { apiClosed = true; } }),
  });
  t.after(async () => {
    for (const call of processes.calls) call.child.finish(null);
    await controller.close();
  });
  assert.equal(controller.status().installed, true);
  return { controller, requests, get apiClosed() { return apiClosed; } };
}

test('collector uses fixed argv, shell:false, detached pipes and a credential-free environment', { timeout: 5000 }, async (t) => {
  const names = ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AZURE_CLIENT_SECRET',
    'GOOGLE_APPLICATION_CREDENTIALS', 'OPENAI_API_KEY', 'SYSOM_OPENAPI_TOKEN', 'SSH_AUTH_SOCK',
    'PYTHONPATH', 'LD_PRELOAD', 'NODE_OPTIONS'];
  const saved = names.map((name) => [name, process.env[name]]);
  try {
    for (const name of names) process.env[name] = `secret-${name}`;
    const fixture = rawFixture(t, (call) => call.succeed(undefined, 'diagnostic 汉字'));
    const result = await fixture.run();
    const call = fixture.calls[0];
    assert.equal(call.binary, path.join(os.tmpdir(), 'never-run-sysak'));
    assert.deepEqual(call.argv, ['idc', '--profile', 'resources', '--request-id', fixture.requestId, '-o', '-']);
    assert.deepEqual(call.options, {
      cwd: os.tmpdir(), detached: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8', PYTHONDONTWRITEBYTECODE: '1' },
    });
    for (const name of names) assert.equal(Object.hasOwn(call.options.env, name), false);
    assert.equal(result.bytes, Buffer.byteLength(JSON.stringify(result.raw)));
    assert.equal(result.stderrBytes, Buffer.byteLength('diagnostic 汉字'));
    assert.deepEqual(fixture.kills, []);
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test('malformed JSON and incompatible raw collection fields fail closed', { timeout: 5000 }, async (t) => {
  const cases = [
    ['truncated JSON', () => '{'], ['null', () => 'null'], ['array', () => '[]'],
    ['schema', (raw) => { raw.schema_version = '2.0'; }],
    ['request identity', (raw) => { raw.request_id = randomUUID(); }],
    ['collector', (raw) => { raw.collector.name = 'shell'; }],
    ['profile', (raw) => { raw.collection.profile = 'inspection'; }],
    ['collection status', (raw) => { raw.collection.status = 'error'; }],
    ['resources', (raw) => { delete raw.resources; }],
    ['configuration', (raw) => { raw.configuration = null; }],
    ['diagnostics', (raw) => { delete raw.diagnostics; }],
    ['read-only capability', (raw) => { raw.capabilities.read_only = false; }],
  ];
  for (const [name, mutate] of cases) await t.test(name, async (t) => {
    const fixture = rawFixture(t, (call) => {
      const raw = rawSnapshot(call.profile, call.requestId);
      const text = mutate(raw);
      call.child.stdout.write(text ?? JSON.stringify(raw));
      call.child.finish();
    });
    await assert.rejects(fixture.run(), errorIs('INVALID_COLLECTION', 502, true));
    assert.deepEqual(fixture.kills, []);
  });
  await t.test('partial read-only results are accepted', async (t) => {
    const fixture = rawFixture(t, (call) => {
      const raw = rawSnapshot(call.profile, call.requestId);
      raw.collection.status = 'partial';
      call.succeed(raw);
    });
    assert.equal((await fixture.run()).raw.collection.status, 'partial');
  });
});

test('process timeout terminates the fake process group and reports a retryable 504', { timeout: 5000 }, async (t) => {
  const fixture = rawFixture(t, () => {}, 15);
  await assert.rejects(fixture.run(), errorIs('COLLECTION_TIMEOUT', 504, true));
  assert.equal(fixture.kills[0].pid, fixture.calls[0].child.pid);
  assert.equal(fixture.kills[0].signal, 'SIGTERM');
  assert(fixture.kills.every(({ signal }) => ['SIGTERM', 'SIGKILL'].includes(signal)));
});

test('cancellation closes the fake child; a pre-aborted signal never spawns', { timeout: 5000 }, async (t) => {
  const fixture = rawFixture(t, () => {});
  const started = fixture.nextSpawn();
  const pending = fixture.run();
  const rejected = assert.rejects(pending, errorIs('COLLECTION_CANCELLED'));
  await started;
  fixture.abort.abort();
  await rejected;
  assert.equal(fixture.kills[0].pid, fixture.calls[0].child.pid);
  assert.equal(fixture.kills[0].signal, 'SIGTERM');
  const preAborted = rawFixture(t, () => assert.fail('pre-aborted collection spawned'));
  preAborted.abort.abort();
  await assert.rejects(preAborted.run(), errorIs('COLLECTION_CANCELLED'));
  assert.equal(preAborted.calls.length, 0);
});

test('collectRaw cancellation and timeout EPERM wait for root watchdog close without child.kill fallback or accepting late output', { timeout: 5000 }, async t => {
  for (const cause of ['cancel', 'timeout']) for (const code of [0, 124]) await t.test(`${cause}: watchdog close ${code}`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const processes = watchdogProcesses(t);
    const abort = new AbortController();
    const requestId = randomUUID();
    const started = processes.nextSpawn();
    const pending = collectRaw('/fixture/never-run-sysak', 'resources', requestId, abort.signal, processes);
    let settled = false;
    pending.then(() => { settled = true; }, () => { settled = true; });
    const rejected = assert.rejects(pending, cause === 'cancel' ? errorIs('COLLECTION_CANCELLED') : errorIs('COLLECTION_TIMEOUT', 504, true));
    const call = await started;
    const fallback = t.mock.method(call.child, 'kill', () => assert.fail('EPERM must not fall back to child.kill'));
    if (cause === 'cancel') abort.abort();
    else t.mock.timers.tick(35000);
    assert.deepEqual(processes.kills, [{ pid: call.child.pid, signal: 'SIGTERM' }]);
    call.child.emit('error', Object.assign(new Error('mock EPERM after stop'), { code: 'EPERM' }));
    await turn();
    assert.equal(settled, false, 'EPERM after failure must not settle before close');
    t.mock.timers.tick(1000);
    assert.deepEqual(processes.kills, [
      { pid: call.child.pid, signal: 'SIGTERM' }, { pid: call.child.pid, signal: 'SIGKILL' },
    ]);
    // Repeated error events must keep waiting, not remove the handler after one event.
    call.child.emit('error', Object.assign(new Error('mock EPERM after escalation'), { code: 'EPERM' }));
    call.child.stdout.write(JSON.stringify(rawSnapshot('resources', requestId)));
    await turn();
    assert.equal(settled, false, 'valid late output must not bypass the root watchdog');
    assert.equal(fallback.mock.callCount(), 0);
    call.child.finish(code);
    await rejected;
    assert.equal(settled, true);
    t.mock.timers.tick(100000);
    abort.abort();
    assert.equal(processes.kills.length, 2, 'close must clear both timeout and escalation timers');
    assert.equal(fallback.mock.callCount(), 0);
  });
});

test('controller disable, close and timeout EPERM discard root output without HTTP submission, task metadata or cache', linux, async t => {
  for (const cause of ['disable', 'close', 'timeout']) await t.test(cause, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const processes = watchdogProcesses(t);
    const fixture = await mockWatchdogController(t, processes);
    const { controller, requests } = fixture;
    const started = processes.nextSpawn();
    const pending = controller.snapshot();
    let settled = false;
    pending.then(() => { settled = true; }, () => { settled = true; });
    const rejected = assert.rejects(pending, cause === 'timeout' ? errorIs('COLLECTION_TIMEOUT', 504, true) : errorIs('COLLECTION_CANCELLED'));
    const call = await started;
    const fallback = t.mock.method(call.child, 'kill', () => assert.fail('must leave the root watchdog to close the mock child'));
    let closing;
    let closeSettled = false;
    if (cause === 'disable') controller.setEnabled(false);
    else if (cause === 'close') {
      closing = controller.close().then(() => { closeSettled = true; });
    } else t.mock.timers.tick(35000);
    assert.deepEqual(processes.kills, [{ pid: call.child.pid, signal: 'SIGTERM' }]);
    call.child.emit('error', Object.assign(new Error('mock root EPERM'), { code: 'EPERM' }));
    call.child.stdout.write(JSON.stringify(rawSnapshot(call.profile, call.requestId)));
    await turn();
    assert.equal(settled, false);
    assert.equal(closeSettled, false, 'close must wait for root watchdog close');
    assert.equal(fixture.apiClosed, false);
    assert.equal(requests.length, 0);
    assert.equal(controller.status().last_task, null);
    t.mock.timers.tick(1000);
    assert.deepEqual(processes.kills, [
      { pid: call.child.pid, signal: 'SIGTERM' }, { pid: call.child.pid, signal: 'SIGKILL' },
    ]);
    call.child.emit('error', Object.assign(new Error('mock root escalation EPERM'), { code: 'EPERM' }));
    await turn();
    assert.equal(settled, false);
    assert.equal(fallback.mock.callCount(), 0);
    call.child.finish(0);
    await rejected;
    if (closing) await closing;
    assert.equal(controller.status().error.code, cause === 'timeout' ? 'COLLECTION_TIMEOUT' : 'COLLECTION_CANCELLED');
    assert.equal(requests.length, 0, 'late valid raw JSON must not reach OpenAPI');
    assert.equal(controller.status().last_task, null);
    if (cause === 'close') assert.equal(fixture.apiClosed, true);
    else controller.setEnabled(false);
    await assert.rejects(controller.snapshot(false), errorIs('COLLECTOR_DISABLED'));
    assert.equal(processes.calls.length, 1, 'disabled cache read must not start a process');
    t.mock.timers.tick(100000);
    assert.equal(processes.kills.length, 2, 'watchdog close must cancel local timers');
    if (cause !== 'close') {
      controller.setEnabled(true);
      const nextStarted = processes.nextSpawn();
      const next = controller.snapshot(false);
      const nextRejected = assert.rejects(next, errorIs('COLLECTION_CANCELLED'));
      const nextCall = await nextStarted;
      assert.equal(processes.calls.length, 2, 'resume must recollect rather than return a poisoned cache');
      const nextFallback = t.mock.method(nextCall.child, 'kill', () => assert.fail('EPERM must not signal a fake child either'));
      controller.setEnabled(false);
      nextCall.child.finish(124);
      await nextRejected;
      assert.equal(nextFallback.mock.callCount(), 0);
      assert.equal(requests.length, 0);
      await assert.rejects(controller.snapshot(false), errorIs('COLLECTOR_DISABLED'));
    }
  });
});

test('EPERM without an existing collection failure and root watchdog exit codes retain distinct errors', { timeout: 5000 }, async t => {
  await t.test('EPERM before stop is a spawn error', async t => {
    const fixture = rawFixture(t, call => {
      call.child.emit('error', Object.assign(new Error('mock spawn EPERM'), { code: 'EPERM' }));
      call.child.finish(-1);
    });
    await assert.rejects(fixture.run(), errorIs('COLLECTOR_UNAVAILABLE'));
    assert.deepEqual(fixture.kills, []);
  });
  for (const [code, errorCode, status, retryable] of [
    [126, 'ROOT_COLLECTOR_UNAVAILABLE', 403, false],
    [127, 'ROOT_COLLECTOR_UNAVAILABLE', 403, false],
    [124, 'COLLECTION_TIMEOUT', 504, true],
    [125, 'COLLECTION_TOO_LARGE', 413, false],
    [75, 'ROOT_SERVICE_BUSY', 503, true],
  ]) await t.test(`service exit ${code}`, async t => {
    const fixture = rawFixture(t, call => call.child.finish(code));
    await assert.rejects(fixture.run(), error => {
      errorIs(errorCode, status, retryable)(error);
      if (code === 126 || code === 127) {
        assert.match(error.message, /服务身份或组件校验失败/);
        assert.match(error.message, /安装与用户授权/);
        assert.doesNotMatch(error.message, /pkexec|sudo|授权弹窗/);
      }
      return true;
    });
    assert.deepEqual(fixture.kills, []);
  });
});

test('spawn error and nonzero process exit are distinct collection failures', { timeout: 5000 }, async (t) => {
  await t.test('spawn error', async (t) => {
    const fixture = rawFixture(t, (call) => {
      call.child.emit('error', new Error('ENOENT'));
      call.child.finish(-1);
    });
    await assert.rejects(fixture.run(), errorIs('COLLECTOR_UNAVAILABLE'));
  });
  await t.test('exit failure', async (t) => {
    const fixture = rawFixture(t, (call) => { call.child.stderr.write('private stderr'); call.child.finish(2); });
    await assert.rejects(fixture.run(), errorIs('COLLECTION_FAILED', 503, true));
  });
});

test('raw output cap accepts exactly 8 MiB and kills on the first extra byte', { timeout: 5000 }, async (t) => {
  const exact = rawFixture(t, (call) => {
    const raw = rawSnapshot(call.profile, call.requestId);
    raw.diagnostics.padding = '';
    raw.diagnostics.padding = 'x'.repeat(8 * MiB - Buffer.byteLength(JSON.stringify(raw)));
    const bytes = Buffer.from(JSON.stringify(raw));
    call.child.stdout.write(bytes.subarray(0, MiB));
    call.child.stdout.write(bytes.subarray(MiB));
    call.child.finish();
  });
  assert.equal((await exact.run()).bytes, 8 * MiB);
  assert.deepEqual(exact.kills, []);
  const oversized = rawFixture(t, (call) => {
    call.child.stdout.write(Buffer.alloc(8 * MiB, 0x20));
    call.child.stdout.write(Buffer.from('汉'));
  });
  await assert.rejects(oversized.run(), errorIs('COLLECTION_TOO_LARGE', 413));
  assert.equal(oversized.kills[0].pid, oversized.calls[0].child.pid);
});

test('missing bundle reports unavailable status without attempting collection', linux, async (t) => {
  const { controller, processes, api } = await controllerFixture(t, {
    mutateBundle: ({ root }) => fs.rmSync(path.join(root, 'manifest.json')),
  });
  const status = controller.status();
  assert.equal(status.installed, false);
  assert.equal(status.phase, 'error');
  assert.equal(status.mode, 'mock');
  assert.equal(status.read_only, true);
  assert.equal(status.api_version, '1.0');
  assert.equal(status.error.code, 'COLLECTOR_UNAVAILABLE');
  await assert.rejects(controller.snapshot(), errorIs('COLLECTOR_UNAVAILABLE'));
  assert.equal(processes.calls.length, 0);
  assert.equal(api.requests.length, 0);
});

test('manifest architecture, commands, digests and path containment determine bundle status', linux, async (t) => {
  await t.test('valid hash manifest', (t) => {
    const files = bundle(t);
    assert.deepEqual(verifyBundle(files.root), files.manifest);
  });
  const cases = [
    ['wrong architecture', ({ manifest }) => { manifest.arch = 'not-this-architecture'; }],
    ['wrong schema', ({ manifest }) => { manifest.schema_version = '2.0'; }],
    ['missing command', ({ manifest }) => { manifest.commands = ['resource_anomaly', 'memgraph']; }],
    ['wrong digest', ({ manifest }) => { manifest.files.sysak = '0'.repeat(64); }],
    ['malformed digest', ({ manifest }) => { manifest.files.sysak = 'not-a-hash'; }],
    ['modified file', ({ root }) => fs.appendFileSync(path.join(root, 'collector.py'), '# tampered\n')],
    ['traversal', ({ manifest }) => { manifest.files['../outside'] = '0'.repeat(64); }],
    ['symlink escape', ({ root, manifest }) => {
      fs.symlinkSync(path.join(root, '..'), path.join(root, 'escape'));
      manifest.files.escape = '0'.repeat(64);
    }],
  ];
  for (const [name, mutate] of cases) await t.test(name, async (t) => {
    const { controller, processes, api } = await controllerFixture(t, {
      mutateBundle(files) { mutate(files); files.writeManifest(); },
    });
    assert.equal(controller.status().installed, false);
    assert.equal(controller.status().error.code, 'INVALID_BUNDLE');
    await assert.rejects(controller.snapshot(), errorIs('INVALID_BUNDLE'));
    assert.equal(processes.calls.length, 0);
    assert.equal(api.requests.length, 0);
  });
});

test('loopback collected-state pipeline coalesces, caches cloned state and records a nonsimulated task despite outer mock mode', linux, async (t) => {
  const { controller, processes, api, files } = await controllerFixture(t, { onSpawn: () => {} });
  assert.equal(controller.status().installed, true);
  assert.equal(controller.status().phase, 'idle');
  const started = processes.nextSpawn();
  const first = controller.snapshot();
  const second = controller.snapshot();
  const call = await started;
  assert.equal(controller.status().phase, 'collecting');
  call.succeed();
  const [state, coalesced] = await Promise.all([first, second]);
  assert.deepEqual(state, healthState());
  assert.deepEqual(coalesced, state);
  assert.equal(processes.calls.length, 1);
  assert.equal(api.requests.length, 1);
  const request = api.requests[0];
  assert.equal(request.method, 'POST');
  assert.equal(request.url, '/openapi/v1/collections');
  assert.match(api.token, /^[a-f0-9]{64}$/);
  assert.equal(request.headers.authorization, `Bearer ${api.token}`);
  assert.equal(request.headers['content-type'], 'application/json');
  assert.deepEqual(Object.keys(request.body).sort(), ['device_id', 'operation', 'parameters', 'raw_snapshot', 'request_id', 'schema_version']);
  assert.equal(request.body.device_id, controller.status().device_id);
  assert.equal(request.body.request_id, call.requestId);
  assert.equal(request.body.raw_snapshot.request_id, call.requestId);
  assert.deepEqual(request.body.parameters, { hasGpu: false });
  assert.equal(call.binary, path.join(files.root, 'sysak'));
  const status = controller.status();
  assert.equal(status.phase, 'idle');
  assert.equal(status.error, null);
  assert.deepEqual(status.last_task, {
    id: status.last_task.id, request_id: call.requestId, operation: 'snapshot', status: 'completed',
    profile: 'resources', collection_status: 'ok', raw_bytes: Buffer.byteLength(JSON.stringify(request.body.raw_snapshot)),
    collected_at: timestamp, simulated: false,
  });
  assert.match(status.last_task.id, /^[a-f0-9-]{36}$/);
  state.resources.cpu.rows.push({ id: 'caller-mutation' });
  state.revision = 999;
  const cached = await controller.snapshot();
  assert.deepEqual(cached, healthState());
  cached.resources.cpu.usage = 99;
  assert.equal((await controller.snapshot()).resources.cpu.usage, 12);
  assert.equal(processes.calls.length, 1);
  assert(!JSON.stringify(status).includes(api.token));
  assert.equal(JSON.parse(JSON.stringify(status)).last_task.simulated, false);
  assert.equal(status.mode, 'mock');
  assert.equal(cached.mode, 'collected');
  assert.equal(cached.resources.energy.usage, null);
  assert.deepEqual(cached.resources.energy.quantity, { value: 13, unit: 'W' });
  const view = controller.queryView();
  assert.deepEqual(view.state, healthState());
  assert.deepEqual(view.tasks, [status.last_task]);
  assert.equal(view.agent, null);
  view.state.resources.cpu.usage = 99;
  view.tasks[0].simulated = true;
  assert.equal(controller.queryView().state.resources.cpu.usage, 12);
  assert.equal(controller.queryView().tasks[0].simulated, false);
  assert.equal(processes.calls.length, 1);
  assert.equal(api.requests.length, 1);
});

test('query task history retains only 100 successful metadata records and never includes raw evidence or credentials', linux, async t => {
  const { controller, api } = await controllerFixture(t, { onSpawn: call => call.succeed() });
  for (let i = 0; i < 102; i++) await controller.snapshot(true);
  const view = controller.queryView();
  assert.equal(view.tasks.length, 100);
  assert.equal(view.state.revision, 102);
  assert.equal(view.tasks[0].id, controller.status().last_task.id);
  assert.equal(view.tasks.at(-1).request_id, api.requests[2].body.request_id);
  assert.equal(view.tasks.every(task => task.simulated === false && !Object.hasOwn(task, 'raw_snapshot')), true);
  assert.equal(JSON.stringify(view).includes(api.token), false);
});

test('explicit refresh coalesces and failed refresh preserves cache without poisoning later refreshes', linux, async (t) => {
  let attempt = 0;
  const { controller, processes, api, clock } = await controllerFixture(t, {
    onSpawn(call) {
      if (++attempt === 2) { call.child.stdout.write('{'); call.child.finish(); }
      else call.succeed();
    },
  });
  const initial = await controller.snapshot(false);
  assert.equal(initial.revision, 1);
  clock.advance(6000);
  assert.deepEqual(await controller.snapshot(), initial);
  assert.deepEqual(await controller.snapshot(false), initial);
  assert.equal(processes.calls.length, 1, 'old cache polling must not collect');
  const failed = controller.snapshot(true);
  const mergedFailure = controller.snapshot(true);
  const failures = [failed, mergedFailure].map((pending) => assert.rejects(pending, errorIs('INVALID_COLLECTION', 502, true)));
  assert.deepEqual(await controller.snapshot(false), initial, 'cached reads must not join a forced refresh');
  await Promise.all(failures);
  assert.equal(processes.calls.length, 2, 'concurrent forced refreshes must share one collection');
  assert.equal(controller.status().error.code, 'INVALID_COLLECTION');
  assert.deepEqual(await controller.snapshot(), initial);
  assert.equal(api.requests.length, 1);
  const refreshed = controller.snapshot(true);
  const mergedRefresh = controller.snapshot(true);
  const [next, merged] = await Promise.all([refreshed, mergedRefresh]);
  assert.equal(next.revision, 2);
  assert.deepEqual(merged, next);
  assert.equal((await controller.snapshot(false)).revision, 2);
  assert.equal(processes.calls.length, 3);
  assert.equal(api.requests.length, 2);
  assert.equal(controller.status().error, null);
});

test('disabled collection rejects fresh work, permits cached display and refreshes after re-enable', linux, async (t) => {
  const { controller, processes, api } = await controllerFixture(t);
  assert.throws(() => controller.setEnabled('false'), errorIs('INVALID_PARAMETERS', 400));
  assert.equal(controller.setEnabled(false).phase, 'disabled');
  await assert.rejects(controller.snapshot(), errorIs('COLLECTOR_DISABLED'));
  await assert.rejects(controller.reset(), errorIs('COLLECTOR_DISABLED'));
  await assert.rejects(controller.operation({ operation: 'inspect', parameters: { revision: 1 } }), errorIs('COLLECTOR_DISABLED'));
  assert.equal(processes.calls.length, 0);
  controller.setEnabled(true);
  const initial = await controller.snapshot();
  assert.equal(controller.setEnabled(false).enabled, false);
  assert.deepEqual(await controller.snapshot(), initial);
  await assert.rejects(controller.snapshot(true), errorIs('COLLECTOR_DISABLED'));
  await assert.rejects(controller.operation({ operation: 'inspect', parameters: { revision: initial.revision } }), errorIs('COLLECTOR_DISABLED'));
  assert.equal(processes.calls.length, 1);
  controller.setEnabled(true);
  assert.deepEqual(await controller.snapshot(false), initial, 'resume alone must not invalidate the display cache');
  assert.equal(processes.calls.length, 1);
  assert.equal((await controller.snapshot(true)).revision, 2);
  assert.equal(api.requests.length, 2);
});

test('disable and close cancel an in-flight process and close stops the loopback server', linux, async (t) => {
  for (const action of ['disable', 'close']) await t.test(action, async (t) => {
    const { controller, processes, api } = await controllerFixture(t, { onSpawn: () => {} });
    const started = processes.nextSpawn();
    const pending = controller.snapshot();
    const rejected = assert.rejects(pending, errorIs('COLLECTION_CANCELLED'));
    await started;
    if (action === 'disable') controller.setEnabled(false);
    else await controller.close();
    await rejected;
    assert.equal(controller.status().phase, 'disabled');
    assert.equal(controller.status().enabled, false);
    assert.equal(controller.status().error.code, 'COLLECTION_CANCELLED');
    assert.equal(processes.kills[0].pid, processes.calls[0].child.pid);
    assert.equal(api.requests.length, 0);
    if (action === 'close') {
      assert.equal(api.closed, true);
      assert.throws(() => controller.setEnabled(true), errorIs('COLLECTOR_CLOSED'));
      await assert.rejects(controller.snapshot(), errorIs('COLLECTOR_DISABLED'));
    }
  });
});

test('queued operations serialize collection and HTTP submission, propagate revisions and recover after conflicts', linux, async (t) => {
  const entered = deferred();
  const release = deferred();
  t.after(() => release.resolve());
  let revision = 7;
  const { controller, processes, api } = await controllerFixture(t, {
    async handler(body) {
      if (body.operation === 'inspect') { entered.resolve(); await release.promise; }
      if (body.operation !== 'snapshot') {
        if (body.parameters.revision !== revision) return { status: 409, body: {
          schema_version: '1.0', request_id: body.request_id,
          error: { code: 'revision_conflict', message: 'stale revision', retryable: false },
        } };
        revision++;
      }
      return { body: responseFor(body, healthState(revision)) };
    },
  });
  assert.equal((await controller.snapshot()).revision, 7);
  const inspect = controller.operation({ operation: 'inspect', parameters: { revision: 7 } });
  const staleInspect = controller.operation({ operation: 'inspect', parameters: { revision: 7 } });
  const conflict = assert.rejects(staleInspect, errorIs('revision_conflict', 409));
  const nextInspect = controller.operation({ operation: 'inspect', parameters: { revision: 8 } });
  await entered.promise;
  await turn();
  assert.equal(controller.status().phase, 'submitting');
  assert.equal(processes.calls.length, 2, 'queued operations must not spawn while the first HTTP response is pending');
  assert.equal(api.requests.length, 2);
  release.resolve();
  assert.equal((await inspect).revision, 8);
  await conflict;
  assert.equal((await nextInspect).revision, 9);
  assert.deepEqual(api.requests.map(({ body }) => body.operation), ['snapshot', 'inspect', 'inspect', 'inspect']);
  assert.deepEqual(api.requests.slice(1).map(({ body }) => body.parameters.revision), [7, 7, 8]);
  assert.deepEqual(processes.calls.map(({ profile }) => profile), ['resources', 'inspection', 'inspection', 'inspection']);
  assert.equal(new Set(api.requests.map(({ body }) => body.request_id)).size, 4);
  assert.equal((await controller.snapshot()).revision, 9);
  assert.equal(controller.status().last_task.operation, 'inspect');
  assert.equal(controller.status().last_task.simulated, false);
  assert.equal(controller.status().error, null);
});

test('OpenAPI error code, message, HTTP status and retryability propagate without overwriting cached state', linux, async (t) => {
  const { controller, api } = await controllerFixture(t, {
    handler(body, count) {
      if (count === 1) return { body: responseFor(body, healthState(42)) };
      return { status: 503, body: { schema_version: '1.0', request_id: body.request_id,
        error: { code: 'device_capacity', message: 'mock capacity reached', retryable: true } } };
    },
  });
  await controller.snapshot();
  const task = structuredClone(controller.status().last_task);
  await assert.rejects(controller.operation({ operation: 'inspect', parameters: { revision: 42 } }), (error) => {
    errorIs('device_capacity', 503, true)(error);
    assert.equal(error.message, 'mock capacity reached');
    return true;
  });
  assert.equal(api.requests[1].body.raw_snapshot.collection.profile, 'inspection');
  assert.equal(controller.status().phase, 'error');
  assert.deepEqual(controller.status().error, { code: 'device_capacity', message: 'mock capacity reached' });
  assert.deepEqual(controller.status().last_task, task);
  assert.equal((await controller.snapshot()).revision, 42);
  assert.deepEqual(JSON.parse(JSON.stringify(controller.status())).error, controller.status().error);
});

test('invalid or oversized OpenAPI success responses are rejected', linux, async (t) => {
  const cases = [
    ['schema', (reply) => { reply.schema_version = '2.0'; }],
    ['request ID', (reply) => { reply.request_id = randomUUID(); }],
    ['mode', (reply) => { reply.mode = 'live'; }],
    ['read only', (reply) => { reply.read_only = false; }],
    ['task ID', (reply) => { reply.task_id = 'bad-id'; }],
    ['revision', (reply) => { reply.state.revision = 0; }],
    ['resource', (reply) => { delete reply.state.resources.gpu; }],
    ['rows', (reply) => { reply.state.resources.cpu.rows = {}; }],
    ['usage', (reply) => { reply.state.resources.cpu.usage = '12'; }],
    ['negative usage', (reply) => { reply.state.resources.cpu.usage = -1; }],
    ['invalid units', (reply) => { reply.state.resources.energy.quantity.unit = 'kWh'; }],
    ['negative quantity', (reply) => { reply.state.resources.energy.quantity.value = -1; }],
    ['malformed quantity', (reply) => { reply.state.resources.memory.quantity = { value: '12', unit: 'B' }; }],
    ['negative row', (reply) => { reply.state.resources.cpu.rows = [collectedRow({ usage: -1 })]; }],
    ['invalid row units', (reply) => { reply.state.resources.disk.rows = [collectedRow({ quantity: { value: 1000, unit: 'MB/s' } })]; }],
    ['oversized', (reply) => { reply.padding = 'x'.repeat(MiB); }],
  ];
  for (const [name, mutate] of cases) await t.test(name, async (t) => {
    const { controller } = await controllerFixture(t, {
      handler(body) { const reply = responseFor(body); mutate(reply); return { body: reply }; },
    });
    await assert.rejects(controller.snapshot(), errorIs('INVALID_API_RESPONSE', 502));
    assert.equal(controller.status().last_task, null);
    assert.equal(controller.status().error.code, 'INVALID_API_RESPONSE');
  });
  await t.test('malformed response JSON reports an unavailable API', async (t) => {
    const { controller } = await controllerFixture(t, { handler: () => ({ text: '{' }) });
    await assert.rejects(controller.snapshot(), errorIs('OPENAPI_UNAVAILABLE', 503, true));
  });
  await t.test('unstructured HTTP error uses the documented fallback', async (t) => {
    const { controller } = await controllerFixture(t, { handler: () => ({ status: 500, body: {} }) });
    await assert.rejects(controller.snapshot(), errorIs('OPENAPI_FAILED', 500));
  });
});

test('unsupported operations and invalid reset parameters never reach the collector; reset returns actual collected state and nonsimulated task', linux, async (t) => {
  const { controller, processes, api } = await controllerFixture(t, {
    handler(body, count) { return { body: responseFor(body, healthState(count, false)) }; },
  });
  for (const payload of [null, [], { operation: 'exec', parameters: {} }, { operation: 'snapshot', parameters: {} },
    { operation: 'reset', parameters: {} }, { operation: 'configuration', parameters: {} }, { operation: 'inspect', parameters: [] },
    { operation: 'inspect', parameters: {}, command: 'touch forbidden' },
    { operation: 'inspect', parameters: { padding: 'x'.repeat(8192) } }]) {
    await assert.rejects(controller.operation(payload), errorIs('INVALID_OPERATION', 400));
  }
  for (const parameters of [{ hasGpu: 'yes' }, { command: 'installer' }]) {
    await assert.rejects(controller.reset(parameters), errorIs('INVALID_PARAMETERS', 400));
  }
  assert.equal(processes.calls.length, 0);
  assert.equal(api.requests.length, 0);
  const reset = await controller.reset({ hasGpu: true });
  assert.equal(reset.hasGpu, false, 'controller must accept parser GPU evidence rather than overwrite it with a hint');
  assert.equal(reset.mode, 'collected');
  assert.equal(reset.revision, 1);
  assert.equal(api.requests[0].body.operation, 'reset');
  assert.deepEqual(api.requests[0].body.parameters, { hasGpu: true });
  assert.equal(processes.calls[0].profile, 'resources');
  assert.equal(processes.calls[0].options.shell, false);
  assert.equal(controller.status().last_task.simulated, false);
  assert.equal((await controller.reset()).revision, 2);
  assert.equal((await controller.snapshot()).revision, 2);
});

test('write operations return 409/read_only before any collection or HTTP submission, including without cached state or an installed collector', linux, async (t) => {
  for (const phase of ['cold', 'cached', 'disabled', 'uninstalled']) await t.test(phase, async (t) => {
    const { controller, processes, api, clock } = await controllerFixture(t, {
      ...(phase === 'uninstalled' ? { mutateBundle: ({ root }) => fs.rmSync(path.join(root, 'manifest.json')) } : {}),
    });
    const state = phase === 'cached' ? await controller.snapshot() : null;
    if (phase === 'disabled') controller.setEnabled(false);
    const before = structuredClone(controller.status());
    const timer = clock.pending;
    const calls = processes.calls.length;
    const requests = api.requests.length;
    for (const [operation, parameters] of [
      ['cleanup', { revision: 1, resource: 'cpu', ids: ['process-101-1000'] }],
      ['optimize', { revision: 1, ids: ['opt-1'] }],
      ['sessions-cleanup', { revision: 1, resource: 'disk', agentId: 'agent-coding', sessionIds: ['agent-coding-disk-2'] }],
      ['alert-sample', { revision: 1, target: 'cpu', usage: 96 }],
    ]) {
      await assert.rejects(controller.operation({ operation, parameters }), errorIs('read_only', 409));
      assert.equal(processes.calls.length, calls);
      assert.equal(api.requests.length, requests);
      assert.deepEqual(controller.status(), before);
      assert.deepEqual(clock.pending, timer, 'read-only rejection must not reschedule inspection');
      if (state) assert.deepEqual(await controller.snapshot(), state);
    }
    await assert.rejects(controller.operation({ operation: 'configuration', parameters: {} }), errorIs('INVALID_OPERATION', 400));
    assert.equal(processes.calls.length, calls);
    assert.equal(api.requests.length, requests);
  });
});

test('read_only rejection does not enter the manual queue or block behind an in-flight collection', linux, async (t) => {
  let spawnCount = 0;
  const { controller, processes, api } = await controllerFixture(t, {
    onSpawn(call) { if (++spawnCount > 1) call.succeed(); },
  });
  const started = processes.nextSpawn();
  const pending = controller.snapshot();
  // Always settle the fake child, even when a regression wrongly queues a write.
  const call = await started;
  const writes = ['cleanup', 'optimize', 'sessions-cleanup', 'alert-sample'];
  const outcomes = [];
  const rejections = writes.map((operation) => controller.operation({ operation, parameters: { revision: 1 } })
    .then(() => { outcomes.push({ operation, error: null }); }, (error) => { outcomes.push({ operation, error }); }));
  try {
    await waitFor(() => outcomes.length === writes.length, 'writes must reject immediately, not wait for the collection queue');
    for (const { error } of outcomes) errorIs('read_only', 409)(error);
    assert.equal(controller.status().phase, 'collecting');
    assert.equal(processes.calls.length, 1);
    assert.equal(api.requests.length, 0);
  } finally {
    call.succeed();
    await pending.catch(() => {});
  }
  await Promise.all(rejections);
  assert.equal(api.requests.length, 1);
  assert.equal(controller.status().last_task.operation, 'snapshot');
});

test('OpenAPI real byte/watt/rate quantities and null percentages survive cache cloning and nonsimulated task metadata', linux, async (t) => {
  const expected = quantifiedState();
  for (const resource of Object.values(expected.resources)) for (const row of resource.rows) row.effect = '非进程对象或身份无法核验';
  const { controller, processes, api } = await controllerFixture(t, {
    handler(body) { return { body: responseFor(body, structuredClone(expected)) }; },
  });
  const state = await controller.snapshot();
  assert.deepEqual(state, expected);
  assert.equal(controller.status().mode, 'mock');
  assert.equal(state.mode, 'collected');
  assert.equal(controller.status().last_task.simulated, false);
  state.resources.memory.quantity.value = 0;
  state.resources.disk.rows[0].quantity.value = 0;
  assert.deepEqual(await controller.snapshot(), expected);
  assert.equal(processes.calls.length, 1);
  assert.equal(api.requests.length, 1);
});

test('inspection interval defaults to five minutes and accepts both integer boundaries without collecting', linux, async (t) => {
  for (const minutes of [undefined, 1, 1440]) await t.test(String(minutes ?? 'default'), async (t) => {
    const options = minutes === undefined ? {} : { inspectionIntervalMinutes: minutes };
    const { controller, processes, api, clock } = await controllerFixture(t, options);
    const expected = minutes ?? 5;
    assert.equal(controller.status().inspection_interval_minutes, expected);
    scheduledIn(controller, clock, expected);
    assert.equal(controller.status().last_task, null);
    assert.equal(processes.calls.length, 0);
    assert.equal(api.requests.length, 0);
  });
  const { controller, processes, api, clock } = await controllerFixture(t);
  for (const minutes of [1, 1440]) {
    clock.advance(1234);
    const status = controller.setInspectionInterval(minutes);
    assert.equal(typeof status?.then, 'undefined', 'interval setter must return status synchronously');
    assert.deepEqual(status, controller.status());
    assert.equal(status.inspection_interval_minutes, minutes);
    scheduledIn(controller, clock, minutes);
  }
  assert.equal(processes.calls.length, 0, 'saving scheduling options must never collect');
  assert.equal(api.requests.length, 0);
});

test('invalid initial inspection intervals are rejected before any collector or HTTP work', linux, async (t) => {
  const files = bundle(t);
  const processes = fakeProcesses(() => assert.fail('invalid options must not spawn'));
  let starts = 0;
  const startMockOpenApi = async () => { starts++; assert.fail('invalid options must not start the API'); };
  const clock = fakeClock();
  for (const minutes of ['5', 1.5, 0, -1, 1441, NaN, Infinity, null, false]) {
    await assert.rejects(createIdcController({ bundleRoot: files.root, startMockOpenApi,
      ...processes, scheduler: clock.scheduler, inspectionIntervalMinutes: minutes }),
    errorIs('INVALID_INSPECTION_INTERVAL', 400));
  }
  assert.equal(starts, 0);
  assert.equal(processes.calls.length, 0);
  assert.equal(clock.pending.length, 0);
});

test('invalid interval values fail with 400 and leave settings, timer and cache unchanged', linux, async (t) => {
  const settingsPath = path.join(bundle(t).root, 'idc-settings.json');
  const { controller, processes, api, clock } = await controllerFixture(t, { settingsPath });
  const state = await controller.snapshot();
  controller.setInspectionInterval(1);
  const saved = fs.readFileSync(settingsPath, 'utf8');
  const before = controller.status();
  const timer = clock.pending[0];
  const invalid = ['1', '1440', '', 1.5, 0, -1, 1441, NaN, Infinity, undefined, null, true, {}, []];
  for (const value of invalid) {
    assert.throws(() => controller.setInspectionInterval(value), errorIs('INVALID_INSPECTION_INTERVAL', 400));
    assert.equal(controller.status().inspection_interval_minutes, 1);
    assert.equal(controller.status().next_inspection_at, before.next_inspection_at);
    assert.deepEqual(clock.pending, [timer]);
    assert.equal(fs.readFileSync(settingsPath, 'utf8'), saved);
    assert.deepEqual(await controller.snapshot(false), state);
  }
  assert.equal(processes.calls.length, 1);
  assert.equal(api.requests.length, 1);
});

test('inspection interval persists across restarts with the exact settings shape and no extra collection', linux, async (t) => {
  const settingsPath = path.join(bundle(t).root, 'idc-settings.json');
  const first = await controllerFixture(t, { settingsPath });
  assert.equal(first.controller.status().error, null, 'a missing settings file is not corrupt');
  first.controller.setInspectionInterval(1440);
  assert.deepEqual(JSON.parse(fs.readFileSync(settingsPath, 'utf8')), { inspection_interval_minutes: 1440 });
  await first.controller.close();
  const second = await controllerFixture(t, { settingsPath, inspectionIntervalMinutes: 1 });
  assert.equal(second.controller.status().inspection_interval_minutes, 1440);
  scheduledIn(second.controller, second.clock, 1440);
  second.controller.setInspectionInterval(1);
  assert.deepEqual(JSON.parse(fs.readFileSync(settingsPath, 'utf8')), { inspection_interval_minutes: 1 });
  await second.controller.close();
  const third = await controllerFixture(t, { settingsPath });
  assert.equal(third.controller.status().inspection_interval_minutes, 1);
  scheduledIn(third.controller, third.clock, 1);
  for (const fixture of [first, second, third]) {
    assert.equal(fixture.processes.calls.length, 0, 'persisting and loading settings must not spawn');
    assert.equal(fixture.api.requests.length, 0);
  }
});

test('corrupt or unreadable persisted settings report SETTINGS_LOAD_FAILED and schedule the default', linux, async (t) => {
  const cases = ['{', 'null', '[]', '{}', '{"inspection_interval_minutes":"1"}',
    '{"inspection_interval_minutes":1.5}', '{"inspection_interval_minutes":0}',
    '{"inspection_interval_minutes":1441}', 'directory'];
  for (const contents of cases) await t.test(contents, async (t) => {
    const settingsPath = path.join(bundle(t).root, 'idc-settings.json');
    if (contents === 'directory') fs.mkdirSync(settingsPath);
    else fs.writeFileSync(settingsPath, contents);
    const { controller, processes, api, clock } = await controllerFixture(t, { settingsPath });
    assert.equal(controller.status().inspection_interval_minutes, 5);
    assert.equal(controller.status().error.code, 'SETTINGS_LOAD_FAILED');
    scheduledIn(controller, clock, 5);
    if (contents !== 'directory') assert.equal(fs.readFileSync(settingsPath, 'utf8'), contents);
    assert.equal(processes.calls.length, 0);
    assert.equal(api.requests.length, 0);
  });
});

test('failed settings save leaves the previous interval, deadline, persisted value and cache intact', linux, async (t) => {
  const root = bundle(t).root;
  const parent = path.join(root, 'settings');
  fs.mkdirSync(parent);
  const settingsPath = path.join(parent, 'idc-settings.json');
  fs.writeFileSync(settingsPath, JSON.stringify({ inspection_interval_minutes: 1 }));
  const { controller, processes, api, clock } = await controllerFixture(t, { settingsPath });
  const cached = await controller.snapshot();
  clock.advance(1000);
  const before = controller.status();
  const timer = clock.pending[0];
  // ENOTDIR is deterministic even when the tests run as root (chmod is not).
  const backup = path.join(root, 'saved-settings');
  fs.renameSync(parent, backup);
  fs.writeFileSync(parent, 'not a directory');
  assert.throws(() => controller.setInspectionInterval(1440), errorIs('SETTINGS_SAVE_FAILED', 500));
  assert.equal(controller.status().inspection_interval_minutes, 1);
  assert.equal(controller.status().next_inspection_at, before.next_inspection_at);
  assert.deepEqual(clock.pending, [timer]);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(backup, 'idc-settings.json'), 'utf8')),
    { inspection_interval_minutes: 1 });
  assert.deepEqual(await controller.snapshot(false), cached);
  assert.equal(processes.calls.length, 1, 'failed settings save must not collect');
  assert.equal(api.requests.length, 1);
});

test('first scheduled inspection initializes a missing snapshot then spawns inspection and submits the current revision', linux, async (t) => {
  const { controller, processes, api, clock } = await controllerFixture(t, {
    handler(body, count) { return { body: responseFor(body, healthState(40 + count)) }; },
  });
  clock.advance(5 * minute - 1);
  await turn();
  assert.equal(processes.calls.length, 0);
  clock.advance(1);
  await autoFinished(controller, clock);
  assert.deepEqual(processes.calls.map(({ profile }) => profile), ['resources', 'inspection']);
  assert.deepEqual(api.requests.map(({ body }) => body.operation), ['snapshot', 'inspect']);
  assert.deepEqual(api.requests[0].body.parameters, { hasGpu: false });
  assert.deepEqual(api.requests[1].body.parameters, { revision: 41 });
  assert.equal(api.requests[1].body.raw_snapshot.collection.profile, 'inspection');
  assert.equal(api.requests[1].body.request_id, processes.calls[1].requestId);
  assert.equal((await controller.snapshot(false)).revision, 42);
  assert.deepEqual(Object.keys(controller.status().last_task).sort(),
    ['id', 'request_id', 'operation', 'status', 'profile', 'collection_status', 'raw_bytes', 'collected_at', 'simulated'].sort());
  scheduledIn(controller, clock, 5);
});

test('old cache polls stay cloned and never spawn until the independent inspection deadline', linux, async (t) => {
  const { controller, processes, api, clock } = await controllerFixture(t, { inspectionIntervalMinutes: 1 });
  const initial = await controller.snapshot();
  for (const elapsed of [6000, 20000, 33999]) {
    clock.advance(elapsed);
    const cached = await controller.snapshot(false);
    assert.deepEqual(cached, initial);
    cached.resources.cpu.usage = 99;
    assert.deepEqual(await controller.snapshot(), initial);
    assert.equal(processes.calls.length, 1);
    assert.equal(api.requests.length, 1);
  }
  clock.advance(1);
  await autoFinished(controller, clock);
  assert.deepEqual(processes.calls.map(({ profile }) => profile), ['resources', 'inspection']);
  assert.deepEqual(api.requests[1].body.parameters, { revision: initial.revision });
  assert.equal((await controller.snapshot(false)).revision, 2);
  scheduledIn(controller, clock, 1);
});

test('changing the interval restarts from now and invalidates even an already-delivered old timer callback', linux, async (t) => {
  const { controller, processes, api, clock } = await controllerFixture(t);
  await controller.snapshot();
  const obsolete = clock.pending[0];
  clock.advance(2 * minute);
  controller.setInspectionInterval(1);
  scheduledIn(controller, clock, 1);
  obsolete.fn();
  await turn();
  await turn();
  assert.equal(processes.calls.length, 1);
  assert.equal(api.requests.length, 1, 'interval change must not submit an inspection');
  scheduledIn(controller, clock, 1);
  clock.advance(minute - 1);
  await turn();
  assert.equal(processes.calls.length, 1);
  clock.advance(1);
  await autoFinished(controller, clock);
  assert.equal(processes.calls.length, 2);
  assert.equal(api.requests[1].body.operation, 'inspect');
  scheduledIn(controller, clock, 1);
  const prior = clock.pending[0];
  clock.advance(1000);
  controller.setInspectionInterval(1);
  scheduledIn(controller, clock, 1);
  assert.notEqual(clock.pending[0].handle, prior.handle, 'setting the same interval also restarts its deadline');
});

test('pause and close cancel timers, resume starts a full period, and paused settings never collect', linux, async (t) => {
  const { controller, processes, api, clock } = await controllerFixture(t, { inspectionIntervalMinutes: 1 });
  const original = clock.pending[0];
  clock.advance(15000);
  const paused = controller.setEnabled(false);
  assert.equal(paused.next_inspection_at, null);
  assert.equal(clock.pending.length, 0);
  clock.advance(20 * minute);
  original.fn();
  await turn();
  assert.equal(processes.calls.length, 0);
  const intervalStatus = controller.setInspectionInterval(2);
  assert.equal(intervalStatus.inspection_interval_minutes, 2);
  assert.equal(intervalStatus.next_inspection_at, null);
  assert.equal(clock.pending.length, 0, 'saving a paused interval must not arm a timer');
  controller.setEnabled(true);
  scheduledIn(controller, clock, 2);
  assert.equal(processes.calls.length, 0, 'resume must not collect immediately');
  const resumed = clock.pending[0];
  await controller.close();
  assert.equal(controller.status().next_inspection_at, null);
  assert.equal(clock.pending.length, 0);
  clock.advance(20 * minute);
  resumed.fn();
  await turn();
  assert.equal(processes.calls.length, 0);
  assert.equal(api.requests.length, 0);
  assert.equal(api.closed, true);
});

test('a late timer callback from before pause cannot erase or revive the resumed schedule', linux, async (t) => {
  const { controller, processes, api, clock } = await controllerFixture(t, { inspectionIntervalMinutes: 1 });
  const obsolete = clock.pending[0];
  controller.setEnabled(false);
  clock.advance(10000);
  controller.setEnabled(true);
  scheduledIn(controller, clock, 1);
  obsolete.fn();
  await turn();
  assert.equal(processes.calls.length, 0, 'an obsolete callback must not start collection');
  assert.equal(api.requests.length, 0);
  scheduledIn(controller, clock, 1);
  await controller.close();
  assert.equal(clock.pending.length, 0, 'close must still be able to cancel the resumed timer');
});

test('pause cancels an active automatic collection and resume preserves cache until the new deadline', linux, async (t) => {
  const { controller, processes, api, clock } = await controllerFixture(t, {
    inspectionIntervalMinutes: 1,
    onSpawn(call) { if (call.profile === 'resources') call.succeed(); },
  });
  const initial = await controller.snapshot();
  clock.advance(minute);
  await waitFor(() => processes.calls.length === 2, 'automatic inspection must spawn');
  assert.equal(processes.calls[1].profile, 'inspection');
  controller.setEnabled(false);
  await waitFor(() => controller.status().error?.code === 'COLLECTION_CANCELLED', 'pause must cancel the active collection');
  assert.equal(processes.kills[0].pid, processes.calls[1].child.pid);
  assert.equal(controller.status().next_inspection_at, null);
  assert.equal(clock.pending.length, 0);
  assert.equal(api.requests.length, 1);
  clock.advance(10 * minute);
  controller.setEnabled(true);
  scheduledIn(controller, clock, 1);
  assert.deepEqual(await controller.snapshot(false), initial);
  assert.equal(processes.calls.length, 2, 'resume and cached reads must not spawn');
  clock.advance(minute - 1);
  await turn();
  assert.equal(processes.calls.length, 2);
  clock.advance(1);
  await waitFor(() => processes.calls.length === 3, 'resumed timer must start a new inspection');
  processes.calls[2].succeed();
  await autoFinished(controller, clock);
  assert.deepEqual(api.requests[1].body.parameters, { revision: initial.revision });
});

test('slow automatic collection and HTTP submission never overlap or accumulate missed inspection periods', linux, async (t) => {
  const entered = deferred();
  const release = deferred();
  t.after(() => release.resolve());
  const { controller, processes, api, clock } = await controllerFixture(t, {
    inspectionIntervalMinutes: 1,
    onSpawn(call) { if (call.profile === 'resources') call.succeed(); },
    async handler(body, count) {
      if (count === 2) { entered.resolve(); await release.promise; }
      return { body: responseFor(body, healthState(count)) };
    },
  });
  await controller.snapshot();
  clock.advance(minute);
  await waitFor(() => processes.calls.length === 2, 'automatic inspection must spawn');
  clock.advance(10 * minute);
  await turn();
  assert.equal(processes.calls.length, 2);
  assert.equal(api.requests.length, 1);
  assert.equal(clock.pending.length, 0, 'there must be no periodic timer while automatic work is collecting');
  assert.deepEqual(processes.kills, [], 'scheduler time must not advance collectRaw timeouts');
  processes.calls[1].succeed();
  await entered.promise;
  clock.advance(10 * minute);
  await turn();
  assert.equal(processes.calls.length, 2);
  assert.equal(api.requests.length, 2);
  assert.equal(controller.status().phase, 'submitting', 'scheduler time must not advance HTTP timeouts');
  assert.equal(clock.pending.length, 0);
  release.resolve();
  await autoFinished(controller, clock);
  scheduledIn(controller, clock, 1);
  await turn();
  assert.equal(processes.calls.length, 2, 'completion must not drain a backlog of missed inspections');
  clock.advance(minute - 1);
  await turn();
  assert.equal(processes.calls.length, 2);
  clock.advance(1);
  await waitFor(() => processes.calls.length === 3, 'the next full interval must trigger exactly one inspection');
  processes.calls[2].succeed();
  await autoFinished(controller, clock);
  assert.equal(api.requests.length, 3);
});

test('automatic raw and HTTP failures retain cached state and last_task, then rearm and recover', linux, async (t) => {
  for (const failure of ['raw', 'http']) await t.test(failure, async (t) => {
    let spawnCount = 0;
    const { controller, processes, api, clock } = await controllerFixture(t, {
      inspectionIntervalMinutes: 1,
      onSpawn(call) {
        if (++spawnCount === 2 && failure === 'raw') { call.child.stdout.write('{'); call.child.finish(); }
        else call.succeed();
      },
      handler(body, count) {
        if (count === 2 && failure === 'http') return { status: 503, body: {
          schema_version: '1.0', request_id: body.request_id,
          error: { code: 'device_capacity', message: 'temporary mock capacity', retryable: true },
        } };
        return { body: responseFor(body, healthState(body.operation === 'snapshot' ? 7 : 8)) };
      },
    });
    const cached = await controller.snapshot();
    const task = structuredClone(controller.status().last_task);
    clock.advance(minute);
    const code = failure === 'raw' ? 'INVALID_COLLECTION' : 'device_capacity';
    await waitFor(() => controller.status().error?.code === code && clock.pending.length === 1,
      'automatic failure must be reported and its next timer armed');
    assert.deepEqual(await controller.snapshot(false), cached);
    assert.deepEqual(controller.status().last_task, task);
    scheduledIn(controller, clock, 1);
    assert.equal(processes.calls.length, 2);
    assert.equal(api.requests.length, failure === 'raw' ? 1 : 2);
    clock.advance(minute);
    await autoFinished(controller, clock);
    assert.equal(processes.calls.length, 3);
    assert.equal((await controller.snapshot(false)).revision, 8);
    assert.equal(controller.status().error, null);
    assert(api.requests.slice(1).every(({ body }) => body.operation === 'inspect' && body.parameters.revision === 7));
    scheduledIn(controller, clock, 1);
  });
});

test('queued automatic inspection shares the manual queue and reads the latest revision only when it executes', linux, async (t) => {
  const entered = deferred();
  const release = deferred();
  t.after(() => release.resolve());
  let revision = 7;
  const { controller, processes, api, clock } = await controllerFixture(t, {
    inspectionIntervalMinutes: 1,
    async handler(body, count) {
      if (count === 2) { entered.resolve(); await release.promise; }
      if (body.operation !== 'snapshot') {
        if (body.parameters.revision !== revision) return { status: 409, body: {
          schema_version: '1.0', request_id: body.request_id,
          error: { code: 'revision_conflict', message: 'stale queued revision', retryable: false },
        } };
        revision++;
      }
      return { body: responseFor(body, healthState(revision)) };
    },
  });
  await controller.snapshot();
  const manual = controller.operation({ operation: 'inspect', parameters: { revision: 7 } });
  await entered.promise;
  const queuedInspect = controller.operation({ operation: 'inspect', parameters: { revision: 8 } });
  clock.advance(minute);
  await turn();
  clock.advance(5 * minute);
  await turn();
  assert.equal(processes.calls.length, 2);
  assert.equal(api.requests.length, 2, 'automatic jobs must not bypass a manual HTTP submission');
  assert.equal(clock.pending.length, 0, 'a queued automatic job must not accumulate another timer');
  release.resolve();
  assert.equal((await manual).revision, 8);
  assert.equal((await queuedInspect).revision, 9);
  await autoFinished(controller, clock);
  assert.deepEqual(api.requests.map(({ body }) => body.operation), ['snapshot', 'inspect', 'inspect', 'inspect']);
  assert.deepEqual(api.requests.slice(1).map(({ body }) => body.parameters.revision), [7, 8, 9]);
  assert.deepEqual(processes.calls.map(({ profile }) => profile), ['resources', 'inspection', 'inspection', 'inspection']);
  assert.equal((await controller.snapshot()).revision, 10);
  scheduledIn(controller, clock, 1);
});

test('interval changes, pause/resume and close invalidate an automatic job already queued behind manual collection', linux, async (t) => {
  for (const action of ['interval', 'pause/resume', 'close']) await t.test(action, async (t) => {
    const { controller, processes, api, clock } = await controllerFixture(t, {
      inspectionIntervalMinutes: 1,
      onSpawn(call) { if (call.profile === 'resources') call.succeed(); },
    });
    await controller.snapshot();
    const started = processes.nextSpawn();
    const manual = controller.operation({ operation: 'inspect', parameters: { revision: 1 } });
    const outcome = action === 'interval' ? manual : assert.rejects(manual, errorIs('COLLECTION_CANCELLED'));
    const call = await started;
    clock.advance(minute);
    await turn();
    assert.equal(processes.calls.length, 2);
    assert.equal(clock.pending.length, 0);
    if (action === 'interval') {
      controller.setInspectionInterval(2);
      scheduledIn(controller, clock, 2);
      call.succeed();
    } else if (action === 'pause/resume') {
      controller.setEnabled(false);
      await outcome;
      controller.setEnabled(true);
      scheduledIn(controller, clock, 1);
    } else await controller.close();
    await outcome;
    await turn();
    await turn();
    assert.equal(processes.calls.length, 2, 'the obsolete queued inspection must never spawn');
    assert.equal(api.requests.length, action === 'interval' ? 2 : 1);
    if (action === 'close') {
      assert.equal(clock.pending.length, 0);
      assert.equal(controller.status().next_inspection_at, null);
      assert.equal(api.closed, true);
    } else {
      const minutes = action === 'interval' ? 2 : 1;
      scheduledIn(controller, clock, minutes);
      clock.advance(minutes * minute);
      await waitFor(() => processes.calls.length === 3, 'only the replacement timer may start a new inspection');
      processes.calls[2].succeed();
      await autoFinished(controller, clock);
      assert.equal(api.requests.at(-1).body.parameters.revision, action === 'interval' ? 2 : 1);
      scheduledIn(controller, clock, minutes);
    }
  });
});
