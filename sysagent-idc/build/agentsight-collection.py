#!/usr/bin/python3
"""Fixed-path management requiring explicit consent to host-wide content capture."""

import argparse
import contextlib
import fcntl
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import stat
import subprocess
import sys
import tempfile
import time

RUNTIME = Path('/usr/share/sysom/agentsight-runtime')
HELPER = RUNTIME / 'agentsight-collection.py'
BINARY = RUNTIME / 'agentsight'
MANIFEST = RUNTIME / 'manifest.json'
CONTROL = Path('/etc/sysom-agentsight')
CONSENT = CONTROL / 'consent.json'
CONFIG = CONTROL / 'config.json'
LOCK = CONTROL / 'collection.lock'
ALLOWED_UID = Path('/etc/sysom-idc/allowed-uid')
DATA_PARENT = Path('/var/lib/sysom-agentsight')
UNIT_DIR = Path('/usr/lib/systemd/system')
DROPIN_DIR = Path('/etc/systemd/system')
RUN_UNIT_DIR = Path('/run/systemd/system')
SYSTEMCTL = Path('/usr/bin/systemctl')
UNITS = ('sysom-agentsight-trace.service', 'sysom-agentsight-api.service')
DROPIN_NAME = '50-sysom-agentsight.conf'
MAX_JSON = 16 * 1024
MAX_BINARY = 256 * 1024 * 1024
CONSENT_VERSION = 2
STORAGE_LIMIT_MB = 50
TIMEOUT = 20
DEADLINE = None
SAFE_ENV = {
    'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'HOME': '/root',
    'LANG': 'C', 'LC_ALL': 'C', 'SYSTEMD_PAGER': 'cat',
    'SYSTEMD_COLORS': '0', 'SYSTEMD_NO_ASK_PASSWORD': '1',
}
MESSAGES = {
    'OK': 'Both managed services are running.',
    'DISABLED': 'Host capture is disabled.',
    'NOT_ENROLLED': 'Explicit host-capture enrollment is required.',
    'FORBIDDEN': 'Root and the authorized enrollment UID are required.',
    'INVALID_CONSENT': 'The protected enrollment record is invalid.',
    'UNSAFE_PATH': 'A managed path has unsafe ownership, permissions or type.',
    'CONFIG_CONFLICT': 'The config is not the unchanged managed baseline; it was preserved.',
    'INVALID_PACKAGE': 'The installed runtime failed validation.',
    'UNIT_CONFLICT': 'The managed units or numeric drop-ins failed validation.',
    'SYSTEMCTL_FAILED': 'A managed service operation failed.',
    'SYSTEMCTL_UNAVAILABLE': 'The system service manager is unavailable.',
    'NOT_RUNNING': 'One or both managed services are not running.',
    'IO_FAILED': 'A protected enrollment operation failed.',
    'INVALID_ARGUMENT': 'Use a fixed action and an explicit UID and host-capture acceptance for enable.',
}


class CollectionError(Exception):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def fail(code):
    raise CollectionError(code)


def _root_uid():
    return 0


def _require_root():
    if os.geteuid() != 0:
        fail('FORBIDDEN')


def _metadata(path):
    return os.lstat(path)


def _ancestors(path):
    return reversed(Path(path).parents)


def _root_directory(path):
    info = _metadata(path)
    if (not stat.S_ISDIR(info.st_mode) or info.st_uid != _root_uid()
            or info.st_mode & 0o022):
        fail('UNSAFE_PATH')
    return info


def _check_ancestors(path):
    for parent in _ancestors(path):
        _root_directory(parent)


def _root_file_info(info, mode=None):
    if (not stat.S_ISREG(info.st_mode) or info.st_uid != _root_uid()
            or info.st_nlink != 1 or info.st_mode & 0o7022
            or mode is not None and stat.S_IMODE(info.st_mode) != mode):
        fail('UNSAFE_PATH')
    return info


