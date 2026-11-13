'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const build = path.resolve(__dirname, '../build');
const manager = path.join(build, 'agentsight-collection.py');
const cleanEnv = { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' };

// All production paths are remapped inside one temporary fixture. Root checks,
// pwd, data chown/ownership and subprocess execution are patched in memory.
// No sudo, install, real systemctl, executable binary or tracing is used.
const driver = String.raw`
import contextlib, fcntl, hashlib, io, json, os, pathlib, runpy, stat, subprocess, sys, types
root = pathlib.Path(sys.argv[1])
source = pathlib.Path(sys.argv[2])
namespace = runpy.run_path(str(source), run_name='fixture_only')
g = namespace['main'].__globals__
for name in ('RUNTIME', 'HELPER', 'BINARY', 'MANIFEST', 'CONTROL', 'CONSENT', 'CONFIG',
             'LOCK', 'ALLOWED_UID', 'DATA_PARENT', 'UNIT_DIR', 'DROPIN_DIR', 'RUN_UNIT_DIR', 'SYSTEMCTL'):
    g[name] = root / str(g[name]).lstrip('/')
for directory in ('usr/share/sysom/agentsight-runtime', 'etc/sysom-idc', 'var/lib',
                  'usr/lib/systemd/system', 'etc/systemd/system', 'run/systemd/system', 'usr/bin'):
    target = root / directory
    target.mkdir(parents=True, exist_ok=True, mode=0o755)
    for parent in (target, *target.parents):
        if parent == root or root in parent.parents:
            parent.chmod(0o755)

def write(file, data, mode=0o644):
    if isinstance(data, str): data = data.encode()
    file.write_bytes(data)
    file.chmod(mode)

write(g['HELPER'], source.read_bytes())
for unit in g['UNITS']:
    write(g['UNIT_DIR'] / unit, (source.parent / unit).read_bytes())
elf = bytearray(128)
elf[:6] = b'\x7fELF\x02\x01'
elf[18:20] = (62).to_bytes(2, 'little')
write(g['BINARY'], elf, 0o755) # inert ELF header fixture, NEVER executed
manifest = {'schemaVersion': 1, 'version': '0.16.0', 'platform': 'linux', 'arch': 'x64',
            'sha256': hashlib.sha256(elf).hexdigest()}
write(g['MANIFEST'], json.dumps(manifest))
write(g['SYSTEMCTL'], b'inert systemctl fixture', 0o755)
uid, gid = 2001, 3001
write(g['ALLOWED_UID'], str(uid) + '\n')
account = types.SimpleNamespace(pw_uid=uid, pw_gid=gid, pw_name='fixture')
def lookup(value):
    if value != uid: raise KeyError(value)
    return account
g['pwd'] = types.SimpleNamespace(getpwuid=lookup)
g['_require_root'] = lambda: None
g['_root_uid'] = os.getuid
# /tmp is intentionally not a production trust boundary. Check every ancestor
# within the fixture, including the fixture root, with the production checks.
g['_ancestors'] = lambda p: reversed([x for x in pathlib.Path(p).parents
                                     if x == root or root in x.parents])
real_metadata = g['_metadata']
owned = {}
spoof = {}
chowns = []
def metadata(p):
    p = pathlib.Path(p)
    info = real_metadata(p)
    values = {key: getattr(info, key) for key in dir(info) if key.startswith('st_')}
    if p in owned: values.update(st_uid=owned[p][0], st_gid=owned[p][1])
    if p in spoof: values.update(spoof[p])
    return types.SimpleNamespace(**values)
g['_metadata'] = metadata
def chown(p, u, group):
    chowns.append((str(p), u, group))
    owned[pathlib.Path(p)] = (u, group)
g['_chown_created_data'] = chown
calls = []
active = {unit: False for unit in g['UNITS']}
failed = set()
mode = 'normal'
def inert_run(command, **options):
    global mode
    assert command[:3] == [str(g['SYSTEMCTL']), '--no-ask-password', '--no-pager']
    assert options['env'] == g['SAFE_ENV']
    assert 0 < options['timeout'] <= 20 and options['close_fds'] is True
    assert options['check'] is False
    for name in ('stdin', 'stdout', 'stderr'): assert options[name] == subprocess.DEVNULL
    action = tuple(command[3:])
    calls.append(action)
    if mode == 'timeout':
        raise subprocess.TimeoutExpired(command, 7, output=b'PRIVATE_RAW_CONFIG', stderr=b'PRIVATE_KEY')
    if mode == 'failure':
        return types.SimpleNamespace(returncode=1)
    if action[0] in ('enable', 'restart'):
        # Emulate synchronous root ExecStartPre while the parent's lock is held.
        # verify must never call systemctl or acquire/write the lock.
        before = len(calls)
        g['_dispatch']('verify')
        assert len(calls) == before
        for unit in g['UNITS']: active[unit] = True
    elif action[0] == 'disable':
        for unit in g['UNITS']: active[unit] = False
    elif action[0] == 'is-active':
        return types.SimpleNamespace(returncode=0 if active[action[-1]] else 3)
    elif action[0] == 'is-failed':
        return types.SimpleNamespace(returncode=0 if action[-1] in failed else 1)
    return types.SimpleNamespace(returncode=0)
g['subprocess'] = types.SimpleNamespace(run=inert_run, DEVNULL=subprocess.DEVNULL,
                                        TimeoutExpired=subprocess.TimeoutExpired)

def cli(*arguments):
    out = io.StringIO()
    with contextlib.redirect_stdout(out): code = g['main'](list(arguments))
    text = out.getvalue()
    assert len(text) < 1024 and text.count('\n') == 1
    result = json.loads(text)
    assert set(result) == {'state', 'enabled', 'scope', 'trace_running', 'api_running', 'code', 'message'}
    assert result['state'] in ('running', 'disabled', 'failed', 'unavailable')
    assert result['scope'] in ('host', 'none')
    for name in ('enabled', 'trace_running', 'api_running'): assert type(result[name]) is bool
    assert 'PRIVATE' not in text and 'sha256' not in text and str(root) not in text
    return code, result

def enable():
    code, result = cli('enable', '--uid', str(uid), '--accept-host-capture')
    assert code == 0 and result['state'] == 'running', result
    return result

def legacy_enrollment():
    enable()
    config = g['_baseline'](uid)
    del config['storage']['max_total_size_mb']
    config['cmdline'] = {'allow': []}
    write(g['CONFIG'], g['_json_bytes'](config))
    record = json.loads(g['CONSENT'].read_bytes())
    record['version'] = 1
    record['managed_config'] = g['_config_identity'](uid)
    write(g['CONSENT'], g['_json_bytes'](record), 0o600)
    return record


def rejected(action, codes):
    before = len(calls)
    code, result = cli(action)
    assert code == 1 and result['code'] in codes, result
    assert len(calls) == before
    return result

exec(sys.argv[3])
print('fixture assertions passed')
`;

function fixture(scenario) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsight-collection-test-'));
  try {
    const result = spawnSync('/usr/bin/python3', ['-I', '-c', driver, directory, manager, scenario], {
      encoding: 'utf8', env: cleanEnv, timeout: 15000, maxBuffer: 128 * 1024,
    });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /fixture assertions passed/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function scenario(name, code) {
  test(name, () => fixture(code));
}

scenario('fresh install is off; ensure and verify cannot enroll', String.raw`
code, result = cli('status')
assert code == 0 and result['state'] == 'disabled' and result['code'] == 'NOT_ENROLLED'
assert calls == []
assert cli('ensure')[1]['state'] == 'disabled'
rejected('verify', {'NOT_ENROLLED'})
code, result = cli('setup')
assert code == 0 and result['enabled'] is False
assert calls == [('daemon-reload',)]
for file in ('CONTROL', 'CONSENT', 'CONFIG', 'DATA_PARENT'):
    assert not g[file].exists()
`);

scenario('enable requires explicit acceptance and a positive authorized existing UID/GID', String.raw`
for args in (('enable',), ('enable', '--uid', str(uid)),
             ('enable', '--accept-host-capture'),
             ('enable', '--uid', '0', '--accept-host-capture'),
             ('enable', '--uid', '-1', '--accept-host-capture'),
             ('enable', '--uid', 'true', '--accept-host-capture'),
             ('enable', '--uid', '02001', '--accept-host-capture'),
             ('enable', '--uid', '2147483648', '--accept-host-capture'),
             ('enable', '--uid', '2002', '--accept-host-capture')):
    code, result = cli(*args)
    assert code == 1 and result['code'] in ('FORBIDDEN', 'INVALID_ARGUMENT')
    assert calls == [] and not g['CONFIG'].exists() and not g['CONSENT'].exists()
account.pw_gid = 0
assert cli('enable', '--uid', str(uid), '--accept-host-capture')[1]['code'] == 'FORBIDDEN'
account.pw_gid = gid
account.pw_name = 'root'
assert cli('enable', '--uid', str(uid), '--accept-host-capture')[1]['code'] == 'FORBIDDEN'
account.pw_name = 'fixture'
g['pwd'] = types.SimpleNamespace(getpwuid=lambda value: (_ for _ in ()).throw(KeyError(value)))
assert cli('enable', '--uid', str(uid), '--accept-host-capture')[1]['code'] == 'FORBIDDEN'
assert not g['CONTROL'].exists()
`);

scenario('explicit enrollment generates safe schema6 config and shared numeric service identity', String.raw`
result = enable()
assert result['enabled'] is True and result['scope'] == 'host'
record = json.loads(g['CONSENT'].read_bytes())
assert record['version'] == 2 and record['uid'] == uid
assert record['enabled'] is True and record['scope'] == 'host' and record['content_retention'] is True
assert stat.S_IMODE(g['CONSENT'].stat().st_mode) == 0o600
assert stat.S_IMODE(g['CONFIG'].stat().st_mode) == 0o644
config = json.loads(g['CONFIG'].read_bytes())
assert config == g['_baseline'](uid, trace_enabled=True)
assert config['schema_version'] == 6 and config['traceEnabled'] is True
rules = config['cmdline']['allow']
assert len(rules) == 20
assert {rule['agent_name'] for rule in rules} == {'qoder', 'claude', 'qwen', 'codex', 'openclaw'}
assert all(rule['rule'] and rule['rule'] != ['*'] for rule in rules)
assert {'agent_name': 'qoder', 'rule': ['*node*', '*', '*qoder*']} in rules
assert config['storage']['base_path'] == str(g['DATA_PARENT'] / str(uid))
assert config['storage']['max_total_size_mb'] == 50
assert config['server']['auth'] == {'enabled': True}
f = config['features']
assert f['trajectory_collection']['enabled'] is False and f['reuse_llm_judge'] is False
assert f['tokenizer']['enabled'] is False and f['sqlite_storage']['enabled'] is True
assert f['token_stats'] is True and f['token_consumption'] is True
assert f['interruption_detection']['enabled'] is True and f['session_mapping']['enabled'] is True
assert config['deadloop']['enabled'] is False
assert stat.S_IMODE((g['DATA_PARENT'] / str(uid)).stat().st_mode) == 0o700
assert chowns == [(str(g['DATA_PARENT'] / str(uid)), uid, gid)]
for unit in g['UNITS']:
    file = g['DROPIN_DIR'] / (unit + '.d') / g['DROPIN_NAME']
    assert file.read_bytes() == g['_dropin'](account)
    assert stat.S_IMODE(file.stat().st_mode) == 0o644
    assert b'User=2001\nGroup=3001\n' in file.read_bytes()
assert calls[0] == ('daemon-reload',)
assert calls[1] == ('enable', '--now', *g['UNITS'])
`);

scenario('all actions require root, including fixed privileged prestart verification', String.raw`
def not_root(): g['fail']('FORBIDDEN')
g['_require_root'] = not_root
for action in ('status', 'ensure', 'disable', 'setup', 'verify'):
    rejected(action, {'FORBIDDEN'})
code, result = cli('enable', '--uid', str(uid), '--accept-host-capture')
assert code == 1 and result['code'] == 'FORBIDDEN' and calls == []
assert not g['CONTROL'].exists()
`);

scenario('broker identity is mandatory when present and must match both enrollment and authorization', String.raw`
enable()
config_before = g['CONFIG'].read_bytes()
consent_before = g['CONSENT'].read_bytes()
for caller in ('', '0', '-1', '2002', '02001', '2001\n', 'PRIVATE_KEY'):
    os.environ['SYSOM_IDC_CALLER_UID'] = caller
    for action in ('status', 'ensure', 'disable'):
        rejected(action, {'FORBIDDEN'})
    assert g['CONSENT'].read_bytes() == consent_before
os.environ['SYSOM_IDC_CALLER_UID'] = str(uid)
for action in ('status', 'ensure'):
    code, result = cli(action)
    assert code == 0 and result['state'] == 'running'
assert cli('disable')[0] == 0
assert g['CONFIG'].read_bytes() == config_before
assert json.loads(g['CONSENT'].read_bytes())['enabled'] is False
`);

scenario('authorized unenrolled broker sees disabled state without creating consent or starting services', String.raw`
os.environ['SYSOM_IDC_CALLER_UID'] = str(uid)
for action in ('status', 'ensure'):
    code, result = cli(action)
    assert code == 0 and result['state'] == 'disabled' and result['enabled'] is False
assert calls == [] and not g['CONTROL'].exists()
os.environ['SYSOM_IDC_CALLER_UID'] = '2002'
for action in ('status', 'ensure', 'disable'):
    rejected(action, {'FORBIDDEN'})
assert not g['CONTROL'].exists()
`);

scenario('disable preserves data and config; disabled ensure/verify do not opt in; re-enable preserves baseline', String.raw`
enable()
data = g['DATA_PARENT'] / str(uid)
write(data / 'capture.sqlite', b'PRIVATE_CAPTURE', 0o600)
config_before = g['CONFIG'].read_bytes()
identity_before = g['_config_identity'](uid)
chowns_before = list(chowns)
code, result = cli('disable')
assert code == 0 and result['state'] == 'disabled' and result['scope'] == 'none'
assert result['trace_running'] is False and result['api_running'] is False
assert ('disable', '--now', *g['UNITS']) in calls
assert cli('ensure')[1]['state'] == 'disabled'
rejected('verify', {'DISABLED'})
assert g['CONFIG'].read_bytes() == config_before
assert (data / 'capture.sqlite').read_bytes() == b'PRIVATE_CAPTURE'
assert g['_config_identity'](uid) == identity_before and chowns == chowns_before
before = len(calls)
assert cli('setup')[0] == 0 and calls[before:] == [('daemon-reload',)]
enable()
assert chowns == chowns_before and g['_config_identity'](uid) == identity_before
assert (data / 'capture.sqlite').read_bytes() == b'PRIVATE_CAPTURE'
`);

scenario('authorization changes fail verification and starts but direct root can revoke stale consent', String.raw`
enable()
write(g['ALLOWED_UID'], '2002\n')
for action in ('verify', 'ensure', 'status'):
    rejected(action, {'FORBIDDEN'})
os.environ['SYSOM_IDC_CALLER_UID'] = str(uid)
rejected('disable', {'FORBIDDEN'})
del os.environ['SYSOM_IDC_CALLER_UID']
assert cli('disable')[0] == 0
assert json.loads(g['CONSENT'].read_bytes())['enabled'] is False
`);

scenario('allowed UID file rejects nonroot ownership, writable mode, symlink and malformed values', String.raw`
enable()
file = g['ALLOWED_UID']
original = file.read_bytes()
for value in ('0', '2001 extra', '02001', 'true', '2001\n2002', '9' * 65):
    write(file, value)
    rejected('ensure', {'FORBIDDEN', 'UNSAFE_PATH'})
write(file, original, 0o664)
rejected('ensure', {'UNSAFE_PATH'})
file.chmod(0o644)
spoof[file] = {'st_uid': os.getuid() + 1}
rejected('ensure', {'UNSAFE_PATH'})
spoof.clear()
file.unlink()
file.symlink_to(g['MANIFEST'])
rejected('ensure', {'UNSAFE_PATH'})
`);

scenario('invalid and oversized consent, symlinks and unsafe metadata never start services', String.raw`
enable()
file = g['CONSENT']
original = file.read_bytes()
record = json.loads(original)
for field, value in (('version', True), ('version', 3), ('uid', True), ('uid', 0),
                     ('enabled', 'true'), ('scope', 'user'), ('content_retention', False),
                     ('managed_config', {})):
    bad = dict(record)
    bad[field] = value
    write(file, json.dumps(bad), 0o600)
    rejected('ensure', {'INVALID_CONSENT'})
write(file, b'{' + b' ' * (16 * 1024), 0o600)
rejected('ensure', {'UNSAFE_PATH'})
write(file, b'{"version":1,"version":1}', 0o600)
rejected('ensure', {'INVALID_CONSENT'})
write(file, original, 0o644)
rejected('ensure', {'UNSAFE_PATH'})
file.chmod(0o600)
spoof[file] = {'st_uid': os.getuid() + 1}
rejected('verify', {'UNSAFE_PATH'})
spoof.clear()
file.unlink()
file.symlink_to(g['MANIFEST'])
rejected('verify', {'UNSAFE_PATH'})
`);

scenario('runtime checks digest, ELF, manifest version/platform/schema and 16KiB bound', String.raw`
enable()
binary = g['BINARY']
original = binary.read_bytes()
write(binary, original[:-1] + b'X', 0o755)
rejected('ensure', {'INVALID_PACKAGE'})
write(binary, b'not ELF' + original[7:], 0o755)
rejected('verify', {'INVALID_PACKAGE'})
write(binary, original, 0o644)
rejected('ensure', {'INVALID_PACKAGE'})
write(binary, original, 0o755)
for field, value in (('schemaVersion', True), ('schemaVersion', 2), ('version', '0.17.0'),
                     ('platform', 'darwin'), ('arch', 'arm64'), ('sha256', '0' * 64),
                     ('sha256', 'A' * 64), ('sha256', 1)):
    bad = dict(manifest)
    bad[field] = value
    write(g['MANIFEST'], json.dumps(bad))
    rejected('ensure', {'INVALID_PACKAGE'})
write(g['MANIFEST'], b' ' * (16 * 1024 + 1))
rejected('ensure', {'UNSAFE_PATH'})
write(g['MANIFEST'], json.dumps(manifest))
binary.unlink()
binary.symlink_to(g['SYSTEMCTL'])
rejected('ensure', {'UNSAFE_PATH'})
`);

scenario('helper, units, drop-ins and their ancestors reject unsafe permissions and symlinks', String.raw`
enable()
dropin = g['DROPIN_DIR'] / (g['UNITS'][0] + '.d') / g['DROPIN_NAME']
for file in (g['HELPER'], g['BINARY'], g['MANIFEST'], g['UNIT_DIR'] / g['UNITS'][0], dropin):
    original = file.read_bytes()
    permission = stat.S_IMODE(file.stat().st_mode)
    file.chmod(permission | 0o020)
    rejected('verify', {'UNSAFE_PATH'})
    file.chmod(permission)
    spoof[file] = {'st_uid': os.getuid() + 1}
    rejected('ensure', {'UNSAFE_PATH'})
    spoof.clear()
    file.unlink()
    file.symlink_to(g['SYSTEMCTL'])
    rejected('verify', {'UNSAFE_PATH'})
    file.unlink()
    write(file, original, permission)
parent = g['RUNTIME']
renamed = parent.with_name('runtime-moved')
parent.rename(renamed)
parent.symlink_to(renamed, target_is_directory=True)
rejected('ensure', {'UNSAFE_PATH'})
`);

scenario('unknown operator config is never opened, imported or overwritten', String.raw`
g['CONTROL'].mkdir(mode=0o755)
write(g['CONFIG'], b'PRIVATE_OPERATOR_CONFIG_DO_NOT_READ')
original_open = g['_open_root_file']
def no_config_read(file, *args, **kwargs):
    assert pathlib.Path(file) != g['CONFIG'], 'operator config opened'
    return original_open(file, *args, **kwargs)
g['_open_root_file'] = no_config_read
before = g['CONFIG'].stat()
code, result = cli('enable', '--uid', str(uid), '--accept-host-capture')
assert code == 1 and result['code'] == 'CONFIG_CONFLICT'
assert g['CONFIG'].stat().st_ino == before.st_ino
assert g['CONFIG'].read_bytes() == b'PRIVATE_OPERATOR_CONFIG_DO_NOT_READ'
assert not g['CONSENT'].exists() and not g['DATA_PARENT'].exists() and calls == []
`);

scenario('edited or replaced managed config fails closed without reading contents or overwriting', String.raw`
enable()
write(g['CONFIG'], b'PRIVATE_CHANGED_CONFIG')
original_open = g['_open_root_file']
def no_config_read(file, *args, **kwargs):
    assert pathlib.Path(file) != g['CONFIG']
    return original_open(file, *args, **kwargs)
g['_open_root_file'] = no_config_read
for action in ('verify', 'ensure', 'status'):
    result = rejected(action, {'CONFIG_CONFLICT'})
    assert result['enabled'] is True and result['scope'] == 'host'
code, result = cli('enable', '--uid', str(uid), '--accept-host-capture')
assert code == 1 and result['code'] == 'CONFIG_CONFLICT'
assert g['CONFIG'].read_bytes() == b'PRIVATE_CHANGED_CONFIG'
assert cli('disable')[0] == 0
assert g['CONFIG'].read_bytes() == b'PRIVATE_CHANGED_CONFIG'
`);

scenario('existing user data is neither migrated nor recursively chowned; unsafe data fails closed', String.raw`
g['DATA_PARENT'].mkdir(mode=0o755)
data = g['DATA_PARENT'] / str(uid)
data.mkdir(mode=0o700)
write(data / 'existing.sqlite', b'PRIVATE_EXISTING_DATA', 0o600)
(data / 'user-link').symlink_to(g['MANIFEST'])
owned[data] = (uid, gid)
enable()
assert chowns == [] and (data / 'existing.sqlite').read_bytes() == b'PRIVATE_EXISTING_DATA'
assert (data / 'user-link').is_symlink()
for owner in ((uid + 1, gid), (uid, 0), (uid, gid + 1)):
    owned[data] = owner
    rejected('ensure', {'UNSAFE_PATH'})
owned[data] = (uid, gid)
data.chmod(0o750)
rejected('verify', {'UNSAFE_PATH'})
assert chowns == []
data.chmod(0o700)
backup = data.with_name('old-data')
data.rename(backup)
data.symlink_to(backup, target_is_directory=True)
rejected('verify', {'UNSAFE_PATH'})
`);

scenario('conflicting numeric drop-ins, extra overrides and writable system parents are rejected', String.raw`
enable()
unit = g['UNITS'][0]
file = g['DROPIN_DIR'] / (unit + '.d') / g['DROPIN_NAME']
original = file.read_bytes()
write(file, '[Service]\nUser=0\n')
rejected('ensure', {'UNIT_CONFLICT'})
write(file, original)
extra = file.parent / '99-override.conf'
write(extra, '[Service]\nUser=0\n')
rejected('verify', {'UNIT_CONFLICT'})
extra.unlink()
for base in (g['DROPIN_DIR'], g['RUN_UNIT_DIR']):
    override = base / unit
    write(override, '[Service]\nExecStart=/wrong\n')
    rejected('ensure', {'UNIT_CONFLICT'})
    override.unlink()
g['UNIT_DIR'].chmod(0o777)
rejected('ensure', {'UNSAFE_PATH'})
`);

scenario('missing optional runtime unit directory does not break fresh enrollment', String.raw`
g['RUN_UNIT_DIR'].rmdir()
enable()
assert cli('status')[1]['state'] == 'running'
`);

scenario('systemctl uses one total deadline for all operations', String.raw`
g['DEADLINE'] = 99
g['time'] = types.SimpleNamespace(monotonic=lambda: 100)
before = len(calls)
try: g['_systemctl'](('daemon-reload',))
except g['CollectionError'] as error: assert error.code == 'SYSTEMCTL_UNAVAILABLE'
else: raise AssertionError('expired operation executed')
assert len(calls) == before
`);

scenario('systemctl is fixed, bounded and sanitized; timeout/raw output never leaks', String.raw`
os.environ['LD_PRELOAD'] = 'PRIVATE_PRELOAD'
os.environ['PYTHONPATH'] = 'PRIVATE_PATH'
os.environ['DBUS_SYSTEM_BUS_ADDRESS'] = 'PRIVATE_BUS'
enable()
mode = 'timeout'
code, result = cli('ensure')
assert code == 1 and result['code'] == 'SYSTEMCTL_UNAVAILABLE'
assert result['state'] == 'unavailable' and result['enabled'] is True
mode = 'failure'
code, result = cli('ensure')
assert code == 1 and result['state'] == 'failed' and result['enabled'] is True
before = len(calls)
for action in (('start', 'arbitrary.service'), ('restart', 'sysom-agentsight-api.service'),
               ('enable', '--now', 'arbitrary.service'), ('daemon-reexec',)):
    try: g['_systemctl'](action)
    except g['CollectionError'] as error: assert error.code == 'INVALID_ARGUMENT'
    else: raise AssertionError('arbitrary command accepted')
assert len(calls) == before
`);

scenario('status distinguishes running, inactive and failed services without logs or command lines', String.raw`
enable()
active[g['UNITS'][1]] = False
code, result = cli('status')
assert code == 1 and result['state'] == 'unavailable' and result['code'] == 'NOT_RUNNING'
assert result['trace_running'] is True and result['api_running'] is False and result['enabled'] is True
failed.add(g['UNITS'][1])
code, result = cli('status')
assert code == 1 and result['state'] == 'failed'
assert result['trace_running'] is True and result['api_running'] is False
assert all(action[0] not in ('show', 'status', 'cat') for action in calls)
`);

scenario('upgrade setup only reloads and restarts a valid previous enrollment; never rewrites config', String.raw`
enable()
config_identity = g['_config_identity'](uid)
consent = g['CONSENT'].read_bytes()
before = len(calls)
code, result = cli('setup')
assert code == 0 and result['state'] == 'running'
assert calls[before:before + 2] == [('daemon-reload',), ('restart', *g['UNITS'])]
assert not any(action[0] == 'enable' for action in calls[before:])
assert g['_config_identity'](uid) == config_identity and g['CONSENT'].read_bytes() == consent
write(g['ALLOWED_UID'], '2002')
before = len(calls)
code, result = cli('setup')
assert code == 1 and calls[before:] == [('daemon-reload',)]
`);

scenario('legacy enrollment migrates to a 50MiB baseline without opening old config or touching data', String.raw`
legacy_enrollment()
data = g['DATA_PARENT'] / str(uid)
write(data / 'existing.sqlite', b'PRIVATE_EXISTING_DATA', 0o600)
config_before = g['_config_identity'](uid)
consent_before = g['CONSENT'].read_bytes()
original_open = g['_open_root_file']
def no_config_read(file, *args, **kwargs):
    assert pathlib.Path(file) != g['CONFIG']
    return original_open(file, *args, **kwargs)
g['_open_root_file'] = no_config_read
for action in ('status', 'verify', 'ensure'):
    assert cli(action)[0] == 0
assert g['_config_identity'](uid) == config_before
assert g['CONSENT'].read_bytes() == consent_before
before = len(calls)
assert cli('setup')[0] == 0
assert calls[before:before + 2] == [('daemon-reload',), ('restart', *g['UNITS'])]
record = json.loads(g['CONSENT'].read_bytes())
assert record['version'] == 2 and record['managed_config'] == g['_config_identity'](uid)
upgraded_config = json.loads(g['CONFIG'].read_bytes())
assert upgraded_config['storage']['max_total_size_mb'] == 50
assert upgraded_config['traceEnabled'] is True
assert (data / 'existing.sqlite').read_bytes() == b'PRIVATE_EXISTING_DATA'
assert cli('verify')[0] == 0
`);

scenario('explicit reinstall migrates legacy baseline; disabled upgrades remain disabled and unchanged', String.raw`
legacy_enrollment()
assert cli('disable')[0] == 0
before = g['_config_identity'](uid), g['CONSENT'].read_bytes()
assert cli('setup')[0] == 0
assert before == (g['_config_identity'](uid), g['CONSENT'].read_bytes())
enable()
record = json.loads(g['CONSENT'].read_bytes())
assert record['version'] == 2 and record['enabled'] is True
reenabled_config = json.loads(g['CONFIG'].read_bytes())
assert reenabled_config['storage']['max_total_size_mb'] == 50
assert reenabled_config['traceEnabled'] is True
`);

scenario('legacy config edited by an operator is preserved and never migrated', String.raw`
legacy_enrollment()
write(g['CONFIG'], b'PRIVATE_OPERATOR_CONFIG')
before = g['_config_identity'](uid), g['CONSENT'].read_bytes()
code, result = cli('setup')
assert code == 1 and result['code'] == 'CONFIG_CONFLICT'
code, result = cli('enable', '--uid', str(uid), '--accept-host-capture')
assert code == 1 and result['code'] == 'CONFIG_CONFLICT'
assert before == (g['_config_identity'](uid), g['CONSENT'].read_bytes())
assert g['CONFIG'].read_bytes() == b'PRIVATE_OPERATOR_CONFIG'
`);

scenario('verification is read-only and lock contention is nonblocking', String.raw`
enable()
lock = os.open(g['LOCK'], os.O_RDWR)
try:
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    before = g['CONSENT'].read_bytes(), g['_config_identity'](uid)
    code, result = cli('verify')
    assert code == 0 and result['enabled'] is True
    rejected('ensure', {'IO_FAILED'})
    assert before == (g['CONSENT'].read_bytes(), g['_config_identity'](uid))
finally:
    os.close(lock)
`);

scenario('fixed CLI rejects arbitrary actions, unit names and path/config options', String.raw`
for args in (('start',), ('status', '--unit', 'ssh.service'), ('ensure', '--config', '/wrong'),
             ('verify', '--uid', str(uid)), ('disable', '--accept-host-capture'),
             ('setup', '--binary', '/wrong')):
    code, result = cli(*args)
    assert code == 1 and result['code'] == 'INVALID_ARGUMENT'
assert calls == [] and not g['CONTROL'].exists()
`);

test('static units confine privileged capabilities to the opted-in trace service', () => {
  const trace = fs.readFileSync(path.join(build, 'sysom-agentsight-trace.service'), 'utf8');
  const api = fs.readFileSync(path.join(build, 'sysom-agentsight-api.service'), 'utf8');
  for (const unit of [trace, api]) {
    assert.match(unit, /^ConditionPathExists=\/etc\/sysom-agentsight\/consent\.json$/m);
    assert.match(unit, /^ExecStartPre=\+\/usr\/bin\/python3 -I \/usr\/share\/sysom\/agentsight-runtime\/agentsight-collection\.py verify$/m);
    for (const line of ['UMask=0077', 'KillSignal=SIGINT', 'TimeoutStopSec=10',
      'Restart=on-failure', 'ProtectSystem=strict', 'ProtectHome=read-only',
      'PrivateTmp=true', 'StandardOutput=null', 'StandardError=null']) {
      assert.ok(unit.split('\n').includes(line), line);
    }
    assert.doesNotMatch(unit, /setcap|Requires=|BindsTo=|User=root/);
    assert.equal((unit.match(/^ExecStart=/gm) || []).length, 1);
  }
  const capabilities = 'CAP_BPF CAP_PERFMON CAP_SYS_RESOURCE CAP_SYS_PTRACE CAP_DAC_READ_SEARCH CAP_SYS_ADMIN';
  assert.ok(trace.includes(`AmbientCapabilities=${capabilities}\n`));
  assert.ok(trace.includes(`CapabilityBoundingSet=${capabilities}\n`));
  assert.match(trace, /^LimitMEMLOCK=infinity$/m);
  assert.match(trace, /^IPAddressDeny=any$/m);
  assert.match(trace, /^ExecStart=\/usr\/share\/sysom\/agentsight-runtime\/agentsight trace --config \/etc\/sysom-agentsight\/config\.json$/m);
  assert.match(api, /^AmbientCapabilities=$/m);
  assert.match(api, /^CapabilityBoundingSet=$/m);
  assert.doesNotMatch(api, /CAP_[A-Z_]+|^ExecStart=.*7396/m);
  assert.match(api, /^ExecStart=\/usr\/share\/sysom\/agentsight-runtime\/agentsight serve --config \/etc\/sysom-agentsight\/config\.json --host 127\.0\.0\.1 --port 7397$/m);
});

test('package hooks are syntactically valid, default-off and preserve upgrade enrollment', () => {
  const postPath = path.join(build, 'agentsight-postinst.sh');
  const prePath = path.join(build, 'agentsight-prerm.sh');
  const post = fs.readFileSync(postPath, 'utf8');
  const pre = fs.readFileSync(prePath, 'utf8');
  const command = '/usr/bin/python3 -I /usr/share/sysom/agentsight-runtime/agentsight-collection.py';
  assert.ok(post.includes(`configure)\n        ${command} setup\n`));
  assert.ok(pre.includes(`remove|deconfigure)\n        ${command} disable\n`));
  assert.match(pre, /upgrade\|failed-upgrade\)\n        ;;\n/);
  for (const text of [post, pre]) {
    assert.doesNotMatch(text, /^\s*(sudo|systemctl|rm|chown|chmod|cp|curl|wget)\b/m);
    assert.doesNotMatch(text, /--accept-host-capture|\bpurge\)/);
    assert.equal((text.match(/^\s*\/usr\/bin\/python3 /gm) || []).length, 1);
  }
  for (const file of [postPath, prePath]) {
    const check = spawnSync('/bin/sh', ['-n', file], { encoding: 'utf8', env: cleanEnv, timeout: 3000 });
    assert.equal(check.status, 0, check.stderr);
  }
  // Run only cases with no helper invocation. Never execute configure/remove.
  for (const [file, argument] of [[postPath, 'abort-upgrade'], [postPath, 'abort-remove'],
    [prePath, 'upgrade'], [prePath, 'failed-upgrade']]) {
    const result = spawnSync('/bin/sh', [file, argument], { encoding: 'utf8', env: cleanEnv, timeout: 3000 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
  }
});
