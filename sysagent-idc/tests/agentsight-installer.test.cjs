'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const installer = path.resolve(__dirname, '../build/install-debs.sh');
const template = fs.readFileSync(installer, 'utf8');
const flag = '--enable-agent-collection';
const pythonPath = '/usr/bin/python3';
const managerPath = '/usr/share/sysom/agentsight-runtime/agentsight-collection.py';

// Only the shell runs for real. Every external installer operation is inert,
// including the ordinary-user sudo transition and the fixed Python executable.
// PATH has no system fallback; no real dpkg, sudo, service, network or trace runs.
const mockCommand = String.raw`#!/usr/bin/python3 -I
import json, os, sys
name = os.path.basename(sys.argv[0])
args = sys.argv[1:]
if name == 'dirname':
    assert len(args) == 2 and args[0] == '--'
    print(os.path.dirname(args[1]))
    sys.exit(0)
with open(os.environ['FIXTURE_LOG'], 'a', encoding='utf-8') as stream:
    stream.write(json.dumps({'command': name, 'args': args}) + '\n')
if name == 'id':
    assert args == ['-u']
    print(os.environ['FIXTURE_UID'])
elif name == 'sudo':
    assert len(args) >= 2 and args[0] == 'sh'
    assert args[1] == os.environ['FIXTURE_INSTALLER']
    env = dict(os.environ)
    env['SUDO_UID'] = env['FIXTURE_UID']
    env['FIXTURE_UID'] = '0'
    os.execve(os.path.join(env['PATH'], 'sh'), args, env)
elif name == 'dpkg':
    assert args == ['--install', *json.loads(os.environ['FIXTURE_PACKAGES'])]
    sys.exit(int(os.environ['FIXTURE_DPKG_EXIT']))
elif name == 'python3':
    assert len(args) == 6
    assert args[:4] == ['-I', os.environ['FIXTURE_MANAGER'], 'enable', '--uid']
    assert args[5:] == ['--accept-host-capture']
    sys.exit(int(os.environ['FIXTURE_MANAGER_EXIT']))
else:
    raise AssertionError('unexpected installer executable')
`;

