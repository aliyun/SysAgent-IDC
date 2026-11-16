const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const net = require('node:net');
const childProcess = require('node:child_process');
const root = require('../electron/sysak-root.cjs');
const { verifyRootInstallation, connectRootIdc, INSTALLED_ROOT, HELPER, SOCKET, AUTH } = root;
// Consumers capture this inert spawn as their default too, so no test can ever
// start a real process; current-user collection is driven by explicit spawn doubles.
const savedSpawn = childProcess.spawn;
let collectRaw, createIdcController, runProcessAction, controlAgentCollection;
try {
  childProcess.spawn = () => assert.fail('no test may start a real process');
  ({ collectRaw, createIdcController } = require('../electron/idc-controller.cjs'));
  ({ runProcessAction } = require('../electron/process-control.cjs'));
  ({ controlAgentCollection } = require('../electron/agentsight-client.cjs'));
} finally {
  childProcess.spawn = savedSpawn;
}

const rootFailure = error => {
  assert.equal(error.code, 'ROOT_COLLECTOR_UNAVAILABLE');
  assert.match(error.message, /管理员安装并启用/);
  assert.match(error.message, /sysAK IDC 服务/);
  assert.match(error.message, /授权当前用户/);
  assert.doesNotMatch(error.message, /pkexec|sudo|实时授权|授权弹窗|private/);
  assert.match(error.message, /不以普通用户回退/);
  return true;
};
const hash = content => createHash('sha256').update(content).digest('hex');
const NOW = 1793536496000;
const UID = 1000;
const TOOLS = '.sysak_components/tools';
const COMMANDS = ['idc_inspect', 'resource_anomaly', 'memgraph', 'ai'];
const SAFE_PROFILES = { resource_anomaly: ['--idc'], memgraph: ['--graph', '--jsonstdout'], ai: ['--threshold', '1s'] };
const MODULES = [
  'resource_anomaly_idc', 'fdleak_metrics', 'plugin_abnormalPackages', 'plugin_anonTaskTop', 'plugin_cache',
  'plugin_memcgLeak', 'plugin_memfrag', 'plugin_memgraph', 'plugin_meminfo', 'plugin_memleak', 'plugin_podDetect',
  'plugin_system', 'plugin_taskProc', 'plugin_vmRssTaskTop', 'plugin_skcheck', 'plugin_appmem', 'mem_utils', 'plugin_thpCollect',
];
const FILES = ['sysak', `${TOOLS}/.sysak.rules`, ...COMMANDS.map(name => `${TOOLS}/${name}`),
  ...MODULES.map(name => `${TOOLS}/${name}.py`)].sort();
const DIRECTORIES = ['', '.sysak_components', TOOLS];
const COLLECTOR = `${TOOLS}/idc_inspect`;
const AI = `${TOOLS}/ai`;
const RULES = `${TOOLS}/.sysak.rules`;
const canonicalRules = 'detect/generic:idc_inspect:python-dep{python3}:help{idc_inspect}\n' +
  'detect/generic:resource_anomaly:python-dep{python3}:help{resource_anomaly --idc only}\n' +
  'detect/mem:memgraph:python-dep{python3}:help{memgraph --graph --jsonstdout}\n' +
  'generic:ai::help{GPU AI diagnostics}\n';
function mockElf(arch = process.arch) {
  const data = Buffer.alloc(64);
  Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]).copy(data);
  data.writeUInt16LE(3, 16);
  data.writeUInt16LE(arch === 'x64' ? 62 : 183, 18);
  data.writeUInt32LE(1, 20);
  data.writeUInt16LE(64, 52);
  return data;
}
const MiB = 1024 * 1024;
const turn = () => new Promise(resolve => setImmediate(resolve));
// The root service only brokers AgentSight collection control now.
const agentArgs = (action = 'status') => ['idc', '--agent-collection', action];
// Retired root argv families: collection and process actions run as the current user.
const collectionArgs = (id = randomUUID(), profile = 'resources') =>
  ['idc', '--profile', profile, '--request-id', id, '-o', '-'];
const inspectArgs = (id = randomUUID()) => ['idc_inspect', '--request-id', id, '-o', '-'];
const processArgs = (action = 'check') => ['idc_inspect', '--process-action', action];
const SYSTEM_SYSAK = '/usr/bin/sysak';

// The entire installation, including ownership and modes, exists only in memory.
// Unknown paths fail instead of falling through to the real filesystem.
function installationFixture(t) {
  if (t) t.mock.method(process, 'getuid', () => UID);
  const nodes = new Map();
  const inspected = [];
  const accessed = [];
  const binary = '/fixture/user-owned/bundle/sysak';
  const installedBinary = path.join(INSTALLED_ROOT, 'sysak');
  const installedCollector = path.join(INSTALLED_ROOT, COLLECTOR);
  const localManifest = path.join(path.dirname(binary), 'manifest.json');
  const installedManifest = path.join(INSTALLED_ROOT, 'manifest.json');
  function directory(file) {
    if (nodes.has(file)) return;
    const parent = path.dirname(file);
    if (parent !== file) directory(parent);
    nodes.set(file, { kind: 'directory', uid: 0, mode: 0o40755 });
  }
  function file(name, content, uid = 0, mode = 0o100755) {
    directory(path.dirname(name));
    nodes.set(name, { kind: 'file', uid, mode, content: Buffer.from(content) });
  }
  file(AUTH, `${UID}\n`, 0, 0o100644);
  directory(path.dirname(SOCKET));
  nodes.set(SOCKET, { kind: 'socket', uid: 0, mode: 0o140666 });
  file(HELPER, '# inert root helper fixture\n');
  file(installedBinary, mockElf());
  file(installedCollector, '#!/usr/bin/env python3\n# inert IDC entry fixture\n', 0, 0o100644);
  file(binary, nodes.get(installedBinary).content, 1000, 0o100700);
  file(path.join(path.dirname(binary), COLLECTOR), nodes.get(installedCollector).content, 1000, 0o100600);
  nodes.get('/fixture/user-owned').uid = 1000;
  nodes.get('/fixture/user-owned').mode = 0o40700;
  for (const relative of FILES) {
    const installed = path.join(INSTALLED_ROOT, relative);
    if (!nodes.has(installed)) {
      const data = relative === AI ? mockElf() : relative === RULES ? canonicalRules
        : COMMANDS.some(name => relative === `${TOOLS}/${name}`) ? '#!/usr/bin/env python3\n# inert entry\n'
          : `# inert ${relative} fixture\n`;
      file(installed, data, 0, relative === AI ? 0o100755 : 0o100644);
    }
    const local = path.join(path.dirname(binary), relative);
    if (!nodes.has(local)) file(local, nodes.get(installed).content, 1000, 0o100600);
  }
  const manifest = {
    schema_version: '1.0', platform: 'linux', arch: process.arch,
    commands: COMMANDS, requires: ['python3'], safe_profiles: SAFE_PROFILES,
    files: Object.fromEntries(FILES.map(relative => [relative, hash(nodes.get(path.join(INSTALLED_ROOT, relative)).content)])),
  };
  function writeManifest(name, value) {
    file(name, JSON.stringify(value), name === localManifest ? 1000 : 0, 0o100644);
  }
  writeManifest(localManifest, manifest);
  writeManifest(installedManifest, manifest);
  function get(name) {
    const node = nodes.get(name);
    if (!node) throw Object.assign(new Error(`missing fixture: ${name}`), { code: 'ENOENT' });
    return node;
  }
  const io = {
    lstatSync(name) {
      inspected.push(name);
      const node = get(name);
      return { uid: node.uid, mode: node.mode,
        isFile: () => node.kind === 'file',
        isDirectory: () => node.kind === 'directory',
        isSocket: () => node.kind === 'socket',
        isSymbolicLink: () => node.kind === 'symlink' };
    },
    readdirSync(name) {
      assert.equal(get(name).kind, 'directory');
      return [...nodes.keys()].filter(file => file !== name && path.dirname(file) === name).map(file => path.basename(file));
    },
    readFileSync(name, encoding) {
      const node = get(name);
      assert.equal(node.kind, 'file', 'fixture reads must target regular files');
      return encoding ? node.content.toString(encoding) : Buffer.from(node.content);
    },
    realpathSync(name) {
      get(name);
      return name;
    },
    accessSync(name, mode) {
      accessed.push({ name, mode });
      const node = get(name);
      if (((mode & fs.constants.X_OK) && !(node.mode & 0o111)) ||
          ((mode & fs.constants.R_OK) && !(node.mode & 0o444)) ||
          ((mode & fs.constants.W_OK) && !(node.mode & 0o222))) {
        throw Object.assign(new Error('fixture is not executable'), { code: 'EACCES' });
      }
    },
  };
  return { binary, installedBinary, installedCollector, localManifest, installedManifest,
    nodes, inspected, accessed, io, manifest, writeManifest,
    verify: () => verifyRootInstallation(binary, { io }),
    manifestHash: () => hash(nodes.get(installedManifest).content) };
}
function mockDefaultIo(t, fixture) {
  for (const name of ['lstatSync', 'readdirSync', 'readFileSync', 'realpathSync', 'accessSync']) t.mock.method(fs, name, fixture.io[name]);
  t.mock.method(Date, 'now', () => NOW);
  t.mock.method(net, 'createConnection', () => assert.fail('real socket connections are forbidden'));
  t.mock.method(childProcess, 'spawn', () => assert.fail('sudo/pkexec/user fallback is forbidden'));
  t.mock.method(process, 'kill', () => assert.fail('production signals are forbidden'));
}
const trustedPaths = () => [HELPER, AUTH, SOCKET, path.join(INSTALLED_ROOT, 'manifest.json'),
  ...FILES.map(relative => path.join(INSTALLED_ROOT, relative)),
  ...DIRECTORIES.map(relative => path.join(INSTALLED_ROOT, relative)),
  '/opt', path.dirname(INSTALLED_ROOT), '/run', path.dirname(SOCKET), '/etc', path.dirname(AUTH)];

