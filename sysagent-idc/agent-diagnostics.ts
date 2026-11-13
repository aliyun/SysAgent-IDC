import {
  type AgentDiagnostic, type AgentSourceKey, type AgentSourceStatus,
  type AgentProcessEvidence, type AgentSessionEvidence, type AgentInterruptionEvidence,
  type AgentLatencyEvidence, agentSourceLabels, agentInterruptionLabels,
} from './src/agent-diagnostics-data';

// Pure, bounded evidence interpretation. No collector, network, LLM or process actions.
export const AGENT_SOURCE_LIMITS = { processes: 256, sessions: 500, interruptions: 200, interruptionCounts: 1, latency: 256 } as const;
const SOURCE_KEYS = Object.keys(AGENT_SOURCE_LIMITS) as AgentSourceKey[];
const STATUSES: AgentSourceStatus[] = ['available', 'unavailable', 'invalid', 'truncated'];
const PROCESS_STATUSES = ['healthy', 'unhealthy', 'hung', 'unknown', 'no_port', 'offline'] as const;
const SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;
const FRESHNESS_MS = 120_000; // Probe freshness only, not a business-health or latency SLO.
type Obj = Record<string, unknown>;
type Counts = { total: number; critical: number; high: number };
type ProcessData = { rows: AgentProcessEvidence[]; scan: number; filtered: number };

