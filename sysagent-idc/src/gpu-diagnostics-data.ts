import type { GpuDevice, GpuDiagnostic, GpuJobProcess, HealthState } from './health-data';
import { localTime } from '../agent-diagnostics';

export type GpuTab = "overview" | "inspection" | "events" | "profiling";

export function escapeGpuHtml(value: unknown) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;');
}

export function gpuMetric(value: number | null | undefined, unit = '') {
  return typeof value === 'number' && Number.isFinite(value) ? `${value}${unit}` : 'N/A · 不可用';
}

function gpuBytes(value: number | null | undefined) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'N/A · 不可用';
  const power = value >= 1024 ** 3 ? 3 : value >= 1024 ** 2 ? 2 : value >= 1024 ? 1 : 0;
  return `${Number((value / 1024 ** power).toFixed(2))} ${['B', 'KiB', 'MiB', 'GiB'][power]}`;
}

export function gpuDeviceMetrics(device: GpuDevice) {
  return [
    { label: '计算利用率', value: gpuMetric(device.utilization, '%') },
    { label: '显存活动利用率', value: gpuMetric(device.memoryUtilization, '%') },
    { label: '已用显存', value: gpuBytes(device.memoryUsedBytes) },
    { label: '总显存', value: gpuBytes(device.memoryTotalBytes) },
    { label: '温度', value: gpuMetric(device.temperatureCelsius, ' °C') },
    { label: '功耗 / 上限', value: `${gpuMetric(device.powerWatts, ' W')} / ${gpuMetric(device.powerLimitWatts, ' W')}` },
    { label: 'ECC 已纠正', value: gpuMetric(device.eccCorrected) },
    { label: 'ECC 未纠正', value: gpuMetric(device.eccUncorrected) },
    { label: 'PCIe 代际 / 最大代际', value: `${gpuMetric(device.pcieGeneration)} / ${gpuMetric(device.pcieMaxGeneration)}` },
    { label: 'PCIe 链路宽度', value: gpuMetric(device.pcieWidth, ' lanes') },
  ];
}

export function gpuExecutionStatusLabel(status?: GpuDiagnostic['status']) {
  const labels: Record<GpuDiagnostic['status'], string> = {
    not_run: '未检查', ok: '检查完成', partial: '部分检查', unavailable: '不可用',
    error: '检查失败', timeout: '检查超时', truncated: '结果截断', permission_denied: '权限不足',
  };
  return status ? labels[status] : '未检查';
}

export function gpuDiagnosticStatusLabel(diagnostic?: GpuDiagnostic) {
  return gpuExecutionStatusLabel(diagnostic?.status);
}

export const gpuJobCapability = '展示原生进程资源及HANG/NCCL/Xid证据；指标窗口未提供，name/starttime不可用，缺少GX则ai不可用；不提供完整CPU/GPU时间线或Kernel热点';

export function gpuJobProcessKey(process: GpuJobProcess) {
  return `${process.pid}:${process.starttime ?? 'unknown'}`;
}

export function gpuJobProcessMetrics(process: GpuJobProcess) {
  return [
    { label: 'CPU 占用', value: gpuMetric(process.cpuPercent, '%') },
    { label: '进程 SM 利用率', value: gpuMetric(process.smUtilization, '%') },
    { label: '进程显存活动利用率', value: gpuMetric(process.memoryUtilization, '%') },
    { label: 'RSS 字节（系统内存，不是显存）', value: gpuMetric(process.rssBytes, ' B') },
    { label: 'GPU indices', value: process.gpuIndices.length ? process.gpuIndices.join('、') : 'N/A · 未取得关联 GPU' },
    { label: '进程状态', value: process.state || 'N/A · 不可用' },
  ];
}

export function gpuNvmlCoverage(state: HealthState) {
  if (state.mode !== 'collected') return 'N/A · 未采集';
  const resource = state.resources.gpu;
  const coverage = resource.status === 'available' ? '可用' : resource.status === 'partial' ? '部分测量' : '不可用 / 未知';
  const records = resource.gpuDevices === undefined ? 'N/A · 未取得逐卡记录' : `${resource.gpuDevices.length} 条逐卡资源记录`;
  return `${coverage} · ${records}（不等于 GX 分析完成）`;
}

