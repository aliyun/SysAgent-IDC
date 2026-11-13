import * as vscode from 'vscode';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { detectGpu } from '../../sysagent-idc/electron/gpu-detect.cjs';
import { stateResourceIds, summarizeHealth, buildHealthReport, type AlertTarget, type HealthState } from '../../sysagent-idc/src/health-data';
import { alertLabels, crossedTargets, targetUsage } from './alerts';
import { rpcMethods, type HostMessage, type RpcMethod, type WebviewMessage } from './protocol';

interface Controller {
  snapshot(refresh?: boolean): Promise<HealthState>;
  agentSnapshot(refresh?: boolean): Promise<import('../../sysagent-idc/src/agent-diagnostics-data').AgentDiagnostic>;
  reset(parameters: unknown): Promise<HealthState>;
  operation(payload: unknown): Promise<HealthState>;
  prepareProcessCleanup(payload: unknown): Promise<unknown>;
  executeProcessCleanup(payload: unknown): Promise<unknown>;
  status(): unknown;
  setEnabled(enabled: boolean): unknown;
  setInspectionInterval(minutes: number): unknown;
  close(): Promise<void>;
}
const { createIdcController } = require('../../sysagent-idc/electron/idc-controller.cjs') as {
  createIdcController(options: { bundleRoot: string; deviceId: string; startMockOpenApi: unknown; hasGpu: boolean; settingsPath: string; agentSightService: boolean;
    agentSight: { deploymentRoot: string; packageDirectories: string[] };
    queryApi: { discoveryDirectory: string; hostKind: string; summarizeHealth: unknown; buildHealthReport: unknown } }): Promise<Controller>;
};
const { startMockOpenApi } = require('../../sysagent-idc/electron/generated/openapi.cjs');
const { agentSightHome } = require('../../sysagent-idc/electron/agentsight-deployment.cjs') as { agentSightHome(): string };

const pulseFrames = 6;
const pulseInterval = 250;
const maxSaveBytes = 5 * 1024 * 1024;

