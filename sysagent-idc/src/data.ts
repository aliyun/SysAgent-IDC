export type DeviceKind = 'server' | 'micro' | 'mini';
export type DeviceStatus = 'healthy' | 'warning' | 'offline';
export type PageId = 'overview' | 'devices' | 'gpu' | 'agents' | 'ops' | 'logs';

export interface Device {
  id: string;
  name: string;
  kind: DeviceKind;
  address: string;
  status: DeviceStatus;
  cpu: number | null;
  memory: number | null;
  gpu: number | null;
  health: number;
  uptime: string;
  hardware: string;
  memorySize: string;
  local?: boolean;
  hasGpu?: boolean;
}

export interface NavItem {
  id: PageId;
  label: string;
  section: string;
  badge?: string;
}

export interface PageInfo {
  title: string;
  subtitle: string;
  eyebrow: string;
}

export interface LogSample {
  time: string;
  level: 'INFO' | 'WARN' | 'ERROR';
  service: string;
  message: string;
}

export const deviceKindLabels: Record<DeviceKind, string> = {
  server: 'GPU 服务器',
  micro: '微主机',
  mini: 'Yoga mini',
};

export const devices: Device[] = [
  {
    id: 'dc-02',
    name: '本地 AI 工作站',
    kind: 'server',
    address: '192.168.1.100',
    status: 'warning',
    cpu: 32,
    memory: 87,
    gpu: 56,
    health: 68,
    uptime: '12 天 8 小时',
    hardware: 'NVIDIA A100 × 2',
    memorySize: '256 GB',
    local: true,
  },
  {
    id: 'dc-01',
    name: 'GPU 训练节点',
    kind: 'server',
    address: '10.24.8.21',
    status: 'healthy',
    cpu: 42,
    memory: 51,
    gpu: 78,
    health: 98,
    uptime: '28 天 16 小时',
    hardware: 'NVIDIA A100 × 2',
    memorySize: '256 GB',
  },
  {
    id: 'mini-dev',
    name: 'Yoga mini · 开发端',
    kind: 'mini',
    address: '192.168.1.108',
    status: 'healthy',
    cpu: 24,
    memory: 46,
    gpu: null,
    health: 97,
    uptime: '6 天 3 小时',
    hardware: 'CPU 推理 · 示例配置',
    memorySize: '32 GB',
  },
  {
    id: 'micro-office',
    name: '微主机 · 办公网',
    kind: 'micro',
    address: '192.168.1.112',
    status: 'healthy',
    cpu: 18,
    memory: 38,
    gpu: null,
    health: 99,
    uptime: '18 天 5 小时',
    hardware: '无独立 GPU',
    memorySize: '16 GB',
  },
  {
    id: 'mini-lab',
    name: 'Yoga mini · 实验室',
    kind: 'mini',
    address: '192.168.1.120',
    status: 'healthy',
    cpu: 12,
    memory: 31,
    gpu: null,
    health: 98,
    uptime: '3 天 11 小时',
    hardware: 'CPU 推理 · 示例配置',
    memorySize: '32 GB',
  },
  {
    id: 'micro-edge',
    name: '微主机 · 边缘节点',
    kind: 'micro',
    address: '10.24.8.32',
    status: 'offline',
    cpu: 0,
    memory: 0,
    gpu: null,
    health: 0,
    uptime: '上次在线 15 分钟前',
    hardware: '无独立 GPU',
    memorySize: '16 GB',
  },
];

export const navItems: NavItem[] = [
  { id: 'overview', label: '体检首页', section: '工作空间', badge: '9' },
  { id: 'devices', label: '设备管理', section: '工作空间', badge: '6' },
  { id: 'gpu', label: 'GPU 诊断', section: '智能运维' },
  { id: 'agents', label: 'Agent 管家', section: '智能运维', badge: '1' },
  { id: 'ops', label: '研发运维', section: '工程与数据' },
  { id: 'logs', label: '日志分析', section: '工程与数据' },
];

export const pageInfo: Record<PageId, PageInfo> = {
  overview: {
    title: '本机体检',
    subtitle: '先看证据，再决定操作，让本地 AI 稳定运行。',
    eyebrow: 'LOCAL HEALTH GUARD',
  },
  devices: {
    title: '设备管理',
    subtitle: '统一管理你的 GPU 服务器、微主机与 Yoga mini。',
    eyebrow: 'DEVICE FLEET',
  },
  gpu: {
    title: 'GPU 诊断',
    subtitle: '看清每一张卡的状态，找到性能与稳定性的答案。',
    eyebrow: 'GPU INTELLIGENCE',
  },
  agents: {
    title: 'Agent 管家',
    subtitle: '不仅知道它还活着，更知道它是否正常工作。',
    eyebrow: 'AGENT OPERATIONS',
  },
  ops: {
    title: '研发运维',
    subtitle: '连接开发与运行，让部署之后的问题回到开发之前。',
    eyebrow: 'CODING + OPS',
  },
  logs: {
    title: '日志分析',
    subtitle: '本地先聚合，模型再分析，把算力用在真正重要的地方。',
    eyebrow: 'LOCAL DATA ENGINE',
  },
};

export const chartValues: number[] = [
  28, 30, 29, 34, 32, 30, 37, 45, 42, 39, 49, 53, 48, 50, 46, 43, 48, 54,
  59, 55, 52, 47, 50, 54, 59, 55, 60, 56, 51, 54, 50, 53, 55, 56, 56,
];

export const logSamples: LogSample[] = [
  {
    time: '14:28:04.182',
    level: 'INFO',
    service: 'inference-gateway',
    message: 'request completed · model=local-qwen · latency=842ms',
  },
  {
    time: '14:28:05.036',
    level: 'INFO',
    service: 'agent-runtime',
    message: 'checkpoint saved · task=log-analysis-012 · batch=184',
  },
  {
    time: '14:28:06.214',
    level: 'WARN',
    service: 'agent-runtime',
    message: 'worker queue approaching limit · active=28 · capacity=32',
  },
  {
    time: '14:28:07.893',
    level: 'INFO',
    service: 'node-collector',
    message: 'metrics collected · cpu=32% · memory=68% · gpu=56%',
  },
  {
    time: '14:28:09.127',
    level: 'ERROR',
    service: 'workspace-web',
    message: 'database query timeout · query_id=sql-078 · duration=3200ms',
  },
  {
    time: '14:28:10.422',
    level: 'INFO',
    service: 'inference-gateway',
    message: 'request completed · model=local-qwen · latency=761ms',
  },
  {
    time: '14:28:12.081',
    level: 'WARN',
    service: 'workspace-web',
    message: 'slow query detected · query_id=sql-078 · rows_examined=48219',
  },
  {
    time: '14:28:14.736',
    level: 'INFO',
    service: 'agent-runtime',
    message: 'local aggregation completed · input=12000 · groups=38',
  },
];