test('root module exports fixed installation/helper/socket/auth entry points, never an elevation launcher', t => {
  assert.equal(typeof verifyRootInstallation, 'function');
  assert.equal(typeof connectRootIdc, 'function');
  assert.equal(SOCKET, '/run/sysom-idc/idc.sock');
  assert.equal(AUTH, '/etc/sysom-idc/allowed-uid');
  assert.equal(INSTALLED_ROOT, '/opt/SysAgent管家/resources/sysak');
  assert.equal(HELPER, '/opt/SysAgent管家/resources/sysak-root-runner.py');
  assert.deepEqual(Object.keys(root).sort(), ['AUTH', 'HELPER', 'INSTALLED_ROOT', 'SOCKET', 'connectRootIdc', 'verifyRootInstallation']);
  for (const file of [INSTALLED_ROOT, HELPER, SOCKET, AUTH]) assert(path.isAbsolute(file));
});

test('matching root installation returns its manifest digest despite a user-owned bundle and writable socket leaf', t => {
  const fixture = installationFixture(t);
  assert.equal(fixture.verify(), fixture.manifestHash());
  assert.deepEqual(fixture.accessed, [
    { name: HELPER, mode: fs.constants.X_OK }, { name: fixture.installedBinary, mode: fs.constants.X_OK },
    { name: path.join(INSTALLED_ROOT, AI), mode: fs.constants.X_OK },
    { name: SOCKET, mode: fs.constants.R_OK | fs.constants.W_OK },
  ]);
  for (const name of trustedPaths()) assert(fixture.inspected.includes(name), `must inspect ${name}`);
  assert.equal(verifyRootInstallation(fixture.installedBinary, { io: fixture.io }), fixture.manifestHash());
  fixture.nodes.get(fixture.installedBinary).mode = 0o100700;
  fixture.nodes.get(INSTALLED_ROOT).mode = 0o40700;
  assert.equal(fixture.verify(), fixture.manifestHash(), 'root owner-write is allowed');
  for (const mode of [0o140666, 0o140622]) {
    fixture.nodes.get(SOCKET).mode = mode;
    assert.equal(fixture.verify(), fixture.manifestHash(), 'only the socket leaf may be group/other writable');
  }
});

test('non-root ownership and group/other-writable files or ancestors fail closed', async t => {
  for (const name of trustedPaths()) for (const [label, mutate] of [
    ['non-root owner', node => { node.uid = 1000; }],
    ...(name === SOCKET ? [] : [
      ['group writable', node => { node.mode |= 0o020; }],
      ['other writable', node => { node.mode |= 0o002; }],
    ]),
  ]) await t.test(`${label}: ${name}`, t => {
    const fixture = installationFixture(t);
    mutate(fixture.nodes.get(name));
    assert.throws(fixture.verify, rootFailure);
  });
});

test('symlinks at any trusted file or ancestor and non-directory ancestors are rejected', async t => {
  for (const name of trustedPaths()) await t.test(`symlink: ${name}`, t => {
    const fixture = installationFixture(t);
    fixture.nodes.get(name).kind = 'symlink';
    assert.throws(fixture.verify, rootFailure);
  });
  await t.test('regular file used as an ancestor', t => {
    const fixture = installationFixture(t);
    fixture.nodes.get(INSTALLED_ROOT).kind = 'file';
    assert.throws(fixture.verify, rootFailure);
  });
  await t.test('directory used as the installed binary', t => {
    const fixture = installationFixture(t);
    fixture.nodes.get(fixture.installedBinary).kind = 'directory';
    assert.throws(fixture.verify, rootFailure);
  });
});

test('missing installation, source manifest, helpers or executables never trigger installation or fallback', async t => {
  for (const name of [...trustedPaths(), installationFixture().localManifest]) await t.test(`missing: ${name}`, t => {
    const fixture = installationFixture(t);
    fixture.nodes.delete(name);
    assert.throws(fixture.verify, rootFailure);
  });
  for (const name of [HELPER, installationFixture().installedBinary, path.join(INSTALLED_ROOT, AI)]) await t.test(`not executable: ${name}`, t => {
    const fixture = installationFixture(t);
    fixture.nodes.get(name).mode = 0o100644;
    assert.throws(fixture.verify, rootFailure);
  });
});

test('version/manifest disagreements and modified installed bytes are rejected', async t => {
  for (const [label, mutate] of [
    ['schema', value => { value.schema_version = '2.0'; }],
    ['architecture', value => { value.arch = 'other-arch'; }],
    ['platform', value => { value.platform = 'other-platform'; }],
    ['commands', value => { value.commands = ['idc']; }],
    ['digest mismatch', value => { value.files.sysak = '0'.repeat(64); }],
    ['missing file entry', value => { delete value.files[COLLECTOR]; }],
    ['extra file entry', value => { value.files['extra.py'] = '0'.repeat(64); }],
    ['files array', value => { value.files = []; }],
    ['files missing', value => { delete value.files; }],
  ]) await t.test(label, t => {
    const fixture = installationFixture(t);
    const installed = structuredClone(fixture.manifest);
    mutate(installed);
    fixture.writeManifest(fixture.installedManifest, installed);
    assert.throws(fixture.verify, rootFailure);
  });
  for (const name of ['installedBinary', 'installedCollector']) await t.test(`modified ${name}`, t => {
    const fixture = installationFixture(t);
    fixture.nodes.get(fixture[name]).content = Buffer.from('tampered installed bytes');
    assert.throws(fixture.verify, rootFailure);
  });
  for (const name of ['localManifest', 'installedManifest']) await t.test(`malformed ${name}`, t => {
    const fixture = installationFixture(t);
    fixture.nodes.get(fixture[name]).content = Buffer.from('{');
    assert.throws(fixture.verify, rootFailure);
  });
  for (const digest of ['not-a-hash', 'a'.repeat(63), 'A'.repeat(64)]) await t.test(`invalid digest: ${digest}`, t => {
    const fixture = installationFixture(t);
    const manifest = structuredClone(fixture.manifest);
    manifest.files.sysak = digest;
    fixture.writeManifest(fixture.localManifest, manifest);
    fixture.writeManifest(fixture.installedManifest, manifest);
    assert.throws(fixture.verify, rootFailure);
  });
});

