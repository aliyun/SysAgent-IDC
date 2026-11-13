const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

require.extensions['.ts'] = (module, filename) => {
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
    fileName: filename,
  });
  module._compile(output.outputText, filename);
};
require.extensions['.tsx'] = require.extensions['.ts'];
global.window = { setTimeout };
const data = require('../src/health-data.ts');
const api = require('../src/standalone-api.ts');
const original = fs.readFileSync(path.join(__dirname, '../../sysagent-analysis/port/c4-health-data.js'), 'utf8');
const reference = vm.createContext({ structuredClone });
vm.runInContext(original.slice(original.indexOf('var qa')), reference);
const normalize = (value) => JSON.parse(JSON.stringify(value, (key, item) => key === 'hasGpu' || key === 'mode' ? undefined : key === 'sampledAt' || key === 'time' ? '<time>' : item));
const equalReference = (actual, expected) => assert.deepEqual(normalize(actual), normalize(expected));

test('initial values, score, badges and protected Agent parents match reference', () => {
  const state = data.createInitialState();
  assert.equal(state.mode, 'demo');
  equalReference(state, reference.Ln());
  assert.deepEqual(data.resourceUsages(state), { cpu: 93, energy: 84, memory: 94, disk: 96, gpu: 92 });
  const score = data.summarizeHealth(state);
  assert.equal(score.score, 10);
  assert.equal(score.open.length, 9);
  assert.deepEqual([score.n, score.x, score.m, score.y], [3, 3, 12, 6]);
  for (const resource of Object.values(state.resources)) {
    assert.equal(resource.rows.length, 10);
    assert.equal(resource.rows.filter((row) => row.defaultSelected && row.cleanable).length, 3);
    assert(resource.rows.every((row, index, rows) => !index || row.usage <= rows[index - 1].usage));
    assert(resource.rows.filter((row) => row.agentId).every((row) => !row.cleanable && !row.defaultSelected));
  }
});

test('all score bands and strict >90 threshold', () => {
  assert.deepEqual([0, 59.9, 60, 79.9, 80, 89.9, 90, 100].map((n) => data.scoreBand(n).id), ['red', 'red', 'orange', 'orange', 'yellow', 'yellow', 'green', 'green']);
  const state = data.setDemoUsageState(data.createInitialState(), 'fd', 90);
  assert.equal(state.inspections.find((row) => row.id === 'fd').status, 'normal');
  assert.equal(data.summarizeHealth(state).x, 2);
});

test('cleanup exactly matches reference across every resource and is immutable', () => {
  for (const resource of data.resourceIds) {
    const state = data.createInitialState();
    const before = JSON.stringify(state);
    const ids = state.resources[resource].rows.filter((row) => row.defaultSelected && row.cleanable).map((row) => row.id);
    const next = data.cleanupState(state, resource, ids);
    equalReference(next, reference.Ss(state, resource, ids));
    assert.equal(JSON.stringify(state), before);
    assert.equal(next.resources[resource].rows.length, 7);
    assert.equal(next.inspections.find((row) => row.id === 'fd').usage, 83);
  }
});

test('optimization subset and full optimization match original; full score 100, phase two stays unchecked', () => {
  for (const ids of [['opt-agent'], ['opt-memory'], ['opt-root', 'opt-fd'], ['opt-logs'], ['opt-agent', 'opt-root', 'opt-memory', 'opt-fd', 'opt-logs']]) {
    const state = data.createInitialState();
    const next = data.optimizeState(state, ids);
    equalReference(next, reference.K8(state, ids));
    if (ids.length === 5) {
      assert.equal(data.summarizeHealth(next).score, 100);
      assert.equal(next.optimizations.length, 0);
      assert.equal(next.inspections.filter((row) => row.status === 'unchecked').length, 4);
    }
  }
});

test('runtime session cleanup affects CPU/energy/memory/GPU and FD, not disk', () => {
  const state = data.createInitialState();
  const ids = ['agent-logs-session-2', 'agent-logs-session-3'];
  const next = data.cleanupSessionsState(state, 'cpu', 'agent-logs', ids);
  equalReference(next, reference.J8(state, 'cpu', 'agent-logs', ids));
  assert.deepEqual(next.resources.disk, state.resources.disk);
  assert.equal(next.inspections.find((row) => row.id === 'fd').usage, 87);
  for (const resource of ['cpu', 'energy', 'memory', 'gpu']) {
    const row = next.resources[resource].rows.find((item) => item.agentId === 'agent-logs');
    assert.equal(row.sessions.length, 2);
    assert.equal(row.usage, row.sessions.reduce((sum, session) => sum + session.usage, 0));
  }
});

test('disk session cleanup does not end runtime sessions or affect FD', () => {
  const state = data.createInitialState();
  const ids = ['agent-coding-disk-2', 'agent-coding-disk-3'];
  const next = data.cleanupSessionsState(state, 'disk', 'agent-coding', ids);
  equalReference(next, reference.J8(state, 'disk', 'agent-coding', ids));
  for (const resource of ['cpu', 'energy', 'memory', 'gpu']) assert.deepEqual(next.resources[resource], state.resources[resource]);
  assert.equal(next.inspections.find((row) => row.id === 'fd').usage, 95);
});

test('active, nonexistent, duplicate, empty and cross-scope session requests are rejected', () => {
  const state = data.createInitialState();
  for (const [resource, ids] of [['cpu', []], ['cpu', ['agent-logs-session-1']], ['cpu', ['agent-logs-disk-2']], ['disk', ['agent-logs-session-2']], ['cpu', ['unknown']], ['cpu', ['agent-logs-session-2', 'agent-logs-session-2']]]) {
    assert.throws(() => data.cleanupSessionsState(state, resource, 'agent-logs', ids));
  }
});

