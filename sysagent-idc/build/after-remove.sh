#!/bin/sh
set -eu

APP_DIR='/opt/SysAgent管家'

# An old package's postrm must not unregister the new version during upgrades.
case "${1:-remove}" in
    remove|purge) ;;
    *) exit 0 ;;
esac

if [ "$(id -u)" != 0 ]; then
    printf '%s\n' 'SysAgent: this removal hook requires a root package operation.' >&2
    exit 1
fi

UNIT_FILE='/etc/systemd/system/sysom-idc.service'
CONFIG_DIR='/etc/sysom-idc'
AUTH_FILE="$CONFIG_DIR/allowed-uid"

require_safe_chain() {
    parent=$1
    while :; do
        if [ ! -d "$parent" ] || [ -L "$parent" ]; then
            printf 'SysAgent: unsafe root service ancestor: %s\n' "$parent" >&2
            exit 1
        fi
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

require_safe_file() {
    if [ ! -f "$1" ] || [ -L "$1" ] || [ "$(stat -c %h -- "$1")" != 1 ] ||
       [ "$(stat -c %u:%g -- "$1")" != 0:0 ] || [ "$(stat -c %a -- "$1")" != 644 ]; then
        printf 'SysAgent: unsafe root service file: %s\n' "$1" >&2
        exit 1
    fi
}

require_safe_chain '/etc/systemd/system'
if [ -e "$UNIT_FILE" ] || [ -L "$UNIT_FILE" ]; then require_safe_file "$UNIT_FILE"; fi
if [ "${1:-remove}" = purge ]; then
    if [ -e "$CONFIG_DIR" ] || [ -L "$CONFIG_DIR" ]; then require_safe_chain "$CONFIG_DIR"; fi
    if [ -e "$AUTH_FILE" ] || [ -L "$AUTH_FILE" ]; then require_safe_file "$AUTH_FILE"; fi
fi

systemd_state=''
if [ -d /run/systemd/system ] && command -v systemctl >/dev/null 2>&1; then
    systemd_state=$(systemctl is-system-running 2>/dev/null || true)
fi
case "$systemd_state" in
    running|degraded)
        if [ -f "$UNIT_FILE" ]; then systemctl disable --now sysom-idc.service; fi
        ;;
    *) printf '%s\n' 'SysAgent: systemd is not running; no service state was changed and no fallback is used.' >&2 ;;
esac
if [ -f "$UNIT_FILE" ]; then rm -f -- "$UNIT_FILE"; fi
case "$systemd_state" in running|degraded) systemctl daemon-reload ;; esac
if [ "${1:-remove}" = purge ]; then
    if [ -f "$AUTH_FILE" ]; then rm -f -- "$AUTH_FILE"; fi
    if [ -d "$CONFIG_DIR" ]; then rmdir -- "$CONFIG_DIR" 2>/dev/null || true; fi
fi

update-alternatives --remove 'sysagent-idc' "$APP_DIR/sysagent-idc"

# dpkg removes application resources; retain user data and other sysAK installations.
if command -v update-desktop-database >/dev/null 2>&1; then
    update-desktop-database /usr/share/applications
fi

if command -v gtk-update-icon-cache >/dev/null 2>&1; then
    gtk-update-icon-cache -q -t -f /usr/share/icons/hicolor || true
fi
