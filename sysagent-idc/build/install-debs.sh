#!/bin/sh
set -eu
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
case "${1-}" in
    '') [ "$#" -eq 0 ] || exit 2; collection=0 ;;
    --enable-agent-collection) [ "$#" -eq 1 ] || exit 2; collection=1 ;;
    *) printf '%s\n' '用法：sh install-debs.sh [--enable-agent-collection]' >&2; exit 2 ;;
esac
if [ "$(id -u)" -ne 0 ]; then
    exec sudo sh "$HERE/install-debs.sh" "$@"
fi
printf '%s\n' '安装 SysAgent 与独立 AgentSight 配套 deb；不联网下载，保留已有用户配置。'
if [ "$collection" = 1 ]; then
    uid=${SYSOM_IDC_UID-${SUDO_UID-}}
    case "$uid" in ''|0*|*[!0-9]*) printf '%s\n' '启用采集需要通过 sudo 执行，或明确设置 SYSOM_IDC_UID 为已授权普通用户的数字 UID。' >&2; exit 2 ;; esac
    printf '%s\n' '你已明确选择启用主机级真实调用采集：可能捕获其他进程的明文、参数及会话内容，并在本地保存；当前 AgentSight 不提供严格的进程隔离。trace 服务包含兼容内核 perf 安全策略所需的 CAP_SYS_ADMIN，数据库总容量清理目标为 50 MiB（不是硬磁盘配额）。该选项不产生模型调用费用。'
fi
dpkg --install "$HERE/sysom-agentsight-runtime_@AGENTSIGHT_VERSION@_amd64.deb" "$HERE/sysagent-idc_@SYSOM_VERSION@_amd64.deb"
if [ "$collection" = 1 ]; then
    /usr/bin/python3 -I /usr/share/sysom/agentsight-runtime/agentsight-collection.py enable --uid "$uid" --accept-host-capture
fi
