import { localTime } from '../agent-diagnostics';

export type ResourceId = 'cpu' | 'energy' | 'memory' | 'disk' | 'gpu';
export type SessionStatus = 'active' | 'idle' | 'completed';
export type InspectionStatus = 'normal' | 'abnormal' | 'unchecked';
export type OperationKind = 'cleanup' | 'session-cleanup' | 'optimize' | 'inspect' | 'demo-alert';
export type AlertTarget = 'cpu' | 'energy' | 'memory' | 'gpu' | 'root' | 'fd';

export interface ResourceSession {
  id: string;
  name: string;
  status: SessionStatus;
  usage: number;
  cleanable: boolean;
  defaultSelected: boolean;
}

export interface ResourceRow {
  id: string;
  name: string;
  detail: string;
  usage: number;
  cleanable: boolean;
  defaultSelected: boolean;
  effect: string;
  quantity?: { value: number; unit: 'B' | 'B/s' | 'W' | 'count' };
  pid?: number;
  starttime?: number;
  agentKind?: string;
  agentId?: string;
  sessions?: ResourceSession[];
}

export interface GpuDevice {
  index: number;
  name: string;
  uuid: string;
  busId: string;
  utilization: number | null;
  memoryUtilization: number | null;
  memoryUsedBytes: number | null;
  memoryTotalBytes: number | null;
  temperatureCelsius: number | null;
  powerWatts: number | null;
  powerLimitWatts: number | null;
  eccCorrected: number | null;
  eccUncorrected: number | null;
  pcieGeneration: number | null;
  pcieMaxGeneration: number | null;
  pcieWidth: number | null;
}

export interface GpuFinding {
  check: string;
  severity: 'OK' | 'WARN' | 'ERROR';
  message: string;
  suggestion?: string;
}

export interface GpuJobProcess {
  pid: number;
  starttime: number | null;
  name: string;
  state: string;
  cpuPercent: number | null;
  rssBytes: number | null;
  gpuIndices: number[];
  smUtilization: number | null;
  memoryUtilization: number | null;
  status: GpuDiagnostic['status'];
  findings: GpuFinding[];
}

export interface GpuJobAnalysis {
  status: GpuDiagnostic['status'];
  source: 'sysak ai';
  sampledAt: string | null;
  sampleWindowSeconds: number | null;
  complete: boolean;
  reason: string;
  processes: GpuJobProcess[];
}

export interface GpuDiagnostic {
  status: 'not_run' | 'ok' | 'partial' | 'unavailable' | 'error' | 'timeout' | 'truncated' | 'permission_denied';
  outcome: 'normal' | 'abnormal' | 'unknown' | 'no_gpu';
  sampledAt: string | null;
  source: 'sysak ai';
  complete: boolean;
  gpuCount: number | null;
  architectures: string[];
  devices: string[];
  summary: string;
  findings: GpuFinding[];
  jobAnalysis?: GpuJobAnalysis;
}

export interface ResourceSnapshot {
  id: ResourceId;
  label: string;
  usage: number | null;
  // Demo capacities are in GB; collected quantities carry explicit byte units.
  capacity: number | null;
  unit: string;
  source?: 'sysak' | 'demo';
  status?: 'available' | 'partial' | 'unavailable';
  note?: string;
  quantity?: { value: number; unit: 'B' | 'W'; total?: number; available?: number };
  rankLabel?: string;
  rankUnit?: '%' | 'B' | 'B/s' | 'W' | 'count';
  sampledAt?: string;
  gpuDevices?: GpuDevice[];
  rows: ResourceRow[];
}

export interface Inspection {
  id: string;
  label: string;
  important: boolean;
  phase: 1 | 2;
  status: InspectionStatus;
  usage: number | null;
  detail: string;
  evidence: string[];
  execution?: 'complete' | 'partial' | 'unavailable';
}

export function inspectionResultLabel(item: Inspection) {
  if (item.status === 'abnormal') return '异常';
  if (item.status === 'normal') return '正常';
  return item.execution === 'partial' ? '已检查 · 结论受限' : item.execution === 'unavailable' ? '已尝试 · 不可用' : '未检查';
}