const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`;

function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsight installer 惰性 '));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const bin = path.join(directory, 'bin');
  const configDirectory = path.join(directory, 'home', '.config', 'sysagent-idc');
  fs.mkdirSync(bin);
  fs.mkdirSync(configDirectory, { recursive: true });
  const installPath = path.join(directory, 'install-debs.sh');
  const manager = path.join(directory, 'inert-collection.py');
  const python = path.join(bin, 'python3');
  const log = path.join(directory, 'operations.jsonl');
  const packages = [
    path.join(directory, 'gx_0.0-fixture_amd64.deb'),
    path.join(directory, 'sysom-agentsight-runtime_0.0-fixture_amd64.deb'),
    path.join(directory, 'sysagent-idc_0.0-fixture_amd64.deb'),
  ];
  assert.equal(template.split(pythonPath).length, 2, 'replace exactly the fixed installer interpreter');
  assert.equal(template.split(managerPath).length, 2, 'replace exactly the fixed collection manager');
  fs.writeFileSync(installPath, template
    .replace(pythonPath, shellQuote(python))
    .replace(managerPath, shellQuote(manager))
    .replaceAll('@AGENTSIGHT_VERSION@', '0.0-fixture')
    .replaceAll('@SYSOM_VERSION@', '0.0-fixture')
    .replaceAll('@GX_VERSION@', '0.0-fixture'));
  fs.writeFileSync(manager, '# Inert path argument; never executed.\n');
  fs.writeFileSync(log, '');
  for (const filename of packages) fs.writeFileSync(filename, 'inert local deb fixture');
  for (const name of ['id', 'dirname', 'sudo', 'dpkg', 'python3']) {
    fs.writeFileSync(path.join(bin, name), mockCommand, { mode: 0o755 });
  }
  fs.symlinkSync('/bin/sh', path.join(bin, 'sh'));
  const configs = [path.join(configDirectory, 'config.json'), path.join(directory, 'config.json')];
  const snapshots = configs.map(filename => {
    fs.writeFileSync(filename, '{"fixture":"preexisting user settings"}\n', { mode: 0o600 });
    return { filename, bytes: fs.readFileSync(filename), stat: fs.statSync(filename) };
  });
  const env = {
    PATH: bin,
    LANG: 'C.UTF-8',
    HOME: path.join(directory, 'home'),
    XDG_CONFIG_HOME: path.dirname(configDirectory),
    FIXTURE_LOG: log,
    FIXTURE_UID: options.ordinary ? '1000' : '0',
    FIXTURE_INSTALLER: installPath,
    FIXTURE_MANAGER: manager,
    FIXTURE_PACKAGES: JSON.stringify(packages),
    FIXTURE_DPKG_EXIT: String(options.dpkgExit ?? 0),
    FIXTURE_MANAGER_EXIT: String(options.managerExit ?? 0),
    ...options.env,
  };
  return {
    installPath, manager, packages,
    run(args = []) {
      const result = spawnSync('/bin/sh', [installPath, ...args], { env, encoding: 'utf8', timeout: 15000 });
      const events = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
      assert.equal(result.error, undefined, JSON.stringify({ args, ordinary: !!options.ordinary, events, error: result.error?.message }));
      assert.equal(result.signal, null, result.stderr);
      for (const { filename, bytes, stat } of snapshots) {
        assert.deepEqual(fs.readFileSync(filename), bytes, 'synthetic existing config content is untouched');
        const after = fs.statSync(filename);
        for (const field of ['ino', 'mode', 'size', 'mtimeMs', 'ctimeMs']) {
          assert.equal(after[field], stat[field], `synthetic existing config ${field} is untouched`);
        }
      }
      return { ...result, events };
    },
  };
}

function assertInstalled(f, result, { ordinary = false, uid } = {}) {
  const commands = ordinary ? ['id', 'sudo', 'id', 'dpkg'] : ['id', 'dpkg'];
  if (uid !== undefined) commands.push('python3');
  assert.deepEqual(result.events.map(event => event.command), commands, result.stderr);
  const dpkg = result.events.find(event => event.command === 'dpkg');
  assert.deepEqual(dpkg.args, ['--install', ...f.packages], 'GX, runtime and main local packages installed together, in order');
  if (uid !== undefined) {
    assert.deepEqual(result.events.at(-1).args, ['-I', f.manager, 'enable', '--uid', uid, '--accept-host-capture']);
  }
}

test('offline installer: default installs all three local debs without enrollment or config changes', t => {
  const f = fixture(t, { env: { SYSOM_IDC_UID: '0', SUDO_UID: 'not-a-uid' } });
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assertInstalled(f, result);
});

test('offline installer: explicit opt-in passes isolation, positive UID and host-capture consent', t => {
  for (const [env, uid] of [
    [{ SUDO_UID: '1000' }, '1000'],
    [{ SYSOM_IDC_UID: '2000', SUDO_UID: '1000' }, '2000'],
    [{ SYSOM_IDC_UID: '1' }, '1'],
  ]) {
    const f = fixture(t, { env });
    const result = f.run([flag]);
    assert.equal(result.status, 0, result.stderr);
    assertInstalled(f, result, { uid });
  }
});

test('offline installer: ordinary-to-sudo transition preserves default and opt-in arguments', t => {
  for (const args of [[], [flag]]) {
    const f = fixture(t, { ordinary: true });
    const result = f.run(args);
    assert.equal(result.status, 0, result.stderr);
    assertInstalled(f, result, { ordinary: true, uid: args.length ? '1000' : undefined });
    assert.deepEqual(result.events[1].args, ['sh', f.installPath, ...args]);
  }
});

test('offline installer: malformed arguments fail before sudo, dpkg or enrollment', t => {
  const malformed = [
    [''], ['--unknown'], ['--accept-host-capture'], ['--enable-agent-collection=true'],
    [flag, flag], [flag, ''], [flag, '--uid', '1000'], [flag, '--accept-host-capture'],
    ['', flag], [flag, '; harmless fixture'],
  ];
  for (const ordinary of [false, true]) {
    for (const args of malformed) {
      const f = fixture(t, { ordinary, env: { SYSOM_IDC_UID: '1000' } });
      const result = f.run(args);
      assert.equal(result.status, 2, `${JSON.stringify(args)}: ${result.stderr}`);
      assert.deepEqual(result.events, [], 'invalid arguments must fail before any external installer operation');
    }
  }
});

test('offline installer: missing or malformed UID cannot enroll or install packages', t => {
  const malformed = ['', '0', '-1', '+1000', '1.5', ' 1000', '1000 ', '1000\n', '1000; inert', '$(inert)', '١٠٠٠', '１０００'];
  for (const value of malformed) {
    for (const env of [{ SYSOM_IDC_UID: value, SUDO_UID: '1000' }, { SUDO_UID: value }]) {
      const f = fixture(t, { env });
      const result = f.run([flag]);
      assert.equal(result.status, 2, `UID ${JSON.stringify(value)}: ${result.stderr}`);
      assert.deepEqual(result.events.map(event => event.command), ['id'], 'reject before dpkg and collection manager');
    }
  }
  const f = fixture(t);
  const result = f.run([flag]);
  assert.equal(result.status, 2, result.stderr);
  assert.deepEqual(result.events.map(event => event.command), ['id']);
});

test('offline installer: an all-zero UID is not a positive enrollment UID', t => {
  for (const value of ['00', '000']) {
    for (const env of [{ SYSOM_IDC_UID: value }, { SUDO_UID: value }]) {
      const f = fixture(t, { env });
      const result = f.run([flag]);
      assert.equal(result.status, 2, `UID ${JSON.stringify(value)}: ${result.stderr}`);
      assert.deepEqual(result.events.map(event => event.command), ['id'], 'zero must fail before installation or enrollment');
    }
  }
});

test('offline installer: dpkg failure propagates and prevents enrollment', t => {
  for (const ordinary of [false, true]) {
    for (const args of [[], [flag]]) {
      const f = fixture(t, { ordinary, dpkgExit: 73, env: { SYSOM_IDC_UID: '1000' } });
      const result = f.run(args);
      assert.equal(result.status, 73, result.stderr);
      assertInstalled(f, result, { ordinary });
    }
  }
});

test('offline installer: root collection manager failure is not reported as success', t => {
  for (const ordinary of [false, true]) {
    for (const managerExit of [1, 42, 126]) {
      const f = fixture(t, { ordinary, managerExit, env: { SYSOM_IDC_UID: '1000' } });
      const result = f.run([flag]);
      assert.equal(result.status, managerExit, result.stderr);
      assertInstalled(f, result, { ordinary, uid: '1000' });
    }
  }
});
