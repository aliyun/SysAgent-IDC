import { recognizeAgent, resourceLabels, type GpuDevice, type GpuDiagnostic, type GpuFinding, type GpuJobAnalysis, type ResourceId, type HealthState, type Inspection, type ResourceRow, type ResourceSnapshot } from './src/health-data';

type ObjectValue = Record<string, unknown>;
const obj = (value: unknown): value is ObjectValue => value !== null && typeof value === 'object' && !Array.isArray(value);
const number = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const positive = (value: unknown): value is number => number(value) && value > 0;
const percent = (value: number) => Math.round(Math.max(0, Math.min(100, value)) * 10) / 10;
const text = (value: unknown, fallback: string) => typeof value === 'string' ? value.slice(0, 256) : fallback;
const CRITICAL_LOG_CATEGORIES = ['hung_task', 'soft_lockup', 'hard_lockup', 'rcu_stall', 'fs_error', 'io_error', 'oom', 'nfs_hang', 'gpu_xid'];
function entries(value: unknown): ObjectValue[] {
  return Array.isArray(value) ? value.filter(obj) : [];
}
// schema 1.1 的段数据与 status/reason 同级，没有 1.0 的 content 包装。
function section(raw: ObjectValue, name: string): ObjectValue | undefined {
  const sections = obj(raw.sections) ? raw.sections : {};
  return obj(sections[name]) ? sections[name] as ObjectValue : undefined;
}
const usable = (value: ObjectValue | undefined) => !!value && ['ok', 'partial'].includes(String(value.status));
const reasonOf = (value: ObjectValue | undefined) => {
  const reason = value?.reason;
  return typeof reason === 'string' && reason ? `；原因 ${reason}` : '';
};
function row(id: string, name: string, detail: string, usage: number, extra: Partial<ResourceRow> = {}): ResourceRow {
  return { id, name, detail, usage, cleanable: false, defaultSelected: false, effect: '只读采集，不支持清理', ...extra };
}
function measured(resource: ResourceSnapshot, usage: number | null, evidence: unknown, note: string) {
  resource.usage = usage;
  resource.status = usage === null && !resource.quantity ? 'unavailable' : obj(evidence) && evidence.status !== 'ok' ? 'partial' : 'available';
  resource.note = note;
}
function identityOf(process: ObjectValue): { pid: number; starttime: number; agentKind?: string } | undefined {
  const pid = process.pid;
  const starttime = process.starttime;
  if (!Number.isSafeInteger(pid) || !number(pid) || pid <= 1 || !Number.isSafeInteger(starttime) || !number(starttime)) return;
  const agentKind = recognizeAgent(text(process.comm, ''));
  return { pid, starttime, ...(agentKind ? { agentKind } : {}) };
}
function rankRows(rows: ResourceRow[]) {
  rows.sort((a, b) => b.usage - a.usage || (a.pid ?? 0) - (b.pid ?? 0));
  return [...new Map([...rows.slice(0, 20), ...rows.filter(item => item.agentKind).slice(0, 20)].map(item => [item.id, item])).values()];
}
function processRows(raw: ObjectValue, output: HealthState['resources'], totalMemory: number | undefined) {
  const process = section(raw, 'process');
  const io = section(raw, 'io');
  for (const item of entries(process?.top_cpu)) {
    const identity = identityOf(item);
    const usage = item.cpu_pct_node;
    if (!identity || !number(usage) || usage > 100) continue;
    output.cpu.rows.push(row(`process-${identity.pid}-${identity.starttime}`, text(item.comm, `PID ${identity.pid}`), `PID ${identity.pid} · 占整机 CPU 容量`, percent(usage), identity));
  }
  for (const item of entries(process?.top_rss)) {
    const identity = identityOf(item);
    if (!identity || !number(item.rss_kb)) continue;
    const bytes = item.rss_kb * 1024;
    if (!Number.isSafeInteger(bytes) || !positive(totalMemory) || bytes > totalMemory) continue;
    output.memory.rows.push(row(`process-${identity.pid}-${identity.starttime}`, text(item.comm, `PID ${identity.pid}`), `PID ${identity.pid} · RSS 常驻内存，共享页可能重复计入`, percent(bytes / totalMemory * 100), { ...identity, quantity: { value: bytes, unit: 'B' } }));
  }
  const diskRows = new Map<string, ResourceRow>();
  for (const item of entries(io?.by_disk)) {
    const identity = identityOf(item);
    const rate = item.disk_bytes_per_sec;
    if (!identity || !number(rate)) continue;
    const id = `process-${identity.pid}-${identity.starttime}`;
    diskRows.set(id, row(id, text(item.comm, `PID ${identity.pid}`), `PID ${identity.pid} · 块设备读写吞吐，不代表磁盘空间归属`, rate, { ...identity, quantity: { value: rate, unit: 'B/s' } }));
  }
  for (const item of entries(io?.by_vfs)) {
    const identity = identityOf(item);
    const rate = item.vfs_bytes_per_sec;
    if (!identity || !number(rate)) continue;
    const id = `process-${identity.pid}-${identity.starttime}`;
    if (diskRows.has(id)) continue;
    diskRows.set(id, row(id, text(item.comm, `PID ${identity.pid}`), `PID ${identity.pid} · VFS 读写吞吐（含页缓存），不代表磁盘空间归属`, rate, { ...identity, quantity: { value: rate, unit: 'B/s' } }));
  }
  output.disk.rows.push(...diskRows.values());
  const coverage = !usable(process) ? '进程段不可用' : process!.status === 'ok' && process!.truncated !== true ? '已完成有界采样' : '部分缺失、权限受限或扫描截断';
  output.cpu.rows = rankRows(output.cpu.rows);
  output.memory.rows = rankRows(output.memory.rows);
  output.disk.rows = rankRows(output.disk.rows);
  for (const id of ['cpu', 'memory', 'disk'] as const) output[id].note += `；进程排行仅覆盖可见 /proc 的 top_n 窗口，${coverage}`;
}
function gpuNumber(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number | null {
  const parsed = typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value.trim()) ? Number(value.trim()) : value;
  return number(parsed) && parsed <= maximum ? parsed : null;
}
function gpuBytes(value: unknown): number | null {
  const mib = gpuNumber(value);
  return mib !== null && Number.isSafeInteger(mib * 1024 * 1024) ? mib * 1024 * 1024 : null;
}
function gpuResource(raw: ObjectValue, resource: ResourceSnapshot): boolean {
  const data = section(raw, 'gpu');
  if (!data) {
    resource.note = 'idc_inspect 未返回 gpu 段，不能判断硬件状态';
    return true;
  }
  resource.gpuDevices = [];
  if (data.available !== true || !Array.isArray(data.devices)) {
    resource.note = `nvidia-smi GPU 快照不可用：${text(data.reason, '工具、驱动或权限不可用')}；不代表没有 GPU`;
    return true;
  }
  const seen = new Set<number>();
  for (const device of entries(data.devices).slice(0, 32)) {
    const index = gpuNumber(device.index);
    if (index === null || !Number.isSafeInteger(index) || seen.has(index)) continue;
    seen.add(index);
    let used = gpuBytes(device.mem_used_mb);
    const total = gpuBytes(device.mem_total_mb);
    if (used !== null && total !== null && used > total) used = null;
    const gpu: GpuDevice = {
      index, name: text(device.name, 'GPU'), uuid: text(device.uuid, ''), busId: text(device.bus_id, ''),
      utilization: gpuNumber(device.util_pct, 100), memoryUtilization: gpuNumber(device.mem_util_pct, 100),
      memoryUsedBytes: used, memoryTotalBytes: total,
      temperatureCelsius: gpuNumber(device.temp_c), powerWatts: gpuNumber(device.power_draw_w), powerLimitWatts: gpuNumber(device.power_limit_w),
      eccCorrected: gpuNumber(device.ecc_corr), eccUncorrected: gpuNumber(device.ecc_uncorr),
      pcieGeneration: gpuNumber(device.pcie_gen_cur), pcieMaxGeneration: gpuNumber(device.pcie_gen_max), pcieWidth: gpuNumber(device.pcie_width),
    };
    resource.gpuDevices.push(gpu);
    if (gpu.utilization !== null) {
      const detail = [used !== null && total !== null ? `显存 ${used / 1048576}/${total / 1048576} MiB` : '显存不可用', gpu.powerWatts !== null ? `${gpu.powerWatts} W` : '功率不可用', gpu.temperatureCelsius !== null ? `${gpu.temperatureCelsius} °C` : '温度不可用'].join(' · ');
      resource.rows.push(row(`gpu-${index}`, gpu.name, detail, gpu.utilization));
    }
  }
  const devices = resource.gpuDevices;
  if (devices.length && devices.every(device => device.memoryUsedBytes !== null && device.memoryTotalBytes !== null)) {
    const total = devices.reduce((sum, device) => sum + device.memoryTotalBytes!, 0);
    const used = devices.reduce((sum, device) => sum + device.memoryUsedBytes!, 0);
    if (total > 0 && Number.isSafeInteger(total) && Number.isSafeInteger(used)) resource.quantity = { value: used, unit: 'B', total, available: total - used };
  }
  const usage = resource.rows.length ? Math.max(...resource.rows.map(device => device.usage)) : null;
  measured(resource, usage, data, 'idc_inspect nvidia-smi 单次 GPU 快照；多卡显示最高利用率，无历史曲线或进程 GPU 利用率归属');
  if (!devices.length) {
    resource.note = data.devices.length === 0 && data.status === 'ok' ? 'idc_inspect nvidia-smi 查询成功，未检测到可见 NVIDIA GPU' : 'idc_inspect GPU 设备数据无效，不能判断硬件状态';
  } else if (devices.length !== data.devices.length || data.gpu_count !== devices.length || data.status !== 'ok' || devices.some(device => Object.values(device).some(value => value === null) || !device.uuid)) {
    resource.status = 'partial';
  }
  resource.rows.sort((a, b) => b.usage - a.usage);
  return !(data.status === 'ok' && data.available === true && data.devices.length === 0 && data.gpu_count === 0);
}
function energyResource(raw: ObjectValue, resource: ResourceSnapshot) {
  const data = section(raw, 'energy');
  if (!data) return;
  const watts = data.total_watts;
  if (data.available !== true || !number(watts)) {
    resource.note = `RAPL 能耗不可用：${text(data.reason, '平台未暴露 package 能量域')}；不估算整机功耗`;
    return;
  }
  const seen = new Set<string>();
  for (const zone of entries(data.zones).slice(0, 32)) {
    if (typeof zone.name !== 'string' || seen.has(zone.name) || !number(zone.watts)) continue;
    seen.add(zone.name);
    resource.rows.push(row(`rapl-${zone.name}`, text(zone.label, zone.name), 'CPU package RAPL 能量差分；非整机功耗', zone.watts, { quantity: { value: zone.watts, unit: 'W' } }));
  }
  if (!resource.rows.length) return;
  resource.quantity = { value: watts, unit: 'W' };
  measured(resource, null, data, 'CPU package RAPL 平均功率；不叠加重叠子域，不估算进程能耗或预算百分比');
  const unresolved = data.unresolved_wrap;
  const denied = data.denied;
  if (data.nr_zones !== resource.rows.length || number(unresolved) && unresolved > 0 || number(denied) && denied > 0) resource.status = 'partial';
  resource.rows.sort((a, b) => b.usage - a.usage);
}
function inspection(id: string, label: string, important: boolean, phase: 1 | 2): Inspection {
  return { id, label, important, phase, status: 'unchecked', usage: null, detail: '尚未接入真实诊断', evidence: [] };
}
function setInspection(item: Inspection, usage: number | null, detail: string, evidence: string[]) {
  item.usage = usage;
  item.status = usage === null ? 'unchecked' : usage > 90 ? 'abnormal' : 'normal';
  item.detail = detail;
  item.evidence = evidence;
}
function gpuFindings(value: unknown): GpuFinding[] {
  return entries(value).slice(0, 256).filter(item => typeof item.check === 'string' && typeof item.message === 'string' && ['OK', 'WARN', 'ERROR'].includes(String(item.severity))).map(item => ({
    check: (item.check as string).slice(0, 128), severity: item.severity as GpuFinding['severity'], message: (item.message as string).slice(0, 1024),
    ...(typeof item.suggestion === 'string' ? { suggestion: item.suggestion.slice(0, 1024) } : {}),
  }));
}
function gpuJobs(value: unknown, sampledAt: string, wrapperStatus: GpuDiagnostic['status']): GpuJobAnalysis {
  const result: GpuJobAnalysis = { status: 'unavailable', source: 'sysak ai', sampledAt, sampleWindowSeconds: null, complete: false, reason: 'AI 未返回可用作业证据', processes: [] };
  if (!obj(value) || !['ok', 'partial', 'unavailable', 'error', 'timeout'].includes(String(value.status)) || !Array.isArray(value.processes)) return result;
  result.status = value.status as GpuDiagnostic['status'];
  if (!['ok', 'partial'].includes(wrapperStatus)) result.status = wrapperStatus;
  result.reason = text(value.reason, '作业检查覆盖未知');
  result.sampleWindowSeconds = gpuNumber(value.sample_window_seconds, 10);
  const seen = new Set<number>();
  for (const process of entries(value.processes).slice(0, 128)) {
    const pid = gpuNumber(process.pid, 2147483647);
    if (pid === null || pid === 0 || !Number.isSafeInteger(pid) || seen.has(pid) || typeof process.name !== 'string' || typeof process.state !== 'string' || !Array.isArray(process.gpu_indices)) continue;
    if (!['not_run', 'ok', 'partial', 'unavailable', 'error', 'timeout'].includes(String(process.status))) continue;
    seen.add(pid);
    const nullableNumber = (value: unknown, maximum = Number.MAX_SAFE_INTEGER) => value === null || number(value) && value <= maximum;
    const nullableInteger = (value: unknown) => value === null || number(value) && Number.isSafeInteger(value);
    const starttime = nullableInteger(process.starttime) && process.starttime !== null ? process.starttime as number : null;
    const rss = nullableInteger(process.rss_bytes) && process.rss_bytes !== null ? process.rss_bytes as number : null;
    const gpuIndices = [...new Set(process.gpu_indices.filter((index): index is number => Number.isSafeInteger(index) && number(index) && index < 32))].slice(0, 32);
    const findings = gpuFindings(process.findings);
    const valid = number(process.pid) && process.name.length <= 256 && process.state.length <= 16 && nullableInteger(process.starttime) && nullableInteger(process.rss_bytes) &&
      nullableNumber(process.cpu_percent) && nullableNumber(process.sm_utilization, 100) && nullableNumber(process.memory_utilization, 100) &&
      gpuIndices.length === process.gpu_indices.length && gpuIndices.length > 0 && Array.isArray(process.findings) && findings.length === process.findings.length;
    result.processes.push({
      pid, starttime, name: process.name.slice(0, 256), state: process.state.slice(0, 16),
      cpuPercent: number(process.cpu_percent) ? process.cpu_percent : null, rssBytes: rss, gpuIndices,
      smUtilization: number(process.sm_utilization) && process.sm_utilization <= 100 ? process.sm_utilization : null,
      memoryUtilization: number(process.memory_utilization) && process.memory_utilization <= 100 ? process.memory_utilization : null,
      status: !valid && process.status === 'ok' ? 'partial' : process.status as GpuDiagnostic['status'], findings,
    });
  }
  result.complete = result.status === 'ok' && value.complete === true && number(value.sample_window_seconds) && value.sample_window_seconds > 0 && value.sample_window_seconds <= 10 && typeof value.reason === 'string' && result.processes.length === value.processes.length && result.processes.every(process => process.status === 'ok');
  if (!result.complete && result.status === 'ok') result.status = 'partial';
  return result;
}
function aiMetrics(value: unknown): GpuDevice[] {
  const seen = new Set<number>();
  return entries(value).slice(0, 32).flatMap(device => {
    if (!Number.isSafeInteger(device.index) || !number(device.index) || device.index >= 32 || seen.has(device.index) || !['name', 'uuid', 'busId'].every(key => typeof device[key] === 'string')) return [];
    seen.add(device.index);
    const metric = { index: device.index, name: (device.name as string).slice(0, 256), uuid: (device.uuid as string).slice(0, 256), busId: (device.busId as string).slice(0, 256) } as GpuDevice;
    for (const key of ['utilization', 'memoryUtilization', 'memoryUsedBytes', 'memoryTotalBytes', 'temperatureCelsius', 'powerWatts', 'powerLimitWatts', 'eccCorrected', 'eccUncorrected', 'pcieGeneration', 'pcieMaxGeneration', 'pcieWidth'] as const) {
      const value = device[key];
      const integer = ['memoryUsedBytes', 'memoryTotalBytes', 'eccCorrected', 'eccUncorrected', 'pcieGeneration', 'pcieMaxGeneration', 'pcieWidth'].includes(key);
      metric[key] = number(value) && value <= (key === 'utilization' || key === 'memoryUtilization' ? 100 : Number.MAX_SAFE_INTEGER) && (!integer || Number.isSafeInteger(value)) ? value : null;
    }
    if (metric.memoryUsedBytes !== null && metric.memoryTotalBytes !== null && metric.memoryUsedBytes > metric.memoryTotalBytes) metric.memoryUsedBytes = null;
    return [metric];
  });
}
function gpuDiagnostic(evidence: unknown, sampledAt: string): GpuDiagnostic {
  const result: GpuDiagnostic = { status: 'not_run', outcome: 'unknown', sampledAt: null, source: 'sysak ai', complete: false, gpuCount: null, architectures: [], devices: [], summary: '尚未取得 GPU 作业诊断证据；当前 sysAK 未提供 ai 报告，GPU 资源快照不代表硬件健康结论', findings: [] };
  if (!obj(evidence)) return result;
  const statuses: GpuDiagnostic['status'][] = ['ok', 'partial', 'unavailable', 'error', 'timeout', 'truncated', 'permission_denied'];
  result.status = statuses.includes(evidence.status as GpuDiagnostic['status']) ? evidence.status as GpuDiagnostic['status'] : 'error';
  result.sampledAt = typeof evidence.sampled_at === 'string' && Number.isFinite(Date.parse(evidence.sampled_at)) ? evidence.sampled_at : sampledAt;
  result.summary = `GPU 诊断${result.status === 'timeout' ? '超时' : result.status === 'unavailable' ? '不可用，组件未安装或工具缺失' : '未完整返回'}；不能判断硬件正常`;
  const data = obj(evidence.content) ? evidence.content : undefined;
  if (!data) return result;
  if (data.schema_version !== '1.0' || data.tool !== 'ai' || data.mode !== 'native' || data.read_only !== false || !['ok', 'partial', 'unavailable', 'error', 'timeout'].includes(String(data.status)) || !Array.isArray(data.details)) {
    result.status = 'error';
    result.summary = 'ai 返回数据无效，不能判断硬件状态';
    return result;
  }
  if (['ok', 'partial'].includes(result.status) && data.status !== 'ok') result.status = data.status as GpuDiagnostic['status'];
  const count = data.gpu_count;
  result.gpuCount = number(count) && Number.isSafeInteger(count) && count <= 32 ? count : null;
  result.architectures = Array.isArray(data.gpu_arch) ? data.gpu_arch.filter((value): value is string => typeof value === 'string').slice(0, 32).map(value => value.slice(0, 256)) : [];
  result.devices = Array.isArray(data.gpu_devices) ? data.gpu_devices.filter((value): value is string => typeof value === 'string').slice(0, 32).map(value => value.slice(0, 256)) : [];
  result.findings = gpuFindings(data.details);
  result.jobAnalysis = gpuJobs(data.job_analysis, result.sampledAt!, result.status);
  const coverage = obj(data.coverage) ? data.coverage : undefined;
  const metadataComplete = Array.isArray(data.gpu_arch) && result.architectures.length === data.gpu_arch.length && Array.isArray(data.gpu_devices) && result.devices.length === data.gpu_devices.length &&
    result.gpuCount !== null && result.devices.length === result.gpuCount && (result.gpuCount !== 0 || result.architectures.length === 0);
  const evidenceConsistent = result.gpuCount !== 0 || !result.findings.some(finding => finding.severity !== 'OK') && (!Array.isArray(data.gpu_metrics) || data.gpu_metrics.length === 0);
  result.complete = result.status === 'ok' && data.status === 'ok' && coverage?.complete === true && metadataComplete && evidenceConsistent && result.findings.length === data.details.length && (result.gpuCount === 0 || result.findings.length > 0);
  const executionChecks = new Set(['coverage', 'driver', 'smi_exists', 'nvml', 'gx', 'collection', 'pci_inventory']);
  if (result.findings.some(finding => executionChecks.has(finding.check) && finding.severity !== 'OK')) result.complete = false;
  const errors = result.findings.filter(value => !executionChecks.has(value.check) && value.severity === 'ERROR' && result.gpuCount !== 0).length;
  const warnings = result.findings.filter(value => !executionChecks.has(value.check) && value.severity === 'WARN' && result.gpuCount !== 0).length;
  if (errors || warnings) {
    result.outcome = 'abnormal';
    result.summary = `GPU 诊断发现 ${errors} 项错误、${warnings} 项告警${result.complete ? '' : '；部分检查未完成，不能推断其余项正常'}`;
  } else if (result.complete && result.gpuCount === 0) {
    result.outcome = 'no_gpu';
    result.summary = 'ai 已完成 PCI 设备枚举，未检测到 GPU';
  } else if (result.complete) {
    result.outcome = 'normal';
    result.summary = `已完成 ${result.findings.length} 项 GPU 检查，未发现告警；仅代表本次检查范围`;
  } else {
    result.summary = `GPU 诊断${result.status === 'timeout' ? '超时' : result.status === 'unavailable' ? '不可用' : result.status === 'error' ? '执行失败' : '部分完成'}，不能判断整体正常：${text(coverage?.reason, '检查或指标缺失')}`;
  }
  if (!result.complete && result.status === 'ok') result.status = 'partial';
  return result;
}
function runInspections(raw: ObjectValue, inspections: Inspection[], sampledAt: string, hasGpu: boolean) {
  const rootItem = inspections.find((item) => item.id === 'root')!;
  const fdItem = inspections.find((item) => item.id === 'fd')!;
  const memoryItem = inspections.find((item) => item.id === 'memory')!;
  const logItem = inspections.find((item) => item.id === 'logs')!;
  const gpuItem = inspections.find((item) => item.id === 'gpu')!;
  const disk = section(raw, 'disk');
  const root = entries(disk?.mounts).find((mount) => mount.target === '/' && mount.status !== 'error');
  const size = root?.size_bytes;
  const avail = root?.avail_bytes;
  const rootUsage = usable(disk) && root && positive(size) && number(avail) && avail <= size ? percent((size - avail) / size * 100) : null;
  const hung = entries(disk?.hung_mounts);
  const rootEvidence = ['sysAK idc_inspect disk.mounts', `采集时间 ${sampledAt}`, '容量阈值：严格大于 90%'];
  if (root) {
    rootEvidence.push(`根文件系统 ${text(root.source, '未知设备')} · ${text(root.fstype, '未知文件系统')}${root.read_only === true ? ' · 只读挂载' : ''}${root.is_network === true ? ' · 网络文件系统' : ''}`);
    if (number(size)) rootEvidence.push(`容量 ${size} B；可用 ${number(avail) ? avail : '不可用'} B`);
    if (number(root.inodes) && number(root.inodes_free)) rootEvidence.push(`inode 空闲 ${root.inodes_free}/${root.inodes}${number(root.inodes_used_pct) ? ` · inode 使用率 ${root.inodes_used_pct}%` : ''}`);
  }
  if (hung.length) rootEvidence.push(`疑似 hang 挂载点：${hung.slice(0, 5).map((mount) => `${text(mount.target, '/')}（${text(mount.fstype, '未知')}）`).join('、')}`);
  const skipped = disk?.skipped;
  if (number(skipped) && skipped > 0) rootEvidence.push(`跳过 ${skipped} 个挂载点：时间预算、权限或类型限制`);
  rootEvidence.push(`disk 段状态 ${text(disk?.status, '缺失')}${reasonOf(disk)}`);
  delete rootItem.execution;
  rootItem.execution = !usable(disk) || !root ? 'unavailable' : disk!.status === 'ok' && rootUsage !== null && !hung.length ? 'complete' : 'partial';
  setInspection(rootItem, rootUsage, rootUsage === null ? `根文件系统容量不可用：${text(disk?.reason, 'disk 段缺失或根挂载点不可读')}；本次未检查` : `根文件系统使用率 ${rootUsage}%${rootUsage > 90 ? '，超过 90%' : '，未超过 90%'}${hung.length ? '；存在疑似 hang 挂载点' : ''}；容量来自 statvfs，不做目录大小扫描`, rootEvidence);
  const memory = section(raw, 'memory');
  const memTotal = memory?.total_kb;
  const memAvailable = memory?.available_kb;
  const memoryUsage = usable(memory) && positive(memTotal) && number(memAvailable) && memAvailable <= memTotal ? percent((memTotal - memAvailable) / memTotal * 100) : null;
  const memoryEvidence = ['sysAK idc_inspect memory', `采集时间 ${sampledAt}`, '内存使用率 = (total_kb - available_kb) / total_kb；严格大于 90%'];
  if (memory) {
    for (const key of ['total_kb', 'available_kb', 'used_kb', 'free_kb', 'cached_kb', 'buffers_kb', 'slab_kb', 'sunreclaim_kb', 'swap_total_kb', 'swap_free_kb']) if (number(memory[key])) memoryEvidence.push(`${key}: ${memory[key]} KiB`);
    if (number(memory.committed_kb) && number(memory.commit_limit_kb)) memoryEvidence.push(`commit ${memory.committed_kb}/${memory.commit_limit_kb} KiB${number(memory.commit_pct) ? ` · ${memory.commit_pct}%` : ''}`);
    if (number(memory.oom_kill)) memoryEvidence.push(`累计 oom_kill ${memory.oom_kill} 次`);
  }
  const psi = section(raw, 'psi');
  const memoryPsi = obj(psi?.memory) ? psi?.memory as ObjectValue : undefined;
  if (memoryPsi?.available === true) {
    const some = memoryPsi.some_avg10;
    const full = memoryPsi.full_avg10;
    memoryEvidence.push(`PSI 内存 some_avg10=${number(some) ? some : '不可用'}；full_avg10=${number(full) ? full : '不可用'}`);
    if (number(some) && some > 10) memoryEvidence.push(`内存压力 some_avg10 ${some}% 超过 10%，存在回收停顿`);
  } else memoryEvidence.push('PSI 内存压力不可用：平台未暴露或读取受限');
  memoryEvidence.push(`memory 段状态 ${text(memory?.status, '缺失')}${reasonOf(memory)}`);
  delete memoryItem.execution;
  if (memory) memoryItem.execution = memory.status === 'ok' && memoryUsage !== null ? 'complete' : memoryUsage !== null ? 'partial' : 'unavailable';
  setInspection(memoryItem, memoryUsage, memoryUsage === null ? `内存指标不可用：${text(memory?.reason, 'memory 段缺失或不可读')}；本次未检查` : `系统内存使用率 ${memoryUsage}%${memoryUsage > 90 ? '，超过 90%' : '，未超过 90%'}；不将缓存全部视作不可回收内存`, memoryEvidence);
  const fd = section(raw, 'fd');
  const fdInteger = (value: unknown): value is number => number(value) && Number.isSafeInteger(value);
  const allocated = fd?.allocated;
  const fdMax = fd?.max;
  const globalUsage = usable(fd) && fdInteger(allocated) && fdInteger(fdMax) && fdMax > 0 && allocated <= fdMax ? allocated / fdMax * 100 : null;
  const fdEvidence = ['sysAK idc_inspect fd', `采集时间 ${sampledAt}`, 'FD 阈值：严格大于 90%', 'FD 压力快照，不是泄漏趋势检查'];
  fdEvidence.push(globalUsage === null ? '全局文件句柄占用不可用：计数或上限缺失、无效' : `全局文件句柄 ${allocated}/${fdMax}；占用 ${percent(globalUsage)}%`);
  if (fdInteger(fd?.nr_open)) fdEvidence.push(`单进程上限 nr_open ${fd!.nr_open}`);
  const seenPids = new Set<number>();
  const topProcs = entries(fd?.top_procs);
  const processes = usable(fd) ? topProcs.slice(0, 4096).filter((process) => {
    if (!fdInteger(process.pid) || process.pid <= 1 || process.pid > 2147483647 || seenPids.has(process.pid) || !fdInteger(process.fd_count) || !fdInteger(process.fd_limit) || process.fd_limit <= 0 || !number(process.usage_pct)) return false;
    // Counts may exceed a lowered limit. Validate even >100% against the sysAK
    // two-decimal ratio; never trust a supplied percentage alone.
    if (Math.abs(process.usage_pct - Math.round(process.fd_count / process.fd_limit * 10000) / 100) > 0.000001) return false;
    seenPids.add(process.pid);
    return true;
  }).sort((a, b) => (b.fd_count as number) / (b.fd_limit as number) - (a.fd_count as number) / (a.fd_limit as number)) : [];
  for (const process of processes.slice(0, 10)) fdEvidence.push(`PID ${process.pid} · ${text(process.comm, '进程')} · FD ${process.fd_count}/${process.fd_limit} · ${process.usage_pct}%`);
  const denied = fd?.denied;
  const metricsComplete = globalUsage !== null && processes.length === topProcs.length;
  const complete = fd?.status === 'ok' && metricsComplete && fd!.scanned === true && denied === 0 && fd!.truncated !== true;
  fdEvidence.push(`进程 FD 覆盖：scanned=${typeof fd?.scanned === 'boolean' ? fd.scanned : '不可用'}；denied=${fdInteger(denied) ? denied : '不可用'}；truncated=${typeof fd?.truncated === 'boolean' ? fd.truncated : '不可用'}`);
  fdEvidence.push(complete ? '可见进程 FD 扫描完整；原因：无' : `进程 FD 部分覆盖${reasonOf(fd)}；不能推断未观察进程正常`);
  fdEvidence.push(`fd 段状态 ${text(fd?.status, '缺失')}`);
  delete fdItem.execution;
  if (fd) fdItem.execution = complete ? 'complete' : globalUsage !== null || processes.length > 0 ? 'partial' : 'unavailable';
  let fdUsage = globalUsage;
  if (processes.length) fdUsage = Math.max(fdUsage ?? 0, Math.min(100, (processes[0].fd_count as number) / (processes[0].fd_limit as number) * 100));
  if (!usable(fd) || (!complete && fdUsage !== null && fdUsage <= 90)) fdUsage = null;
  const fdDetail = !fd ? 'FD 段缺失' : fdItem.execution === 'unavailable' ? 'FD 采集已尝试但不可用' : fdUsage === null ? 'FD 采集已执行但未完整覆盖，不能判断为正常' : `全局/已观察进程 FD 最高使用率 ${percent(fdUsage)}%${fdUsage > 90 ? '，超过 90%' : '，未超过 90%'}${complete ? '；可见进程扫描完整' : '；部分覆盖，已发现压力异常，不能推断整体正常'}`;
  setInspection(fdItem, fdUsage, `${fdDetail}；FD 压力快照，不是泄漏趋势检查`, fdEvidence);
  const log = section(raw, 'log');
  delete logItem.execution;
  if (!usable(log)) {
    logItem.execution = 'unavailable';
    setInspection(logItem, null, `内核日志不可读：${text(log?.reason, 'log 段缺失')}；未见异常不代表正常`, ['sysAK idc_inspect log', `采集时间 ${sampledAt}`, `log 段状态 ${text(log?.status, '缺失')}`]);
  } else {
    const categories = obj(log!.categories) ? log!.categories as ObjectValue : {};
    const hits = Object.entries(categories).map(([name, value]) => ({ name, count: obj(value) && number(value.count) ? value.count : 0 })).filter((hit) => hit.count > 0);
    const critical = hits.filter((hit) => CRITICAL_LOG_CATEGORIES.includes(hit.name));
    const records = log!.nr_records;
    const window = log!.window_sec;
    const logEvidence = ['sysAK idc_inspect log', `采集时间 ${sampledAt}`, `来源 ${text(log!.source, 'dmesg')} · 窗口 ${number(window) ? window : '未知'} 秒 · 记录 ${number(records) ? records : '未知'} 条`, `时间戳可解析：${log!.timestamped === true ? '是' : '否，窗口按读取范围近似'}`];
    for (const hit of hits.slice(0, 12)) logEvidence.push(`${hit.name}：${hit.count} 条`);
    for (const task of entries(log!.hung_tasks).slice(0, 5)) logEvidence.push(`hung task：${text(task.comm, '进程')} PID ${number(task.pid) ? task.pid : '未知'} · 阻塞 ${number(task.blocked_sec) ? task.blocked_sec : '未知'} 秒`);
    logItem.execution = log!.status === 'ok' && log!.timestamped === true ? 'complete' : 'partial';
    setInspection(logItem, null, critical.length ? `内核日志命中 ${critical.map((hit) => `${hit.name}×${hit.count}`).join('、')}` : `内核日志近 ${number(window) ? window : '未知'} 秒共 ${number(records) ? records : '未知'} 条记录，未见关键异常${log!.status === 'ok' ? '' : '；采样部分覆盖，不能推断其余正常'}`, logEvidence);
    logItem.status = critical.length ? 'abnormal' : log!.status === 'ok' ? 'normal' : 'unchecked';
  }
  const gpu = section(raw, 'gpu');
  const devices = entries(gpu?.devices);
  const lost = gpu?.lost_card_num;
  const xidValue = gpu?.xid_count;
  // -1 表示 Xid 日志不可读，不能当作 0 命中。
  const xid = typeof xidValue === 'number' && Number.isFinite(xidValue) ? xidValue : null;
  const ecc = devices.reduce((sum, device) => sum + (number(device.ecc_uncorr) ? device.ecc_uncorr : 0), 0);
  const gpuEvidence = ['sysAK idc_inspect gpu', `采集时间 ${sampledAt}`, `可见 ${devices.length} 卡 · 掉卡 ${number(lost) ? lost : '未知'} · Xid ${xid === null || xid < 0 ? '日志不可读' : xid} · 不可纠正 ECC ${ecc}`, '基础硬件快照，不含作业级 AI / NCCL / HANG 证据'];
  delete gpuItem.execution;
  if (!hasGpu || !usable(gpu)) {
    gpuItem.execution = 'unavailable';
    setInspection(gpuItem, null, !hasGpu ? '未检测到可用 NVIDIA GPU，本次未做 GPU 硬件检查' : `GPU 快照不可用：${text(gpu?.reason, 'gpu 段缺失')}；不代表没有 GPU，也不能判断硬件正常`, gpuEvidence);
  } else {
    const abnormal = number(lost) && lost > 0 || xid !== null && xid > 0 || ecc > 0;
    const conclusive = xid !== null && xid >= 0 && gpu!.status === 'ok';
    gpuItem.execution = conclusive ? 'complete' : 'partial';
    setInspection(gpuItem, null, abnormal ? `掉卡 ${number(lost) ? lost : 0} · Xid ${xid !== null && xid > 0 ? xid : 0} · 不可纠正 ECC ${ecc}` : conclusive ? '基础硬件检查未见异常；不代表作业与驱动栈整体正常' : 'GPU 快照部分覆盖或 Xid 日志不可读，不能判断整体正常', gpuEvidence);
    gpuItem.status = abnormal ? 'abnormal' : conclusive ? 'normal' : 'unchecked';
  }
}
export function parseCollectedState(raw: ObjectValue, previous: HealthState | undefined, inspect: boolean, reset: boolean): HealthState {
  const diagnostics = obj(raw.diagnostics) ? raw.diagnostics : {};
  const sampledAt = String((raw.collection as ObjectValue).finished_at);
  const resource = (id: ResourceId): ResourceSnapshot => ({
    id, label: resourceLabels[id], usage: null, capacity: null, unit: id === 'energy' ? 'W' : '%', source: 'sysak', status: 'unavailable', note: '接口缺失、权限受限或有效样本不足；不使用模拟值补齐', sampledAt, rows: [],
    rankLabel: id === 'disk' ? '进程读写吞吐排行' : id === 'energy' ? 'CPU package 功率' : id === 'gpu' ? 'GPU 设备利用率' : id === 'memory' ? '进程常驻内存排行' : '进程 CPU 利用率排行', rankUnit: id === 'disk' ? 'B/s' : id === 'energy' ? 'W' : '%',
  });
  const output: HealthState['resources'] = { cpu: resource('cpu'), energy: resource('energy'), memory: resource('memory'), disk: resource('disk'), gpu: resource('gpu') };
  const cpu = section(raw, 'cpu');
  const cpuTotal = obj(cpu?.total) ? cpu?.total as ObjectValue : undefined;
  const cpuUsage = cpuTotal?.usage_pct;
  if (usable(cpu) && number(cpuUsage) && cpuUsage <= 100) {
    const load = obj(cpu?.load) ? cpu?.load as ObjectValue : undefined;
    const load1m = load?.['1m'];
    const cores = cpu?.cpu_count;
    const iowait = cpuTotal?.iowait_pct;
    measured(output.cpu, percent(cpuUsage), cpu, `idc_inspect /proc/stat 窗口差分；idle 与 iowait 不计忙碌${number(cores) ? ` · ${cores} 核` : ''}${number(load1m) ? ` · 1 分钟负载 ${load1m}` : ''}${number(iowait) ? ` · iowait ${iowait}%` : ''}`);
  }
  const memory = section(raw, 'memory');
  const memoryTotal = memory?.total_kb;
  const memoryAvailable = memory?.available_kb;
  if (usable(memory) && positive(memoryTotal) && number(memoryAvailable) && memoryAvailable <= memoryTotal) {
    const total = memoryTotal * 1024;
    const available = memoryAvailable * 1024;
    const used = total - available;
    if ([total, used, available].every((value) => number(value) && Number.isSafeInteger(value))) {
      output.memory.quantity = { value: used, unit: 'B', total, available };
      measured(output.memory, percent(used / total * 100), memory, 'idc_inspect /proc/meminfo；已用 = MemTotal - MemAvailable，不将缓存全部视作不可回收内存');
    }
  }
  const disk = section(raw, 'disk');
  const rootMount = entries(disk?.mounts).find((mount) => mount.target === '/' && mount.status !== 'error');
  const diskSize = rootMount?.size_bytes;
  const diskAvail = rootMount?.avail_bytes;
  if (usable(disk) && rootMount && positive(diskSize) && number(diskAvail) && diskAvail <= diskSize) {
    const used = diskSize - diskAvail;
    if ([diskSize, used, diskAvail].every((value) => number(value) && Number.isSafeInteger(value))) {
      output.disk.quantity = { value: used, unit: 'B', total: diskSize, available: diskAvail };
      measured(output.disk, percent(used / diskSize * 100), disk, `根文件系统 / 的 statvfs 容量 · ${text(rootMount.source, '未知设备')} · ${text(rootMount.fstype, '未知文件系统')}；进程 I/O 排行不是磁盘空间归属`);
    }
  }
  let hasGpu = gpuResource(raw, output.gpu);
  energyResource(raw, output.energy);
  processRows(raw, output, positive(memoryTotal) ? memoryTotal * 1024 : undefined);
  const inspections = !reset && previous?.mode === 'collected' ? structuredClone(previous.inspections) : [
    inspection('root', '根目录诊断', true, 1), inspection('memory', '内存诊断', true, 1), inspection('fd', 'FD 诊断', true, 1),
    inspection('agents', 'Agent 状态', false, 1), inspection('logs', '日志诊断', false, 1), inspection('gpu', 'GPU 诊断', false, 1),
    inspection('network', '网络诊断', false, 2), inspection('io', 'I/O 诊断', false, 2),
  ];
  const gpuReport = inspect ? gpuDiagnostic(diagnostics.ai, sampledAt) : !reset && previous?.mode === 'collected' && previous.gpuDiagnostic ? structuredClone(previous.gpuDiagnostic) : gpuDiagnostic(undefined, sampledAt);
  if (inspect) {
    runInspections(raw, inspections, sampledAt, hasGpu);
    const aiEvidence = obj(diagnostics.ai) && obj(diagnostics.ai.content) ? diagnostics.ai.content : undefined;
    const metrics = aiEvidence?.schema_version === '1.0' && aiEvidence.tool === 'ai' && aiEvidence.mode === 'native' && aiEvidence.read_only === false && ['ok', 'partial', 'error', 'timeout', 'unavailable'].includes(String(aiEvidence.status)) ? aiMetrics(aiEvidence.gpu_metrics) : [];
    if (gpuReport.jobAnalysis) {
      for (const process of gpuReport.jobAnalysis.processes) {
        if (gpuReport.gpuCount !== null && process.gpuIndices.some(index => index >= gpuReport.gpuCount!)) {
          if (process.status === 'ok') process.status = 'partial';
          gpuReport.jobAnalysis.complete = false;
          if (gpuReport.jobAnalysis.status === 'ok') gpuReport.jobAnalysis.status = 'partial';
        }
      }
    }
    if (metrics.length) {
      // Native ai has no stable BDF/UUID. Replace the SMI snapshot; never join
      // its identities or metrics to ai records by index or empty busId.
      output.gpu.gpuDevices = metrics;
      output.gpu.rows = metrics.filter(device => device.utilization !== null).map(device => row(`gpu-${device.index}`, device.name || `GPU ${device.index}`, `${device.busId || 'PCI 身份不可用'} · 原生 AI / NVML 逐卡资源`, device.utilization!));
      const utilization = metrics.flatMap(device => device.utilization === null ? [] : [device.utilization]);
      const used = metrics.reduce((sum, device) => sum + (device.memoryUsedBytes ?? 0), 0);
      const total = metrics.reduce((sum, device) => sum + (device.memoryTotalBytes ?? 0), 0);
      const inventoryComplete = gpuReport.gpuCount === metrics.length && Array.isArray(aiEvidence?.gpu_metrics) && metrics.length === aiEvidence.gpu_metrics.length;
      const memoryComplete = inventoryComplete && metrics.every(device => device.memoryUsedBytes !== null && device.memoryTotalBytes !== null) && Number.isSafeInteger(used) && Number.isSafeInteger(total);
      output.gpu.quantity = memoryComplete ? { value: used, total, unit: 'B' } : undefined;
      measured(output.gpu, utilization.length ? Math.max(...utilization) : null, diagnostics.ai, 'sysak ai 原生 / NVML 本机逐卡证据；指标窗口未提供，设备名称、UUID 与 PCI 身份不可用，不与其他快照按序号关联；缺失指标不补齐，资源指标不是硬件健康结论');
      if (!inventoryComplete || metrics.some(device => Object.values(device).includes(null)) || aiEvidence?.status !== 'ok') output.gpu.status = 'partial';
      if (!inventoryComplete && gpuReport.complete) {
        gpuReport.complete = false;
        gpuReport.status = 'partial';
        if (gpuReport.outcome === 'normal' || gpuReport.outcome === 'no_gpu') {
          gpuReport.outcome = 'unknown';
          gpuReport.summary = 'AI 资源指标与设备枚举不一致，不能判断整体正常';
        }
      }
      hasGpu = true;
    }
    if (gpuReport.outcome === 'no_gpu' && (output.gpu.gpuDevices?.length || output.gpu.rows.length)) {
      gpuReport.status = 'partial';
      gpuReport.complete = false;
      gpuReport.outcome = 'unknown';
      gpuReport.summary = 'GPU 资源快照与 ai 设备枚举不一致，不能判断 GPU 不存在或硬件正常';
    }
    if (gpuReport.status !== 'not_run') {
      const gpuInspection = inspections.find(item => item.id === 'gpu')!;
      gpuInspection.status = gpuReport.outcome === 'normal' ? 'normal' : gpuReport.outcome === 'abnormal' ? 'abnormal' : 'unchecked';
      gpuInspection.usage = null;
      gpuInspection.detail = gpuReport.summary;
      gpuInspection.evidence = [gpuReport.source, `采集时间 ${gpuReport.sampledAt ?? '未执行'}`, gpuReport.complete ? '本次检查覆盖完整' : '检查未执行、未完成或覆盖受限', ...gpuReport.findings.slice(0, 10).map(item => `${item.severity} · ${item.check} · ${item.message}`)];
      delete gpuInspection.execution;
      gpuInspection.execution = gpuReport.complete ? 'complete' : gpuReport.findings.length ? 'partial' : 'unavailable';
      if (gpuReport.outcome === 'no_gpu' && !output.gpu.gpuDevices?.length && !output.gpu.rows.length) hasGpu = false;
    }
  }
  const revision = previous ? previous.revision + 1 : inspect ? 2 : 1;
  const operations = reset ? [] : structuredClone(previous?.operations ?? []);
  if (inspect) operations.unshift({ id: `inspect-${revision}`, kind: 'inspect', names: ['sysAK idc_inspect 1.1：disk.mounts / memory / fd / log / gpu'], time: sampledAt, revision });
  return { mode: 'collected', hasGpu, revision, sampledAt, resources: output, inspections, gpuDiagnostic: gpuReport, optimizations: [], operations: operations.slice(0, 30) };
}
