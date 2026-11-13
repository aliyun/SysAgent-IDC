import { spawnSync } from 'node:child_process';
import { readFile, writeFile, readdir, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
function run(command, args, env = {}) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', env: { ...process.env, ...env } });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed: ${result.status}`);
}
function npm(folder, script) {
  run('npm', ['--prefix', resolve(root, folder), 'run', script]);
}
run(process.execPath, ['scripts/sync-versions.mjs']);
const sourceHash = createHash('sha256');
async function hashSources(path) {
  for (const entry of (await readdir(resolve(root, path), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const next = `${path}/${entry.name}`;
    if (entry.isDirectory()) await hashSources(next);
    else if (entry.isFile()) sourceHash.update(next).update(await readFile(resolve(root, next)));
    else throw new Error(`源目录不允许符号链接: ${next}`);
  }
}
for (const path of ['scripts', 'sysagent-idc/src', 'sysagent-idc/electron', 'sysagent-idc/scripts', 'sysagent-idc/tests', 'sysagent-ide-extension/src', 'sysagent-ide-extension/webview', 'sysagent-ide-extension/scripts', 'sysagent-ide-extension/test']) await hashSources(path);
for (const path of ['package.json', 'sysagent-idc/package.json', 'sysagent-idc/package-lock.json', 'sysagent-idc/vite.config.ts', 'sysagent-idc/public/icon.svg', 'sysagent-idc/build/after-install.sh', 'sysagent-idc/build/make-icon.cjs', 'sysagent-ide-extension/package.json', 'sysagent-ide-extension/package-lock.json']) sourceHash.update(path).update(await readFile(resolve(root, path)));
sourceHash.update(version);
const fingerprint = sourceHash.digest('hex');
const release = resolve(root, 'release');
const manifestPath = resolve(release, `release-${version}.json`);
let previous;
try { previous = JSON.parse(await readFile(manifestPath, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
if (previous) throw new Error(`发行批次 ${version} 已完成；先提升 sysom_idc/package.json 版本，不覆盖已验收的交付文件。`);

npm('sysagent-idc', 'icon');
npm('sysagent-idc', 'test');
npm('sysagent-ide-extension', 'typecheck');
npm('sysagent-ide-extension', 'test');
npm('sysagent-ide-extension', 'test:vscode');
npm('sysagent-idc', 'build:electron:mirror');
npm('sysagent-idc', 'build:html');
npm('sysagent-ide-extension', 'package');
const extractedVsix = await mkdtemp(resolve(tmpdir(), 'sysom-release-vsix-'));
try {
  run('unzip', ['-q', resolve(root, `sysagent-ide-extension/release/sysagent-ide-${version}.vsix`), '-d', extractedVsix]);
  run(process.execPath, ['sysagent-ide-extension/test/run-vscode.cjs'], { SYSOM_EXTENSION_PATH: resolve(extractedVsix, 'extension') });
} finally {
  await rm(extractedVsix, { recursive: true, force: true });
}
run(process.execPath, ['sysagent-analysis/tests/run-acceptance.cjs', pathToFileURL(resolve(root, `sysagent-idc/release/SysAgent管家-${version}-demo.html`)).href, `rebuilt-offline-v${version.replaceAll('.', '')}`]);
run(process.execPath, ['sysagent-analysis/tests/verify-package.cjs', resolve(root, `sysagent-idc/release/SysAgent管家-${version}.AppImage`)], { APPIMAGE_EXTRACT_AND_RUN: '1' });
const unpacked = await mkdtemp(resolve(tmpdir(), 'sysom-release-deb-'));
try {
  run('dpkg-deb', ['-x', resolve(root, `sysagent-idc/release/sysagent-idc_${version}_amd64.deb`), unpacked]);
  run(process.execPath, ['sysagent-analysis/tests/verify-package.cjs', resolve(unpacked, 'opt/SysAgent管家/sysagent-idc')]);
} finally {
  await rm(unpacked, { recursive: true, force: true });
}
const paths = [
  `sysagent-idc/release/SysAgent管家-${version}.AppImage`,
  `sysagent-idc/release/sysagent-idc_${version}_amd64.deb`,
  `sysagent-idc/release/SysAgent管家-${version}-demo.html`,
  `sysagent-ide-extension/release/sysagent-ide-${version}.vsix`,
];
const artifacts = [];
for (const path of paths) {
  const contents = await readFile(resolve(root, path));
  artifacts.push({ path: `sysom_idc/${path}`, bytes: contents.length, sha256: createHash('sha256').update(contents).digest('hex') });
}
for (const folder of ['sysagent-idc', 'sysagent-ide-extension']) {
  const sums = artifacts.filter(item => item.path.startsWith(`sysom_idc/${folder}/`)).map(item => `${item.sha256}  ${item.path.split('/').at(-1)}\n`).join('');
  await writeFile(resolve(root, folder, 'release', `SHA256SUMS-${version}`), sums);
}
await mkdir(release, { recursive: true });
await writeFile(resolve(release, `SHA256SUMS-${version}`), artifacts.map(item => `${item.sha256}  ${relative(release, resolve(root, item.path.slice('sysom_idc/'.length)))}\n`).join(''));
await writeFile(manifestPath, JSON.stringify({ version, sourceSha256: fingerprint, generatedAt: new Date().toISOString(), delivery: 'local-only', checks: ['model-api', 'ide-typecheck', 'ide-webview', 'vscode-smoke', 'portable-vsix', 'offline-browser', 'appimage-native-browser', 'deb-native-browser'], artifacts }, null, 2) + '\n');
console.log(`Complete local release ${version}: all ${artifacts.length} artifacts verified. No installation or upload performed.`);