test('native sysak/ai and canonical rules are validated even with matching local and installed digests', async t => {
  for (const relative of ['sysak', AI]) for (const [label, bad] of [
    ['python3 script', Buffer.from('#!/usr/bin/env python3\n')],
    ['wrong ELF architecture', mockElf(process.arch === 'x64' ? 'arm64' : 'x64')],
    ['truncated ELF', mockElf().subarray(0, 63)],
    ['invalid ELF', Buffer.alloc(64)],
  ]) await t.test(`${relative}: ${label}`, t => {
    const fixture = installationFixture(t);
    fixture.nodes.get(path.join(INSTALLED_ROOT, relative)).content = bad;
    const manifest = structuredClone(fixture.manifest);
    manifest.files[relative] = hash(bad);
    for (const file of [fixture.localManifest, fixture.installedManifest]) fixture.writeManifest(file, manifest);
    assert.throws(fixture.verify, rootFailure);
  });
  for (const bad of [
    canonicalRules.replace('generic:ai::', 'generic:ai:python-dep{python3}:'),
    canonicalRules.replace('generic:ai:', 'detect/gpu:ai:'),
    canonicalRules.replace('memgraph:python-dep{python3}', 'memgraph:python-dep{all}'),
    canonicalRules + 'detect/gpu:gpudiag:python-dep{python3}:help{old GPU}\n',
    canonicalRules + canonicalRules,
  ]) await t.test(`noncanonical rules: ${bad.slice(-64)}`, t => {
    const fixture = installationFixture(t);
    fixture.nodes.get(path.join(INSTALLED_ROOT, RULES)).content = Buffer.from(bad);
    const manifest = structuredClone(fixture.manifest);
    manifest.files[RULES] = hash(bad);
    for (const file of [fixture.localManifest, fixture.installedManifest]) fixture.writeManifest(file, manifest);
    assert.throws(fixture.verify, rootFailure);
  });
});

test('the complete old gpudiag package is not a runtime installation even with correct digests', t => {
  const fixture = installationFixture(t);
  const ai = path.join(INSTALLED_ROOT, AI);
  const gpudiag = `${TOOLS}/gpudiag`;
  const node = fixture.nodes.get(ai);
  fixture.nodes.delete(ai);
  fixture.nodes.set(path.join(INSTALLED_ROOT, gpudiag), { ...node, content: Buffer.from('#!/usr/bin/env python3\n# old GPU\n') });
  const rules = canonicalRules.replace('generic:ai::help{GPU AI diagnostics}', 'detect/gpu:gpudiag:python-dep{python3}:help{gpudiag --idc}');
  fixture.nodes.get(path.join(INSTALLED_ROOT, RULES)).content = Buffer.from(rules);
  const manifest = structuredClone(fixture.manifest);
  manifest.commands = [...COMMANDS.slice(0, 3), 'gpudiag'];
  delete manifest.safe_profiles.ai;
  manifest.safe_profiles.gpudiag = ['--idc'];
  delete manifest.files[AI];
  manifest.files[gpudiag] = hash(fixture.nodes.get(path.join(INSTALLED_ROOT, gpudiag)).content);
  manifest.files[RULES] = hash(rules);
  for (const name of ['gpu_snapshot.py', 'collectors/__init__.py', 'collectors/gpu.py', 'light_inspect_compat.py']) {
    const relative = `${TOOLS}/light_inspect/${name}`;
    const content = Buffer.from('# inert old GPU dependency\n');
    fixture.nodes.set(path.join(INSTALLED_ROOT, relative), { kind: 'file', uid: 0, mode: 0o100644, content });
    manifest.files[relative] = hash(content);
  }
  for (const file of [fixture.localManifest, fixture.installedManifest]) fixture.writeManifest(file, manifest);
  assert.equal(Object.keys(manifest.files).length, 28);
  assert.throws(fixture.verify, rootFailure);
});

test('manifest traversal and absolute paths cannot escape the root installation', async t => {
  for (const relative of ['../outside', 'nested/../../outside', '/outside', `${INSTALLED_ROOT}-outside/sysak`]) {
    await t.test(relative, t => {
      const fixture = installationFixture(t);
      const manifest = structuredClone(fixture.manifest);
      manifest.files[relative] = '0'.repeat(64);
      fixture.writeManifest(fixture.localManifest, manifest);
      fixture.writeManifest(fixture.installedManifest, manifest);
      assert.throws(fixture.verify, rootFailure);
      assert(!fixture.inspected.includes(path.resolve(INSTALLED_ROOT, relative)), 'must reject before inspecting an escaped target');
    });
  }
  for (const binary of ['sysak', 'relative/sysak', '/fixture/user-owned/bundle/other']) await t.test(`invalid binary: ${binary}`, t => {
    const fixture = installationFixture(t);
    assert.throws(() => verifyRootInstallation(binary, { io: fixture.io }), rootFailure);
  });
});


