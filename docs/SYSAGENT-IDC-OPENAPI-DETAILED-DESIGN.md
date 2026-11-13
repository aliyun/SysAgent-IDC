# SysAgent 管家：本地 IDC 采集、前后端协调与 OpenAPI 详细设计

- 文档版本：2.0。
- 2026-11-13 名称更新：当前产品为 SysAgent 0.2.17，桌面目录为 `sysagent-idc`，IDE 目录为 `sysagent-ide-extension`，安装目录为 `/opt/SysAgent管家`，扩展标识为 `sysagent-local.sysagent-ide`。0.2.17 双端构建成功，隔离 AppImage 原生验收 30/30、IDE 原生验收 24/24 通过；全量回归及最终发布包校验结果见根 README，不沿用历史数量或哈希。本文件其余带日期的设计与验收描述均保留为历史阶段，段落中的“当前／本次／本轮”指当时阶段，不指 0.2.17；旧产物记录不作为当前安装入口，当前交付与安装以根 README 为准。源码目录按改名后的路径引用，历史文件名与包元数据保留原名，不表示历史产物被重命名。既有实际类 `SysOMOpenAPI`、`sysom-openapi`、`window.sysomDesktop`、`SYSOM_*`、`sysom://` 和 systemd/socket/数据路径仍为实际运行标识，不能按展示名称改写。
- 常驻服务增量（2026-11-10，0.2.12 已本地生成并由用户安装；0.2.13 修复阶段）：参考 sysAK confmon 的 `Type=simple` / `Restart=on-failure` 生命周期，新增 `sysom-idc.service` 常驻 root 服务。普通桌面/IDE 经 `/run/sysom-idc/idc.sock` 请求固定安装的 `sysak idc`，不再执行 sudo/pkexec；顶层 `resource_anomaly` / `memgraph` 请求拒绝，诊断仍由 IDC 内部固定调用。安装时通过 `SYSOM_IDC_UID` 或 `SUDO_UID` 记录单一授权用户，服务在读取请求前用 `SO_PEERCRED` 和普通进程凭据验证；缺授权配置不启动服务，不猜测用户、不放开免密策略。请求绑定安装 manifest 摘要、35/15 秒期限、8 MiB stdout / 1 MiB stderr 限制；断连/取消只回收本次采集进程组。进程操作绑定 socket peer PID/starttime，按用户追加要求允许其他用户与 root 的非关键目标；保护 PID 1、内核线程、系统/用户服务、服务与 manager 祖先和 manager 子树，无法核实 systemd scope 时拒绝。目标凭据及 cgroup 在信号前再次比对；pidfd SIGTERM、二次确认及 revision 一次性 token 保留。固定安装目录与 bundle 全文件信任校验不变，Electron/IDE 和用户可写代码不提权。
- 当前服务增量的权威设计见下方“常驻服务源码增量”；其余 0.2.11 构建、验收、pkexec/原 caller-only 描述均为已冻结发行阶段的证据，不是服务增量的实际安装验收；0.2.11 的三包、JSON、SHA256 和历史结果不改写。本次未执行系统安装、启动 root 服务、管理员授权或生产进程处置。服务增量验证结果另列，不能沿用 991/107 或旧 unavailable 验收数字。
- 整理日期：2026-11-10。
- 冻结交付基线：SysAgent 桌面应用与 IDE 插件统一为 **0.2.10**，已交付 Linux x64 deb、AppImage、VSIX；三者仍包含交付时的同一套 **28 文件**私有 sysAK（含 confscan）、39 键 Agent 名称筛选及 fdleak `--fd-usage`。插件复用实际 IDC controller、OpenAPI 与共享体检界面，见第 6.5、16.1、17.4 节；不将历史包改写成此次精简版。
- 当前 0.2.11 构建阶段（2026-11-10，本地归档及桌面、Chrome、真实 IDE unavailable 验收通过）：根包、子包及 lockfile 已同步 **0.2.11**，版本一致性校验通过。**所有 SysAgent/IDE 发起的 sysAK 命令统一走固定 root helper，普通 Electron/IDE 不提权，不执行用户可写代码为 root，不自动普通用户回退。** IDC 内存诊断直接调用原生 `memgraph.py --graph --jsonstdout`（无 `--idc`），保留默认插件及额外扫描，不再宣称 proc-only/read-only 安全 profile。三个命令 `idc/resource_anomaly/memgraph`，原生 Makefile 16 模块加 resource_anomaly 2 模块，共 **18 模块、23 个必需组件文件，另加 manifest 共 24 文件**；helper 是 bundle 外的独立安装资源。confscan 及配置保持移除，`configuration: {}` 仅为 API 兼容容器。原 confscan 三处修改独立 stash 并恢复 HEAD；原生 memgraph 7 路径修改已 stash（`13bca2d4e2994a4274b103ad89aca0ee0fb40e05`）并恢复 HEAD，native 目录 git diff 为 0，适配在 IDC/管家侧。**两个开发 bundle 的 23 必需文件及 manifest 校验通过；桌面 build、直接 electron-builder 打包及插件 build/typecheck/package 均 exit 0，0.2.11 deb/AppImage/VSIX 已构建并存在。本阶段 Node/Python 回归通过（详见 16.1）；本地归档及桌面、Chrome、真实 IDE unavailable 验收通过。未实际安装/系统授权/发布，也未加入 polkit passwordless policy；本阶段证据单列于 16.1、17.4，不与 pre-root 历史累计。**
- 0.2.10 历史验收：桌面完整 Node 测试 713/713、构建、三包静态 12 阶段校验通过；解包 deb 原生 Electron 实测 5 项、插件真实 Chrome 验收 12 项、最终解包 VSIX 在隔离 VS Code 1.145.2 的 4 项验收通过。实际 IDE 中选择/取消、旧 token 拒绝、仅自建临时 WorkBuddy 确认 SIGTERM、刷新与 history 均通过；两端真实采集模式无 Session 操作控件，未知指标不冒充正常。SHA256 已生成并复核。
- 版本边界：0.2.10 及旧交付的版本、功能、28/21 文件清单、大小、链接、哈希和验收记录均冻结保留；0.2.9 不包含后续 39 键与 `--fd-usage`。除第 16.1 节本阶段单列回归外，正文沿用的“已验证/通过”仅指历史源码或交付时场景，不证明 root 安装/授权黄金路径已成功。pre-root confscan 移除阶段的 **614/614、69/69、Chrome 12 项**不改为新合计。此前当前章节中的普通用户执行禁令、10 文件/五模块、`memgraph_idc`、安全 profile 和原生 memgraph 暂未实现描述均由本阶段替代；带日期的历史段落只说明当时边界。当前与历史证据分别见 16.1、17.4。
- 适用项目：`sysom_idc/sysagent-idc`、`sysom_idc/sysagent-ide-extension`；本地采集器位于 sysAK `source/tools/detect/generic/idc`。IDE 包需 Linux x64、系统 Python 3 和兼容 VS Code API 1.85+ 的本地扩展宿主；不表示 Qoder Desktop 独立 App 支持 VSIX。
- 本阶段未执行真实系统安装/升级/卸载、系统管理员授权、用户 IDE 安装、AppImage FUSE 启动、生产进程处置、sysAK 全量编译、上传发布或 commit/push；仅实现固定 sysAK root 执行链，不等于已运行 root 黄金路径。远端 OpenAPI 仍只读；可信 Session、文件清理及自动修复未实现。此次文档更新不运行测试，不读取/输出凭据或仓库配置，不扩大上述边界。

## 常驻服务源码增量（2026-11-10，0.2.12 与 0.2.13）

### 0.2.12 已安装故障与 0.2.13 修复

用户已自行安装 0.2.12，并报告体检返回“sysAK IDC 服务身份或组件校验失败”。只读诊断确认服务 active/root、授权 UID 匹配、installed/桌面/VSIX manifest 一致、客户端信任校验通过；daemon 的具体拒绝点是严格组件闭包，而不是身份或授权。安装 tools 目录多出 root:root 0600 的 `vmlinux-6.8.0-90-generic`，旧 dispatcher 的 `subcmd_parse()` 在执行 IDC 前无条件调用 `btf_support_check()`，复制系统 BTF 后破坏安装目录的不可变闭包。

0.2.13 只在精确 `idc` 模式跳过 BTF 准备；IDC 内部诊断本就直接运行固定 Python 入口，不需要 dispatcher BTF。其他原生命令继续按原行为准备 BTF，原生 memgraph/confscan 不改，daemon 仍拒绝任何未列入 manifest 的文件。新增惰性 C harness 验证 resources、inspection、check、terminate 均不访问/写入 BTF，resource_anomaly/memgraph 顶级分支仍准备 BTF；另修正优化构建路径初始化：`realpath` 缓冲区由 512 字节改为 `PATH_MAX`，保留 `_FORTIFY_SOURCE=2` 检查；新增强化编译的路径初始化用例。全部 4 项 dispatcher 用例及最终 143 项原生惰性回归通过，新 ELF 单独编译，不做 sysAK 全量构建。

修复后的普通 UID 实际调用连续执行 2 次 resources 与 2 次 inspection：四次均 exit 0、返回合法 IDC JSON，前后 24 文件闭包和 23 组件摘要一致，未生成 BTF 或字节码。普通用户下 memgraph/failed_units 仍 error、resource_anomaly partial、GPU unavailable，不能当作 root 全诊断成功。最终 dispatcher 改动前的针对性 Node 打包/服务测试 336/336 通过（355.929 秒）；完整 1085 项是 0.2.12 基线，不冒充新版本完整重跑。

已有额外文件不会因 dpkg 升级自动消失：用户需先关闭桌面，把已确认的旧 BTF 文件以不覆盖方式备份到 bundle 外，再安装匹配的 0.2.13 deb 和 VSIX。以上为 0.2.13 的历史恢复记录；当前安装与升级说明见 [插件 README](../sysagent-ide-extension/README.md)。开发代理没有修改系统资源、授权或服务，没有真实目标终止；实际 root 成功采集尚待升级后验证。0.2.12 三包构建和 7 阶段归档检查通过，完整 Node 重跑 1085/1085，原生惰性 141/141，最终 VSIX Chrome 7 项/隔离真实 IDE 4 项 unavailable 通过；原生桌面隔离验收因 spawn EACCES 未通过，不冒充成功。历史发行及当前缺陷/边界分别记录于 [0.2.12](../release/release-0.2.12.json) 和 [0.2.13](../release/release-0.2.13.json)。

### 0.2.14：普通用户服务清理范围（2026-11-10）

0.2.14 桌面 deb/AppImage 和 IDE VSIX 同步采用本段策略，覆盖下方历史阶段“一律保护用户 `.service`”的限制，不改写 0.2.13 已发行包及历史验收。经认证的 root IDC 在可核实 systemd v1/v2 `user.slice` 下接受普通应用 `.scope` 或非关键 `.service`；`user@UID.service` 仅作为用户 manager 祖先，不能单独作为应用证据。`QoderWake.service`、普通用户服务以及继承用户 `dbus.service` / `dbus-broker.service` 的 GUI 应用可通过目标策略；真正的 D-Bus/桌面/音频关键进程仍按关键名称拒绝，systemd-/GNOME/KDE/Xfce/Cinnamon/MATE/音频关键用户服务前缀保护其工作进程。`system.slice`、用户分组外服务、未知分组、PID 1、内核线程、服务/manager 祖先及 manager 子树继续保护。

其他用户/root 的稳定非关键目标仍可允许，但 socket 调用者仍仅为已授权普通 UID。目标四项 UID/GID、flags、全部原始 cgroup memberships 的证据在信号前再次比对；即使从一个允许的用户服务迁移到另一个允许服务，也返回 `protected/target_credentials_or_scope_changed`，不发送信号。PID/starttime、pidfd SIGTERM、二次确认和一次性 token 保持，直接非服务 CLI 的 own-user 边界不变。

新增用例覆盖 D-Bus 普通应用、QoderWake/普通用户服务、跨用户/root、v1 systemd 分组、关键名称/用户服务、空用户 manager/未知分组，以及允许服务之间或转入关键/系统服务的变化。精确执行 IDC/身份/dispatcher 惰性类共 148 项通过；不运行 disposable 真实信号类，不表示已验收真实 root 终止。桌面和插件开发 bundle 与 0.2.14 发行件同步更新；旧发行包及系统安装未修改，需匹配的 0.2.14 deb/VSIX 升级后才对已安装用户生效。

0.2.14 本地发行验证：根包、桌面、IDE 与两份 lockfile 版本同步；桌面 build/deb/AppImage、IDE typecheck/build/最终 VSIX 均 exit 0。完整 Node 1085/1085 通过（352.104 秒），原生惰性 148/148 通过（3.115 秒）；最终三包 8 阶段归档、31 项 root 属主/模式/类型元信息、23 组件加 manifest 的源码/桌面/AppImage/VSIX 五处一致性通过。两桌面 asar SHA256 相同。最终解包 VSIX 在 Chrome 7 项及隔离真实 VS Code 1.145.2 的 4 项 unavailable 验收通过，证据为 `sysagent-analysis/tests/output/ide-webview-v0214-root-unavailable-9y5Lht` 与 `sysagent-analysis/tests/output/ide-vscode-v0.2.14-root-unavailable-dVk8le`。解包 deb 的 IDC 连续 2 次 resources 和 2 次 inspection 均 exit 0、JSON 合法，无 BTF/字节码或 bundle 摘要变化；普通 UID 的 memgraph error、resource_anomaly partial、GPU unavailable，不当作 root 全诊断正常。未安装/启动服务或执行真实目标终止，原生桌面 GUI 本版未重新验收；旧 EACCES 仍是不通过边界。0.2.13 三包原哈希复核不变，新三包与校验见 [0.2.14 发行记录](../release/release-0.2.14.json) 和 [SHA256](../release/SHA256SUMS-0.2.14)。

### 常驻服务实现及打包前源码验证（历史阶段）

以下实现约束继续有效；段落中的“未发行/未安装”与 0.2.11 证据目录仅描述打包前的代理验证，不否定用户后续自行安装 0.2.12 的实际状态。

- 生命周期：`sysom-idc.service` 采用 `Type=simple`、root、`Restart=on-failure`、`KillMode=control-group`；不借用 confmon 的 shell/配置采集功能，不恢复 confscan。deb 携带独立 unit 和 runner，固定部署在 `/etc/systemd/system/sysom-idc.service` 与应用资源目录；不安装全局 sysak。
- 安装授权：仅接受 `SYSOM_IDC_UID`、`SUDO_UID` 或升级时既有安全 `/etc/sysom-idc/allowed-uid`。UID 范围 1–4294967294，必须对应现存非 root 主 GID 账户；明确指定新 UID 才替换授权，不猜测图形登录用户。授权文件 root:root 0644，目录 0755。安装前拒绝资源与祖先的 symlink、非 root ownership、group/other write，全部预检后才规范化模式。无授权不启用；无运行中的 systemd 不回退。正常升级保留授权并重启；remove 停用服务和移除本产品 unit，purge 才移除授权文件，旧 postrm upgrade 不干扰新版本。
- 一次安装：新服务包生成后可执行 `sudo env SYSOM_IDC_UID="$(id -u)" dpkg -i <新服务包.deb>`。后续桌面/IDE 均普通权限，经固定 Unix socket 调用，不弹 sudo/pkexec，不加免密规则或重新登录用户组。VSIX/AppImage 不安装系统服务，依赖该固定可信安装；冻结 0.2.11 包不含此增量。
- 调用者：服务在读取 JSON 前验证 `SO_PEERCRED`、peer pidfd、四项 UID/GID、CapInh/CapPrm/CapEff/CapAmb 为零及 PID/starttime；合法非零 CapBnd 仅为 capability 上限，不表示已获权限。只有安装授权用户可连接调用，root/其他用户 peer 均拒绝；目标用户范围与调用者权限分开。
- 协议：每连接一个 UTF-8 JSON 行，线长度至多 65536 字节，键严格为 `{schema_version,args,stdin,deadline,manifest_sha256}`。argv 仅 `idc --profile resources|inspection --request-id UUID -o -` 或 `idc --process-action check|terminate`；采集 stdin 为空，动作 stdin 仅 `{manager_pid,targets}`，manager 必须等于 peer PID。回包为 16 KiB 解码上限的 base64 stdout/stderr 帧和固定退出码；无用户 env、UID、路径、shell 或任意信号。manifest 摘要与全文件 hash 再核验；服务清空环境，只重建固定 PATH/LANG/no-bytecode 和服务核实的三项 peer 环境变量。
- 有界执行：采集/动作总期限 35/15 秒，root watchdog 最多 30/10 秒，验证后按剩余时间缩短并预留 1 秒；stdout 8 MiB、stderr 1 MiB、最多 4 个接收线程，实际执行串行且忙时拒绝。请求头 5 秒超时；断连、peer 退出、暂停或服务停止只回收本次 collector 进程组，TERM 后至多 1 秒 KILL，reap 也按剩余期限限时；无法回收时停止接单并非零退出，交由本 unit 生命周期收尾，不继续对已失去所有权的数字进程组发信号。sysAK dispatcher 仅 IDC 分支关闭旧数字进程组转发，保留同一 broker 进程组并传递真实退出状态；其他原生工具与 memgraph 源码不变。IDC 内部固定命令也增量读取并分别限额：诊断 stdout 8 MiB、普通命令 stdout 64 KiB、stderr 1 MiB；超额只多读 1 字节即返回明确 truncated，不缓存或导出 stderr。内部子进程保持 broker 进程组，仅回收 owned child，reap 最多 250 ms 且不得延长全局采集期限；不对清理目标发 KILL。
- 进程清理：经服务认证的 root IDC 允许其他用户和 root 的非关键进程，不再限定目标属于授权 UID，也不因目标已有 capabilities 单独拒绝。保护 PID 1、PPid=2/PF_KTHREAD 内核线程、关键名称、system.slice、实际系统/用户 `.service`、服务/manager 祖先及 manager 子树。仅能确认 systemd `user.slice` + `.scope` 的目标可继续；`user@UID.service` 只是用户分组祖先，可包含合法桌面 app scope，不因此拒绝所有 GUI 应用。未知 scope、混合凭据、凭据或 cgroup 变化拒绝；PID/starttime、pidfd SIGTERM、二次确认、revision 绑定 60 秒一次性 token 和强制刷新保持。直接非服务普通 CLI 仍保留其 own-user 边界，不是应用回退路径。
- 环境前提：运行中的 systemd、系统 Python 3 提供 `os.pidfd_open` 和 `signal.pidfd_send_signal`（通常 3.9+）、可用 Linux pidfd（通常内核 5.3+，发行版回移另验），且 procfs/cgroup 可核实。安装前和 daemon 绑定 socket 前都预检自身 pidfd_open；缺支持会阻止全部服务采集，而不仅是进程清理；清理目标不降级到数字 PID 信号。本机 6.8 的普通用户 pidfd_open 可用，不等于 root 服务已实装。当前仅 dispatcher 单独本机编译的开发 ELF 还要求 GLIBC_2.34；其他发行版需选择匹配构建基线再验收，不能按冻结包的兼容性推断。
- 增量验证：最终完整 Node **1085/1085** 通过（375.303 秒，含服务 8 组/33 项 Python fixture 及安装生命周期回归）；原生 IDC/身份/dispatcher 惰性测试 **141/141** 通过（3.174 秒，含 dispatcher 2 项，不运行 disposable 真实信号集成用例）。最终桌面 build、插件 typecheck/build 均 exit 0；23 必需文件及 manifest 在桌面/插件逐字节一致，IDC 与最终 native 源码一致，dispatcher 与本轮单独编译 ELF 一致。最新 Chrome Webview **7 项**和隔离 VS Code 1.145.2 **4 项**服务 unavailable 验收通过，无扩展 host 子进程/信号/外部 Webview 请求；IDE 自身后台 CDN/Marketplace 请求另行阻断，不宣称整个 IDE 没有背景联网。证据目录分别为 `sysagent-analysis/tests/output/ide-webview-v0211-root-unavailable-nD9nAg`、`sysagent-analysis/tests/output/ide-vscode-v0.2.11-root-unavailable-VCg4mw`。unit 静态 verify、shell/JS/Python 语法及 git diff --check 通过；systemd-analyze 的其他预装 unit 告警未修改。冻结 0.2.11 三包 SHA256 全部复核成功，未改包或历史结果。
- 证据边界：跨用户/root 清理只由惰性 procfs/pidfd/signal fixture 验证；本次没有 root 实装、真实成功采集、系统/用户 IDE 安装、新发行打包、生产进程信号、上传、commit 或 push。开发浏览器可能显示预期 503；不能把 unavailable 分支通过当成服务黄金路径或零控制台错误证明。

## 目录