test('alert samples across all targets match reference and use immutable snapshots', () => {
  for (const target of data.alertTargets) {
    for (const usage of [80, 96]) {
      const state = data.createInitialState();
      const next = data.setDemoUsageState(state, target, usage);
      equalReference(next, reference.$8(state, target, usage));
      assert.equal(next.revision, state.revision + 1);
      assert.equal(target === 'fd' ? next.inspections.find((row) => row.id === 'fd').usage : next.resources[target === 'root' ? 'disk' : target].usage, usage);
    }
  }
});

test('operations are capped at 30 and report never describes energy as watts', () => {
  let state = data.createInitialState();
  for (let n = 0; n < 40; n++) state = data.setDemoUsageState(state, 'energy', n % 2 ? 80 : 96);
  assert.equal(state.operations.length, 30);
  const report = data.buildHealthReport(state, { name: '本地 AI 工作站' });
  assert(report.includes('预算占比估算，非实测能耗'));
  assert(report.includes('不操作真实硬件、进程或文件'));
  assert(!/\d\s*W\b/.test(report));
});

test('report formats snapshot, resource and operation timestamps as local time without changing stored values', () => {
  const { localTime } = require('../agent-diagnostics.ts');
  const iso = '2026-11-13T02:39:01.444Z';
  const state = data.createInitialState();
  state.sampledAt = iso;
  for (const resource of Object.values(state.resources)) resource.sampledAt = iso;
  state.operations = [{ id: 'time-check', time: iso, kind: 'inspect', names: ['时间检查'], revision: state.revision }];
  const before = JSON.stringify(state);
  const report = data.buildHealthReport(state, { name: '本地 AI 工作站' });
  const date = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  const expected = `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  assert.equal(localTime(iso), expected);
  assert.equal(localTime(null), '—');
  assert.equal(localTime('invalid'), '—');
  assert(report.includes(expected));
  assert(!report.includes(iso));
  assert.equal(JSON.stringify(state), before);
});

test('API rejects invalid revisions, ids, protected rows and stale concurrent requests', async () => {
  let state = await api.resetHealthSnapshot();
  await assert.rejects(api.cleanupResources('cpu', ['cpu-0'], state.revision), (error) => error.status === 400);
  await assert.rejects(api.cleanupResources('cpu', ['cpu-4'], state.revision), (error) => error.status === 400);
  await assert.rejects(api.cleanupResources('unknown', ['cpu-2'], state.revision), (error) => error.status === 400);
  await assert.rejects(api.optimizeHealth([], state.revision), (error) => error.status === 400);
  await assert.rejects(api.runHealthInspection(1.5), (error) => error.status === 400);
  const results = await Promise.allSettled([api.runHealthInspection(state.revision), api.runHealthInspection(state.revision)]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  const rejected = results.find((result) => result.status === 'rejected');
  assert.equal(rejected.reason.status, 409);
  state = await api.fetchHealthSnapshot();
  assert.equal(state.revision, 2);
  assert.equal(state.operations[0].kind, 'inspect');
  await assert.rejects(api.setAlertSample('energy', 90, state.revision), (error) => error.status === 400);
  const reset = await api.resetHealthSnapshot();
  assert.equal(reset.revision, 1);
  assert.equal(data.summarizeHealth(reset).score, 10);
});

test('local IDC coordinator delegates to a mock controller and enforces its HTTP contract', async (t) => {
  const http = require('node:http');
  const { EventEmitter } = require('node:events');
  const { randomUUID } = require('node:crypto');
  const { pathToFileURL } = require('node:url');
  const esbuild = require('esbuild');
  const root = path.resolve(__dirname, '..');
  // Keep import.meta.url relative to the project, not an OS temporary directory.
  const bundleFile = path.join(root, `.health-score-demo-api-${randomUUID()}.mjs`);
  let ownsBundle = false;
  t.after(() => { if (ownsBundle) fs.rmSync(bundleFile); });
  const mockSource = `
    const { createInitialState, refreshState } = require('./src/health-data.ts');
    const HealthState = createInitialState();
    class CollectorError extends Error {
      constructor(code, message, status = 503, retryable = false) {
        super(message);
        Object.assign(this, { code, status, retryable });
      }
    }
    const mock = { HealthState, CollectorError, instances: [], deferCreation: false };
    mock.createIdcController = (options) => {
      let state = structuredClone(HealthState);
      let enabled = true;
      let inspectionIntervalMinutes = 5;
      const controller = {
        options, calls: [], closeCount: 0,
        status() {
          this.calls.push(['status']);
          return { schema_version: '1.0', mode: 'mock', read_only: true,
            installed: true, enabled, phase: enabled ? 'idle' : 'disabled', error: null,
            inspection_interval_minutes: inspectionIntervalMinutes,
            next_inspection_at: enabled
              ? new Date(Date.parse(HealthState.sampledAt) + inspectionIntervalMinutes * 60000).toISOString() : null };
        },
        async snapshot(...args) {
          this.calls.push(['snapshot', ...args]);
          if (this.snapshotError) throw this.snapshotError;
          return structuredClone(state);
        },
        async reset(parameters) {
          this.calls.push(['reset', parameters]);
          state = createInitialState(parameters.hasGpu ?? true);
          return structuredClone(state);
        },
        async operation(payload) {
          this.calls.push(['operation', payload]);
          if (!Number.isInteger(payload.parameters.revision)) {
            throw new CollectorError('INVALID_PARAMETERS', 'Mock revision must be an integer', 400);
          }
          if (payload.parameters.revision !== state.revision) {
            throw new CollectorError('REVISION_CONFLICT', 'Mock revision is stale', 409);
          }
          state.revision++;
          state.operations.unshift({ id: 'mock-inspect-' + state.revision, kind: payload.operation,
            names: [], time: state.sampledAt, revision: state.revision });
          state = refreshState(state);
          return structuredClone(state);
        },
        setEnabled(value) {
          this.calls.push(['setEnabled', value]);
          if (typeof value !== 'boolean') {
            throw new CollectorError('INVALID_PARAMETERS', 'Mock enabled must be boolean', 400);
          }
          enabled = value;
          return this.status();
        },
        setInspectionInterval(value) {
          this.calls.push(['setInspectionInterval', value]);
          if (!Number.isInteger(value) || value < 1 || value > 1440) {
            throw new CollectorError('INVALID_INSPECTION_INTERVAL', 'Mock interval must be an integer from 1 to 1440', 400);
          }
          if (this.intervalError) throw this.intervalError;
          inspectionIntervalMinutes = value;
          return this.status();
        },
        async close() { this.closeCount++; enabled = false; },
      };
      mock.instances.push(controller);
      return mock.deferCreation
        ? new Promise((resolve) => { controller.resolveCreation = () => resolve(controller); })
        : Promise.resolve(controller);
    };
    module.exports = mock;
  `;
  let intercepted = false;
  const bundle = await esbuild.build({
    entryPoints: [path.join(root, 'demo-api.ts')], outfile: bundleFile,
    bundle: true, platform: 'node', format: 'esm', target: 'node18', write: false,
    plugins: [{
      name: 'mock-idc-controller',
      setup(build) {
        // createRequire is a runtime call: bridge it to a static import so esbuild
        // can intercept the CJS controller without ever loading the real collector.
        build.onLoad({ filter: /[/\\]demo-api\.ts$/ }, ({ path: filename }) => {
          const source = fs.readFileSync(filename, 'utf8');
          const controllerRequire = "require('./electron/idc-controller.cjs')";
          assert(source.includes(controllerRequire));
          return { loader: 'ts', resolveDir: root, contents:
            "import __controllerMock from './electron/idc-controller.cjs';\n" +
            source.replace(controllerRequire, '__controllerMock') +
            '\nexport { __controllerMock as coordinatorMock };\n' };
        });
        build.onResolve({ filter: /^\.\/electron\/idc-controller\.cjs$/ }, () => {
          intercepted = true;
          return { path: 'controller', namespace: 'mock-idc' };
        });
        build.onLoad({ filter: /.*/, namespace: 'mock-idc' }, () => ({
          contents: mockSource, loader: 'js', resolveDir: root,
        }));
      },
    }],
  });
  assert.equal(intercepted, true);
  fs.writeFileSync(bundleFile, bundle.outputFiles[0].contents, { flag: 'wx' });
  ownsBundle = true;
  const { demoApi, coordinatorMock: mock } = await import(pathToFileURL(bundleFile).href);

  const attach = (hook = 'configureServer') => {
    const httpServer = new EventEmitter();
    let handler;
    const plugin = demoApi();
    assert.equal(plugin.name, 'sysom-idc-api');
    plugin[hook]({ httpServer, middlewares: { use(prefix, callback) {
      assert.equal(prefix, '/api/idc');
      handler = callback;
    } } });
    assert.equal(typeof handler, 'function');
    const controller = mock.instances.at(-1);
    assert.equal(controller.options.bundleRoot, path.join(root, 'resources/sysak'));
    assert.equal(typeof controller.options.startMockOpenApi, 'function');
    return { httpServer, handler, controller };
  };
  const fixture = async (subtest, hook) => {
    const { httpServer, handler, controller } = attach(hook);
    const server = http.createServer((request, response) => {
      request.url = request.url.slice('/api/idc'.length);
      void handler(request, response);
    });
    subtest.after(async () => {
      server.closeAllConnections();
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      httpServer.emit('close');
      await new Promise(setImmediate);
      assert.equal(controller.closeCount, 1);
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const port = server.address().port;
    const localHost = `127.0.0.1:${port}`;
    const request = (route, { method = 'GET', body, headers = {}, host = localHost } = {}) => new Promise((resolve, reject) => {
      const outgoing = http.request({
        hostname: '127.0.0.1', port, path: `/api/idc/${route}`, method, agent: false, setHost: false,
        headers: { ...(host === null ? {} : { Host: host }),
          ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}), ...headers },
      }, (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('error', reject);
        response.on('end', () => {
          try { resolve({ status: response.statusCode, headers: response.headers,
            body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); }
          catch (error) { reject(error); }
        });
      });
      outgoing.on('error', reject);
      outgoing.end(body === undefined || typeof body === 'string' ? body : JSON.stringify(body));
    });
    const post = (route, body = {}, options = {}) => request(route, { ...options, method: 'POST', body });
    return { request, post, localHost, controller };
  };
  const success = (response, expected) => {
    assert.equal(response.status, 200);
    assert.equal(response.headers['content-type'], 'application/json; charset=utf-8');
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.deepEqual(response.body, { ok: true, data: expected });
  };
  const failure = (response, status, code, retryable = false) => {
    assert.equal(response.status, status);
    assert.equal(response.headers['content-type'], 'application/json; charset=utf-8');
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.deepEqual(Object.keys(response.body).sort(), ['error', 'ok']);
    assert.equal(response.body.ok, false);
    assert.deepEqual(Object.keys(response.body.error).sort(), ['code', 'message', 'retryable', 'status']);
    assert.equal(typeof response.body.error.message, 'string');
    assert(response.body.error.message.length > 0);
    assert.deepEqual({ ...response.body.error, message: '<message>' }, { code, message: '<message>', status, retryable });
  };

  await t.test('status, snapshot, reset, operations and enabled return envelopes and delegate unchanged parameters', async (subtest) => {
    const { request, post, controller } = await fixture(subtest);
    const status = { schema_version: '1.0', mode: 'mock', read_only: true,
      installed: true, enabled: true, phase: 'idle', error: null,
      inspection_interval_minutes: 5,
      next_inspection_at: new Date(Date.parse(mock.HealthState.sampledAt) + 5 * 60000).toISOString() };
    success(await request('status'), status);
    success(await request('snapshot?fresh=1'), mock.HealthState);
    assert.deepEqual(controller.calls, [['status'], ['snapshot']]);
    const reset = await post('reset', { hasGpu: false });
    assert.equal(reset.body.data.hasGpu, false);
    assert.equal(reset.body.data.revision, 1);
    success(reset, await controller.snapshot());
    assert.deepEqual(controller.calls.at(-2), ['reset', { hasGpu: false }]);
    const payload = { operation: 'inspect', parameters: { revision: 1 } };
    const operated = await post('operations', payload);
    assert.equal(operated.body.data.revision, 2);
    assert.equal(operated.body.data.operations[0].kind, 'inspect');
    assert.deepEqual(controller.calls.at(-1), ['operation', payload]);
    success(operated, await controller.snapshot());
    success(await request('snapshot'), operated.body.data);
    success(await post('enabled', { enabled: false }), { ...status, enabled: false, phase: 'disabled', next_inspection_at: null });
    success(await request('status'), { ...status, enabled: false, phase: 'disabled', next_inspection_at: null });
    success(await post('enabled', { enabled: true }), status);
    assert.deepEqual(controller.calls.filter(([name]) => name === 'setEnabled'), [['setEnabled', false], ['setEnabled', true]]);
  });

  await t.test('controller receives the project resources settings path', async (subtest) => {
    const { controller } = await fixture(subtest);
    assert.equal(controller.options.settingsPath, path.join(root, 'resources/idc-settings.json'));
    assert.deepEqual(controller.calls, []);
  });

  await t.test('snapshot refresh queries delegate exact booleans, ignore unrelated queries and reject invalid refresh values', async (subtest) => {
    const { request, controller } = await fixture(subtest);
    for (const [route, args] of [
      ['snapshot', []], ['snapshot?fresh=1', []], ['snapshot?unknown=value', []],
      ['snapshot?refresh=true', [true]], ['snapshot?refresh=false', [false]],
      ['snapshot?fresh=1&refresh=true&unknown=value', [true]],
      ['snapshot?refresh=false&unknown=value', [false]],
    ]) {
      success(await request(route), mock.HealthState);
      assert.deepEqual(controller.calls.at(-1), ['snapshot', ...args]);
    }
    const before = controller.calls.length;
    for (const value of ['', '1', '0', 'TRUE', 'False', 'null', 'undefined', 'true-ish']) {
      failure(await request(`snapshot?refresh=${encodeURIComponent(value)}`), 400, 'INVALID_PARAMETERS');
      assert.equal(controller.calls.length, before, 'invalid refresh must fail before delegation');
    }
  });

  await t.test('interval delegates validated integer boundaries and returns scheduling status without collecting', async (subtest) => {
    const { request, post, controller } = await fixture(subtest);
    for (const minutes of [1, 1440, 5]) {
      const response = await post('interval', { inspection_interval_minutes: minutes });
      success(response, { schema_version: '1.0', mode: 'mock', read_only: true,
        installed: true, enabled: true, phase: 'idle', error: null,
        inspection_interval_minutes: minutes,
        next_inspection_at: new Date(Date.parse(mock.HealthState.sampledAt) + minutes * 60000).toISOString() });
      assert.deepEqual(controller.calls.slice(-2), [['setInspectionInterval', minutes], ['status']]);
      success(await request('status'), response.body.data);
    }
    assert.equal(controller.calls.filter(([name]) => name === 'snapshot' || name === 'operation' || name === 'reset').length, 0,
      'saving interval must not initialize or refresh collection');
    await post('enabled', { enabled: false });
    const paused = await post('interval', { inspection_interval_minutes: 1 });
    assert.equal(paused.status, 200);
    assert.equal(paused.body.data.next_inspection_at, null);
    assert.equal(paused.body.data.inspection_interval_minutes, 1);
  });

  await t.test('interval requires its sole body field and propagates validation and save failures without changing settings', async (subtest) => {
    const { request, post, controller } = await fixture(subtest);
    for (const body of [{ inspection_interval_minutes: 1, extra: true }, { minutes: 1 },
      { inspection_interval_minutes: 1, enabled: true }]) {
      failure(await post('interval', body), 400, 'INVALID_PARAMETERS');
      assert.deepEqual(controller.calls, [], 'extra interval keys must be rejected before the controller');
    }
    for (const body of ['{', 'null', '[]', 'true', '1', '"string"']) {
      failure(await post('interval', body), 400, 'INVALID_PARAMETERS');
      assert.deepEqual(controller.calls, []);
    }
    failure(await post('interval', {}, { headers: { 'Content-Type': 'text/plain' } }), 415, 'JSON_REQUIRED');
    assert.deepEqual(controller.calls, []);
    for (const value of [undefined, '1', '1440', '', 1.5, 0, -1, 1441, null, true, {}, []]) {
      const response = await post('interval', { inspection_interval_minutes: value });
      failure(response, 400, 'INVALID_INSPECTION_INTERVAL');
      assert.deepEqual(controller.calls.at(-1), ['setInspectionInterval', value]);
      const status = await request('status');
      assert.equal(status.body.data.inspection_interval_minutes, 5);
    }
    controller.intervalError = new mock.CollectorError('SETTINGS_SAVE_FAILED', 'Mock settings save failed', 500);
    const response = await post('interval', { inspection_interval_minutes: 1 });
    failure(response, 500, 'SETTINGS_SAVE_FAILED');
    assert.equal(response.body.error.message, 'Mock settings save failed');
    assert.deepEqual(controller.calls.at(-1), ['setInspectionInterval', 1]);
    assert.equal((await request('status')).body.data.inspection_interval_minutes, 5);
    assert.equal(controller.calls.filter(([name]) => name === 'snapshot' || name === 'operation' || name === 'reset').length, 0);
  });

  await t.test('JSON objects are required and the body cap is exactly 8 KiB of bytes', async (subtest) => {
    const { post, controller } = await fixture(subtest);
    for (const contentType of ['text/plain', '']) {
      failure(await post('reset', {}, { headers: { 'Content-Type': contentType } }), 415, 'JSON_REQUIRED');
    }
    for (const body of ['{', 'null', '[]', 'true', '1', '"string"']) {
      failure(await post('reset', body), 400, 'INVALID_PARAMETERS');
    }
    assert.deepEqual(controller.calls, []);
    for (const body of ['', '{}', '{}'.padEnd(8192, ' ')]) {
      const response = await post('reset', body, { headers: { 'Content-Type': 'Application/JSON; charset=utf-8' } });
      success(response, await controller.snapshot());
      assert.deepEqual(controller.calls.at(-2), ['reset', {}]);
    }
    const before = controller.calls.length;
    failure(await post('reset', '{}'.padEnd(8193, ' ')), 413, 'BODY_TOO_LARGE');
    const multibyte = JSON.stringify({ padding: '界'.repeat(2731) });
    assert(multibyte.length < 8192 && Buffer.byteLength(multibyte) > 8192);
    failure(await post('reset', multibyte), 413, 'BODY_TOO_LARGE');
    failure(await post('enabled', { enabled: true, extra: true }), 400, 'INVALID_PARAMETERS');
    assert.equal(controller.calls.length, before);
    for (const body of [{}, { enabled: 'true' }]) {
      failure(await post('enabled', body), 400, 'INVALID_PARAMETERS');
      assert.deepEqual(controller.calls.at(-1), ['setEnabled', body.enabled]);
    }
  });

  await t.test('same-origin and loopback Host checks reject unsafe requests before delegation', async (subtest) => {
    const { request, post, localHost, controller } = await fixture(subtest);
    for (const origin of ['https://untrusted.invalid', 'null', 'not a URL', 'http://127.0.0.1:1', `http://localhost:${localHost.split(':')[1]}`]) {
      failure(await post('reset', {}, { headers: { Origin: origin } }), 403, 'INVALID_ORIGIN');
    }
    for (const host of ['untrusted.invalid', `127.0.0.1.untrusted.invalid:${localHost.split(':')[1]}`, '0.0.0.0']) {
      failure(await request('status', { host }), 403, 'INVALID_HOST');
    }
    failure(await request('status', { host: 'untrusted.invalid', headers: { Origin: 'http://untrusted.invalid' } }), 403, 'INVALID_HOST');
    assert.deepEqual(controller.calls, []);
    for (const host of [localHost, 'localhost:5173', '[::1]:5173']) {
      const response = await request('snapshot', { host, headers: { Origin: `http://${host}` } });
      success(response, mock.HealthState);
    }
    success(await post('reset', {}, { headers: { Origin: `http://${localHost}` } }), await controller.snapshot());
  });

  await t.test('known routes enforce methods and Allow headers; obsolete routes are not found', async (subtest) => {
    const { request, controller } = await fixture(subtest);
    for (const route of ['status', 'snapshot', 'reset', 'operations', 'enabled', 'interval']) {
      const allowed = ['status', 'snapshot'].includes(route) ? 'GET' : 'POST';
      for (const method of [allowed === 'GET' ? 'POST' : 'GET', 'PUT', 'OPTIONS']) {
        const response = await request(route, { method, body: method === 'POST' ? {} : undefined });
        failure(response, 405, 'METHOD_NOT_ALLOWED');
        assert.equal(response.headers.allow, allowed);
      }
    }
    for (const route of ['unknown', 'inspect', 'optimize', 'cleanup', 'sessions/cleanup']) {
      failure(await request(route), 404, 'NOT_FOUND');
    }
    assert.deepEqual(controller.calls, []);
  });

  await t.test('revision conflicts and controller errors are serialized, not implemented by the coordinator', async (subtest) => {
    const { post, request, controller } = await fixture(subtest);
    const payload = { operation: 'inspect', parameters: { revision: 1 } };
    const results = await Promise.all([post('operations', payload), post('operations', payload)]);
    const completed = results.find((response) => response.status === 200);
    assert(completed);
    assert.equal(completed.body.data.revision, 2);
    failure(results.find((response) => response.status === 409), 409, 'REVISION_CONFLICT');
    assert.deepEqual(controller.calls, [['operation', payload], ['operation', payload]]);
    const invalid = { operation: 'inspect', parameters: { revision: 1.5 } };
    failure(await post('operations', invalid), 400, 'INVALID_PARAMETERS');
    assert.deepEqual(controller.calls.at(-1), ['operation', invalid]);
    controller.snapshotError = new mock.CollectorError('COLLECTION_TIMEOUT', 'Mock timeout', 504, true);
    const timeout = await request('snapshot');
    failure(timeout, 504, 'COLLECTION_TIMEOUT', true);
    assert.equal(timeout.body.error.message, 'Mock timeout');
    controller.snapshotError = new Error('private collector detail');
    const internal = await request('snapshot');
    failure(internal, 503, 'INTERNAL_ERROR', true);
    assert(!internal.body.error.message.includes('private collector detail'));
  });

  await t.test('development and preview close the controller once, including pending initialization', async () => {
    for (const hook of ['configureServer', 'configurePreviewServer']) {
      mock.deferCreation = true;
      let attached;
      try { attached = attach(hook); }
      finally { mock.deferCreation = false; }
      const { httpServer, controller } = attached;
      assert.equal(httpServer.listenerCount('close'), 1);
      httpServer.emit('close');
      assert.equal(controller.closeCount, 0);
      controller.resolveCreation();
      await new Promise(setImmediate);
      assert.equal(controller.closeCount, 1);
      assert.equal(httpServer.listenerCount('close'), 0);
      httpServer.emit('close');
      await new Promise(setImmediate);
      assert.equal(controller.closeCount, 1);
    }
  });
});

