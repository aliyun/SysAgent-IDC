import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync,
  readdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseArgs } from './build.mjs';

const scripts = dirname(fileURLToPath(import.meta.url));
const project = resolve(scripts, '..');
const VERSION = '0.2.17';
const RUNTIME_VERSION = '0.16.0';
const GX_VERSION = '0.6.5-2';
const GX_FILENAME = `gx_${GX_VERSION}_amd64.deb`;
const GX_DEB = Buffer.from('!<arch>\ninert bundled GX fixture; never install or execute\n');
const LEGAL = ['LICENSE', 'THIRD_PARTY_NOTICES', 'FONT_LICENSE'];
const CI = ['ci', '--include=dev', '--no-audit', '--no-fund'];
const SUCCESS = /构建完成|构建成功|\b(?:success(?:ful(?:ly)?)?|succeeded)\b|\b(?:build|built)[^\n]*complet/i;
const nativeOptions = {
  skip: process.platform !== 'linux' || process.arch !== 'x64' || Number(process.versions.node.split('.')[0]) < 20,
};
const sha256 = data => createHash('sha256').update(data).digest('hex');

// Native and host commands remain blocked if orchestration changes.
const childGuard = String.raw`
const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const root = process.env.SYSAGENT_BUILD_TEST_ROOT;
const log = event => fs.appendFileSync(process.env.SYSAGENT_BUILD_TEST_LOG, JSON.stringify(event) + '\n');
const allowed = new Set(['scripts/sync-versions.mjs', 'mock npm ; no shell.cjs'].map(name => path.join(root, name)));
function check(command, args, options = {}) {
  log({ kind: 'child', command, args, cwd: options.cwd || process.cwd(), shell: options.shell === undefined ? null : options.shell });
  if (command !== process.execPath || !Array.isArray(args) || !allowed.has(args[0]) || options.shell) {
    log({ kind: 'forbidden-child', command, args });
    throw new Error('Fixture forbids shell, root, service, installer or external command invocation');
  }
  if (args[0] === path.join(root, 'mock npm ; no shell.cjs') && options.shell !== false) {
    throw new Error('npm must use process.execPath and explicit shell: false');
  }
}
for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync']) {
  const original = cp[name];
  cp[name] = function(command, args, options, ...rest) {
    check(command, args, options);
    return original.call(this, command, args, options, ...rest);
  };
}
for (const name of ['exec', 'execSync', 'fork']) {
  cp[name] = function(...args) {
    log({ kind: 'forbidden-child', command: name, args });
    throw new Error('Fixture forbids ' + name);
  };
}
require('node:module').syncBuiltinESMExports();
`;

const mockNpm = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const folder = path.basename(process.cwd());
fs.appendFileSync(process.env.SYSAGENT_BUILD_TEST_LOG, JSON.stringify({ kind: 'npm', folder, args, execPath: process.execPath }) + '\n');
if (process.env.SYSAGENT_BUILD_TEST_FAILURE === folder + ':' + args.join(' ')) process.exit(7);
function write(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
}
if (args[0] === 'ci') {
  fs.mkdirSync('node_modules', { recursive: true });
} else if (folder === 'sysagent-idc' && ['run build', 'run build:deb'].includes(args.join(' '))) {
  fs.rmSync('dist', { recursive: true, force: true });
  write('dist/index.html', '<html>fixture web build</html>');
  if (args.join(' ') === 'run build:deb' && process.env.SYSAGENT_BUILD_TEST_OMIT !== 'desktop') {
    const version = JSON.parse(fs.readFileSync('package.json', 'utf8')).version;
    write('release/sysagent-idc_' + version + '_amd64.deb', 'fixture desktop deb ' + version + '\n');
  }
} else if (folder === 'sysagent-ide-extension' && args.join(' ') === 'run package') {
  if (process.env.SYSAGENT_BUILD_TEST_OMIT !== 'ide') {
    const version = JSON.parse(fs.readFileSync('package.json', 'utf8')).version;
    write('release/sysagent-ide-' + version + '.vsix', 'fixture VSIX ' + version + '\n');
  }
} else {
  throw new Error('Unexpected mock npm command: ' + folder + ':' + args.join(' '));
}
`;

const sysakStub = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const log = event => fs.appendFileSync(process.env.SYSAGENT_BUILD_TEST_LOG, JSON.stringify(event) + '\n');
module.exports = {
  verifyBundle(bundle) {
    log({ kind: 'verify-sysak', bundle });
    if (bundle !== path.join(process.env.SYSAGENT_BUILD_TEST_ROOT, 'sysagent-idc/resources/sysak')) throw new Error('Wrong bundled SysAK path');
    const manifest = JSON.parse(fs.readFileSync(path.join(bundle, 'manifest.json'), 'utf8'));
    const binary = fs.readFileSync(path.join(bundle, 'sysak'));
    if (crypto.createHash('sha256').update(binary).digest('hex') !== manifest.sha256) throw new Error('SysAK checksum mismatch');
    log({ kind: 'verified-sysak' });
    return manifest;
  },
  prepareBundle(source) {
    log({ kind: 'prepare-sysak', source });
    if (source !== path.join(process.env.SYSAGENT_BUILD_TEST_ROOT, 'vendor/sysak/linux-x64')) throw new Error('Wrong SysAK source path');
    const manifest = JSON.parse(fs.readFileSync(path.join(source, 'manifest.json'), 'utf8'));
    if (crypto.createHash('sha256').update(fs.readFileSync(path.join(source, 'sysak'))).digest('hex') !== manifest.sha256) throw new Error('SysAK checksum mismatch');
    fs.cpSync(source, path.join(process.env.SYSAGENT_BUILD_TEST_ROOT, 'sysagent-idc/resources/sysak'), { recursive: true });
  }
};
`;

