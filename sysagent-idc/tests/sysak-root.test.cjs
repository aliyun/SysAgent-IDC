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
// Consumers capture this inert spawn as their default too, so a regression can
// never start a process, even without a caller-provided spawnImpl.
const savedSpawn = childProcess.spawn;
let collectRaw, createIdcController, runProcessAction;
try {
  childProcess.spawn = () => assert.fail('production consumers must never spawn');
  ({ collectRaw, createIdcController } = require('../electron/idc-controller.cjs'));
  ({ runProcessAction } = require('../electron/process-control.cjs'));
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
const COMMANDS = ['idc', 'resource_anomaly', 'memgraph', 'ai'];
const SAFE_PROFILES = { resource_anomaly: ['--idc'], memgraph: ['--graph', '--jsonstdout'], ai: ['--threshold', '1s'] };
const MODULES = [
  'resource_anomaly_idc', 'fdleak_metrics', 'plugin_abnormalPackages', 'plugin_anonTaskTop', 'plugin_cache',
  'plugin_memcgLeak', 'plugin_memfrag', 'plugin_memgraph', 'plugin_meminfo', 'plugin_memleak', 'plugin_podDetect',
  'plugin_system', 'plugin_taskProc', 'plugin_vmRssTaskTop', 'plugin_skcheck', 'plugin_appmem', 'mem_utils', 'plugin_thpCollect',
];
const FILES = ['sysak', `${TOOLS}/.sysak.rules`, ...COMMANDS.map(name => `${TOOLS}/${name}`),
  ...MODULES.map(name => `${TOOLS}/${name}.py`)].sort();
const DIRECTORIES = ['', '.sysak_components', TOOLS];
const COLLECTOR = `${TOOLS}/idc`;
const AI = `${TOOLS}/ai`;
const RULES = `${TOOLS}/.sysak.rules`;
const canonicalRules = 'detect/generic:idc:python-dep{python3}:help{idc}\n' +
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
const collectionArgs = (id = randomUUID(), profile = 'resources') =>
  ['idc', '--profile', profile, '--request-id', id, '-o', '-'];

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
function connectionFixture(t, args = collectionArgs()) {
  const files = installationFixture(t);
  mockDefaultIo(t, files);
  const socket = fakeSocket(t);
  const calls = [];
  const request = connectRootIdc(files.binary, args, { connectImpl(options) { calls.push(options); return socket; } });
  const result = observe(request);
  t.after(() => request.kill());
  return { files, socket, request, result, calls };
}
function rawSnapshot(profile, requestId) {
  return { schema_version: '1.0', request_id: requestId, collected_at: new Date(NOW).toISOString(),
    collector: { name: 'sysak', permissions: { status: 'granted', elevated: true, denied: [] } },
    collection: { profile, status: 'ok' }, capabilities: { read_only: true },
    resources: {}, configuration: {}, diagnostics: {} };
}
function processReply(action, targets) {
  return { schema_version: '1.0', action, results: targets.map(target => ({ ...target,
    name: 'fixture-only', status: action === 'check' ? 'eligible' : 'signalled', eligible: true, reason: 'fixture' })) };
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

test('connector uses one fixed socket and exact credential-free request; actions wait for stdin and connection', { timeout: 5000 }, async t => {
  for (const action of ['check', 'terminate']) for (const order of ['connect first', 'stdin first']) {
    await t.test(`${action}: ${order}`, async t => {
      const args = ['idc', '--process-action', action];
      const { files, socket, request, result, calls } = connectionFixture(t, args);
      assert(request instanceof EventEmitter);
      for (const stream of ['stdin', 'stdout', 'stderr']) assert(request[stream] instanceof PassThrough);
      assert.equal('pid' in request, false, 'socket request must not have a signalable PID');
      const stdin = JSON.stringify({ manager_pid: 990099, targets: [{ pid: 900101, starttime: 1000 }] });
      if (order === 'connect first') socket.emit('connect');
      request.stdin.write(stdin.slice(0, 10));
      assert.equal(socket.writes.length, 0, 'never send partial input');
      request.stdin.end(stdin.slice(10));
      await turn();
      if (order === 'stdin first') {
        assert.equal(socket.writes.length, 0, 'wait for connection');
        socket.emit('connect');
      }
      assert.deepEqual(calls, [{ path: SOCKET }]);
      assert.deepEqual(socket.writes, [JSON.stringify({ schema_version: '1.0', args, stdin,
        deadline: NOW + 15000, manifest_sha256: files.manifestHash() }) + '\n']);
      socket.frame({ code: 0 });
      assert.deepEqual(result.codes, [0]);
      assert.deepEqual(result.errors, []);
      assert.equal(socket.destroyed, true);
    });
  }
  for (const profile of ['resources', 'inspection']) await t.test(profile, async t => {
    const args = collectionArgs(randomUUID(), profile);
    const { files, socket, request } = connectionFixture(t, args);
    socket.emit('connect');
    await turn();
    assert.equal(request.stdin.writableEnded, true);
    assert.deepEqual(socket.writes, [JSON.stringify({ schema_version: '1.0', args, stdin: '',
      deadline: NOW + 35000, manifest_sha256: files.manifestHash() }) + '\n']);
    socket.frame({ code: 0 });
  });
});

test('invalidRequest accepts only exact sysak idc collection/action argv and opens no socket', async t => {
  for (const args of [[], ['idc'], ['memgraph'], ['ai', '--threshold', '1s'], ['ai', '--idc'], ['gpudiag', '--idc'],
    collectionArgs(randomUUID(), 'ai'), collectionArgs(randomUUID(), 'gpudiag'),
    ['resource_anomaly', '--process-action', 'check'],
    ['idc', '--process-action', 'exec'], ['idc', '--process-action', 'check', 'extra'],
    ['idc', '--profile', '--process-action'], collectionArgs('not-a-uuid'),
    collectionArgs(randomUUID(), 'all'), [...collectionArgs(), '--uid', String(UID)],
    ['idc', '--profile', 'resources', '--request-id', randomUUID(), '-o', '/tmp/output'], ['sh', '-c', 'sysak idc']]) {
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
      assert.throws(() => connectRootIdc(fixture.binary, collectionArgs(), { connectImpl() { connections++; assert.fail('unverified connection'); } }), rootFailure);
      assert.equal(connections, 0);
    });
  }
  await t.test('synchronous connect failure is not retried', t => {
    const fixture = installationFixture(t);
    mockDefaultIo(t, fixture);
    let calls = 0;
    const failure = new Error('inert connect failure');
    assert.throws(() => connectRootIdc(fixture.binary, collectionArgs(), { connectImpl() { calls++; throw failure; } }), failure);
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

test('stdin and complete serialized request are byte-bounded to 65536 before socket write', async t => {
  await t.test('input exceeds cap', async t => {
    const { request, socket, result } = connectionFixture(t, ['idc', '--process-action', 'check']);
    socket.emit('connect');
    request.stdin.write(Buffer.alloc(65536, 0x61));
    request.stdin.end('汉');
    await turn();
    assert.deepEqual(socket.writes, []);
    assert.deepEqual(result.codes, [126]);
    rootFailure(result.errors[0]);
  });
  await t.test('JSON overhead and escaping count toward wire limit', async t => {
    const args = ['idc', '--process-action', 'check'];
    const { files, request, socket, result } = connectionFixture(t, args);
    const overhead = Buffer.byteLength(JSON.stringify({ schema_version: '1.0', args, stdin: '',
      deadline: NOW + 15000, manifest_sha256: files.manifestHash() }) + '\n');
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
  for (const args of [collectionArgs(), ['idc', '--process-action', 'terminate']]) await t.test(args[1], t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { request, socket, result } = connectionFixture(t, args);
    const timeout = args[1] === '--profile' ? 35000 : 15000;
    t.mock.timers.tick(timeout - 1);
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
    const { request, socket, result } = connectionFixture(t, ['idc', '--process-action', 'check']);
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
    const { request, result } = connectionFixture(t, ['idc', '--process-action', 'check']);
    request.stdin.emit('error', new Error('private input error'));
    assert.deepEqual(result.codes, [126]);
    rootFailure(result.errors[0]);
  });
});

test('controller startup defaults to service verification without connecting or starting a process', { skip: process.platform !== 'linux', timeout: 5000 }, async t => {
  for (const kind of ['matching installation', 'missing helper', 'user-owned binary', 'missing socket', 'wrong UID']) {
    await t.test(kind, async t => {
      const fixture = installationFixture(t);
      if (kind === 'missing helper') fixture.nodes.delete(HELPER);
      if (kind === 'user-owned binary') fixture.nodes.get(fixture.installedBinary).uid = UID;
      if (kind === 'missing socket') fixture.nodes.delete(SOCKET);
      if (kind === 'wrong UID') fixture.nodes.get(AUTH).content = Buffer.from('1001');
      mockDefaultIo(t, fixture);
      let closed = false;
      const controller = await createIdcController({ bundleRoot: path.dirname(fixture.binary),
        startMockOpenApi: async () => ({ baseUrl: 'http://fixture.invalid', close: async () => { closed = true; } }),
        scheduler: { now: () => NOW, setTimeout: () => 1, clearTimeout() {} },
        spawnImpl: () => assert.fail('startup must never spawn'), killGroup: () => assert.fail('must not signal any group'),
      });
      t.after(() => controller.close());
      assert.equal(controller.status().installed, kind === 'matching installation');
      if (kind === 'matching installation') {
        assert.equal(controller.status().phase, 'idle');
        assert.equal(controller.status().error, null);
        fixture.nodes.delete(HELPER);
      } else {
        assert.equal(controller.status().phase, 'error');
        rootFailure(controller.status().error);
      }
      await assert.rejects(controller.snapshot(), rootFailure);
      assert.equal(controller.status().error.code, 'ROOT_COLLECTOR_UNAVAILABLE');
      await controller.close();
      assert.equal(closed, true);
    });
  }
});

test('default collection/check/terminate consumers use net.createConnection, never spawn, and send no UID/environment', { timeout: 5000 }, async t => {
  for (const kind of ['collection', 'check', 'terminate']) await t.test(kind, async t => {
    const targets = [{ pid: 900101, starttime: 1000 }];
    const fixture = consumerSocket(t, (request, socket) => {
      if (kind === 'collection') socket.output('stdout', JSON.stringify(rawSnapshot(request.args[2], request.args[4])));
      else {
        assert.deepEqual(JSON.parse(request.stdin), { manager_pid: 990099, targets });
        socket.output('stdout', JSON.stringify(processReply(kind, targets)));
      }
      socket.output('stderr', 'private diagnostic');
      socket.frame({ code: 0 });
    });
    const requestId = randomUUID();
    if (kind === 'collection') {
      const result = await collectRaw(fixture.files.binary, 'resources', requestId, new AbortController().signal);
      assert.deepEqual(result.raw, rawSnapshot('resources', requestId));
      assert.equal(result.stderrBytes, Buffer.byteLength('private diagnostic'));
    } else assert.deepEqual(await runProcessAction(fixture.files.binary, kind, targets, { managerPid: 990099 }), processReply(kind, targets).results);
    assert.equal(fixture.calls.length, 1);
    const request = fixture.calls[0].request;
    assert.deepEqual(request.args, kind === 'collection' ? collectionArgs(requestId) : ['idc', '--process-action', kind]);
    assert.equal(request.deadline, NOW + (kind === 'collection' ? 35000 : 15000));
    assert.equal(Object.hasOwn(request, 'uid'), false);
    assert.equal(Object.hasOwn(request, 'env'), false);
    assert.equal(fixture.calls[0].socket.destroyed, true);
  });
});

test('controller snapshot and local process annotation use default socket consumers with mocked HTTP and no launch injection', { skip: process.platform !== 'linux', timeout: 5000 }, async t => {
  const targets = [{ pid: 900101, starttime: 1000 }];
  const fixture = consumerSocket(t, (request, socket) => {
    if (request.args[1] === '--profile') {
      const raw = rawSnapshot(request.args[2], request.args[4]);
      raw.resources.processes = { status: 'ok', content: { samples: [{ processes: targets }] } };
      socket.output('stdout', JSON.stringify(raw));
    } else {
      assert.deepEqual(request.args, ['idc', '--process-action', 'check']);
      assert.deepEqual(JSON.parse(request.stdin), { manager_pid: process.pid, targets });
      socket.output('stdout', JSON.stringify(processReply('check', targets)));
    }
    socket.frame({ code: 0 });
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
    assert.equal(body.raw_snapshot.request_id, body.request_id);
    return { ok: true, text: async () => JSON.stringify({ schema_version: '1.0', request_id: body.request_id,
      task_id: randomUUID(), mode: 'mock', read_only: true, state,
      task: { simulated: false, status: 'completed' } }) };
  });
  let apiClosed = false;
  const controller = await createIdcController({ bundleRoot: path.dirname(fixture.files.binary),
    startMockOpenApi: async () => ({ baseUrl: 'http://fixture.invalid', close: async () => { apiClosed = true; } }),
    scheduler: { now: () => NOW, setTimeout: () => 1, clearTimeout() {} },
  });
  t.after(() => controller.close());
  assert.equal(fixture.calls.length, 0, 'startup verification must not connect');
  const result = await controller.snapshot();
  assert.equal(result.resources.cpu.rows[0].cleanable, true);
  assert.equal(result.resources.cpu.rows[0].defaultSelected, false);
  assert.match(result.resources.cpu.rows[0].effect, /整个进程.*SIGTERM/);
  assert.equal(fixture.calls.length, 2, 'collection and check both use the default socket path');
  assert.equal(httpCalls.length, 1);
  assert.equal(controller.status().last_task.simulated, false);
  assert.deepEqual(await controller.snapshot(), result);
  assert.equal(fixture.calls.length, 2, 'cache reads never reconnect or re-authorize');
  assert(fixture.calls.every(call => call.socket.destroyed));
  await controller.close();
  assert.equal(apiClosed, true);
});

test('default consumers reject unavailable service, UID denial, connection failure/busy without fallback or retry', { timeout: 5000 }, async t => {
  for (const kind of ['collection', 'check', 'terminate']) for (const failure of ['missing auth', 'UID denied', 'connection error', 126, 127, 75, 125]) {
    await t.test(`${kind}: ${failure}`, async t => {
      const fixture = consumerSocket(t, (_request, socket) => {
        if (failure === 'connection error') socket.emit('error', new Error('private socket failure'));
        else socket.frame({ code: failure, error: failure === 75 ? 'ROOT_SERVICE_BUSY' :
          failure === 125 ? 'COLLECTION_TOO_LARGE' : 'ROOT_COLLECTOR_UNAVAILABLE' });
      });
      if (failure === 'missing auth') fixture.files.nodes.delete(AUTH);
      if (failure === 'UID denied') fixture.files.nodes.get(AUTH).content = Buffer.from('1001');
      const pending = kind === 'collection' ? collectRaw(fixture.files.binary, 'resources', randomUUID(), new AbortController().signal,
        { spawnImpl: () => assert.fail('service failures must never spawn'), killGroup: () => assert.fail('socket has no process group') }) :
        runProcessAction(fixture.files.binary, kind, [{ pid: 900101, starttime: 1000 }], { spawnImpl: () => assert.fail('never retry as user') });
      await assert.rejects(pending, error => {
        if (['missing auth', 'UID denied', 'connection error'].includes(failure)) rootFailure(error);
        else if (kind === 'collection') {
          assert.equal(error.code, failure === 75 ? 'ROOT_SERVICE_BUSY' : failure === 125 ? 'COLLECTION_TOO_LARGE' : 'ROOT_COLLECTOR_UNAVAILABLE');
          assert.equal(error.status, failure === 75 ? 503 : failure === 125 ? 413 : 403);
          assert.equal(error.retryable, failure === 75);
        } else assert.match(error.message, failure === 75 ? /服务忙/ : failure === 125 ? /进程操作不可用/ : /服务身份或组件校验失败/);
        assert.doesNotMatch(error.message, /private|pkexec|sudo/);
        return true;
      });
      assert.equal(fixture.calls.length, ['missing auth', 'UID denied'].includes(failure) ? 0 : 1, 'no fallback or retry');
    });
  }
});

test('default collectRaw cancellation/pre-abort/timeout closes socket without PID or production signals', { timeout: 5000 }, async t => {
  for (const cause of ['cancel', 'timeout', 'pre-abort']) await t.test(cause, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const fixture = consumerSocket(t);
    const abort = new AbortController();
    if (cause === 'pre-abort') abort.abort();
    const pending = collectRaw(fixture.files.binary, 'resources', randomUUID(), abort.signal,
      { timeoutMs: 10, killGroup: () => assert.fail('socket request must never signal a process group') });
    const rejected = assert.rejects(pending, error => {
      assert.equal(error.code, cause === 'timeout' ? 'COLLECTION_TIMEOUT' : 'COLLECTION_CANCELLED');
      return true;
    });
    if (cause !== 'pre-abort') {
      await turn();
      assert.equal(fixture.calls.length, 1);
      if (cause === 'cancel') abort.abort();
      else t.mock.timers.tick(10);
    }
    await rejected;
    if (cause === 'pre-abort') assert.equal(fixture.calls.length, 0);
    else assert.equal(fixture.calls[0].socket.destroyed, true);
    t.mock.timers.tick(100000);
    abort.abort();
  });
});