// Socket doubles never bind/connect to a real endpoint, nor deliver OS signals.
function fakeSocket(t, onWrite) {
  const socket = new EventEmitter();
  socket.writes = [];
  socket.destroyed = false;
  socket.setEncoding = encoding => { assert.equal(encoding, 'utf8'); return socket; };
  socket.write = body => {
    assert.equal(socket.destroyed, false);
    assert.equal(typeof body, 'string');
    socket.writes.push(body);
    onWrite?.(body, socket);
    return true;
  };
  socket.destroy = () => {
    if (!socket.destroyed) { socket.destroyed = true; socket.emit('close'); }
    return socket;
  };
  socket.frame = frame => socket.emit('data', JSON.stringify(frame) + '\n');
  socket.output = (stream, bytes) => {
    const data = Buffer.from(bytes);
    for (let offset = 0; offset < data.length; offset += 16384) {
      socket.frame({ stream, data: data.subarray(offset, offset + 16384).toString('base64') });
    }
  };
  t.after(() => socket.destroy());
  return socket;
}
function observe(request) {
  const result = { stdout: [], stderr: [], errors: [], codes: [] };
  for (const stream of ['stdout', 'stderr']) request[stream].on('data', chunk => result[stream].push(chunk));
  request.on('error', error => result.errors.push(error));
  request.on('close', code => result.codes.push(code));
  return result;
}
function connectionFixture(t, args = agentArgs()) {
  const files = installationFixture(t);
  mockDefaultIo(t, files);
  const socket = fakeSocket(t);
  const calls = [];
  const request = connectRootIdc(files.binary, args, { connectImpl(options) { calls.push(options); return socket; } });
  const result = observe(request);
  t.after(() => request.kill());
  return { files, socket, request, result, calls };
}
// Current-user `sysak idc_inspect` schema 1.1 envelope (compact subset).
function inspectRaw(requestId, sections = {}) {
  return { schema_version: '1.1', request_id: requestId,
    collector: { name: 'sysak', command: 'idc_inspect', version: 'fixture-1.1' },
    collection: { profile: 'inspection', status: 'ok', finished_at: new Date(NOW).toISOString(), duration_ms: 1200, sections: {} },
    host: { hostname: 'fixture-host' }, device: { id: 'fixture-device' }, capabilities: { read_only: true },
    sections: { cpu: { status: 'ok' }, memory: { status: 'ok' }, disk: { status: 'ok' }, fd: { status: 'ok' }, ...sections } };
}
function processReply(action, targets) {
  return { schema_version: '1.0', action, results: targets.map(target => ({ ...target,
    name: 'fixture-only', status: action === 'check' ? 'eligible' : 'signalled', eligible: true, reason: 'fixture' })) };
}
function collectionStatusReply(action) {
  const running = action !== 'disable';
  return { state: running ? 'running' : 'disabled', enabled: running, scope: running ? 'host' : 'none',
    trace_running: running, api_running: running };
}
// Inert current-user sysAK double: no real process, process group or signal exists.
function fakeSysakChild(kills) {
  const child = new EventEmitter();
  child.pid = 990099;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const input = [];
  child.stdin.on('data', chunk => input.push(chunk));
  child.input = () => Buffer.concat(input).toString('utf8');
  let finished = false;
  child.finish = (code = 0) => {
    if (finished) return;
    finished = true;
    child.stdout.end();
    child.stderr.end();
    setImmediate(() => child.emit('close', code));
  };
  child.kill = signal => { kills.push(signal); child.finish(null); return true; };
  return child;
}
function sysakSpawnFixture(t, onSpawn) {
  const calls = [];
  const kills = [];
  const groups = [];
  const spawnImpl = (file, argv, options) => {
    const child = fakeSysakChild(kills);
    const call = { file, argv, options, child };
    calls.push(call);
    t.after(() => child.finish(null));
    setImmediate(() => onSpawn?.(child, call));
    return child;
  };
  return { spawnImpl, calls, kills, groups, killGroup: (pid, signal) => { groups.push([pid, signal]); } };
}
// The system sysAK installation resolveSysak() looks for, entirely in memory.
function systemSysakFixture({ component = true, rules = true } = {}) {
  const components = '/usr/bin/.sysak_components';
  const entry = `${components}/tools/idc_inspect`;
  const rulesFile = `${components}/tools/.sysak.rules`;
  const files = new Map([[SYSTEM_SYSAK, Buffer.from('# inert system sysak\n')]]);
  if (component) files.set(entry, Buffer.from('#!/usr/bin/env python3\n# inert idc_inspect\n'));
  if (rules) files.set(rulesFile, Buffer.from(canonicalRules));
  const missing = name => Object.assign(new Error(`missing fixture: ${name}`), { code: 'ENOENT' });
  return { binary: SYSTEM_SYSAK, components, entry, rulesFile, files, io: {
    statSync(name) { if (!files.has(name)) throw missing(name); return { isFile: () => true }; },
    existsSync(name) { return name === components; },
    realpathSync(name) { if (!files.has(name)) throw missing(name); return name; },
    accessSync(name) { if (!files.has(name)) throw missing(name); },
    readFileSync(name, encoding) {
      if (!files.has(name)) throw missing(name);
      const content = files.get(name);
      return encoding ? content.toString(encoding) : Buffer.from(content);
    },
  } };
}
// Root installation IO stays observable (any consultation is recorded), while the
// current-user system sysAK resolves from its own in-memory fixture.
function mockCurrentUserInfo(t, files, system) {
  for (const name of ['lstatSync', 'readdirSync']) t.mock.method(fs, name, files.io[name]);
  for (const name of ['statSync', 'existsSync', 'realpathSync', 'accessSync', 'readFileSync']) t.mock.method(fs, name, system.io[name]);
  t.mock.method(Date, 'now', () => NOW);
  t.mock.method(net, 'createConnection', () => assert.fail('current-user collection must never open the root socket'));
  t.mock.method(childProcess, 'spawn', () => assert.fail('only inert spawn doubles are allowed'));
  t.mock.method(process, 'kill', () => assert.fail('production signals are forbidden'));
}
function consumerSocket(t, onRequest) {
  const files = installationFixture(t);
  mockDefaultIo(t, files);
  const calls = [];
  t.mock.method(net, 'createConnection', options => {
    assert.deepEqual(options, { path: SOCKET });
    const socket = fakeSocket(t, body => {
      assert.equal(body.endsWith('\n'), true);
      assert.equal(body.split('\n').length, 2, 'one JSON request, one newline');
      const request = JSON.parse(body);
      assert.deepEqual(Object.keys(request).sort(), ['args', 'deadline', 'manifest_sha256', 'schema_version', 'stdin']);
      assert.equal(request.schema_version, '1.0');
      assert.equal(request.manifest_sha256, files.manifestHash());
      calls.push({ socket, request });
      onRequest?.(request, socket);
    });
    setImmediate(() => socket.emit('connect'));
    return socket;
  });
  return { files, calls };
}

test('authorization requires the one exact non-root UID from process.getuid, not a supplied identity', async t => {
  for (const value of ['', '0', '1001', '-1000', '+1000', '01000', '1e3', '1000.0', '1000\n1001', '1000 garbage', '99999999999']) {
    await t.test(JSON.stringify(value), t => {
      const fixture = installationFixture(t);
      fixture.nodes.get(AUTH).content = Buffer.from(value);
      assert.throws(fixture.verify, rootFailure);
    });
  }
  for (const uid of [0, 1001]) await t.test(`actual UID ${uid}`, t => {
    const fixture = installationFixture(t);
    t.mock.method(process, 'getuid', () => uid);
    assert.throws(fixture.verify, rootFailure);
  });
});

test('nonregular trusted files/socket and nondirectory socket/auth ancestors are rejected', async t => {
  for (const name of [HELPER, AUTH, path.join(INSTALLED_ROOT, 'manifest.json'),
    path.join(INSTALLED_ROOT, 'sysak'), path.join(INSTALLED_ROOT, COLLECTOR)]) {
    for (const kind of ['directory', 'socket', 'fifo']) await t.test(`${kind}: ${name}`, t => {
      const fixture = installationFixture(t);
      fixture.nodes.get(name).kind = kind;
      assert.throws(fixture.verify, rootFailure);
    });
  }
  for (const kind of ['file', 'directory', 'fifo']) await t.test(`not a socket: ${kind}`, t => {
    const fixture = installationFixture(t);
    fixture.nodes.get(SOCKET).kind = kind;
    assert.throws(fixture.verify, rootFailure);
  });
  for (const name of ['/run', path.dirname(SOCKET), '/etc', path.dirname(AUTH)]) await t.test(`file ancestor: ${name}`, t => {
    const fixture = installationFixture(t);
    fixture.nodes.get(name).kind = 'file';
    assert.throws(fixture.verify, rootFailure);
  });
  for (const mode of [0o140222, 0o140444]) await t.test(`socket access mode ${mode.toString(8)}`, t => {
    const fixture = installationFixture(t);
    fixture.nodes.get(SOCKET).mode = mode;
    assert.throws(fixture.verify, rootFailure);
  });
});

