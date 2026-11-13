export interface AgentSessionCount {
  name: string;
  count: number;
}

export interface AgentInterruptionType {
  label: string;
  count: number;
  tone: 'critical' | 'high';
}

export interface AgentInterruptions {
  total: number;
  critical: number;
  high: number;
  byType: AgentInterruptionType[];
}

export interface AgentSummary {
  sessions: number;
  sessionsByAgent: AgentSessionCount[];
  inputTokens: number;
  outputTokens: number;
  interruptions: AgentInterruptions;
  processes: number;
  stuckProcess: {
    role: string;
    latency: string;
  };
}

export const agentSummary: AgentSummary = {
  sessions: 109,
  sessionsByAgent: [
    { name: 'Cosh', count: 96 },
    { name: 'OpenClaw', count: 13 },
  ],
  inputTokens: 250095,
  outputTokens: 8522,
  interruptions: {
    total: 43,
    critical: 13,
    high: 30,
    byType: [
      { label: '死循环', count: 9, tone: 'critical' },
      { label: 'Agent Crash', count: 4, tone: 'critical' },
      { label: 'LLM Error', count: 30, tone: 'high' },
    ],
  },
  processes: 2,
  stuckProcess: { role: 'Worker', latency: '5,325ms' },
};

export function formatNumber(value: number): string {
  return value.toLocaleString('zh-CN');
}