const agentProcessNames: Record<string, string> = {
  qoder: 'Qoder', 'qoder-cli': 'Qoder CLI', qodercli: 'Qoder CLI',
  qoderwake: 'QoderWake', 'qodercli-wake': 'QoderWake CLI',
  workbuddy: 'WorkBuddy', codebuddy: 'CodeBuddy',
  claude: 'Claude Code', 'claude-desktop': 'Claude Desktop',
  codex: 'Codex', 'codex-agent': 'Codex',
  // Linux comm keeps only 15 bytes of the native release binary basename.
  'codex-x86_64-un': 'Codex', 'codex-aarch64-u': 'Codex',
  cursor: 'Cursor', 'cursor-agent': 'Cursor Agent',
  aider: 'Aider', gemini: 'Gemini CLI', opencode: 'OpenCode', goose: 'Goose',
  copilot: 'GitHub Copilot CLI', kimi: 'Kimi Code CLI', qwen: 'Qwen Code',
  auggie: 'Augment', cline: 'Cline', kilo: 'Kilo',
  antigravity: 'Antigravity', agy: 'Antigravity CLI',
  openclaw: 'OpenClaw', 'kiro-cli': 'Kiro CLI', amp: 'Amp', droid: 'Factory Droid',
  junie: 'JetBrains Junie', openhands: 'OpenHands',
  devin: 'Devin CLI', 'devin-desktop': 'Devin Desktop', windsurf: 'Windsurf',
  crush: 'Crush', warp: 'Warp Agent CLI', vibe: 'Mistral Vibe',
};

export function recognizeAgent(name: string): string | undefined {
  const key = name.toLowerCase();
  return Object.hasOwn(agentProcessNames, key) ? agentProcessNames[key] : undefined;
}

export function collectedRankingRows(resource: ResourceSnapshot, agentOnly: boolean) {
  return resource.rows.filter(row => !agentOnly || !!row.agentKind).slice().sort((a, b) => b.usage - a.usage || (a.pid ?? 0) - (b.pid ?? 0)).slice(0, 10);
}

export interface Optimization {
  id: string;
  inspection: string;
  title: string;
  action: string;
  effect: string;
}

export interface HealthOperation {
  id: string;
  kind: OperationKind;
  names: string[];
  time: string;
  revision: number;
}

export interface HealthState {
  mode?: 'collected' | 'demo';
  hasGpu: boolean;
  revision: number;
  sampledAt: string;
  resources: Record<ResourceId, ResourceSnapshot>;
  inspections: Inspection[];
  gpuDiagnostic?: GpuDiagnostic;
  optimizations: Optimization[];
  operations: HealthOperation[];
}

export interface ScoreBand {
  id: 'red' | 'orange' | 'yellow' | 'green';
  color: string;
  label: string;
}

export interface ScoreParts {
  score: number;
  n: number;
  m: number;
  x: number;
  y: number;
  otherAbnormal: number;
  resourceAbnormal: number;
  unchecked: number;
}

export interface HealthSummary extends ScoreParts {
  open: (Inspection | ResourceSnapshot)[];
  band: ScoreBand;
  checked: number;
  total: number;
  unavailable: number;
}

export const resourceIds: ResourceId[] = ['cpu', 'energy', 'memory', 'disk', 'gpu'];

export const resourceLabels: Record<ResourceId, string> = {
  cpu: 'CPU 利用率',
  energy: '能耗',
  memory: '系统内存',
  disk: '系统磁盘',
  gpu: 'GPU 利用率',
};

