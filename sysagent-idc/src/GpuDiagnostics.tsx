import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Activity, ArrowRight, Bell, Check, ChevronRight, CircleDot, Clock3, Cpu, Download, FileSearch, Gauge, Layers, LoaderCircle, Network, Play, RefreshCw, Search, Settings2, ShieldCheck, Sparkles, TriangleAlert, type LucideIcon } from "lucide-react";
import type { HealthState } from "./health-data";
import { localTime } from "../agent-diagnostics";
import { problemNavigation, gpuEvents, profilingScenarios, buildGpuReportHtml, gpuDeviceMetrics, gpuDiagnosticStatusLabel, gpuDiagnosticOutcomeLabel, gpuOverviewExplanation, gpuMetric, gpuExecutionStatusLabel, gpuJobCapability, gpuJobProcessKey, gpuJobProcessMetrics, gpuNvmlCoverage, type GpuTab, type GpuEventId, type GpuEvent, type ProfilingScenarioId, type ProfilingScenario } from "./gpu-diagnostics-data";
interface DiagnosticTab {
  id: GpuTab;
  label: string;
  description: string;
}
interface EvidenceProps {
  title: string;
  items: string[];
  tone: "support" | "counter" | "gap";
}
interface EventReportProps {
  event: GpuEvent;
}
interface ProfilingResultProps {
  scenario: ProfilingScenario;
}
export interface GpuDiagnosticsProps {
  healthState: HealthState;
  onRefresh: () => Promise<void>;
  onDiagnose: () => Promise<void>;
  busy?: boolean;
  error?: string;
  overview?: ReactNode;
  onNotify: (message: string) => void;
}
const diagnosticTabs: DiagnosticTab[] = [{
  id: "overview",
  label: "GPU 概览",
  description: "本机当前资源快照"
}, {
  id: "inspection",
  label: "GPU 诊断",
  description: "硬件状态与异常检查"
}, {
  id: "events",
  label: "异常事件分析",
  description: "独立演示 · 报错与 HANG"
}, {
  id: "profiling",
  label: "作业 Profiling",
  description: "独立演示 · 性能时间线"
}];
const eventIcons: Record<GpuEventId, LucideIcon> = {
  "vram-oob": TriangleAlert,
  hang: Clock3,
  oom: Layers,
  "gpu-comm": Network
};
function escapeHtml(value: unknown) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("\"", "&quot;").replaceAll("'", "&#039;");
}
function htmlList(items: string[]) {
  return `<ul>${items.map(item => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
}
function downloadHtml(filename: string, title: string, body: string) {
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>body{font:14px/1.7 system-ui,sans-serif;color:#24364d;max-width:980px;margin:40px auto;padding:0 24px}h1{font-size:26px}h2{margin-top:28px;font-size:18px;border-bottom:1px solid #dfe6ef;padding-bottom:8px}h3{font-size:15px}table{width:100%;border-collapse:collapse}th,td{padding:9px;border:1px solid #dfe6ef;text-align:left}.meta{color:#71839d}.notice{background:#f3f7ff;border:1px solid #d7e3fb;padding:12px;border-radius:8px}li{margin:5px 0}</style></head><body><h1>${escapeHtml(title)}</h1><p class="meta">SysAgent管家 · GPU 智能诊断 · 离线演示报告</p><p class="notice">本报告由模拟数据生成，不代表真实生产环境诊断结论。</p>${body}</body></html>`;
  const url = URL.createObjectURL(new Blob([html], {
    type: "text/html;charset=utf-8"
  }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}
function Evidence({
  title,
  items,
  tone
}: EvidenceProps) {
  return <div className={`gd-evidence ${tone}`}>
    <strong>
      {title}
    </strong>
    <ul>
      {items.map(item => <li key={item}>
        {item}
      </li>)}
    </ul>
  </div>;
}
function EventReport({
  event
}: EventReportProps) {
  return <div className="gd-report" aria-live="polite">
    <div className="gd-report-head">
      <span>
        <Sparkles size={18} />
      </span>
      <div>
        <small>
          AGENT 诊断结论
        </small>
        <h3>
          {event.conclusion}
        </h3>
      </div>
      <em className={event.confidence === "高" ? "high" : "medium"}>
        {"置信度 "}
        {event.confidence}
      </em>
    </div>
    <div className="gd-fact-grid">
      {event.facts.map(fact => <div key={fact}>
        <Check size={14} />
        <span>
          {fact}
        </span>
      </div>)}
    </div>
    <div className="gd-report-grid">
      <section>
        <h4>
          故障时间线
        </h4>
        <div className="gd-event-timeline">
          {event.timeline.map(entry => <div key={`${entry.time}-${entry.text}`}>
            <time>
              {entry.time}
            </time>
            <i />
            <span>
              {entry.text}
            </span>
          </div>)}
        </div>
      </section>
      <section>
        <h4>
          关键调用链
        </h4>
        <ol className="gd-call-stack">
          {event.callStack.map(frame => <li key={frame}>
            {frame}
          </li>)}
        </ol>
      </section>
    </div>
    <div className="gd-evidence-grid">
      <Evidence title="支持结论" items={event.support} tone="support" />
      <Evidence title="反例核对" items={event.counter} tone="counter" />
      <Evidence title="证据缺口" items={event.gap} tone="gap" />
    </div>
    <div className="gd-actions">
      <h4>
        建议的下一步
      </h4>
      {event.actions.map((action, index) => <div key={action}>
        <span>
          {index + 1}
        </span>
        <p>
          {action}
        </p>
      </div>)}
    </div>
  </div>;
}
function ProfilingResult({
  scenario
}: ProfilingResultProps) {
  const legend = [["python", "Python"], ["data", "数据加载"], ["h2d", "H2D"], ["compute", "GPU 计算"], ["comm", "通信"], ["wait", "等待"], ["memory", "显存对象"]];
  return <div className="gd-profile-result" aria-live="polite">
    <div className="gd-metric-strip">
      {scenario.metrics.map(metric => <div key={metric.label} className={metric.tone || ""}>
        <span>
          {metric.label}
        </span>
        <strong>
          {metric.value}
        </strong>
      </div>)}
    </div>
    <section className="panel gd-timeline-panel">
      <div className="gd-section-title">
        <div>
          <span className="gd-section-icon blue">
            <Activity size={18} />
          </span>
          <div>
            <h3>
              CPU / GPU Timeline
            </h3>
            <p>
              对齐 Python 调用、GPU Kernel、通信和等待区间
            </p>
          </div>
        </div>
        <span>
          模拟采样 · 240 steps
        </span>
      </div>
      <div className="gd-timeline-ruler">
        <span>
          0 ms
        </span>
        <span>
          450 ms
        </span>
        <span>
          900 ms
        </span>
        <span>
          1,350 ms
        </span>
        <span>
          1,820 ms
        </span>
      </div>
      <div className="gd-profile-lanes">
        {scenario.lanes.map(lane => <div key={lane.label} className="gd-profile-lane">
          <strong>
            {lane.label}
          </strong>
          <div>
            {lane.segments.map(segment => <span key={`${lane.label}-${segment.label}`} className={segment.kind} style={{
              left: `${segment.left}%`,
              width: `${segment.width}%`
            }} title={segment.label}>
              {segment.label}
            </span>)}
          </div>
        </div>)}
      </div>
      <div className="gd-timeline-legend">
        {legend.map(([kind, label]) => <span key={kind}>
          <i className={kind} />
          {label}
        </span>)}
      </div>
    </section>
    <div className="gd-profile-grid">
      <section className="panel gd-hotspots">
        <div className="gd-section-title compact">
          <div>
            <span className="gd-section-icon violet">
              <Gauge size={18} />
            </span>
            <div>
              <h3>
                耗时与调用热点
              </h3>
              <p>
                按聚合耗时排序
              </p>
            </div>
          </div>
        </div>
        <div className="gd-table-wrap">
          <table>
            <thead>
              <tr>
                <th>
                  调用
                </th>
                <th>
                  类型
                </th>
                <th>
                  次数
                </th>
                <th>
                  总耗时
                </th>
                <th>
                  占比
                </th>
              </tr>
            </thead>
            <tbody>
              {scenario.hotspots.map(hotspot => <tr key={hotspot.name}>
                <td>
                  {hotspot.name}
                </td>
                <td>
                  {hotspot.type}
                </td>
                <td>
                  {hotspot.calls}
                </td>
                <td>
                  {hotspot.total}
                </td>
                <td>
                  <strong>
                    {hotspot.share}
                  </strong>
                </td>
              </tr>)}
            </tbody>
          </table>
        </div>
      </section>
      <section className="panel gd-call-path-panel">
        <div className="gd-section-title compact">
          <div>
            <span className="gd-section-icon amber">
              <FileSearch size={18} />
            </span>
            <div>
              <h3>
                关键调用路径
              </h3>
              <p>
                从业务入口回溯热点
              </p>
            </div>
          </div>
        </div>
        <ol className="gd-call-stack">
          {scenario.callPath.map(frame => <li key={frame}>
            {frame}
          </li>)}
        </ol>
      </section>
    </div>
    <section className="panel gd-profile-finding">
      <div className="gd-finding-head">
        <span>
          <Sparkles size={19} />
        </span>
        <div>
          <small>
            AGENT 性能解释
          </small>
          <h3>
            {scenario.finding}
          </h3>
        </div>
      </div>
      <div className="gd-evidence-grid">
        <Evidence title="支持证据" items={scenario.support} tone="support" />
        <Evidence title="反例核对" items={scenario.counter} tone="counter" />
        <Evidence title="适用边界" items={[scenario.uncertainty]} tone="gap" />
      </div>
      <div className="gd-actions">
        <h4>
          优化建议与验证方式
        </h4>
        {scenario.suggestions.map((suggestion, index) => <div key={suggestion}>
          <span>
            {index + 1}
          </span>
          <p>
            {suggestion}
          </p>
        </div>)}
      </div>
    </section>
  </div>;
}
export function GpuDiagnostics({
  healthState,
  onRefresh,
  onDiagnose,
  busy = false,
  error = '',
  overview,
  onNotify
}: GpuDiagnosticsProps) {
  const [activeTab, setActiveTab] = useState<GpuTab>("overview");
  const [selectedEventId, setSelectedEventId] = useState<GpuEventId>("vram-oob");
  const [eventStage, setEventStage] = useState(-1);
  const [eventComplete, setEventComplete] = useState(false);
  const [eventRunning, setEventRunning] = useState(false);
  const [eventPolicies, setEventPolicies] = useState<Record<GpuEventId, boolean>>({
    "vram-oob": true,
    hang: true,
    oom: true,
    "gpu-comm": true
  });
  const [notificationChannel, setNotificationChannel] = useState("控制台 + 企业微信");
  const [selectedScenarioId, setSelectedScenarioId] = useState<ProfilingScenarioId>("train-throughput");
  const [profilingStage, setProfilingStage] = useState(-1);
  const [profilingComplete, setProfilingComplete] = useState(false);
  const [profilingRunning, setProfilingRunning] = useState(false);
  const [instance, setInstance] = useState("gpu-node-03");
  const [region, setRegion] = useState("IDC · 北京-A");
  const [pid, setPid] = useState("28416");
  const [collectionRange, setCollectionRange] = useState("15 分钟");
  const [pidError, setPidError] = useState("");
  const [findingSearch, setFindingSearch] = useState('');
  const [findingFilter, setFindingFilter] = useState('all');
  const [selectedJobKey, setSelectedJobKey] = useState<string | null>(null);
  const [jobSearch, setJobSearch] = useState('');
  const [jobFindingSearch, setJobFindingSearch] = useState('');
  const [pendingAction, setPendingAction] = useState<'refresh' | 'diagnose' | null>(null);
  const [actionError, setActionError] = useState('');
  const realActionLock = useRef(false);
  const collected = healthState.mode === 'collected';
  const gpuResource = healthState.resources.gpu;
  const diagnostic = collected ? healthState.gpuDiagnostic : undefined;
  const gpuDevices = collected ? gpuResource.gpuDevices || [] : [];
  const jobAnalysis = diagnostic?.jobAnalysis;
  const jobProcesses = jobAnalysis?.processes || [];
  const selectedJob = selectedJobKey === null ? jobProcesses[0] : jobProcesses.find(process => gpuJobProcessKey(process) === selectedJobKey);
  const visibleJobProcesses = jobProcesses.filter(process => `${process.pid} ${process.starttime ?? ''} ${process.name}`.toLowerCase().includes(jobSearch.trim().toLowerCase()));
  const selectedJobFindings = selectedJob?.findings.filter(finding => `${finding.check} ${finding.message} ${finding.suggestion || ''}`.toLowerCase().includes(jobFindingSearch.trim().toLowerCase())) || [];
  const realBusy = busy || pendingAction !== null;
  const displayError = actionError || error;
  const filteredFindings = diagnostic?.findings.filter(finding =>
    (findingFilter === 'all' || finding.severity === findingFilter) &&
    `${finding.check} ${finding.message} ${finding.suggestion || ''}`.toLowerCase().includes(findingSearch.toLowerCase())
  ) || [];

  async function runRealAction(action: 'refresh' | 'diagnose') {
    if (realActionLock.current || busy) return;
    realActionLock.current = true;
    setPendingAction(action);
    setActionError('');
    try {
      if (action === 'diagnose') await onDiagnose();
      else await onRefresh();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : '本机 GPU 请求失败');
    } finally {
      realActionLock.current = false;
      setPendingAction(null);
    }
  }

  function exportGpuReport() {
    const url = URL.createObjectURL(new Blob([buildGpuReportHtml(healthState)], { type: 'text/html;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'sysagent-gpu-collected-report.html';
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    onNotify('本机 GPU 报告已导出，包含来源、覆盖范围和不可用说明。');
  }
  const eventRunId = useRef(0);
  const profilingRunId = useRef(0);
  const selectedEvent = gpuEvents.find(event => event.id === selectedEventId)!;
  const selectedScenario = profilingScenarios.find(scenario => scenario.id === selectedScenarioId)!;
  const profilingStages = ["提交采集任务", "采集 Python 调用栈与 CPU/GPU Timeline", "采集 Kernel、显存与通信活动", "计算引擎聚合耗时与次数", "Agent 解释结果并核对反例"];
  useEffect(() => () => {
    eventRunId.current += 1;
    profilingRunId.current += 1;
  }, []);
  function wait(milliseconds: number): Promise<void> {
    return new Promise<void>(resolve => window.setTimeout(resolve, milliseconds));
  }
  function changeTab(tab: GpuTab) {
    setActiveTab(tab);
    window.requestAnimationFrame(() => {
      document.querySelector(".main-content")?.scrollTo({
        top: 0,
        left: 0,
        behavior: "smooth"
      });
    });
  }
  function selectEvent(eventId: GpuEventId) {
    eventRunId.current += 1;
    setSelectedEventId(eventId);
    setEventStage(-1);
    setEventComplete(false);
    setEventRunning(false);
  }
  async function analyzeEvent() {
    const runId = ++eventRunId.current;
    setEventRunning(true);
    setEventComplete(false);
    setEventStage(0);
    for (let stageIndex = 0; stageIndex < selectedEvent.steps.length; stageIndex += 1) {
      await wait(420);
      if (runId !== eventRunId.current) return;
      setEventStage(stageIndex + 1);
    }
    setEventRunning(false);
    setEventComplete(true);
    onNotify(`${selectedEvent.title}：模拟自主分析完成，已生成证据链报告。`);
  }
  function exportEventReport() {
    const timelineRows = selectedEvent.timeline.map(entry => `<tr><td>${escapeHtml(entry.time)}</td><td>${escapeHtml(entry.text)}</td></tr>`).join("");
    downloadHtml(`GPU异常分析-${selectedEvent.id}.html`, `GPU 异常分析：${selectedEvent.title}`, `<h2>对象</h2><p>${escapeHtml(selectedEvent.job)} · ${escapeHtml(selectedEvent.scope)}</p><h2>诊断结论</h2><p>${escapeHtml(selectedEvent.conclusion)}</p><p>置信度：${selectedEvent.confidence}</p><h2>关键事实</h2>${htmlList(selectedEvent.facts)}<h2>时间线</h2><table><tr><th>时间</th><th>事件</th></tr>${timelineRows}</table><h2>调用链</h2>${htmlList(selectedEvent.callStack)}<h2>支持证据</h2>${htmlList(selectedEvent.support)}<h2>反例与缺口</h2>${htmlList([...selectedEvent.counter, ...selectedEvent.gap])}<h2>建议</h2>${htmlList(selectedEvent.actions)}`);
    onNotify("异常分析 HTML 报告已导出。");
  }
  function saveAlertPolicy() {
    onNotify(`告警策略已保存：通过${notificationChannel}发送模拟分析结果。`);
  }
  function selectScenario(scenarioId: ProfilingScenarioId) {
    profilingRunId.current += 1;
    setSelectedScenarioId(scenarioId);
    setProfilingStage(-1);
    setProfilingComplete(false);
    setProfilingRunning(false);
    setPidError("");
  }
  async function collectProfiling(submitEvent: FormEvent<HTMLFormElement>) {
    submitEvent.preventDefault();
    if (!/^\d+$/.test(pid) || Number(pid) < 1) {
      setPidError("请输入有效的正整数 PID。");
      return;
    }
    setPidError("");
    const runId = ++profilingRunId.current;
    setProfilingRunning(true);
    setProfilingComplete(false);
    setProfilingStage(0);
    for (let stageIndex = 0; stageIndex < profilingStages.length; stageIndex += 1) {
      await wait(430);
      if (runId !== profilingRunId.current) return;
      setProfilingStage(stageIndex + 1);
    }
    setProfilingRunning(false);
    setProfilingComplete(true);
    onNotify(`${selectedScenario.title}：模拟 Profiling 完成。`);
  }
  function exportProfilingReport() {
    const hotspotRows = selectedScenario.hotspots.map(hotspot => `<tr><td>${escapeHtml(hotspot.name)}</td><td>${escapeHtml(hotspot.type)}</td><td>${escapeHtml(hotspot.calls)}</td><td>${escapeHtml(hotspot.total)}</td><td>${escapeHtml(hotspot.share)}</td></tr>`).join("");
    downloadHtml(`GPU-Profiling-${selectedScenario.id}.html`, `作业 Profiling：${selectedScenario.title}`, `<h2>采集对象</h2><p>${escapeHtml(instance)} · ${escapeHtml(region)} · PID ${escapeHtml(pid)} · ${escapeHtml(collectionRange)}</p><h2>性能解释</h2><p>${escapeHtml(selectedScenario.finding)}</p><h2>热点</h2><table><tr><th>调用</th><th>类型</th><th>次数</th><th>总耗时</th><th>占比</th></tr>${hotspotRows}</table><h2>关键调用路径</h2>${htmlList(selectedScenario.callPath)}<h2>支持证据</h2>${htmlList(selectedScenario.support)}<h2>反例与适用边界</h2>${htmlList([...selectedScenario.counter, selectedScenario.uncertainty])}<h2>优化建议</h2>${htmlList(selectedScenario.suggestions)}`);
    onNotify("Profiling HTML 报告已导出。");
  }
  return <div className="gpu-diagnostics">
    <section className="panel gd-header">
      <div className="gd-header-copy">
        <span className="gd-header-icon">
          <Sparkles size={23} />
        </span>
        <div>
          <span className="eyebrow">
            GPU INTELLIGENCE
          </span>
          <h2>
            GPU 智能诊断
          </h2>
          <p>
            GPU 诊断与作业进程分析来自本机 sysak ai 按需采集，经本地 OpenAPI mock 解析实际数据；事件演示独立，离线 Profiling 也为独立演示。
          </p>
        </div>
        <span className="subtle-tag">
          {collected ? '本机 · IDC / sysak ai → OpenAPI mock' : 'Demo / 离线 · 本机测量不可用'}
        </span>
      </div>
      <div className="gd-tabs" role="tablist" aria-label="GPU 诊断工作区">
        {diagnosticTabs.map(tab => <button key={tab.id} role="tab" aria-selected={activeTab === tab.id} className={activeTab === tab.id ? "active" : ""} onClick={() => changeTab(tab.id)}>
          <strong>
            {tab.id === 'profiling' && collected ? '作业级深度剖析' : tab.label}
          </strong>
          <span>
            {tab.id === 'profiling' && collected ? '本机 AI · 进程资源与异常证据' : tab.description}
          </span>
        </button>)}
      </div>
    </section>
    <div className="gd-workspace">
      {displayError && (activeTab === 'overview' || activeTab === 'inspection' || collected && activeTab === 'profiling') && <div className="gd-real-notice error" role="alert"><TriangleAlert size={17} /><span>{displayError} · 当前展示的是上次已取得的快照，不代表本次请求成功。</span></div>}
      {(activeTab === 'events' || activeTab === 'profiling' && !collected) && <div className="gd-real-notice demo" role="note"><FileSearch size={17} />独立演示：使用内置样例，不读取所选设备、日志或 PID；不执行真实分析、告警配置或 Profiling，也不代表本机诊断结论。</div>}
      {activeTab === "overview" && <>
        <section className="panel gd-real-panel">
          <div className="gd-section-title">
            <div><span className="gd-section-icon blue"><Cpu size={18} /></span><div><h3>本机 GPU 资源</h3><p>当前按需快照 · 资源采集时间：{collected ? localTime(gpuResource.sampledAt || healthState.sampledAt || null) : '不可用'}</p></div></div>
            <button className="button secondary" disabled={realBusy} onClick={() => runRealAction('refresh')}>
              {pendingAction === 'refresh' ? <LoaderCircle size={15} className="spinning" /> : <RefreshCw size={15} />}
              {pendingAction === 'refresh' ? '刷新中…' : '刷新本机 GPU 资源'}
            </button>
          </div>
          <div className="gd-real-notice"><TriangleAlert size={17} /><span>{gpuOverviewExplanation(healthState)}</span></div>
          <div className="gd-metric-strip gd-real-summary">
            <div><span>已取得逐卡记录</span><strong>{collected && gpuResource.gpuDevices !== undefined ? `${gpuDevices.length} 张` : 'N/A · 不可用'}</strong></div>
            <div><span>当前 GPU 利用率</span><strong>{gpuMetric(collected ? gpuResource.usage : null, '%')}</strong></div>
            <div><span>资源覆盖</span><strong>{collected ? gpuResource.status === 'available' ? '可用' : gpuResource.status === 'partial' ? '部分测量' : '不可用 / 未知' : '未采集'}</strong></div>
            <div><span>诊断执行状态</span><strong>{gpuDiagnosticStatusLabel(diagnostic)}</strong></div>
          </div>
          <div className="gd-real-device-grid">
            {gpuDevices.map(device => <article className="gd-real-device" key={`${device.index}-${device.uuid}`}>
              <h3>GPU {device.index} · {device.name || '名称不可用'}</h3>
              <p>UUID：{device.uuid || 'N/A · 不可用'}</p><p>PCI Bus ID：{device.busId || 'N/A · 不可用'}</p>
              <dl>{gpuDeviceMetrics(device).map(metric => <div key={metric.label}><dt>{metric.label}</dt><dd>{metric.value}</dd></div>)}</dl>
            </article>)}
          </div>
          {!gpuDevices.length && <p className="gd-real-empty">没有可用的逐卡指标。请刷新本机资源或切换到 GPU 诊断查看检查结果；不会补造设备与测量。</p>}
          <div className="gd-export-row"><span>资源快照不是硬件健康结论；不展示模拟历史曲线。</span><button className="button primary" onClick={() => changeTab('inspection')}>查看 GPU 诊断<ChevronRight size={14} /></button></div>
        </section>
        {overview}
        <section className="panel gd-question-panel">
          <div className="gd-section-title">
            <div>
              <span className="gd-section-icon blue">
                <FileSearch size={18} />
              </span>
              <div>
                <span className="eyebrow">
                  QUESTION NAVIGATOR
                </span>
                <h3>
                  从客户问题进入诊断
                </h3>
                <p>
                  先明确证据，再选择进一步分析方向。
                </p>
              </div>
            </div>
          </div>
          <div className="gd-table-wrap gd-question-table">
            <table>
              <thead>
                <tr>
                  <th>
                    客户提出的问题
                  </th>
                  <th>
                    Agent 使用的主要证据
                  </th>
                  <th>
                    进一步分析的方向
                  </th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {problemNavigation.map(item => <tr key={item.question}>
                  <td>
                    <strong>
                      {item.question}
                    </strong>
                  </td>
                  <td>
                    {item.evidence}
                  </td>
                  <td>
                    {item.direction}
                  </td>
                  <td>
                    <button className="gd-row-action" onClick={() => changeTab(item.tab)}>
                      {item.tab === 'inspection' || item.tab === 'profiling' && collected ? '查看本机诊断' : '查看独立演示'}
                      <ChevronRight size={14} />
                    </button>
                  </td>
                </tr>)}
              </tbody>
            </table>
          </div>
        </section>
      </>}
      {activeTab === "events" && <div className="gd-events-layout">
        <aside>
          <div className="gd-side-heading">
            <span>
              典型异常场景
            </span>
            <small>
              示例事件
            </small>
          </div>
          <div className="gd-event-list">
            {gpuEvents.map(event => {
              const EventIcon = eventIcons[event.id];
              return <button key={event.id} className={event.id === selectedEvent.id ? "active" : ""} onClick={() => selectEvent(event.id)}>
              <span>
                <EventIcon size={17} />
              </span>
              <div>
                <strong>
                  {event.title}
                </strong>
                <small>
                  {event.description}
                </small>
              </div>
              <em className={event.severity === "严重" ? "critical" : ""}>
                {event.severity}
              </em>
            </button>;
            })}
          </div>
          <section className="panel gd-alert-config">
            <div>
              <Bell size={17} />
              <strong>
                事件驱动策略
              </strong>
            </div>
            {gpuEvents.map(event => <label key={event.id}>
              <input type="checkbox" checked={eventPolicies[event.id]} onChange={inputEvent => setEventPolicies(policies => ({
                ...policies,
                [event.id]: inputEvent.target.checked
              }))} />
              <span>
                {event.title}
              </span>
            </label>)}
            <label className="gd-config-select">
              通知渠道
              <select value={notificationChannel} onChange={inputEvent => setNotificationChannel(inputEvent.target.value)}>
                <option>
                  控制台 + 企业微信
                </option>
                <option>
                  仅控制台
                </option>
                <option>
                  控制台 + Webhook
                </option>
              </select>
            </label>
            <button className="button secondary full" onClick={saveAlertPolicy}>
              <Settings2 size={14} />
              保存演示告警策略
            </button>
          </section>
        </aside>
        <main>
          <section className="panel gd-event-case">
            <div className="gd-case-head">
              <div>
                <span className={`gd-severity ${selectedEvent.severity === "严重" ? "critical" : ""}`}>
                  {selectedEvent.severity}
                  事件
                </span>
                <h2>
                  {selectedEvent.title}
                </h2>
                <p>
                  {selectedEvent.description}
                </p>
              </div>
              <button className="button primary" disabled={eventRunning} onClick={() => {
                analyzeEvent();
              }}>
                {eventRunning ? <LoaderCircle size={15} className="spinning" /> : <Play size={15} />}
                {eventRunning ? "演示分析中" : eventComplete ? "重新演示分析" : "运行演示分析"}
              </button>
            </div>
            <div className="gd-case-meta">
              <div>
                <span>
                  任务
                </span>
                <strong>
                  {selectedEvent.job}
                </strong>
              </div>
              <div>
                <span>
                  影响范围
                </span>
                <strong>
                  {selectedEvent.scope}
                </strong>
              </div>
              <div>
                <span>
                  触发信号
                </span>
                <strong>
                  {selectedEvent.trigger}
                </strong>
              </div>
            </div>
            <div className="gd-analysis-flow">
              {selectedEvent.steps.map((step, index) => {
                const complete = eventStage > index;
                const current = eventRunning && eventStage === index;
                return <div key={step} className={complete ? "complete" : current ? "current" : ""}>
                <span>
                  {complete ? <Check size={14} /> : current ? <LoaderCircle size={14} className="spinning" /> : index + 1}
                </span>
                <p>
                  {step}
                </p>
                {index < selectedEvent.steps.length - 1 && <ArrowRight size={13} />}
              </div>;
              })}
            </div>
          </section>
          {eventComplete ? <>
            <EventReport event={selectedEvent} />
            <div className="gd-export-row">
              <span>
                报告包含模拟数据、支持证据、反例与证据缺口。
              </span>
              <button className="button secondary" onClick={exportEventReport}>
                <Download size={15} />
                导出 HTML 报告
              </button>
            </div>
          </> : <section className="panel gd-empty-result">
            <span>
              <FileSearch size={28} />
            </span>
            <h3>
              等待分析异常事件
            </h3>
            <p>
              Agent 将关联 GPU、容器、通信和调用栈证据，不会仅凭单条告警下结论。
            </p>
          </section>}
        </main>
      </div>}
      {activeTab === 'profiling' && collected && <section className="panel gd-real-panel gd-job-panel" aria-busy={realBusy}>
        <div className="gd-section-title">
          <div><span className="gd-section-icon violet"><Activity size={18} /></span><div><span className="eyebrow">SYSAK AI · JOB EVIDENCE</span><h3>作业级深度剖析</h3><p>本机 sysak ai 原生证据 · 指标窗口未提供；--threshold 1s 是诊断阈值，不是统一采样窗口。</p></div></div>
          <button className="button primary" disabled={realBusy} onClick={() => runRealAction('diagnose')}>
            {pendingAction === 'diagnose' ? <LoaderCircle size={15} className="spinning" /> : <Play size={15} />}
            {pendingAction === 'diagnose' ? '本机 AI 采集中…' : jobAnalysis ? '重新采集本机作业证据' : '采集本机作业证据'}
          </button>
        </div>
        <div className="gd-real-notice" role="note"><TriangleAlert size={17} /><span>{gpuJobCapability}。只可选择已采集 PID 查看证据；重新采集始终扫描本机，不执行输入 PID，不指定远程实例。</span></div>
        {pendingAction === 'diagnose' && <div className="gd-real-notice" role="status"><LoaderCircle size={17} className="spinning" /><span>正在运行 sysak ai 并等待 OpenAPI 结果。保留上次作业证据，本次请求完成前不更新结论。</span></div>}
        <div className="gd-real-result" aria-live="polite">
          <span className="gd-real-status">{gpuExecutionStatusLabel(jobAnalysis?.status)}</span>
          <h3>{diagnostic?.outcome === 'no_gpu' ? '未检测到 GPU' : jobAnalysis?.complete && jobAnalysis.status === 'ok' ? '本次返回覆盖标记为完成' : '作业分析受限 / 不可用，不代表正常'}</h3>
          <p>{jobAnalysis?.reason || '尚无作业分析结果；原生 ai 强依赖 GX，缺少 GX 则 ai 不可用；独立资源快照不代表 ai 已取得证据。'}</p>
          <p>本机 AI 执行：{gpuDiagnosticStatusLabel(diagnostic)} · {diagnostic?.summary || '尚未取得 AI 诊断结果。'}</p>
          <dl className="gd-real-meta">
            <div><dt>来源</dt><dd>{jobAnalysis?.source || 'sysak ai（尚无作业采集结果）'}</dd></div>
            <div><dt>采集时间</dt><dd>{localTime(jobAnalysis?.sampledAt ?? null) || 'N/A · 不可用'}</dd></div>
            <div><dt>指标采样窗口</dt><dd>{gpuMetric(jobAnalysis?.sampleWindowSeconds, ' s')}</dd></div>
            <div><dt>本机已采集进程</dt><dd>{jobAnalysis ? `${jobProcesses.length} 个` : 'N/A · 未取得列表'}</dd></div>
            <div><dt>NVML 资源指标覆盖 / 采集时间</dt><dd>{gpuNvmlCoverage(healthState)} · {localTime(gpuResource.sampledAt || healthState.sampledAt || null) || 'N/A · 不可用'}</dd></div>
            <div><dt>GX 分析执行状态 / 覆盖</dt><dd>{gpuExecutionStatusLabel(jobAnalysis?.status)} · {jobAnalysis?.complete ? '返回覆盖标记为完成' : '未完成 / 分析不可用，不代表正常'}</dd></div>
          </dl>
        </div>
        {gpuDevices.length > 0 && <details className="gd-job-nvml"><summary>查看已取得的 NVML 逐卡资源指标（不是进程利用率）</summary><div className="gd-real-device-grid">{gpuDevices.map(device => <article className="gd-real-device" key={`${device.index}-${device.uuid}`}><h3>GPU {device.index} · {device.name || 'N/A · 不可用'}</h3><dl>{gpuDeviceMetrics(device).map(metric => <div key={metric.label}><dt>{metric.label}</dt><dd>{metric.value}</dd></div>)}</dl></article>)}</div></details>}
        <div className="gd-section-title">
          <div><h3>已采集作业进程</h3><p>保留原始 PID；原生 ai 不提供 starttime 和 name，不能确认跨快照进程身份，不将 cmd 当作 comm。选择仅查看本次证据。</p></div>
          <div className="gd-task-tools"><label><Search size={14} /><input aria-label="搜索已采集作业进程" placeholder="搜索已采集 PID" value={jobSearch} onChange={event => setJobSearch(event.target.value)} /></label>{jobSearch && <button className="button secondary" onClick={() => setJobSearch('')}>清除进程搜索</button>}</div>
        </div>
        <div className="gd-job-layout">
          <div className="gd-job-list" role="group" aria-label="选择已采集作业进程">
            {visibleJobProcesses.map(process => <button key={gpuJobProcessKey(process)} className={selectedJob && gpuJobProcessKey(selectedJob) === gpuJobProcessKey(process) ? 'active' : ''} aria-pressed={selectedJob && gpuJobProcessKey(selectedJob) === gpuJobProcessKey(process) || false} onClick={() => { setSelectedJobKey(gpuJobProcessKey(process)); setJobFindingSearch(''); }}><strong>PID {process.pid} · name：{process.name || 'N/A · 不可用'}</strong><span>starttime：{gpuMetric(process.starttime)}</span><small>{gpuExecutionStatusLabel(process.status)}</small></button>)}
            {!visibleJobProcesses.length && <p className="gd-real-empty">{jobProcesses.length ? '没有匹配的进程，请清除或调整搜索。' : '没有已采集的作业进程；可能无 GPU、无可见进程或分析不可用，请查看执行状态和原因。不会补造 PID。'}</p>}
          </div>
          <div className="gd-real-device gd-job-detail" aria-live="polite">
            {selectedJob ? <>
              <h3>PID {selectedJob.pid} · name：{selectedJob.name || 'N/A · 不可用'}</h3><p>starttime：{gpuMetric(selectedJob.starttime)} · 进程分析执行状态：{gpuExecutionStatusLabel(selectedJob.status)}</p>
              <dl>{gpuJobProcessMetrics(selectedJob).map(metric => <div key={metric.label}><dt>{metric.label}</dt><dd>{metric.value}</dd></div>)}</dl>
              <div className="gd-section-title"><div><h3>进程实际 HANG / NCCL / Xid 及其他证据</h3></div><div className="gd-task-tools"><label><Search size={14} /><input aria-label="搜索作业进程证据" placeholder="搜索实际检查项或证据" value={jobFindingSearch} onChange={event => setJobFindingSearch(event.target.value)} /></label></div></div>
              <div className="gd-table-wrap gd-real-findings"><table><thead><tr><th>检查项</th><th>级别</th><th>观测 / 证据</th><th>建议</th></tr></thead><tbody>
                {selectedJobFindings.map((finding, index) => <tr key={`${finding.check}-${index}`}><td>{finding.check}</td><td><span className={`gd-real-status ${finding.severity.toLowerCase()}`}>{finding.severity}</span></td><td>{finding.message}</td><td>{finding.suggestion || '未提供'}</td></tr>)}
                {!selectedJobFindings.length && <tr><td colSpan={4}>{selectedJob.findings.length ? '没有匹配的进程证据，请调整搜索。' : '尚无进程诊断证据；缺少 GX、未完成或缺测不代表正常。'}</td></tr>}
              </tbody></table></div>
            </> : <p className="gd-real-empty">{selectedJobKey !== null ? '上次选择的 PID + starttime 已不在本次列表，请重新选择已采集进程。' : '暂无可查看的进程证据。'}</p>}
          </div>
        </div>
        <div className="gd-section-title"><div><h3>本机 NVML / GX 检查及 HANG / NCCL / Xid 证据</h3><p>保留 AI 返回的实际检查项；逐卡指标不复制为进程利用率。</p></div></div>
        <div className="gd-table-wrap gd-real-findings"><table><thead><tr><th>检查项</th><th>级别</th><th>观测 / 证据</th><th>建议</th></tr></thead><tbody>
          {diagnostic?.findings.map((finding, index) => <tr key={`${finding.check}-${index}`}><td>{finding.check}</td><td><span className={`gd-real-status ${finding.severity.toLowerCase()}`}>{finding.severity}</span></td><td>{finding.message}</td><td>{finding.suggestion || '未提供'}</td></tr>)}
          {!diagnostic?.findings.length && <tr><td colSpan={4}>尚无本机检查证据；不推断 GPU 或进程正常。</td></tr>}
        </tbody></table></div>
        <div className="gd-export-row"><span>导出来源、时间、范围、全部作业进程与证据，不受进程选择或搜索影响。</span><button className="button secondary" disabled={realBusy} onClick={exportGpuReport}><Download size={15} />导出本机作业诊断 HTML 报告</button></div>
      </section>}
      {activeTab === "profiling" && !collected && <>
        <section className="panel gd-profile-config">
          <div className="gd-section-title">
            <div>
              <span className="gd-section-icon violet">
                <Activity size={18} />
              </span>
              <div>
                <span className="eyebrow">
                  JOB PROFILING
                </span>
                <h3>
                  作业级深度剖析
                </h3>
                <p>
                  独立演示：内置性能窗口，不采集输入的实例或 PID，不执行真实 Profiling。
                </p>
              </div>
            </div>
          </div>
          <div className="gd-scenario-grid">
            {profilingScenarios.map(scenario => <button key={scenario.id} className={scenario.id === selectedScenario.id ? "active" : ""} onClick={() => selectScenario(scenario.id)}>
              <span>
                {scenario.id === selectedScenario.id ? <Check size={15} /> : <CircleDot size={15} />}
              </span>
              <strong>
                {scenario.title}
              </strong>
              <small>
                {scenario.description}
              </small>
            </button>)}
          </div>
          <form className="gd-profile-form" onSubmit={collectProfiling}>
            <label>
              实例
              <input value={instance} onChange={inputEvent => setInstance(inputEvent.target.value)} />
            </label>
            <label>
              区域
              <select value={region} onChange={inputEvent => setRegion(inputEvent.target.value)}>
                <option>
                  IDC · 北京-A
                </option>
                <option>
                  IDC · 北京-B
                </option>
                <option>
                  ECS · 华东-1
                </option>
              </select>
            </label>
            <label>
              目标 PID
              <input inputMode="numeric" value={pid} aria-invalid={!!pidError} onChange={inputEvent => setPid(inputEvent.target.value)} />
            </label>
            <label>
              采集范围
              <select value={collectionRange} onChange={inputEvent => setCollectionRange(inputEvent.target.value)}>
                <option>
                  5 分钟
                </option>
                <option>
                  15 分钟
                </option>
                <option>
                  30 分钟
                </option>
              </select>
            </label>
            <button className="button primary" disabled={profilingRunning}>
              {profilingRunning ? <LoaderCircle size={15} className="spinning" /> : <Play size={15} />}
              {profilingRunning ? "演示采样中" : profilingComplete ? "重新演示采样" : "开始演示 Profiling"}
            </button>
          </form>
          {pidError && <p className="gd-form-error" role="alert">
            {pidError}
          </p>}
          {profilingStage >= 0 && <div className="gd-profile-stages">
            {profilingStages.map((stage, index) => <div key={stage} className={profilingStage > index ? "complete" : profilingRunning && profilingStage === index ? "current" : ""}>
              <span>
                {profilingStage > index ? <Check size={13} /> : profilingRunning && profilingStage === index ? <LoaderCircle size={13} className="spinning" /> : index + 1}
              </span>
              <small>
                {stage}
              </small>
            </div>)}
          </div>}
        </section>
        {profilingComplete ? <>
          <ProfilingResult scenario={selectedScenario} />
          <div className="gd-export-row">
            <span>
              报告保留采集参数、性能证据、反例和建议验证方式。
            </span>
            <button className="button secondary" onClick={exportProfilingReport}>
              <Download size={15} />
              导出 Profiling 报告
            </button>
          </div>
        </> : <section className="panel gd-profile-features">
          {[["统一时间线", "对齐 Python、CPU、GPU Kernel、显存和通信活动"], ["作业级归因", "按作业、Rank、进程和调用路径聚合，而非只看节点"], ["证据与反例", "同时展示支持结论和不支持结论的观测，避免武断"], ["可验证建议", "每条优化建议都给出复测指标和适用边界"]].map(([featureTitle, featureDescription], featureIndex) => <div key={featureTitle}>
            <span>
              0
              {featureIndex + 1}
            </span>
            <strong>
              {featureTitle}
            </strong>
            <p>
              {featureDescription}
            </p>
          </div>)}
        </section>}
      </>}
      {activeTab === "inspection" && <section className="panel gd-real-panel" aria-busy={pendingAction === 'diagnose'}>
        <div className="gd-section-title">
          <div><span className="gd-section-icon blue"><ShieldCheck size={18} /></span><div><span className="eyebrow">SYSAK AI</span><h3>GPU 诊断</h3><p>本机原生 ai 异常证据 · 巡检时按需执行，资源刷新不运行诊断；原生工具可能写入诊断日志，不宣称只读或完整健康检查。</p></div></div>
          <button className="button primary" disabled={realBusy || !collected} onClick={() => runRealAction('diagnose')}>
            {pendingAction === 'diagnose' ? <LoaderCircle size={15} className="spinning" /> : <Play size={15} />}
            {pendingAction === 'diagnose' ? '运行中…' : diagnostic && diagnostic.status !== 'not_run' ? '重新检查 GPU' : '运行 GPU 检查'}
          </button>
        </div>
        {!collected && <div className="gd-real-notice"><TriangleAlert size={17} /><span>Demo / 离线模式不能执行真实 GPU 诊断。请通过本机采集通道运行；不会以模拟结果代替。</span></div>}
        {pendingAction === 'diagnose' && <div className="gd-real-notice" role="status"><LoaderCircle size={17} className="spinning" /><span>正在运行 sysak ai 并等待 OpenAPI 结果。以下为上次快照，本次运行完成前不更新结论。</span></div>}
        <div className="gd-real-result" aria-live="polite">
          <span className={`gd-real-status ${diagnostic?.outcome === 'abnormal' ? 'error' : ''}`}>{gpuDiagnosticStatusLabel(diagnostic)}</span>
          <h3>{gpuDiagnosticOutcomeLabel(diagnostic)}</h3>
          <p>{diagnostic?.summary || '尚未运行 GPU 检查，没有真实诊断结论。请点击检查按钮按需采集。'}</p>
          <dl className="gd-real-meta">
            <div><dt>来源</dt><dd>{diagnostic?.source || 'sysak ai（尚无采集结果）'}</dd></div>
            <div><dt>采集时间</dt><dd>{localTime(diagnostic?.sampledAt ?? null) || 'N/A · 不可用'}</dd></div>
            <div><dt>检查覆盖</dt><dd>{diagnostic ? diagnostic.complete ? '完整覆盖（本次工具检查范围）' : '部分覆盖 / 未完成，不代表正常' : '未检查'}</dd></div>
            <div><dt>GPU 数量</dt><dd>{gpuMetric(diagnostic?.gpuCount)}</dd></div>
            <div><dt>架构</dt><dd>{diagnostic?.architectures.join('、') || 'N/A · 不可用'}</dd></div>
            <div><dt>设备</dt><dd>{diagnostic?.devices.join('、') || 'N/A · 不可用'}</dd></div>
          </dl>
        </div>
        <div className="gd-section-title">
          <div><h3>真实检查项与证据</h3></div>
          <div className="gd-task-tools">
            <label><Search size={14} /><input aria-label="搜索 GPU 检查项" placeholder="搜索检查项、证据或建议" value={findingSearch} onChange={event => setFindingSearch(event.target.value)} /></label>
            <select aria-label="GPU 检查级别筛选" value={findingFilter} onChange={event => setFindingFilter(event.target.value)}><option value="all">全部级别</option><option value="OK">OK</option><option value="WARN">WARN</option><option value="ERROR">ERROR</option></select>
          </div>
        </div>
        <div className="gd-table-wrap gd-real-findings"><table><thead><tr><th>检查项</th><th>级别</th><th>观测 / 证据</th><th>建议</th></tr></thead><tbody>
          {filteredFindings.map((finding, index) => <tr key={`${finding.check}-${index}`}><td>{finding.check}</td><td><span className={`gd-real-status ${finding.severity.toLowerCase()}`}>{finding.severity}</span></td><td>{finding.message}</td><td>{finding.suggestion || '未提供'}</td></tr>)}
          {!filteredFindings.length && <tr><td colSpan={4}>{diagnostic?.findings.length ? '没有匹配的检查项，请调整筛选。' : '尚无可用检查项；未检查或缺失结果不代表正常。'}</td></tr>}
        </tbody></table></div>
        <div className="gd-export-row"><span>报告保留本次执行状态、来源、覆盖范围和全部检查项（不受筛选影响）。</span><button className="button secondary" disabled={realBusy || !collected} onClick={exportGpuReport}><Download size={15} />导出 GPU 诊断 HTML 报告</button></div>
      </section>}
    </div>
  </div>;
}
