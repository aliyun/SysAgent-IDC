# SysAgent 管家 IDE 插件

**当前版本 0.2.17，配套 AgentSight 0.16.0，扩展标识 `sysagent-local.sysagent-ide`。** 插件在编辑器面板和状态栏中展示本机资源与 Agent 诊断，与桌面版共用诊断逻辑；不提供系统桌面悬浮窗口。0.2.17 双端构建成功，隔离 AppImage 原生验收 30/30、IDE 原生验收 24/24 通过；未重新安装系统服务或发起模型调用。

## 安装前准备

- 使用[当前发布目录](../sysagent-idc/release/idc-0.2.17-sysagent-20261113/)中的 `SysAgent管家-0.2.17-linux-x64-offline.tar.gz` 完整离线包，不要混用旧 deb 或旧 VSIX。
- 运行时要求 Linux x86_64、glibc 2.38+；完整系统资源采集还需 systemd、Python 3.9+ 和 Linux pidfd 支持。其他发行版需自行核对依赖。
- IDE 需要 VS Code API 1.85+，支持 VS Code、Qoder IDE 等兼容宿主。Qoder Desktop 独立应用和 JetBrains 不支持该 VSIX。
- 使用发布包不需要 Node.js、npm、Rust 或开发后端。安装系统 deb 需要管理员授权，IDE 必须以普通用户运行。

## 快速开始

解压完整离线包，在解压目录打开终端。先彻底退出旧 SysAgent 和旧插件客户端，再以将要使用插件的普通用户执行：

```bash
sha256sum --check SHA256SUMS
sh ./install-debs.sh
```

安装入口使用 `dpkg --install` 安装两个本地文件 `sysagent-idc_0.2.17_amd64.deb` 和 `sysom-agentsight-runtime_0.16.0_amd64.deb`，不联网下载，并可重新安装同版本包。主 deb 提供系统采集服务，runtime deb 提供独立 AgentSight；VSIX 不替代这两个系统包。缺系统依赖时不会自动补齐或回滚，请由管理员补齐后重跑入口。

在 IDE 命令面板选择 **Extensions: Install from VSIX… / 扩展: 从 VSIX 安装…**，选择 `sysagent-ide-0.2.17.vsix`，按提示重载 IDE。VS Code 用户也可执行：

```bash
code --install-extension ./sysagent-ide-0.2.17.vsix
```

点击状态栏 SysAgent 入口，或执行 **SysAgent管家: 打开体检主页**（`sysagent.openHome`）；命令面板还提供巡检入口（`sysagent.inspect`）。不需要同时启动桌面应用。

## Agent 诊断

进入 **Agent 管家** 查看桌面与 IDE 共用的“本机 Agent 诊断”，前置结论与归组问题，可直接查看证据。四张 KPI 显示近 24 小时已采集会话数、已记录输入/输出 Token 和未处理中断，缺失为 `—`。会话与 Token 包含辅助调用，输入已含缓存用量；不是会话终身累计，上游未报告用量可能未计入，`0` 仅表示来源记录为零。报告缓存超过 60 秒后重新获取，手动刷新不使用缓存。数据服务连通不等于真实调用采集已开启。

- **总览**（默认）：结论、按类型归组的待关注问题、实测延迟和进程探活。进程支持名称/PID 搜索、角色/状态组合筛选及每页 20 条分页，筛选回第一页；本地操作不追加采集或改变顶部统计。HTTP 响应不是业务健康结论，正常 CLI 无端口不算异常。
- **会话**：本地 Agent / ID / Model 搜索，按最后活跃时间降序、同时间按 ID 排序；搜索不改变全窗口 KPI。展开仅显示首末时间和关联中断元数据，不获取对话正文。
- **中断**：紧凑事件表和只读九字段证据弹窗（事件 ID、类型、严重度、发生时间、Session ID、Call ID、PID、Agent、处理状态）。只在报告已有关联会话时提供跳转；不额外请求或更改处理状态。
- **延迟**：可选 E2E P95 / TTFT P95 / TPS P50 实测对比；完整调用表保留完整/流式调用数及 TTFT P95、E2E P95、TPS P50、TPOT P95。TTFT / TPOT 仅适用于流式调用，不自行设故障阈值。

**数据范围**仅展示统计时间、更新时间与五类数据覆盖状态，不透出内部部署参数或原始错误；授权与部署说明见本文下方。停用采集保留历史；刷新失败保留上次报告并明确标为“旧结果 · 刷新失败”，更新中也标明尚未更新。不直接获取正文、不推断 Session 独占 CPU/GPU 归属、不自动修复、部署或发起付费调用；空列表不等于健康。

