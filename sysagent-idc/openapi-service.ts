import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import contract from './openapi-contract.json';
import { type HealthState } from './src/health-data';
import { parseCollectedState } from './collected-state';
import { parseAgentDiagnostic, AgentSnapshotError, AGENT_SOURCE_LIMITS } from './agent-diagnostics';
import { type AgentDiagnostic } from './src/agent-diagnostics-data';

export { summarizeHealth, buildHealthReport } from './src/health-data';

const SCHEMA_VERSION = '1.0';
const REQUEST_LIMIT = 10 * 1024 * 1024;
const RAW_LIMIT = 8 * 1024 * 1024;
const DEVICE_LIMIT = 32;
const RESULT_LIMIT = 100;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const operations = [
  'snapshot', 'reset', 'inspect', 'cleanup', 'optimize',
  'sessions-cleanup', 'alert-sample',
] as const;
type Operation = typeof operations[number];
type Profile = 'resources' | 'inspection';
type JsonObject = Record<string, unknown>;
interface Permissions {
  status: 'granted' | 'partial' | 'denied';
  elevated?: boolean;
  denied?: string[];
}
interface Receipt {
  raw_bytes: number;
  profile: Profile;
  collected_at: string;
  collection_status: 'ok' | 'partial';
  collector: { name: 'sysak'; version?: string; permissions?: Permissions };
  device: { id: string };
}
interface Task {
  id: string;
  status: 'completed';
  operation: Operation | 'agent-diagnose';
  simulated: false;
  read_only: true;
}
interface CollectionResponse {
  schema_version: '1.0';
  request_id: string;
  task_id: string;
  mode: 'mock';
  read_only: true;
  state: HealthState;
  receipt: Receipt;
  task: Task;
}
interface AgentDiagnosticResponse {
  schema_version: '1.0';
  request_id: string;
  task_id: string;
  mode: 'mock';
  read_only: true;
  report: AgentDiagnostic;
  task: Task;
}
type EvidenceResponse = CollectionResponse | AgentDiagnosticResponse;
class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly retryable = false) {
    super(message);
  }
}
function fail(message: string): never {
  throw new ApiError(400, 'invalid_request', message);
}
function object(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function uuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}
function keys(value: JsonObject, allowed: readonly string[]) {
  if (Object.keys(value).some((key) => !allowed.includes(key))) fail('Unsupported field');
}
function string(value: unknown, max = 128): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max * 2 && [...value].length <= max;
}
function profileFor(operation: Operation): Profile {
  return operation === 'inspect' ? 'inspection' : 'resources';
}
function timestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(value);
  if (!match || !Number.isFinite(Date.parse(value))) return false;
  const year = Number(match[1]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return Number(match[3]) <= days[Number(match[2]) - 1];
}
function send(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(JSON.stringify(value));
}

async function readBody(request: IncomingMessage): Promise<{ value: unknown; text: string; digest: string }> {
  if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json' ||
      (request.headers['content-encoding'] && request.headers['content-encoding'] !== 'identity')) {
    throw new ApiError(415, 'unsupported_media_type', 'An uncompressed application/json body is required');
  }
  const length = request.headers['content-length'];
  if (length && Number(length) > REQUEST_LIMIT) {
    throw new ApiError(413, 'request_too_large', 'Request exceeds 10 MiB');
  }
  // Do not destroy the socket on overflow: the caller must receive the JSON 413.
  const chunks: Buffer[] = [];
  let size = 0;
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      request.off('data', onData);
      request.off('end', onEnd);
      request.off('error', onError);
      request.off('aborted', onAborted);
    };
    const onError = () => { cleanup(); reject(new ApiError(400, 'invalid_request', 'Unable to read request')); };
    const onAborted = () => { cleanup(); reject(new ApiError(400, 'invalid_request', 'Request aborted')); };
    const onEnd = () => { cleanup(); resolve(); };
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > REQUEST_LIMIT) {
        cleanup();
        request.resume();
        reject(new ApiError(413, 'request_too_large', 'Request exceeds 10 MiB'));
      } else chunks.push(chunk);
    };
    request.on('data', onData);
    request.once('end', onEnd);
    request.once('error', onError);
    request.once('aborted', onAborted);
  });
  const bytes = Buffer.concat(chunks);
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return { value: JSON.parse(text), text, digest: createHash('sha256').update(bytes).digest('hex') };
  } catch {
    fail('Body must be valid UTF-8 JSON');
  }
}