export function gpuDiagnosticOutcomeLabel(diagnostic?: GpuDiagnostic) {
  if (!diagnostic || diagnostic.status === 'not_run') return '未检查 · 无诊断结论';
  if (diagnostic.outcome === 'no_gpu') return '未检测到 GPU';
  if (diagnostic.outcome === 'abnormal') return '发现异常';
  if (diagnostic.outcome === 'normal' && diagnostic.status === 'ok' && diagnostic.complete) return '本次检查未发现异常';
  return '结论受限 / 未知，不代表硬件正常';
}

export function gpuOverviewExplanation(state: HealthState) {
  if (state.mode !== 'collected') return '当前为 Demo / 离线数据，未采集本机 GPU。概览不使用示例硬件或模拟指标；真实诊断需本机采集通道。';
  const resource = state.resources.gpu;
  if (state.gpuDiagnostic?.status === 'permission_denied') return `GPU 诊断权限不足；可见资源指标不等于完整诊断。${resource.note || ''}`;
  if (state.gpuDiagnostic?.outcome === 'no_gpu') return `本次诊断未检测到 GPU。${resource.note || ''}`;
  if (resource.status === 'unavailable') return `GPU 测量不可用，可能未检测到 GPU、驱动不可用或缺少采集权限；不能据此判定正常。${resource.note || ''}`;
  if (!state.hasGpu) return `未检测到 GPU；仍可按需检查并查看不可用原因。${resource.note || ''}`;
  if (!resource.gpuDevices?.length) return `尚未取得逐卡指标，缺失测量不代表 GPU 正常。${resource.note || ''}`;
  return resource.note || '仅展示本机当前按需快照，不生成历史曲线；缺失测量显示 N/A，不代表正常。';
}

