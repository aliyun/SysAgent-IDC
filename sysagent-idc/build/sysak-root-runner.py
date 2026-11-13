#!/usr/bin/python3 -I
"""Root-only, local sysAK IDC broker. No user-supplied paths or commands."""
import base64
import hashlib
import json
import math
import os
import re
import select
import selectors
import signal
import socket
import stat
import struct
import subprocess
import sys
import threading
import time
from pathlib import Path


ROOT = Path('/opt/SysAgent管家/resources/sysak')
HELPER = ROOT.parent / 'sysak-root-runner.py'
SOCKET = '/run/sysom-idc/idc.sock'
AUTH = '/etc/sysom-idc/allowed-uid'
TIMEOUT = Path('/usr/bin/timeout')
AGENT_COLLECTION = Path('/usr/share/sysom/agentsight-runtime/agentsight-collection.py')
REQUEST_LIMIT = 65536
CHUNK = 16384
STDOUT_LIMIT = 8 * 1024 * 1024
STDERR_LIMIT = 1024 * 1024
UNAVAILABLE = 'ROOT_COLLECTOR_UNAVAILABLE'
BUSY = 'ROOT_SERVICE_BUSY'
TOO_LARGE = 'COLLECTION_TOO_LARGE'
HASH = re.compile(r'[0-9a-f]{64}\Z')
UUID = re.compile(r'[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\Z', re.I)
TOOLS = '.sysak_components/tools'
COMMANDS = ('idc', 'resource_anomaly', 'memgraph', 'ai')
SAFE_PROFILES = {'resource_anomaly': ['--idc'], 'memgraph': ['--graph', '--jsonstdout'], 'ai': ['--threshold', '1s']}
MODULES = (
    'resource_anomaly_idc', 'fdleak_metrics',
    'plugin_abnormalPackages', 'plugin_anonTaskTop', 'plugin_cache', 'plugin_memcgLeak', 'plugin_memfrag',
    'plugin_memgraph', 'plugin_meminfo', 'plugin_memleak', 'plugin_podDetect', 'plugin_system', 'plugin_taskProc',
    'plugin_vmRssTaskTop', 'plugin_skcheck', 'plugin_appmem', 'mem_utils', 'plugin_thpCollect',
)
REQUIRED_FILES = frozenset([
    'sysak', TOOLS + '/.sysak.rules', *[TOOLS + '/' + name for name in COMMANDS],
    *[TOOLS + '/' + name + '.py' for name in MODULES],
])
DIRECTORIES = frozenset(['', '.sysak_components', TOOLS])


class Rejected(ValueError):
    pass


class Expired(Exception):
    pass


class Cancelled(Exception):
    pass


class TooLarge(Exception):
    pass


def require_root():
    if os.getresuid() != (0, 0, 0) or os.getresgid() != (0, 0, 0):
        raise Rejected()


