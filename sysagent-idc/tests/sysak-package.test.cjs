'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  prepareBundle, verifyBundle, validateElf, normalizeRules, parseArgs, sha256,
  REQUIRED_FILES, TOOLS: ACTUAL_TOOLS, RULES: ACTUAL_RULES,
} = require('../scripts/prepare-sysak.cjs');
const afterPack = require('../build/after-pack.cjs');

const ROOT = path.resolve(__dirname, '..');
// Independent expected lists keep accidental whitelist expansion observable.
const TOOLS = '.sysak_components/tools';
const RULES = `${TOOLS}/.sysak.rules`;
const LEGACY_COMMANDS = ['idc', 'resource_anomaly', 'memgraph'];
const COMMANDS = [...LEGACY_COMMANDS, 'ai'];
const DIRECTORIES = ['.sysak_components', TOOLS];
const DIAGNOSTIC_MODULES = [
  'resource_anomaly_idc', 'fdleak_metrics',
  'plugin_abnormalPackages', 'plugin_anonTaskTop', 'plugin_cache', 'plugin_memcgLeak',
  'plugin_memfrag', 'plugin_memgraph', 'plugin_meminfo', 'plugin_memleak', 'plugin_podDetect',
  'plugin_system', 'plugin_taskProc', 'plugin_vmRssTaskTop', 'plugin_skcheck', 'plugin_appmem',
  'mem_utils', 'plugin_thpCollect',
];
const SAFE_PROFILES = {
  resource_anomaly: ['--idc'], memgraph: ['--graph', '--jsonstdout'], ai: ['--threshold', '1s'],
};
const EXPECTED_FILES = [
  'sysak', ...COMMANDS.map(name => `${TOOLS}/${name}`), RULES,
  ...DIAGNOSTIC_MODULES.map(name => `${TOOLS}/${name}.py`),
].sort();
const canonicalRules = 'detect/generic:idc:python-dep{python3}:help{idc}\n' +
  'detect/generic:resource_anomaly:python-dep{python3}:help{resource_anomaly --idc only}\n' +
  'detect/mem:memgraph:python-dep{python3}:help{memgraph --graph --jsonstdout}\n' +
  'generic:ai::help{GPU AI diagnostics}\n';
const legacyConfscanRule = 'detect/generic:confscan:python-dep{python3}:help{confscan}\n';

function write(file, content, mode = 0o644) {
  const parent = path.dirname(file);
  // Fixture directories only; inspect the existing ancestor before creating.
  let ancestor = parent;
  while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
  assert.ok(fs.statSync(ancestor).isDirectory());
  fs.mkdirSync(parent, { recursive: true, mode: 0o755 });
  fs.writeFileSync(file, content, { mode });
}

function mockElf(arch = process.arch) {
  const elf = Buffer.alloc(64);
  Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]).copy(elf);
  elf.writeUInt16LE(3, 16);
  elf.writeUInt16LE(arch === 'x64' ? 62 : 183, 18);
  elf.writeUInt32LE(1, 20);
  elf.writeUInt16LE(64, 52);
  return elf;
}

function fixture(t) {
  assert.ok(fs.statSync(os.tmpdir()).isDirectory());
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'sysom-sysak-test-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const projectRoot = path.join(temporary, 'guard');
  const source = path.join(temporary, 'completed-build');
  write(path.join(projectRoot, 'package.json'), JSON.stringify({ name: 'sysagent-idc' }));
  write(path.join(source, 'sysak'), mockElf(), 0o755);
  for (const command of COMMANDS) {
    write(path.join(source, TOOLS, command), command === 'ai' ? mockElf() : `#!/usr/bin/env python3\n# mock ${command}\n`, 0o755);
  }
  for (const module of DIAGNOSTIC_MODULES) write(path.join(source, TOOLS, `${module}.py`), '# mock bundled module\n');
  write(path.join(source, RULES), canonicalRules);
  const bundle = path.join(projectRoot, 'resources/sysak');
  return { temporary, source, projectRoot, bundle, prepare: () => prepareBundle(source, { projectRoot }) };
}

function fileList(root, relative = '') {
  return fs.readdirSync(path.join(root, relative), { withFileTypes: true }).flatMap(entry => {
    const name = relative ? `${relative}/${entry.name}` : entry.name;
    return entry.isDirectory() ? fileList(root, name) : [name];
  }).sort();
}

function snapshot(root) {
  return Object.fromEntries(fileList(root).map(relative => {
    const file = path.join(root, relative);
    // Snapshot links themselves, never read a fixture's external or dangling target.
    const value = fs.lstatSync(file).isSymbolicLink() ? `symlink:${fs.readlinkSync(file)}` : sha256(fs.readFileSync(file));
    return [relative, value];
  }));
}