test('no-GPU state drops the GPU inspection, resource scoring and alert target', async () => {
  const state = data.createInitialState(false);
  assert.equal(state.hasGpu, false);
  assert(!state.inspections.some((item) => item.id === 'gpu'));
  assert.deepEqual(data.stateResourceIds(state), ['cpu', 'energy', 'memory', 'disk']);
  assert(!data.availableAlertTargets(state).includes('gpu'));
  const score = data.summarizeHealth(state);
  assert.deepEqual([score.n, score.x, score.m, score.y, score.score], [3, 3, 10, 5, 10]);
  assert(!score.open.some((item) => item.id === 'gpu'));
  assert(!data.buildHealthReport(state, { name: '本地' }).includes('GPU'));
  assert.throws(() => data.setDemoUsageState(state, 'gpu', 96));
  api.configureGpu(false);
  try {
    const snapshot = await api.fetchHealthSnapshot();
    assert.equal(snapshot.hasGpu, false);
    await assert.rejects(api.setAlertSample('gpu', 96, snapshot.revision), (error) => error.status === 400);
    await assert.rejects(api.cleanupResources('gpu', ['gpu-2'], snapshot.revision), (error) => error.status === 400);
    assert.equal((await api.resetHealthSnapshot()).hasGpu, false);
  } finally {
    api.configureGpu(true);
  }
  assert.equal((await api.fetchHealthSnapshot()).hasGpu, true);
});

