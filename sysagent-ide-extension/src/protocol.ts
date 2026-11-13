export const rpcMethods = [
  'healthSnapshot',
  'agentDiagnostic',
  'healthReset',
  'healthOperation',
  'prepareProcessCleanup',
  'executeProcessCleanup',
  'collectorStatus',
  'setCollectorEnabled',
  'setInspectionInterval',
] as const;

export type RpcMethod = (typeof rpcMethods)[number];

export interface LauncherState {
  revision: number;
  pulseRevision: number | null;
  items: { label: string; usage: number }[];
}

export type WebviewMessage =
  | { type: 'rpc'; id: number; method: RpcMethod; args: unknown[] }
  | { type: 'launcher'; state: LauncherState }
  | { type: 'collapse' }
  | { type: 'open-home' }
  | { type: 'save'; filename: string; content: string }
  | { type: 'clipboard'; text: string };

export type HostMessage =
  | { type: 'rpc-result'; id: number; value: unknown }
  | { type: 'open-home' }
  | { type: 'dismiss-alert' };