function rewriteManifest(bundle, edit) {
  const file = path.join(bundle, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  edit(manifest);
  fs.writeFileSync(file, JSON.stringify(manifest));
}

test('packages exactly four commands and eighteen flat modules without light_inspect; normalizes rules; reproducible', t => {
  const f = fixture(t);
  write(path.join(f.source, '.git/config'), 'credential = secret');
  write(path.join(f.source, 'source/private.c'), 'do not copy');
  write(path.join(f.source, '.env'), 'TOKEN=secret');
  write(path.join(f.source, TOOLS, 'unrelated-tool'), 'unrelated');
  write(path.join(f.source, TOOLS, 'gpudiag'), '#!/usr/bin/env python3\n# obsolete GPU entry; not copied\n', 0o755);
  write(path.join(f.source, TOOLS, '6.8.0/.sysak.rules'), 'kernel-specific');
  write(path.join(f.source, TOOLS, 'confscan'), '#!/usr/bin/env python\n# excluded legacy command\n', 0o755);
  write(path.join(f.source, TOOLS, 'confscan_lib/config.py'), '# excluded legacy module\n');
  write(path.join(f.source, TOOLS, 'confscan_lib/__pycache__/config.pyc'), 'bytecode');
  write(path.join(f.source, TOOLS, 'confscan_conf/d1_boot.json'), '{invalid excluded JSON');
  // Unrelated/private modules and bytecode are not traversed or copied.
  // Native memgraph's imported plugins are required and remain byte-identical.
  for (const relative of [
    'diagnostics/__init__.py', 'diagnostics/fdleak/adapter.py',
    'diagnostics/memcgoffline/adapter.py', 'diagnostics/diskscanner/adapter.py',
    'memgraph_idc.py', 'memtop.py', 'memgraph_plugins.py', '__pycache__/memgraph_idc.pyc',
    'resource_anomaly_conf/credentials.json',
    'light_inspect/gpu_snapshot.py', 'light_inspect/collectors/__init__.py',
    'light_inspect/collectors/gpu.py', 'light_inspect/light_inspect_compat.py',
    'light_inspect/__init__.py', 'light_inspect/collectors/cpu.py', 'light_inspect/collectors/memory.py',
    'light_inspect/credentials.json', 'light_inspect/__pycache__/gpu_snapshot.pyc',
  ]) write(path.join(f.source, TOOLS, relative), 'not a bundled dependency');
  const untouched = path.join(f.temporary, 'excluded-data');
  write(path.join(untouched, 'keep'), 'untouched');
  fs.symlinkSync(path.join(untouched, 'keep'), path.join(f.source, TOOLS, 'legacy-link'));
  write(path.join(f.source, RULES), canonicalRules + legacyConfscanRule + canonicalRules + 'detect:other::help{other}\n');
  const sourceBefore = snapshot(f.source);
  const manifest = f.prepare();
  assert.equal(manifest.schema_version, '1.0');
  assert.equal(manifest.platform, 'linux');
  assert.equal(manifest.arch, process.arch);
  assert.deepEqual(manifest.commands, COMMANDS);
  assert.deepEqual(manifest.requires, ['python3']);
  assert.deepEqual(manifest.safe_profiles, SAFE_PROFILES);
  assert.equal(ACTUAL_TOOLS, TOOLS);
  assert.equal(ACTUAL_RULES, RULES);
  assert.equal(DIAGNOSTIC_MODULES.length, 18);
  assert.equal(EXPECTED_FILES.length, 24);
  assert.equal(REQUIRED_FILES.length, 24);
  assert.deepEqual(REQUIRED_FILES, EXPECTED_FILES);
  assert.deepEqual(fileList(f.bundle), [...EXPECTED_FILES, 'manifest.json'].sort());
  assert.equal(fs.readFileSync(path.join(f.bundle, RULES), 'utf8'), canonicalRules);
  assert.deepEqual(Object.keys(manifest.files).sort(), EXPECTED_FILES);
  for (const relative of EXPECTED_FILES) {
    assert.equal(manifest.files[relative], sha256(fs.readFileSync(path.join(f.bundle, relative))));
    if (relative !== RULES) assert.deepEqual(fs.readFileSync(path.join(f.bundle, relative)), fs.readFileSync(path.join(f.source, relative)));
  }
  assert.deepEqual(verifyBundle(f.bundle), manifest);
  const before = snapshot(f.bundle);
  assert.deepEqual(f.prepare(), manifest);
  assert.deepEqual(snapshot(f.bundle), before);
  assert.deepEqual(snapshot(f.source), sourceBefore);
  assert.equal(fs.readFileSync(path.join(untouched, 'keep'), 'utf8'), 'untouched');
  assert.equal(fs.lstatSync(path.join(f.source, TOOLS, 'legacy-link')).isSymbolicLink(), true);
  assert.deepEqual(fs.readdirSync(path.dirname(f.bundle)), ['sysak']);
});

for (const relative of EXPECTED_FILES) {
  test(`missing component fails without touching an existing bundle: ${relative}`, t => {
    const f = fixture(t);
    f.prepare();
    const before = snapshot(f.bundle);
    fs.unlinkSync(path.join(f.source, relative));
    assert.throws(f.prepare, /Missing required component|Missing required directory/);
    assert.deepEqual(snapshot(f.bundle), before);
    verifyBundle(f.bundle);
  });
}

for (const includeRemovedFiles of [false, true]) {
  test(`rejects an obsolete confscan bundle without replacing it (removed files: ${includeRemovedFiles})`, t => {
    const f = fixture(t);
    f.prepare();
    const removed = {
      [`${TOOLS}/confscan`]: '#!/usr/bin/env python3\n# obsolete command\n',
      [`${TOOLS}/confscan_lib/config.py`]: '# obsolete module\n',
      [`${TOOLS}/confscan_conf/d1_boot.json`]: '{"items":[]}\n',
    };
    if (includeRemovedFiles) {
      for (const [relative, content] of Object.entries(removed)) write(path.join(f.bundle, relative), content);
    }
    rewriteManifest(f.bundle, manifest => {
      manifest.commands = ['idc', 'confscan', 'resource_anomaly', 'memgraph'];
      for (const [relative, content] of Object.entries(removed)) manifest.files[relative] = sha256(Buffer.from(content));
    });
    assert.deepEqual(fileList(f.bundle), [
      ...EXPECTED_FILES, 'manifest.json', ...(includeRemovedFiles ? Object.keys(removed) : []),
    ].sort());
    const before = snapshot(f.bundle);
    const modes = modeSnapshot(f.bundle);
    const error = includeRemovedFiles ? /Unexpected file\/directory/ : /Invalid manifest/;
    assert.throws(() => verifyBundle(f.bundle), error);
    assert.throws(f.prepare, error);
    assert.deepEqual(snapshot(f.bundle), before);
    assert.deepEqual(modeSnapshot(f.bundle), modes);
    assert.deepEqual(fs.readdirSync(path.dirname(f.bundle)), ['sysak']);
  });
}

for (const relative of EXPECTED_FILES) {
  test(`verification and replacement reject hash tampering: ${relative}`, t => {
    const f = fixture(t);
    f.prepare();
    fs.appendFileSync(path.join(f.bundle, relative), '\n# tamper\n');
    const before = snapshot(f.bundle);
    assert.throws(() => verifyBundle(f.bundle), /SHA256 mismatch/);
    assert.throws(f.prepare, /SHA256 mismatch/);
    assert.deepEqual(snapshot(f.bundle), before);
    assert.deepEqual(fs.readdirSync(path.dirname(f.bundle)), ['sysak']);
  });

  test(`verification rejects a missing or symlinked required component: ${relative}`, t => {
    const f = fixture(t);
    f.prepare();
    const file = path.join(f.bundle, relative);
    fs.unlinkSync(file);
    assert.throws(() => verifyBundle(f.bundle), /missing required components/);
    fs.symlinkSync(path.join(f.source, relative), file);
    assert.throws(() => verifyBundle(f.bundle), /symlink/);
    assert.throws(f.prepare, /symlink/);
    assert.equal(fs.lstatSync(file).isSymbolicLink(), true);
  });
}

for (const command of LEGACY_COMMANDS) {
  test(`preparation and verification require a python3 entry: ${command}`, t => {
    const f = fixture(t);
    f.prepare();
    const relative = `${TOOLS}/${command}`;
    const bad = Buffer.from('#!/usr/bin/env python\n# not python3\n');
    const before = snapshot(f.bundle);
    fs.writeFileSync(path.join(f.source, relative), bad);
    assert.throws(f.prepare, /Expected python3 entry script/);
    assert.deepEqual(snapshot(f.bundle), before);
    assert.deepEqual(fs.readdirSync(path.dirname(f.bundle)), ['sysak']);
    fs.writeFileSync(path.join(f.bundle, relative), bad);
    rewriteManifest(f.bundle, manifest => { manifest.files[relative] = sha256(bad); });
    assert.throws(() => verifyBundle(f.bundle), /Expected python3 entry script/);
  });

  test(`rules canonicalize only native memgraph all at source; verification requires python3: ${command}`, t => {
    const f = fixture(t);
    f.prepare();
    const before = snapshot(f.bundle);
    const bad = Buffer.from(canonicalRules.replace(`${command}:python-dep{python3}`, `${command}:python-dep{all}`));
    fs.writeFileSync(path.join(f.source, RULES), bad);
    if (command === 'memgraph') {
      f.prepare(); // Unchanged native Makefile's all dependency is canonicalized at source only.
      assert.equal(fs.readFileSync(path.join(f.bundle, RULES), 'utf8'), canonicalRules);
      assert.deepEqual(fs.readFileSync(path.join(f.source, RULES)), bad);
    } else {
      assert.throws(f.prepare, /expected only python-dep\{python3\}/);
    }
    assert.deepEqual(snapshot(f.bundle), before);
    fs.writeFileSync(path.join(f.bundle, RULES), bad);
    rewriteManifest(f.bundle, manifest => { manifest.files[RULES] = sha256(bad); });
    assert.throws(() => verifyBundle(f.bundle), /expected only python-dep\{python3\}/);
  });
}

for (const relative of [...EXPECTED_FILES, 'manifest.json']) {
  test(`verification rejects unsafe permissions and enforces executable policy: ${relative}`, t => {
    const f = fixture(t);
    f.prepare();
    const file = path.join(f.bundle, relative);
    const expectedMode = relative === 'sysak' || COMMANDS.some(command => relative === `${TOOLS}/${command}`) ||
      relative.endsWith('.py') ? 0o755 : 0o644;
    assert.equal(fs.statSync(file).mode & 0o7777, expectedMode);
    for (const mode of [expectedMode | 0o2000, expectedMode | 0o002, expectedMode | 0o020]) {
      fs.chmodSync(file, mode);
      assert.throws(() => verifyBundle(f.bundle), /Unsafe permissions/);
    }
    if (expectedMode === 0o755) {
      fs.chmodSync(file, 0o644);
      assert.throws(() => verifyBundle(f.bundle), /non-executable/);
    }
    fs.chmodSync(file, expectedMode);
    verifyBundle(f.bundle);
  });
}

for (const name of [...COMMANDS, ...DIAGNOSTIC_MODULES.map(module => `${module}.py`)]) {
  test(`a non-regular diagnostic/command component is never opened: ${name}`, t => {
    const f = fixture(t);
    const file = path.join(f.source, TOOLS, name);
    fs.unlinkSync(file);
    fs.mkdirSync(file);
    assert.throws(f.prepare, /non-regular/);
    assert.equal(fs.existsSync(f.bundle), false);
  });
}

test('hash tamper is rejected, including when asked to replace a damaged bundle', t => {
  const f = fixture(t);
  f.prepare();
  fs.appendFileSync(path.join(f.bundle, TOOLS, 'idc'), '# tamper\n');
  assert.throws(() => verifyBundle(f.bundle), /SHA256 mismatch/);
  assert.throws(f.prepare, /SHA256 mismatch/);
  assert.match(fs.readFileSync(path.join(f.bundle, TOOLS, 'idc'), 'utf8'), /tamper/);
  assert.deepEqual(fs.readdirSync(path.dirname(f.bundle)), ['sysak']);
});

test('validates both supported ELF e_machine values and rejects a host mismatch', t => {
  assert.equal(validateElf(mockElf('x64'), 'x64'), 'x64');
  assert.equal(validateElf(mockElf('arm64'), 'arm64'), 'arm64');
  assert.throws(() => validateElf(mockElf('arm64'), 'x64'), /architecture mismatch/);
  assert.throws(() => validateElf(mockElf('x64'), 'arm64'), /architecture mismatch/);
  for (const bad of [Buffer.from('not ELF'), Buffer.alloc(64)]) assert.throws(() => validateElf(bad), /ELF executable/);
  const malformed = mockElf();
  malformed[4] = 1;
  assert.throws(() => validateElf(malformed), /ELF executable/);
  const f = fixture(t);
  write(path.join(f.source, 'sysak'), mockElf(process.arch === 'x64' ? 'arm64' : 'x64'));
  assert.throws(f.prepare, /architecture mismatch/);
  assert.equal(fs.existsSync(f.bundle), false);
});

for (const [label, bad] of [
  ['python3 script', Buffer.from('#!/usr/bin/env python3\n# ai must be native\n')],
  ['shell script', Buffer.from('#!/bin/sh\nexit 0\n')],
  ['wrong architecture', mockElf(process.arch === 'x64' ? 'arm64' : 'x64')],
  ['truncated ELF', mockElf().subarray(0, 63)],
  ['non-ELF', Buffer.alloc(64)],
]) {
  test(`native ai rejects ${label} in source, verification, replacement, afterPack and installer checker`, async t => {
    const f = packedFixture(t);
    const relative = `${TOOLS}/ai`;
    const before = snapshot(f.bundle);
    fs.writeFileSync(path.join(f.source, relative), bad);
    assert.throws(f.prepare, /ai must be.*ELF executable|architecture mismatch/);
    assert.deepEqual(snapshot(f.bundle), before);
    fs.writeFileSync(path.join(f.source, relative), mockElf());
    fs.writeFileSync(path.join(f.bundle, relative), bad);
    rewriteManifest(f.bundle, m => { m.files[relative] = sha256(bad); });
    const damaged = snapshot(f.bundle);
    assert.throws(() => verifyBundle(f.bundle), /ai must be.*ELF executable|architecture mismatch/);
    assert.throws(f.prepare, /ai must be.*ELF executable|architecture mismatch/);
    assert.notEqual(installManifestCheck(f.bundle).status, 0);
    assert.deepEqual(snapshot(f.bundle), damaged);
    fs.writeFileSync(path.join(f.packedBundle, relative), bad);
    rewriteManifest(f.packedBundle, m => { m.files[relative] = sha256(bad); });
    await assert.rejects(afterPack({ appOutDir: f.appOutDir }), /ai must be.*ELF executable|architecture mismatch/);
  });
}

test('verify checks ELF architecture even if the attacker recomputes its hash', t => {
  const f = fixture(t);
  f.prepare();
  const wrong = mockElf(process.arch === 'x64' ? 'arm64' : 'x64');
  fs.writeFileSync(path.join(f.bundle, 'sysak'), wrong);
  rewriteManifest(f.bundle, manifest => { manifest.files.sysak = sha256(wrong); });
  assert.throws(() => verifyBundle(f.bundle), /architecture mismatch/);
});

for (const [name, edit] of [
  ['schema', manifest => { manifest.schema_version = '2.0'; }],
  ['platform', manifest => { manifest.platform = 'darwin'; }],
  ['arch', manifest => { manifest.arch = process.arch === 'x64' ? 'arm64' : 'x64'; }],
  ['commands', manifest => { manifest.commands = ['idc']; }],
  ['old two-command manifest', manifest => { manifest.commands = ['idc', 'confscan']; }],
  ['requires', manifest => { delete manifest.requires; }],
  ['python2 dependency', manifest => { manifest.requires = ['python3', 'python2']; }],
  ['missing safe profiles', manifest => { delete manifest.safe_profiles; }],
  ['legacy resource mode', manifest => { manifest.safe_profiles.resource_anomaly = ['--all']; }],
  ['private IDC memgraph mode', manifest => { manifest.safe_profiles.memgraph = ['--idc', '--jsonstdout']; }],
  ['obsolete AI IDC argv', manifest => { manifest.safe_profiles.ai = ['--idc']; }],
  ['extra safe profile', manifest => { manifest.safe_profiles.memgraph.push('--force-scan'); }],
  ['unsupported safe command', manifest => { manifest.safe_profiles.other = ['--idc']; }],
  ['traversal', manifest => { manifest.files['../../private'] = 'a'.repeat(64); }],
  ['missing hash', manifest => { delete manifest.files.sysak; }],
  ['invalid hash', manifest => { manifest.files.sysak = 'invalid'; }],
]) {
  test(`manifest rejects ${name}`, t => {
    const f = fixture(t);
    f.prepare();
    rewriteManifest(f.bundle, edit);
    assert.throws(() => verifyBundle(f.bundle), /Invalid manifest|SHA256 mismatch/);
  });
}

test('rules require three python3 commands and native ai, unambiguous duplicates and canonical output', () => {
  const lines = canonicalRules.trim().split('\n');
  assert.equal(normalizeRules(canonicalRules + canonicalRules), canonicalRules);
  assert.equal(normalizeRules([...lines].reverse().join('\n') + '\n'), canonicalRules);
  assert.equal(normalizeRules(canonicalRules, true), canonicalRules);
  assert.throws(() => normalizeRules(canonicalRules.split('\n')[0]), /Missing resource_anomaly rule/);
  for (const obsolete of [
    legacyConfscanRule, legacyConfscanRule + legacyConfscanRule,
    legacyConfscanRule.replace('python-dep{python3}', 'prev{modin};python-dep{python2}'),
  ]) {
    assert.equal(normalizeRules(obsolete + canonicalRules + obsolete), canonicalRules);
    assert.throws(() => normalizeRules(canonicalRules + obsolete, true), /Unexpected sysAK rule/);
  }
  for (const command of COMMANDS) {
    const line = lines.find(rule => rule.split(':')[1] === command);
    assert.throws(() => normalizeRules(lines.filter(rule => rule !== line).join('\n')),
      new RegExp(`Missing ${command} rule`));
    if (command === 'ai') {
      for (const dependency of ['python3', 'python2', 'all', 'prev{modin}', 'python-dep{python3};post{modout}']) {
        const bad = canonicalRules.replace('generic:ai::', `generic:ai:${dependency.startsWith('python') && !dependency.includes('{') ? `python-dep{${dependency}}` : dependency}:`);
        assert.throws(() => normalizeRules(bad), /Invalid ai rule/);
        assert.throws(() => normalizeRules(bad, true), /Invalid ai rule/);
      }
      assert.throws(() => normalizeRules(canonicalRules.replace('generic:ai:', 'detect/gpu:ai:')), /Invalid ai rule/);
      assert.throws(() => normalizeRules(canonicalRules.replace('help{GPU AI diagnostics}', 'help{different}')), /Invalid ai rule/);
      continue;
    }
    for (const dependency of ['python2', 'all', 'python3,python2']) {
      const bad = canonicalRules.replace(`${command}:python-dep{python3}`, `${command}:python-dep{${dependency}}`);
      if (command === 'memgraph' && dependency === 'all') {
        assert.equal(normalizeRules(bad), canonicalRules);
        assert.equal(normalizeRules(bad + canonicalRules), canonicalRules);
      } else {
        assert.throws(() => normalizeRules(bad), /expected only python-dep\{python3\}/);
      }
      assert.throws(() => normalizeRules(bad, true), /expected only python-dep\{python3\}/);
    }
    for (const dependency of ['prev{modin};python-dep{python3}', 'python-dep{python3};post{modout}']) {
      assert.throws(() => normalizeRules(canonicalRules.replace(`${command}:python-dep{python3}`, `${command}:${dependency}`)),
        new RegExp(`Invalid ${command} rule`));
    }
    assert.throws(() => normalizeRules(canonicalRules + line.replace(/help\{.*\}$/, 'help{different}') + '\n'), /Conflicting duplicate/);
  }
  assert.throws(() => normalizeRules(canonicalRules + canonicalRules, true), /exactly one canonical/);
  assert.throws(() => normalizeRules([...lines].reverse().join('\n') + '\n', true), /exactly one canonical/);
  assert.throws(() => normalizeRules(canonicalRules + 'detect:other::help{other}\n', true), /Unexpected sysAK rule/);
  assert.throws(() => normalizeRules(canonicalRules.replace('python-dep{python3}', 'prev{modin};python-dep{python3}')), /Invalid idc rule/);
});

for (const [name, rules, error] of [
  ['duplicate rules', canonicalRules + canonicalRules, /canonical/],
  ['removed confscan rule', canonicalRules + legacyConfscanRule, /Unexpected sysAK rule/],
]) {
  test(`verification and replacement reject ${name} even with matching hashes`, t => {
    const f = fixture(t);
    f.prepare();
    const bad = Buffer.from(rules);
    fs.writeFileSync(path.join(f.bundle, RULES), bad);
    rewriteManifest(f.bundle, manifest => { manifest.files[RULES] = sha256(bad); });
    const before = snapshot(f.bundle);
    assert.throws(() => verifyBundle(f.bundle), error);
    assert.throws(f.prepare, error);
    assert.deepEqual(snapshot(f.bundle), before);
  });
}

test('source symlinks at the root, ancestors, entry, modules and rules are rejected', t => {
  const f = fixture(t);
  const linked = path.join(f.temporary, 'linked-source');
  fs.symlinkSync(f.source, linked, 'dir');
  assert.throws(() => prepareBundle(linked, { projectRoot: f.projectRoot }), /Unsafe directory/);
  fs.symlinkSync(f.temporary, path.join(f.temporary, 'linked-parent'), 'dir');
  assert.throws(() => prepareBundle(path.join(f.temporary, 'linked-parent/completed-build'), { projectRoot: f.projectRoot }), /Unsafe directory/);
  for (const relative of EXPECTED_FILES) {
    const original = path.join(f.source, relative);
    const data = fs.readFileSync(original);
    const outside = path.join(f.temporary, 'private');
    write(outside, data);
    fs.unlinkSync(original);
    fs.symlinkSync(outside, original);
    assert.throws(f.prepare, /Unsafe file/);
    assert.deepEqual(fs.readFileSync(outside), data);
    fs.unlinkSync(original);
    write(original, data);
  }
});

test('a non-regular entry fails without opening or executing it', t => {
  const f = fixture(t);
  const entry = path.join(f.source, TOOLS, 'idc');
  fs.unlinkSync(entry);
  fs.mkdirSync(entry);
  assert.throws(f.prepare, /non-regular/);
});

test('target resource symlinks cannot overwrite/delete any external directory', t => {
  const f = fixture(t);
  const outside = path.join(f.temporary, 'user-data');
  write(path.join(outside, 'keep.txt'), 'keep');
  fs.symlinkSync(outside, path.join(f.projectRoot, 'resources'), 'dir');
  assert.throws(f.prepare, /Unsafe directory/);
  fs.unlinkSync(path.join(f.projectRoot, 'resources'));
  fs.mkdirSync(path.join(f.projectRoot, 'resources'));
  fs.symlinkSync(outside, f.bundle, 'dir');
  assert.throws(f.prepare, /Unsafe directory/);
  assert.equal(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8'), 'keep');
  assert.equal(fs.lstatSync(f.bundle).isSymbolicLink(), true);
});

test('unsafe files inside a bundle and unexpected contents are refused, not removed', t => {
  const f = fixture(t);
  f.prepare();
  write(path.join(f.bundle, 'credentials.json'), '{"secret":true}');
  assert.throws(() => verifyBundle(f.bundle), /Unexpected file/);
  assert.throws(f.prepare, /Unexpected file/);
  assert.equal(fs.existsSync(path.join(f.bundle, 'credentials.json')), true);
  fs.unlinkSync(path.join(f.bundle, 'credentials.json'));
  const module = path.join(f.bundle, TOOLS, 'plugin_system.py');
  fs.unlinkSync(module);
  fs.symlinkSync(path.join(f.source, TOOLS, 'plugin_system.py'), module);
  assert.throws(() => verifyBundle(f.bundle), /symlink/);
  assert.throws(f.prepare, /symlink/);
  assert.equal(fs.lstatSync(module).isSymbolicLink(), true);
});

for (const relative of DIRECTORIES) {
  for (const kind of ['missing', 'file', 'symlink']) {
    test(`unsafe source directory is rejected without replacing the bundle: ${relative} (${kind})`, t => {
      const f = fixture(t);
      f.prepare();
      const before = snapshot(f.bundle);
      const modes = modeSnapshot(f.bundle);
      const directory = path.join(f.source, relative);
      const outside = path.join(f.temporary, 'original-directory');
      fs.renameSync(directory, outside);
      const outsideBefore = snapshot(outside);
      if (kind === 'file') write(directory, 'not a directory');
      if (kind === 'symlink') fs.symlinkSync(outside, directory, 'dir');
      assert.throws(f.prepare, /Missing required component|Missing required directory|Unsafe directory|ENOTDIR/);
      assert.deepEqual(snapshot(f.bundle), before);
      assert.deepEqual(modeSnapshot(f.bundle), modes);
      assert.deepEqual(snapshot(outside), outsideBefore);
      if (kind === 'symlink') assert.equal(fs.lstatSync(directory).isSymbolicLink(), true);
      verifyBundle(f.bundle);
    });
  }
}

test('invalid manifest JSON is rejected without replacing or changing the bundle', t => {
  const f = fixture(t);
  f.prepare();
  fs.writeFileSync(path.join(f.bundle, 'manifest.json'), '{broken');
  const before = snapshot(f.bundle);
  const modes = modeSnapshot(f.bundle);
  assert.throws(() => verifyBundle(f.bundle), /Invalid JSON: manifest\.json/);
  assert.throws(f.prepare, /Invalid JSON: manifest\.json/);
  assert.deepEqual(snapshot(f.bundle), before);
  assert.deepEqual(modeSnapshot(f.bundle), modes);
  assert.deepEqual(fs.readdirSync(path.dirname(f.bundle)), ['sysak']);
});

for (const kind of ['directory', 'symlink', 'dangling symlink']) {
  test(`excluded source light_inspect, gpudiag and confscan paths are never inspected, traversed or copied: ${kind}`, t => {
    const f = fixture(t);
    const outside = path.join(f.temporary, 'excluded-data');
    write(path.join(outside, 'keep'), 'untouched');
    const excluded = ['confscan', 'confscan_lib', 'confscan_conf', 'light_inspect', 'gpudiag']
      .map(name => path.join(f.source, TOOLS, name));
    const missing = path.join(f.temporary, 'missing-excluded-data');
    for (const directory of excluded) {
      if (kind === 'directory') {
        write(path.join(directory, 'unexpected.py'), '# excluded module\n');
        write(path.join(directory, 'credentials.json'), '{invalid excluded JSON');
        fs.symlinkSync(outside, path.join(directory, '__pycache__'), 'dir');
      } else {
        fs.symlinkSync(kind === 'symlink' ? outside : missing, directory, 'dir');
      }
    }
    const sourceBefore = snapshot(f.source);
    const sourceModes = modeSnapshot(f.source);
    const outsideBefore = snapshot(outside);
    const outsideModes = modeSnapshot(outside);
    const forbidden = [...excluded, outside, missing];
    const attempted = [];
    const mocks = [];
    function checkAccess(method, value) {
      if (Buffer.isBuffer(value)) value = value.toString();
      if (typeof value !== 'string') return; // Reads by descriptor are checked at openSync.
      const absolute = path.resolve(value);
      const contains = (parent, child) => child === parent || child.startsWith(`${parent}${path.sep}`);
      const bulkCopy = method === 'cpSync' && excluded.some(directory => contains(absolute, directory));
      if (bulkCopy || forbidden.some(directory => contains(directory, absolute))) {
        attempted.push(`${method}: ${absolute}`);
        assert.fail(`Excluded source path accessed: ${method}: ${absolute}`);
      }
    }
    try {
      for (const method of [
        'accessSync', 'existsSync', 'lstatSync', 'statSync', 'openSync', 'readFileSync',
        'readdirSync', 'opendirSync', 'readlinkSync', 'realpathSync', 'cpSync', 'copyFileSync',
      ]) {
        const original = fs[method];
        mocks.push(t.mock.method(fs, method, (...args) => {
          checkAccess(method, args[0]);
          if (method === 'cpSync' || method === 'copyFileSync') checkAccess(method, args[1]);
          return original(...args);
        }));
      }
      const manifest = f.prepare();
      assert.deepEqual(manifest.commands, COMMANDS);
      assert.deepEqual(Object.keys(manifest.files).sort(), EXPECTED_FILES);
      assert.deepEqual(fileList(f.bundle), [...EXPECTED_FILES, 'manifest.json'].sort());
      assert.deepEqual(verifyBundle(f.bundle), manifest);
      const before = snapshot(f.bundle);
      assert.deepEqual(f.prepare(), manifest);
      assert.deepEqual(snapshot(f.bundle), before);
      assert.deepEqual(attempted, []);
    } finally {
      for (const mock of mocks) mock.mock.restore();
    }
    assert.deepEqual(snapshot(f.source), sourceBefore);
    assert.deepEqual(modeSnapshot(f.source), sourceModes);
    assert.deepEqual(snapshot(outside), outsideBefore);
    assert.deepEqual(modeSnapshot(outside), outsideModes);
    for (const directory of excluded) {
      assert.equal(fs.lstatSync(directory).isSymbolicLink(), kind !== 'directory');
    }
    assert.equal(fs.existsSync(missing), false);
  });
}

test('refuses overlapping source/target, a different project and arbitrary CLI target arguments', t => {
  const f = fixture(t);
  assert.throws(() => prepareBundle(f.temporary, { projectRoot: f.projectRoot }), /must not overlap/);
  write(path.join(f.projectRoot, 'package.json'), '{"name":"other-project"}');
  assert.throws(f.prepare, /Destination must be/);
  assert.throws(() => parseArgs(['--target', '/tmp/user-data']), /Unknown or incomplete/);
  assert.throws(() => parseArgs(['--source']), /Unknown or incomplete/);
  assert.throws(() => parseArgs(['--verify', '--source', f.source]), /cannot be combined/);
  assert.deepEqual(parseArgs(['--source', f.source]), { source: f.source, verify: false });
});

const LEGACY_FILES = EXPECTED_FILES.filter(relative => relative !== `${TOOLS}/ai`);
const legacyRules = canonicalRules.split('\n').filter(line => !line.includes(':ai:')).join('\n');
function legacyBundle(f) {
  f.prepare();
  fs.unlinkSync(path.join(f.bundle, TOOLS, 'ai'));
  fs.writeFileSync(path.join(f.bundle, RULES), legacyRules);
  rewriteManifest(f.bundle, manifest => {
    manifest.commands = LEGACY_COMMANDS;
    delete manifest.safe_profiles.ai;
    for (const relative of Object.keys(manifest.files)) if (!LEGACY_FILES.includes(relative)) delete manifest.files[relative];
    manifest.files[RULES] = sha256(Buffer.from(legacyRules));
  });
  assert.equal(LEGACY_FILES.length, 23);
  assert.deepEqual(fileList(f.bundle), [...LEGACY_FILES, 'manifest.json'].sort());
}

for (const includeGpuFiles of [false, true]) {
  test(`obsolete GPU packages are never upgraded or accepted at runtime (old GPU files: ${includeGpuFiles})`, t => {
    const f = fixture(t);
    f.prepare();
    fs.unlinkSync(path.join(f.bundle, TOOLS, 'ai'));
    const gpudiag = `${TOOLS}/gpudiag`;
    const data = '#!/usr/bin/env python3\n# inert obsolete GPU entry\n';
    write(path.join(f.bundle, gpudiag), data, 0o755);
    const rules = legacyRules + 'detect/gpu:gpudiag:python-dep{python3}:help{gpudiag --idc}\n';
    fs.writeFileSync(path.join(f.bundle, RULES), rules);
    const oldGpuFiles = ['gpu_snapshot.py', 'collectors/__init__.py', 'collectors/gpu.py', 'light_inspect_compat.py']
      .map(name => `${TOOLS}/light_inspect/${name}`);
    if (includeGpuFiles) for (const relative of oldGpuFiles) write(path.join(f.bundle, relative), '# inert obsolete dependency\n', 0o755);
    rewriteManifest(f.bundle, manifest => {
      manifest.commands = [...LEGACY_COMMANDS, 'gpudiag'];
      delete manifest.safe_profiles.ai;
      manifest.safe_profiles.gpudiag = ['--idc'];
      delete manifest.files[`${TOOLS}/ai`];
      manifest.files[gpudiag] = sha256(Buffer.from(data));
      manifest.files[RULES] = sha256(Buffer.from(rules));
      if (includeGpuFiles) for (const relative of oldGpuFiles) manifest.files[relative] = sha256(fs.readFileSync(path.join(f.bundle, relative)));
    });
    assert.equal(fileList(f.bundle).length, includeGpuFiles ? 29 : 25);
    const before = snapshot(f.bundle);
    const modes = modeSnapshot(f.bundle);
    assert.throws(() => verifyBundle(f.bundle), /Unexpected file/);
    assert.throws(f.prepare, /Unexpected file/);
    assert.notEqual(installManifestCheck(f.bundle).status, 0);
    assert.deepEqual(snapshot(f.bundle), before);
    assert.deepEqual(modeSnapshot(f.bundle), modes);
    assert.deepEqual(fs.readdirSync(path.dirname(f.bundle)), ['sysak']);
  });
}

test('former ai bundle with four hashed light_inspect dependencies is rejected, never silently upgraded', t => {
  const f = fixture(t);
  f.prepare();
  const files = ['gpu_snapshot.py', 'collectors/__init__.py', 'collectors/gpu.py', 'light_inspect_compat.py']
    .map(name => `${TOOLS}/light_inspect/${name}`);
  for (const relative of files) write(path.join(f.bundle, relative), '# inert former GPU dependency\n', 0o755);
  rewriteManifest(f.bundle, manifest => {
    for (const relative of files) manifest.files[relative] = sha256(fs.readFileSync(path.join(f.bundle, relative)));
    assert.equal(Object.keys(manifest.files).length, 28);
  });
  const before = snapshot(f.bundle);
  const modes = modeSnapshot(f.bundle);
  assert.throws(() => verifyBundle(f.bundle), /Unexpected file/);
  assert.throws(f.prepare, /Unexpected file/);
  assert.notEqual(installManifestCheck(f.bundle).status, 0);
  assert.deepEqual(snapshot(f.bundle), before);
  assert.deepEqual(modeSnapshot(f.bundle), modes);
  assert.deepEqual(fs.readdirSync(path.dirname(f.bundle)), ['sysak']);
});

test('a fully validated three-command bundle upgrades atomically; normal verification accepts only the new closure', t => {
  const f = fixture(t);
  legacyBundle(f);
  const oldManifest = JSON.parse(fs.readFileSync(path.join(f.bundle, 'manifest.json'), 'utf8'));
  assert.throws(() => verifyBundle(f.bundle), /missing required components/);
  const manifest = f.prepare();
  assert.deepEqual(manifest.commands, COMMANDS);
  assert.deepEqual(manifest.safe_profiles, SAFE_PROFILES);
  assert.deepEqual(verifyBundle(f.bundle), manifest);
  for (const relative of LEGACY_FILES.filter(relative => relative !== RULES)) {
    assert.equal(manifest.files[relative], oldManifest.files[relative]);
  }
  assert.deepEqual(fs.readdirSync(path.dirname(f.bundle)), ['sysak']);
});

for (const relative of LEGACY_FILES) {
  test(`legacy upgrade refuses a corrupted component without modifying the bundle: ${relative}`, t => {
    const f = fixture(t);
    legacyBundle(f);
    fs.appendFileSync(path.join(f.bundle, relative), '# corrupted\n');
    const before = snapshot(f.bundle);
    const modes = modeSnapshot(f.bundle);
    assert.throws(f.prepare, /SHA256 mismatch/);
    assert.deepEqual(snapshot(f.bundle), before);
    assert.deepEqual(modeSnapshot(f.bundle), modes);
    assert.deepEqual(fs.readdirSync(path.dirname(f.bundle)), ['sysak']);
  });
}

for (const [label, damage] of [
  ['bad profiles', f => rewriteManifest(f.bundle, m => { m.safe_profiles.memgraph = ['--idc']; })],
  ['bad architecture', f => rewriteManifest(f.bundle, m => { m.arch = 'unknown'; })],
  ['bad schema', f => rewriteManifest(f.bundle, m => { m.schema_version = '2.0'; })],
  ['bad requires', f => rewriteManifest(f.bundle, m => { m.requires = ['python2']; })],
  ['missing hash', f => rewriteManifest(f.bundle, m => { delete m.files.sysak; })],
  ['missing file', f => fs.unlinkSync(path.join(f.bundle, TOOLS, 'idc'))],
  ['writable file', f => fs.chmodSync(path.join(f.bundle, TOOLS, 'idc'), 0o777)],
  ['writable directory', f => fs.chmodSync(path.join(f.bundle, TOOLS), 0o777)],
  ['symlink', f => { fs.unlinkSync(path.join(f.bundle, TOOLS, 'idc')); fs.symlinkSync(path.join(f.source, TOOLS, 'idc'), path.join(f.bundle, TOOLS, 'idc')); }],
  ['unlisted GPU directory', f => fs.mkdirSync(path.join(f.bundle, TOOLS, 'light_inspect'))],
  ['unlisted file', f => write(path.join(f.bundle, TOOLS, 'confscan'), 'untouched')],
  ['unlisted file with digest', f => { write(path.join(f.bundle, TOOLS, 'confscan'), 'untouched'); rewriteManifest(f.bundle, m => { m.files[`${TOOLS}/confscan`] = sha256('untouched'); }); }],
  ['noncanonical rules with matching hash', f => {
    fs.writeFileSync(path.join(f.bundle, RULES), legacyRules.replace('memgraph:python-dep{python3}', 'memgraph:python-dep{all}'));
    rewriteManifest(f.bundle, m => { m.files[RULES] = sha256(fs.readFileSync(path.join(f.bundle, RULES))); });
  }],
  ['wrong ELF with matching hash', f => {
    fs.writeFileSync(path.join(f.bundle, 'sysak'), mockElf(process.arch === 'x64' ? 'arm64' : 'x64'));
    rewriteManifest(f.bundle, m => { m.files.sysak = sha256(fs.readFileSync(path.join(f.bundle, 'sysak'))); });
  }],
  ['python2 entry with matching hash', f => {
    fs.writeFileSync(path.join(f.bundle, TOOLS, 'idc'), '#!/usr/bin/env python\n');
    rewriteManifest(f.bundle, m => { m.files[`${TOOLS}/idc`] = sha256(fs.readFileSync(path.join(f.bundle, TOOLS, 'idc'))); });
  }],
]) {
  test(`legacy upgrade refuses ${label} and leaves bytes/modes untouched`, t => {
    const f = fixture(t);
    legacyBundle(f);
    damage(f);
    const before = snapshot(f.bundle);
    const modes = modeSnapshot(f.bundle);
    assert.throws(f.prepare);
    assert.deepEqual(snapshot(f.bundle), before);
    assert.deepEqual(modeSnapshot(f.bundle), modes);
    assert.deepEqual(fs.readdirSync(path.dirname(f.bundle)), ['sysak']);
  });
}

for (const legacy of [legacyBundle]) for (const failure of ['rename', 'post-install verification', 'rollback']) {
  test(`${legacy.name} atomic upgrade handles ${failure} failure without losing the validated old package`, t => {
    const f = fixture(t);
    legacy(f);
    const before = snapshot(f.bundle);
    const modes = modeSnapshot(f.bundle);
    const rename = fs.renameSync;
    t.mock.method(fs, 'renameSync', (from, to) => {
      if (to === f.bundle && path.basename(from) === 'package' && failure !== 'post-install verification') throw new Error('mock upgrade failure');
      if (to === f.bundle && path.basename(from) === 'previous' && failure === 'rollback') throw new Error('mock rollback failure');
      rename(from, to);
      if (to === f.bundle && path.basename(from) === 'package') fs.appendFileSync(path.join(to, TOOLS, 'ai'), '# corrupted\n');
    });
    assert.throws(f.prepare, failure === 'rollback' ? /rollback failed.*recovery files preserved/ : /mock upgrade failure|SHA256 mismatch/);
    const stages = fs.readdirSync(path.dirname(f.bundle)).filter(name => name.startsWith('.sysak-stage-'));
    const previous = failure === 'rollback' ? path.join(path.dirname(f.bundle), stages[0], 'previous') : f.bundle;
    assert.deepEqual(snapshot(previous), before);
    assert.deepEqual(modeSnapshot(previous), modes);
    assert.throws(() => verifyBundle(previous), /missing required components|Unexpected file/);
    assert.equal(stages.length, failure === 'rollback' ? 1 : 0);
    t.mock.restoreAll();
    if (failure === 'rollback') fs.renameSync(previous, f.bundle); // Recover owned fixture for a fresh upgrade.
    f.prepare();
    assert.deepEqual(verifyBundle(f.bundle).commands, COMMANDS);
  });
}

test('staging failure restores the old bundle and leaves user data unchanged', t => {
  const f = fixture(t);
  f.prepare();
  const before = snapshot(f.bundle);
  fs.appendFileSync(path.join(f.source, TOOLS, 'resource_anomaly_idc.py'), '# changed\n');
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (to === f.bundle && path.basename(from) === 'package') throw new Error('mock rename failure');
    return rename(from, to);
  });
  assert.throws(f.prepare, /mock rename failure/);
  assert.deepEqual(snapshot(f.bundle), before);
  assert.deepEqual(fs.readdirSync(path.dirname(f.bundle)), ['sysak']);
});

