const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { createHash, randomUUID } = require('node:crypto');
const ts = require('typescript');
const { runProcessAction } = require('../electron/process-control.cjs');
const { CollectorError, createIdcController } = require('../electron/idc-controller.cjs');

// Match the existing health-score tests without generating compiled files.
require.extensions['.ts'] = (module, filename) => {
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
    fileName: filename,
  });
  module._compile(output.outputText, filename);
};
require.extensions['.tsx'] = require.extensions['.ts'];
const { recognizeAgent, collectedRankingRows } = require('../src/health-data.ts');
const { parseCollectedState } = require('../collected-state.ts');

const timestamp = '2026-11-01T12:34:56.000Z';
const linux = { skip: process.platform !== 'linux', timeout: 5000 };
const identities = [{ pid: 900101, starttime: 1000 }, { pid: 900202, starttime: 2000 }];
// Service verification is bypassed only for legacy launch-injection tests; launches/signals stay mocked.
const launchImpl = (binary, args, opts, spawnImpl) => spawnImpl(binary, args, opts);
const verifyExecutionImpl = () => {};
const rowId = ({ pid, starttime }) => `process-${pid}-${starttime}`;
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function errorIs(code, status = 409) {
  return error => {
    assert(error instanceof CollectorError);
    assert.equal(error.code, code);
    assert.equal(error.status, status);
    return true;
  };
}
function resultsFor(action, targets, status = action === 'check' ? 'eligible' : 'signalled') {
  return targets.map(target => ({ ...target, name: `checked-${target.pid}`, status,
    eligible: status === 'eligible' || status === 'signalled', reason: `fixture-${status}` }));
}
function replyFor(action, targets = identities) {
  return { schema_version: '1.0', action, results: resultsFor(action, targets) };
}

// No real spawn, process.kill, or pidfd operation is reachable through these mocks.
function fakeChild(kills = []) {
  const child = new EventEmitter();
  child.pid = 990001;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const input = [];
  child.stdin.on('data', chunk => input.push(chunk));
  child.input = () => Buffer.concat(input).toString('utf8');
  let finished = false;
  child.finish = (code = 0) => {
    if (finished) return;
    finished = true;
    child.stdout.end();
    child.stderr.end();
    setImmediate(() => child.emit('close', code));
  };
  child.kill = signal => { kills.push(signal); child.finish(null); return true; };
  return child;
}
function actionFixture(t, onSpawn, action = 'check', targets = identities, managerPid) {
  const calls = [];
  const kills = [];
  const child = fakeChild(kills);
  t.after(() => child.finish(null));
  const binary = path.join(os.tmpdir(), 'inert sysak; $(never-execute)');
  const spawnImpl = (file, argv, options) => {
    calls.push({ file, argv, options });
    setImmediate(() => onSpawn(child));
    return child;
  };
  return { child, calls, kills, binary, run: () => runProcessAction(binary, action, targets,
    { spawnImpl, launchImpl, ...(managerPid === undefined ? {} : { managerPid }) }) };
}

test('process action fixes argv/shell/environment and sends ordered identities plus manager PID only through JSON stdin', async t => {
  for (const action of ['check', 'terminate']) await t.test(action, async t => {
    const targets = [...identities].reverse();
    const reply = replyFor(action, targets);
    reply.results[0].name = 'Qoder 汉字; $(not-a-command)\n"quoted"';
    const fixture = actionFixture(t, child => {
      assert.equal(child.stdin.writableEnded, true);
      assert.deepEqual(JSON.parse(child.input()), { manager_pid: 990099, targets });
      // Even JSON-looking/private stderr must not enter the stdout protocol.
      child.stderr.write('{"schema_version":"bad"} private stderr');
      child.stdin.emit('error', new Error('EPIPE fixture'));
      const bytes = Buffer.from(JSON.stringify(reply));
      for (let i = 0; i < bytes.length; i++) child.stdout.write(bytes.subarray(i, i + 1));
      child.finish();
    }, action, targets, 990099);
    assert.deepEqual(await fixture.run(), reply.results);
    assert.equal(fixture.calls.length, 1);
    assert.deepEqual(fixture.calls[0], { file: fixture.binary, argv: ['idc', '--process-action', action], options: {
      cwd: os.tmpdir(), shell: false, stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8', PYTHONDONTWRITEBYTECODE: '1' },
    } });
    assert.deepEqual(fixture.kills, []);
  });
  const fixture = actionFixture(t, child => { child.stdout.write(JSON.stringify(replyFor('check'))); child.finish(); });
  await fixture.run();
  assert.equal(JSON.parse(fixture.child.input()).manager_pid, process.pid);
});

test('process-action protocol fails closed on invalid envelopes, identity/order, types and eligibility/status contradictions', async t => {
  const mutations = [
    ['truncated JSON', () => '{'], ['null', () => 'null'], ['array', () => '[]'],
    ['two JSON documents', reply => JSON.stringify(reply) + JSON.stringify(reply)],
    ['schema missing', reply => { delete reply.schema_version; }],
    ['schema version', reply => { reply.schema_version = '2.0'; }],
    ['wrong action', reply => { reply.action = reply.action === 'check' ? 'terminate' : 'check'; }],
    ['missing results', reply => { delete reply.results; }],
    ['results not array', reply => { reply.results = {}; }],
    ['too few results', reply => { reply.results.pop(); }],
    ['too many results', reply => { reply.results.push(reply.results[0]); }],
    ['reordered results', reply => { reply.results.reverse(); }],
    ['duplicate result identity', reply => { reply.results[1] = reply.results[0]; }],
    ['null result', reply => { reply.results[0] = null; }],
    ['PID mismatch', reply => { reply.results[0].pid++; }],
    ['PID string', reply => { reply.results[0].pid = String(reply.results[0].pid); }],
    ['starttime mismatch', reply => { reply.results[0].starttime++; }],
    ['starttime string', reply => { reply.results[0].starttime = String(reply.results[0].starttime); }],
    ['missing starttime', reply => { delete reply.results[0].starttime; }],
    ['eligible missing', reply => { delete reply.results[0].eligible; }],
    ['eligible string', reply => { reply.results[0].eligible = 'true'; }],
    ['eligible number', reply => { reply.results[0].eligible = 1; }],
    ['successful status but ineligible', reply => { reply.results[0].eligible = false; }],
    ['protected but eligible', reply => { reply.results[0].status = 'protected'; }],
    ['unknown status', reply => { reply.results[0].status = 'terminated'; }],
    ['opposite action status', reply => { reply.results[0].status = reply.action === 'check' ? 'signalled' : 'eligible'; }],
    ['name missing', reply => { delete reply.results[0].name; }],
    ['name not string', reply => { reply.results[0].name = 1; }],
    ['reason missing', reply => { delete reply.results[0].reason; }],
    ['reason not string', reply => { reply.results[0].reason = null; }],
  ];
  for (const action of ['check', 'terminate']) for (const [name, mutate] of mutations) {
    await t.test(`${action}: ${name}`, async t => {
      const fixture = actionFixture(t, child => {
        const reply = replyFor(action);
        const text = mutate(reply);
        child.stdout.write(typeof text === 'string' ? text : JSON.stringify(reply));
        child.finish();
      }, action);
      await assert.rejects(fixture.run(), /sysAK 返回无效的进程操作结果/);
      assert.deepEqual(fixture.kills, []);
    });
  }
});

