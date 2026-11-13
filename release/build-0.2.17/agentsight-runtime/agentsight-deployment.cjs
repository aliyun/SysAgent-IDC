const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');

class AgentSightDeploymentError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AgentSightDeploymentError';
    this.code = code;
  }
}

function agentSightHome(env = process.env) {
  const home = env.HOME || os.homedir();
  const data = env.XDG_DATA_HOME && path.isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : path.join(home, '.local', 'share');
  if (!path.isAbsolute(home) || !path.isAbsolute(data)) throw new AgentSightDeploymentError('AGENTSIGHT_DEPLOYMENT_PATH_INVALID', 'AgentSight 用户目录必须是绝对路径');
  return path.join(data, 'sysom', 'agentsight');
}

async function regularFile(file, fsImpl) {
  if (!path.isAbsolute(file)) throw new AgentSightDeploymentError('AGENTSIGHT_DEPLOYMENT_PATH_INVALID', 'AgentSight 文件路径必须是绝对路径');
  const stat = await fsImpl.promises.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new AgentSightDeploymentError('AGENTSIGHT_DEPLOYMENT_UNSAFE', 'AgentSight 文件不是普通文件，已停止部署');
  return stat;
}

async function packageDigest(file, fsImpl, signal) {
  const handle = await fsImpl.promises.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(64 * 1024);
    let bytesRead;
    do {
      signal?.throwIfAborted();
      ({ bytesRead } = await handle.read(buffer, 0, buffer.length, null));
      hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead);
    return hash.digest('hex');
  } finally { await handle.close(); }
}

async function verifyAgentSightPackage(directory, { fsImpl = fs, signal } = {}) {
  if (!path.isAbsolute(directory)) throw new AgentSightDeploymentError('AGENTSIGHT_PACKAGE_INVALID', 'AgentSight 配套安装件路径无效');
  if ((await fsImpl.promises.lstat(directory)).isSymbolicLink()) throw new AgentSightDeploymentError('AGENTSIGHT_PACKAGE_INVALID', 'AgentSight 配套安装件不能是符号链接');
  const manifestPath = path.join(directory, 'manifest.json');
  if ((await regularFile(manifestPath, fsImpl)).size > 16 * 1024) throw new AgentSightDeploymentError('AGENTSIGHT_PACKAGE_INVALID', 'AgentSight 配套安装件清单过大');
  let manifest;
  try { manifest = JSON.parse(await fsImpl.promises.readFile(manifestPath, 'utf8')); }
  catch { throw new AgentSightDeploymentError('AGENTSIGHT_PACKAGE_INVALID', 'AgentSight 配套安装件清单无效'); }
  if (manifest.schemaVersion !== 1 || manifest.platform !== 'linux' || manifest.arch !== 'x64' ||
      manifest.version !== '0.16.0' || !/^[a-f0-9]{64}$/.test(manifest.sha256)) {
    throw new AgentSightDeploymentError('AGENTSIGHT_PACKAGE_INVALID', 'AgentSight 配套安装件版本或平台不兼容');
  }
  const binary = path.join(directory, 'agentsight');
  const stat = await regularFile(binary, fsImpl);
  if (stat.size < 64 || stat.size > 256 * 1024 * 1024) throw new AgentSightDeploymentError('AGENTSIGHT_PACKAGE_INVALID', 'AgentSight 配套程序大小无效');
  const handle = await fsImpl.promises.open(binary, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const header = Buffer.alloc(20);
    await handle.read(header, 0, header.length, 0);
    if (!header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) || header[4] !== 2 || header[5] !== 1 || header.readUInt16LE(18) !== 62) {
      throw new AgentSightDeploymentError('AGENTSIGHT_PACKAGE_INVALID', 'AgentSight 配套程序不是 Linux x64 ELF 文件');
    }
  } finally { await handle.close(); }
  if (await packageDigest(binary, fsImpl, signal) !== manifest.sha256) throw new AgentSightDeploymentError('AGENTSIGHT_PACKAGE_CHECKSUM', 'AgentSight 配套程序校验失败，未安装');
  return { binary, manifest };
}

async function privateDirectory(directory, fsImpl) {
  let ancestor = directory;
  while (true) {
    try {
      if (await fsImpl.promises.realpath(ancestor) !== ancestor) throw new AgentSightDeploymentError('AGENTSIGHT_DEPLOYMENT_UNSAFE', 'AgentSight 用户目录不能包含符号链接');
      break;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      ancestor = path.dirname(ancestor);
    }
  }
  await fsImpl.promises.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fsImpl.promises.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || await fsImpl.promises.realpath(directory) !== directory ||
      typeof process.getuid === 'function' && stat.uid !== process.getuid() || (stat.mode & 0o022) !== 0) {
    throw new AgentSightDeploymentError('AGENTSIGHT_DEPLOYMENT_UNSAFE', 'AgentSight 用户目录的归属或权限不安全，已停止部署');
  }
}

