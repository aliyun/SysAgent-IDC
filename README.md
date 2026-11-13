# SysAgent 管家

SysAgent 是面向 Linux 工作站的本地资源与 Agent 诊断工具，提供 **Electron 桌面应用**和 **VS Code 兼容 IDE 插件**。

- 查看本机资源、进程和体检结果，执行有界诊断。
- 分析已采集的 Agent 会话、中断和调用延迟，优先展示诊断结论与证据。
- 桌面与 IDE 共用诊断逻辑，不需要同时运行两个客户端。
- 提供本机只读 HTTP API，供其他工具查询已缓存的诊断结果。

系统资源诊断使用 SysAK 与本地 IDC 服务，Agent 诊断使用独立的 AgentSight 运行时。服务不可用或证据缺失时会明确提示，不把空数据当作健康结论。部分非核心页面仍含演示内容，详见[功能指南](./docs/FUNCTION-USER-GUIDE.md)。

当前版本：**SysAgent 0.2.17 / AgentSight 0.16.0**。

- [快速开始](#快速开始)
- [安装与首次运行](#安装与首次运行)
- [Agent 采集与隐私](#agent-采集与隐私)
- [开发与测试](#开发与测试)
- [常见问题](#常见问题)
- [源码交付与许可](#源码交付与许可)

## 快速开始

### 1. 准备环境

| 场景 | 要求 |
| --- | --- |
| 构建 deb 与 VSIX | Linux x86_64 / amd64、Node.js 20+、npm、`dpkg-deb`，建议至少 3 GiB 可用空间 |
| 首次构建 | 联网安装 npm 依赖及下载 Electron 打包工具 |
| 运行桌面应用 | Linux x64 图形桌面、glibc 2.38+；建议 Ubuntu 24.04 x64 |
| 系统资源采集 | systemd、Python 3.9+、可用的 Linux pidfd 支持 |
| 运行 IDE 插件 | VS Code API 1.85+ 的兼容宿主，例如 VS Code 或 Qoder IDE |

**构建不需要 root、图形会话或运行采集服务。** 安装 deb 需要管理员授权，日常运行应用与 IDE 使用普通用户。Qoder Desktop 独立应用和 JetBrains 不是此 VSIX 的宿主；其他发行版尚未逐一认证。

检查构建工具：

```bash
node --version
npm --version
dpkg-deb --version
```

### 2. 获取完整源码

克隆本仓库，或通过仓库的 **Code → Download ZIP** 下载并解压完整源码。在包含 `package.json` 的项目根目录打开终端；以下构建命令均在这里执行。

请保留完整的 `vendor/` 目录，包括隐藏的 `.sysak_components/`。仓库提供构建所需的 Linux x64 SysAK 和 AgentSight 预编译输入，**不需要另找上游构建目录、旧安装包或开发缓存，也不需要 Git LFS 或子模块**。不要只下载某个子项目目录。

### 3. 一键构建

```bash
npm run build
```

无需先在根目录运行 `npm install`：脚本会检查版本、准备并校验 SysAK、在两个子项目执行 `npm ci`、编译源码，再生成：

```text
release/build-0.2.17/
├── sysagent-idc_0.2.17_amd64.deb
├── sysom-agentsight-runtime_0.16.0_amd64.deb
├── sysagent-ide-0.2.17.vsix
├── agentsight-runtime/
├── install-debs.sh
├── SHA256SUMS
├── LICENSE
├── THIRD_PARTY_NOTICES
└── FONT_LICENSE
```

| 产物 | 用途 |
| --- | --- |
| 主 SysAgent deb | 桌面应用与系统资源采集服务；精确依赖 AgentSight runtime 0.16.0 |
| AgentSight runtime deb | 独立 AgentSight 配套运行时 |
| VSIX | IDE 插件；包含 SysAK，不内嵌 AgentSight |
| `agentsight-runtime/` | 独立配套目录，含二进制、manifest、许可及部署工具 |
| `install-debs.sh` / `SHA256SUMS` | 同批次安装入口与完整性校验 |

`npm run release` 使用同一入口。构建只编译和打包，**不安装系统服务、不开启真实采集、不结束进程、不上传发布件**。此入口使用随仓库提供的 SysAK/AgentSight 二进制，不重新编译这两个上游项目，也不生成 AppImage。

只需要部分产物时：

```bash
npm run build:desktop              # 主 deb + AgentSight runtime deb
npm run build:ide                  # 仅 VSIX
npm run build:web                  # 仅网页生产构建，不下载 Electron 二进制
npm run build -- --skip-install    # 已安装依赖后复用；首次构建不要使用
npm run build -- --help
```

仅构建 VSIX 不会生成 AgentSight runtime deb。需要 Agent 诊断时，使用完整构建取得配套运行时，或使用已安装的兼容运行时。

Electron 下载默认使用项目内置镜像，可用 `ELECTRON_MIRROR`、`ELECTRON_BUILDER_BINARIES_MIRROR` 环境变量覆盖；脚本不修改 npm 或 Git 配置。

## 安装与首次运行

已有可信来源的发布包时可以跳过构建，在包含两个 deb、安装脚本和 `SHA256SUMS` 的产物目录执行以下步骤。生成安装包并不等于安装，修改源码也不会更新已安装程序。

### 1. 校验产物

从项目根目录进入本次构建目录：

```bash
cd release/build-0.2.17
sha256sum --check SHA256SUMS
```

所有项目应显示 `OK`。校验失败时不要安装，请重新构建或重新获取完整发布包。校验确认传输完整性，不代替可信来源验证。

### 2. 安装桌面端与配套运行时

以将要使用 SysAgent 的普通用户执行：

```bash
sh ./install-debs.sh
sysagent-idc
```

按提示提供管理员授权，随后也可从应用菜单打开“SysAgent管家”。**不要只安装主 deb**：它依赖同批次 AgentSight runtime deb。

安装入口只安装本地包，不联网补齐系统依赖，也不自动回滚。缺少系统库时先由管理员补齐，再重新运行安装入口；不要强制跳过依赖、禁用沙箱或用 `sudo` 启动 GUI。

默认安装不会启用新的主机级 Agent 调用采集。升级保留已有配置、数据和授权选择；安装前请彻底退出旧客户端。直接以 root 登录安装不能作为首次普通用户授权的默认方式。

### 3. 安装 IDE 插件（可选）

推荐先安装两个 deb，再在 IDE 命令面板选择 **Extensions: Install from VSIX… / 扩展: 从 VSIX 安装…**，选择 `sysagent-ide-0.2.17.vsix`，按提示重载 IDE。

VS Code 用户也可在产物目录执行：

```bash
code --install-extension ./sysagent-ide-0.2.17.vsix
```

点击状态栏 SysAgent 入口，或执行 **SysAgent管家: 打开体检主页**。无需同时运行桌面应用。插件诊断本地扩展宿主所在机器，不自动诊断远程工作区；相同 HOME/XDG 环境下，两端共享 AgentSight 用户目录，但巡检设置各自保存。

只需要 IDE 内 Agent 诊断时，可只安装配套 runtime deb 和 VSIX：

```bash
sudo dpkg --install ./sysom-agentsight-runtime_0.16.0_amd64.deb
code --install-extension ./sysagent-ide-0.2.17.vsix
```

此方式不提供系统资源采集服务；VSIX 本身不会安装系统服务。

### 4. 查看第一份报告

1. 打开体检主页，查看本机资源和进程；系统资源服务未就绪时先检查安装状态。
2. 打开 **Agent 管家**，等待本地服务准备完成，再刷新报告；可在总览、会话、中断、延迟之间切换。
3. 首次没有已采集历史时，列表可能为空、指标可能显示 `—`；API 连通不等于已开启真实采集，也不等于业务健康。
4. 刷新失败会保留上次报告并标记旧结果，不要把旧结果当作本次状态。

诊断不会自动重启 Agent、部署模型或发起付费调用。进程清理需要单独确认，可能中断真实任务。关闭主页会收起到悬浮小管家，右键小管家选择“退出”才会彻底退出。

详细操作和指标解释见[功能指南](./docs/FUNCTION-USER-GUIDE.md)或[浏览器版指南](./docs/FUNCTION-USER-GUIDE.html)。指南配图为标注过的人工样例，不代表你的机器实测结果。

## Agent 采集与隐私

AgentSight API 与真实调用采集是两条独立链路。应用可复用已有本地 API，或从独立运行时准备缺失文件并以普通权限启动 API；启动 API 不会生成历史，也不会覆盖已有用户配置。

**真实 eBPF 调用采集是明确授权的可选操作。** 理解并接受主机级采集风险后，才在产物目录执行：

```bash
sh ./install-debs.sh --enable-agent-collection
```

- 当前 AgentSight 不提供严格进程隔离，可能捕获其他主机进程的明文、参数和会话内容并本地保存；敏感或多用户机器建议保持关闭。
- `traceEnabled:false` 不意味着已保存数据经过脱敏。不要公开数据库、令牌、完整配置或含敏感内容的日志。
- 独立 trace 服务拥有包含 `CAP_SYS_ADMIN` 在内的采集能力；API、GUI、IDE 不获得这些能力。回环 API 地址本身不是多用户鉴权边界。
- 托管数据库合计 50 MiB 是周期性软清理目标，不是硬磁盘配额；停用采集不会删除历史。

查看采集状态：

```bash
sudo /usr/bin/python3 -I /usr/share/sysom/agentsight-runtime/agentsight-collection.py status
```

状态中的 `trace_running:true` 与 `api_running:true` 表示两条链路正在运行；仍需要可被捕获的真实调用才能形成历史。

需要停用采集并保留历史时，再执行：

```bash
sudo /usr/bin/python3 -I /usr/share/sysom/agentsight-runtime/agentsight-collection.py disable
```

自定义部署使用 `SYSOM_AGENTSIGHT_URL`（仅回环 HTTP/HTTPS）、`SYSOM_AGENTSIGHT_BIN`、`SYSOM_AGENTSIGHT_CONFIG`、`SYSOM_AGENTSIGHT_PACKAGE` 环境变量，文件路径需为绝对路径。鉴权使用 `SYSOM_AGENTSIGHT_TOKEN` 或已有密钥机制，不写入源码、README 或公开日志。已有显式配置优先，不会自动切换数据来源。

## 开发与测试

重新在包含 `package.json` 的项目根目录打开终端，再执行以下命令。

### 网页预览与开发

```bash
npm run build:web
npm run preview
```

打开 `http://127.0.0.1:4173` 查看界面。网页预览不会安装原生服务，不等同于桌面端的完整本机诊断能力。

完成 `build:web` 后，可执行 `npm run dev` 启动热更新服务，地址为 `http://127.0.0.1:5173`，不会启动 Electron。

桌面开发需要完整安装桌面依赖并下载 Electron：先执行 `npm run build:desktop`，再在可用图形会话中执行 `npm --prefix sysagent-idc run dev`。

### 回归测试

```bash
npm test
npm run test:api
npm run check:versions
```

`npm test` 运行隔离构建流程测试，`test:api` 运行只读查询/API 回归，不安装系统服务或发起真实采集。已在 Linux x64、Node.js 22.23.1 / npm 10.9.8 上验证：不含 Git、依赖、生成资源或旧发布件的完整源码快照能够生成两个 deb 与 VSIX，49 项构建测试和 37 项查询/API 测试通过。

该验证不包含安装、图形界面或真实采集验收。部分历史模块测试依赖未纳入仓库的参考夹具，不属于根目录测试范围；历史 Demo 发行脚本不是当前构建入口。

### 目录与文档

| 路径 | 内容 |
| --- | --- |
| [sysagent-idc/](./sysagent-idc/) | React / TypeScript 界面、Electron 桌面端及本地服务 |
| [sysagent-ide-extension/](./sysagent-ide-extension/) | IDE 插件与 Webview |
| [scripts/build.mjs](./scripts/build.mjs) | 统一构建入口 |
| [vendor/sysak/linux-x64/](./vendor/sysak/linux-x64/) | SysAK 完整构建输入与 manifest |
| [vendor/agentsight/linux-x64/](./vendor/agentsight/linux-x64/) | AgentSight 二进制、manifest 与许可 |
| [功能指南](./docs/FUNCTION-USER-GUIDE.md) | 功能与指标解释 |
| [本机 HTTP API](./docs/LOCAL-HTTP-API.md) | 只读接口与第三方接入 |
| [IDC 设计](./docs/SYSAGENT-IDC-OPENAPI-DETAILED-DESIGN.md) | 资源采集与接口设计 |

## 常见问题

| 问题 | 处理方式 |
| --- | --- |
| 构建提示缺少 SysAK / AgentSight | 重新获取完整仓库，检查 vendor 子目录和 manifest，不以旧 deb 或本机缓存替代 |
| Electron 下载失败 | 检查网络及镜像环境变量，成功安装依赖后才使用 `--skip-install` |
| deb 依赖无法满足 | 核对 x64、glibc 与系统库；不要单装主 deb 或跳过依赖 |
| AgentSight 配套安装件缺失 | 重新执行同批次 `install-debs.sh`，彻底退出客户端后重启 |
| Agent 报告为空 | 检查 API 与真实采集状态；只有 API 可用不意味着已有历史 |
| 资源不可用，但 Agent 报告可用 | 检查 `systemctl status sysom-idc.service --no-pager` 和安装用户授权 |
| 端口、鉴权或配置错误 | 核对已有部署，不结束未知进程、不删除配置、不公开令牌 |
| 修改源码后仍显示旧行为 | 重新构建、安装并退出旧客户端；只构建不会更新已安装程序 |
| 缺少 GPU 页面或数据 | 取决于硬件、驱动和证据；虚拟显示设备不等于真实 GPU |

反馈问题时请提供系统、Node/npm 或 IDE 版本、构建命令和脱敏错误信息，不附带令牌、私人配置、数据库或真实会话内容。

## 源码交付与许可

**构建输入必须提交，生成安装包单独分发：**

- `vendor/sysak/linux-x64/` 全部 **25 个文件**随源码提交：包括 `sysak`、隐藏的 `.sysak_components/` 及其中的原生/Python 组件、规则和配置，以及 `manifest.json`。
- `vendor/agentsight/linux-x64/` 全部 **3 个文件**随源码提交：`agentsight`、`manifest.json`、`LICENSE`。不能只提交 manifest 或让二进制留在本机未跟踪目录。
- 共 28 项必要输入不被 `.gitignore` 排除，无需 Git LFS。更新输入时同步 manifest，并验证完整构建；不要遗漏隐藏组件。
- `sysagent-idc/resources/sysak/` 从 vendor 安全生成，不作为源码输入提交。
- `release/` 及子项目 `release/` 是生成安装包目录，保持 Git 忽略；通过项目发布资产渠道单独分发。依赖、编译输出、私人配置、数据库和开发缓存同样不提交。

维护者提交源码时可显式加入并核对完整输入：

```bash
git add -- vendor/sysak/linux-x64 vendor/agentsight/linux-x64
git ls-files -- vendor/sysak/linux-x64 vendor/agentsight/linux-x64
```

SysAgent 原创代码采用 [MIT](./LICENSE)。SysAK、AgentSight、Electron、字体等第三方组件遵循自身许可，不因项目 MIT 而重新授权；分发时保留 [THIRD_PARTY_NOTICES](./THIRD_PARTY_NOTICES)、[FONT_LICENSE](./FONT_LICENSE) 和 [AgentSight LICENSE](./vendor/agentsight/linux-x64/LICENSE)。参考 UI 与素材的来源和授权说明见第三方声明。
