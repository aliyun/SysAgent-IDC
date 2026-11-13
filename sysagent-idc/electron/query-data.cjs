'use strict';

class QueryError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'QueryError';
    this.code = code;
    this.status = status;
  }
}

const own = (object, key) => object != null && Object.hasOwn(object, key);
const string = { type: 'string' };
const number = { type: 'number' };
const integer = { type: 'integer' };
const boolean = { type: 'boolean' };
const nullable = schema => ({ ...schema, type: [schema.type, 'null'] });
const date = { type: 'string', format: 'date-time' };
const enumeration = (...values) => ({ type: 'string', enum: values });
const array = items => ({ type: 'array', items });
const object = (properties, required = []) => ({ type: 'object', additionalProperties: false, properties, required });
const quantity = object({ value: number, unit: enumeration('B', 'W'), total: number, available: number }, ['value', 'unit']);
const rowQuantity = object({ value: number, unit: enumeration('B', 'B/s', 'W', 'count') }, ['value', 'unit']);
const resourceSession = object({ id: string, name: string, status: enumeration('active', 'idle', 'completed'), usage: number, cleanable: boolean, defaultSelected: boolean });
const rowProperties = {
  id: string, name: string, detail: string, usage: number, cleanable: boolean, defaultSelected: boolean,
  effect: string, quantity: rowQuantity, pid: integer, starttime: integer, agentKind: string, agentId: string,
  sessions: array(resourceSession),
};
const rowSchema = object(rowProperties);
const deviceProperties = {
  index: integer, name: string, uuid: string, busId: string,
  utilization: nullable(number), memoryUtilization: nullable(number), memoryUsedBytes: nullable(number),
  memoryTotalBytes: nullable(number), temperatureCelsius: nullable(number), powerWatts: nullable(number),
  powerLimitWatts: nullable(number), eccCorrected: nullable(number), eccUncorrected: nullable(number),
  pcieGeneration: nullable(number), pcieMaxGeneration: nullable(number), pcieWidth: nullable(number),
};
const deviceSchema = object(deviceProperties);
const gpuStatus = enumeration('not_run', 'ok', 'partial', 'unavailable', 'error', 'timeout', 'truncated', 'permission_denied');
const gpuFinding = object({ check: string, severity: enumeration('OK', 'WARN', 'ERROR'), message: string, suggestion: string });
const gpuJobProperties = {
  pid: integer, starttime: nullable(integer), name: string, state: string, cpuPercent: nullable(number),
  rssBytes: nullable(integer), gpuIndices: array(integer), smUtilization: nullable(number),
  memoryUtilization: nullable(number), status: gpuStatus, findings: array(gpuFinding),
};
const gpuJob = object(gpuJobProperties);
const gpuJobAnalysis = object({ status: gpuStatus, source: enumeration('sysak ai'), sampledAt: nullable(date), sampleWindowSeconds: nullable(number), complete: boolean, reason: string, processes: array(gpuJob) });
const gpuDiagnostic = object({ status: gpuStatus, outcome: enumeration('normal', 'abnormal', 'unknown', 'no_gpu'), sampledAt: nullable(date), source: enumeration('sysak ai'), complete: boolean, gpuCount: nullable(integer), architectures: array(string), devices: array(string), summary: string, findings: array(gpuFinding), jobAnalysis: gpuJobAnalysis });
const resourceProperties = {
  id: enumeration('cpu', 'energy', 'memory', 'disk', 'gpu'), label: string, usage: nullable(number),
  capacity: nullable(number), unit: string, source: enumeration('sysak', 'demo'),
  status: enumeration('available', 'partial', 'unavailable'), note: string, quantity,
  rankLabel: string, rankUnit: enumeration('%', 'B', 'B/s', 'W', 'count'), sampledAt: date,
  gpuDevices: array(deviceSchema), rows: array(rowSchema),
};
const inspectionProperties = { id: string, label: string, important: boolean, phase: { type: 'integer', enum: [1, 2] }, status: enumeration('normal', 'abnormal', 'unchecked'), usage: nullable(number), detail: string, evidence: array(string), execution: enumeration('complete', 'partial', 'unavailable') };
const optimizationProperties = { id: string, inspection: string, title: string, action: string, effect: string };
const operationProperties = { id: string, kind: enumeration('cleanup', 'session-cleanup', 'optimize', 'inspect', 'demo-alert'), names: array(string), time: date, revision: integer };
const processProperties = { pid: integer, name: string, role: string, status: enumeration('healthy', 'unhealthy', 'hung', 'unknown', 'no_port', 'offline'), ports: array(integer), lastCheckAt: nullable(date), latencyMs: nullable(number), parentPid: nullable(integer), hasCrash: boolean };
const sessionProperties = { id: string, agent: nullable(string), model: nullable(string), conversations: integer, inputTokens: integer, outputTokens: integer, firstSeenAt: nullable(date), lastSeenAt: nullable(date) };
const interruptionProperties = { id: string, sessionId: nullable(string), callId: nullable(string), pid: nullable(integer), agent: nullable(string), type: string, severity: enumeration('critical', 'high', 'medium', 'low'), occurredAt: nullable(date), resolved: boolean };
const latencyProperties = { agent: nullable(string), calls: integer, streamingCalls: integer, ttftP95Ms: nullable(number), e2eP95Ms: nullable(number), tpsP50: nullable(number), tpotP95Ms: nullable(number) };
const agentFindingProperties = { severity: enumeration('info', 'warning', 'error'), title: string, detail: string, suggestion: string };
const coverageProperties = { key: enumeration('processes', 'sessions', 'interruptions', 'interruptionCounts', 'latency'), status: enumeration('available', 'unavailable', 'invalid', 'truncated'), reason: string };
const taskProperties = { id: string, request_id: string, operation: string, status: string, profile: string, collection_status: string, raw_bytes: integer, collected_at: date, simulated: boolean };