function collectedFixture() {
  const state = data.createInitialState(true);
  state.mode = 'collected';
  state.sampledAt = '2026-01-01T12:00:00.000Z';
  const GiB = 1024 ** 3;
  for (const resource of Object.values(state.resources)) {
    Object.assign(resource, { source: 'sysak', status: 'available', capacity: null,
      sampledAt: state.sampledAt, rankUnit: '%', rankLabel: '进程整机占比', note: '当前可见进程 Top 10，非整机占用总和',
      rows: [{ id: `${resource.id}-pid-17`, pid: 17, name: 'worker', detail: '当前进程样本', usage: 18,
        cleanable: false, defaultSelected: false, effect: '只读' }] });
  }
  state.resources.cpu.usage = 92;
  Object.assign(state.resources.memory, { usage: 40, quantity: { value: 8 * GiB, unit: 'B', total: 20 * GiB, available: 12 * GiB } });
  Object.assign(state.resources.disk, { usage: 67, status: 'partial', rankUnit: 'B/s', rankLabel: '进程磁盘 IO 速率',
    quantity: { value: 67 * GiB, unit: 'B', total: 100 * GiB, available: 33 * GiB },
    note: '根目录容量；排行为进程 IO 速率，不代表磁盘空间归属' });
  state.resources.disk.rows[0].usage = 12 * 1024 ** 2;
  state.resources.disk.rows[0].quantity = { value: 12 * 1024 ** 2, unit: 'B/s' };
  Object.assign(state.resources.energy, { usage: null, quantity: { value: 87.3, unit: 'W' }, rankUnit: 'W', rankLabel: '实测功率', rows: [] });
  Object.assign(state.resources.gpu, { usage: null, status: 'unavailable', rows: [], note: '已检测到 GPU，利用率采集不可用' });
  for (const item of state.inspections) Object.assign(item, { status: 'unchecked', usage: null, detail: '本次未检查', evidence: [] });
  Object.assign(state.inspections.find(item => item.id === 'root'), { status: 'normal', usage: 63, detail: '独立根目录诊断', evidence: ['独立采集证据'] });
  Object.assign(state.inspections.find(item => item.id === 'fd'), { status: 'normal', usage: 73, detail: '独立 FD 诊断', evidence: ['独立采集证据'] });
  return state;
}

