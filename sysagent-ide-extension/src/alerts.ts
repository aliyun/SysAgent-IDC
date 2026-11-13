import { availableAlertTargets, type AlertTarget, type HealthState } from '../../sysagent-idc/src/health-data';

export const alertLabels: Record<AlertTarget, string> = {
  cpu: 'CPU 利用率',
  energy: '能耗预算占比',
  memory: '系统内存',
  gpu: 'GPU 利用率',
  root: '根目录使用率',
  fd: 'FD 使用率',
};

export function targetUsage(state: HealthState, target: AlertTarget): number | null {
  return target === 'fd'
    ? state.inspections.find((inspection) => inspection.id === 'fd')?.usage ?? null
    : state.resources[target === 'root' ? 'disk' : target].usage;
}

export function crossedTargets(previous: HealthState, current: HealthState): AlertTarget[] {
  return availableAlertTargets(current).filter((target) => {
    const before = targetUsage(previous, target);
    const after = targetUsage(current, target);
    return before !== null && after !== null && before <= 90 && after > 90;
  });
}