const agentSightStub = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const log = event => fs.appendFileSync(process.env.SYSAGENT_BUILD_TEST_LOG, JSON.stringify(event) + '\n');
module.exports = {
  async verifyAgentSightPackage(vendor) {
    log({ kind: 'verify-agentsight', vendor });
    // Resolve asynchronously so forgetting to await verification cannot pass.
    await new Promise(resolve => setImmediate(resolve));
    if (vendor !== path.join(process.env.SYSAGENT_BUILD_TEST_ROOT, 'vendor/agentsight/linux-x64')) throw new Error('Wrong bundled AgentSight path');
    const manifest = JSON.parse(fs.readFileSync(path.join(vendor, 'manifest.json'), 'utf8'));
    const binary = path.join(vendor, 'agentsight');
    if (crypto.createHash('sha256').update(fs.readFileSync(binary)).digest('hex') !== manifest.sha256) throw new Error('AgentSight checksum mismatch');
    log({ kind: 'verified-agentsight', version: manifest.version });
    return { binary, manifest };
  },
  prepareAgentSight() { log({ kind: 'forbidden-native' }); throw new Error('Build must not deploy AgentSight'); }
};
`;

const gxStub = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const log = event => fs.appendFileSync(process.env.SYSAGENT_BUILD_TEST_LOG, JSON.stringify(event) + '\n');
module.exports = {
  verifyGxPackage(vendor) {
    log({ kind: 'verify-gx', vendor });
    if (vendor !== path.join(process.env.SYSAGENT_BUILD_TEST_ROOT, 'vendor/gx/linux-x64')) throw new Error('Wrong bundled GX path');
    const manifest = JSON.parse(fs.readFileSync(path.join(vendor, 'manifest.json'), 'utf8'));
    const binary = path.join(vendor, 'gx_0.6.5-2_amd64.deb');
    if (crypto.createHash('sha256').update(fs.readFileSync(binary)).digest('hex') !== manifest.sha256) throw new Error('GX checksum mismatch');
    log({ kind: 'verified-gx', version: manifest.version });
    return { binary, manifest };
  }
};
`;