const rowNames: Record<ResourceId, string[]> = {
  cpu: ['本地模型推理', '训练任务', '过期 Python Worker', '数据库服务', 'Agent 运行时', '闲置索引 Worker', '桌面与系统服务', '完成的分析任务', '残留调试任务', '监控采集进程'],
  energy: ['本地模型推理', '训练任务', '过期推理 Worker', '数据库服务', 'Agent 运行时', '闲置索引 Worker', '桌面与系统服务', '完成的分析任务', '残留调试任务', '监控采集进程'],
  memory: ['本地模型权重', '数据库缓存', '闲置模型缓存', '运行中推理任务', '系统服务', '过期任务中间结果', '内核与文件缓存', '完成的聚合结果', '残留调试缓存', '设备监控服务'],
  disk: ['模型权重目录', '用户数据与项目', '过期运行日志', '正在使用的容器镜像', '当前任务检查点', '可再生工具缓存', '系统与依赖包', '过期临时目录', '已导出分析副本', '当前服务数据'],
  gpu: ['运行中推理任务', '训练任务', '闲置模型显存缓存', '业务推理 Worker', '嵌入模型服务', '过期张量缓存', '图形与系统服务', '完成的测试任务', '残留测试上下文', '设备监控上下文'],
};

const initialUsage: Record<ResourceId, number[]> = {
  cpu: [28, 18, 13, 10, 8, 6, 4, 3, 2, 1],
  energy: [24, 17, 11, 8, 6, 5, 4, 3, 3, 3],
  memory: [30, 20, 12, 9, 7, 6, 4, 3, 2, 1],
  disk: [35, 20, 14, 8, 6, 4, 3, 2, 2, 2],
  gpu: [38, 24, 12, 6, 4, 3, 2, 1, 1, 1],
};

const diskDetails = ['/models', '/workspace', '/var/log/archive', '/containers/active', '/checkpoints', '/cache/tools', '/usr', '/tmp/expired', '/exports/copies', '/services/data'];

function agentRow(agentId: string, baseUsage: number, onDisk: boolean): Partial<ResourceRow> {
  const isLogs = agentId === 'agent-logs';
  const names = isLogs
    ? ['运行中的日志分析', '空闲检索会话', '已完成的批次分析', '空闲历史会话']
    : ['运行中的编码任务', '空闲代码审查', '已完成的测试会话'];
  const diskSuffix = isLogs ? ['工作目录', '上下文缓存', '中间结果', '历史记录'] : ['工作区', '构建缓存', '测试产物'];
  const weights = isLogs ? [0.4, 0.3, 0.2, 0.1] : [0.5, 0.3, 0.2];
  const sessions: ResourceSession[] = names.map((name, index) => ({
    id: `${agentId}-${onDisk ? 'disk' : 'session'}-${index + 1}`,
    name: onDisk ? `${name} · ${diskSuffix[index]}` : name,
    status: index === 0 ? 'active' : index === 2 ? 'completed' : 'idle',
    usage: Number((baseUsage * weights[index]).toFixed(4)),
    cleanable: index > 0,
    defaultSelected: index === 1 || index === 2,
  }));
  return {
    agentId,
    name: isLogs ? '日志分析 Agent' : 'Coding Agent',
    sessions,
    cleanable: false,
    defaultSelected: false,
    ...(onDisk
      ? {
          detail: `/var/lib/agents/${isLogs ? 'logs' : 'coding'}`,
          effect: '仅删除选中 Session 的 Demo 数据文件，不结束 Agent 进程。',
        }
      : {}),
  };
}

function scaleRow(row: ResourceRow, factor: number) {
  if (row.sessions) {
    row.sessions.forEach((session) => {
      session.usage = Number((session.usage * factor).toFixed(4));
    });
    row.usage = row.sessions.reduce((sum, session) => sum + session.usage, 0);
  } else {
    row.usage = Number((row.usage * factor).toFixed(4));
  }
}

const phaseTwo = (id: string, label: string): Inspection => ({
  id,
  label,
  important: false,
  phase: 2,
  status: 'unchecked',
  usage: null,
  detail: '二期规划 · 本次未检查',
  evidence: [],
});

export function stateResourceIds(state: HealthState): ResourceId[] {
  return state.hasGpu ? resourceIds : resourceIds.filter((id) => id !== 'gpu');
}

