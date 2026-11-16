const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { runProcessAction } = require('./process-control.cjs');
const { collectAgentEvidence, createAgentSightService, controlAgentCollection } = require('./agentsight-client.cjs');
const { loadSysomConfig, sysakChildEnv, createSysomClient } = require('./sysom-client.cjs');

const MAX_RAW_BYTES = 8 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// 预发自动上传时 sysAK 把主报告 request_id 覆盖为 32 位十六进制 inspection_id。
const INSPECTION_ID = /^[0-9a-f]{32}$/i;
const operations = new Set(['snapshot', 'reset', 'inspect', 'cleanup', 'optimize', 'sessions-cleanup', 'alert-sample']);
const SYSAK_COMMAND = 'idc_inspect';
const SYSAK_SCHEMA = '1.1';
const SYSAK_PROFILE = 'inspection';
const SYSAK_ROOT = '/usr/local/sysak';
// idc_inspect 内部预算 24s、硬超时 30s，外层留出回收余量。
const COLLECTION_TIMEOUT_MS = 45000;
const PROCESS_RANKINGS = ['top_cpu', 'top_rss', 'top_sys', 'top_blkio_wait', 'top_d_state'];

class CollectorError extends Error {
  constructor(code, message, status = 503, retryable = false) {
    super(message);
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

function isFile(file, mode) {
  try {
    if (!fs.statSync(file).isFile()) return false;
    fs.accessSync(file, mode);
    return true;
  } catch { return false; }
}

// 与 sysak 的 set_path 一致：优先二进制同目录组件，其次固定安装根目录。
function componentsFor(binary) {
  const beside = path.join(path.dirname(fs.realpathSync(binary)), '.sysak_components');
  return fs.existsSync(beside) ? beside : path.join(SYSAK_ROOT, '.sysak_components');
}

function resolveSysak({ sysakBinary } = {}) {
  if (process.platform !== 'linux') throw new CollectorError('UNSUPPORTED_PLATFORM', '本地 sysAK 采集目前仅支持 Linux');
  const override = sysakBinary || process.env.SYSOM_SYSAK_BIN;
  const candidates = override ? [override] : ['/usr/bin/sysak', '/usr/local/bin/sysak',
    ...(process.env.PATH || '').split(path.delimiter).filter(Boolean).map((directory) => path.join(directory, 'sysak'))];
  const binary = candidates.map((candidate) => path.resolve(candidate)).find((candidate) => isFile(candidate, fs.constants.X_OK));
  if (!binary) throw new CollectorError('SYSAK_NOT_FOUND', '未找到已安装的 sysAK，请先安装 sysak 软件包后重试');
  const components = componentsFor(binary);
  const rules = path.join(components, 'tools', '.sysak.rules');
  // 组件缺失时 sysak 会尝试联网下载，必须在启动前拦截。
  if (!isFile(path.join(components, 'tools', SYSAK_COMMAND), fs.constants.R_OK) || !isFile(rules, fs.constants.R_OK) ||
      !fs.readFileSync(rules, 'utf8').split('\n').some((line) => line.split(':')[1] === SYSAK_COMMAND)) {
    throw new CollectorError('SYSAK_COMPONENT_MISSING', `sysAK 已安装但缺少 ${SYSAK_COMMAND} 组件，请安装包含该组件的 sysak 软件包`);
  }
  return { binary, components, source: override ? 'override' : 'system' };
}

// sysak 启动器用 printf 把组件诊断信息混入 stdout（sysak.c copy_file），只取首个完整 JSON 对象。
function collectionJson(text) {
  const start = text.indexOf('{');
  if (start < 0) throw new Error('missing json');
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === '{') depth++;
    else if (char === '}' && --depth === 0) return text.slice(start, index + 1);
  }
  throw new Error('unterminated json');
}