def trusted(path, directory=False, executable=False):
    path = Path(path)
    if not path.is_absolute():
        raise Rejected()
    for current in [*reversed(path.parents), path]:
        info = current.lstat()
        if stat.S_ISLNK(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise Rejected()
        is_directory = current != path or directory
        if not (stat.S_ISDIR(info.st_mode) if is_directory else stat.S_ISREG(info.st_mode)):
            raise Rejected()
    if executable and not info.st_mode & stat.S_IXUSR:
        raise Rejected()
    return info


def read_authorized_uid():
    require_root()
    trusted(Path(AUTH))
    with Path(AUTH).open('rb') as stream:
        value = stream.read(33)
    if not re.fullmatch(rb'[0-9]+\n?', value) or len(value) > 32:
        raise Rejected()
    uid = int(value)
    if not 0 < uid <= 4294967294:
        raise Rejected()
    return uid


def strict_json(raw):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise Rejected()
            result[key] = value
        return result

    def constant(_):
        raise Rejected()

    def floating(value):
        number = float(value)
        if not math.isfinite(number):
            raise Rejected()
        return number

    try:
        return json.loads(raw, object_pairs_hook=pairs, parse_constant=constant, parse_float=floating)
    except (ValueError, TypeError, RecursionError, UnicodeError):
        raise Rejected() from None


def check_budget(deadline, stop=None):
    if stop is not None and stop.is_set():
        raise Cancelled()
    if time.monotonic() >= deadline:
        raise Expired()


def validate_request(raw, peer_pid):
    if len(raw) > REQUEST_LIMIT:
        raise Rejected()
    try:
        request = strict_json(raw.decode('utf-8'))
        if type(request) is not dict or set(request) != {'schema_version', 'args', 'stdin', 'deadline', 'manifest_sha256'}:
            raise Rejected()
        args = request['args']
        if (request['schema_version'] != '1.0' or type(args) is not list or not args or len(args) > 64 or
                any(type(arg) is not str or '\0' in arg for arg in args) or
                sum(len(arg.encode('utf-8')) for arg in args) > 16384):
            raise Rejected()
        collection = (len(args) == 7 and args[:2] == ['idc', '--profile'] and
                      args[2] in ('resources', 'inspection') and args[3] == '--request-id' and
                      UUID.fullmatch(args[4]) and args[5:] == ['-o', '-'])
        action = (len(args) == 3 and args[:2] == ['idc', '--process-action'] and
                  args[2] in ('check', 'terminate'))
        agent_collection = (len(args) == 3 and args[:2] == ['idc', '--agent-collection'] and
                            args[2] in ('status', 'ensure', 'disable'))
        if not (collection or action or agent_collection):
            raise Rejected()
        if type(request['stdin']) is not str or '\0' in request['stdin']:
            raise Rejected()
        payload = request['stdin'].encode('utf-8')
        if (collection or agent_collection) and payload:
            raise Rejected()
        if action:
            body = strict_json(request['stdin'])
            if (type(body) is not dict or set(body) != {'manager_pid', 'targets'} or
                    type(body['manager_pid']) is not int or body['manager_pid'] != peer_pid or
                    type(body['targets']) is not list):
                raise Rejected()
            # Target identity/eligibility is validated only by the native IDC parser.
        if type(request['manifest_sha256']) is not str or not HASH.fullmatch(request['manifest_sha256']):
            raise Rejected()
        if type(request['deadline']) is not int:
            raise Rejected()
        remaining = request['deadline'] / 1000 - time.time()
        if not 0 < remaining <= (15 if action else 35):
            raise Rejected()
        return request, time.monotonic() + remaining, (10 if action else 30), payload
    except (OverflowError, UnicodeError):
        raise Rejected() from None


def execution_duration(request, deadline, limit, stop):
    check_budget(deadline, stop)
    # Check both clocks again after hashing; never extend the original budget.
    remaining = min(deadline - time.monotonic(), request['deadline'] / 1000 - time.time()) - 1
    if remaining <= 0:
        raise Expired()
    return min(limit, remaining)


def validate_component(relative, data, arch):
    if relative in ('sysak', TOOLS + '/ai'):
        machine = {'x64': 62, 'arm64': 183}.get(arch)
        if (machine is None or len(data) < 64 or data[:7] != b'\x7fELF\x02\x01\x01' or
                struct.unpack_from('<I', data, 20)[0] != 1 or struct.unpack_from('<H', data, 52)[0] != 64 or
                struct.unpack_from('<H', data, 16)[0] not in (2, 3) or
                struct.unpack_from('<H', data, 18)[0] != machine):
            raise Rejected()
    elif relative in {TOOLS + '/' + name for name in COMMANDS}:
        if not re.match(rb'#![^\r\n]*\bpython3\b', data):
            raise Rejected()
    elif relative == TOOLS + '/.sysak.rules':
        lines = data.decode('utf-8').split('\n')
        if len(lines) != len(COMMANDS) + 1 or lines.pop() != '':
            raise Rejected()
        for command, line in zip(COMMANDS, lines):
            if command == 'ai':
                if line != 'generic:ai::help{GPU AI diagnostics}':
                    raise Rejected()
            elif not re.fullmatch(r'[A-Za-z0-9_/-]+:' + command + r':python-dep\{python3\}:help\{[^\r\n\0]*\}', line):
                raise Rejected()


def verify_bundle(expected_hash, deadline, stop):
    check_budget(deadline, stop)
    trusted(HELPER)
    manifest_file = ROOT / 'manifest.json'
    trusted(manifest_file)
    with manifest_file.open('rb') as stream:
        raw = stream.read(1024 * 1024 + 1)
    if len(raw) > 1024 * 1024 or hashlib.sha256(raw).hexdigest() != expected_hash:
        raise Rejected()
    manifest = strict_json(raw.decode('utf-8'))
    arch = {'x86_64': 'x64', 'aarch64': 'arm64'}.get(os.uname().machine)
    if (type(manifest) is not dict or manifest.get('schema_version') != '1.0' or
            manifest.get('platform') != 'linux' or arch is None or manifest.get('arch') != arch or
            manifest.get('commands') != list(COMMANDS) or manifest.get('requires') != ['python3'] or
            manifest.get('safe_profiles') != SAFE_PROFILES or type(manifest.get('files')) is not dict or
            set(manifest['files']) != REQUIRED_FILES):
        raise Rejected()
    files, directories = {manifest_file}, {ROOT / relative for relative in DIRECTORIES}
    for relative, digest in manifest['files'].items():
        check_budget(deadline, stop)
        if (type(relative) is not str or not relative or '\0' in relative or
                Path(relative).is_absolute() or any(part in ('', '.', '..') for part in relative.split('/')) or
                relative == 'manifest.json' or type(digest) is not str or not HASH.fullmatch(digest)):
            raise Rejected()
        path = ROOT / relative
        trusted(path, executable=(relative in ('sysak', TOOLS + '/ai')))
        hasher = hashlib.sha256()
        header = b''
        rules = bytearray()
        with path.open('rb') as stream:
            while True:
                check_budget(deadline, stop)
                chunk = stream.read(256 * 1024)
                if not chunk:
                    break
                if not header:
                    header = chunk
                if relative == TOOLS + '/.sysak.rules':
                    rules.extend(chunk)
                hasher.update(chunk)
        if hasher.hexdigest() != digest:
            raise Rejected()
        validate_component(relative, bytes(rules) if relative == TOOLS + '/.sysak.rules' else header, arch)
        files.add(path)
    for directory in directories:
        check_budget(deadline, stop)
        trusted(directory, directory=True)
        for child in directory.iterdir():
            if child not in files and child not in directories:
                raise Rejected()
    trusted(TIMEOUT, executable=True)
    check_budget(deadline, stop)


def peer_ready(pidfd):
    if select.select([pidfd], [], [], 0)[0]:
        raise Cancelled()


def authenticate(conn, allowed_uid):
    pid, uid, gid = struct.unpack('iII', conn.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize('iII')))
    if pid <= 0 or uid != allowed_uid or not 0 < uid <= 4294967294 or gid == 0:
        raise Rejected()
    pidfd = os.pidfd_open(pid, 0)
    try:
        peer_ready(pidfd)
        with Path('/proc/%d/status' % pid).open('rb') as stream:
            raw = stream.read(16385)
        if len(raw) > 16384:
            raise Rejected()
        fields = {}
        required = {'Uid', 'Gid', 'CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb'}
        required_bytes = {key.encode('ascii'): key for key in required}
        for line in raw.splitlines():
            key, separator, value = line.partition(b':')
            if separator and key in required_bytes:
                name = required_bytes[key]
                if name in fields:
                    raise Rejected()
                fields[name] = value.decode('ascii').split()
        if set(fields) != required:
            raise Rejected()
        for key, expected in [('Uid', uid), ('Gid', gid)]:
            if (len(fields[key]) != 4 or any(not re.fullmatch(r'[0-9]+', part) or
                                           int(part) != expected for part in fields[key])):
                raise Rejected()
        for key in required - {'Uid', 'Gid'}:
            if len(fields[key]) != 1 or not re.fullmatch(r'[0-9a-fA-F]{1,16}', fields[key][0]):
                raise Rejected()
            # The bounding set limits future grants; it is not an active privilege.
            if key != 'CapBnd' and int(fields[key][0], 16):
                raise Rejected()
        with Path('/proc/%d/stat' % pid).open('rb') as stream:
            raw = stream.read(4097)
        if len(raw) > 4096:
            raise Rejected()
        # comm may contain spaces and parentheses; field 22 follows the LAST ')'.
        prefix, separator, suffix = raw.rpartition(b')')
        fields = suffix.split()
        if (not separator or not prefix.startswith(('%d (' % pid).encode()) or len(fields) < 20 or
                not re.fullmatch(rb'[0-9]+', fields[19]) or int(fields[19]) <= 0):
            raise Rejected()
        starttime = int(fields[19])
        peer_ready(pidfd)
        return uid, pid, starttime, pidfd
    except BaseException:
        os.close(pidfd)
        raise


