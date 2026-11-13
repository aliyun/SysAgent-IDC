'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

const INSTALLED_ROOT = '/opt/SysAgent管家/resources/sysak';
const HELPER = '/opt/SysAgent管家/resources/sysak-root-runner.py';
const SOCKET = '/run/sysom-idc/idc.sock';
const AUTH = '/etc/sysom-idc/allowed-uid';
const TOOLS = '.sysak_components/tools';
const COMMANDS = Object.freeze(['idc', 'resource_anomaly', 'memgraph', 'ai']);
const SAFE_PROFILES = Object.freeze({
  resource_anomaly: ['--idc'], memgraph: ['--graph', '--jsonstdout'], ai: ['--threshold', '1s'],
});
const MODULES = Object.freeze([
  'resource_anomaly_idc', 'fdleak_metrics',
  'plugin_abnormalPackages', 'plugin_anonTaskTop', 'plugin_cache', 'plugin_memcgLeak', 'plugin_memfrag',
  'plugin_memgraph', 'plugin_meminfo', 'plugin_memleak', 'plugin_podDetect', 'plugin_system', 'plugin_taskProc',
  'plugin_vmRssTaskTop', 'plugin_skcheck', 'plugin_appmem', 'mem_utils', 'plugin_thpCollect',
]);
const REQUIRED_FILES = Object.freeze([
  'sysak', `${TOOLS}/.sysak.rules`, ...COMMANDS.map(name => `${TOOLS}/${name}`),
  ...MODULES.map(name => `${TOOLS}/${name}.py`),
].sort());
const DIRECTORIES = Object.freeze(['', '.sysak_components', TOOLS]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function rootError() {
  const error = new Error('需要管理员安装并启用与当前组件一致的 sysAK IDC 服务，且授权当前用户；不以普通用户回退执行');
  error.code = 'ROOT_COLLECTOR_UNAVAILABLE';
  return error;
}

function trusted(file, io = fs, socket = false, directory = false) {
  let current = path.parse(file).root;
  for (const part of file.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = io.lstatSync(current);
    if (stat.isSymbolicLink() || stat.uid !== 0 ||
        (!(socket && current === file) && (stat.mode & 0o022)) ||
        (current !== file && !stat.isDirectory())) throw rootError();
  }
  const stat = io.lstatSync(file);
  if (socket ? !stat.isSocket() : directory ? !stat.isDirectory() : !stat.isFile()) throw rootError();
}

function verifyComponent(relative, data) {
  if (relative === 'sysak' || relative === `${TOOLS}/ai`) {
    const machine = { x64: 62, arm64: 183 }[process.arch];
    if (!machine || data.length < 64 || !data.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) ||
        data[4] !== 2 || data[5] !== 1 || data[6] !== 1 || data.readUInt32LE(20) !== 1 ||
        data.readUInt16LE(52) !== 64 || ![2, 3].includes(data.readUInt16LE(16)) ||
        data.readUInt16LE(18) !== machine) throw rootError();
  } else if (COMMANDS.some(name => relative === `${TOOLS}/${name}`)) {
    if (!/^#![^\r\n]*\bpython3\b/.test(data.toString('utf8'))) throw rootError();
  } else if (relative === `${TOOLS}/.sysak.rules`) {
    const lines = data.toString('utf8').split('\n');
    if (lines.length !== COMMANDS.length + 1 || lines.pop() !== '') throw rootError();
    for (const [index, command] of COMMANDS.entries()) {
      if (command === 'ai' ? lines[index] !== 'generic:ai::help{GPU AI diagnostics}'
        : !new RegExp(`^[A-Za-z0-9_/-]+:${command}:python-dep\\{python3\\}:help\\{[^\\r\\n\\0]*\\}$`).test(lines[index])) throw rootError();
    }
  }
}

function verifyRootInstallation(binary, { io = fs } = {}) {
  try {
    for (const file of [HELPER, AUTH, path.join(INSTALLED_ROOT, 'manifest.json')]) trusted(file, io);
    trusted(SOCKET, io, true);
    const uid = io.readFileSync(AUTH, 'utf8').trim();
    if (!/^[1-9][0-9]{0,9}$/.test(uid) || Number(uid) !== process.getuid()) throw rootError();
    if (!path.isAbsolute(binary) || path.basename(binary) !== 'sysak') throw rootError();
    const local = JSON.parse(io.readFileSync(path.join(path.dirname(binary), 'manifest.json'), 'utf8'));
    const installedBytes = io.readFileSync(path.join(INSTALLED_ROOT, 'manifest.json'));
    const installed = JSON.parse(installedBytes.toString('utf8'));
    if (installed.schema_version !== '1.0' || installed.platform !== 'linux' || installed.arch !== process.arch ||
        JSON.stringify(installed.commands) !== JSON.stringify(COMMANDS) ||
        JSON.stringify(installed.requires) !== JSON.stringify(['python3']) ||
        JSON.stringify(installed.safe_profiles) !== JSON.stringify(SAFE_PROFILES) ||
        local.schema_version !== installed.schema_version || local.arch !== installed.arch ||
        local.platform !== installed.platform || JSON.stringify(local.commands) !== JSON.stringify(installed.commands) ||
        JSON.stringify(local.requires) !== JSON.stringify(installed.requires) ||
        JSON.stringify(local.safe_profiles) !== JSON.stringify(installed.safe_profiles) ||
        !installed.files || typeof installed.files !== 'object' || Array.isArray(installed.files) ||
        !local.files || typeof local.files !== 'object' || Array.isArray(local.files) ||
        JSON.stringify(Object.keys(installed.files).sort()) !== JSON.stringify(REQUIRED_FILES) ||
        JSON.stringify(Object.keys(local.files).sort()) !== JSON.stringify(REQUIRED_FILES)) throw rootError();
    const allowed = new Set([...REQUIRED_FILES, 'manifest.json', ...DIRECTORIES.filter(Boolean)]);
    for (const relative of DIRECTORIES) {
      const directory = path.join(INSTALLED_ROOT, relative);
      trusted(directory, io, false, true);
      for (const name of io.readdirSync(directory)) {
        if (!allowed.has(relative ? `${relative}/${name}` : name)) throw rootError();
      }
    }
    for (const [relative, digest] of Object.entries(installed.files)) {
      const file = path.resolve(INSTALLED_ROOT, relative);
      if (path.isAbsolute(relative) || relative.split('/').includes('..') ||
          !file.startsWith(INSTALLED_ROOT + path.sep) || !/^[a-f0-9]{64}$/.test(digest) || local.files[relative] !== digest) throw rootError();
      trusted(file, io);
      const data = io.readFileSync(file);
      if (crypto.createHash('sha256').update(data).digest('hex') !== digest) throw rootError();
      verifyComponent(relative, data);
    }
    io.accessSync(HELPER, fs.constants.X_OK);
    io.accessSync(path.join(INSTALLED_ROOT, 'sysak'), fs.constants.X_OK);
    io.accessSync(path.join(INSTALLED_ROOT, TOOLS, 'ai'), fs.constants.X_OK);
    io.accessSync(SOCKET, fs.constants.R_OK | fs.constants.W_OK);
    return crypto.createHash('sha256').update(installedBytes).digest('hex');
  } catch {
    throw rootError();
  }
}

function connectRootIdc(binary, args, { connectImpl = net.createConnection } = {}) {
  const manifestHash = verifyRootInstallation(binary);
  const collection = args.length === 7 && args[0] === 'idc' && args[1] === '--profile' &&
    ['resources', 'inspection'].includes(args[2]) && args[3] === '--request-id' && UUID.test(args[4]) &&
    args[5] === '-o' && args[6] === '-';
  const action = args.length === 3 && args[0] === 'idc' && args[1] === '--process-action' &&
    ['check', 'terminate'].includes(args[2]);
  const agentCollection = args.length === 3 && args[0] === 'idc' && args[1] === '--agent-collection' &&
    ['status', 'ensure', 'disable'].includes(args[2]);
  if (!collection && !action && !agentCollection) throw rootError();
  const request = new EventEmitter();
  request.stdin = new PassThrough();
  request.stdout = new PassThrough();
  request.stderr = new PassThrough();
  const timeout = action ? 15000 : 35000;
  const deadline = Date.now() + timeout;
  const socket = connectImpl({ path: SOCKET });
  const input = [];
  let inputBytes = 0;
  let connected = false;
  let ready = false;
  let done = false;
  let buffer = '';
  const received = { stdout: 0, stderr: 0 };
  const finish = (code, error) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    socket.destroy();
    request.stdout.end();
    request.stderr.end();
    if (error) request.emit('error', error);
    request.emit('close', code);
  };
  const timer = setTimeout(() => finish(124), timeout);
  const send = () => {
    if (!connected || !ready || done) return;
    const body = JSON.stringify({ schema_version: '1.0', args, stdin: Buffer.concat(input).toString('utf8'),
      deadline, manifest_sha256: manifestHash }) + '\n';
    if (Buffer.byteLength(body) > 65536) return finish(126, rootError());
    socket.write(body);
  };
  request.stdin.on('data', chunk => {
    inputBytes += chunk.length;
    if (inputBytes > 65536) finish(126, rootError());
    else input.push(chunk);
  });
  request.stdin.on('finish', () => { ready = true; send(); });
  request.stdin.on('error', () => finish(126, rootError()));
  request.kill = () => { finish(null); return true; };
  socket.on('connect', () => { connected = true; send(); });
  socket.setEncoding('utf8');
  socket.on('data', chunk => {
    if (done) return;
    buffer += chunk;
    if (Buffer.byteLength(buffer) > 128 * 1024) return finish(126, rootError());
    let end;
    while (!done && (end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      try {
        const frame = JSON.parse(line);
        if (['stdout', 'stderr'].includes(frame.stream) &&
            Object.keys(frame).sort().join(',') === 'data,stream' && typeof frame.data === 'string' &&
            /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(frame.data)) {
          const data = Buffer.from(frame.data, 'base64');
          if (data.length > 16384) throw rootError();
          received[frame.stream] += data.length;
          if (received[frame.stream] > (frame.stream === 'stdout' ? 8 : 1) * 1024 * 1024) {
            return finish(125);
          }
          request[frame.stream].write(data);
        } else if (Number.isInteger(frame.code) && frame.code >= -64 && frame.code <= 255 &&
            Object.keys(frame).every(key => ['code', 'error'].includes(key)) &&
            (frame.error === undefined || ['ROOT_COLLECTOR_UNAVAILABLE', 'ROOT_SERVICE_BUSY', 'COLLECTION_TOO_LARGE'].includes(frame.error))) {
          if (buffer.length) throw rootError();
          finish(frame.code);
        } else throw rootError();
      } catch { finish(126, rootError()); }
    }
    if (!done && Buffer.byteLength(buffer) > 32768) finish(126, rootError());
  });
  socket.on('error', () => finish(126, rootError()));
  socket.on('close', () => { if (!done) finish(126, rootError()); });
  if (collection) queueMicrotask(() => request.stdin.end());
  return request;
}

module.exports = { verifyRootInstallation, connectRootIdc, INSTALLED_ROOT, HELPER, SOCKET, AUTH };