test('matching but unsupported schema/platform/architecture/commands/filemaps still fail closed', async t => {
  for (const [label, mutate] of [
    ['schema', value => { value.schema_version = '2.0'; }],
    ['platform', value => { value.platform = 'darwin'; }],
    ['architecture', value => { value.arch = 'unsupported-arch'; }],
    ['missing idc command', value => { value.commands = ['memgraph']; }],
    ['commands not array', value => { value.commands = 'idc'; }],
    ['old three commands', value => { value.commands = COMMANDS.slice(0, 3); }],
    ['requires missing', value => { delete value.requires; }],
    ['python2 dependency', value => { value.requires.push('python2'); }],
    ['profiles missing', value => { delete value.safe_profiles; }],
    ['unsafe ai mode', value => { value.safe_profiles.ai = ['--all']; }],
    ['missing IDC entry', value => { delete value.files[COLLECTOR]; }],
    ['unknown component', value => { value.files[`${TOOLS}/light_inspect/collectors/cpu.py`] = '0'.repeat(64); }],
    ['empty filemap', value => { value.files = {}; }],
    ['sysak absent from filemap', value => { delete value.files.sysak; }],
  ]) await t.test(label, t => {
    const fixture = installationFixture(t);
    const manifest = structuredClone(fixture.manifest);
    mutate(manifest);
    for (const name of [fixture.localManifest, fixture.installedManifest]) fixture.writeManifest(name, manifest);
    assert.throws(fixture.verify, rootFailure);
  });
});

test('unexpected files/directories are refused even outside the hashed manifest', t => {
  assert.equal(FILES.length, 24);
  for (const relative of ['unknown.py', `${TOOLS}/light_inspect`, `${TOOLS}/gpudiag`]) {
    const fixture = installationFixture(t);
    fixture.nodes.set(path.join(INSTALLED_ROOT, relative), { kind: relative.endsWith('/light_inspect') ? 'directory' : 'file', uid: 0, mode: 0o100644, content: Buffer.from('inert') });
    assert.throws(fixture.verify, rootFailure);
  }
});

test('connector uses one fixed socket and exact credential-free request; collection control waits for stdin and connection', { timeout: 5000 }, async t => {
  for (const action of ['status', 'ensure', 'disable']) for (const order of ['connect first', 'stdin first']) {
    await t.test(`${action}: ${order}`, async t => {
      const args = agentArgs(action);
      const { files, socket, request, result, calls } = connectionFixture(t, args);
      assert(request instanceof EventEmitter);
      for (const stream of ['stdin', 'stdout', 'stderr']) assert(request[stream] instanceof PassThrough);
      assert.equal('pid' in request, false, 'socket request must not have a signalable PID');
      if (order === 'connect first') socket.emit('connect');
      assert.equal(socket.writes.length, 0, 'never send before the final input');
      request.stdin.end();
      await turn();
      if (order === 'stdin first') {
        assert.equal(socket.writes.length, 0, 'wait for connection');
        socket.emit('connect');
      }
      assert.deepEqual(calls, [{ path: SOCKET }]);
      assert.deepEqual(socket.writes, [JSON.stringify({ schema_version: '1.0', args, stdin: '',
        deadline: NOW + 35000, manifest_sha256: files.manifestHash() }) + '\n']);
      socket.frame({ code: 0 });
      assert.deepEqual(result.codes, [0]);
      assert.deepEqual(result.errors, []);
      assert.equal(socket.destroyed, true);
    });
  }
  // The service refuses every payload (root-helper Protocol suite); the client must
  // still buffer the whole input and write exactly one framed request.
  await t.test('partial payload is never sent', async t => {
    const args = agentArgs('ensure');
    const { files, socket, request, result } = connectionFixture(t, args);
    socket.emit('connect');
    request.stdin.write('{"manager_pid":99');
    assert.equal(socket.writes.length, 0, 'never send partial input');
    request.stdin.end('0099,"targets":[]}');
    await turn();
    assert.deepEqual(socket.writes, [JSON.stringify({ schema_version: '1.0', args,
      stdin: '{"manager_pid":990099,"targets":[]}', deadline: NOW + 35000, manifest_sha256: files.manifestHash() }) + '\n']);
    socket.frame({ code: 126, error: 'ROOT_COLLECTOR_UNAVAILABLE' });
    assert.deepEqual(result.codes, [126]);
  });
});

test('root client accepts only AgentSight collection-control argv and opens no socket for anything else', async t => {
  for (const args of [[], ['idc'], ['memgraph'], ['ai', '--threshold', '1s'], ['ai', '--idc'], ['gpudiag', '--idc'],
    // Retired root capabilities: collection profiles and process actions are refused.
    collectionArgs(), collectionArgs(randomUUID(), 'inspection'),
    collectionArgs(randomUUID(), 'ai'), collectionArgs(randomUUID(), 'gpudiag'),
    inspectArgs(), processArgs('check'), processArgs('terminate'),
    ['idc', '--process-action', 'check'], ['idc', '--process-action', 'terminate'],
    ['resource_anomaly', '--process-action', 'check'],
    ['idc', '--process-action', 'exec'], ['idc', '--process-action', 'check', 'extra'],
    ['idc', '--profile', '--process-action'], collectionArgs('not-a-uuid'),
    collectionArgs(randomUUID(), 'all'), [...collectionArgs(), '--uid', String(UID)],
    ['idc', '--profile', 'resources', '--request-id', randomUUID(), '-o', '/tmp/output'], ['sh', '-c', 'sysak idc'],
    // Collection control itself cannot be extended, reordered or given a payload path.
    ['idc', '--agent-collection'], ['idc', '--agent-collection', 'enable'], ['idc', '--agent-collection', ''],
    ['idc', '--agent-collection', 'status', '--uid', String(UID)], ['idc', '--agent-collection', 'ensure', '/bin/sh'],
    ['idc_inspect', '--agent-collection', 'status'], ['--agent-collection', 'idc', 'status'],
    ['idc', '--agent-collection', 'STATUS'], ['idc', '--agent-collection', 'status;id']]) {
    await t.test(JSON.stringify(args), t => {
      const fixture = installationFixture(t);
      mockDefaultIo(t, fixture);
      let connections = 0;
      assert.throws(() => connectRootIdc(fixture.binary, args, { connectImpl() { connections++; assert.fail('invalid argv connected'); } }), rootFailure);
      assert.equal(connections, 0);
    });
  }
});

test('unverified installation fails before connecting; no sudo/pkexec/ordinary-user fallback or retry', async t => {
  for (const kind of ['missing helper', 'user-owned sysak', 'missing auth', 'unauthorized UID', 'unsafe socket ancestor']) {
    await t.test(kind, t => {
      const fixture = installationFixture(t);
      if (kind === 'missing helper') fixture.nodes.delete(HELPER);
      if (kind === 'user-owned sysak') fixture.nodes.get(fixture.installedBinary).uid = UID;
      if (kind === 'missing auth') fixture.nodes.delete(AUTH);
      if (kind === 'unauthorized UID') fixture.nodes.get(AUTH).content = Buffer.from('1001');
      if (kind === 'unsafe socket ancestor') fixture.nodes.get(path.dirname(SOCKET)).mode |= 0o002;
      mockDefaultIo(t, fixture);
      let connections = 0;
      assert.throws(() => connectRootIdc(fixture.binary, agentArgs(), { connectImpl() { connections++; assert.fail('unverified connection'); } }), rootFailure);
      assert.equal(connections, 0);
    });
  }
  await t.test('synchronous connect failure is not retried', t => {
    const fixture = installationFixture(t);
    mockDefaultIo(t, fixture);
    let calls = 0;
    const failure = new Error('inert connect failure');
    assert.throws(() => connectRootIdc(fixture.binary, agentArgs(), { connectImpl() { calls++; throw failure; } }), failure);
    assert.equal(calls, 1);
  });
});