// Original bytes preserve whitespace limits; duplicate keys would be ambiguous.
function rawBytes(text: string): number {
  let position = 0;
  const whitespace = () => { while (/\s/.test(text[position] ?? '') && position < text.length) position++; };
  const quoted = () => {
    position++;
    while (position < text.length) {
      const char = text[position++];
      if (char === '\\') position++;
      else if (char === '"') return;
    }
  };
  whitespace();
  position++; // opening envelope brace
  const seen = new Set<string>();
  let size = 0;
  while (position < text.length) {
    whitespace();
    if (text[position] === '}') break;
    const keyStart = position;
    quoted();
    const key: string = JSON.parse(text.slice(keyStart, position));
    if (seen.has(key)) fail('Duplicate envelope field');
    seen.add(key);
    whitespace();
    position++; // colon
    whitespace();
    const start = position;
    let depth = 0;
    while (position < text.length) {
      const char = text[position];
      if (char === '"') { quoted(); continue; }
      if (char === '{' || char === '[') depth++;
      else if (char === '}' || char === ']') {
        if (!depth) break;
        depth--;
        position++;
        if (!depth) break;
        continue;
      } else if (char === ',' && !depth) break;
      position++;
    }
    if (key === 'raw_snapshot') size = Buffer.byteLength(text.slice(start, position), 'utf8');
    whitespace();
    if (text[position] === '}') break;
    position++; // comma
  }
  if (size > RAW_LIMIT) throw new ApiError(413, 'raw_snapshot_too_large', 'raw_snapshot exceeds 8 MiB');
  return size;
}

function receiptFor(raw: unknown, requestId: string, deviceId: string, operation: Operation, size: number): Receipt {
  if (!object(raw) || raw.schema_version !== SCHEMA_VERSION || raw.request_id !== requestId) {
    fail('Invalid raw_snapshot version or request_id');
  }
  if (!object(raw.collection) || raw.collection.profile !== profileFor(operation) ||
      !['ok', 'partial', 'error'].includes(raw.collection.status as string)) {
    fail('Invalid collection profile or status');
  }
  if (!object(raw.resources) || !object(raw.configuration) || !object(raw.diagnostics) ||
      !object(raw.collector) || raw.collector.name !== 'sysak' || !object(raw.device) ||
      !object(raw.capabilities) || raw.capabilities.read_only !== true) {
    fail('raw_snapshot requires sysak collector, device, read-only capabilities, and structured sections');
  }
  if (!timestamp(raw.collection.finished_at)) fail('Invalid collection.finished_at timestamp');
  const collector: Receipt['collector'] = { name: 'sysak' };
  if (raw.collector.version !== undefined) {
    if (!string(raw.collector.version)) fail('Invalid collector version');
    collector.version = raw.collector.version;
  }
  if (raw.collector.permissions !== undefined) {
    const permissions = raw.collector.permissions;
    if (!object(permissions)) fail('Invalid collector permissions');
    keys(permissions, ['status', 'elevated', 'denied']);
    if (!['granted', 'partial', 'denied'].includes(permissions.status as string) ||
        (permissions.elevated !== undefined && typeof permissions.elevated !== 'boolean') ||
        (permissions.denied !== undefined && (!Array.isArray(permissions.denied) || permissions.denied.length > 64 ||
          !permissions.denied.every((entry) => string(entry)) || new Set(permissions.denied).size !== permissions.denied.length))) {
      fail('Invalid collector permissions');
    }
    collector.permissions = {
      status: permissions.status as Permissions['status'],
      ...(permissions.elevated !== undefined ? { elevated: permissions.elevated as boolean } : {}),
      ...(permissions.denied !== undefined ? { denied: permissions.denied as string[] } : {}),
    };
  }
  if (raw.collection.status === 'error') {
    throw new ApiError(503, 'collection_failed', 'Collector reported an error; no state was changed', true);
  }
  return {
    raw_bytes: size, profile: profileFor(operation), collected_at: raw.collection.finished_at,
    collection_status: raw.collection.status as 'ok' | 'partial',
    collector, device: { id: deviceId },
  };
}

