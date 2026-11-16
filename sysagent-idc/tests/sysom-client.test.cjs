'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  TERMINAL_STATUSES, SYSAK_UPLOAD_ENV_KEYS, SysomError,
  loadSysomConfig, sysakChildEnv, createSysomClient,
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