test('collected refresh preserves totals, independent diagnostics, availability and capture notes', () => {
  const state = collectedFixture();
  const totals = data.resourceUsages(state);
  const inspections = structuredClone(state.inspections);
  state.optimizations = [{ id: 'stale-demo', inspection: 'root' }];
  const cpu = state.resources.cpu;
  cpu.rows.push({ id: 'pid-3', pid: 3, name: 'busy', usage: 21, detail: 'sample', effect: '',
    cleanable: true, defaultSelected: true, agentId: 'synthetic', sessions: [{ usage: 999 }] });
  data.refreshState(state);
  assert.deepEqual(data.resourceUsages(state), totals);
  assert.deepEqual(state.inspections, inspections);
  assert.deepEqual(cpu.rows.map(row => row.usage), [21, 18]);
  assert(state.resources.disk.note.includes('IO 速率'));
  assert.equal(state.resources.gpu.status, 'unavailable');
  assert.equal(state.hasGpu, true);
  assert.equal(state.resources.energy.quantity.value, 87.3);
  assert.deepEqual(state.optimizations, []);
  for (const resource of Object.values(state.resources)) {
    assert(resource.rows.every(row => !row.cleanable && !row.defaultSelected && !row.agentId && !row.sessions));
  }
});

test('nullable percentages are excluded from threshold denominator, not counted as normal', () => {
  const score = data.calculateScore([], [null, 91, null, 90]);
  assert.deepEqual([score.m, score.y, score.resourceAbnormal, score.score], [2, 1, 1, 90]);
  assert.equal(data.calculateScore([], [null, null]).m, 0);
  const state = collectedFixture();
  const summary = data.summarizeHealth(state);
  assert.equal(summary.m, state.inspections.filter(item => !item.important).length + 3);
  assert.equal(summary.resourceAbnormal, 1);
  assert(!summary.open.some(item => item.id === 'energy' || item.id === 'gpu'));
  assert.equal(summary.unavailable, 1);
  for (const resource of Object.values(state.resources)) Object.assign(resource, { usage: null, status: 'unavailable', quantity: undefined });
  for (const item of state.inspections) Object.assign(item, { status: 'unchecked', usage: null });
  const unknown = data.summarizeHealth(state);
  assert.equal(unknown.checked, 0);
  assert.equal(unknown.unavailable, 5);
  assert.equal(unknown.band.label, '暂无可用评分证据');
  assert.equal(unknown.band.color, '#91a4bc');
});

