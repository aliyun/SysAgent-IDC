import { useEffect, useRef, useState, type FormEvent } from "react";
import { Activity, ArrowDownToLine, ArrowRight, ArrowUpRight, Bell, Blocks, BookOpen, Check, ChevronDown, ChevronRight, Cloud, Cpu, Database, FileCode2, GitBranch, Info, LayoutDashboard, LoaderCircle, LockKeyhole, Maximize2, Menu, Minimize2, Minus, Network, Pause, Play, Plus, RefreshCw, Search, Server, Settings2, ShieldCheck, Sparkles, Terminal, Workflow, X, Zap } from "lucide-react";
import { deviceKindLabels, devices, navItems, pageInfo, logSamples, type Device, type DeviceKind, type PageId } from "./data";
import { Logo, MascotLogo, DeviceIcon, StatusPill, Meter, HealthRing, PanelHeading, EmptyState, Modal, TextLink, ReportItem, WorkspaceIcon } from "./components";
import { formatResourceQuantity, resourceUsages, summarizeHealth, buildHealthReport, type HealthState } from "./health-data";
import { optimizeHealth, runHealthInspection } from "./health-api";
import { fetchAgentDiagnostic, runGpuInspection } from "./idc-client";
import { buildGpuReportHtml } from "./gpu-diagnostics-data";
import { HealthGuardPage, HealthReportContent } from "./HealthGuardPage";
import { GpuDiagnostics } from "./GpuDiagnostics";
import { AgentDiagnostics, LiveAgentDiagnostics } from "./AgentDiagnostics";
type ModalId = "health-scan" | "health-report" | "device" | "add-device" | "privacy" | "capabilities" | "restart" | "deploy" | "help";
export interface AppProps {
  active?: boolean;
  onCollapse?: () => void;
  healthState: HealthState;
  snapshotLoading: boolean;
  snapshotError: string;
  onRefresh: (refresh?: boolean) => Promise<HealthState>;
  demoRunning: boolean;
  mutationBusy: boolean;
  onActionBusy: (busy: boolean) => void;
  homeRequest: number;
}
interface DevicePanelProps {
  devices: Device[];
  onInspect: (device: Device) => void;
  compact?: boolean;
  collected?: boolean;
  onViewAll?: () => void;
}
const navigationIcons = {
  overview: LayoutDashboard,
  devices: Server,
  gpu: Cpu,
  agents: Blocks,
  ops: Workflow,
  logs: Database
};
const deploymentStages = ["检查环境", "同步应用", "启动服务", "健康验证"];
const offlineDemo = !window.sysomDesktop?.isElectron && !['http:', 'https:'].includes(window.location.protocol);
function DevicePanel({
  devices,
  onInspect,
  compact = false,
  collected = false,
  onViewAll
}: DevicePanelProps) {
  const [kindFilter, setKindFilter] = useState("all");
  const [query, setQuery] = useState("");
  const filteredDevices = devices.filter(device => (kindFilter === "all" || device.kind === kindFilter) && `${device.name} ${device.address}`.toLowerCase().includes(query.toLowerCase()));
  const visibleDevices = compact ? devices.slice(0, 3) : filteredDevices;
  const filters = [{
    id: "all",
    label: "全部设备"
  }, {
    id: "server",
    label: "GPU 服务器"
  }, {
    id: "micro",
    label: "微主机"
  }, {
    id: "mini",
    label: "Yoga mini"
  }];
  return <section className={"panel device-panel"}>
    <PanelHeading title={compact ? "我的设备" : "设备列表"} eyebrow={compact ? `${devices.length} 台示例设备 · 统一健康视图` : collected ? '本机系统资源为真实采集；其他设备为 Demo，不建立远程连接' : '仅展示演示配置，不建立真实远程连接'}>
      {compact && onViewAll ? <TextLink onClick={onViewAll}>
        {"查看全部"}
      </TextLink> : <span className={"subtle-tag"}>
        <Network size={13} />
        {" 本地工作空间"}
      </span>}
    </PanelHeading>
    {!compact && <div className={"table-toolbar"}>
      <div className={"filter-tabs"} aria-label={"设备类型筛选"}>
        {filters.map(item => <button key={item.id} aria-pressed={kindFilter === item.id} className={kindFilter === item.id ? "active" : ""} onClick={() => setKindFilter(item.id)}>
          {item.label}
          <span>
            {devices.filter(device => item.id === "all" || device.kind === item.id).length}
          </span>
        </button>)}
      </div>
      <label className={"table-search"}>
        <Search size={15} />
        <input aria-label={"搜索设备名称或 IP"} placeholder={"搜索名称或 IP"} value={query} onChange={event => setQuery(event.target.value)} />
        {query && <button aria-label={"清除设备搜索"} onClick={() => setQuery("")}>
          <X size={14} />
        </button>}
      </label>
    </div>}
    <div className={"table-scroll"}>
      <table>
        <thead>
          <tr>
            <th>
              {"设备名称"}
            </th>
            <th>
              {"运行状态"}
            </th>
            <th>
              {"CPU"}
            </th>
            <th>
              {"内存"}
            </th>
            <th>
              {"GPU"}
            </th>
            <th>
              {"运行时长"}
            </th>
            <th className={"align-right"}>
              {"操作"}
            </th>
          </tr>
        </thead>
        <tbody>
          {visibleDevices.map(device => <tr key={device.id}>
            <td>
              <div className={"table-device"}>
                <DeviceIcon kind={device.kind} />
                <div>
                  <strong>
                    {device.name}
                    {device.local && <span className={"local-tag"}>
                      {"本机"}
                    </span>}
                  </strong>
                  <p>
                    {deviceKindLabels[device.kind]}
                    <span>
                      {"·"}
                    </span>
                    <span className={"mono"}>
                      {device.address}
                    </span>
                  </p>
                </div>
              </div>
            </td>
            <td>
              <StatusPill status={device.status} label={collected && device.local ? '本机资源采集 · 非完整诊断' : undefined} />
            </td>
            <td>
              <Meter value={device.cpu} muted={device.status === "offline"} />
            </td>
            <td>
              <Meter value={device.memory} muted={device.status === "offline"} />
            </td>
            <td>
              {device.gpu === null ? <span className={"no-gpu"}>
                {device.hasGpu ? '不可用' : '—'}
              </span> : <Meter value={device.gpu} muted={device.status === "offline"} />}
            </td>
            <td className={"uptime"}>
              {device.uptime}
            </td>
            <td className={"align-right"}>
              <button className={"table-action"} onClick={() => onInspect(device)} aria-label={`查看${device.name}`}>
                {"详情"}
                <ChevronRight size={13} />
              </button>
            </td>
          </tr>)}
        </tbody>
      </table>
    </div>
    {!visibleDevices.length && <EmptyState title={"没有找到匹配设备"} description={"试试其他设备名称，或调整设备类型筛选。"}>
      <button className={"button secondary"} onClick={() => {
        setKindFilter("all");
        setQuery("");
      }}>
        {"清除筛选"}
      </button>
    </EmptyState>}
    {!compact && <div className={"table-footer"}>
      <span>
        {"共 "}
        {filteredDevices.length}
        {" 台设备"}
      </span>
      <span>
        <i className={"tiny-dot"} />
        {collected ? ' 本机资源来自采集，其他设备为演示配置' : ' 演示数据 · 不代表真实设备状态'}
      </span>
    </div>}
  </section>;
}
export default function App({
  active = true,
  onCollapse,
  healthState,
  snapshotLoading,
  snapshotError,
  onRefresh,
  demoRunning,
  mutationBusy,
  onActionBusy,
  homeRequest
}: AppProps) {
  const [page, setPage] = useState<PageId>("overview");
  const [selectedDeviceId, setSelectedDeviceId] = useState("dc-02");
  const [addedDevices, setAddedDevices] = useState<Device[]>([]);
  const [modal, setModal] = useState<ModalId | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const actionLockRef = useRef(false);
  const modalRef = useRef(modal);
  modalRef.current = modal;
  const [detailDevice, setDetailDevice] = useState<Device>(devices[0]);
  const [toast, setToast] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [globalQuery, setGlobalQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const collected = healthState.mode === 'collected';
  const agentsRecovered = healthState.inspections.find(item => item.id === "agents")?.status === "normal";
  const [allowCloudSummary, setAllowCloudSummary] = useState(false);
  const [deploymentRunning, setDeploymentRunning] = useState(false);
  const [deploymentStep, setDeploymentStep] = useState(-1);
  const [deploymentEnvironment, setDeploymentEnvironment] = useState("IDC · 测试环境");
  const [logTaskRunning, setLogTaskRunning] = useState(false);
  const [logProgress, setLogProgress] = useState(64);
  const [logLevel, setLogLevel] = useState("ALL");
  const [logQuery, setLogQuery] = useState("");
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const usages = resourceUsages(healthState);
  const healthSummary = summarizeHealth(healthState);
  const hasGpu = healthState.hasGpu;
  const visibleNavItems = collected || hasGpu ? navItems : navItems.filter(item => item.id !== "gpu");
  const allDevices: Device[] = [...devices, ...addedDevices].map(device => device.local ? {
    ...device,
    cpu: usages.cpu,
    memory: usages.memory,
    health: healthSummary.score,
    hasGpu,
    ...(collected ? {
      address: '本机',
      hardware: !hasGpu ? '未检测到硬件 GPU' : healthState.resources.gpu.status === 'unavailable' ? 'GPU 状态不可用 · 未取得硬件证据' : '已采集 GPU · 具体硬件以采集证据为准',
      memorySize: formatResourceQuantity(healthState.resources.memory),
      uptime: '未采集运行时长',
    } : {}),
    ...(hasGpu ? {
      gpu: usages.gpu
    } : {
      gpu: null,
      kind: "micro" as const,
      hardware: "未检测到硬件 GPU"
    })
  } : device);
  const localDevice = allDevices.find(device => device.local)!;
  const selectedDevice = allDevices.find(item => item.id === selectedDeviceId)!;
  const selectedHealthScore = selectedDevice.health;
  const currentPageInfo = pageInfo[page];
  const refreshSnapshot = onRefresh;
  useEffect(() => {
    setPage("overview");
    setModal(null);
    setSidebarOpen(false);
    setNotificationsOpen(false);
    setSearchOpen(false);
  }, [homeRequest]);
  useEffect(() => {
    if (!toast) return;
    const timeoutId = window.setTimeout(() => setToast(""), 4200);
    return () => window.clearTimeout(timeoutId);
  }, [toast]);
  useEffect(() => {
    if (modal !== "health-scan") return;
    let mounted = true;
    const timeoutId = window.setTimeout(async () => {
      try {
        if (modal === "health-scan" && selectedDevice.local) {
          await runHealthInspection(healthState.revision);
          await refreshSnapshot(false);
        }
        if (mounted) {
          setModal("health-report");
        }
      } catch (error) {
        if (mounted) {
          setModal(null);
          setToast(error instanceof Error ? error.message : "诊断接口请求失败");
        }
      }
    }, 650);
    return () => {
      mounted = false;
      window.clearTimeout(timeoutId);
    };
  }, [modal, selectedDevice.local]);
  useEffect(() => {
    if (!deploymentRunning) return;
    const timeoutId = window.setTimeout(() => {
      if (deploymentStep === 3) {
        setDeploymentStep(4);
        setDeploymentRunning(false);
        setToast("模拟部署完成，示例健康检查通过。未操作真实服务器。");
      } else {
        setDeploymentStep(deploymentStep + 1);
      }
    }, 850);
    return () => window.clearTimeout(timeoutId);
  }, [deploymentRunning, deploymentStep]);
  useEffect(() => {
    if (!logTaskRunning) return;
    if (logProgress >= 100) {
      setLogTaskRunning(false);
      setToast("示例日志分析完成，已生成聚合报告。");
      return;
    }
    const timeoutId = window.setTimeout(() => setLogProgress(progress => Math.min(100, progress + 4)), 1100);
    return () => window.clearTimeout(timeoutId);
  }, [logTaskRunning, logProgress]);
  useEffect(() => {
    if (!active) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        searchInputRef.current?.focus();
        setSearchOpen(true);
      }
      if (event.key === "Escape") {
        setSearchOpen(false);
        setNotificationsOpen(false);
        setSidebarOpen(false);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [active]);
  function collapseWindow() {
    navigate("overview");
    setModal(null);
    onCollapse?.();
  }
  function navigate(destination: PageId) {
    if (destination === "gpu" && !collected && !hasGpu) destination = "agents";
    if (!(mutationBusy || actionBusy)) {
      setPage(destination);
      setSidebarOpen(false);
      setNotificationsOpen(false);
      setSearchOpen(false);
      document.querySelector(".main-content")?.scrollTo({
        top: 0,
        behavior: "instant"
      });
    }
  }
  async function restartAgent() {
    if (collected) {
      setToast('本机采集为只读，Agent 模拟恢复不会修改采集资源。');
      return;
    }
    if (!(actionLockRef.current || mutationBusy || demoRunning || snapshotLoading || snapshotError)) {
      actionLockRef.current = true;
      setActionBusy(true);
      onActionBusy(true);
      try {
        await optimizeHealth(["opt-agent"], healthState.revision);
        await refreshSnapshot(false);
        if (modalRef.current === "restart") {
          setModal(null);
        }
        setToast("Agent Demo 优化完成，整体快照已刷新。");
      } catch (error) {
        setToast(error instanceof Error ? error.message : "Agent 优化失败");
      } finally {
        actionLockRef.current = false;
        setActionBusy(false);
        onActionBusy(false);
      }
    }
  }
  function inspectDevice(device: Device) {
    setDetailDevice(device);
    setModal("device");
  }
  function runScan() {
    if (selectedDevice.status === "offline") {
      setToast("设备离线，无法运行模拟诊断。请切换在线设备。");
      return;
    }
    setModal("health-scan");
  }
  async function performGpuAction(diagnose: boolean): Promise<void> {
    if (actionLockRef.current || mutationBusy || demoRunning || snapshotLoading) {
      throw new Error('其他采集或操作正在执行，请等待完成后再试。');
    }
    if (diagnose && snapshotError) throw new Error('当前快照不可用，请先刷新本机资源。');
    actionLockRef.current = true;
    setActionBusy(true);
    onActionBusy(true);
    try {
      if (diagnose) {
        await runGpuInspection(healthState.revision);
        await refreshSnapshot(false);
      } else {
        await refreshSnapshot(true);
      }
    } finally {
      actionLockRef.current = false;
      setActionBusy(false);
      onActionBusy(false);
    }
  }
  async function exportReport() {
    const reportPage = modal === "health-report" ? "overview" : page;
    if (reportPage === 'agents' && !offlineDemo && selectedDevice.local) {
      try {
        const report = await fetchAgentDiagnostic();
        const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json;charset=utf-8' }));
        const link = document.createElement('a');
        link.href = url;
        link.download = 'sysagent-agent-collected-report.json';
        document.body.appendChild(link);
        link.click();
        link.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
        setToast('Agent 诊断报告已导出，包含实际证据、时间窗与覆盖限制。');
      } catch (error) { setToast(error instanceof Error ? error.message : 'Agent 诊断报告导出失败'); }
      return;
    }
    if (reportPage === 'gpu') {
      const url = URL.createObjectURL(new Blob([buildGpuReportHtml(healthState)], { type: 'text/html;charset=utf-8' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `sysagent-gpu-${collected ? 'collected' : 'unavailable'}-report.html`;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setToast(collected ? 'GPU 报告已导出，包含实际采集证据、执行状态与不可用说明。' : 'GPU 不可用说明已导出；Demo / 离线模式没有本机诊断证据。');
      return;
    }
    const pageReports = {
      overview: `${selectedDevice.status === "offline" ? "设备离线，未展示或探测资源指标。" : `健康评分：${selectedHealthScore}
CPU：${selectedDevice.cpu}%
内存：${selectedDevice.memory}%
GPU：${selectedDevice.gpu === null ? "无独立 GPU" : `${selectedDevice.gpu}%`}`}
建议：${selectedDevice.local ? "检查 Agent 工作队列与磁盘空间。" : "以实际探针与诊断证据为准。"}`,
      devices: `共 ${allDevices.length} 台示例设备
${allDevices.map(device => `${device.name} | ${deviceKindLabels[device.kind]} | ${device.address} | ${device.status}`).join(`
`)}`,
      agents: selectedDevice.status === "offline" ? "设备离线，未探测 Agent 服务。" : `示例 Agent：${agentsRecovered ? "3 / 3 健康运行，模拟恢复验证通过。" : "2 / 3 健康运行，日志分析队列偏高。"}
重启不等于任务续跑，真实恢复需检查点与幂等机制。`,
      ops: `示例项目：workspace-web
目标环境：${deploymentEnvironment}
模拟流程：${deploymentStep < 0 ? "尚未运行" : deploymentStep === 4 ? "四阶段全部完成" : deploymentStages[deploymentStep] + "执行中"}
未调用云 API、SSH 或真实部署命令。`,
      logs: `内置日志样本 ${logSamples.length} 条 · 筛选结果 ${filteredLogs.length} 条
模拟任务进度 ${logProgress}% · ${logTaskRunning ? "模拟执行中" : logProgress === 100 ? "模拟完成" : "已暂停"}
建议：结合 sql-078 执行计划检查过滤条件与索引；日志不足以确定根因。
海量数据处理与任务续跑仍需工程实现和压测。`
    };
    const reportText = reportPage === "overview" && selectedDevice.local ? buildHealthReport(healthState, localDevice) : `SysAgent管家 · ${pageInfo[reportPage].title}演示报告
所有数据均为模拟，不代表真实诊断结果。

当前设备：${selectedDevice.name}
硬件：${selectedDevice.hardware}

${pageReports[reportPage]}

研发运维及日志调度为概念验证，尚未连接真实系统。`;
    const objectUrl = URL.createObjectURL(new Blob([reportText], {
      type: "text/plain;charset=utf-8"
    }));
    const downloadLink = document.createElement("a");
    downloadLink.href = objectUrl;
    downloadLink.download = `sysagent-${reportPage}-${collected && reportPage === 'overview' && selectedDevice.local ? 'collected' : 'demo'}-report.txt`;
    downloadLink.click();
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
    setToast(collected && reportPage === 'overview' && selectedDevice.local ? '采集报告已导出，包含数据来源、单位与未检查说明。' : '演示报告已导出。报告包含模拟数据标记。');
  }
  function addDevice(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const kind = formData.get("kind") as DeviceKind;
    setAddedDevices(item => [...item, {
      id: `demo-${Date.now()}`,
      name: String(formData.get("name")).trim(),
      kind,
      address: String(formData.get("address")).trim(),
      status: "offline",
      cpu: 0,
      memory: 0,
      gpu: kind === "server" ? 0 : null,
      health: 0,
      uptime: "等待首次连接",
      hardware: "硬件待识别",
      memorySize: "待识别"
    }]);
    setModal(null);
    setToast("已保存演示接入配置，未建立真实连接。刷新页面后配置会重置。");
  }
  const matchedDevices = allDevices.filter(device => `${device.name} ${device.address}`.toLowerCase().includes(globalQuery.toLowerCase()));
  const matchedPages = visibleNavItems.filter(item => item.label.toLowerCase().includes(globalQuery.toLowerCase()));
  const filteredLogs = logSamples.filter(log => (logLevel === "ALL" || log.level === logLevel) && `${log.service} ${log.message}`.toLowerCase().includes(logQuery.toLowerCase()));
  return <div className={`app-shell guard-desktop ${expanded ? "expanded" : ""}`}>
    {sidebarOpen && <button className={"sidebar-scrim"} aria-label={"关闭导航"} onClick={() => setSidebarOpen(false)} />}
    <aside className={`sidebar ${sidebarOpen ? "open" : ""}`}>
      <a className={"brand"} href={"#overview"} onClick={event => {
        event.preventDefault();
        navigate("overview");
      }}>
        <Logo />
        <span>
          <strong>
            {"SysAgent管家"}
          </strong>
          <small>
            {"本地智能运维工作台"}
          </small>
        </span>
      </a>
      <button className={"workspace-switch"} onClick={() => setModal("capabilities")}>
        <span className={"workspace-avatar"}>
          <WorkspaceIcon />
        </span>
        <span>
          {"我的工作空间"}
          <small>
            {collected ? '个人版 · 本机资源采集' : '个人版 · 演示环境'}
          </small>
        </span>
        <ChevronDown size={14} />
      </button>
      <nav aria-label={"主导航"}>
        {["工作空间", "智能运维", "工程与数据"].map(inspection => <div key={inspection} className={"nav-section"}>
          <p>
            {inspection}
          </p>
          {visibleNavItems.filter(navItem => navItem.section === inspection).map(navItem => {
            const NavigationIcon = navigationIcons[navItem.id];
            return <button key={navItem.id} className={`nav-item ${page === navItem.id ? "active" : ""}`} aria-current={page === navItem.id ? "page" : undefined} disabled={mutationBusy || actionBusy} onClick={() => navigate(navItem.id)}>
              <NavigationIcon size={19} strokeWidth={1.8} />
              <span>
                {navItem.label}
              </span>
              {navItem.badge && (navItem.id !== 'agents' || offlineDemo) && <span className={`nav-badge ${navItem.id === "overview" && healthSummary.open.length ? "danger" : navItem.id === "agents" && !agentsRecovered ? "alert" : ""}`}>
                {navItem.id === "overview" ? healthSummary.open.length : navItem.id === "devices" ? allDevices.length : agentsRecovered ? 0 : 1}
              </span>}
            </button>;
          })}
        </div>)}
      </nav>
      <div className={"sidebar-bottom"}>
        <div className={"side-device-info"}>
          <strong>
            <Cpu size={14} />
            {localDevice.name}
          </strong>
          <p>
            {"Linux · "}
            {localDevice.hardware}
            <br />
            {collected ? '' : '示例连续运行 '}
            {localDevice.uptime}
          </p>
        </div>
        <button className={"privacy-card"} onClick={() => setModal("privacy")}>
          <div>
            <span className={"privacy-icon"}>
              <ShieldCheck size={20} />
            </span>
            <span>
              {allowCloudSummary ? "摘要外发策略" : "本地优先策略"}
              <small>
                {collected ? '本地采集 · 真实资源解析' : offlineDemo ? '隐私策略 · 离线演示' : '资源 Demo'}
              </small>
            </span>
            <ChevronRight size={14} />
          </div>
          <p>
            <i className={"tiny-dot"} />
            {allowCloudSummary ? "授权后仅允许脱敏摘要" : "默认不启用云端分析"}
          </p>
        </button>
        <button className={"sidebar-help"} onClick={() => setModal("help")}>
          <BookOpen size={17} />
          {"帮助与产品说明"}
          <ArrowUpRight size={14} />
        </button>
        <div className={"sidebar-footer"}>
          <span>
            {"SYSAGENT HEALTH GUARD"}
          </span>
          <span>
            {`v${import.meta.env.VITE_SYSAGENT_VERSION}`}
          </span>
        </div>
      </div>
    </aside>
    <div className={"main-shell"}>
      <header className={"topbar"}>
        <div className={"breadcrumb"}>
          <button className={"icon-button mobile-menu-button"} aria-label={"打开导航"} onClick={() => setSidebarOpen(true)}>
            <Menu size={21} />
          </button>
          <span className={"desktop-title"}>
            <MascotLogo />
            {"SysAgent管家"}
            <small>
              {"本机系统管家"}
            </small>
          </span>
          <ChevronRight size={14} />
          <strong>
            {currentPageInfo.title}
          </strong>
        </div>
        <div className={"topbar-tools"}>
          <div className={"global-search"}>
            <Search size={16} />
            <input ref={searchInputRef} placeholder={"搜索设备或功能"} aria-label={"全局搜索"} value={globalQuery} onFocus={() => setSearchOpen(true)} onChange={event => {
              setGlobalQuery(event.target.value);
              setSearchOpen(true);
            }} onKeyDown={event => {
              if (event.key === "Enter" && matchedDevices.length) {
                event.preventDefault();
                inspectDevice(matchedDevices[0]);
                setSearchOpen(false);
              }
            }} />
            <kbd>
              {"⌘ K"}
            </kbd>
            {searchOpen && <>
              <button className={"search-dismiss"} tabIndex={-1} aria-label={"关闭搜索结果"} onClick={() => setSearchOpen(false)} />
              <div className={"search-results"}>
                <p>
                  {"设备与功能"}
                </p>
                {matchedPages.slice(0, 3).map(item => <button key={item.id} onClick={() => {
                  navigate(item.id);
                  setGlobalQuery("");
                }}>
                  <LayoutDashboard size={15} />
                  <span>
                    {item.label}
                  </span>
                  <ChevronRight size={13} />
                </button>)}
                {matchedDevices.slice(0, 4).map(device => <button key={device.id} onClick={() => {
                  inspectDevice(device!);
                  setSearchOpen(false);
                  setGlobalQuery("");
                }}>
                  <Server size={15} />
                  <span>
                    {device.name}
                    <small>
                      {device.address}
                    </small>
                  </span>
                  <ChevronRight size={13} />
                </button>)}
                {!matchedPages.length && !matchedDevices.length && <div className={"search-empty"}>
                  {"未找到匹配结果"}
                </div>}
              </div>
            </>}
          </div>
          <span className={"demo-badge"}>
            <i />
            {page === 'agents' && !offlineDemo && selectedDevice.local ? 'AgentSight → OpenAPI · 本机只读诊断' : collected ? page === 'gpu' ? '本机 AI GPU / 作业证据 · 事件独立演示' : page === 'overview' || page === 'devices' ? '本机资源采集' : '本页诊断 / 功能 Demo' : offlineDemo ? '离线演示' : '资源 Demo'}
          </span>
          <div className={"notification-anchor"}>
            <button className={"icon-button notification-button"} aria-label={"查看通知"} aria-expanded={notificationsOpen} onClick={() => {
              setNotificationsOpen(!notificationsOpen);
              setSearchOpen(false);
            }}>
              <Bell size={19} />
              <i />
            </button>
            {notificationsOpen && <div className={"notification-popover"}>
              <h3>
                {"待关注事项"}
                <span>
                  {"示例事件"}
                </span>
              </h3>
              {offlineDemo && !agentsRecovered && <button onClick={() => {
                setSelectedDeviceId(localDevice.id);
                navigate("agents");
              }}>
                <span className={"alert-dot amber"} />
                <div>
                  <strong>
                    {"日志分析 Agent 队列偏高"}
                  </strong>
                  <p>
                    {"活跃线程 28 / 32 · 2 分钟前"}
                  </p>
                </div>
                <ChevronRight size={14} />
              </button>}
              {usages.disk !== null && usages.disk > 90 && <button onClick={() => navigate("overview")}>
                <span className={"alert-dot amber"} />
                <div>
                  <strong>
                    {"本机磁盘使用率达到 "}
                    {usages.disk}
                    {"%"}
                  </strong>
                  <p>
                    {collected ? '根目录容量使用率超过 90% · 本机采集' : '根目录超过 90% · 最新 Demo 快照'}
                  </p>
                </div>
                <ChevronRight size={14} />
              </button>}
              <button onClick={() => {
                inspectDevice(devices[5]);
                setNotificationsOpen(false);
              }}>
                <span className={"alert-dot gray"} />
                <div>
                  <strong>
                    {"边缘节点暂时离线"}
                  </strong>
                  <p>
                    {"上次在线 15 分钟前"}
                  </p>
                </div>
                <ChevronRight size={14} />
              </button>
            </div>}
          </div>
          <button className={"icon-button canvas-expand"} aria-label={expanded ? "还原工作台" : "展开工作台"} onClick={() => setExpanded(item => !item)}>
            {expanded ? <Minimize2 size={17} /> : <Maximize2 size={17} />}
          </button>
          <span className={"topbar-divider"} />
          <button className={"user-avatar"} aria-label={"查看工作空间说明"} onClick={() => setModal("help")}>
            {"S"}
          </button>
          {onCollapse && <>
            <button className={"icon-button window-collapse"} aria-label={"收起为悬浮球"} title={"收起为悬浮球"} onClick={collapseWindow}>
              <Minus size={18} />
            </button>
            <button className={"icon-button window-close"} aria-label={"关闭主页并收回悬浮球"} title={"关闭主页并收回悬浮球"} onClick={collapseWindow}>
              <X size={18} />
            </button>
          </>}
        </div>
      </header>
      <main className={"main-content"}>
        {page !== "overview" && <div className={"page-heading"}>
          <div>
            <span className={"eyebrow"}>
              {currentPageInfo.eyebrow}
            </span>
            <h1>
              {currentPageInfo.title}
              {(page === "ops" || page === "logs") && <span className={"concept-badge"}>
                {"概念验证"}
              </span>}
            </h1>
            <p>
              {page === 'agents' && !offlineDemo && selectedDevice.local ? '通过 AgentSight 采集进程探活、会话 Token、中断及调用延迟，由本地 OpenAPI 分析；证据不足时不判定健康。' : page === 'gpu' ? '本机 GPU 诊断与作业进程分析来自 sysak ai，经本地 OpenAPI mock 解析实际数据；事件演示独立，离线 Profiling 为独立演示。' : currentPageInfo.subtitle}
            </p>
          </div>
          <div className={"page-actions"}>
            <button className={"button secondary"} disabled={page === 'gpu' && (actionBusy || mutationBusy || snapshotLoading)} onClick={exportReport}>
              <ArrowDownToLine size={15} />
              {"导出报告"}
            </button>
            {page === "devices" ? <button className={"button primary"} onClick={() => setModal("add-device")}>
              <Plus size={16} />
              {"接入设备"}
            </button> : page === "gpu" || page === 'agents' && !offlineDemo && selectedDevice.local ? null : page === "ops" ? <button className={"button primary"} disabled={deploymentRunning} onClick={() => setModal("deploy")}>
              <Play size={15} />
              {"模拟部署"}
            </button> : <button className={"button primary"} onClick={() => runScan()}>
              <Sparkles size={16} />
              {"一键体检"}
            </button>}
          </div>
        </div>}
        {page === "overview" && <HealthGuardPage device={localDevice} state={healthState} loading={snapshotLoading} loadError={snapshotError} onRefresh={refreshSnapshot} externalBusy={demoRunning} onBusyChange={onActionBusy} onNavigate={navItem => {
          if (navItem === "gpu" || navItem === "agents") {
            setSelectedDeviceId(localDevice.id);
          }
          navigate(navItem);
        }} onNotify={setToast} />}
        {page === "devices" && <>
          <div className={"fleet-summary"}>
            {(["server", "micro", "mini"] as const).map(device => <button key={device} className={"fleet-card"} onClick={() => {
              const matchingDevice = allDevices.find(device2 => device2.kind === device);
              inspectDevice(matchingDevice!);
            }}>
              <DeviceIcon kind={device} large={true} />
              <div>
                <strong>
                  {deviceKindLabels[device]}
                </strong>
                <p>
                  {device === "server" ? "GPU 专家版 · 深度诊断" : device === "micro" ? "轻量基础版 · 系统管家" : "开发运维版 · 本地中枢"}
                </p>
              </div>
              <span>
                {allDevices.filter(device2 => device2.kind === device).length}
                <small>
                  {"台"}
                </small>
              </span>
              <ChevronRight size={17} />
            </button>)}
          </div>
          <DevicePanel devices={allDevices} collected={collected} onInspect={inspectDevice} />
          <div className={"info-strip"}>
            <Info size={16} />
            <span>
              {"采用共同的轻量底座，按设备启用能力；无卡设备不会显示 GPU 指标。端侧兼容性与规模化管理仍需验证。"}
            </span>
          </div>
        </>}
        {page === 'gpu' && <div className="context-bar"><span><Server size={16} />诊断对象</span><strong>本机</strong><span className="context-hardware">{collected ? localDevice.hardware : '本机 GPU 未采集 · 不使用 Demo 硬件作为证据'}</span><span className="subtle-tag">只使用本机按需数据，不连接示例远程设备</span></div>}
        {page === "agents" && <div className={"context-bar"}>
          <span>
            <Server size={16} />
            {"当前设备"}
          </span>
          <select aria-label={"选择诊断设备"} value={selectedDeviceId} onChange={event => setSelectedDeviceId(event.target.value)}>
            {allDevices.map(item => <option key={item.id} value={item.id}>
              {item.name}
            </option>)}
          </select>
          <span className={"context-hardware"}>
            {selectedDevice.hardware}
          </span>
          <span className={"subtle-tag"}>
            {!offlineDemo && selectedDevice.local ? 'AgentSight 本机只读接口' : '示例设备 · 不建立远程连接'}
          </span>
        </div>}
        {page === "gpu" && <GpuDiagnostics
          healthState={healthState}
          onRefresh={() => performGpuAction(false)}
          onDiagnose={() => performGpuAction(true)}
          busy={actionBusy || mutationBusy || demoRunning || snapshotLoading}
          error={snapshotError}
          onNotify={setToast}
        />}
        {page === 'agents' && !offlineDemo && selectedDevice.local && <LiveAgentDiagnostics onNotify={setToast} />}
        {page === "agents" && (offlineDemo || !selectedDevice.local) && selectedDevice.status === "offline" && <section className={"panel"}>
          <EmptyState title={"这台设备暂时离线"} description={"无法探测离线设备上的 Agent 服务，请切换在线设备。此演示不会进行真实连接。"} />
        </section>}
        {page === "agents" && (offlineDemo || !selectedDevice.local) && selectedDevice.status !== "offline" && <>
          <div className={"agent-summary"}>
            <div>
              <span className={"agent-summary-icon"}>
                <Blocks size={26} />
              </span>
              <div>
                <h2>
                  {"本机 Agent 服务"}
                </h2>
                <p>
                  {"以下为示例服务，不代表所选设备上实际安装的进程。"}
                </p>
              </div>
            </div>
            <span>
              <strong>
                {agentsRecovered ? 3 : 2}
              </strong>
              {" / 3 健康运行"}
            </span>
          </div>
          <AgentDiagnostics recovered={agentsRecovered} onRestart={restartAgent} onNotify={setToast} />
          <div className={"agent-grid"}>
            {[{
              name: "本地推理 Agent",
              type: "MODEL INFERENCE",
              icon: Zap,
              state: "healthy" as const,
              description: "处理本地模型推理与请求路由",
              latency: "842 ms",
              memory: "8.4 GB",
              queue: "4 / 32"
            }, {
              name: "系统巡检 Agent",
              type: "SYSTEM INSPECTION",
              icon: ShieldCheck,
              state: "healthy" as const,
              description: "定期检查系统资源与运行环境",
              latency: "128 ms",
              memory: "184 MB",
              queue: "0 / 8"
            }, {
              name: "日志分析 Agent",
              type: "LOG ANALYTICS",
              icon: Database,
              state: agentsRecovered ? "healthy" as const : "warning" as const,
              description: "聚合本地日志，保存任务检查点",
              latency: agentsRecovered ? "960 ms" : "3,200 ms",
              memory: "2.1 GB",
              queue: agentsRecovered ? "6 / 32" : "28 / 32"
            }].map(agent => <section key={agent.name} className={`panel agent-card ${agent.state === "warning" ? "attention" : ""}`}>
              <div className={"agent-card-head"}>
                <span className={"agent-glyph"}>
                  <agent.icon size={24} />
                </span>
                <StatusPill status={agent.state} />
              </div>
              <span className={"eyebrow"}>
                {agent.type}
              </span>
              <h2>
                {agent.name}
              </h2>
              <p>
                {agent.description}
              </p>
              <div className={"agent-metrics"}>
                <div>
                  <span>
                    {"响应延迟"}
                  </span>
                  <strong>
                    {agent.latency}
                  </strong>
                </div>
                <div>
                  <span>
                    {"内存占用"}
                  </span>
                  <strong>
                    {agent.memory}
                  </strong>
                </div>
                <div>
                  <span>
                    {"工作队列"}
                  </span>
                  <strong className={agent.state === "warning" ? "amber-text" : ""}>
                    {agent.queue}
                  </strong>
                </div>
              </div>
              <div className={"agent-card-footer"}>
                <span>
                  <i className={"tiny-dot"} />
                  {agent.state === "warning" ? "工作队列偏高" : "最近探测正常"}
                </span>
                <button onClick={() => agent.state === "warning" ? setModal("restart") : setToast(`${agent.name}：模拟健康探测通过，未访问真实进程。`)}>
                  {agent.state === "warning" ? "处理异常" : "检查状态"}
                  <ChevronRight size={13} />
                </button>
              </div>
            </section>)}
          </div>
          <section className={"panel recovery-panel"}>
            <div className={"recovery-heading"}>
              <span className={"recovery-icon"}>
                <RefreshCw size={23} />
              </span>
              <div>
                <h2>
                  {"可控恢复，而不是盲目重启"}
                </h2>
                <p>
                  {"先留存诊断证据，再按授权执行恢复，最后验证服务是否真正恢复。"}
                </p>
              </div>
              <span className={"subtle-tag"}>
                {"策略演示"}
              </span>
            </div>
            <div className={"recovery-flow"}>
              {["健康探测", "采集证据", "确认操作", "受控重启", "恢复验证"].map((item, index) => <div key={item}>
                <span>
                  {String(index + 1).padStart(2, "0")}
                </span>
                <strong>
                  {item}
                </strong>
                {index < 4 && <ArrowRight size={16} />}
              </div>)}
            </div>
            <div className={"info-strip"}>
              <Info size={16} />
              <span>
                {"重启不等于长任务续跑。检查点、持久化任务状态与重试策略需要单独实现。"}
              </span>
            </div>
          </section>
        </>}
        {page === "ops" && <>
          <div className={"info-strip concept"}>
            <Info size={16} />
            <span>
              {"研发运维为概念验证：仅模拟部署过程，不连接代码仓库、不执行远程命令。"}
            </span>
            <button onClick={() => setModal("capabilities")}>
              {"能力边界"}
              <ArrowUpRight size={13} />
            </button>
          </div>
          <div className={"ops-grid"}>
            <section className={"panel deployment-panel"}>
              <PanelHeading title={"应用部署"}>
                <span className={"subtle-tag"}>
                  <GitBranch size={13} />
                  {"main · 示例分支"}
                </span>
              </PanelHeading>
              <div className={"project-info"}>
                <span>
                  <FileCode2 size={28} />
                </span>
                <div>
                  <h2>
                    {"workspace-web"}
                  </h2>
                  <p>
                    {"Web 应用模板 · 示例项目"}
                  </p>
                </div>
                <span className={"project-version"}>
                  {"v1.2.0"}
                </span>
              </div>
              <div className={"deploy-config"}>
                <label>
                  {"目标环境"}
                  <select aria-label={"部署目标环境"} value={deploymentEnvironment} disabled={deploymentRunning} onChange={event => {
                    setDeploymentEnvironment(event.target.value);
                    setDeploymentStep(-1);
                  }}>
                    <option>
                      {"IDC · 测试环境"}
                    </option>
                    <option>
                      {"ECS · 测试环境"}
                    </option>
                    <option>
                      {"本地 · 开发环境"}
                    </option>
                  </select>
                </label>
                <label>
                  {"部署方式"}
                  <div>
                    <Terminal size={15} />
                    {"容器模板部署"}
                    <span>
                      {"模拟"}
                    </span>
                  </div>
                </label>
              </div>
              <div className={"deployment-steps"}>
                {deploymentStages.map((item, index) => <div key={item} className={deploymentStep > index ? "complete" : deploymentStep === index ? "current" : ""}>
                  <span>
                    {deploymentStep > index ? <Check size={16} /> : deploymentStep === index ? <LoaderCircle size={16} className={"spinning"} /> : index + 1}
                  </span>
                  <strong>
                    {item}
                  </strong>
                  <small>
                    {deploymentStep > index ? "通过" : deploymentStep === index ? "执行中" : "等待"}
                  </small>
                </div>)}
              </div>
              <div className={"deployment-console"}>
                <div>
                  <i />
                  <i />
                  <i />
                  <span>
                    {"deployment.log · demo"}
                  </span>
                </div>
                <p>
                  <span>
                    {"$"}
                  </span>
                  {" deploy workspace-web --env \""}
                  {deploymentEnvironment}
                  {"\""}
                </p>
                {deploymentStep < 0 ? <p className={"terminal-muted"}>
                  {"等待开始模拟部署..."}
                </p> : deploymentStages.slice(0, deploymentStep + 1).map((item, index) => <p key={item}>
                  <span className={"terminal-green"}>
                    {deploymentStep > index ? "[ok]" : "[..]"}
                  </span>
                  {" "}
                  {item}
                  {" "}
                  {deploymentStep > index ? "completed" : "running..."}
                </p>)}
                {deploymentStep === 4 && <p className={"terminal-green"}>
                  {"示例流程完成 · 未执行任何真实命令"}
                </p>}
              </div>
              <div className={"deployment-footer"}>
                <span>
                  <LockKeyhole size={14} />
                  {"发布操作需确认，默认使用测试环境"}
                </span>
                <button className={"button primary"} disabled={deploymentRunning} onClick={() => setModal("deploy")}>
                  {deploymentRunning ? <LoaderCircle size={15} className={"spinning"} /> : <Play size={15} />}
                  {deploymentRunning ? "模拟部署中" : deploymentStep === 4 ? "再次模拟部署" : "开始模拟部署"}
                </button>
              </div>
            </section>
            <section className={"panel loop-panel"}>
              <PanelHeading title={"开发到运维的闭环"} />
              <div className={"loop-steps"}>
                {[{
                  icon: FileCode2,
                  title: "编写代码",
                  text: "连接外部 Coding 工具",
                  tag: "待集成"
                }, {
                  icon: Cloud,
                  title: "部署上线",
                  text: "应用模板与授权执行",
                  tag: "模拟流程"
                }, {
                  icon: Activity,
                  title: "健康观测",
                  text: "资源指标 + 应用探针",
                  tag: "需适配"
                }, {
                  icon: Sparkles,
                  title: "诊断反馈",
                  text: "证据与建议返回开发端",
                  tag: "可复用底座"
                }].map(item => <div key={item.title}>
                  <span>
                    <item.icon size={20} />
                  </span>
                  <article>
                    <h3>
                      {item.title}
                      <em>
                        {item.tag}
                      </em>
                    </h3>
                    <p>
                      {item.text}
                    </p>
                  </article>
                </div>)}
              </div>
              <div className={"loop-note"}>
                <ShieldCheck size={19} />
                <p>
                  {"自动改码与发布不是现成功能，首版保留人工审核。"}
                </p>
              </div>
            </section>
          </div>
          <DevicePanel devices={allDevices.filter(device => !device.local)} compact={true} onInspect={inspectDevice} onViewAll={() => navigate("devices")} />
        </>}
        {page === "logs" && <>
          <div className={"info-strip concept"}>
            <Info size={16} />
            <span>
              {"以下使用 8 条内置日志演示聚合分析；大规模吞吐、混合调度和任务续跑仍需工程实现与压测。"}
            </span>
          </div>
          <div className={"logs-top"}>
            <section className={"panel log-task-panel"}>
              <PanelHeading title={"本地日志聚合任务"}>
                <StatusPill status={logTaskRunning ? "running" : logProgress === 100 ? "healthy" : "warning"} label={logTaskRunning ? "模拟执行中" : logProgress === 100 ? "模拟完成" : "已暂停"} />
              </PanelHeading>
              <div className={"log-task-title"}>
                <span>
                  <Database size={24} />
                </span>
                <div>
                  <h2>
                    {"应用日志 · 异常模式分析"}
                  </h2>
                  <p>
                    {"示例任务 LOG-012 · 本地分批聚合"}
                  </p>
                </div>
                <strong>
                  {logProgress}
                  <small>
                    {"%"}
                  </small>
                </strong>
              </div>
              <div className={"task-progress"}>
                <i style={{
                  width: `${logProgress}%`
                }} />
              </div>
              <div className={"task-detail-row"}>
                <span>
                  <Check size={13} />
                  {"检查点：batch-"}
                  {Math.round(logProgress * 2.8)}
                </span>
                <span>
                  <Cpu size={13} />
                  {"并发上限 2 · 示例策略"}
                </span>
                <button className={"button secondary small-button"} onClick={() => {
                  if (logProgress === 100) {
                    setLogProgress(0);
                  }
                  setLogTaskRunning(!logTaskRunning);
                }}>
                  {logTaskRunning ? <Pause size={13} /> : <Play size={13} />}
                  {logTaskRunning ? "暂停" : logProgress === 100 ? "重新模拟" : "继续模拟"}
                </button>
              </div>
            </section>
            <section className={"panel routing-panel"}>
              <span className={"routing-icon"}>
                <Network size={22} />
              </span>
              <div>
                <h2>
                  {"本地优先，按需外发"}
                </h2>
                <p>
                  {"确定性程序处理数据，模型解释聚合结果。"}
                </p>
                <span>
                  <LockKeyhole size={13} />
                  {"原始日志不参与本演示的外部请求"}
                </span>
              </div>
              <button className={"icon-button"} aria-label={"设置分析路由"} onClick={() => setModal("privacy")}>
                <Settings2 size={18} />
              </button>
            </section>
          </div>
          <section className={"panel log-explorer"}>
            <PanelHeading title={"日志浏览器"}>
              <span className={"subtle-tag"}>
                {"内置样本 · 8 条"}
              </span>
            </PanelHeading>
            <div className={"table-toolbar"}>
              <div className={"filter-tabs"} aria-label={"日志等级筛选"}>
                {["ALL", "INFO", "WARN", "ERROR"].map(item => <button key={item} className={logLevel === item ? "active" : ""} aria-pressed={logLevel === item} onClick={() => setLogLevel(item)}>
                  {item === "ALL" ? "全部等级" : item}
                </button>)}
              </div>
              <label className={"table-search log-search"}>
                <Search size={15} />
                <input aria-label={"搜索日志内容"} placeholder={"搜索服务名或关键字"} value={logQuery} onChange={event => setLogQuery(event.target.value)} />
              </label>
            </div>
            <div className={"table-scroll"}>
              <table className={"log-table"}>
                <thead>
                  <tr>
                    <th>
                      {"时间"}
                    </th>
                    <th>
                      {"等级"}
                    </th>
                    <th>
                      {"服务"}
                    </th>
                    <th>
                      {"日志内容"}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {filteredLogs.map(log => <tr key={log.time}>
                    <td className={"mono"}>
                      {log.time}
                    </td>
                    <td>
                      <span className={`log-level ${log.level.toLowerCase()}`}>
                        {log.level}
                      </span>
                    </td>
                    <td className={"mono"}>
                      {log.service}
                    </td>
                    <td className={"mono"}>
                      {log.message}
                    </td>
                  </tr>)}
                </tbody>
              </table>
            </div>
            {!filteredLogs.length && <EmptyState title={"没有匹配日志"} description={"请调整日志等级或搜索关键字。"}>
              <button className={"button secondary"} onClick={() => {
                setLogLevel("ALL");
                setLogQuery("");
              }}>
                {"清除日志筛选"}
              </button>
            </EmptyState>}
          </section>
          <section className={"panel log-findings"}>
            <span className={"finding-icon"}>
              <Sparkles size={23} />
            </span>
            <div>
              <span className={"eyebrow"}>
                {"SAMPLE ANALYSIS"}
              </span>
              <h2>
                {"从日志中找到值得排查的问题"}
              </h2>
              <p>
                {"样本中的 sql-078 同时出现查询超时和大量扫描行。建议结合执行计划检查索引，不能仅凭日志确定根因。"}
              </p>
            </div>
            <button className={"button secondary"} onClick={() => setToast("示例建议：获取 sql-078 的执行计划，核对过滤条件与索引。此演示不自动修改代码。")}>
              {"查看优化建议"}
              <ArrowUpRight size={14} />
            </button>
          </section>
        </>}
        <footer className={"content-footer"}>
          <span>
            <span className={"footer-mark"}>
              <MascotLogo />
            </span>
            {"SysAgent管家 · 让本地 AI 稳定运行"}
          </span>
          <button onClick={() => setModal("capabilities")}>
            {"演示数据与能力说明"}
            <ArrowUpRight size={12} />
          </button>
        </footer>
      </main>
    </div>
    {toast && <div className={"toast"} role={"status"}>
      <span>
        <Check size={16} />
      </span>
      {toast}
      <button aria-label={"关闭提示"} onClick={() => setToast("")}>
        <X size={15} />
      </button>
    </div>}
    {modal && <Modal title={modal === "health-scan" ? collected && modal === 'health-scan' && selectedDevice.local ? '正在运行本机资源采集' : '正在运行模拟诊断' : modal === "health-report" ? "本机健康体检报告" : modal === "device" ? "设备详情" : modal === "add-device" ? "接入新设备" : modal === "privacy" ? "隐私与执行策略" : modal === "capabilities" ? "产品能力与交付边界" : modal === "restart" ? "确认模拟恢复" : modal === "deploy" ? "确认模拟部署" : "关于SysAgent管家"} subtitle={collected ? '本机系统资源由 OpenAPI 真实解析 · 其他模块为 Demo 或未检查 · 不执行系统修复' : offlineDemo ? '离线演示 · 不访问或修改真实设备' : 'Demo 快照 · 不执行系统修复'} onClose={() => {
      if (!actionBusy) {
        setModal(null);
      }
    }} wide={modal === "capabilities" || modal === "health-report" && !!selectedDevice.local}>
      {(modal === "health-scan") && <div className={"scanning-state"}>
        <span>
          <LoaderCircle size={36} className={"spinning"} />
        </span>
        <h3>
          {"正在关联指标与异常事件"}
        </h3>
        <p>
          {collected && modal === 'health-scan' && selectedDevice.local ? '正在采集并解析本机系统资源；未检查诊断保持未检查。' : '读取内置样本，生成模拟诊断报告...'}
        </p>
        <small>
          {collected && modal === 'health-scan' && selectedDevice.local ? '关闭弹窗不会执行清理或修复。' : '关闭弹窗可取消本次演示。'}
        </small>
      </div>}
      {modal === "health-report" && selectedDevice.local && <>
        <HealthReportContent device={localDevice} state={healthState} />
        <div className={"modal-actions"}>
          <button className={"button secondary"} onClick={exportReport}>
            <ArrowDownToLine size={15} />
            {collected && modal === 'health-report' && selectedDevice.local ? '导出采集报告' : '导出演示报告'}
          </button>
          <button className={"button primary"} onClick={() => setModal(null)}>
            {"完成"}
          </button>
        </div>
      </>}
      {modal === "health-report" && !selectedDevice.local && <>
        <div className={"report-summary"}>
          <HealthRing score={selectedHealthScore} compact={true} />
          <div>
            <span className={"subtle-tag green"}>
              {"模拟报告"}
            </span>
            <h3>
              {selectedDevice.name}
            </h3>
            <p>
              {selectedDevice.gpu === null ? "系统 · Agent · 磁盘与依赖" : "系统 · GPU · Agent · 磁盘与依赖"}
            </p>
          </div>
        </div>
        <ReportItem title="系统资源处于正常范围" description={`CPU ${selectedDevice.cpu}% · 内存 ${selectedDevice.memory}% · 无示例 OOM 事件。`} />
        <ReportItem title={"服务状态与诊断证据"} description={"报告由内置指标和日志生成，不能用于判断真实系统健康。"} />
        <div className={"modal-actions"}>
          <button className={"button secondary"} onClick={exportReport}>
            <ArrowDownToLine size={15} />
            {collected && modal === 'health-report' && selectedDevice.local ? '导出采集报告' : '导出演示报告'}
          </button>
          <button className={"button primary"} onClick={() => setModal(null)}>
            {"完成"}
          </button>
        </div>
      </>}
      {modal === "device" && <>
        <div className={"detail-device"}>
          <DeviceIcon kind={detailDevice.kind} large={true} />
          <div>
            <h3>
              {detailDevice.name}
            </h3>
            <p>
              {deviceKindLabels[detailDevice.kind]}
              {" · "}
              {detailDevice.address}
            </p>
          </div>
          <StatusPill status={detailDevice.status} />
        </div>
        <div className={"detail-grid"}>
          {[{
            label: "硬件配置",
            value: detailDevice.hardware
          }, {
            label: "系统内存",
            value: detailDevice.memorySize
          }, {
            label: "运行时长",
            value: detailDevice.uptime
          }, {
            label: "执行通道",
            value: detailDevice.local ? (offlineDemo ? "离线演示" : "sysAK 本机只读采集") : "SSH 通道 · 演示配置"
          }].map(item => <div key={item.label}>
            <span>
              {item.label}
            </span>
            <strong>
              {item.value}
            </strong>
          </div>)}
        </div>
        {detailDevice.status === "offline" ? <div className={"info-strip"}>
          <Info size={16} />
          <span>
            {"设备离线或尚未连接，暂不展示资源数据。"}
          </span>
        </div> : <div className={"detail-meters"}>
          <div>
            <span>
              {"CPU"}
            </span>
            <Meter value={detailDevice.local ? usages.cpu : detailDevice.cpu} />
          </div>
          <div>
            <span>
              {"内存"}
            </span>
            <Meter value={detailDevice.local ? usages.memory : detailDevice.memory} />
          </div>
          {(!detailDevice.local || hasGpu) && <div>
            <span>
              {"GPU"}
            </span>
            {(detailDevice.local ? usages.gpu : detailDevice.gpu) === null ? <small>
              {(detailDevice.local ? hasGpu : detailDevice.hasGpu) ? 'GPU 测量不可用' : '无独立 GPU'}
            </small> : <Meter value={detailDevice.local ? usages.gpu : detailDevice.gpu} />}
          </div>}
        </div>}
        <label className={"form-label"}>
          {"切换当前诊断设备"}
          <select aria-label={"弹窗选择设备"} value={detailDevice.id} onChange={event => setDetailDevice(allDevices.find(index => index.id === event.target.value)!)}>
            {allDevices.map(item => <option key={item.id} value={item.id}>
              {item.name}
            </option>)}
          </select>
        </label>
        <div className={"modal-actions"}>
          <button className={"button secondary"} onClick={() => {
            setSelectedDeviceId(detailDevice.id);
            setModal(null);
            setToast(`当前设备已切换为${detailDevice.name}。`);
          }}>
            {"设为当前设备"}
          </button>
          <button className={"button primary"} onClick={() => {
            setSelectedDeviceId(detailDevice.id);
            setModal(null);
            navigate(collected && detailDevice.local || hasGpu && detailDevice.gpu !== null ? "gpu" : "agents");
          }}>
            {"打开"}
            {collected && detailDevice.local || hasGpu && detailDevice.gpu !== null ? "GPU 诊断" : "Agent 管家"}
            <ArrowRight size={14} />
          </button>
        </div>
      </>}
      {modal === "add-device" && <form onSubmit={addDevice}>
        <div className={"info-strip"}>
          <Info size={16} />
          <span>
            {"仅保存当前页面中的演示配置，不收集密钥、不发起连接。"}
          </span>
        </div>
        <label className={"form-label"}>
          {"设备名称"}
          <input name={"name"} required={true} maxLength={60} pattern={".*\\S.*"} placeholder={"例如：研发工作站"} />
        </label>
        <label className={"form-label"}>
          {"设备类型"}
          <select name={"kind"}>
            <option value={"server"}>
              {"GPU 服务器"}
            </option>
            <option value={"micro"}>
              {"微主机"}
            </option>
            <option value={"mini"}>
              {"Yoga mini"}
            </option>
          </select>
        </label>
        <label className={"form-label"}>
          {"IP 地址或主机名"}
          <input name={"address"} required={true} maxLength={253} pattern={"[a-zA-Z0-9.:\\-]+"} placeholder={"例如：192.168.1.101"} />
        </label>
        <p className={"form-hint"}>
          {"提交后显示“等待首次连接”；刷新页面会重置。"}
        </p>
        <div className={"modal-actions"}>
          <button type={"button"} className={"button secondary"} onClick={() => setModal(null)}>
            {"取消"}
          </button>
          <button className={"button primary"} type={"submit"}>
            <Plus size={15} />
            {"保存演示配置"}
          </button>
        </div>
      </form>}
      {modal === "privacy" && <>
        <div className={"privacy-modal-hero"}>
          <ShieldCheck size={30} />
          <div>
            <h3>
              {"先明确边界，再使用云端能力"}
            </h3>
            <p>
              {collected ? '当前 IDC / sysAK 原始证据提交本机回环地址的 OpenAPI 解析，系统资源使用真实测量，不上传外部服务。诊断并非全部接入；远端接入仍需脱敏、认证和授权。' : '当前为离线或内置 Demo，不采集真实系统资源；云端与远端接入尚未启用。'}
            </p>
          </div>
        </div>
        <div className={"policy-row"}>
          <div>
            <strong>
              {"本地数据预处理"}
            </strong>
            <p>
              {"日志清洗、聚合和基础诊断优先在本地完成。"}
            </p>
          </div>
          <span className={"subtle-tag green"}>
            {"产品原则"}
          </span>
        </div>
        <div className={"policy-row"}>
          <div>
            <strong>
              {"允许脱敏摘要参与云端分析"}
            </strong>
            <p>
              {"模拟授权开关；切换不会发送任何数据。"}
            </p>
          </div>
          <label className={"toggle"}>
            <input type={"checkbox"} checked={allowCloudSummary} onChange={event => setAllowCloudSummary(event.target.checked)} aria-label={"允许脱敏摘要参与云端分析"} />
            <span />
          </label>
        </div>
        <div className={"policy-row"}>
          <div>
            <strong>
              {"高风险运维操作人工确认"}
            </strong>
            <p>
              {"安装、重启、修改配置和部署默认需要授权。"}
            </p>
          </div>
          <LockKeyhole size={19} className={"muted-icon"} />
        </div>
        <div className={"info-strip"}>
          <Info size={16} />
          <span>
            {"真正实现“数据不出域”需要覆盖模型、日志、知识库、脚本分发与所有数据出口。"}
          </span>
        </div>
        <div className={"modal-actions"}>
          <button className={"button primary"} onClick={() => {
            setModal(null);
            setToast("演示策略已更新；没有产生任何外部请求。");
          }}>
            {"保存演示策略"}
          </button>
        </div>
      </>}
      {modal === "capabilities" && <>
        <p className={"capability-intro"}>
          {"基于 SysAgent 能力分析整理。源码中的平台能力仍需经过端侧封装、兼容性验证及实际 POC。"}
        </p>
        <div className={"capability-list"}>
          {[{
            title: "本地 sysAK 采集与 OpenAPI 协调链路",
            tag: collected ? '资源已接通 · 只读' : '离线 Demo',
            tone: "green",
            text: !offlineDemo ? '系统资源来自 IDC / sysAK；Agent 诊断独立通过 AgentSight 本机只读接口获取进程探活、会话 Token、中断和调用延迟，由本地 OpenAPI 分析。未取得证据时显示不可用，不判定健康；不自动重启、修复或提供 Session 独占资源。' : '离线 Demo 不获取真实 AgentSight 或硬件数据；桌面和开发服务器模式支持本机只读诊断。'
          }, {
            title: "监控、诊断、巡检与远程执行通道",
            tag: "已有能力底座",
            tone: "green",
            text: "GPU / CPU / 内存 / IO / 网络诊断，健康巡检，MCP 工具与 SSH / ECS 通道。"
          }, {
            title: "可安装的轻量本机 SysAgent管家",
            tag: "需要适配",
            tone: "blue",
            text: "本机执行通道、操作系统兼容、本地存储、模型与知识库本地化，用户 Agent 探针。"
          }, {
            title: "恢复策略、依赖安装与隐私出口控制",
            tag: "需要新增或验证",
            tone: "amber",
            text: "受控自愈、指定运行环境安装、离线 CVE 覆盖，以及敏感数据检测和外发阻断。"
          }, {
            title: "自动部署、改码闭环与大规模日志调度",
            tag: "联合开发方向",
            tone: "purple",
            text: "业务部署模板、Coding 工具集成、任务检查点与幂等、混合算力路由和规模化压测。"
          }].map(item => <article key={item.title}>
            <div>
              <h3>
                {item.title}
              </h3>
              <span className={`subtle-tag ${item.tone}`}>
                {item.tag}
              </span>
            </div>
            <p>
              {item.text}
            </p>
          </article>)}
        </div>
        <div className={"modal-actions"}>
          <button className={"button primary"} onClick={() => setModal(null)}>
            {"了解，继续体验"}
          </button>
        </div>
      </>}
      {modal === "restart" && <>
        <div className={"confirm-hero"}>
          <span>
            <RefreshCw size={27} />
          </span>
          <div>
            <h3>
              {"日志分析 Agent · 受控恢复"}
            </h3>
            <p>
              {"演示流程：采集证据 → 重启 → 恢复验证"}
            </p>
          </div>
        </div>
        <ReportItem title={"操作范围"} description={"只更新页面中的模拟状态，不终止或重启真实进程。"} />
        <ReportItem warning={true} title={"长任务恢复边界"} description={"真实任务需检查点和幂等机制，单纯重启无法保证续跑。"} />
        <div className={"modal-actions"}>
          <button className={"button secondary"} disabled={actionBusy} onClick={() => setModal(null)}>
            {"取消"}
          </button>
          <button className={"button primary"} disabled={collected || actionBusy || mutationBusy || demoRunning} onClick={restartAgent}>
            {actionBusy ? <LoaderCircle size={15} className={"spinning"} /> : <RefreshCw size={15} />}
            {actionBusy ? "正在恢复并刷新…" : "确认模拟恢复"}
          </button>
        </div>
      </>}
      {modal === "deploy" && <>
        <div className={"confirm-hero"}>
          <span>
            <Cloud size={27} />
          </span>
          <div>
            <h3>
              {"workspace-web → "}
              {deploymentEnvironment}
            </h3>
            <p>
              {"容器应用模板 · main · v1.2.0"}
            </p>
          </div>
        </div>
        <ReportItem title={"将展示四阶段演示流程"} description={"环境检查、应用同步、服务启动与健康验证。"} />
        <ReportItem warning={true} title={"不会进行真实发布"} description={"不调用云 API，不建立 SSH 连接，不处理凭据，也不修改服务器。"} />
        <div className={"modal-actions"}>
          <button className={"button secondary"} onClick={() => setModal(null)}>
            {"取消"}
          </button>
          <button className={"button primary"} onClick={() => {
            setDeploymentStep(0);
            setDeploymentRunning(true);
            setModal(null);
            navigate("ops");
          }}>
            <Play size={15} />
            {"确认模拟部署"}
          </button>
        </div>
      </>}
      {modal === "help" && <>
        <div className={"about-brand"}>
          <Logo />
          <div>
            <h3>
              {"SysAgent管家"}
            </h3>
            <p>
              {"本地 AI 的运维管家与开发控制中枢"}
            </p>
          </div>
        </div>
        <p className={"about-copy"}>
          {collected ? '本机系统资源与进程排行来自 IDC / sysAK 经本地 OpenAPI 解析；GPU 诊断与作业进程分析来自本机 sysak ai 有界扫描，由 OpenAPI mock 解析实际数据；支持进程资源及 HANG/NCCL/Xid 证据，不提供完整 CPU/GPU 时间线或 Kernel 热点。Agent 诊断通过独立 AgentSight 的本机只读接口采集进程探活、会话 Token、中断和调用延迟，再由本地 OpenAPI 分析展示；数据缺失不代表健康。GPU 事件演示独立，离线 Profiling、其他设备和日志仍为 Demo。诊断不自动重启、修复或提供 Agent Session 独占资源。' : offlineDemo ? '面向 GPU 服务器、无卡微主机与 Yoga mini 的前端交互原型。离线 Demo 不访问真实硬件或 AgentSight。' : '本机系统资源尚未取得完整采集证据；Agent 诊断可独立通过 AgentSight 本机接口和本地 OpenAPI 获取只读报告，不依赖 sysAK 安装成功。'}
        </p>
        <div className={"about-shortcuts"}>
          <span>
            {"全局搜索"}
            <kbd>
              {"Ctrl / ⌘ K"}
            </kbd>
          </span>
          <span>
            {"关闭弹窗"}
            <kbd>
              {"Esc"}
            </kbd>
          </span>
        </div>
        <div className={"info-strip"}>
          <Info size={16} />
          <span>
            {!offlineDemo ? '建议体验：总览体检 → 本机 GPU 诊断 → AgentSight 只读诊断。模板部署与日志工作区仍为独立演示。' : hasGpu ? '离线演示：总览体检 → GPU 页面 → Agent 模拟恢复 → 模板部署 → 日志筛选。' : '离线演示：总览体检 → 设备管理 → Agent 模拟恢复 → 日志筛选。'}
          </span>
        </div>
        <div className={"modal-actions"}>
          <button className={"button primary"} onClick={() => setModal(null)}>
            {"开始体验"}
          </button>
        </div>
      </>}
    </Modal>}
  </div>;
}