test('post-replacement verification failure rolls back without deleting the previous package', t => {
  const f = fixture(t);
  f.prepare();
  const before = snapshot(f.bundle);
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from, to) => {
    rename(from, to);
    if (to === f.bundle && path.basename(from) === 'package') fs.appendFileSync(path.join(to, TOOLS, 'idc'), '# tampered\n');
  });
  assert.throws(f.prepare, /SHA256 mismatch/);
  assert.deepEqual(snapshot(f.bundle), before);
  assert.deepEqual(fs.readdirSync(path.dirname(f.bundle)), ['sysak']);
});

test('rollback failure preserves a recoverable previous package in owned staging', t => {
  const f = fixture(t);
  f.prepare();
  const before = snapshot(f.bundle);
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (to === f.bundle && ['package', 'previous'].includes(path.basename(from))) throw new Error('mock install/rollback failure');
    return rename(from, to);
  });
  assert.throws(f.prepare, /rollback failed.*recovery files preserved/);
  const stages = fs.readdirSync(path.dirname(f.bundle)).filter(name => name.startsWith('.sysak-stage-'));
  assert.equal(stages.length, 1);
  const previous = path.join(path.dirname(f.bundle), stages[0], 'previous');
  assert.deepEqual(snapshot(previous), before);
  verifyBundle(previous);
});