export function createInitialState(hasGpu = true): HealthState {
  const resources = Object.fromEntries(
    resourceIds.map((id) => [
      id,
      {
        id,
        label: resourceLabels[id],
        usage: 0,
        capacity: id === 'memory' ? 256 : id === 'disk' ? 1000 : null,
        unit: id === 'cpu' ? '整机占比' : id === 'gpu' ? '总 GPU 占比' : id === 'energy' ? '能耗预算占比 · 估算' : '总容量占比',
        rows: rowNames[id].map((name, index) => ({
          id: `${id}-${index}`,
          name,
          usage: initialUsage[id][index],
          detail: id === 'disk' ? diskDetails[index] : `演示对象 ${String(index + 1).padStart(2, '0')}`,
          cleanable: [2, 5, 7, 8].includes(index),
          defaultSelected: [2, 5, 8].includes(index),
          effect:
            id === 'disk'
              ? '仅删除 Demo 中选定的对象；真实文件删除需核验清单和备份。'
              : '仅释放 Demo 对象的资源；真实任务回收可能中断工作，需授权。',
          ...(index === 4 || index === 7
            ? agentRow(index === 4 ? 'agent-logs' : 'agent-coding', initialUsage[id][index], id === 'disk')
            : {}),
        })),
      } satisfies ResourceSnapshot,
    ]),
  ) as Record<ResourceId, ResourceSnapshot>;

  const state: HealthState = {
    mode: 'demo',
    hasGpu,
    revision: 1,
    sampledAt: new Date().toISOString(),
    resources,
    inspections: [
      {
        id: 'agents',
        label: 'Agent 诊断',
        important: false,
        phase: 1,
        status: 'abnormal',
        usage: null,
        detail: '日志分析 Agent 队列接近上限',
        evidence: ['演示工作队列 28 / 32', '请求延迟 3,200 ms；进程仍存活'],
      },
      ...(hasGpu
        ? [
            {
              id: 'gpu',
              label: 'GPU 诊断',
              important: false,
              phase: 1,
              status: 'normal',
              usage: null,
              detail: '基础硬件检查未见异常',
              evidence: ['演示 Xid / ECC 错误 0', 'GPU 基础诊断与整体利用率分别计数'],
            } satisfies Inspection,
          ]
        : []),
      { id: 'root', label: '根目录诊断', important: true, phase: 1, status: 'abnormal', usage: 96, detail: '', evidence: [] },
      { id: 'memory', label: '内存诊断', important: true, phase: 1, status: 'abnormal', usage: 94, detail: '', evidence: [] },
      { id: 'fd', label: 'FD 诊断', important: true, phase: 1, status: 'abnormal', usage: 95, detail: '', evidence: [] },
      {
        id: 'logs',
        label: '日志诊断',
        important: false,
        phase: 1,
        status: 'abnormal',
        usage: null,
        detail: 'Debug 日志采样过密',
        evidence: ['演示 Debug 采样 100%', '降低采样不等于清除历史日志'],
      },
      phaseTwo('load', '负载诊断'),
      phaseTwo('network', '网络诊断'),
      phaseTwo('security', '安全扫描'),
      phaseTwo('system', '系统与配置'),
    ],
    optimizations: [],
    operations: [],
  };
  return refreshState(state);
}

export function resourceUsages(state: HealthState): Record<ResourceId, number | null> {
  return Object.fromEntries(resourceIds.map((id) => [id, state.resources[id].status === 'unavailable' ? null : state.resources[id].usage])) as Record<ResourceId, number | null>;
}

export function formatBytes(value: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
  let amount = value;
  let index = 0;
  while (Math.abs(amount) >= 1024 && index < units.length - 1) {
    amount /= 1024;
    index++;
  }
  return `${Number(amount.toFixed(index ? 1 : 0))} ${units[index]}`;
}

export function formatResourceValue(resource: ResourceSnapshot): string {
  if (resource.status === 'unavailable') return '不可用';
  if (resource.usage !== null) return `${Number(resource.usage.toFixed(1))}%`;
  if (resource.quantity?.unit === 'W') return `${Number(resource.quantity.value.toFixed(1))} W`;
  return '不可用';
}