test('newline framing handles fragmented/multiple frames and preserves separate stdout/stderr base64 bytes', t => {
  const { socket, result } = connectionFixture(t);
  const out = Buffer.from('中文\u0000stdout\n');
  const err = Buffer.from([0xff, 0x00, 0x0a]);
  const wire = JSON.stringify({ stream: 'stdout', data: out.toString('base64') }) + '\n' +
    JSON.stringify({ stream: 'stderr', data: err.toString('base64') }) + '\n';
  for (const byte of wire) socket.emit('data', byte);
  socket.emit('data', JSON.stringify({ stream: 'stdout', data: Buffer.alloc(16384, 0x61).toString('base64') }) + '\n' + JSON.stringify({ code: 0 }) + '\n');
  assert.deepEqual(Buffer.concat(result.stdout), Buffer.concat([out, Buffer.alloc(16384, 0x61)]));
  assert.deepEqual(Buffer.concat(result.stderr), err);
  assert.deepEqual(result.codes, [0]);
  assert.deepEqual(result.errors, []);
  socket.frame({ stream: 'stdout', data: 'Yg==' });
  assert.equal(Buffer.concat(result.stdout).length, out.length + 16384, 'ignore output after final frame');
});

test('valid frames crossing a 64 KiB socket read are parsed before applying the incomplete-line limit', t => {
  const { socket, result } = connectionFixture(t);
  const chunk = Buffer.alloc(16384, 0x61);
  const line = JSON.stringify({ stream: 'stdout', data: chunk.toString('base64') }) + '\n';
  const wire = line.repeat(4) + '{"code":0}\n';
  socket.emit('data', wire.slice(0, 20000));
  socket.emit('data', wire.slice(20000, 20000 + 65536));
  socket.emit('data', wire.slice(20000 + 65536));
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.codes, [0]);
  assert.deepEqual(Buffer.concat(result.stdout), Buffer.alloc(65536, 0x61));
});

test('invalid frames, oversized chunks/lines and premature socket close fail closed', async t => {
  for (const [label, wire] of [
    ['malformed JSON', '{\n'], ['null', 'null\n'], ['array', '[]\n'], ['empty line', '\n'],
    ['unknown stream', JSON.stringify({ stream: 'stdin', data: 'YQ==' }) + '\n'],
    ['invalid base64', JSON.stringify({ stream: 'stdout', data: '%%%=' }) + '\n'],
    ['unpadded base64', JSON.stringify({ stream: 'stdout', data: 'YQ' }) + '\n'],
    ['non-string data', JSON.stringify({ stream: 'stdout', data: 1 }) + '\n'],
    ['extra stream key', JSON.stringify({ stream: 'stdout', data: 'YQ==', uid: UID }) + '\n'],
    ['chunk exceeds 16384', JSON.stringify({ stream: 'stdout', data: Buffer.alloc(16385).toString('base64') }) + '\n'],
    ['noninteger exit', '{"code":0.5}\n'], ['exit out of range', '{"code":256}\n'],
    ['exit is string', '{"code":"0"}\n'], ['unknown final error', '{"code":126,"error":"PRIVATE"}\n'],
    ['extra final key', '{"code":0,"uid":1000}\n'], ['trailing frame', '{"code":0}\n{"code":0}\n'],
    ['oversized unframed line', 'x'.repeat(65537)],
  ]) await t.test(label, t => {
    const { socket, result } = connectionFixture(t);
    socket.emit('data', wire);
    assert.deepEqual(result.codes, [126]);
    assert.equal(result.errors.length, 1);
    rootFailure(result.errors[0]);
    assert.equal(socket.destroyed, true);
  });
  for (const event of ['error', 'close']) await t.test(`premature ${event}`, t => {
    const { socket, result } = connectionFixture(t);
    socket.emit('data', '{"code":');
    socket.emit(event, new Error('private connection failure'));
    assert.deepEqual(result.codes, [126]);
    assert.equal(result.errors.length, 1);
    rootFailure(result.errors[0]);
  });
});

test('stream caps accept exactly 8 MiB stdout/1 MiB stderr and close on the first extra byte', async t => {
  for (const [stream, limit] of [['stdout', 8 * MiB], ['stderr', MiB]]) await t.test(stream, t => {
    const exact = connectionFixture(t);
    exact.socket.output(stream, Buffer.alloc(limit, 0x61));
    exact.socket.frame({ code: 0 });
    assert.equal(Buffer.concat(exact.result[stream]).length, limit);
    assert.deepEqual(exact.result.codes, [0]);
    assert.deepEqual(exact.result.errors, []);
    const oversized = connectionFixture(t);
    oversized.socket.output(stream, Buffer.alloc(limit, 0x61));
    oversized.socket.output(stream, Buffer.from('b'));
    oversized.socket.frame({ code: 0 });
    assert.equal(Buffer.concat(oversized.result[stream]).length, limit);
    assert.deepEqual(oversized.result.codes, [125]);
    assert.equal(oversized.socket.destroyed, true);
  });
});

// The service only accepts empty stdin, but the client must still bound whatever a
// caller writes before it reaches the wire (root-helper Protocol covers the refusal).
test('stdin and complete serialized request are byte-bounded to 65536 before socket write', async t => {
  await t.test('input exceeds cap', async t => {
    const { request, socket, result } = connectionFixture(t, agentArgs('status'));
    socket.emit('connect');
    request.stdin.write(Buffer.alloc(65536, 0x61));
    request.stdin.end('汉');
    await turn();
    assert.deepEqual(socket.writes, []);
    assert.deepEqual(result.codes, [126]);
    rootFailure(result.errors[0]);
  });
  await t.test('JSON overhead and escaping count toward wire limit', async t => {
    const args = agentArgs('status');
    const { files, request, socket, result } = connectionFixture(t, args);
    const overhead = Buffer.byteLength(JSON.stringify({ schema_version: '1.0', args, stdin: '',
      deadline: NOW + 35000, manifest_sha256: files.manifestHash() }) + '\n');
    socket.emit('connect');
    request.stdin.end('a'.repeat(65536 - overhead));
    await turn();
    assert.equal(Buffer.byteLength(socket.writes[0]), 65536);
    socket.frame({ code: 0 });
    assert.deepEqual(result.codes, [0]);
    const over = connectionFixture(t, args);
    over.socket.emit('connect');
    over.request.stdin.end('a'.repeat(65537 - overhead));
    await turn();
    assert.deepEqual(over.socket.writes, []);
    assert.deepEqual(over.result.codes, [126]);
    rootFailure(over.result.errors[0]);
    const escaped = connectionFixture(t, args);
    escaped.socket.emit('connect');
    escaped.request.stdin.end('"'.repeat(40000));
    await turn();
    assert.deepEqual(escaped.socket.writes, []);
    assert.deepEqual(escaped.result.codes, [126]);
  });
});

test('timeout/cancel close only sockets, emit one terminal close and clear timers without signals', async t => {
  for (const action of ['status', 'ensure', 'disable']) await t.test(action, t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { request, socket, result } = connectionFixture(t, agentArgs(action));
    // One unified 35 s budget: the retired 15 s process-action deadline is gone.
    t.mock.timers.tick(35000 - 1);
    assert.deepEqual(result.codes, []);
    t.mock.timers.tick(1);
    assert.deepEqual(result.codes, [124]);
    assert.equal(socket.destroyed, true);
    request.kill('SIGKILL');
    socket.frame({ code: 0 });
    t.mock.timers.tick(100000);
    assert.deepEqual(result.codes, [124]);
    assert.deepEqual(result.errors, []);
  });
  await t.test('cancel before connect/final input', t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { request, socket, result } = connectionFixture(t, agentArgs('ensure'));
    assert.equal(request.kill('SIGTERM'), true);
    assert.equal(request.kill(), true);
    socket.emit('connect');
    request.stdin.end('{}');
    t.mock.timers.tick(100000);
    assert.deepEqual(result.codes, [null]);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(socket.writes, []);
  });
  await t.test('stdin error does not expose private details', t => {
    const { request, result } = connectionFixture(t, agentArgs('disable'));
    request.stdin.emit('error', new Error('private input error'));
    assert.deepEqual(result.codes, [126]);
    rootFailure(result.errors[0]);
  });
});