const CACHE_LIMITS = [
  'Read-only controller cache; never refreshes, collects, executes actions, or queries the host.',
  'Contains only explicitly allowed normalized fields; no raw payload, credentials, or collector/configuration paths are exposed. Existing typed evidence text is retained, not filesystem access.',
  'Coverage describes the source cache before filtering; an empty result is not evidence of a healthy or fully observed system.',
];
const RESOURCE_LIMITS = [
  'Resource rankings are the collector top20 + agent20 union, not all host processes; every cached row is returned, not the UI Top10.',
  'Disk ranking rows measure B/s I/O, not directory size or disk-space ownership. Resource quantities have their original units.',
  'cleanable/action/effect fields are historical display metadata only; this API cannot execute them.',
];
const AGENT_LIMITS = [
  'AgentSight evidence uses a fixed 24h window; source coverage, filteredProcesses and lastScanAt bound the evidence, not all agents or all history.',
  'Health revision does not identify a new AgentSight scan; sampled_at and window identify its independent cache.',
  'Process evidence has PID but no starttime; it cannot establish a persistent OS process identity.',
];
const GPU_LIMITS = [
  'GPU diagnostics/job evidence is an on-demand short window (up to 10 seconds), not continuous history; status, complete and sampleWindowSeconds bound coverage.',
  'GPU job identity is PID + starttime; null starttime is unverified and its ID is snapshot-scoped.',
];
const GENERATED_LIMIT = 'Generated IDs are deterministic only within this cached snapshot (source timestamp/revision and row order); do not reuse them after a cache change.';

function definition(name, family, key, properties, fields, limitations, options = {}) {
  // The query whitelist is literal and independent of keys received from the cache.
  return { name, family, key, schema: object(properties), fields: fields.split(' '), limitations, idField: 'id', ...options };
}
const definitions = [
  definition('resources', 'health', 'resources', resourceProperties,
    'id label usage capacity unit source status note quantity quantity.value quantity.unit quantity.total quantity.available rankLabel rankUnit sampledAt gpuDevices rows', RESOURCE_LIMITS),
  definition('resource-rows', 'health', 'rows', { ...rowProperties, resource: resourceProperties.id, queryId: string },
    'id queryId resource name detail usage cleanable defaultSelected effect quantity quantity.value quantity.unit pid starttime agentKind agentId sessions',
    [...RESOURCE_LIMITS, 'Original row id is preserved and can repeat across resources. Detail lookup uses queryId = resource + ":" + original id (URI-encode the entire ID in the route).'], { idField: 'queryId' }),
  definition('inspections', 'health', 'inspections', inspectionProperties,
    'id label important phase status usage detail evidence execution', ['Only cached inspection evidence; unchecked/unavailable is not normal. No inspection is executed.']),
  definition('optimizations', 'health', 'optimizations', optimizationProperties,
    'id inspection title action effect', ['Cached recommendations only; action text is never executed.']),
  definition('operations', 'health', 'operations', operationProperties,
    'id kind names time revision', ['Only cached bounded operation history, not an audit log or an execution endpoint.']),
  definition('gpu-devices', 'health', 'devices', { id: string, ...deviceProperties },
    'id index name uuid busId utilization memoryUtilization memoryUsedBytes memoryTotalBytes temperatureCelsius powerWatts powerLimitWatts eccCorrected eccUncorrected pcieGeneration pcieMaxGeneration pcieWidth',
    [...RESOURCE_LIMITS, 'GPU device metrics come from the resource cache, not GPU diagnostic/job sampling.', GENERATED_LIMIT], { generated: true }),
  definition('gpu-findings', 'health', 'gpuFindings', { id: string, ...gpuFinding.properties, scope: enumeration('overall', 'job'), processPid: nullable(integer), processStarttime: nullable(integer) },
    'id check severity message suggestion scope processPid processStarttime', [...GPU_LIMITS, 'Includes overall findings and each job finding; overall findings have null processPid/processStarttime.', GENERATED_LIMIT], { generated: true }),
  definition('gpu-jobs', 'health', 'jobs', { id: string, ...gpuJobProperties },
    'id pid starttime name state cpuPercent rssBytes gpuIndices smUtilization memoryUtilization status findings', GPU_LIMITS),
  definition('agent-processes', 'agent', 'processes', { id: string, ...processProperties },
    'id pid name role status ports lastCheckAt latencyMs parentPid hasCrash', [...AGENT_LIMITS, GENERATED_LIMIT], { generated: true }),
  definition('agent-sessions', 'agent', 'sessions', sessionProperties,
    'id agent model conversations inputTokens outputTokens firstSeenAt lastSeenAt', AGENT_LIMITS),
  definition('agent-interruptions', 'agent', 'interruptions', interruptionProperties,
    'id sessionId callId pid agent type severity occurredAt resolved', AGENT_LIMITS),
  definition('agent-latency', 'agent', 'latency', { id: string, ...latencyProperties },
    'id agent calls streamingCalls ttftP95Ms e2eP95Ms tpsP50 tpotP95Ms', [...AGENT_LIMITS, GENERATED_LIMIT], { generated: true }),
  definition('agent-findings', 'agent', 'findings', { id: string, ...agentFindingProperties },
    'id severity title detail suggestion', [...AGENT_LIMITS, 'Analyzer findings are not raw AgentSight events.', GENERATED_LIMIT], { generated: true }),
  definition('agent-coverage', 'agent', 'coverage', { id: string, ...coverageProperties },
    'id key status reason', [...AGENT_LIMITS, GENERATED_LIMIT], { generated: true }),
  definition('tasks', 'tasks', 'tasks', taskProperties,
    'id request_id operation status profile collection_status raw_bytes collected_at simulated',
    ['At most 100 successful task metadata records from this controller process; not failures, global task history, raw data, secrets or system paths.']),
];
const RESOURCE_IDS = ['cpu', 'energy', 'memory', 'disk', 'gpu'];