function collectRaw(binary, requestId, signal, { spawnImpl = spawn, killGroup = (pid, signal) => process.kill(-pid, signal), timeoutMs = COLLECTION_TIMEOUT_MS, env, allowInspectionId = false } = {}) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new CollectorError('COLLECTION_CANCELLED', '本地采集已停止'));
    const childEnv = env || { PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8', PYTHONDONTWRITEBYTECODE: '1' };
    const child = spawnImpl(binary, [SYSAK_COMMAND, '--request-id', requestId, '-o', '-'], {
      cwd: path.dirname(binary), detached: true, shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: childEnv,
    });
    let size = 0;
    let stderrSize = 0;
    let stderrCaptured = 0;
    const chunks = [];
    const stderrChunks = [];
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
        try { child.kill('SIGTERM'); } catch {}
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
    child.stderr.on('data', (chunk) => {
      stderrSize += chunk.length;
      if (stderrCaptured < 8192) { stderrChunks.push(chunk); stderrCaptured += chunk.length; }
    });
    const cleanup = () => {
      finished = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      signal.removeEventListener('abort', abort);
    };
    child.once('error', () => {
      cleanup();
      reject(new CollectorError('COLLECTOR_UNAVAILABLE', '无法启动 sysAK，请检查组件与 Python 3 是否已安装'));
    });
    child.once('close', (code) => {
      cleanup();
      if (failure) return reject(failure);
      if (code !== 0) return reject(new CollectorError('COLLECTION_FAILED', 'sysAK 采集未正常完成', 503, true));
      try {
        const raw = JSON.parse(collectionJson(Buffer.concat(chunks).toString('utf8')));
        const section = (name) => raw.sections?.[name] && typeof raw.sections[name] === 'object' && !Array.isArray(raw.sections[name]);
        const identityOk = raw.request_id === requestId || (allowInspectionId && INSPECTION_ID.test(raw.request_id));
        if (raw.schema_version !== SYSAK_SCHEMA || !identityOk || raw.collector?.name !== 'sysak' ||
            raw.collector?.command !== SYSAK_COMMAND || raw.collection?.profile !== SYSAK_PROFILE ||
            !['ok', 'partial'].includes(raw.collection?.status) || typeof raw.collection?.finished_at !== 'string' ||
            !raw.host || !raw.device || raw.capabilities?.read_only !== true ||
            !['cpu', 'memory', 'disk', 'fd'].every(section)) {
          throw new Error('invalid collection');
        }
        resolve({ raw, bytes: size, stderrBytes: stderrSize, stderrText: Buffer.concat(stderrChunks).toString('utf8') });
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

function collectionSummary(raw) {
  return {
    schema_version: raw.schema_version,
    command: raw.collector.command,
    version: typeof raw.collector.version === 'string' ? raw.collector.version : null,
    status: raw.collection.status,
    collected_at: raw.collection.finished_at,
    duration_ms: Number.isFinite(raw.collection.duration_ms) ? raw.collection.duration_ms : null,
    sections: Object.entries(raw.collection.sections || {}).map(([name, value]) => ({
      name, status: value?.status ?? 'unknown', reason: value?.reason ?? '',
    })),
  };
}

// 把 getHostInspection 的扁平任务视图归一为桌面云端巡检展示字段。
function cloudTaskView(task) {
  return {
    status: typeof task?.status === 'string' ? task.status : 'queued',
    phase: typeof task?.phase === 'string' ? task.phase : null,
    progress: Number.isFinite(task?.progress) ? task.progress : 0,
    reportId: typeof task?.reportId === 'string' ? task.reportId : null,
    reportStatus: typeof task?.reportStatus === 'string' ? task.reportStatus : null,
  };
}

const array = (value) => Array.isArray(value) ? value : [];

async function createIdcController(options) {
  const { bundleRoot, deviceId = crypto.randomUUID(), startMockOpenApi, hasGpu = true, settingsPath,
    inspectionIntervalMinutes = 5, scheduler = { now: Date.now, setTimeout, clearTimeout } } = options;
  if (!UUID.test(deviceId)) throw new CollectorError('INVALID_DEVICE_ID', '设备标识无效', 400);
  // 预发模式：env 提供 endpoint+AK/SK 时启用 sysAK 自动上传(步骤1–4)与桌面步骤5；
  // 缺凭证则回退纯本地 mock。sysomConfig 仅供单测注入。
  const config = options.sysomConfig !== undefined ? options.sysomConfig : loadSysomConfig();
  const collectOptions = { ...options, env: sysakChildEnv(config), allowInspectionId: !!config };
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
  let sysak = null;
  try { sysak = resolveSysak(options); installed = true; }
  catch (error) { installError = error instanceof CollectorError ? error : new CollectorError('SYSAK_NOT_FOUND', '未找到已安装的 sysAK，请先安装 sysak 软件包后重试'); }
  const token = crypto.randomBytes(32).toString('hex');
  const api = await startMockOpenApi({ token });
  // 步骤5只读客户端：仅在预发模式创建；sysomClient 供单测注入假替身，不触网。
  const sysom = config ? (options.sysomClient || createSysomClient(config)) : null;
  let enabled = true;
  let closed = false;
  let phase = installed ? 'idle' : 'error';
  let lastError = installError || settingsError;
  let lastTask = null;
  let lastCollection = null;
  const tasks = [];
  let queryServer = null;
  let queryError = null;
  let cached = null;
  let processTargets = new Map();
  let cleanupPlan = null;
  const localOperations = [];
  const processAction = options.processActionImpl || ((action, targets) => runProcessAction(sysak.binary, action, targets));
  let queue = Promise.resolve();
  let active = null;
  let snapshotPending = null;
  let agentPending = null;
  let agentCached = null;
  let agentCachedAt = null;
  let agentActive = null;
  let cloudInspection = null;
  let cloudPollController = null;
  let cloudGeneration = 0;
  // AgentSight 采集服务仍由 root 辅助进程管理；资源采集与进程操作已降到当前用户。
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
    return { schema_version: SYSAK_SCHEMA, mode: config ? 'pre' : 'mock', read_only: true, device_id: deviceId, installed, enabled: enabled && !closed,
      phase, api_version: '1.0', last_task: lastTask, inspection_interval_minutes: intervalMinutes,
      next_inspection_at: nextInspectionAt, error: lastError ? { code: lastError.code, message: lastError.message } : null,
      collector: { name: 'sysak', command: SYSAK_COMMAND, schema_version: SYSAK_SCHEMA,
        binary: sysak?.binary ?? null, source: sysak?.source ?? null, version: lastCollection?.version ?? null },
      collection: lastCollection, cloud_inspection: cloudInspection,
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
  // 步骤5后台轮询：不阻塞采集队列；新采集取代旧轮询，close/暂停可取消。
  // 终态后取一次真实报告，全程只读，结果写入 cloudInspection 供 status() 透出。
  function recordUploadFailure(stderrText) {
    cloudPollController?.abort();
    const line = (stderrText || '').split('\n').map((entry) => entry.trim()).find((entry) => entry.startsWith('idc_inspect: upload'));
    const detail = line ? line.replace(/^idc_inspect:\s*/, '') : 'sysAK 未完成云端上传';
    cloudInspection = { inspectionId: '', status: 'failed', phase: null, progress: 0, reportId: null, reportStatus: null,
      report: null, error: { code: 'UploadFailed', message: `上传失败：${detail}；本次仅本地采集` }, updatedAt: new Date().toISOString() };
  }
  function startCloudPoll(inspectionId) {
    cloudPollController?.abort();
    const controller = new AbortController();
    cloudPollController = controller;
    const generation = ++cloudGeneration;
    const stale = () => generation !== cloudGeneration || controller.signal.aborted;
    const stamp = () => new Date().toISOString();
    cloudInspection = { inspectionId, ...cloudTaskView(null), report: null, error: null, updatedAt: stamp() };
    void (async () => {
      try {
        const task = await sysom.pollHostInspection(inspectionId, {
          signal: controller.signal,
          onProgress: (view) => { if (!stale()) cloudInspection = { ...cloudInspection, ...cloudTaskView(view), updatedAt: stamp() }; },
        });
        if (stale()) return;
        cloudInspection = { ...cloudInspection, ...cloudTaskView(task), updatedAt: stamp() };
        if (!task.reportId) return;
        try {
          const report = await sysom.getInspectionReport(task.reportId);
          if (!stale()) cloudInspection = { ...cloudInspection, report, updatedAt: stamp() };
        } catch (error) {
          if (!stale()) cloudInspection = { ...cloudInspection, error: { code: error.code || 'ReportFetchFailed', message: error.message }, updatedAt: stamp() };
        }
      } catch (error) {
        if (!stale()) cloudInspection = { ...cloudInspection, error: { code: error.code || 'CloudPollFailed', message: error.message }, updatedAt: stamp() };
      }
    })();
  }
  async function annotateProcesses(raw, state) {
    cleanupPlan = null;
    processTargets = new Map();
    const sections = raw.sections || {};
    const observed = [
      ...PROCESS_RANKINGS.flatMap((name) => array(sections.process?.[name])),
      ...array(sections.io?.by_disk), ...array(sections.io?.by_vfs), ...array(sections.fd?.top_procs),
    ];
    const identities = new Map(observed.filter(p => p && Number.isSafeInteger(p.pid) && p.pid > 1 && Number.isSafeInteger(p.starttime) && p.starttime >= 0)
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
    active = new AbortController();
    const signal = active.signal;
    try {
      phase = 'collecting';
      lastError = null;
      const result = await collectRaw(sysak.binary, requestId, signal, collectOptions);
      if (signal.aborted) throw new CollectorError('COLLECTION_CANCELLED', '本地采集已停止');
      // 预发模式：sysAK 上传成功时主报告 request_id 即 32 位 hex inspection_id；
      // 上传失败回退 UUID 时不得当作云端任务去轮询步骤5。
      const inspectionId = config && INSPECTION_ID.test(result.raw.request_id) ? result.raw.request_id : null;
      const envelopeId = inspectionId || requestId;
      phase = 'submitting';
      const timeout = setTimeout(() => active?.abort(), 30000);
      let response;
      try {
        response = await fetch(`${api.baseUrl}/openapi/v1/collections`, {
          method: 'POST', signal,
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: JSON.stringify({ schema_version: SYSAK_SCHEMA, request_id: envelopeId, device_id: deviceId,
            operation, parameters, raw_snapshot: result.raw }),
        });
        const text = await response.text();
        if (Buffer.byteLength(text) > 1024 * 1024) throw new CollectorError('INVALID_API_RESPONSE', 'OpenAPI 响应超过大小限制', 502);
        const parsed = JSON.parse(text);
        if (!response.ok) throw new CollectorError(parsed.error?.code || 'OPENAPI_FAILED', parsed.error?.message || 'OpenAPI 请求失败', response.status, parsed.error?.retryable === true);
        if (parsed.schema_version !== SYSAK_SCHEMA || parsed.request_id !== envelopeId || parsed.mode !== 'mock' ||
            parsed.read_only !== true || parsed.state?.mode !== 'collected' || parsed.task?.simulated !== false ||
            !validState(parsed.state) || !UUID.test(parsed.task_id || '')) {
          throw new CollectorError('INVALID_API_RESPONSE', 'OpenAPI 返回了不兼容的展示数据', 502);
        }
        const nextState = parsed.state;
        nextState.operations = [...localOperations, ...nextState.operations.filter(item => !item.id.startsWith('process-cleanup-'))].slice(0, 30);
        await annotateProcesses(result.raw, nextState);
        if (signal.aborted) throw new CollectorError('COLLECTION_CANCELLED', '本地采集已停止');
        cached = nextState;
        lastCollection = collectionSummary(result.raw);
        lastTask = { id: parsed.task_id, request_id: envelopeId, operation, status: parsed.task?.status || 'completed',
          profile: SYSAK_PROFILE, collection_status: result.raw.collection.status, raw_bytes: result.bytes,
          collected_at: result.raw.collection.finished_at, simulated: parsed.task.simulated,
          uploaded: !!inspectionId, ...(inspectionId ? { inspection_id: inspectionId } : {}) };
        rememberTask(lastTask);
        phase = 'idle';
        if (config && inspectionId) startCloudPoll(inspectionId);
        else if (config) recordUploadFailure(result.stderrText);
        return structuredClone(cached);
      } finally { clearTimeout(timeout); }
    } catch (error) {
      lastError = error instanceof CollectorError ? error : new CollectorError('OPENAPI_UNAVAILABLE', '模拟 OpenAPI 暂不可用，请稍后重试', 503, true);
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
      if (!value) { active?.abort(); agentActive?.abort(); cloudPollController?.abort(); phase = 'disabled'; }
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
      cloudPollController?.abort();
      const queryClosing = queryServer?.close();
      queryServer = null;
      await Promise.all([queue, queryClosing, agentService?.close()]);
      await api.close();
    },
  };
}

module.exports = { CollectorError, collectRaw, collectionJson, createIdcController, resolveSysak, validState };
