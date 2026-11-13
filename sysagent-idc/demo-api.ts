import type { IncomingMessage, ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import type { Plugin, PreviewServer, ViteDevServer } from 'vite';
import { startMockOpenApi } from './openapi-service';

const require = createRequire(import.meta.url);
interface Controller {
  close(): Promise<void>;
  status(): unknown;
  snapshot(refresh?: boolean): Promise<unknown>;
  agentSnapshot(refresh?: boolean): Promise<unknown>;
  reset(parameters: Record<string, unknown>): Promise<unknown>;
  operation(parameters: Record<string, unknown>): Promise<unknown>;
  prepareProcessCleanup(parameters: Record<string, unknown>): Promise<unknown>;
  executeProcessCleanup(parameters: Record<string, unknown>): Promise<unknown>;
  setEnabled(enabled: unknown): unknown;
  setInspectionInterval(minutes: unknown): unknown;
}
const { createIdcController, CollectorError } = require('./electron/idc-controller.cjs') as {
  createIdcController(options: { bundleRoot: string; settingsPath: string; startMockOpenApi: typeof startMockOpenApi }): Promise<Controller>;
  CollectorError: new (code: string, message: string, status: number) => Error & { code: string; status: number; retryable: boolean };
};
const routes = new Set(['snapshot', 'agent-diagnostic', 'reset', 'operations', 'status', 'enabled', 'interval', 'process-prepare', 'process-execute']);

export function demoApi(): Plugin {
  const attach = (server: ViteDevServer | PreviewServer) => {
    const controller = createIdcController({
      bundleRoot: fileURLToPath(new URL('./resources/sysak', import.meta.url)),
      settingsPath: fileURLToPath(new URL('./resources/idc-settings.json', import.meta.url)),
      startMockOpenApi,
    });
    server.httpServer?.once('close', () => { void controller.then((value) => value.close()); });
    server.middlewares.use('/api/idc', async (request: IncomingMessage, response: ServerResponse) => {
      const send = (status: number, value: unknown) => {
        response.statusCode = status;
        response.setHeader('Content-Type', 'application/json; charset=utf-8');
        response.setHeader('Cache-Control', 'no-store');
        response.end(JSON.stringify(value));
      };
      try {
        if (request.headers.origin) {
          let sameOrigin = false;
          try { sameOrigin = new URL(request.headers.origin).host === request.headers.host; } catch { sameOrigin = false; }
          if (!sameOrigin) throw new CollectorError('INVALID_ORIGIN', '不允许跨站访问本地采集接口', 403);
        }
        if (!request.headers.host || !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(`http://${request.headers.host}`).hostname)) {
          throw new CollectorError('INVALID_HOST', '本地采集接口仅接受回环地址', 403);
        }
        const route = (request.url ?? '/').split('?')[0].replace(/^\//, '');
        if (!routes.has(route)) throw new CollectorError('NOT_FOUND', '未知本地采集接口', 404);
        const method = ['snapshot', 'agent-diagnostic', 'status'].includes(route) ? 'GET' : 'POST';
        if (request.method !== method) {
          response.setHeader('Allow', method);
          throw new CollectorError('METHOD_NOT_ALLOWED', '不支持的请求方法', 405);
        }
        let body: Record<string, unknown> = {};
        if (method === 'POST') {
          if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
            throw new CollectorError('JSON_REQUIRED', '请求体必须为 JSON', 415);
          }
          const chunks: Buffer[] = [];
          let size = 0;
          for await (const chunk of request) {
            size += Buffer.byteLength(chunk);
            if (size > 8192) throw new CollectorError('BODY_TOO_LARGE', '操作参数超过 8192 字节', 413);
            chunks.push(Buffer.from(chunk));
          }
          try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
          catch { throw new CollectorError('INVALID_PARAMETERS', '无效的 JSON 参数', 400); }
          if (!body || typeof body !== 'object' || Array.isArray(body)) throw new CollectorError('INVALID_PARAMETERS', '无效的操作参数', 400);
        }
        const value = await controller;
        let data;
        if (route === 'status') data = value.status();
        else if (route === 'snapshot' || route === 'agent-diagnostic') {
          const refresh = new URL(request.url ?? '/', 'http://localhost').searchParams.get('refresh');
          if (refresh !== null && !['true', 'false'].includes(refresh)) throw new CollectorError('INVALID_PARAMETERS', '刷新参数必须为 true 或 false', 400);
          data = route === 'agent-diagnostic' ? await value.agentSnapshot(refresh === 'true') : refresh === null ? await value.snapshot() : await value.snapshot(refresh === 'true');
        } else if (route === 'reset') data = await value.reset(body);
        else if (route === 'operations') data = await value.operation(body);
        else if (route === 'process-prepare') data = await value.prepareProcessCleanup(body);
        else if (route === 'process-execute') data = await value.executeProcessCleanup(body);
        else if (route === 'interval') {
          if (Object.keys(body).some((key) => key !== 'inspection_interval_minutes')) throw new CollectorError('INVALID_PARAMETERS', '无效的巡检周期参数', 400);
          data = value.setInspectionInterval(body.inspection_interval_minutes);
        } else {
          if (Object.keys(body).some((key) => key !== 'enabled')) throw new CollectorError('INVALID_PARAMETERS', '无效的采集启停参数', 400);
          data = value.setEnabled(body.enabled);
        }
        send(200, { ok: true, data });
      } catch (error) {
        const known = error instanceof CollectorError;
        const detail = { code: known ? error.code : 'INTERNAL_ERROR', message: known ? error.message : '本地采集服务暂不可用',
          status: known ? error.status : 503, retryable: known ? error.retryable : true };
        send(detail.status, { ok: false, error: detail });
      }
    });
  };
  return { name: 'sysom-idc-api', configureServer: attach, configurePreviewServer: attach };
}
