import type { HostMessage, RpcMethod, WebviewMessage } from '../src/protocol';

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };

type HostEvent = 'open-home' | 'dismiss-alert';

const vscode = acquireVsCodeApi();
const pending = new Map<number, { resolve: (value: unknown) => void; timer: number }>();
const listeners: Record<HostEvent, Set<() => void>> = { 'open-home': new Set(), 'dismiss-alert': new Set() };
let nextId = 1;

window.addEventListener('message', (event: MessageEvent<HostMessage>) => {
  const message = event.data;
  if (message.type === 'rpc-result') {
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    window.clearTimeout(request.timer);
    request.resolve(message.value);
  } else {
    listeners[message.type]?.forEach((listener) => listener());
  }
});

export function post(message: WebviewMessage) {
  vscode.postMessage(message);
}

export function rpc<T>(method: RpcMethod, ...args: unknown[]): Promise<T> {
  const id = nextId++;
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Host RPC timed out: ${method}`));
    }, 65_000);
    pending.set(id, { resolve: resolve as (value: unknown) => void, timer });
    try {
      post({ type: 'rpc', id, method, args });
    } catch (error) {
      pending.delete(id);
      window.clearTimeout(timer);
      reject(error);
    }
  });
}

export function onHost(type: HostEvent, listener: () => void) {
  listeners[type].add(listener);
  return () => { listeners[type].delete(listener); };
}
