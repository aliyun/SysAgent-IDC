const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const gpuVendors = new Set(['0x10de', '0x1002', '0x8086']);

function read(file) {
  try {
    return fs.readFileSync(file, 'utf8').trim().toLowerCase();
  } catch {
    return '';
  }
}

function linuxPciGpu(pciRoot) {
  let entries;
  try {
    entries = fs.readdirSync(pciRoot);
  } catch {
    return false;
  }
  return entries.some((entry) => {
    const device = path.join(pciRoot, entry);
    return read(path.join(device, 'class')).startsWith('0x03') && gpuVendors.has(read(path.join(device, 'vendor')));
  });
}

function detectGpu({
  env = process.env,
  platform = process.platform,
  pciRoot = '/sys/bus/pci/devices',
  devRoot = '/dev',
  run = spawnSync,
} = {}) {
  if (env.SYSOM_GPU === '0' || env.SYSOM_GPU === '1') return env.SYSOM_GPU === '1';
  if (platform === 'linux') return linuxPciGpu(pciRoot) || fs.existsSync(path.join(devRoot, 'nvidia0'));
  let result;
  if (platform === 'win32') {
    const powershell = path.join(env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    result = run(powershell, ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_VideoController | ForEach-Object { "$($_.Name) $($_.PNPDeviceID)" }'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
  } else if (platform === 'darwin') {
    result = run('/usr/sbin/system_profiler', ['SPDisplaysDataType'], { encoding: 'utf8', timeout: 5000 });
  } else {
    return false;
  }
  if (result.error || result.status !== 0) return false;
  return String(result.stdout).split(/\r?\n/).some((line) => (
    /PCI\\VEN_(10DE|1002|8086)/i.test(line) || /nvidia|geforce|quadro|tesla|radeon|amd|intel|apple/i.test(line)
  ) && !/software|virtual|vmware|parallels/i.test(line));
}

function hasRenderNode(driRoot = '/dev/dri') {
  try {
    return fs.readdirSync(driRoot).some((entry) => entry.startsWith('renderD'));
  } catch {
    return false;
  }
}

module.exports = { detectGpu, hasRenderNode };