export function buildGpuReportHtml(state: HealthState) {
  const real = state.mode === 'collected';
  const resource = state.resources.gpu;
  const diagnostic = real ? state.gpuDiagnostic : undefined;
  const devices = real ? resource.gpuDevices || [] : [];
  const e = escapeGpuHtml;
  const rows = diagnostic?.findings.map(finding => `<tr><td>${e(finding.check)}</td><td>${e(finding.severity)}</td><td>${e(finding.message)}</td><td>${e(finding.suggestion || '未提供')}</td></tr>`).join('') || '';
  const cards = devices.map(device => `<h3>GPU ${e(device.index)} · ${e(device.name || '名称不可用')}</h3><p>UUID：${e(device.uuid || 'N/A')} · PCI Bus ID：${e(device.busId || 'N/A')}</p><ul>${gpuDeviceMetrics(device).map(metric => `<li>${e(metric.label)}：${e(metric.value)}</li>`).join('')}</ul>`).join('');
  const job = diagnostic?.jobAnalysis;
  const processes = job?.processes.map(process => `<section><h3>PID ${e(process.pid)} · name：${e(process.name || 'N/A')} · starttime：${e(gpuMetric(process.starttime))}</h3><p>进程分析执行状态：${e(gpuExecutionStatusLabel(process.status))}</p><ul>${gpuJobProcessMetrics(process).map(metric => `<li>${e(metric.label)}：${e(metric.value)}</li>`).join('')}</ul><table><tr><th>检查项</th><th>级别</th><th>观测 / 证据</th><th>建议</th></tr>${process.findings.map(finding => `<tr><td>${e(finding.check)}</td><td>${e(finding.severity)}</td><td>${e(finding.message)}</td><td>${e(finding.suggestion || '未提供')}</td></tr>`).join('') || '<tr><td colspan="4">尚无进程诊断证据；缺测不代表正常。</td></tr>'}</table></section>`).join('') || '<p>没有已采集的作业进程；不补造 PID、资源指标或诊断结论。</p>';
  const jobReport = real ? `<h2>作业级深度剖析</h2><p>${e(gpuJobCapability)}</p><p>范围：本机 sysak ai 原生证据，选择 PID 仅查看本次已有证据；指标窗口：${e(gpuMetric(job?.sampleWindowSeconds, ' s'))}（原生未提供统一指标窗口；--threshold 1s 为诊断阈值，不是历史性能窗口）</p><p>来源：${e(job?.source || 'sysak ai（尚无作业采集结果）')} · 采集时间：${e(localTime(job?.sampledAt ?? null))}</p><p>NVML 资源指标覆盖：${e(gpuNvmlCoverage(state))} · GX 分析执行状态：${e(gpuExecutionStatusLabel(job?.status))}</p><p>GX 分析覆盖：${job ? job.complete ? '返回覆盖标记为完成，不等于完整性能剖析' : '部分覆盖 / 分析不可用，不代表正常' : '未取得分析结果，不代表正常'}</p><p>${e(job?.reason || '尚无作业分析结果；原生 ai 强依赖 GX，缺少 GX 则 ai 不可用；独立资源快照不代表 ai 已取得证据。')}</p>${processes}` : '';
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>本机 GPU 诊断报告</title><style>body{font:14px/1.7 system-ui;max-width:1000px;margin:32px auto;padding:0 24px;color:#24364d}table{width:100%;border-collapse:collapse}td,th{border:1px solid #dfe6ef;padding:8px;text-align:left;overflow-wrap:anywhere}</style></head><body><h1>本机 GPU 诊断报告</h1><p>SysAgent管家 · ${real ? 'IDC / sysak ai → 本地 OpenAPI mock 解析实际数据' : 'Demo / 离线 · 无本机采集证据'}</p><p>${e(gpuOverviewExplanation(state))}</p><h2>GPU 概览</h2><p>资源采集时间：${e(real ? localTime(resource.sampledAt || state.sampledAt || null) : '不可用')}</p>${cards || '<p>逐卡指标不可用。</p>'}<h2>GPU 诊断</h2><p>执行状态：${e(gpuDiagnosticStatusLabel(diagnostic))} · ${e(gpuDiagnosticOutcomeLabel(diagnostic))}</p><p>来源：${e(diagnostic?.source || 'sysak ai（尚无采集结果）')} · 采集时间：${e(localTime(diagnostic?.sampledAt ?? null))}</p><p>覆盖：${diagnostic ? diagnostic.complete ? '完整覆盖（本次工具检查范围）' : '部分覆盖 / 未完成' : '未检查'} · GPU 数量：${e(gpuMetric(diagnostic?.gpuCount))}</p><p>架构：${e(diagnostic?.architectures.join('、') || '不可用')} · 设备：${e(diagnostic?.devices.join('、') || '不可用')}</p><p>${e(diagnostic?.summary || '尚无诊断结果，不代表硬件正常。')}</p><table><thead><tr><th>检查项</th><th>级别</th><th>观测 / 证据</th><th>建议</th></tr></thead><tbody>${rows || '<tr><td colspan="4">尚无可用检查项；不推断正常。</td></tr>'}</tbody></table>${jobReport}<p>仅反映本次采集结果，缺失或部分检查不代表硬件正常。事件分析与离线 Profiling 为独立演示，不包含在此报告。</p></body></html>`;
}
export type GpuEventId = "vram-oob" | "hang" | "oom" | "gpu-comm";
export type ProfilingScenarioId = "train-throughput" | "multi-node" | "inference-latency" | "vram-growth";
export interface ProblemNavigation {
  question: string;
  evidence: string;
  direction: string;
  tab: Exclude<GpuTab, "overview">;
}
export interface GpuTimelineEntry {
  time: string;
  text: string;
}
export interface GpuEvent {
  id: GpuEventId;
  title: string;
  description: string;
  severity: "严重" | "高";
  job: string;
  scope: string;
  trigger: string;
  steps: string[];
  conclusion: string;
  confidence: "高" | "中";
  facts: string[];
  timeline: GpuTimelineEntry[];
  callStack: string[];
  support: string[];
  counter: string[];
  gap: string[];
  actions: string[];
}
export interface ProfilingMetric {
  label: string;
  value: string;
  tone?: "warn" | "good";
}
export type ProfilingSegmentKind = "python" | "data" | "h2d" | "compute" | "comm" | "wait" | "memory";
export interface ProfilingSegment {
  left: number;
  width: number;
  kind: ProfilingSegmentKind;
  label: string;
}
export interface ProfilingLane {
  label: string;
  segments: ProfilingSegment[];
}
export interface ProfilingHotspot {
  name: string;
  type: "Python" | "Kernel" | "Communication" | "System" | "Allocation";
  calls: string;
  total: string;
  share: string;
}
export interface ProfilingScenario {
  id: ProfilingScenarioId;
  title: string;
  description: string;
  metrics: ProfilingMetric[];
  lanes: ProfilingLane[];
  hotspots: ProfilingHotspot[];
  callPath: string[];
  finding: string;
  support: string[];
  counter: string[];
  uncertainty: string;
  suggestions: string[];
}
export const problemNavigation: ProblemNavigation[] = [{
  question: "本机 GPU 硬件是否异常",
  evidence: "sysak ai 经本地 OpenAPI 解析的检查项、执行状态与覆盖范围",
  direction: "按需检查硬件状态，查看实际证据与异常建议",
  tab: "inspection"
}, {
  question: "任务突然报错或卡住（独立演示）",
  evidence: "Xid / OOM / 进程退出事件、GPU 与容器指标、调用栈、通信状态",
  direction: "还原故障时间线，定位首个异常 Rank，并区分根因与级联现象",
  tab: "events"
}, {
  question: "本机作业进程资源与异常证据",
  evidence: "sysak ai 原生进程 CPU、SM、显存活动、RSS 及 HANG/NCCL/Xid 实际证据；统一指标窗口未提供",
  direction: "查看已采集进程及 NVML/GX 覆盖；不提供完整时间线或 Kernel 热点（离线性能页为独立演示）",
  tab: "profiling"
}];
export const gpuEvents: GpuEvent[] = [{
  id: "vram-oob",
  title: "显存访问越界",
  description: "训练进程收到 CUDA illegal memory access",
  severity: "严重",
  job: "sft-qwen-7b-exp12",
  scope: "gpu-node-03 · GPU 2 · Rank 18",
  trigger: "CUDA error 700 · 10:16:42",
  steps: ["关联 CUDA 错误、容器退出与 GPU 指标", "定位首个失败 Rank 与异常 Kernel", "解析 SASS 地址和越界访问范围", "回溯 Python / CUDA 调用链", "核对反例并生成处置建议"],
  conclusion: "fused_rope_fwd_kernel 在处理超长序列时读取了 KV Cache 边界外 512 B，Rank 18 是首个失败进程，其余 Rank 随通信组退出。",
  confidence: "高",
  facts: ["异常 Kernel：fused_rope_fwd_kernel<bf16>", "SASS：+0x1a40 · LDG.E.128", "输入序列 8,704 tokens，缓存上限 8,192", "越界地址距已分配区域末端 512 B"],
  timeline: [{
    time: "10:16:39.812",
    text: "Rank 18 开始处理 8,704-token batch"
  }, {
    time: "10:16:42.106",
    text: "GPU 2 捕获 illegal memory access"
  }, {
    time: "10:16:42.148",
    text: "Rank 18 首先退出"
  }, {
    time: "10:16:42.371",
    text: "其余 Rank 收到 NCCL communicator aborted"
  }],
  callStack: ["train.py:182 · train_step(batch)", "qwen.py:311 · model.forward(tokens)", "rope.py:96 · apply_rotary_pos_emb(q, k)", "rope_cuda.py:41 · fused_rope_forward(...)", "fused_rope_fwd_kernel<bf16> +0x1a40"],
  support: ["只有超过 8,192 tokens 的 batch 触发错误", "Compute Sanitizer 指向同一条 LDG 指令", "GPU ECC、温度和 PCIe 链路均正常"],
  counter: ["同节点其他任务持续正常，暂不支持硬件故障假设"],
  gap: ["缺少该自定义算子的边界检查符号信息"],
  actions: ["临时将 max_seq_len 限制为 8,192 后重试失败 batch", "为 fused RoPE 算子补充长度校验并运行边界用例", "保留 core dump 与 Sanitizer 报告供算子团队复核"]
}, {
  id: "hang",
  title: "训练或推理任务 HANG",
  description: "64 个 Rank 超过 15 分钟无 step 进展",
  severity: "高",
  job: "pretrain-moe-64r",
  scope: "8 节点 × 8 卡 · 64 Ranks",
  trigger: "step 2,841 停滞 · 14:21:05",
  steps: ["确认 step、吞吐和心跳同时停滞", "采集全部 Rank 的 Python 与通信栈", "构建 Rank 等待关系图", "定位最早阻塞的非通信调用", "核对存储与网络证据并生成报告"],
  conclusion: "Rank 37 在读取 NFS 训练分片时阻塞 12 秒，导致其余 63 个 Rank 等待 ncclAllReduce；通信等待是级联现象，不是根因。",
  confidence: "高",
  facts: ["首个阻塞：gpu-node-05 · GPU 5 · Rank 37", "Rank 37：DataLoader → NFS read，持续 12.0 s", "其余 63 Rank：ncclAllReduce 等待", "NFS p99 延迟同期从 28 ms 升至 12.1 s"],
  timeline: [{
    time: "14:02:52",
    text: "step 2,840 正常完成，耗时 1.91 s"
  }, {
    time: "14:02:54",
    text: "Rank 37 开始读取 shard-01987.tar"
  }, {
    time: "14:02:55",
    text: "其余 Rank 进入 ncclAllReduce"
  }, {
    time: "14:21:05",
    text: "无进展阈值触发自主分析"
  }],
  callStack: ["trainer.py:428 · next(train_dataloader)", "dataloader.py:701 · _next_data()", "dataset.py:214 · read_shard(path)", "io.py:89 · fd.read(8388608)", "nfs_client_read · waiting for server response"],
  support: ["所有通信等待边都最终指向 Rank 37", "NFS 延迟尖峰与 step 停滞时间一致", "IB 端口无丢包，NCCL async error 为空"],
  counter: ["NCCL watchdog 告警发生在阻塞之后 15 分钟"],
  gap: ["尚未获取 NFS 服务端慢请求日志"],
  actions: ["重新调度 Rank 37 并从 step 2,840 检查点恢复", "将热点分片预取到本地 NVMe，并设置读取超时", "联动存储侧核查 shard-01987.tar 所在卷"]
}, {
  id: "oom",
  title: "OOM 或反复重启",
  description: "推理容器 24 小时内发生 26 次 OOM 重启",
  severity: "高",
  job: "infer-chat-gw-v2",
  scope: "gpu-node-02 · Pod infer-chat-7f9d",
  trigger: "OOMKilled · 18:48:23",
  steps: ["聚合同一工作负载的重复重启事件", "对齐容器内存、显存和请求并发", "拆分模型、KV Cache 与 pinned memory", "定位持续增长的分配调用", "生成去重告警与容量建议"],
  conclusion: "容器 pinned memory 在 6 小时内由 61.8 GiB 增至 64 GiB 上限并触发 OOM；GPU 显存尚余 9 GiB，不是本次退出原因。",
  confidence: "高",
  facts: ["容器内存：61.8 → 64.0 GiB", "GPU 显存：71 / 80 GiB", "根因调用：request_cache.py:207 · pin_memory()", "26 条重复告警已合并为 1 个问题"],
  timeline: [{
    time: "12:40:00",
    text: "工作集 61.8 GiB，开始持续缓慢增长"
  }, {
    time: "18:47:58",
    text: "并发请求达到 148"
  }, {
    time: "18:48:23",
    text: "cgroup memory.max 触发 OOM kill"
  }, {
    time: "18:48:41",
    text: "Pod 第 26 次重新就绪"
  }],
  callStack: ["server.py:366 · handle_batch(requests)", "request_cache.py:207 · cache_tokens(batch)", "tensor.py:91 · tensor.pin_memory()", "c10::cuda::CUDACachingHostAllocator::allocate"],
  support: ["每次 OOM 前 pinned memory 都达到 cgroup 上限", "降低请求并发后增长斜率同步下降", "GPU Xid、ECC 和显存分配均无异常"],
  counter: ["显存占用较高，但退出时仍有 9 GiB 可用"],
  gap: ["需用生产流量回放验证缓存释放修复"],
  actions: ["限制 pinned request cache 为 48 GiB 并启用 LRU", "修复请求取消路径未释放 host tensor 的问题", "将 26 条重启告警按 Pod 与调用栈聚合去重"]
}, {
  id: "gpu-comm",
  title: "通信或 GPU 异常导致退出",
  description: "Xid 79 后多个 Rank 报告 ncclRemoteError",
  severity: "严重",
  job: "rl-ppo-v3",
  scope: "gpu-node-07 · GPU 3 · Rank 51",
  trigger: "Xid 79 · 22:37:02",
  steps: ["关联 Xid、NCCL 与业务进程退出事件", "识别时间线上最早出现的硬件信号", "采集 PCIe、NVLink 和 GPU 健康状态", "区分本地故障与远端级联错误", "生成隔离与复检建议"],
  conclusion: "gpu-node-07 的 GPU 3 在 PCIe 链路由 x16 降至 x4 后出现 Xid 79，Rank 51 首先断开，另外 15 个 Rank 的 ncclRemoteError 均为级联结果。",
  confidence: "中",
  facts: ["首个事件：Xid 79 · GPU has fallen off the bus", "PCIe 链路：Gen4 x16 → Gen4 x4", "首个退出：Rank 51，晚于 Xid 86 ms", "15 个远端 Rank 随后报告 ncclRemoteError"],
  timeline: [{
    time: "22:36:51",
    text: "PCIe replay counter 快速增加"
  }, {
    time: "22:37:01",
    text: "链路宽度由 x16 降至 x4"
  }, {
    time: "22:37:02",
    text: "GPU 3 报告 Xid 79"
  }, {
    time: "22:37:02",
    text: "Rank 51 退出，远端 Rank 级联失败"
  }],
  callStack: ["ppo_trainer.py:519 · optimizer.step()", "distributed.py:141 · all_reduce(grad)", "ProcessGroupNCCL.cpp · ncclAllReduce", "transport/net.cc · ncclRemoteError"],
  support: ["Xid 早于业务进程退出和 NCCL 错误", "sysak ai 复检仍观察到 PCIe x4 降级", "同节点其余 GPU 未发现相同错误"],
  counter: ["重启驱动后 GPU 可重新枚举，尚不能确认永久硬件损坏"],
  gap: ["需冷重启后运行 PCIe 压力复检"],
  actions: ["隔离 gpu-node-07/GPU 3，避免继续调度生产任务", "冷重启后执行 PCIe、显存和 NCCL 全量复检", "若链路继续降级，检查插槽、转接板并更换 GPU"]
}];
export const profilingScenarios: ProfilingScenario[] = [{
  id: "train-throughput",
  title: "训练吞吐上不去",
  description: "识别数据加载、CPU 调度与 GPU 计算流水线中的空洞",
  metrics: [{
    label: "GPU 有效利用率",
    value: "38%",
    tone: "warn"
  }, {
    label: "平均 Step",
    value: "1.82 s"
  }, {
    label: "DataLoader 占比",
    value: "49%",
    tone: "warn"
  }, {
    label: "GEMM Tensor Core",
    value: "82%",
    tone: "good"
  }],
  lanes: [{
    label: "Python",
    segments: [{
      left: 1,
      width: 45,
      kind: "data",
      label: "DataLoader 890ms"
    }, {
      left: 49,
      width: 9,
      kind: "python",
      label: "forward"
    }, {
      left: 61,
      width: 14,
      kind: "python",
      label: "backward"
    }, {
      left: 79,
      width: 8,
      kind: "python",
      label: "optimizer"
    }]
  }, {
    label: "GPU 0",
    segments: [{
      left: 1,
      width: 45,
      kind: "wait",
      label: "等待数据"
    }, {
      left: 48,
      width: 7,
      kind: "h2d",
      label: "H2D"
    }, {
      left: 56,
      width: 17,
      kind: "compute",
      label: "GEMM"
    }, {
      left: 74,
      width: 10,
      kind: "compute",
      label: "Attention"
    }, {
      left: 85,
      width: 9,
      kind: "comm",
      label: "AllReduce"
    }]
  }],
  hotspots: [{
    name: "DataLoader._next_data",
    type: "Python",
    calls: "240",
    total: "213.6 s",
    share: "49.0%"
  }, {
    name: "ampere_sgemm_128x64",
    type: "Kernel",
    calls: "7,680",
    total: "82.4 s",
    share: "18.9%"
  }, {
    name: "ncclKernel_AllReduce",
    type: "Communication",
    calls: "1,920",
    total: "31.7 s",
    share: "7.3%"
  }],
  callPath: ["train.py:182", "trainer.py:441 · train_step", "dataloader.py:701 · _next_data", "dataset.py:214 · decode_sample"],
  finding: "GPU 每个 step 前平均等待数据 890 ms，主要瓶颈在单进程解码和同步读取，而不是模型 Kernel。",
  support: ["DataLoader 占 step 的 49%", "GPU 等待区间与 CPU 解码完全重合", "计算期间 Tensor Core 利用率达到 82%"],
  counter: ["NCCL 只占 7.3%，不支持通信是主瓶颈的假设"],
  uncertainty: "采样覆盖 240 steps，未包含 checkpoint 保存阶段。",
  suggestions: ["num_workers 从 2 调至 8，并启用 persistent_workers", "启用 pin_memory 与 prefetch_factor=4", "将训练分片缓存至本地 NVMe 后复测吞吐"]
}, {
  id: "multi-node",
  title: "多机扩展后变慢",
  description: "对比 Rank 时间线，区分网络带宽与慢节点长尾",
  metrics: [{
    label: "8 节点扩展效率",
    value: "61%",
    tone: "warn"
  }, {
    label: "AllReduce",
    value: "410 ms"
  }, {
    label: "总线带宽",
    value: "182 GB/s",
    tone: "good"
  }, {
    label: "Rank 13 长尾",
    value: "+210 ms",
    tone: "warn"
  }],
  lanes: [{
    label: "Rank 0",
    segments: [{
      left: 2,
      width: 31,
      kind: "compute",
      label: "backward"
    }, {
      left: 34,
      width: 22,
      kind: "comm",
      label: "AllReduce"
    }, {
      left: 57,
      width: 28,
      kind: "wait",
      label: "等待 Rank 13"
    }]
  }, {
    label: "Rank 13",
    segments: [{
      left: 2,
      width: 50,
      kind: "python",
      label: "CPU 调度长尾"
    }, {
      left: 53,
      width: 22,
      kind: "comm",
      label: "AllReduce"
    }]
  }],
  hotspots: [{
    name: "ncclKernel_AllReduce_RING",
    type: "Communication",
    calls: "960",
    total: "98.4 s",
    share: "23.0%"
  }, {
    name: "optimizer.step",
    type: "Python",
    calls: "120",
    total: "73.2 s",
    share: "17.1%"
  }, {
    name: "cgroup CPU throttling",
    type: "System",
    calls: "318",
    total: "25.1 s",
    share: "5.9%"
  }],
  callPath: ["trainer.py:503", "optimizer.py:174 · step", "torch/distributed.py · all_reduce", "ncclKernel_AllReduce_RING"],
  finding: "网络带宽达到预期，但 node-04 的 Rank 13 因 CPU throttling 晚进入集合通信，放大为所有 Rank 的等待。",
  support: ["Rank 13 每 step 比中位数晚 210 ms", "node-04 CPU 被节流 31%", "NCCL bus bandwidth 182 GB/s，接近基线"],
  counter: ["IB 丢包率低于 0.01%，不支持网络拥塞假设"],
  uncertainty: "只覆盖一个 20 分钟窗口，需在其他节点轮换任务以排除数据分片影响。",
  suggestions: ["将 node-04 CPU quota 从 16 核调整为 32 核", "为 DataLoader 与通信线程预留 CPU", "迁移 Rank 13 后进行 A/B Profiling"]
}, {
  id: "inference-latency",
  title: "推理延迟或并发异常",
  description: "分解排队、预处理、Prefill 与 Decode 阶段",
  metrics: [{
    label: "P99 TTFT",
    value: "2.4 s",
    tone: "warn"
  }, {
    label: "目标 TTFT",
    value: "1.0 s"
  }, {
    label: "Tokenizer GIL",
    value: "37%",
    tone: "warn"
  }, {
    label: "并发上限",
    value: "16 req"
  }],
  lanes: [{
    label: "Request",
    segments: [{
      left: 1,
      width: 26,
      kind: "wait",
      label: "Queue"
    }, {
      left: 28,
      width: 21,
      kind: "python",
      label: "Tokenizer"
    }, {
      left: 51,
      width: 20,
      kind: "compute",
      label: "Prefill"
    }, {
      left: 73,
      width: 23,
      kind: "compute",
      label: "Decode"
    }]
  }, {
    label: "GPU 0",
    segments: [{
      left: 1,
      width: 48,
      kind: "wait",
      label: "批处理等待"
    }, {
      left: 51,
      width: 19,
      kind: "compute",
      label: "Prefill"
    }, {
      left: 72,
      width: 24,
      kind: "compute",
      label: "Decode"
    }]
  }],
  hotspots: [{
    name: "tokenizer.encode_batch",
    type: "Python",
    calls: "4,812",
    total: "51.2 s",
    share: "37.0%"
  }, {
    name: "paged_attention_v2",
    type: "Kernel",
    calls: "31,440",
    total: "26.8 s",
    share: "19.4%"
  }, {
    name: "scheduler.wait_for_batch",
    type: "Python",
    calls: "4,812",
    total: "22.1 s",
    share: "16.0%"
  }],
  callPath: ["api.py:219", "engine.py:381 · add_request", "tokenizer.py:144 · encode_batch", "scheduler.py:271 · schedule"],
  finding: "请求在 CPU tokenizer 与过小的批处理预算上排队，GPU 尚有容量但并发被 max_num_batched_tokens=4096 限制。",
  support: ["Tokenizer 持有 GIL 的时间占 37%", "GPU 平均利用率仅 52%", "批处理预算命中率达到 96%"],
  counter: ["Decode Kernel 延迟与基线一致，不支持 GPU 退化假设"],
  uncertainty: "结果基于固定输入长度回放，真实流量长度分布可能改变收益。",
  suggestions: ["将 tokenizer 移至独立进程池", "在显存水位允许时将 max_num_batched_tokens 调至 8192", "以并发 16/24/32 做阶梯压测"]
}, {
  id: "vram-growth",
  title: "显存持续增长",
  description: "追踪分配调用、存活对象与 KV Cache 生命周期",
  metrics: [{
    label: "6 小时显存",
    value: "52 → 76 GB",
    tone: "warn"
  }, {
    label: "KV Cache",
    value: "58%"
  }, {
    label: "未释放 Tensor",
    value: "18.6 GB",
    tone: "warn"
  }, {
    label: "分配失败",
    value: "0",
    tone: "good"
  }],
  lanes: [{
    label: "显存",
    segments: [{
      left: 1,
      width: 35,
      kind: "memory",
      label: "模型 28 GB"
    }, {
      left: 37,
      width: 38,
      kind: "compute",
      label: "KV Cache 30 GB"
    }, {
      left: 76,
      width: 20,
      kind: "data",
      label: "残留 18.6 GB"
    }]
  }, {
    label: "请求",
    segments: [{
      left: 1,
      width: 18,
      kind: "python",
      label: "Req 1"
    }, {
      left: 22,
      width: 20,
      kind: "python",
      label: "Req 2"
    }, {
      left: 45,
      width: 20,
      kind: "python",
      label: "Req 3"
    }, {
      left: 68,
      width: 27,
      kind: "wait",
      label: "Tensor 仍存活"
    }]
  }],
  hotspots: [{
    name: "metrics.py:44 history.append",
    type: "Allocation",
    calls: "18,420",
    total: "18.6 GB",
    share: "77.5%"
  }, {
    name: "kv_cache.allocate_blocks",
    type: "Allocation",
    calls: "4,810",
    total: "4.1 GB",
    share: "17.1%"
  }, {
    name: "torch.cat",
    type: "Kernel",
    calls: "9,612",
    total: "1.3 GB",
    share: "5.4%"
  }],
  callPath: ["server.py:366", "callback.py:102 · on_request_end", "metrics.py:44 · history.append(logits.detach())", "CUDACachingAllocator::malloc"],
  finding: "监控回调把 logits.detach() 长期保存在 history 列表中，18.6 GB Tensor 在请求结束后仍被 Python 引用。",
  support: ["引用链全部指向 metrics.history", "清空列表后 reserved memory 下降 18.4 GB", "KV Cache 水位随活跃请求正常回落"],
  counter: ["缓存分配器 reserved memory 较高，但不是存活对象增长的来源"],
  uncertainty: "尚未验证长时间运行下修复后的指标采样需求。",
  suggestions: ["只保存聚合标量，不保存完整 logits Tensor", "对 history 设置固定长度并迁移到 CPU", "修复后运行 12 小时显存稳定性回归"]
}];
