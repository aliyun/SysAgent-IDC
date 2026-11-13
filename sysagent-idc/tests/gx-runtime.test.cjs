'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const helper = path.resolve(__dirname, '../build/gx-runtime.py');
// Import, never execute __main__. All package queries, loader commands, identities,
// executable checks and installation trust checks are mocked. Only temporary
// fixture files are read/written; GX and host /etc paths are never accessed.
const script = String.raw`
import importlib.util
import io
import os
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

spec = importlib.util.spec_from_file_location('gx_runtime_under_test', sys.argv[1])
m = importlib.util.module_from_spec(spec)
with mock.patch.object(os, 'getuid', side_effect=AssertionError('install ran during import')) as uid, \
     mock.patch.object(os, 'access', side_effect=AssertionError('access ran during import')) as access, \
     mock.patch.object(subprocess, 'run', side_effect=AssertionError('subprocess ran during import')) as run:
    spec.loader.exec_module(m)
    uid.assert_not_called()
    access.assert_not_called()
    run.assert_not_called()

QUERY = ['/usr/bin/dpkg-query', '-W', '-f=$' + '{Status}\t$' + '{Version}', 'gx']
LDCONFIG = ['/sbin/ldconfig']
ENV = {'PATH': '/usr/bin:/bin', 'LC_ALL': 'C'}
CONTENT = b'/usr/lib64\n'
READY = 'SysAgent: GX 0.6.5-2 runtime and library path are ready.\n'
RESOURCES = tuple(map(Path, (
    '/usr/bin/gx', '/usr/lib64/libgx.so', '/usr/lib64/libgx_client.so',
    '/usr/lib64/libgx_nvinfo.bin', '/usr/lib64/libgx_amdinfo.bin', '/etc/libgx.yaml',
)))


def query_call():
    return mock.call(QUERY, env=ENV, stdout=subprocess.PIPE,
                     stderr=subprocess.PIPE, check=True)


def loader_call():
    return mock.call(LDCONFIG, env=ENV, check=True)


class HarnessCase(unittest.TestCase):
    def patch(self, obj, name, **kwargs):
        patcher = mock.patch.object(obj, name, **kwargs)
        value = patcher.start()
        self.addCleanup(patcher.stop)
        return value

    def setUp(self):
        # Cleanup happens after patches stop; never point CONFIG at host /etc.
        temporary = tempfile.TemporaryDirectory(prefix='gx-runtime-test-')
        self.addCleanup(temporary.cleanup)
        self.config = Path(temporary.name) / 'sysagent-gx.conf'
        self.patch(m, 'CONFIG', new=self.config)
        self.uid = self.patch(m.os, 'getuid', return_value=0)
        self.access = self.patch(m.os, 'access', return_value=True)
        self.run = self.patch(m.subprocess, 'run', side_effect=AssertionError('unexpected subprocess'))
        self.output = io.StringIO()
        self.patch(sys, 'stdout', new=self.output)

    def snapshot(self):
        info = self.config.lstat()
        return (self.config.read_bytes(), info.st_ino, info.st_mode, info.st_mtime_ns)


class Install(HarnessCase):
    def setUp(self):
        super().setUp()
        self.package_output = b'install ok installed\t0.6.5-2\n'
        self.package_error = None
        self.loader_error = None
        self.missing = None
        self.reject_config = False
        self.run.side_effect = self.fake_run
        self.trust = self.patch(m, 'trusted', side_effect=self.fake_trusted)
        # Permit the helper's real exclusive file creation only inside this fixture.
        self.real_open = os.open
        self.open = self.patch(m.os, 'open', side_effect=self.safe_open)

    def fake_run(self, argv, **kwargs):
        # Strict kwargs equality also forbids shell, inherited environment and GX execution.
        if argv == QUERY:
            self.assertEqual(kwargs, dict(env=ENV, stdout=subprocess.PIPE,
                                          stderr=subprocess.PIPE, check=True))
            if self.package_error is not None:
                raise self.package_error
            return subprocess.CompletedProcess(argv, 0, self.package_output, b'')
        self.assertEqual(argv, LDCONFIG, 'only dpkg-query and ldconfig may be requested')
        self.assertEqual(kwargs, dict(env=ENV, check=True))
        if self.loader_error is not None:
            raise self.loader_error
        return subprocess.CompletedProcess(argv, 0)

    def fake_trusted(self, filename, directory=False):
        self.assertIn(filename, (*RESOURCES, self.config.parent, self.config))
        self.assertEqual(directory, filename == self.config.parent)
        if filename == self.missing:
            raise FileNotFoundError('missing required GX resource')
        if filename == self.config and self.reject_config:
            raise RuntimeError('Unsafe GX runtime path')

    def safe_open(self, filename, flags, mode):
        self.assertEqual(filename, self.config)
        self.assertEqual(flags, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW)
        self.assertEqual(mode, 0o644)
        return self.real_open(filename, flags, mode)

    def assert_preloader_rejection(self):
        self.assertEqual(self.run.call_args_list, [query_call()])
        self.open.assert_not_called()
        self.assertEqual(self.output.getvalue(), '')

    def test_exact_configured_version_success(self):
        m.install()
        self.uid.assert_called_once_with()
        self.access.assert_called_once_with('/usr/bin/gx', os.X_OK)
        self.assertEqual(self.trust.call_args_list,
                         [mock.call(resource) for resource in RESOURCES] +
                         [mock.call(self.config.parent, directory=True)])
        self.assertEqual(self.run.call_args_list, [query_call(), loader_call()])
        self.open.assert_called_once_with(self.config,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644)
        self.assertEqual(self.config.read_bytes(), CONTENT)
        self.assertFalse(self.config.is_symlink())
        self.assertEqual(self.output.getvalue(), READY)

    def test_idempotence_preserves_existing_config(self):
        m.install()
        # Even a pre-existing stricter mode must not be rewritten or chmodded.
        self.config.chmod(0o600)
        before = self.snapshot()
        self.trust.reset_mock()
        m.install()
        self.assertEqual(self.snapshot(), before)
        self.open.assert_called_once()
        self.assertEqual(self.run.call_args_list,
                         [query_call(), loader_call(), query_call(), loader_call()])
        self.assertEqual(self.trust.call_args_list,
                         [mock.call(resource) for resource in RESOURCES] +
                         [mock.call(self.config.parent, directory=True), mock.call(self.config)])
        self.assertEqual(self.output.getvalue(), READY * 2)

    def reject_package(self):
        # Prove rejection also preserves an already-existing loader configuration.
        self.config.write_bytes(b'existing loader configuration\n')
        before = self.snapshot()
        with self.assertRaisesRegex(RuntimeError, '^Configured GX 0[.]6[.]5-2 is required$'):
            m.install()
        self.assert_preloader_rejection()
        self.trust.assert_not_called()
        self.access.assert_not_called()
        self.assertEqual(self.snapshot(), before)

    def test_old_or_other_version_rejected(self):
        for version in (b'0.6.5-1', b'0.6.4-2', b'0.6.5-20', b'0.6.6-1'):
            with self.subTest(version=version):
                self.run.reset_mock()
                self.package_output = b'install ok installed\t' + version
                self.reject_package()

    def test_unconfigured_package_rejected(self):
        for status in (b'install ok unpacked', b'install ok half-configured',
                       b'deinstall ok config-files'):
            with self.subTest(status=status):
                self.run.reset_mock()
                self.package_output = status + b'\t0.6.5-2'
                self.reject_package()

    def test_missing_package_rejected(self):
        for output in (b'', b'unknown ok not-installed\t'):
            with self.subTest(output=output):
                self.run.reset_mock()
                self.package_output = output
                self.reject_package()
        self.run.reset_mock()
        before = self.snapshot()
        self.package_error = subprocess.CalledProcessError(1, QUERY, stderr=b'no packages found')
        with self.assertRaises(subprocess.CalledProcessError) as raised:
            m.install()
        self.assertIs(raised.exception, self.package_error)
        self.assert_preloader_rejection()
        self.trust.assert_not_called()
        self.access.assert_not_called()
        self.assertEqual(self.snapshot(), before)

    def test_missing_required_resources_rejected(self):
        self.config.write_bytes(b'unchanged loader configuration\n')
        before = self.snapshot()
        for index, resource in enumerate(RESOURCES):
            with self.subTest(resource=str(resource)):
                self.run.reset_mock()
                self.trust.reset_mock()
                self.missing = resource
                with self.assertRaisesRegex(FileNotFoundError, 'missing required GX resource'):
                    m.install()
                self.assert_preloader_rejection()
                self.assertEqual(self.trust.call_args_list,
                                 [mock.call(item) for item in RESOURCES[:index + 1]])
                self.access.assert_not_called()
                self.assertEqual(self.snapshot(), before)

    def test_nonexecutable_gx_rejected(self):
        self.access.return_value = False
        with self.assertRaisesRegex(RuntimeError, '^GX executable is unavailable$'):
            m.install()
        self.assert_preloader_rejection()
        self.assertFalse(self.config.exists())
        self.assertEqual(self.trust.call_args_list, [mock.call(item) for item in RESOURCES])
        self.access.assert_called_once_with('/usr/bin/gx', os.X_OK)

    def test_conflicting_file_unchanged(self):
        self.config.write_bytes(b'/unmanaged/library/path\n')
        before = self.snapshot()
        with self.assertRaisesRegex(RuntimeError, 'Existing GX loader configuration is not managed by SysAgent'):
            m.install()
        self.assert_preloader_rejection()
        self.trust.assert_any_call(self.config)
        self.assertEqual(self.snapshot(), before)

    def test_conflicting_symlinks_unchanged(self):
        # Both matching and conflicting targets, and a dangling link, remain untouched.
        target = self.config.parent / 'inert-target'
        for content in (CONTENT, b'/unmanaged/library/path\n', None):
            with self.subTest(content=content):
                self.run.reset_mock()
                self.trust.reset_mock()
                if content is not None:
                    target.write_bytes(content)
                self.config.symlink_to(target.name)
                link_before = self.config.lstat()
                self.reject_config = True
                # Reads must not follow the symlink, even to a matching fixture.
                with mock.patch.object(Path, 'read_bytes', side_effect=AssertionError('followed symlink')):
                    with self.assertRaisesRegex(RuntimeError, '^Unsafe GX runtime path$'):
                        m.install()
                self.assert_preloader_rejection()
                self.trust.assert_any_call(self.config)
                self.assertEqual(self.config.lstat(), link_before)
                self.assertEqual(os.readlink(self.config), target.name)
                if content is None:
                    self.assertFalse(target.exists())
                else:
                    self.assertEqual(target.read_bytes(), content)
                    target.unlink()
                self.config.unlink()

    def test_ldconfig_failure_reported(self):
        self.loader_error = subprocess.CalledProcessError(1, LDCONFIG, stderr=b'inert loader failure')
        with self.assertRaises(subprocess.CalledProcessError) as raised:
            m.install()
        self.assertIs(raised.exception, self.loader_error)
        self.assertEqual(self.run.call_args_list, [query_call(), loader_call()])
        self.assertEqual(self.config.read_bytes(), CONTENT)
        self.assertEqual(self.output.getvalue(), '')

    def test_nonroot_rejected(self):
        self.uid.return_value = 1000
        with self.assertRaisesRegex(RuntimeError, '^GX runtime integration requires the package installer$'):
            m.install()
        self.uid.assert_called_once_with()
        self.run.assert_not_called()
        self.trust.assert_not_called()
        self.access.assert_not_called()
        self.open.assert_not_called()
        self.assertFalse(self.config.exists())
        self.assertEqual(self.output.getvalue(), '')


class Trusted(HarnessCase):
    def setUp(self):
        super().setUp()
        self.leaf = Path('/inert/gx/runtime/libgx.so')
        self.order = [*reversed(self.leaf.parents), self.leaf]
        self.nodes = {item: self.info(stat.S_IFDIR | 0o755, links=2)
                      for item in self.leaf.parents}
        self.nodes[self.leaf] = self.info(stat.S_IFREG | 0o644)
        self.lstat = self.patch(Path, 'lstat', autospec=True, side_effect=self.fake_lstat)

    @staticmethod
    def info(mode, uid=0, links=1):
        return SimpleNamespace(st_mode=mode, st_uid=uid, st_gid=0, st_nlink=links)

    def fake_lstat(self, item):
        self.assertIn(item, self.nodes, 'lstat must never inspect the host filesystem')
        return self.nodes[item]

    def reject_each_node(self, transform, message):
        for item in self.order:
            with self.subTest(path=str(item)):
                original = self.nodes[item]
                self.nodes[item] = transform(original)
                self.lstat.reset_mock()
                with self.assertRaisesRegex(RuntimeError, message):
                    m.trusted(self.leaf)
                self.assertEqual(self.lstat.call_args_list,
                                 [mock.call(node) for node in self.order[:self.order.index(item) + 1]])
                self.nodes[item] = original

    def test_root_owned_regular_file_and_directories(self):
        m.trusted(self.leaf)
        self.assertEqual(self.lstat.call_args_list, [mock.call(item) for item in self.order])
        self.lstat.reset_mock()
        self.nodes[self.leaf] = self.info(stat.S_IFDIR | 0o755, links=2)
        m.trusted(self.leaf, directory=True)
        self.assertEqual(self.lstat.call_args_list, [mock.call(item) for item in self.order])
        self.run.assert_not_called()
        self.uid.assert_not_called()
        self.access.assert_not_called()

    def test_symlink_ancestors_and_leaf_rejected(self):
        self.reject_each_node(lambda original: self.info(stat.S_IFLNK | 0o755),
                              '^Unsafe GX runtime path$')

    def test_file_ancestors_rejected(self):
        for ancestor in self.leaf.parents:
            with self.subTest(ancestor=str(ancestor)):
                original = self.nodes[ancestor]
                self.nodes[ancestor] = self.info(stat.S_IFREG | 0o644)
                with self.assertRaisesRegex(RuntimeError, '^Unsafe GX runtime ancestor$'):
                    m.trusted(self.leaf)
                self.nodes[ancestor] = original

    def test_nonroot_ownership_rejected(self):
        self.reject_each_node(lambda original: self.info(original.st_mode, uid=1000),
                              '^Unsafe GX runtime path$')

    def test_group_or_world_writable_rejected(self):
        for write_bits in (0o020, 0o002, 0o022):
            with self.subTest(write_bits=oct(write_bits)):
                self.reject_each_node(lambda original: self.info(original.st_mode | write_bits),
                                      '^Unsafe GX runtime path$')

    def test_nonregular_or_hardlinked_leaf_rejected(self):
        for kind in (stat.S_IFDIR, stat.S_IFIFO, stat.S_IFSOCK, stat.S_IFCHR, stat.S_IFBLK):
            with self.subTest(kind=kind):
                self.nodes[self.leaf] = self.info(kind | 0o644)
                with self.assertRaisesRegex(RuntimeError, '^GX runtime file is missing or unsafe$'):
                    m.trusted(self.leaf)
        for links in (0, 2, 3):
            with self.subTest(links=links):
                self.nodes[self.leaf] = self.info(stat.S_IFREG | 0o644, links=links)
                with self.assertRaisesRegex(RuntimeError, '^GX runtime file is missing or unsafe$'):
                    m.trusted(self.leaf)

    def test_directory_flag_rejects_regular_file(self):
        with self.assertRaisesRegex(RuntimeError, '^GX runtime directory is missing$'):
            m.trusted(self.leaf, directory=True)


suite = unittest.defaultTestLoader.loadTestsFromName(sys.argv[2], module=sys.modules[__name__])
result = unittest.TextTestRunner(verbosity=2).run(suite)
sys.exit(0 if result.wasSuccessful() else 1)
`;