export { localTime };
export class AgentSnapshotError extends Error {}
function object(value: unknown): value is Obj {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function shape(value: unknown, required: readonly string[]): value is Obj {
  return object(value) && required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key));
}
function number(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
function integer(value: unknown): value is number {
  return number(value) && Number.isSafeInteger(value);
}
function text(value: unknown, max = 256, empty = false): value is string {
  return typeof value === 'string' && (empty || value.length > 0) && value.length <= max;
}
function nullableText(value: unknown): value is string | null {
  return value === null || text(value);
}
function nullableInteger(value: unknown): value is number | null {
  return value === null || integer(value);
}
function safeText(value: string): string {
  // Never interpret unknown types/reasons as markup, commands or a known finding type.
  return value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ')
    .replace(/&/g, '＆').replace(/</g, '＜').replace(/>/g, '＞');
}
function isoEpoch(value: unknown, divisor = 1): string | null {
  if (!number(value) || !Number.isInteger(value) || value / divisor > 8.64e15) return null;
  return new Date(value / divisor).toISOString();
}
function localTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '—';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function epoch(value: unknown, divisor = 1): value is number {
  return isoEpoch(value, divisor) !== null;
}
function timestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(value);
  if (!match || !Number.isFinite(Date.parse(value))) return false;
  const year = Number(match[1]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return Number(match[3]) <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][Number(match[2]) - 1];
}
function list<T>(value: unknown, parse: (row: unknown) => T | null, id: (row: T) => string | number): T[] | null {
  if (!Array.isArray(value)) return null;
  const rows: T[] = [];
  const ids = new Set<string | number>();
  for (const raw of value) {
    const row = parse(raw);
    if (!row || ids.has(id(row))) return null;
    ids.add(id(row));
    rows.push(row);
  }
  return rows;
}
function processRow(raw: unknown): AgentProcessEvidence | null {
  if (!shape(raw, ['pid', 'agent_name', 'role', 'status', 'ports', 'last_check_time', 'latency_ms', 'parent_pid', 'has_crash']) ||
      !integer(raw.pid) || !text(raw.agent_name) || !text(raw.role) || !PROCESS_STATUSES.includes(raw.status as AgentProcessEvidence['status']) ||
      !Array.isArray(raw.ports) || raw.ports.length > 256 || !raw.ports.every(p => integer(p) && p <= 65535) ||
      new Set(raw.ports).size !== raw.ports.length || !epoch(raw.last_check_time) || !nullableInteger(raw.latency_ms) ||
      !nullableInteger(raw.parent_pid) || typeof raw.has_crash !== 'boolean') return null;
  return {
    pid: raw.pid, name: safeText(raw.agent_name), role: safeText(raw.role), status: raw.status as AgentProcessEvidence['status'],
    ports: [...raw.ports] as number[], lastCheckAt: raw.last_check_time === 0 ? null : isoEpoch(raw.last_check_time),
    latencyMs: raw.latency_ms, parentPid: raw.parent_pid, hasCrash: raw.has_crash,
  };
}
function processes(raw: unknown): ProcessData | null {
  if (!shape(raw, ['agents', 'last_scan_time', 'filtered_count']) || !epoch(raw.last_scan_time) || !integer(raw.filtered_count)) return null;
  const rows = list(raw.agents, processRow, row => row.pid);
  return rows ? { rows, scan: raw.last_scan_time, filtered: raw.filtered_count } : null;
}
function sessionRow(raw: unknown): AgentSessionEvidence | null {
  if (!shape(raw, ['session_id', 'conversation_count', 'first_seen_ns', 'last_seen_ns', 'total_input_tokens', 'total_output_tokens', 'agent_name', 'model']) ||
      !text(raw.session_id) || !integer(raw.conversation_count) || !epoch(raw.first_seen_ns, 1e6) || !epoch(raw.last_seen_ns, 1e6) ||
      raw.first_seen_ns > raw.last_seen_ns || !integer(raw.total_input_tokens) || !integer(raw.total_output_tokens) ||
      !nullableText(raw.agent_name) || !nullableText(raw.model)) return null;
  return {
    id: raw.session_id, agent: raw.agent_name === null ? null : safeText(raw.agent_name), model: raw.model === null ? null : safeText(raw.model),
    conversations: raw.conversation_count, inputTokens: raw.total_input_tokens, outputTokens: raw.total_output_tokens,
    firstSeenAt: isoEpoch(raw.first_seen_ns, 1e6), lastSeenAt: isoEpoch(raw.last_seen_ns, 1e6),
  };
}
function interruptionRow(raw: unknown): AgentInterruptionEvidence | null {
  if (!shape(raw, ['interruption_id', 'session_id', 'call_id', 'pid', 'agent_name', 'interruption_type', 'severity', 'occurred_at_ns', 'resolved']) ||
      !text(raw.interruption_id) || !nullableText(raw.session_id) || !nullableText(raw.call_id) || !nullableInteger(raw.pid) ||
      !nullableText(raw.agent_name) || !text(raw.interruption_type) || !SEVERITIES.includes(raw.severity as AgentInterruptionEvidence['severity']) ||
      !epoch(raw.occurred_at_ns, 1e6) || typeof raw.resolved !== 'boolean') return null;
  return {
    id: raw.interruption_id, sessionId: raw.session_id, callId: raw.call_id, pid: raw.pid,
    agent: raw.agent_name === null ? null : safeText(raw.agent_name), type: safeText(raw.interruption_type),
    severity: raw.severity as AgentInterruptionEvidence['severity'], occurredAt: isoEpoch(raw.occurred_at_ns, 1e6), resolved: raw.resolved,
  };
}
function counts(raw: unknown): Counts | null {
  if (!shape(raw, ['total', 'by_severity']) || !integer(raw.total) || !shape(raw.by_severity, SEVERITIES) ||
      !SEVERITIES.every(key => integer((raw.by_severity as Obj)[key]))) return null;
  const sum = SEVERITIES.reduce((total, key) => total + ((raw.by_severity as Obj)[key] as number), 0);
  if (!Number.isSafeInteger(sum) || sum !== raw.total) return null;
  return { total: raw.total, critical: raw.by_severity.critical as number, high: raw.by_severity.high as number };
}
function quantiles(raw: unknown): raw is { p50: number; p95: number; p99: number } | null {
  return raw === null || (shape(raw, ['p50', 'p95', 'p99']) && number(raw.p50) && number(raw.p95) && number(raw.p99) && raw.p50 <= raw.p95 && raw.p95 <= raw.p99);
}
function latencyRow(raw: unknown): AgentLatencyEvidence | null {
  if (!shape(raw, ['agent_name', 'call_count', 'streaming_call_count', 'ttft_ms', 'tps_tokens_per_second', 'tpot_ms_per_token', 'e2e_latency_ms']) ||
      !nullableText(raw.agent_name) || !integer(raw.call_count) || !integer(raw.streaming_call_count) || raw.streaming_call_count > raw.call_count ||
      !quantiles(raw.ttft_ms) || !quantiles(raw.tps_tokens_per_second) || !quantiles(raw.tpot_ms_per_token) || !quantiles(raw.e2e_latency_ms)) return null;
  return {
    agent: raw.agent_name === null ? null : safeText(raw.agent_name), calls: raw.call_count, streamingCalls: raw.streaming_call_count,
    ttftP95Ms: raw.ttft_ms?.p95 ?? null, e2eP95Ms: raw.e2e_latency_ms?.p95 ?? null,
    tpsP50: raw.tps_tokens_per_second?.p50 ?? null, tpotP95Ms: raw.tpot_ms_per_token?.p95 ?? null,
  };
}
const SUGGESTIONS: Record<string, string> = {
  agent_crash: '人工核对退出记录与进程状态，异常退出原因尚未确认。',
  llm_error: '人工核对模型服务错误码、配额与连通性。',
  dead_loop: '人工检查调用重复模式与任务进度，不能仅凭事件确认死循环。',
  sse_truncated: '人工检查流式连接与完整调用记录。',
  context_overflow: '人工核对上下文长度与模型窗口。',
  token_limit: '人工核对 Token 预算与调用上限。',
  tool_error: '人工核对工具返回状态与权限。',
  user_cancel: '人工确认是否为预期取消；取消事件不等于 Agent 故障。',
};