def _root_file(path, mode=None):
    _check_ancestors(path)
    return _root_file_info(_metadata(path), mode)


@contextlib.contextmanager
def _open_root_file(path, mode=None):
    before = _root_file(path, mode)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
    try:
        after = _root_file_info(os.fstat(fd), mode)
        if (before.st_dev, before.st_ino) != (after.st_dev, after.st_ino):
            fail('UNSAFE_PATH')
        with os.fdopen(fd, 'rb', closefd=False) as stream:
            yield stream
    finally:
        os.close(fd)


def _read_bounded(path, limit, mode=None):
    with _open_root_file(path, mode) as stream:
        if os.fstat(stream.fileno()).st_size > limit:
            fail('UNSAFE_PATH')
        data = stream.read(limit + 1)
        if len(data) > limit:
            fail('UNSAFE_PATH')
        return data


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('duplicate key')
        result[key] = value
    return result


def _read_json(path, code, mode=None):
    try:
        return json.loads(_read_bounded(path, MAX_JSON, mode), object_pairs_hook=_unique_object)
    except (ValueError, UnicodeError, RecursionError):
        fail(code)


def _uid(value):
    if isinstance(value, str) and re.fullmatch(r'[1-9][0-9]{0,9}', value):
        value = int(value)
    if type(value) is not int or not 0 < value < 2 ** 31:
        fail('FORBIDDEN')
    return value


def _authorized_account(uid):
    uid = _uid(uid)
    try:
        allowed = _read_bounded(ALLOWED_UID, 64).decode('ascii').strip()
        if _uid(allowed) != uid:
            fail('FORBIDDEN')
        account = pwd.getpwuid(uid)
    except (KeyError, UnicodeError):
        fail('FORBIDDEN')
    if (account.pw_uid != uid or account.pw_name == 'root'
            or type(account.pw_gid) is not int or not 0 < account.pw_gid < 2 ** 31):
        fail('FORBIDDEN')
    return account


def _caller(uid=None):
    _require_root()
    # A present but empty/malformed broker identity must not become a root call.
    if 'SYSOM_IDC_CALLER_UID' in os.environ:
        caller = _uid(os.environ['SYSOM_IDC_CALLER_UID'])
        if uid is not None and caller != uid:
            fail('FORBIDDEN')
        _authorized_account(caller)


def _config_identity(uid):
    # Metadata ONLY: never open or hash an existing operator configuration.
    info = _root_file(CONFIG, 0o644)
    return {
        'uid': uid, 'dev': info.st_dev, 'ino': info.st_ino, 'size': info.st_size,
        'mtime_ns': info.st_mtime_ns, 'ctime_ns': info.st_ctime_ns,
    }


def _consent():
    try:
        record = _read_json(CONSENT, 'INVALID_CONSENT', 0o600)
    except FileNotFoundError:
        return None
    fields = {'version', 'uid', 'enabled', 'scope', 'content_retention', 'managed_config'}
    if (type(record) is not dict or set(record) != fields
            or type(record['version']) is not int or record['version'] not in (1, CONSENT_VERSION)
            or type(record['uid']) is not int or not 0 < record['uid'] < 2 ** 31
            or type(record['enabled']) is not bool or record['scope'] != 'host'
            or record['content_retention'] is not True):
        fail('INVALID_CONSENT')
    identity = record['managed_config']
    keys = {'uid', 'dev', 'ino', 'size', 'mtime_ns', 'ctime_ns'}
    if (type(identity) is not dict or set(identity) != keys
            or any(type(value) is not int or value < 0 for value in identity.values())
            or identity['uid'] != record['uid'] or not 0 < identity['size'] <= MAX_JSON):
        fail('INVALID_CONSENT')
    return record


def _validate_config(record):
    try:
        if _config_identity(record['uid']) != record['managed_config']:
            fail('CONFIG_CONFLICT')
    except FileNotFoundError:
        fail('CONFIG_CONFLICT')


