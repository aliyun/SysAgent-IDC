import type { HealthState } from '../../sysagent-idc/src/health-data';
import type { ClientReply, CollectorStatus, ProcessCleanupPlan, ProcessCleanupResult } from '../../sysagent-idc/src/idc-client';
import { onHost, post, rpc } from './host-bridge';

const noop = () => {};
const collapse = async () => post({ type: 'collapse' });

window.sysomDesktop = {
  isElectron: true,
  isFloating: false,
  gpu: document.body.dataset.sysomGpu === '1',
  healthSnapshot: (refresh = false) => rpc<ClientReply<HealthState>>('healthSnapshot', refresh),
  agentDiagnostic: (refresh = false) => rpc<ClientReply<import('../../sysagent-idc/src/agent-diagnostics-data').AgentDiagnostic>>('agentDiagnostic', refresh),
  healthReset: ({ hasGpu }) => rpc<ClientReply<HealthState>>('healthReset', { hasGpu }),
  healthOperation: ({ operation, parameters }) => rpc<ClientReply<HealthState>>('healthOperation', { operation, parameters }),
  prepareProcessCleanup: ({ resource, ids, revision }) => rpc<ClientReply<ProcessCleanupPlan>>('prepareProcessCleanup', { resource, ids, revision }),
  executeProcessCleanup: ({ token }) => rpc<ClientReply<ProcessCleanupResult>>('executeProcessCleanup', { token }),
  collectorStatus: () => rpc<ClientReply<CollectorStatus>>('collectorStatus'),
  setCollectorEnabled: (enabled) => rpc<ClientReply<CollectorStatus>>('setCollectorEnabled', enabled),
  setInspectionInterval: (minutes) => rpc<ClientReply<CollectorStatus>>('setInspectionInterval', minutes),
  minimize: collapse,
  hideToLauncher: collapse,
  close: collapse,
  openHome: async () => post({ type: 'open-home' }),
  getLauncherState: async () => ({ revision: 0, pulseRevision: null, items: [] }),
  updateLauncherState: (state) => post({ type: 'launcher', state }),
  onLauncherState: () => noop,
  onOpenHome: (callback) => onHost('open-home', callback),
  onCollapsed: () => noop,
  onDismissAlert: (callback) => onHost('dismiss-alert', callback),
  dismissAlert: noop,
  beginDrag: noop,
  moveDrag: noop,
  endDrag: noop,
  showLauncherMenu: noop,
};

const blobs = new Map<string, Blob>();
const createObjectURL = URL.createObjectURL.bind(URL);
URL.createObjectURL = (object: Blob | MediaSource) => {
  const url = createObjectURL(object);
  if (object instanceof Blob) blobs.set(url, object);
  return url;
};
const anchorClick = HTMLAnchorElement.prototype.click;
HTMLAnchorElement.prototype.click = function click(this: HTMLAnchorElement) {
  const blob = this.download ? blobs.get(this.href) : undefined;
  if (!blob) return anchorClick.call(this);
  const filename = this.download;
  blobs.delete(this.href);
  blob.text().then((content) => post({ type: 'save', filename, content }));
};

Object.defineProperty(navigator, 'clipboard', {
  configurable: true,
  value: { writeText: async (text: string) => post({ type: 'clipboard', text: String(text) }) },
});