export function formatResourceQuantity(resource: ResourceSnapshot): string {
  const quantity = resource.quantity;
  if (resource.status === 'unavailable') return '本次未取得测量值';
  if (quantity?.unit === 'B') {
    return `${formatBytes(quantity.value)}${quantity.total !== undefined ? ` / ${formatBytes(quantity.total)}` : ''}${quantity.available !== undefined ? ` · 可用 ${formatBytes(quantity.available)}` : ''}`;
  }
  if (quantity?.unit === 'W') return '实测功率 · 非能耗预算占比';
  if (resource.capacity !== null && resource.usage !== null) {
    return `${(resource.capacity * resource.usage / 100).toFixed(1)} / ${resource.capacity} GB`;
  }
  return resource.unit;
}

export function formatRankingValue(resource: ResourceSnapshot, row: ResourceRow): string {
  const unit = resource.rankUnit ?? '%';
  const value = row.quantity?.unit === unit ? row.quantity.value : row.usage;
  if (unit === 'B' || unit === 'B/s') return `${formatBytes(value)}${unit === 'B/s' ? '/s' : ''}`;
  return `${Number(value.toFixed(1))}${unit === '%' ? '%' : ` ${unit}`}`;
}

export function inspectionScope(state: HealthState, item: Inspection): string {
  if (item.status === 'unchecked' && !item.execution) return '未检查';
  if (item.execution === 'partial') return '本地采集 · 部分覆盖';
  if (item.execution === 'unavailable') return '本地检查已尝试 · 不可用';
  return state.mode !== 'collected' || /demo|演示/i.test([item.detail, ...item.evidence].join(' ')) ? 'Demo' : '本地采集';
}

export function scoreBand(score: number): ScoreBand {
  if (score < 60) return { id: 'red', color: '#ef4444', label: '需要优先处理' };
  if (score < 80) return { id: 'orange', color: '#f29122', label: '需要改善' };
  if (score < 90) return { id: 'yellow', color: '#d4b225', label: '仍需关注' };
  return { id: 'green', color: '#0fb57f', label: '已检查项表现良好' };
}

export function calculateScore(inspections: Inspection[], resourceValues: (number | null)[]): ScoreParts {
  const important = inspections.filter((item) => item.important);
  const others = inspections.filter((item) => !item.important);
  const n = important.length;
  const measured = resourceValues.filter((value): value is number => value !== null && Number.isFinite(value));
  const m = others.length + measured.length;
  const x = important.filter((item) => item.status !== 'unchecked' && item.usage !== null && item.usage > 90).length;
  const otherAbnormal = others.filter((item) => item.status === 'abnormal').length;
  const resourceAbnormal = measured.filter((value) => value > 90).length;
  const y = otherAbnormal + resourceAbnormal;
  const raw = 20 + (80 - x * (n ? 80 / n : 0)) - y * (m ? 20 / m : 0);
  return {
    score: Math.max(0, Math.min(100, raw)),
    n,
    m,
    x,
    y,
    otherAbnormal,
    resourceAbnormal,
    unchecked: inspections.filter((item) => item.status === 'unchecked').length,
  };
}

export function summarizeHealth(state: HealthState): HealthSummary {
  const ids = stateResourceIds(state);
  const usages = resourceUsages(state);
  const parts = calculateScore(
    state.inspections,
    ids.map((id) => usages[id]),
  );
  const open = [
    ...state.inspections.filter((item) => item.status === 'abnormal'),
    ...ids.filter((id) => {
      const usage = usages[id];
      return usage !== null && usage > 90;
    }).map((id) => state.resources[id]),
  ];
  return {
    ...parts,
    open,
    band: state.mode === 'collected' && !state.inspections.some((item) => item.status !== 'unchecked') && ids.every((id) => usages[id] === null)
      ? { id: 'green', color: '#91a4bc', label: '暂无可用评分证据' }
      : state.mode === 'collected' && (parts.unchecked > 0 || ids.some((id) => usages[id] === null)) && parts.score >= 90
        ? { ...scoreBand(parts.score), label: '仅已知项评分，未知不代表正常' }
        : scoreBand(parts.score),
    checked: state.inspections.filter((item) => item.status !== 'unchecked').length,
    total: state.inspections.length,
    unavailable: ids.filter((id) => (state.resources[id].usage === null && !state.resources[id].quantity) || state.resources[id].status === 'unavailable').length,
  };
}

