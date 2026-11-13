export type AgentSourceKey = 'processes' | 'sessions' | 'interruptions' | 'interruptionCounts' | 'latency';
export type AgentSourceStatus = 'available' | 'unavailable' | 'invalid' | 'truncated';
export type AgentProcessStatus = 'healthy' | 'unhealthy' | 'hung' | 'unknown' | 'no_port' | 'offline';
export type AgentSeverity = 'critical' | 'high' | 'medium' | 'low';

export interface AgentProcessEvidence {
  pid: number;
  name: string;
  role: string;
  status: AgentProcessStatus;
  ports: number[];
  lastCheckAt: string | null;
  latencyMs: number | null;
  parentPid: number | null;
  hasCrash: boolean;
}

export interface AgentSessionEvidence {
  id: string;
  agent: string | null;
  model: string | null;
  conversations: number;
  inputTokens: number;
  outputTokens: number;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
}

export interface AgentInterruptionEvidence {
  id: string;
  sessionId: string | null;
  callId: string | null;
  pid: number | null;
  agent: string | null;
  type: string;
  severity: AgentSeverity;
  occurredAt: string | null;
  resolved: boolean;
}

export interface AgentLatencyEvidence {
  agent: string | null;
  calls: number;
  streamingCalls: number;
  ttftP95Ms: number | null;
  e2eP95Ms: number | null;
  tpsP50: number | null;
  tpotP95Ms: number | null;
}

export interface AgentDiagnostic {
  source: 'agentsight';
  analyzer: 'sysom-openapi';
  sampledAt: string;
  window: { start: string; end: string };
  status: 'ok' | 'partial' | 'unavailable';
  outcome: 'observed' | 'abnormal' | 'unknown';
  summary: string;
  lastScanAt: string | null;
  filteredProcesses: number | null;
  coverage: { key: AgentSourceKey; status: AgentSourceStatus; reason: string }[];
  totals: { sessions: number | null; inputTokens: number | null; outputTokens: number | null; unresolved: number | null; critical: number | null; high: number | null };
  findings: { severity: 'info' | 'warning' | 'error'; title: string; detail: string; suggestion: string }[];
  processes: AgentProcessEvidence[];
  sessions: AgentSessionEvidence[];
  interruptions: AgentInterruptionEvidence[];
  latency: AgentLatencyEvidence[];
}

export const agentSourceLabels: Record<AgentSourceKey, string> = {
  processes: '进程探活', sessions: '会话与 Token', interruptions: '中断明细', interruptionCounts: '未处理中断汇总', latency: '调用延迟',
};

export const agentProcessLabels: Record<AgentProcessStatus, string> = {
  healthy: 'HTTP 有响应', unhealthy: '端口不可达', hung: '响应超时', unknown: '尚未检查', no_port: '无监听端口', offline: '进程已退出',
};

export const agentInterruptionLabels: Record<string, string> = {
  agent_crash: 'Agent 异常退出', llm_error: '模型调用错误', dead_loop: '循环风险', sse_truncated: '流式响应中断',
  context_overflow: '上下文超限', token_limit: 'Token 达到上限', tool_error: '工具调用错误', user_cancel: '用户取消',
};
