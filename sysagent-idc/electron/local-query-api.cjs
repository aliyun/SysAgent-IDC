'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { randomBytes, randomUUID, createHash, timingSafeEqual } = require('node:crypto');
const { datasetCatalog, queryDataset, openApiContract, QueryError } = require('./query-data.cjs');

function privateDirectory(directory) {
  const absolute = path.resolve(directory);
  let current = path.parse(absolute).root;
  for (const part of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Discovery directory contains an unsafe path');
  }
  const stat = fs.statSync(absolute);
  if ((stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) {
    throw new Error('Discovery directory must be owned by the current user and private (0700)');
  }
}

async function startLocalQueryApi({ queryView, discoveryDirectory, hostKind, summarizeHealth, buildHealthReport }) {
  const parent = path.dirname(path.resolve(discoveryDirectory));
  // Validate existing parents before creating a private child or writing credentials.
  let current = path.parse(parent).root;
  for (const part of parent.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Unsafe discovery parent');
  }
  const parentStat = fs.statSync(parent);
  if ((parentStat.mode & 0o022) !== 0 || (process.getuid && parentStat.uid !== process.getuid())) {
    throw new Error('Discovery parent must be owned by the current user and not writable by others');
  }
  if (!fs.existsSync(discoveryDirectory)) fs.mkdirSync(discoveryDirectory, { mode: 0o700 });
  privateDirectory(discoveryDirectory);
  const instanceId = randomUUID();
  const token = randomBytes(32).toString('hex');
  const tokenHash = createHash('sha256').update(`Bearer ${token}`).digest();
  let baseUrl;
  let discoveryFile;
  let discoveryIdentity;
  const server = http.createServer({ maxHeaderSize: 8192 }, (req, res) => {
    const send = (code, value) => {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
        'x-content-type-options': 'nosniff', 'connection': 'close' });
      res.end(JSON.stringify(value));
    };
    const fail = (status, code, message) => send(status, { schema_version: '1.0', error: { code, message } });
    try {
      const counts = new Map();
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const key = req.rawHeaders[i].toLowerCase();
        counts.set(key, (counts.get(key) || 0) + 1);
      }
      if (counts.has('origin') || counts.get('host') !== 1 || req.headers.host !== new URL(baseUrl).host) {
        return fail(403, 'FORBIDDEN_CLIENT', 'Only direct authenticated loopback clients are supported');
      }
      const authorization = req.headers.authorization || '';
      if (counts.get('authorization') !== 1 || !timingSafeEqual(createHash('sha256').update(authorization).digest(), tokenHash)) {
        res.setHeader('www-authenticate', 'Bearer');
        return fail(401, 'UNAUTHORIZED', 'A query-only Bearer token is required');
      }
      if (req.method !== 'GET') {
        res.setHeader('allow', 'GET');
        return fail(405, 'READ_ONLY', 'Only GET is allowed; collection and writes are not exposed');
      }
      if (req.headers['transfer-encoding'] || (req.headers['content-length'] && req.headers['content-length'] !== '0')) {
        return fail(400, 'INVALID_REQUEST', 'GET requests must not include a body');
      }
      if (!req.url.startsWith('/') || req.url.startsWith('//') || req.url.includes('\\') || req.url.includes('#') || req.url.length > 4096) {
        return fail(400, 'INVALID_PATH', 'Invalid request path');
      }
      const rawPath = req.url.split('?')[0];
      const segments = rawPath.split('/').slice(1).map(part => decodeURIComponent(part));
      if (segments.some(part => !part || part === '.' || part === '..' || /[/\\\x00-\x1f\x7f]/.test(part))) {
        return fail(400, 'INVALID_PATH', 'Noncanonical paths are not accepted');
      }
      const url = new URL(req.url, baseUrl);
      const route = `/${segments.join('/')}`;
      if (segments[0] === 'api' && segments[1] === 'v1' && segments[2] === 'datasets' && [4, 5].includes(segments.length)) {
        return send(200, queryDataset(queryView(), segments[3], url.searchParams, segments[4]));
      }
      if (url.searchParams.size) return fail(400, 'INVALID_QUERY', 'This endpoint does not accept query parameters');
      if (route === '/api/v1/openapi.json') return send(200, openApiContract());
      const view = queryView();
      const meta = { instance_id: instanceId, host_kind: hostKind, device_id: view.status.device_id,
        revision: view.state?.revision ?? null, sampled_at: view.state?.sampledAt ?? null,
        agent_sampled_at: view.agent?.sampledAt ?? null, cache_only: true };
      const envelope = (data) => ({ schema_version: '1.0', meta, data });
      switch (route) {
        case '/api/v1/status': return send(200, envelope(view.status));
        case '/api/v1/capabilities': return send(200, envelope({ ...datasetCatalog(view),
          unavailable_features: ['persistent-history', 'raw-evidence', 'session-resource-ownership', 'remote-devices',
            'log-library', 'offline-gpu-profiling', 'automatic-repair'],
          demo_data_exposed: false, query_max_limit: 1000 }));
        case '/api/v1/snapshot': return send(200, envelope(view));
        case '/api/v1/summary':
          if (!view.state) return fail(503, 'NO_CACHED_DATA', 'No health snapshot has been collected by this instance');
          return send(200, envelope(summarizeHealth(view.state)));
        case '/api/v1/report':
          if (!view.state && !view.agent) return fail(503, 'NO_CACHED_DATA', 'No diagnostic evidence has been collected by this instance');
          return send(200, envelope({ health: view.state, health_summary: view.state ? summarizeHealth(view.state) : null,
            health_text: view.state ? buildHealthReport(view.state, { name: `本机 ${view.status.device_id}` }) : null,
            agent: view.agent, gpu: view.state?.gpuDiagnostic ?? null }));
        default: return fail(404, 'NOT_FOUND', 'Unknown query endpoint');
      }
    } catch (error) {
      if (error instanceof QueryError) return fail(error.status, error.code, error.message);
      if (error instanceof URIError) return fail(400, 'INVALID_PATH', 'Invalid URL encoding');
      return fail(500, 'QUERY_FAILED', 'Local cached query failed');
    }
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  server.keepAliveTimeout = 2000;
  server.maxConnections = 64;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const endpoint = { schema_version: '1.0', instance_id: instanceId, host_kind: hostKind, pid: process.pid,
    device_id: queryView().status.device_id, started_at: new Date().toISOString(),
    base_url: `http://127.0.0.1:${server.address().port}`, token, read_only: true };
  baseUrl = endpoint.base_url;
  discoveryFile = path.join(discoveryDirectory, `${instanceId}.json`);
  try {
    privateDirectory(discoveryDirectory);
    fs.writeFileSync(discoveryFile, JSON.stringify(endpoint, null, 2), { mode: 0o600, flag: 'wx' });
    discoveryIdentity = fs.lstatSync(discoveryFile);
  } catch (error) {
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    throw error;
  }
  let closePromise;
  return {
    baseUrl, discoveryFile, instanceId,
    close() {
      if (!closePromise) closePromise = new Promise((resolve, reject) => {
        server.close((error) => {
          try {
            const stat = fs.lstatSync(discoveryFile);
            if (!stat.isSymbolicLink() && stat.dev === discoveryIdentity.dev && stat.ino === discoveryIdentity.ino) fs.unlinkSync(discoveryFile);
          } catch (cleanupError) { if (cleanupError.code !== 'ENOENT') return reject(cleanupError); }
          if (error) reject(error); else resolve();
        });
        server.closeAllConnections();
      });
      return closePromise;
    },
  };
}

module.exports = { startLocalQueryApi };
