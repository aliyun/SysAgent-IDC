'use strict';

const assert = require('node:assert/strict');
const cp = require('node:child_process');
const { createHash } = require('node:crypto');
const {
  copyFileSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  renameSync, rmSync, symlinkSync, writeFileSync,
} = require('node:fs');
const { syncBuiltinESMExports } = require('node:module');
const { tmpdir } = require('node:os');
const { resolve } = require('node:path');
const { after, mock, test } = require('node:test');

// Integrity verification is file-only: never install, unpack or execute the DEB.
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  mock.method(cp, name, () => { throw new Error('GX integrity tests forbid external commands'); });
}
syncBuiltinESMExports();
const { verifyGxPackage } = require('./gx-package.cjs');

const VERSION = '0.6.5-2';
const FILENAME = `gx_${VERSION}_amd64.deb`;
const SHA256 = 'a471bf61863c61744b102ba19a8620feea68d9aeaab8591c9d056f3cbe5b1902';
const METADATA = {
  schema_version: '1.0', platform: 'linux', arch: 'x64', package: 'gx',
  version: VERSION, filename: FILENAME, sha256: SHA256,
};
const source = resolve(__dirname, '../vendor/gx/linux-x64');
const sourceDeb = readFileSync(resolve(source, FILENAME));
const sourceManifest = readFileSync(resolve(source, 'manifest.json'));
const sha256 = data => createHash('sha256').update(data).digest('hex');

// All mutations and links belong to disposable copies, never the vendor input.
after(() => {
  assert.deepEqual(readFileSync(resolve(source, FILENAME)), sourceDeb);
  assert.deepEqual(readFileSync(resolve(source, 'manifest.json')), sourceManifest);
});

function fixture(t) {
  const root = mkdtempSync(resolve(tmpdir(), 'gx integrity ; fixture-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = resolve(root, 'linux-x64');
  mkdirSync(directory);
  for (const name of ['manifest.json', FILENAME]) {
    copyFileSync(resolve(source, name), resolve(directory, name));
    assert.equal(lstatSync(resolve(directory, name)).nlink, 1);
  }
  return { root, directory, binary: resolve(directory, FILENAME), manifest: resolve(directory, 'manifest.json') };
}

function updateManifest(f, change) {
  const manifest = JSON.parse(readFileSync(f.manifest, 'utf8'));
  change(manifest);
  writeFileSync(f.manifest, JSON.stringify(manifest));
}

test('accepts an unmodified copy of the official GX package and returns pinned metadata', t => {
  const f = fixture(t);
  assert.equal(sha256(sourceDeb), SHA256, 'Vendor bytes must match the independently pinned digest');
  assert.deepEqual(sourceDeb.subarray(0, 8), Buffer.from('!<arch>\n'));
  const result = verifyGxPackage(f.directory);
  assert.equal(result.binary, f.binary);
  assert.deepEqual(result.manifest, JSON.parse(sourceManifest.toString('utf8')));
  for (const [key, value] of Object.entries(METADATA)) assert.equal(result.manifest[key], value);
  assert.deepEqual(readFileSync(f.binary), sourceDeb);
  assert.deepEqual(readFileSync(f.manifest), sourceManifest);
});

test('rejects corrupt payloads, archive headers, truncated and empty packages', async t => {
  for (const damage of ['payload', 'archive header', 'truncated', 'empty']) {
    await t.test(damage, t => {
      const f = fixture(t);
      let data = Buffer.from(sourceDeb);
      if (damage === 'payload') data[data.length - 1] ^= 1;
      else if (damage === 'archive header') data[0] ^= 1;
      else if (damage === 'truncated') data = data.subarray(0, data.length - 1);
      else data = Buffer.alloc(0);
      if (damage === 'payload' || damage === 'truncated') {
        assert.deepEqual(data.subarray(0, 8), Buffer.from('!<arch>\n'), 'Checksum must reject even a valid archive header');
      }
      writeFileSync(f.binary, data);
      assert.throws(() => verifyGxPackage(f.directory), /GX 0\.6\.5-2 package checksum mismatch/);
    });
  }
});

test('rejects modified packages even when the manifest hash is updated to match', t => {
  const f = fixture(t);
  const data = Buffer.from(sourceDeb);
  data[data.length - 1] ^= 1;
  writeFileSync(f.binary, data);
  updateManifest(f, manifest => { manifest.sha256 = sha256(data); });
  assert.throws(() => verifyGxPackage(f.directory), /Invalid GX 0\.6\.5-2 manifest/);
});

test('rejects wrong or missing pinned manifest metadata', async t => {
  const invalid = {
    schema_version: '2.0', platform: 'darwin', arch: 'arm64', package: 'not-gx',
    version: '0.6.5-1', filename: `../${FILENAME}`, sha256: '0'.repeat(64),
  };
  for (const [key, value] of Object.entries(invalid)) {
    for (const damage of ['wrong', 'missing', 'wrong type']) {
      await t.test(`${key}: ${damage}`, t => {
        const f = fixture(t);
        updateManifest(f, manifest => {
          if (damage === 'missing') delete manifest[key];
          else manifest[key] = damage === 'wrong type' ? [METADATA[key]] : value;
        });
        assert.throws(() => verifyGxPackage(f.directory), /Invalid GX 0\.6\.5-2 manifest/);
      });
    }
  }
});

test('rejects malformed manifest JSON', t => {
  const f = fixture(t);
  writeFileSync(f.manifest, '{ invalid JSON');
  assert.throws(() => verifyGxPackage(f.directory), SyntaxError);
});

test('rejects missing vendor directory, manifest or official package filename', async t => {
  for (const name of ['', 'manifest.json', FILENAME]) {
    await t.test(name || 'directory', t => {
      const f = fixture(t);
      rmSync(resolve(f.directory, name), { recursive: true });
      assert.throws(() => verifyGxPackage(f.directory), { code: 'ENOENT' });
    });
  }
});

test('rejects symlinks for the package directory, manifest and DEB', async t => {
  for (const name of ['', 'manifest.json', FILENAME]) {
    await t.test(name || 'directory', t => {
      const f = fixture(t);
      const input = resolve(f.directory, name);
      const target = resolve(f.root, 'symlink-target');
      renameSync(input, target);
      symlinkSync(target, input, name ? 'file' : 'dir');
      assert.equal(lstatSync(input).isSymbolicLink(), true);
      assert.throws(() => verifyGxPackage(f.directory), /Unsafe GX package input/);
    });
  }
});

test('rejects hardlinked manifest and DEB files', async t => {
  for (const name of ['manifest.json', FILENAME]) {
    await t.test(name, t => {
      const f = fixture(t);
      const input = resolve(f.directory, name);
      linkSync(input, resolve(f.root, 'extra-hardlink'));
      assert.equal(lstatSync(input).nlink, 2);
      assert.throws(() => verifyGxPackage(f.directory), /Unsafe GX package input/);
    });
  }
});

test('rejects non-directory vendor roots and non-file manifest/DEB inputs', async t => {
  for (const name of ['', 'manifest.json', FILENAME]) {
    await t.test(name || 'directory', t => {
      const f = fixture(t);
      const input = resolve(f.directory, name);
      rmSync(input, { recursive: true });
      if (name) mkdirSync(input);
      else writeFileSync(input, 'not a directory');
      assert.throws(() => verifyGxPackage(f.directory), /Unsafe GX package input/);
    });
  }
});