const optimizationCatalog: Optimization[] = [
  { id: 'opt-agent', inspection: 'agents', title: 'Agent 队列优化', action: '模拟降低并发与受控恢复', effect: '更新演示队列；真实重启可能中断任务，不承诺断点续跑。' },
  { id: 'opt-root', inspection: 'root', title: '根目录空间优化', action: '模拟回收过期日志与缓存', effect: '仅处理默认可回收 Demo 对象，不删除真实文件。' },
  { id: 'opt-memory', inspection: 'memory', title: '系统内存优化', action: '模拟回收闲置缓存与中间结果', effect: '不访问模型进程，真实回收需核验任务状态。' },
  { id: 'opt-fd', inspection: 'fd', title: 'FD 占用优化', action: '模拟释放失效文件描述符', effect: '只更新演示占用；不关闭真实连接或文件。' },
  { id: 'opt-logs', inspection: 'logs', title: '日志采样优化', action: '模拟降低 Debug 采样', effect: '保留 Warning / Error 的演示采样，不删除历史日志。' },
];

export function refreshState(state: HealthState): HealthState {
  if (state.mode === 'collected') {
    // Bounded rankings cannot replace independent system totals or diagnostics.
    resourceIds.forEach((id) => {
      const resource = state.resources[id];
      resource.rows.forEach((row) => {
        row.cleanable = false;
        row.defaultSelected = false;
        delete row.agentId;
        delete row.sessions;
      });
      resource.rows.sort((a, b) => b.usage - a.usage);
    });
    state.optimizations = [];
    return state;
  }
  resourceIds.forEach((id) => {
    const resource = state.resources[id];
    resource.rows.forEach((row) => {
      if (row.sessions) row.usage = row.sessions.reduce((sum, session) => sum + session.usage, 0);
    });
    resource.rows.sort((a, b) => b.usage - a.usage);
    resource.usage = Math.round(resource.rows.reduce((sum, row) => sum + row.usage, 0) * 10) / 10;
  });
  state.inspections.forEach((item) => {
    if (item.id === 'root' || item.id === 'memory') {
      item.usage = state.resources[item.id === 'root' ? 'disk' : 'memory'].usage;
    }
    if (item.important) {
      const usage = item.usage ?? 0;
      item.status = usage > 90 ? 'abnormal' : 'normal';
      const subject = item.id === 'fd' ? '文件描述符' : item.id === 'root' ? '根目录' : '系统内存';
      item.detail = `${subject}使用率 ${item.usage}%${item.status === 'abnormal' ? '，超过 90%' : '，未超过 90%'}`;
      item.evidence = [`演示快照 v${state.revision}：使用率 ${item.usage}%`, '判断阈值：严格大于 90% 计为异常'];
    }
  });
  state.optimizations = optimizationCatalog
    .filter((opt) => state.inspections.some((item) => item.id === opt.inspection && item.status === 'abnormal'))
    .map((opt) => ({ ...opt }));
  return state;
}

function requireDemo(state: HealthState): void {
  if (state.mode === 'collected') throw new Error('本地采集快照为只读，不支持清理、优化或告警样本修改');
}

function fdInspection(state: HealthState): Inspection {
  return state.inspections.find((item) => item.id === 'fd')!;
}

export function cleanupState(state: HealthState, resource: ResourceId, ids: string[]): HealthState {
  requireDemo(state);
  const next = structuredClone(state);
  next.resources[resource].rows = next.resources[resource].rows.filter((row) => !ids.includes(row.id));
  resourceIds
    .filter((id) => id !== resource)
    .forEach((id) => {
      next.resources[id].rows.forEach((row) => scaleRow(row, 1 - ids.length * 0.012));
    });
  const fd = fdInspection(next);
  fd.usage = Math.max(35, (fd.usage ?? 0) - ids.length * 4);
  next.revision += 1;
  next.sampledAt = new Date().toISOString();
  next.operations.unshift({
    id: `cleanup-${next.revision}`,
    kind: 'cleanup',
    names: state.resources[resource].rows.filter((row) => ids.includes(row.id)).map((row) => row.name),
    time: next.sampledAt,
    revision: next.revision,
  });
  next.operations = next.operations.slice(0, 30);
  return refreshState(next);
}