const cases = [
  ['exact configured version succeeds with fixed subprocess argv/env', 'Install.test_exact_configured_version_success'],
  ['installation is idempotent and preserves existing config', 'Install.test_idempotence_preserves_existing_config'],
  ['old or other package versions fail before loader mutation', 'Install.test_old_or_other_version_rejected'],
  ['unconfigured packages fail before loader mutation', 'Install.test_unconfigured_package_rejected'],
  ['missing packages fail before loader mutation', 'Install.test_missing_package_rejected'],
  ['every required resource is mandatory before loader mutation', 'Install.test_missing_required_resources_rejected'],
  ['nonexecutable GX is rejected without running GX', 'Install.test_nonexecutable_gx_rejected'],
  ['conflicting loader file remains unchanged', 'Install.test_conflicting_file_unchanged'],
  ['conflicting loader symlinks and their targets remain unchanged', 'Install.test_conflicting_symlinks_unchanged'],
  ['ldconfig failure propagates without a success report', 'Install.test_ldconfig_failure_reported'],
  ['nonroot installation fails before external operations', 'Install.test_nonroot_rejected'],
  ['trusted accepts root-owned regular file and directory chains', 'Trusted.test_root_owned_regular_file_and_directories'],
  ['trusted rejects symlinks at every path level', 'Trusted.test_symlink_ancestors_and_leaf_rejected'],
  ['trusted rejects ordinary-file ancestors', 'Trusted.test_file_ancestors_rejected'],
  ['trusted rejects nonroot ownership at every path level', 'Trusted.test_nonroot_ownership_rejected'],
  ['trusted rejects group/world write at every path level', 'Trusted.test_group_or_world_writable_rejected'],
  ['trusted rejects nonregular and hardlinked leaves', 'Trusted.test_nonregular_or_hardlinked_leaf_rejected'],
  ['trusted directory checks reject an ordinary file', 'Trusted.test_directory_flag_rejects_regular_file'],
];

for (const [name, selector] of cases) {
  test(name, { timeout: 15000 }, () => {
    const result = spawnSync('python3', ['-I', '-B', '-', helper, selector], {
      input: script,
      encoding: 'utf8',
      timeout: 10000,
      maxBuffer: 1024 * 1024,
      shell: false,
    });
    const diagnostics = `${result.stdout || ''}${result.stderr || ''}`;
    assert.equal(result.error, undefined, result.error ? result.error.message : diagnostics);
    assert.equal(result.signal, null, diagnostics);
    assert.equal(result.status, 0, diagnostics);
  });
}
