import { build } from 'esbuild';
import { copyFile, mkdir, rm, readFile, chmod, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const guard = resolve(root, '../sysagent-idc');
const dist = resolve(root, 'dist');
const { version } = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const { verifyBundle, REQUIRED_FILES } = createRequire(import.meta.url)(resolve(guard, 'scripts/prepare-sysak.cjs'));
const bundle = resolve(guard, 'resources/sysak');
verifyBundle(bundle);

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

await build({
  absWorkingDir: root,
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.js',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  external: ['vscode'],
  logLevel: 'warning',
});

await build({
  absWorkingDir: root,
  entryPoints: ['webview/main.tsx'],
  outdir: 'dist/webview',
  entryNames: 'webview',
  assetNames: 'fonts/[name]-[hash]',
  bundle: true,
  format: 'iife',
  target: 'es2020',
  jsx: 'automatic',
  minify: true,
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env.VITE_SYSAGENT_VERSION': JSON.stringify(version) },
  loader: { '.woff': 'file', '.woff2': 'file', '.svg': 'dataurl' },
  nodePaths: [resolve(guard, 'node_modules')],
  logLevel: 'warning',
});

await copyFile(resolve(guard, 'build/icon.png'), resolve(dist, 'icon.png'));
for (const relative of [...REQUIRED_FILES, 'manifest.json']) {
  const source = resolve(bundle, relative);
  const target = resolve(dist, 'sysak', relative);
  await mkdir(dirname(target), { recursive: true, mode: 0o755 });
  await copyFile(source, target);
  await chmod(target, (await stat(source)).mode & 0o777);
}
verifyBundle(resolve(dist, 'sysak'));
