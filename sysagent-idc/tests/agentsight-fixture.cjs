const http = require('node:http');
let mode = 'full';
const port = Number(process.argv[2] || 17496);
const server = http.createServer((request, response) => {
  const route = new URL(request.url, 'http://localhost').pathname;
  const send = (status, value) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); };
  if (request.method === 'POST' && route.startsWith('/fixture/')) {
    const next = route.slice('/fixture/'.length);
    if (!['full', 'empty', 'partial', 'unavailable', 'delay'].includes(next)) return send(400, { error: 'Unknown test mode' });
    mode = next;
    return send(200, { mode });
  }
  if (request.method !== 'GET') return send(405, { error: 'Fixture supports GET only' });
  if (mode === 'unavailable') return send(503, { error: 'Fixture unavailable' });
  if (mode === 'delay') return;
  if (mode === 'partial' && route === '/api/metrics/latency') return send(503, { error: 'Fixture latency unavailable' });
  const now = Date.now();
  const ns = Number(BigInt(now) * 1000000n);
  const empty = mode === 'empty';
  const data = {
    '/api/agent-process-health': { last_scan_time: empty ? 0 : now, filtered_count: 1, agents: empty ? [] : [
      { pid: 7001, agent_name: 'Fixture HTTP Agent', role: 'gateway', status: 'hung', ports: [9000], last_check_time: now,
        latency_ms: null, parent_pid: null, has_crash: false, restart_cmd: ['fixture-only-private-command'] },
      { pid: 7002, agent_name: 'Fixture CLI', role: 'client', status: 'no_port', ports: [], last_check_time: now,
        latency_ms: null, parent_pid: null, has_crash: false },
      { pid: 7003, agent_name: 'Fixture Responsive', role: 'gateway', status: 'healthy', ports: [9001], last_check_time: now,
        latency_ms: 0, parent_pid: null, has_crash: false },
    ] },
    '/api/sessions': empty ? [] : [
      { session_id: 'fixture-session-a', agent_name: 'Fixture HTTP Agent', model: 'fixture-model', conversation_count: 3,
        total_input_tokens: 1024, total_output_tokens: 0, first_seen_ns: ns - 60000000000, last_seen_ns: ns,
        first_user_query: 'Fixture private query should not reach UI' },
      { session_id: 'fixture-session-b', agent_name: null, model: null, conversation_count: 0,
        total_input_tokens: 0, total_output_tokens: 42, first_seen_ns: ns - 120000000000, last_seen_ns: ns - 1000000000 },
    ],
    '/api/interruptions': empty ? [] : [
      { interruption_id: 'fixture-linked-error', session_id: 'fixture-session-a', call_id: null, pid: 7001,
        agent_name: 'Fixture HTTP Agent', interruption_type: 'llm_error', severity: 'high', occurred_at_ns: ns, resolved: false },
      { interruption_id: 'fixture-unassigned', session_id: null, call_id: null, pid: null, agent_name: null,
        interruption_type: '<img src=x onerror=alert(1)>', severity: 'low', occurred_at_ns: ns - 1000000000,
        resolved: false, detail: 'Fixture private detail should not reach UI' },
    ],
    '/api/interruptions/count': { total: empty ? 0 : 205, by_severity: { critical: 0, high: empty ? 0 : 204, medium: 0, low: empty ? 0 : 1 } },
    '/api/metrics/latency': empty ? [] : [
      { agent_name: null, call_count: 3, streaming_call_count: 2, ttft_ms: null, tpot_ms_per_token: null,
        tps_tokens_per_second: { p50: 0, p95: 0, p99: 0 }, e2e_latency_ms: { p50: 80, p95: 120, p99: 140 } },
      { agent_name: 'Fixture HTTP Agent', call_count: 2, streaming_call_count: 1,
        ttft_ms: { p50: 0, p95: 0, p99: 0 }, tpot_ms_per_token: null,
        tps_tokens_per_second: null, e2e_latency_ms: { p50: 10, p95: 20, p99: 30 } },
    ],
  };
  if (!Object.hasOwn(data, route)) return send(404, { error: 'Unknown fixture endpoint' });
  send(200, data[route]);
});
server.listen(port, '127.0.0.1', () => process.stdout.write(`AgentSight protocol test fixture listening on 127.0.0.1:${port}\n`));
process.on('SIGTERM', () => { server.closeAllConnections(); server.close(() => process.exit(0)); });
