import { Modal, ReportItem } from './components';
import type { CloudInspectionReport } from './idc-client';

export const cloudStatusLabels: Record<string, string> = {
  created: '已创建', uploaded: '已上传', queued: '排队中', downloading: '下载中',
  validating: '校验中', analyzing: '分析中', reporting: '生成报告中',
  completed: '已完成', partial_completed: '部分完成', failed: '失败', expired: '已过期', cancelled: '已取消',
};
export const levelLabels: Record<string, string> = { Normal: '正常', Suggestion: '建议', Warning: '警告', Error: '错误', Critical: '严重' };
export const levelRank: Record<string, number> = { Critical: 0, Error: 1, Warning: 2, Suggestion: 3, Normal: 4 };
export const itemNameLabels: Record<string, string> = {
  'collection.coverage': '采集覆盖率', 'config.risk': '内核配置风险', 'cpu.saturation': 'CPU 饱和度',
  'disk.capacity': '磁盘容量', 'fd.exhaustion': '文件描述符', 'gpu.health': 'GPU 健康',
  'log.disk_usage': '日志磁盘占用', 'memory.pressure': '内存压力', 'network.errors': '网络错误', 'service.failed': '系统服务',
};
export const cloudActive = new Set(['created', 'uploaded', 'queued', 'downloading', 'validating', 'analyzing', 'reporting']);

export function CloudReportModal({ report, onClose }: { report: CloudInspectionReport; onClose: () => void }) {
  const summary = report.summary ?? {};
  const items = report.itemSummaries ?? [];
  const overall = summary.overallLevel ?? 'Normal';
  return <Modal title={report.name || '云端巡检报告'} subtitle={`报告 ${report.reportId}`} onClose={onClose} wide>
    <section className="sh-cloud-report" aria-label="云端巡检报告">
      <div className="sh-cloud-report-summary">
        <span className={`sh-level-badge ${overall.toLowerCase()}`}>{levelLabels[overall] ?? overall}</span>
        <span>巡检项 {summary.totalItems ?? items.length} · 异常 {summary.abnormalItems ?? 0}</span>
        <span>实例 {summary.totalInstances ?? 0} · 异常 {summary.abnormalInstances ?? 0}</span>
      </div>
      {report.scope?.hostname && <p className="sh-cloud-report-scope">主机 {report.scope.hostname}{report.scope.window ? ` · 窗口 ${report.scope.window}` : ''}{report.scope.profile ? ` · ${report.scope.profile}` : ''}</p>}
      {items.length === 0
        ? <p className="sh-cloud-report-empty">本次报告未包含项级结果。</p>
        : <div className="sh-cloud-report-items">{items.map(item =>
          <ReportItem key={item.itemName} title={`${itemNameLabels[item.itemName] ?? item.itemName} · ${levelLabels[item.level] ?? item.level}`} description={item.reason || '未见异常说明'} warning={(levelRank[item.level] ?? 4) <= levelRank.Warning} />)}</div>}
    </section>
  </Modal>;
}