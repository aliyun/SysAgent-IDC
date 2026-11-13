const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { runProcessAction } = require('./process-control.cjs');
const { verifyRootInstallation, connectRootIdc } = require('./sysak-root.cjs');
const { collectAgentEvidence, createAgentSightService, controlAgentCollection } = require('./agentsight-client.cjs');

const MAX_RAW_BYTES = 8 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const operations = new Set(['snapshot', 'reset', 'inspect', 'cleanup', 'optimize', 'sessions-cleanup', 'alert-sample']);

class CollectorError extends Error {
  constructor(code, message, status = 503, retryable = false) {
    super(message);
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

function verifyBundle(root) {
  if (process.platform !== 'linux') throw new CollectorError('UNSUPPORTED_PLATFORM', '本地 sysAK 采集目前仅支持 Linux');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  if (manifest.schema_version !== '1.0' || manifest.platform !== 'linux' || manifest.arch !== process.arch ||
      !manifest.commands?.includes('idc') || !manifest.files ||
      typeof manifest.files !== 'object' || !manifest.files.sysak) {
    throw new CollectorError('INVALID_BUNDLE', 'sysAK 组件清单或架构不匹配，请重新安装完整软件包');
  }
  const resolvedRoot = fs.realpathSync(root);
  for (const [relative, digest] of Object.entries(manifest.files)) {
    const file = path.resolve(root, relative);
    if (!file.startsWith(`${path.resolve(root)}${path.sep}`) ||
        !fs.realpathSync(file).startsWith(`${resolvedRoot}${path.sep}`) ||
        typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest) ||
        crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') !== digest) {
      throw new CollectorError('INVALID_BUNDLE', 'sysAK 组件校验失败，请重新安装完整软件包');
    }
  }
  fs.accessSync(path.join(root, 'sysak'), fs.constants.X_OK);
  return manifest;
}

function collectRaw(binary, profile, requestId, signal, { spawnImpl = spawn, launchImpl = connectRootIdc, killGroup = (pid, signal) => process.kill(-pid, signal), timeoutMs = 35000 } = {}) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new CollectorError('COLLECTION_CANCELLED', '本地采集已停止'));
    const child = launchImpl(binary, ['idc', '--profile', profile, '--request-id', requestId, '-o', '-'], {
      cwd: path.dirname(binary), detached: true, shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8', PYTHONDONTWRITEBYTECODE: '1' },
    }, spawnImpl);
    let size = 0;
    let stderrSize = 0;
    const chunks = [];
    let failure = null;
    let finished = false;
    let killTimer;
    const stop = (error) => {
      if (finished || failure) return;
      failure = error;
      if (child.pid) {
        try { killGroup(child.pid, 'SIGTERM'); } catch (cause) {
          if (!['ESRCH', 'EPERM'].includes(cause.code)) { try { child.kill('SIGTERM'); } catch {} }
        }
        killTimer = setTimeout(() => {
          if (!finished) {
            try { killGroup(child.pid, 'SIGKILL'); } catch (cause) {
              if (!['ESRCH', 'EPERM'].includes(cause.code)) { try { child.kill('SIGKILL'); } catch {} }
            }
          }
        }, 1000);
      } else {
        child.kill();
      }
    };
    const timer = setTimeout(() => stop(new CollectorError('COLLECTION_TIMEOUT', '本地采集超时，请稍后重试', 504, true)), timeoutMs);
    const abort = () => stop(new CollectorError('COLLECTION_CANCELLED', '本地采集已停止'));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    child.stdout.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_RAW_BYTES) stop(new CollectorError('COLLECTION_TOO_LARGE', '原始采集结果超过 8 MiB 限制', 413));
      else chunks.push(chunk);
    });
    child.stderr.on('data', (chunk) => { stderrSize += chunk.length; });
    const cleanup = () => {
      finished = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      signal.removeEventListener('abort', abort);
    };
    child.on('error', (error) => {
      if (failure && error.code === 'EPERM') return;
      cleanup();
      reject(error.code === 'ROOT_COLLECTOR_UNAVAILABLE' ? error :
        new CollectorError('COLLECTOR_UNAVAILABLE', '无法连接 sysAK IDC 服务，请检查服务是否已安装并运行'));
    });
    child.once('close', (code) => {
      cleanup();
      if (failure) return reject(failure);
      if (code === 126 || code === 127) return reject(new CollectorError('ROOT_COLLECTOR_UNAVAILABLE', 'sysAK IDC 服务身份或组件校验失败，请检查安装与用户授权', 403));
      if (code === 75) return reject(new CollectorError('ROOT_SERVICE_BUSY', 'sysAK IDC 服务正在处理其他请求，请稍后重试', 503, true));
      if (code === 125) return reject(new CollectorError('COLLECTION_TOO_LARGE', 'sysAK IDC 服务响应超过限制', 413));
      if (code === 124) return reject(new CollectorError('COLLECTION_TIMEOUT', 'root sysAK 采集超过执行时限', 504, true));
      if (code !== 0) return reject(new CollectorError('COLLECTION_FAILED', 'sysAK 采集未正常完成', 503, true));
      try {
        const raw = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (raw.schema_version !== '1.0' || raw.request_id !== requestId || raw.collector?.name !== 'sysak' ||
            raw.collection?.profile !== profile || !['ok', 'partial'].includes(raw.collection?.status) ||
            !raw.resources || !raw.configuration || !raw.diagnostics || raw.capabilities?.read_only !== true) {
          throw new Error('invalid collection');
        }
        resolve({ raw, bytes: size, stderrBytes: stderrSize });
      } catch {
        reject(new CollectorError('INVALID_COLLECTION', 'sysAK 返回了无效的原始采集 JSON', 502, true));
      }
    });
  });
}