// The service parses submitted evidence, but never invokes tools or persists raw data.
export async function startMockOpenApi({ token, port = 0 }: { token: string; port?: number }): Promise<{
  baseUrl: string; close: () => Promise<void>;
}> {
  if (typeof token !== 'string' || !/^[\x21-\x7e]+$/.test(token)) throw new Error('A nonempty Bearer token without whitespace is required');
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid listen port');
  const tokenDigest = createHash('sha256').update(token).digest();
  const devices = new Map<string, CollectionResponse>();
  const results = new Map<string, { digest: string; route: string; response: EvidenceResponse }>();
  const tasks = new Map<string, Task>();
  function retain(cacheKey: string, digest: string, route: string, result: EvidenceResponse) {
    if (results.size >= RESULT_LIMIT) {
      const oldestKey = results.keys().next().value!;
      tasks.delete(results.get(oldestKey)!.response.task_id);
      results.delete(oldestKey);
    }
    results.set(cacheKey, { digest, route, response: result });
    tasks.set(result.task_id, result.task);
  }
  const server = createServer((request, response) => {
    void handle(request, response);
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 30_000;

  async function handle(request: IncomingMessage, response: ServerResponse) {
    let requestId: string | undefined;
    try {
      const match = /^Bearer ([\x21-\x7e]+)$/i.exec(request.headers.authorization ?? '');
      // Hashes always have equal length, including absent/wrong-length tokens.
      const supplied = createHash('sha256').update(match?.[1] ?? '').digest();
      const authenticated = timingSafeEqual(tokenDigest, supplied);
      if (!match || !authenticated) {
        response.setHeader('WWW-Authenticate', 'Bearer');
        throw new ApiError(401, 'unauthorized', 'A valid Bearer token is required');
      }
      if (request.headers.origin !== undefined) throw new ApiError(403, 'origin_not_allowed', 'Browser origins are not allowed');
      const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
      const deviceRoute = /^\/openapi\/v1\/devices\/([^/]+)\/snapshot$/.exec(path);
      const taskRoute = /^\/openapi\/v1\/tasks\/([^/]+)$/.exec(path);
      const agentRoute = path === '/openapi/v1/agent-diagnostics';
      const known = path === '/openapi/v1/collections' || agentRoute || path === '/openapi/v1/capabilities' ||
        path === '/openapi/v1/openapi.json' || deviceRoute || taskRoute;
      if (!known) throw new ApiError(404, 'not_found', 'Route not found');
      const method = path === '/openapi/v1/collections' || agentRoute ? 'POST' : 'GET';
      if (request.method !== method) {
        response.setHeader('Allow', method);
        throw new ApiError(405, 'method_not_allowed', 'Method not allowed');
      }
      if (path === '/openapi/v1/openapi.json') { send(response, 200, contract); return; }
      if (path === '/openapi/v1/capabilities') {
        send(response, 200, {
          schema_version: SCHEMA_VERSION, api_version: 'v1', mode: 'mock', read_only: true,
          collection: { collector: 'sysak', profiles: ['resources', 'inspection'], arbitrary_commands: false },
          demo_operations: [], collection_operations: ['snapshot', 'reset', 'inspect'], destructive_actions_enabled: false,
          agent_diagnostics: {
            route: '/openapi/v1/agent-diagnostics', method: 'POST', source: 'agentsight', operation: 'agent-diagnose',
            independent_evidence: true, requires_sysak_snapshot: false, requires_revision: false,
            mutates_sysak_snapshot: false, analyzer: 'local-rules', external_calls: false, source_limits: AGENT_SOURCE_LIMITS,
          },
          tasks: { execution: 'synchronous', statuses: ['completed'], asynchronous_supported: false },
          limits: { request_bytes: REQUEST_LIMIT, raw_snapshot_bytes: RAW_LIMIT, devices: DEVICE_LIMIT, retained_results: RESULT_LIMIT },
        });
        return;
      }
      if (deviceRoute) {
        if (!uuid(deviceRoute[1])) fail('Invalid device_id UUID');
        const latest = devices.get(deviceRoute[1].toLowerCase());
        if (!latest) throw new ApiError(404, 'not_found', 'Device snapshot not found');
        send(response, 200, latest);
        return;
      }
      if (taskRoute) {
        if (!uuid(taskRoute[1])) fail('Invalid task_id UUID');
        const task = tasks.get(taskRoute[1].toLowerCase());
        if (!task) throw new ApiError(404, 'not_found', 'Task not found or no longer retained');
        send(response, 200, { schema_version: SCHEMA_VERSION, task });
        return;
      }
      const { value, text, digest } = await readBody(request);
      if (!object(value)) fail('Request must be a JSON object');
      if (uuid(value.request_id)) requestId = value.request_id;
      const cached = requestId ? results.get(requestId.toLowerCase()) : undefined;
      if (cached) {
        if (cached.digest !== digest || cached.route !== path) throw new ApiError(409, 'idempotency_conflict', 'request_id was already used with another payload or route');
        send(response, 200, cached.response);
        return;
      }
      const size = rawBytes(text);
      if (agentRoute) {
        keys(value, ['schema_version', 'request_id', 'device_id', 'raw_snapshot']);
        if (value.schema_version !== SCHEMA_VERSION || !requestId || !uuid(value.device_id)) fail('Invalid schema version or UUID');
        let report: AgentDiagnostic;
        try { report = parseAgentDiagnostic(value.raw_snapshot); }
        catch (error) {
          if (error instanceof AgentSnapshotError) fail(error.message);
          throw error;
        }
        const taskId = randomUUID();
        const task: Task = { id: taskId, status: 'completed', operation: 'agent-diagnose', simulated: false, read_only: true };
        const result: AgentDiagnosticResponse = {
          schema_version: SCHEMA_VERSION, request_id: requestId, task_id: taskId,
          mode: 'mock', read_only: true, report, task,
        };
        // Independent evidence: never reads, allocates or revises a SysAK device snapshot.
        retain(requestId.toLowerCase(), digest, path, result);
        send(response, 200, result);
        return;
      }
      keys(value, ['schema_version', 'request_id', 'device_id', 'operation', 'raw_snapshot', 'parameters']);
      if (value.schema_version !== SCHEMA_VERSION || !requestId || !uuid(value.device_id)) fail('Invalid schema version or UUID');
      const cacheKey = requestId.toLowerCase();
      if (!operations.includes(value.operation as Operation)) fail('Unsupported operation');
      if (!object(value.parameters)) fail('parameters must be an object');
      const operation = value.operation as Operation;
      const parameters = value.parameters;
      const deviceKey = value.device_id.toLowerCase();
      const previous = devices.get(deviceKey);
      const revisionOptional = ['snapshot', 'reset'].includes(operation);
      // Stale revisions must fail before raw or action validation.
      if (!revisionOptional || parameters.revision !== undefined) {
        if (!Number.isInteger(parameters.revision) || (parameters.revision as number) < 1) fail('A positive integer revision is required');
        if (parameters.revision !== (previous?.state.revision ?? 1)) throw new ApiError(409, 'revision_conflict', 'Snapshot changed; refresh before retrying');
      }
      if (!['snapshot', 'reset', 'inspect'].includes(operation)) throw new ApiError(409, 'read_only', '真实采集数据为只读，不支持清理、优化或模拟改值');
      keys(parameters, ['revision', 'hasGpu']);
      if (parameters.hasGpu !== undefined && typeof parameters.hasGpu !== 'boolean') fail('hasGpu must be boolean');
      const receipt = receiptFor(value.raw_snapshot, requestId, value.device_id, operation, size);
      if (!previous && devices.size >= DEVICE_LIMIT) throw new ApiError(503, 'device_capacity', 'Device capacity reached', true);
      const next = parseCollectedState(value.raw_snapshot as JsonObject, previous?.state, operation === 'inspect', operation === 'reset');
      const taskId = randomUUID();
      const task: Task = { id: taskId, status: 'completed', operation, simulated: false, read_only: true };
      const result: CollectionResponse = {
        schema_version: SCHEMA_VERSION, request_id: requestId, task_id: taskId,
        mode: 'mock', read_only: true, state: next, receipt, task,
      };
      // No await keeps revision checks and commits atomic.
      devices.set(deviceKey, result);
      retain(cacheKey, digest, path, result);
      send(response, 200, result);
    } catch (error) {
      if (response.destroyed || response.writableEnded) return;
      request.resume();
      const apiError = error instanceof ApiError ? error : new ApiError(503, 'service_unavailable', 'Mock service unavailable', true);
      send(response, apiError.status, {
        schema_version: SCHEMA_VERSION,
        ...(requestId ? { request_id: requestId } : {}),
        error: { code: apiError.code, message: apiError.message, retryable: apiError.retryable },
      });
    }
  }
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => { server.off('listening', onListening); reject(error); };
    const onListening = () => { server.off('error', onError); resolve(); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Mock server did not bind a TCP port');
  let closing: Promise<void> | undefined;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => {
      if (!closing) {
        closing = new Promise<void>((resolve, reject) => {
          server.close((error) => {
            devices.clear(); results.clear(); tasks.clear();
            if (error) reject(error); else resolve();
          });
          server.closeAllConnections();
        });
      }
      return closing;
    },
  };
}