function findDefinition(name) {
  const result = definitions.find(item => item.name === name);
  if (!result) throw new QueryError('UNKNOWN_DATASET', 'Unknown dataset', 404);
  return result;
}
function fieldSchema(def, field) {
  if (!def.fields.includes(field)) throw new QueryError('INVALID_FIELD', `Field is not allowed: ${field}`);
  let schema = def.schema;
  for (const key of field.split('.')) schema = schema.properties[key];
  return schema;
}
function fieldType(schema) {
  return Array.isArray(schema.type) ? schema.type.find(type => type !== 'null') : schema.type;
}
function scalar(schema) { return ['string', 'number', 'integer', 'boolean'].includes(fieldType(schema)); }
function equalityField(schema) { return scalar(schema) || fieldType(schema) === 'array' && scalar(schema.items); }
function rangeField(schema) { return ['number', 'integer'].includes(fieldType(schema)) || schema.format === 'date-time'; }
function valueAt(item, field) {
  let value = item;
  for (const key of field.split('.')) {
    if (!own(value, key)) return undefined;
    value = value[key];
  }
  return value;
}

// Deep-copy only schema-declared own properties, including nested rows/findings.
function copyAllowed(value, schema) {
  if (value === null || value === undefined) return value;
  const type = fieldType(schema);
  if (type === 'array') return Array.isArray(value) ? value.map(item => copyAllowed(item, schema.items)).filter(item => item !== undefined) : undefined;
  if (type !== 'object') {
    if (type === 'integer') return Number.isSafeInteger(value) ? value : undefined;
    if (type === 'number') return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
    return typeof value === type ? value : undefined;
  }
  if (typeof value !== 'object' || Array.isArray(value)) return undefined;
  const result = {};
  for (const [key, child] of Object.entries(schema.properties)) {
    if (own(value, key)) {
      const copied = copyAllowed(value[key], child);
      if (copied !== undefined) result[key] = copied;
    }
  }
  return result;
}
function timestamp(view, def) {
  if (def.family === 'agent') return view.agent?.sampledAt ?? null;
  if (def.key === 'gpuFindings') return view.state?.gpuDiagnostic?.sampledAt ?? null;
  if (def.key === 'jobs') return view.state?.gpuDiagnostic?.jobAnalysis?.sampledAt ?? null;
  if (def.key === 'devices') return view.state?.resources?.gpu?.sampledAt ?? view.state?.sampledAt ?? null;
  if (def.family === 'tasks') return view.tasks?.[0]?.collected_at ?? null;
  return view.state?.sampledAt ?? null;
}
function snapshotId(view, def, index) {
  return `${def.name}:${view.state?.revision ?? 'none'}:${encodeURIComponent(timestamp(view, def) ?? 'none')}:${index}`;
}
function rowsFor(view, def) {
  const state = view.state;
  let rows;
  if (def.family === 'agent') rows = view.agent[def.key];
  else if (def.family === 'tasks') rows = view.tasks.slice(0, 100);
  else if (def.key === 'resources') rows = RESOURCE_IDS.filter(id => own(state.resources, id)).map(id => state.resources[id]);
  else if (def.key === 'rows') rows = RESOURCE_IDS.flatMap(resource => (state.resources?.[resource]?.rows ?? []).map((row, index) => ({
    ...copyAllowed(row, rowSchema), resource,
    queryId: `${resource}:${own(row, 'id') ? row.id : snapshotId(view, def, index)}`,
    ...(!own(row, 'id') ? { id: snapshotId(view, def, index) } : {}),
  })));
  else if (def.key === 'devices') rows = state.resources?.gpu?.gpuDevices ?? [];
  else if (def.key === 'jobs') rows = (state.gpuDiagnostic?.jobAnalysis?.processes ?? []).map(process => ({
    ...copyAllowed(process, gpuJob),
    id: `gpu-job:${process.pid}:${process.starttime ?? `unknown:${encodeURIComponent(timestamp(view, def) ?? 'none')}:${state.revision}`}`,
  }));
  else if (def.key === 'gpuFindings') {
    const report = state.gpuDiagnostic;
    rows = [
      ...(report?.findings ?? []).map(finding => ({ ...copyAllowed(finding, gpuFinding), scope: 'overall', processPid: null, processStarttime: null })),
      ...(report?.jobAnalysis?.processes ?? []).flatMap(process => (process.findings ?? []).map(finding => ({ ...copyAllowed(finding, gpuFinding), scope: 'job', processPid: process.pid, processStarttime: process.starttime }))),
    ];
  } else rows = state[def.key];
  return (rows ?? []).map((row, index) => {
    const result = copyAllowed(row, def.schema);
    if (!own(result, 'id')) result.id = snapshotId(view, def, index);
    return result;
  });
}
function aggregate(statuses) {
  if (!statuses.length) return 'unknown';
  const distinct = [...new Set(statuses)];
  return distinct.length === 1 ? distinct[0] : 'partial';
}
function healthSource(state) { return state?.mode === 'collected' ? 'sysak' : state?.mode === 'demo' ? 'demo' : null; }
function resourceCoverage(state, ids) {
  return ids.map(key => {
    const item = state?.resources?.[key];
    return { key, source: item?.source ?? healthSource(state), status: item?.status ?? (state?.mode === 'demo' ? 'demo' : 'unknown'), sampled_at: item?.sampledAt ?? state?.sampledAt ?? null, reason: item?.note ?? '' };
  });
}
function cached(view, def) {
  if (def.family === 'tasks') return Array.isArray(view?.tasks);
  return view?.[def.family === 'agent' ? 'agent' : 'state'] != null;
}
function metadata(view, def) {
  const state = view?.state;
  const agent = view?.agent;
  const ready = cached(view, def);
  let source = def.family === 'agent' ? agent?.source ?? 'agentsight' : def.family === 'tasks' ? 'controller' : healthSource(state);
  let status = 'unknown';
  let coverage = {};
  if (ready && def.family === 'agent') {
    const sources = (agent.coverage ?? []).map(item => copyAllowed(item, object(coverageProperties)));
    const entry = sources.find(item => item.key === def.key);
    status = entry?.status ?? (['findings', 'coverage'].includes(def.key) ? agent.status : 'unknown');
    coverage = { report_status: agent.status, outcome: agent.outcome, window: copyAllowed(agent.window, object({ start: date, end: date })), lastScanAt: agent.lastScanAt ?? null, filteredProcesses: agent.filteredProcesses ?? null, sources };
  } else if (ready && ['resources', 'rows', 'devices'].includes(def.key)) {
    const sources = resourceCoverage(state, def.key === 'devices' ? ['gpu'] : RESOURCE_IDS);
    source = aggregate(sources.map(item => item.source));
    if (source === 'partial') source = 'mixed';
    status = aggregate(sources.map(item => item.status));
    coverage = { sources, ranking_scope: 'top20 + agent20 union' };
  } else if (ready && ['jobs', 'gpuFindings'].includes(def.key)) {
    const diagnostic = state.gpuDiagnostic;
    const job = diagnostic?.jobAnalysis;
    const report = def.key === 'jobs' ? job : diagnostic;
    source = report?.source ?? diagnostic?.source ?? 'sysak ai';
    status = report?.status ?? 'not_run';
    coverage = {
      status: diagnostic?.status ?? 'not_run', outcome: diagnostic?.outcome ?? 'unknown', complete: diagnostic?.complete ?? false,
      sampled_at: diagnostic?.sampledAt ?? null,
      jobAnalysis: { status: job?.status ?? 'not_run', complete: job?.complete ?? false, sampled_at: job?.sampledAt ?? null, sampleWindowSeconds: job?.sampleWindowSeconds ?? null, reason: job?.reason ?? '' },
    };
    if (def.key === 'gpuFindings' && job && job.status !== status) status = 'partial';
  } else if (ready && def.key === 'inspections') {
    const sources = (state.inspections ?? []).map(item => ({ key: item.id, status: item.execution ?? (item.status === 'unchecked' ? 'not_run' : 'unknown'), outcome: item.status }));
    status = aggregate(sources.map(item => item.status));
    coverage = { sources };
  } else if (ready && def.family === 'tasks') {
    status = 'available';
    coverage = { scope: 'current_controller_process_successful_tasks', retained: Math.min(view.tasks.length, 100), maximum: 100 };
  } else if (ready) {
    // Recommendations/history are cached, not a claim about collector availability.
    status = 'cached';
    coverage = { scope: 'cached_normalized_state' };
  }
  return {
    source, status: ready ? status : 'not_cached', sampled_at: ready ? timestamp(view, def) : null,
    revision: state?.revision ?? null, coverage, limitations: [...CACHE_LIMITS, ...def.limitations],
  };
}

