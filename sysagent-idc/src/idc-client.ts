import type { AlertTarget, HealthState, ResourceId } from './health-data';

export interface CollectorStatus {
  schema_version: string;
  mode: 'mock' | 'offline-demo';
  read_only: boolean;
  device_id: string;
  installed: boolean;
  enabled: boolean;
  inspection_interval_minutes: number;
  next_inspection_at: string | null;
  phase: 'idle' | 'collecting' | 'submitting' | 'error' | 'disabled' | 'unsupported';
  api_version: string;
  agent_sight?: {
    state: 'running' | 'unavailable' | 'closed';
    message: string;
    collection?: {
      state: 'running' | 'disabled' | 'failed' | 'unavailable';
      enabled: boolean;
      scope: 'host' | 'none';
      trace_running: boolean;
      api_running: boolean;
      message: string;
    };
  };
  last_task: null | {
    id: string;
    request_id: string;
    operation: string;
    status: string;
    profile: string;
    collection_status: string;
    raw_bytes: number;
    collected_at: string;
    simulated: boolean;
  };
  error: null | { code: string; message: string };
}

export interface ProcessCleanupPlan {
  token: string;
  revision: number;
  expires_at: string;
  processes: { id: string; pid: number; starttime: number; name: string }[];
}
export interface ProcessCleanupResult {
  revision: number;
  refresh_required: boolean;
  results: { pid: number; starttime: number; name: string; eligible: boolean; status: string; reason: string }[];
}
export interface MutationResult { revision: number }
export interface OperationRequest { operation: string; parameters: Record<string, unknown> }
export interface ClientReply<T = unknown> {
  ok: boolean;
  data?: T;
  error?: { code: string; message: string; status: number; retryable: boolean };
}

export class DemoApiError extends Error {
  constructor(message: string, readonly status: number, readonly code = 'OPENAPI_FAILED') {
    super(message);
    this.name = 'DemoApiError';
  }
}

let hasGpu = true;
export function configureGpu(present: boolean) { hasGpu = present; }

async function decode<T>(reply: ClientReply<T>): Promise<T> {
  if (!reply.ok || reply.data === undefined) throw new DemoApiError(reply.error?.message || '本地采集请求失败', reply.error?.status || 503, reply.error?.code);
  return reply.data;
}

async function webRequest<T>(route: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api/idc/${route}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(65000),
    cache: 'no-store',
  });
  if (!response.headers.get('content-type')?.includes('application/json')) throw new DemoApiError('本地采集接口未启动，请通过桌面应用或开发服务器运行', 503);
  return decode(await response.json() as ClientReply<T>);
}

export async function fetchHealthSnapshot(refresh = false): Promise<HealthState> {
  const desktop = window.sysomDesktop;
  return desktop?.healthSnapshot ? decode(await desktop.healthSnapshot(refresh)) : webRequest(refresh ? 'snapshot?refresh=true' : 'snapshot');
}

export async function fetchAgentDiagnostic(refresh = false): Promise<import('./agent-diagnostics-data').AgentDiagnostic> {
  if (isOfflineDemo()) throw new DemoApiError('离线演示无法获取真实 AgentSight 数据', 409, 'OFFLINE_DEMO');
  const desktop = window.sysomDesktop;
  return desktop?.agentDiagnostic ? decode(await desktop.agentDiagnostic(refresh)) : webRequest(refresh ? 'agent-diagnostic?refresh=true' : 'agent-diagnostic');
}

export async function resetHealthSnapshot(): Promise<HealthState> {
  const desktop = window.sysomDesktop;
  return desktop?.healthReset ? decode(await desktop.healthReset({ hasGpu })) : webRequest('reset', { hasGpu });
}

async function operation(operation: string, parameters: Record<string, unknown>): Promise<MutationResult> {
  const desktop = window.sysomDesktop;
  const request = { operation, parameters };
  const state = desktop?.healthOperation ? await decode(await desktop.healthOperation(request)) : await webRequest<HealthState>('operations', request);
  return { revision: state.revision };
}

export async function prepareProcessCleanup(resource: ResourceId, ids: string[], revision: number): Promise<ProcessCleanupPlan> {
  if (isOfflineDemo()) throw new DemoApiError('离线演示不能结束真实进程', 409, 'OFFLINE_DEMO');
  const payload = { resource, ids, revision };
  const desktop = window.sysomDesktop;
  return desktop?.prepareProcessCleanup ? decode(await desktop.prepareProcessCleanup(payload)) : webRequest('process-prepare', payload);
}
export async function executeProcessCleanup(token: string): Promise<ProcessCleanupResult> {
  if (isOfflineDemo()) throw new DemoApiError('离线演示不能结束真实进程', 409, 'OFFLINE_DEMO');
  const desktop = window.sysomDesktop;
  return desktop?.executeProcessCleanup ? decode(await desktop.executeProcessCleanup({ token })) : webRequest('process-execute', { token });
}

export function cleanupResources(resource: ResourceId, ids: string[], revision: number) {
  return operation('cleanup', { resource, ids, revision });
}
export function optimizeHealth(ids: string[], revision: number) {
  return operation('optimize', { ids, revision });
}
export function cleanupAgentSessions(resource: ResourceId, agentId: string, sessionIds: string[], revision: number) {
  return operation('sessions-cleanup', { resource, agentId, sessionIds, revision });
}
export function setAlertSample(target: AlertTarget, usage: 80 | 96, revision: number) {
  return operation('alert-sample', { target, usage, revision });
}
export function runHealthInspection(revision: number) {
  return operation('inspect', { revision });
}
export function runGpuInspection(revision: number) {
  if (isOfflineDemo()) throw new DemoApiError('离线演示不能执行真实 GPU 诊断，请使用桌面应用或开发服务器', 409, 'OFFLINE_DEMO');
  return operation('inspect', { revision });
}

function isOfflineDemo() {
  return !window.sysomDesktop?.isElectron && !['http:', 'https:'].includes(window.location.protocol);
}

export async function fetchCollectorStatus(): Promise<CollectorStatus> {
  if (isOfflineDemo()) {
    return { schema_version: '1.0', mode: 'offline-demo', read_only: true, device_id: '', installed: false, enabled: false,
      inspection_interval_minutes: 5, next_inspection_at: null,
      phase: 'unsupported', api_version: '1.0', last_task: null, error: null };
  }
  const desktop = window.sysomDesktop;
  return desktop?.collectorStatus ? decode(await desktop.collectorStatus()) : webRequest('status');
}

export async function setCollectorEnabled(enabled: boolean): Promise<CollectorStatus> {
  const desktop = window.sysomDesktop;
  return desktop?.setCollectorEnabled ? decode(await desktop.setCollectorEnabled(enabled)) : webRequest('enabled', { enabled });
}

export async function setInspectionInterval(minutes: number): Promise<CollectorStatus> {
  if (isOfflineDemo()) throw new DemoApiError('离线演示不支持设置巡检周期，请通过桌面应用或开发服务器运行', 503, 'OFFLINE_DEMO');
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) {
    throw new DemoApiError('巡检周期必须为 1 至 1440 分钟的整数', 400, 'INVALID_INSPECTION_INTERVAL');
  }
  const desktop = window.sysomDesktop;
  return desktop?.setInspectionInterval ? decode(await desktop.setInspectionInterval(minutes)) : webRequest('interval', { inspection_interval_minutes: minutes });
}
