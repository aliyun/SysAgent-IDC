'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const helper = path.resolve(__dirname, '../build/sysak-root-runner.py');
// Import only: root identities, installation IO, Popen and ALL signals are mocked.
// The sole real IPC fixture uses ordinary-user socketpair, never the installed socket.
const script = String.raw`
import base64, importlib.util, io, json, signal, socket, stat, struct, threading, unittest
from contextlib import ExitStack, contextmanager
from types import SimpleNamespace
from unittest import mock
spec = importlib.util.spec_from_file_location('root_helper', HELPER_PATH)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
NOW, MONO, PID, CHILD, PEERFD, CHILDFD = 1793536496, 500, 990099, 880088, 91, 92
TOOLS = '.sysak_components/tools'
COMMANDS = ['idc', 'resource_anomaly', 'memgraph', 'ai']
PROFILES = {'resource_anomaly': ['--idc'], 'memgraph': ['--graph', '--jsonstdout'], 'ai': ['--threshold', '1s']}
MODULES = ['resource_anomaly_idc', 'fdleak_metrics', 'plugin_abnormalPackages', 'plugin_anonTaskTop', 'plugin_cache',
           'plugin_memcgLeak', 'plugin_memfrag', 'plugin_memgraph', 'plugin_meminfo', 'plugin_memleak', 'plugin_podDetect',
           'plugin_system', 'plugin_taskProc', 'plugin_vmRssTaskTop', 'plugin_skcheck', 'plugin_appmem', 'mem_utils', 'plugin_thpCollect']
FILES = {'sysak', TOOLS+'/.sysak.rules', *[TOOLS+'/'+name for name in COMMANDS], *[TOOLS+'/'+name+'.py' for name in MODULES]}
DIRECTORIES = {'', '.sysak_components', TOOLS}
COLLECTOR = TOOLS+'/idc'
AI = TOOLS+'/ai'
RULES = TOOLS+'/.sysak.rules'
CANONICAL_RULES = ('detect/generic:idc:python-dep{python3}:help{idc}\n'
                   'detect/generic:resource_anomaly:python-dep{python3}:help{resource_anomaly --idc only}\n'
                   'detect/mem:memgraph:python-dep{python3}:help{memgraph --graph --jsonstdout}\n'
                   'generic:ai::help{GPU AI diagnostics}\n')
def mock_elf(machine=None):
    data = bytearray(64)
    data[:7] = b'\x7fELF\x02\x01\x01'
    struct.pack_into('<HHI', data, 16, 3, machine or {'x86_64':62,'aarch64':183}[m.os.uname().machine], 1)
    struct.pack_into('<H', data, 52, 64)
    return bytes(data)
ARGS = ['idc', '--profile', 'resources', '--request-id', '550e8400-e29b-41d4-a716-446655440000', '-o', '-']
def request(**changes):
    body = dict(schema_version='1.0', args=ARGS, stdin='', deadline=(NOW+35)*1000, manifest_sha256='a'*64)
    body.update(changes)
    return body

def encoded(body):
    return json.dumps(body, ensure_ascii=True, separators=(',', ':')).encode()

@contextmanager
def clocks(wall=NOW, mono=MONO):
    with mock.patch.object(m.time, 'time', return_value=wall), mock.patch.object(m.time, 'monotonic', return_value=mono): yield

@contextmanager
def root(uid=(0,0,0), gid=(0,0,0)):
    with mock.patch.object(m.os, 'getresuid', return_value=uid), mock.patch.object(m.os, 'getresgid', return_value=gid): yield

class Protocol(unittest.TestCase):
    def parse(self, body):
        with clocks(): return m.validate_request(encoded(body), PID)
    def reject(self, body):
        with self.assertRaises(m.Rejected): self.parse(body)
    def test_allowlist_and_deadlines(self):
        for profile in ('resources', 'inspection'):
            with self.subTest(profile=profile):
                body, end, limit, stdin = self.parse(request(args=ARGS[:2]+[profile]+ARGS[3:]))
                self.assertEqual((end, limit, stdin), (MONO+35, 30, b''))
        for action in ('check', 'terminate'):
            with self.subTest(action=action):
                payload = json.dumps({'manager_pid':PID, 'targets':[{'pid':123,'starttime':'42'}]})
                _, end, limit, stdin = self.parse(request(args=['idc','--process-action',action], stdin=payload, deadline=(NOW+15)*1000))
                self.assertEqual((end, limit, stdin), (MONO+15, 10, payload.encode()))
        for value in [True, False, None, '1000', 1.5, (NOW+35)*1000+1, NOW*1000, (NOW-1)*1000, 10**400]:
            with self.subTest(deadline=value): self.reject(request(deadline=value))
        self.reject(request(args=['idc','--process-action','check'], stdin=json.dumps({'manager_pid':PID,'targets':[]}), deadline=(NOW+15)*1000+1))
    def test_fixed_collection_commands_cannot_enroll_or_accept_payload(self):
        for action in ('status', 'ensure', 'disable'):
            _, end, limit, stdin = self.parse(request(args=['idc','--agent-collection',action],deadline=(NOW+35)*1000))
            self.assertEqual((end, limit, stdin), (MONO+35,30,b''))
            self.reject(request(args=['idc','--agent-collection',action],deadline=(NOW+35)*1000+1))
            self.reject(request(args=['idc','--agent-collection',action],stdin='{}',deadline=(NOW+15)*1000))
        for action in ('enable','verify','setup','start','stop','sysom-idc.service',';id'):
            self.reject(request(args=['idc','--agent-collection',action],deadline=(NOW+15)*1000))
        self.reject(request(args=['idc','--agent-collection','ensure','--uid','0'],deadline=(NOW+15)*1000))
    def test_strict_keys_json_and_types(self):
        for key in request():
            body = request(); del body[key]
            with self.subTest(missing=key): self.reject(body)
        for key in ('uid','starttime','path','env','command','PKEXEC_UID'):
            with self.subTest(extra=key): self.reject(request(**{key:'inert'}))
        for change in [dict(schema_version='2.0'),dict(schema_version=1),dict(args=None),dict(args='idc'),dict(args=[1]),
                       dict(stdin=None),dict(stdin={}),dict(stdin='not empty'),dict(stdin='\0'),dict(manifest_sha256='A'*64),
                       dict(manifest_sha256='a'*63),dict(manifest_sha256=123),dict(manifest_sha256='a'*64+'\n')]:
            with self.subTest(change=change): self.reject(request(**change))
        raw = encoded(request())
        for data in [b'\xff', b'[]', b'null', b'{', raw[:-1]+b',"deadline":1}',
                     raw.replace(str((NOW+35)*1000).encode(), b'NaN'), raw.replace(str((NOW+35)*1000).encode(), b'Infinity'),
                     raw.replace(str((NOW+35)*1000).encode(), b'1e999'), b'['*1100+b']'*1100,
                     encoded(request(stdin='\ud800')), b'x'*(m.REQUEST_LIMIT+1)]:
            with self.subTest(raw=data[:40]), clocks(), self.assertRaises(m.Rejected): m.validate_request(data, PID)
    def test_no_top_level_native_subcommands_shell_or_paths(self):
        invalid = [[], ['x']*65, ['x']*64, ['x'*16384], ['x'*16385], ['汉'*5462], ['idc','x\0y'],
                   ['resource_anomaly','--idc'], ['memgraph','--graph','--jsonstdout'], ['ai','--threshold','1s'], ['ai','--idc'], ['gpudiag','--idc'],
                   ARGS[:2]+['ai']+ARGS[3:], ARGS[:2]+['gpudiag']+ARGS[3:],
                   ['resource_anomaly','--process-action','check'], ['memgraph','--idc','--jsonstdout'],
                   ['memgraph','--graph','--jsonstdout','--output','/etc/fixture'], ['sh','-c','true'],
                   ['idc','--process-action','kill'], ['idc','--process-action','check','--caller-uid','0'],
                   ARGS[:-1]+['/etc/fixture'], ARGS[:2]+['configuration']+ARGS[3:]]
        for value in ('$(id)',chr(96)+'id'+chr(96),'uuid";id;"','invalid-uuid'): invalid.append(ARGS[:4]+[value]+ARGS[5:])
        for args in invalid:
            with self.subTest(args=str(args)[:100]): self.reject(request(args=args))
    def test_action_envelope_manager_must_be_peer(self):
        for body in [{}, {'manager_pid':PID}, {'manager_pid':PID,'targets':{}}, {'manager_pid':PID+1,'targets':[]},
                     {'manager_pid':True,'targets':[]}, {'manager_pid':str(PID),'targets':[]}]:
            with self.subTest(body=body): self.reject(request(args=['idc','--process-action','check'],stdin=json.dumps(body),deadline=(NOW+15)*1000))
        for key in ('uid','caller_uid','starttime','path','env','command'):
            body = {'manager_pid':PID,'targets':[],key:'inert'}
            with self.subTest(key=key): self.reject(request(args=['idc','--process-action','terminate'],stdin=json.dumps(body),deadline=(NOW+15)*1000))
        for payload in ['{"manager_pid":%d,"manager_pid":%d,"targets":[]}'%(PID,PID),
                        '{"manager_pid":%d,"targets":[NaN]}'%PID,
                        '{"manager_pid":%d,"targets":[{"pid":1,"pid":2}]}'%PID]:
            with self.subTest(payload=payload): self.reject(request(args=['idc','--process-action','check'],stdin=payload,deadline=(NOW+15)*1000))
    def test_verification_cost_and_one_second_reserve(self):
        for elapsed in (14,15,16):
            with self.subTest(elapsed=elapsed), clocks(NOW+elapsed, MONO+elapsed), self.assertRaises(m.Expired):
                m.execution_duration(request(deadline=(NOW+15)*1000),MONO+15,10,threading.Event())
        for seconds, elapsed, limit, expected in [(35,20,30,14),(15,8,10,6),(2,.5,30,.5),(5,0,30,4),(35,0,30,30),(15,0,10,10)]:
            with self.subTest(seconds=seconds,elapsed=elapsed), clocks(NOW+elapsed, MONO+elapsed):
                self.assertEqual(m.execution_duration(request(deadline=(NOW+seconds)*1000),MONO+seconds,limit,threading.Event()), expected)
        with clocks(NOW+40,MONO), self.assertRaises(m.Expired): m.execution_duration(request(),MONO+35,30,threading.Event())
        stop = threading.Event(); stop.set()
        with clocks(), self.assertRaises(m.Cancelled): m.execution_duration(request(),MONO+35,30,stop)

class Installation:
    def __init__(self):
        self.nodes, self.inspected, self.reads = {}, [], []
        self.add(m.HELPER, b'inert helper')
        self.add(m.Path(m.AUTH), b'1000\n', 0o100644)
        self.add(m.TIMEOUT, b'inert timeout')
        for name in FILES:
            data = mock_elf() if name in ('sysak', AI) else CANONICAL_RULES.encode() if name == RULES else b'#!/usr/bin/env python3\n# inert entry\n' if name in {TOOLS+'/'+command for command in COMMANDS} else ('inert '+name).encode()
            self.add(m.ROOT/name, data, 0o100755 if name in ('sysak', AI) else 0o100644)
        self.manifest = {'schema_version':'1.0','platform':'linux','arch':{'x86_64':'x64','aarch64':'arm64'}[m.os.uname().machine],
                         'commands':COMMANDS, 'requires':['python3'], 'safe_profiles':PROFILES,
                         'files':{name:m.hashlib.sha256(self.nodes[m.ROOT/name]['data']).hexdigest() for name in FILES}}
        self.refresh()
    def add(self, path, data=b'', mode=0o100755):
        for parent in reversed(path.parents): self.nodes.setdefault(parent, {'uid':0,'gid':0,'mode':0o40755,'data':b''})
        self.nodes[path] = {'uid':0,'gid':0,'mode':mode,'data':data}
    def refresh(self, raw=None):
        self.raw = encoded(self.manifest) if raw is None else raw
        self.add(m.ROOT/'manifest.json', self.raw, 0o100644)
        self.digest = m.hashlib.sha256(self.raw).hexdigest()
    def lstat(self, path):
        self.inspected.append(path)
        if path not in self.nodes: raise FileNotFoundError('mock path missing')
        node = self.nodes[path]
        return SimpleNamespace(st_uid=node['uid'],st_gid=node['gid'],st_mode=node['mode'],st_dev=1,st_ino=2)
    def open(self, path, *args, **kwargs):
        node = self.nodes[path]
        assert stat.S_ISREG(node['mode']), 'must read only regular mock files'
        self.reads.append(path)
        return io.BytesIO(node['data'])
    @contextmanager
    def patched(self):
        with mock.patch.object(m.Path,'lstat',lambda p:self.lstat(p)), mock.patch.object(m.Path,'open',lambda p,*a,**kw:self.open(p,*a,**kw)), mock.patch.object(m.Path,'iterdir',lambda p:iter(child for child in self.nodes if child != p and child.parent == p)), clocks(), root(): yield self
    def verify(self):
        with self.patched(): m.verify_bundle(self.digest,MONO+35,threading.Event())

class Trust(unittest.TestCase):
    def test_all_root_identity_fields(self):
        for field in ('uid','gid'):
            for identity in [(1000,0,0),(0,1000,0),(0,0,1000),(1000,1000,1000)]:
                with self.subTest(field=field,identity=identity), root(**{field:identity}), mock.patch.object(m,'trusted') as trusted, self.assertRaises(m.Rejected): m.read_authorized_uid()
                trusted.assert_not_called()
        with root(): m.require_root()
    def test_authorization_uid_is_one_nonzero_ascii_integer(self):
        for value in [b'',b'0',b'-1',b'+1000',b'1.5',b'4294967295',b'1000 ',b' 1000',b'1000\n1001',b'1000\n\n','١٠٠٠'.encode(),'１０００'.encode(),b'1'*33]:
            install = Installation(); install.nodes[m.Path(m.AUTH)]['data'] = value
            with self.subTest(value=value), install.patched(), self.assertRaises(m.Rejected): m.read_authorized_uid()
        for value in (b'1',b'1000\n',b'2147483647',b'4294967294'):
            install = Installation(); install.nodes[m.Path(m.AUTH)]['data'] = value
            with self.subTest(value=value), install.patched(): self.assertEqual(m.read_authorized_uid(),int(value))
        for target in (m.Path(m.AUTH),m.Path(m.AUTH).parent):
            for field,value in [('uid',1000),('mode',0o100775),('mode',0o100757),('mode',0o120777)]:
                install = Installation(); install.nodes[target][field] = value
                with self.subTest(target=target,field=field,value=value), install.patched(), self.assertRaises(m.Rejected): m.read_authorized_uid()
    def test_every_trusted_component_and_ancestor(self):
        targets = [m.HELPER,m.ROOT/'manifest.json',*[m.ROOT/name for name in FILES],*[m.ROOT/name for name in DIRECTORIES],m.ROOT.parent,m.TIMEOUT]
        for target in targets:
            for field,value in [('uid',1000),('mode',0o100775),('mode',0o100757),('mode',0o120777),('missing',None)]:
                install = Installation()
                if field == 'missing': del install.nodes[target]
                else: install.nodes[target][field] = value
                with self.subTest(target=target,field=field,value=value), self.assertRaises((m.Rejected,OSError)): install.verify()
        for target in [m.HELPER,m.ROOT/'manifest.json',m.ROOT/'sysak',m.ROOT/COLLECTOR,m.TIMEOUT]:
            install = Installation(); install.nodes[target]['mode'] = 0o40755
            with self.subTest(directory=target), self.assertRaises(m.Rejected): install.verify()
        install = Installation(); install.nodes[m.ROOT.parent]['mode'] = 0o100755
        with self.assertRaises(m.Rejected): install.verify()
        for target in (m.ROOT/'sysak',m.ROOT/AI,m.TIMEOUT):
            install = Installation(); install.nodes[target]['mode'] = 0o100644
            with self.subTest(nonexecutable=target), self.assertRaises(m.Rejected): install.verify()
        install = Installation(); install.nodes[m.ROOT/'sysak']['mode'] = 0o100700; install.verify()
    def test_exact_closure_and_all_digests(self):
        self.assertEqual(len(FILES),24)
        self.assertEqual(m.REQUIRED_FILES, FILES)
        self.assertEqual(m.DIRECTORIES, DIRECTORIES)
        self.assertEqual(list(m.COMMANDS), COMMANDS)
        self.assertEqual(m.SAFE_PROFILES, PROFILES)
        install = Installation(); install.verify()
        for name in install.manifest['files']: self.assertIn(m.ROOT/name, install.reads)
        unknown = Installation(); unknown.add(m.ROOT/'nested/collector.py', b'nested',0o100644)
        unknown.manifest['files']['nested/collector.py'] = m.hashlib.sha256(b'nested').hexdigest()
        unknown.refresh()
        with self.assertRaises(m.Rejected): unknown.verify()
        for path in (m.HELPER,m.ROOT/'manifest.json',m.ROOT,m.ROOT.parent,m.TIMEOUT): self.assertIn(path,install.inspected)
        for unlisted in ('json.py','extra/import.py','empty',TOOLS+'/light_inspect/collectors/cpu.py',TOOLS+'/light_inspect/__pycache__'):
            install = Installation(); install.add(m.ROOT/unlisted,b'inert',0o40755 if unlisted=='empty' else 0o100644)
            with self.subTest(unlisted=unlisted), self.assertRaises(m.Rejected): install.verify()
        for name in FILES:
            install = Installation(); install.nodes[m.ROOT/name]['data'] = b'tampered'
            with self.subTest(tampered=name), self.assertRaises(m.Rejected): install.verify()
        install = Installation(); install.nodes[m.ROOT/'manifest.json']['data'] += b' '
        with self.assertRaises(m.Rejected): install.verify()
    def test_native_elf_rules_and_entries_even_with_matching_hashes(self):
        for name in ('sysak', AI):
            for data in (b'#!/usr/bin/env python3\n',mock_elf(183 if m.os.uname().machine == 'x86_64' else 62),mock_elf()[:63],b'\0'*64):
                install = Installation(); install.nodes[m.ROOT/name]['data'] = data
                install.manifest['files'][name] = m.hashlib.sha256(data).hexdigest(); install.refresh()
                with self.subTest(name=name,data=data[:20]), self.assertRaises(m.Rejected): install.verify()
        for text in (CANONICAL_RULES.replace('generic:ai::','generic:ai:python-dep{python3}:'),
                     CANONICAL_RULES.replace('generic:ai:','detect/gpu:ai:'),
                     CANONICAL_RULES.replace('memgraph:python-dep{python3}','memgraph:python-dep{all}'),
                     CANONICAL_RULES+CANONICAL_RULES,
                     CANONICAL_RULES+'detect/gpu:gpudiag:python-dep{python3}:help{old GPU}\n'):
            install = Installation(); install.nodes[m.ROOT/RULES]['data'] = text.encode()
            install.manifest['files'][RULES] = m.hashlib.sha256(text.encode()).hexdigest(); install.refresh()
            with self.subTest(rules=text[-60:]), self.assertRaises(m.Rejected): install.verify()
        for command in COMMANDS[:3]:
            name = TOOLS+'/'+command; data = b'#!/usr/bin/env python\n'
            install = Installation(); install.nodes[m.ROOT/name]['data'] = data
            install.manifest['files'][name] = m.hashlib.sha256(data).hexdigest(); install.refresh()
            with self.subTest(command=command), self.assertRaises(m.Rejected): install.verify()
    def test_complete_gpudiag_legacy_bundle_is_never_accepted_at_runtime(self):
        install = Installation(); data = b'#!/usr/bin/env python3\n# old GPU\n'
        del install.nodes[m.ROOT/AI]; install.add(m.ROOT/(TOOLS+'/gpudiag'),data)
        rules = CANONICAL_RULES.replace('generic:ai::help{GPU AI diagnostics}', 'detect/gpu:gpudiag:python-dep{python3}:help{gpudiag --idc}').encode()
        install.nodes[m.ROOT/RULES]['data'] = rules
        install.manifest['commands'] = COMMANDS[:3]+['gpudiag']
        install.manifest['safe_profiles'] = {name:value for name,value in PROFILES.items() if name != 'ai'}
        install.manifest['safe_profiles']['gpudiag'] = ['--idc']
        for name in ('gpu_snapshot.py','collectors/__init__.py','collectors/gpu.py','light_inspect_compat.py'):
            relative = TOOLS+'/light_inspect/'+name
            install.add(m.ROOT/relative,b'# inert old GPU dependency\n',0o100644)
            install.manifest['files'][relative] = m.hashlib.sha256(b'# inert old GPU dependency\n').hexdigest()
        del install.manifest['files'][AI]
        install.manifest['files'][TOOLS+'/gpudiag'] = m.hashlib.sha256(data).hexdigest()
        install.manifest['files'][RULES] = m.hashlib.sha256(rules).hexdigest(); install.refresh()
        self.assertEqual(len(install.manifest['files']),28)
        with self.assertRaises(m.Rejected): install.verify()
    def test_manifest_schema_paths_hashes_and_duplicates(self):
        for change in [dict(schema_version='2.0'),dict(platform='other'),dict(arch='other'),dict(commands=COMMANDS[:3]),
                       dict(requires=['python3','python2']),dict(safe_profiles={**PROFILES,'ai':['--all']}),
                       dict(files={}),dict(files=[]),dict(files=None)]:
            install = Installation(); install.manifest.update(change); install.refresh()
            with self.subTest(change=change), self.assertRaises(m.Rejected): install.verify()
        for relative in ('/outside','../outside','nested/../../outside','a//b','./sysak','sysak/','manifest.json','', 'a\0b'):
            install = Installation(); install.manifest['files'][relative] = '0'*64; install.refresh()
            with self.subTest(relative=relative), self.assertRaises(m.Rejected): install.verify()
            escaped = m.ROOT/relative
            if escaped in {m.ROOT/name for name in ('sysak',COLLECTOR)}:
                self.assertEqual(install.inspected.count(escaped),0, 'invalid static filemap must fail before component access')
            elif relative not in ('manifest.json',''):
                self.assertNotIn(escaped,install.inspected)
        for digest in (None,123,'','not-a-hash','a'*63,'A'*64,'0'*64):
            install = Installation(); install.manifest['files']['sysak'] = digest; install.refresh()
            with self.subTest(digest=digest), self.assertRaises(m.Rejected): install.verify()
        install = Installation(); install.refresh(install.raw[:-1]+b',"files":{}}')
        with self.assertRaises(m.Rejected): install.verify()
        install = Installation(); install.refresh(b'x'*(1024*1024+1))
        with self.assertRaises(m.Rejected): install.verify()
        install = Installation()
        with install.patched(), mock.patch.object(m,'check_budget',side_effect=m.Expired), self.assertRaises(m.Expired): m.verify_bundle(install.digest,MONO+35,threading.Event())
        self.assertEqual(install.inspected,[])

class Identity(unittest.TestCase):
    def authenticate(self, uid=1000,gid=1000,pid=PID, fields=None,stat_data=None,ready=False,allowed_uid=1000):
        values = {'Uid':'1000 1000 1000 1000','Gid':'1000 1000 1000 1000','CapInh':'0000000000000000','CapPrm':'0000000000000000','CapEff':'0000000000000000','CapBnd':'0000000000000000','CapAmb':'0000000000000000'}
        values.update(fields or {})
        status = ''.join(key+':\t'+value+'\n' for key,value in values.items() if value is not None).encode()+'Name:\t管家\n'.encode()
        data = stat_data if stat_data is not None else ('%d (name with ) parentheses) '%pid+'S '+'0 '*18+'777 0 0\n').encode()
        conn = mock.Mock(); conn.getsockopt.return_value = struct.pack('iII',pid,uid,gid)
        def open_proc(path,*args,**kwargs):
            self.assertIn(str(path),['/proc/%d/status'%pid,'/proc/%d/stat'%pid])
            return io.BytesIO(status if path.name=='status' else data)
        with mock.patch.object(m.Path,'open',open_proc), mock.patch.object(m.os,'pidfd_open',return_value=PEERFD) as opened, mock.patch.object(m.os,'close') as closed, mock.patch.object(m.select,'select',return_value=([PEERFD] if ready else [],[],[])):
            try: result = m.authenticate(conn,allowed_uid)
            except BaseException:
                if uid != allowed_uid or gid == 0 or pid <= 0: opened.assert_not_called()
                else: closed.assert_called_once_with(PEERFD)
                raise
            conn.getsockopt.assert_called_once_with(socket.SOL_SOCKET,socket.SO_PEERCRED,12)
            opened.assert_called_once_with(PID,0); closed.assert_not_called()
            return result
    def test_peer_credentials_proc_fields_capabilities_and_starttime(self):
        self.assertEqual(self.authenticate(),(1000,PID,777,PEERFD))
        high_uid = 4294967294
        self.assertEqual(self.authenticate(uid=high_uid,allowed_uid=high_uid,fields={'Uid':' '.join([str(high_uid)]*4)}),(high_uid,PID,777,PEERFD))
        for change in [dict(uid=0),dict(uid=1001),dict(gid=0),dict(pid=0),dict(pid=-1)]:
            with self.subTest(change=change), self.assertRaises(m.Rejected): self.authenticate(**change)
        for key in ('Uid','Gid'):
            for value in ('0 1000 1000 1000','1000 0 1000 1000','1000 1000 0 1000','1000 1000 1000 0','1000 1000 1000','1001 1001 1001 1001','+1000 1000 1000 1000',None):
                with self.subTest(key=key,value=value), self.assertRaises(m.Rejected): self.authenticate(fields={key:value})
        for key in ('CapInh','CapPrm','CapEff','CapAmb'):
            with self.subTest(key=key), self.assertRaises(m.Rejected): self.authenticate(fields={key:'0000000000000001'})
        for key in ('CapInh','CapPrm','CapEff','CapBnd','CapAmb'):
            for value in ('not-hex','0 0',None):
                with self.subTest(key=key,value=value), self.assertRaises(m.Rejected): self.authenticate(fields={key:value})
        for bounding in ('0000000000000001','000001ffffffffff','ffffffffffffffff'):
            with self.subTest(bounding=bounding):
                self.assertEqual(self.authenticate(fields={'CapBnd':bounding}),(1000,PID,777,PEERFD))
        with self.assertRaises(m.Rejected): self.authenticate(fields={'Uid':'1000 1000 1000 1000\nUid:\t1000 1000 1000 1000'})
        for data in (b'bad stat', ('%d (x) S '%PID+'0 '*19).encode(), ('1 (x) S '+'0 '*18+'777').encode(), b'x'*4097):
            with self.subTest(stat=data[:60]), self.assertRaises(m.Rejected): self.authenticate(stat_data=data)
        with self.assertRaises(m.Cancelled): self.authenticate(ready=True)
    def test_pidfd_failure_fails_closed_without_proc_read(self):
        conn = mock.Mock(); conn.getsockopt.return_value = struct.pack('iII',PID,1000,1000)
        with mock.patch.object(m.os,'pidfd_open',side_effect=OSError('private detail')), mock.patch.object(m.Path,'open') as opened, self.assertRaises(OSError): m.authenticate(conn,1000)
        opened.assert_not_called()

class Header(unittest.TestCase):
    def read(self,chunks,clock=None):
        conn = mock.Mock(); conn.recv.side_effect = chunks
        with clocks(), mock.patch.object(m.select,'select',side_effect=lambda *a:([conn],[],[])):
            if clock is None: return m.read_request(conn,PEERFD,threading.Event())
            with mock.patch.object(m.time,'monotonic',side_effect=clock): return m.read_request(conn,PEERFD,threading.Event())
    def test_fragmentation_and_byte_boundary(self):
        raw = encoded(request()); self.assertEqual(self.read([raw[:3],raw[3:]+b'\n']),raw)
        self.assertEqual(self.read([b'x'*4096]*15+[b'x'*4095+b'\n']),b'x'*65535)
        for chunks in [[b'x'*4096]*16+[b'\n'],[b'{}\n{}\n'],[b'{}\nx']]:
            with self.subTest(size=sum(map(len,chunks))), self.assertRaises(m.Rejected): self.read(chunks)
        with self.assertRaises(m.Cancelled): self.read([b''])
        with self.assertRaises(m.Expired): self.read([],clock=[MONO,MONO+5])
    def test_dead_peer_and_shutdown(self):
        conn = mock.Mock()
        with clocks(), mock.patch.object(m.select,'select',return_value=([PEERFD],[],[])), self.assertRaises(m.Cancelled): m.read_request(conn,PEERFD,threading.Event())
        conn.recv.assert_not_called()
        stop = threading.Event(); stop.set()
        with clocks(), self.assertRaises(m.Cancelled): m.read_request(conn,PEERFD,stop)

class Pipe:
    def __init__(self,fd): self.fd=fd; self.closed=False
    def fileno(self): return self.fd
    def close(self): self.closed=True
class FakeProcess:
    def __init__(self,code=0):
        self.pid=CHILD; self.stdin=Pipe(10); self.stdout=Pipe(11); self.stderr=Pipe(12)
        self.returncode=None; self.code=code; self.waited=False
    def wait(self,timeout=None):
        assert timeout is not None and 0 <= timeout <= 1, 'reaping must have a finite remaining budget'
        self.waited=True; self.returncode=self.code; return self.code
    def poll(self): raise AssertionError('never reap before group cleanup')
    def communicate(self,*a,**kw): raise AssertionError('unbounded communicate forbidden')
class FakeSelector:
    def __init__(self,fixture): self.f=fixture; self.keys={}
    def __enter__(self): return self
    def __exit__(self,*a): pass
    def register(self,obj,event,data):
        fd=obj if isinstance(obj,int) else obj.fileno()
        self.keys[fd]=SimpleNamespace(fd=fd,fileobj=obj,data=data)
    def unregister(self,obj): self.keys.pop(obj if isinstance(obj,int) else obj.fileno())
    def select(self,timeout):
        self.f.events.append(('select',timeout))
        if self.f.mode=='timeout': raise m.Expired()
        if self.f.mode=='shutdown': self.f.stop.set(); return []
        if self.f.mode=='disconnect': self.f.disconnected=True; return []
        if self.f.mode=='peer-exit': self.f.peer_dead=True; return []
        return [(key,1) for key in list(self.keys.values()) if key.data not in ('connection','peer')]
class ExecutionFixture:
    def __init__(self,stdout=b'out\x00\xff',stderr=b'err',mode='normal',code=0,action=False):
        self.output={11:stdout,12:stderr}; self.mode=mode; self.proc=FakeProcess(code)
        self.conn=mock.Mock(); self.conn.fileno.return_value=90
        self.conn.recv.side_effect=lambda *a:b'' if self.disconnected else b'extra-request'
        self.disconnected=False; self.peer_dead=False; self.events=[]; self.frames=[]; self.input=bytearray()
        self.stop=threading.Event(); self.action=action
        self.body=request(args=['idc','--process-action','check'],stdin=json.dumps({'manager_pid':PID,'targets':[]}),deadline=(NOW+15)*1000) if action else request()
    def read(self,fd,n):
        assert n==m.CHUNK, 'pipe reads must be bounded to 16 KiB'
        data=self.output[fd][:n]; self.output[fd]=self.output[fd][n:]; return data
    def write(self,fd,data):
        assert fd==10 and len(data)<=m.CHUNK
        self.input.extend(data); return len(data)
    def select(self,read,write,error,timeout):
        if PEERFD in read and self.peer_dead: return ([PEERFD],[],[])
        if self.conn in read and self.disconnected: return ([self.conn],[],[])
        return ([CHILDFD] if CHILDFD in read else [],write,[])
    def killpg(self,pid,sig):
        assert pid==CHILD and not self.proc.waited, 'signals must target only the unreaped collector group'
        self.events.append(('signal',pid,sig))
    @contextmanager
    def patched(self):
        with ExitStack() as stack:
            stack.enter_context(clocks())
            stack.enter_context(mock.patch.object(m.subprocess,'Popen',return_value=self.proc))
            stack.enter_context(mock.patch.object(m.os,'pidfd_open',return_value=CHILDFD))
            stack.enter_context(mock.patch.object(m.os,'close'))
            stack.enter_context(mock.patch.object(m.os,'set_blocking'))
            stack.enter_context(mock.patch.object(m.os,'read',self.read))
            stack.enter_context(mock.patch.object(m.os,'write',self.write))
            stack.enter_context(mock.patch.object(m.os,'killpg',self.killpg))
            stack.enter_context(mock.patch.object(m.select,'select',self.select))
            stack.enter_context(mock.patch.object(m.selectors,'DefaultSelector',lambda:FakeSelector(self)))
            stack.enter_context(mock.patch.object(m,'send_frame',side_effect=lambda conn,frame,*a:self.frames.append(frame)))
            stack.enter_context(mock.patch.dict(m.os.environ,{'PKEXEC_UID':'0','LD_PRELOAD':'inert','PYTHONPATH':'inert','SYSOM_IDC_CALLER_UID':'0','SYSOM_IDC_PEER_PID':'1','SYSOM_IDC_PEER_STARTTIME':'1','SYSOM_OPENAPI_TOKEN':'fixture-only'},clear=True))
            yield
    def run(self):
        return m.run_collector(self.conn,(1000,PID,777,PEERFD),self.body,MONO+(15 if self.action else 35),10 if self.action else 30,self.body['stdin'].encode(),self.stop)
    def assert_cleanup(self,test):
        test.assertTrue(self.proc.waited)
        test.assertTrue(all(p.closed for p in (self.proc.stdin,self.proc.stdout,self.proc.stderr)))
        test.assertEqual([e for e in self.events if e[0]=='signal'], [('signal',CHILD,signal.SIGTERM),('signal',CHILD,signal.SIGKILL)])

class Execution(unittest.TestCase):
    def test_fixed_argv_environment_streaming_and_stdin(self):
        for action in (False,True):
            fixture=ExecutionFixture(stdout=b'\x00\xff'*20000,action=action)
            with self.subTest(action=action), fixture.patched():
                self.assertEqual(fixture.run(),0)
                m.subprocess.Popen.assert_called_once_with(['/usr/bin/timeout','--signal=TERM','--kill-after=1s','10s' if action else '30s',str(m.ROOT/'sysak'),*fixture.body['args']],shell=False,cwd=m.ROOT,start_new_session=True,stdin=m.subprocess.PIPE,stdout=m.subprocess.PIPE,stderr=m.subprocess.PIPE,env={'PATH':'/usr/bin:/bin','LANG':'C.UTF-8','PYTHONDONTWRITEBYTECODE':'1','SYSOM_IDC_CALLER_UID':'1000','SYSOM_IDC_PEER_PID':str(PID),'SYSOM_IDC_PEER_STARTTIME':'777'})
                m.os.pidfd_open.assert_called_once_with(CHILD,0)
            self.assertEqual(bytes(fixture.input),fixture.body['stdin'].encode())
            for frame in fixture.frames:
                self.assertEqual(set(frame),{'stream','data'})
                self.assertLessEqual(len(base64.b64decode(frame['data'],validate=True)),16384)
            self.assertEqual(b''.join(base64.b64decode(f['data']) for f in fixture.frames if f['stream']=='stdout'), b'\x00\xff'*20000)
            fixture.assert_cleanup(self)
    def test_output_limits_are_independent_and_byte_exact(self):
        for stream,limit in [('stdout',m.STDOUT_LIMIT),('stderr',m.STDERR_LIMIT)]:
            for extra in (0,1):
                fixture=ExecutionFixture(**{stream:b'x'*(limit+extra)})
                with self.subTest(stream=stream,extra=extra), fixture.patched():
                    if extra:
                        with self.assertRaises(m.TooLarge): fixture.run()
                    else: self.assertEqual(fixture.run(),0)
                self.assertLessEqual(sum(len(base64.b64decode(f['data'])) for f in fixture.frames if f['stream']==stream),limit)
                fixture.assert_cleanup(self)
    def test_timeout_disconnect_pidfd_and_shutdown_cleanup(self):
        for mode,error in [('timeout',m.Expired),('disconnect',m.Cancelled),('peer-exit',m.Cancelled),('shutdown',m.Cancelled)]:
            fixture=ExecutionFixture(mode=mode)
            with self.subTest(mode=mode), fixture.patched(), self.assertRaises(error): fixture.run()
            fixture.assert_cleanup(self)
        fixture=ExecutionFixture()
        with fixture.patched(), mock.patch.object(m.os,'pidfd_open',side_effect=OSError('inert private detail')), self.assertRaises(OSError): fixture.run()
        fixture.assert_cleanup(self)
        fixture=ExecutionFixture(); fixture.stop.set()
        with fixture.patched(), self.assertRaises(m.Cancelled): fixture.run()
        self.assertFalse(fixture.proc.waited); self.assertEqual(fixture.events,[])
    def test_actual_watchdog_clock_and_deadline_after_reaping(self):
        fixture=ExecutionFixture()
        with fixture.patched():
            def elapsed(selector,timeout):
                m.time.monotonic.return_value=MONO+30
                return []
            with mock.patch.object(FakeSelector,'select',elapsed), self.assertRaises(m.Expired): fixture.run()
        fixture.assert_cleanup(self)
        fixture=ExecutionFixture()
        original_wait=fixture.proc.wait
        with fixture.patched():
            def wait(timeout=None):
                result=original_wait(timeout=timeout)
                m.time.time.return_value=NOW+35
                return result
            fixture.proc.wait=wait
            with self.assertRaises(m.Expired): fixture.run()
        fixture.assert_cleanup(self)
    def test_partial_stdin_and_nonblocking_pipe_retry(self):
        fixture=ExecutionFixture(action=True)
        original_read=fixture.read
        stalled=set()
        def read(fd,size):
            if fd not in stalled:
                stalled.add(fd); raise BlockingIOError()
            return original_read(fd,size)
        def write(fd,data):
            fixture.input.extend(data[:1]); return 1
        with fixture.patched(), mock.patch.object(m.os,'read',read), mock.patch.object(m.os,'write',write):
            self.assertEqual(fixture.run(),0)
        # The inert child exits before consuming the whole payload; cleanup still owns it.
        self.assertGreater(len(fixture.input),0)
        self.assertTrue(fixture.body['stdin'].encode().startswith(bytes(fixture.input)))
        fixture.assert_cleanup(self)
    def test_stuck_collector_reap_is_bounded_and_never_resignals_a_reused_group(self):
        fixture=ExecutionFixture()
        with fixture.patched(), mock.patch.object(fixture.proc,'wait',side_effect=m.subprocess.TimeoutExpired('inert collector',1)) as wait, self.assertRaises(m.subprocess.TimeoutExpired):
            fixture.run()
        wait.assert_called_once_with(timeout=1)
        self.assertTrue(all(p.closed for p in (fixture.proc.stdin,fixture.proc.stdout,fixture.proc.stderr)))
        self.assertEqual([e for e in fixture.events if e[0]=='signal'],[('signal',CHILD,signal.SIGTERM),('signal',CHILD,signal.SIGKILL)])
    def test_native_exitcode_and_watchdog_status(self):
        for code,expected in [(0,0),(42,42),(124,124),(-15,143)]:
            fixture=ExecutionFixture(code=code)
            with self.subTest(code=code), fixture.patched(): self.assertEqual(fixture.run(),expected)
            fixture.assert_cleanup(self)

class AgentCollectionExecution(unittest.TestCase):
    INTERPRETER = m.Path('/usr/bin/python3')
    CANONICAL = m.Path('/usr/bin/python3.99')
    def installation(self):
        install=Installation()
        install.add(m.AGENT_COLLECTION,b'# inert installed collection manager\n')
        install.add(self.CANONICAL,mock_elf())
        # A normal distro interpreter alias can be a symlink: resolve it first,
        # then trust the canonical executable, never the unresolved alias.
        install.add(self.INTERPRETER,b'inert interpreter alias',0o120777)
        return install
    def collector(self,action='status',code=0):
        fixture=ExecutionFixture(stdout=b'{"fixture":true}\n',stderr=b'inert manager stderr',code=code)
        fixture.body=request(args=['idc','--agent-collection',action])
        return fixture
    @contextmanager
    def patched(self,fixture,install=None):
        install=install or self.installation()
        with install.patched(), fixture.patched(), mock.patch.object(m.Path,'resolve',autospec=True,return_value=self.CANONICAL) as resolve, mock.patch.object(m,'trusted',wraps=m.trusted) as trusted:
            yield install,resolve,trusted
    def test_fixed_manager_path_canonical_interpreter_argv_environment_and_exitcodes(self):
        self.assertEqual(str(m.AGENT_COLLECTION),'/usr/share/sysom/agentsight-runtime/agentsight-collection.py')
        for action in ('status','ensure','disable'):
            for code,expected in ((0,0),(42,42),(124,124),(-15,143)):
                fixture=self.collector(action,code)
                with self.subTest(action=action,code=code), self.patched(fixture) as (install,resolve,trusted):
                    body,end,limit,payload=m.validate_request(encoded(fixture.body),PID)
                    self.assertEqual(payload,b'')
                    self.assertEqual(m.run_collector(fixture.conn,(1000,PID,777,PEERFD),body,end,limit,payload,fixture.stop),expected)
                    resolve.assert_called_once_with(self.INTERPRETER,strict=True)
                    self.assertEqual(trusted.call_args_list,[mock.call(m.AGENT_COLLECTION,executable=True),mock.call(self.CANONICAL,executable=True)])
                    m.subprocess.Popen.assert_called_once_with(
                        [str(m.TIMEOUT),'--signal=TERM','--kill-after=1s','30s',str(self.CANONICAL),'-I',str(m.AGENT_COLLECTION),action],
                        shell=False,cwd=m.ROOT,start_new_session=True,
                        stdin=m.subprocess.PIPE,stdout=m.subprocess.PIPE,stderr=m.subprocess.PIPE,
                        env={'PATH':'/usr/bin:/bin','LANG':'C.UTF-8','PYTHONDONTWRITEBYTECODE':'1',
                             'SYSOM_IDC_CALLER_UID':'1000','SYSOM_IDC_PEER_PID':str(PID),'SYSOM_IDC_PEER_STARTTIME':'777'})
                    m.os.pidfd_open.assert_called_once_with(CHILD,0)
                    self.assertNotIn(self.INTERPRETER,install.inspected)
                    for target in (m.AGENT_COLLECTION,self.CANONICAL):
                        for component in (*target.parents,target): self.assertIn(component,install.inspected)
                self.assertEqual(bytes(fixture.input),b'')
                self.assertEqual(b''.join(base64.b64decode(frame['data']) for frame in fixture.frames if frame['stream']=='stdout'),b'{"fixture":true}\n')
                self.assertEqual(b''.join(base64.b64decode(frame['data']) for frame in fixture.frames if frame['stream']=='stderr'),b'inert manager stderr')
                fixture.assert_cleanup(self)
    def test_untrusted_manager_canonical_python_and_ancestors_fail_before_popen(self):
        targets=(m.AGENT_COLLECTION,self.CANONICAL,m.AGENT_COLLECTION.parent,m.Path('/usr/share'),m.Path('/usr'),self.CANONICAL.parent,m.Path('/'))
        for target in targets:
            changes=[('uid',1000),('mode',0o120777),('missing',None)]
            changes.append(('mode',0o100775 if target in (m.AGENT_COLLECTION,self.CANONICAL) else 0o40775))
            changes.append(('mode',0o100644 if target in (m.AGENT_COLLECTION,self.CANONICAL) else 0o100755))
            for field,value in changes:
                install=self.installation(); fixture=self.collector()
                if field=='missing': del install.nodes[target]
                else: install.nodes[target][field]=value
                with self.subTest(target=target,field=field,value=value), self.patched(fixture,install):
                    with self.assertRaises((m.Rejected,OSError)): fixture.run()
                    m.subprocess.Popen.assert_not_called()
                    m.os.pidfd_open.assert_not_called()
                self.assertFalse(fixture.proc.waited)
                self.assertEqual(fixture.events,[])
                self.assertEqual(fixture.frames,[])
    def test_interpreter_resolution_failure_never_uses_path_or_unresolved_python(self):
        for error in (FileNotFoundError('inert missing interpreter'),OSError('inert resolution failure')):
            fixture=self.collector(); install=self.installation()
            with self.subTest(error=type(error).__name__), install.patched(), fixture.patched(), mock.patch.object(m.Path,'resolve',autospec=True,side_effect=error) as resolve, mock.patch.object(m,'trusted',wraps=m.trusted) as trusted, self.assertRaises(OSError):
                try: fixture.run()
                finally:
                    resolve.assert_called_once_with(self.INTERPRETER,strict=True)
                    trusted.assert_called_once_with(m.AGENT_COLLECTION,executable=True)
                    m.subprocess.Popen.assert_not_called()
                    m.os.pidfd_open.assert_not_called()
            self.assertFalse(fixture.proc.waited)
            self.assertEqual(fixture.events,[])
    def test_existing_native_commands_do_not_resolve_or_dispatch_the_collection_helper(self):
        fixture=ExecutionFixture()
        with fixture.patched(), mock.patch.object(m.Path,'resolve') as resolve, mock.patch.object(m,'trusted') as trusted:
            self.assertEqual(fixture.run(),0)
            resolve.assert_not_called(); trusted.assert_not_called()
            self.assertEqual(m.subprocess.Popen.call_args.args[0][4:],[str(m.ROOT/'sysak'),*ARGS])
        fixture.assert_cleanup(self)
    def test_service_propagates_fixed_manager_exit_status(self):
        for action in ('status','ensure','disable'):
            for code in (0,42,126):
                service=m.Service(1000); service.slots.acquire()
                fixture=self.collector(action,code)
                with self.subTest(action=action,code=code), self.patched(fixture), mock.patch.object(m,'authenticate',return_value=(1000,PID,777,PEERFD)), mock.patch.object(m,'read_request',return_value=encoded(fixture.body)), mock.patch.object(m,'verify_bundle') as verify:
                    service.handle(fixture.conn)
                    verify.assert_called_once_with('a'*64,MONO+35,service.stop)
                    m.subprocess.Popen.assert_called_once()
                self.assertEqual(fixture.frames[-1],{'code':code})
                fixture.conn.close.assert_called_once()
                self.assertFalse(service.execution.locked())
                self.assertTrue(service.slots.acquire(blocking=False)); service.slots.release()
                fixture.assert_cleanup(self)
    def test_service_rejects_arbitrary_commands_extra_args_and_payload_before_dispatch(self):
        invalid=[([],''),(['sh','-c','inert'],''),([str(m.AGENT_COLLECTION),'status'],''),
                 (['idc','--agent-collection'],''),(['idc','--agent-collection','status','--uid','1000'],''),
                 (['idc','--agent-collection','ensure','--accept-host-capture'],''),
                 (['idc','--agent-collection','disable','/bin/sh'],''),
                 (['idc','--agent-collection','status'],'{}'),(['idc','--agent-collection','ensure'],'inert')]
        invalid.extend((['idc','--agent-collection',action],'') for action in ('enable','verify','setup','start','stop','; inert','$(inert)','/bin/sh','sysom-idc.service'))
        for args,payload in invalid:
            service=m.Service(1000); service.slots.acquire()
            fixture=self.collector(); body=request(args=args,stdin=payload)
            with self.subTest(args=args,payload=payload), root(), fixture.patched(), mock.patch.object(m,'authenticate',return_value=(1000,PID,777,PEERFD)), mock.patch.object(m,'read_request',return_value=encoded(body)), mock.patch.object(m,'verify_bundle') as verify, mock.patch.object(m.Path,'resolve',return_value=self.CANONICAL) as resolve, mock.patch.object(m,'trusted') as trusted:
                service.handle(fixture.conn)
                verify.assert_not_called(); resolve.assert_not_called(); trusted.assert_not_called()
                m.subprocess.Popen.assert_not_called(); m.os.pidfd_open.assert_not_called()
            self.assertEqual(fixture.frames,[{'code':126,'error':m.UNAVAILABLE}])
            self.assertEqual(fixture.events,[])
            fixture.conn.close.assert_called_once()
            self.assertFalse(service.execution.locked())
            self.assertTrue(service.slots.acquire(blocking=False)); service.slots.release()

class Dispatch(unittest.TestCase):
    def dispatch(self,error=None,busy=False,auth_error=False,real_execution=False):
        service=m.Service(1000); service.slots.acquire()
        if busy: service.execution.acquire()
        conn=mock.Mock(); frames=[]
        with ExitStack() as stack:
            stack.enter_context(root()); stack.enter_context(clocks())
            stack.enter_context(mock.patch.object(m,'authenticate',side_effect=m.Rejected() if auth_error else None,return_value=(1000,PID,777,PEERFD)))
            read=stack.enter_context(mock.patch.object(m,'read_request',return_value=encoded(request())))
            verify=stack.enter_context(mock.patch.object(m,'verify_bundle',side_effect=error if error and not real_execution else None))
            run=stack.enter_context(mock.patch.object(m,'run_collector',side_effect=error if real_execution else None,return_value=0))
            stack.enter_context(mock.patch.object(m.os,'close'))
            stack.enter_context(mock.patch.object(m,'send_frame',side_effect=lambda conn,frame,*a:frames.append(frame)))
            service.handle(conn)
            if auth_error: read.assert_not_called()
            if auth_error or busy: verify.assert_not_called(); run.assert_not_called()
        conn.close.assert_called_once()
        self.assertTrue(service.slots.acquire(blocking=False)); service.slots.release()
        if busy: service.execution.release()
        else: self.assertFalse(service.execution.locked())
        if isinstance(error,m.subprocess.TimeoutExpired):
            self.assertTrue(service.failed); self.assertTrue(service.stop.is_set())
        return frames
    def test_fixed_terminal_errors_no_exception_text_and_busy(self):
        self.assertEqual(self.dispatch(),[{'code':0}])
        self.assertEqual(self.dispatch(busy=True),[{'code':75,'error':m.BUSY}])
        self.assertEqual(self.dispatch(auth_error=True),[{'code':126,'error':m.UNAVAILABLE}])
        for error in (OSError('private path and data'),m.Rejected('private detail'),UnicodeError('secret'),TypeError('secret')):
            with self.subTest(error=type(error).__name__): self.assertEqual(self.dispatch(error=error),[{'code':126,'error':m.UNAVAILABLE}])
        self.assertEqual(self.dispatch(error=RuntimeError('unexpected private detail')),[{'code':126,'error':m.UNAVAILABLE}])
        self.assertEqual(self.dispatch(error=m.Expired()),[{'code':124}])
        self.assertEqual(self.dispatch(error=m.TooLarge(),real_execution=True),[{'code':125,'error':m.TOO_LARGE}])
        self.assertEqual(self.dispatch(error=m.Cancelled(),real_execution=True),[])
        self.assertEqual(self.dispatch(error=m.subprocess.TimeoutExpired('inert collector',1),real_execution=True),[{'code':126,'error':m.UNAVAILABLE}])
    def test_shutdown_closes_connections_without_signalling_peer(self):
        service=m.Service(1000); conn=mock.Mock(); service.connections.add(conn); service.listener=mock.Mock()
        with mock.patch.object(m.os,'killpg') as kill, mock.patch.object(m.os,'kill') as other: service.shutdown(signal.SIGTERM,None)
        self.assertTrue(service.stop.is_set()); service.listener.close.assert_called_once()
        conn.shutdown.assert_called_once_with(socket.SHUT_RDWR); conn.close.assert_called_once()
        kill.assert_not_called(); other.assert_not_called()
    def test_main_is_service_only_and_registers_both_shutdown_signals(self):
        with mock.patch.object(m,'read_authorized_uid',return_value=1000), mock.patch.object(m.os,'getpid',return_value=PID), mock.patch.object(m.os,'pidfd_open',return_value=PEERFD) as opened, mock.patch.object(m.os,'close') as closed, mock.patch.object(m,'Service') as service, mock.patch.object(m.signal,'signal') as signals:
            m.main([])
            opened.assert_called_once_with(PID,0); closed.assert_called_once_with(PEERFD)
            service.assert_called_once_with(1000); service.return_value.serve.assert_called_once_with()
            self.assertEqual(signals.call_args_list,[mock.call(signal.SIGTERM,service.return_value.shutdown),mock.call(signal.SIGINT,service.return_value.shutdown)])
        for args in [['idc'],[str((NOW+35)*1000),*ARGS],['--socket','/tmp/inert']]:
            with self.subTest(args=args), mock.patch.object(m,'read_authorized_uid') as read, self.assertRaises(m.Rejected): m.main(args)
            read.assert_not_called()
    def test_missing_pidfd_support_never_binds_or_advertises_a_service(self):
        with mock.patch.object(m,'read_authorized_uid',return_value=1000), mock.patch.object(m.os,'pidfd_open',side_effect=OSError('unsupported')), mock.patch.object(m,'Service') as service, self.assertRaises(OSError):
            m.main([])
        service.assert_not_called()
    def test_failed_cleanup_stops_service_with_nonzero_exit(self):
        service=m.Service(1000); service.failed=True; service.stop.set()
        with mock.patch.object(service,'bind'), self.assertRaises(m.Rejected): service.serve()
    def test_four_receiver_slots_and_finite_shutdown_joins(self):
        service=m.Service(1000); listener=mock.Mock(); service.listener=listener
        conns=[mock.Mock() for _ in range(5)]; workers=[]; frames=[]
        def accept():
            if conns: return conns.pop(0),None
            service.stop.set(); raise OSError('inert stop')
        listener.accept.side_effect=accept
        def thread(**kwargs):
            self.assertTrue(kwargs['daemon'])
            worker=mock.Mock(); workers.append(worker); return worker
        with clocks(), mock.patch.object(service,'bind'), mock.patch.object(m.threading,'Thread',side_effect=thread), mock.patch.object(m,'terminal',side_effect=lambda conn,code,error=None:frames.append((code,error))): service.serve()
        self.assertEqual(len(workers),4); self.assertEqual(frames,[(75,m.BUSY)])
        for worker in workers: worker.start.assert_called_once(); worker.join.assert_called_once_with(3)

class SocketBinding(unittest.TestCase):
    def bind(self,existing=None,runtime=None):
        install=Installation(); directory=m.Path(m.SOCKET).parent
        install.add(directory,b'',0o40755)
        if runtime: install.nodes[directory].update(runtime)
        if existing: install.add(m.Path(m.SOCKET),b'',existing.get('mode',0o140666)); install.nodes[m.Path(m.SOCKET)].update(existing)
        listener=mock.Mock()
        def bind(path):
            self.assertEqual(path,m.SOCKET); install.add(m.Path(path),b'',0o140600)
        listener.bind.side_effect=bind
        with install.patched(), mock.patch.object(m.socket,'socket',return_value=listener) as factory, mock.patch.object(m.Path,'unlink') as unlink, mock.patch.object(m.os,'umask',return_value=0o022) as mask, mock.patch.object(m.os,'chmod') as chmod:
            try: m.Service(1000).bind()
            except m.Rejected:
                unlink.assert_not_called(); factory.assert_not_called(); raise
            factory.assert_called_once_with(socket.AF_UNIX,socket.SOCK_STREAM)
            self.assertEqual(mask.call_args_list,[mock.call(0o077),mock.call(0o022)])
            chmod.assert_called_once_with(m.SOCKET,0o666); listener.listen.assert_called_once_with(16); listener.settimeout.assert_called_once_with(.2)
            if existing: unlink.assert_called_once_with()
            else: unlink.assert_not_called()
    def test_fixed_unix_socket_safe_runtime_and_existing_socket(self):
        self.assertEqual(str(m.ROOT),'/opt/SysAgent管家/resources/sysak')
        self.assertEqual(str(m.HELPER),'/opt/SysAgent管家/resources/sysak-root-runner.py')
        self.assertEqual(m.SOCKET,'/run/sysom-idc/idc.sock'); self.assertEqual(m.AUTH,'/etc/sysom-idc/allowed-uid')
        self.bind(); self.bind(existing={'mode':0o140666,'uid':0})
        for node in [dict(mode=0o100644),dict(mode=0o40755),dict(mode=0o120777),dict(uid=1000),dict(gid=1000)]:
            with self.subTest(existing=node), self.assertRaises(m.Rejected): self.bind(existing=node)
        for node in [dict(mode=0o40777),dict(mode=0o40750),dict(uid=1000),dict(gid=1000),dict(mode=0o120777)]:
            with self.subTest(runtime=node), self.assertRaises(m.Rejected): self.bind(runtime=node)

    def test_shutdown_unlinks_only_the_same_root_owned_socket_inode(self):
        for mode,uid,gid,inode,expected in [(0o140666,0,0,2,True),(0o140666,0,0,3,False),(0o100644,0,0,2,False),(0o120777,0,0,2,False),(0o140666,1000,0,2,False),(0o140666,0,1000,2,False)]:
            service=m.Service(1000); service.stop.set(); service.bound_identity=(1,2)
            info=SimpleNamespace(st_mode=mode,st_uid=uid,st_gid=gid,st_dev=1,st_ino=inode)
            with self.subTest(mode=mode,uid=uid,gid=gid,inode=inode), clocks(), mock.patch.object(service,'bind'), mock.patch.object(m.Path,'lstat',return_value=info), mock.patch.object(m.Path,'unlink') as unlink:
                service.serve()
                self.assertEqual(unlink.called,expected)

class IPC(unittest.TestCase):
    def test_actual_ordinary_peer_credentials_accept_normal_bounding_set(self):
        self.assertGreater(m.os.getuid(),0)
        self.assertGreater(m.os.getgid(),0)
        server,client=socket.socketpair(socket.AF_UNIX,socket.SOCK_STREAM)
        peerfd=None
        try:
            with mock.patch.object(m.subprocess,'Popen') as launch, mock.patch.object(m.os,'kill') as kill, mock.patch.object(m.os,'killpg') as group, mock.patch.object(m.signal,'pidfd_send_signal') as send:
                uid,pid,starttime,peerfd=m.authenticate(server,m.os.getuid())
                self.assertEqual((uid,pid),(m.os.getuid(),m.os.getpid()))
                self.assertGreater(starttime,0)
                m.peer_ready(peerfd)
                launch.assert_not_called(); kill.assert_not_called(); group.assert_not_called(); send.assert_not_called()
        finally:
            if peerfd is not None: m.os.close(peerfd)
            server.close(); client.close()
    def test_ordinary_user_socketpair_header_and_base64_frames(self):
        server,client=socket.socketpair(socket.AF_UNIX,socket.SOCK_STREAM)
        real_select=m.select.select
        def select_without_pidfd(read,write,error,timeout): return real_select([fd for fd in read if fd != PEERFD],write,error,timeout)
        try:
            server.setblocking(False); client.settimeout(1)
            client.sendall(encoded(request())+b'\n')
            with mock.patch.object(m.select,'select',select_without_pidfd):
                self.assertEqual(m.read_request(server,PEERFD,threading.Event()),encoded(request()))
                m.send_frame(server,{'stream':'stdout','data':base64.b64encode(b'\x00\xfffixture').decode()},m.time.monotonic()+1)
                m.terminal(server,0)
            data=bytearray()
            while data.count(b'\n')<2: data.extend(client.recv(4096))
            frames=[json.loads(line) for line in data.splitlines()]
            self.assertEqual(base64.b64decode(frames[0]['data']),b'\x00\xfffixture'); self.assertEqual(frames[1],{'code':0})
            client.close()
            with mock.patch.object(m.select,'select',select_without_pidfd), self.assertRaises(m.Cancelled): m.connection_ready(server,PEERFD,m.time.monotonic()+1,threading.Event())
        finally: server.close(); client.close()
    def test_terminal_during_shutdown_never_leaks_closed_fd_exceptions(self):
        conn=mock.Mock()
        with mock.patch.object(m,'send_frame',side_effect=ValueError('closed descriptor and private detail')):
            m.terminal(conn,126,m.UNAVAILABLE)
    def test_send_is_bounded_on_backpressure_and_disconnect(self):
        conn=mock.Mock()
        with mock.patch.object(m.time,'monotonic',side_effect=[MONO,MONO,MONO+1]), mock.patch.object(m.select,'select',return_value=([],[],[])), self.assertRaises(m.Expired): m.send_frame(conn,{'code':0},MONO+.5)
        conn.send.assert_not_called(); conn.send.return_value=0
        with clocks(), mock.patch.object(m.select,'select',return_value=([],[conn],[])), self.assertRaises(m.Cancelled): m.send_frame(conn,{'code':0},MONO+1)
`;
for (const suite of ['Protocol', 'Trust', 'Identity', 'Header', 'Execution', 'AgentCollectionExecution', 'Dispatch', 'SocketBinding', 'IPC']) {
  test(`root IDC service: ${suite}`, () => {
    const python = `HELPER_PATH = ${JSON.stringify(helper)}\n${script}\nunittest.main(argv=['fixtures', ${JSON.stringify(suite)}], verbosity=2)`;
    const result = spawnSync('/usr/bin/python3', ['-I', '-B', '-c', python], { encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024 });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /\nOK\s*$/);
  });
}