def _make_root_directory(path, mode=0o755):
    _check_ancestors(path)
    try:
        os.mkdir(path, mode)
        os.chmod(path, mode, follow_symlinks=False)
    except FileExistsError:
        pass
    _root_directory(path)


@contextlib.contextmanager
def _locked(create=False):
    # No state is created by status/verify/ensure or a fresh installation setup.
    if create:
        _make_root_directory(CONTROL)
    else:
        try:
            _check_ancestors(CONTROL)
            _root_directory(CONTROL)
        except FileNotFoundError:
            yield
            return
    _check_ancestors(LOCK)
    flags = os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC
    if create:
        flags |= os.O_CREAT
    try:
        fd = os.open(LOCK, flags, 0o600)
    except FileNotFoundError:
        fail('INVALID_CONSENT')
    try:
        _root_file_info(os.fstat(fd), 0o600)
        # Do not wait indefinitely behind another enrollment/systemctl operation.
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            fail('IO_FAILED')
        yield
    finally:
        os.close(fd)


def _publish(path, data, mode, replace=False):
    _check_ancestors(path)
    # Temporary files live only in a root-owned, non-writable directory.
    fd, name = tempfile.mkstemp(prefix='.collection-', dir=path.parent)
    try:
        os.fchmod(fd, mode)
        with os.fdopen(fd, 'wb') as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        if replace:
            _root_file(path, mode)
            os.replace(name, path)
        else:
            os.link(name, path, follow_symlinks=False)  # exclusive; no overwrite
        if os.path.lexists(name):
            os.unlink(name)
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.lexists(name):
            os.unlink(name)


def _json_bytes(value):
    return (json.dumps(value, sort_keys=True, indent=2) + '\n').encode('utf-8')


def _baseline(uid, trace_enabled=False):
    return {
        'schema_version': 6, 'traceEnabled': bool(trace_enabled),
        'cmdline': {'allow': [
            {'agent_name': name, 'rule': pattern}
            for name in ('qoder', 'claude', 'qwen', 'codex', 'openclaw')
            for pattern in ([f'*{name}*'], ['*node*', f'*{name}*'],
                            ['*node*', '*', f'*{name}*'],
                            ['*node*', '*', '*', f'*{name}*'])
        ]},
        'storage': {
            'base_path': str(DATA_PARENT / str(uid)),
            'max_total_size_mb': STORAGE_LIMIT_MB,
        },
        'server': {'auth': {'enabled': True}},
        'features': {
            'token_stats': True, 'tokenizer': {'enabled': False},
            'session_mapping': {'enabled': True}, 'sqlite_storage': {'enabled': True},
            'interruption_detection': {'enabled': True}, 'token_consumption': True,
            'sls_logtail': False, 'trajectory_collection': {'enabled': False},
            'reuse_llm_judge': False,
        },
        'deadloop': {'enabled': False}, 'runtime': {'sls_logtail_path': ''},
    }


def _upgrade_baseline(record):
    if record['version'] == CONSENT_VERSION:
        return
    # Metadata-bound v1 enrollment identifies the untouched generated baseline.
    _validate_config(record)
    _publish(CONFIG, _json_bytes(_baseline(record['uid'], trace_enabled=record['enabled'])), 0o644, replace=True)
    record['version'] = CONSENT_VERSION
    record['managed_config'] = _config_identity(record['uid'])
    _publish(CONSENT, _json_bytes(record), 0o600, replace=True)


def _chown_created_data(path, uid, gid):
    os.chown(path, uid, gid, follow_symlinks=False)


