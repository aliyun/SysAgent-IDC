'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const TOOLS = '.sysak_components/tools';
const LEGACY_COMMANDS = Object.freeze(['idc', 'resource_anomaly', 'memgraph']);
const COMMANDS = Object.freeze([...LEGACY_COMMANDS, 'ai']);
const AI_RULE = 'generic:ai::help{GPU AI diagnostics}';
// Native memgraph's complete Makefile pymods/import closure, plus resource_anomaly's IDC modules.
const DIAGNOSTIC_MODULES = Object.freeze([
  'resource_anomaly_idc', 'fdleak_metrics',
  'plugin_abnormalPackages', 'plugin_anonTaskTop', 'plugin_cache', 'plugin_memcgLeak',
  'plugin_memfrag', 'plugin_memgraph', 'plugin_meminfo', 'plugin_memleak', 'plugin_podDetect',
  'plugin_system', 'plugin_taskProc', 'plugin_vmRssTaskTop', 'plugin_skcheck', 'plugin_appmem',
  'mem_utils', 'plugin_thpCollect',
]);
// The historical safe_profiles manifest field records argv, not a safety or coverage boundary.
const SAFE_PROFILES = Object.freeze({
  resource_anomaly: Object.freeze(['--idc']),
  memgraph: Object.freeze(['--graph', '--jsonstdout']),
  ai: Object.freeze(['--threshold', '1s']),
});
const RULES = `${TOOLS}/.sysak.rules`;
const REQUIRED_FILES = Object.freeze([
  'sysak', ...COMMANDS.map(name => `${TOOLS}/${name}`), RULES,
  ...DIAGNOSTIC_MODULES.map(name => `${TOOLS}/${name}.py`),
].sort());
const ALLOWED_FILES = new Set([...REQUIRED_FILES, 'manifest.json']);
const LEGACY_DIRS = new Set(['.sysak_components', TOOLS]);
const ALLOWED_DIRS = LEGACY_DIRS;
const CURRENT_BUNDLE = Object.freeze({ commands: COMMANDS, profiles: SAFE_PROFILES,
  required: REQUIRED_FILES, files: ALLOWED_FILES, directories: ALLOWED_DIRS });
// Upgrade-only closure: no GPU files/directories, unknown components or relaxed rules.
const LEGACY_REQUIRED_FILES = Object.freeze(REQUIRED_FILES.filter(relative => relative !== `${TOOLS}/ai`));
const LEGACY_BUNDLE = Object.freeze({ commands: LEGACY_COMMANDS,
  profiles: Object.freeze({ resource_anomaly: SAFE_PROFILES.resource_anomaly, memgraph: SAFE_PROFILES.memgraph }),
  required: LEGACY_REQUIRED_FILES, files: new Set([...LEGACY_REQUIRED_FILES, 'manifest.json']), directories: LEGACY_DIRS });
const MACHINE = Object.freeze({ x64: 62, arm64: 183 });

function fail(message) {
  throw new Error(`${message}; sysAK requires python3 on the host (including AppImage)`);
}

function hostArch() {
  if (process.platform !== 'linux' || !Object.hasOwn(MACHINE, process.arch)) {
    fail(`Unsupported host ${process.platform}/${process.arch}; only linux/x64 or linux/arm64`);
  }
  return process.arch;
}

function exists(file) {
  try { fs.lstatSync(file); return true; } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

// Check every ancestor, including the selected source root. Never follow links.
function assertDirectory(directory) {
  const absolute = path.resolve(directory);
  let current = path.parse(absolute).root;
  for (const part of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let stat;
    try { stat = fs.lstatSync(current); } catch (error) {
      if (error.code === 'ENOENT') fail(`Missing required directory: ${current}`);
      throw error;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail(`Unsafe directory (symlink/non-directory): ${current}`);
  }
  return absolute;
}

function inside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function safeFile(root, relative, allowedFiles = ALLOWED_FILES) {
  if (!allowedFiles.has(relative)) fail(`Unexpected file path: ${relative}`);
  assertDirectory(path.dirname(path.join(root, relative)));
  const file = path.join(root, relative);
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile()) fail(`Unsafe file (symlink/non-regular): ${file}`);
  // O_NONBLOCK prevents a raced FIFO from blocking; O_NOFOLLOW protects the leaf.
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.ino !== stat.ino || opened.dev !== stat.dev) fail(`File changed while reading: ${file}`);
    return { data: fs.readFileSync(fd), mode: opened.mode };
  } finally {
    fs.closeSync(fd);
  }
}

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function validateElf(data, arch = hostArch(), label = 'sysak') {
  if (!Object.hasOwn(MACHINE, arch)) fail(`Unsupported architecture: ${arch}`);
  if (data.length < 64 || !data.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) ||
      data[4] !== 2 || data[5] !== 1 || data[6] !== 1 || data.readUInt32LE(20) !== 1 ||
      data.readUInt16LE(52) !== 64 || ![2, 3].includes(data.readUInt16LE(16))) {
    fail(`${label} must be a completed 64-bit little-endian ELF executable`);
  }
  const machine = data.readUInt16LE(18);
  if (machine !== MACHINE[arch]) fail(`ELF architecture mismatch: e_machine=${machine}, host=${arch}`);
  return arch;
}