<details>
<summary>部署与采集授权（安装者阅读）</summary>

插件通过独立 AgentSight 获取证据，再由本地 OpenAPI 分析。首次启动检查并复用已有可用 API，或者从独立配套件准备缺失文件后启动 `agentsight serve`。默认用户目录为 `~/.local/share/sysom/agentsight/`；绝对路径 `XDG_DATA_HOME` 会改变存储位置。桌面和 IDE 在相同 HOME/XDG 下共享该目录；已有配置、二进制和数据不会被启动流程覆盖。

只需要 Agent 诊断时，可在离线包目录单独安装 runtime deb，再安装 VSIX：

```bash
sudo dpkg --install ./sysom-agentsight-runtime_0.16.0_amd64.deb
```

此方式不提供系统资源采集服务。完整资源、巡检和受控进程操作仍需按快速开始安装主 SysAgent deb，并完成普通用户授权。VSIX 不内嵌 AgentSight 二进制。

API 启动不代表开启真实采集。独立 systemd 采集需要本批次两个 deb，并显式授权：`sh ./install-debs.sh --enable-agent-collection`。该选项明确接受主机级明文/参数采集与本地完整会话保存，不能严格限定进程；敏感、多用户机器保持关闭，不因 `traceEnabled:false` 获得本地内容脱敏，也不自动发起付费模型调用。

已授权后，独立 trace/API 两服务开机自启，使用相同普通 UID 和专用数据目录 `/var/lib/sysom-agentsight/<UID>`；只有 trace 服务获得 eBPF 所需 capabilities。专用 API 使用回环端口 7397，不替换原有 7396 部署。桌面或 IDE 启动通过受控服务检查/启动，退出插件不停止采集；已有用户配置不被改写。仅安装 runtime deb 不建立主 SysAgent 授权，因此自动服务启动需按快速开始安装两个 deb。

托管数据库合计容量的周期性清理目标为 50 MiB（不是硬磁盘配额）；WAL 增长、忙锁和保留空页可能使实际占用超过目标。trace 服务包含兼容本机 perf 安全策略所需、权限较大的 CAP_SYS_ADMIN；API 与 IDE 不获得此能力。托管配置带有常见 Agent 的匹配规则，匹配不等于严格进程隔离，其他客户端或不支持的协议可能无法形成记录。

诊断页独立显示真实采集状态。未授权默认只运行普通 API；没有历史时列表可为空，缺失或不可用不等于健康。停用并保留数据可执行 `sudo /usr/bin/python3 -I /usr/share/sysom/agentsight-runtime/agentsight-collection.py disable`；原有 BIN / CONFIG / URL 环境变量指定的独立部署仍优先，不强制切换。回环 API 沿用 AgentSight 访问规则，不应作为多用户鉴权边界。诊断不会自动重启 Agent、修复故障或提供 Session 独占资源归属。

</details>

## 日常使用与排错

- 插件读取本地扩展宿主机器，不自动诊断远程工作区；部分远端设备、日志和事件仍是演示，不能当作本机真实证据。
- 桌面与 IDE 的巡检设置各自保存；缺匹配系统采集服务时，系统资源和巡检操作可能不可用，Agent 诊断仍是独立链路。
- 提示缺配套件：安装本批次 runtime deb，或重新运行双 deb 安装入口，再重载 IDE。
- 系统资源不可用：检查 `systemctl status sysom-idc.service --no-pager`，确认以目标普通用户执行安装入口。直接以 root 登录安装没有普通用户身份，不是默认推荐方式。不要用 sudo 启动 IDE、修改免密规则或禁用完整性校验。
- AgentSight 启动失败、鉴权拒绝或端口冲突：检查既有部署，不删除配置或结束未知进程，不公开令牌或完整配置。
- 系统库缺失时安装会失败而不会下载；请先由管理员准备兼容库。
- 系统进程清理需要确认，可能中断真实任务；Session/文件自动清理、自动修复和远程执行不在本次使用范围。

## 更多说明与许可

详细桌面、AppImage、首次启动和排错说明见完整离线包根目录的 README。历史开发记录中的包路径不作为当前安装入口。

开发者需单独准备依赖，再在插件源码目录运行 `npm run typecheck` 和 `npm run build`；共用页面或 host 改动后需要分别构建桌面与插件。根目录早期 Demo 发行脚本不作为当前真实版发布流程。

原创代码采用 MIT。插件包中包含 LICENSE.txt、THIRD_PARTY_NOTICES 和 FONT_LICENSE；源码保留 LICENSE、第三方声明和字体许可。AgentSight 与 SysAK 保留各自许可，不由 SysAgent 的 MIT 协议重新授权。
