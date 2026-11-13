const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);
const { verifyAgentSightPackage } = require('../electron/agentsight-deployment.cjs');

async function packageAgentSight({ binary, license, output, version }) {
  if (![binary, license, output].every(value => typeof value === 'string' && path.isAbsolute(value)) || !/^\d+\.\d+\.\d+$/.test(version || '')) {
    throw new Error('Specify absolute --binary, --license, --output paths and --version');
  }
  for (const file of [binary, license]) {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Package inputs must be regular files');
  }
  await fs.mkdir(output, { mode: 0o700 });
  await fs.copyFile(binary, path.join(output, 'agentsight'), fs.constants.COPYFILE_EXCL);
  await fs.chmod(path.join(output, 'agentsight'), 0o700);
  const digest = createHash('sha256').update(await fs.readFile(path.join(output, 'agentsight'))).digest('hex');
  await fs.writeFile(path.join(output, 'manifest.json'), JSON.stringify({ schemaVersion: 1, version, platform: 'linux', arch: 'x64', sha256: digest }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  await verifyAgentSightPackage(output);
  await fs.copyFile(license, path.join(output, 'LICENSE'), fs.constants.COPYFILE_EXCL);
  await fs.copyFile(path.join(__dirname, '../electron/agentsight-deployment.cjs'), path.join(output, 'agentsight-deployment.cjs'), fs.constants.COPYFILE_EXCL);
  await fs.writeFile(path.join(output, 'install.cjs'), "const { prepareAgentSight } = require('./agentsight-deployment.cjs');\nprepareAgentSight({ packageDirectories: [__dirname] }).then(() => { console.log('AgentSight 用户级程序、API 配置和数据目录已准备；已有配置保留，未启动采集'); }).catch(() => { console.error('AgentSight 独立安装失败，请检查安装件与用户目录权限'); process.exitCode = 1; });\n", { flag: 'wx', mode: 0o600 });
  return { sha256: digest, version };
}

async function packageAgentSightDeb({ directory, output }) {
  if (typeof output !== 'string' || !path.isAbsolute(output) || !output.endsWith('.deb')) throw new Error('Specify an absolute .deb output path');
  try { await fs.lstat(output); throw new Error('Deb output already exists'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const { manifest } = await verifyAgentSightPackage(directory);
  const staging = await fs.mkdtemp(path.join(path.dirname(output), '.agentsight-deb-'));
  const temporary = path.join(path.dirname(output), `.agentsight-${randomUUID()}.deb`);
  try {
    await fs.chmod(staging, 0o755);
    const control = path.join(staging, 'DEBIAN');
    const payload = path.join(staging, 'usr/share/sysom/agentsight-runtime');
    const doc = path.join(staging, 'usr/share/doc/sysom-agentsight-runtime');
    for (const folder of [control, payload, doc]) await fs.mkdir(folder, { recursive: true, mode: 0o755 });
    let size = 0;
    for (const filename of ['agentsight', 'manifest.json', 'LICENSE', 'agentsight-deployment.cjs', 'install.cjs']) {
      const source = path.join(directory, filename);
      const stat = await fs.lstat(source);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Deb inputs must be regular files');
      const target = path.join(payload, filename);
      await fs.copyFile(source, target, fs.constants.COPYFILE_EXCL);
      await fs.chmod(target, filename === 'agentsight' ? 0o755 : 0o644);
      size += stat.size;
    }
    await verifyAgentSightPackage(payload);
    await fs.copyFile(path.join(payload, 'LICENSE'), path.join(doc, 'copyright'), fs.constants.COPYFILE_EXCL);
    await fs.chmod(path.join(doc, 'copyright'), 0o644);
    size += (await fs.stat(path.join(doc, 'copyright'))).size;
    for (const filename of ['agentsight-collection.py', 'sysom-agentsight-trace.service', 'sysom-agentsight-api.service']) {
      const source = path.join(__dirname, '../build', filename);
      const stat = await fs.lstat(source);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Deb service inputs must be regular files');
      const target = filename.endsWith('.service') ? path.join(staging, 'usr/lib/systemd/system', filename) : path.join(payload, filename);
      await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o755 });
      await fs.copyFile(source, target, fs.constants.COPYFILE_EXCL);
      await fs.chmod(target, filename.endsWith('.py') ? 0o755 : 0o644);
      size += (await fs.stat(target)).size;
    }
    for (const [name, source] of [['postinst', 'agentsight-postinst.sh'], ['prerm', 'agentsight-prerm.sh']]) {
      const input = path.join(__dirname, '../build', source);
      const stat = await fs.lstat(input);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Deb hook inputs must be regular files');
      await fs.copyFile(input, path.join(control, name), fs.constants.COPYFILE_EXCL);
      await fs.chmod(path.join(control, name), 0o755);
    }
    const fields = [
      'Package: sysom-agentsight-runtime', `Version: ${manifest.version}`, 'Architecture: amd64',
      'Maintainer: Local demo build <noreply@localhost>', 'Section: utils', 'Priority: optional',
      `Installed-Size: ${Math.ceil(size / 1024)}`,
      'Depends: libc6 (>= 2.38), libelf1, libgcc-s1, libstdc++6, zlib1g, python3, systemd',
      'Description: Independent AgentSight runtime for SysAgent',
      ' Provides a verified offline runtime in /usr/share/sysom/agentsight-runtime.',
      ' Includes independent systemd collection and API services; capture requires explicit host-wide consent.',
    ];
    await fs.writeFile(path.join(control, 'control'), fields.join('\n') + '\n', { flag: 'wx', mode: 0o644 });
    await run('dpkg-deb', ['--root-owner-group', '-Zgzip', '--build', staging, temporary]);
    await fs.chmod(temporary, 0o644);
    await fs.link(temporary, output);
    return { version: manifest.version, sha256: createHash('sha256').update(await fs.readFile(output)).digest('hex') };
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
    await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const values = {};
  let valid = args.length === 8 || args.length === 10;
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]?.slice(2);
    if (!args[index]?.startsWith('--') || !['binary', 'license', 'output', 'version', 'deb'].includes(key) || values[key] !== undefined) valid = false;
    values[key] = args[index + 1];
  }
  (valid ? packageAgentSight(values) : Promise.reject(new Error('Invalid arguments')))
    .then(async result => {
      console.log(`AgentSight ${result.version} 独立配套安装件已生成，校验 ${result.sha256}`);
      if (values.deb !== undefined) {
        const deb = await packageAgentSightDeb({ directory: values.output, output: values.deb });
        const installer = (await fs.readFile(path.join(__dirname, '../build/install-debs.sh'), 'utf8'))
          .replaceAll('@AGENTSIGHT_VERSION@', result.version).replaceAll('@SYSOM_VERSION@', require('../package.json').version);
        await fs.writeFile(path.join(path.dirname(values.deb), 'install-debs.sh'), installer, { flag: 'wx', mode: 0o755 });
        console.log(`AgentSight ${deb.version} 独立 deb 和显式授权安装入口已生成，校验 ${deb.sha256}`);
      }
    })
    .catch(() => { console.error('AgentSight 配套安装件生成失败；需要绝对路径 --binary --license --output 和 --version，不覆盖已有输出'); process.exitCode = 1; });
}

module.exports = { packageAgentSight, packageAgentSightDeb };