test('controller startup resolves the system sysak without root-service verification, connecting or spawning', { skip: process.platform !== 'linux', timeout: 5000 }, async t => {
  for (const kind of ['matching root installation', 'missing helper', 'user-owned binary', 'missing socket', 'wrong UID',
    'missing idc_inspect component', 'missing rules']) {
    await t.test(kind, async t => {
      const fixture = installationFixture(t);
      if (kind === 'missing helper') fixture.nodes.delete(HELPER);
      if (kind === 'user-owned binary') fixture.nodes.get(fixture.installedBinary).uid = UID;
      if (kind === 'missing socket') fixture.nodes.delete(SOCKET);
      if (kind === 'wrong UID') fixture.nodes.get(AUTH).content = Buffer.from('1001');
      const system = systemSysakFixture({ component: kind !== 'missing idc_inspect component', rules: kind !== 'missing rules' });
      mockCurrentUserInfo(t, fixture, system);
      const savedBinary = process.env.SYSOM_SYSAK_BIN;
      delete process.env.SYSOM_SYSAK_BIN;
      t.after(() => { if (savedBinary !== undefined) process.env.SYSOM_SYSAK_BIN = savedBinary; });
      let closed = false;
      const controller = await createIdcController({ bundleRoot: path.dirname(fixture.binary), sysomConfig: null,
        startMockOpenApi: async () => ({ baseUrl: 'http://fixture.invalid', close: async () => { closed = true; } }),
        scheduler: { now: () => NOW, setTimeout: () => 1, clearTimeout() {} },
        spawnImpl: () => assert.fail('startup must never spawn'), killGroup: () => assert.fail('must not signal any group'),
      });
      t.after(() => controller.close());
      const installed = !['missing idc_inspect component', 'missing rules'].includes(kind);
      assert.equal(controller.status().installed, installed);
      assert.equal(controller.status().collector.command, 'idc_inspect');
      assert.equal(controller.status().collector.schema_version, '1.1');
      if (installed) {
        assert.equal(controller.status().phase, 'idle');
        assert.equal(controller.status().error, null);
        assert.equal(controller.status().collector.binary, SYSTEM_SYSAK);
        assert.equal(controller.status().collector.source, 'system');
      } else {
        assert.equal(controller.status().phase, 'error');
        assert.equal(controller.status().error.code, 'SYSAK_COMPONENT_MISSING');
        assert.match(controller.status().error.message, /idc_inspect/);
      }
      // Local collection no longer depends on the root AgentSight-only service:
      // its installation is never inspected, connected to or used as a fallback.
      assert.deepEqual(fixture.inspected, []);
      await controller.close();
      assert.equal(closed, true);
    });
  }
});

test('the remaining root consumer (AgentSight collection control) uses net.createConnection, never spawn, and sends no UID/environment', { timeout: 5000 }, async t => {
  for (const action of ['status', 'ensure', 'disable']) await t.test(action, async t => {
    const fixture = consumerSocket(t, (request, socket) => {
      assert.deepEqual(request.args, agentArgs(action));
      assert.equal(request.stdin, '', 'collection control never carries a payload');
      socket.output('stdout', JSON.stringify(collectionStatusReply(action)));
      socket.output('stderr', 'private diagnostic');
      socket.frame({ code: 0 });
    });
    const status = await controlAgentCollection(fixture.files.binary, action);
    assert.equal(status.state, action === 'disable' ? 'disabled' : 'running');
    assert.equal(status.enabled, action !== 'disable');
    assert.equal(fixture.calls.length, 1);
    const request = fixture.calls[0].request;
    assert.equal(request.deadline, NOW + 35000);
    assert.equal(request.schema_version, '1.0');
    assert.equal(Object.hasOwn(request, 'uid'), false);
    assert.equal(Object.hasOwn(request, 'env'), false);
    assert.equal(fixture.calls[0].socket.destroyed, true);
  });
});

test('collection/check/terminate consumers spawn the current-user sysak, never the root socket, and send no UID/environment', { timeout: 5000 }, async t => {
  for (const kind of ['collection', 'check', 'terminate']) await t.test(kind, async t => {
    const targets = [{ pid: 900101, starttime: 1000 }];
    const fixture = installationFixture(t);
    const system = systemSysakFixture();
    mockCurrentUserInfo(t, fixture, system);
    const requestId = randomUUID();
    const spawn = sysakSpawnFixture(t, (child, call) => {
      if (call.argv[1] === '--request-id') child.stdout.write(JSON.stringify(inspectRaw(requestId)));
      else {
        assert.deepEqual(JSON.parse(child.input()), { manager_pid: 990099, targets });
        child.stdout.write(JSON.stringify(processReply(kind, targets)));
      }
      child.stderr.write('private diagnostic');
      child.finish(0);
    });
    if (kind === 'collection') {
      const result = await collectRaw(SYSTEM_SYSAK, requestId, new AbortController().signal,
        { spawnImpl: spawn.spawnImpl, killGroup: spawn.killGroup });
      assert.deepEqual(result.raw, inspectRaw(requestId));
      assert.equal(result.stderrBytes, Buffer.byteLength('private diagnostic'));
    } else {
      assert.deepEqual(await runProcessAction(SYSTEM_SYSAK, kind, targets,
        { spawnImpl: spawn.spawnImpl, managerPid: 990099 }), processReply(kind, targets).results);
    }
    assert.equal(spawn.calls.length, 1, 'one current-user invocation, no root fallback');
    const call = spawn.calls[0];
    assert.equal(call.file, SYSTEM_SYSAK);
    assert.deepEqual(call.argv, kind === 'collection' ? inspectArgs(requestId) : processArgs(kind));
    assert.equal(call.options.shell, false);
    assert.equal(call.options.cwd, path.dirname(SYSTEM_SYSAK));
    assert.deepEqual(call.options.stdio, kind === 'collection' ? ['ignore', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe']);
    assert.deepEqual(Object.keys(call.options.env).sort(), ['LANG', 'PATH', 'PYTHONDONTWRITEBYTECODE']);
    assert.deepEqual(fixture.inspected, [], 'current-user collection never verifies the root installation');
    assert.deepEqual(spawn.kills, []);
    assert.deepEqual(spawn.groups, []);
  });
});

test('controller snapshot and local process annotation use current-user sysak doubles with mocked HTTP and never the root socket', { skip: process.platform !== 'linux', timeout: 5000 }, async t => {
  const targets = [{ pid: 900101, starttime: 1000 }];
  const files = installationFixture(t);
  const system = systemSysakFixture();
  mockCurrentUserInfo(t, files, system);
  const spawn = sysakSpawnFixture(t, (child, call) => {
    if (call.argv[1] === '--request-id') {
      child.stdout.write(JSON.stringify(inspectRaw(call.argv[2], { process: { status: 'ok', top_cpu: targets } })));
    } else {
      assert.deepEqual(call.argv, processArgs('check'));
      assert.deepEqual(JSON.parse(child.input()), { manager_pid: process.pid, targets });
      child.stdout.write(JSON.stringify(processReply('check', targets)));
    }
    child.finish(0);
  });
  const state = { mode: 'collected', hasGpu: false, revision: 1, sampledAt: new Date(NOW).toISOString(),
    resources: Object.fromEntries(['cpu', 'energy', 'memory', 'disk', 'gpu'].map(id => [id, {
      id, label: id, usage: ['energy', 'gpu'].includes(id) ? null : 12,
      unit: id === 'energy' ? 'W' : '%', rows: [],
    }])), inspections: [], optimizations: [], operations: [] };
  state.resources.cpu.rows = [{ id: 'process-900101-1000', ...targets[0], usage: 12,
    cleanable: true, defaultSelected: true, name: 'untrusted API name', effect: 'untrusted API effect' }];
  const httpCalls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'http://fixture.invalid/openapi/v1/collections');
    assert.equal(options.method, 'POST');
    const body = JSON.parse(options.body);
    httpCalls.push(body);
    assert.equal(body.operation, 'snapshot');
    assert.equal(body.schema_version, '1.1');
    assert.equal(body.raw_snapshot.request_id, body.request_id);
    return { ok: true, text: async () => JSON.stringify({ schema_version: '1.1', request_id: body.request_id,
      task_id: randomUUID(), mode: 'mock', read_only: true, state,
      task: { simulated: false, status: 'completed' } }) };
  });
  let apiClosed = false;
  const controller = await createIdcController({ bundleRoot: path.dirname(files.binary), sysomConfig: null,
    startMockOpenApi: async () => ({ baseUrl: 'http://fixture.invalid', close: async () => { apiClosed = true; } }),
    scheduler: { now: () => NOW, setTimeout: () => 1, clearTimeout() {} },
    spawnImpl: spawn.spawnImpl, killGroup: spawn.killGroup,
    processActionImpl: (action, list) => runProcessAction(SYSTEM_SYSAK, action, list, { spawnImpl: spawn.spawnImpl }),
  });
  t.after(() => controller.close());
  assert.equal(spawn.calls.length, 0, 'startup must not collect or connect');
  const result = await controller.snapshot();
  assert.equal(result.resources.cpu.rows[0].cleanable, true);
  assert.equal(result.resources.cpu.rows[0].defaultSelected, false);
  assert.match(result.resources.cpu.rows[0].effect, /整个进程.*SIGTERM/);
  assert.equal(spawn.calls.length, 2, 'collection and check both use the current-user sysak');
  assert.deepEqual(spawn.calls.map(call => call.argv[1]), ['--request-id', '--process-action']);
  assert.equal(httpCalls.length, 1);
  assert.equal(controller.status().last_task.simulated, false);
  assert.deepEqual(await controller.snapshot(), result);
  assert.equal(spawn.calls.length, 2, 'cache reads never re-collect or re-authorize');
  assert.deepEqual(files.inspected, [], 'the root installation is never consulted');
  assert.deepEqual(spawn.groups, []);
  await controller.close();
  assert.equal(apiClosed, true);
});