test('normalized bundle modes are reproducible under a restrictive umask', t => {
  const f = fixture(t);
  const previous = process.umask(0o077);
  try { f.prepare(); } finally { process.umask(previous); }
  verifyBundle(f.bundle);
  assert.equal(fs.statSync(f.bundle).mode & 0o7777, 0o755);
  assert.equal(fs.statSync(path.join(f.bundle, 'manifest.json')).mode & 0o7777, 0o644);
  fs.chmodSync(path.join(f.bundle, TOOLS), 0o700);
  assert.throws(() => verifyBundle(f.bundle), /Unsafe bundle directory permissions/);
});

test('preparation lock refuses concurrent/stale operations without deleting the lock', t => {
  const f = fixture(t);
  f.prepare();
  const lock = path.join(f.projectRoot, 'resources/.sysak-prepare.lock');
  write(lock, 'inspect before retrying');
  assert.throws(f.prepare, /stale lock/);
  assert.equal(fs.readFileSync(lock, 'utf8'), 'inspect before retrying');
  verifyBundle(f.bundle);
});

test('ordinary executable modes are normalized; verification rejects privilege bits', t => {
  const f = fixture(t);
  fs.chmodSync(path.join(f.source, 'sysak'), 0o4755); // Mock file only, never a real binary.
  f.prepare();
  for (const relative of EXPECTED_FILES.filter(name => name === 'sysak' ||
      COMMANDS.some(command => name === `${TOOLS}/${command}`) || name.endsWith('.py'))) {
    assert.equal(fs.statSync(path.join(f.bundle, relative)).mode & 0o7777, 0o755);
  }
  fs.chmodSync(path.join(f.bundle, 'sysak'), 0o4755);
  assert.throws(() => verifyBundle(f.bundle), /Unsafe permissions/);
  fs.chmodSync(path.join(f.bundle, 'sysak'), 0o644);
  assert.throws(() => verifyBundle(f.bundle), /non-executable/);
});

test('CLI supports source/env, verifies existing only without source, and --verify ignores env', t => {
  const f = fixture(t);
  const script = path.join(f.projectRoot, 'scripts/prepare-sysak.cjs');
  write(script, fs.readFileSync(path.join(ROOT, 'scripts/prepare-sysak.cjs')));
  const env = { ...process.env };
  delete env.SYSAK_BUNDLE_DIR;
  function cli(args, override = {}) {
    return spawnSync(process.execPath, [script, ...args], { env: { ...env, ...override }, encoding: 'utf8' });
  }
  const missing = cli([]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /No sysAK bundle.*--source/);
  assert.match(missing.stderr, /requires python3/);
  assert.equal(fs.existsSync(f.bundle), false);
  assert.equal(cli(['--source', f.source]).status, 0);
  const before = snapshot(f.bundle);
  assert.equal(cli([]).status, 0);
  assert.equal(cli(['--verify'], { SYSAK_BUNDLE_DIR: '/not/a/real/path' }).status, 0);
  assert.deepEqual(snapshot(f.bundle), before);
  assert.equal(cli([], { SYSAK_BUNDLE_DIR: f.source }).status, 0);
  assert.match(cli(['--verify']).stdout, /requires python3 \(not bundled\)/);
});

function modeSnapshot(root, relative = '') {
  const file = path.join(root, relative);
  const stat = fs.lstatSync(file);
  const modes = { [relative]: stat.mode & 0o7777 };
  if (stat.isDirectory()) {
    for (const name of fs.readdirSync(file)) {
      Object.assign(modes, modeSnapshot(root, relative ? `${relative}/${name}` : name));
    }
  }
  return modes;
}

function packedFixture(t) {
  const f = fixture(t);
  f.prepare();
  const appOutDir = path.join(f.temporary, 'linux-unpacked');
  const bundle = path.join(appOutDir, 'resources/sysak');
  fs.mkdirSync(path.dirname(bundle), { recursive: true });
  fs.cpSync(f.bundle, bundle, { recursive: true });
  write(path.join(appOutDir, 'resources/sysak-root-runner.py'), '# inert root helper fixture\n', 0o664);
  write(path.join(appOutDir, 'resources/gx-runtime.py'), '# inert GX helper fixture\n', 0o664);
  write(path.join(appOutDir, 'resources/sysom-idc.service'), '# inert unit fixture\n', 0o660);
  for (const [relative, mode] of Object.entries(modeSnapshot(bundle))) {
    fs.chmodSync(path.join(bundle, relative), mode & 0o111 ? 0o775 : 0o664);
  }
  return { ...f, appOutDir, packedBundle: bundle };
}