function validState(state) {
  const nonnegative = (value) => Number.isFinite(value) && value >= 0;
  const quantity = (value, units) => value && units.includes(value.unit) && nonnegative(value.value) &&
    (value.total === undefined || nonnegative(value.total)) && (value.available === undefined || nonnegative(value.available));
  const gpuDevice = (device) => device && Number.isSafeInteger(device.index) && device.index >= 0 &&
    ['name', 'uuid', 'busId'].every((key) => typeof device[key] === 'string') &&
    ['utilization', 'memoryUtilization'].every((key) => device[key] === null || nonnegative(device[key]) && device[key] <= 100) &&
    ['memoryUsedBytes', 'memoryTotalBytes', 'temperatureCelsius', 'powerWatts', 'powerLimitWatts', 'eccCorrected', 'eccUncorrected', 'pcieGeneration', 'pcieMaxGeneration', 'pcieWidth'].every((key) => device[key] === null || nonnegative(device[key]));
  const gpuStatuses = ['not_run', 'ok', 'partial', 'unavailable', 'error', 'timeout', 'truncated', 'permission_denied'];
  const date = (value) => value === null || typeof value === 'string' && Number.isFinite(Date.parse(value));
  const finding = (value) => value && typeof value.check === 'string' && value.check.length <= 128 &&
    typeof value.message === 'string' && value.message.length <= 1024 && ['OK', 'WARN', 'ERROR'].includes(value.severity) &&
    (value.suggestion === undefined || typeof value.suggestion === 'string' && value.suggestion.length <= 1024);
  const findings = (value) => Array.isArray(value) && value.length <= 256 && value.every(finding);
  const nullableInteger = (value) => value === null || Number.isSafeInteger(value) && nonnegative(value);
  const jobAnalysis = (report) => report && gpuStatuses.includes(report.status) && report.source === 'sysak ai' &&
    date(report.sampledAt) && (report.sampleWindowSeconds === null || nonnegative(report.sampleWindowSeconds) && report.sampleWindowSeconds <= 10) &&
    typeof report.complete === 'boolean' && typeof report.reason === 'string' && report.reason.length <= 256 &&
    Array.isArray(report.processes) && report.processes.length <= 128 && new Set(report.processes.map((process) => process?.pid)).size === report.processes.length &&
    report.processes.every((process) => process && Number.isSafeInteger(process.pid) && process.pid > 0 && process.pid <= 2147483647 &&
      nullableInteger(process.starttime) && nullableInteger(process.rssBytes) && typeof process.name === 'string' && process.name.length <= 256 &&
      typeof process.state === 'string' && process.state.length <= 16 && (process.cpuPercent === null || nonnegative(process.cpuPercent)) &&
      ['smUtilization', 'memoryUtilization'].every((key) => process[key] === null || nonnegative(process[key]) && process[key] <= 100) &&
      Array.isArray(process.gpuIndices) && process.gpuIndices.length <= 32 && new Set(process.gpuIndices).size === process.gpuIndices.length &&
      process.gpuIndices.every((index) => Number.isSafeInteger(index) && index >= 0 && index < 32) &&
      gpuStatuses.includes(process.status) && findings(process.findings)) &&
    (!report.complete || report.status === 'ok' && report.sampleWindowSeconds > 0 && report.processes.every((process) => process.status === 'ok'));
  const gpuDiagnostic = (report) => report && gpuStatuses.includes(report.status) &&
    ['normal', 'abnormal', 'unknown', 'no_gpu'].includes(report.outcome) && report.source === 'sysak ai' &&
    typeof report.complete === 'boolean' && typeof report.summary === 'string' &&
    (report.sampledAt === null || typeof report.sampledAt === 'string' && Number.isFinite(Date.parse(report.sampledAt))) &&
    (report.gpuCount === null || Number.isSafeInteger(report.gpuCount) && report.gpuCount >= 0) &&
    ['architectures', 'devices'].every((key) => Array.isArray(report[key]) && report[key].length <= 32 && report[key].every((value) => typeof value === 'string')) &&
    findings(report.findings) && (report.jobAnalysis === undefined || jobAnalysis(report.jobAnalysis));
  return state && (state.gpuDiagnostic === undefined || gpuDiagnostic(state.gpuDiagnostic)) && ['collected', 'demo'].includes(state.mode) && typeof state.hasGpu === 'boolean' && Number.isInteger(state.revision) && state.revision > 0 &&
    typeof state.sampledAt === 'string' && Array.isArray(state.inspections) && Array.isArray(state.optimizations) &&
    Array.isArray(state.operations) && ['cpu', 'energy', 'memory', 'disk', 'gpu'].every((id) => {
      const resource = state.resources?.[id];
      return resource && typeof resource.label === 'string' && ['%', 'W', 'GB'].includes(resource.unit) &&
        (resource.rankUnit === undefined || ['%', 'B', 'B/s', 'W', 'count'].includes(resource.rankUnit)) &&
        (resource.usage === null || (nonnegative(resource.usage) && resource.usage <= 100)) &&
        (resource.quantity === undefined || quantity(resource.quantity, ['B', 'W'])) &&
        (resource.gpuDevices === undefined || Array.isArray(resource.gpuDevices) && resource.gpuDevices.length <= 32 && resource.gpuDevices.every(gpuDevice)) &&
        Array.isArray(resource.rows) && resource.rows.every((row) => nonnegative(row.usage) &&
          (row.quantity === undefined || quantity(row.quantity, ['B', 'B/s', 'W', 'count'])));
    });
}