class SysagentGuard implements vscode.Disposable {
  private readonly status = vscode.window.createStatusBarItem('sysagent.guard', vscode.StatusBarAlignment.Right, 100);
  private panel: vscode.WebviewPanel | undefined;
  private snapshot: HealthState | undefined;
  private alerts: AlertTarget[] = [];
  private webviewAlert = false;
  private webviewCalls = 0;
  private pulseFrame = 0;
  private pulseTimer: NodeJS.Timeout | undefined;
  private disposed = false;
  private loadError: string | undefined;
  private readonly refreshTimer: NodeJS.Timeout;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly hasGpu: boolean,
    private readonly controller: Controller,
  ) {
    this.status.name = 'SysAgent管家';
    this.status.command = 'sysagent.openHome';
    this.render();
    this.status.show();
    this.refresh().catch(() => undefined);
    this.refreshTimer = setInterval(() => this.refresh().catch(() => undefined), 5000);
  }

  inspect() {
    return {
      statusText: this.status.text,
      alerts: this.alerts.map((target) => alertLabels[target]),
      panelOpen: this.panel !== undefined,
      revision: this.snapshot?.revision,
      mode: this.snapshot?.mode,
      collector: this.controller.status(),
      hasGpu: this.hasGpu,
      webviewCalls: this.webviewCalls,
      webviewAlert: this.webviewAlert,
    };
  }

  openHome() {
    if (!this.webviewAlert) this.clearAlert();
    if (this.panel) {
      this.panel.reveal();
      this.send({ type: 'open-home' });
      return;
    }
    const panel = vscode.window.createWebviewPanel('sysagent.home', 'SysAgent管家', vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview')],
    });
    panel.iconPath = vscode.Uri.joinPath(this.extensionUri, 'dist', 'icon.png');
    panel.webview.onDidReceiveMessage((message) => { if (this.panel === panel) this.receive(message); });
    panel.onDidDispose(() => {
      if (this.panel === panel) {
        this.panel = undefined;
        this.webviewAlert = false;
      }
    });
    this.panel = panel;
    panel.webview.html = this.html(panel.webview);
  }

  async runInspection() {
    const state = await this.controller.snapshot();
    this.observe(await this.controller.operation({ operation: 'inspect', parameters: { revision: state.revision } }));
  }

  dispose() {
    this.disposed = true;
    clearInterval(this.refreshTimer);
    if (this.pulseTimer) clearInterval(this.pulseTimer);
    this.panel?.dispose();
    this.status.dispose();
    return this.controller.close();
  }

  private async refresh() {
    try {
      const next = await this.controller.snapshot();
      if (!this.disposed) { this.loadError = undefined; this.observe(next); }
    } catch (error) {
      if (!this.disposed) { this.loadError = error instanceof Error ? error.message : '本机采集不可用'; this.render(); }
      throw error;
    }
  }

  private observe(next: HealthState) {
    const previous = this.snapshot;
    if (previous && next.revision < previous.revision) return;
    this.snapshot = next;
    const crossed = previous && previous.revision !== next.revision ? crossedTargets(previous, next) : [];
    if (crossed.length) this.raiseAlert(crossed);
    else this.render();
  }

  private raiseAlert(targets: AlertTarget[]) {
    this.alerts = [...new Set([...this.alerts, ...targets])];
    this.pulse();
    if (this.panel?.visible) return;
    const items = targets.map((target) => `${alertLabels[target]} ${targetUsage(this.snapshot!, target)}%`).join('、');
    vscode.window
      .showWarningMessage(`SysAgent管家 · 本机资源阈值告警：${items}。阈值 >90%，部分采集不代表全部系统状态。`, '查看本机健康', '忽略')
      .then((choice) => {
        if (choice === '查看本机健康') this.openHome();
        else if (choice === '忽略') this.dismissAlert();
      });
  }

  private dismissAlert() {
    this.clearAlert();
    this.send({ type: 'dismiss-alert' });
  }

  private clearAlert() {
    this.alerts = [];
    this.stopPulse();
    this.render();
  }

  private pulse() {
    this.stopPulse();
    this.pulseFrame = pulseFrames;
    this.render();
    this.pulseTimer = setInterval(() => {
      this.pulseFrame--;
      if (this.pulseFrame <= 0) this.stopPulse();
      this.render();
    }, pulseInterval);
  }

  private stopPulse() {
    if (this.pulseTimer) clearInterval(this.pulseTimer);
    this.pulseTimer = undefined;
    this.pulseFrame = 0;
  }

  private render() {
    const state = this.snapshot;
    if (this.loadError) {
      this.status.text = '$(warning) SysAgent 采集不可用';
      this.status.tooltip = this.loadError;
      return;
    }
    if (!state) {
      this.status.text = '$(sync~spin) SysAgent';
      this.status.tooltip = 'SysAgent管家：正在采集本机证据';
      return;
    }
    const summary = summarizeHealth(state);
    const alertItems = this.alerts.map((target) => `${alertLabels[target]} ${targetUsage(state, target)}%`);
    if (alertItems.length) {
      this.status.text = `${this.pulseFrame % 2 ? '$(bell)' : '$(bell-dot)'} SysAgent ${alertItems.length} 项告警`;
      this.status.backgroundColor = new vscode.ThemeColor(
        this.pulseFrame > 0 ? 'statusBarItem.errorBackground' : 'statusBarItem.warningBackground',
      );
    } else {
      this.status.text = `$(hubot) SysAgent ${summary.score}分`;
      this.status.backgroundColor = undefined;
    }
    const tooltip = new vscode.MarkdownString(undefined, true);
    tooltip.appendMarkdown(`**SysAgent管家** · 仅已知项评分 ${summary.score}（${summary.band.label}），未知不代表正常\n\n`);
    tooltip.appendMarkdown(`${stateResourceIds(state).map((id) => `${state.resources[id].label} ${state.resources[id].usage === null ? '未知' : `${state.resources[id].usage}%`}`).join(' · ')}\n\n`);
    if (alertItems.length) tooltip.appendMarkdown(`$(bell-dot) 阈值告警：${alertItems.join('、')}\n\n`);
    tooltip.appendMarkdown(`快照 v${state.revision} · 本机实际采集 · 点击打开体检主页`);
    this.status.tooltip = tooltip;
  }

  private send(message: HostMessage) {
    this.panel?.webview.postMessage(message);
  }

  private async receive(message: WebviewMessage) {
    if (!message || typeof message !== 'object' || this.disposed) return;
    switch (message.type) {
      case 'rpc':
        this.webviewCalls++;
        return this.answer(message.id, message.method, message.args);
      case 'launcher': {
        const hasItems = Array.isArray(message.state?.items) && message.state.items.length > 0;
        if (!hasItems && this.webviewAlert) this.clearAlert();
        this.webviewAlert = hasItems;
        return;
      }
      case 'collapse':
        return this.panel?.dispose();
      case 'open-home':
        return this.openHome();
      case 'save':
        return this.save(message.filename, message.content);
      case 'clipboard':
        if (typeof message.text === 'string') await vscode.env.clipboard.writeText(message.text.slice(0, 10000));
    }
  }

  private async answer(id: number, method: RpcMethod, args: unknown[]) {
    if (!Number.isSafeInteger(id) || id < 1) return;
    const panel = this.panel;
    try {
      if (!rpcMethods.includes(method) || !Array.isArray(args) || Buffer.byteLength(JSON.stringify(args)) > 8192 ||
          (method === 'collectorStatus' ? args.length !== 0 : ['healthSnapshot', 'agentDiagnostic'].includes(method) ? args.length > 1 : args.length !== 1)) {
        throw Object.assign(new Error('不支持的本机接口参数'), { code: 'INVALID_PARAMETERS', status: 400 });
      }
      const parameter = args[0];
      let value: unknown;
      switch (method) {
        case 'healthSnapshot':
          if (parameter !== undefined && typeof parameter !== 'boolean') throw Object.assign(new Error('无效的刷新参数'), { code: 'INVALID_PARAMETERS', status: 400 });
          value = await this.controller.snapshot(parameter as boolean | undefined);
          this.observe(value as HealthState);
          break;
        case 'agentDiagnostic':
          if (parameter !== undefined && typeof parameter !== 'boolean') throw Object.assign(new Error('无效的刷新参数'), { code: 'INVALID_PARAMETERS', status: 400 });
          value = await this.controller.agentSnapshot(parameter as boolean | undefined);
          break;
        case 'healthReset': value = await this.controller.reset(parameter); break;
        case 'healthOperation': value = await this.controller.operation(parameter); break;
        case 'prepareProcessCleanup': value = await this.controller.prepareProcessCleanup(parameter); break;
        case 'executeProcessCleanup': value = await this.controller.executeProcessCleanup(parameter); break;
        case 'collectorStatus': value = this.controller.status(); break;
        case 'setCollectorEnabled': value = this.controller.setEnabled(parameter as boolean); break;
        case 'setInspectionInterval': value = this.controller.setInspectionInterval(parameter as number); break;
      }
      if (panel === this.panel && !this.disposed) this.send({ type: 'rpc-result', id, value: { ok: true, data: value } });
    } catch (error) {
      if (panel !== this.panel || this.disposed) return;
      const failure = error as Error & { code?: string; status?: number; retryable?: boolean };
      this.send({ type: 'rpc-result', id, value: { ok: false, error: {
        code: failure.code || 'COLLECTOR_FAILED', message: failure.message || '本机采集接口失败',
        status: failure.status || 503, retryable: failure.retryable === true,
      } } });
    }
  }

  private async save(filename: unknown, content: unknown) {
    if (typeof filename !== 'string' || typeof content !== 'string' || Buffer.byteLength(content) > maxSaveBytes) return;
    const name = path.basename(filename).replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 120) || 'sysagent-report.txt';
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file(os.homedir());
    const target = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.joinPath(folder, name), saveLabel: '保存报告' });
    if (!target) return;
    await vscode.workspace.fs.writeFile(target, Buffer.from(content, 'utf8'));
    vscode.window.showInformationMessage(`SysAgent管家：已保存 ${path.basename(target.fsPath)}`);
  }

  private html(webview: vscode.Webview) {
    const nonce = randomBytes(16).toString('base64');
    const asset = (file: string) => webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview', file));
    const csp = [
      "default-src 'none'",
      `img-src ${webview.cspSource} data: blob:`,
      `font-src ${webview.cspSource}`,
      `style-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');
    return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="${asset('webview.css')}">
<title>SysAgent管家</title>
</head>
<body data-sysom-gpu="${this.hasGpu ? 1 : 0}">
<div id="root"></div>
<script nonce="${nonce}" src="${asset('webview.js')}"></script>
</body>
</html>`;
  }
}