def connection_ready(conn, pidfd, deadline, stop):
    check_budget(deadline, stop)
    peer_ready(pidfd)
    if select.select([conn], [], [], 0)[0]:
        data = conn.recv(1, socket.MSG_PEEK)
        if not data:
            raise Cancelled()
        # Only one request per connection, not a command stream.
        raise Rejected()


def read_request(conn, pidfd, stop):
    end = time.monotonic() + 5
    raw = bytearray()
    while True:
        check_budget(end, stop)
        ready = select.select([conn, pidfd], [], [], min(0.1, max(0, end - time.monotonic())))[0]
        if pidfd in ready:
            raise Cancelled()
        if conn not in ready:
            continue
        chunk = conn.recv(min(4096, REQUEST_LIMIT + 1 - len(raw)))
        if not chunk:
            raise Cancelled()
        raw.extend(chunk)
        if len(raw) > REQUEST_LIMIT:
            raise Rejected()
        if b'\n' in chunk:
            if not raw.endswith(b'\n') or raw.count(b'\n') != 1:
                raise Rejected()
            return bytes(raw[:-1])


def send_frame(conn, frame, deadline, stop=None, pidfd=None):
    raw = (json.dumps(frame, ensure_ascii=True, separators=(',', ':'), allow_nan=False) + '\n').encode('ascii')
    view = memoryview(raw)
    while view:
        check_budget(deadline, stop)
        if pidfd is not None:
            connection_ready(conn, pidfd, deadline, stop)
        if not select.select([], [conn], [], min(0.1, max(0, deadline - time.monotonic())))[1]:
            continue
        try:
            sent = conn.send(view)
        except BlockingIOError:
            continue
        if not sent:
            raise Cancelled()
        view = view[sent:]