1. [目标、范围与设计约束](#1-目标范围与设计约束)
2. [当前实现与完成度](#2-当前实现与完成度)
3. [整体架构与职责](#3-整体架构与职责)
4. [本地 sysAK 采集设计](#4-本地-sysak-采集设计)
5. [数据模型](#5-数据模型)
6. [当前本地接口与 IPC](#6-当前本地接口与-ipc)
7. [当前本机 OpenAPI v1](#7-当前本机-openapi-v1)
8. [状态机、时序与一致性](#8-状态机时序与一致性)
9. [前端交互设计](#9-前端交互设计)
10. [下一阶段远端 OpenAPI 设计](#10-下一阶段远端-openapi-设计)
11. [真实指标解析与诊断设计](#11-真实指标解析与诊断设计)
12. [Agent、Session、历史与告警对接](#12-agentsession历史与告警对接)
13. [真实清理与优化闭环](#13-真实清理与优化闭环)
14. [安全、隐私与生命周期](#14-安全隐私与生命周期)
15. [开发分期与模块改造清单](#15-开发分期与模块改造清单)
16. [测试与验收](#16-测试与验收)
17. [风险、待定事项与交付依据](#17-风险待定事项与交付依据)

## 1. 目标、范围与设计约束

### 1.1 产品目标

SysAgent 管家保持现有 Demo 的页面结构和小管家视觉，由本地 sysAK 获取设备原始证据，提交 OpenAPI，使用返回的结构化展示数据呈现系统资源、体检结论、优化建议和报告。

数据处理分为三层：

1. 采集层负责获取原始系统接口及固定 argv 诊断结果；原生 memgraph 不属于 proc-only/read-only 安全边界。
2. 解析层负责统计口径、指标计算、规则判断和建议生成。
3. 展示层负责用户交互、状态展示和报告，不执行任意命令。

当前阶段将实际 sysAK IDC 证据解析为 SystemResources 真实值和有界进程排行；根目录与 FD 使用 `resource_anomaly --idc`，内存直接使用原生 `memgraph.py --graph --jsonstdout`。桌面、开发网页和 IDE host 统一由 `electron/sysak-root.cjs` 启动已安装的固定 root helper；普通 Electron/IDE 保持普通权限。进程 check/terminate 也运行于 root，但目标仍仅限 pkexec 原调用用户的 ordinary 非受保护进程，用户没有授权结束 root/其他用户目标。名称白名单仅为 Agent 启发式标签，不提供 Session 归属。远端认证、持久化、Session/文件清理和完整修复另行设计；两个开发 bundle 已校验，0.2.11 deb/AppImage/VSIX 已构建；本地归档及桌面、Chrome、真实 IDE unavailable 验收通过。root 真实安装/授权黄金路径未验收，当前回归及冻结历史分别见 16.1、17.4。

### 1.2 明确的功能边界

| 项目 | 范围约束 |
| --- | --- |
| 本机资源与体检 | 实际资源值、有界进程排行，根目录/FD 为 IDC 元数据诊断，内存为原生 memgraph（非 proc-only/read-only profile）；所有应用发起 sysAK 均经固定 root helper；专用本机进程 API 仅确认 SIGTERM 原调用用户 ordinary 非受保护进程 |
| SysAgent 配置扫描 | confscan 从当前 SysAgent 集成中彻底移除；无页面、按钮、客户端/OpenAPI 操作、内部体检调用或配置采集依赖 |
| raw 配置容器 | `configuration: {}` 仅暂留 API envelope 兼容字段，不表示存在配置 profile、证据采集或 confscan 能力；历史交付中的配置证据不外推到当前源码 |
| 清理、优化、Session 清理 | OpenAPI 及旧 operations 路径仍拒绝遗留写操作，返回 409 read_only；新增本机 prepare/execute 路径仅确认结束整个合规进程，不清理 Session/文件/FD、不改参数或自动修复；离线 HTML 仅模拟 |
| 云端解析 | 当前没有实际远端接入或外部上传；外层 mode=mock 仅表示本机回环部署，非模拟指标 |
| 远端命令 | 不接受任意 shell、脚本、命令字符串或任意路径下发 |
| 平台 | Linux x86_64 当前源码原生 UI 与依赖 pidfd 的本机确认 SIGTERM 已验证（仅 本次测试自行创建的临时进程，见 16.1）；更多发行版/容器/权限/硬件组合待验收，GPU 跨平台检测不等于 sysAK 支持 Windows/macOS |
| 安装 | sysAK 为应用私有组件；root 执行必须有固定 `/opt/SysAgent管家/resources/` 下 root-owned helper/bundle 与匹配本地 manifest，不运行用户可写/AppImage 临时目录/插件 dist 代码为 root；不安装全局 sysak、不建 systemd 服务、不设 sysak setuid、不加 polkit passwordless policy；本阶段未实际安装或系统授权 |
| 旧 FastAPI 后端 | 当前未接入主链路；是否复用属于后续后端实现选择 |
| OSS 上传 | 当前未实现；仅在将来确有大体积诊断产物需求时单独设计 |

### 1.3 文档标识规则

- **已实现（源码）**：源码或契约已具备该能力；**已验证**须限定到第 16.1 节的实际测试/运行场景，不等于所有 UI、环境或安装包均已通过。
- **模拟**：独立离线 Demo 或尚未接入的专项样本，不作为 collected 证据。
- **规划**：本文件提出的后续设计，尚未写入现有契约或代码。
- **待定/待验证**：仍需决策或验收，不能视为已选定或已通过。

当前 v1 外层 `mode=mock` 是部署兼容标识；展示 `state.mode=collected`、`task.simulated=false` 表示实际证据解析。采集 capabilities、CollectorStatus 和 OpenAPI 的 `read_only=true` 是保留的协议/业务写操作边界，不因专用本机进程 API 而修改；**不能据此声称原生 memgraph 是 proc-only/read-only、安全 profile，或整个应用没有本地执行能力。** 远端没有进程执行授权，异步任务与远端执行协议仍需独立协商/版本化。16.1 将 root/原生阶段、pre-root 只读调查及源码回归、冻结 0.2.10/0.2.9 历史分别登记；历史通过不外推为 root 安装/授权黄金路径或全部环境验收。

## 2. 当前实现与完成度

### 2.1 当前链路

```text
前端操作 / 快照请求
  → 桌面 IPC 或 Vite 本地 HTTP
  → IDC 控制器
  → sysak-root.cjs → 固定 pkexec/helper → 已安装 root sysak idc
  → 原始 JSON（内存诊断原生 memgraph 只导出 graph counters，coverage 未知）
  → 本机回环 OpenAPI HTTP 提交（外层 mode=mock）
  → collected-state.ts 解析实际资源与固定诊断证据
  → HealthState(mode=collected) + 回执 + 同步任务(simulated=false)
  → 控制器依据本次 raw 身份 + 新鲜 sysAK check 覆盖本机 cleanable
  → 前端整体刷新（当前选择/筛选/确认执行及强制资源刷新已通过原生 UI 指定场景，见 16.1）

本机进程选择（独立于 OpenAPI 写操作）
  → prepare(resource,ids,revision) → sysAK check → 60 秒单次 token
  → 用户确认 / 取消
  → execute(token) → sysAK terminate(pidfd SIGTERM) → 分进程结果
  → 强制重新采集整体资源；结果不明或刷新失败时阻止重复操作
```

服务不再从 Demo 生成资源值：CPU、内存、根文件系统、GPU 设备遥测、可用时的 CPU package RAPL 功率及 CPU/RSS/I/O 进程排行来自实际证据。总量独立计算，不求和排行；缺失百分比为 `null`，缺失排行为空，不补 Demo 或 0。CPU/内存/disk 各保留 overallTop20 与 AgentTop20 的去重并集（最多 40 行），UI 先筛选再取 Top10。根目录/FD 解析独立 IDC 元数据报告，内存解析原生 graph/partial/未知覆盖，不称原生为安全 profile；FD 将执行覆盖与健康结论分开。控制器本地预检/确认执行已实现，但不信任 OpenAPI 的可清理标志；真实性能时间序列历史、Session 归属和专项探针仍未实现；本机进程结果 history 已在当前原生 UI 验证保留（16.1），Agent 名称标签不等于可信业务归属。

### 2.2 完成度矩阵

下表原有能力的“已验证/通过”仅对应 pre-root 源码或 0.2.10/更早交付证据（16.1）；本阶段归档及 unavailable 验收明确单列，不外推历史 UI 或 root 黄金路径。当前两个开发 bundle 已校验，0.2.11 deb/AppImage/VSIX 已构建，本地归档及桌面、Chrome、真实 IDE unavailable 验收通过；未安装匹配 root 组件时采集不可用而不普通回退。

| 能力 | 当前状态 | 主要缺口 |
| --- | --- | --- |
| sysAK IDC 命令 | 双样本与固定 argv 诊断；应用调用统一 root，内存原生 `--graph --jsonstdout`，过滤输出为 native/partial/覆盖未知；本阶段 Python 回归见 16.1 | 真实 root 安装/管理员授权黄金路径及更多权限/容器/驱动待验收 |
| 本地执行桥接 | 已实现并通过 Electron 实际 harness，支持持久化巡检周期与本地定时调度 | 远端客户端接入、启停持久化、授权策略 |
| 巡检配置 | Electron 已验证默认 5 分钟、配置 90 分钟及持久化、暂停/恢复、紧凑卡片与无首页横幅 | 浏览器其余/移动端场景、启停持久化、真实远端状态与授权联动 |
| JSON 提交与回执 | 本机回环已验证实际 IDC→OpenAPI，state=collected、simulated=false | 远端 HTTPS、认证、断网与可恢复提交 |
| 系统资源总览 | 真实 CPU/内存/根容量链路已实测；本环境 GPU/能耗不可用，不补值 | null/W/B/s 等其余 UI 场景、更多环境覆盖 |
| 资源排行 | overallTop20+AgentTop20 去重并集（≤40/资源），先过滤再 Top10；当前原生 UI 已验证全部程序/Agent 过滤与临时 codex 可选，不默认勾选（16.1） | 仅有界可见进程，无可信 Session 归属或文件清单；更多 UI/环境待验收 |
| 体检与报告 | FD execution=complete/partial/unavailable 回归已通过；真实 partial/unchecked 卡片与详情、来源及非泄漏趋势说明已验证（16.1） | 更多失败/UI/环境场景待验收；评分仍兼容公式，不是泄漏趋势诊断 |
| 清理与优化 | 完整测试及 0.2.9 解包 deb 原生 UI 确认/取消、旧 token 撤销、仅本次测试自建进程 pidfd SIGTERM、逐项结果/强制刷新/history 已通过；OpenAPI/旧 operations 继续 read_only（16.1） | 错误/断网/未知执行/刷新失败仅单测覆盖；未结束生产进程；Session/文件清理和自动修复未实现 |
| Agent/Session | comm 精确白名单与筛选回归、临时 codex 原生 UI 可选已验证（16.1）；可信 Agent 探针和 Session 延期 | 标签可能漏识别；无会话状态/Token/业务或文件关联，不把 node/python 全部判 Agent |
| 性能历史 | 未接入真实时间序列；当前原生 UI 已验证性能页不伪造历史（16.1），离线样本独立 | 连续采样、历史存储仍未实现；不与已保留的本机进程结果 history 混淆 |
| 设备管理 | 本机快照联动，远端设备仍未接入 | 真实远端设备注册、在线状态、逐设备结果 |
| GPU 详情 | 无硬件与未知/不可读的区别已实现并测试，浏览器未知标签已验证；逐卡 CSV 解析存在，专项详情未全部接入 | 更多硬件型号/驱动实测；无 GPU 进程利用率/Session 归属，故障及厂商扩展 |
| 日志分析、部署页面 | 演示为主，不从当前快照伪造真实诊断 | 对应采集器、后端分析和独立任务能力 |
| 告警与悬浮小管家 | 摘要与演示展示存在；collected 禁止 alert-sample 改值 | 真实持续条件、恢复、通知生命周期 |
| 打包与组件校验 | 版本及两个开发 bundle 校验通过；0.2.11 deb/AppImage/VSIX 已构建；本地归档及桌面、Chrome、真实 IDE unavailable 验收通过。三个命令、18 模块（原生 Makefile 16 + resource_anomaly 2）、dispatcher 与规则，共 23 必需文件及 manifest；独立 root helper 为额外安装资源，不含 confscan/配置 JSON | 最终解包 VSIX 在隔离 VS Code 1.145.2 的 unavailable 验收通过；发行 JSON/SHA 已生成并核验；未实际安装；23/24 文件及本地/installed manifest 校验不等于 root 黄金路径通过；冻结 28 文件包不改（16.1、17.4） |

### 2.3 已知遗留与限制

1. 前端首次初始化获取当前快照，不再调用 reset；控制器无缓存时执行一次 resources 采集。
2. 采集启停状态只在控制器内存中，应用重启默认启用；巡检周期已持久化，但尚无云端上传授权状态。
3. 回环服务的 collected 设备状态、结果和任务只在内存中，退出后清空；设备 UUID 和巡检周期在桌面端持久化。同一服务生命周期 revision 单调；跨服务重启的持久版本恢复仍待设计。
4. 前端每 1.5 秒只读取缓存，周期巡检默认 5 分钟，可设置 1–1440 整数分钟；手动刷新显式采集，页面轮询不执行 sysAK。
5. 当前服务端任务同步返回 `completed`，不存在异步执行、任务取消或任务进度接口。
6. 控制器只提交 `/collections`；能力、设备快照、任务查询虽已在 Mock 实现，客户端还没有完整消费流程。
7. 资源 `usage` 为 `number|null`，提供 source/status/note/quantity/rankUnit；行新增可选 starttime/agentKind，本机 cleanable 经 raw 身份与新鲜 sysAK check 覆盖。当前进程选择/Agent 筛选与真实 FD partial 文案已通过原生 UI 指定场景，完整测试与剩余边界见第 16.1 节；无可信 Session 归属，GPU 未知标签的既有记录仍属历史。不可使用 `?? 0` 或 Demo 值掩盖缺失。
8. collected 无“系统与配置”项；confscan 不再作为内部 evidence 或采集依赖，raw `configuration: {}` 仅为容器。当前白名单为 23 必需组件及 manifest，18 模块是原生 memgraph Makefile 16 + resource_anomaly 2，不是 UI 项或新增命令数；见 14.3。confscan 三处修改独立 stash；原生 memgraph 7 路径修改 stash 为 `13bca2d4e2994a4274b103ad89aca0ee0fb40e05`，恢复 HEAD 后 native 目录 git diff 为 0。适配在 IDC/管家侧，不改 legacy 全量构建语义。两端开发 bundle 已校验，0.2.11 三包已构建、本地归档及桌面、Chrome、真实 IDE unavailable 验收通过，未实际安装；历史包清单/哈希/验收不改（16.1、17.4）。
9. root helper/bundle 必须先由受控系统安装提供且与本地 manifest 匹配；开发目录、AppImage 临时资源、插件 dist 只用于本地版本/哈希核对，绝不被 pkexec 作为 root 代码执行。缺安装或拒绝授权时不可用，不普通回退；普通进程取消不保证立即杀死 root collector，丢弃结果并由 root watchdog 有界收尾。
10. 现有开发说明部分仍描述旧版离线 API、`/api/demo` 和 0.2.6 行为；当前链路以本文件及源码为准，后续同步修订旧说明。

## 3. 整体架构与职责

### 3.1 当前部署拓扑

```text
Linux 本机
├─ SysAgent Electron
│  ├─ 主渲染进程：健康快照、页面、用户操作
│  ├─ 悬浮窗口：接收摘要，不建立第二份采集模型
│  ├─ preload：有限 IPC 能力
│  └─ 主进程：可信来源校验、设备 UUID、IDC 控制器
├─ 普通权限 IDC controller / IDE host
│  └─ sysak-root.cjs：核对本地 manifest 与固定 root 安装，调用 pkexec
├─ /opt/SysAgent管家/resources/（root-owned，非用户可写）
│  ├─ sysak-root-runner.py：身份/路径/hash/期限验证、清空 env、root watchdog
│  └─ sysak 私有 bundle
│     ├─ sysak / idc 采集及独立 --process-action check/terminate
│     ├─ resource_anomaly --idc / 原生 memgraph --graph --jsonstdout
│     └─ 18 模块；23 必需组件 + manifest 共 24 文件，无 confscan/配置目录
└─ 本机 OpenAPI（外层 mode=mock）
   └─ 127.0.0.1 临时端口、私有 Bearer token、内存 collected 展示状态
```

开发网页版由 Vite 中间件提供 `/api/idc`，同样调用 IDC 控制器和本机 Mock；其中 process-prepare/process-execute 独立在本机执行预检/确认动作，不经 OpenAPI 写操作。浏览器本身不获得 shell 执行权，桌面进程动作只接受可信主窗口主 frame 的专用 IPC。

单文件离线 HTML 通过构建别名使用 `standalone-api.ts`，仅操作离线模拟数据，不尝试启动本地采集或访问远端服务。

### 3.2 目标远端拓扑（规划）

```text
SysAgent 页面
  → 本地可信 IPC
  → 采集调度 / 远端 API 客户端
  → sysAK 原始采集
  → 上传授权与数据过滤
  → HTTPS OpenAPI 网关
  → 鉴权与设备归属校验
  → 解析器 / 诊断规则 / 任务协调
  → 持久化展示快照与任务结果
  → 展示模型返回 / 任务查询
  → 前端渲染
```

当前源码已具备独立本机进程白名单执行链路（process-control.cjs→sysAK process API）；目标远端计划/授权/回执协议仍属规划。远端将来只能返回结构化计划，不能绕过本地确认和执行前校验，也不能据本机能力打开旧 OpenAPI 写操作。

### 3.3 模块职责

| 模块 | 职责 | 禁止或不承担的职责 |
| --- | --- | --- |
| 前端 | 读展示模型、提交对象 ID、显示状态、确认操作 | 不读原始凭据，不执行 shell，不自行推断文件可删除 |
| preload / IPC | 暴露有限方法，将请求交给可信主进程 | 不提供通用 IPC 调用或任意命令接口 |
| IDC 控制器 | 组件校验、串行采集/提交/缓存；raw 身份交集与本机 check 标注；prepare token、执行互斥及本地结果记录 | 不信任远端 cleanable，不把 Demo 变换当效果，不让远端或 renderer 直接指定 PID/路径/信号 |
| sysAK IDC / root 桥接 | resources/inspection 与独立 check/terminate 均走固定 root helper；原生 memgraph 输出过滤、native 覆盖未知；进程校验仍限制原 caller ordinary UID 与 pidfd SIGTERM | 协议 read_only 保留但不是原生工具的安全 profile；不提权 Electron/IDE，不执行用户可写代码为 root，不普通回退，不结束 root/其他用户目标，不做目标 SIGKILL/数字 PID kill/Session/文件/FD 清理 |
| OpenAPI 网关 | 认证、版本、限额、幂等、设备归属、错误语义 | 不因为上传了 `device_id` 就认定设备身份可信 |
| 解析与诊断 | 单位、范围、指标差分、规则、建议、证据关联 | 不从缺失数据生成正常结论，不凭 PID 或名称判定可回收 |
| 任务服务 | 任务与结果生命周期、版本推进、状态查询 | 不把 HTTP 接收成功等同于真实处置成功 |
| process-control.cjs / sysAK 进程 API（已实现源码） | 固定 argv、JSON stdin、分进程校验/结果；仅 pidfd SIGTERM，UI 执行后强制资源刷新 | 不承诺 exited/freed，不接受远端任意命令；完整修复、远端执行回执与效果复检仍规划 |

## 4. 本地 sysAK 采集设计

### 4.1 调用协议

当前桌面、开发网页和 IDE 统一调用 `electron/sysak-root.cjs`，固定外层执行形式为：

```text
/usr/bin/pkexec --disable-internal-agent /opt/SysAgent管家/resources/sysak-root-runner.py <deadlineUnixMs> <sysakArgs>
```

`<sysakArgs>` 的采集参数仍固定为下列之一，真正执行的 dispatcher 仅为 `/opt/SysAgent管家/resources/sysak/sysak`，不把本地 `binary` 路径传给 pkexec：

```text
idc --profile resources --request-id <UUID> -o -
idc --profile inspection --request-id <UUID> -o -
```

期限由普通 host 在启动 pkexec 前生成（采集 35 秒、进程动作 15 秒，包含授权等待），不是 renderer 可传参数。`--disable-internal-agent` 不提供终端授权回退；缺系统授权 agent、拒绝或取消授权均失败，不以 ordinary sysAK 回退。

sysAK CLI 还提供 `--sample-ms`，默认 200 毫秒，允许 20～1000 毫秒；管家未将该参数开放给前端。该值是请求的采样等待，不是实际进程/RAPL 差分分母：扫描本身耗时，必须使用样本内实际 monotonic 时间差。

当前 IDC CLI 移除 `configuration` profile，仅保留 `resources/inspection`；SysAgent 与 OpenAPI 均不提供配置扫描业务操作。raw envelope 可暂留空 `configuration: {}` 容器，但不能据此恢复配置采集。

### 4.2 采集内容

| 证据 | 来源或命令 | 当前行为 |
| --- | --- | --- |
| CPU | `/proc/stat` | 两次原始采样 |
| 磁盘 I/O | `/proc/diskstats` | 两次原始采样，不做吞吐解析 |
| 网络计数 | `/proc/net/dev` | 两次原始采样，不等于完整网络诊断 |
| 内存、负载、运行时长 | `/proc/meminfo`、`loadavg`、`uptime`、`vmstat` | 原始文本 |
| PSI | `/proc/pressure/{cpu,memory,io}` | 压力证据 |
| FD | `/proc/sys/fs/file-nr`、`file-max` | 整体 FD 证据，不证明某个 FD 可关闭 |
| 当前作用域 | 当前 namespace、`self/cgroup`、cgroup2 挂载 | 标注 procfs 视图与当前进程 cgroup |
| cgroup v2 | CPU、内存、PID、I/O 等固定文件 | 当前进程所属 cgroup，不代表所有 Agent |
| 根文件系统 | `statvfs` | 容量、空闲、可用、inode 原始字段 |
| 进程 | `/proc/[pid]/{stat,status,io}` 白名单字段 | 两次结构化样本，PID+starttime、utime/stime、RSS bytes、read/write bytes、clock_ticks/page_size、实际 monotonic 时间及覆盖状态；最多 4096 个，不读 cmdline/environ |
| CPU 数量 | `/proc/stat` 的 per-CPU 行 | 作为可见整机 CPU 容量分母，不用排行行数或 Session 数量代替 |
| GPU | 固定 `nvidia-smi` CSV 查询 | 名称、UUID、利用率、显存、功耗、温度；逐设备解析，无 GPU 进程利用率或 Agent/Session 归属 |
| 能耗 | powercap package `energy_uj`/`max_energy_range_uj` | 两次实际 monotonic 样本，最多 32 个不重叠 package 域；可用时计算平均 W，不累加子域/psys |
| 根目录/FD 诊断 | 固定 `resource_anomaly --idc` | 根容量和目录分配字节下界；可见 PID FD 数/soft limit；仅元数据，不读配置、environ、socket 或 FD 目标 |
| 内存诊断 | IDC 直接执行固定原生 `memgraph.py --graph --jsonstdout` | root 执行；原生入口无 `--idc`，默认 memcgLeak/memfrag/thpCollect 与依赖/额外扫描保留，非 proc-only/read-only；仅导出过滤后的 graph counters，status=partial、native 插件覆盖未知 |
| 失败服务 | `systemctl --failed` | 固定只读结果 |
| 日志占用与 printk | `journalctl --disk-usage`、`/proc/sys/kernel/printk` | 不等于 Debug 采样率、错误日志语义或日志安全清理计划 |
| Agent 诊断 | 应用集成占位 | 标记不可用，等待 Agent 探针对接 |

`resources` 执行资源采集；`inspection` 增加 resource_anomaly IDC 报告、原生 memgraph 报告与非配置证据，不再调用 confscan。IDC 仅在固定 bundle 位置解析 Python 入口，以 `[sys.executable, '-B', 固定入口, 固定诊断参数]`、`shell=false` 直接执行；原生 memgraph 不经 `memgraph_idc.py`。缺组件、无权限、超时、JSON/容量非法时标记不可用/失败，不普通回退，也不伪造完整覆盖。

resource_anomaly 仍要求 `mode=idc/read_only=true`；原生 memgraph JSON 则要求 `version=2.0`、合法 `memgraph.total/avaliable`，且不含伪造的 `mode/read_only`。IDC 只保留有限非负 graph counters，转换为 `version=2.0/mode=native/tool=memgraph/unit=KiB/status=partial` 与 `coverage.native_plugin_coverage_unknown=true`，不导出其他原生插件结果/私有文本。**输出过滤不是执行范围限制：原生默认插件与额外扫描保留，不能称为 proc-only/read-only 或安全 profile。** 固定 argv 不包含 `--json=<path>`，但不承诺原生插件无内部副作用；manifest 历史字段 `safe_profiles` 仅记录 argv（resource_anomaly `['--idc']`、memgraph `['--graph','--jsonstdout']`），不是安全/覆盖声明。远端启用前仍须独立落实上传最小化与脱敏。

### 4.3 范围与完整性

- procfs 可能包含宿主范围计数，namespace 与 cgroup 证据必须参与解析。
- 不将容器内观察到的指标自动标记为整台物理宿主机指标。
- 进程每次扫描最多 4096 个 PID、16384 个目录条目、2 秒；有界 PID 视图按数值排序，不声称已找出全机 Top4096。解析器按有效 CPU/RSS/I/O 值排序，各保留 overallTop20 与 AgentTop20 去重并集（≤40 行），UI 在全部程序/只看 Agent 过滤后重新排序并取 Top10；截断、权限拒绝、消失进程保留覆盖说明。
- package RAPL 每次扫描最多 32 域、1 秒，双样本按路径配对；范围缺失或回绕不合法不能生成虚假功率。
- `resource_anomaly --idc`：根目录扫描 1.5 秒、20000 条目、深度 4、Top10，跳过 proc/sys/dev、跨文件系统及符号链接；同 inode 去重，仅已扫描分配字节下界。FD 扫描 1.5 秒、最多 4096 PID/每 PID MAX_FDS=8192；额外读取一个目录条目区分恰好 8192（完整）与超限（截断），超限不把计数下界当精确值。仅计数并读固定 comm/Max open files，不解析 FD 链接或 socket。
- 原生 `memgraph.py --graph --jsonstdout`：保留原生默认插件/依赖和额外扫描，不沿用旧 IDC 64 KiB meminfo/纯分析边界。两个诊断子调用仍各最多 5 秒、返回报告预算 8 MiB，并受 IDC 总采集剩余时间与 root watchdog 约束；合法 graph 只证明有限内存压力数据，插件失败可被原生插件系统吞掉，因此必须 partial/coverage unknown。
- 单个普通文件/普通命令内容上限 64 KiB，整体 JSON 输出上限 8 MiB；不再保留 confscan 子命令、独立报告预算或配置扫描超时。
- 整体超限时优先截断大证据，保留来源、原状态、省略大小与原因；展示必须保留部分采集语义，不为缺失项补数。
- 不输出子命令 stderr 内容作为原始证据，避免私有错误信息外泄。

### 4.4 执行约束

- 外层固定 `/usr/bin/pkexec --disable-internal-agent` 与固定 helper，`cwd='/'`、`shell=false`，仅传 PATH=`/usr/bin:/bin`、LANG=`C.UTF-8`；不提升 Electron/IDE 本身权限。
- 启动前验证 pkexec、helper、installed manifest 及全部 bundle 文件的逐祖先路径：拒绝 symlink、非 root owner、group/other writable、非目录祖先/非普通文件；本地与 installed manifest 的 schema/platform/arch/commands/文件集合及逐文件 SHA256 必须一致。helper 自身由 root-owned 固定安装路径保护，不作为本地可写 bundle 代码执行。
- helper 为 `/usr/bin/python3 -I` 入口，要求 `getresuid/getresgid=(0,0,0)`；原 caller UID 仅由 pkexec 的 `PKEXEC_UID` 提供且须为合法非零普通 UID，不接受 stdin/argv 自选 UID。helper 再验证自身、installed manifest/全部文件 hash 和 `/usr/bin/timeout` 的可信路径。
- helper 清空 env，仅重建 PATH、LANG、`PYTHONDONTWRITEBYTECODE=1`、`PKEXEC_UID`；不继承应用凭据、PYTHONPATH、LD_PRELOAD 等。
- 授权等待包含在采集 35 秒/进程动作 15 秒绝对 Unix 毫秒期限内。helper 在验证前检查期限，在哈希验证后、exec 前再检查并预留 1 秒，拒绝晚授权执行；剩余预算不足时不启动 sysAK。
- root `/usr/bin/timeout --signal=TERM --kill-after=1s` watchdog：采集最多 30 秒、进程动作最多 10 秒，实际运行时限取与 `deadline−now−1s` 的较小值。随后 SIGKILL 只用于收尾本次 collector/helper 执行树，不是目标业务进程 SIGKILL。
- 暂停/退出/超限/超时会取消本地请求并尝试停止自有进程组；普通进程可能因 EPERM 无法立即杀死 root collector，必须丢弃结果、等待 root watchdog 有界收尾，不宣称立即取消成功。已发给目标的 SIGTERM 不可撤回。
- 缺 root 安装、版本/hash 不一致、Python 3 不可用、授权取消/拒绝或 JSON 异常均 fail closed，不提交伪造证据，不执行用户可写/AppImage 临时/插件 dist 代码为 root，不自动 ordinary fallback。未加入 polkit passwordless policy，未实际系统安装/授权/发布。

### 4.5 独立 sysAK 进程 API（root 源码阶段；历史 UI 与本阶段回归分列于 16.1）

`electron/process-control.cjs` 复用 `spawnRootSysak`，sysAK 参数严格为 `['idc', '--process-action', 'check' | 'terminate']`，通过相同固定 pkexec/helper 以 root 执行，不与 `--profile`、`-o` 或采集参数混用。stdin 仍为 JSON `{manager_pid: 普通权限控制器所在进程的 PID, targets: [{pid,starttime}]}`，manager 不是 root helper PID，必须是 helper 的 genuine ancestor 且为 pkexec 原 caller 的 ordinary 进程；不接受命令、路径、自选 UID 或信号。stdout 为 `{schema_version:'1.0',action,results}`；桥接逐项验证身份、顺序、数量、状态及 eligible 一致性，丢弃 stderr。root 执行只扩展采集读取权限，**不扩展允许结束的用户范围**。

- sysAK 输入最多 16 KiB、check 最多 100 个目标、terminate 最多 10 个，拒绝重复 PID、重复 JSON key、额外字段和非法整数；stdin 必须在总动作预算 5 秒内 EOF。
- 固定读取 `/proc/<pid>/{stat,status}`，单文件最多 64 KiB；总读取最多 32768 次、每目标预算 0.25 秒、每次祖先链最多 128 次 stat 读取（含二次验证）。不扫描全量 /proc、不读 cmdline/environ/目标 FD。
- manager_pid 必须是 helper 已验证祖先；保护 PID 1、manager/helper 的祖先和 manager 后代，以及桌面/系统关键进程（固定名称与系统前缀）。祖先链不可核验时拒绝，不因名称为 Agent 而放行。
- 应用调用的 sysAK runtime 为 root，real/effective/saved UID/GID 均为 0，procfs 四项 UID/GID 也验证为 0；目标 real/effective/saved/fs UID 四项仍必须等于 **pkexec 原 caller UID**，manager 也必须属于该 ordinary caller。拒绝 root/其他用户目标、混合或 root GID、非零 CapInh/CapPrm/CapEff/CapAmb；caller UID 不来自 stdin。root 授权没有授予结束其他用户或 root targets 的权限。身份、凭据、runtime 与祖先关系在信号前再次校验；独立 CLI 的 ordinary backend 不构成应用失败回退。
- 先打开 pidfd，再核验 PID+starttime 和保护策略；terminate 只调用 `pidfd_send_signal(..., SIGTERM)`，没有数字 PID kill、SIGKILL 或自动提权回退。pidfd 不支持则 unsupported。
- check 返回 eligible/protected/permission_denied/stale/gone/unsupported；terminate 将 eligible 成功项改为 signalled，其余逐项保留拒绝原因。signalled 仅表示信号发送，不证明退出或资源释放。
- Node 桥接外层 15 秒、响应最多 64 KiB；15 秒绝对期限包含授权等待，root watchdog 最多 10 秒加 1 秒 collector SIGKILL 收尾（可按剩余期限缩短）。超时/超限立即拒绝并尝试 SIGTERM 辅助进程，但普通 host 不保证能杀 root 执行树，丢弃迟到结果并由 watchdog 收尾。失败/超时可能已有部分目标 SIGTERM，按结果不明处理、强制刷新核对而不重复结束。root 授权取消/拒绝/组件失败也不 ordinary 回退；采集 capabilities 的 read_only/unsupported_actions 元数据保持兼容，不能当作原生 memgraph 执行范围声明。

## 5. 数据模型

### 5.1 原始证据模型：采集协议 1.0（已实现）

顶层字段如下：

| 字段 | 说明 |
| --- | --- |
| `schema_version` | 当前为 `1.0` |
| `request_id` | 与外层提交请求完全相同 |
| `collector` | `name=sysak`、`command=idc`、工具版本 |
| `device` | platform、machine、hostname、scope；不含应用设备 UUID |
| `collection` | profile、started_at、finished_at、duration_ms、status；资源采集含 sample_ms |
| `resources` | 资源原始证据对象 |
| `configuration` | 暂留的 API envelope 兼容容器；当前为 `{}`，不对应 CLI profile、配置扫描调用或配置证据 |
| `diagnostics` | 固定 argv 诊断证据，可为空；resource_anomaly IDC 元数据与原生 memgraph 的过滤图/partial/未知覆盖，不将后者称为只读安全 profile |
| `capabilities` | `read_only=true`，原始工具能力元数据 |

典型证据项：

```typescript
type EvidenceStatus =
  | 'ok' | 'partial' | 'unavailable' | 'permission_denied'
  | 'timeout' | 'error' | 'truncated';

interface RawEvidence {
  status: EvidenceStatus;
  source: string | { argv: string[] };
  content: unknown;
  sampled_at: string;
  reason?: string;
}
```

此定义说明通用形态；具体截断、错误、limit 等附加字段以采集器输出为准，当前 v1 对嵌套证据保持开放。不要假定所有子项都有同一种内容格式。

协议关系：

- 外层 `device_id` 是应用持久化 UUID，不从原始 `device` 对象推导。
- 采集时间读取 `collection.finished_at`，没有顶层 `collected_at` 字段。
- 总体采集状态为 `ok/partial/error`。
- `partial` 允许提交并保留完整性提示；`error` 不生成成功展示状态。

### 5.2 当前展示模型：HealthState（已实现、实际证据解析）

```typescript
type ResourceId = 'cpu' | 'energy' | 'memory' | 'disk' | 'gpu';
type SessionStatus = 'active' | 'idle' | 'completed';
type InspectionStatus = 'normal' | 'abnormal' | 'unchecked';

interface ResourceSession {
  id: string;
  name: string;
  status: SessionStatus;
  usage: number;
  cleanable: boolean;
  defaultSelected: boolean;
}

interface ResourceRow {
  id: string;
  name: string;
  detail: string;
  usage: number;
  cleanable: boolean;
  defaultSelected: boolean;
  effect: string;
  pid?: number;
  starttime?: number;
  agentKind?: string;
  quantity?: { value: number; unit: 'B' | 'B/s' | 'W' | 'count' };
  agentId?: string;
  sessions?: ResourceSession[];
}

interface ResourceSnapshot {
  id: ResourceId;
  label: string;
  usage: number | null;
  capacity: number | null;
  unit: string;
  source?: 'sysak' | 'demo';
  status?: 'available' | 'partial' | 'unavailable';
  note?: string;
  quantity?: { value: number; unit: 'B' | 'W'; total?: number; available?: number };
  rankLabel?: string;
  rankUnit?: '%' | 'B' | 'B/s' | 'W' | 'count';
  sampledAt?: string;
  rows: ResourceRow[];
}

interface Inspection {
  id: string;
  label: string;
  important: boolean;
  phase: 1 | 2;
  status: InspectionStatus;
  usage: number | null;
  detail: string;
  evidence: string[];
  execution?: 'complete' | 'partial' | 'unavailable';
}

interface Optimization {
  id: string;
  inspection: string;
  title: string;
  action: string;
  effect: string;
}

interface HealthOperation {
  id: string;
  kind: 'cleanup' | 'session-cleanup' | 'optimize' | 'inspect' | 'demo-alert';
  names: string[];
  time: string;
  revision: number;
}

interface HealthState {
  mode?: 'collected' | 'demo';
  hasGpu: boolean;
  revision: number;
  sampledAt: string;
  resources: Record<ResourceId, ResourceSnapshot>;
  inspections: Inspection[];
  optimizations: Optimization[];
  operations: HealthOperation[];
}
```

collected 返回 `mode=collected`，各资源 `source=sysak`，缺失百分比为 null；quantity 缺失不伪造 value=0。合法实测 0 仍可保留，不能与缺失混淆。`capacity` 保留兼容字段，collected 容量使用 quantity 的 bytes，不套用 Demo GB。CPU/内存/根文件系统 usage 独立于排行；disk 行 usage 是 B/s，energy 行是 W，不能按百分比渲染或用行和回写总占用。OpenAPI 原始展示行仍 `cleanable=false/defaultSelected=false`；CPU/内存/disk 进程行带可选 starttime 与启发式 agentKind，不生成 agentId/sessions。控制器把所有行先置为不可清理，再仅对本次 raw 身份匹配且新鲜 sysAK check 合格的进程覆盖本机 cleanable=true；defaultSelected 始终 false，GPU/energy 非进程对象不可结束。optimizations 为空，操作记录最多 30 条，本机进程结果通过本地记录合并，不伪造远端任务。

`hasGpu` 从证据推断，不由可选 hasGpu 提示覆盖；GPU 不可读不能等同无硬件。模型仍保留五种资源。无硬件与未知/不可读的区别已实现并测试，浏览器 GPU 未知标签已验证；更多硬件型号、驱动与页面场景仍待验收。独立 inspections 的结论时间保留在 evidence/inspect 操作中；resource-refresh 更新 sampledAt 不代表已复检。

FD 的可选 execution 表达工具执行/覆盖，而 status 仍只有 normal/abnormal/unchecked：部分执行且没有已知 >90% 异常时 `execution=partial,status=unchecked,usage=null`，UI 显示“已检查 · 结论受限”，评分和确定结论计数仍按 unchecked；若已观察到合法 >90% 则保留 abnormal。工具缺失/未安装不设置 execution；已尝试但失败设置 unavailable，不能虚构正常。详情见 11.2。

### 5.3 当前提交与回执模型（已实现）

```text
CollectionRequest
  schema_version: "1.0"
  request_id: UUID
  device_id: UUID
  operation: 当前支持的操作枚举
  parameters: 与操作匹配的参数对象
  raw_snapshot: 原始采集协议 1.0

CollectionResponse
  schema_version: "1.0"
  request_id: 原请求 UUID
  task_id: 服务端任务 UUID
  mode: "mock"
  read_only: true
  state: HealthState（mode="collected"）
  receipt:
    raw_bytes、profile、collected_at、collection_status
    collector: name，可带 version/permissions
    device: { id: 外层 device_id }
  task:
    id、status="completed"、operation
    simulated=false、read_only=true
```

外层 mode=mock 仅为回环部署标识，state.mode=collected 为证据来源模式，task.simulated=false 为实际解析任务。三者不可混为“全 Demo”。服务端返回展示和回执，不回传完整原始快照；只读请求仍能生成新展示 revision，但不执行系统写动作。

### 5.4 展示模型进一步演进（规划）

当前已支持 null、source/status/note、quantity 和排行单位；以下为远端持久化、有效期和规则可追溯性增强，不再把基础实际解析列作未来才实现的能力：

| 结构 | 规划字段或变化 |
| --- | --- |
| 展示快照 | `snapshot_id`、`schema_version`、`revision`、`sampled_at`、`valid_until`、`source_mode`、`scope`、`rule_version` |
| 指标 | `value:number|null`、`unit`、`status`、`reason`、`sample_window_ms`、`source_refs`、`measured/estimated` |
| 资源排行 | 稳定对象 ID、归属、统计范围、时间窗口、完整性和分页信息 |
| 诊断项 | `normal/abnormal/unchecked/unsupported/error`、规则版本、证据引用、原因与严重程度 |
| 建议 | 建议 ID、关联诊断、风险、前置条件、预计影响、是否允许生成处置计划 |
| 评分 | 服务端明确返回分数、计算项、覆盖率、规则版本；数据不足时分数允许不可用 |
| 操作记录 | 分离“收到请求”“解析完成”“执行完成”“效果验证”，不能合并为一个成功状态 |

资源不可用时显示“不可用/无权限/未支持”，不显示 0%；当前前端适配需逐处验收，不能对 collected 结果套用旧默认值。进一步的有效期、scope/source_refs/规则版本尚未齐备。

原始采集协议可继续使用 1.0；业务 OpenAPI 和展示协议独立版本化，不要求同时修改所有协议。

## 6. 当前本地接口与 IPC

### 6.1 前端入口

默认前端通过 `idc-client.ts` 调用：桌面优先使用 `window.sysomDesktop`；开发网页使用同源 `/api/idc`。

| 功能 | HTTP | IPC | 请求 | 返回数据 |
| --- | --- | --- | --- | --- |
| 健康快照 | `GET /api/idc/snapshot` | `health:snapshot` | 可选查询 refresh=true/false，IPC 接收 boolean，默认 false；true 执行 resources，false 只读缓存（无缓存时初始化） | HealthState |
| 重新初始化展示 | `POST /api/idc/reset` | `health:reset` | `{hasGpu?:boolean}`；重新 resources 采集，清远端检查/记录但不降 revision；本机进程操作记录仍合并，非系统重置 | HealthState |
| 操作 | `POST /api/idc/operations` | `health:operation` | `{operation,parameters}`；collected 仅允许 inspect，写操作 409 read_only | HealthState |
| 采集状态 | `GET /api/idc/status` | `collector:status` | 无 | CollectorStatus |
| 启停 | `POST /api/idc/enabled` | `collector:enabled` | HTTP `{enabled:boolean}`；IPC boolean | CollectorStatus |
| 巡检周期 | `POST /api/idc/interval` | `collector:interval` | HTTP `{inspection_interval_minutes:number}`；IPC 整数分钟，范围 1–1440 | CollectorStatus |
| 本机进程准备 | `POST /api/idc/process-prepare` | `process:prepare-cleanup` | `{resource:'cpu'|'memory'|'disk',ids:string[],revision:number}`，1–10 个唯一 ID | ProcessCleanupPlan |
| 本机进程执行 | `POST /api/idc/process-execute` | `process:execute-cleanup` | `{token:string}`，不接受 PID、路径或信号 | ProcessCleanupResult |

旧 operations 客户端（collected 仅 inspect）只把变更结果的 `revision` 返回页面，随后读缓存获取整体快照；新增进程执行返回逐项结果与 refresh_required=true，页面必须以 refresh=true 强制整体重新采集，不能沿用缓存刷新或本地扣减资源。周期保存仅重启计时，不立即采集；多余字段拒绝为 `INVALID_PARAMETERS`，非法周期返回 `INVALID_INSPECTION_INTERVAL`，保存失败返回 `SETTINGS_SAVE_FAILED` 且保留原设置。

### 6.1.1 本机进程准备/执行契约（已实现源码）

```typescript
interface ProcessCleanupPlan {
  token: string; // 32 随机字节，小写 64 位 hex
  revision: number;
  expires_at: string; // ISO，准备时刻 +60 秒
  processes: { id: string; pid: number; starttime: number; name: string }[];
}
interface ProcessCleanupResult {
  revision: number;
  results: {
    pid: number; starttime: number; name: string; eligible: boolean;
    status: 'signalled' | 'protected' | 'permission_denied' | 'stale' | 'gone' | 'unsupported';
    reason: string;
  }[];
  refresh_required: boolean; // 当前执行返回 true
}
```

`prepareProcessCleanup` 与 `executeProcessCleanup` 共用控制器串行队列，均要求组件已校验、控制器启用且未关闭、已有快照。prepare 严格拒绝额外字段、非 CPU/内存/disk、非 1–10 个唯一字符串 ID；revision 必须为当前整数，ID 必须在对应资源行中且已被本机标注可结束，并在 raw 身份表中。再次 sysAK check 全部 eligible 后才发 token，进程名称使用新鲜结果。控制器只保存一份内存计划。

execute 只接受小写 64 位 hex token；匹配后先消费计划，再检查 TTL 和当前 revision，因过期或执行失败也不能复用。采集成功后的重新标注、新 prepare、启停均会作废旧计划，退出后不可执行。执行前关闭选中行的 cleanable，sysAK 再做最终身份/权限/保护校验。返回结果不推进展示 revision、不修改 usage；只有后续成功采集提交才推进 revision。

常见错误：400 INVALID_PARAMETERS；409 COLLECTOR_DISABLED/SNAPSHOT_REQUIRED/STALE_SNAPSHOT/PROTECTED_PROCESS/INVALID_CLEANUP_PLAN/EXPIRED_CLEANUP_PLAN；503 PROCESS_CONTROL_UNAVAILABLE 或 PROCESS_RESULT_UNKNOWN。结果不完整不自动重试，已消费凭证不回滚，必须先刷新核对。

这些是受来源约束的本机接口，不是 `/openapi/v1/collections` operation，不开放给远端服务，也不改变 OpenAPI 的 read_only 能力。

### 6.2 本地响应

```typescript
interface ClientReply<T> {
  ok: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    status: number;
    retryable: boolean;
  };
}
```

HTTP 错误使用对应状态码；IPC 在响应对象中传递相同错误语义，不把主进程异常栈暴露给页面。

### 6.3 采集状态

```text
CollectorStatus
  schema_version、mode、read_only、device_id
  installed、enabled、phase、api_version
  inspection_interval_minutes: 1–1440 整数分钟，默认 5
  next_inspection_at: ISO 时间；暂停、退出、不可用或自动任务待执行/执行中为 null
  last_task:
    id、request_id、operation、status、profile
    collection_status、raw_bytes、collected_at、simulated
  error: null 或 {code,message}
```

当前 `phase`：`idle/collecting/submitting/error/disabled`；离线 HTML 返回 `unsupported` 和 `mode=offline-demo`。`installed` 现要求本地 bundle 校验及固定 root 安装/manifest/hash/路径校验均通过，不表示系统管理员已授权，也不保证外部命令/驱动/接口可用。缺匹配 root 安装时 `installed=false/phase=error`、错误为 `ROOT_COLLECTOR_UNAVAILABLE`、不安排下次巡检；内存 `enabled` 仍可为 true，UI 启停/周期 disabled，不将其说成已持久化暂停。

### 6.4 本地安全边界

- 桌面健康与专用 process:prepare-cleanup/execute-cleanup IPC 均仅接受主窗口的可信主 frame；悬浮窗口、子 frame 和非可信来源不能采集或结束进程。preload 仅暴露这两个有限方法，不提供通用调用。
- Vite 接口仅接受回环 Host，拒绝不同源 Origin。
- POST 参数只接受 JSON，最大 8192 字节。
- 前端 HTTP 请求超时仍为 65 秒；当前采集含授权最多 35 秒、提交 30 秒，另有串行等待与 root check 最多 15 秒，故不能宣称覆盖全部端到端最坏时长。超时不绕过授权/不 ordinary fallback，后续需任务受理与进度机制。
- 不将本地控制器作为对局域网开放的通用采集服务。

### 6.5 IDE 插件本机桥接（当前源码与冻结 0.2.10 边界）

VSIX 的 ordinary 本地扩展 host 复用桌面 `createIdcController`、`process-control`、`sysak-root.cjs` 和 generated OpenAPI；`startMockOpenApi` 是历史兼容名称，实际 `state.mode=collected`、`task.simulated=false`。当前 `dist/sysak` 与桌面按 prepare-sysak 的同一白名单复制/验证：三个命令、原生 memgraph 16 + resource_anomaly 2 模块、dispatcher 与规则，共 23 必需文件及 manifest（24 文件），不含 confscan/配置目录/全仓库。两端开发 bundle 校验及插件 build/typecheck/package 已通过，0.2.11 VSIX 已构建；dist 只提供本地 manifest 核对，不被 root 执行。真正 sysAK 只能来自固定 root-owned `/opt` 安装；插件构建或 VSIX 安装不安装 helper/bundle。没有匹配安装时不可用，不普通回退。本地归档及桌面、Chrome、真实 IDE unavailable 验收通过，最终解包 VSIX 在隔离 VS Code 1.145.2 的 4 项验收通过（16.1），未执行用户 IDE 安装；冻结 0.2.10 VSIX 仍为历史 28 文件。

共享 Webview `idc-client` 经 `window.sysomDesktop` 调用 8 个固定 RPC：`healthSnapshot`、`healthReset`、`healthOperation`、`prepareProcessCleanup`、`executeProcessCleanup`、`collectorStatus`、`setCollectorEnabled`、`setInspectionInterval`。host 校验方法、正整数请求 ID、参数数量及 8192 字节预算，controller 继续校验具体业务参数、身份、revision 和一次性 token。回复复用 `ClientReply`，不启用 HTTP/演示状态回退；已关闭或替换的面板不能继续操作，异步回复也不会投递到新面板。

插件使用本地 `extensionKind=["ui"]`，采集本机而非远端工作区；巡检周期保存在扩展 `globalStorage/inspection-settings.json`，设备 UUID 保存在 `globalState`，与桌面 `userData/idc-settings.json` 独立。默认 5 分钟、范围 1–1440 分钟，由 controller 调度实际采集；host 每 5 秒刷新缓存状态，不因此每 5 秒执行 sysAK。

仅注册 `sysagent.openHome`、`sysagent.inspect`。状态栏、IDE 面板/通知替代桌面悬浮窗；报告保存和剪贴板经 IDE API，Webview 的 `localResourceRoots` 仅为 `dist/webview`，CSP 为 `default-src 'none'` 加 nonce 脚本。旧演示命令与 mock API 适配移除，collected 模式隐藏未接入的 Session 概览/操作。当前发布目标是 Linux x64/Python 3 的兼容 VSIX 宿主；不宣称其他平台或 Qoder Desktop 独立 App 已支持。

## 7. 当前本机 OpenAPI v1

### 7.1 接口清单

完整机器可读契约为 [openapi-contract.json](../sysagent-idc/openapi-contract.json)，OpenAPI 规范版本为 3.1.0、info.version=1.1.0，业务路径仍为 v1/schema_version=1.0。服务启动名 `startMockOpenApi` 和外层 mode=mock 保留为回环部署兼容标识，解析结果不是 Demo。

| 方法 | 路径 | 请求 | 成功响应 |
| --- | --- | --- | --- |
| POST | `/openapi/v1/collections` | CollectionRequest | 200 CollectionResponse |
| GET | `/openapi/v1/devices/{device_id}/snapshot` | UUID 路径参数 | 最近成功的 CollectionResponse |
| GET | `/openapi/v1/tasks/{task_id}` | UUID 路径参数 | `{schema_version,task}` |
| GET | `/openapi/v1/capabilities` | 无 | 只读能力：collection_operations=snapshot/reset/inspect，demo_operations=[]、destructive_actions_enabled=false；采集类型与限制 |
| GET | `/openapi/v1/openapi.json` | 无 | OpenAPI 契约原文 |

实际服务监听 `127.0.0.1` 的临时端口，由启动方法返回；契约中的 8787 是示意值，不是固定部署要求。

所有接口使用 Bearer 认证，拒绝 Origin，不提供浏览器 CORS；前端通过本地桥接，不直接持有 token 调用 Mock。

### 7.2 操作与参数

| operation | 必要参数 | 可选参数 | profile | 当前效果 |
| --- | --- | --- | --- | --- |
| snapshot | 无 | revision、hasGpu | resources | 解析新实际证据，已有设备 revision+1；首次为 1，保留独立 inspections |
| reset | 无 | revision、hasGpu | resources | 重新解析资源并清 inspections/操作历史，已有 revision+1；首次为 1，不退回旧初始值 |
| inspect | revision | hasGpu | inspection | 必须使用最新 revision，解析资源、resource_anomaly IDC 与原生 memgraph 的过滤 graph/未知覆盖，revision+1、记录体检；不将协议 read_only 当作原生执行范围 |
| cleanup | resource、ids、revision（遗留契约） | hasGpu | resources（遗留） | revision 校验后 409 read_only，不修改状态 |
| optimize | ids、revision（遗留契约） | hasGpu | resources（遗留） | revision 校验后 409 read_only，不修改状态 |
| sessions-cleanup | resource、agentId、sessionIds、revision（遗留契约） | hasGpu | resources（遗留） | revision 校验后 409 read_only，不修改状态 |
| alert-sample | target、usage、revision（遗留契约） | hasGpu | resources（遗留） | revision 校验后 409 read_only，不注入模拟值 |

`hasGpu` 为接受但不覆盖证据的兼容提示，包括 reset。只读能力集合只有 snapshot/reset/inspect；枚举中保留遗留操作仅用于兼容拒绝，不表示可以执行。reset 不是系统写入或演示初始化。

参数约束：

- snapshot/reset/inspect 仅接受 revision、hasGpu；不接受额外参数、任意命令、路径、`configuration` 操作或对应业务 profile。
- 除 snapshot/reset 外，当前正整数 revision 必填；任何提供的 revision 均须匹配最新状态。未初始化设备的基准校验为 1；本地先初始化 resources 再 inspect。
- 遗留机器契约仍限定 resource=cpu/energy/memory/disk/gpu，普通/优化 IDs 最多 10 个、Session IDs 最多 20 个且唯一，target=cpu/energy/memory/gpu/root/fd、usage=80/96。这些枚举不能授予远端写权限；服务在 revision 后直接 read_only 拒绝。collected UI 的进程选择/执行改走第 6 节独立本机接口，不能改道旧 cleanup。
- 活动 Session、受保护父行、未知或跨 Agent/范围对象不可处置的安全边界继续保留，后续计划接口也不得绕过。

### 7.3 最小协议示意

下面只展示请求结构，空证据对象不是实际系统报告，不能作为真实诊断输入使用：

```json
{
  "schema_version": "1.0",
  "request_id": "0ea10ce5-f370-4f77-a4b7-b3331f3e4b61",
  "device_id": "2b6b6bcf-4f5d-4c32-8f64-c9083b0393f0",
  "operation": "inspect",
  "parameters": { "revision": 1 },
  "raw_snapshot": {
    "schema_version": "1.0",
    "request_id": "0ea10ce5-f370-4f77-a4b7-b3331f3e4b61",
    "collector": { "name": "sysak", "command": "idc", "version": "1.0.0" },
    "device": { "platform": "Linux", "machine": "x86_64", "scope": "local" },
    "collection": {
      "profile": "inspection",
      "status": "partial",
      "finished_at": "2026-11-09T00:00:00.000Z"
    },
    "resources": {},
    "configuration": {},
    "diagnostics": {},
    "capabilities": { "read_only": true }
  }
}
```

### 7.4 校验与处理顺序

1. Bearer 认证；Origin、路由、方法检查。
2. Content-Type、编码、请求大小、UTF-8/JSON 检查。
3. 相同 request_id 的幂等查询。
4. 请求 envelope 字段、字节预算、版本、UUID、operation 及 parameters 对象形态检查。
5. 当前设备 revision 检查；过期 revision 先返回 revision_conflict，不解析证据或进入动作验证。
6. 遗留 cleanup/optimize/sessions-cleanup/alert-sample 返回 409 read_only；不解析其 raw、不创建任务或提交状态。
7. 只读参数、raw_snapshot 版本/request_id/profile/结构/read_only/结束时间、采集状态和设备容量校验；error 返回 503 不提交，partial 可接受。
8. collected-state.ts 解析实际证据；缺失指标 null。snapshot 保留已有独立 inspections；inspect 解析固定报告；reset 清检查/记录但在已有 revision 上递增。
9. 同步生成 completed、simulated=false 任务并原子提交新展示状态，保留有界幂等结果和任务元信息。
10. 返回 HealthState、receipt、task；不保存或回传完整 raw_snapshot。

raw.capabilities 中工具支持的 profile 只作为原始元数据，不构成服务端许可。外层 device_id 当前只是应用标识，Mock 不认证硬件来源。

### 7.5 限额、幂等与持久化

| 项目 | 当前约束 |
| --- | --- |
| 原始 JSON | 8 MiB，按原始 JSON 值字节计算，不按重新序列化后的大小 |
| 总请求 | 10 MiB，仅未压缩 application/json |
| 控制器响应预算 | 1 MiB；当前读取响应文本后检查，远端接入时需流式限额 |
| Mock HTTP 请求超时 | 30 秒 |
| 设备状态 | 最多 32 个，不自动驱逐已有设备；超限返回 503 |
| 幂等结果与任务 | 最近 100 个成功请求，FIFO |
| 生命周期 | 内存保存，服务退出清空 |

幂等语义：

- UUID 查询不区分大小写，但原始 request_id 在采集与外层请求之间必须完全相同。
- 相同 request_id、完全相同 UTF-8 请求体返回原结果，不再次执行，不成为设备最新快照。
- 相同 request_id、不同字节，包括空白差异，返回 409。
- 超出保留窗口的旧任务返回 404；当前幂等不提供永久“恰好一次”保证。
- 客户端当前没有持久化原请求和自动重放；不能宣称已具备断网可靠重试。

### 7.6 错误语义

| HTTP | 代表错误 | 客户端处理 |
| --- | --- | --- |
| 400 | invalid_request / INVALID_OPERATION | 修正字段、对象或操作，不盲目重试 |
| 401 | unauthorized | 认证处理，不向前端泄露 token |
| 403 | origin_not_allowed / UNTRUSTED_SENDER | 阻止非法来源，不改道绕过 |
| 404 | not_found | 对象/任务不存在或已过保留期，重新获取当前状态 |
| 405 | method_not_allowed | 按契约方法调用 |
| 409 | revision_conflict | 刷新并重新确认选择；不是自动重复原操作 |
| 409 | idempotency_conflict | 禁止复用编号提交不同内容 |
| 409 | read_only | OpenAPI/旧 operations 不支持清理/优化/Session 清理/演示改值；独立本机进程 API 不取消此拒绝，不可盲重试或绕过 |
| 413 | request_too_large / raw_snapshot_too_large | 显示截断或预算问题，不直接放开无限上传 |
| 415 | unsupported_media_type | 按 JSON 和编码要求提交 |
| 503 | collection_failed / device_capacity / service_unavailable | 保留旧展示，提示可重试，后续按退避策略处理 |
| 503 | 本地 ROOT_COLLECTOR_UNAVAILABLE | 固定 root 安装缺失/不可信/hash 或版本不匹配，提示安装与系统管理员授权，不以普通用户回退；预期不可用不是 root 黄金路径通过 |
| 403 | 本地 ROOT_AUTHORIZATION_FAILED | pkexec/helper 退出 126/127，授权取消、拒绝或组件校验失败，不回退；重新请求仍须合法期限与系统授权 |
| 504 | 本地 COLLECTION_TIMEOUT | 中止本次采集，允许用户重试 |
| 502 | 本地 INVALID_COLLECTION / INVALID_API_RESPONSE | 不提交或不更新不兼容结果 |

OpenAPI 错误返回 `schema_version、可选 request_id、error:{code,message,retryable}`；本地桥接另加 `ok` 和错误 `status`。当前前端异常对象未保留完整 retryable 字段，远端客户端改造时应统一。

## 8. 状态机、时序与一致性

### 8.1 本地状态机（已实现）

```text
启动
  ├─ 组件校验失败 → error
  └─ 校验通过 → idle

idle → collecting → submitting → idle
          │              │
          └── 失败 ───────┴→ error

任意活动阶段 → 暂停/退出 → 取消当前采集或提交 → disabled
启用 → 按当前周期重新计时 → idle 或组件错误 error
```

`idle` 只表示没有任务在执行，不表示采集结果不可用或从未采集。当前首页不再显示“等待采集”等采集阶段横幅；内部状态仍用于请求互斥、启停控制和诊断，不直接作为首页展示文案。

### 8.2 首次加载与轮询

当前：获取当前快照 → 无缓存时真实 resources 采集 → OpenAPI 实际解析 → 每 1.5 秒本地 snapshot 只读缓存；重载页面不 reset。手动“刷新整体数据”传入 refresh=true，新成功提交推进 revision；inspect 完成后传入 false 读缓存，进程执行后则必须传入 true 重新采集，不能用缓存证明效果。缓存 GET、服务 GET 和幂等重放不推进 revision。resources 刷新保留独立体检结论及其原证据时间，不用新的资源百分比重算旧诊断。

首页右上角“Demo 能力说明”入口已替换为“巡检配置”，点击打开紧凑配置卡片；再点击卡片中的“巡检周期”进入周期编辑。支持 1、5、15、30 分钟及 1、6、12、24 小时快捷选择，也支持自定义小时和分钟。合计须为 1–1440 整数分钟，默认 5 分钟；保存后返回配置卡片并更新下次巡检日期时间，草稿不随状态轮询重置。

本地控制器使用一次性定时器，到期后在与人工操作共用的串行队列内读取最新 revision，执行 inspection → 提交 `/openapi/v1/collections` → 更新整体缓存。无缓存时先初始化 resources。自动任务完成或失败后再间隔所选周期执行，不并发、不积压漏过的周期；失败保留上次成功结果，错误仍保留在内部状态与回执中，不恢复首页采集技术横幅。

周期保存在 `{inspection_interval_minutes:number}` JSON 中：桌面端位于 Electron userData 的 `idc-settings.json`，开发网页位于 `resources/idc-settings.json`（已忽略版本控制）。保存使用私有临时文件原子替换；失败不改变活动周期。损坏或不可读配置回退 5 分钟并报告 `SETTINGS_LOAD_FAILED`。

保存和恢复启用均从当前时刻重新计时，旧计时器及排队自动任务失效；保存不立即采集。桌面应用收起后控制器仍运行，退出后停止；开发网页的定时器由开发服务器持有，关闭标签页不等于退出服务器。离线 HTML 不执行本地采集，也不开放周期设置。

规划：继续补充持久化启停与远端授权、断网恢复及采集成本策略，不将渲染轮询等同于真实采集频率。

### 8.3 体检时序

```text
用户重新体检
  → 提交 revision
  → 本地串行队列受理
  → inspection 原始采集
  → OpenAPI 提交
  → 最新 revision 校验、资源与固定诊断解析（原生图压力/未知插件覆盖）
  → 返回新状态与任务回执
  → 缓存更新
  → 前端重新获取整个快照
  → 展示新 revision、诊断、建议、报告
```

服务端若返回过期 revision 冲突，本地已有采集可能已经发生，但不应用诊断状态变换或处置结果。

### 8.4 暂停、恢复与退出

- 暂停：停止定时器、作废进程确认计划，禁止新采集/操作及 prepare/execute，取消活动采集/提交；有缓存可读，已安装组件时暂停可改周期。普通 host 不保证立即杀 root collector，丢弃结果并等待 root watchdog；进程动作未接入采集 AbortSignal，已发目标 SIGTERM 不可撤销，不宣称暂停撤回已开始动作。
- 恢复：保留缓存，按当前周期重新计时；界面的“开启巡检”操作另外显式执行一次资源刷新，不立即执行 inspection，不悄悄恢复云端上传授权。
- 退出：标记 closed/disabled，停止定时器并废弃排队自动任务；禁止新进程准备/执行，取消活动采集/提交，等待本地串行队列（含已开始进程动作）结束后关闭 Mock。不是结束业务进程的触发器，不把已发送信号当可回滚。
- 已完成且被服务端接受的请求不因本地网络取消而自动回滚；真实远端需通过请求编号查询最终结果。
- 将来“取消解析任务”和“停止本地采集”是两种行为，应使用不同状态和接口。

进程准备/执行的本机状态为：可选 → check → awaiting_confirmation（60 秒 token）→ 取消或 execute → 分进程结果 → 强制资源刷新。UI 取消仅丢弃确认，不发送 terminate；服务端内存 token 仍受过期、替换、启停和 revision 约束，无独立 cancel API。自动 inspection 与人工 prepare/execute 共用队列，快照更新会作废计划；结果不明或整体刷新失败时 UI 进入 refreshRequired 阻止重复提交，只有成功整体刷新后再选择/确认。

### 8.5 一致性设计

当前控制器串行执行；回环服务在同一同步处理段中完成 revision 检查与状态提交。每个新的成功 snapshot/reset 在已有 revision 上 +1，首次 snapshot/reset 为 1；inspect 必须携带最新 revision 并推进。reset 清 OpenAPI 检查与记录（控制器内存本机进程记录仍合并），不将 revision 退回 1；错误、缓存读取和字节完全相同的幂等重放不推进，重放也不覆盖 latest。前端只接受不低于当前 revision 的快照。此保证限于当前内存服务生命周期，重启清空状态的恢复仍待持久化方案。

真实服务规划：

1. 每设备维护单调展示 revision；新快照产生 snapshot_id，重复请求不推进。
2. 服务端在事务或等效原子操作中检查基准 revision 并提交结果。
3. request_id 的唯一约束按认证主体和设备范围建立，不只按全局字符串。恢复查询同时携带 device_id，并使用同一复合键定位和校验归属，避免不同设备合法复用编号时产生歧义。
4. 持久化幂等记录、请求指纹和最终结果；保留期覆盖客户端可恢复重试窗口。
5. 请求接收但响应丢失时查询 request_id，不生成新编号重复执行。
6. 计划、执行、复检各有独立状态与 ID，失败不能伪造最新成功快照。
7. 展示刷新不得靠 reset 降低 revision，否则当前前端的版本防回退逻辑可能丢弃服务重启后的新状态。

## 9. 前端交互设计

### 9.1 页面与数据来源

| 页面/区域 | 当前数据 | 目标数据 |
| --- | --- | --- |
| 资源卡片 | collected 实际 CPU/内存/根容量已实测；GPU/package W 依赖证据，本环境不可用、缺失 null | 其余单位、缺失和 scope 的 UI 验收及更多硬件实测 |
| 进程排行 | overallTop20+AgentTop20 去重并集（≤40/资源），先筛选再 Top10；原生 UI 已验证过滤/选择/确认 SIGTERM 与强制资源刷新（仅 本次测试自行创建的临时进程，16.1） | 保留覆盖与 PID+starttime，不用行和代替总量；更多失败/UI/环境场景待验收 |
| Agent 筛选 / Session | collected 使用 comm 精确白名单 agentKind 筛选，不生成 agentId/会话行；离线 Demo 独立 | 名称识别可能漏报且不可信归属；Session 选择/清理仍待探针 |
| 体检详情、报告 | 独立根目录/FD/内存报告；真实 FD partial/unchecked 卡片与详情“已检查 · 结论受限”、resource_anomaly 来源及非泄漏趋势说明已验证（16.1） | 执行覆盖与评分分离、有效计数/比率回归通过；其余失败/UI/环境场景待验收 |
| 优化列表 | collected 为空，写操作禁止；离线 Demo 独立 | 获准后另行生成计划，生成不等于执行 |
| 性能曲线 | 无真实历史接口，样本仅离线使用 | 真实时间戳、空缺点与单位，不随当前值缩放伪趋势 |
| 设备管理 | 本机联动，其他设备仍为样本 | 认证设备列表及逐设备快照 |
| Agent/GPU/日志详情 | 专项未全部接入；GPU 资源已有设备遥测 | 不从总览接口伪造进程 GPU/Session 或故障证据 |
| 悬浮小管家 | 主模型摘要；完整告警生命周期未接入 | 真实持续条件和恢复，不独立采集 |

### 9.2 状态与按钮

#### 9.2.1 巡检配置卡片（已实现）

- 首页不再展示独立采集状态横幅；右上角使用“巡检配置”入口，替代“Demo 能力说明”。首次加载和整体数据不可用页面也保留该入口。
- 点击入口打开标题为“巡检配置”的紧凑弹窗，卡片采用标签在左、操作或数值在右的四行布局，分隔线区分各项。

| 左侧标签 | 右侧内容 | 交互与数据来源 |
| --- | --- | --- |
| 启停状态 | 运行时为“暂停巡检”，暂停时为“开启巡检”按钮 | 保留原采集启停逻辑；处理中防止重复提交，未安装组件或离线演示时禁用 |
| 巡检周期 | 如“5分钟”“1小时30分钟”，带进入箭头 | 读取 `inspection_interval_minutes`；已安装时进入周期编辑，缺匹配 root 安装或离线时 disabled |
| 下次巡检 | 本地日期时间，如 `2026/11/09 20:14` | 读取 `next_inspection_at`；暂停显示“已暂停”，不可用显示“暂不可用”，读取中或尚未安排时显示简短状态 |
| 上次巡检 | 最近一次 inspection 的本地日期时间，未巡检显示“暂无巡检” | 最近任务为 inspection 时使用 `last_task.collected_at`；最近任务为 resources 时使用当前 HealthState 中最近 `kind=inspect` 的操作时间 |

“上次巡检”不使用普通资源采集时间；手动资源刷新和恢复时的资源刷新不得替换该时间。当前回环 collected 操作记录和任务为内存数据，上次巡检时间不是独立持久化设置；resource-refresh 保留体检记录，reset 显式清空。

首页及配置卡片不展示原始 JSON 大小、任务编号、部分接口缺失说明、sysAK → 本机 OpenAPI → collected 技术链路、保存成功通知或原始 `Failed to fetch` 文本。仅移除这些展示内容，内部采集状态、回执、错误码和请求关联信息继续保留。配置获取或启停失败在配置弹窗内使用简短中文提示，周期保存失败在周期编辑弹窗内提示。

配置卡片关闭后，CollectionStatus 组件仍挂载，每 1.5 秒读取状态并同步启停；隐藏界面不停止调度，也不绕过暂停后的体检/进程动作禁用。collected 优化、Session/文件清理和旧 operations 写路径始终不开放；独立进程选择/准备/确认受启用、身份、权限、revision、token 与刷新状态约束。配置卡片窄屏布局的既有记录仍属旧基线；当前新增进程交互与 360px 资源排行 document 不溢出已验证，范围及单测/真实 UI 边界见第 16.1 节，不等于完整移动端验收。

#### 9.2.2 周期编辑（已实现）

1. 点击卡片的周期值，用“设置巡检周期”弹窗替换配置卡片，不叠加两个对话框；编辑结束后返回卡片。
2. 提供 1、5、15、30 分钟及 1、6、12、24 小时快捷选项，5 分钟标为默认；自定义分别输入小时与分钟。
3. 小时为 0–24 整数、分钟为 0–59 整数，合计 1–1440 分钟；24 小时时分钟必须为 0。非法值或与当前周期相同的值不可保存。
4. 取消或关闭周期编辑只丢弃草稿，返回配置卡片；保存成功更新周期与下次巡检时间并返回卡片，不立即采集，也不显示额外保存成功条。
5. 状态轮询不重置编辑草稿；保存期间防止重复提交与关闭，保存失败保留输入并允许重试。暂停时仍可修改周期，但不安排下一次巡检，开启后按新周期重新计时。
6. 周期编辑内保留范围提示和简短计时说明；离线 HTML 不执行本地采集，巡检启停和周期设置均禁用。

界面文案使用“开启巡检/暂停巡检”，底层仍调用既有 `collector:enabled` 或 `/api/idc/enabled`，不新增接口，也不改变启停状态是否持久化的边界。

#### 9.2.3 collected 状态与按钮（pre-root 原生 UI 历史；本阶段只验证无 root 安装分支）

confscan 移除前的历史源码 Electron UI 已有以下验证：实际 collected 快照、全部程序/Agent 先过滤再 Top10、临时 codex 可选、取消不发信号、刷新撤销旧 token、确认后仅自建进程 pidfd SIGTERM、逐项结果/强制刷新/history、真实 FD partial 文案、当时 8 项诊断、无伪造性能历史及 360px 资源排行不溢出，consoleErrors=0；完整测试与私有组件 prepare/verify 也仅记为当时证据，不证明此次增量通过。当前 0.2.11 三包已构建，本地归档及桌面、Chrome、真实 IDE unavailable 验收通过，不将历史 UI 结果外推为本阶段 root 黄金路径或真实 IDE 通过；错误/断网/未知执行/刷新失败只有历史单测覆盖，完整离线 HTML 与更多 UI/环境仍待验收，见 16.1。技术回执与诊断明细分区，不加首页采集技术横幅。collected 仅本机独立进程路径允许确认 SIGTERM；优化、Session/文件/FD 清理、模拟告警改值与配置扫描仍不开放。

| 状态 | 展示 | 操作规则 |
| --- | --- | --- |
| 首次无结果 | 简短加载/不可用页面，保留巡检配置入口；缺 root 安装时明确提示安装/系统管理员授权及不普通回退 | 禁止清理/优化；缺匹配 root 安装时启停和周期 disabled，下次巡检暂不可用；重试不能绕过安装/授权 |
| 采集成功 | collected 资源时间与单位；独立诊断保留体检时间 | 快照/体检只读；仅本机 check 合格进程可选择/准备确认，技术回执留明细 |
| 部分成功 | 缺失原因、有效项目数 | 不把缺失项判正常，不允许无证据处置 |
| 失败且有旧结果 | 旧数据 + 错误 + 过期标记 | 不冒充当前实时；高风险操作要求重新采集 |
| 暂停 | 明确保留上次快照 | 禁止新采集；真实执行不因“已有缓存”被绕过 |
| 网络断开 | 本地已采集/尚未解析的区分 | 不静默回落到 Demo |
| 能力不支持 | 不支持原因 | 隐藏或禁用对应按钮，不把不可用当硬件不存在 |
| 离线 HTML | 明确仅模拟，无本地采集 | 保留演示交互，不与生产设备混合 |

### 9.3 必须保留的交互约束

- 资源、诊断和分数使用同一份展示 revision；独立 inspection 保留原检查时间，不冒充与最新 resources 同时复检。
- Session 未接入，不能伪造活动/空闲/完成状态或按 Session 清理；Agent 名称标签本身不授予可结束权限。collected 的进程行（含 Agent 命中）按本机安全策略决定可选，全部 defaultSelected=false。
- 选择对象属于特定设备和 revision；刷新后重新校验，失效选择不自动迁移。
- 清理确认显示对象、范围、风险和预计影响，不能只显示“释放多少资源”。
- 操作成功提示来自任务和执行回执，不来自按钮动画或前端本地扣减。
- 模式取自 state.mode，不因外层 mode=mock 把实际值标成模拟；collected 出错保留旧有效结果，不返回 Demo。离线 HTML 明确独立模拟。
- 实际 CPU/内存/disk 进程行可在本机 raw 身份与 check 合格后选择；Agent 白名单仅用于过滤，不提供 Session 归属。GPU 行为设备、energy 行为 package，不可结束；disk 行 B/s 不代表目录字节，结束进程不承诺释放磁盘空间。
- 当前 SysAgent 不采集配置证据或调用 confscan；collected 无“系统与配置”项。暂留空 envelope 容器不增加操作入口，检查数量、未知覆盖与评分分母仍须随真实模型验收。

### 9.4 本机进程确认与结果（回归及真实原生 UI 指定场景已验证，见 16.1）

1. “全部程序/只看 Agent”先过滤、按实测值排序再 Top10；切换过滤清空选择，只对白名单 agentKind 筛选，不展开 Session。未命中提示“本次采样未识别”，不声称没有 Agent。
2. 合格行支持单选/全选当前可结束进程，最多 10 项且不默认勾选；保护/权限/身份失效或能力不可用行禁用并显示原因。busy、暂停、loadError 或 refreshRequired 均阻止操作。
3. “清理所选进程”先 prepare，不发送信号；确认区显示新鲜进程名称、PID、整个进程作用范围、中断任务/未保存数据风险、60 秒有效期和不清文件/不强杀边界。可取消，revision 变化禁用确认并要求重选。
4. 确认只提交 token，立即丢弃 UI 计划，呈现逐进程 signalled 或拒绝原因。文案明确“已发送 SIGTERM（不代表已退出）”，不说进程已退出/资源已释放，不按按钮动画扣减资源。
5. 执行后强制 refresh=true 获取整体新采样；信号发送和效果是不同事实。结果不明或刷新失败进入 refreshRequired、清空选择并阻止重复提交，提示先刷新核对；刷新失败不自动重复 terminate。新采样也只反映资源现状，不证明所有目标已退出或修复完成。

## 10. 下一阶段远端 OpenAPI 设计

### 10.1 版本策略（规划）

后续远端业务候选采用 `/openapi/v2` 与业务 `schema_version=2.0`；当前 v1 已在本机实现实际证据解析，不以新版本作为基础解析前提。远端/异步/执行仍需版本化，原因：

- v1 外层 mode=mock 仅表示回环部署，read_only=true、同步 completed；state.mode=collected、task.simulated=false 已表达实际解析，不代表生产远端服务。
- 当前 v1 展示已表达 null、quantity、starttime/agentKind 和诊断 execution；独立本机 API 有 token/逐进程结果，但尚无远端通用执行任务、效果验证、持久快照身份、完整有效期/规则版本或异步进度。
- 更换服务器地址不能绕过响应验证、上传授权、认证和设备归属校验。

下面 v2 路径是本文件提出的候选详细设计，不在当前 OpenAPI JSON 中，不是可调用的已上线接口。实施前需服务端确认版本和字段。

### 10.2 远端客户端边界

控制器保留本地采集与生命周期职责，远端 API 客户端集中承担：

1. 服务地址及认证配置，从受控配置或系统凭据存储读取，不放前端 bundle。
2. HTTPS、认证续期、设备归属和能力协商。
3. 请求编码、大小限制、超时、流式响应预算、契约验证。
4. 请求编号、原请求指纹、结果查询、受限退避与可恢复提交。
5. 用户授权和数据最小化后才允许原始证据离开设备。
6. 返回类型化展示和任务，不向前端暴露原始 token、私有服务错误或任意命令。

回环 collected、将来的远端服务与离线 Demo 须明确隔离；部署模式和数据来源模式分别校验，不在网络失败时自动切换模拟，不添加对外可访问的本地通用代理。

### 10.3 候选接口

| 优先级 | 方法与路径 | 目的 | 关键边界 |
| --- | --- | --- | --- |
| P0 | `GET /openapi/v2/capabilities` | 版本、采集类型、展示模型、限额、真实动作能力 | 不支持的能力不得启用 |
| P0 | `POST /openapi/v2/devices/register` | 设备注册/凭据绑定 | UUID 不是认证；注册须有可信授权上下文 |
| P0 | `POST /openapi/v2/collections` | 原始采集提交与解析受理 | 保持原始证据，绑定 request_id、设备与授权 |
| P0 | `GET /openapi/v2/devices/{device_id}/snapshot` | 最新展示快照 | 有效期、revision、完整性、数据模式明确 |
| P0 | `GET /openapi/v2/devices/{device_id}/requests/{request_id}` | 响应丢失时查询受理/结果 | 以认证主体、device_id、request_id 唯一定位，校验设备归属，不以新 ID 重复执行 |
| P1 | `GET /openapi/v2/tasks/{task_id}` | 状态、进度、结果或错误 | 与当前 v1 completed 元信息不同 |
| P1 | `POST /openapi/v2/tasks/{task_id}/cancel` | 请求取消服务端任务 | 返回最终状态；执行中可能不允许取消 |
| P1 | `POST /openapi/v2/devices/{device_id}/heartbeat` | 在线状态与能力更新时间 | 不充当原始指标解析，不暴露硬件序列号 |
| P1 | `GET /openapi/v2/devices` | 授权范围内设备列表 | 分页、归属和离线状态 |
| P1 | `GET /openapi/v2/devices/{device_id}/metrics` | 时间范围指标历史 | 时间区间、粒度、单位、缺失点 |
| P1 | `GET /openapi/v2/devices/{device_id}/alerts` | 告警生命周期与恢复 | 诊断、告警、通知分开 |
| P1 | `GET /openapi/v2/devices/{device_id}/agents` | Agent 与会话摘要 | 仅可信探针数据，详细模型另行确认 |
| P2 | `POST /openapi/v2/action-plans` | 基于最新诊断生成处置计划 | 不执行；返回风险、对象和前置条件 |
| P2 | `GET /openapi/v2/action-plans/{plan_id}` | 读取计划与有效期 | 设备/revision/object 绑定 |
| P2 | `POST /openapi/v2/executions` | 登记用户确认后的受控执行任务 | 授权记录与计划绑定，不含 shell 字符串 |
| P2 | `POST /openapi/v2/executions/{execution_id}/receipt` | 本地上传动作结果 | 认证、幂等、结果完整性 |
| P2 | `GET /openapi/v2/executions/{execution_id}` | 查询执行和复检结果 | accepted/executed/verified 区分 |

本地启动固定动作属于本地可信执行器接口，不允许公网 OpenAPI 直接操作本机进程。执行受理后由主动确认的本地客户端领取/读取结构化动作，不设计默认后台任意远控。

### 10.4 v2 采集提交模型（规划）

| 字段 | 用途 |
| --- | --- |
| schema_version | 业务协议版本 |
| request_id | 一次逻辑提交的稳定 ID；重试不换 ID |
| device_id | 已认证绑定的应用设备 ID |
| operation | 只读阶段限定 snapshot/inspect，不混入 reset 或 alert-sample |
| parameters | 明确的采集/诊断意图和可选基准 revision，不接受命令 |
| raw_snapshot | 原始采集协议，独立校验其版本 |
| client | 应用版本、采集器版本、支持的展示协议 |
| authorization_context | 引用已登记的上传授权，不用自由文本代替用户同意 |

服务端从认证上下文确定租户与设备归属，不信任请求中任意声明的 tenant、角色或权限。采集器 raw.request_id 必须与外层一致。

### 10.5 v2 返回和任务状态（规划）

- 快速解析：200，返回最终展示快照、采集回执和 completed 任务。
- 异步解析：202，返回 request_id、task_id、状态及建议查询间隔；不返回伪造完成的 HealthState。
- 任务状态：queued → running → completed/failed；取消可经过 cancelling → cancelled。
- 客户端通过任务查询获得结果，校验归属、版本和 revision 后更新页面。
- 长任务先显示旧有效快照，再显示新任务进度，不把旧结果标签改为“刚刚更新”。
- 解析成功仅表示展示结果生成；真实执行和验证使用独立执行模型。

### 10.6 持久化与数据关系（规划）

```text
设备
  → 多个采集受理记录
  → 多个解析任务
  → 多个展示快照
  → 多个历史指标点 / 告警

展示快照 + 诊断建议
  → 处置计划
  → 用户确认 / 执行任务
  → 本地回执
  → 复检采集 / 验证结果
```

建议实体及最小约束：

| 实体 | 最小字段与约束 |
| --- | --- |
| Device | 认证归属、device_id、客户端能力、last_seen；主体+device_id 唯一 |
| CollectionRequest | request_id、请求指纹、profile、时间、完整性、状态；主体+设备+请求唯一 |
| Task | task_id、设备、类型、状态、阶段、结果引用、错误 |
| DisplaySnapshot | snapshot_id、设备、revision、采样时间、有效期、展示数据、规则版本 |
| MetricPoint | 设备、资源、时间、值、单位、scope、有效性 |
| Alert | 稳定告警 ID、规则、开始/恢复时间、状态、关联证据 |
| ActionPlan | plan_id、设备、基准 revision、对象快照、动作、风险、失效时间 |
| Execution | execution_id、plan_id、授权主体、动作状态、回执和验证引用 |

原始证据默认不长期保存；服务端瞬时解析、临时排队或诊断留存均需明确保留期、加密、访问控制和删除策略。默认值与正式保存周期属于待定项，不能以“没有应用日志”为由宣称整个生产链路完全不留存。

### 10.7 超时与重试（规划）

- 本地采集超时、网络超时、服务端任务超时分别建模。
- 本地进程取消不保证服务端请求被撤销；恢复时先查询 request_id。
- 仅对约定的暂时网络错误、429、可重试 5xx 做有界退避；次数、总时长和本地队列预算需配置并验收。
- 400/403/409 不盲目重试；401 在受控续期成功后重放同一逻辑请求。
- 请求字节或请求指纹必须稳定，禁止将同一 ID 与重新采集的不同 raw_snapshot 组合。
- 排队的原始数据若保存本地，必须使用受限权限和容量，过期后重新采集并使用新 request_id。
- 对未来执行任务，禁止使用“用户点重试就新建执行”替代幂等查询。

## 11. 真实指标解析与诊断设计

### 11.1 当前指标口径（已实现并测试，本机实测与环境扩展边界见 16.1）

| 指标 | 实际计算与展示 | 无效条件/边界 |
| --- | --- | --- |
| CPU 总览 | `/proc/stat` 聚合 cpu 行双样本差分；total=sum(user,nice,system,idle,iowait,irq,softirq,steal) 的 delta，busy=total−idle_delta−iowait_delta；usage=busy/total×100。guest/guest_nice 已包含 user/nice，不再累加 | 缺样本、非法/回退计数、total_delta≤0 时 null；不是 Top20 行之和 |
| 进程 CPU | 同一 PID+starttime 配对；usage=`Δ(utime+stime)/clock_ticks/实际 monotonic 秒差/cpu_count×100`，整机 CPU 容量百分比，不是单核 top 百分比 | 缺配对、PID 复用/退出、时间≤0、ticks/cpu_count 不可用或 delta<0 则不生成该 CPU 行 |
| 内存总览 | meminfo kB×1024 转 bytes；used=MemTotal−MemAvailable，usage=used/MemTotal×100；quantity={value:used,unit:B,total,available} | 必需字段缺失、total≤0、available>total 时 null/quantity 缺失；不回落 MemFree 或缓存“可清理”估计 |
| 进程内存 | 第二样本 RSS bytes（VmRSS 或合法页数×page_size），行 usage=RSS/MemTotal×100，quantity.value 为 RSS bytes | 不是泄漏/PSS/Agent 会话归属；共享页可能重复，行和不能代表总内存；非法 RSS/分母则不生成行 |
| 根文件系统总览 | statvfs：total=f_blocks×f_frsize，used=(f_blocks−f_bfree)×f_frsize，available=f_bavail×f_frsize；usage=used/total×100，quantity 单位 B | 独立于进程 I/O 和目录扫描；字段非法/容量无效则 null，保留块不能冒充已占用 |
| 进程磁盘排行 | 同一 PID+starttime 的 read_bytes 与 write_bytes 双差分相加/实际 monotonic 秒差；行 usage/quantity 为 B/s，按读写吞吐排序 | 两次 io_status=ok 且计数不回退；不是占用目录大小、可释放字节或 statvfs 的分项 |
| GPU 设备 | 固定七列 CSV 遥测逐卡解析；总览取有效设备最高利用率，保留显存 bytes、功率 W、温度 °C 明细 | N/A/无权限/无驱动不补值；只有设备遥测，无 GPU 进程利用率或 Agent/Session 归属 |
| CPU package 功率 | 按路径配对不重叠 package RAPL 双样本；W=`Δenergy_uj/1e6/实际 monotonic 秒差`，回绕仅在两样本 max_energy_range_uj 一致且合法时补一个周期；可用 package 求和为 quantity.value | 仅 CPU package 平均 W，不是整机/进程功耗、累计能量或预算百分比；energy.usage 始终 null，无有效配对则 quantity 缺失，不叠加 psys/core/uncore/dram |

CPU、内存和根文件系统总量直接来自各自系统证据；CPU/RSS/I/O 排行仅对有界可见样本排序，各保留 overallTop20 与白名单 AgentTop20 去重并集（最多 40 行），UI 筛选后再排序取 Top10。排行缺失不抹掉合法总量，总量缺失也不由排行推导。进程身份采用 `process-<pid>-<starttime>`；它仅在当前设备/procfs 视图有意义，不提供跨重启全局身份。百分比当前按一位小数展示，吞吐/W 必须使用 rankUnit，不强制缩放为百分比。

范围证据保留 namespace/cgroup，但当前解析不自动实现 cgroup 限额视角；“整机”指当前 procfs/cpu_count 可观察的容量，不保证容器所见等于物理宿主。inode、diskstats 设备吞吐、网络差分和持续压力规则仍是后续增强，不宣称已由当前资源页实现。名称启发式 Agent 筛选已实现，但可信 Agent/Session 归属与业务 Token 统计延期，必须等待探针；本机确认 token 不是业务 Token 计数。

### 11.2 固定诊断映射与覆盖语义（原生 memgraph 非安全 profile）

| Inspection ID | 固定证据与当前规则 | 覆盖/不可用处理 |
| --- | --- | --- |
| root | `diagnostics.resource_anomaly` 的 IDC 只读报告 root；used_bytes/total_bytes×100，严格大于 90% 为 abnormal，否则 normal | 合法 statvfs 容量可独立判断；目录扫描另标 complete/reason，Top10 allocated_bytes 始终是有界元数据下界，不是完整目录大小/可清理字节 |
| fd | 同报告 fd；工具 allocated 已扣除 file-nr unused，解析用 allocated/file_max（不重复减 unused）；进程 FD 数/soft limit，取合法最高比率，严格 >90% 为 abnormal | 校验整数计数/limit/比率与 coverage；execution=complete/partial/unavailable 独立于 status。部分覆盖合法高占用保留 abnormal，否则 usage=null/unchecked，UI“已检查 · 结论受限”；不是泄漏趋势，不关闭他进程 FD |
| memory | `diagnostics.memgraph`，`version=2.0/mode=native/tool=memgraph/unit=KiB/status=partial` 且 `coverage.native_plugin_coverage_unknown=true`；使用 graph.total 与原生历史拼写 graph.avaliable 计算 (total−avaliable)/total×100，严格 >90% 为 abnormal | 原生 total 包含 ReservedMem（如有），不同于资源总览 MemTotal；合法比例仅判断 graph 内存压力，execution=partial，缺失/非法则 unavailable/unchecked，不推断原生插件完整或完整内存诊断正常。无伪造 read_only 或旧 coverage.missing_fields 契约 |
| agents/logs/gpu/network/io | 当前保留未知项 | status=unchecked、usage=null，无工具/规则支持时不生成正常或模拟异常 |

仅 inspect 调用独立诊断解析；resources 刷新保留已有 inspections 和原证据时间，不由最新 CPU/内存/disk 总览值覆写检查结论。reset 显式将检查恢复 unchecked、清历史并推进 revision；尚未体检、工具不可用、报告不合法时同样 unchecked，不用通用 resources 作为独立诊断的后备成功证据。这里 reset 清的是 OpenAPI 检查/操作历史，控制器内存的本机进程结果记录仍会合并，不代表处置被撤销。

FD 计数须为非负安全整数；全局 file_max>0 且 allocated≤file_max，PID 合法且唯一、fd_count 非负、soft_limit>0；进程 usage_pct 必须与 fd_count/soft_limit 的两位小数比率一致，不信任单独百分比。允许降低 soft limit 后真实计数超过上限（比率可 >100%，展示封顶但保留异常）。complete 还要求 fd.status=ok、全局/全部进程指标合法、coverage.complete=true、observed_processes 与有效进程数相等、denied_processes=0、truncated=false、reason 为空；缺失/非法/丢弃的行不能宣称完整或 normal。

FD execution：证据缺失或 component_not_installed 不设置；完整返回设 complete；已返回部分覆盖或部分合法数据设 partial；已尝试但失败、超时或无有效返回设 unavailable。partial 的合法 >90% 异常不被覆盖不足抹去；否则保留 unchecked/null。UI 和报告用“已检查 · 结论受限”或“已尝试 · 不可用”，不以 execution 将评分状态强改为 normal。resources 刷新仍保留原 execution/结论/体检时间。

`resource_anomaly --idc` 只读 statvfs、目录元数据和可见 FD 数/限额，不读 environ、配置、socket、FD 链接目标或文件内容；目录扫描不跨设备、不跟随符号链接并保持条目/深度/时间预算。每 PID 8192 FD 后仅一次额外条目 lookahead：恰好边界可完整，超限保留 fd_limit/truncated 且不提供虚假精确计数。FD 是压力快照，进程/FD 动态变化不等于泄漏趋势或泄漏证明。

当前 IDC 直接执行恢复 HEAD 的原生 `memgraph.py --graph --jsonstdout`，原生入口无 `--idc`，也不通过 `memgraph_idc.py`。默认 memcgLeak/memfrag/thpCollect、meminfo 等依赖及原生额外扫描全部保留，不再承诺 proc-only/read-only 或不启动插件；只在 IDC 输出侧过滤图计数，不能把过滤说成安全 profile。校验原生 `version=2.0`、total>0 与 0≤avaliable≤total，再保留有限非负 `total/avaliable/free/used/reserved/userUsed/kernelUsed/shmem`；其他插件结果和私有文本不导出。因原生插件系统可能吞掉插件失败，返回 `status=partial`、`coverage.native_plugin_coverage_unknown=true`；成功退出/有效 graph 都不证明全插件完整，缺图则不可用。解析器只按图压力判断阈值并在 evidence 明示未知覆盖，不覆盖独立资源总量或声称完整内存诊断正常。

原生 memgraph 7 路径修改已 stash（`13bca2d4e2994a4274b103ad89aca0ee0fb40e05`）并恢复 HEAD，native 目录 git diff 为 0；适配和 root 运行边界在 IDC/管家侧。此前 non-root 可替代性调查已成为 pre-root 历史，不再是当前禁止原生的约束。

日志 printk/journal_usage、PSI、vmstat、cgroup 可继续是非配置原始证据，但当前不据其生成 Debug 采样过密或专项健康结论；扩展需要独立规则和验收。confscan 与配置证据已从当前 SysAgent 链路移除，不保留内部调用。

#### fdleak 只读占用采集（后续源码新增）

fdleak 是 resource_anomaly 的子诊断，本轮新增参数不另建独立 `sysak fdleak` 命令：

```bash
sysak resource_anomaly --run fdleak --fd-usage
sysak resource_anomaly -j --run fdleak --fd-usage
sysak resource_anomaly --json --run fdleak --fd-usage
```

三种精确形式均直接输出 JSON，入口在 legacy 插件导入和 root gate 之前分派；拒绝额外参数、重复参数、PID/top/interval/focus、--all、--idc、其他诊断和报告输出路径，不扫描根目录、不执行完整泄漏诊断、不写报告、不自动提权。管家已有巡检仍固定使用 `resource_anomaly --idc`，本轮未添加新远端接口或独立 FD 页面。

| JSON 字段 | 含义 |
| --- | --- |
| schema_version / mode / read_only / status | 1.0 / fd_usage / true；全局 ok、partial、permission_denied、unavailable 或 error |
| system.file_max | 系统文件句柄总上限，来自 `/proc/sys/fs/file-max` |
| system.nr_open | 系统允许设置的单进程 NOFILE 上限，来自 `/proc/sys/fs/nr_open`；不是当前各进程的软限额 |
| system.allocated_file_handles / unused_file_handles / used_file_handles | file-nr 已分配、空闲与已用句柄；已用 = 已分配 - 空闲。不能用各进程 FD 数之和替代，共享句柄与描述符是不同数量 |
| system.usage_pct | 已用系统句柄与 file_max 的比例；极小比例按两位小数可能显示 0.0，但已用数量并不为 0 |
| processes[] | 可见进程的 PID、comm 名称、fd_count、fd_count_exact、fd_count_lower_bound、soft_limit/hard_limit、soft_unlimited/hard_unlimited、usage_pct、status 及不完整原因 |
| coverage | complete、observed_processes、denied_processes、truncated 和 reason；全部结果不等于宿主上不可见进程也已采集 |

复用有界只读采集：1.5 秒、最多 4096 个 PID、每进程 8192 FD 加一次额外条目 lookahead。只有读到目录 EOF 才设置精确 fd_count；超限/超时只提供已观察下界，精确数量和占用百分比保持 null。权限不足、进程消失、缺字段或坏数据不填 0；unlimited 用 null 与对应布尔字段表示，不输出 Infinity。只读取 `/proc` 的 comm、limits 和 FD 目录条目，不读取 FD 链接目标、cmdline/environ、socket 状态、配置或文件内容。快照非原子、不构成泄漏趋势分析。file_max 可能超过 JavaScript 安全整数范围，外部消费者应采用无损整数解析；当前 JS file-max 精度/真实趋势尚未修复。217/129/88 是 pre-root non-root 历史，root 可能减少 denied，不能据此宣称当前完整覆盖；所有 SysAgent/IDE 发起命令仍走固定 root helper，独立 CLI 的 ordinary 可用性不是回退路径。

### 11.3 规则与评分

当前评分仍使用前端兼容公式，并非已经完成生产评分服务：

```text
n = 重要诊断项总数
m = 其他诊断项总数 + 当前可见、有效且非 null 的资源百分比项数
x = 已检查的重要项中 usage > 90 的数量
y = 其他诊断 abnormal 数量 + 有效资源 usage > 90 数量
score = clamp(20 + (80 - x*80/n) - y*20/m, 0, 100)
```

n/m 为 0 有保护；null 不作为 0 参与资源评分，package W 不作为预算百分比计入。未知诊断仍可能进入分母，因此高分只表示已知项，不能授予“全部正常”；源码提供“仅已知项评分，未知不代表正常”及无可用评分证据提示；当前真实 FD partial/unchecked 卡片与详情已验证，其余评分空缺/UI 场景仍待验收，范围见第 16.1 节。FD 部分覆盖且没有合法已知 >90% 异常时仍 unchecked，显示“已检查 · 结论受限”不改变评分；已知高占用保留 abnormal 并参与既有公式，不能以部分覆盖抹掉异常。

真实评分规划：

1. 先定义每项适用性、数据有效性、严重程度、阈值和采样窗口。
2. 服务端统一计算并返回分数分解和覆盖率，前端只展示。
3. 未支持、无权限、未检查不能等同正常；数据不足不授予“满分健康”。
4. 同一问题在资源超限与诊断项中重复出现时，明确是否重复扣分。
5. GPU 不适用、删除旧配置占位、增加新诊断时，规则版本与分母同步变化。
6. 规则更新或复检结果可以改变建议，不自动执行处置。

## 12. Agent、Session、历史与告警对接

### 12.1 Agent 名称筛选已实现；可信 Agent/Session 集成延期

源码 `recognizeAgent` 对进程 comm 转小写后做精确键匹配，不读 cmdline/environ，不作子串/泛化运行时推断：

2026-11-10 调研 35 项产品/形态并补查 Mistral Vibe，当前源码包含 39 个精确名称、35 种显示标签，不声称穷尽市场。官方二进制名、CLI 命令入口和本机实际 comm 是不同证据；以下是名称候选，不保证所有安装方式都使用这些 comm。只对明确长二进制 basename 的 15 字节截断做精确键匹配，不使用任意前缀。

| comm 键 | agentKind 标签 | 名称依据 |
| --- | --- | --- |
| qoder / qoder-cli / qodercli | Qoder / Qoder CLI | [安装文档](https://docs.qoder.com/cli/installation)、[SDK 本地 qodercli](https://docs.qoder.com/cli/sdk/how-it-works)；qoder 本机已观察 |
| qoderwake / qodercli-wake | QoderWake / QoderWake CLI | [Wake 文档](https://docs.qoder.com/qoderwake/cli-reference)；两个 comm 均已在本机观察，不与 QoderWork 混同 |
| workbuddy | WorkBuddy | [官方产品](https://www.workbuddy.cn/)；用户指定的名称候选，真实安装包 basename 仍待核验，临时同名进程用于筛选测试 |
| codebuddy | CodeBuddy | [CLI 文档](https://www.workbuddy.cn/cli/) |
| claude / claude-desktop | Claude Code / Claude Desktop | [CLI 安装](https://code.claude.com/docs/en/setup)、[桌面文档](https://code.claude.com/docs/en/desktop-linux)；标签不表示正在执行 Cowork 任务 |
| codex / codex-agent / codex-x86_64-un / codex-aarch64-u | Codex | [官方二进制](https://github.com/openai/codex)；后两项为 Linux 15 字节 basename 候选，不是宽泛前缀 |
| cursor / cursor-agent | Cursor / Cursor Agent | [CLI 文档](https://cursor.com/docs/cli/installation)；不收录其通用命令 agent |
| aider | Aider | [安装文档](https://aider.chat/docs/install.html)；Python 启动方式可能只显示解释器 |
| gemini | Gemini CLI | [安装文档](https://geminicli.com/docs/get-started/installation/) |
| opencode | OpenCode | [官方文档](https://opencode.ai/docs/) |
| goose | Goose | [安装文档](https://goose-docs.ai/docs/getting-started/installation) |
| copilot | GitHub Copilot CLI | [官方 CLI](https://github.com/github/copilot-cli) |
| kimi | Kimi Code CLI | [安装文档](https://www.kimi.com/code/docs/en/kimi-code-cli/guides/getting-started.html) |
| qwen | Qwen Code | [CLI 文档](https://qwenlm.github.io/qwen-code-docs/en/users/quickstart/) |
| auggie | Augment | [CLI 文档](https://docs.augmentcode.com/cli/setup-auggie/install-auggie-cli) |
| cline | Cline | [安装文档](https://docs.cline.bot/getting-started/installing-cline)；不识别共用编辑器宿主 |
| kilo | Kilo | [CLI 文档](https://kilo.ai/docs/code-with-ai/platforms/cli) |
| antigravity / agy | Antigravity / Antigravity CLI | [官方归档与 CLI](https://antigravity.google/docs/getting-started/)；官方 Antigravity 归一化为小写键 |
| openclaw | OpenClaw | [安装文档](https://docs.openclaw.ai/install)；不猜测 gateway 进程 title |
| kiro-cli | Kiro CLI | [安装文档](https://kiro.dev/docs/getting-started/installation/)；不收录通用旧命令 q |
| amp | Amp | [CLI 文档](https://ampcode.com/docs/cli) |
| droid | Factory Droid | [CLI 文档](https://docs.factory.com/reference/cli-reference) |
| junie | JetBrains Junie | [CLI 文档](https://junie.jetbrains.com/docs/junie-cli.html)；不把共用 java 进程标为 Agent |
| openhands | OpenHands | [CLI 文档](https://docs.openhands.dev/openhands/usage/cli/installation)；容器/Python 宿主可能漏识别 |
| devin / devin-desktop | Devin CLI / Devin Desktop | [CLI](https://docs.devin.ai/cli)、[Linux 桌面启动命令](https://docs.devin.ai/desktop/getting-started) |
| windsurf | Windsurf | [历史 CLI 启动名称](https://www.deployhq.com/guides/windsurf)；保留旧版候选，与 devin-desktop 区分 |
| crush | Crush | [官方二进制](https://github.com/charmbracelet/crush) |
| warp | Warp Agent CLI | [Agent CLI](https://docs.warp.dev/agents/cli/quickstart/)；不将普通 warp-terminal 进程统归为 Agent |
| vibe | Mistral Vibe | [官方 CLI 启动命令](https://docs.mistral.ai/vibe/code/cli/install-setup) |

调研但未凭空增加 comm 的产品包括 [TRAE](https://docs.trae.ai/ide/get-started-with-trae-desktop?_lang=en)、[Roo Code](https://docs.roocode.com/getting-started/installing)、[QoderWork](https://qoder.com/en/download) 和 [Manus](https://manus.im/docs/features/desktop)：缺乏明确独立 Linux 进程名或本机 Linux 形态。Continue 的 cn、Pi 的 pi 与通用 agent/q 名称易冲突，未仅凭这些短名称识别；编辑器扩展和云端 Agent 不因共用 code/node/python/java/electron 宿主被归类。后续应通过可信探针而不是读取可能包含凭据的 cmdline/environ 扩展识别。

这只是启发式名称白名单，可漏识别（例如 comm 仅为 node/python 的包装程序），也可能被同名程序命中；不把 node/python 一律判 Agent，不证明产品真实性、业务状态或 Session 归属。collected 行可带 agentKind，但不携带 agentId/sessions；过滤计数仅代表已返回并命中的有界行，不是全机 Agent 数。OpenAPI 保留总体 Top20 与 Agent Top20 去重并集，保证总体 Top10 外的高排名 Agent 仍能参与先过滤后的 Top10 展示。

collected 白名单命中的进程也可在本机安全 check 合格后手动确认结束整个进程，不是 Session 级处置；标签不绕过 UID/manager/桌面/系统保护。GPU 设备与 RAPL package 不提供会话归属或进程结束。AgentSessions、业务 Token、文件关联与探针尚未接入，独立离线样本不能作为探针结果。

后续由应用侧探针提供：Agent 稳定 ID、运行状态、队列与心跳、Session ID、活动/空闲/完成状态、业务计数、工作目录或存储对象引用。

与系统证据关联时：

- 进程身份至少绑定 PID、starttime、设备和进程作用域；跨重启身份还需 boot 标识等证据，当前需补充。
- Session 与进程、cgroup、文件对象分别关联，不假定一个 Session 等于一个 PID。
- Token 数据来自可信业务计数，不从 CPU 或日志占用反推。
- 运行资源和磁盘资源分别授权；删除会话产物不等于结束会话。
- “空闲”不自动证明无依赖，“已完成”不自动允许删除用户产物。

### 12.2 历史采集

当前 inspection 按用户配置定时执行，默认 5 分钟，也可人工触发；resources 用于初始化与手动刷新，渲染轮询只读缓存。历史指标需要另行设计轻量采样与存储频率，按成本和目标时效确定，不能把页面轮询作为后台采集触发器。

历史点必须包含时间、设备、作用域、单位、有效性和采样窗口。断网/暂停/不可用产生空缺点，不插入 0 或固定演示序列。服务端聚合明确平均、最大或末值，前端不随意缩放模板生成趋势。

### 12.3 告警状态

规划状态为 pending/firing/resolved，通知读取告警状态而非自行从固定样本生成：

- 进入阈值需持续条件或多次有效样本；退出使用恢复条件，避免抖动。
- 告警键绑定设备、规则、资源/对象和作用域，重复样本更新同一事件。
- 暂停或缺失数据不自动标记恢复。
- 用户关闭通知只改变通知确认状态，不清除故障或诊断。
- 悬浮小管家只接收主渲染模型摘要，不启动第二个采集调度器。

## 13. 真实清理与优化闭环

### 13.1 已实现的本机进程处置与仍只读的 OpenAPI

旧 collected `health:operation`/`/api/idc/operations` 仍只允许 inspect；OpenAPI 的 cleanup/optimize/sessions-cleanup/alert-sample 仍在 revision 校验后 409 read_only，不创建任务、不改状态，也没有远端进程执行权。采集 capabilities 保持 read_only。离线 HTML 的 Demo 变换独立保留。

最新源码的真实本机窄闭环已实现：用户在 CPU/内存/disk 行选择合规进程 → 本机 prepare 再次 check → 60 秒单次 token → 二次确认 → 专用 sysAK terminate → pidfd SIGTERM 逐项结果 → UI 强制全量资源刷新。原始 PID+starttime 与本机新鲜校验决定 cleanable，不信任 remote 标志；token 绑定 revision/目标且先消费后执行。暂停、过期、身份变化或受保护对象拒绝，结果不明阻止重复提交。详细契约、安全策略和 UI 见 4.5、6.1.1、9.4。

这不是完整优化/修复：不结束 Session、不删除文件、不任意关闭他进程 FD、不改参数、不发目标 SIGKILL、不提权 Electron/IDE，也不因 sysAK root 执行扩大目标权限；用户没有授权结束其他用户或 root 目标，不承诺 exited/freed/磁盘空间回收。root watchdog 的 collector SIGKILL 是执行生命周期收尾，非业务处置。SIGTERM 可能中断任务并丢失未保存数据；新采样只显示现状。冻结 0.2.10/0.2.9 与 pre-root UI 的确认执行仅针对当时自建临时目标，无生产进程处置；不外推为本阶段 root 安装/授权黄金路径通过。两个开发 bundle 已校验，0.2.11 三包已构建，本地归档及桌面、Chrome、真实 IDE unavailable 验收通过，未实际安装；本阶段回归和历史失败分支证据见 16.1。

### 13.2 未来完整处置/远端协调时序（规划）

```text
有效采集与诊断
  → 用户选择建议/对象
  → OpenAPI 生成结构化计划
  → 前端显示风险、对象、影响、权限和有效期
  → 用户确认
  → 本地再次核验设备、对象和当前状态
  → 固定白名单动作执行
  → 上传分动作回执
  → 再次采集
  → OpenAPI 复检
  → 分别显示执行结果和效果验证
```

### 13.3 未来通用计划约束（规划，不替代当前本机 token）

最小计划字段：plan_id、device_id、base_revision、expires_at、action_type、object_refs、preconditions、risk、expected_effect、required_permission、rollback_supported、verification_rule。

动作类型与实际操作参数需逐项评审；不在当前采集命令中顺带加入清理逻辑。

- 对象必须来自可信发现和归属，不能由前端自由传入任意文件路径。
- 进程需核验稳定身份和业务状态，拒绝 PID 已复用或对象已变化的计划。
- 文件操作核验目录范围、对象身份、活动占用、符号链接和依赖；不可恢复删除需明确告知。
- 参数修改需声明旧值、目标值、适用范围、权限和复检；不可将失败回滚包装为成功。
- FD 不支持从管家任意关闭另一进程的文件描述符；应通过受支持业务接口或经评审的受控处置策略处理。
- 受控恢复/restart 不能承诺任务断点续跑，除非业务本身提供并验证恢复能力。

### 13.4 当前结果与未来执行状态

当前本机返回逐项 signalled/protected/permission_denied/stale/gone/unsupported 与 refresh_required=true；只合并本地操作记录，不生成远端 execution_id，不推进 revision 或扣减 usage。signalled 不是 exited/freed；失联/超时返回 PROCESS_RESULT_UNKNOWN，单次 token 不可重放，先刷新核对。

未来通用执行任务建议使用：accepted → awaiting_local → executing → succeeded/partially_succeeded/failed；验证另有 pending/passed/failed/inconclusive。以下业务结果/网络幂等与效果验证仍为规划，不以当前 SIGTERM 回执声称已经实现。

每项动作记录开始/结束、前置检查、权限结果、退出/业务结果、受影响对象和安全错误。网络回执丢失通过 execution_id 重试或查询，不再次执行动作。

“动作成功但指标未改善”与“指标改善但动作失败”是不同事实，都不能覆盖成统一成功。

## 14. 安全、隐私与生命周期

### 14.1 当前已实现安全措施

- 私有组件清单、SHA-256 与架构检查，打包白名单不携带源码仓库、无关工具或凭据。
- sysAK/helper 不设置 setuid，不改变 Docker 权限；普通 Electron/IDE 保持普通权限。固定安装的 helper/bundle 为 root-owned，逐祖先拒绝 symlink/non-root owner/group-other write；不存在用户可写代码获 root 执行的回退。
- 全部应用 sysAK 发起统一经 `sysak-root.cjs` 的固定 pkexec/helper；本地/installed manifest 与文件 hash 必须匹配，helper 再核验身份/路径/hash/执行期限并清空 env，仅 PATH/LANG/no-bytecode/PKEXEC_UID；不开放任意命令/路径/UID。原生 memgraph 不冒充安全 profile/read-only，输出仅有限图计数/partial/覆盖未知，细则见 4.4。
- 采集 35 秒/进程动作 15 秒包含授权等待，验证前后防晚授权，root watchdog 30/10 秒加 1 秒 collector-only SIGKILL；普通进程取消无法保证立即杀 root collector，丢弃结果等待 watchdog。未加入 polkit passwordless policy，未实际安装/系统授权/发布。
- 本地 IPC 来源检查、回环 Host/同源约束、JSON 和大小限制。
- Mock 私有随机 token，不暴露给 renderer；服务端使用固定长度摘要比较。
- Mock 不记录完整原始快照或 token，也不将完整原始快照长期保存。
- 前端仅接收展示与回执；业务错误不返回未知异常栈。
- 专用本机进程 API 不经 OpenAPI 写路径；raw PID+starttime 与新鲜 check 覆盖本机 cleanable，准备 token 为 64 hex/60 秒/单次/current revision/enabled，renderer 不直接传 PID、路径或信号执行。
- root sysAK 进程 API 仅 pidfd SIGTERM；manager 必须为 genuine ancestor 且为 pkexec 原 caller 的 ordinary 进程，目标四项 UID 仍为原 caller，拒绝 root/异用户/混合或 root GID/能力进程，保护关键祖先、manager 树及桌面/系统进程，信号前有界二次核验保留。没有授权结束 root/其他用户目标，不支持 pidfd/无法核验时拒绝，无数字 PID kill、目标 SIGKILL 或 ordinary 回退；已发信号不可撤销，结果不明不重复执行。

### 14.2 出设备数据策略（规划）

接真实远端前必须落实：

1. 用户知悉并授权上传；本地采集开关与远端上传开关分开。
2. 对主机名、账号/进程标识、路径等制定明确最小化策略；当前 SysAgent 不采集配置内容，空 `configuration` 容器不是上传配置的授权。
3. 工具/文件白名单不等于完整脱敏；历史交付含配置采集能力，若处理其旧证据仍须独立审查，不把它作为当前采集需求。
4. 上传前过滤留在采集之外的独立边界，记录过滤策略版本和被省略项状态，保持证据可解释。
5. 不读取仓库配置、远端地址或脚本中的凭据用于新服务；使用环境变量或既有系统密钥机制。
6. TLS、认证刷新和设备归属校验；浏览器 bundle 和普通应用日志不保存凭据。
7. 未授权、凭据失效或隐私策略不匹配时阻止上传，不静默发送。
8. 原始采集文件和离线队列如保存本地，限制访问、容量和保留期。

### 14.3 安装、升级、卸载

**当前 0.2.11 root/原生构建阶段（2026-11-10，开发 bundle 校验通过，deb/AppImage/VSIX 已构建，本地归档及桌面、Chrome、真实 IDE unavailable 验收通过；未实际安装）：** `prepare-sysak.cjs` 的 REQUIRED_FILES 为 23 文件：dispatcher + 三命令 + 规则 + 18 模块；manifest 另计，共 24 文件。18 模块明确是原生 memgraph Makefile 完整 16 模块 + resource_anomaly 2 模块，不再带 `memgraph_idc.py`，10 文件/五模块清单仅为 pre-root 历史。两端开发 bundle 使用同一清单/哈希，模块直接位于 tools；无 confscan/其模块/配置 JSON/`confscan_lib/confscan_conf`。

```text
sysak
.sysak_components/tools/
├─ .sysak.rules
├─ idc
├─ resource_anomaly
├─ memgraph（原生 memgraph.py 入口）
├─ resource_anomaly_idc.py
├─ fdleak_metrics.py
├─ plugin_abnormalPackages.py
├─ plugin_anonTaskTop.py
├─ plugin_cache.py
├─ plugin_memcgLeak.py
├─ plugin_memfrag.py
├─ plugin_memgraph.py
├─ plugin_meminfo.py
├─ plugin_memleak.py
├─ plugin_podDetect.py
├─ plugin_system.py
├─ plugin_taskProc.py
├─ plugin_vmRssTaskTop.py
├─ plugin_skcheck.py
├─ plugin_appmem.py
├─ mem_utils.py
└─ plugin_thpCollect.py
manifest.json（另计，bundle 总 24 文件）
```

原生 Makefile `pymods` 保持完整 16 模块和 HEAD；prepare 只将私有 source staging 的原生 `python-dep{all}` 规则规范化为 `python-dep{python3}`，不改变仓库 legacy 全量构建语义。manifest 历史字段 `safe_profiles` 只记录固定 argv：resource_anomaly `['--idc']`、memgraph `['--graph','--jsonstdout']`，不是安全/覆盖 profile。

**固定 root 安装设计：** 独立资源 `/opt/SysAgent管家/resources/sysak-root-runner.py` 不属于 bundle 24 文件；桌面 package extraResources 包含它，安装脚本预检应用目录、资源目录及 helper/完整 23 文件/manifest，设置应用/资源目录 0755、资源 root:root（执行项 0755、规则/manifest 0644）。afterPack 在全部白名单/祖先预检通过后，将 appOutDir、resources 和 bundle 目录规范为 0755，按已检查 inode 修改，不改源资源或无关文件；安装脚本同样在完整预检后规范 APP_DIR，避免 0775 祖先被 root helper 拒绝。deb 依赖 Python 3、pkexec、coreutils；所有应用 sysAK 仅可使用固定 root-owned `/opt/SysAgent管家/resources/sysak`。运行时逐祖先禁止 symlink/non-root/group-other write，逐文件 hash 与本地 manifest 一致，helper 再验证后 exec timeout/sysak，详见 4.4。未加入 polkit passwordless policy，不将安装/授权偷偷作为开发构建步骤。

**AppImage/IDE 边界：** AppImage 临时挂载/解包目录和插件 dist 不是 root 执行源；它们仅用于本地版本/hash 核对，仍依赖事先受控安装的固定 helper/bundle。VSIX 不会自动安装系统 helper，也不提升 IDE 权限。没有匹配安装或授权时错误不可用，不自动 ordinary fallback。此次 0.2.11 deb/AppImage/VSIX 已构建，本地归档及桌面、Chrome、真实 IDE unavailable 验收通过；未执行安装脚本/系统授权、未改变已安装应用，已验证本地交付的 unavailable 分支，不宣称实际安装生命周期或 root 黄金路径成功。

**冻结交付与安装事实（pre-root 历史）：** 0.2.10 及旧 release 文件不改。以下 staging、28 文件清单、四命令、配置目录/权限与包内验收仅为各轮交付历史，不是当前白名单或 root 新结果；原 sysAK confscan 三处修改独立 stash 并恢复 HEAD，原生 memgraph 7 路径修改 stash `13bca2d4e2994a4274b103ad89aca0ee0fb40e05` 后恢复 HEAD，native 目录 git diff 为 0。

0.2.9 交付时私有组件已在 `/path/to/workspace/workspace/sysAK/out-idc-actions-rYyxXa` 选择性更新：仅重建 IDC/resource_anomaly，保留 dispatcher/confscan/memgraph；`prepare:sysak`/`verify:sysak` 已通过，最新 manifest/哈希已准备并校验，仍 28 文件、linux/x64、四个系统 Python 3 命令。0.2.9 Linux x64 deb/AppImage/linux-unpacked 已打包，三者组件及 app.asar 一致性、解包 deb 元数据/python3 依赖/postinst/postrm 与源码逐字一致及 `sh -n`、AppImage 真实 unsquashfs 归档权限、解包 deb 原生 UI 指定场景已验证（见 16.1）。实际已安装 `/opt` 应用与旧交付物未改，新旧并存；真实系统安装/升级/卸载与 AppImage FUSE 启动未执行。以下上一轮私有组件/staging/0.2.8 包事实独立保留，其 idc 不含最新独立进程 API，不能凭旧包 manifest 通过推断新增功能已入包。

上一轮应用私有 sysAK bundle 已扩展为 **28 个白名单组件文件及 manifest**：保留旧 21 个文件（sysak、idc、confscan、规则、6 个 Python 模块、11 个内部采集配置），新增 `resource_anomaly`、`memgraph` 两个安全入口脚本，以及 `resource_anomaly_idc.py`、`fdleak_metrics.py`、`memgraph_idc.py`、`plugin_system.py`、`plugin_memgraph.py` 五个 helper。manifest 的命令集合为 `[idc, confscan, resource_anomaly, memgraph]`，四个命令均声明使用系统 Python 3；`safe_profiles` 为 `resource_anomaly: ['--idc']`、`memgraph: ['--idc', '--jsonstdout']`。prepared `resources/sysak` 已验证 manifest、文件哈希及真实原生执行，`npm run verify:sysak` 通过。

上一轮选择性 staging 位于 `/path/to/workspace/workspace/sysAK/out-idc-package-7gfEod`，上一版带哈希的私有 bundle 保存在其 `previous-app-bundle` 目录。直接由 `source/sysak.c` 和 `source/sysak_exec.c` 编译 dispatcher；仅执行 idc、confscan、resource_anomaly、memgraph 的独立 Makefile，后两者通过命令行 pymods 限定 IDC 依赖闭包，DEPEND 限定 Python 3；resource_anomaly 的 Python 3 shebang 仅调整 staging 副本。仓库 legacy Makefile 的 `python-dep{all}` 保持原样，不更改全量构建依赖语义。未执行 configure、full build、global install 或提权，不扩大到整个源码树、不跳过哈希、不放宽权限。C 入口构建成功，既有格式/长度警告仍存在，不能据此声称 dispatcher 全量静态审计通过。

**`release/idc-0.2.9` deb/AppImage 已包含交付时的进程选择/基础 Agent 筛选/FD 执行语义并完成包内验证，但不包含后续 39 键扩展与 `--fd-usage`；既有 `release/idc-0.2.8` deb/AppImage 仍是上一轮只读基线，旧 0.2.8/0.2.7 不覆盖。** 其历史 deb 解包验证版本、python3 依赖、postinst/postrm、28 文件清单/哈希及当时 app.asar 的主进程、控制器、OpenAPI 和页面构建；普通用户启用沙箱运行通过当时真实 IDC→OpenAPI→渲染、只读拒绝、巡检配置及 360px 检查。保留这些证据但不外推新增能力，也不等同系统安装/升级/卸载，后者未执行。

- AppImage/deb 都依赖系统 Python 3，AppImage 并非完全无系统依赖。
- 历史 deb 安装脚本检查全部 28 个组件及 manifest，包含 resource_anomaly/memgraph 和五个 helper；命令/模块为 0755，配置/manifest/规则为 0644。沿用应用入口及 Electron sandbox 的现有处理，sysak 不设置 setuid。新增隔离测试验证全部组件缺失时在改权限前失败、完整组件恢复普通用户权限。
- 卸载由包管理器移除应用资源，脚本只注销对应应用入口，不删除用户数据或其他位置的 sysak。
- AppImage 不创建全局采集服务，用户移除该文件不代表用户数据被自动清除。
- 应用暂停/退出仅自动清理自有采集子进程，不触发业务处置；最新源码同时禁止新进程动作并使计划不可执行。主动确认的 SIGTERM 属独立链路，已发送不能撤销，退出须等待已开始的队列动作结束。

升级规划：组件验证完成后再启动新采集；启停与上传授权独立持久化；不自动重置服务端设备状态。未知或损坏的组件目录不通过强制删除规避验证。

当前组件哈希用于一致性和完整性校验，不等于发布签名、可信更新链或防管理员篡改；生产分发另需签名及来源验证。

### 14.4 可观测性（规划）

记录 request_id/task_id、阶段耗时、数据大小、采集完整性、错误码、重试与队列统计；禁止记录原始配置全文、认证头、完整私有子命令 stderr。

服务端关联日志按认证主体和设备隔离，执行审计记录授权和结果；脱敏诊断日志与用户可读错误分离。

## 15. 开发分期与模块改造清单

### 15.1 分期

| 阶段 | 交付 | 退出条件 |
| --- | --- | --- |
| 上一轮只读基线（历史） | 资源总量/Top20、根目录/FD/内存安全诊断、null/单位、只读拒绝与 revision；Node 505/0、Python 聚焦 73 及 0.2.8 包实测记录保留 | 仅证明当时源码/包，不包含新增进程/Agent/FD 功能；安装生命周期及其余场景仍未验收 |
| 0.2.9：本机受控进程/Agent/FD（历史交付） | overallTop20+AgentTop20（≤40，UI 先筛选再 Top10）、本机 check/单次确认 token/pidfd SIGTERM/结果与强制刷新、FD execution 语义已实现；build、完整 npm test 713/713（fail 0）、此前 Python 94、prepare/verify、0.2.9 打包/包内一致性及解包 deb 原生 UI 指定场景通过（16.1） | 真实系统安装/升级/卸载、AppImage FUSE 启动及剩余 UI/环境验收待完成；错误/断网/未知执行/刷新失败仅单测覆盖；不以旧包替代当前验证，不结束生产进程 |
| confscan 移除阶段（pre-root 历史，2026-11-10） | 三命令/五模块/10 组件及 manifest，614/69/12 原回归值保留（16.1）；空 configuration 容器暂留 | 已由当前 root/原生阶段取代，不外推旧 ordinary/proc-only/safe profile 约束 |
| 当前 0.2.11 root/原生 memgraph（已构建，unavailable 验收通过，2026-11-10） | 全部应用 sysAK 统一 root helper，普通 Electron/IDE 不提权；原生默认插件/扫描保留，graph 输出 native/partial/未知覆盖；原生 16 + resource 2 模块，23 必需文件 + manifest | 版本/开发 bundle 校验、桌面 build/打包、插件 build/typecheck/package 通过，三包已存在；本阶段 Node/Python 回归通过（详见 16.1）。本地归档及桌面、Chrome、真实 IDE unavailable 验收通过；未实际安装/系统授权/加 passwordless policy，不证明 root 黄金路径 |
| P0：远端与可靠性增强 | 认证、上传授权、设备归属、持久快照/任务、可恢复提交、scope/有效期增强 | 原始证据可追溯，上传经授权，断网不回落 Demo，重启状态可恢复 |
| P1：诊断与协调 | 规则版本/覆盖率评分、历史与告警；Agent/Session 延期后按可信探针独立接入 | 未知不等于正常，趋势真实，任务查询/重试无重复结果 |
| P2：完整处置与远端协调 | 扩展本机窄进程闭环之外的通用计划、授权、Session/文件/参数动作、远端执行回执与效果复检 | 各动作独立评审和验收，身份/权限/幂等/复检通过；无任意命令下发，不把 SIGTERM 当完整修复 |
| P3：专项与环境扩展 | 多设备细节、GPU/日志专项、升级和多发行版验证 | 独立探针、契约、权限说明和验收，不靠 Demo 补齐 |

当前已实现本机受控进程结束和名称 Agent 筛选，并统一应用 sysAK root 发起；不以可信 Session/完整修复/云端接入为前提，也不因 root 授权扩大目标到其他用户或 root。confscan 保持移除，不扩展未经授权的 Session/文件/参数动作。原生目录恢复 HEAD，IDC/管家侧适配；两端开发 bundle 已校验，0.2.11 三包已构建，本地归档及桌面、Chrome、真实 IDE unavailable 验收通过；未实际安装或系统授权。历史包与 pre-root 验收独立保留，root 黄金路径、安装生命周期/AppImage FUSE/其余 UI 环境仍待验收（16.1）。

### 15.2 改造位置

下表原有 UI/组件“通过”仅是 pre-root/冻结交付历史，本阶段归档及 unavailable 结果单列，均不作为当前 root 黄金路径结果；本阶段源码职责、23/24 文件清单与新增回归明确区分，0.2.11 本阶段 Node/Python 回归通过（详见 16.1）；本地归档及桌面、Chrome、真实 IDE unavailable 验收通过（16.1）。

| 位置 | 当前职责 | 后续改造/待验收 |
| --- | --- | --- |
| [collected-state.ts](../sysagent-idc/collected-state.ts) | 实际资源独立总量、overallTop20+AgentTop20/身份、package W；FD 计数/比率/coverage/execution 与 revision | 筛选/FD 边界回归已通过（16.1）；更多 scope/规则可追溯性待增强 |
| [openapi-service.ts](../sysagent-idc/openapi-service.ts) | 认证回环服务，调用实际解析器；revision/read_only/幂等/预算与原子提交 | 当前契约回归已通过（16.1）；远端认证/持久化另行实现，不改成任意执行器 |
| [openapi-contract.json](../sysagent-idc/openapi-contract.json) | v1 契约：外层 mock、state collected、simulated=false、nullable quantities 与只读能力 | 校验请求/响应、遗留操作拒绝；远端版本另行协商 |
| [idc-client.ts](../sysagent-idc/src/idc-client.ts) | IPC/本地 HTTP；专用 prepare/execute 类型与路由，旧 operations 仍只读拒绝 | 确认/不确定结果与强制刷新回归已通过（16.1），未知执行/刷新失败仅单测；retryable/远端任务受理另行增强 |
| [DesktopDemo.tsx](../sysagent-idc/src/DesktopDemo.tsx) | 当前快照初始化、缓存轮询与手动刷新 | collected/离线隔离、断网恢复与授权策略 |
| [CollectionStatus.tsx](../sysagent-idc/src/CollectionStatus.tsx) | 巡检配置卡片、周期编辑、上下次巡检时间；Electron 默认 5/配置 90 分钟、持久化及暂停/恢复已验证 | 保留 1–1440 范围及无首页横幅；其余浏览器/移动端场景待验收 |
| [health-data.ts](../sysagent-idc/src/health-data.ts) | nullable/单位、comm 精确白名单、先筛选再 Top10、execution 标签与兼容评分；collected 不求行和 | Agent/FD 语义回归及真实过滤/partial 文案已验证（16.1）；生产评分另行设计，Demo 变换不得覆盖本机可选标注 |
| [ResourceRankings.tsx](../sysagent-idc/src/ResourceRankings.tsx) | 全部程序/只看 Agent、合规进程选择/保护原因，无 Session 伪归属 | 当前选择/过滤与 360px 排行已通过原生 UI（16.1）；空列表等更多 UI 场景待验收，暂停约束回归已通过 |
| [HealthGuardPage.tsx](../sysagent-idc/src/HealthGuardPage.tsx) | 巡检/体检；prepare、确认/取消、逐进程结果、强制刷新与 refreshRequired 阻止重复；优化/Session 写仍禁用 | 确认/取消/旧 token 撤销/结果/刷新及真实 FD partial 文案已通过原生 UI（16.1）；过期等回归通过，未知执行/刷新失败仅单测；完整修复仍规划 |
| [HealthPerformance.tsx](../sysagent-idc/src/HealthPerformance.tsx) | 历史展示消费点 | 无真实序列不套固定模板；未来单位/空缺点 |
| [App.tsx](../sysagent-idc/src/App.tsx) | 页面与本机快照联动；`!offlineDemo && selectedDevice.local` 隔离本机真实宿主的 Demo Session 区域 | 初次 Demo Session 显示已修复、两端重建；桌面/Chrome/最终解包 VSIX 真实 IDE unavailable 均通过（16.1）；不伪造 Agent/Session/GPU 进程归属 |
| [idc-controller.cjs](../sysagent-idc/electron/idc-controller.cjs) | 固定采集/回环提交/串行调度；raw 身份+新鲜 check 标注；prepare token/执行消费/本地结果；旧写拒绝 | 安全/TTL/replay/revision/暂停/关闭/刷新回归已通过，跨资源同 ID 不匹配授权已修复（16.1）；远端与持久化另行增强 |
| [sysak-root.cjs](../sysagent-idc/electron/sysak-root.cjs) / [sysak-root-runner.py](../sysagent-idc/build/sysak-root-runner.py) | 统一固定 pkexec/helper/root-owned installed bundle；逐祖先 ownership/mode/symlink、manifest/hash、PKEXEC_UID、env/期限/watchdog | 采集 35 秒/动作 15 秒含授权，验证前后防晚授权；watchdog 30/10+1 秒 collector-only SIGKILL，不 ordinary fallback；实际安装/授权待验收 |
| [process-control.cjs](../sysagent-idc/electron/process-control.cjs) | 复用 spawnRootSysak，固定 idc --process-action argv、ordinary manager_pid/targets stdin、15 秒/64 KiB 与逐行校验 | root 不扩大目标 owner，PID+starttime/pidfd SIGTERM/token 保护保留；结果不明不重试，不以旧 UI 证明 root 黄金路径 |
| [main.cjs](../sysagent-idc/electron/main.cjs) / [preload.cjs](../sysagent-idc/electron/preload.cjs) / [demo-api.ts](../sysagent-idc/demo-api.ts) | 可信主窗口专用 process IPC 与开发回环 prepare/execute 路由；旧 operations 分离 | 当前来源/参数边界回归已通过，主窗口专用链路已原生 UI 联测（16.1）；更多来源场景待验收，不扩大到通用命令或远端执行 |
| [standalone-api.ts](../sysagent-idc/src/standalone-api.ts) | 独立离线 Demo；进程 prepare/execute 显式拒绝，旧 HTML 有历史构建/基础交互记录 | 当前源码完整测试已通过（16.1），完整离线 HTML 演示验收仍待完成；不调用本机采集/进程 API |
| [sysAK idc.py](file:///path/to/workspace/workspace/sysAK/source/tools/detect/generic/idc/idc.py) | 双采样/固定诊断，原生 memgraph 图过滤 native/partial/未知覆盖；root check/terminate 仅原 PKEXEC_UID ordinary targets、genuine ancestor manager/pidfd SIGTERM | 本阶段 IDC/root process Python 回归由主代理通过（计数见 16.1）；历史 69/49 与旧包 UI 不外推为实际 root 安装/授权 |
| [resource_anomaly_idc.py](file:///path/to/workspace/workspace/sysAK/source/tools/detect/generic/resource_anomaly/resource_anomaly_idc.py) | 根容量/目录下界、FD 数/限额；MAX_FDS=8192 后一次 lookahead 区分边界/截断；当前应用调用在 root collector 内执行 | 14 项与真实 partial UI 是 pre-root 历史，13 项为更早基线，不计本阶段新回归；FD 217/129/88 仅 non-root 调查，root 覆盖未实测，无配置/environ/socket/FD 目标读取，部分低占用不判正常 |
| [原生 memgraph.py](file:///path/to/workspace/workspace/sysAK/source/tools/detect/mem/memgraph/memgraph.py) / [Makefile](file:///path/to/workspace/workspace/sysAK/source/tools/detect/mem/memgraph/Makefile) | 恢复 HEAD；原生入口无 --idc，默认插件/额外扫描保留；IDC 直接 --graph --jsonstdout，非旧 memgraph_idc/proc-only/read-only profile | 7 路径修改 stash `13bca2d4e2994a4274b103ad89aca0ee0fb40e05`、native 目录 diff 0；覆盖未知，历史 memgraph IDC 11 项仅 pre-root |
| [prepare-sysak.cjs](../sysagent-idc/scripts/prepare-sysak.cjs) | 原生完整 16 + resource_anomaly 2 模块，18 模块/23 必需文件 + manifest 共 24；safe_profiles 只记录 argv，不含 confscan/配置 | 两端开发 bundle 校验通过，0.2.11 三包已构建、本地归档及桌面、Chrome、真实 IDE unavailable 验收通过；不跳过 hash，不改原生/legacy 全量 Makefile；installed root/helper 与运行验收仍独立 |
| [安装脚本](../sysagent-idc/build/after-install.sh) / [package.json](../sysagent-idc/package.json) | helper 为独立 extraResource，预检完整 23 文件/manifest + helper 并设置 root-owned，依赖 Python 3/pkexec/coreutils | 0.2.11 桌面包已构建，本地归档及桌面、Chrome、真实 IDE unavailable 验收通过；未实际安装/系统授权，不加 passwordless policy，不把 VSIX 或 AppImage 临时目录代码交 root |
| [backend 健康骨架](../sysagent-idc/backend/app/routers/health.py) | 旧固定数据/TODO，未接通 | 先确认是否复用，不能据此宣称已部署远端 |

以上列当前 root/原生源码职责与历史验证，不固定行号；0.2.10/0.2.9 和 pre-root 的组件/包内/UI 通过不外推为 root 黄金路径。版本/两个开发 bundle 校验、桌面 build/打包及插件 build/typecheck/package 已通过，0.2.11 三包已构建；本阶段 Node/Python 回归通过（详见 16.1）。本地归档及桌面、Chrome、真实 IDE unavailable 验收通过；未实际安装/系统授权，AppImage FUSE/更多 UI/环境仍待验收。

## 16. 测试与验收

### 16.1 历史验证说明

本机验证路径、机器及进程测量和历史交付细节已从开源副本中省略；本文不证明当前发行版通过验收。

### 16.2 下一阶段验收矩阵

| 类别 | 场景 | 验收要求 |
| --- | --- | --- |
| 采集 | 正常主机、容器、无 GPU、无 systemd、权限受限 | 范围和缺失明确；不将不可用转换为正常或 0 |
| 预算 | IDC 自有文件 64 KiB、4096 PID/16384 条目/2 秒、32 RAPL 域/1 秒、总输出 8 MiB；采集/动作 35/15 秒含授权，root watchdog 30/10 秒 +1 秒；子诊断 5 秒/8 MiB | 验证前后防晚授权；取消丢弃结果，普通 host 不保证立即杀 root collector；watchdog 只收尾 collector、不 SIGKILL 目标。原生扫描不沿用旧 proc-only 文件边界；有界排行/截断可追溯 |
| CPU/RSS/I/O | guest 重复、PID 复用、计数回退、实际时间异于 sample-ms、多核归一化 | CPU 正确排除 guest 双计、按 ticks/实际秒/cpu_count；RSS bytes/%；read+write B/s，均不求行和生成主机总量 |
| 容量 | MemTotal/MemAvailable 缺失、statvfs 保留块、根容量与高进程 I/O 不一致 | MemTotal−MemAvailable bytes，根 used/total/available 独立；缺失 null、不补 Demo/0 |
| GPU | 多卡 CSV、N/A、无驱动/无硬件、未知/不可读 | 无硬件与未知区别已实现并测试；更多硬件实测待完成。设备遥测及最高有效利用率，不提供 GPU 进程或 Session 归属 |
| 能耗 | 单点、回绕、范围不一致、package 与子域/psys 重叠 | 仅有效配对不重叠 package 平均 W；usage=null，不估预算/整机/进程能耗 |
| 固定诊断 | resource_anomaly --idc / 原生 memgraph.py --graph --jsonstdout、缺组件/超时/图非法；默认插件失败/额外扫描 | resource_anomaly 元数据边界保留；memgraph 原生非 proc-only/read-only、安全 profile，输出仅有限 graph/partial/覆盖未知，有效图不证明全部插件成功；无 arbitrary command 或 ordinary fallback |
| root 安装/授权 | 固定 pkexec/helper/installed bundle，本地与 installed manifest/hash，symlink/non-root/group-other write，授权取消/拒绝/晚授权 | 普通 Electron/IDE 不提权，绝不执行用户可写/AppImage 临时/插件 dist root 代码；helper 清空 env、PKEXEC_UID 仅来自 pkexec；无 passwordless policy；实际系统安装/授权黄金路径本阶段未执行 |
| 诊断一致性 | FD execution 缺失/complete/partial/unavailable、非法计数/比率/coverage、8192/8193 FD、部分低占用与已知 >90%、resources 刷新 | 工具缺失无 execution，尝试失败 unavailable；partial 低占用 unchecked/null但 UI 已检查结论受限，高占用异常保留；精确边界 lookahead 不误截断，无假 normal；压力快照非泄漏趋势，保留原体检时间/结论 |
| 认证 | 缺 token、过期、跨设备、跨主体 | 拒绝访问，无凭据泄露 |
| 网络 | 请求前失败、服务端已受理响应丢失、超时、429/5xx | 保留旧状态，稳定 ID 查询与有界重试，无重复动作 |
| 一致性 | 新 snapshot/reset、inspect 最新 revision、缓存 GET、重放、错误 | 初始 snapshot/reset=1；新的成功提交 prior+1，reset 不回退；inspect 必须最新；重放原结果且不覆盖 latest，错误不提交；跨重启恢复另行设计 |
| 只读拒绝 | 四种遗留写操作、过期 revision 与非法 raw 并存 | revision_conflict 优先于 read_only；匹配后 409 read_only，不解析写证据/建任务/改状态 |
| 任务 | 当前 200 completed/simulated=false；未来 202/取消另测 | 部署 mock 不等于模拟测量，不得将受理当执行；100 请求 FIFO 与任务淘汰保持 |
| UI | 初次无数据、null/W/B/s、overallTop20+AgentTop20/UI 先过滤再 Top10、进程选择/确认/取消、部分 FD、暂停/断网/离线/移动端 | 移除前历史原生 UI 已验证过滤/选择/确认/取消/旧 token 撤销/结果与刷新、真实 FD partial、当时 8 项诊断、无伪造历史及 360px 排行（16.1），不作为此次增量通过证据；错误/断网/未知执行/刷新失败仅单测覆盖，其余 UI/完整离线 HTML/环境待验收；无首页横幅，巡检默认 5 分钟/1–1440；无优化/Session/文件写或配置扫描/会话伪归属，不回落 Demo |
| 范围 | confscan 彻底移除 | SysAgent 无配置 profile、调用、内部 evidence、命令/模块/配置目录白名单或业务操作；仅暂留空 raw configuration 容器，历史交付记录不改写 |
| Agent 名称筛选 | 精确 comm 白名单、大小写、非白名单 node/python、Agent 在整体 Top20 外、空匹配 | 仅启发式 agentKind；保留 AgentTop20 并在过滤后 Top10，不伪造 Session/业务关联；名称不授予执行权限 |
| 可信 Agent/Session（未来） | 活动/空闲/完成、跨 Agent、PID 复用、文件依赖 | 探针稳定归属，保护活动与未知对象；目前不支持 Session 操作 |
| 本机进程安全 | root runtime、原 pkexec caller ordinary genuine ancestor manager，root/异用户/混合四 UID/GID/capability targets、关键祖先、pidfd/PID 复用及预算 | root 运行不扩大目标授权，目标仅原 caller ordinary 进程；仅 pidfd SIGTERM，无数字 PID kill/目标 SIGKILL/ordinary fallback；用户没有授权结束其他用户或 root targets；注入或获准隔离测试，不结束生产进程 |
| 本机确认/结果 | 1–10 ID、resource/revision、60 秒过期、token 单次/替换/启停、逐项拒绝、响应丢失和刷新失败 | 不接受远端 cleanable/自由 PID；先消费再执行；signalled≠exited/freed，强制资源刷新，结果不明阻止重复提交 |
| 历史/告警 | 空缺样本、阈值抖动、恢复、关闭通知 | 真实时间序列，缺失不恢复，通知不清故障 |
| 处置 | 计划过期、对象变化、权限失败、部分动作成功 | 执行前阻止或分项回执，不伪造统一成功 |
| 复检 | 动作成功但无改善、动作失败但指标变化 | 分开报告执行和效果 |
| 生命周期 | 安装、升级、暂停、退出、卸载 | 组件完整且 root-owned；暂停/退出取消并丢弃结果，但普通 host 不保证立即杀 root collector，由 root watchdog 有界收尾；不删业务数据/不影响其他 sysak；真实安装/授权未验收 |
| 分发 | 不同发行版、Python 缺失、签名校验 | 明确系统依赖与可支持环境，不绕过沙箱或修改权限来掩盖失败 |

### 16.3 推荐测试层级

1. 采集单元测试：依赖注入 procfs/sysfs、命令结果、计时和进程组，不对测试机器执行业务处置。
2. 解析测试：真实脱敏样本、精确单位、差分、scope、缺失和规则解释。
3. 契约测试：请求和响应均按机器契约校验；回环外层 mock/state collected/simulated=false、离线 Demo 和未来远端分别测试，覆盖遗留写操作 409 拒绝。
4. 集成测试：本地采集 → HTTP → 解析 → 展示；同时覆盖失败和取消。
5. UI 验收：桌面与开发网页黄金路径、离线 HTML、无 GPU、旧缓存、错误状态；实际浏览器操作不能由类型检查替代。
6. 打包测试：检查实际包的组件、契约、脚本、依赖和签名；只验证源目录不充分。
7. 真实处置测试：仅在明确授权的隔离测试环境，准备可验证的对象与恢复方式；不在用户当前业务环境默认执行。

## 17. 风险、待定事项与交付依据

### 17.1 主要风险

| 风险 | 处理方向 |
| --- | --- |
| 外层 mock 被误读为全 Demo，或专项样本被误读为真实 | 部署/数据模式分离：state collected、task simulated=false；专项/离线样本隔离，不回退 Demo |
| 排行和被当成主机总量、B/s/W 当成百分比 | 系统总量独立；overallTop20+AgentTop20≤40 有界，先筛选再 Top10；quantity/rankUnit 显式，不伪造 GPU/Session/能耗归属 |
| 容器指标被当成物理宿主指标 | 保留 scope，当前只按可见 procfs/cpu_count，不声称已有完整 cgroup 归一化 |
| 缺失/部分 FD 被当成正常或 0 | 当前模型已支持 null/status；部分 FD 低占用 unchecked，图缺依赖 null |
| reset 或刷新回退 revision / 覆写独立检查 | 新成功提交递增，reset 不回退；resources 保留 inspections；跨重启持久化仍待设计 |
| 冻结包/pre-root 验收或新包构建被误当 root 阶段验收通过 | 当前三命令/18 模块/23 必需文件 + manifest，版本/开发 bundle 校验及 0.2.11 三包构建通过，本阶段 Node/Python 回归通过（详见 16.1）；本地归档及桌面、Chrome、真实 IDE unavailable 验收通过，未实际安装/系统授权；pre-root 614/69/12 及旧 28/21 文件包/大小/链接/哈希/验收冻结，不改新合计、不证明 root 黄金路径 |
| 普通可写代码获 root 或取消失效 | 仅固定 root-owned helper/bundle，逐祖先拒绝 symlink/non-root/group-other write、manifest/hash 一致，不执行 AppImage 临时/插件 dist root 代码，不 ordinary fallback；35/15 秒含授权，前后验证防晚授权，root watchdog 收尾 collector；普通 host 取消不保证立即杀 root |
| root 采集被误当扩大目标处置授权 | caller UID 只来自 pkexec，manager genuine ordinary ancestor；目标仅原 caller ordinary，拒 root/异用户/capability，保留 pidfd SIGTERM/critical ancestry/token；未获其他用户或 root targets 授权 |
| 原生 graph 成功被当完整安全诊断 | memgraph 默认插件/额外扫描保留，非 proc-only/read-only；仅输出 native/partial/图计数/覆盖未知，safe_profiles 只是 argv；有效图不证明全部插件完整 |
| 请求丢失后重复执行 | 当前本机单次 token、逐项结果/不确定错误与 refreshRequired，不重发 terminate；远端 request_id/execution_id 查询和持久幂等仍规划 |
| 名称 Agent 标签/远端 cleanable 被误当执行许可 | comm 精确白名单仅过滤且可能漏/误命中；本机 raw 身份+新鲜 check 覆盖权限，无 Session 推断 |
| SIGTERM 被误写为 exited/freed 或自动修复 | 仅报告 signalled，强制资源采样核对；不删文件/目标强杀/提权 Electron/IDE，不因 root helper 扩大 owner 权限；watchdog collector SIGKILL 与目标区分，结果不明先刷新，旧包不证明当前 root 黄金路径 |
| 配置文本或私有路径出设备 | 上传授权、最小化、过滤、保留与访问策略 |
| PID/路径/Session 归属不可靠 | 稳定身份和执行前核验 |
| 服务端无限制原始数据留存 | 明确保留目的、预算、加密和删除 |
| 包哈希被当作可信发布证明 | 发布签名、下载来源、更新链单独设计 |
| 快照轮询造成大量重复上传 | 调度与渲染解耦、缓存、退避和流量预算 |
| 无计划执行任意“优化” | 结构化计划、本地白名单、明确授权、回执和复检 |

### 17.2 实施前待定事项

- 真实 OpenAPI 部署位置、实现技术栈；是否复用旧 FastAPI 骨架。
- 认证主体、设备注册/注销和凭据续期方式。
- v2 路径、业务字段及规则版本最终约定。
- 上传数据范围、脱敏方式、用户授权交互及各层保留期。
- 采集频率、任务查询间隔、退避预算和离线队列策略。
- 真实评分口径、缺失覆盖率、诊断严重程度和重复扣分处理。
- 哪些 Agent 提供探针、Session/文件/进程可信业务关联来源仍延期；当前精确 comm 白名单仅为已实现的启发式筛选，不代替探针。
- 本机受控 SIGTERM 的原生 UI 仅为 pre-root/冻结历史自建目标证据；当前 root process Python 回归见 16.1，实际 root 安装/系统授权及执行黄金路径未验收。root 不扩大 targets：仅原 caller ordinary，用户没有授权结束其他用户或 root。Session/文件/参数动作与自动修复未实现，不开放任意命令、不提权 Electron/IDE。
- 当前按三命令/18 模块/23 必需文件 + manifest（24 文件）与独立 helper 验收；两端开发 bundle 校验及 0.2.11 三包构建通过，本地归档及桌面、Chrome、真实 IDE unavailable 验收通过，未实际安装/系统授权/加 passwordless policy，不能把开发 bundle 或新包构建视为 root 安装。0.2.10 与旧 28/21 文件包的功能/大小/链接/哈希/验收冻结（16.1、17.4）。AppImage 临时/插件 dist 绝不 root 执行；真实生命周期/FUSE/多环境仍待验收。
- 历史 build、完整 npm test 713/713（fail 0）、Python 94 与进程/Agent/FD UI 通过记录见 16.1，不是此次文档更新或移除增量的新测试。本阶段包内 root-unavailable UI 已有桌面/Chrome 通过证据；其他错误/断网/未知执行/刷新失败仅有历史单测覆盖，其余真实 UI 失败分支、页面/null/W/B/s/完整离线 HTML/移动端/更多环境仍待验收。
- 支持的 Linux 发行版、架构、容器环境与更多 GPU 厂商/驱动/硬件型号；GPU 无硬件/未知区别已实现并测试，但不代表所有硬件已验收。

当前源码边界是“固定 root helper 的实际证据解析 + resource_anomaly IDC 元数据/原生 memgraph 图过滤与未知覆盖 + 启发式 Agent 筛选 + 仅原 caller ordinary 进程的确认 pidfd SIGTERM”。普通 Electron/IDE 不提权，无用户可写代码 root 执行或 ordinary fallback；远端/旧写操作仍只读，Session/文件清理/完整修复未实现。confscan 保持移除、raw configuration 仅空容器；原生 7 路径修改已 stash 恢复 HEAD，native diff 0，适配在 IDC/管家侧而非安全 profile。版本/两端开发 bundle 校验及 0.2.11 三包构建通过，本阶段 Node/Python 回归通过（详见 16.1）；本地归档及桌面、Chrome、真实 IDE unavailable 验收通过，未实际安装/系统授权/加 passwordless policy。16.1 分列当前静态归档、解包 Electron/插件 host Chrome/最终 VSIX 真实 IDE unavailable 通过与旧开发浏览器/pre-root/冻结验收；包内零错误结果与旧开发浏览器预期 503 观察分开，不证明 root 黄金路径通过。FD denied 可能因 root 减少，但 JS file-max 精度与真实趋势仍未修复。

### 17.3 关键源码与协议依据

当前源码及协议关键依据（不固定行号；版本/两个开发 bundle 校验及 0.2.11 三包构建通过，本地归档及桌面、Chrome、真实 IDE unavailable 验收通过，未实际安装/系统授权，当前 root 回归、pre-root 调查及冻结历史见 16.1）：

- [sysAK IDC 双采样、envelope、原生图过滤、预算及 root caller 进程校验](file:///path/to/workspace/workspace/sysAK/source/tools/detect/generic/idc/idc.py)。
- [resource_anomaly IDC 元数据入口](file:///path/to/workspace/workspace/sysAK/source/tools/detect/generic/resource_anomaly/resource_anomaly_idc.py)。
- [原生 memgraph 入口](file:///path/to/workspace/workspace/sysAK/source/tools/detect/mem/memgraph/memgraph.py) / [原生 Makefile 16 模块](file:///path/to/workspace/workspace/sysAK/source/tools/detect/mem/memgraph/Makefile)：恢复 HEAD，native 目录 diff 0，IDC 直接 --graph --jsonstdout，默认插件/额外扫描保留；旧 memgraph_idc 不在当前清单。
- [统一 root 桥接](../sysagent-idc/electron/sysak-root.cjs) / [固定 root helper](../sysagent-idc/build/sysak-root-runner.py)：pkexec/路径/owner/mode/hash、env/PKEXEC_UID、授权期限/watchdog、无 ordinary fallback。
- [实际资源与独立诊断解析器](../sysagent-idc/collected-state.ts)。
- [OpenAPI 校验、只读拒绝、同步提交、幂等与能力](../sysagent-idc/openapi-service.ts)。
- [OpenAPI 当前机器契约](../sysagent-idc/openapi-contract.json)。
- [本地控制器：raw 身份+check 标注、prepare/单次 token/execute 与串行生命周期](../sysagent-idc/electron/idc-controller.cjs)。
- [专用进程桥接：固定 argv、manager_pid/targets JSON stdin 与有界结果校验](../sysagent-idc/electron/process-control.cjs)。
- [sysAK 专用进程 API：有界 UID/manager 保护与 pidfd SIGTERM](file:///path/to/workspace/workspace/sysAK/source/tools/detect/generic/idc/idc.py)。
- [nullable/starttime/agentKind/execution 模型、精确白名单、先筛选后 Top10 与评分标签](../sysagent-idc/src/health-data.ts)。
- [进程选择/Agent 过滤](../sysagent-idc/src/ResourceRankings.tsx) / [确认/取消、逐项结果与强制刷新](../sysagent-idc/src/HealthGuardPage.tsx)。
- [组件白名单与发布校验](../sysagent-idc/scripts/prepare-sysak.cjs)：当前三命令、18 模块（原生 16 + resource 2）、23 必需文件 + manifest 共 24，safe_profiles 仅记录 argv，无 confscan/配置目录；见 14.3。两端开发 bundle 校验及 0.2.11 三包构建通过，本地归档及桌面、Chrome、真实 IDE unavailable 验收通过，不代表 fixed root 已安装/授权；旧 0.2.10/0.2.9 28 文件/四命令及 0.2.7 21 文件历史冻结（16.1、17.4）。
- [root 资源安装预检/ownership](../sysagent-idc/build/after-install.sh) / [helper extraResource 与 Python 3/pkexec/coreutils 依赖](../sysagent-idc/package.json)：0.2.11 桌面包已构建，本地归档及桌面、Chrome、真实 IDE unavailable 验收通过，本阶段未执行实际安装脚本或系统授权。

界面/桥接/构建源码依据（本阶段 build/typecheck/package、Node/Python 回归、包内 unavailable 验收与旧开发浏览器/pre-root/冻结包历史分别见 16.1。本地归档及桌面、Chrome、真实 IDE unavailable 验收通过；包内 Electron/插件 host Chrome 的零错误结果不与旧开发浏览器预期 503 观察混淆，不证明 root 黄金路径。未实际安装/系统授权，未知执行/刷新失败等更多 UI、生命周期/AppImage FUSE 仍待验收）：

- [主进程可信 IPC](../sysagent-idc/electron/main.cjs) / [preload 有限能力](../sysagent-idc/electron/preload.cjs) / [Vite 本地桥接](../sysagent-idc/demo-api.ts)。
- [巡检配置卡片](../sysagent-idc/src/CollectionStatus.tsx) / [首页巡检入口](../sysagent-idc/src/HealthGuardPage.tsx)：包内 unavailable 分支结果见 16.1，不外推 root 授权采集。
- [共享 App 的 Demo Session 隔离](../sysagent-idc/src/App.tsx)：`!offlineDemo && selectedDevice.local` 修复后两端重建；Chrome unavailable 已通过，最终解包 VSIX 的真实 IDE unavailable 验收也已通过（16.1）。
- [单文件 HTML 离线别名](../sysagent-idc/scripts/build-html.mjs) / [独立离线客户端](../sysagent-idc/src/standalone-api.ts)。
- [打包依赖与资源设置](../sysagent-idc/package.json)。

### 17.4 历史交付说明

历史本机交付路径与诊断记录已省略；当前版本的源码及发布件范围见根目录 README。