function normalizeRules(text, strict = false) {
  return normalizeRulesForCommands(text, strict, COMMANDS);
}

function normalizeRulesForCommands(text, strict, commands) {
  const selected = new Map();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const command = line.split(':')[1];
    if (!commands.includes(command)) {
      if (strict) fail(`Unexpected sysAK rule: ${line}`);
      continue;
    }
    // Canonicalize native python-dep{all} only during preparation; verification stays python3-only.
    const candidate = !strict && command === 'memgraph'
      ? line.replace(/^([A-Za-z0-9_/-]+:memgraph:)python-dep\{all\}:/, '$1python-dep{python3}:') : line;
    if (command === 'ai') {
      if (candidate !== AI_RULE) fail(`Invalid ai rule; expected ${AI_RULE} without python-dep`);
    } else {
      const match = /^([A-Za-z0-9_/-]+):(idc|resource_anomaly|memgraph):python-dep\{python3\}:help\{([^\r\n\0]*)\}$/.exec(candidate);
      if (!match) fail(`Invalid ${command} rule; expected only python-dep{python3} and help{...}`);
    }
    if (selected.has(command) && selected.get(command) !== candidate) fail(`Conflicting duplicate ${command} rules`);
    selected.set(command, candidate);
  }
  for (const command of commands) {
    if (!selected.has(command)) fail(`Missing ${command} rule${command === 'ai' ? ' without python-dep' : ' with python-dep{python3}'}`);
  }
  const normalized = commands.map(command => selected.get(command)).join('\n') + '\n';
  if (strict && text !== normalized) fail(`Rules must contain exactly one canonical entry for each of: ${commands.join(', ')}`);
  return normalized;
}

function scanBundle(root, bundle) {
  assertDirectory(root);
  const files = [];
  function walk(relative) {
    const directory = path.join(root, relative);
    assertDirectory(directory);
    const mode = fs.lstatSync(directory).mode;
    if ((mode & 0o7000) || (mode & 0o022) || (mode & 0o555) !== 0o555) fail(`Unsafe bundle directory permissions: ${relative || '.'}`);
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory() && bundle.directories.has(name)) {
        walk(name);
      } else if (entry.isFile() && bundle.files.has(name)) {
        files.push(name);
      } else {
        fail(`Unexpected file/directory or symlink in bundle: ${name}`);
      }
    }
  }
  walk('');
  const expected = [...bundle.files].sort();
  if (JSON.stringify(files.sort()) !== JSON.stringify(expected)) fail('Bundle has missing required components or manifest.json');
  return files;
}

function parseJson(data, label) {
  try { return JSON.parse(data.toString('utf8')); } catch { fail(`Invalid JSON: ${label}`); }
}

function executable(relative, commands = COMMANDS) {
  return relative === 'sysak' || commands.some(name => relative === `${TOOLS}/${name}`) || relative.endsWith('.py');
}

function validateEntry(relative, data, arch, commands) {
  if (relative === 'sysak' || relative === `${TOOLS}/ai`) validateElf(data, arch, path.basename(relative));
  else if (commands.some(name => relative === `${TOOLS}/${name}`) && !/^#![^\r\n]*\bpython3\b/.test(data.toString('utf8'))) {
    fail(`Expected python3 entry script: ${relative}`);
  }
}

function verifyBundle(root = path.join(PROJECT_ROOT, 'resources/sysak')) {
  return verifyBundleSchema(root, CURRENT_BUNDLE);
}