let activeGuard: SysagentGuard | undefined;

export async function activate(context: vscode.ExtensionContext) {
  const hasGpu = detectGpu();
  fs.mkdirSync(context.globalStorageUri.fsPath, { recursive: true, mode: 0o700 });
  const deviceId = context.globalState.get<string>('sysagent.deviceId') || randomUUID();
  await context.globalState.update('sysagent.deviceId', deviceId);
  const controller = await createIdcController({
    bundleRoot: vscode.Uri.joinPath(context.extensionUri, 'dist', 'sysak').fsPath,
    deviceId, startMockOpenApi, hasGpu, settingsPath: path.join(context.globalStorageUri.fsPath, 'inspection-settings.json'), agentSightService: true,
    agentSight: { deploymentRoot: agentSightHome(), packageDirectories: [
      path.join(context.extensionUri.fsPath, 'agentsight-runtime'),
      path.join(path.dirname(context.extensionUri.fsPath), 'agentsight-runtime'),
    ] },
    queryApi: { discoveryDirectory: path.join(context.globalStorageUri.fsPath, 'local-api'), hostKind: 'ide',
      summarizeHealth, buildHealthReport },
  });
  const guard = new SysagentGuard(context.extensionUri, hasGpu, controller);
  activeGuard = guard;
  context.subscriptions.push(guard,
    vscode.commands.registerCommand('sysagent.openHome', () => guard.openHome()),
    vscode.commands.registerCommand('sysagent.inspect', () => guard.runInspection()),
  );
  return { inspect: () => guard.inspect() };
}

export async function deactivate() {
  const guard = activeGuard;
  activeGuard = undefined;
  await guard?.dispose();
}