test('current-user consumers reject spawn failure, nonzero exit and oversized output without root fallback or retry', { timeout: 5000 }, async t => {
  for (const kind of ['collection', 'check', 'terminate']) for (const failure of ['root service unavailable', 'root UID denied', 'spawn error', 'nonzero exit', 'oversized output']) {
    await t.test(`${kind}: ${failure}`, async t => {
      const targets = [{ pid: 900101, starttime: 1000 }];
      const fixture = installationFixture(t);
      if (failure === 'root service unavailable') fixture.nodes.delete(AUTH);
      if (failure === 'root UID denied') fixture.nodes.get(AUTH).content = Buffer.from('1001');
      const system = systemSysakFixture();
      mockCurrentUserInfo(t, fixture, system);
      const requestId = randomUUID();
      // A broken or unauthorized root service must neither block nor replace local collection.
      const independent = ['root service unavailable', 'root UID denied'].includes(failure);
      const spawn = sysakSpawnFixture(t, (child, call) => {
        const collection = call.argv[1] === '--request-id';
        if (independent) {
          child.stdout.write(JSON.stringify(collection ? inspectRaw(requestId) : processReply(kind, targets)));
          return child.finish(0);
        }
        if (failure === 'spawn error') return child.emit('error', new Error('private spawn failure'));
        if (failure === 'nonzero exit') return child.finish(126);
        child.stdout.write(Buffer.alloc(collection ? 8 * MiB + 1 : 65537, 0x61));
        child.finish(0);
      });
      const pending = kind === 'collection'
        ? collectRaw(SYSTEM_SYSAK, requestId, new AbortController().signal, { spawnImpl: spawn.spawnImpl, killGroup: spawn.killGroup })
        : runProcessAction(SYSTEM_SYSAK, kind, targets, { spawnImpl: spawn.spawnImpl, managerPid: 990099 });
      if (independent) {
        if (kind === 'collection') assert.deepEqual((await pending).raw, inspectRaw(requestId));
        else assert.deepEqual(await pending, processReply(kind, targets).results);
      } else {
        await assert.rejects(pending, error => {
          if (kind === 'collection') {
            assert.equal(error.code, failure === 'spawn error' ? 'COLLECTOR_UNAVAILABLE' : failure === 'nonzero exit' ? 'COLLECTION_FAILED' : 'COLLECTION_TOO_LARGE');
            assert.equal(error.status, failure === 'oversized output' ? 413 : 503);
            assert.equal(error.retryable, failure === 'nonzero exit');
          } else assert.match(error.message, failure === 'spawn error' ? /无法启动 sysAK 进程操作/ : failure === 'nonzero exit' ? /进程操作不可用/ : /超过限制/);
          assert.doesNotMatch(error.message, /private|pkexec|sudo/);
          return true;
        });
      }
      assert.equal(spawn.calls.length, 1, 'no fallback or retry');
      assert.deepEqual(fixture.inspected, [], 'the root installation is never consulted');
      if (failure === 'oversized output') {
        if (kind === 'collection') assert.deepEqual(spawn.groups, [[990099, 'SIGTERM']]);
        else assert.deepEqual(spawn.kills, ['SIGTERM']);
      } else {
        assert.deepEqual(spawn.groups, []);
        assert.deepEqual(spawn.kills, []);
      }
    });
  }
});

test('collectRaw cancellation/pre-abort/timeout signals only the fake current-user group, never the root socket', { timeout: 5000 }, async t => {
  for (const cause of ['cancel', 'timeout', 'pre-abort']) await t.test(cause, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const fixture = installationFixture(t);
    const system = systemSysakFixture();
    mockCurrentUserInfo(t, fixture, system);
    const spawn = sysakSpawnFixture(t, () => {});
    const abort = new AbortController();
    if (cause === 'pre-abort') abort.abort();
    const pending = collectRaw(SYSTEM_SYSAK, randomUUID(), abort.signal,
      { spawnImpl: spawn.spawnImpl, killGroup: spawn.killGroup, timeoutMs: 10 });
    const rejected = assert.rejects(pending, error => {
      assert.equal(error.code, cause === 'timeout' ? 'COLLECTION_TIMEOUT' : 'COLLECTION_CANCELLED');
      return true;
    });
    if (cause !== 'pre-abort') {
      await turn();
      assert.equal(spawn.calls.length, 1);
      if (cause === 'cancel') abort.abort();
      else t.mock.timers.tick(10);
      assert.deepEqual(spawn.groups, [[990099, 'SIGTERM']], 'cancellation signals the current-user process group');
      t.mock.timers.tick(1000);
      assert.deepEqual(spawn.groups, [[990099, 'SIGTERM'], [990099, 'SIGKILL']], 'a stuck group is escalated to SIGKILL');
      // collectRaw settles on the child's 'close' event, so let the fake group die first.
      spawn.calls[0].child.finish(null);
    }
    await rejected;
    if (cause === 'pre-abort') assert.equal(spawn.calls.length, 0, 'a pre-aborted collection never spawns');
    assert.deepEqual(spawn.kills, [], 'the fake group is signalled, never child.kill fallback');
    assert.deepEqual(fixture.inspected, []);
    t.mock.timers.tick(100000);
    abort.abort();
  });
});
