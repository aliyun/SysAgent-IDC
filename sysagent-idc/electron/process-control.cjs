const { spawn } = require('node:child_process');
const path = require('node:path');
const { connectRootIdc } = require('./sysak-root.cjs');

function runProcessAction(binary, action, targets, { spawnImpl = spawn, launchImpl = connectRootIdc, managerPid = process.pid } = {}) {
  return new Promise((resolve, reject) => {
    const child = launchImpl(binary, ['idc', '--process-action', action], {
      cwd: path.dirname(binary), shell: false, stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8', PYTHONDONTWRITEBYTECODE: '1' },
    }, spawnImpl);
    const chunks = [];
    let bytes = 0;
    let failure;
    const fail = (message) => {
      if (failure) return;
      failure = new Error(message);
      clearTimeout(timer);
      try { child.kill('SIGTERM'); } catch {}
      reject(failure);
    };
    const timer = setTimeout(() => fail('进程操作超时，结果可能不完整，请刷新后核对'), 15000);
    child.stdout.on('data', (chunk) => {
      if (failure) return;
      bytes += chunk.length;
      if (bytes > 65536) fail('sysAK 进程操作响应超过限制');
      else chunks.push(chunk);
    });
    child.stderr.on('data', () => {});
    child.stdin.on('error', () => {});
    child.on('error', error => { clearTimeout(timer); if (!failure) reject(error.code === 'ROOT_COLLECTOR_UNAVAILABLE' ? error : new Error('无法启动 sysAK 进程操作')); });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (failure) return reject(failure);
      if (code === 126 || code === 127) return reject(new Error('sysAK IDC 服务身份或组件校验失败'));
      if (code === 75) return reject(new Error('sysAK IDC 服务忙，请稍后重试'));
      if (code !== 0) return reject(new Error('sysAK 进程操作不可用'));
      try {
        const reply = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const statuses = action === 'check' ? ['eligible', 'protected', 'permission_denied', 'stale', 'gone', 'unsupported'] : ['signalled', 'protected', 'permission_denied', 'stale', 'gone', 'unsupported'];
        if (reply.schema_version !== '1.0' || reply.action !== action || !Array.isArray(reply.results) || reply.results.length !== targets.length ||
            !reply.results.every((item, index) => item.pid === targets[index].pid && item.starttime === targets[index].starttime &&
              typeof item.eligible === 'boolean' && statuses.includes(item.status) && typeof item.name === 'string' && typeof item.reason === 'string' &&
              (item.eligible === (item.status === 'eligible' || item.status === 'signalled')))) throw new Error('invalid reply');
        resolve(reply.results);
      } catch { reject(new Error('sysAK 返回无效的进程操作结果')); }
    });
    child.stdin.end(JSON.stringify({ manager_pid: managerPid, targets }));
  });
}

module.exports = { runProcessAction };