test('afterPack normalizes sysAK and deployment ancestor modes, preserves unrelated content/source and is idempotent', async t => {
  const f = packedFixture(t);
  fs.chmodSync(path.join(f.packedBundle, TOOLS, 'plugin_thpCollect.py'), 0o664);
  write(path.join(f.appOutDir, 'chrome-sandbox'), 'mock sandbox', 0o750);
  write(path.join(f.appOutDir, 'resources/other/keep.txt'), 'unrelated', 0o660);
  fs.chmodSync(f.appOutDir, 0o770);
  fs.chmodSync(path.join(f.appOutDir, 'resources'), 0o770);
  fs.chmodSync(path.join(f.appOutDir, 'resources/other'), 0o770);
  const before = modeSnapshot(f.appOutDir);
  const sourceModes = modeSnapshot(f.source);
  const resourceModes = modeSnapshot(f.bundle);
  const hashes = snapshot(f.appOutDir);
  assert.throws(() => verifyBundle(f.packedBundle), /Unsafe bundle directory permissions/);
  await afterPack({ appOutDir: f.appOutDir });
  assert.deepEqual(verifyBundle(f.packedBundle), verifyBundle(f.bundle));
  const files = new Set([...EXPECTED_FILES, 'manifest.json']);
  for (const [relative, mode] of Object.entries(modeSnapshot(f.packedBundle))) {
    const executable = relative === 'sysak' || COMMANDS.some(command => relative === `${TOOLS}/${command}`) || relative.endsWith('.py');
    assert.equal(mode, !files.has(relative) || executable ? 0o755 : 0o644, relative || '.');
  }
  for (const [relative, mode] of Object.entries(modeSnapshot(f.appOutDir))) {
    if (relative === '' || relative === 'resources') {
      assert.equal(mode, 0o755, `deployment ancestor: ${relative}`);
    } else if (relative === 'resources/sysak-root-runner.py' || relative === 'resources/gx-runtime.py' || relative === 'resources/sysom-idc.service') {
      assert.equal(mode, relative.endsWith('.py') ? 0o755 : 0o644, relative);
    } else if (relative !== 'resources/sysak' && !relative.startsWith('resources/sysak/')) {
      assert.equal(mode, before[relative], `unrelated path: ${relative}`);
    }
  }
  assert.deepEqual(modeSnapshot(f.source), sourceModes);
  assert.deepEqual(modeSnapshot(f.bundle), resourceModes);
  assert.deepEqual(snapshot(f.appOutDir), hashes);
  const normalized = modeSnapshot(f.appOutDir);
  await afterPack({ appOutDir: f.appOutDir });
  assert.deepEqual(modeSnapshot(f.appOutDir), normalized);
});

for (const [label, relative] of [
  ['appOutDir', ''], ['resources', 'resources'], ['sysAK root', 'resources/sysak'],
  ['components directory', 'resources/sysak/.sysak_components'],
  ['tools directory', `resources/sysak/${TOOLS}`],
  ...EXPECTED_FILES.map(relative => [`required file ${relative}`, `resources/sysak/${relative}`]),
  ['manifest', 'resources/sysak/manifest.json'],
  ['root helper', 'resources/sysak-root-runner.py'],
  ['GX helper', 'resources/gx-runtime.py'],
  ['service unit', 'resources/sysom-idc.service'],
]) {
  test(`afterPack rejects a symlink at ${label} before any chmod`, async t => {
    const f = packedFixture(t);
    const original = path.join(f.appOutDir, relative);
    const outside = path.join(f.temporary, 'outside');
    const type = fs.lstatSync(original).isDirectory() ? 'dir' : 'file';
    fs.renameSync(original, outside);
    fs.symlinkSync(outside, original, type);
    const before = modeSnapshot(f.temporary);
    await assert.rejects(afterPack({ appOutDir: f.appOutDir }), /symlink/);
    assert.deepEqual(modeSnapshot(f.temporary), before);
  });
}

test('afterPack rejects symlinked appOutDir ancestors before any chmod', async t => {
  const f = packedFixture(t);
  const alias = path.join(f.temporary, 'linked-parent');
  fs.symlinkSync(f.temporary, alias, 'dir');
  const before = modeSnapshot(f.temporary);
  await assert.rejects(afterPack({ appOutDir: path.join(alias, 'linux-unpacked') }), /symlink/);
  assert.deepEqual(modeSnapshot(f.temporary), before);
});

for (const kind of ['file', 'directory', 'symlink', 'hardlink', 'missing', 'non-regular']) {
  test(`afterPack rejects ${kind} outside the valid whitelist before any chmod`, async t => {
    const f = packedFixture(t);
    const unexpected = path.join(f.packedBundle, 'unexpected');
    if (kind === 'file') write(unexpected, 'keep', 0o660);
    if (kind === 'directory') fs.mkdirSync(unexpected);
    if (kind === 'symlink') fs.symlinkSync(path.join(f.source, 'sysak'), unexpected);
    if (['hardlink', 'missing', 'non-regular'].includes(kind)) {
      const entry = path.join(f.packedBundle, 'sysak');
      fs.unlinkSync(entry);
      if (kind === 'hardlink') fs.linkSync(path.join(f.source, 'sysak'), entry);
      if (kind === 'non-regular') fs.mkdirSync(entry);
    }
    const before = modeSnapshot(f.temporary);
    await assert.rejects(afterPack({ appOutDir: f.appOutDir }), /Unexpected|Unsafe|ENOENT/);
    assert.deepEqual(modeSnapshot(f.temporary), before);
  });
}

test('afterPack refuses source resources and relative output paths', async t => {
  await assert.rejects(afterPack({ appOutDir: ROOT }), /Refusing to chmod source/);
  await assert.rejects(afterPack({ appOutDir: 'linux-unpacked' }), /absolute appOutDir/);
});

test('afterPack still rejects hash tampering after mode normalization', async t => {
  const f = packedFixture(t);
  fs.appendFileSync(path.join(f.packedBundle, TOOLS, 'idc'), '# tamper\n');
  await assert.rejects(afterPack({ appOutDir: f.appOutDir }), /SHA256 mismatch/);
});

test('packaging configuration, build ordering and hooks match the application install path', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.version, JSON.parse(fs.readFileSync(path.join(ROOT, '..', 'package.json'), 'utf8')).version);
  assert.equal(pkg.main, 'electron/main.cjs');
  assert.equal(pkg.build.afterPack, './build/after-pack.cjs');
  assert.equal(typeof afterPack, 'function');
  assert.equal(afterPack.constructor.name, 'AsyncFunction');
  assert.match(pkg.devDependencies.electron, /33/);
  assert.deepEqual(pkg.build.files, ['dist/**/*', 'electron/**/*', 'package.json', 'LICENSE', 'THIRD_PARTY_NOTICES', 'FONT_LICENSE']);
  assert.deepEqual(pkg.build.linux.target, ['AppImage', 'deb']);
  assert.deepEqual(pkg.build.extraResources, [
    { from: 'resources/sysak', to: 'sysak', filter: ['**/*'] },
    { from: 'build/sysak-root-runner.py', to: 'sysak-root-runner.py' },
    { from: 'build/gx-runtime.py', to: 'gx-runtime.py' },
    { from: 'build/sysom-idc.service', to: 'sysom-idc.service' },
  ]);
  assert.equal(pkg.scripts['prepare:sysak'], 'node scripts/prepare-sysak.cjs');
  assert.equal(pkg.scripts['verify:sysak'], 'node scripts/prepare-sysak.cjs --verify');
  assert.equal(pkg.scripts['build:openapi'], 'node scripts/build-openapi.cjs');
  assert.equal(pkg.scripts['build:electron'], 'npm run verify:sysak && npm run build && electron-builder');
  assert.equal(pkg.scripts.build, 'npm run build:openapi && tsc -b && vite build');
  assert.equal(pkg.scripts.dev, 'npm run build:openapi && concurrently -k "vite" "wait-on tcp:127.0.0.1:5173 && electron ."');
  assert.ok(!pkg.build.deb.depends.includes('pkexec'));
  for (const dependency of ['sysom-agentsight-runtime (= 0.16.0)', 'gx (= 0.6.5-2)', 'libc-bin', 'libc6 (>= 2.27)', 'zlib1g', 'libzstd1', 'python3', 'coreutils', 'systemd']) {
    assert.ok(pkg.build.deb.depends.includes(dependency), `missing deb dependency: ${dependency}`);
  }
  assert.equal(pkg.build.deb.afterInstall, 'build/after-install.sh');
  assert.equal(pkg.build.deb.afterRemove, 'build/after-remove.sh');
  const install = fs.readFileSync(path.join(ROOT, pkg.build.deb.afterInstall), 'utf8');
  const remove = fs.readFileSync(path.join(ROOT, pkg.build.deb.afterRemove), 'utf8');
  const appDir = text => /APP_DIR='([^']+)'/.exec(text)[1];
  assert.equal(appDir(install), '/opt/SysAgent管家');
  assert.equal(appDir(remove), appDir(install));
  const unit = fs.readFileSync(path.join(ROOT, 'build/sysom-idc.service'), 'utf8');
  assert.equal(/^ExecStart=(.+)$/m.exec(unit)[1], `/usr/bin/python3 -I -B ${appDir(install)}/resources/sysak-root-runner.py`);
  assert.match(install, /update-alternatives --install '\/usr\/bin\/sysagent-idc' 'sysagent-idc' "\$APP_DIR\/sysagent-idc" 100/);
  assert.match(remove, /update-alternatives --remove 'sysagent-idc' "\$APP_DIR\/sysagent-idc"/);
  assert.match(install, /SYSAK_DIR="\$APP_DIR\/resources\/sysak"/);
  assert.match(install, /ROOT_HELPER="\$APP_DIR\/resources\/sysak-root-runner\.py"/);
  assert.match(install, /command -v python3/);
  assert.match(install, /for file in "\$ROOT_HELPER" "\$GX_HELPER" "\$UNIT_SOURCE" "\$SYSAK_DIR\/sysak"/);
  assert.match(install, /python3 -I -B "\$GX_HELPER"/);
  assert.match(install, /chmod 644 "\$UNIT_SOURCE"/);
  assert.match(install, /require_file "\$file"/);
  assert.match(install, /chmod 755 "\$ROOT_HELPER"/);
  const preflight = install.slice(0, install.indexOf('\nupdate-alternatives --install'));
  assert.ok(preflight.lastIndexOf('require_file ') < preflight.indexOf('\nchmod '));
  assert.ok(preflight.lastIndexOf('require_file ') < preflight.indexOf('\nchown '));
  for (const module of DIAGNOSTIC_MODULES) assert.ok(install.includes(module));
  for (const command of COMMANDS) assert.ok(install.includes(`"$TOOLS_DIR/${command}"`));
  assert.doesNotMatch(install, /confscan|light_inspect|gpudiag/);
  assert.match(install, /chmod 755 "\$SYSAK_DIR\/sysak" "\$TOOLS_DIR\/idc"/);
  assert.match(install, /chown root:root "\$APP_DIR\/chrome-sandbox"/);
  assert.match(install, /chmod 4755 "\$APP_DIR\/chrome-sandbox"/);
  assert.match(remove, /remove\|purge\)/);
  for (const hook of [install, remove]) {
    assert.doesNotMatch(hook, /\/usr\/(?:s?bin)\/sysak\b|\bsysak\.service\b|\/var\/log\/sysak|\bpkexec\b|\b(?:usermod|groupadd|chgrp)\b/);
    assert.match(hook, /UNIT_FILE='\/etc\/systemd\/system\/sysom-idc\.service'/);
    assert.match(hook, /CONFIG_DIR='\/etc\/sysom-idc'/);
    const services = hook.split('\n').map(line => line.trim()).filter(line => /^systemctl\b/.test(line));
    assert.deepEqual(services, hook === install ? [
      'systemctl daemon-reload', 'systemctl enable sysom-idc.service', 'systemctl restart sysom-idc.service',
    ] : []);
    assert.doesNotMatch(hook, /\brm\s+-[^\n]*r|\bsudo\s+(?!env)/);
    assert.equal(hook.split('\n').filter(line => /\brm\b/.test(line)).length, hook === install ? 0 : 2);
    const ownership = hook.split('\n').map(line => line.trim()).filter(line => /^chown\b/.test(line));
    assert.deepEqual(ownership, hook === install ? [
      'chown root:root "$APP_DIR" "$APP_DIR/resources" "$SYSAK_DIR" "$SYSAK_DIR/.sysak_components" "$TOOLS_DIR" "$ROOT_HELPER" "$GX_HELPER" "$UNIT_SOURCE"',
      'chown root:root "$SYSAK_DIR/sysak" "$SYSAK_DIR/manifest.json" "$TOOLS_DIR/.sysak.rules" "$TOOLS_DIR/idc" "$TOOLS_DIR/resource_anomaly" "$TOOLS_DIR/memgraph" "$TOOLS_DIR/ai"',
      'chown root:root "$TOOLS_DIR/$module.py"',
      'chown root:root "$APP_DIR/chrome-sandbox"',
    ] : []);
    const privilegedModes = hook.split('\n').map(line => line.trim()).filter(line => {
      if (!/^chmod\b/.test(line)) return false;
      const mode = /^chmod ([0-7]{3,4}) /.exec(line);
      assert.ok(mode, `chmod must use an explicit ordinary/setuid mode: ${line}`);
      return (parseInt(mode[1], 8) & 0o7000) !== 0;
    });
    assert.deepEqual(privilegedModes, hook === install ? ['chmod 4755 "$APP_DIR/chrome-sandbox"'] : []);
    assert.match(hook, /update-desktop-database \/usr\/share\/applications/);
  }
});

