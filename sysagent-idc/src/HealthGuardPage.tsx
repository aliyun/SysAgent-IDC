import { useRef, useState, type CSSProperties } from 'react';
import { Activity, ArrowDownToLine, ArrowLeft, ArrowRight, Blocks, Check, ChevronRight, Clock3, Cpu, FileText, FolderRoot, Gauge, HardDrive, Info, ListChecks, LoaderCircle, MemoryStick, Network, RefreshCw, Settings2, ShieldCheck, Sparkles, Trash2, TriangleAlert, Zap, type LucideIcon } from 'lucide-react';
import type { Device, PageId } from './data';
import { MascotLogo, Modal } from './components';
import { AgentOverviewCards } from './AgentOverviewCards';
import { ResourceRankings } from './ResourceRankings';
import { HealthPerformance } from './HealthPerformance';
import { CollectionStatus } from './CollectionStatus';
import { localTime } from '../agent-diagnostics';
import { collectedRankingRows, inspectionResultLabel, buildHealthReport, formatResourceValue, formatResourceQuantity, inspectionScope, scoreBand, stateResourceIds, summarizeHealth, type HealthState, type Inspection, type ResourceId } from './health-data';
import { cleanupAgentSessions, cleanupResources, executeProcessCleanup, prepareProcessCleanup, optimizeHealth, runHealthInspection } from './health-api';
import type { ProcessCleanupPlan, ProcessCleanupResult } from './idc-client';
export type RefreshHealthSnapshot = (refresh?: boolean) => Promise<HealthState>;
export interface HealthReportContentProps {
  device: Device;
  state: HealthState;
}
export interface HealthGuardPageProps extends HealthReportContentProps {
  loading: boolean;
  loadError: string;
  onRefresh: RefreshHealthSnapshot;
  onNavigate: (page: PageId) => void;
  onNotify: (message: string) => void;
  externalBusy: boolean;
  onBusyChange: (busy: boolean) => void;
}
type OperationPhase = 'idle' | 'request' | 'refresh';
type GuardOperation = 'cleanup' | 'session-cleanup' | 'optimize' | 'inspect';
interface SessionSelection {
  agentId: string;
  ids: string[];
}
const resourceIcons: Record<ResourceId, LucideIcon> = {
  cpu: Cpu,
  energy: Zap,
  memory: MemoryStick,
  disk: HardDrive,
  gpu: Blocks
},
  inspectionIcons: Record<string, LucideIcon> = {
    agents: Activity,
    gpu: Blocks,
    root: FolderRoot,
    memory: MemoryStick,
    fd: FileText,
    logs: FileText,
    load: Gauge,
    network: Network,
    io: HardDrive,
    security: ShieldCheck,
    system: Settings2
  },
  resourceColors: Record<ResourceId, string> = {
    cpu: "#2b6cff",
    energy: "#e7a435",
    memory: "#0fb57f",
    disk: "#f29122",
    gpu: "#8b5cf6"
  },
  resourceCircumference = 2 * Math.PI * 33;
