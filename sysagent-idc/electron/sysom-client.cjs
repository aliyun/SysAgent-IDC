'use strict';
// 只读 SysOM 步骤5客户端（主进程）。上传(1–4)仍由 sysAK 负责，本模块只做
// getHostInspection 轮询 + getInspectionReport 取报告。凭证只从 env 读取，
// 绝不写日志或持久化。SDK 可注入假替身用于单测，不触网。

// 终态对齐后端 schemas.HOST_TERMINAL_STATUSES。
const TERMINAL_STATUSES = new Set([
  'completed', 'partial_completed', 'failed', 'expired', 'cancelled',
]);

// 放行给 sysAK 子进程的 env 白名单；其余一律洗掉，避免无关凭证泄漏给子进程。
const SYSAK_UPLOAD_ENV_KEYS = [
  'SYSOM_POP_ENDPOINT', 'SYSOM_ACCESS_KEY_ID', 'SYSOM_ACCESS_KEY_SECRET',
  'SYSOM_SECURITY_TOKEN', 'SYSOM_REGION_ID', 'SYSOM_DEVICE_ID', 'SYSOM_IDC_UPLOAD',
];

// 代理属网络配置而非凭据：办公网出口可能仅代理可达，洗掉会让 sysAK 直连网关
// 超时（upload url failed: 网关连接失败）。仅 pre 模式透传，mock 模式仍全洗。
const PROXY_ENV_KEYS = [
  'http_proxy', 'https_proxy', 'no_proxy',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY',
];

