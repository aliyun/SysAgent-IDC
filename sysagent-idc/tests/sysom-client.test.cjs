'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  TERMINAL_STATUSES, SYSAK_UPLOAD_ENV_KEYS, SysomError,
  loadSysomConfig, sysakChildEnv, createSysomClient, ensureProxyBootstrap,
} = require('../electron/sysom-client.cjs');

const CREDS = {
  SYSOM_POP_ENDPOINT: 'https://sysom-pre.cn-hangzhou.aliyuncs.com/',
  SYSOM_ACCESS_KEY_ID: 'ak-id',
  SYSOM_ACCESS_KEY_SECRET: 'ak-secret',
  SYSOM_REGION_ID: 'cn-hangzhou',
  SYSOM_DEVICE_ID: 'dev-1',
};

// 假替身：记录入参、按脚本返回，绝不触网。
function fakeClient(script) {
  const calls = { host: [], report: [] };
  let hostIndex = 0;
  return {
    calls,
    async getHostInspection(req) {
      calls.host.push(req.inspectionId);
      const step = script.host[Math.min(hostIndex++, script.host.length - 1)];
      if (step instanceof Error) throw step;
      return { statusCode: 200, body: step };
    },
    async getInspectionReport(req) {
      calls.report.push(req.reportId);
      const step = script.report;
      if (step instanceof Error) throw step;
      return { statusCode: 200, body: step };
    },
  };
}

test('loadSysomConfig: null when creds missing or switched off', () => {
  assert.equal(loadSysomConfig({}), null);
  assert.equal(loadSysomConfig({ SYSOM_POP_ENDPOINT: 'e', SYSOM_ACCESS_KEY_ID: 'a' }), null);
  assert.equal(loadSysomConfig({ ...CREDS, SYSOM_IDC_UPLOAD: '0' }), null);
  assert.equal(loadSysomConfig({ ...CREDS, SYSOM_IDC_UPLOAD: 'off' }), null);
});

test('loadSysomConfig: builds config, strips scheme/path, defaults region', () => {
  const cfg = loadSysomConfig(CREDS);
  assert.equal(cfg.endpoint, 'sysom-pre.cn-hangzhou.aliyuncs.com');
  assert.equal(cfg.accessKeyId, 'ak-id');
  assert.equal(cfg.regionId, 'cn-hangzhou');
  assert.equal(cfg.deviceId, 'dev-1');
  assert.equal(loadSysomConfig({ ...CREDS, SYSOM_REGION_ID: undefined }).regionId, 'cn-hangzhou');
  // 显式开启也成立
  assert.ok(loadSysomConfig({ ...CREDS, SYSOM_IDC_UPLOAD: '1' }));
});

test('sysakChildEnv: mock mode never leaks credentials', () => {
  const env = { ...CREDS, PATH: '/usr/bin', AWS_SECRET_ACCESS_KEY: 'leak', OTHER_TOKEN: 'leak' };
  const child = sysakChildEnv(null, env);
  assert.deepEqual(Object.keys(child).sort(), ['LANG', 'PATH', 'PYTHONDONTWRITEBYTECODE']);
  assert.equal(child.LANG, 'C.UTF-8');
  assert.equal(child.PYTHONDONTWRITEBYTECODE, '1');
});