export function optimizeState(state: HealthState, ids: string[]): HealthState {
  requireDemo(state);
  let next = structuredClone(state);
  if (ids.includes('opt-root')) {
    next = cleanupState(next, 'disk', next.resources.disk.rows.filter((row) => row.defaultSelected && row.cleanable).map((row) => row.id));
  }
  if (ids.includes('opt-memory')) {
    next = cleanupState(next, 'memory', next.resources.memory.rows.filter((row) => row.defaultSelected && row.cleanable).map((row) => row.id));
  }
  const markNormal = (id: string, detail: string) => {
    const item = next.inspections.find((inspection) => inspection.id === id)!;
    item.status = 'normal';
    item.detail = detail;
    item.evidence = [detail, 'Demo 优化接口完成，最新快照已重新计算'];
  };
  if (ids.includes('opt-agent')) markNormal('agents', '模拟队列 6 / 32，请求探测通过');
  if (ids.includes('opt-logs')) markNormal('logs', '模拟 Debug 采样 20%，错误完整保留');
  if (ids.includes('opt-fd')) fdInspection(next).usage = 56;
  if (ids.includes('opt-agent') || ids.includes('opt-fd')) {
    resourceIds.forEach((id) => next.resources[id].rows.forEach((row) => scaleRow(row, 0.98)));
  }
  next.revision += 1;
  next.sampledAt = new Date().toISOString();
  next.operations = [
    {
      id: `optimize-${next.revision}`,
      kind: 'optimize' as const,
      names: state.optimizations.filter((opt) => ids.includes(opt.id)).map((opt) => opt.title),
      time: next.sampledAt,
      revision: next.revision,
    },
    ...state.operations,
  ].slice(0, 30);
  return refreshState(next);
}

export function cleanupSessionsState(state: HealthState, resource: ResourceId, agentId: string, sessionIds: string[]): HealthState {
  requireDemo(state);
  const scope = resourceIds.filter((id) => (resource === 'disk' ? id === 'disk' : id !== 'disk'));
  const agentRows = scope.map((id) => state.resources[id].rows.find((row) => row.agentId === agentId));
  const valid =
    sessionIds.length > 0 &&
    new Set(sessionIds).size === sessionIds.length &&
    agentRows.every(
      (row) =>
        row?.sessions &&
        sessionIds.every((sessionId) =>
          row.sessions!.some((session) => session.id === sessionId && session.cleanable && session.status !== 'active'),
        ),
    );
  if (!valid) throw new Error('Agent 或 Session 不存在，或会话处于受保护状态');
  const first = agentRows[0]!;
  const names = first.sessions!.filter((session) => sessionIds.includes(session.id)).map((session) => `${first.name} · ${session.name} (${session.id})`);
  const next = structuredClone(state);
  scope.forEach((id) => {
    const row = next.resources[id].rows.find((item) => item.agentId === agentId)!;
    row.sessions = row.sessions!.filter((session) => !sessionIds.includes(session.id));
  });
  if (resource !== 'disk') {
    const fd = fdInspection(next);
    fd.usage = Math.max(35, (fd.usage ?? 0) - sessionIds.length * 4);
  }
  next.revision += 1;
  next.sampledAt = new Date().toISOString();
  next.operations = [
    { id: `sessions-${next.revision}`, kind: 'session-cleanup' as const, names, time: next.sampledAt, revision: next.revision },
    ...state.operations,
  ].slice(0, 30);
  return refreshState(next);
}

export const alertTargets: AlertTarget[] = ['cpu', 'energy', 'memory', 'gpu', 'root', 'fd'];

export function availableAlertTargets(state: HealthState): AlertTarget[] {
  const targets = state.hasGpu ? alertTargets : alertTargets.filter((target) => target !== 'gpu');
  if (state.mode !== 'collected') return targets;
  return targets.filter((target) => {
    if (target === 'fd') {
      const inspection = state.inspections.find((item) => item.id === 'fd');
      return inspection?.status !== 'unchecked' && inspection?.usage != null;
    }
    const resource = state.resources[target === 'root' ? 'disk' : target];
    return resource.status !== 'unavailable' && resource.usage !== null;
  });
}