test('each allowed check/terminate status preserves ordered, authoritative per-process outcomes', async t => {
  for (const action of ['check', 'terminate']) {
    for (const status of [action === 'check' ? 'eligible' : 'signalled', 'protected', 'permission_denied', 'stale', 'gone', 'unsupported']) {
      await t.test(`${action}: ${status}`, async t => {
        const reply = replyFor(action);
        reply.results = resultsFor(action, identities, status);
        const fixture = actionFixture(t, child => { child.stdout.write(JSON.stringify(reply)); child.finish(); }, action);
        assert.deepEqual(await fixture.run(), reply.results);
      });
    }
  }
});

test('process-action stdout limit is byte-based: 65536 accepted, one extra byte rejected and fake child terminated', async t => {
  const reply = replyFor('check');
  reply.results[0].reason = '';
  const padding = 65536 - Buffer.byteLength(JSON.stringify(reply));
  reply.results[0].reason = '汉'.repeat(Math.floor(padding / 3)) + 'x'.repeat(padding % 3);
  const bytes = Buffer.from(JSON.stringify(reply));
  assert.equal(bytes.length, 65536);
  const exact = actionFixture(t, child => {
    child.stdout.write(bytes.subarray(0, 32000));
    child.stdout.write(bytes.subarray(32000));
    child.finish();
  });
  assert.deepEqual(await exact.run(), reply.results);
  assert.deepEqual(exact.kills, []);
  const oversized = actionFixture(t, child => { child.stdout.write(bytes); child.stdout.write(Buffer.from(' ')); });
  await assert.rejects(oversized.run(), /响应超过限制/);
  assert.deepEqual(oversized.kills, ['SIGTERM']);
});

test('process-action fifteen-second deadline kills only a fake child and rejects even a later successful close', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const fixture = actionFixture(t, () => {});
  // Simulate an uncooperative child that closes successfully after the deadline.
  fixture.child.kill = signal => { fixture.kills.push(signal); return true; };
  const pending = fixture.run();
  const rejected = assert.rejects(pending, /进程操作超时，结果可能不完整/);
  t.mock.timers.tick(14999);
  assert.deepEqual(fixture.kills, []);
  t.mock.timers.tick(1);
  assert.deepEqual(fixture.kills, ['SIGTERM']);
  await rejected;
  fixture.child.stdout.write(JSON.stringify(replyFor('check')));
  fixture.child.finish(0);
  assert.deepEqual(fixture.kills, ['SIGTERM']);
});

test('spawn errors, synchronous spawn failure and nonzero/signal exits never accept stdout or expose stderr', async t => {
  await t.test('asynchronous spawn error', async t => {
    const fixture = actionFixture(t, child => { child.emit('error', new Error('private ENOENT')); child.finish(-1); });
    await assert.rejects(fixture.run(), /^Error: 无法启动 sysAK 进程操作$/);
    assert.deepEqual(fixture.kills, []);
  });
  await t.test('synchronous spawn throw becomes a rejection', async () => {
    const error = new Error('spawn fixture rejected');
    await assert.rejects(runProcessAction('/never-run-sysak', 'check', identities, { launchImpl, spawnImpl() { throw error; } }), error);
  });
  for (const code of [1, 2, null]) await t.test(`exit ${code}`, async t => {
    const fixture = actionFixture(t, child => {
      child.stdout.write(JSON.stringify(replyFor('check')));
      child.stderr.write('private failure details');
      child.finish(code);
    });
    await assert.rejects(fixture.run(), /^Error: sysAK 进程操作不可用$/);
  });
  for (const [code, message] of [
    [126, 'sysAK IDC 服务身份或组件校验失败'],
    [127, 'sysAK IDC 服务身份或组件校验失败'],
    [75, 'sysAK IDC 服务忙，请稍后重试'],
  ]) await t.test(`service exit ${code}`, async t => {
    const fixture = actionFixture(t, child => {
      child.stdout.write(JSON.stringify(replyFor('check')));
      child.stderr.write('private service details');
      child.finish(code);
    });
    await assert.rejects(fixture.run(), error => {
      assert.equal(error.message, message);
      assert.doesNotMatch(error.message, /pkexec|sudo|private/);
      return true;
    });
    assert.equal(fixture.calls.length, 1, 'service failure must not retry via a user process');
    assert.deepEqual(fixture.kills, []);
  });
  await t.test('completed action clears its timeout', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const fixture = actionFixture(t, child => { child.stdout.write(JSON.stringify(replyFor('check'))); child.finish(); });
    await fixture.run();
    t.mock.timers.tick(10000);
    assert.deepEqual(fixture.kills, []);
  });
  await t.test('spawn error clears its timeout', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const fixture = actionFixture(t, child => { child.emit('error', new Error('fixture')); child.finish(-1); });
    await assert.rejects(fixture.run(), /无法启动/);
    t.mock.timers.tick(10000);
    assert.deepEqual(fixture.kills, []);
  });
});

