import { useState } from 'react';
import { ArrowRight, Blocks, Cpu, HardDrive, Info, MemoryStick, Zap, type LucideIcon } from 'lucide-react';
import { chartValues, type Device } from './data';
import { ResourceChart } from './components';
import { localTime } from '../agent-diagnostics';
import { formatResourceQuantity, formatResourceValue, type HealthState, type ResourceId } from './health-data';
export interface HealthPerformanceProps {
  device: Device;
  state: HealthState;
  onInvestigate: (inspectionId: string) => void;
}
const performanceResources: Array<{
  id: ResourceId;
  label: string;
  icon: LucideIcon;
  color: string;
}> = [{
  id: "cpu",
  label: "CPU",
  icon: Cpu,
  color: "#2b6cff"
}, {
  id: "energy",
  label: "能耗",
  icon: Zap,
  color: "#e7a435"
}, {
  id: "memory",
  label: "内存",
  icon: MemoryStick,
  color: "#0fb57f"
}, {
  id: "gpu",
  label: "GPU",
  icon: Blocks,
  color: "#8b5cf6"
}, {
  id: "disk",
  label: "磁盘",
  icon: HardDrive,
  color: "#ef9a06"
}];
export function HealthPerformance({
  device,
  state,
  onInvestigate
}: HealthPerformanceProps) {
  const [selection, setSelectedResource] = useState<ResourceId>("cpu");
  const selectedResource = selection === 'gpu' && !state.hasGpu ? 'cpu' : selection;
  const collected = state.mode === 'collected';
  const snapshot = state.resources[selectedResource];
  const visibleResources = state.hasGpu ? performanceResources : performanceResources.filter(item => item.id !== "gpu");
  const resource = performanceResources.find(item => item.id === selectedResource)!;
  // Collected snapshots have no history: never scale the Demo series for them.
  const values = !collected && snapshot.usage !== null ? chartValues.map(item => Math.min(100, Math.max(0, Math.round(item * snapshot.usage! / 56)))) : [];
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  const average = Math.round(values.reduce((item, current) => item + current, 0) / values.length);
  return <section className="hg-performance">
    <div className="hg-performance-heading">
      <div>
        <h1>
          {"本机性能监视"}
        </h1>
        <p>
          {device.name}
          {" · 资源观察与诊断分开，不凭曲线直接操作系统。"}
        </p>
      </div>
      <span className="hg-tag">
        {collected ? '本地资源采集 · 只读' : '固定演示样本 · 非实时采集'}
      </span>
    </div>
    <div className="hg-performance-grid">
      <section className="hg-card hg-performance-chart">
        <div
          className="hg-resource-tabs"
          role="group"
          aria-label="性能资源选择"
        >
          {visibleResources.map(item => <button
            aria-pressed={selectedResource === item.id}
            className={selectedResource === item.id ? "active" : ""}
            onClick={() => setSelectedResource(item.id)}
            key={item.id}
          >
            <item.icon size={15} />
            {item.label}
          </button>)}
        </div>
        <div
          className="hg-performance-value"
          style={{
            color: resource.color
          }}
        >
          <strong>
            {snapshot.usage !== null && snapshot.status !== 'unavailable' ? <>{snapshot.usage}<small>%</small></> : formatResourceValue(snapshot)}
          </strong>
          <span>
            {collected ? '当前采集值' : '当前演示状态'}
            <span>
              {collected ? localTime(snapshot.sampledAt ?? state.sampledAt) : '14:00–14:30 示意窗口'}
            </span>
          </span>
        </div>
        {collected ? <div className="sh-no-history" role="status"><strong>暂无历史采样</strong><p>目前仅有当前快照，不生成趋势、平均值或历史峰值。</p><p>{formatResourceQuantity(snapshot)}</p></div> : values.length ? <><ResourceChart
          values={values}
          label={`${resource.label}性能示意趋势`}
          color={resource.color}
        />
        <div className="hg-performance-statistics">
          <div>
            <span>
              {"样本最低"}
            </span>
            <strong>
              {minimum}
              {"%"}
            </strong>
          </div>
          <div>
            <span>
              {"样本平均"}
            </span>
            <strong>
              {average}
              {"%"}
            </strong>
          </div>
          <div>
            <span>
              {"样本峰值"}
            </span>
            <strong>
              {maximum}
              {"%"}
            </strong>
          </div>
        </div></> : <p className="sh-empty">当前值不可用，无趋势数据。</p>}
        <div className="hg-dialog-note">
          <Info size={14} />
          {collected ? snapshot.note || '仅当前采集范围；缺失测量值不代表正常。' : '曲线由同一内置序列按资源状态缩放，仅示意交互，不用于判断资源间相关性或真实峰值。'}
        </div>
      </section>
      <aside className="hg-card hg-resource-context">
        <h2>
          {"先观察，再定位问题"}
        </h2>
        <div className="hg-resource-details">
          <div>
            <span>
              {"设备"}
            </span>
            <strong>
              {device.name}
            </strong>
          </div>
          <div>
            <span>
              {"系统内存"}
            </span>
            <strong>
              {collected ? formatResourceQuantity(state.resources.memory) : device.memorySize}
            </strong>
          </div>
          {state.hasGpu && <div>
            <span>
              {"GPU"}
            </span>
            <strong>
              {collected ? formatResourceValue(state.resources.gpu) : device.hardware}
            </strong>
          </div>}
          <div>
            <span>
              {"数据来源"}
            </span>
            <strong>
              {collected ? 'IDC / sysAK · 本地 OpenAPI 解析 v' : 'Demo 快照 v'}
              {state.revision}
              {" ·"}
              {" "}
              {localTime(state.sampledAt)}
            </strong>
          </div>
          <div>
            <span>
              {"后台操作"}
            </span>
            <strong>
              {collected ? '只读采集，不清理或修复' : '只读演示，不结束进程'}
            </strong>
          </div>
        </div>
        <p>
          {collected ? snapshot.note || '当前资源值与诊断结果独立；未采集或未检查的项目没有正常结论。' : selectedResource === "energy" ? "能耗占比根据 Demo 预算分摊到程序与 Session，非实测电量；清理空闲会话后统一刷新估算值。" : selectedResource === "cpu" ? "短时 CPU 尖峰尚未归因。查看已有证据，不根据占用率猜测具体进程。" : selectedResource === "memory" ? "结合任务预算与可用内存查看风险，避免把缓存占用直接判成泄漏。" : selectedResource === "gpu" ? "逐卡显存、温度和错误事件在 GPU 诊断页；基础正常不等于 Profiling 已完成。" : "磁盘占用与清理策略分开。删除前核对范围、保留期和恢复边界。"}
        </p>
        <button
          className="hg-button primary"
          onClick={() => onInvestigate(selectedResource === "cpu" ? "load" : selectedResource === "disk" ? "root" : selectedResource === "energy" ? "agents" : selectedResource)}
        >
          {selectedResource === "gpu" ? "进入 GPU 诊断" : `查看${resource.label}相关问题`}
          <ArrowRight size={15} />
        </button>
      </aside>
    </div>
  </section>;
}