function serviceHookFixture(t, { systemd = true } = {}) {
  const f = fixture(t);
  f.prepare();
  const installed = installResourcePreflight(f);
  const etc = path.join(f.temporary, 'etc');
  const unitDirectory = path.join(etc, 'systemd/system');
  const config = path.join(etc, 'sysom-idc');
  const unit = path.join(unitDirectory, 'sysom-idc.service');
  const auth = path.join(config, 'allowed-uid');
  const running = path.join(f.temporary, 'run/systemd/system');
  fs.mkdirSync(unitDirectory, { recursive: true, mode: 0o755 });
  if (systemd) fs.mkdirSync(running, { recursive: true, mode: 0o755 });
  const commands = path.join(f.temporary, 'commands');
  const log = path.join(f.temporary, 'commands.jsonl');
  const mock = `#!${process.execPath}
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const command = path.basename(process.argv[1]);
const args = process.argv.slice(2);
fs.appendFileSync(process.env.HOOK_LOG, JSON.stringify([command, ...args]) + '\\n');
const base = process.env.FIXTURE;
function owned(file) {
  if (!path.isAbsolute(file) || !(file === base || file.startsWith(base + '/')) || path.resolve(file) !== file) throw new Error('Outside owned fixture: ' + file);
  let parent = path.dirname(file);
  while (parent !== base) {
    if (fs.existsSync(parent) && fs.lstatSync(parent).isSymbolicLink()) throw new Error('Symlink ancestor: ' + parent);
    parent = path.dirname(parent);
  }
  return file;
}
function out(value) { process.stdout.write(String(value) + '\\n'); }
switch (command) {
  case 'id': out(process.env.MOCK_ROOT_UID || '0'); break;
  case 'python3': if (process.env.PIDFD_SUPPORTED === '0') process.exit(1); break; // Never execute runner or bundled collector.
  case 'stat': {
    const [flag, format, dash, file] = args;
    if (flag !== '-c' || dash !== '--') throw new Error('Unexpected stat argv');
    if (format === '%u:%g') out(file === process.env.UNSAFE_OWNER ? '1000:1000' : '0:0');
    else if (format === '%a') out(file === base || !file.startsWith(base + '/') ? '755' : (fs.lstatSync(owned(file)).mode & 0o7777).toString(8));
    else if (format === '%h') out(fs.lstatSync(owned(file)).nlink);
    else throw new Error('Unexpected stat format');
    break;
  }
  case 'getent': {
    const uid = args[1];
    if (args[0] !== 'passwd' || !['1', '1000', '1001', '2000', '4294967294'].includes(uid)) process.exit(2);
    out('desktop:x:' + uid + ':' + (uid === '2000' ? '0' : '1000') + ':fixture:/nonexistent:/bin/false');
    break;
  }
  case 'chmod': {
    const mode = parseInt(args[0], 8);
    for (const file of args.slice(1)) fs.chmodSync(owned(file), mode); // Owned inert fixture only.
    break;
  }
  case 'chown': for (const file of args.slice(1)) owned(file); break; // No real ownership changes.
  case 'install': {
    if (args[0] === '-d') {
      if (JSON.stringify(args.slice(1, 8)) !== JSON.stringify(['-o', 'root', '-g', 'root', '-m', '755', '--'])) throw new Error('Unexpected directory install');
      const destination = owned(args[8]);
      if (destination !== process.env.CONFIG) throw new Error('Unscoped directory install');
      fs.mkdirSync(destination, { recursive: true }); fs.chmodSync(destination, 0o755);
    } else {
      if (JSON.stringify(args.slice(0, 8)) !== JSON.stringify(['-T', '-o', 'root', '-g', 'root', '-m', '644', '--'])) throw new Error('Unexpected file install');
      const source = args[8], destination = owned(args[9]);
      if (![process.env.UNIT, process.env.AUTH].includes(destination)) throw new Error('Unscoped file install');
      const bytes = fs.readFileSync(source === '/dev/stdin' ? 0 : owned(source));
      fs.writeFileSync(destination, bytes); fs.chmodSync(destination, 0o644);
    }
    break;
  }
  case 'systemctl':
    if (args[0] === 'is-system-running') {
      const state = process.env.SYSTEMD_STATE || 'running';
      out(state);
      if (state !== 'running') process.exit(1);
    } else if (!(['daemon-reload'].includes(args[0]) && args.length === 1) &&
      !(args.at(-1) === 'sysom-idc.service' && ['enable', 'restart', 'disable'].includes(args[0]))) throw new Error('Unscoped service command');
    break; // No real systemctl can be reached.
  case 'wc': {
    const bytes = fs.readFileSync(0);
    out(args[0] === '-c' ? bytes.length : [...bytes].filter(byte => byte === 10).length);
    break;
  }
  case 'rm': {
    if (args[0] !== '-f' || args[1] !== '--' || args.length !== 3 || ![process.env.UNIT, process.env.AUTH].includes(args[2])) throw new Error('Unscoped rm');
    fs.unlinkSync(owned(args[2])); break;
  }
  case 'rmdir':
    if (args[0] !== '--' || args.length !== 2 || args[1] !== process.env.CONFIG) throw new Error('Unscoped rmdir');
    try { fs.rmdirSync(owned(args[1])); } catch { process.exit(1); }
    break;
  case 'update-alternatives':
    if (args[0] === '--remove' && (args[1] !== 'sysagent-idc' || args[2] !== process.env.APP + '/sysagent-idc')) throw new Error('Unscoped alternatives removal');
    break;
  case 'update-desktop-database': case 'gtk-update-icon-cache': break;
  default: throw new Error('Unexpected command: ' + command);
}
`;
  for (const command of ['id', 'stat', 'python3', 'getent', 'chmod', 'chown', 'install', 'systemctl',
    'wc', 'rm', 'rmdir', 'update-alternatives', 'update-desktop-database', 'gtk-update-icon-cache']) {
    write(path.join(commands, command), mock, 0o755);
  }
  write(path.join(installed.appDir, 'chrome-sandbox'), 'inert sandbox fixture');
  const keep = path.join(f.temporary, 'user-data/keep');
  write(keep, 'preserved');
  function run(hook, operation, env = {}) {
    const script = fs.readFileSync(path.join(ROOT, 'build', hook), 'utf8')
      .replace("APP_DIR='/opt/SysAgent管家'", `APP_DIR='${installed.appDir}'`)
      .replace("UNIT_FILE='/etc/systemd/system/sysom-idc.service'", `UNIT_FILE='${unit}'`)
      .replace("CONFIG_DIR='/etc/sysom-idc'", `CONFIG_DIR='${config}'`)
      .replaceAll("'/etc/systemd/system'", `'${unitDirectory}'`)
      .replaceAll("'/etc'", `'${etc}'`)
      .replace('/run/systemd/system', running);
    assert.doesNotMatch(script, /\/opt\/SysAgent|['"]\/etc|\[ -d \/run\/systemd/);
    // Shell mocks avoid Node startups; only stat/chmod touch owned fixtures.
    const fastMocks = `
fixture_path() {
    case "$1" in "$FIXTURE"|"$FIXTURE"/*) ;; *) exit 98 ;; esac
    case "$1" in *'/../'*|*'/./'*|*'//'*) exit 98 ;; esac
    [ "$1" != "$FIXTURE" ] || return 0
    parent=\${1%/*}
    while [ "$parent" != "$FIXTURE" ]; do
        [ ! -L "$parent" ] || exit 98
        parent=\${parent%/*}
    done
}
log_args() {
    printf '["%s"' "$1"
    shift
    for arg do printf ',"%s"' "$arg"; done
    printf ']\\n'
}
id() {
    log_args id "$@" >> "$HOOK_LOG"
    printf '%s\\n' "\${MOCK_ROOT_UID:-0}"
}
python3() {
    log_args python3 "$@" >> "$HOOK_LOG"
    [ "\${PIDFD_SUPPORTED:-}" != 0 ]
}
chown() {
    log_args chown "$@" >> "$HOOK_LOG"
    shift
    for file do fixture_path "$file"; done
}
chmod() {
    log_args chmod "$@" >> "$HOOK_LOG"
    mode=$1
    shift
    for file do fixture_path "$file"; done
    /bin/chmod "$mode" "$@"
}
stat() {
    [ "$1" = -c ] && [ "$3" = -- ] && [ "$#" = 4 ] || exit 98
    printf '["stat","-c","%s","--","%s"]\\n' "$2" "$4" >> "$HOOK_LOG"
    case "$2" in
        %u:%g)
            if [ "$4" = "\${UNSAFE_OWNER:-}" ]; then printf '1000:1000\\n'; else printf '0:0\\n'; fi ;;
        %a)
            case "$4" in
                "$FIXTURE"|"$FIXTURE"/*) /usr/bin/stat -c %a -- "$4" ;;
                *) printf '755\\n' ;;
            esac ;;
        %h)
            case "$4" in
                "$FIXTURE"/*) /usr/bin/stat -c %h -- "$4" ;;
                *) exit 98 ;;
            esac ;;
        *) exit 98 ;;
    esac
}
`;
    const result = spawnSync('/bin/sh', ['-c', fastMocks + script, 'inert-hook', operation], {
      encoding: 'utf8', cwd: f.temporary, timeout: 15000,
      env: { PATH: commands, HOOK_LOG: log, FIXTURE: f.temporary, APP: installed.appDir,
        CONFIG: config, UNIT: unit, AUTH: auth, ...env },
    });
    assert.ifError(result.error);
    return result;
  }
  return { ...f, installed, etc, config, unitDirectory, unit, auth, running, keep,
    runInstall: env => run('after-install.sh', 'configure', env),
    runRemove: (operation, env) => run('after-remove.sh', operation, env),
    calls: () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [],
    clear: () => { if (fs.existsSync(log)) fs.unlinkSync(log); },
  };
}

const serviceCalls = f => f.calls().filter(args => args[0] === 'systemctl');

test('missing Python/kernel pidfd support fails before any service or resource mutation', t => {
  const f = serviceHookFixture(t);
  const before = modeSnapshot(f.installed.appDir);
  const result = f.runInstall({ SYSOM_IDC_UID: '1000', PIDFD_SUPPORTED: '0' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /os.pidfd_open.*kernel 5.3.*no service fallback/);
  assert.ok(!f.calls().some(args => ['chmod', 'chown', 'install', 'systemctl'].includes(args[0])));
  assert.deepEqual(modeSnapshot(f.installed.appDir), before);
});

test('installs the exact unit and one ordinary UID, then enables/restarts only the IDC service', t => {
  const f = serviceHookFixture(t);
  const result = f.runInstall({ SYSOM_IDC_UID: '001000', SUDO_UID: '1001' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(f.auth, 'utf8'), '1000\n');
  assert.equal(fs.statSync(f.auth).mode & 0o7777, 0o644);
  assert.equal(fs.statSync(f.config).mode & 0o7777, 0o755);
  assert.equal(fs.statSync(f.unit).mode & 0o7777, 0o644);
  assert.deepEqual(fs.readFileSync(f.unit), fs.readFileSync(f.installed.unit));
  assert.deepEqual(serviceCalls(f), [['systemctl', 'is-system-running'], ['systemctl', 'daemon-reload'],
    ['systemctl', 'enable', 'sysom-idc.service'], ['systemctl', 'restart', 'sysom-idc.service']]);
  assert.equal(fs.readFileSync(f.keep, 'utf8'), 'preserved');
});

for (const target of ['appDir', 'resources', 'bundle', 'helper', 'unit', ...COMMANDS,
  ...DIAGNOSTIC_MODULES.map(name => `${name}.py`)]) {
  for (const kind of ['non-root owner', 'writable']) {
    test(`installer refuses untrusted packaged resource ${target} (${kind}) before changing ownership/modes`, t => {
      const f = serviceHookFixture(t);
      const file = target === 'resources' ? path.join(f.installed.appDir, 'resources')
        : COMMANDS.includes(target) || target.endsWith('.py')
          ? path.join(f.installed.bundle, TOOLS, target) : f.installed[target];
      if (kind === 'writable') fs.chmodSync(file, fs.statSync(file).isDirectory() ? 0o777 : 0o666);
      const before = modeSnapshot(f.installed.appDir);
      const result = f.runInstall({ SYSOM_IDC_UID: '1000', ...(kind === 'non-root owner' ? { UNSAFE_OWNER: file } : {}) });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /unsafe root service/);
      assert.ok(!f.calls().some(args => ['chmod', 'chown', 'install', 'systemctl'].includes(args[0])));
      assert.deepEqual(modeSnapshot(f.installed.appDir), before);
    });
  }
}

test('SUDO_UID is accepted once; upgrades preserve secure authorization unless explicitly replaced', t => {
  const f = serviceHookFixture(t);
  assert.equal(f.runInstall({ SUDO_UID: '1000' }).status, 0);
  const before = fs.readFileSync(f.auth);
  const inode = fs.statSync(f.auth).ino;
  f.clear();
  const upgrade = f.runInstall();
  assert.equal(upgrade.status, 0, upgrade.stderr);
  assert.deepEqual(fs.readFileSync(f.auth), before);
  assert.equal(fs.statSync(f.auth).ino, inode);
  assert.equal(f.calls().filter(args => args[0] === 'install' && args.at(-1) === f.auth).length, 0);
  assert.equal(f.runInstall({ SYSOM_IDC_UID: '1001' }).status, 0);
  assert.equal(fs.readFileSync(f.auth, 'utf8'), '1001\n');
});

test('missing authorization never guesses a desktop UID or starts/enables a service', t => {
  const f = serviceHookFixture(t);
  const result = f.runInstall();
  assert.equal(result.status, 0, result.stderr);
  assert.ok(fs.existsSync(f.unit));
  assert.ok(!fs.existsSync(f.auth));
  assert.match(result.stderr, /no authorized UID.*not enabled or started/);
  assert.match(result.stderr, /sudo env SYSOM_IDC_UID=/);
  assert.deepEqual(serviceCalls(f), [['systemctl', 'is-system-running'], ['systemctl', 'daemon-reload']]);
  assert.ok(!f.calls().some(args => args[0] === 'getent'));
});

for (const uid of ['', '0', '-1', '4294967295', '4294967296', '99999999999999999999', 'nobody',
  '1000;touch injected', '$(touch injected)', '1000\n1001', '1000:1001', '1234', '2000']) {
  test(`authorization rejects invalid/nonexistent/root-group UID without installation/start: ${JSON.stringify(uid)}`, t => {
    const f = serviceHookFixture(t);
    const result = f.runInstall({ SYSOM_IDC_UID: uid, SUDO_UID: '1000' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /authorization requires/);
    assert.deepEqual(serviceCalls(f), []);
    assert.ok(!f.calls().some(args => args[0] === 'install'));
    assert.ok(!fs.existsSync(f.auth));
    assert.ok(!fs.existsSync(path.join(f.temporary, 'injected')));
  });
}

for (const uid of ['1', '4294967294']) {
  test(`authorization accepts numeric boundary UID ${uid} with an existing non-root GID`, t => {
    const f = serviceHookFixture(t);
    const result = f.runInstall({ SYSOM_IDC_UID: uid });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readFileSync(f.auth, 'utf8'), uid + '\n');
  });
}

for (const { systemd, state } of [{ systemd: false }, { systemd: true, state: 'offline' }, { systemd: true, state: 'starting' }]) {
  test(`without running systemd the package has no service fallback (${systemd ? state : 'no runtime directory'})`, t => {
    const f = serviceHookFixture(t, { systemd });
    const result = f.runInstall({ SYSOM_IDC_UID: '1000', SYSTEMD_STATE: state || '' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /systemd is not running.*No fallback/);
    assert.deepEqual(serviceCalls(f), systemd ? [['systemctl', 'is-system-running']] : []);
    f.clear();
    const remove = f.runRemove('remove', { SYSTEMD_STATE: state || '' });
    assert.equal(remove.status, 0, remove.stderr);
    assert.deepEqual(serviceCalls(f), systemd ? [['systemctl', 'is-system-running']] : []);
    assert.ok(!fs.existsSync(f.unit));
    assert.ok(fs.existsSync(f.auth));
  });
}

test('degraded systemd can activate the authorized service', t => {
  const f = serviceHookFixture(t);
  const result = f.runInstall({ SYSOM_IDC_UID: '1000', SYSTEMD_STATE: 'degraded' });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(serviceCalls(f).some(args => args[1] === 'restart'));
});

test('old postrm is inert for upgrades; remove preserves authorization; purge deletes only exact files', t => {
  const f = serviceHookFixture(t);
  assert.equal(f.runInstall({ SYSOM_IDC_UID: '1000' }).status, 0);
  write(path.join(f.config, 'other-data'), 'preserved');
  write(path.join(f.unitDirectory, 'confmon.service'), 'other product unit');
  const before = snapshot(f.etc);
  f.clear();
  for (const operation of ['upgrade', 'failed-upgrade', 'abort-install', 'abort-upgrade', 'disappear']) {
    const result = f.runRemove(operation);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(f.calls(), []);
    assert.deepEqual(snapshot(f.etc), before);
  }
  const removed = f.runRemove('remove');
  assert.equal(removed.status, 0, removed.stderr);
  assert.deepEqual(serviceCalls(f), [['systemctl', 'is-system-running'],
    ['systemctl', 'disable', '--now', 'sysom-idc.service'], ['systemctl', 'daemon-reload']]);
  assert.ok(!fs.existsSync(f.unit));
  assert.ok(fs.existsSync(f.auth));
  assert.deepEqual(f.calls().filter(args => args[0] === 'rm'), [['rm', '-f', '--', f.unit]]);
  const stopIndex = f.calls().findIndex(args => args[0] === 'systemctl' && args[1] === 'disable');
  const removeIndex = f.calls().findIndex(args => args[0] === 'rm');
  const reloadIndex = f.calls().findIndex(args => args[0] === 'systemctl' && args[1] === 'daemon-reload');
  assert.ok(stopIndex < removeIndex && removeIndex < reloadIndex);
  f.clear();
  const purged = f.runRemove('purge');
  assert.equal(purged.status, 0, purged.stderr);
  assert.ok(!fs.existsSync(f.auth));
  assert.equal(fs.readFileSync(path.join(f.config, 'other-data'), 'utf8'), 'preserved');
  assert.equal(fs.readFileSync(path.join(f.unitDirectory, 'confmon.service'), 'utf8'), 'other product unit');
  assert.equal(fs.readFileSync(f.keep, 'utf8'), 'preserved');
  assert.deepEqual(f.calls().filter(args => ['rm', 'rmdir'].includes(args[0])),
    [['rm', '-f', '--', f.auth], ['rmdir', '--', f.config]]);
});

test('purge removes the now-empty owned configuration directory', t => {
  const f = serviceHookFixture(t);
  assert.equal(f.runInstall({ SYSOM_IDC_UID: '1000' }).status, 0);
  f.clear();
  const result = f.runRemove('purge');
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!fs.existsSync(f.config));
  assert.deepEqual(f.calls().filter(args => args[0] === 'rm'),
    [['rm', '-f', '--', f.unit], ['rm', '-f', '--', f.auth]]);
});

for (const leaf of ['unit', 'auth']) {
  for (const kind of ['symlink', 'dangling symlink', 'directory', 'hardlink', 'writable', 'non-root owner']) {
    test(`unsafe ${leaf} (${kind}) is refused before service installation or removal`, t => {
      const f = serviceHookFixture(t);
      fs.mkdirSync(f.config, { mode: 0o755 });
      const file = f[leaf];
      const outside = path.join(f.temporary, 'outside-file');
      write(outside, '1000\n');
      if (kind.endsWith('symlink')) fs.symlinkSync(kind === 'symlink' ? outside : outside + '-missing', file);
      else if (kind === 'directory') fs.mkdirSync(file);
      else if (kind === 'hardlink') fs.linkSync(outside, file);
      else write(file, '1000\n', kind === 'writable' ? 0o666 : 0o644);
      const env = kind === 'non-root owner' ? { UNSAFE_OWNER: file } : {};
      const before = snapshot(f.etc);
      const result = f.runInstall(env);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /unsafe/);
      assert.deepEqual(serviceCalls(f), []);
      assert.ok(!f.calls().some(args => args[0] === 'install'));
      assert.deepEqual(snapshot(f.etc), before);
      f.clear();
      const remove = f.runRemove(leaf === 'auth' ? 'purge' : 'remove', env);
      assert.notEqual(remove.status, 0);
      assert.deepEqual(serviceCalls(f), []);
      assert.ok(!f.calls().some(args => ['rm', 'rmdir'].includes(args[0])));
      assert.deepEqual(snapshot(f.etc), before);
      assert.equal(fs.readFileSync(outside, 'utf8'), '1000\n');
    });
  }
}

for (const directory of ['config', 'unitDirectory']) {
  for (const kind of ['symlink', 'writable', 'non-root owner', 'file']) {
    test(`unsafe service destination ancestor ${directory} (${kind}) is refused`, t => {
      const f = serviceHookFixture(t);
      const target = f[directory];
      if (fs.existsSync(target)) fs.renameSync(target, target + '-saved');
      if (kind === 'symlink') fs.symlinkSync(f.temporary, target, 'dir');
      else if (kind === 'file') write(target, 'not directory');
      else fs.mkdirSync(target, { mode: kind === 'writable' ? 0o777 : 0o755 });
      if (kind === 'writable') fs.chmodSync(target, 0o777);
      const env = { SYSOM_IDC_UID: '1000', ...(kind === 'non-root owner' ? { UNSAFE_OWNER: target } : {}) };
      const before = snapshot(f.etc);
      const result = f.runInstall(env);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /unsafe/);
      assert.deepEqual(serviceCalls(f), []);
      assert.ok(!f.calls().some(args => args[0] === 'install'));
      assert.deepEqual(snapshot(f.etc), before);
      f.clear();
      assert.notEqual(f.runRemove('purge', env).status, 0);
      assert.deepEqual(serviceCalls(f), []);
      assert.deepEqual(snapshot(f.etc), before);
    });
  }
}

for (const value of ['0\n', '1000\n1001\n', '1000\n\n', '1000\n1001', '1000\0\n', '999999999999999\n', '1000;id\n', '2000\n']) {
  test(`upgrade rejects invalid stored authorization ${JSON.stringify(value)}`, t => {
    const f = serviceHookFixture(t);
    write(f.auth, value);
    const result = f.runInstall();
    assert.notEqual(result.status, 0);
    assert.deepEqual(serviceCalls(f), []);
    assert.ok(!f.calls().some(args => args[0] === 'install'));
    assert.equal(fs.readFileSync(f.auth, 'utf8'), value);
  });
}

test('ordinary users cannot invoke installation/removal hooks; old postrm still remains inert', t => {
  const f = serviceHookFixture(t);
  const env = { MOCK_ROOT_UID: '1000', SYSOM_IDC_UID: '1000' };
  assert.notEqual(f.runInstall(env).status, 0);
  assert.deepEqual(f.calls(), [['id', '-u']]);
  f.clear();
  assert.notEqual(f.runRemove('remove', env).status, 0);
  assert.deepEqual(f.calls(), [['id', '-u']]);
  f.clear();
  assert.equal(f.runRemove('upgrade', env).status, 0);
  assert.deepEqual(f.calls(), []);
});

function installResourcePreflight(f) {
  const appDir = path.join(f.temporary, 'installed-app');
  const bundle = path.join(appDir, 'resources/sysak');
  const helper = path.join(appDir, 'resources/sysak-root-runner.py');
  const gxHelper = path.join(appDir, 'resources/gx-runtime.py');
  const unit = path.join(appDir, 'resources/sysom-idc.service');
  const log = path.join(f.temporary, 'preflight-chown.argv');
  fs.mkdirSync(path.dirname(bundle), { recursive: true });
  fs.cpSync(f.bundle, bundle, { recursive: true });
  // Neither fixture contains executable service/collector code.
  write(helper, '# inert helper fixture\n');
  write(gxHelper, '# inert GX helper fixture\n');
  write(unit, '# inert unit fixture\n');
  for (const relative of Object.keys(modeSnapshot(appDir))) {
    const file = path.join(appDir, relative);
    fs.chmodSync(file, fs.lstatSync(file).isDirectory() ? 0o700 : 0o600);
  }
  const install = fs.readFileSync(path.join(ROOT, 'build/after-install.sh'), 'utf8');
  const boundary = install.indexOf('\nupdate-alternatives --install');
  assert.ok(boundary > 0);
  const assignment = "APP_DIR='/opt/SysAgent管家'";
  assert.equal(install.split(assignment).length, 2);
  const quote = value => `'${value.replace(/'/g, "'\\''")}'`;
  const script = install.slice(0, boundary).replace(assignment, `APP_DIR=${quote(appDir)}`);
  assert.doesNotMatch(script, /\/opt\/|\b(?:update-alternatives|chrome-sandbox|update-desktop-database|gtk-update-icon-cache|sudo|systemctl)\b/);
  // Empty PATH and shell functions prevent any real ownership/installation
  // command. Only chmod on the temporary resources can reach a system binary.
  const inertCommands = `
python3() { :; }
id() { printf '0\\n'; }
stat() {
    format=$2
    shift 3
    case "$format" in
        %u:%g) printf '0:0\\n' ;;
        %a) printf '755\\n' ;;
        %h) /usr/bin/stat -c %h -- "$1" ;;
        *) exit 98 ;;
    esac
}
chown() {
    printf '%s\\000' "$@" >> "$CHOWN_LOG"
    printf '\\n' >> "$CHOWN_LOG"
}
chmod() {
    mode=$1
    shift
    for target do
        case "$target" in
            "$APP_DIR"|"$APP_DIR/resources"|"$APP_DIR/resources/"*) ;;
            *) printf 'Refusing chmod outside temporary resources: %s\\n' "$target" >&2; exit 97 ;;
        esac
    done
    /bin/chmod "$mode" "$@"
}
`;
  return {
    appDir, bundle, helper, gxHelper, unit,
    chownCalls: () => !fs.existsSync(log) ? [] : fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map(line => {
      const args = line.split('\0');
      assert.equal(args.pop(), '');
      return args;
    }),
    run: () => spawnSync('/bin/sh', ['-c', inertCommands + script], {
      encoding: 'utf8', cwd: f.temporary, env: { PATH: '', CHOWN_LOG: log },
    }),
  };
}

test('installer preflight covers all private components and restores ordinary-user modes', t => {
  const f = fixture(t);
  f.prepare();
  const installed = installResourcePreflight(f);
  write(path.join(installed.appDir, 'resources/other/keep'), 'unrelated resource', 0o600);
  const before = snapshot(installed.appDir);
  const sourceBefore = snapshot(f.bundle);
  const sourceModes = modeSnapshot(f.bundle);
  const result = installed.run();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(snapshot(installed.appDir), before);
  assert.deepEqual(snapshot(f.bundle), sourceBefore);
  assert.deepEqual(modeSnapshot(f.bundle), sourceModes);
  assert.equal(fs.statSync(installed.helper).mode & 0o7777, 0o755);
  assert.equal(fs.statSync(installed.gxHelper).mode & 0o7777, 0o755);
  assert.equal(fs.statSync(installed.unit).mode & 0o7777, 0o644);
  assert.equal(fs.statSync(path.join(installed.appDir, 'resources')).mode & 0o7777, 0o755);
  assert.equal(fs.statSync(installed.appDir).mode & 0o7777, 0o755);
  assert.equal(fs.statSync(path.join(installed.appDir, 'resources/other/keep')).mode & 0o7777, 0o600);
  for (const relative of [...EXPECTED_FILES, 'manifest.json']) {
    const executable = relative === 'sysak' || relative.endsWith('.py') || COMMANDS.some(name => relative === `${TOOLS}/${name}`);
    assert.equal(fs.statSync(path.join(installed.bundle, relative)).mode & 0o7777, executable ? 0o755 : 0o644, relative);
  }
  for (const relative of ['', ...DIRECTORIES]) {
    assert.equal(fs.statSync(path.join(installed.bundle, relative)).mode & 0o7777, 0o755, relative);
  }
  verifyBundle(installed.bundle);
});

for (const relative of [...EXPECTED_FILES, 'manifest.json']) {
  test(`installer preflight rejects missing private component before changing permissions: ${relative}`, t => {
    const f = fixture(t);
    f.prepare();
    const installed = installResourcePreflight(f);
    fs.unlinkSync(path.join(installed.bundle, relative));
    const before = modeSnapshot(installed.appDir);
    const contents = snapshot(installed.appDir);
    const result = installed.run();
    assert.notEqual(result.status, 0);
    assert.ok(result.stderr.includes(relative));
    assert.deepEqual(modeSnapshot(installed.appDir), before);
    assert.deepEqual(snapshot(installed.appDir), contents);
    assert.deepEqual(installed.chownCalls(), []);
  });
}

test('installer preflight records root:root argv for every fixed resource using inert chown only', t => {
  const f = fixture(t);
  f.prepare();
  const installed = installResourcePreflight(f);
  write(path.join(installed.appDir, 'resources/unrelated'), 'not a root-owned bundle resource', 0o600);
  const result = installed.run();
  assert.equal(result.status, 0, result.stderr);
  const tools = path.join(installed.bundle, TOOLS);
  const calls = installed.chownCalls();
  assert.deepEqual(calls, [
    ['root:root', installed.appDir, path.join(installed.appDir, 'resources'), installed.bundle,
      ...DIRECTORIES.map(relative => path.join(installed.bundle, relative)), installed.helper, installed.gxHelper, installed.unit],
    ['root:root', path.join(installed.bundle, 'sysak'), path.join(installed.bundle, 'manifest.json'),
      path.join(tools, '.sysak.rules'), ...COMMANDS.map(name => path.join(tools, name))],
    ...DIAGNOSTIC_MODULES.map(name => ['root:root', path.join(tools, `${name}.py`)]),
  ]);
  const targets = calls.flatMap(args => args.slice(1));
  assert.equal(calls.length, 20);
  assert.equal(targets.length, 33);
  assert.equal(new Set(targets).size, targets.length);
  assert.deepEqual([...targets].sort(), [
    installed.appDir, path.join(installed.appDir, 'resources'), installed.helper, installed.gxHelper, installed.unit,
    ...['', ...DIRECTORIES, ...EXPECTED_FILES, 'manifest.json']
      .map(relative => path.join(installed.bundle, relative)),
  ].sort());
  // These assertions describe requested argv only, not actual root ownership
  // or a system deployment. The injected function never calls real chown.
});

for (const kind of ['missing', 'non-regular directory', 'symlink', 'dangling symlink']) {
  test(`installer preflight rejects ${kind} helper before any chmod or mocked chown`, t => {
    const f = fixture(t);
    f.prepare();
    const installed = installResourcePreflight(f);
    const outside = path.join(f.temporary, 'helper-target');
    if (kind === 'symlink') write(outside, '# inert helper target\n', 0o600);
    fs.unlinkSync(installed.helper);
    if (kind === 'non-regular directory') fs.mkdirSync(installed.helper);
    if (kind.endsWith('symlink')) fs.symlinkSync(outside, installed.helper);
    const modes = modeSnapshot(f.temporary);
    const contents = snapshot(f.temporary);
    const result = installed.run();
    assert.notEqual(result.status, 0);
    assert.ok(result.stderr.includes(installed.helper), result.stderr);
    assert.deepEqual(installed.chownCalls(), []);
    assert.deepEqual(modeSnapshot(f.temporary), modes);
    assert.deepEqual(snapshot(f.temporary), contents);
    if (kind.endsWith('symlink')) assert.equal(fs.lstatSync(installed.helper).isSymbolicLink(), true);
  });
}

for (const name of ['sysak-root-runner.py', 'sysom-idc.service']) {
  for (const kind of ['missing', 'directory', 'hardlink']) {
    test(`afterPack preflights ${name} (${kind}) before changing any inode modes`, async t => {
      const f = packedFixture(t);
      const file = path.join(f.appOutDir, 'resources', name);
      fs.unlinkSync(file);
      if (kind === 'directory') fs.mkdirSync(file);
      if (kind === 'hardlink') fs.linkSync(path.join(f.source, 'sysak'), file);
      const before = modeSnapshot(f.temporary);
      await assert.rejects(afterPack({ appOutDir: f.appOutDir }), /Unsafe|Unexpected|ENOENT/);
      assert.deepEqual(modeSnapshot(f.temporary), before);
    });
  }
  test(`afterPack refuses a replaced ${name} inode without chmodding its replacement`, async t => {
    const f = packedFixture(t);
    const file = path.join(f.appOutDir, 'resources', name);
    const outside = path.join(f.temporary, 'replaced-leaf');
    write(outside, '# inert replacement\n', 0o600);
    const open = fs.openSync;
    t.mock.method(fs, 'openSync', (target, flags, ...rest) => {
      if (target === file) {
        fs.unlinkSync(file);
        fs.renameSync(outside, file);
      }
      return open(target, flags, ...rest);
    });
    await assert.rejects(afterPack({ appOutDir: f.appOutDir }), /changed before chmod/);
    assert.equal(fs.statSync(file).mode & 0o7777, 0o600);
  });
  for (const kind of ['missing', 'directory', 'symlink', 'dangling symlink', 'hardlink']) {
    test(`installer rejects ${name} (${kind}) before any resource chmod/chown`, t => {
      const f = fixture(t);
      f.prepare();
      const installed = installResourcePreflight(f);
      const file = path.join(installed.appDir, 'resources', name);
      const outside = path.join(f.temporary, 'outside-required');
      write(outside, '# inert outside data\n', 0o600);
      fs.unlinkSync(file);
      if (kind === 'directory') fs.mkdirSync(file);
      if (kind === 'hardlink') fs.linkSync(outside, file);
      if (kind.endsWith('symlink')) fs.symlinkSync(kind === 'symlink' ? outside : outside + '-missing', file);
      const before = modeSnapshot(f.temporary);
      const result = installed.run();
      assert.notEqual(result.status, 0);
      assert.ok(result.stderr.includes(file), result.stderr);
      assert.deepEqual(installed.chownCalls(), []);
      assert.deepEqual(modeSnapshot(f.temporary), before);
    });
  }
}

for (const relative of ['unexpected', '.hidden-extra', `${TOOLS}/extra.py`, '.sysak_components/unlisted',
  `${TOOLS}/light_inspect/collectors/cpu.py`, `${TOOLS}/light_inspect/__pycache__/gpu_snapshot.pyc`,
  `${TOOLS}/light_inspect/credentials.json`]) {
  test(`installer refuses unlisted bundle path before changing permissions: ${relative}`, t => {
    const f = fixture(t);
    f.prepare();
    const installed = installResourcePreflight(f);
    write(path.join(installed.bundle, relative), 'untouched');
    const before = modeSnapshot(installed.appDir);
    const result = installed.run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unexpected sysAK bundle path/);
    assert.deepEqual(installed.chownCalls(), []);
    assert.deepEqual(modeSnapshot(installed.appDir), before);
  });
}