def _data(account, create=False):
    if create:
        _make_root_directory(DATA_PARENT)
    path = DATA_PARENT / str(account.pw_uid)
    _check_ancestors(path)
    if create:
        try:
            os.mkdir(path, 0o700)
        except FileExistsError:
            pass  # Never chown, chmod, descend into or migrate existing user data.
        else:
            os.chmod(path, 0o700, follow_symlinks=False)
            _chown_created_data(path, account.pw_uid, account.pw_gid)
    info = _metadata(path)
    if (not stat.S_ISDIR(info.st_mode) or info.st_uid != account.pw_uid
            or info.st_gid != account.pw_gid or stat.S_IMODE(info.st_mode) != 0o700):
        fail('UNSAFE_PATH')
    return path


def _dropin(account):
    data = DATA_PARENT / str(account.pw_uid)
    return ('[Service]\n'
            f'User={account.pw_uid}\nGroup={account.pw_gid}\n'
            f'WorkingDirectory={data}\nEnvironment="HOME={data}"\n'
            f'ReadWritePaths={data}\n').encode('ascii')


def _static_units():
    for unit in UNITS:
        _root_file(UNIT_DIR / unit, 0o644)
        # Reject alternate unit definitions and unowned/unknown drop-ins rather
        # than silently honoring a different command, UID or sandbox.
        for base in (DROPIN_DIR, RUN_UNIT_DIR):
            _check_ancestors(base)
            if not os.path.lexists(base):
                continue
            _root_directory(base)
            candidate = base / unit
            _check_ancestors(candidate)
            if os.path.lexists(candidate):
                fail('UNIT_CONFLICT')
        for base in (UNIT_DIR, RUN_UNIT_DIR, DROPIN_DIR):
            _check_ancestors(base)
            if not os.path.lexists(base):
                continue
            _root_directory(base)
            directory = base / (unit + '.d')
            _check_ancestors(directory)
            if not os.path.lexists(directory):
                continue
            _root_directory(directory)
            for item in directory.iterdir():
                if item.name.endswith('.conf') and not (
                        base == DROPIN_DIR and item.name == DROPIN_NAME):
                    fail('UNIT_CONFLICT')


def _dropins(account, create=False):
    expected = _dropin(account)
    for unit in UNITS:
        directory = DROPIN_DIR / (unit + '.d')
        if create:
            _make_root_directory(directory)
        file = directory / DROPIN_NAME
        if create and not os.path.lexists(file):
            _publish(file, expected, 0o644)
        if _read_bounded(file, 1024, 0o644) != expected:
            fail('UNIT_CONFLICT')


def _runtime():
    _root_file(HELPER)
    manifest = _read_json(MANIFEST, 'INVALID_PACKAGE')
    if (type(manifest) is not dict or type(manifest.get('schemaVersion')) is not int
            or manifest['schemaVersion'] != 1 or manifest.get('version') != '0.16.0'
            or manifest.get('platform') != 'linux' or manifest.get('arch') != 'x64'
            or type(manifest.get('sha256')) is not str
            or not re.fullmatch(r'[a-f0-9]{64}', manifest['sha256'])):
        fail('INVALID_PACKAGE')
    with _open_root_file(BINARY) as stream:
        before = os.fstat(stream.fileno())
        if (not 64 <= before.st_size <= MAX_BINARY
                or stat.S_IMODE(before.st_mode) & 0o111 != 0o111):
            fail('INVALID_PACKAGE')
        header = stream.read(20)
        if (header[:6] != b'\x7fELF\x02\x01'
                or int.from_bytes(header[18:20], 'little') != 62):
            fail('INVALID_PACKAGE')
        digest = hashlib.sha256(header)
        total = len(header)
        while True:
            block = stream.read(64 * 1024)
            if not block:
                break
            total += len(block)
            if total > MAX_BINARY:
                fail('INVALID_PACKAGE')
            digest.update(block)
        after = os.fstat(stream.fileno())
        if (total != before.st_size or before.st_size != after.st_size
                or before.st_mtime_ns != after.st_mtime_ns
                or before.st_ctime_ns != after.st_ctime_ns
                or digest.hexdigest() != manifest['sha256']):
            fail('INVALID_PACKAGE')