test('collected mutations reject without changing resources or independent evidence', () => {
  const state = collectedFixture();
  const before = structuredClone(state);
  for (const operation of [
    () => data.cleanupState(state, 'cpu', ['cpu-pid-17']),
    () => data.optimizeState(state, ['opt-root']),
    () => data.cleanupSessionsState(state, 'cpu', 'synthetic', ['session-1']),
    () => data.setDemoUsageState(state, 'cpu', 96),
    () => data.setDemoUsageState(state, 'energy', 80),
  ]) assert.throws(operation, /只读/);
  assert.deepEqual(state, before);
});

test('collected report formats measured watts, bytes and IO truthfully and retains unavailable GPU', () => {
  const state = collectedFixture();
  const report = data.buildHealthReport(state, { name: '本机' });
  assert(report.includes('本机资源采集报告'));
  assert(report.includes('87.3 W'));
  assert(report.includes('8 GiB / 20 GiB · 可用 12 GiB'));
  assert(report.includes('进程磁盘 IO 速率（B/s）'));
  assert(report.includes('PID 17 · worker：12 MiB/s'));
  assert(report.includes('GPU 利用率：不可用'));
  assert(report.includes('已检测到 GPU，利用率采集不可用'));
  assert(report.includes('状态：partial'));
  assert(report.includes('独立根目录诊断'));
  assert(!report.includes('能耗：null%'));
  assert(!report.includes('能耗：0%'));
  assert(!report.includes('预算占比估算'));
  assert(!report.includes('所有数据与清理优化均为模拟'));
  assert.equal(data.formatResourceValue(state.resources.gpu), '不可用');
  assert.equal(data.formatResourceValue(state.resources.energy), '87.3 W');
  assert.equal(data.inspectionScope(state, state.inspections.find(item => item.id === 'root')), '本地采集');
  assert.equal(data.inspectionScope(state, state.inspections.find(item => item.id === 'memory')), '未检查');
  Object.assign(state.resources.energy, { quantity: undefined, status: 'unavailable' });
  assert.equal(data.formatResourceValue(state.resources.energy), '不可用');
  assert(!data.buildHealthReport(state, { name: '本机' }).includes('87.3 W'));
});

