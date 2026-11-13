import { recognizeAgent, resourceLabels, type GpuDevice, type GpuDiagnostic, type GpuFinding, type GpuJobAnalysis, type ResourceId, type HealthState, type Inspection, type ResourceRow, type ResourceSnapshot } from './src/health-data';

type ObjectValue = Record<string, unknown>;
const obj = (value: unknown): value is ObjectValue => value !== null && typeof value === 'object' && !Array.isArray(value);
const number = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const positive = (value: unknown): value is number => number(value) && value > 0;
const percent = (value: number) => Math.round(Math.max(0, Math.min(100, value)) * 10) / 10;
const text = (value: unknown, fallback: string) => typeof value === 'string' ? value.slice(0, 256) : fallback;
function content(value: unknown): unknown {
  return obj(value) && ['ok', 'partial', 'truncated'].includes(String(value.status)) ? value.content : undefined;
}
function record(value: unknown): ObjectValue | undefined {
  const result = content(value);
  return obj(result) ? result : undefined;
}
function entries(value: unknown): ObjectValue[] {
  return Array.isArray(value) ? value.filter(obj) : [];
}
function row(id: string, name: string, detail: string, usage: number, extra: Partial<ResourceRow> = {}): ResourceRow {
  return { id, name, detail, usage, cleanable: false, defaultSelected: false, effect: '只读采集，不支持清理', ...extra };
}
function cpuCounters(value: unknown): number[] | undefined {
  const raw = content(value);
  if (typeof raw !== 'string') return;
  const line = raw.split('\n').find((line) => /^cpu\s/.test(line));
  const counters = line?.trim().split(/\s+/).slice(1, 9).map(Number);
  if (counters && counters.length === 8 && counters.every((value) => number(value) && Number.isSafeInteger(value))) return counters;
}
function meminfo(value: unknown): Record<string, number> {
  const raw = content(value);
  const result: Record<string, number> = {};
  if (typeof raw !== 'string') return result;
  for (const line of raw.split('\n')) {
    const match = /^([A-Za-z_()]+):\s*(\d+)\s+kB\s*$/.exec(line);
    if (match && Number.isSafeInteger(Number(match[2]) * 1024)) result[match[1]] = Number(match[2]) * 1024;
  }
  return result;
}
function measured(resource: ResourceSnapshot, usage: number | null, evidence: unknown, note: string) {
  resource.usage = usage;
  resource.status = usage === null && !resource.quantity ? 'unavailable' : obj(evidence) && evidence.status !== 'ok' ? 'partial' : 'available';
  resource.note = note;
}
function processRows(resources: ObjectValue, output: HealthState['resources'], totalMemory: number | undefined) {
  const data = record(resources.processes);
  const samples = entries(data?.samples);
  if (samples.length !== 2) return;
  const [first, second] = samples;
  const elapsed = number(first.monotonic_seconds) && number(second.monotonic_seconds) ? second.monotonic_seconds - first.monotonic_seconds : 0;
  const count = content(resources.cpu_count);
  const ticks = data?.clock_ticks;
  const previous = new Map(entries(first.processes).filter((p) => Number.isSafeInteger(p.pid) && Number.isSafeInteger(p.starttime)).map((p) => [`${p.pid}:${p.starttime}`, p]));
  for (const process of entries(second.processes).slice(0, 4096)) {
    if (!Number.isSafeInteger(process.pid) || !number(process.pid) || !Number.isSafeInteger(process.starttime)) continue;
    const pid = process.pid;
    const before = previous.get(`${pid}:${process.starttime}`);
    const name = text(process.comm, `PID ${pid}`);
    const id = `process-${pid}-${process.starttime}`;
    const agentKind = recognizeAgent(name);
    const identity = { pid, starttime: process.starttime as number, ...(agentKind ? { agentKind } : {}) };
    if (positive(totalMemory) && number(process.rss_bytes) && process.rss_bytes <= totalMemory) {
      output.memory.rows.push(row(id, name, `PID ${pid} · RSS 常驻内存，共享页可能重复计入`, percent(process.rss_bytes / totalMemory * 100), { ...identity, quantity: { value: process.rss_bytes, unit: 'B' } }));
    }
    if (!before || elapsed <= 0) continue;
    if (positive(ticks) && positive(count) && [process.utime, process.stime, before.utime, before.stime].every(number)) {
      const delta = (process.utime as number) + (process.stime as number) - (before.utime as number) - (before.stime as number);
      if (number(delta) && (process.utime as number) >= (before.utime as number) && (process.stime as number) >= (before.stime as number)) output.cpu.rows.push(row(id, name, `PID ${pid} · 占整机 CPU 容量`, percent(delta / ticks / elapsed / count * 100), identity));
    }
    if (process.io_status === 'ok' && before.io_status === 'ok' && obj(process.io) && obj(before.io) && [process.io.read_bytes, process.io.write_bytes, before.io.read_bytes, before.io.write_bytes].every(number)) {
      const read = (process.io.read_bytes as number) - (before.io.read_bytes as number);
      const write = (process.io.write_bytes as number) - (before.io.write_bytes as number);
      if (read >= 0 && write >= 0) {
        const rate = (read + write) / elapsed;
        if (number(rate)) output.disk.rows.push(row(id, name, `PID ${pid} · 读写吞吐，不代表磁盘空间归属`, rate, { ...identity, quantity: { value: rate, unit: 'B/s' } }));
      }
    }
  }
  for (const id of ['cpu', 'memory', 'disk'] as const) {
    output[id].rows.sort((a, b) => b.usage - a.usage || (a.pid ?? 0) - (b.pid ?? 0));
    const ranked = output[id].rows;
    output[id].rows = [...new Map([...ranked.slice(0, 20), ...ranked.filter(row => row.agentKind).slice(0, 20)].map(row => [row.id, row])).values()];
    output[id].note += `；进程排行仅覆盖可见 /proc，${obj(resources.processes) && resources.processes.status === 'ok' ? '已完成有界采样' : '部分缺失、权限受限或扫描截断'}`;
  }
}
function gpuNumber(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number | null {
  const parsed = typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value.trim()) ? Number(value.trim()) : value;
  return number(parsed) && parsed <= maximum ? parsed : null;
}
function gpuBytes(value: unknown): number | null {
  const mib = gpuNumber(value);
  return mib !== null && Number.isSafeInteger(mib * 1024 * 1024) ? mib * 1024 * 1024 : null;
}
function gpuResource(evidence: unknown, resource: ResourceSnapshot): boolean {
  const raw = content(evidence);
  if (obj(raw)) {
    resource.gpuDevices = [];
    if (raw.schema_version !== '1.0' || raw.tool !== 'idc' || raw.mode !== 'idc' || raw.read_only !== true || !['ok', 'partial', 'unavailable', 'error', 'timeout'].includes(String(raw.status))) {
      resource.note = 'IDC nvidia-smi GPU 返回数据无效，不能判断硬件状态';
      return true;
    }
    if (raw.available !== true || !Array.isArray(raw.devices)) {
      resource.note = `IDC nvidia-smi GPU 快照不可用：${text(raw.reason, '工具、驱动或权限不可用')}；不代表没有 GPU`;
      return true;
    }
    const seen = new Set<number>();
    for (const device of entries(raw.devices).slice(0, 32)) {
      const index = gpuNumber(device.index);
      if (index === null || !Number.isSafeInteger(index) || seen.has(index)) continue;
      seen.add(index);
      let used = gpuBytes(device.mem_used);
      const total = gpuBytes(device.mem_total);
      if (used !== null && total !== null && used > total) used = null;
      const gpu: GpuDevice = {
        index, name: text(device.name, 'GPU'), uuid: text(device.uuid, ''), busId: text(device.bus_id, ''),
        utilization: gpuNumber(device.util, 100), memoryUtilization: gpuNumber(device.mem_util_pct, 100),
        memoryUsedBytes: used, memoryTotalBytes: total,
        temperatureCelsius: gpuNumber(device.temp), powerWatts: gpuNumber(device.power_draw), powerLimitWatts: gpuNumber(device.power_limit),
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
    measured(resource, usage, evidence, 'IDC 按需 nvidia-smi GPU 快照；多卡显示最高利用率，无历史曲线或进程 GPU 利用率归属');
    if (!devices.length) {
      resource.note = raw.devices.length === 0 && raw.status === 'ok' ? 'IDC nvidia-smi GPU 查询成功，未检测到可见 NVIDIA GPU' : 'IDC nvidia-smi GPU 设备数据无效，不能判断硬件状态';
    } else if (devices.length !== raw.devices.length || raw.gpu_count !== devices.length || raw.status !== 'ok' || devices.some(device => Object.values(device).some(value => value === null) || !device.uuid)) {
      resource.status = 'partial';
    }
    resource.rows.sort((a, b) => b.usage - a.usage);
    return !(obj(evidence) && evidence.status === 'ok' && raw.status === 'ok' && raw.devices.length === 0 && raw.gpu_count === 0);
  }
  if (typeof raw !== 'string') return true;
  if (!raw.trim()) return !obj(evidence) || evidence.status !== 'ok';
  let memoryTotal = 0;
  let memoryUsed = 0;
  let memoryComplete = true;
  for (const [index, line] of raw.trim().split('\n').slice(0, 32).entries()) {
    const fields = line.split(',').map((field) => field.trim());
    if (fields.length !== 7) continue;
    const value = (index: number) => /^\d+(?:\.\d+)?$/.test(fields[index]) && number(Number(fields[index])) ? Number(fields[index]) : null;
    const usage = value(2);
    const total = value(3);
    const used = value(4);
    const watts = value(5);
    const temperature = value(6);
    if (total !== null && used !== null && used <= total) { memoryTotal += total * 1024 * 1024; memoryUsed += used * 1024 * 1024; }
    else memoryComplete = false;
    if (usage === null || usage > 100) continue;
    const detail = [total !== null && used !== null ? `显存 ${used}/${total} MiB` : '显存不可用', watts !== null ? `${watts} W` : '功率不可用', temperature !== null ? `${temperature} °C` : '温度不可用'].join(' · ');
    resource.rows.push(row(`gpu-${index}`, text(fields[0], 'GPU'), detail, usage));
  }
  if (memoryComplete && memoryTotal > 0) resource.quantity = { value: memoryUsed, unit: 'B', total: memoryTotal, available: memoryTotal - memoryUsed };
  const usage = resource.rows.length ? Math.max(...resource.rows.map((row) => row.usage)) : null;
  measured(resource, usage, evidence, 'IDC 按需 nvidia-smi 实测；多卡显示最高利用率，不提供进程 GPU 利用率归属');
  resource.rows.sort((a, b) => b.usage - a.usage);
  return true;
}
function energyResource(evidence: unknown, resource: ResourceSnapshot) {
  const data = record(evidence);
  const samples = entries(data?.samples);
  if (samples.length !== 2) return;
  const elapsed = number(samples[0].monotonic_seconds) && number(samples[1].monotonic_seconds) ? samples[1].monotonic_seconds - samples[0].monotonic_seconds : 0;
  if (elapsed <= 0) return;
  const previous = new Map(entries(samples[0].zones).map((zone) => [zone.path, zone]));
  const seen = new Set<string>();
  for (const zone of entries(samples[1].zones).slice(0, 32)) {
    if (typeof zone.path !== 'string' || seen.has(zone.path) || typeof zone.name !== 'string' || !/^package(?:[-_]\d+)?$/.test(zone.name)) continue;
    seen.add(zone.path);
    const before = previous.get(zone.path);
    if (!before || !number(before.energy_uj) || !number(zone.energy_uj)) continue;
    let delta = zone.energy_uj - before.energy_uj;
    if (delta < 0) {
      if (!positive(zone.max_energy_range_uj) || zone.max_energy_range_uj !== before.max_energy_range_uj || before.energy_uj >= zone.max_energy_range_uj || zone.energy_uj >= zone.max_energy_range_uj) continue;
      delta += zone.max_energy_range_uj;
    }
    const watts = delta / 1e6 / elapsed;
    if (number(watts)) resource.rows.push(row(`rapl-${resource.rows.length}`, zone.name, 'CPU package RAPL 能量差分；非整机功耗', watts, { quantity: { value: watts, unit: 'W' } }));
  }
  if (!resource.rows.length) return;
  resource.quantity = { value: resource.rows.reduce((sum, row) => sum + row.usage, 0), unit: 'W' };
  measured(resource, null, evidence, 'CPU package RAPL 平均功率；不叠加重叠子域，不估算进程能耗或预算百分比');
  if (resource.rows.length !== entries(samples[1].zones).length || resource.rows.length !== entries(samples[0].zones).length) resource.status = 'partial';
  resource.rows.sort((a, b) => b.usage - a.usage);
}
function inspection(id: string, label: string, important: boolean, phase: 1 | 2): Inspection {
  return { id, label, important, phase, status: 'unchecked', usage: null, detail: '尚未接入真实诊断', evidence: [] };
}
function diagnosticContent(value: unknown): ObjectValue | undefined {
  const data = record(value);
  return data?.mode === 'idc' && data.read_only === true ? data : undefined;
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
  const result: GpuDiagnostic = { status: 'not_run', outcome: 'unknown', sampledAt: null, source: 'sysak ai', complete: false, gpuCount: null, architectures: [], devices: [], summary: '尚未执行 GPU 诊断；点击诊断时按需调用 SysAK ai', findings: [] };
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
function runInspections(diagnostics: ObjectValue, inspections: Inspection[], sampledAt: string) {
  const rootItem = inspections.find((item) => item.id === 'root')!;
  const fdItem = inspections.find((item) => item.id === 'fd')!;
  const memoryItem = inspections.find((item) => item.id === 'memory')!;
  const anomaly = diagnosticContent(diagnostics.resource_anomaly);
  const root = obj(anomaly?.root) ? anomaly.root : undefined;
  const fd = obj(anomaly?.fd) ? anomaly.fd : undefined;
  const rootUsage = root && ['ok', 'partial'].includes(String(root.status)) && positive(root.total_bytes) && number(root.used_bytes) && root.used_bytes <= root.total_bytes ? percent(root.used_bytes / root.total_bytes * 100) : null;
  const rootEvidence = ['sysAK resource_anomaly --idc', `采集时间 ${sampledAt}`, '容量阈值：严格大于 90%'];
  if (root) {
    if (number(root.total_bytes)) rootEvidence.push(`根文件系统容量 ${root.total_bytes} B；已用 ${number(root.used_bytes) ? root.used_bytes : '不可用'} B`);
    const scan = obj(root.scan) ? root.scan : undefined;
    rootEvidence.push(scan?.complete === true ? '目录元数据扫描完整' : `目录元数据扫描部分覆盖：${text(scan?.reason, '时间、深度、条目或权限限制')}；仅为已扫描文件的分配字节下界，不是完整目录大小`);
    for (const directory of entries(root.directories).slice(0, 10)) if (number(directory.allocated_bytes)) rootEvidence.push(`${text(directory.path, '/')} · 已扫描分配字节 ${directory.allocated_bytes} B`);
  }
  setInspection(rootItem, rootUsage, rootUsage === null ? 'resource_anomaly 根目录容量诊断不可用' : `根文件系统使用率 ${rootUsage}%${rootUsage > 90 ? '，超过 90%' : '，未超过 90%'}；目录排行为有界扫描`, rootEvidence);
  const fdDiagnostic = obj(diagnostics.resource_anomaly) ? diagnostics.resource_anomaly : undefined;
  const fdEvidence = ['来源 sysAK resource_anomaly --idc', `采集时间 ${text(fdDiagnostic?.sampled_at, sampledAt)}`, 'FD 阈值：严格大于 90%', 'FD 压力快照，不是泄漏趋势检查'];
  const fdInteger = (value: unknown): value is number => number(value) && Number.isSafeInteger(value);
  const coverage = obj(fd?.coverage) ? fd.coverage : undefined;
  const fdReturned = fd && ['ok', 'partial'].includes(String(fd.status));
  const globalUsage = fdReturned && fdInteger(fd.allocated) && fdInteger(fd.file_max) && fd.file_max > 0 && fd.allocated <= fd.file_max ? fd.allocated / fd.file_max * 100 : null;
  fdEvidence.push(globalUsage === null ? '全局文件句柄占用不可用：计数或上限缺失、无效' : `全局文件句柄 ${fd!.allocated}/${fd!.file_max}；占用 ${percent(globalUsage)}%`);
  const seenPids = new Set<number>();
  const processes = fdReturned ? entries(fd.processes).slice(0, 4096).filter((p) => {
    if (!fdInteger(p.pid) || p.pid <= 0 || p.pid > 2147483647 || seenPids.has(p.pid) || !fdInteger(p.fd_count) || !fdInteger(p.soft_limit) || p.soft_limit <= 0 || !number(p.usage_pct)) return false;
    // Counts may exceed a lowered soft limit. Validate even >100% against the
    // sysAK two-decimal ratio; never trust a supplied percentage alone.
    if (Math.abs(p.usage_pct - Math.round(p.fd_count / p.soft_limit * 10000) / 100) > 0.000001) return false;
    seenPids.add(p.pid);
    return true;
  }).sort((a, b) => (b.fd_count as number) / (b.soft_limit as number) - (a.fd_count as number) / (a.soft_limit as number)) : [];
  for (const process of processes.slice(0, 10)) fdEvidence.push(`PID ${process.pid} · ${text(process.name, '进程')} · FD ${process.fd_count}/${process.soft_limit} · ${process.usage_pct}%`);
  const metricsComplete = globalUsage !== null && Array.isArray(fd?.processes) && processes.length === fd.processes.length;
  const complete = fd?.status === 'ok' && metricsComplete && coverage?.complete === true && fdInteger(coverage.observed_processes) && coverage.observed_processes === processes.length && coverage.denied_processes === 0 && coverage.truncated === false && (coverage.reason === undefined || coverage.reason === '');
  fdEvidence.push(`进程 FD 覆盖：observed_processes=${fdInteger(coverage?.observed_processes) ? coverage.observed_processes : '不可用'}；denied_processes=${fdInteger(coverage?.denied_processes) ? coverage.denied_processes : '不可用'}；truncated=${typeof coverage?.truncated === 'boolean' ? coverage.truncated : '不可用'}`);
  fdEvidence.push(complete ? '可见进程 FD 扫描完整；原因：无' : `进程 FD 部分覆盖；原因：${text(coverage?.reason, '覆盖信息缺失、权限、时间或条目限制')}；${metricsComplete ? '不能推断未观察进程正常' : '全局或进程指标缺失、无效或截断'}；不能判断整体正常`);
  const notExecuted = !fdDiagnostic || fdDiagnostic.reason === 'component_not_installed';
  delete fdItem.execution;
  if (!notExecuted) fdItem.execution = complete ? 'complete' : fdReturned && (fd.status === 'partial' || globalUsage !== null || processes.length > 0) ? 'partial' : 'unavailable';
  if (notExecuted) fdEvidence.push('工具未执行：诊断缺失或组件未安装');
  else fdEvidence.push(`诊断返回状态 ${text(fdDiagnostic.status, '未知')}；FD 状态 ${text(fd?.status, '不可用')}${typeof fdDiagnostic.reason === 'string' ? `；原因 ${text(fdDiagnostic.reason, '')}` : ''}`);
  let fdUsage = globalUsage;
  if (processes.length) fdUsage = Math.max(fdUsage ?? 0, Math.min(100, (processes[0].fd_count as number) / (processes[0].soft_limit as number) * 100));
  if (notExecuted || (!complete && fdUsage !== null && fdUsage <= 90)) fdUsage = null;
  const fdDetail = notExecuted ? 'FD 工具未执行' : fdItem.execution === 'unavailable' ? 'FD 诊断已尝试但不可用' : fdUsage === null ? 'FD 诊断已执行但未完整覆盖，不能判断为正常' : `全局/已观察进程 FD 最高使用率 ${percent(fdUsage)}%${fdUsage > 90 ? '，超过 90%' : '，未超过 90%'}${complete ? '；可见进程扫描完整' : '；部分覆盖，已发现压力异常，不能推断整体正常'}`;
  setInspection(fdItem, fdUsage, `${fdDetail}；FD 压力快照，不是泄漏趋势检查`, fdEvidence);
  // Native memgraph is not the proc-only IDC/read-only diagnostic contract.
  const memoryData = record(diagnostics.memgraph);
  const memory = memoryData?.mode === 'native' && memoryData.tool === 'memgraph' && memoryData.version === '2.0' && memoryData.unit === 'KiB' && memoryData.status === 'partial' && obj(memoryData.coverage) && memoryData.coverage.native_plugin_coverage_unknown === true ? memoryData : undefined;
  const graph = obj(memory?.graph) ? memory.graph : undefined;
  const total = graph?.total;
  const available = graph?.avaliable;
  const memoryUsage = positive(total) && number(available) && available <= total ? percent((1 - available / total) * 100) : null;
  const memoryDiagnostic = obj(diagnostics.memgraph) ? diagnostics.memgraph : undefined;
  const memoryEvidence = ['sysak memgraph --graph --jsonstdout', `采集时间 ${text(memoryDiagnostic?.sampled_at, sampledAt)}`, '内存压力使用率 = (graph.total - graph.avaliable) / graph.total；原生 total 包含 ReservedMem（如有）；严格大于 90%'];
  if (graph) for (const key of ['total', 'free', 'used', 'avaliable', 'reserved', 'userUsed', 'kernelUsed', 'shmem']) if (number(graph[key])) memoryEvidence.push(`${key}: ${graph[key]} KiB`);
  memoryEvidence.push('原生插件覆盖未知：native_plugin_coverage_unknown；有效 graph 或成功退出不代表全部插件诊断完整');
  if (memoryDiagnostic) memoryEvidence.push(`诊断返回状态 ${text(memoryDiagnostic.status, '未知')}${typeof memoryDiagnostic.reason === 'string' ? `；原因 ${text(memoryDiagnostic.reason, '')}` : ''}`);
  delete memoryItem.execution;
  if (memoryDiagnostic && memoryDiagnostic.reason !== 'component_not_installed') memoryItem.execution = memoryUsage === null ? 'unavailable' : 'partial';
  setInspection(memoryItem, memoryUsage, memoryUsage === null ? 'memgraph 原生内存诊断不可用' : `系统内存压力使用率 ${memoryUsage}%${memoryUsage > 90 ? '，超过 90%' : '，未超过 90%'}；仅判断 graph 内存压力，原生插件覆盖未知，不能推断完整内存诊断正常`, memoryEvidence);
}
export function parseCollectedState(raw: ObjectValue, previous: HealthState | undefined, inspect: boolean, reset: boolean): HealthState {
  const resources = obj(raw.resources) ? raw.resources : {};
  const diagnostics = obj(raw.diagnostics) ? raw.diagnostics : {};
  const sampledAt = String((raw.collection as ObjectValue).finished_at);
  const resource = (id: ResourceId): ResourceSnapshot => ({
    id, label: resourceLabels[id], usage: null, capacity: null, unit: id === 'energy' ? 'W' : '%', source: 'sysak', status: 'unavailable', note: '接口缺失、权限受限或有效样本不足；不使用模拟值补齐', sampledAt, rows: [],
    rankLabel: id === 'disk' ? '进程读写吞吐排行' : id === 'energy' ? 'CPU package 功率' : id === 'gpu' ? 'GPU 设备利用率' : id === 'memory' ? '进程常驻内存排行' : '进程 CPU 利用率排行', rankUnit: id === 'disk' ? 'B/s' : id === 'energy' ? 'W' : '%',
  });
  const output: HealthState['resources'] = { cpu: resource('cpu'), energy: resource('energy'), memory: resource('memory'), disk: resource('disk'), gpu: resource('gpu') };
  const cpu = Array.isArray(resources.cpu) ? resources.cpu : [];
  if (cpu.length === 2) {
    const before = cpuCounters(cpu[0]);
    const after = cpuCounters(cpu[1]);
    if (before && after && before.length === after.length) {
      const delta = after.map((value, index) => value - before[index]);
      const total = delta.reduce((sum, value) => sum + value, 0);
      if (delta.every(number) && positive(total)) measured(output.cpu, percent((total - delta[3] - (delta[4] ?? 0)) / total * 100), cpu[0], '/proc/stat 双样本差分；idle 与 iowait 不计忙碌；guest 已包含在 user/nice 中');
    }
  }
  const memory = meminfo(resources.meminfo);
  if (positive(memory.MemTotal) && number(memory.MemAvailable) && memory.MemAvailable <= memory.MemTotal) {
    const used = memory.MemTotal - memory.MemAvailable;
    output.memory.quantity = { value: used, unit: 'B', total: memory.MemTotal, available: memory.MemAvailable };
    measured(output.memory, percent(used / memory.MemTotal * 100), resources.meminfo, '/proc/meminfo；已用 = MemTotal - MemAvailable，不将缓存全部视作不可回收内存');
  }
  const disk = record(resources.root_filesystem);
  if (disk && positive(disk.f_frsize) && positive(disk.f_blocks) && number(disk.f_bfree) && number(disk.f_bavail) && disk.f_bfree <= disk.f_blocks && disk.f_bavail <= disk.f_bfree) {
    const total = disk.f_blocks * disk.f_frsize;
    const used = (disk.f_blocks - disk.f_bfree) * disk.f_frsize;
    const available = disk.f_bavail * disk.f_frsize;
    if ([total, used, available].every((value) => number(value) && Number.isSafeInteger(value))) {
      output.disk.quantity = { value: used, unit: 'B', total, available };
      measured(output.disk, percent(used / total * 100), resources.root_filesystem, '根文件系统 / 的 statvfs 容量；进程 I/O 排行不是磁盘空间归属');
    }
  }
  let hasGpu = gpuResource(resources.gpu, output.gpu);
  energyResource(resources.energy_uj, output.energy);
  processRows(resources, output, memory.MemTotal);
  const inspections = !reset && previous?.mode === 'collected' ? structuredClone(previous.inspections) : [
    inspection('root', '根目录诊断', true, 1), inspection('memory', '内存诊断', true, 1), inspection('fd', 'FD 诊断', true, 1),
    inspection('agents', 'Agent 状态', false, 1), inspection('logs', '日志诊断', false, 1), inspection('gpu', 'GPU 诊断', false, 1),
    inspection('network', '网络诊断', false, 2), inspection('io', 'I/O 诊断', false, 2),
  ];
  const gpuReport = inspect ? gpuDiagnostic(diagnostics.ai, sampledAt) : !reset && previous?.mode === 'collected' && previous.gpuDiagnostic ? structuredClone(previous.gpuDiagnostic) : gpuDiagnostic(undefined, sampledAt);
  if (inspect) {
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
    runInspections(diagnostics, inspections, sampledAt);
    const gpuInspection = inspections.find(item => item.id === 'gpu')!;
    gpuInspection.status = gpuReport.outcome === 'normal' ? 'normal' : gpuReport.outcome === 'abnormal' ? 'abnormal' : 'unchecked';
    gpuInspection.usage = null;
    gpuInspection.detail = gpuReport.summary;
    gpuInspection.evidence = [gpuReport.source, `采集时间 ${gpuReport.sampledAt ?? '未执行'}`, gpuReport.complete ? '本次检查覆盖完整' : '检查未执行、未完成或覆盖受限', ...gpuReport.findings.slice(0, 10).map(item => `${item.severity} · ${item.check} · ${item.message}`)];
    delete gpuInspection.execution;
    if (gpuReport.status !== 'not_run') gpuInspection.execution = gpuReport.complete ? 'complete' : gpuReport.findings.length ? 'partial' : 'unavailable';
    if (gpuReport.outcome === 'no_gpu' && !output.gpu.gpuDevices?.length && !output.gpu.rows.length) hasGpu = false;
  }
  const revision = previous ? previous.revision + 1 : inspect ? 2 : 1;
  const operations = reset ? [] : structuredClone(previous?.operations ?? []);
  if (inspect) operations.unshift({ id: `inspect-${revision}`, kind: 'inspect', names: ['根目录 / FD：resource_anomaly；内存：memgraph；GPU：ai'], time: sampledAt, revision });
  return { mode: 'collected', hasGpu, revision, sampledAt, resources: output, inspections, gpuDiagnostic: gpuReport, optimizations: [], operations: operations.slice(0, 30) };
}