// Execute only the read-only, inline manifest checker. Never run installation,
// ownership changes, the root runner or bundled tools in this validation test.
function installManifestCheck(bundle) {
  const install = fs.readFileSync(path.join(ROOT, 'build/after-install.sh'), 'utf8');
  const script = /<<'SYSAK_MANIFEST_PY'\n([\s\S]*?)\nSYSAK_MANIFEST_PY/.exec(install)?.[1];
  assert.ok(script);
  assert.ok(install.indexOf('SYSAK_MANIFEST_PY\n') < install.indexOf('\nchmod '));
  return spawnSync('/usr/bin/python3', ['-I', '-B', '-c', script, bundle], { encoding: 'utf8', timeout: 15000 });
}

test('installer inline checker validates the exact new component manifest without executing any collector', t => {
  const f = fixture(t);
  f.prepare();
  const before = snapshot(f.bundle);
  const modes = modeSnapshot(f.bundle);
  const result = installManifestCheck(f.bundle);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(snapshot(f.bundle), before);
  assert.deepEqual(modeSnapshot(f.bundle), modes);
});

for (const relative of EXPECTED_FILES) {
  test(`installer inline checker rejects changed bytes without mutation: ${relative}`, t => {
    const f = fixture(t);
    f.prepare();
    fs.appendFileSync(path.join(f.bundle, relative), '# changed\n');
    const before = snapshot(f.bundle);
    const modes = modeSnapshot(f.bundle);
    const result = installManifestCheck(f.bundle);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /invalid sysAK manifest or component digest/);
    assert.deepEqual(snapshot(f.bundle), before);
    assert.deepEqual(modeSnapshot(f.bundle), modes);
  });
}