function datasetCatalog(view = {}) {
  return {
    schema_version: '1.0', read_only: true, cache_only: true,
    datasets: definitions.map(def => ({
      name: def.name, cached: cached(view, def), detail_id_field: def.idField,
      id_scope: def.generated ? 'snapshot' : def.name === 'gpu-jobs' ? 'pid+starttime (snapshot when starttime is null)' : def.name === 'resource-rows' ? 'resource+original id; generated fallback is snapshot-scoped' : 'source id; generated fallback is snapshot-scoped',
      fields: def.fields.map(name => {
        const schema = fieldSchema(def, name);
        return { name, type: fieldType(schema), nullable: Array.isArray(schema.type) && schema.type.includes('null'), filter: equalityField(schema), range: rangeField(schema), sort: scalar(schema), project: true, ...(schema.enum ? { enum: [...schema.enum] } : {}), ...(schema.format ? { format: schema.format } : {}) };
      }),
      meta: metadata(view, def),
    })),
  };
}

const NUMERIC = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
function numeric(text, isInteger = false) {
  const value = Number(text);
  if (!NUMERIC.test(text) || !Number.isFinite(value) || isInteger && !Number.isSafeInteger(value)) throw new QueryError('INVALID_NUMBER', 'Expected a finite number or safe integer');
  return value;
}
function isoTime(text) {
  // Date.parse alone accepts numeric strings and silently normalizes invalid dates.
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2}))?$/.exec(text);
  if (!match) throw new QueryError('INVALID_TIME', 'Expected an ISO date or date-time with timezone');
  const [, year, month, day, hour, minute, second, zone] = match;
  const y = Number(year), m = Number(month), d = Number(day);
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const value = Date.parse(text);
  if (m < 1 || m > 12 || d < 1 || d > days[m - 1] || Number(hour ?? 0) > 23 || Number(minute ?? 0) > 59 || Number(second ?? 0) > 59 || zone && zone !== 'Z' && (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4)) > 59) || !Number.isFinite(value)) {
    throw new QueryError('INVALID_TIME', 'Invalid ISO time');
  }
  return value;
}
function filterValue(text, schema) {
  if (text === 'null' && Array.isArray(schema.type) && schema.type.includes('null')) return null;
  const type = fieldType(schema);
  let value = text;
  if (['number', 'integer'].includes(type)) value = numeric(text, type === 'integer');
  else if (type === 'boolean') {
    if (!['true', 'false'].includes(text)) throw new QueryError('INVALID_BOOLEAN', 'Expected true or false');
    value = text === 'true';
  } else if (schema.format === 'date-time') isoTime(text);
  if (schema.enum && !schema.enum.includes(value)) throw new QueryError('INVALID_VALUE', 'Value is not in the field enum');
  return value;
}
function commaFields(text, def, sort = false) {
  const fields = text.split(',').map(entry => entry.trim());
  const seen = new Set();
  for (const entry of fields) {
    const field = sort && entry.startsWith('-') ? entry.slice(1) : entry;
    const schema = fieldSchema(def, field);
    if (seen.has(field) || sort && !scalar(schema)) throw new QueryError('INVALID_FIELDS', 'Duplicate field or non-scalar sort field');
    seen.add(field);
  }
  if (!sort && fields.some(field => fields.some(other => other !== field && other.startsWith(`${field}.`)))) throw new QueryError('INVALID_FIELDS', 'Overlapping projection paths');
  return fields;
}
function parseQuery(params, def, detail) {
  if (!(params instanceof URLSearchParams)) throw new QueryError('INVALID_QUERY', 'Expected URLSearchParams');
  const result = { filters: new Map(), ranges: new Map(), offset: 0, limit: 100, fields: null, sort: [], q: null, revision: undefined };
  const seen = new Set();
  for (const [key, text] of params) {
    const filter = key.startsWith('filter.');
    if (!filter && seen.has(key)) throw new QueryError('DUPLICATE_PARAMETER', `Repeated parameter: ${key}`);
    seen.add(key);
    if (detail && !['fields', 'revision'].includes(key)) throw new QueryError('INVALID_PARAMETER', 'Detail accepts only fields and revision');
    if (filter || key.startsWith('min.') || key.startsWith('max.')) {
      const prefix = key.slice(0, key.indexOf('.'));
      const field = key.slice(prefix.length + 1);
      const schema = fieldSchema(def, field);
      if (filter) {
        if (!equalityField(schema)) throw new QueryError('INVALID_FIELD', 'Equality filters require scalar values or scalar array membership');
        if (!result.filters.has(field)) result.filters.set(field, []);
        result.filters.get(field).push(filterValue(text, fieldType(schema) === 'array' ? schema.items : schema));
      } else {
        if (!rangeField(schema)) throw new QueryError('INVALID_FIELD', 'Bounds require numeric or ISO time fields');
        const value = schema.format === 'date-time' ? isoTime(text) : numeric(text);
        const range = result.ranges.get(field) ?? {};
        range[prefix] = value;
        result.ranges.set(field, range);
      }
    } else if (key === 'offset' || key === 'limit' || key === 'revision') {
      if (!/^(?:0|[1-9]\d*)$/.test(text)) throw new QueryError('INVALID_NUMBER', `${key} must be a nonnegative decimal safe integer`);
      const value = numeric(text, true);
      if (key === 'limit' && (value < 1 || value > 1000)) throw new QueryError('INVALID_LIMIT', 'limit must be 1..1000');
      result[key] = value;
    } else if (key === 'fields') result.fields = commaFields(text, def);
    else if (key === 'sort') result.sort = commaFields(text, def, true);
    else if (key === 'q') result.q = text.toLowerCase();
    else throw new QueryError('INVALID_PARAMETER', `Unknown query parameter: ${key}`);
  }
  for (const range of result.ranges.values()) if (range.min !== undefined && range.max !== undefined && range.min > range.max) throw new QueryError('INVALID_RANGE', 'min exceeds max');
  return result;
}
function containsText(value, query) {
  if (typeof value === 'string') return value.toLowerCase().includes(query);
  if (Array.isArray(value)) return value.some(item => containsText(item, query));
  if (value && typeof value === 'object') return Object.values(value).some(item => containsText(item, query));
  return false;
}
function matches(item, query, def) {
  for (const [field, choices] of query.filters) {
    const value = valueAt(item, field);
    const schema = fieldSchema(def, field);
    const values = fieldType(schema) === 'array' ? value ?? [] : [value];
    const element = fieldType(schema) === 'array' ? schema.items : schema;
    if (!values.some(item => choices.some(choice => element.format === 'date-time' && item != null && choice != null ? Date.parse(item) === isoTime(choice) : item === choice))) return false;
  }
  for (const [field, range] of query.ranges) {
    const value = valueAt(item, field);
    if (value == null) return false; // null/absent is never coerced to zero.
    const numberValue = fieldSchema(def, field).format === 'date-time' ? Date.parse(value) : value;
    if (typeof numberValue !== 'number' || !Number.isFinite(numberValue) || range.min !== undefined && numberValue < range.min || range.max !== undefined && numberValue > range.max) return false;
  }
  return query.q === null || containsText(item, query.q);
}
function compare(a, b, query, def) {
  for (const entry of query.sort) {
    const descending = entry.startsWith('-');
    const field = descending ? entry.slice(1) : entry;
    let left = valueAt(a.item, field), right = valueAt(b.item, field);
    if (fieldSchema(def, field).format === 'date-time') {
      left = left == null ? null : Date.parse(left);
      right = right == null ? null : Date.parse(right);
      if (!Number.isFinite(left)) left = null;
      if (!Number.isFinite(right)) right = null;
    }
    if (left == null || right == null) {
      if (left == null && right != null) return 1;
      if (right == null && left != null) return -1;
      continue;
    }
    const order = left < right ? -1 : left > right ? 1 : 0;
    if (order) return descending ? -order : order;
  }
  return a.index - b.index;
}
function project(item, fields, def) {
  if (!fields) return item;
  const result = {};
  for (const field of fields) {
    const value = valueAt(item, field);
    if (value === undefined) continue;
    const keys = field.split('.');
    let target = result;
    for (const key of keys.slice(0, -1)) target = target[key] ??= {};
    target[keys[keys.length - 1]] = copyAllowed(value, fieldSchema(def, field));
  }
  return result;
}
function queryDataset(view, name, params = new URLSearchParams(), id) {
  const def = findDefinition(name);
  const detail = id !== undefined;
  if (detail && (typeof id !== 'string' || !id.length)) throw new QueryError('INVALID_ID', 'Expected a nonempty string detail ID');
  const query = parseQuery(params, def, detail);
  if (!cached(view, def)) throw new QueryError('NOT_CACHED', 'No cached data for this dataset; querying never triggers collection', 503);
  const meta = metadata(view, def);
  if (query.revision !== undefined && query.revision !== meta.revision) throw new QueryError('REVISION_MISMATCH', 'Snapshot revision changed or is absent', 409);
  const rows = rowsFor(view, def);
  const base = { schema_version: '1.0', dataset: name, meta };
  if (detail) {
    const found = rows.filter(item => item[def.idField] === id);
    if (!found.length) throw new QueryError('NOT_FOUND', 'Detail ID is not in this cached snapshot', 404);
    if (found.length > 1) throw new QueryError('AMBIGUOUS_ID', 'Source ID is not unique in this snapshot', 409);
    return { ...base, item: project(found[0], query.fields, def) };
  }
  const selected = rows.map((item, index) => ({ item, index })).filter(({ item }) => matches(item, query, def));
  if (query.sort.length) selected.sort((a, b) => compare(a, b, query, def));
  const items = selected.slice(query.offset, query.offset + query.limit).map(({ item }) => project(item, query.fields, def));
  const next = query.offset + items.length;
  return { ...base, total: selected.length, offset: query.offset, limit: query.limit, items, next_offset: next < selected.length ? next : null };
}

