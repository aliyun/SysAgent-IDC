import {
  availableAlertTargets,
  cleanupSessionsState,
  cleanupState,
  createInitialState,
  optimizeState,
  refreshState,
  setDemoUsageState,
  stateResourceIds,
  type AlertTarget,
  type HealthState,
  type ResourceId,
} from './health-data';

let hasGpu = true;
let state: HealthState = createInitialState(hasGpu);

export function configureGpu(present: boolean) {
  hasGpu = present;
  state = createInitialState(hasGpu);
}

const delay = () => new Promise<void>((resolve) => setTimeout(resolve, 180));

export interface MutationResult {
  revision: number;
}

export class DemoApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'DemoApiError';
  }
}

function assertRevision(revision: number) {
  if (!Number.isInteger(revision)) throw new DemoApiError('无效的快照版本', 400);
  if (revision !== state.revision) throw new DemoApiError('数据已更新，请刷新后重新选择', 409);
}

function assertIds(ids: string[], limit = 10) {
  if (!Array.isArray(ids) || !ids.length || ids.length > limit || !ids.every((id) => typeof id === 'string') || new Set(ids).size !== ids.length) {
    throw new DemoApiError('请选择有效的演示对象', 400);
  }
}

export async function fetchHealthSnapshot(): Promise<HealthState> {
  await delay();
  return structuredClone(state);
}

export async function resetHealthSnapshot(): Promise<HealthState> {
  await delay();
  state = createInitialState(hasGpu);
  return structuredClone(state);
}

export async function prepareProcessCleanup(_resource: ResourceId, _ids: string[], _revision: number): Promise<import('./idc-client').ProcessCleanupPlan> {
  throw new DemoApiError('离线演示不能结束真实进程', 409);
}

export async function executeProcessCleanup(_token: string): Promise<import('./idc-client').ProcessCleanupResult> {
  throw new DemoApiError('离线演示不能结束真实进程', 409);
}

export async function cleanupResources(resource: ResourceId, ids: string[], revision: number): Promise<MutationResult> {
  await delay();
  assertRevision(revision);
  assertIds(ids);
  if (!stateResourceIds(state).includes(resource) || !ids.every((id) => state.resources[resource].rows.some((row) => row.id === id && row.cleanable))) {
    throw new DemoApiError('对象不存在或不允许清理', 400);
  }
  state = cleanupState(state, resource, ids);
  state.operations = state.operations.slice(0, 30);
  return { revision: state.revision };
}

export async function optimizeHealth(ids: string[], revision: number): Promise<MutationResult> {
  await delay();
  assertRevision(revision);
  assertIds(ids);
  if (!ids.every((id) => state.optimizations.some((opt) => opt.id === id))) {
    throw new DemoApiError('优化项目已失效，请重新选择', 400);
  }
  state = optimizeState(state, ids);
  return { revision: state.revision };
}

export async function cleanupAgentSessions(
  resource: ResourceId,
  agentId: string,
  sessionIds: string[],
  revision: number,
): Promise<MutationResult> {
  await delay();
  assertRevision(revision);
  assertIds(sessionIds, 20);
  if (!stateResourceIds(state).includes(resource) || !state.resources[resource].rows.some((row) => row.agentId === agentId)) {
    throw new DemoApiError('无效的资源或 Agent 应用', 400);
  }
  state = cleanupSessionsState(state, resource, agentId, sessionIds);
  return { revision: state.revision };
}

export async function setAlertSample(target: AlertTarget, usage: 80 | 96, revision: number): Promise<MutationResult> {
  await delay();
  assertRevision(revision);
  if (!availableAlertTargets(state).includes(target) || (usage !== 80 && usage !== 96)) throw new DemoApiError('无效的告警演示参数', 400);
  state = setDemoUsageState(state, target, usage);
  return { revision: state.revision };
}

export async function runGpuInspection(_revision: number): Promise<MutationResult> {
  throw new DemoApiError('离线演示不能执行真实 GPU 诊断，请使用桌面应用或开发服务器', 409);
}

export async function runHealthInspection(revision: number): Promise<MutationResult> {
  await delay();
  assertRevision(revision);
  state = refreshState({
    ...structuredClone(state),
    revision: state.revision + 1,
    sampledAt: new Date().toISOString(),
  });
  state.operations.unshift({
    id: `inspect-${state.revision}`,
    kind: 'inspect',
    names: ['六项一期诊断'],
    time: state.sampledAt,
    revision: state.revision,
  });
  state.operations = state.operations.slice(0, 30);
  return { revision: state.revision };
}