async function publish(file, write, mode, fsImpl, signal) {
  const temporary = path.join(path.dirname(file), `.agentsight-${randomUUID()}.tmp`);
  try {
    signal?.throwIfAborted();
    await write(temporary);
    await fsImpl.promises.chmod(temporary, mode);
    signal?.throwIfAborted();
    try { await fsImpl.promises.link(temporary, file); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    await regularFile(file, fsImpl);
  } finally {
    await fsImpl.promises.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

async function prepareAgentSight({ root, packageDirectories = [], binary, configPath, env = process.env, fsImpl = fs, signal } = {}) {
  try {
    signal?.throwIfAborted();
    root = root || agentSightHome(env);
    if (!path.isAbsolute(root) || path.normalize(root) !== root || root === path.parse(root).root) throw new AgentSightDeploymentError('AGENTSIGHT_DEPLOYMENT_PATH_INVALID', 'AgentSight 用户部署目录无效');
    for (const directory of [root, path.join(root, 'bin'), path.join(root, 'data')]) {
      try {
        const stat = await fsImpl.promises.lstat(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink() || await fsImpl.promises.realpath(directory) !== directory ||
            typeof process.getuid === 'function' && stat.uid !== process.getuid() || (stat.mode & 0o022) !== 0) {
          throw new AgentSightDeploymentError('AGENTSIGHT_DEPLOYMENT_UNSAFE', 'AgentSight 用户目录的归属或权限不安全，已停止部署');
        }
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    if (!configPath) {
      try {
        await regularFile(path.join(root, 'config.json'), fsImpl);
        await fsImpl.promises.access(path.join(root, 'config.json'), fs.constants.R_OK);
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    if (configPath) {
      await regularFile(configPath, fsImpl);
      await fsImpl.promises.access(configPath, fs.constants.R_OK);
    }
    if (binary) {
      await regularFile(binary, fsImpl);
      await fsImpl.promises.access(binary, fs.constants.X_OK);
    } else {
      const installed = path.join(root, 'bin', 'agentsight');
      try {
        await regularFile(installed, fsImpl);
        await fsImpl.promises.access(installed, fs.constants.X_OK);
        binary = installed;
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    let payload;
    if (!binary) {
      if (process.platform !== 'linux' || process.arch !== 'x64') throw new AgentSightDeploymentError('AGENTSIGHT_PACKAGE_INVALID', 'AgentSight 用户级部署目前仅支持 Linux x64');
      const directories = env.SYSOM_AGENTSIGHT_PACKAGE ? [env.SYSOM_AGENTSIGHT_PACKAGE] : [...packageDirectories, path.join(root, 'package'), '/usr/local/share/sysom/agentsight-runtime', '/usr/share/sysom/agentsight-runtime'];
      for (const directory of directories) {
        if (!path.isAbsolute(directory)) throw new AgentSightDeploymentError('AGENTSIGHT_PACKAGE_INVALID', 'AgentSight 配套安装件路径必须是绝对路径');
        try { await fsImpl.promises.lstat(directory); }
        catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        payload = await verifyAgentSightPackage(directory, { fsImpl, signal });
        break;
      }
      if (!payload) throw new AgentSightDeploymentError('AGENTSIGHT_PACKAGE_MISSING', '未找到 AgentSight 独立配套安装件；请随应用提供 agentsight-runtime 目录或使用独立安装件，应用不会联网下载');
    }
    signal?.throwIfAborted();
    await privateDirectory(root, fsImpl);
    await privateDirectory(path.join(root, 'data'), fsImpl);
    if (binary === path.join(root, 'bin', 'agentsight')) await privateDirectory(path.join(root, 'bin'), fsImpl);
    if (payload) {
      await privateDirectory(path.join(root, 'bin'), fsImpl);
      binary = path.join(root, 'bin', 'agentsight');
      await publish(binary, async temporary => {
        await fsImpl.promises.copyFile(payload.binary, temporary, fs.constants.COPYFILE_EXCL);
        if (await packageDigest(temporary, fsImpl, signal) !== payload.manifest.sha256) throw new AgentSightDeploymentError('AGENTSIGHT_PACKAGE_CHECKSUM', 'AgentSight 复制后校验失败，未安装');
      }, 0o700, fsImpl, signal);
    }
    if (!configPath) {
      configPath = path.join(root, 'config.json');
      try {
        await regularFile(configPath, fsImpl);
        await fsImpl.promises.access(configPath, fs.constants.R_OK);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        const config = {
          schema_version: 6, traceEnabled: false, cmdline: { allow: [] },
          storage: { base_path: path.join(root, 'data') }, server: { auth: { enabled: true } },
          features: { token_stats: true, tokenizer: { enabled: false }, session_mapping: { enabled: true }, sqlite_storage: { enabled: true },
            interruption_detection: { enabled: true }, token_consumption: true, sls_logtail: false,
            trajectory_collection: { enabled: false }, reuse_llm_judge: false },
          deadloop: { enabled: false }, runtime: { sls_logtail_path: '' },
        };
        await publish(configPath, temporary => fsImpl.promises.writeFile(temporary, JSON.stringify(config, null, 2) + '\n', { flag: 'wx', mode: 0o600 }), 0o600, fsImpl, signal);
      }
    }
    return { binary, configPath, root };
  } catch (error) {
    if (signal?.aborted) throw new AgentSightDeploymentError('AGENTSIGHT_DEPLOYMENT_CANCELLED', 'AgentSight 用户级部署已取消');
    if (error instanceof AgentSightDeploymentError) throw error;
    throw new AgentSightDeploymentError('AGENTSIGHT_DEPLOYMENT_FAILED', 'AgentSight 用户级部署失败，请检查独立安装件及用户目录权限');
  }
}

module.exports = { agentSightHome, prepareAgentSight, verifyAgentSightPackage, AgentSightDeploymentError };