test('directory byte rankings do not turn sizes into percentages or ownership', () => {
  const resource = collectedFixture().resources.disk;
  Object.assign(resource, { rankUnit: 'B', rankLabel: '有界目录大小', note: '仅已扫描的部分目录，非全盘扫描' });
  const row = { id: 'directory-1', name: '/var/log', detail: '有界目录扫描', usage: 1536,
    quantity: { value: 1536, unit: 'B' }, cleanable: false, defaultSelected: false, effect: '只读' };
  assert.equal(data.formatRankingValue(resource, row), '1.5 KiB');
  assert.equal(data.formatRankingValue({ ...resource, rankUnit: 'count' }, { ...row, usage: 3, quantity: undefined }), '3 count');
});

test('collected alerts skip missing metrics, unavailable GPU and measured power without budget', () => {
  const state = collectedFixture();
  assert.deepEqual(data.availableAlertTargets(state), ['cpu', 'memory', 'root', 'fd']);
  Object.assign(state.resources.cpu, { status: 'unavailable', usage: 96 });
  assert.equal(data.resourceUsages(state).cpu, null);
  assert(!data.availableAlertTargets(state).includes('cpu'));
  assert(!data.summarizeHealth(state).open.some(item => item.id === 'cpu'));
  state.hasGpu = false;
  state.inspections = state.inspections.filter(item => item.id !== 'gpu');
  assert(!data.stateResourceIds(state).includes('gpu'));
  assert(!data.buildHealthReport(state, { name: '本机' }).includes('GPU'));
});

test('collected rankings render PID metrics, protected selections and Agent filtering without Session ownership', () => {
  const React = require('react');
  const { renderToStaticMarkup } = require('react-dom/server');
  const { ResourceRankings } = require('../src/ResourceRankings.tsx');
  const resource = collectedFixture().resources.disk;
  // Even stale expansion/selection data must not expose Demo controls in collected mode.
  resource.rows[0].agentId = 'synthetic';
  resource.rows[0].sessions = [{ id: 'synthetic-session', name: 'should-not-render', usage: 18 }];
  const props = { resource, collected: true, color: '#abc', selectedIds: [], onSelect() {}, blocked: false,
    busy: false, onCleanupSessions() {}, agentOnly: false, onAgentOnlyChange() {} };
  const html = renderToStaticMarkup(React.createElement(ResourceRankings, props));
  assert(html.includes('排行 / PID'));
  assert(html.includes('12 MiB/s'));
  assert(html.includes('worker'));
  assert(html.includes('不代表磁盘空间归属'));
  assert(html.includes('选择进程 worker PID'));
  assert(html.includes('只看 Agent'));
  assert(html.includes('受保护 / 不可用'));
  assert(!html.includes('sh-agent-sessions'));
  assert(!html.includes('should-not-render'));
  const empty = renderToStaticMarkup(React.createElement(ResourceRankings, { ...props, resource: { ...resource, rows: [] } }));
  assert(empty.includes('没有可用排行数据'));
  assert(empty.includes('不代表系统没有资源占用'));
});

