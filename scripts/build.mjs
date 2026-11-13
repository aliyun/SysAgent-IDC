import { spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const legalFiles = ['LICENSE', 'THIRD_PARTY_NOTICES', 'FONT_LICENSE'];
const targets = ['all', 'desktop', 'ide', 'web'];

export function parseArgs(args) {
  const options = { target: 'all', skipInstall: false, help: false };
  const seen = new Set();
  for (let index = 0; index < args.length; index++) {
    const flag = args[index] === '-h' ? '--help' : args[index];
    if (seen.has(flag)) throw new Error(`重复参数：${flag}`);
    seen.add(flag);
    if (flag === '--help') options.help = true;
    else if (flag === '--skip-install') options.skipInstall = true;
    else if (flag === '--target') {
      const value = args[++index];
      if (!value || value.startsWith('-')) throw new Error('--target 需要参数值');
      options.target = value;
    } else throw new Error(`未知参数：${flag}；使用 --help 查看用法`);
  }
  if (!targets.includes(options.target)) throw new Error(`--target 必须为 ${targets.join(' / ')}`);
  return options;
}

function run(command, args, cwd = root) {
  const result = spawnSync(command, args, {
    cwd, stdio: 'inherit', shell: false,
    env: {
      ...process.env,
      ELECTRON_MIRROR: process.env.ELECTRON_MIRROR ?? 'https://npmmirror.com/mirrors/electron/',
      ELECTRON_BUILDER_BINARIES_MIRROR: process.env.ELECTRON_BUILDER_BINARIES_MIRROR ?? 'https://npmmirror.com/mirrors/electron-builder-binaries/',
    },
  });
  if (result.error) throw new Error(`无法启动构建命令：${result.error.message}`);
  if (result.signal) throw new Error(`构建被信号 ${result.signal} 中断`);
  if (result.status !== 0) throw new Error(`构建命令失败，退出码 ${result.status}`);
}

function npm(folder, args) {
  console.log(`\n[build] ${folder}: npm ${args.join(' ')}`);
  const cwd = resolve(root, folder);
  if (process.env.npm_execpath) run(process.execPath, [process.env.npm_execpath, ...args], cwd);
  else run('npm', args, cwd);
}

export async function main(args = process.argv.slice(2)) {
  const options = parseArgs(args);
  if (options.help) {
    console.log(`用法：npm run build -- [选项]

  --target all|desktop|ide|web  默认 all：主 deb、GX deb、AgentSight runtime deb、VSIX
  --skip-install              复用已安装的依赖；首次构建不要使用
  --help, -h                  显示帮助

Linux x64、Node.js 20+，原生构建输入已随源码提供。
桌面打包需要 dpkg-deb；首次安装依赖需要联网，运行应用另需图形库。
产物：release/build-<版本>/；web：sysagent-idc/dist/。
不会安装系统服务、开启采集、结束进程或上传发布件。`);
    return;
  }
  if (Number(process.versions.node.split('.')[0]) < 20) throw new Error('需要 Node.js 20 或更高版本');
  const native = options.target !== 'web';
  const desktop = ['all', 'desktop'].includes(options.target);
  const ide = ['all', 'ide'].includes(options.target);
  if (native && (process.platform !== 'linux' || process.arch !== 'x64')) throw new Error('原生构建仅支持 Linux x64；其他环境可使用 --target web');
  run(process.execPath, [resolve(root, 'scripts/sync-versions.mjs'), '--check']);
  const { version } = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  const folders = ide ? ['sysagent-idc', 'sysagent-ide-extension'] : ['sysagent-idc'];
  if (options.skipInstall) {
    for (const folder of folders) {
      if (!existsSync(resolve(root, folder, 'node_modules'))) throw new Error(`${folder}/node_modules 不存在；首次构建请不要使用 --skip-install`);
    }
  }
  if (native) {
    const source = resolve(root, 'vendor/sysak/linux-x64');
    if (!existsSync(source)) throw new Error('缺少 SysAK bundle；请完整获取仓库中的 vendor/sysak/linux-x64');
    const { prepareBundle, verifyBundle } = require(resolve(root, 'sysagent-idc/scripts/prepare-sysak.cjs'));
    prepareBundle(source);
    verifyBundle(resolve(root, 'sysagent-idc/resources/sysak'));
  }
  let runtime;
  let gx;
  const vendor = resolve(root, 'vendor/agentsight/linux-x64');
  if (desktop) {
    if (!existsSync(vendor)) throw new Error('缺少 AgentSight 构建输入；请完整获取 vendor/agentsight/linux-x64');
    runtime = await require(resolve(root, 'sysagent-idc/electron/agentsight-deployment.cjs')).verifyAgentSightPackage(vendor);
    const guard = JSON.parse(readFileSync(resolve(root, 'sysagent-idc/package.json'), 'utf8'));
    if (!guard.build.deb.depends.includes(`sysom-agentsight-runtime (= ${runtime.manifest.version})`)) throw new Error('AgentSight runtime 版本与主 deb 依赖不一致');
    gx = require(resolve(root, 'scripts/gx-package.cjs')).verifyGxPackage(resolve(root, 'vendor/gx/linux-x64'));
    if (!guard.build.deb.depends.includes(`gx (= ${gx.manifest.version})`)) throw new Error('GX 版本与主 deb 依赖不一致');
  }
  if (!options.skipInstall) {
    const install = ['ci', '--include=dev', '--no-audit', '--no-fund'];
    if (!desktop) install.push('--ignore-scripts');
    for (const folder of folders) npm(folder, install);
  }
  npm('sysagent-idc', ['run', desktop ? 'build:deb' : 'build']);
  for (const file of legalFiles) copyFileSync(resolve(root, file), resolve(root, 'sysagent-idc/dist', file));
  if (ide) npm('sysagent-ide-extension', ['run', 'package']);
  if (native) {
    const output = resolve(root, `release/build-${version}`);
    mkdirSync(output, { recursive: true });
    const artifacts = [];
    if (desktop) {
      const filename = `sysagent-idc_${version}_amd64.deb`;
      copyFileSync(resolve(root, 'sysagent-idc/release', filename), resolve(output, filename));
      artifacts.push(filename);
      copyFileSync(gx.binary, resolve(output, gx.manifest.filename));
      artifacts.push(gx.manifest.filename);
      const staging = mkdtempSync(resolve(root, 'release/.runtime-build-'));
      try {
        const directory = resolve(staging, 'agentsight-runtime');
        const filename = `sysom-agentsight-runtime_${runtime.manifest.version}_amd64.deb`;
        const { packageAgentSight, packageAgentSightDeb } = require(resolve(root, 'sysagent-idc/scripts/package-agentsight.cjs'));
        await packageAgentSight({ binary: runtime.binary, license: resolve(vendor, 'LICENSE'), output: directory, version: runtime.manifest.version });
        await packageAgentSightDeb({ directory, output: resolve(staging, filename) });
        cpSync(directory, resolve(output, 'agentsight-runtime'), { recursive: true });
        copyFileSync(resolve(staging, filename), resolve(output, filename));
        artifacts.push(filename, ...['agentsight', 'manifest.json', 'LICENSE', 'agentsight-deployment.cjs', 'install.cjs'].map(name => `agentsight-runtime/${name}`));
        const installer = readFileSync(resolve(root, 'sysagent-idc/build/install-debs.sh'), 'utf8')
          .replaceAll('@AGENTSIGHT_VERSION@', runtime.manifest.version).replaceAll('@SYSOM_VERSION@', version)
          .replaceAll('@GX_VERSION@', gx.manifest.version);
        writeFileSync(resolve(output, 'install-debs.sh'), installer, { mode: 0o755 });
        artifacts.push('install-debs.sh');
      } finally {
        rmSync(staging, { recursive: true, force: true });
      }
    }
    if (ide) {
      const filename = `sysagent-ide-${version}.vsix`;
      copyFileSync(resolve(root, 'sysagent-ide-extension/release', filename), resolve(output, filename));
      artifacts.push(filename);
    }
    for (const file of legalFiles) {
      copyFileSync(resolve(root, file), resolve(output, file));
      artifacts.push(file);
    }
    writeFileSync(resolve(output, 'SHA256SUMS'), artifacts.sort().map(file => `${createHash('sha256').update(readFileSync(resolve(output, file))).digest('hex')}  ${file}\n`).join(''));
    console.log(`\n[build] 产物：release/build-${version}/`);
  }
  console.log(`\n[build] ${options.target} 构建完成；未安装服务或上传文件`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`\n[build] 失败：${error.message}`); process.exitCode = 1; });
}