function projectionSchema(schema) {
  if (fieldType(schema) === 'object') return object(Object.fromEntries(Object.entries(schema.properties).map(([key, child]) => [key, projectionSchema(child)])));
  if (fieldType(schema) === 'array') return array(projectionSchema(schema.items));
  return schema;
}

function openApiContract() {
  const ref = name => ({ $ref: `#/components/schemas/${name}` });
  const sourceCoverage = object({ key: string, source: nullable(string), status: string, sampled_at: nullable(date), reason: string, outcome: string }, ['key', 'status']);
  const coverage = object({
    sources: array(sourceCoverage), ranking_scope: string, report_status: enumeration('ok', 'partial', 'unavailable'),
    window: object({ start: date, end: date }, ['start', 'end']), lastScanAt: nullable(date), filteredProcesses: nullable(integer),
    status: gpuStatus, outcome: string, complete: boolean, sampled_at: nullable(date),
    jobAnalysis: object({ status: gpuStatus, complete: boolean, sampled_at: nullable(date), sampleWindowSeconds: nullable(number), reason: string }, ['status', 'complete', 'sampled_at', 'sampleWindowSeconds', 'reason']),
    scope: string, retained: { type: 'integer', minimum: 0, maximum: 100 }, maximum: { const: 100 },
  });
  coverage.description = 'Source-specific coverage before filtering: per-resource/source statuses and timestamps; Agent fixed window, lastScanAt and filteredProcesses; GPU complete and short sample window; or process-local task retention.';
  const meta = object({ source: nullable(string), status: string, sampled_at: nullable(date), revision: nullable(integer), coverage, limitations: array(string) }, ['source', 'status', 'sampled_at', 'revision', 'coverage', 'limitations']);
  const taskSchema = object(taskProperties);
  const healthState = object({ mode: enumeration('collected', 'demo'), hasGpu: boolean, revision: integer, sampledAt: date, resources: object(Object.fromEntries(RESOURCE_IDS.map(id => [id, object(resourceProperties)])), RESOURCE_IDS), inspections: array(object(inspectionProperties)), gpuDiagnostic, optimizations: array(object(optimizationProperties)), operations: array(object(operationProperties)) }, ['hasGpu', 'revision', 'sampledAt', 'resources', 'inspections', 'optimizations', 'operations']);
  const agentReport = object({ source: enumeration('agentsight'), analyzer: enumeration('sysom-openapi'), sampledAt: date, window: object({ start: date, end: date }, ['start', 'end']), status: enumeration('ok', 'partial', 'unavailable'), outcome: enumeration('observed', 'abnormal', 'unknown'), summary: string, lastScanAt: nullable(date), filteredProcesses: nullable(integer), coverage: array(object(coverageProperties)), totals: object({ sessions: nullable(integer), inputTokens: nullable(integer), outputTokens: nullable(integer), unresolved: nullable(integer), critical: nullable(integer), high: nullable(integer) }), findings: array(object(agentFindingProperties)), processes: array(object(processProperties)), sessions: array(object(sessionProperties)), interruptions: array(object(interruptionProperties)), latency: array(object(latencyProperties)) }, ['source', 'analyzer', 'sampledAt', 'window', 'status', 'outcome', 'summary', 'lastScanAt', 'filteredProcesses', 'coverage', 'totals', 'findings', 'processes', 'sessions', 'interruptions', 'latency']);
  const summary = object({ score: number, n: integer, m: integer, x: integer, y: integer, otherAbnormal: integer, resourceAbnormal: integer, unchecked: integer, open: array({ oneOf: [object(inspectionProperties), object(resourceProperties)] }), band: object({ id: enumeration('red', 'orange', 'yellow', 'green'), color: string, label: string }), checked: integer, total: integer, unavailable: integer }, ['score', 'n', 'm', 'x', 'y', 'otherAbnormal', 'resourceAbnormal', 'unchecked', 'open', 'band', 'checked', 'total', 'unavailable']);
  const catalogField = object({ name: string, type: enumeration('string', 'number', 'integer', 'boolean', 'object', 'array'), nullable: boolean, filter: boolean, range: boolean, sort: boolean, project: { const: true }, enum: array({ type: ['string', 'number'] }), format: string }, ['name', 'type', 'nullable', 'filter', 'range', 'sort', 'project']);
  const schemas = {
    Meta: meta, Task: taskSchema, HealthState: healthState, AgentDiagnostic: agentReport, HealthSummary: summary,
    Status: object({ schema_version: { const: '1.0' }, mode: string, read_only: { const: true }, device_id: string, installed: boolean, enabled: boolean, phase: string, api_version: string, last_task: { oneOf: [taskSchema, { type: 'null' }] }, inspection_interval_minutes: { type: 'integer', minimum: 1, maximum: 1440 }, next_inspection_at: nullable(date), error: { oneOf: [object({ code: string, message: string }, ['code', 'message']), { type: 'null' }] } }, ['schema_version', 'mode', 'read_only', 'device_id', 'installed', 'enabled', 'phase', 'api_version', 'last_task', 'inspection_interval_minutes', 'next_inspection_at', 'error']),
    Capabilities: object({ schema_version: { const: '1.0' }, read_only: { const: true }, cache_only: { const: true }, datasets: array(object({ name: enumeration(...definitions.map(def => def.name)), cached: boolean, detail_id_field: string, id_scope: string, fields: array(catalogField), meta: ref('Meta') }, ['name', 'cached', 'detail_id_field', 'id_scope', 'fields', 'meta'])) }, ['schema_version', 'read_only', 'cache_only', 'datasets']),
    Error: object({ schema_version: { const: '1.0' }, error: object({ code: string, message: string }, ['code', 'message']) }, ['schema_version', 'error']),
    HttpMeta: object({ instance_id: string, host_kind: string, device_id: string, revision: nullable(integer), sampled_at: nullable(date), agent_sampled_at: nullable(date), cache_only: { const: true } }, ['instance_id', 'host_kind', 'device_id', 'revision', 'sampled_at', 'agent_sampled_at', 'cache_only']),
    QueryView: object({ status: ref('Status'), state: { oneOf: [ref('HealthState'), { type: 'null' }] }, agent: { oneOf: [ref('AgentDiagnostic'), { type: 'null' }] }, tasks: array(ref('Task')) }, ['status', 'state', 'agent', 'tasks']),
    ReportData: object({ health: { oneOf: [ref('HealthState'), { type: 'null' }] }, health_summary: { oneOf: [ref('HealthSummary'), { type: 'null' }] }, health_text: nullable(string), agent: { oneOf: [ref('AgentDiagnostic'), { type: 'null' }] }, gpu: { oneOf: [gpuDiagnostic, { type: 'null' }] } }, ['health', 'health_summary', 'health_text', 'agent', 'gpu']),
    Snapshot: object({ schema_version: { const: '1.0' }, meta: ref('HttpMeta'), data: ref('QueryView') }, ['schema_version', 'meta', 'data']),
    Summary: object({ schema_version: { const: '1.0' }, meta: ref('HttpMeta'), data: ref('HealthSummary') }, ['schema_version', 'meta', 'data']),
    Report: object({ schema_version: { const: '1.0' }, meta: ref('HttpMeta'), data: ref('ReportData') }, ['schema_version', 'meta', 'data']),
    OpenAPI: { type: 'object', required: ['openapi', 'info', 'paths', 'components'], properties: { openapi: { const: '3.1.0' }, info: { type: 'object' }, paths: { type: 'object' }, components: { type: 'object' }, security: array({ type: 'object' }) }, additionalProperties: true },
  };
  schemas.Status.properties.agent_sight = object({ state: enumeration('running', 'unavailable', 'closed'), managed: boolean, code: nullable(string), message: string,
    collection: object({ state: enumeration('running', 'disabled', 'failed', 'unavailable'), enabled: boolean, scope: enumeration('host', 'none'), trace_running: boolean, api_running: boolean, message: string }, ['state', 'enabled', 'scope', 'trace_running', 'api_running', 'message']),
  }, ['state', 'managed', 'code', 'message']);
  schemas.Status.properties.query_api = object({ enabled: boolean, base_url: nullable(string), instance_id: nullable(string), error: { oneOf: [object({ code: string, message: string }), { type: 'null' }] } }, ['enabled', 'base_url', 'instance_id', 'error']);
  schemas.CapabilitiesData = object({ ...schemas.Capabilities.properties, unavailable_features: array(string), demo_data_exposed: { const: false }, query_max_limit: { const: 1000 } }, [...schemas.Capabilities.required, 'unavailable_features', 'demo_data_exposed', 'query_max_limit']);
  for (const [name, data] of [['StatusResponse', 'Status'], ['CapabilitiesResponse', 'CapabilitiesData']]) {
    schemas[name] = object({ schema_version: { const: '1.0' }, meta: ref('HttpMeta'), data: ref(data) }, ['schema_version', 'meta', 'data']);
  }
  const lists = [], details = [];
  for (const def of definitions) {
    const token = def.name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    schemas[`${token}Item`] = projectionSchema(def.schema);
    const common = { schema_version: { const: '1.0' }, dataset: { const: def.name }, meta: ref('Meta') };
    schemas[`${token}List`] = object({ ...common, total: { type: 'integer', minimum: 0 }, offset: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER }, limit: { type: 'integer', minimum: 1, maximum: 1000 }, items: array(ref(`${token}Item`)), next_offset: { type: ['integer', 'null'], minimum: 0, maximum: Number.MAX_SAFE_INTEGER } }, ['schema_version', 'dataset', 'meta', 'total', 'offset', 'limit', 'items', 'next_offset']);
    schemas[`${token}Detail`] = object({ ...common, item: ref(`${token}Item`) }, ['schema_version', 'dataset', 'meta', 'item']);
    lists.push(ref(`${token}List`));
    details.push(ref(`${token}Detail`));
  }
  schemas.DatasetList = { oneOf: lists };
  schemas.DatasetDetail = { oneOf: details };
  const response = (description, schema) => ({ description, content: { 'application/json': { schema } } });
  const responses = success => ({
    200: response('Cached response; availability and coverage are not inferred from row count.', ref(success)),
    400: response('Unknown parameter/field, repeated non-filter parameter, invalid number/time/enum, or invalid query.', ref('Error')),
    401: { ...response('Missing or invalid Bearer credential.', ref('Error')), headers: { 'WWW-Authenticate': { schema: string, description: 'Bearer authentication challenge' } } },
    403: response('Rejected Host or any Origin header (including null); local-only access.', ref('Error')),
    404: response('Unknown dataset/route or detail ID absent from this cache.', ref('Error')),
    405: { ...response('Only GET is allowed; HEAD and all mutation methods are rejected.', ref('Error')), headers: { Allow: { schema: { const: 'GET' } } } },
    409: response('Requested revision does not equal the cached HealthState revision, or source identity is ambiguous.', ref('Error')),
    503: response('Required cache absent. No collection is started; unavailable cached sources instead return 200 with accurate meta.', ref('Error')),
  });
  const param = (name, description, schema = string) => ({ name, in: 'query', required: false, description, schema });
  const revisionParam = param('revision', 'Optional nonnegative decimal safe integer; must equal meta.revision, otherwise 409. Null/absent revision never matches. Agent scans have independent sampled_at.', { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
  const projectionParam = param('fields', 'Comma-separated static allowed field paths for this dataset. Unknown, duplicate, empty and overlapping parent/child paths are 400. Only requested fields appear; absent properties are omitted, null and zero preserved. See capabilities.');
  const nameParam = { name: 'name', in: 'path', required: true, description: 'Static dataset name; no object or prototype paths.', schema: enumeration(...definitions.map(def => def.name)) };
  const listParams = [nameParam, revisionParam, projectionParam,
    param('q', 'Case-insensitive literal substring search over string VALUES in allowed JSON, including nested strings. Does not search numeric/boolean values or property names and never evaluates expressions.'),
    param('sort', 'Comma-separated scalar allowed fields; prefix - for descending. Stable multi-key order; null/missing always last. ISO fields compare instants. Unknown/duplicate/non-scalar fields are 400.'),
    param('offset', 'Nonnegative decimal safe integer; no signs, exponent or whitespace.', { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER, default: 0 }),
    param('limit', 'Decimal integer 1..1000; pagination is over filtered, sorted items.', { type: 'integer', minimum: 1, maximum: 1000, default: 100 }),
  ];
  const fieldUses = new Map();
  for (const def of definitions) for (const field of def.fields) {
    const schema = fieldSchema(def, field);
    if (!equalityField(schema)) continue;
    if (!fieldUses.has(field)) fieldUses.set(field, []);
    fieldUses.get(field).push({ dataset: def.name, type: fieldType(schema), nullable: Array.isArray(schema.type), range: rangeField(schema), ...(schema.format ? { format: schema.format } : {}), ...(schema.enum ? { enum: schema.enum } : {}) });
  }
  for (const [field, uses] of fieldUses) {
    listParams.push({ ...param(`filter.${field}`, 'Typed equality (scalar arrays use membership): repeats of this same field are OR; different fields and all bounds/q are AND. No comma splitting. Numbers must be finite (integers safe), booleans true/false, ISO times compare instants; literal null matches null only on nullable fields, not absent fields.', array(string)), style: 'form', explode: true, 'x-datasets': uses });
    const ranges = uses.filter(use => use.range);
    if (ranges.length) for (const bound of ['min', 'max']) listParams.push({ ...param(`${bound}.${field}`, `Inclusive ${bound} bound: finite numeric value for numeric fields or valid ISO date/date-time with timezone for time fields. Null/absent rows do not match. min > max is 400.`), 'x-datasets': ranges });
  }
  const operation = (operationId, description, success, parameters = []) => ({ operationId, summary: description, description: 'Pure cached GET. All unlisted query parameters and repeated non-filter parameters are rejected with 400. No refresh, collection, execution or mutation is supported.', parameters, responses: responses(success), 'x-cache-only': true });
  const contract = {
    openapi: '3.1.0', jsonSchemaDialect: 'https://json-schema.org/draft/2020-12/schema',
    info: { title: 'SysAgent local cache query API', version: '1.0', description: 'Local GET-only normalized cache queries. Requires strict Host allowlisting, Bearer authentication and rejection of every Origin header. No root/AgentSight/collector calls. Capabilities lists exact per-dataset query fields and limitations. Generated IDs are snapshot-scoped; URI-encode IDs, and use revision for health consistency.' },
    servers: [{ url: '/', description: 'Current loopback origin; no remote collection server.' }],
    security: [{ bearerAuth: [] }],
    paths: {
      '/api/v1/status': { get: operation('getStatus', 'Controller status, without collecting', 'StatusResponse') },
      '/api/v1/capabilities': { get: operation('getCapabilities', 'Static dataset catalog and current cache coverage', 'CapabilitiesResponse') },
      '/api/v1/snapshot': { get: operation('getSnapshot', 'Entire cached health, Agent, status and successful task view (all rows)', 'Snapshot') },
      '/api/v1/summary': { get: operation('getSummary', 'HealthSummary derived only from the cached HealthState', 'Summary') },
      '/api/v1/report': { get: operation('getReport', 'Structured cached health/Agent/GPU report and health text', 'Report') },
      '/api/v1/datasets/{name}': { get: operation('listDataset', 'Filter, sort, project and paginate a cached dataset', 'DatasetList', listParams) },
      '/api/v1/datasets/{name}/{id}': { get: operation('getDatasetDetail', 'Look up the catalog detail_id_field in the current cache', 'DatasetDetail', [nameParam, { name: 'id', in: 'path', required: true, schema: { type: 'string', minLength: 1 }, description: 'URI-encoded source or generated ID, as identified by catalog detail_id_field. resource-rows uses queryId, preserving the original row id; GPU jobs use PID+starttime.' }, revisionParam, projectionParam]) },
      '/api/v1/openapi.json': { get: operation('getOpenApi', 'This complete OpenAPI 3.1 contract', 'OpenAPI') },
    },
    components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', description: 'Local service token in Authorization: Bearer <token>. Never put credentials in query parameters.' } }, schemas },
    'x-query-rules': { unknown_parameters: '400', duplicate_non_filter_parameters: '400', prototype_paths: 'forbidden', filter_same_field: 'OR', filter_different_fields: 'AND', range_bounds: 'inclusive', detail_parameters: ['fields', 'revision'], default_limit: 100, maximum_limit: 1000, allowed_methods: ['GET'], reject_origin: true, strict_host: true, no_collection: true },
  };
  // Return a detached contract: callers cannot alter the module's static schemas.
  return JSON.parse(JSON.stringify(contract));
}

module.exports = { datasetCatalog, queryDataset, QueryError, openApiContract };