class SysomError extends Error {
  constructor(code, message, status = 503, retryable = false) {
    super(message);
    this.name = 'SysomError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

function clean(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function hostOf(endpoint) {
  let host = endpoint;
  if (host.includes('://')) host = host.split('://')[1];
  return host.split('/')[0].trim();
}

// 与 sysAK cloud.config.load_config 同语义：显式关闭或缺 endpoint/AK/SK 时返回
// null（桌面回退纯本地/mock）；否则给出 pre 模式配置。
function loadSysomConfig(env = process.env) {
  const sw = clean(env.SYSOM_IDC_UPLOAD);
  if (sw && ['0', 'false', 'no', 'off'].includes(sw.toLowerCase())) return null;
  const endpoint = clean(env.SYSOM_POP_ENDPOINT);
  const accessKeyId = clean(env.SYSOM_ACCESS_KEY_ID);
  const accessKeySecret = clean(env.SYSOM_ACCESS_KEY_SECRET);
  if (!endpoint || !accessKeyId || !accessKeySecret) return null;
  return {
    endpoint: hostOf(endpoint),
    accessKeyId,
    accessKeySecret,
    securityToken: clean(env.SYSOM_SECURITY_TOKEN),
    regionId: clean(env.SYSOM_REGION_ID) || 'cn-hangzhou',
    deviceId: clean(env.SYSOM_DEVICE_ID),
  };
}

// 子进程 env：基础三项 + 仅在 pre 模式(config 非空)放行 SYSOM_* 白名单与代理变量。
// mock 模式即使父 env 里有 AK/SK 也不外泄，保持既有安全回归。
function sysakChildEnv(config, env = process.env) {
  const base = {
    PATH: env.PATH || '/usr/local/bin:/usr/bin:/bin',
    LANG: 'C.UTF-8',
    PYTHONDONTWRITEBYTECODE: '1',
  };
  if (!config) return base;
  for (const key of PROXY_ENV_KEYS.concat(SYSAK_UPLOAD_ENV_KEYS)) {
    const value = clean(env[key]);
    if (value !== undefined) base[key] = value;
  }
  return base;
}

function plain(value) {
  if (value && typeof value.toMap === 'function') return value.toMap();
  return value;
}

function toSysomError(error) {
  if (error instanceof SysomError) return error;
  const data = error && error.data;
  const status = (error && (error.statusCode || error.status)) ||
    (data && (data.statusCode || data.StatusCode)) || 503;
  const code = (error && error.code) || (data && (data.Code || data.code)) || 'SysomCallFailed';
  const message = (error && error.message) || String(error);
  return new SysomError(code, message, status, status >= 500);
}

// 主进程 SDK 传输层(httpx)不读代理 env，Config 的代理字段在普通 HTTP 路径也
// 不被消费：仅代理出口的网络里 getHostInspection 会直连超时。用 global-agent
// 按 env 补丁全局 http(s)（forceGlobalAgent 默认 true，能覆盖 httpx 的显式 Agent）。
// v4 默认读 GLOBAL_AGENT_ 前缀的大写变量，故传空命名空间读标准变量，并把仅小写
// 的 env 临时归一为大写（bootstrap 时取值，调用后还原，不持久改动 process.env）。
function ensureProxyBootstrap(env = process.env, { bootstrap = require('global-agent').bootstrap } = {}) {
  if (globalThis.GLOBAL_AGENT) return false;
  const httpProxy = clean(env.HTTP_PROXY) || clean(env.http_proxy);
  const httpsProxy = clean(env.HTTPS_PROXY) || clean(env.https_proxy);
  if (!httpProxy && !httpsProxy) return false;
  const normalized = {
    HTTP_PROXY: httpProxy,
    HTTPS_PROXY: httpsProxy,
    NO_PROXY: clean(env.NO_PROXY) || clean(env.no_proxy),
  };
  const saved = new Map(Object.keys(normalized).map((key) => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(normalized)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    bootstrap({ environmentVariableNamespace: '' });
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  return true;
}

function createSysomClient(config, { client } = {}) {
  if (!config) throw new SysomError('SysomNotConfigured', '缺少 SysOM 预发配置', 400);
  const SDK = require('@alicloud/sysom20231230');
  let api = client;
  if (!api) {
    ensureProxyBootstrap();
    const core = require('@alicloud/openapi-core');
    const Client = SDK.default || SDK;
    api = new Client(new core.$OpenApiUtil.Config({
      accessKeyId: config.accessKeyId,
      accessKeySecret: config.accessKeySecret,
      securityToken: config.securityToken,
      endpoint: config.endpoint,
      regionId: config.regionId,
      protocol: 'HTTPS',
    }));
  }

  // getHostInspection 的 body 是扁平任务视图；getInspectionReport 的 body 是
  // {code,data,message} 信封，报告正文在 data。两者形状不同，分别归一。
  async function getHostInspection(inspectionId) {
    try {
      const resp = await api.getHostInspection(new SDK.GetHostInspectionRequest({ inspectionId }));
      return plain(resp && resp.body) || {};
    } catch (error) {
      throw toSysomError(error);
    }
  }

  async function getInspectionReport(reportId) {
    try {
      const resp = await api.getInspectionReport(new SDK.GetInspectionReportRequest({ reportId }));
      const body = plain(resp && resp.body) || {};
      if (body.code && body.code !== 'Success') {
        throw new SysomError(body.code, body.message || '巡检报告返回失败', 502);
      }
      return body.data || {};
    } catch (error) {
      throw toSysomError(error);
    }
  }

  async function pollHostInspection(inspectionId, {
    intervalMs = 3000, timeoutMs = 120000, signal, onProgress, onRetry,
  } = {}) {
    const deadline = Date.now() + timeoutMs;
    const wait = () => new Promise((resolve) => setTimeout(resolve, intervalMs));
    for (;;) {
      if (signal && signal.aborted) {
        throw new SysomError('PollCancelled', '巡检轮询已取消', 499);
      }
      let task;
      try {
        task = await getHostInspection(inspectionId);
      } catch (error) {
        // 网关偶发 5xx（retryable）：退避后重试直到 deadline，不因瞬时故障中断。
        if (error instanceof SysomError && error.retryable && Date.now() < deadline) {
          if (onRetry) onRetry(error);
          await wait();
          continue;
        }
        throw error;
      }
      if (onProgress) onProgress(task);
      if (TERMINAL_STATUSES.has(task.status)) return task;
      if (Date.now() >= deadline) {
        throw new SysomError('PollTimeout', '巡检分析超时，请稍后在报告中查看', 504, true);
      }
      await wait();
    }
  }

  return { getHostInspection, getInspectionReport, pollHostInspection };
}

module.exports = {
  TERMINAL_STATUSES,
  SYSAK_UPLOAD_ENV_KEYS,
  SysomError,
  loadSysomConfig,
  sysakChildEnv,
  ensureProxyBootstrap,
  createSysomClient,
};