async function createIdcController(options) {
  const { bundleRoot, deviceId = crypto.randomUUID(), startMockOpenApi, hasGpu = true, settingsPath,
    inspectionIntervalMinutes = 5, scheduler = { now: Date.now, setTimeout, clearTimeout } } = options;
  if (!UUID.test(deviceId)) throw new CollectorError('INVALID_DEVICE_ID', '设备标识无效', 400);
  function validateInterval(minutes) {
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) {
      throw new CollectorError('INVALID_INSPECTION_INTERVAL', '巡检周期必须为 1–1440 的整数分钟', 400);
    }
  }
  validateInterval(inspectionIntervalMinutes);
  let intervalMinutes = inspectionIntervalMinutes;
  let settingsError = null;
  if (settingsPath) {
    try {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      if (!settings || typeof settings !== 'object' || Array.isArray(settings) ||
          Object.keys(settings).some((key) => key !== 'inspection_interval_minutes')) throw new Error('invalid settings');
      validateInterval(settings.inspection_interval_minutes);
      intervalMinutes = settings.inspection_interval_minutes;
    } catch (error) {
      if (error.code !== 'ENOENT') {
        intervalMinutes = 5;
        settingsError = new CollectorError('SETTINGS_LOAD_FAILED', '巡检周期配置读取失败，已使用默认 5 分钟', 500);
      }
    }
  }
  let installed = false;
  let installError = null;
  try {
    verifyBundle(bundleRoot);
    (options.verifyExecutionImpl || verifyRootInstallation)(path.join(bundleRoot, 'sysak'));
    installed = true;
  } catch (error) {
    installError = error instanceof CollectorError ? error : new CollectorError(
      error.code === 'ROOT_COLLECTOR_UNAVAILABLE' ? error.code : 'COLLECTOR_UNAVAILABLE',
      error.code === 'ROOT_COLLECTOR_UNAVAILABLE' ? error.message : 'sysAK 采集组件尚未随应用安装');
  }
  const token = crypto.randomBytes(32).toString('hex');
  const api = await startMockOpenApi({ token });
  let enabled = true;
  let closed = false;
  let phase = installed ? 'idle' : 'error';
  let lastError = installError || settingsError;
  let lastTask = null;
  const tasks = [];
  let queryServer = null;
  let queryError = null;
  let cached = null;
  let processTargets = new Map();
  let cleanupPlan = null;
  const localOperations = [];
  const processAction = options.processActionImpl || ((action, targets) => runProcessAction(path.join(bundleRoot, 'sysak'), action, targets));
  let queue = Promise.resolve();
  let active = null;
  let snapshotPending = null;
  let agentPending = null;
  let agentCached = null;
  let agentCachedAt = null;
  let agentActive = null;
  const agentService = options.agentSightService ? createAgentSightService({
    ...options.agentSight,
    collectionControlImpl: options.agentSight?.collectionControlImpl || (action => controlAgentCollection(path.join(bundleRoot, 'sysak'), action)),
  }) : null;
  void agentService?.ensure();
  let inspectionTimer = null;
  let nextInspectionAt = null;
  let scheduleGeneration = 0;
  let automaticPending = false;
  const enqueue = (job) => {
    const pending = queue.then(job);
    queue = pending.catch(() => {});
    return pending;
  };
  function status() {
    return { schema_version: '1.0', mode: 'mock', read_only: true, device_id: deviceId, installed, enabled: enabled && !closed,
      phase, api_version: '1.0', last_task: lastTask, inspection_interval_minutes: intervalMinutes,
      next_inspection_at: nextInspectionAt, error: lastError ? { code: lastError.code, message: lastError.message } : null,
      query_api: { enabled: !!queryServer, base_url: queryServer?.baseUrl ?? null, instance_id: queryServer?.instanceId ?? null,
        error: queryError }, ...(agentService ? { agent_sight: agentService.status() } : {}) };
  }
  function queryView() {
    return structuredClone({ status: status(), state: cached, agent: agentCached, tasks });
  }
  function rememberTask(task) {
    tasks.unshift(task);
    tasks.splice(100);
  }
  function clearInspectionTimer() {
    scheduleGeneration++;
    if (inspectionTimer !== null) scheduler.clearTimeout(inspectionTimer);
    inspectionTimer = null;
    nextInspectionAt = null;
  }
  function scheduleInspection() {
    if (closed || !enabled || !installed || inspectionTimer !== null) return;
    const generation = scheduleGeneration;
    const delay = intervalMinutes * 60000;
    nextInspectionAt = new Date(scheduler.now() + delay).toISOString();
    inspectionTimer = scheduler.setTimeout(() => {
      if (generation !== scheduleGeneration || closed || !enabled) return;
      inspectionTimer = null;
      nextInspectionAt = null;
      if (automaticPending) {
        scheduleInspection();
        return;
      }
      automaticPending = true;
      void enqueue(async () => {
        if (generation !== scheduleGeneration || closed || !enabled) return;
        if (!cached) await submit('snapshot', { hasGpu });
        if (generation !== scheduleGeneration || closed || !enabled) return;
        await submit('inspect', { revision: cached.revision });
      }).catch(() => {}).finally(() => {
        automaticPending = false;
        if (generation === scheduleGeneration) scheduleInspection();
      });
    }, delay);
    inspectionTimer.unref?.();
  }
  function requireProcessControl() {
    if (!enabled || closed) throw new CollectorError('COLLECTOR_DISABLED', '巡检已暂停或组件已退出，不允许结束进程', 409);
    if (!installed) throw installError;
    if (!cached) throw new CollectorError('SNAPSHOT_REQUIRED', '请先刷新资源快照', 409);
  }
  async function annotateProcesses(raw, state) {
    cleanupPlan = null;
    processTargets = new Map();
    const samples = raw.resources?.processes?.content?.samples;
    const observed = Array.isArray(samples) ? samples.at(-1)?.processes : [];
    const identities = new Map((Array.isArray(observed) ? observed : []).filter(p => Number.isSafeInteger(p.pid) && p.pid > 1 && Number.isSafeInteger(p.starttime) && p.starttime >= 0)
      .map(p => [`process-${p.pid}-${p.starttime}`, { pid: p.pid, starttime: p.starttime }]));
    const rows = ['cpu', 'memory', 'disk'].flatMap(id => state.resources[id].rows);
    for (const item of Object.values(state.resources).flatMap(resource => resource.rows)) {
      item.cleanable = false;
      item.defaultSelected = false;
      item.effect = '非进程对象或身份无法核验';
    }
    for (const item of rows) {
      const identity = identities.get(item.id);
      if (identity && item.pid === identity.pid && item.starttime === identity.starttime && processTargets.size < 100) processTargets.set(item.id, identity);
    }
    if (!processTargets.size) return;
    try {
      const targets = [...processTargets.values()];
      const results = await processAction('check', targets);
      const checked = new Map(results.map((result, index) => [`process-${targets[index].pid}-${targets[index].starttime}`, result]));
      for (const item of rows) {
        const identity = processTargets.get(item.id);
        const result = identity && item.pid === identity.pid && item.starttime === identity.starttime ? checked.get(item.id) : undefined;
        item.cleanable = result?.status === 'eligible' && result.eligible === true;
        item.effect = item.cleanable ? '结束整个进程（SIGTERM），可能中断任务' : result?.reason || '身份无法核验';
      }
    } catch {
      for (const item of rows) item.effect = '受控进程操作不可用，请检查 sysAK 版本和权限';
    }
  }
  async function submit(operation, parameters = {}) {
    if (!enabled || closed) throw new CollectorError('COLLECTOR_DISABLED', '本地采集已暂停，请先启用采集');
    if (!installed) throw installError;
    const requestId = crypto.randomUUID();
    const profile = operation === 'inspect' ? 'inspection' : 'resources';
    active = new AbortController();
    const signal = active.signal;
    try {
      phase = 'collecting';
      lastError = null;
      const result = await collectRaw(path.join(bundleRoot, 'sysak'), profile, requestId, signal, options);
      if (signal.aborted) throw new CollectorError('COLLECTION_CANCELLED', '本地采集已停止');
      phase = 'submitting';
      const timeout = setTimeout(() => active?.abort(), 30000);
      let response;
      try {
        response = await fetch(`${api.baseUrl}/openapi/v1/collections`, {
          method: 'POST', signal,
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: JSON.stringify({ schema_version: '1.0', request_id: requestId, device_id: deviceId,
            operation, parameters, raw_snapshot: result.raw }),
        });
        const text = await response.text();
        if (Buffer.byteLength(text) > 1024 * 1024) throw new CollectorError('INVALID_API_RESPONSE', 'OpenAPI 响应超过大小限制', 502);
        const parsed = JSON.parse(text);
        if (!response.ok) throw new CollectorError(parsed.error?.code || 'OPENAPI_FAILED', parsed.error?.message || 'OpenAPI 请求失败', response.status, parsed.error?.retryable === true);
        if (parsed.schema_version !== '1.0' || parsed.request_id !== requestId || parsed.mode !== 'mock' ||
            parsed.read_only !== true || parsed.state?.mode !== 'collected' || parsed.task?.simulated !== false ||
            !validState(parsed.state) || !UUID.test(parsed.task_id || '')) {
          throw new CollectorError('INVALID_API_RESPONSE', 'OpenAPI 返回了不兼容的展示数据', 502);
        }
        const nextState = parsed.state;
        nextState.operations = [...localOperations, ...nextState.operations.filter(item => !item.id.startsWith('process-cleanup-'))].slice(0, 30);
        await annotateProcesses(result.raw, nextState);
        if (signal.aborted) throw new CollectorError('COLLECTION_CANCELLED', '本地采集已停止');
        cached = nextState;
        lastTask = { id: parsed.task_id, request_id: requestId, operation, status: parsed.task?.status || 'completed',
          profile, collection_status: result.raw.collection.status, raw_bytes: result.bytes,
          collected_at: result.raw.collection.finished_at, simulated: parsed.task.simulated };
        rememberTask(lastTask);
        phase = 'idle';
        return structuredClone(cached);
      } finally { clearTimeout(timeout); }
    } catch (error) {
      lastError = error instanceof CollectorError ? error : error.code === 'ROOT_COLLECTOR_UNAVAILABLE'
        ? new CollectorError(error.code, error.message)
        : new CollectorError('OPENAPI_UNAVAILABLE', '模拟 OpenAPI 暂不可用，请稍后重试', 503, true);
      phase = enabled && !closed ? 'error' : 'disabled';
      throw lastError;
    } finally { active = null; }
  }
  if (options.queryApi) {
    try {
      const { startLocalQueryApi } = require('./local-query-api.cjs');
      queryServer = await startLocalQueryApi({ ...options.queryApi, queryView });
    } catch {
      queryError = { code: 'QUERY_API_UNAVAILABLE', message: '本机查询接口启动失败，请检查 local-api 目录安全权限' };
    }
  }
  scheduleInspection();
  return {
    status,
    queryView,
    snapshot(refresh = false) {
      if (typeof refresh !== 'boolean') return Promise.reject(new CollectorError('INVALID_PARAMETERS', '刷新参数必须为布尔值', 400));
      if (cached && !refresh) return Promise.resolve(structuredClone(cached));
      if (!snapshotPending) snapshotPending = enqueue(() => submit('snapshot', { hasGpu })).finally(() => { snapshotPending = null; });
      return snapshotPending.then((state) => structuredClone(state));
    },
    agentSnapshot(refresh = false) {
      if (typeof refresh !== 'boolean') return Promise.reject(new CollectorError('INVALID_PARAMETERS', '刷新参数必须为布尔值', 400));
      if (!enabled || closed) return Promise.reject(new CollectorError('COLLECTOR_DISABLED', '采集已暂停或应用已退出', 409));
      const cacheAge = agentCachedAt === null ? Infinity : scheduler.now() - agentCachedAt;
      if (agentCached && !refresh && cacheAge >= 0 && cacheAge < 60_000) return Promise.resolve(structuredClone(agentCached));
      if (!agentPending) agentPending = enqueue(async () => {
        if (!enabled || closed) throw new CollectorError('COLLECTOR_DISABLED', '采集已暂停或应用已退出', 409);
        agentActive = new AbortController();
        const signal = agentActive.signal;
        try {
          const serviceStatus = await agentService?.ensure();
          if (signal.aborted) throw new CollectorError('COLLECTION_CANCELLED', 'Agent 诊断已停止');
          const raw = await collectAgentEvidence({ ...options.agentSight, ...(agentService ? { baseUrl: agentService.endpoint() } : {}), signal, now: scheduler.now() });
          if (serviceStatus?.state === 'unavailable') {
            for (const source of Object.values(raw.sources)) {
              if (source.status === 'unavailable') source.reason = serviceStatus.message;
            }
          }
          const timeout = setTimeout(() => agentActive?.abort(), 30000);
          try {
            const requestId = crypto.randomUUID();
            const response = await fetch(`${api.baseUrl}/openapi/v1/agent-diagnostics`, {
              method: 'POST', signal, redirect: 'error',
              headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
              body: JSON.stringify({ schema_version: '1.0', request_id: requestId, device_id: deviceId, raw_snapshot: raw }),
            });
            const chunks = [];
            let size = 0;
            for await (const chunk of response.body) {
              size += chunk.byteLength;
              if (size > 1024 * 1024) throw new CollectorError('INVALID_API_RESPONSE', 'OpenAPI 响应超过大小限制', 502);
              chunks.push(Buffer.from(chunk));
            }
            const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (!response.ok) throw new CollectorError(parsed.error?.code || 'OPENAPI_FAILED', parsed.error?.message || 'OpenAPI Agent 分析失败', response.status, parsed.error?.retryable === true);
            const report = parsed.report;
            if (parsed.schema_version !== '1.0' || parsed.request_id !== requestId || parsed.mode !== 'mock' || parsed.read_only !== true ||
                !UUID.test(parsed.task_id || '') || parsed.task?.simulated !== false || parsed.task?.operation !== 'agent-diagnose' ||
                report?.source !== 'agentsight' || report.analyzer !== 'sysom-openapi' || typeof report.sampledAt !== 'string' ||
                typeof report.summary !== 'string' || !['ok', 'partial', 'unavailable'].includes(report.status) ||
                !['observed', 'abnormal', 'unknown'].includes(report.outcome) || !report.window || !report.totals ||
                !['processes', 'sessions', 'interruptions', 'latency', 'coverage', 'findings'].every(key => Array.isArray(report[key]))) {
              throw new CollectorError('INVALID_API_RESPONSE', 'OpenAPI 返回了不兼容的 Agent 诊断数据', 502);
            }
            if (signal.aborted || !enabled || closed) throw new CollectorError('COLLECTION_CANCELLED', 'Agent 诊断已停止');
            agentCached = report;
            agentCachedAt = scheduler.now();
            rememberTask({ id: parsed.task_id, request_id: requestId, operation: 'agent-diagnose',
              status: parsed.task.status || 'completed', collected_at: report.sampledAt, simulated: false });
            return structuredClone(agentCached);
          } finally { clearTimeout(timeout); }
        } catch (error) {
          if (error.code && error.status) throw error;
          throw new CollectorError('OPENAPI_UNAVAILABLE', '本地 OpenAPI Agent 分析暂不可用，请重试；原诊断结果已保留', 503, true);
        } finally { agentActive = null; }
      }).finally(() => { agentPending = null; });
      return agentPending.then(report => structuredClone(report));
    },
    reset(parameters = {}) {
      if (Object.keys(parameters).some((key) => key !== 'hasGpu') || (parameters.hasGpu !== undefined && typeof parameters.hasGpu !== 'boolean')) {
        return Promise.reject(new CollectorError('INVALID_PARAMETERS', '无效的设备展示参数', 400));
      }
      return enqueue(() => submit('reset', { hasGpu, ...parameters }));
    },
    operation(payload) {
      if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !operations.has(payload.operation) ||
          ['snapshot', 'reset'].includes(payload.operation) || !payload.parameters || typeof payload.parameters !== 'object' ||
          Array.isArray(payload.parameters) || Object.keys(payload).some((key) => !['operation', 'parameters'].includes(key)) ||
          Buffer.byteLength(JSON.stringify(payload)) > 8192) {
        return Promise.reject(new CollectorError('INVALID_OPERATION', '不支持的本地采集操作', 400));
      }
      if (payload.operation !== 'inspect') return Promise.reject(new CollectorError('read_only', '真实资源数据为只读，不支持清理、优化或模拟改值', 409));
      return enqueue(() => submit(payload.operation, payload.parameters));
    },
    prepareProcessCleanup(payload) {
      return enqueue(async () => {
        requireProcessControl();
        if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).some(key => !['resource', 'ids', 'revision'].includes(key)) ||
            !['cpu', 'memory', 'disk'].includes(payload.resource) || !Array.isArray(payload.ids) || !payload.ids.length || payload.ids.length > 10 ||
            !payload.ids.every(id => typeof id === 'string') || new Set(payload.ids).size !== payload.ids.length || !Number.isInteger(payload.revision)) {
          throw new CollectorError('INVALID_PARAMETERS', '请选择 1–10 个有效进程', 400);
        }
        if (payload.revision !== cached.revision) throw new CollectorError('STALE_SNAPSHOT', '资源已更新，请重新选择进程', 409);
        const rows = payload.ids.map(id => cached.resources[payload.resource].rows.find(row => row.id === id && row.cleanable && processTargets.has(id)));
        if (rows.some(row => !row)) throw new CollectorError('PROTECTED_PROCESS', '对象已失效或不允许结束，请刷新后重选', 409);
        cleanupPlan = null;
        const targets = rows.map(row => processTargets.get(row.id));
        let results;
        try { results = await processAction('check', targets); }
        catch { throw new CollectorError('PROCESS_CONTROL_UNAVAILABLE', 'sysAK 受控进程操作不可用', 503); }
        requireProcessControl();
        if (results.some(item => item.status !== 'eligible' || !item.eligible)) throw new CollectorError('PROTECTED_PROCESS', '进程身份或权限已变化，请刷新后重选', 409);
        cleanupPlan = { token: crypto.randomBytes(32).toString('hex'), revision: cached.revision, expires: scheduler.now() + 60000, targets,
          processes: rows.map((row, index) => ({ id: row.id, pid: row.pid, starttime: row.starttime, name: results[index].name })) };
        return { token: cleanupPlan.token, revision: cleanupPlan.revision, expires_at: new Date(cleanupPlan.expires).toISOString(), processes: structuredClone(cleanupPlan.processes) };
      });
    },
    executeProcessCleanup(payload) {
      return enqueue(async () => {
        requireProcessControl();
        if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).some(key => key !== 'token') || typeof payload.token !== 'string' || !/^[a-f0-9]{64}$/.test(payload.token)) {
          throw new CollectorError('INVALID_PARAMETERS', '无效的确认凭证', 400);
        }
        const plan = cleanupPlan;
        if (!plan || plan.token !== payload.token) throw new CollectorError('INVALID_CLEANUP_PLAN', '确认已失效或已使用，请重新选择', 409);
        cleanupPlan = null;
        if (scheduler.now() >= plan.expires || plan.revision !== cached.revision) throw new CollectorError('EXPIRED_CLEANUP_PLAN', '确认已过期或快照已更新，请重新选择', 409);
        for (const resource of Object.values(cached.resources)) for (const row of resource.rows) if (plan.processes.some(item => item.id === row.id)) row.cleanable = false;
        let results;
        try { results = await processAction('terminate', plan.targets); }
        catch { throw new CollectorError('PROCESS_RESULT_UNKNOWN', '操作结果未完整返回，请刷新核对，不要重复结束进程', 503); }
        const operation = { id: `process-cleanup-${crypto.randomUUID()}`, kind: 'cleanup', revision: cached.revision,
          time: new Date(scheduler.now()).toISOString(), names: results.map(item => `${item.name} (PID ${item.pid}) · ${item.status}`) };
        localOperations.unshift(operation);
        localOperations.splice(30);
        cached.operations.unshift(operation);
        cached.operations.splice(30);
        return { revision: cached.revision, results, refresh_required: true };
      });
    },
    setEnabled(value) {
      if (typeof value !== 'boolean') throw new CollectorError('INVALID_PARAMETERS', '采集启停参数必须为布尔值', 400);
      if (closed) throw new CollectorError('COLLECTOR_CLOSED', '采集组件已退出');
      enabled = value;
      cleanupPlan = null;
      clearInspectionTimer();
      if (!value) { active?.abort(); agentActive?.abort(); phase = 'disabled'; }
      else { lastError = installError; phase = installed ? 'idle' : 'error'; scheduleInspection(); }
      return status();
    },
    setInspectionInterval(minutes) {
      validateInterval(minutes);
      if (closed) throw new CollectorError('COLLECTOR_CLOSED', '采集组件已退出');
      if (settingsPath) {
        const temporary = `${settingsPath}.${crypto.randomUUID()}.tmp`;
        let ownsTemporary = false;
        try {
          fs.writeFileSync(temporary, JSON.stringify({ inspection_interval_minutes: minutes }), { mode: 0o600, flag: 'wx' });
          ownsTemporary = true;
          fs.renameSync(temporary, settingsPath);
        } catch {
          if (ownsTemporary) { try { fs.unlinkSync(temporary); } catch {} }
          throw new CollectorError('SETTINGS_SAVE_FAILED', '巡检周期保存失败，原有设置未改变', 500);
        }
      }
      intervalMinutes = minutes;
      settingsError = null;
      if (lastError?.code === 'SETTINGS_LOAD_FAILED') lastError = null;
      clearInspectionTimer();
      scheduleInspection();
      return status();
    },
    async close() {
      closed = true;
      enabled = false;
      clearInspectionTimer();
      phase = 'disabled';
      active?.abort();
      agentActive?.abort();
      const queryClosing = queryServer?.close();
      queryServer = null;
      await Promise.all([queue, queryClosing, agentService?.close()]);
      await api.close();
    },
  };
}

module.exports = { CollectorError, collectRaw, createIdcController, verifyBundle, validState };