const packageStub = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const log = event => fs.appendFileSync(process.env.SYSAGENT_BUILD_TEST_LOG, JSON.stringify(event) + '\n');
const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
module.exports = {
  async packageAgentSight({ binary, license, output, version }) {
    log({ kind: 'package-runtime', binary, license, output, version });
    if (process.env.SYSAGENT_BUILD_TEST_FAILURE === 'package-runtime') throw new Error('Fixture runtime packaging failure');
    if (![binary, license, output].every(value => typeof value === 'string' && path.isAbsolute(value))) throw new Error('Runtime helper needs absolute paths');
    if (version !== '0.16.0') throw new Error('Wrong runtime packaging version');
    fs.mkdirSync(output, { mode: 0o700 });
    fs.copyFileSync(binary, path.join(output, 'agentsight'));
    fs.copyFileSync(license, path.join(output, 'LICENSE'));
    const sha256 = digest(binary);
    fs.writeFileSync(path.join(output, 'manifest.json'), JSON.stringify({ version, sha256 }));
    fs.writeFileSync(path.join(output, 'agentsight-deployment.cjs'), 'module.exports = {};');
    fs.writeFileSync(path.join(output, 'install.cjs'), 'process.exitCode = 0;');
    return { sha256, version };
  },
  async packageAgentSightDeb({ directory, output }) {
    log({ kind: 'package-runtime-deb', directory, output });
    if (process.env.SYSAGENT_BUILD_TEST_FAILURE === 'package-runtime-deb') throw new Error('Fixture runtime deb failure');
    if (!path.isAbsolute(directory) || !path.isAbsolute(output) || !output.endsWith('.deb')) throw new Error('Runtime deb helper needs absolute paths');
    const { version } = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
    fs.readFileSync(path.join(directory, 'LICENSE'));
    if (process.env.SYSAGENT_BUILD_TEST_OMIT !== 'runtime') fs.writeFileSync(output, 'fixture AgentSight runtime deb ' + version + '\n', { flag: 'wx' });
    return { version, sha256: process.env.SYSAGENT_BUILD_TEST_OMIT === 'runtime' ? '0'.repeat(64) : digest(output) };
  }
};
`;

function write(root, name, contents) {
  const file = resolve(root, name);
  const within = relative(root, file);
  assert.ok(within !== '..' && !within.startsWith(`..${sep}`) && !isAbsolute(within), 'Fixture files must stay under their temporary root');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, contents);
}

function updateJson(root, name, change) {
  const file = resolve(root, name);
  const data = JSON.parse(readFileSync(file, 'utf8'));
  change(data);
  writeFileSync(file, JSON.stringify(data));
}

function snapshot(root) {
  const entries = [];
  function walk(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = resolve(directory, entry.name);
      const name = relative(root, file);
      if (entry.isDirectory()) {
        entries.push([name, 'directory', statSync(file).mode]);
        walk(file);
      } else {
        entries.push([name, sha256(readFileSync(file)), statSync(file).mode]);
      }
    }
  }
  walk(root);
  return entries;
}

function fixture(t) {
  // Spaces and a shell metacharacter exercise npm_execpath argument safety.
  const root = mkdtempSync(resolve(tmpdir(), 'sysagent build ; fixture-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(resolve(root, 'scripts'));
  copyFileSync(resolve(scripts, 'build.mjs'), resolve(root, 'scripts/build.mjs'));
  const versionCheck = readFileSync(resolve(scripts, 'sync-versions.mjs'), 'utf8');
  write(root, 'scripts/sync-versions.mjs', `import { appendFileSync as testAppend } from 'node:fs';\nconst testArgs = process.argv.slice(2);\ntestAppend(process.env.SYSAGENT_BUILD_TEST_LOG, JSON.stringify({ kind: 'versions', args: testArgs }) + '\\n');\nif (JSON.stringify(testArgs) !== JSON.stringify(['--check'])) throw new Error('Build must check versions without rewriting them');\n${versionCheck}`);
  write(root, 'package.json', JSON.stringify({ name: 'sysagent-build-fixture', version: VERSION, type: 'module' }));
  write(root, 'package-lock.json', JSON.stringify({ version: VERSION, packages: { '': { version: VERSION } } }));
  for (const folder of ['sysagent-idc', 'sysagent-ide-extension']) {
    write(root, `${folder}/package.json`, JSON.stringify({
      name: folder, version: VERSION,
      ...(folder === 'sysagent-idc' ? { build: { deb: { depends: [`sysom-agentsight-runtime (= ${RUNTIME_VERSION})`, `gx (= ${GX_VERSION})`, 'python3'] } } } : {}),
    }));
    write(root, `${folder}/package-lock.json`, JSON.stringify({ version: VERSION, packages: { '': { version: VERSION } } }));
  }
  for (const name of LEGAL) {
    for (const folder of ['', 'sysagent-idc', 'sysagent-ide-extension']) write(root, folder ? `${folder}/${name}` : name, `fixture ${name}\n`);
  }
  write(root, 'sysagent-idc/scripts/prepare-sysak.cjs', sysakStub);
  write(root, 'sysagent-idc/electron/agentsight-deployment.cjs', agentSightStub);
  write(root, 'sysagent-idc/scripts/package-agentsight.cjs', packageStub);
  write(root, 'scripts/gx-package.cjs', gxStub);
  write(root, `vendor/gx/linux-x64/${GX_FILENAME}`, GX_DEB);
  write(root, 'vendor/gx/linux-x64/manifest.json', JSON.stringify({
    schema_version: '1.0', platform: 'linux', arch: 'x64', package: 'gx',
    version: GX_VERSION, filename: GX_FILENAME, sha256: sha256(GX_DEB),
  }));
  const sysak = Buffer.from('inert bundled SysAK fixture\n');
  write(root, 'vendor/sysak/linux-x64/sysak', sysak);
  write(root, 'vendor/sysak/linux-x64/manifest.json', JSON.stringify({ version: 'fixture', sha256: sha256(sysak) }));
  const binary = Buffer.from('inert bundled AgentSight fixture\n');
  write(root, 'vendor/agentsight/linux-x64/agentsight', binary);
  write(root, 'vendor/agentsight/linux-x64/manifest.json', JSON.stringify({ version: RUNTIME_VERSION, sha256: sha256(binary) }));
  write(root, 'vendor/agentsight/linux-x64/LICENSE', 'fixture AgentSight license\n');
  mkdirSync(resolve(root, 'sysagent-idc/build'), { recursive: true });
  copyFileSync(resolve(project, 'sysagent-idc/build/install-debs.sh'), resolve(root, 'sysagent-idc/build/install-debs.sh'));
  // Old accepted batches and unrelated output must never be selected/rewritten.
  const latest = resolve(root, `sysagent-idc/release/idc-${VERSION}-sysagent-20261113`);
  write(latest, `sysagent-idc_${VERSION}_amd64.deb`, 'old accepted desktop artifact\n');
  write(latest, 'install-debs.sh', 'old accepted installer\n');
  write(latest, 'agentsight-runtime/manifest.json', '{"accepted":true}\n');
  write(root, 'release/latest/keep.txt', 'do not overwrite the latest batch\n');
  write(root, 'child-guard.cjs', childGuard);
  write(root, 'mock npm ; no shell.cjs', mockNpm);
  mkdirSync(resolve(root, 'home'));
  mkdirSync(resolve(root, 'tmp'));
  mkdirSync(resolve(root, 'bin'));
  const log = resolve(root, 'events.jsonl');
  // Do not inherit native overrides, credentials or preload hooks.
  const env = {
    PATH: resolve(root, 'bin'),
    HOME: resolve(root, 'home'),
    XDG_CONFIG_HOME: resolve(root, 'home/config'),
    XDG_DATA_HOME: resolve(root, 'home/data'),
    TMPDIR: resolve(root, 'tmp'),
    LANG: 'C.UTF-8',
    npm_execpath: resolve(root, 'mock npm ; no shell.cjs'),
    NODE_OPTIONS: `--require=${JSON.stringify(resolve(root, 'child-guard.cjs'))}`,
    SYSAGENT_BUILD_TEST_ROOT: root,
    SYSAGENT_BUILD_TEST_LOG: log,
  };
  const latestBefore = snapshot(latest);
  return {
    root, latest, env,
    execute(args = [], extra = {}) {
      return spawnSync(process.execPath, [resolve(root, 'scripts/build.mjs'), ...args], {
        cwd: root, env: { ...env, ...extra }, encoding: 'utf8', timeout: 15_000, maxBuffer: 1024 * 1024,
      });
    },
    events() {
      return existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
    },
    calls() {
      return this.events().filter(event => event.kind === 'npm').map(({ folder, args }) => ({ folder, args }));
    },
    assertLatestUnchanged() {
      assert.deepEqual(snapshot(latest), latestBefore);
      assert.equal(readFileSync(resolve(root, 'release/latest/keep.txt'), 'utf8'), 'do not overwrite the latest batch\n');
    },
  };
}

function succeeded(result) {
  assert.ifError(result.error);
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.status, 0, result.stdout + result.stderr);
}

function failed(result) {
  assert.ifError(result.error);
  assert.equal(result.signal, null, result.stderr);
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.doesNotMatch(result.stdout, SUCCESS);
}

function assertPreflight(f, { native = false, runtime = false, gx = false } = {}) {
  const events = f.events();
  const versions = events.findIndex(event => event.kind === 'versions');
  const firstNpm = events.findIndex(event => event.kind === 'npm');
  assert.notEqual(versions, -1, 'sync-versions --check must run');
  assert.deepEqual(events[versions].args, ['--check']);
  if (firstNpm !== -1) assert.ok(versions < firstNpm, 'Version preflight must precede npm');
  for (const [required, kind, start] of [
    [native, 'verified-sysak', 'verify-sysak'],
    [runtime, 'verified-agentsight', 'verify-agentsight'],
    [gx, 'verified-gx', 'verify-gx'],
  ]) {
    const index = events.findIndex(event => event.kind === kind);
    if (required) {
      assert.notEqual(index, -1, `${kind} must finish`);
      if (firstNpm !== -1) assert.ok(index < firstNpm, `${kind} must finish before npm`);
    } else {
      assert.equal(index, -1, `${kind} is not needed for this target`);
      assert.equal(events.some(event => event.kind === start), false, `${start} must not run for this target`);
    }
  }
  assert.equal(events.some(event => /^forbidden-/.test(event.kind)), false);
  for (const event of events.filter(event => event.kind === 'child')) {
    assert.equal(event.command, process.execPath);
    if (event.args[0] === f.env.npm_execpath) assert.equal(event.shell, false);
  }
}

function assertLegal(directory) {
  for (const name of LEGAL) assert.equal(readFileSync(resolve(directory, name), 'utf8'), `fixture ${name}\n`);
}

function assertChecksums(directory, artifacts) {
  const entries = readFileSync(resolve(directory, 'SHA256SUMS'), 'utf8').trim().split('\n');
  const seen = new Set();
  for (const line of entries) {
    const match = /^([a-f0-9]{64})\s+\*?(.+)$/.exec(line);
    assert.ok(match, `Invalid SHA256SUMS line: ${line}`);
    const [, digest, name] = match;
    assert.equal(isAbsolute(name), false, 'Checksums must be portable');
    const file = resolve(directory, name);
    const within = relative(directory, file);
    assert.ok(within !== '..' && !within.startsWith(`..${sep}`) && !isAbsolute(within), 'Checksum must refer to this build directory');
    assert.equal(seen.has(name), false, `Duplicate checksum: ${name}`);
    seen.add(name);
    assert.equal(digest, sha256(readFileSync(file)), `Checksum does not match ${name}`);
  }
  for (const name of artifacts) assert.ok(seen.has(name), `Missing checksum for ${name}`);
}

function assertNativeArtifacts(f, { desktop, ide }) {
  const output = resolve(f.root, `release/build-${VERSION}`);
  const artifacts = [];
  if (desktop) {
    const desktopName = `sysagent-idc_${VERSION}_amd64.deb`;
    const runtimeName = `sysom-agentsight-runtime_${RUNTIME_VERSION}_amd64.deb`;
    artifacts.push(desktopName, runtimeName, GX_FILENAME, 'install-debs.sh');
    assert.equal(readFileSync(resolve(output, desktopName), 'utf8'), `fixture desktop deb ${VERSION}\n`);
    assert.equal(readFileSync(resolve(output, runtimeName), 'utf8'), `fixture AgentSight runtime deb ${RUNTIME_VERSION}\n`);
    assert.deepEqual(readFileSync(resolve(output, GX_FILENAME)), GX_DEB, 'Copy the verified GX bytes under the official filename');
    assert.deepEqual(readFileSync(resolve(f.root, 'vendor/gx/linux-x64', GX_FILENAME)), GX_DEB, 'Do not alter the vendored GX input');
    assert.equal(f.events().find(event => event.kind === 'verify-gx').vendor, resolve(f.root, 'vendor/gx/linux-x64'));
    assert.equal(f.events().find(event => event.kind === 'verified-gx').version, GX_VERSION);
    const installer = readFileSync(resolve(output, 'install-debs.sh'), 'utf8');
    assert.doesNotMatch(installer, /@(?:AGENTSIGHT_VERSION|SYSOM_VERSION|GX_VERSION)@/);
    const template = readFileSync(resolve(f.root, 'sysagent-idc/build/install-debs.sh'), 'utf8');
    assert.ok(template.includes('@GX_VERSION@'), 'Exercise GX installer placeholder replacement');
    assert.equal(installer, template.replaceAll('@AGENTSIGHT_VERSION@', RUNTIME_VERSION)
      .replaceAll('@SYSOM_VERSION@', VERSION).replaceAll('@GX_VERSION@', GX_VERSION));
    assert.ok(installer.includes(desktopName));
    assert.ok(installer.includes(runtimeName));
    assert.ok(installer.includes(GX_FILENAME));
    const runtime = f.events().find(event => event.kind === 'package-runtime');
    const deb = f.events().find(event => event.kind === 'package-runtime-deb');
    assert.ok(runtime && deb, 'Use both exported runtime packaging helpers');
    assert.equal(runtime.binary, resolve(f.root, 'vendor/agentsight/linux-x64/agentsight'));
    assert.equal(runtime.license, resolve(f.root, 'vendor/agentsight/linux-x64/LICENSE'));
    assert.equal(runtime.version, RUNTIME_VERSION);
    assert.equal(deb.directory, runtime.output);
    assert.ok(runtime.output.startsWith(resolve(f.root, 'release/.runtime-build-')), 'Runtime staging belongs in its own temporary directory');
    assert.equal(existsSync(runtime.output), false, 'Clean up runtime temporary staging');
    assert.equal(readFileSync(resolve(f.root, 'vendor/agentsight/linux-x64/agentsight'), 'utf8'), 'inert bundled AgentSight fixture\n');
  } else {
    assert.equal(f.events().some(event => event.kind.startsWith('package-runtime')), false);
    assert.equal(existsSync(resolve(output, `sysagent-idc_${VERSION}_amd64.deb`)), false);
    assert.equal(existsSync(resolve(output, `sysom-agentsight-runtime_${RUNTIME_VERSION}_amd64.deb`)), false);
    assert.equal(existsSync(resolve(output, GX_FILENAME)), false);
    assert.equal(existsSync(resolve(output, 'install-debs.sh')), false);
  }
  if (ide) {
    const name = `sysagent-ide-${VERSION}.vsix`;
    artifacts.push(name);
    assert.equal(readFileSync(resolve(output, name), 'utf8'), `fixture VSIX ${VERSION}\n`);
  } else {
    assert.equal(existsSync(resolve(output, `sysagent-ide-${VERSION}.vsix`)), false);
  }
  assertLegal(resolve(f.root, 'sysagent-idc/dist'));
  assertLegal(output);
  assertChecksums(output, artifacts);
  f.assertLatestUnchanged();
}

test('parseArgs defaults to all and accepts every target and supported flag', () => {
  assert.deepEqual(parseArgs([]), { target: 'all', skipInstall: false, help: false });
  for (const target of ['all', 'desktop', 'ide', 'web']) {
    assert.deepEqual(parseArgs(['--target', target]), { target, skipInstall: false, help: false });
    assert.deepEqual(parseArgs(['--skip-install', '--target', target]), { target, skipInstall: true, help: false });
  }
  for (const flag of ['--help', '-h']) assert.deepEqual(parseArgs([flag]), { target: 'all', skipInstall: false, help: true });
  assert.deepEqual(parseArgs(['--target', 'desktop', '--skip-install', '--help']), { target: 'desktop', skipInstall: true, help: true });
});

test('parseArgs rejects unknown, duplicate, missing and invalid arguments', () => {
  for (const args of [
    ['--invalid'], ['web'], ['--sysak-source', '/unused'], ['--target'],
    ['--target', '--skip-install'], ['--target', '--help'], ['--target', ''],
    ['--target', 'unknown'], ['--target', 'ALL'], ['--target=web'],
    ['--target', 'web', '--target', 'ide'], ['--target', 'all', '--target', 'all'],
    ['--skip-install', '--skip-install'], ['--help', '--help'], ['-h', '-h'], ['--help', '-h'],
  ]) assert.throws(() => parseArgs(args), undefined, JSON.stringify(args));
});

test('help has no version, npm, native preparation, packaging or filesystem side effects', t => {
  for (const flag of ['--help', '-h']) {
    const f = fixture(t);
    rmSync(resolve(f.root, 'vendor/sysak/linux-x64'), { recursive: true });
    rmSync(resolve(f.root, 'vendor'), { recursive: true });
    updateJson(f.root, 'sysagent-ide-extension/package.json', data => { data.version = '0.0.1'; });
    const before = snapshot(f.root);
    const result = f.execute([flag]);
    succeeded(result);
    for (const option of ['--target', '--skip-install', 'all', 'desktop', 'ide', 'web']) assert.ok(result.stdout.includes(option));
    assert.deepEqual(f.events(), []);
    assert.deepEqual(snapshot(f.root), before);
  }
});

test('invalid CLI exits before preflight, npm or artifact generation', t => {
  const f = fixture(t);
  const before = snapshot(f.root);
  failed(f.execute(['--target', 'invalid']));
  assert.deepEqual(f.events(), []);
  assert.deepEqual(snapshot(f.root), before);
});

test('fresh web installs only web dependencies with ignore-scripts and copies legal files', t => {
  const f = fixture(t);
  // Web must not require native bundles or AgentSight/GX dependency pins.
  rmSync(resolve(f.root, 'vendor/sysak/linux-x64'), { recursive: true });
  rmSync(resolve(f.root, 'vendor'), { recursive: true });
  updateJson(f.root, 'sysagent-idc/package.json', data => { data.build.deb.depends = []; });
  succeeded(f.execute(['--target', 'web']));
  assert.deepEqual(f.calls(), [
    { folder: 'sysagent-idc', args: [...CI, '--ignore-scripts'] },
    { folder: 'sysagent-idc', args: ['run', 'build'] },
  ]);
  assertPreflight(f);
  assertLegal(resolve(f.root, 'sysagent-idc/dist'));
  assert.equal(existsSync(resolve(f.root, 'sysagent-ide-extension/node_modules')), false);
  assert.equal(f.events().some(event => /^(?:load|verify|package)-(?:sysak|agentsight|runtime|gx)/.test(event.kind)), false);
  f.assertLatestUnchanged();
});

test('web skip-install reuses existing node_modules and never reinstalls', t => {
  const f = fixture(t);
  mkdirSync(resolve(f.root, 'sysagent-idc/node_modules'));
  succeeded(f.execute(['--target', 'web', '--skip-install']));
  assert.deepEqual(f.calls(), [{ folder: 'sysagent-idc', args: ['run', 'build'] }]);
  assertPreflight(f);
  assertLegal(resolve(f.root, 'sysagent-idc/dist'));
});

test('skip-install on a fresh web checkout fails before invoking npm', t => {
  const f = fixture(t);
  const result = f.execute(['--target', 'web', '--skip-install']);
  failed(result);
  assert.match(result.stderr, /node_modules|--skip-install/);
  assert.deepEqual(f.calls(), []);
  assert.equal(existsSync(resolve(f.root, 'sysagent-idc/dist')), false);
});

test('version mismatches in either package or lock root fail before npm without rewriting', async t => {
  for (const folder of ['sysagent-idc', 'sysagent-ide-extension']) {
    for (const file of ['package.json', 'package-lock.json']) {
      await t.test(`${folder}/${file}`, t => {
        const f = fixture(t);
        updateJson(f.root, `${folder}/${file}`, data => { data.version = '0.0.1'; });
        const before = readFileSync(resolve(f.root, `${folder}/${file}`), 'utf8');
        failed(f.execute(['--target', 'web']));
        assert.deepEqual(f.calls(), []);
        assert.equal(readFileSync(resolve(f.root, `${folder}/${file}`), 'utf8'), before);
        assert.equal(existsSync(resolve(f.root, 'sysagent-idc/dist')), false);
      });
    }
    await t.test(`${folder}/package-lock.json packages['']`, t => {
      const f = fixture(t);
      updateJson(f.root, `${folder}/package-lock.json`, data => { data.packages[''].version = '0.0.1'; });
      failed(f.execute(['--target', 'web']));
      assert.deepEqual(f.calls(), []);
    });
  }
});

test('web install and build failures are nonzero and never emit success or copied legal files', t => {
  for (const failure of [[...CI, '--ignore-scripts'].join(' '), 'run build']) {
    const f = fixture(t);
    const result = f.execute(['--target', 'web'], { SYSAGENT_BUILD_TEST_FAILURE: `sysagent-idc:${failure}` });
    failed(result);
    assert.match(result.stderr, /7/);
    assert.equal(existsSync(resolve(f.root, 'sysagent-idc/dist/LICENSE')), false);
    assert.equal(existsSync(resolve(f.root, `release/build-${VERSION}/SHA256SUMS`)), false);
  }
});

test('missing or corrupt bundled SysAK fails native preflight before npm', nativeOptions, async t => {
  for (const target of ['desktop', 'ide', 'all']) {
    for (const damage of ['missing', 'corrupt']) {
      await t.test(`${target}: ${damage}`, t => {
        const f = fixture(t);
        if (damage === 'missing') rmSync(resolve(f.root, 'vendor/sysak/linux-x64'), { recursive: true });
        else write(f.root, 'vendor/sysak/linux-x64/sysak', 'corrupted SysAK bytes');
        const result = f.execute(['--target', target]);
        failed(result);
        assert.match(result.stderr, /sysak|SysAK|SysAK checksum|ENOENT/i);
        assert.deepEqual(f.calls(), []);
        assert.equal(f.events().some(event => event.kind.startsWith('package-runtime')), false);
        assert.equal(existsSync(resolve(f.root, 'sysagent-idc/dist')), false);
      });
    }
  }
});

test('missing or corrupt bundled AgentSight fails desktop/all before npm', nativeOptions, async t => {
  for (const target of ['desktop', 'all']) {
    for (const damage of ['missing', 'corrupt']) {
      await t.test(`${target}: ${damage}`, t => {
        const f = fixture(t);
        if (damage === 'missing') rmSync(resolve(f.root, 'vendor/agentsight/linux-x64'), { recursive: true });
        else write(f.root, 'vendor/agentsight/linux-x64/agentsight', 'corrupted AgentSight bytes');
        failed(f.execute(['--target', target]));
        assert.deepEqual(f.calls(), []);
        assert.equal(f.events().some(event => event.kind.startsWith('package-runtime')), false);
      });
    }
  }
});

test('AgentSight version must match an exact native runtime dependency pin', nativeOptions, async t => {
  for (const depends of [
    ['sysom-agentsight-runtime (= 0.15.0)'],
    ['sysom-agentsight-runtime (>= 0.16.0)'],
    ['sysom-agentsight-runtime'],
    [],
  ]) {
    await t.test(JSON.stringify(depends), t => {
      const f = fixture(t);
      updateJson(f.root, 'sysagent-idc/package.json', data => { data.build.deb.depends = depends; });
      const result = f.execute(['--target', 'all']);
      failed(result);
      assert.match(result.stderr, /AgentSight|agentsight|depends|0\.16\.0/);
      assert.deepEqual(f.calls(), []);
      assert.equal(f.events().some(event => event.kind.startsWith('package-runtime')), false);
    });
  }
  await t.test('verified manifest version differs from the dependency pin', t => {
    const f = fixture(t);
    updateJson(f.root, 'vendor/agentsight/linux-x64/manifest.json', data => { data.version = '0.15.0'; });
    failed(f.execute(['--target', 'desktop']));
    assert.deepEqual(f.calls(), []);
  });
});

function assertGxPreflightFailure(f, result) {
  failed(result);
  assert.match(result.stderr, /GX|ENOENT/);
  assert.equal(f.events().filter(event => event.kind === 'verify-gx').length, 1);
  assert.deepEqual(f.calls(), []);
  assert.equal(f.events().some(event => event.kind.startsWith('package-runtime')), false);
  assert.equal(f.events().some(event => /^forbidden-/.test(event.kind)), false);
  assert.equal(existsSync(resolve(f.root, 'sysagent-idc/dist')), false);
  assert.equal(existsSync(resolve(f.root, `release/build-${VERSION}`)), false);
  f.assertLatestUnchanged();
}

test('missing or corrupt bundled GX fails desktop/all preflight before npm or packaging', nativeOptions, async t => {
  for (const target of ['desktop', 'all']) {
    for (const damage of ['missing directory', 'missing manifest', 'missing deb', 'corrupt deb']) {
      await t.test(`${target}: ${damage}`, t => {
        const f = fixture(t);
        const vendor = resolve(f.root, 'vendor/gx/linux-x64');
        if (damage === 'missing directory') rmSync(vendor, { recursive: true });
        else if (damage === 'missing manifest') rmSync(resolve(vendor, 'manifest.json'));
        else if (damage === 'missing deb') rmSync(resolve(vendor, GX_FILENAME));
        else write(f.root, `vendor/gx/linux-x64/${GX_FILENAME}`, 'corrupted GX bytes');
        assertGxPreflightFailure(f, f.execute(['--target', target]));
        assert.equal(f.events().some(event => event.kind === 'verified-gx'), false);
      });
    }
  }
});

test('GX requires the exact verified version in the main deb dependency pin', nativeOptions, async t => {
  for (const target of ['desktop', 'all']) {
    for (const depends of [
      ['gx (= 0.6.5-1)'],
      ['gx (= 0.6.5)'],
      [`gx (>= ${GX_VERSION})`],
      ['gx'],
      [],
    ]) {
      await t.test(`${target}: ${JSON.stringify(depends)}`, t => {
        const f = fixture(t);
        updateJson(f.root, 'sysagent-idc/package.json', data => {
          data.build.deb.depends = [`sysom-agentsight-runtime (= ${RUNTIME_VERSION})`, 'python3', ...depends];
        });
        assertGxPreflightFailure(f, f.execute(['--target', target]));
        assert.equal(f.events().find(event => event.kind === 'verified-gx').version, GX_VERSION);
      });
    }
    await t.test(`${target}: verified manifest version differs from dependency pin`, t => {
      const f = fixture(t);
      updateJson(f.root, 'vendor/gx/linux-x64/manifest.json', data => { data.version = '0.6.5-1'; });
      assertGxPreflightFailure(f, f.execute(['--target', target]));
      assert.equal(f.events().find(event => event.kind === 'verified-gx').version, '0.6.5-1');
    });
  }
});

test('native skip-install requires all selected packages before running any npm build', nativeOptions, t => {
  for (const target of ['desktop', 'ide', 'all']) {
    const f = fixture(t);
    if (target !== 'desktop') mkdirSync(resolve(f.root, 'sysagent-idc/node_modules'));
    failed(f.execute(['--target', target, '--skip-install']));
    assert.deepEqual(f.calls(), []);
    assert.equal(f.events().some(event => event.kind.startsWith('package-runtime')), false);
  }
});

test('default all orchestrates main deb, official GX deb, independent runtime deb and VSIX without host installation', nativeOptions, t => {
  const f = fixture(t);
  const result = f.execute();
  succeeded(result);
  assert.deepEqual(f.calls(), [
    { folder: 'sysagent-idc', args: CI },
    { folder: 'sysagent-ide-extension', args: CI },
    { folder: 'sysagent-idc', args: ['run', 'build:deb'] },
    { folder: 'sysagent-ide-extension', args: ['run', 'package'] },
  ]);
  assertPreflight(f, { native: true, runtime: true, gx: true });
  assertNativeArtifacts(f, { desktop: true, ide: true });
});

test('desktop produces the main, official GX and independent runtime debs without a VSIX', nativeOptions, t => {
  const f = fixture(t);
  succeeded(f.execute(['--target', 'desktop']));
  assert.deepEqual(f.calls(), [
    { folder: 'sysagent-idc', args: CI },
    { folder: 'sysagent-idc', args: ['run', 'build:deb'] },
  ]);
  assertPreflight(f, { native: true, runtime: true, gx: true });
  assertNativeArtifacts(f, { desktop: true, ide: false });
});

test('fresh IDE ignores install scripts, verifies SysAK and does not need AgentSight or GX', nativeOptions, t => {
  const f = fixture(t);
  rmSync(resolve(f.root, 'vendor/agentsight'), { recursive: true });
  rmSync(resolve(f.root, 'vendor/gx'), { recursive: true });
  updateJson(f.root, 'sysagent-idc/package.json', data => { data.build.deb.depends = []; });
  succeeded(f.execute(['--target', 'ide']));
  assert.deepEqual(f.calls(), [
    { folder: 'sysagent-idc', args: [...CI, '--ignore-scripts'] },
    { folder: 'sysagent-ide-extension', args: [...CI, '--ignore-scripts'] },
    { folder: 'sysagent-idc', args: ['run', 'build'] },
    { folder: 'sysagent-ide-extension', args: ['run', 'package'] },
  ]);
  assertPreflight(f, { native: true });
  assertNativeArtifacts(f, { desktop: false, ide: true });
});

test('all skip-install still verifies native inputs and produces all artifacts', nativeOptions, t => {
  const f = fixture(t);
  for (const folder of ['sysagent-idc', 'sysagent-ide-extension']) mkdirSync(resolve(f.root, folder, 'node_modules'));
  succeeded(f.execute(['--target', 'all', '--skip-install']));
  assert.deepEqual(f.calls(), [
    { folder: 'sysagent-idc', args: ['run', 'build:deb'] },
    { folder: 'sysagent-ide-extension', args: ['run', 'package'] },
  ]);
  assertPreflight(f, { native: true, runtime: true, gx: true });
  assertNativeArtifacts(f, { desktop: true, ide: true });
});

test('all fails on each npm or runtime helper error without claiming success', nativeOptions, async t => {
  for (const failure of [
    `sysagent-idc:${CI.join(' ')}`,
    `sysagent-ide-extension:${CI.join(' ')}`,
    'sysagent-idc:run build:deb',
    'sysagent-ide-extension:run package',
    'package-runtime',
    'package-runtime-deb',
  ]) {
    await t.test(failure, t => {
      const f = fixture(t);
      failed(f.execute(['--target', 'all'], { SYSAGENT_BUILD_TEST_FAILURE: failure }));
      assert.equal(existsSync(resolve(f.root, `release/build-${VERSION}/SHA256SUMS`)), false);
      assert.equal(f.events().some(event => /^forbidden-/.test(event.kind)), false);
      if (failure.startsWith('sysagent-')) {
        const calls = f.calls();
        assert.equal(calls.at(-1).folder + ':' + calls.at(-1).args.join(' '), failure, 'Do not run subsequent npm steps after failure');
      }
      for (const event of f.events().filter(event => event.kind === 'package-runtime')) {
        assert.equal(existsSync(event.output), false, 'Clean runtime staging on failure');
      }
      f.assertLatestUnchanged();
    });
  }
});

test('successful commands with missing outputs do not reuse old batches or emit success', nativeOptions, async t => {
  for (const artifact of ['desktop', 'ide', 'runtime']) {
    await t.test(artifact, t => {
      const f = fixture(t);
      failed(f.execute(['--target', 'all'], { SYSAGENT_BUILD_TEST_OMIT: artifact }));
      assert.equal(existsSync(resolve(f.root, `release/build-${VERSION}/SHA256SUMS`)), false);
      f.assertLatestUnchanged();
    });
  }
});
