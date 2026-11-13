'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { REQUIRED_FILES, COMMANDS, TOOLS, verifyBundle } = require('../scripts/prepare-sysak.cjs');

// Match prepare-sysak's executable policy; never infer permissions from copied modes.
const FILE_MODES = new Map(REQUIRED_FILES.map(relative => [relative,
  relative === 'sysak' || COMMANDS.some(name => relative === `${TOOLS}/${name}`) || relative.endsWith('.py')
    ? 0o755 : 0o644,
]));
FILE_MODES.set('manifest.json', 0o644);
const DIRECTORIES = new Set(['']);
for (const relative of REQUIRED_FILES) {
  for (let parent = path.posix.dirname(relative); parent !== '.'; parent = path.posix.dirname(parent)) {
    DIRECTORIES.add(parent);
  }
}

function assertDirectory(directory) {
  const absolute = path.resolve(directory);
  let current = path.parse(absolute).root;
  for (const part of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Unsafe directory (symlink/non-directory): ${current}`);
  }
}

function inside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

module.exports = async function afterPack({ appOutDir }) {
  if (typeof appOutDir !== 'string' || !path.isAbsolute(appOutDir)) throw new Error('Expected an absolute appOutDir');
  const root = path.join(appOutDir, 'resources', 'sysak');
  const source = path.resolve(__dirname, '../resources/sysak');
  if (inside(source, root) || inside(root, source)) throw new Error('Refusing to chmod source sysAK resources');

  // Preflight the entire whitelist and every ancestor before changing any modes.
  const targets = [];
  for (const directory of [appOutDir, path.join(appOutDir, 'resources')]) {
    assertDirectory(directory);
    targets.push({ file: directory, stat: fs.lstatSync(directory), mode: 0o755 });
  }
  for (const relative of DIRECTORIES) {
    const directory = path.join(root, relative);
    assertDirectory(directory);
    targets.push({ file: directory, stat: fs.lstatSync(directory), mode: 0o755 });
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (!((entry.isDirectory() && DIRECTORIES.has(name)) || (entry.isFile() && FILE_MODES.has(name)))) {
        throw new Error(`Unexpected file/directory or symlink in bundle: ${name}`);
      }
    }
  }
  const files = [
    ...[...FILE_MODES].map(([relative, mode]) => [path.join(root, relative), mode]),
    [path.join(appOutDir, 'resources/sysak-root-runner.py'), 0o755],
    [path.join(appOutDir, 'resources/sysom-idc.service'), 0o644],
  ];
  for (const [file, mode] of files) {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) {
      throw new Error(`Unsafe file (symlink/non-regular/hardlink): ${file}`);
    }
    targets.push({ file, stat, mode });
  }

  for (const { file, stat, mode } of targets) {
    assertDirectory(path.dirname(file));
    // Do not follow a replaced leaf or block on a FIFO; chmod only the checked inode.
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      const opened = fs.fstatSync(fd);
      if (opened.ino !== stat.ino || opened.dev !== stat.dev ||
          (stat.isDirectory() ? !opened.isDirectory() : !opened.isFile() || opened.nlink !== 1)) {
        throw new Error(`Bundle path changed before chmod: ${file}`);
      }
      fs.fchmodSync(fd, mode);
    } finally {
      fs.closeSync(fd);
    }
  }
  verifyBundle(root);
};