function ScoreRing({
  score,
  label,
  color
}: {
  score: number;
  label?: string;
  color?: string;
}) {
  const band = { ...scoreBand(score), ...(label ? { label } : {}), ...(color ? { color } : {}) };
  const circumference = 2 * Math.PI * 80;
  return <div
    className="sh-score-ring"
    data-band={band.id}
    style={{
      color: band.color
    }}
  >
    <svg
      viewBox="0 0 186 186"
      aria-hidden="true"
    >
      <circle
        className="track"
        cx="93"
        cy="93"
        r="80"
      />
      <circle
        className="value"
        cx="93"
        cy="93"
        r="80"
        stroke={band.color}
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - score / 100)}
      />
    </svg>
    <div>
      <strong>
        {score.toFixed(1)}
        <small>
          {"分"}
        </small>
      </strong>
      <span>
        {band.label}
      </span>
    </div>
  </div>;
}
export function HealthReportContent({
  device,
  state
}: HealthReportContentProps) {
  const collected = state.mode === 'collected';
  const summary = summarizeHealth(state);
  return <div className="snapshot-home sh-report">
    <div className="sh-report-header">
      <ScoreRing score={summary.score} label={summary.band.label} color={summary.band.color} />
      <div>
        <h3>
          {device.name}
        </h3>
        <p>
          {"整体快照 v"}
          {state.revision}
          {" · "}
          {localTime(state.sampledAt)}
        </p>
        <p>
          {collected ? '已有确定结论 ' : '已检查 '}
          {summary.checked}
          {" 项，"}
          {summary.unchecked}
          {collected ? ' 项尚无确定结论。' : ' 项未检查。'}
        </p>
      </div>
    </div>
    <section className="sh-formula">
      <strong>
        {"20 + (80 − x × 80/n) − y × 20/m"}
      </strong>
      <p>
        {"n="}
        {summary.n}
        {" · x="}
        {summary.x}
        {" · m="}
        {summary.m}
        {" · y="}
        {summary.y}
      </p>
      <p>
        {"y = 其他诊断异常 "}
        {summary.otherAbnormal}
        {" + 资源超过 90%"}
        {" "}
        {summary.resourceAbnormal}
      </p>
    </section>
    {collected && <div className="sh-report-inspections">
      {stateResourceIds(state).map(id => <div key={id}>
        <span>{state.resources[id].label} · {formatResourceQuantity(state.resources[id])}</span>
        <b>{formatResourceValue(state.resources[id])}</b>
      </div>)}
    </div>}
    <div className="sh-report-inspections">
      {state.inspections.map(operation => <div key={operation.id}>
        <span>
          {operation.label} · {inspectionScope(state, operation)}
          {operation.important ? " · 重要" : operation.phase === 2 ? " · 二期" : ""}
        </span>
        <b className={operation.status}>
          {inspectionResultLabel(operation)}
          {operation.usage !== null ? ` · ${operation.usage}%` : ""}
        </b>
      </div>)}
    </div>
    <h3 className="sh-record-title">
      {"操作记录 "}
      <span>
        {state.operations.length}
        {" 条"}
      </span>
    </h3>
    {!state.operations.length && <p className="sh-muted">
      {collected ? '暂无操作。本机采集只读；进程结束需本机核验与二次确认。' : '暂无操作。所有清理与优化仅作用于 Demo 数据。'}
    </p>}
    {state.operations.map(operation => <article
      className="sh-record"
      key={operation.id}
    >
      <span>
        <Check size={14} />
      </span>
      <div>
        <strong>
          {operation.kind === "cleanup" ? "资源清理" : operation.kind === "session-cleanup" ? "Session 清理" : operation.kind === "demo-alert" ? "资源告警演示" : operation.kind === "optimize" ? "一键优化" : "系统体检"}
        </strong>
        <p>
          {operation.names.join("、")}
        </p>
        <small>
          {localTime(operation.time)}
          {" · 整体快照 v"}
          {operation.revision}
        </small>
      </div>
    </article>)}
    <div className="sh-notice">
      <Info size={14} />
      {collected ? '系统资源来自本地采集；诊断按来源单独标注。未知百分比不参与阈值评分，未检查或不可用不代表正常。进程结束需单独确认。' : '分数按指定公式计算；未检查项没有正常结论，Demo 不清理真实进程或文件。'}
    </div>
  </div>;
}
export function HealthGuardPage({
  device,
  state,
  loading,
  loadError,
  onRefresh,
  onNavigate,
  onNotify,
  externalBusy,
  onBusyChange
}: HealthGuardPageProps) {
  const [selectedResource, setSelectedResource] = useState<ResourceId | null>(null);
  const [selectedRowIds, setSelectedRowIds] = useState<string[]>([]);
  const [optimizationOpen, setOptimizationOpen] = useState(false);
  const [selectedOptimizationIds, setSelectedOptimizationIds] = useState<string[]>([]);
  const [selectedInspectionId, setSelectedInspectionId] = useState<string | null>(null);
  const [inspectionListOpen, setInspectionListOpen] = useState(false);
  const [returnToInspectionList, setReturnToInspectionList] = useState(false);
  const [agentOnly, setAgentOnly] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [scoreRulesOpen, setScoreRulesOpen] = useState(false);
  const [performanceOpen, setPerformanceOpen] = useState(false);
  const [operationPhase, setOperationPhase] = useState<OperationPhase>("idle");
  const [operationError, setOperationError] = useState("");
  const [refreshRequired, setRefreshRequired] = useState(false);
  const [collectorEnabled, setCollectorEnabled] = useState(true);
  const [inspectionConfigOpen, setInspectionConfigOpen] = useState(false);
  const [operationSuccess, setOperationSuccess] = useState("");
  const [cleanupPlan, setCleanupPlan] = useState<ProcessCleanupPlan | null>(null);
  const [processResults, setProcessResults] = useState<ProcessCleanupResult['results']>([]);
  const operationInFlight = useRef(false);
  const collected = state.mode === 'collected';
  const summary = summarizeHealth(state);
  const busy = operationPhase !== "idle" || loading || externalBusy;
  const blocked = busy || refreshRequired || !!loadError || !collectorEnabled;
  const resource = selectedResource ? state.resources[selectedResource] : null;
  const selectedRows = (resource ? collected ? collectedRankingRows(resource, agentOnly) : resource.rows.slice(0, 10) : []).filter(item => item.cleanable && selectedRowIds.includes(item.id));
  const selectedOptimizations = state.optimizations.filter(item => selectedOptimizationIds.includes(item.id));
  const inspection = state.inspections.find(item => item.id === selectedInspectionId);
  const inspectionCounts = {
    abnormal: state.inspections.filter(item => item.status === "abnormal").length,
    normal: state.inspections.filter(item => item.status === "normal").length,
    unchecked: state.inspections.filter(item => item.status === 'unchecked' && !item.execution).length,
    limited: state.inspections.filter(item => item.status === 'unchecked' && !!item.execution).length
  };
  const inspectionGroups = [{
    title: "重要检查",
    hint: "使用率严格大于 90% 计为重要异常",
    items: state.inspections.filter(item => item.important)
  }, {
    title: "一期诊断",
    hint: collected ? '结果与来源分别标注；未检查不代表正常' : '已检查 · Demo 样本',
    items: state.inspections.filter(item => !item.important && item.phase === 1)
  }, {
    title: "二期规划",
    hint: "尚未检查，不代表正常",
    items: state.inspections.filter(item => item.phase === 2)
  }];
  const agentsRecovered = state.inspections.find(item => item.id === "agents")?.status === "normal";
  function openResource(resourceId: ResourceId) {
    setSelectedResource(resourceId);
    setCleanupPlan(null);
    setProcessResults([]);
    setAgentOnly(false);
    setSelectedRowIds(state.resources[resourceId].rows.slice(0, 10).filter(entry => entry.cleanable && entry.defaultSelected).map(entry => entry.id));
    setOperationError("");
    setOperationSuccess("");
  }
  function openOptimization() {
    setSelectedOptimizationIds(state.optimizations.map(item => item.id));
    setOptimizationOpen(true);
    setOperationError("");
    setOperationSuccess("");
  }
  function openInspectionFromList(inspectionId: string) {
    setInspectionListOpen(false);
    setReturnToInspectionList(true);
    setSelectedInspectionId(inspectionId);
  }
  function openInspection(inspectionId: string) {
    setReturnToInspectionList(false);
    setSelectedInspectionId(inspectionId);
  }
  function renderInspection(item: Inspection) {
    const InspectionIcon = inspectionIcons[item.id];
    return <button
      className={`sh-inspection ${item.important ? "important" : ""} ${item.status}`}
      data-inspection={item.id}
      data-version={state.revision}
      disabled={busy}
      onClick={() => openInspectionFromList(item.id)}
      key={item.id}
    >
      <div className="sh-inspection-title">
        <span>
          <InspectionIcon size={19} />
        </span>
        <strong>
          {item.label}
        </strong>
        {item.important && <em>
          {"重要"}
        </em>}
        {item.phase === 2 && <em className="phase">
          {"二期"}
        </em>}
      </div>
      <div className="sh-inspection-result">
        <span>
          {inspectionResultLabel(item)}
        </span>
        {item.usage !== null && <b>
          {item.usage}
          <small>
            {"%"}
          </small>
        </b>}
      </div>
      <p>
        {item.detail}
      </p>
      <div className="sh-inspection-footer">
        <span>
          {item.execution === 'partial' ? 'sysAK 已检查 · 部分覆盖，不能判定整体正常' : item.execution === 'unavailable' ? 'sysAK 已尝试检查 · 数据不可用' : item.status === 'unchecked' ? '暂无检查结果' : `${inspectionScope(state, item)}${item.important ? ' · 阈值 >90%' : ' · 已检查'}`}
        </span>
        <ChevronRight size={13} />
      </div>
    </button>;
  }
  async function runOperation(kind: GuardOperation, sessionSelection?: SessionSelection) {
    if (
      blocked ||
      operationInFlight.current ||
      (collected && kind !== 'inspect') ||
      (kind === "cleanup" && (!selectedResource || !selectedRows.length)) ||
      (kind === "session-cleanup" && (!selectedResource || !sessionSelection?.ids.length)) ||
      (kind === "optimize" && !selectedOptimizations.length)
    ) return;
    operationInFlight.current = true;
    onBusyChange(true);
    setOperationError("");
    setOperationSuccess("");
    setOperationPhase("request");
    let mutationCompleted = false;
    try {
      if (kind === "cleanup") {
        await cleanupResources(selectedResource!, selectedRows.map(row => row.id), state.revision);
      } else if (kind === "session-cleanup") {
        await cleanupAgentSessions(selectedResource!, sessionSelection!.agentId, sessionSelection!.ids, state.revision);
      } else if (kind === "optimize") {
        await optimizeHealth(selectedOptimizations.map(item => item.id), state.revision);
      } else {
        await runHealthInspection(state.revision);
      }
      mutationCompleted = true;
      setOperationPhase("refresh");
      const snapshot = await onRefresh(false);
      setSelectedRowIds([]);
      setSelectedOptimizationIds([]);
      const message = `${kind === "session-cleanup" ? "Session 清理" : kind === "cleanup" ? "清理" : kind === "optimize" ? "优化" : "体检"}完成，资源快照与诊断展示已刷新至 v${snapshot.revision}；缺失或未检查项没有正常结论。`;
      setOperationSuccess(message);
      onNotify(message);
    } catch (error) {
      if (mutationCompleted) {
        setRefreshRequired(true);
        setOperationError("操作接口已完成，但整体刷新失败。请重试刷新，不要重复提交操作。");
      } else {
        setOperationError(error instanceof Error ? error.message : "请求失败，请稍后重试");
        try {
          await onRefresh(false);
        } catch { }
      }
    } finally {
      operationInFlight.current = false;
      setOperationPhase("idle");
      onBusyChange(false);
    }
  }
  async function prepareCleanup() {
    if (blocked || operationInFlight.current || !selectedResource || !selectedRows.length) return;
    operationInFlight.current = true;
    onBusyChange(true);
    setOperationPhase('request');
    setOperationError('');
    setOperationSuccess('');
    setProcessResults([]);
    try {
      setCleanupPlan(await prepareProcessCleanup(selectedResource, selectedRows.map(row => row.id), state.revision));
    } catch (error) {
      setCleanupPlan(null);
      setOperationError(error instanceof Error ? error.message : '进程确认准备失败');
    } finally {
      operationInFlight.current = false;
      setOperationPhase('idle');
      onBusyChange(false);
    }
  }
  async function confirmCleanup() {
    if (blocked || operationInFlight.current || !cleanupPlan) return;
    const plan = cleanupPlan;
    setCleanupPlan(null);
    operationInFlight.current = true;
    onBusyChange(true);
    setOperationPhase('request');
    setOperationError('');
    try {
      const reply = await executeProcessCleanup(plan.token);
      setProcessResults(reply.results);
      setSelectedRowIds([]);
      setOperationPhase('refresh');
      try {
        await onRefresh(true);
        setRefreshRequired(false);
        const message = `已向 ${reply.results.filter(item => item.status === 'signalled').length} 个进程发送结束请求，其余结果见下方；已刷新快照。发送信号不代表进程已退出或资源已释放。`;
        setOperationSuccess(message);
        onNotify(message);
      } catch {
        setRefreshRequired(true);
        setOperationError('结束请求已处理，但快照刷新失败。请刷新核对，不要重复提交。');
      }
    } catch (error) {
      setSelectedRowIds([]);
      setRefreshRequired(true);
      setOperationError(`${error instanceof Error ? error.message : '进程操作结果不明'}。请先刷新核对，不要重复提交。`);
    } finally {
      operationInFlight.current = false;
      setOperationPhase('idle');
      onBusyChange(false);
    }
  }
  async function refreshSnapshot() {
    if (!busy) {
      onBusyChange(true);
      setOperationPhase("refresh");
      try {
        const snapshot = await onRefresh();
        setRefreshRequired(false);
        setOperationError("");
        setSelectedRowIds([]);
        setSelectedOptimizationIds([]);
        setOperationSuccess(`整体数据已刷新至 v${snapshot.revision}。`);
      } catch (error) {
        setOperationError(error instanceof Error ? error.message : "整体刷新失败");
      } finally {
        setOperationPhase("idle");
        onBusyChange(false);
      }
    }
  }
  function exportReport() {
    const url = URL.createObjectURL(new Blob([buildHealthReport(state, device)], {
      type: "text/plain;charset=utf-8"
    }));
    const link = document.createElement("a");
    link.href = url;
    link.download = collected ? 'sysagent-health-collected-report.txt' : 'sysagent-health-demo-report.txt';
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const operationStatus = <>
    {operationPhase !== "idle" && <div
      className="sh-operation-state"
      role="status"
    >
      <LoaderCircle
        size={15}
        className="spinning"
      />
      {operationPhase === "request" ? collected ? '正在执行本地操作并核验结果…' : '正在请求 Demo 接口…' : '操作完成，正在刷新快照…'}
    </div>}
    {operationError && <div
      className="sh-operation-error"
      role="alert"
    >
      <TriangleAlert size={15} />
      <span>
        {operationError}
      </span>
      {refreshRequired && <button
        onClick={refreshSnapshot}
        disabled={busy}
      >
        {"重试整体刷新"}
      </button>}
    </div>}
    {operationSuccess && <div
      className="sh-operation-success"
      role="status"
    >
      <Check size={15} />
      {operationSuccess}
    </div>}
  </>;
  return loading || loadError ? <div className="snapshot-home sh-unavailable">
    <CollectionStatus open={inspectionConfigOpen} onClose={() => setInspectionConfigOpen(false)} lastInspectionAt={state.operations.find(operation => operation.kind === 'inspect')?.time ?? null} busy={busy} onRefresh={onRefresh} onBusyChange={onBusyChange} onEnabledChange={setCollectorEnabled} />
    <button className="hg-text-button sh-inspection-entry" aria-haspopup="dialog" onClick={() => setInspectionConfigOpen(true)}>
      巡检配置<ChevronRight size={13} />
    </button>
    <span>
      {loading ? <LoaderCircle
        size={32}
        className="spinning"
      /> : <TriangleAlert size={32} />}
    </span>
    <h1>
      {loading ? "正在加载系统资源与体检数据" : "整体数据暂不可用"}
    </h1>
    <p>
      {loadError || "等待 sysAK 本地采集与 OpenAPI 解析返回快照；没有数据时不展示资源数值或系统评分。"}
    </p>
    <button
      className="hg-button"
      disabled={busy}
      onClick={refreshSnapshot}
    >
      {"重试加载"}
    </button>
  </div> : <div className="snapshot-home">
    <CollectionStatus open={inspectionConfigOpen} onClose={() => setInspectionConfigOpen(false)} lastInspectionAt={state.operations.find(operation => operation.kind === 'inspect')?.time ?? null} busy={busy} onRefresh={onRefresh} onBusyChange={onBusyChange} onEnabledChange={setCollectorEnabled} />
    <div className="sh-topline">
      <div>
        <MascotLogo />
        <span>
          {"本机健康中心"}
        </span>
        <small>
          {device.name}
        </small>
      </div>
      <button
        className="hg-text-button"
        aria-haspopup="dialog"
        onClick={() => setInspectionConfigOpen(true)}
      >
        {"巡检配置"}
        <ChevronRight size={13} />
      </button>
    </div>
    <section className="sh-hero">
      <div className="sh-hero-score">
        <ScoreRing score={summary.score} label={summary.band.label} color={summary.band.color} />
        {!collected && <button
          className="sh-optimize-button"
          disabled={blocked || !state.optimizations.length}
          onClick={openOptimization}
        >
          <Sparkles size={17} />
          {"一键优化 "}
          {state.optimizations.length}
          {" 项"}
          <ArrowRight size={14} />
        </button>}
      </div>
      <div className="sh-hero-copy">
        <span className="sh-eyebrow">
          {"LOCAL SYSTEM HEALTH"}
        </span>
        <h1>
          {collected ? summary.open.length ? '当前采集与诊断展示中有指标需要关注。' : '当前资源快照已更新，未检查项没有健康结论。' : summary.x ? `${summary.x} 项重要诊断异常，建议优先优化。` : summary.y ? "重要诊断已正常，仍有资源与服务需要关注。" : "已检查项运行良好，继续守护本机健康。"}
        </h1>
        <p>
          {collected ? `IDC / sysAK 经本地 OpenAPI 解析系统资源，只读展示。诊断有确定结论 ${summary.checked} 项、未检查或结论受限 ${summary.unchecked} 项；资源不可用 ${summary.unavailable} 项。其他模块仍可能为 Demo，不代表全部诊断已接入。` : <>{"已完成 "}
          {summary.checked}
          {" 项一期检查，根目录、内存和 FD 中"}
          {" "}
          {summary.x}
          {" 项超过 90%。其他诊断异常 "}
          {summary.otherAbnormal}
          {" "}
          {"项，资源超限 "}
          {summary.resourceAbnormal}
          {" 项；"}
          {summary.unchecked}
          {" "}
          {"项二期功能尚未检查。"}</>}
        </p>
        <div className="sh-hero-tags">
          <span className={summary.x ? "critical" : "healthy"}>
            {"重要异常 "}
            {summary.x}
            {` / ${summary.n}`}
          </span>
          <span>
            {"其他异常计数 "}
            {summary.y}
          </span>
          <span>
            {collected ? '尚无定论 ' : '未检查 '}
            {summary.unchecked}
          </span>
        </div>
        <div className="sh-hero-actions">
          <button
            className="hg-button"
            disabled={blocked}
            onClick={() => runOperation("inspect")}
          >
            <RefreshCw size={14} />
            {"重新体检"}
          </button>
          <button
            className="hg-text-button"
            onClick={() => setScoreRulesOpen(true)}
          >
            {"评分计算规则"}
            <ChevronRight size={13} />
          </button>
          <button
            className="hg-text-button"
            onClick={() => setReportOpen(true)}
          >
            <Clock3 size={13} />
            {"体检报告"}
          </button>
        </div>
        <div className="sh-score-legend">
          <span>
            <i style={{
              background: "#ef4444"
            }} />
            {"<60"}
          </span>
          <span>
            <i style={{
              background: "#f29122"
            }} />
            {"60–80"}
          </span>
          <span>
            <i style={{
              background: "#d4b225"
            }} />
            {"80–90"}
          </span>
          <span>
            <i style={{
              background: "#0fb57f"
            }} />
            {"90–100"}
          </span>
        </div>
      </div>
    </section>
    {!selectedResource && !optimizationOpen && operationStatus}
    {!collected && <AgentOverviewCards
      recovered={agentsRecovered}
      disabled={busy}
      onOpen={() => onNavigate("agents")}
    />}
    <section
      className="sh-home-panel resource"
      aria-label="系统资源"
    >
      <div className="sh-panel-head">
        <span className="sh-panel-mark">
          <Gauge size={19} />
        </span>
        <div>
          <h2>
            {"系统资源"}
          </h2>
          <p>
            {collected ? 'IDC / sysAK · 本地 OpenAPI 解析 · 当前采集快照（各项范围与时间见详情）' : state.hasGpu ? 'CPU、能耗、内存、磁盘与 GPU · 最新时刻同一份 Demo 快照' : 'CPU、能耗、内存与磁盘 · 最新时刻同一份 Demo 快照'}
          </p>
        </div>
        <div
          className="sh-snapshot-time sh-panel-aside"
          data-revision={state.revision}
        >
          <i />
          {localTime(state.sampledAt)}
          <small>
            {"v"}
            {state.revision}
          </small>
          <button
            aria-label="刷新整体数据"
            disabled={busy}
            onClick={refreshSnapshot}
          >
            <RefreshCw size={13} />
          </button>
        </div>
      </div>
      <div
        className="sh-resource-grid"
        style={{
          "--resource-count": stateResourceIds(state).length
        } as CSSProperties}
      >
        {stateResourceIds(state).map(resourceId => {
          const snapshot = state.resources[resourceId];
          const ResourceIcon = resourceIcons[resourceId];
          const exceeded = snapshot.usage !== null && snapshot.usage > 90;
          const hasPercent = snapshot.usage !== null && snapshot.status !== 'unavailable';
          const agentUsage = snapshot.rows.filter(row => row.agentId).reduce((row, agentRow) => row + agentRow.usage, 0);
          return <section
            className={`sh-resource-card ${exceeded ? "exceeded" : ""}`}
            data-resource={resourceId}
            data-version={state.revision}
            key={resourceId}
          >
            <div className="sh-resource-title">
              <span style={{
                background: `${resourceColors[resourceId]}12`,
                color: resourceColors[resourceId]
              }}>
                <ResourceIcon size={20} />
              </span>
              <h3>
                {snapshot.label}
                {resourceId === "cpu" && <small>
                  {"整机"}
                </small>}
                {resourceId === "energy" && <small>
                  {collected ? '功率测量' : '预算占比 · 估算'}
                </small>}
              </h3>
              <span className={exceeded ? "sh-limit abnormal" : "sh-limit"}>
                {snapshot.status === 'unavailable' ? '不可用' : snapshot.status === 'partial' ? '部分采集' : hasPercent ? exceeded ? '超过 90%' : '未超限' : snapshot.quantity?.unit === 'W' ? '实测功率' : '不可用'}
              </span>
            </div>
            <div className="sh-resource-body">
              <div
                className={`sh-resource-value ${hasPercent ? '' : 'sh-resource-unknown'}`}
                role="img"
                aria-label={`${snapshot.label} ${formatResourceValue(snapshot)}`}
              >
                {hasPercent && <svg
                  viewBox="0 0 80 80"
                  aria-hidden="true"
                >
                  <circle
                    className="track"
                    cx="40"
                    cy="40"
                    r="33"
                  />
                  <circle
                    className="value"
                    cx="40"
                    cy="40"
                    r="33"
                    stroke={exceeded ? "#ef6a60" : resourceColors[resourceId]}
                    strokeDasharray={resourceCircumference}
                    strokeDashoffset={resourceCircumference * (1 - Math.min(100, snapshot.usage!) / 100)}
                  />
                </svg>}
                <strong>{hasPercent ? <>{snapshot.usage}<small>%</small></> : formatResourceValue(snapshot)}</strong>
              </div>
              <div className="sh-resource-meta">
                <span>
                  {formatResourceQuantity(snapshot)}
                </span>
                {!collected && agentUsage > 0 && <span className="agent">
                  <i />
                  {"Agent "}
                  {Math.round(agentUsage * 10) / 10}
                  {"%"}
                </span>}
              </div>
            </div>
            <div className="sh-resource-bottom">
              <span>
                {hasPercent ? '阈值 90%' : '不参与百分比阈值'}
              </span>
              <button
                aria-label={`查看${snapshot.label}详情`}
                disabled={busy}
                onClick={() => openResource(resourceId)}
              >
                {"详情"}
                <ChevronRight size={14} />
              </button>
            </div>
          </section>;
        })}
      </div>
    </section>
    <button
      className="sh-inspection-entry"
      data-version={state.revision}
      aria-label={`查看全部 ${state.inspections.length} 项体检项目`}
      disabled={busy}
      onClick={() => setInspectionListOpen(true)}
    >
      <span className="sh-entry-icon">
        <ListChecks size={23} />
      </span>
      <div className="sh-entry-copy">
        <strong>
          {"体检项目"}
          <small>
            {state.inspections.length}
            {` 项 · ${summary.n} 项重要 · ${state.inspections.filter(item => item.phase === 2).length} 项二期${collected ? ' · 诊断来源单独标注' : ' · Demo'}`}
          </small>
        </strong>
        <p>
          {inspectionCounts.abnormal ? `${inspectionCounts.abnormal} 项异常待关注，重要项 ${summary.x} / ${summary.n} 超过 90%` : summary.checked ? '已检查项目未发现异常，不能推断未检查项目' : '本次诊断尚未检查，没有正常结论'}
          {` · ${inspectionCounts.unchecked} 项未检查 · ${inspectionCounts.limited} 项结论受限`}
        </p>
        <div
          className="sh-entry-bar"
          aria-hidden="true"
        >
          <i
            className="abnormal"
            style={{
              flex: inspectionCounts.abnormal
            }}
          />
          <i
            className="normal"
            style={{
              flex: inspectionCounts.normal
            }}
          />
          <i
            className="unchecked"
            style={{
              flex: inspectionCounts.unchecked + inspectionCounts.limited
            }}
          />
        </div>
      </div>
      <div className="sh-entry-stats">
        {([["abnormal", "异常"], ["normal", "正常"], ["unchecked", "未检查"]] as const).map(([item, entry]) => <div
          className={item}
          data-entry-stat={item}
          key={item}
        >
          <b>
            {inspectionCounts[item] + (item === 'unchecked' ? inspectionCounts.limited : 0)}
          </b>
          <span>
            {item === 'unchecked' && collected ? '尚无定论' : entry}
          </span>
        </div>)}
      </div>
      <span className="sh-entry-cta">
        {"查看体检项目"}
        <ChevronRight size={14} />
      </span>
    </button>
    <div className="sh-bottom-note">
      <Info size={14} />
      <span>
        {collected ? '系统资源与进程排行来自只读采集；支持当前用户非受保护进程的确认结束和 Agent 白名单筛选，不提供 Session 归属、文件清理或自动修复。能耗仅显示实测功率或不可用，GPU 缺少测量不代表正常。' : `清理与优化通过模拟解析接口更新展示数据：Session 清理在 CPU、能耗、内存${state.hasGpu ? "和 GPU " : ""}间同步释放运行资源，磁盘中按 Session 删除其数据文件。能耗按预算占比估算；接口成功后统一刷新，不操作真实文件或任务。`}
      </span>
    </div>
    {resource && <Modal
      title={`${resource.label} · ${collected ? resource.rankLabel || '资源排行' : '占用排行'} Top 10`}
      subtitle={`整体快照 v${state.revision} · ${localTime(resource.sampledAt ?? state.sampledAt)} · ${resource.unit}${collected ? ' · 只读采集' : ' · Demo'}`}
      onClose={() => {
        busy || setSelectedResource(null);
      }}
      wide={true}
    >
      <div className="snapshot-home">
        <div className="sh-rank-intro">
          <div>
            <strong>
              {formatResourceValue(resource)}
            </strong>
            <span>
              {resource.label}
              {" · 最新整体占用"}
            </span>
          </div>
          <p>
            {collected ? `${formatResourceQuantity(resource)} · ${resource.note || '当前采集范围，排行不等于整机占用总和。'}` : agentOnly ? resource.id === "disk" ? "已筛选 Agent 相关数据：展开 Agent 查看各 Session 占用的工作目录、缓存与中间结果，运行中会话的数据受保护。" : "已筛选 Agent 相关进程：展开 Agent 查看 Session，空闲或已完成的会话可勾选清理，运行中会话受保护。" : resource.id === "energy" ? "能耗以预算占比展示，按程序及 Session 分摊，仅为 Demo 估算，非实测能耗。" : "Agent 应用可继续展开 Session；运行中会话受保护，空闲或完成的会话可按需清理。"}
          </p>
        </div>
        <ResourceRankings
          resource={resource}
          collected={collected}
          color={resourceColors[resource.id]}
          selectedIds={selectedRowIds}
          onSelect={ids => { setSelectedRowIds(ids); setCleanupPlan(null); }}
          blocked={blocked}
          busy={busy}
          onCleanupSessions={(item, entry) => runOperation("session-cleanup", {
            agentId: item,
            ids: entry
          })}
          agentOnly={agentOnly}
          onAgentOnlyChange={value => { setAgentOnly(value); setSelectedRowIds([]); setCleanupPlan(null); }}
          key={resource.id}
        />
        <div className="sh-notice">
          <Info size={14} />
          {collected ? '排行仅为已采集范围。清理会请求结束整个进程，可能中断任务；不会删除磁盘文件或清理 Agent Session。' : '清理仅作用于选中的 Demo 对象。真实进程回收可能中断任务，真实删除不一定可恢复。'}
        </div>
        {operationStatus}
        {collected && <>
          {!!processResults.length && <div className="sh-process-results" role="status">{processResults.map(item => <p key={`${item.pid}-${item.starttime}`}><strong>{item.name} · PID {item.pid}</strong> — {item.status === 'signalled' ? '已发送 SIGTERM（不代表已退出）' : item.reason}</p>)}</div>}
          {cleanupPlan ? <div className="sh-process-confirm" role="group" aria-label="确认结束进程">
            <h3>确认结束以下进程？</h3>
            <p>会结束整个进程，可能中断任务并丢失未保存的数据；不清理文件，不强杀。确认有效期 60 秒。</p>
            {cleanupPlan.processes.map(item => <p key={item.id}><strong>{item.name}</strong> · PID {item.pid}</p>)}
            {cleanupPlan.revision !== state.revision && <p role="alert">快照已更新，请取消后重新选择。</p>}
            <div className="sh-card-footer"><button className="hg-button" disabled={busy} onClick={() => setCleanupPlan(null)}>取消</button><button className="hg-button primary" disabled={blocked || cleanupPlan.revision !== state.revision} onClick={confirmCleanup}>确认结束进程</button></div>
          </div> : <div className="sh-card-footer"><span>本机校验权限与身份，二次确认后发送 SIGTERM。</span><button className="hg-button primary" disabled={blocked || !selectedRows.length} onClick={prepareCleanup}><Trash2 size={15} />清理所选进程（{selectedRows.length}）</button></div>}
        </>}
        {!collected && <div className="sh-card-footer">
          {agentOnly ? <span>
            {"Agent 视图只按 Session 清理；切换“全部程序”可进行程序级清理。"}
          </span> : <>
            <span>
              {"操作后刷新整份快照，不只刷新本指标。"}
            </span>
            <button
              className="hg-button primary"
              disabled={blocked || !selectedRows.length}
              onClick={() => runOperation("cleanup")}
            >
              {busy ? <LoaderCircle
                size={15}
                className="spinning"
              /> : <Trash2 size={15} />}
              {"清理 "}
              {selectedRows.length}
              {" 项"}
            </button>
          </>}
        </div>}
      </div>
    </Modal>}
    {inspectionListOpen && <Modal
      title="体检项目"
      subtitle={`整体快照 v${state.revision} · ${inspectionCounts.abnormal} 项异常 · ${inspectionCounts.unchecked} 项未检查 · ${inspectionCounts.limited} 项结论受限`}
      onClose={() => setInspectionListOpen(false)}
      wide={true}
    >
      <div className="snapshot-home sh-inspection-modal">
        {inspectionGroups.map(item => <section
          className="sh-inspection-group"
          key={item.title}
        >
          <div className="sh-inspection-group-title">
            <h3>
              {item.title}
            </h3>
            <span>
              {item.items.length}
              {" 项 · "}
              {item.hint}
            </span>
          </div>
          <div className="sh-inspection-grid">
            {item.items.map(renderInspection)}
          </div>
        </section>)}
        <div className="sh-card-footer">
          <span>
            {"点击任一项目查看证据与处理建议。"}
          </span>
          <button
            className="hg-button"
            onClick={() => {
              setInspectionListOpen(false);
              setPerformanceOpen(true);
            }}
          >
            <Activity size={14} />
            {"性能监视"}
          </button>
        </div>
      </div>
    </Modal>}
    {!collected && optimizationOpen && <Modal
      title={`一键优化 · ${state.optimizations.length} 项建议`}
      subtitle={`已勾选全部当前建议，可按需取消 · 整体快照 v${state.revision}`}
      onClose={() => {
        busy || setOptimizationOpen(false);
      }}
      wide={true}
    >
      <div className="snapshot-home">
        <div className="sh-optimization-intro">
          <Sparkles size={24} />
          <div>
            <strong>
              {"先确认范围，再优化系统"}
            </strong>
            <p>
              {"只提交选中的项目，处理后统一刷新资源、全部体检项与健康分。"}
            </p>
          </div>
        </div>
        <div className="sh-rank-toolbar">
          <label>
            <input
              type="checkbox"
              ref={item => {
                item && (item.indeterminate = selectedOptimizations.length > 0 && selectedOptimizations.length < state.optimizations.length);
              }}
              aria-label="全选优化建议"
              checked={state.optimizations.length > 0 && selectedOptimizations.length === state.optimizations.length}
              disabled={blocked || !state.optimizations.length}
              onChange={() => setSelectedOptimizationIds(selectedOptimizations.length === state.optimizations.length ? [] : state.optimizations.map(item => item.id))}
            />
            {"全选优化建议"}
          </label>
          <span>
            {"已选 "}
            {selectedOptimizations.length}
            {" / "}
            {state.optimizations.length}
            {" 项"}
          </span>
        </div>
        <div className="sh-optimization-list">
          {state.optimizations.map(item => <label key={item.id}>
            <input
              type="checkbox"
              aria-label={`选择${item.title}`}
              disabled={blocked}
              checked={selectedOptimizations.some(entry => entry.id === item.id)}
              onChange={() => setSelectedOptimizationIds(entry => entry.includes(item.id) ? entry.filter(id => id !== item.id) : [...entry, item.id])}
            />
            <div>
              <strong>
                {item.title}
              </strong>
              <p>
                {item.action}
              </p>
              <small>
                {item.effect}
              </small>
            </div>
            <span>
              {"Demo"}
            </span>
          </label>)}
        </div>
        {!state.optimizations.length && <div className="sh-optimization-empty">
          <Check size={30} />
          <h3>
            {"当前优化建议已处理完成"}
          </h3>
          <p>
            {"二期项目仍未检查，不代表系统所有问题均已排除。"}
          </p>
        </div>}
        {operationStatus}
        <div className="sh-card-footer">
          <span>
            {"Demo 接口 · 不修改真实系统"}
          </span>
          <button
            className="hg-button primary"
            disabled={blocked || !selectedOptimizations.length}
            onClick={() => runOperation("optimize")}
          >
            {busy ? <LoaderCircle
              size={15}
              className="spinning"
            /> : <Sparkles size={15} />}
            {"优化 "}
            {selectedOptimizations.length}
            {" 项"}
          </button>
        </div>
      </div>
    </Modal>}
    {inspection && <Modal
      title={inspection.label}
      subtitle={`${inspectionScope(state, inspection)} · ${inspection.important ? '重要体检项目 · 严格大于90%计为异常' : inspection.status === 'unchecked' ? '未检查不等于正常' : '一期诊断'}`}
      onClose={() => setSelectedInspectionId(null)}
    >
      <div className="snapshot-home">
        {returnToInspectionList && <button
          className="hg-text-button sh-back-button"
          onClick={() => {
            setSelectedInspectionId(null);
            setInspectionListOpen(true);
          }}
        >
          <ArrowLeft size={13} />
          {"返回体检项目"}
        </button>}
        <div className={`sh-diagnosis-summary ${inspection.status}`}>
          <strong>
            {inspectionResultLabel(inspection)}
          </strong>
          {inspection.usage !== null && <b>
            {inspection.usage}
            {"%"}
          </b>}
          <p>
            {inspection.detail}
          </p>
        </div>
        {inspection.evidence.map(item => <p
          className="sh-evidence"
          key={item}
        >
          <Info size={14} />
          {item}
        </p>)}
        {inspection.phase === 2 ? <div className="sh-notice">
          <Clock3 size={14} />
          {"本次没有运行该检查，暂不能提供正常或异常结论。"}
        </div> : <div className="sh-card-footer">
          <span>
            {"快照 v"}
            {state.revision}
          </span>
          {["root", "memory"].includes(inspection.id) ? <button
            className="hg-button"
            onClick={() => {
              setSelectedInspectionId(null);
              openResource(inspection.id === "root" ? "disk" : "memory");
            }}
          >
            {"查看资源排行"}
            <ArrowRight size={14} />
          </button> : ["agents", "gpu", "logs"].includes(inspection.id) ? <button
            className="hg-button"
            onClick={() => {
              setSelectedInspectionId(null);
              onNavigate((inspection.id === "logs" ? "logs" : inspection.id) as PageId);
            }}
          >
            {"进入诊断页面"}
            <ArrowRight size={14} />
          </button> : <button
            className="hg-button"
            disabled={!state.optimizations.some(item => item.inspection === inspection.id)}
            onClick={() => {
              setSelectedInspectionId(null);
              openOptimization();
            }}
          >
            {"查看优化建议"}
            <ArrowRight size={14} />
          </button>}
        </div>}
      </div>
    </Modal>}
    {scoreRulesOpen && <Modal
      title="系统评分规则"
      subtitle="按指定公式计算，先计算精确值，再显示一位小数"
      onClose={() => setScoreRulesOpen(false)}
      wide={true}
    >
      <div className="snapshot-home">
        <section className="sh-formula">
          <strong>
            {"20 + (80 − x × 80/n) − y × 20/m"}
          </strong>
          <p>
            {"当前：20 + (80 − "}
            {summary.x}
            {" × 80/"}
            {summary.n}
            {") − "}
            {summary.y}
            {" × 20/"}
            {summary.m}
            {" = "}
            {summary.score.toFixed(1)}
            {" 分"}
          </p>
        </section>
        <div className="sh-formula-variables">
          <div>
            <b>
              {"n = "}
              {summary.n}
            </b>
            <span>
              {"重要项目：根目录、内存、FD"}
            </span>
          </div>
          <div>
            <b>
              {"x = "}
              {summary.x}
            </b>
            <span>
              {"重要项目中使用率严格超过 90% 的数量"}
            </span>
          </div>
          <div>
            <b>
              {"m = "}
              {summary.m}
            </b>
            <span>
              {"其他体检项目 "}
              {state.inspections.filter(item => !item.important).length}
              {" 项 + 有百分比的系统资源 "}
              {stateResourceIds(state).filter(id => state.resources[id].usage !== null).length}
              {collected ? ' 项（未知值与功率 W 排除）' : ' 项（含 Demo 能耗预算占比）'}
            </span>
          </div>
          <div>
            <b>
              {"y = "}
              {summary.y}
            </b>
            <span>
              {"其他诊断异常 "}
              {summary.otherAbnormal}
              {" 项 + 资源超过90%"}
              {" "}
              {summary.resourceAbnormal}
              {" 项"}
            </span>
          </div>
        </div>
        <p className="sh-notice">
          <Info size={14} />
          {'根目录与内存诊断与资源指标独立计数；未检查诊断不产生异常计数，也不视为正常。资源百分比为 null 时排除于 m，实测功率 W 不参与百分比评分。'}
        </p>
        <div className="sh-band-grid">
          {[{
            color: "#ef4444",
            text: "红色",
            range: "0 ≤ 分数 < 60"
          }, {
            color: "#f29122",
            text: "橙色",
            range: "60 ≤ 分数 < 80"
          }, {
            color: "#d4b225",
            text: "黄色",
            range: "80 ≤ 分数 < 90"
          }, {
            color: "#0fb57f",
            text: "绿色",
            range: "90 ≤ 分数 ≤ 100"
          }].map(item => <div key={item.text}>
            <i style={{
              background: item.color
            }} />
            <b>
              {item.text}
            </b>
            <span>
              {item.range}
            </span>
          </div>)}
        </div>
      </div>
    </Modal>}
    {reportOpen && <Modal
      title="本机体检报告"
      subtitle={`${collected ? '本地采集 · 诊断来源单独标注' : 'Demo'} 最新整体快照 v${state.revision}`}
      onClose={() => setReportOpen(false)}
      wide={true}
    >
      <HealthReportContent
        device={device}
        state={state}
      />
      <div className="modal-actions">
        <button
          className="hg-button"
          onClick={exportReport}
        >
          <ArrowDownToLine size={14} />
          {collected ? '导出采集报告' : '导出演示报告'}
        </button>
        <button
          className="hg-button primary"
          onClick={() => setReportOpen(false)}
        >
          {"完成"}
        </button>
      </div>
    </Modal>}
    {performanceOpen && <Modal
      title="性能监视"
      subtitle={collected ? '当前值来自本地采集；暂无历史采样' : '历史曲线为示意，当前值来自最新 Demo 快照'}
      onClose={() => setPerformanceOpen(false)}
      wide={true}
    >
      <HealthPerformance
        device={device}
        state={state}
        onInvestigate={item => {
          setPerformanceOpen(false);
          openInspection(item);
        }}
      />
    </Modal>}
  </div>;
}
