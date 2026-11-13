#!/bin/sh
set -eu

APP_DIR='/opt/SysAgent管家'
SYSAK_DIR="$APP_DIR/resources/sysak"
TOOLS_DIR="$SYSAK_DIR/.sysak_components/tools"
ROOT_HELPER="$APP_DIR/resources/sysak-root-runner.py"
GX_HELPER="$APP_DIR/resources/gx-runtime.py"
UNIT_SOURCE="$APP_DIR/resources/sysom-idc.service"

# Only the package installer may deploy the application's root IDC service.
if [ "$(id -u)" != 0 ]; then
    printf '%s\n' 'SysAgent: this installation hook requires a root package installation.' >&2
    exit 1
fi
if ! command -v python3 >/dev/null 2>&1; then
    printf '%s\n' 'SysAgent: bundled sysAK requires python3 (also required for AppImage).' >&2
    exit 1
fi
if ! python3 -I -B -c 'import os; fd = os.pidfd_open(os.getpid(), 0); os.close(fd)'; then
    printf '%s\n' 'SysAgent: IDC service requires Python with os.pidfd_open (normally 3.9+) and usable Linux pidfds (normally kernel 5.3+); no service fallback is used.' >&2
    exit 1
fi

require_directory() {
    parent=$1
    while :; do
        if [ ! -d "$parent" ] || [ -L "$parent" ]; then
            printf 'SysAgent: missing/unsafe resource ancestor: %s\n' "$parent" >&2
            exit 1
        fi
        [ "$parent" != / ] || break
        parent=${parent%/*}
        parent=${parent:-/}
    done
}

require_file() {
    if [ ! -f "$1" ] || [ ! -s "$1" ] || [ ! -r "$1" ] || [ -L "$1" ] || [ "$(stat -c %h -- "$1")" != 1 ]; then
        printf 'SysAgent: missing/unsafe sysAK resource file: %s\n' "$1" >&2
        exit 1
    fi
    owner=$(stat -c %u:%g -- "$1")
    mode=$(stat -c %a -- "$1")
    if [ "$owner" != 0:0 ] || [ "$((0$mode & 0022))" != 0 ]; then
        printf 'SysAgent: unsafe root service resource: %s\n' "$1" >&2
        exit 1
    fi
}

require_safe_chain() {
    require_directory "$1"
    parent=$1
    while :; do
        owner=$(stat -c %u:%g -- "$parent")
        mode=$(stat -c %a -- "$parent")
        if [ "$owner" != 0:0 ] || [ "$((0$mode & 0022))" != 0 ]; then
            printf 'SysAgent: unsafe root service ancestor: %s\n' "$parent" >&2
            exit 1
        fi
        [ "$parent" != / ] || break
        parent=${parent%/*}
        parent=${parent:-/}
    done
}

require_safe_chain "${APP_DIR%/*}"

for directory in "$APP_DIR" "$APP_DIR/resources" "$SYSAK_DIR" "$SYSAK_DIR/.sysak_components" "$TOOLS_DIR"; do
    require_safe_chain "$directory"
done
for file in "$ROOT_HELPER" "$GX_HELPER" "$UNIT_SOURCE" "$SYSAK_DIR/sysak" "$SYSAK_DIR/manifest.json" \
    "$TOOLS_DIR/idc" "$TOOLS_DIR/resource_anomaly" "$TOOLS_DIR/memgraph" "$TOOLS_DIR/ai" "$TOOLS_DIR/.sysak.rules"; do
    require_file "$file"
done
for module in resource_anomaly_idc fdleak_metrics plugin_abnormalPackages plugin_anonTaskTop plugin_cache plugin_memcgLeak plugin_memfrag plugin_memgraph plugin_meminfo plugin_memleak plugin_podDetect plugin_system plugin_taskProc plugin_vmRssTaskTop plugin_skcheck plugin_appmem mem_utils plugin_thpCollect; do
    require_file "$TOOLS_DIR/$module.py"
done

for directory in "$SYSAK_DIR" "$SYSAK_DIR/.sysak_components" "$TOOLS_DIR"; do
    for entry in "$directory"/* "$directory"/.[!.]* "$directory"/..?*; do
        [ -e "$entry" ] || [ -L "$entry" ] || continue
        case "$entry" in
            "$SYSAK_DIR/sysak"|"$SYSAK_DIR/manifest.json"|"$SYSAK_DIR/.sysak_components"|"$TOOLS_DIR"|"$TOOLS_DIR/idc"|"$TOOLS_DIR/resource_anomaly"|"$TOOLS_DIR/memgraph"|"$TOOLS_DIR/ai"|"$TOOLS_DIR/.sysak.rules") continue ;;
        esac
        allowed=0
        for module in resource_anomaly_idc fdleak_metrics plugin_abnormalPackages plugin_anonTaskTop plugin_cache plugin_memcgLeak plugin_memfrag plugin_memgraph plugin_meminfo plugin_memleak plugin_podDetect plugin_system plugin_taskProc plugin_vmRssTaskTop plugin_skcheck plugin_appmem mem_utils plugin_thpCollect; do
            [ "$entry" != "$TOOLS_DIR/$module.py" ] || allowed=1
        done
        if [ "$allowed" != 1 ]; then
            printf 'SysAgent: unexpected sysAK bundle path: %s\n' "$entry" >&2
            exit 1
        fi
    done
done

# Validate the exact manifest and bytes before any resource/service mutation.
python3 -I -B - "$SYSAK_DIR" <<'SYSAK_MANIFEST_PY'
import hashlib
import json
import os
import re
import struct
import sys
from pathlib import Path

root = Path(sys.argv[1])
tools = '.sysak_components/tools'
commands = ['idc', 'resource_anomaly', 'memgraph', 'ai']
profiles = {'resource_anomaly': ['--idc'], 'memgraph': ['--graph', '--jsonstdout'], 'ai': ['--threshold', '1s']}
modules = [
    'resource_anomaly_idc', 'fdleak_metrics',
    'plugin_abnormalPackages', 'plugin_anonTaskTop', 'plugin_cache', 'plugin_memcgLeak', 'plugin_memfrag',
    'plugin_memgraph', 'plugin_meminfo', 'plugin_memleak', 'plugin_podDetect', 'plugin_system', 'plugin_taskProc',
    'plugin_vmRssTaskTop', 'plugin_skcheck', 'plugin_appmem', 'mem_utils', 'plugin_thpCollect',
]
required = {'sysak', tools + '/.sysak.rules', *[tools + '/' + name for name in commands],
            *[tools + '/' + name + '.py' for name in modules]}

def pairs(items):
    result = {}
    for key, value in items:
        if key in result:
            raise ValueError('duplicate manifest key')
        result[key] = value
    return result

try:
    manifest = json.loads((root / 'manifest.json').read_bytes(), object_pairs_hook=pairs)
    arch = {'x86_64': 'x64', 'aarch64': 'arm64'}.get(os.uname().machine)
    if (type(manifest) is not dict or manifest.get('schema_version') != '1.0' or
            manifest.get('platform') != 'linux' or arch is None or manifest.get('arch') != arch or
            manifest.get('commands') != commands or manifest.get('requires') != ['python3'] or
            manifest.get('safe_profiles') != profiles or type(manifest.get('files')) is not dict or
            set(manifest['files']) != required):
        raise ValueError('invalid manifest')
    for relative, digest in manifest['files'].items():
        data = (root / relative).read_bytes()
        if (type(digest) is not str or not re.fullmatch('[a-f0-9]{64}', digest) or
                hashlib.sha256(data).hexdigest() != digest):
            raise ValueError('invalid component digest')
        if relative in ('sysak', tools + '/ai'):
            if (len(data) < 64 or data[:7] != b'\x7fELF\x02\x01\x01' or
                    struct.unpack_from('<I', data, 20)[0] != 1 or struct.unpack_from('<H', data, 52)[0] != 64 or
                    struct.unpack_from('<H', data, 16)[0] not in (2, 3) or
                    struct.unpack_from('<H', data, 18)[0] != {'x64': 62, 'arm64': 183}[arch]):
                raise ValueError('invalid native ELF architecture')
        elif relative in {tools + '/' + name for name in commands}:
            if not re.match(rb'#![^\r\n]*\bpython3\b', data):
                raise ValueError('invalid python3 entry')
        elif relative == tools + '/.sysak.rules':
            lines = data.decode('utf-8').split('\n')
            if len(lines) != len(commands) + 1 or lines.pop() != '':
                raise ValueError('noncanonical rules')
            for command, line in zip(commands, lines):
                if command == 'ai':
                    if line != 'generic:ai::help{GPU AI diagnostics}':
                        raise ValueError('invalid native ai rule')
                elif not re.fullmatch(r'[A-Za-z0-9_/-]+:' + command + r':python-dep\{python3\}:help\{[^\r\n\0]*\}', line):
                    raise ValueError('invalid python3 rule')
except Exception:
    sys.stderr.write('SysAgent: invalid sysAK manifest or component digest.\n')
    sys.exit(1)
SYSAK_MANIFEST_PY

# Ordinary users can traverse/read/run the bundled tools; no privilege bits.
chmod 755 "$APP_DIR" "$APP_DIR/resources" "$SYSAK_DIR" "$SYSAK_DIR/.sysak_components" "$TOOLS_DIR"
chmod 755 "$SYSAK_DIR/sysak" "$TOOLS_DIR/idc" "$TOOLS_DIR/resource_anomaly" "$TOOLS_DIR/memgraph" "$TOOLS_DIR/ai"
for module in resource_anomaly_idc fdleak_metrics plugin_abnormalPackages plugin_anonTaskTop plugin_cache plugin_memcgLeak plugin_memfrag plugin_memgraph plugin_meminfo plugin_memleak plugin_podDetect plugin_system plugin_taskProc plugin_vmRssTaskTop plugin_skcheck plugin_appmem mem_utils plugin_thpCollect; do
    chmod 755 "$TOOLS_DIR/$module.py"
done
chmod 644 "$SYSAK_DIR/manifest.json" "$TOOLS_DIR/.sysak.rules"
chmod 755 "$ROOT_HELPER" "$GX_HELPER"
chmod 644 "$UNIT_SOURCE"
chown root:root "$APP_DIR" "$APP_DIR/resources" "$SYSAK_DIR" "$SYSAK_DIR/.sysak_components" "$TOOLS_DIR" "$ROOT_HELPER" "$GX_HELPER" "$UNIT_SOURCE"
chown root:root "$SYSAK_DIR/sysak" "$SYSAK_DIR/manifest.json" "$TOOLS_DIR/.sysak.rules" "$TOOLS_DIR/idc" "$TOOLS_DIR/resource_anomaly" "$TOOLS_DIR/memgraph" "$TOOLS_DIR/ai"
for module in resource_anomaly_idc fdleak_metrics plugin_abnormalPackages plugin_anonTaskTop plugin_cache plugin_memcgLeak plugin_memfrag plugin_memgraph plugin_meminfo plugin_memleak plugin_podDetect plugin_system plugin_taskProc plugin_vmRssTaskTop plugin_skcheck plugin_appmem mem_utils plugin_thpCollect; do
    chown root:root "$TOOLS_DIR/$module.py"
done

python3 -I -B "$GX_HELPER"

update-alternatives --install '/usr/bin/sysagent-idc' 'sysagent-idc' "$APP_DIR/sysagent-idc" 100

UNIT_FILE='/etc/systemd/system/sysom-idc.service'
CONFIG_DIR='/etc/sysom-idc'
AUTH_FILE="$CONFIG_DIR/allowed-uid"

require_safe_file() {
    require_file "$1"
    if [ "$(stat -c %u:%g -- "$1")" != 0:0 ] || [ "$(stat -c %a -- "$1")" != 644 ]; then
        printf 'SysAgent: unsafe root service file: %s\n' "$1" >&2
        exit 1
    fi
}

normalize_id() {
    case "$1" in ''|*[!0-9]*) return 1 ;; esac
    number=$1
    while [ "${number#0}" != "$number" ]; do number=${number#0}; done
    [ -n "$number" ] && [ "${#number}" -le 10 ] && [ "$number" -le 4294967294 ] || return 1
    printf '%s\n' "$number"
}

validate_uid() {
    authorized_uid=$(normalize_id "$1") || return 1
    passwd_entry=$(getent passwd "$authorized_uid") || return 1
    case "$passwd_entry" in ''|*'
'*) return 1 ;; esac
    IFS=: read -r account password account_uid account_gid gecos home login_shell <<EOF
$passwd_entry
EOF
    [ "$account_uid" = "$authorized_uid" ] || return 1
    normalize_id "$account_gid" >/dev/null || return 1
}

require_safe_chain '/etc/systemd/system'
require_safe_chain '/etc'
if [ -e "$UNIT_FILE" ] || [ -L "$UNIT_FILE" ]; then require_safe_file "$UNIT_FILE"; fi
if [ -e "$CONFIG_DIR" ] || [ -L "$CONFIG_DIR" ]; then require_safe_chain "$CONFIG_DIR"; fi
if [ -e "$AUTH_FILE" ] || [ -L "$AUTH_FILE" ]; then require_safe_file "$AUTH_FILE"; fi

new_uid=0
if [ "${SYSOM_IDC_UID+x}" = x ]; then
    requested_uid=$SYSOM_IDC_UID
    new_uid=1
elif [ "${SUDO_UID+x}" = x ]; then
    requested_uid=$SUDO_UID
    new_uid=1
elif [ -f "$AUTH_FILE" ]; then
    auth_lines=$(wc -l < "$AUTH_FILE")
    auth_bytes=$(wc -c < "$AUTH_FILE")
    if [ "$auth_lines" -gt 1 ] || [ "$auth_bytes" -gt 11 ]; then
        printf '%s\n' 'SysAgent: invalid existing allowed-uid.' >&2
        exit 1
    fi
    requested_uid=''
    remainder=''
    {
        IFS= read -r requested_uid || [ -n "$requested_uid" ]
        if IFS= read -r remainder || [ -n "$remainder" ]; then
            printf '%s\n' 'SysAgent: invalid existing allowed-uid (expected one UID).' >&2
            exit 1
        fi
    } < "$AUTH_FILE"
    if [ "$auth_bytes" -ne "$((${#requested_uid} + auth_lines))" ]; then
        printf '%s\n' 'SysAgent: invalid existing allowed-uid bytes.' >&2
        exit 1
    fi
else
    requested_uid=''
fi
if [ "$new_uid" = 1 ] || [ -f "$AUTH_FILE" ]; then
    if ! validate_uid "$requested_uid"; then
        printf '%s\n' 'SysAgent: authorization requires an existing ordinary numeric UID (1..4294967294), with a non-root primary GID.' >&2
        exit 1
    fi
else
    authorized_uid=''
fi

install -T -o root -g root -m 644 -- "$UNIT_SOURCE" "$UNIT_FILE"
install -d -o root -g root -m 755 -- "$CONFIG_DIR"
if [ "$new_uid" = 1 ]; then
    printf '%s\n' "$authorized_uid" | install -T -o root -g root -m 644 -- /dev/stdin "$AUTH_FILE"
fi

systemd_state=''
if [ -d /run/systemd/system ] && command -v systemctl >/dev/null 2>&1; then
    systemd_state=$(systemctl is-system-running 2>/dev/null || true)
fi
case "$systemd_state" in
    running|degraded)
        systemctl daemon-reload
        if [ -n "$authorized_uid" ]; then
            systemctl enable sysom-idc.service
            systemctl restart sysom-idc.service
        fi
        ;;
    *) printf '%s\n' 'SysAgent: systemd is not running; IDC service was not started. No fallback is used. On a systemd host, rerun the root package installation to activate it.' >&2 ;;
esac
if [ -z "$authorized_uid" ]; then
    printf '%s\n' 'SysAgent: no authorized UID; IDC service was not enabled or started. Reinstall with sudo env SYSOM_IDC_UID=<your numeric UID> apt-get install --reinstall sysagent-idc (or dpkg -i <package.deb>).' >&2
fi

# A root namespace probe does not represent desktop AppArmor restrictions.
chown root:root "$APP_DIR/chrome-sandbox"
chmod 4755 "$APP_DIR/chrome-sandbox"

if command -v update-desktop-database >/dev/null 2>&1; then
    update-desktop-database /usr/share/applications
fi

if command -v gtk-update-icon-cache >/dev/null 2>&1; then
    gtk-update-icon-cache -q -t -f /usr/share/icons/hicolor || true
fi