// Raw/API fixtures follow idc-controller.test.cjs; every child and action is injected.
function rawSnapshot(profile, requestId, targets = identities) {
  return {
    schema_version: '1.0', request_id: requestId, collected_at: timestamp,
    collector: { name: 'sysak', version: '1.0', permissions: { status: 'granted', elevated: false, denied: [] } },
    collection: { profile, status: 'ok', started_at: timestamp, finished_at: timestamp },
    capabilities: { read_only: true }, device: { hostname: 'fixture-only' },
    resources: {
      cpu: [
        { status: 'ok', content: 'cpu 100 0 0 900 0 0 0 0\n' },
        { status: 'ok', content: 'cpu 112 0 0 988 0 0 0 0\n' },
      ],
      gpu: { status: 'ok', content: '' },
      meminfo: { status: 'ok', content: 'MemTotal: 1000 kB\nMemAvailable: 880 kB\n' },
      processes: { status: 'ok', content: { samples: [{ processes: targets }, { processes: targets }] } },
    }, configuration: {}, diagnostics: {},
  };
}
function collectedRow(target = identities[0], extra = {}) {
  return { id: rowId(target), ...target, name: 'untrusted-api-name', detail: `PID ${target.pid}`, usage: 12,
    cleanable: true, defaultSelected: true, effect: 'untrusted-api-effect', ...extra };
}
function healthState(revision = 1) {
  return { mode: 'collected', hasGpu: false, revision, sampledAt: timestamp,
    resources: Object.fromEntries(['cpu', 'energy', 'memory', 'disk', 'gpu'].map(id => [id, {
      id, label: id, usage: id === 'energy' || id === 'gpu' ? null : 12, capacity: null,
      unit: id === 'energy' ? 'W' : '%', source: 'sysak', rows: [],
    }])), inspections: [], optimizations: [], operations: [] };
}
function processState(revision = 1, targets = identities) {
  const state = healthState(revision);
  for (const id of ['cpu', 'memory', 'disk']) state.resources[id].rows = targets.map(target => collectedRow(target));
  return state;
}
function responseFor(body, state) {
  const taskId = randomUUID();
  return { schema_version: '1.0', request_id: body.request_id, task_id: taskId, mode: 'mock', read_only: true, state,
    task: { id: taskId, operation: body.operation, status: 'completed', simulated: false, read_only: true } };
}
function fakeClock() {
  let now = Date.parse(timestamp);
  let sequence = 0;
  const timers = new Map();
  const scheduler = { now: () => now,
    setTimeout(fn, delay) { const handle = ++sequence; timers.set(handle, { fn, at: now + delay }); return handle; },
    clearTimeout(handle) { timers.delete(handle); } };
  return { scheduler, get now() { return now; }, advance(ms) { now += ms; } };
}
async function controllerFixture(t, { raw = rawSnapshot, state = revision => processState(revision), action, uninstalled = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sysom-process-control-test-'));
  fs.writeFileSync(path.join(root, 'sysak'), 'inert fixture: never execute\n', { mode: 0o700 });
  if (!uninstalled) fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({
    schema_version: '1.0', platform: 'linux', arch: process.arch, commands: ['idc', 'resource_anomaly', 'memgraph'],
    files: { sysak: createHash('sha256').update(fs.readFileSync(path.join(root, 'sysak'))).digest('hex') },
  }));
  const requests = [];
  const spawns = [];
  const actions = [];
  const apiFailures = [];
  const children = [];
  const clock = fakeClock();
  let server;
  let apiClosed = false;
  let controller;
  async function closeApi() {
    if (!server || apiClosed) return;
    apiClosed = true;
    const done = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    server.closeAllConnections();
    await done;
  }
  // A single cleanup hook avoids removing the bundle before the queue is settled.
  t.after(async () => {
    for (const child of children) child.finish(null);
    if (controller) await controller.close();
    await closeApi();
    fs.rmSync(root, { recursive: true, force: true });
    assert.deepEqual(apiFailures, [], 'mock API must not conceal fixture errors');
  });
  const startMockOpenApi = async ({ token }) => {
    server = http.createServer(async (request, response) => {
      try {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        assert.equal(request.method, 'POST');
        assert.equal(request.url, '/openapi/v1/collections');
        assert.equal(request.headers.authorization, `Bearer ${token}`);
        requests.push(body);
        const text = JSON.stringify(responseFor(body, state(requests.length, body)));
        response.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
        response.end(text);
      } catch (error) {
        apiFailures.push(error);
        response.writeHead(500, { connection: 'close' });
        response.end('{}');
      }
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    return { baseUrl: `http://127.0.0.1:${server.address().port}`, close: closeApi };
  };
  controller = await createIdcController({ bundleRoot: root, deviceId: randomUUID(), startMockOpenApi,
    scheduler: clock.scheduler, launchImpl, verifyExecutionImpl,
    spawnImpl(binary, argv, options) {
      assert.deepEqual(argv.slice(0, 2), ['idc', '--profile'], 'process actions must use the injected action mock');
      const child = fakeChild();
      children.push(child);
      spawns.push({ binary, argv, options });
      setImmediate(() => { child.stdout.write(JSON.stringify(raw(argv[2], argv[4], identities, spawns.length))); child.finish(); });
      return child;
    },
    killGroup(pid, signal) {
      const child = children.find(item => item.pid === pid);
      assert(child, 'only a fake child group can be killed');
      child.kill(signal);
    },
    async processActionImpl(verb, targets) {
      actions.push({ action: verb, targets: structuredClone(targets) });
      return action ? action(verb, targets, actions.length) : resultsFor(verb, targets);
    },
  });
  return { controller, requests, spawns, actions, clock, get apiClosed() { return apiClosed; } };
}
function prepare(controller, state, resource = 'cpu', ids = [rowId(identities[0])]) {
  return controller.prepareProcessCleanup({ resource, ids, revision: state.revision });
}

test('local annotation overrides both remote true/false flags, checks raw identities once across resources and never preselects', linux, async t => {
  const fixture = await controllerFixture(t, { state: revision => {
    const state = processState(revision);
    state.resources.cpu.rows[0].cleanable = false;
    state.resources.cpu.rows[1].cleanable = true;
    state.resources.gpu.rows = [collectedRow()];
    state.resources.energy.rows = [collectedRow()];
    return state;
  }, action: (verb, targets) => resultsFor(verb, targets).map((item, index) => index ?
    { ...item, status: 'protected', eligible: false, reason: 'manager ancestor is protected' } : item) });
  const state = await fixture.controller.snapshot();
  assert.deepEqual(fixture.actions, [{ action: 'check', targets: identities }]);
  for (const id of ['cpu', 'memory', 'disk']) {
    assert.equal(state.resources[id].rows[0].cleanable, true);
    assert.match(state.resources[id].rows[0].effect, /整个进程.*SIGTERM/);
    assert.equal(state.resources[id].rows[1].cleanable, false);
    assert.equal(state.resources[id].rows[1].effect, 'manager ancestor is protected');
  }
  for (const id of ['gpu', 'energy']) assert.equal(state.resources[id].rows[0].cleanable, false);
  for (const resource of Object.values(state.resources)) assert(resource.rows.every(row => !row.defaultSelected));
  await assert.rejects(prepare(fixture.controller, state, 'cpu', [rowId(identities[1])]), errorIs('PROTECTED_PROCESS'));
  assert.equal(fixture.actions.length, 1);
});

test('missing, invalid, stale, or mismatching raw process identities cannot authorize remote cleanable rows', linux, async t => {
  const cases = [
    ['missing process evidence', raw => { delete raw.resources.processes; }],
    ['missing samples', raw => { delete raw.resources.processes.content.samples; }],
    ['empty samples', raw => { raw.resources.processes.content.samples = []; }],
    ['nonarray processes', raw => { raw.resources.processes.content.samples.at(-1).processes = {}; }],
    ['identity only in previous sample', raw => { raw.resources.processes.content.samples.at(-1).processes = []; }],
    ['missing raw starttime', raw => { raw.resources.processes.content.samples.at(-1).processes = [{ pid: identities[0].pid }]; }],
    ['raw PID string', raw => { raw.resources.processes.content.samples.at(-1).processes = [{ ...identities[0], pid: String(identities[0].pid) }]; }],
    ['raw starttime string', raw => { raw.resources.processes.content.samples.at(-1).processes = [{ ...identities[0], starttime: '1000' }]; }],
    ['raw negative starttime', raw => { raw.resources.processes.content.samples.at(-1).processes = [{ ...identities[0], starttime: -1 }]; }],
    ['raw unsafe starttime', raw => { raw.resources.processes.content.samples.at(-1).processes = [{ ...identities[0], starttime: Number.MAX_SAFE_INTEGER + 1 }]; }],
    ['PID recycled in latest sample', raw => { raw.resources.processes.content.samples.at(-1).processes = [{ ...identities[0], starttime: 9999 }]; }],
    ['row PID disagrees with ID', null, state => { state.resources.cpu.rows[0].pid++; }],
    ['row starttime disagrees with ID', null, state => { state.resources.cpu.rows[0].starttime++; }],
    ['row missing starttime', null, state => { delete state.resources.cpu.rows[0].starttime; }],
    ['row missing PID', null, state => { delete state.resources.cpu.rows[0].pid; }],
    ['row ID disagrees with identity', null, state => { state.resources.cpu.rows[0].id = 'remote-made-up-id'; }],
  ];
  for (const [name, mutateRaw, mutateState] of cases) await t.test(name, async t => {
    const fixture = await controllerFixture(t, {
      raw(profile, requestId) { const raw = rawSnapshot(profile, requestId); mutateRaw?.(raw); return raw; },
      state(revision) { const state = healthState(revision); state.resources.cpu.rows = [collectedRow()]; mutateState?.(state); return state; },
    });
    const state = await fixture.controller.snapshot();
    assert.equal(state.resources.cpu.rows[0].cleanable, false);
    assert.equal(state.resources.cpu.rows[0].defaultSelected, false);
    assert.deepEqual(fixture.actions, []);
    await assert.rejects(prepare(fixture.controller, state, 'cpu', [state.resources.cpu.rows[0].id]), errorIs('PROTECTED_PROCESS'));
  });
  for (const pid of [0, 1, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) await t.test(`invalid/reserved PID ${pid}`, async t => {
    const target = { pid, starttime: 0 };
    const fixture = await controllerFixture(t, { raw: (profile, requestId) => rawSnapshot(profile, requestId, [target]),
      state: revision => processState(revision, [target]) });
    const state = await fixture.controller.snapshot();
    assert(state.resources.cpu.rows.every(row => !row.cleanable));
    assert.deepEqual(fixture.actions, []);
  });
});

test('identity validation is per row even when another resource has a valid row with the same ID', linux, async t => {
  // Regression: an ID-only overlay must not let a valid CPU row authorize a forged memory row.
  const fixture = await controllerFixture(t, { state: revision => {
    const state = healthState(revision);
    state.resources.cpu.rows = [collectedRow()];
    state.resources.memory.rows = [collectedRow(identities[0], { pid: identities[1].pid })];
    state.resources.disk.rows = [collectedRow(identities[0], { starttime: identities[1].starttime })];
    return state;
  } });
  const state = await fixture.controller.snapshot();
  assert.deepEqual(fixture.actions, [{ action: 'check', targets: [identities[0]] }]);
  assert.equal(state.resources.cpu.rows[0].cleanable, true);
  assert.deepEqual([state.resources.memory.rows[0].cleanable, state.resources.disk.rows[0].cleanable], [false, false],
    'mismatched PID/starttime must remain protected despite sharing a checked ID');
  await assert.rejects(prepare(fixture.controller, state, 'memory'), errorIs('PROTECTED_PROCESS'));
  await assert.rejects(prepare(fixture.controller, state, 'disk'), errorIs('PROTECTED_PROCESS'));
});

test('annotation is bounded to 100 unique raw targets, and process-action unavailability fails closed', linux, async t => {
  await t.test('100-target bound', async t => {
    const targets = Array.from({ length: 101 }, (_, index) => ({ pid: 910000 + index, starttime: index }));
    const fixture = await controllerFixture(t, { raw: (profile, requestId) => rawSnapshot(profile, requestId, targets),
      state: revision => processState(revision, targets) });
    const state = await fixture.controller.snapshot();
    assert.equal(fixture.actions.length, 1);
    assert.deepEqual(fixture.actions[0].targets, targets.slice(0, 100));
    assert.equal(state.resources.cpu.rows.filter(row => row.cleanable).length, 100);
    assert.equal(state.resources.cpu.rows[100].cleanable, false);
    await assert.rejects(prepare(fixture.controller, state, 'cpu', [rowId(targets[100])]), errorIs('PROTECTED_PROCESS'));
  });
  await t.test('check rejected', async t => {
    const fixture = await controllerFixture(t, { action() { throw new Error('sysAK check unavailable'); } });
    const state = await fixture.controller.snapshot();
    for (const resource of Object.values(state.resources)) for (const row of resource.rows) {
      assert.equal(row.cleanable, false);
      assert.match(row.effect, /受控进程操作不可用/);
    }
    await assert.rejects(prepare(fixture.controller, state), errorIs('PROTECTED_PROCESS'));
    assert.equal(fixture.actions.length, 1);
  });
});

test('prepare checks selected targets again, uses authoritative names and issues an isolated 60-second opaque plan; execute uses only its token once', linux, async t => {
  for (const resource of ['cpu', 'memory', 'disk']) await t.test(resource, async t => {
    const fixture = await controllerFixture(t);
    const state = await fixture.controller.snapshot();
    const selected = [...identities].reverse();
    const plan = await prepare(fixture.controller, state, resource, selected.map(rowId));
    assert.deepEqual(Object.keys(plan).sort(), ['expires_at', 'processes', 'revision', 'token']);
    assert.match(plan.token, /^[a-f0-9]{64}$/);
    assert.equal(plan.revision, state.revision);
    assert.equal(Date.parse(plan.expires_at), fixture.clock.now + 60000);
    assert.deepEqual(plan.processes, selected.map(target => ({ id: rowId(target), ...target, name: `checked-${target.pid}` })));
    assert.deepEqual(fixture.actions[1], { action: 'check', targets: selected });
    assert.equal(fixture.actions.some(item => item.action === 'terminate'), false);
    plan.processes[0].pid = 1;
    plan.processes[0].name = 'caller mutation';
    plan.revision = 999;
    fixture.clock.advance(59999);
    const result = await fixture.controller.executeProcessCleanup({ token: plan.token });
    assert.deepEqual(result, { revision: state.revision, results: resultsFor('terminate', selected), refresh_required: true });
    assert.deepEqual(fixture.actions[2], { action: 'terminate', targets: selected });
    assert.equal(fixture.requests.length, 1, 'local cleanup must not call remote cleanup or recollect automatically');
    assert.equal(fixture.spawns.length, 1);
    const cached = await fixture.controller.snapshot();
    assert.equal(cached.revision, state.revision);
    for (const resource of Object.values(cached.resources)) assert(resource.rows.every(row => !row.cleanable));
    await assert.rejects(fixture.controller.executeProcessCleanup({ token: plan.token }), errorIs('INVALID_CLEANUP_PLAN'));
    assert.equal(fixture.actions.length, 3);
  });
});

test('prepare validates payload, allowed resource/IDs/count and current revision without performing another check', linux, async t => {
  const fixture = await controllerFixture(t);
  const state = await fixture.controller.snapshot();
  const good = { resource: 'cpu', ids: [rowId(identities[0])], revision: state.revision };
  for (const payload of [null, [], {}, { ...good, resource: 'gpu' }, { ...good, resource: 'energy' },
    { ...good, resource: '__proto__' }, { ...good, ids: [] }, { ...good, ids: 'not-array' },
    { ...good, ids: [1] }, { ...good, ids: [good.ids[0], good.ids[0]] },
    { ...good, ids: Array.from({ length: 11 }, (_, index) => `id-${index}`) },
    { ...good, revision: '1' }, { ...good, revision: 1.5 }, { ...good, pid: 1 }, { ...good, token: 'unexpected' }]) {
    await assert.rejects(fixture.controller.prepareProcessCleanup(payload), errorIs('INVALID_PARAMETERS', 400));
  }
  await assert.rejects(prepare(fixture.controller, { revision: 0 }), errorIs('STALE_SNAPSHOT'));
  await assert.rejects(prepare(fixture.controller, { revision: 999 }), errorIs('STALE_SNAPSHOT'));
  await assert.rejects(prepare(fixture.controller, state, 'cpu', ['unknown']), errorIs('PROTECTED_PROCESS'));
  assert.equal(fixture.actions.length, 1);
  assert.equal(fixture.requests.length, 1);
  await t.test('ten selected identities are accepted', async t => {
    const targets = Array.from({ length: 10 }, (_, index) => ({ pid: 920000 + index, starttime: index }));
    const fixture = await controllerFixture(t, { raw: (profile, requestId) => rawSnapshot(profile, requestId, targets),
      state: revision => processState(revision, targets) });
    const state = await fixture.controller.snapshot();
    const plan = await prepare(fixture.controller, state, 'cpu', targets.map(rowId));
    assert.equal(plan.processes.length, 10);
    assert.deepEqual(fixture.actions[1].targets, targets);
  });
});

test('prepare rejects changed protection/permissions/identity on its recheck and invalidates a previous plan', linux, async t => {
  for (const status of ['protected', 'permission_denied', 'stale', 'gone', 'unsupported', 'unavailable']) {
    await t.test(status, async t => {
      const fixture = await controllerFixture(t, { action(verb, targets, count) {
        if (count < 3) return resultsFor(verb, targets);
        if (status === 'unavailable') throw new Error('uncertain check');
        return resultsFor(verb, targets, status);
      } });
      const state = await fixture.controller.snapshot();
      const old = await prepare(fixture.controller, state);
      await assert.rejects(prepare(fixture.controller, state),
        errorIs(status === 'unavailable' ? 'PROCESS_CONTROL_UNAVAILABLE' : 'PROTECTED_PROCESS', status === 'unavailable' ? 503 : 409));
      await assert.rejects(fixture.controller.executeProcessCleanup({ token: old.token }), errorIs('INVALID_CLEANUP_PLAN'));
      assert.equal(fixture.actions.length, 3);
      assert(fixture.actions.every(item => item.action === 'check'));
    });
  }
});

test('a replacement plan, refresh, inspection and reset invalidate previously issued tokens', linux, async t => {
  for (const change of ['replacement', 'refresh', 'inspect', 'reset']) await t.test(change, async t => {
    const fixture = await controllerFixture(t);
    const state = await fixture.controller.snapshot();
    const old = await prepare(fixture.controller, state);
    if (change === 'replacement') {
      const replacement = await prepare(fixture.controller, state, 'memory', [rowId(identities[1])]);
      assert.notEqual(old.token, replacement.token);
      await assert.rejects(fixture.controller.executeProcessCleanup({ token: old.token }), errorIs('INVALID_CLEANUP_PLAN'));
      await fixture.controller.executeProcessCleanup({ token: replacement.token });
      assert.deepEqual(fixture.actions.at(-1), { action: 'terminate', targets: [identities[1]] });
    } else {
      if (change === 'refresh') await fixture.controller.snapshot(true);
      if (change === 'inspect') await fixture.controller.operation({ operation: 'inspect', parameters: { revision: state.revision } });
      if (change === 'reset') await fixture.controller.reset();
      await assert.rejects(fixture.controller.executeProcessCleanup({ token: old.token }), errorIs('INVALID_CLEANUP_PLAN'));
      await assert.rejects(prepare(fixture.controller, state), errorIs('STALE_SNAPSHOT'));
      assert(fixture.actions.every(item => item.action === 'check'));
    }
  });
  await t.test('refresh invalidates even if remote revision does not change', async t => {
    const fixture = await controllerFixture(t, { state: () => processState(1) });
    const state = await fixture.controller.snapshot();
    const old = await prepare(fixture.controller, state);
    await fixture.controller.snapshot(true);
    await assert.rejects(fixture.controller.executeProcessCleanup({ token: old.token }), errorIs('INVALID_CLEANUP_PLAN'));
    assert(fixture.actions.every(item => item.action === 'check'));
  });
});

test('tokens expire at exactly 60 seconds, are consumed on expiry and cannot be revived by replay', linux, async t => {
  for (const elapsed of [60000, 60001]) await t.test(`${elapsed}ms`, async t => {
    const fixture = await controllerFixture(t);
    const state = await fixture.controller.snapshot();
    const plan = await prepare(fixture.controller, state);
    fixture.clock.advance(elapsed);
    await assert.rejects(fixture.controller.executeProcessCleanup({ token: plan.token }), errorIs('EXPIRED_CLEANUP_PLAN'));
    await assert.rejects(fixture.controller.executeProcessCleanup({ token: plan.token }), errorIs('INVALID_CLEANUP_PLAN'));
    assert.equal(fixture.actions.length, 2);
    const next = await prepare(fixture.controller, state);
    assert.notEqual(next.token, plan.token);
    await fixture.controller.executeProcessCleanup({ token: next.token });
  });
});

test('execute rejects malformed/wrong tokens and caller-supplied identities without consuming a valid plan', linux, async t => {
  const fixture = await controllerFixture(t);
  const state = await fixture.controller.snapshot();
  const plan = await prepare(fixture.controller, state);
  for (const payload of [null, [], {}, { token: 1 }, { token: '' }, { token: 'a'.repeat(63) },
    { token: 'a'.repeat(65) }, { token: 'g'.repeat(64) }, { token: 'A'.repeat(64) },
    { token: plan.token, targets: identities }, { token: plan.token, resource: 'cpu' }, { token: plan.token, revision: 1 }]) {
    await assert.rejects(fixture.controller.executeProcessCleanup(payload), errorIs('INVALID_PARAMETERS', 400));
  }
  const wrong = (plan.token[0] === '0' ? '1' : '0') + plan.token.slice(1);
  await assert.rejects(fixture.controller.executeProcessCleanup({ token: wrong }), errorIs('INVALID_CLEANUP_PLAN'));
  assert.equal(fixture.actions.length, 2);
  await fixture.controller.executeProcessCleanup({ token: plan.token });
  assert.equal(fixture.actions.length, 3);
});

test('cold, uninstalled, paused and closed controllers forbid prepare/execute; resume cannot restore old plans', linux, async t => {
  for (const phase of ['cold', 'uninstalled', 'paused', 'closed']) await t.test(phase, async t => {
    const fixture = await controllerFixture(t, { uninstalled: phase === 'uninstalled' });
    const state = ['paused', 'closed'].includes(phase) ? await fixture.controller.snapshot() : { revision: 1 };
    const plan = ['paused', 'closed'].includes(phase) ? await prepare(fixture.controller, state) : { token: 'a'.repeat(64) };
    if (phase === 'paused') fixture.controller.setEnabled(false);
    if (phase === 'closed') await fixture.controller.close();
    const code = phase === 'cold' ? 'SNAPSHOT_REQUIRED' : phase === 'uninstalled' ? 'COLLECTOR_UNAVAILABLE' : 'COLLECTOR_DISABLED';
    const status = phase === 'uninstalled' ? 503 : 409;
    const before = fixture.actions.length;
    await assert.rejects(prepare(fixture.controller, state), errorIs(code, status));
    await assert.rejects(fixture.controller.executeProcessCleanup({ token: plan.token }), errorIs(code, status));
    assert.equal(fixture.actions.length, before);
    if (phase === 'paused') {
      fixture.controller.setEnabled(true);
      await assert.rejects(fixture.controller.executeProcessCleanup({ token: plan.token }), errorIs('INVALID_CLEANUP_PLAN'));
      const fresh = await prepare(fixture.controller, state);
      await fixture.controller.executeProcessCleanup({ token: fresh.token });
    }
    if (phase === 'closed') assert.equal(fixture.apiClosed, true);
  });
});

test('pause/close during an asynchronous prepare recheck cannot issue a usable plan', linux, async t => {
  for (const change of ['pause', 'close']) await t.test(change, async t => {
    const entered = deferred();
    const release = deferred();
    t.after(() => release.resolve());
    const fixture = await controllerFixture(t, { async action(verb, targets, count) {
      if (count === 2) { entered.resolve(); await release.promise; }
      return resultsFor(verb, targets);
    } });
    const state = await fixture.controller.snapshot();
    const pending = assert.rejects(prepare(fixture.controller, state), errorIs('COLLECTOR_DISABLED'));
    await entered.promise;
    const closing = change === 'close' ? fixture.controller.close() : null;
    if (change === 'pause') fixture.controller.setEnabled(false);
    release.resolve();
    await pending;
    if (closing) await closing;
    assert.equal(fixture.actions.length, 2);
    assert(fixture.actions.every(item => item.action === 'check'));
    if (change === 'pause') {
      fixture.controller.setEnabled(true);
      await assert.rejects(fixture.controller.executeProcessCleanup({ token: 'a'.repeat(64) }), errorIs('INVALID_CLEANUP_PLAN'));
    }
  });
});

test('concurrent execution consumes the token before awaiting sysAK and rejects queued replay', linux, async t => {
  const entered = deferred();
  const release = deferred();
  t.after(() => release.resolve());
  const fixture = await controllerFixture(t, { async action(verb, targets) {
    if (verb === 'terminate') { entered.resolve(); await release.promise; }
    return resultsFor(verb, targets);
  } });
  const state = await fixture.controller.snapshot();
  const plan = await prepare(fixture.controller, state);
  const first = fixture.controller.executeProcessCleanup({ token: plan.token });
  const replay = assert.rejects(fixture.controller.executeProcessCleanup({ token: plan.token }), errorIs('INVALID_CLEANUP_PLAN'));
  await entered.promise;
  const cached = await fixture.controller.snapshot();
  for (const id of ['cpu', 'memory', 'disk']) assert.equal(cached.resources[id].rows[0].cleanable, false);
  assert.equal(fixture.actions.filter(item => item.action === 'terminate').length, 1);
  release.resolve();
  await first;
  await replay;
  assert.equal((await fixture.controller.snapshot()).operations.length, 1);
});

test('uncertain execution consumes its token, disables selected rows and requires refresh rather than allowing another signal', linux, async t => {
  const fixture = await controllerFixture(t, { action(verb, targets) {
    if (verb === 'terminate') throw new Error('timeout/protocol failure: signals may already have been sent');
    return resultsFor(verb, targets);
  } });
  const state = await fixture.controller.snapshot();
  const plan = await prepare(fixture.controller, state);
  await assert.rejects(fixture.controller.executeProcessCleanup({ token: plan.token }), errorIs('PROCESS_RESULT_UNKNOWN', 503));
  await assert.rejects(fixture.controller.executeProcessCleanup({ token: plan.token }), errorIs('INVALID_CLEANUP_PLAN'));
  const cached = await fixture.controller.snapshot();
  for (const id of ['cpu', 'memory', 'disk']) {
    assert.equal(cached.resources[id].rows[0].cleanable, false);
    assert.equal(cached.resources[id].rows[1].cleanable, true);
  }
  assert.deepEqual(cached.operations, [], 'uncertain response must not fabricate a successful log');
  await assert.rejects(prepare(fixture.controller, cached), errorIs('PROTECTED_PROCESS'));
  assert.equal(fixture.actions.filter(item => item.action === 'terminate').length, 1);
  const refreshed = await fixture.controller.snapshot(true);
  await prepare(fixture.controller, refreshed);
  assert.equal(fixture.actions.filter(item => item.action === 'terminate').length, 1);
});

test('real process-action protocol failures propagate through the controller as uncertain execution and consume the token', linux, async t => {
  for (const failure of ['malformed JSON', 'identity mismatch', 'size limit', 'exit failure', 'spawn error']) {
    await t.test(failure, async t => {
      const fixture = await controllerFixture(t, { action(verb, targets) {
        const processFixture = actionFixture(t, child => {
          const reply = replyFor(verb, targets);
          if (verb === 'check') { child.stdout.write(JSON.stringify(reply)); child.finish(); return; }
          if (failure === 'spawn error') { child.emit('error', new Error('fixture ENOENT')); child.finish(-1); return; }
          if (failure === 'size limit') { child.stdout.write(Buffer.alloc(65537, 0x20)); return; }
          if (failure === 'identity mismatch') reply.results[0].starttime++;
          child.stdout.write(failure === 'malformed JSON' ? '{' : JSON.stringify(reply));
          child.finish(failure === 'exit failure' ? 2 : 0);
        }, verb, targets, 990099);
        return processFixture.run();
      } });
      const state = await fixture.controller.snapshot();
      const plan = await prepare(fixture.controller, state);
      await assert.rejects(fixture.controller.executeProcessCleanup({ token: plan.token }), errorIs('PROCESS_RESULT_UNKNOWN', 503));
      await assert.rejects(fixture.controller.executeProcessCleanup({ token: plan.token }), errorIs('INVALID_CLEANUP_PLAN'));
      assert.equal(fixture.actions.filter(item => item.action === 'terminate').length, 1);
      for (const id of ['cpu', 'memory', 'disk']) assert.equal((await fixture.controller.snapshot()).resources[id].rows[0].cleanable, false);
    });
  }
});

test('cleanup tokens are scoped to the issuing controller', linux, async t => {
  const first = await controllerFixture(t);
  const second = await controllerFixture(t);
  const firstState = await first.controller.snapshot();
  const secondState = await second.controller.snapshot();
  const firstPlan = await prepare(first.controller, firstState);
  const secondPlan = await prepare(second.controller, secondState);
  assert.notEqual(firstPlan.token, secondPlan.token);
  await assert.rejects(second.controller.executeProcessCleanup({ token: firstPlan.token }), errorIs('INVALID_CLEANUP_PLAN'));
  assert.equal(second.actions.length, 2);
  await second.controller.executeProcessCleanup({ token: secondPlan.token });
  await first.controller.executeProcessCleanup({ token: firstPlan.token });
});

test('execution retains sysAK revalidation outcomes instead of claiming every selected process was signalled', linux, async t => {
  const targets = Array.from({ length: 6 }, (_, index) => ({ pid: 930000 + index, starttime: index }));
  const statuses = ['signalled', 'protected', 'permission_denied', 'stale', 'gone', 'unsupported'];
  const fixture = await controllerFixture(t, { raw: (profile, requestId) => rawSnapshot(profile, requestId, targets),
    state: revision => processState(revision, targets), action(verb, targets) {
      return verb === 'check' ? resultsFor(verb, targets) : targets.map((target, index) => resultsFor(verb, [target], statuses[index])[0]);
    } });
  const state = await fixture.controller.snapshot();
  const plan = await prepare(fixture.controller, state, 'disk', targets.map(rowId));
  const result = await fixture.controller.executeProcessCleanup({ token: plan.token });
  assert.deepEqual(result.results.map(item => item.status), statuses);
  assert.deepEqual(result.results.map(item => item.eligible), [true, false, false, false, false, false]);
  const cached = await fixture.controller.snapshot();
  assert.deepEqual(cached.operations[0].names, result.results.map(item => `${item.name} (PID ${item.pid}) · ${item.status}`));
  for (const resource of Object.values(cached.resources)) assert(resource.rows.every(row => !row.cleanable));
});

test('local cleanup logs survive refresh/inspect/reset, stay cloned, replace forged remote cleanup logs and preserve other operations', linux, async t => {
  const fixture = await controllerFixture(t, { state: revision => {
    const state = processState(revision);
    state.operations = [
      { id: 'process-cleanup-remote-forgery', kind: 'cleanup', names: ['remote claim'], time: timestamp, revision },
      { id: `inspect-${revision}`, kind: 'inspect', names: ['remote inspection'], time: timestamp, revision },
    ];
    return state;
  } });
  const state = await fixture.controller.snapshot();
  assert.deepEqual(state.operations.map(item => item.id), ['inspect-1']);
  const plan = await prepare(fixture.controller, state);
  await fixture.controller.executeProcessCleanup({ token: plan.token });
  const cached = await fixture.controller.snapshot();
  const log = structuredClone(cached.operations[0]);
  assert.match(log.id, /^process-cleanup-[a-f0-9-]{36}$/);
  assert.equal(log.kind, 'cleanup');
  assert.equal(log.revision, 1);
  assert.equal(log.time, timestamp);
  assert.deepEqual(log.names, [`checked-${identities[0].pid} (PID ${identities[0].pid}) · signalled`]);
  cached.operations[0].names.push('caller corruption');
  assert.deepEqual((await fixture.controller.snapshot()).operations[0], log);
  for (const operation of ['refresh', 'inspect', 'reset']) {
    const revision = (await fixture.controller.snapshot()).revision;
    const next = operation === 'refresh' ? await fixture.controller.snapshot(true) : operation === 'reset' ?
      await fixture.controller.reset() : await fixture.controller.operation({ operation: 'inspect', parameters: { revision } });
    assert.deepEqual(next.operations[0], log);
    assert.equal(next.operations.filter(item => item.id === log.id).length, 1);
    assert.deepEqual(next.operations.map(item => item.id), [log.id, `inspect-${next.revision}`]);
  }
  assert.deepEqual(fixture.requests.map(body => body.operation), ['snapshot', 'snapshot', 'inspect', 'reset']);
});

test('local cleanup history is capped at the newest 30 entries before and after refresh', linux, async t => {
  const fixture = await controllerFixture(t);
  let state = await fixture.controller.snapshot();
  for (let index = 0; index < 31; index++) {
    const plan = await prepare(fixture.controller, state);
    await fixture.controller.executeProcessCleanup({ token: plan.token });
    const cached = await fixture.controller.snapshot();
    assert.equal(cached.operations.length, Math.min(index + 1, 30));
    if (index < 30) state = await fixture.controller.snapshot(true);
  }
  const cached = await fixture.controller.snapshot();
  assert.deepEqual(cached.operations.map(item => item.revision), Array.from({ length: 30 }, (_, index) => 31 - index));
  assert.equal(new Set(cached.operations.map(item => item.id)).size, 30);
  assert.deepEqual((await fixture.controller.snapshot(true)).operations, cached.operations);
});

test('legacy remote cleanup/optimization/session APIs remain read-only even when local cleanup is available', linux, async t => {
  const fixture = await controllerFixture(t);
  const state = await fixture.controller.snapshot();
  const plan = await prepare(fixture.controller, state);
  for (const operation of ['cleanup', 'optimize', 'sessions-cleanup', 'alert-sample']) {
    await assert.rejects(fixture.controller.operation({ operation, parameters: {
      revision: state.revision, resource: 'cpu', ids: [rowId(identities[0])], token: plan.token,
    } }), errorIs('read_only'));
  }
  assert.equal(fixture.requests.length, 1);
  assert.equal(fixture.spawns.length, 1);
  assert.equal(fixture.actions.length, 2);
  await fixture.controller.executeProcessCleanup({ token: plan.token });
  assert.equal(fixture.requests.length, 1);
});

test('recognizeAgent is an exact case-insensitive whitelist, not a generic interpreter/path/substring or prototype lookup', () => {
  const expected = {
    qoder: 'Qoder', 'qoder-cli': 'Qoder CLI', qodercli: 'Qoder CLI', qoderwake: 'QoderWake', 'qodercli-wake': 'QoderWake CLI',
    workbuddy: 'WorkBuddy', codebuddy: 'CodeBuddy', claude: 'Claude Code', 'claude-desktop': 'Claude Desktop',
    codex: 'Codex', 'codex-agent': 'Codex', 'codex-x86_64-un': 'Codex', 'codex-aarch64-u': 'Codex',
    cursor: 'Cursor', 'cursor-agent': 'Cursor Agent', aider: 'Aider', gemini: 'Gemini CLI', opencode: 'OpenCode', goose: 'Goose',
    copilot: 'GitHub Copilot CLI', kimi: 'Kimi Code CLI', qwen: 'Qwen Code', auggie: 'Augment', cline: 'Cline', kilo: 'Kilo',
    antigravity: 'Antigravity', agy: 'Antigravity CLI', openclaw: 'OpenClaw', 'kiro-cli': 'Kiro CLI',
    amp: 'Amp', droid: 'Factory Droid', junie: 'JetBrains Junie', openhands: 'OpenHands',
    devin: 'Devin CLI', 'devin-desktop': 'Devin Desktop', windsurf: 'Windsurf', crush: 'Crush', warp: 'Warp Agent CLI', vibe: 'Mistral Vibe',
  };
  assert.equal(Object.keys(expected).length, 39);
  for (const [name, kind] of Object.entries(expected)) {
    assert(Buffer.byteLength(name, 'utf8') <= 15);
    assert.equal(recognizeAgent(name), kind);
    assert.equal(recognizeAgent(name.toUpperCase()), kind);
    assert.equal(recognizeAgent(name[0].toUpperCase() + name.slice(1)), kind);
    for (const lookalike of [`${name}-worker`, `${name}.exe`, `/usr/bin/${name}`, ` ${name}`, `${name} `, `my-${name}`, `${name} --help`]) {
      assert.equal(recognizeAgent(lookalike), undefined, lookalike);
    }
  }
  for (const name of ['', 'node', 'Node', 'nodejs', 'python', 'Python3', 'python3.12', 'electron', 'bash', 'agent',
    'q', 'cn', 'pi', 'code', 'java', 'language_server', 'codex-x86_64-unknown-linux-gnu', 'codex-x86_64-u',
    'constructor', '__proto__', 'prototype', 'toString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf', 'toLocaleString']) {
    assert.equal(recognizeAgent(name), undefined, name);
  }
});

test('collectedRankingRows filters Agents before Top10, sorts by usage then PID and never mutates source order', () => {
  const generic = Array.from({ length: 25 }, (_, index) => collectedRow({ pid: 940000 + index, starttime: index },
    { usage: 100 - index, agentKind: undefined }));
  const agents = Array.from({ length: 12 }, (_, index) => collectedRow({ pid: 950000 + index, starttime: index },
    { usage: 20 - index, agentKind: recognizeAgent(index % 2 ? 'CLAUDE' : 'Qoder') }));
  const rows = [...agents, ...generic].reverse();
  const resource = { ...healthState().resources.cpu, rows };
  const before = structuredClone(rows);
  assert.deepEqual(collectedRankingRows(resource, false).map(row => row.id), generic.slice(0, 10).map(row => row.id));
  assert.deepEqual(collectedRankingRows(resource, true).map(row => row.id), agents.slice(0, 10).map(row => row.id));
  assert.deepEqual(rows, before);
  const ties = { ...resource, rows: [{ id: 'p9', usage: 1, pid: 9, agentKind: 'Codex' },
    { id: 'no-pid', usage: 1, agentKind: 'Codex' }, { id: 'p2', usage: 1, pid: 2, agentKind: 'Codex' }] };
  assert.deepEqual(collectedRankingRows(ties, true).map(row => row.id), ['no-pid', 'p2', 'p9']);
  assert.deepEqual(collectedRankingRows({ ...resource, rows: generic }, true), []);
  assert.deepEqual(collectedRankingRows({ ...resource, rows: [] }, false), []);
});

test('raw parser retains recognized Agents outside the overall Top20 for CPU/memory/disk, bounded to 20 extra Agents', () => {
  const genericNames = ['node', 'python3', 'constructor', 'toString', 'my-qoder'];
  const makeProcess = (index, second) => {
    const agent = index >= 25;
    const weight = agent ? 30 - (index - 25) : 100 - index;
    return { pid: 960000 + index, starttime: index, comm: agent ? (index % 2 ? 'QODER' : 'claude') : genericNames[index % genericNames.length],
      utime: second ? weight : 0, stime: 0, rss_bytes: weight * 1000, io_status: 'ok',
      io: { read_bytes: second ? weight * 1000 : 0, write_bytes: 0 } };
  };
  const raw = rawSnapshot('resources', randomUUID(), []);
  raw.resources.cpu_count = { status: 'ok', content: 1 };
  raw.resources.processes = { status: 'ok', content: { clock_ticks: 100, samples: [
    { monotonic_seconds: 10, processes: Array.from({ length: 50 }, (_, index) => makeProcess(index, false)) },
    { monotonic_seconds: 12, processes: Array.from({ length: 50 }, (_, index) => makeProcess(index, true)) },
  ] } };
  const state = parseCollectedState(raw, undefined, false, false);
  for (const id of ['cpu', 'memory', 'disk']) {
    const resource = state.resources[id];
    assert.equal(resource.rows.length, 40);
    assert.equal(new Set(resource.rows.map(row => row.id)).size, 40);
    assert.equal(resource.rows.filter(row => row.agentKind).length, 20);
    assert(resource.rows.filter(row => row.pid < 960025).every(row => !row.agentKind));
    assert.equal(resource.rows.some(row => row.pid === 960049), false, 'Agent retention must remain bounded');
    assert.deepEqual(collectedRankingRows(resource, false).map(row => row.pid), Array.from({ length: 10 }, (_, index) => 960000 + index));
    assert.deepEqual(collectedRankingRows(resource, true).map(row => row.pid), Array.from({ length: 10 }, (_, index) => 960025 + index));
    assert(resource.rows.every(row => !row.cleanable && !row.defaultSelected));
  }
});
