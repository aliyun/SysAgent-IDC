/// <reference types="vite/client" />

interface DesktopLauncherState {
  mode?: 'collected' | 'demo';
  revision: number;
  pulseRevision: number | null;
  items: { label: string; usage: number }[];
}

interface Window {
  sysomDesktop?: {
    isElectron: boolean;
    isFloating: boolean;
    gpu?: boolean;
    healthSnapshot: (refresh?: boolean) => Promise<import('./idc-client').ClientReply<import('./health-data').HealthState>>;
    agentDiagnostic: (refresh?: boolean) => Promise<import('./idc-client').ClientReply<import('./agent-diagnostics-data').AgentDiagnostic>>;
    healthReset: (parameters: { hasGpu: boolean }) => Promise<import('./idc-client').ClientReply<import('./health-data').HealthState>>;
    healthOperation: (payload: import('./idc-client').OperationRequest) => Promise<import('./idc-client').ClientReply<import('./health-data').HealthState>>;
    prepareProcessCleanup: (payload: { resource: import('./health-data').ResourceId; ids: string[]; revision: number }) => Promise<import('./idc-client').ClientReply<import('./idc-client').ProcessCleanupPlan>>;
    executeProcessCleanup: (payload: { token: string }) => Promise<import('./idc-client').ClientReply<import('./idc-client').ProcessCleanupResult>>;
    collectorStatus: () => Promise<import('./idc-client').ClientReply<import('./idc-client').CollectorStatus>>;
    setCollectorEnabled: (enabled: boolean) => Promise<import('./idc-client').ClientReply<import('./idc-client').CollectorStatus>>;
    setInspectionInterval: (minutes: number) => Promise<import('./idc-client').ClientReply<import('./idc-client').CollectorStatus>>;
    minimize: () => Promise<void>;
    hideToLauncher: () => Promise<void>;
    openHome: () => Promise<void>;
    close: () => Promise<void>;
    getLauncherState: () => Promise<DesktopLauncherState>;
    updateLauncherState: (state: DesktopLauncherState) => void;
    onLauncherState: (callback: (state: DesktopLauncherState) => void) => () => void;
    onOpenHome: (callback: () => void) => () => void;
    onCollapsed: (callback: () => void) => () => void;
    onDismissAlert: (callback: () => void) => () => void;
    dismissAlert: () => void;
    beginDrag: (x: number, y: number) => void;
    moveDrag: (x: number, y: number) => void;
    endDrag: () => void;
    showLauncherMenu: () => void;
  };
}