for (const [label, edit] of [
  ['old commands', m => { m.commands = LEGACY_COMMANDS; }],
  ['missing GPU profile', m => { delete m.safe_profiles.ai; }],
  ['unsafe GPU profile', m => { m.safe_profiles.ai = ['--all']; }],
  ['missing requires', m => { delete m.requires; }],
  ['unknown file with digest', m => { m.files[`${TOOLS}/light_inspect/collectors/cpu.py`] = 'a'.repeat(64); }],
  ['missing IDC hash', m => { delete m.files[`${TOOLS}/idc`]; }],
  ['wrong architecture', m => { m.arch = 'unknown'; }],
  ['wrong schema', m => { m.schema_version = '2.0'; }],
]) {
  test(`installer inline checker refuses ${label}`, t => {
    const f = fixture(t);
    f.prepare();
    rewriteManifest(f.bundle, edit);
    const before = snapshot(f.bundle);
    assert.notEqual(installManifestCheck(f.bundle).status, 0);
    assert.deepEqual(snapshot(f.bundle), before);
  });
}

test('installer checker rejects even the fully valid legacy closure (upgrade compatibility is prepare-only)', t => {
  const f = fixture(t);
  legacyBundle(f);
  const before = snapshot(f.bundle);
  assert.notEqual(installManifestCheck(f.bundle).status, 0);
  assert.deepEqual(snapshot(f.bundle), before);
});

for (const relative of DIRECTORIES) {
  test(`installer rejects a symlinked bundle directory before permission changes: ${relative}`, t => {
    const f = fixture(t);
    f.prepare();
    const installed = installResourcePreflight(f);
    const target = path.join(installed.bundle, relative);
    const outside = path.join(f.temporary, 'moved-bundle-directory');
    fs.renameSync(target, outside);
    fs.symlinkSync(outside, target, 'dir');
    const before = modeSnapshot(f.temporary);
    const result = installed.run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unsafe resource ancestor/);
    assert.deepEqual(installed.chownCalls(), []);
    assert.deepEqual(modeSnapshot(f.temporary), before);
  });
}

test('installer rejects a symlinked deployment ancestor before any resource chmod/chown', t => {
  const f = fixture(t);
  f.prepare();
  const installed = installResourcePreflight(f);
  const resources = path.join(installed.appDir, 'resources');
  const moved = path.join(f.temporary, 'moved-resources');
  fs.renameSync(resources, moved);
  fs.symlinkSync(moved, resources, 'dir');
  const before = modeSnapshot(f.temporary);
  const result = installed.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unsafe resource ancestor/);
  assert.deepEqual(installed.chownCalls(), []);
  assert.deepEqual(modeSnapshot(f.temporary), before);
});

test('OpenAPI build uses installed esbuild, Node20 CJS, embedded JSON and existing runtime output inclusion', () => {
  const script = fs.readFileSync(path.join(ROOT, 'scripts/build-openapi.cjs'), 'utf8');
  assert.match(script, /require\('esbuild'\)\.build/);
  assert.match(script, /openapi-service\.ts/);
  assert.match(script, /openapi-contract\.json/);
  assert.match(script, /openapi\.cjs/);
  assert.match(script, /bundle: true/);
  assert.match(script, /platform: 'node'/);
  assert.match(script, /format: 'cjs'/);
  assert.match(script, /target: 'node20'/);
  assert.match(script, /loader: \{ '\.json': 'json' \}/);
  assert.match(script, /require\.main === module/);
  // Syntax-only checking; do not build the unfinished service or run hooks.
  for (const file of ['scripts/prepare-sysak.cjs', 'scripts/build-openapi.cjs', 'build/after-pack.cjs']) {
    const check = spawnSync(process.execPath, ['--check', path.join(ROOT, file)], { encoding: 'utf8' });
    assert.equal(check.status, 0, check.stderr);
  }
  for (const hook of ['build/after-install.sh', 'build/after-remove.sh']) {
    const check = spawnSync('/bin/sh', ['-n', path.join(ROOT, hook)], { encoding: 'utf8' });
    assert.equal(check.status, 0, check.stderr);
  }
});