test('sysakChildEnv: pre mode allowlists only SYSOM_* keys', () => {
  const env = { ...CREDS, SYSOM_IDC_UPLOAD: '1', PATH: '/usr/bin', AWS_SECRET_ACCESS_KEY: 'leak', OTHER_TOKEN: 'leak' };
  const child = sysakChildEnv(loadSysomConfig(env), env);
  for (const key of SYSAK_UPLOAD_ENV_KEYS) {
    if (env[key] !== undefined) assert.equal(child[key], env[key]);
  }
  assert.equal(child.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(child.OTHER_TOKEN, undefined);
  assert.equal(child.PATH, '/usr/bin');
});

// 办公网出口可能仅代理可达：洗掉代理变量会让 sysAK 直连网关超时（upload url failed）。
const PROXY_ENV = {
  http_proxy: 'http://proxy.example:3127',
  https_proxy: 'http://proxy.example:3127',
  no_proxy: 'localhost,.aliyun.com',
  HTTP_PROXY: 'http://proxy.example:3127',
  HTTPS_PROXY: 'http://proxy.example:3127',
  NO_PROXY: 'localhost,.aliyun.com',
};

test('sysakChildEnv: pre mode passes through proxy vars', () => {
  const env = { ...CREDS, ...PROXY_ENV, PATH: '/usr/bin' };
  const child = sysakChildEnv(loadSysomConfig(env), env);
  for (const key of Object.keys(PROXY_ENV)) {
    assert.equal(child[key], PROXY_ENV[key]);
  }
});

test('sysakChildEnv: pre mode without proxy stays clean', () => {
  const env = { ...CREDS, PATH: '/usr/bin' };
  const child = sysakChildEnv(loadSysomConfig(env), env);
  for (const key of Object.keys(PROXY_ENV)) {
    assert.equal(child[key], undefined);
  }
});

test('sysakChildEnv: mock mode strips proxy vars too', () => {
  const env = { ...CREDS, ...PROXY_ENV, PATH: '/usr/bin' };
  const child = sysakChildEnv(null, env);
  assert.deepEqual(Object.keys(child).sort(), ['LANG', 'PATH', 'PYTHONDONTWRITEBYTECODE']);
});

test('getHostInspection: returns flat body and passes inspectionId', async () => {
  const fake = fakeClient({ host: [{ status: 'queued', inspectionId: 'ins-1', progress: 10 }] });
  const client = createSysomClient(loadSysomConfig(CREDS), { client: fake });
  const task = await client.getHostInspection('ins-1');
  assert.equal(task.status, 'queued');
  assert.equal(task.progress, 10);
  assert.deepEqual(fake.calls.host, ['ins-1']);
});

test('getHostInspection: accepts Dara model body via toMap', async () => {
  const fake = fakeClient({ host: [{ toMap: () => ({ status: 'completed', reportId: 'r-1' }) }] });
  const client = createSysomClient(loadSysomConfig(CREDS), { client: fake });
  const task = await client.getHostInspection('ins-1');
  assert.equal(task.status, 'completed');
  assert.equal(task.reportId, 'r-1');
});

test('getInspectionReport: unwraps data envelope', async () => {
  const fake = fakeClient({ host: [{}], report: { code: 'Success', data: { reportVersion: 'ecs_report_v1', summary: { overallLevel: 'Critical' } }, message: 'ok' } });
  const client = createSysomClient(loadSysomConfig(CREDS), { client: fake });
  const report = await client.getInspectionReport('r-1');
  assert.equal(report.reportVersion, 'ecs_report_v1');
  assert.equal(report.summary.overallLevel, 'Critical');
  assert.deepEqual(fake.calls.report, ['r-1']);
});

test('getInspectionReport: non-Success code becomes SysomError', async () => {
  const fake = fakeClient({ host: [{}], report: { code: 'Inspection.ReportNotFound', message: '报告不存在', data: null } });
  const client = createSysomClient(loadSysomConfig(CREDS), { client: fake });
  await assert.rejects(() => client.getInspectionReport('r-x'), (e) => {
    assert.ok(e instanceof SysomError);
    assert.equal(e.code, 'Inspection.ReportNotFound');
    return true;
  });
});

test('SDK transport error maps to retryable SysomError on 5xx', async () => {
  const err = Object.assign(new Error('ServiceUnavailable'), { statusCode: 503, code: 'ServiceUnavailable' });
  const fake = fakeClient({ host: [err] });
  const client = createSysomClient(loadSysomConfig(CREDS), { client: fake });
  await assert.rejects(() => client.getHostInspection('ins-1'), (e) => {
    assert.ok(e instanceof SysomError);
    assert.equal(e.status, 503);
    assert.equal(e.retryable, true);
    return true;
  });
});

test('pollHostInspection: polls until terminal and reports progress', async () => {
  const fake = fakeClient({ host: [
    { status: 'queued', progress: 0 },
    { status: 'analyzing', progress: 50 },
    { status: 'partial_completed', progress: 100, reportId: 'r-1' },
  ] });
  const client = createSysomClient(loadSysomConfig(CREDS), { client: fake });
  const seen = [];
  const task = await client.pollHostInspection('ins-1', { intervalMs: 1, timeoutMs: 2000, onProgress: (t) => seen.push(t.status) });
  assert.equal(task.status, 'partial_completed');
  assert.equal(task.reportId, 'r-1');
  assert.deepEqual(seen, ['queued', 'analyzing', 'partial_completed']);
  assert.equal(fake.calls.host.length, 3);
});

test('pollHostInspection: every terminal status stops the loop', async () => {
  for (const status of TERMINAL_STATUSES) {
    const fake = fakeClient({ host: [{ status }] });
    const client = createSysomClient(loadSysomConfig(CREDS), { client: fake });
    const task = await client.pollHostInspection('ins-1', { intervalMs: 1, timeoutMs: 1000 });
    assert.equal(task.status, status);
    assert.equal(fake.calls.host.length, 1);
  }
});

test('pollHostInspection: timeout is retryable SysomError', async () => {
  const fake = fakeClient({ host: [{ status: 'queued' }] });
  const client = createSysomClient(loadSysomConfig(CREDS), { client: fake });
  await assert.rejects(() => client.pollHostInspection('ins-1', { intervalMs: 1, timeoutMs: 10 }), (e) => {
    assert.equal(e.code, 'PollTimeout');
    assert.equal(e.retryable, true);
    return true;
  });
});

test('pollHostInspection: abort signal cancels', async () => {
  const fake = fakeClient({ host: [{ status: 'queued' }] });
  const client = createSysomClient(loadSysomConfig(CREDS), { client: fake });
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(() => client.pollHostInspection('ins-1', { intervalMs: 1, timeoutMs: 1000, signal: ac.signal }), (e) => {
    assert.equal(e.code, 'PollCancelled');
    return true;
  });
  assert.equal(fake.calls.host.length, 0);
});

test('pollHostInspection: retries transient 503 then succeeds', async () => {
  const transient = Object.assign(new Error('ServiceUnavailable'), { statusCode: 503, code: 'ServiceUnavailable' });
  const fake = fakeClient({ host: [
    { status: 'queued', progress: 0 },
    transient,
    { status: 'completed', progress: 100, reportId: 'r-1' },
  ] });
  const client = createSysomClient(loadSysomConfig(CREDS), { client: fake });
  const retried = [];
  const task = await client.pollHostInspection('ins-1', { intervalMs: 1, timeoutMs: 2000, onRetry: (e) => retried.push(e.code) });
  assert.equal(task.status, 'completed');
  assert.deepEqual(retried, ['ServiceUnavailable']);
  assert.equal(fake.calls.host.length, 3);
});

test('pollHostInspection: non-retryable error propagates immediately', async () => {
  const fatal = Object.assign(new Error('Forbidden'), { statusCode: 403, code: 'Forbidden' });
  const fake = fakeClient({ host: [fatal] });
  const client = createSysomClient(loadSysomConfig(CREDS), { client: fake });
  await assert.rejects(() => client.pollHostInspection('ins-1', { intervalMs: 1, timeoutMs: 2000 }), (e) => {
    assert.equal(e.code, 'Forbidden');
    assert.equal(e.retryable, false);
    return true;
  });
  assert.equal(fake.calls.host.length, 1);
});

test('pollHostInspection: transient 503 retried until deadline then throws', async () => {
  const transient = Object.assign(new Error('ServiceUnavailable'), { statusCode: 503, code: 'ServiceUnavailable' });
  const fake = fakeClient({ host: [transient] });
  const client = createSysomClient(loadSysomConfig(CREDS), { client: fake });
  await assert.rejects(() => client.pollHostInspection('ins-1', { intervalMs: 1, timeoutMs: 10 }), (e) => {
    assert.equal(e.code, 'ServiceUnavailable');
    return true;
  });
  assert.ok(fake.calls.host.length >= 2);
});

test('createSysomClient: requires config', () => {
  assert.throws(() => createSysomClient(null), (e) => e instanceof SysomError && e.code === 'SysomNotConfigured');
});

// 主进程 SDK 传输层(httpx)不读代理 env：仅代理出口的办公网里 getHostInspection
// 直连超时，后台只见 SubmitHostInspection 不见轮询。用 global-agent 按 env 补丁
// 全局 http(s)。单测注入假 bootstrap，避免真实补丁污染测试进程；真实 bootstrap
// 只在最后一个真实构造用例出现（该文件内其余用例全走假替身，不触网）。
const PROXY_KEYS = ['http_proxy', 'https_proxy', 'no_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY'];

function scrubProxyEnv(t, injected = {}) {
  const saved = new Map(PROXY_KEYS.map((key) => [key, process.env[key]]));
  for (const key of PROXY_KEYS) delete process.env[key];
  for (const [key, value] of Object.entries(injected)) process.env[key] = value;
  t.after(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

test('ensureProxyBootstrap: no proxy configured does nothing', (t) => {
  scrubProxyEnv(t);
  let calls = 0;
  const bootstrap = () => { calls += 1; };
  assert.equal(ensureProxyBootstrap({}, { bootstrap }), false);
  assert.equal(ensureProxyBootstrap({ no_proxy: 'localhost' }, { bootstrap }), false);
  assert.equal(calls, 0);
});

test('ensureProxyBootstrap: lowercase-only env normalized to uppercase for bootstrap, then restored', (t) => {
  scrubProxyEnv(t);
  delete globalThis.GLOBAL_AGENT;
  t.after(() => { delete globalThis.GLOBAL_AGENT; });
  const env = {
    http_proxy: 'http://proxy.fixture.invalid:3127',
    https_proxy: 'http://proxy.fixture.invalid:3127',
    no_proxy: 'localhost,.fixture.invalid',
  };
  let seen;
  const bootstrap = (configuration) => {
    seen = {
      configuration,
      HTTP_PROXY: process.env.HTTP_PROXY,
      HTTPS_PROXY: process.env.HTTPS_PROXY,
      NO_PROXY: process.env.NO_PROXY,
    };
    globalThis.GLOBAL_AGENT = {};
    return true;
  };
  assert.equal(ensureProxyBootstrap(env, { bootstrap }), true);
  assert.deepEqual(seen.configuration, { environmentVariableNamespace: '' });
  assert.equal(seen.HTTP_PROXY, env.http_proxy);
  assert.equal(seen.HTTPS_PROXY, env.https_proxy);
  assert.equal(seen.NO_PROXY, env.no_proxy);
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY']) assert.equal(process.env[key], undefined);
});

test('ensureProxyBootstrap: uppercase values win over lowercase', (t) => {
  scrubProxyEnv(t);
  delete globalThis.GLOBAL_AGENT;
  t.after(() => { delete globalThis.GLOBAL_AGENT; });
  const env = {
    HTTP_PROXY: 'http://upper.fixture.invalid:3127',
    http_proxy: 'http://lower.fixture.invalid:3127',
    HTTPS_PROXY: 'http://upper.fixture.invalid:3127',
    https_proxy: 'http://lower.fixture.invalid:3127',
  };
  let seen;
  const bootstrap = () => { seen = { ...process.env }; globalThis.GLOBAL_AGENT = {}; };
  assert.equal(ensureProxyBootstrap(env, { bootstrap }), true);
  assert.equal(seen.HTTP_PROXY, env.HTTP_PROXY);
  assert.equal(seen.HTTPS_PROXY, env.HTTPS_PROXY);
});

test('ensureProxyBootstrap: already bootstrapped is a no-op', (t) => {
  scrubProxyEnv(t);
  globalThis.GLOBAL_AGENT = {};
  t.after(() => { delete globalThis.GLOBAL_AGENT; });
  let calls = 0;
  const bootstrap = () => { calls += 1; };
  assert.equal(ensureProxyBootstrap({ https_proxy: 'http://proxy.fixture.invalid:3127' }, { bootstrap }), false);
  assert.equal(calls, 0);
});

test('createSysomClient: injected fake client never bootstraps global proxy', (t) => {
  scrubProxyEnv(t, { https_proxy: 'http://proxy.fixture.invalid:3127' });
  delete globalThis.GLOBAL_AGENT;
  t.after(() => { delete globalThis.GLOBAL_AGENT; });
  const fake = fakeClient({ host: [{ status: 'queued' }] });
  createSysomClient(loadSysomConfig(CREDS), { client: fake });
  assert.equal(globalThis.GLOBAL_AGENT, undefined);
});

test('createSysomClient: real SDK construction bootstraps global proxy from env', (t) => {
  scrubProxyEnv(t, {
    http_proxy: 'http://proxy.fixture.invalid:3127',
    https_proxy: 'http://proxy.fixture.invalid:3127',
    no_proxy: 'localhost',
  });
  delete globalThis.GLOBAL_AGENT;
  t.after(() => { delete globalThis.GLOBAL_AGENT; });
  const client = createSysomClient(loadSysomConfig(CREDS));
  assert.equal(typeof client.getHostInspection, 'function');
  assert.ok(globalThis.GLOBAL_AGENT);
  assert.equal(globalThis.GLOBAL_AGENT.HTTPS_PROXY, 'http://proxy.fixture.invalid:3127');
  assert.equal(globalThis.GLOBAL_AGENT.NO_PROXY, 'localhost');
});