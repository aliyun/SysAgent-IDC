import { build } from 'esbuild';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const result = await build({
  absWorkingDir: root,
  entryPoints: ['src/main.tsx'],
  outfile: 'offline.js',
  bundle: true,
  jsx: 'automatic',
  write: false,
  minify: true,
  format: 'iife',
  target: 'es2020',
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env.VITE_SYSAGENT_VERSION': JSON.stringify(pkg.version) },
  loader: { '.woff': 'dataurl', '.woff2': 'dataurl', '.svg': 'dataurl' },
  plugins: [{
    name: 'offline-demo-api',
    setup(builder) {
      builder.onResolve({ filter: /^\.\/health-api$/ }, () => ({ path: resolve(root, 'src/standalone-api.ts') }));
    },
  }],
});
const css = result.outputFiles.find((file) => file.path.endsWith('.css')).text.replace(/<\/style/gi, '<\\/style');
const js = result.outputFiles.find((file) => file.path.endsWith('.js')).text.replace(/<\/script/gi, '<\\/script');
const icon = (await readFile(resolve(root, 'public/icon.svg'))).toString('base64');
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SysAgent管家 · 离线 Demo ${pkg.version}</title><link rel="icon" type="image/svg+xml" href="data:image/svg+xml;base64,${icon}"><style>${css}</style></head><body><div id="root"></div><script>${js}</script></body></html>`;
const output = resolve(root, 'release', `SysAgent管家-${pkg.version}-demo.html`);
await writeFile(output, html);
console.log(output);
