'use strict';

// Shared fixtures for the sysAK idc_inspect schema 1.1 collection tests.
// The raw envelope mirrors the real `sysak idc_inspect` output (compact subset);
// section data sits beside status/reason, with no 1.0 `content` wrapper.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TIMESTAMP = '2026-11-01T12:34:56.000Z';
const GiB = 1024 ** 3;
const PID = 101;
const STARTTIME = 1000;
const COMM = 'fixture-process';

function coverage(sections) {
  const values = Object.values(sections);
  return {
    requested: values.length,
    completed: values.filter((item) => item.status === 'ok').length,
    partial: values.filter((item) => item.status === 'partial').length,
    skipped: values.filter((item) => item.status === 'skipped').length,
    failed: values.filter((item) => !['ok', 'partial', 'skipped'].includes(item.status)).length,
  };
}

function template() {
  const sections = {
    cpu: {
      status: 'ok', reason: '', detail: '', sample_window_ms: 1000, truncated: false, parse_errors: 0,
      cpu_count: 8,
      total: { user_pct: 30.1, nice_pct: 0, system_pct: 9.8, idle_pct: 59.1, iowait_pct: 0.5, irq_pct: 0, softirq_pct: 0.5, steal_pct: 0, usage_pct: 40.4 },
      stat: { procs_running: 2, procs_blocked: 0 },
      load: { '1m': 9.13, '5m': 7.4, '15m': 6.2, per_cpu_1m: 1.14 },
    },
    memory: {
      status: 'ok', reason: '', detail: '', truncated: false, parse_errors: 0,
      total_kb: 15464756, available_kb: 7148964, available_pct: 46.2, used_kb: 8315792, usage_pct: 53.8,
      free_kb: 4102380, buffers_kb: 220144, cached_kb: 2826440, dirty_kb: 1024, writeback_kb: 0,
      slab_kb: 412300, sreclaimable_kb: 300100, sunreclaim_kb: 112200, sunreclaim_pct: 0.7,
      commit_limit_kb: 20000000, committed_kb: 9000000, commit_pct: 45,
      swap_total_kb: 0, swap_free_kb: 0, swap_used_pct: 0, oom_kill: 0,
    },
    psi: {
      status: 'ok', reason: '', detail: '', available: true,
      cpu: { available: true, some_avg10: 4.2, full_avg10: 0, some_avg60: 3.1, full_avg60: 0 },
      memory: { available: true, some_avg10: 1.5, full_avg10: 0.2, some_avg60: 1.1, full_avg60: 0.1 },
      io: { available: true, some_avg10: 0.8, full_avg10: 0.1, some_avg60: 0.6, full_avg60: 0 },
    },
    disk: {
      status: 'ok', reason: '', detail: '', truncated: false, parse_errors: 0, skipped: 0,
      devices: [{ name: 'nvme0n1', read_bytes_per_sec: 0, write_bytes_per_sec: 0 }],
      mounts: [{
        target: '/', source: '/dev/nvme0n1p3', fstype: 'ext4', read_only: false, is_network: false, status: 'ok',
        size_bytes: 40 * GiB, avail_bytes: 9 * GiB, used_pct: 77.5,
        inodes: 2608144, inodes_free: 2352319, inodes_used_pct: 9.8,
      }],
      hung_mounts: [],
    },
    fd: {
      status: 'ok', reason: '', detail: '', truncated: false, parse_errors: 0,
      allocated: 15520, max: 1048576, usage_pct: 1.5, nr_open: 1048576, scanned: true, denied: 0,
      top_procs: [{ pid: PID, comm: COMM, fd_count: 128, fd_limit: 1024, usage_pct: 12.5, starttime: STARTTIME }],
    },
    process: {
      status: 'ok', reason: '', detail: '', sample_window_ms: 1000, truncated: false, parse_errors: 0,
      nr_threads: 512,
      top_cpu: [{ pid: PID, starttime: STARTTIME, comm: COMM, state: 'S', ppid: 1, num_threads: 4,
        cpu_pct: 96, sys_pct: 6, user_pct: 90, cpu_pct_node: 12, sys_pct_node: 0.75, blkio_pct: 0, rss_kb: 250, uid: 1000 }],
      top_rss: [{ pid: PID, starttime: STARTTIME, comm: COMM, state: 'S', ppid: 1, num_threads: 4, rss_kb: 250, uid: 1000 }],
      top_sys: [], top_blkio_wait: [], top_d_state: [],
    },
    io: {
      status: 'ok', reason: '', detail: '', interval_ms: 1000, denied: 0,
      by_disk: [{ pid: PID, starttime: STARTTIME, comm: COMM, read_bytes_per_sec: 1000, write_bytes_per_sec: 3000,
        disk_bytes_per_sec: 4000, read_iops: 2, write_iops: 6 }],
      by_vfs: [{ pid: PID, starttime: STARTTIME, comm: COMM, rchar_bytes_per_sec: 5000, wchar_bytes_per_sec: 7000,
        vfs_bytes_per_sec: 12000, write_cached_only: true }],
      total_disk_read_bytes_per_sec: 1000, total_disk_write_bytes_per_sec: 3000,
      total_vfs_read_bytes_per_sec: 5000, total_vfs_write_bytes_per_sec: 7000,
    },
    energy: {
      status: 'ok', reason: '', detail: '', available: true,
      zones: [{ name: 'intel-rapl:0', label: 'package-0', watts: 13.5, energy_delta_uj: 13500000, max_energy_range_uj: 262143328850 }],
      total_watts: 13.5, nr_zones: 1, unresolved_wrap: 0, denied: 0,
    },
    gpu: {
      status: 'unavailable', reason: 'no_nvidia_smi', detail: 'nvidia-smi not found',
      available: false, gpu_count: 0, pci_count: 0, smi_count: 0, lost_card_num: 0, xid_count: -1,
      nvswitch_error_count: 0, devices: [],
    },
    log: {
      status: 'ok', reason: '', detail: '', source: 'dmesg', timestamped: true, window_sec: 600,
      nr_records: 128, categories: {}, hits: 0, hung_tasks: [],
    },
    network: { status: 'ok', reason: '', detail: '', tcp_retrans: 0, listen_overflows: 0 },
    service: { status: 'ok', reason: '', detail: '', systemd_available: true, failed_units: [], failed_count: 0 },
  };
  const envelope = {
    schema_version: '1.1',
    request_id: '00000000-0000-4000-8000-000000000000',
    collector: { name: 'sysak', command: 'idc_inspect', version: '1.0.0' },
    device: { platform: 'Linux', machine: 'x86_64', hostname: 'fixture-host', scope: 'local' },
    host: { hostname: 'fixture-host', arch: 'x86_64', cpu_count: 8 },
    collection: {
      profile: 'inspection', status: 'ok',
      started_at: TIMESTAMP, finished_at: TIMESTAMP, duration_ms: 1000,
      sample_window_ms: 1000, budget_ms: 24000, truncated: false,
      sections: Object.fromEntries(Object.entries(sections).map(([name, value]) =>
        [name, { status: value.status, reason: value.reason, detail: value.detail }])),
    },
    sections,
    limits: { max_processes: 16384, top_n: 50, max_log_hits: 64, max_json_bytes: 8388608 },
    capabilities: { read_only: true, supported_profiles: ['inspection'], unsupported_actions: ['cleanup', 'optimize', 'process-kill'] },
  };
  envelope.collection.coverage = coverage(envelope.collection.sections);
  return envelope;
}

// Fresh envelope per call; set request_id and mutate fields as needed.
function rawSnapshot(requestId) {
  const raw = template();
  if (requestId !== undefined) raw.request_id = requestId;
  return raw;
}

// A fake system sysAK installation that satisfies resolveSysak's preflight
// (executable launcher + idc_inspect component + matching rule). Never executed.
function sysakInstall(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sysom-sysak-fixture-'));
  const binary = path.join(root, 'sysak');
  fs.writeFileSync(binary, '#!/bin/sh\n# inert fixture; never executed\n', { mode: 0o755 });
  const tools = path.join(root, '.sysak_components', 'tools');
  fs.mkdirSync(tools, { recursive: true });
  fs.writeFileSync(path.join(tools, 'idc_inspect'), '#!/usr/bin/env python3\n# inert fixture\n', { mode: 0o755 });
  fs.writeFileSync(path.join(tools, '.sysak.rules'), 'detect/generic:idc_inspect:python-dep{python3}:help{fixture}\n');
  if (t) t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, binary, components: path.join(root, '.sysak_components'), tools };
}

module.exports = { TIMESTAMP, GiB, PID, STARTTIME, COMM, rawSnapshot, sysakInstall };