test('collected resource cards and performance never render unknown percentages or Demo history', () => {
  const React = require('react');
  const { renderToStaticMarkup } = require('react-dom/server');
  const { HealthGuardPage, HealthReportContent } = require('../src/HealthGuardPage.tsx');
  const { HealthPerformance } = require('../src/HealthPerformance.tsx');
  const state = collectedFixture();
  const device = require('../src/data.ts').devices[0];
  const html = renderToStaticMarkup(React.createElement(HealthGuardPage, {
    state, device, loading: false, loadError: '', externalBusy: false, onRefresh() {},
    onNavigate() {}, onNotify() {}, onBusyChange() {},
  }));
  assert(html.includes('巡检配置'));
  assert(html.includes('87.3 W'));
  assert(html.includes('8 GiB / 20 GiB'));
  assert(!html.includes('null%'));
  assert(!html.includes('sh-optimize-button'));
  const gpuCard = html.match(/data-resource="gpu"[\s\S]*?<\/section>/)[0];
  assert(gpuCard.includes('不可用'));
  assert(!gpuCard.includes('<circle'));
  assert(!gpuCard.includes('未超限'));
  const energyCard = html.match(/data-resource="energy"[\s\S]*?<\/section>/)[0];
  assert(!energyCard.includes('<circle'));
  assert(!energyCard.includes('预算占比 · 估算'));
  assert(!energyCard.includes('Agent'));
  const performance = renderToStaticMarkup(React.createElement(HealthPerformance, { state, device, onInvestigate() {} }));
  assert(performance.includes('暂无历史采样'));
  assert(performance.includes('当前采集值'));
  assert(!performance.includes('resource-chart'));
  assert(!performance.includes('样本平均'));
  assert(!performance.includes('14:00–14:30'));
  const demoPerformance = renderToStaticMarkup(React.createElement(HealthPerformance, { state: data.createInitialState(), device, onInvestigate() {} }));
  assert(demoPerformance.includes('resource-chart'));
  assert(demoPerformance.includes('14:00–14:30'));
  const report = renderToStaticMarkup(React.createElement(HealthReportContent, { state, device }));
  assert(report.includes('87.3 W'));
  assert(report.includes('不可用'));
  assert(report.includes('未检查'));
});

test('all collected inspection IDs have renderable icons, including unimplemented IO', () => {
  const React = require('react');
  const { renderToStaticMarkup } = require('react-dom/server');
  const source = ts.createSourceFile('HealthGuardPage.tsx', fs.readFileSync(path.join(__dirname, '../src/HealthGuardPage.tsx'), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const declaration = source.statements.filter(ts.isVariableStatement).flatMap(statement => statement.declarationList.declarations).find(item => item.name.getText(source) === 'inspectionIcons');
  assert(declaration?.initializer);
  const icons = vm.runInNewContext(`(${declaration.initializer.getText(source)})`, { ...require('lucide-react') });
  const { parseCollectedState } = require('../collected-state.ts');
  const state = parseCollectedState({ collection: { finished_at: '2026-11-09T00:00:00Z' } }, undefined, false, false);
  for (const inspection of state.inspections) {
    assert(icons[inspection.id], `Missing icon for ${inspection.id}`);
    assert(renderToStaticMarkup(React.createElement(icons[inspection.id])).includes('<svg'));
  }
});

test('GPU detector reads PCI class/vendor only and honours SYSOM_GPU', () => {
  const os = require('node:os');
  const { detectGpu, hasRenderNode } = require('../electron/gpu-detect.cjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sysom-gpu-'));
  const pci = path.join(root, 'pci');
  const dev = path.join(root, 'dev');
  const addDevice = (name, cls, vendor) => {
    fs.mkdirSync(path.join(pci, name), { recursive: true });
    fs.writeFileSync(path.join(pci, name, 'class'), `${cls}\n`);
    fs.writeFileSync(path.join(pci, name, 'vendor'), `${vendor}\n`);
  };
  try {
    fs.mkdirSync(dev, { recursive: true });
    const linux = (env = {}) => detectGpu({ env, platform: 'linux', pciRoot: pci, devRoot: dev });
    assert.equal(linux(), false);
    addDevice('0000:00:02.0', '0x030000', '0x1013');
    addDevice('0000:00:03.0', '0x020000', '0x10de');
    assert.equal(linux(), false);
    assert.equal(linux({ SYSOM_GPU: '1' }), true);
    addDevice('0000:3b:00.0', '0x030200', '0x10de');
    assert.equal(linux(), true);
    assert.equal(linux({ SYSOM_GPU: '0' }), false);
    fs.rmSync(path.join(pci, '0000:3b:00.0'), { recursive: true });
    fs.writeFileSync(path.join(dev, 'nvidia0'), '');
    assert.equal(linux(), true);
    const missingCommand = () => ({ status: null, error: new Error('not found') });
    assert.equal(detectGpu({ env: {}, platform: 'darwin', run: missingCommand }), false);
    assert.equal(detectGpu({ env: { SystemRoot: root }, platform: 'win32', run: missingCommand }), false);
    const output = (stdout) => () => ({ status: 0, stdout });
    assert.equal(detectGpu({ platform: 'darwin', env: {}, run: output('Chipset Model: Apple M4') }), true);
    assert.equal(detectGpu({ platform: 'win32', env: {}, run: output('Intel(R) Iris(R) Xe Graphics') }), true);
    assert.equal(detectGpu({ platform: 'win32', env: {}, run: output('AMD Radeon RX 7900') }), true);
    assert.equal(detectGpu({ platform: 'win32', env: {}, run: output('Microsoft Basic Display Adapter') }), false);
    assert.equal(detectGpu({ platform: 'win32', env: {}, run: output('Microsoft Basic Display Adapter PCI\\VEN_10DE&DEV_2684') }), true);
    assert.equal(detectGpu({ platform: 'win32', env: {}, run: output('VMware SVGA 3D') }), false);
    fs.rmSync(path.join(dev, 'nvidia0'));
    addDevice('0000:00:04.0', '0x030000', '0x8086');
    assert.equal(linux(), true);
    assert.equal(hasRenderNode(path.join(root, 'missing')), false);
    fs.mkdirSync(path.join(root, 'dri'));
    fs.writeFileSync(path.join(root, 'dri', 'card0'), '');
    assert.equal(hasRenderNode(path.join(root, 'dri')), false);
    fs.writeFileSync(path.join(root, 'dri', 'renderD128'), '');
    assert.equal(hasRenderNode(path.join(root, 'dri')), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