def terminal(conn, code, error=None):
    frame = {'code': code}
    if error is not None:
        frame['error'] = error
    try:
        send_frame(conn, frame, time.monotonic() + 0.25)
    except Exception:
        # The connection may already have been closed by the shutdown handler.
        pass


def stop_tree(proc, childfd, deadline):
    # Do NOT poll/wait (reap) before these signals: an unreaped session leader
    # pins this process-group ID, so it cannot be reused by a different process.
    try:
        try:
            os.killpg(proc.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        if childfd is not None:
            select.select([childfd], [], [], min(1, max(0, deadline - time.monotonic())))
    finally:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        finally:
            proc.wait(timeout=min(1, max(0, deadline - time.monotonic())))


def run_collector(conn, peer, request, deadline, limit, payload, stop):
    uid, pid, starttime, peerfd = peer
    connection_ready(conn, peerfd, deadline, stop)
    duration = execution_duration(request, deadline, limit, stop)
    env = {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8', 'PYTHONDONTWRITEBYTECODE': '1',
           'SYSOM_IDC_CALLER_UID': str(uid), 'SYSOM_IDC_PEER_PID': str(pid),
           'SYSOM_IDC_PEER_STARTTIME': str(starttime)}
    end = min(deadline - 1, time.monotonic() + duration)
    command = [str(ROOT / 'sysak'), *request['args']]
    if request['args'][:2] == ['idc', '--agent-collection']:
        trusted(AGENT_COLLECTION, executable=True)
        interpreter = Path('/usr/bin/python3').resolve(strict=True)
        trusted(interpreter, executable=True)
        command = [str(interpreter), '-I', str(AGENT_COLLECTION), request['args'][2]]
    proc = subprocess.Popen([str(TIMEOUT), '--signal=TERM', '--kill-after=1s', '%gs' % duration,
                             *command], shell=False, cwd=ROOT,
                            start_new_session=True, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, env=env)
    childfd = None
    try:
        childfd = os.pidfd_open(proc.pid, 0)
        counts = {'stdout': 0, 'stderr': 0}
        with selectors.DefaultSelector() as selector:
            for stream, name in [(proc.stdout, 'stdout'), (proc.stderr, 'stderr')]:
                os.set_blocking(stream.fileno(), False)
                selector.register(stream, selectors.EVENT_READ, name)
            os.set_blocking(proc.stdin.fileno(), False)
            pending = memoryview(payload)
            if pending:
                selector.register(proc.stdin, selectors.EVENT_WRITE, 'stdin')
            else:
                proc.stdin.close()
            selector.register(conn, selectors.EVENT_READ, 'connection')
            selector.register(peerfd, selectors.EVENT_READ, 'peer')
            selector.register(childfd, selectors.EVENT_READ, 'child')
            exited, outputs = False, 2
            while not (exited and outputs == 0):
                connection_ready(conn, peerfd, end, stop)
                for key, _ in selector.select(min(0.1, max(0, end - time.monotonic()))):
                    name = key.data
                    if name in ('connection', 'peer'):
                        connection_ready(conn, peerfd, end, stop)
                    elif name == 'child':
                        exited = True
                        selector.unregister(childfd)
                    elif name == 'stdin':
                        try:
                            written = os.write(key.fd, pending[:CHUNK])
                            pending = pending[written:]
                        except BrokenPipeError:
                            pending = memoryview(b'')
                        except BlockingIOError:
                            continue
                        if not pending:
                            selector.unregister(proc.stdin)
                            proc.stdin.close()
                    else:
                        try:
                            chunk = os.read(key.fd, CHUNK)
                        except BlockingIOError:
                            continue
                        if not chunk:
                            selector.unregister(key.fileobj)
                            outputs -= 1
                            continue
                        counts[name] += len(chunk)
                        if counts[name] > (STDOUT_LIMIT if name == 'stdout' else STDERR_LIMIT):
                            raise TooLarge()
                        send_frame(conn, {'stream': name, 'data': base64.b64encode(chunk).decode('ascii')},
                                   end, stop, peerfd)
            connection_ready(conn, peerfd, end, stop)
    finally:
        try:
            stop_tree(proc, childfd, deadline)
        finally:
            for stream in (proc.stdin, proc.stdout, proc.stderr):
                stream.close()
            if childfd is not None:
                os.close(childfd)
    check_budget(deadline, stop)
    if request['deadline'] / 1000 <= time.time():
        raise Expired()
    return proc.returncode if proc.returncode >= 0 else 128 - proc.returncode


class Service:
    def __init__(self, uid):
        self.uid = uid
        self.stop = threading.Event()
        self.execution = threading.Lock()
        self.slots = threading.BoundedSemaphore(4)
        self.guard = threading.RLock()
        self.connections = set()
        self.threads = set()
        self.listener = None
        self.bound_identity = None
        self.failed = False

    def bind(self):
        require_root()
        directory = Path(SOCKET).parent
        info = trusted(directory, directory=True)
        if info.st_gid != 0 or stat.S_IMODE(info.st_mode) != 0o755:
            raise Rejected()
        try:
            info = Path(SOCKET).lstat()
        except FileNotFoundError:
            pass
        else:
            if not stat.S_ISSOCK(info.st_mode) or info.st_uid != 0 or info.st_gid != 0:
                raise Rejected()
            Path(SOCKET).unlink()
        listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.listener = listener
        previous = os.umask(0o077)
        try:
            listener.bind(SOCKET)
        finally:
            os.umask(previous)
        info = Path(SOCKET).lstat()
        self.bound_identity = (info.st_dev, info.st_ino)
        os.chmod(SOCKET, 0o666)
        listener.listen(16)
        listener.settimeout(0.2)

    def handle(self, conn):
        peerfd, locked = None, False
        try:
            conn.setblocking(False)
            require_root()
            peer = authenticate(conn, self.uid)  # Always before JSON or bundle IO.
            peerfd = peer[3]
            raw = read_request(conn, peerfd, self.stop)
            request, deadline, limit, payload = validate_request(raw, peer[1])
            locked = self.execution.acquire(blocking=False)
            if not locked:
                terminal(conn, 75, BUSY)
                return
            verify_bundle(request['manifest_sha256'], deadline, self.stop)
            code = run_collector(conn, peer, request, deadline, limit, payload, self.stop)
            terminal(conn, code)
        except subprocess.TimeoutExpired:
            self.failed = True
            self.stop.set()
            terminal(conn, 126, UNAVAILABLE)
        except TooLarge:
            terminal(conn, 125, TOO_LARGE)
        except Expired:
            terminal(conn, 124)
        except Cancelled:
            pass
        except Exception:
            # Never disclose Python exceptions, installed paths or request contents.
            terminal(conn, 126, UNAVAILABLE)
        finally:
            if locked:
                self.execution.release()
            if peerfd is not None:
                os.close(peerfd)
            conn.close()
            with self.guard:
                self.connections.discard(conn)
                self.threads.discard(threading.current_thread())
            self.slots.release()

    def shutdown(self, *_):
        self.stop.set()
        if self.listener is not None:
            self.listener.close()
        with self.guard:
            for conn in self.connections:
                try:
                    conn.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass
                conn.close()

    def serve(self):
        try:
            self.bind()
            while not self.stop.is_set():
                try:
                    conn, _ = self.listener.accept()
                except socket.timeout:
                    continue
                except OSError:
                    if self.stop.is_set():
                        break
                    raise
                conn.setblocking(False)
                if not self.slots.acquire(blocking=False):
                    terminal(conn, 75, BUSY)
                    conn.close()
                    continue
                worker = threading.Thread(target=self.handle, args=(conn,), daemon=True)
                with self.guard:
                    if self.stop.is_set():
                        self.slots.release()
                        conn.close()
                        break
                    self.connections.add(conn)
                    self.threads.add(worker)
                worker.start()
        finally:
            self.shutdown()
            end = time.monotonic() + 3
            with self.guard:
                workers = list(self.threads)
            for worker in workers:
                worker.join(max(0, end - time.monotonic()))
            if self.bound_identity is not None:
                try:
                    info = Path(SOCKET).lstat()
                    if (stat.S_ISSOCK(info.st_mode) and info.st_uid == 0 and info.st_gid == 0 and
                            (info.st_dev, info.st_ino) == self.bound_identity):
                        Path(SOCKET).unlink()
                except OSError:
                    pass
        if self.failed:
            raise Rejected()


def main(args):
    if args:
        raise Rejected()
    uid = read_authorized_uid()
    descriptor = os.pidfd_open(os.getpid(), 0)
    os.close(descriptor)
    service = Service(uid)
    signal.signal(signal.SIGTERM, service.shutdown)
    signal.signal(signal.SIGINT, service.shutdown)
    service.serve()


if __name__ == '__main__':
    try:
        main(sys.argv[1:])
    except Exception:
        sys.stderr.write('SysAgent: root IDC service unavailable\n')
        sys.exit(126)