export function setDemoUsageState(state: HealthState, target: AlertTarget, usage: number): HealthState {
  requireDemo(state);
  if (!availableAlertTargets(state).includes(target) || !Number.isFinite(usage) || usage < 0 || usage > 100) {
    throw new Error('无效的告警演示参数');
  }
  const next = structuredClone(state);
  if (target === 'fd') {
    fdInspection(next).usage = usage;
  } else {
    const resource = next.resources[target === 'root' ? 'disk' : target];
    const total = resource.rows.reduce((sum, row) => sum + row.usage, 0);
    resource.rows.forEach((row) => scaleRow(row, total ? usage / total : 0));
    if (!total && usage > 0) resource.rows.find((row) => !row.sessions)!.usage = usage;
  }
  next.revision += 1;
  next.sampledAt = new Date().toISOString();
  next.operations = [
    {
      id: `alert-${next.revision}`,
      kind: 'demo-alert' as const,
      names: [`${target} 设置为 ${usage}% · 演示样本，非实际监控`],
      time: next.sampledAt,
      revision: next.revision,
    },
    ...state.operations,
  ].slice(0, 30);
  return refreshState(next);
}

export function buildHealthReport(state: HealthState, device: { name: string }): string {
  const summary = summarizeHealth(state);
  const collected = state.mode === 'collected';
  const resourcesText = stateResourceIds(state)
    .map((id) => {
      const resource = state.resources[id];
      if (!collected) return `${resource.label}：${formatResourceValue(resource)}${id === 'energy' ? ' · 预算占比估算，非实测能耗' : ''}`;
      const ranks = resource.rows.slice(0, 10).map((row) => `  ${row.pid !== undefined ? `PID ${row.pid} · ` : ''}${row.name}：${formatRankingValue(resource, row)}`).join('\n');
      return `${resource.label}：${formatResourceValue(resource)} · ${formatResourceQuantity(resource)}
来源：${resource.source ?? 'sysak'} · 状态：${resource.status ?? (resource.usage === null && !resource.quantity ? 'unavailable' : 'available')} · 采样：${localTime(resource.sampledAt ?? state.sampledAt)}
范围：${resource.note ?? '仅当前采集范围；排行不代表全部系统占用'}
${resource.rankLabel ?? '资源排行'}（${resource.rankUnit ?? '%'}）
${ranks || '  本次没有可用排行数据'}`;
    })
    .join('\n');
  const inspectionsText = state.inspections
    .map((item) => `${item.label} · ${inspectionScope(state, item)} · ${item.important ? '重要' : item.phase === 2 ? '二期' : '一期'} · ${inspectionResultLabel(item)} · ${item.detail}`)
    .join('\n');
  const operationsText =
    state.operations.map((op) => `${localTime(op.time)} · ${op.kind} · ${op.names.join('、')} · v${op.revision}`).join('\n') || '暂无';
  return `SysAgent管家 · ${collected ? '本机资源采集报告' : '体检演示报告'}
${collected ? '系统资源来自本机 IDC / sysAK 经本地 OpenAPI 解析；其他诊断按 Demo 或未检查标注。只读展示，不执行清理或修复，未实现 Agent Session 资源。' : '所有数据与清理优化均为模拟，不操作真实硬件、进程或文件。'}
设备：${device.name}
快照 v${state.revision} · ${localTime(state.sampledAt)}
分数：${summary.score.toFixed(1)}
公式：20+(80-x*(80/n))-y*(20/m)
n=${summary.n}, x=${summary.x}, m=${summary.m}, y=${summary.y}
y=其他诊断异常${summary.otherAbnormal}+资源超过90%${summary.resourceAbnormal}
尚无确定结论${summary.unchecked}项（未检查或覆盖受限）；未知资源百分比不纳入m，没有检查或测量结果不算正常。${collected ? `资源不可用${summary.unavailable}项；功率 W 不参与百分比阈值评分。` : ''}

${resourcesText}

${inspectionsText}

操作记录
${operationsText}`;
}