export function parseAgentDiagnostic(raw: unknown): AgentDiagnostic {
  if (!shape(raw, ['schema_version', 'source', 'sampled_at', 'window', 'sources']) || raw.schema_version !== '1.0' || raw.source !== 'agentsight' ||
      !timestamp(raw.sampled_at) || !shape(raw.window, ['start', 'end']) || !timestamp(raw.window.start) || !timestamp(raw.window.end) ||
      Date.parse(raw.window.start) > Date.parse(raw.window.end) || Date.parse(raw.window.end) > Date.parse(raw.sampled_at) ||
      !object(raw.sources) || Object.keys(raw.sources).some(key => !SOURCE_KEYS.includes(key as AgentSourceKey))) {
    throw new AgentSnapshotError('Invalid AgentSight raw_snapshot envelope, timestamps or window');
  }
  const report: AgentDiagnostic = {
    source: 'agentsight', analyzer: 'sysom-openapi', sampledAt: raw.sampled_at,
    window: { start: raw.window.start, end: raw.window.end }, status: 'unavailable', outcome: 'unknown', summary: '',
    lastScanAt: null, filteredProcesses: null, coverage: [],
    totals: { sessions: null, inputTokens: null, outputTokens: null, unresolved: null, critical: null, high: null },
    findings: [], processes: [], sessions: [], interruptions: [], latency: [],
  };
  const windowStart = Date.parse(raw.window.start);
  const windowEnd = Date.parse(raw.window.end);
  const sessionInWindow = (value: unknown): AgentSessionEvidence | null => {
    const row = sessionRow(value);
    return row && row.firstSeenAt !== null && row.lastSeenAt !== null && Date.parse(row.firstSeenAt) >= windowStart && Date.parse(row.lastSeenAt) <= windowEnd ? row : null;
  };
  let processData: ProcessData | null = null;
  let countData: Counts | null = null;
  let usable = 0;
  for (const key of SOURCE_KEYS) {
    const source = raw.sources[key];
    let status: AgentSourceStatus = 'invalid';
    let reason = '来源结构或数据无效，已拒绝解释；缺失数据未替换为零。';
    if (source === undefined) { status = 'unavailable'; reason = '未采集此来源。'; }
    else if (shape(source, ['status', 'reason', 'data']) && STATUSES.includes(source.status as AgentSourceStatus) && text(source.reason, 512, true)) {
      status = source.status as AgentSourceStatus;
      reason = safeText(source.reason);
      if (status === 'unavailable' || status === 'invalid') {
        if (source.data !== null) { status = 'invalid'; reason = '不可用或无效来源携带了数据，已拒绝解释。'; }
      } else {
        const data = key === 'processes' ? processes(source.data) : key === 'sessions' ? list(source.data, sessionInWindow, row => row.id) :
          key === 'interruptions' ? list(source.data, interruptionRow, row => row.id) : key === 'interruptionCounts' ? counts(source.data) : list(source.data, latencyRow, row => row.agent ?? '\u0000');
        if (data === null) { status = 'invalid'; reason = '来源数据字段、数值或列表无效，已拒绝解释整个来源。'; }
        else {
          usable++;
          const limit = AGENT_SOURCE_LIMITS[key];
          const rows = key === 'processes' ? (data as ProcessData).rows : Array.isArray(data) ? data : null;
          if (rows && rows.length > limit) status = 'truncated';
          if (status === 'truncated') reason = `${reason ? `${reason}；` : ''}来源受采集限制（最多 ${limit} 项），不代表完整覆盖。`;
          if (key === 'processes') {
            processData = data as ProcessData;
            report.processes = processData.rows.slice(0, limit);
            report.lastScanAt = processData.scan === 0 ? null : isoEpoch(processData.scan);
            report.filteredProcesses = processData.filtered;
          } else if (key === 'sessions') {
            report.sessions = (data as AgentSessionEvidence[]).slice(0, limit);
            if (status === 'available') {
              const input = report.sessions.reduce((sum, row) => sum + row.inputTokens, 0);
              const output = report.sessions.reduce((sum, row) => sum + row.outputTokens, 0);
              if (Number.isSafeInteger(input) && Number.isSafeInteger(output)) {
                report.totals.sessions = report.sessions.length;
                report.totals.inputTokens = input;
                report.totals.outputTokens = output;
              } else {
                usable--; status = 'invalid'; reason = '会话 Token 汇总超过安全整数边界，已拒绝解释整个来源。'; report.sessions = [];
              }
            }
          } else if (key === 'interruptions') report.interruptions = (data as AgentInterruptionEvidence[]).slice(0, limit);
          else if (key === 'interruptionCounts') {
            countData = data as Counts;
            if (status === 'available') {
              report.totals.unresolved = countData.total;
              report.totals.critical = countData.critical;
              report.totals.high = countData.high;
            }
          } else report.latency = (data as AgentLatencyEvidence[]).slice(0, limit);
        }
      }
    }
    report.coverage.push({ key, status, reason });
    if (status !== 'available') report.findings.push({
      severity: 'info', title: `${agentSourceLabels[key]}覆盖不足`, detail: reason || '此来源不可用或未完整采集。',
      suggestion: '补充只读采集后再判断；缺少覆盖不能解释为 Agent 健康。',
    });
  }
  report.status = report.coverage.every(source => source.status === 'available') ? 'ok' : usable ? 'partial' : 'unavailable';
  const sampledMs = Date.parse(report.sampledAt);
  const freshScan = processData !== null && processData.scan > 0 && sampledMs >= processData.scan && sampledMs - processData.scan <= FRESHNESS_MS;
  if (processData && !freshScan) report.findings.push({
    severity: 'info', title: '探活新鲜度未知', detail: '扫描为 0、晚于采样时间或超过 2 分钟；进程探活结论为 unknown。2 分钟仅为探活新鲜度阈值，不是业务健康标准。',
    suggestion: '重新只读采集进程探活；不要据陈旧状态推断健康、崩溃或故障根因。',
  });
  let abnormal = false;
  for (const process of report.processes) {
    const checkMs = process.lastCheckAt === null ? 0 : Date.parse(process.lastCheckAt);
    const freshCheck = checkMs > 0 && checkMs <= sampledMs && sampledMs - checkMs <= FRESHNESS_MS;
    if (!freshScan || (!freshCheck && ['healthy', 'unhealthy', 'hung'].includes(process.status))) {
      process.status = 'unknown';
      continue;
    }
    if (process.status === 'hung' || process.status === 'unhealthy' || (process.status === 'offline' && process.hasCrash)) {
      abnormal = true;
      report.findings.push({
        severity: process.status === 'offline' ? 'error' : 'warning', title: process.status === 'offline' ? '观察到异常退出标记' : '观察到进程探活异常',
        detail: `PID ${process.pid}：${process.status === 'hung' ? 'HTTP 响应超时' : process.status === 'unhealthy' ? '端口不可达' : 'offline 且 has_crash=true'}；仅为上游观察，故障根因尚未确认。`,
        suggestion: '人工核对进程状态、监听端口及已有日志；本分析不会重启或操作进程。',
      });
    }
  }
  for (const event of report.interruptions) {
    if (event.resolved) continue;
    abnormal = true;
    const known = Object.hasOwn(agentInterruptionLabels, event.type);
    report.findings.push({
      severity: event.severity === 'critical' || event.severity === 'high' ? 'error' : 'warning',
      title: `未处理中断：${known ? agentInterruptionLabels[event.type] : '未知类型'}`,
      detail: `已采集中断 ${safeText(event.id)}；类型 ${event.type}；等级 ${event.severity}。事件不等于已确认故障根因。`,
      suggestion: Object.hasOwn(SUGGESTIONS, event.type) ? SUGGESTIONS[event.type] : '人工核对该未知类型的上游事件定义与调用记录；不自动执行任何动作。',
    });
  }
  if (countData && countData.total > 0) {
    abnormal = true;
    report.findings.push({
      severity: countData.critical > 0 || countData.high > 0 ? 'error' : 'warning', title: '窗口内存在未处理事件',
      detail: report.totals.unresolved === null ? '汇总来源受限，仅能确认存在未处理事件，完整总数未知。' : `同窗口全部未处理事件 ${countData.total}，critical ${countData.critical}，high ${countData.high}；不以最多 200 行明细冒充总数。`,
      suggestion: '按严重程度人工核对；本服务不调用 resolve，也不确认故障根因。',
    });
  }
  const observed = report.processes.length > 0 || report.sessions.length > 0 || report.interruptions.length > 0 || report.latency.some(row => row.calls > 0);
  report.outcome = abnormal ? 'abnormal' : report.status === 'ok' && freshScan && observed && report.processes.every(row => row.status !== 'unknown') ? 'observed' : 'unknown';
  report.summary = `仅分析 AgentSight 只读证据；窗口 ${localTime(report.window.start)} 至 ${localTime(report.window.end)}，采样 ${localTime(report.sampledAt)}。` +
    `已采集会话 ${report.sessions.length}（会话及 Token 合计仅针对有效完整的已采集列表，不是会话终身累计；包含辅助调用，输入包含缓存用量；未报告 usage 的调用可能以零记录），` +
    `中断明细 ${report.interruptions.length}（上游仅未解决、最多 200 行；全窗口未处理总数${report.totals.unresolved === null ? '未知' : ` ${report.totals.unresolved}`}）。` +
    `延迟仅描述完整调用，null 表示无测量。覆盖 ${report.status}，结论 ${report.outcome}；` +
    'healthy 仅表示 HTTP 任意状态响应，不保证业务正常；no_port 可为正常 CLI，offline 无崩溃标记不认定崩溃。提交成功不意味着 Agent 健康，未确认故障根因。';
  return report;
}