def _systemctl(arguments):
    fixed = {
        ('daemon-reload',), ('enable', '--now', *UNITS),
        ('disable', '--now', *UNITS), ('restart', *UNITS),
        *(('is-active', '--quiet', unit) for unit in UNITS),
        *(('is-failed', '--quiet', unit) for unit in UNITS),
    }
    if arguments not in fixed:
        fail('INVALID_ARGUMENT')
    info = _root_file(SYSTEMCTL)
    if stat.S_IMODE(info.st_mode) & 0o111 != 0o111:
        fail('UNSAFE_PATH')
    remaining = min(TIMEOUT, DEADLINE - time.monotonic()) if DEADLINE is not None else TIMEOUT
    if remaining <= 0:
        fail('SYSTEMCTL_UNAVAILABLE')
    try:
        result = subprocess.run(
            [str(SYSTEMCTL), '--no-ask-password', '--no-pager', *arguments],
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL, env=dict(SAFE_ENV), timeout=remaining,
            close_fds=True, check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        fail('SYSTEMCTL_UNAVAILABLE')
    return result.returncode


def _operation(arguments):
    if _systemctl(arguments) != 0:
        fail('SYSTEMCTL_FAILED')


def _enrolled(record, check_caller=True):
    if check_caller:
        _caller(record['uid'] if record else None)
    if record is None:
        fail('NOT_ENROLLED')
    account = _authorized_account(record['uid'])
    if not record['enabled']:
        fail('DISABLED')
    _validate_config(record)
    _runtime()
    _static_units()
    _dropins(account)
    _data(account)
    return account


def _state(record, probe=True):
    enabled = bool(record and record['enabled'])
    state = 'unavailable' if enabled else 'disabled'
    code = 'NOT_RUNNING' if enabled else 'DISABLED' if record else 'NOT_ENROLLED'
    running = [False, False]
    if record and probe:
        for index, unit in enumerate(UNITS):
            result = _systemctl(('is-active', '--quiet', unit))
            if result not in (0, 3, 4):
                fail('SYSTEMCTL_UNAVAILABLE')
            running[index] = result == 0
        if enabled:
            if all(running):
                state, code = 'running', 'OK'
            else:
                state, code = 'unavailable', 'NOT_RUNNING'
                for unit in UNITS:
                    result = _systemctl(('is-failed', '--quiet', unit))
                    if result == 0:
                        state, code = 'failed', 'SYSTEMCTL_FAILED'
                    elif result not in (1, 3, 4):
                        fail('SYSTEMCTL_UNAVAILABLE')
    return {
        'state': state, 'enabled': enabled, 'scope': 'host' if enabled else 'none',
        'trace_running': running[0], 'api_running': running[1],
        'code': code, 'message': MESSAGES[code],
    }


def _enable(uid, accepted):
    if not accepted or uid is None:
        fail('INVALID_ARGUMENT')
    uid = _uid(uid)
    _caller(uid)
    account = _authorized_account(uid)
    with _locked(create=True):
        record = _consent()
        if record:
            if record['uid'] != uid:
                fail('CONFIG_CONFLICT')
            _validate_config(record)
        elif os.path.lexists(CONFIG):
            # Even a root-owned pre-existing config is not ours to inspect.
            _root_file(CONFIG)
            fail('CONFIG_CONFLICT')
        _runtime()
        _static_units()
        _data(account, create=True)
        _dropins(account, create=True)
        if record is None:
            _publish(CONFIG, _json_bytes(_baseline(uid, trace_enabled=True)), 0o644)
            record = {
                'version': CONSENT_VERSION, 'uid': uid, 'enabled': True, 'scope': 'host',
                'content_retention': True, 'managed_config': _config_identity(uid),
            }
            _publish(CONSENT, _json_bytes(record), 0o600)
        else:
            if not record['enabled']:
                record['enabled'] = True
                _publish(CONSENT, _json_bytes(record), 0o600, replace=True)
            _upgrade_baseline(record)
        _enrolled(record)
        _operation(('daemon-reload',))
        _operation(('enable', '--now', *UNITS))
        return _state(record)


def _dispatch(action, uid=None, accepted=False):
    _require_root()
    if action == 'enable':
        return _enable(uid, accepted)
    # The prestart must not contend with the enrollment lock held by a
    # synchronous enable/restart. It only reads atomically published state.
    # It runs as root via systemd's fixed '+', not with a broker identity.
    if action == 'verify':
        record = _consent()
        _enrolled(record, check_caller=False)
        return _state(record, probe=False)
    with _locked():
        record = _consent()
        if action not in ('verify', 'setup'):
            _caller(record['uid'] if record else None)
        if action == 'disable':
            if record:
                # A direct root operator can revoke stale enrollment even if
                # authorization changed. Broker calls were checked above.
                record['enabled'] = False
                _publish(CONSENT, _json_bytes(record), 0o600, replace=True)
            _operation(('disable', '--now', *UNITS))
            return _state(record)
        if action == 'setup':
            # Fresh install and disabled upgrades never create consent or config.
            _operation(('daemon-reload',))
            if record and record['enabled']:
                _enrolled(record, check_caller=False)
                _upgrade_baseline(record)
                _operation(('restart', *UNITS))
                return _state(record)
            return _state(record, probe=False)
        if action == 'ensure':
            if not record or not record['enabled']:
                return _state(record, probe=False)
            _enrolled(record)
            _operation(('enable', '--now', *UNITS))
            return _state(record)
        if action == 'status':
            if record:
                _authorized_account(record['uid'])
                if record['enabled']:
                    _enrolled(record)
            return _state(record)
        fail('INVALID_ARGUMENT')


class _Parser(argparse.ArgumentParser):
    def error(self, message):
        fail('INVALID_ARGUMENT')


def main(argv=None):
    global DEADLINE
    DEADLINE = time.monotonic() + 25
    args = None
    try:
        parser = _Parser(description=__doc__)
        parser.add_argument('action', choices=('enable', 'status', 'ensure', 'disable', 'setup', 'verify'))
        parser.add_argument('--uid')
        parser.add_argument('--accept-host-capture', action='store_true')
        args = parser.parse_args(argv)
        if args.action != 'enable' and (args.uid is not None or args.accept_host_capture):
            fail('INVALID_ARGUMENT')
        # Keep all output fixed and bounded; never print exception text, config,
        # environment values, unit output, command lines or service logs.
        result = _dispatch(args.action, args.uid, args.accept_host_capture)
        print(json.dumps(result, separators=(',', ':')))
        return 0 if result['state'] in ('running', 'disabled') or args.action == 'verify' else 1
    except CollectionError as error:
        code = error.code
    except (OSError, ValueError, RecursionError):
        code = 'IO_FAILED'
    enabled = False
    if code not in ('FORBIDDEN', 'INVALID_ARGUMENT', 'INVALID_CONSENT'):
        try:
            _require_root()
            record = _consent()
            if args and args.action not in ('verify', 'setup'):
                _caller(record['uid'] if record else None)
            if record:
                _authorized_account(record['uid'])
                enabled = record['enabled']
        except (CollectionError, OSError, ValueError, RecursionError):
            pass
    result = {
        'state': 'disabled' if code in ('DISABLED', 'NOT_ENROLLED') else
                 'failed' if code == 'SYSTEMCTL_FAILED' else 'unavailable',
        'enabled': enabled, 'scope': 'host' if enabled else 'none',
        'trace_running': False, 'api_running': False,
        'code': code, 'message': MESSAGES[code],
    }
    print(json.dumps(result, separators=(',', ':')))
    return 1


if __name__ == '__main__':
    sys.exit(main())