// Accept validated legacy packages for atomic upgrades only, never for runtime verification.
function verifyReplaceableBundle(root) {
  const manifest = parseJson(safeFile(root, 'manifest.json').data, 'manifest.json');
  const commands = JSON.stringify(manifest?.commands);
  const bundle = commands === JSON.stringify(LEGACY_COMMANDS) ? LEGACY_BUNDLE : CURRENT_BUNDLE;
  return verifyBundleSchema(root, bundle);
}

function verifyBundleSchema(root, bundle) {
  const arch = hostArch();
  if (!exists(root)) fail(`No sysAK bundle at ${root}. Run npm run prepare:sysak -- --source <completed-build-dir> or set SYSAK_BUNDLE_DIR`);
  const files = scanBundle(root, bundle);
  const manifest = parseJson(safeFile(root, 'manifest.json').data, 'manifest.json');
  if (!manifest || manifest.schema_version !== '1.0' || manifest.platform !== 'linux' || manifest.arch !== arch ||
      JSON.stringify(manifest.commands) !== JSON.stringify(bundle.commands) ||
      JSON.stringify(manifest.requires) !== JSON.stringify(['python3']) ||
      JSON.stringify(manifest.safe_profiles) !== JSON.stringify(bundle.profiles) ||
      !manifest.files || Array.isArray(manifest.files) || typeof manifest.files !== 'object' ||
      JSON.stringify(Object.keys(manifest.files).sort()) !== JSON.stringify(bundle.required)) {
    fail('Invalid manifest schema/platform/architecture/commands/requires/safe_profiles/files');
  }
  for (const relative of files) {
    const { data, mode } = safeFile(root, relative, bundle.files);
    if ((mode & 0o7000) || (mode & 0o022) || (executable(relative, bundle.commands) && (mode & 0o111) !== 0o111)) {
      fail(`Unsafe permissions or non-executable script: ${relative}`);
    }
    if (relative === 'manifest.json') continue; // The manifest cannot hash itself.
    if (!/^[a-f0-9]{64}$/.test(manifest.files[relative]) || sha256(data) !== manifest.files[relative]) fail(`SHA256 mismatch: ${relative}`);
    validateEntry(relative, data, arch, bundle.commands);
    if (relative === RULES) normalizeRulesForCommands(data.toString('utf8'), true, bundle.commands);
    if (relative.endsWith('.json')) parseJson(data, relative);
  }
  return manifest;
}

function resourceDirectory(projectRoot) {
  const root = assertDirectory(projectRoot);
  // Test fixtures may supply a project root, but a target is never accepted.
  const pkg = parseJson(fs.readFileSync(path.join(root, 'package.json')), 'package.json');
  if (pkg.name !== 'sysagent-idc') fail('Destination must be the sysagent-idc project resources/sysak directory');
  const resources = path.join(root, 'resources');
  if (!exists(resources)) {
    assertDirectory(root); // Check the parent before creating it.
    fs.mkdirSync(resources, { mode: 0o755 });
    fs.chmodSync(resources, 0o755);
  }
  return assertDirectory(resources);
}

function cleanupStaging(resources, temporary) {
  if (path.dirname(temporary) !== resources || !/^\.sysak-stage-[A-Za-z0-9]+$/.test(path.basename(temporary))) {
    fail('Refusing to remove a directory outside owned resource staging');
  }
  assertDirectory(resources);
  assertDirectory(temporary);
  fs.rmSync(temporary, { recursive: true });
}

function prepareBundle(source, { projectRoot = PROJECT_ROOT } = {}) {
  const arch = hostArch();
  const sourceRoot = assertDirectory(source);
  const target = path.join(path.resolve(projectRoot), 'resources/sysak');
  const resourcesPath = path.dirname(target);
  if (inside(sourceRoot, resourcesPath) || inside(resourcesPath, sourceRoot)) fail('Source and resource staging must not overlap');
  // Read only the whitelist; unrelated tools, source, credentials and .git are not traversed.
  const contents = new Map();
  for (const relative of REQUIRED_FILES) {
    if (!exists(path.join(sourceRoot, relative))) fail(`Missing required component: ${relative}`);
    let { data } = safeFile(sourceRoot, relative);
    validateEntry(relative, data, arch, COMMANDS);
    if (relative === RULES) data = Buffer.from(normalizeRules(data.toString('utf8')));
    if (relative.endsWith('.json')) parseJson(data, relative);
    contents.set(relative, data);
  }
  const resources = resourceDirectory(projectRoot);
  const lock = path.join(resources, '.sysak-prepare.lock');
  let fd;
  try { fd = fs.openSync(lock, 'wx', 0o600); } catch (error) {
    if (error.code === 'EEXIST') fail(`Another preparation or stale lock exists at ${lock}; inspect it before retrying`);
    throw error;
  }
  const owned = fs.fstatSync(fd);
  try {
    return publishBundle(contents, arch, resources, target);
  } finally {
    fs.closeSync(fd);
    const current = fs.lstatSync(lock);
    if (current.isSymbolicLink() || current.ino !== owned.ino || current.dev !== owned.dev) fail(`Preparation lock changed: ${lock}`);
    fs.unlinkSync(lock);
  }
}

function publishBundle(contents, arch, resources, target) {
  // Do not overwrite an unrecognized or damaged directory supplied by the user.
  if (exists(target)) verifyReplaceableBundle(target);
  const temporary = fs.mkdtempSync(path.join(resources, '.sysak-stage-'));
  const candidate = path.join(temporary, 'package');
  const previous = path.join(temporary, 'previous');
  let movedPrevious = false;
  let installed = false;
  let preserve = false;
  try {
    assertDirectory(temporary);
    fs.mkdirSync(candidate, { mode: 0o755 });
    fs.chmodSync(candidate, 0o755);
    for (const relative of [...ALLOWED_DIRS].sort((a, b) => a.split('/').length - b.split('/').length)) {
      const directory = path.join(candidate, relative);
      assertDirectory(path.dirname(directory));
      fs.mkdirSync(directory, { mode: 0o755 });
      fs.chmodSync(directory, 0o755);
    }
    const hashes = {};
    for (const [relative, data] of contents) {
      const file = path.join(candidate, relative);
      assertDirectory(path.dirname(file));
      fs.writeFileSync(file, data, { flag: 'wx', mode: executable(relative) ? 0o755 : 0o644 });
      fs.chmodSync(file, executable(relative) ? 0o755 : 0o644);
      hashes[relative] = sha256(data);
    }
    const manifest = {
      schema_version: '1.0', platform: 'linux', arch, commands: [...COMMANDS], requires: ['python3'],
      safe_profiles: SAFE_PROFILES, files: hashes,
    };
    fs.writeFileSync(path.join(candidate, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o644 });
    fs.chmodSync(path.join(candidate, 'manifest.json'), 0o644);
    verifyBundle(candidate);
    assertDirectory(resources);
    if (exists(target)) {
      verifyReplaceableBundle(target);
      fs.renameSync(target, previous);
      movedPrevious = true;
    }
    fs.renameSync(candidate, target);
    installed = true;
    verifyBundle(target);
    return manifest;
  } catch (error) {
    // Rename back, never remove the previous package before the candidate passes.
    try {
      assertDirectory(resources);
      if (installed) fs.renameSync(target, candidate);
      if (movedPrevious) fs.renameSync(previous, target);
    } catch (rollbackError) {
      preserve = true;
      throw new Error(`${error.message}; rollback failed: ${rollbackError.message}; recovery files preserved at ${temporary}`);
    }
    throw error;
  } finally {
    if (!preserve) {
      try { cleanupStaging(resources, temporary); } catch (error) {
        process.stderr.write(`Staging retained at ${temporary}: ${error.message}\n`);
      }
    }
  }
}

function parseArgs(args) {
  let source;
  let verify = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--verify' && !verify) verify = true;
    else if (args[i] === '--source' && source === undefined && args[i + 1] && !args[i + 1].startsWith('--')) source = args[++i];
    else fail(`Unknown or incomplete argument: ${args[i]}. Usage: prepare-sysak.cjs [--source <completed-build-dir> | --verify]`);
  }
  if (verify && source !== undefined) fail('--verify cannot be combined with --source');
  return { source, verify };
}

function main(args = process.argv.slice(2), env = process.env) {
  const options = parseArgs(args);
  const source = options.source || env.SYSAK_BUNDLE_DIR;
  const manifest = options.verify || !source ? verifyBundle() : prepareBundle(source);
  process.stdout.write(`sysAK bundle verified: linux/${manifest.arch}; commands: ${manifest.commands.join(', ')}; requires python3 (not bundled)\n`);
}

module.exports = { COMMANDS, DIAGNOSTIC_MODULES, SAFE_PROFILES, TOOLS, RULES, REQUIRED_FILES, sha256, validateElf, normalizeRules, verifyBundle, prepareBundle, parseArgs, main };
if (require.main === module) {
  try { main(); } catch (error) {
    process.stderr.write(`prepare:sysak: ${error.message}\n`);
    process.exitCode = 1;
  }
}
