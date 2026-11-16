# 打包与安装

当前交付为 **SysAgent 0.2.18 / GX 0.6.5-2 / 独立 AgentSight 0.16.0**。安装者优先阅读[根 README](../README.md)。

## 0.2.18 开源发布件

在项目根目录执行 `npm run build`（`npm run release` 是同一入口），已有 Node 依赖时可执行 `npm run build -- --skip-install`。入口 [scripts/build.mjs](../scripts/build.mjs) 先做统一版本检查，再准备并校验 sysAK bundle、校验 AgentSight 与 GX 输入并与主 deb 依赖交叉核对、在子项目执行 `npm ci`，然后生成 `release/build-0.2.18/` 中的主 deb、官方未修改 GX deb、AgentSight runtime deb、VSIX、`agentsight-runtime/`、安装脚本、三份许可声明与 `SHA256SUMS`。桌面步骤调用 `build:deb`，**不生成 AppImage**；入口不安装系统服务、不开启采集、不结束进程、不上传发布件。

> **已知构建缺口（当前仓库状态）：** `vendor/sysak/linux-x64/` 仍是旧四命令包（manifest `commands` 为 `idc/resource_anomaly/memgraph/ai`，规则行为 `detect/generic:idc:…`），而 [prepare-sysak.cjs](../sysagent-idc/scripts/prepare-sysak.cjs) 与 deb postinst 都要求 `idc_inspect`。因此 `npm run build`、`build:desktop`、`build:ide`、桌面 `build:deb`/`build:electron`/`verify:sysak` 和 IDE 构建都会在准备 bundle 时失败，报 `prepare:sysak: Missing idc_inspect rule with python-dep{python3}`；只有 `npm run build:web` 不受影响。修复方式是用包含 `idc_inspect` 的 sysAK 构建产物替换 vendor 输入并同步 manifest 的 `commands` 与逐文件哈希，或临时以 `SYSAK_BUNDLE_DIR`／`npm --prefix sysagent-idc run prepare:sysak -- --source <产物目录>` 指向已完成的构建。缺口修复前不能声称发布包构建通过。

主 deb 精确依赖 `gx (= 0.6.5-2)` 与 `sysom-agentsight-runtime (= 0.16.0)`，并声明 GX 需要的 glibc 2.27+、`zlib1g`、`libzstd1`，以及 `python3`、`systemd` 等运行依赖；**不依赖也不安装 sysAK 软件包**。安装脚本用一次 `dpkg --install` 按 GX、AgentSight runtime、主 SysAgent 顺序离线安装三个本地包；缺少系统依赖时由管理员补齐，不能强制跳过。GUI 启动不下载或提权。

资源采集在运行时使用**系统已安装的 sysak**：按 `SYSOM_SYSAK_BIN`（或控制器 `sysakBinary`）→ `/usr/bin/sysak` → `/usr/local/bin/sysak` → `PATH` 解析，并要求组件目录含可读 `tools/idc_inspect` 与匹配的规则行，否则报 `SYSAK_NOT_FOUND`／`SYSAK_COMPONENT_MISSING`，不会联网下载组件。包内 `resources/sysak/` 仍随 deb 与 VSIX 交付并通过 postinst 校验，但当前只作为 AgentSight 采集控制的 `bundleRoot`，不是资源采集的二进制来源。安装 deb 不等于具备资源采集能力，另需系统 sysak。

云端巡检（sysAK 上传步骤 1–4 与桌面步骤 5）依赖 `sysagent-idc/vendor/alicloud-sysom20231230-3.3.2.tgz`，`package.json` 以 `file:` 方式引用，`npm ci` 需要该 tarball 在位。SysOM 凭据只经环境变量提供，不写入源码、包内配置或发布件；未配置时应用保持纯本地模式。

安装后 GX 辅助程序验证已配置版本和可信文件，为 `/usr/lib64` 注册动态库路径并运行 `ldconfig`；不会把 GX 自带的通用 ELF/DWARF 库加入全局搜索路径。真实 GPU 诊断仍取决于硬件和驱动，版本与依赖加载验证不等于硬件功能认证。

源码快照 `sysagent-source-0.2.18.tar.gz` 与离线归档 `release/SysAgent-0.2.18-linux-x64-offline.tar.gz` **不是标准构建入口的产物**，当前工作区也不包含 `release/`。需要归档交付时由维护者在构建成功后另行组包并逐文件校验；本文档不声称这些归档已生成或已校验。

## 配置与源码（当前）

- [package.json](../sysagent-idc/package.json)：Electron Builder 配置与 npm 脚本；`build.linux.target` 仍列 `AppImage` 与 `deb`，但根入口只走 `build:deb`。
- [package-lock.json](../sysagent-idc/package-lock.json)：锁定 Node 依赖，含 `file:vendor/alicloud-sysom20231230-3.3.2.tgz`。
- [build/after-install.sh](../sysagent-idc/build/after-install.sh)：deb postinst。校验包内 sysAK bundle 的 24 个文件、manifest `commands`（`idc_inspect/resource_anomaly/memgraph/ai`）、逐文件 SHA-256、ELF 架构、python3 入口与规范化规则行；设置 root 所有权与普通用户可执行权限；运行 GX 辅助程序；用 `update-alternatives` 注册 `/usr/bin/sysagent-idc`；安装 `/etc/systemd/system/sysom-idc.service` 与 `/etc/sysom-idc/allowed-uid`，仅在存在已授权普通用户 UID 且 systemd 处于 running/degraded 时 `enable` 并 `restart`。要求 python3 具备 `os.pidfd_open`。
- [build/sysom-idc.service](../sysagent-idc/build/sysom-idc.service) 与 [build/sysak-root-runner.py](../sysagent-idc/build/sysak-root-runner.py)：root 辅助服务，**当前只接受 AgentSight 采集控制请求**（argv `idc --agent-collection {status|ensure|disable}`）；资源采集与进程操作已降到当前用户，不再经该服务。
- [build/install-debs.sh](../sysagent-idc/build/install-debs.sh)：安装入口模板，构建时替换 `@GX_VERSION@`、`@AGENTSIGHT_VERSION@`、`@SYSOM_VERSION@`；`--enable-agent-collection` 需要 sudo 或显式 `SYSOM_IDC_UID`。
- [public/icon.svg](../sysagent-idc/public/icon.svg)、[build/icon.png](../sysagent-idc/build/icon.png)、[build/icons/](../sysagent-idc/build/icons/)、[public/icon.png](../sysagent-idc/public/icon.png)：浅蓝小管家形象与 16–1024 像素系统图标；`linux.icon` 指向 `build/icons`。
- 桌面入口 `StartupWMClass` 必须等于窗口 WM_CLASS `sysagent-idc`，否则 Ubuntu Dock 无法匹配入口，会显示通用齿轮图标。
- [build/make-icon.cjs](../sysagent-idc/build/make-icon.cjs)：用 Chrome 与 sysagent-analysis 的 Puppeteer 把 SVG 渲染成 PNG；正常打包直接使用已有图标。修改矢量图标后先在 `sysagent-analysis` 执行 `npm ci`，再在 `sysagent-idc` 执行 `npm run icon`，不需要 Python 或 Pillow。

`homepage` 使用应用自身的本地协议入口，维护者字段为本地构建标识，不代表公开网站或对外支持邮箱。旧 FastAPI Demo 骨架不是真实诊断后端。

> **AgentSight 采集控制尚未适配（未验证）：** 控制器仍以 `sysak idc --agent-collection <action>` 调用包内 sysak，root 辅助程序也只放行这一组 argv；而合并后的 sysAK 只有 `idc_inspect`（支持 `--profile`、`--process-action`、`--upload-report`），源码中没有 `--agent-collection`，随仓库的旧 vendor `idc` 组件同样不含该参数。因此这条控制链路对当前 sysAK 不可用，`--enable-agent-collection` 的实际效果本次没有验证。修复需要单独适配 sysAK 侧命令与 root 放行清单，不在文档对齐范围内。

## 构建（当前）

统一入口在项目根目录执行：

```bash
npm run build            # 三个 deb + VSIX
npm run build:desktop    # 主 deb + GX deb + AgentSight runtime deb
npm run build:ide        # 仅 VSIX
npm run build:web        # 仅网页生产构建，不下载 Electron
```

单独构建子项目时（同样受上述 sysAK bundle 缺口约束）：

```bash
cd sysagent-idc
npm ci
npm run build:deb        # 或 build:electron（按 linux.target 另出 AppImage）
cd ../sysagent-ide-extension
npm run typecheck && npm run build
```

网络访问 GitHub 较慢或不可用时，桌面可用 `npm run build:electron:mirror`，或在 `npm ci` 前设置 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`；根入口默认使用 npmmirror 的 Electron 与 Electron Builder 镜像，可用同名环境变量覆盖。这些方式只经环境变量选择镜像，不修改系统或 npm 全局配置。

产品版本统一来自根目录 [package.json](../package.json)（当前 **0.2.18**），由 `npm run check:versions` 校验、`npm run sync:versions` 同步桌面与 IDE 的清单和 lockfile；不要单独修改子项目版本。AgentSight 独立保持 0.16.0。共享页面改动后需分别构建桌面和 IDE，不能只重打 runtime 或沿用旧 UI 发布件。IDE 的 [scripts/build.mjs](../sysagent-ide-extension/scripts/build.mjs) 会校验并复制 `sysagent-idc/resources/sysak/` 到 `dist/sysak/`，因此 VSIX 构建同样依赖该 bundle 就绪。

## 安装 deb（当前）

在包含三个 deb、`install-debs.sh` 与 `SHA256SUMS` 的 `release/build-0.2.18/` 目录，彻底退出旧 SysAgent 与 IDE 客户端，再以将要使用应用的普通用户执行：

```bash
sha256sum --check SHA256SUMS
sh ./install-debs.sh
sysagent-idc
```

安装入口需要管理员授权，离线安装三个本地包，不联网下载，同版本也重新安装。缺依赖时由管理员补齐后重新执行，不自动补齐或回滚，不要只装主 deb。资源采集另需系统 sysak（见上文）。真实主机级 Agent 调用采集需另行显式执行 `sh ./install-debs.sh --enable-agent-collection`，普通安装不开启；该开关的实际效果受上述未适配问题影响，本次未验证。

也可在 Ubuntu 应用菜单打开“SysAgent管家”。已安装的应用在 `/opt/SysAgent管家`，移动源码不影响它。GUI/IDE 以普通用户运行，构建和普通运行验收不需要 sudo。升级前先完全退出旧版（最小化不等于退出，可右键桌面小管家选择“退出”）；安装后重新启动，已有进程不会自动换成新版本或新图标，Dock 仍显示旧齿轮图标时注销并重新登录一次即可刷新。

## 发布前检查（当前）

桌面与 IDE 必须分别构建，组包后再核对元信息与批次校验清单：

```bash
npm test                 # 根目录：构建流程与 GX 包测试
npm run test:api         # 根目录：只读查询/API 回归
npm run check:versions
cd sysagent-idc && npm test && sh -n build/after-install.sh
cd ../sysagent-ide-extension && npm run typecheck && npm run build
dpkg-deb --info release/build-0.2.18/sysagent-idc_0.2.18_amd64.deb
cd release/build-0.2.18 && sha256sum --check SHA256SUMS
```

**0.2.18 迁移后实际验证：** 桌面 `npm run build` 退出 0；`sysom-client` 与 `idc-controller` 定向回归 220/220 通过；经显式授权的预发全链路实测走通上传与取报告（`partial_completed`、`reportStatus=Success`、Critical、10 项中 5 项异常），并在隔离端口 5174 的开发网页核对了云端结论、报告弹窗与刷新文案。该次**未重新安装软件、未重跑完整发布包构建**（vendor sysAK 缺口），应用全量测试仍有两项已知环境问题（`health-score` 缺参考夹具、`sysak-package` 15 s 超时偶发），因此不声称全量通过，也不沿用历史批次的验收数量或哈希。

## 0.2.17 及早期历史记录

以下配置、产物路径与测试数字保留为历史记录，不作为 0.2.18 的当前安装入口或验收结论；旧版本输出可能已清理。当前入口、组成与检查见上文各节。历史小节中指向 `release/`、`sysagent-idc/release/` 与 `sysagent-ide-extension/release/` 的校验和及批次清单链接是历史引用，这些生成目录已被清理且不在源码仓库中，链接目标当前不存在。

## 配置与源码（0.2.17 及早期历史）

- [package.json](../sysagent-idc/package.json)：Electron Builder 配置和 npm 脚本。
- [package-lock.json](../sysagent-idc/package-lock.json)：锁定 Node 依赖。
- [build/after-install.sh](../sysagent-idc/build/after-install.sh)：deb 安装后注册启动命令、设置 Chromium 沙箱权限、刷新桌面菜单。
- [public/icon.svg](../sysagent-idc/public/icon.svg)：浅蓝色 SysAgent 小管家 Logo，带淡蓝圆环与绿色状态点；系统应用与窗口图标使用此形象，主页、标题栏与关于窗口也使用同款小管家形象。
- [build/icon.png](../sysagent-idc/build/icon.png)：1024 × 1024 透明背景小管家图标原图。
- [build/icons/](../sysagent-idc/build/icons/)：16–1024 像素系统图标，供 Dock、应用列表等使用；`linux.icon` 指向此目录。
- 桌面入口 `StartupWMClass` 必须等于窗口 WM_CLASS `sysagent-idc`，否则 Ubuntu Dock 无法匹配入口，会显示通用齿轮图标。
- [public/icon.png](../sysagent-idc/public/icon.png)：同款 Electron 窗口图标，由 Vite 复制到 dist。
- [build/make-icon.cjs](../sysagent-idc/build/make-icon.cjs)：使用 Google Chrome 和 sysagent-analysis 的 Puppeteer 将 SVG 渲染成 PNG；正常打包直接使用已有图标，不需重新生成。

修改矢量图标后，先在 `sysagent-analysis` 运行 `npm ci`，再在 `sysagent-idc` 运行 `npm run icon`。图标生成不需要 Python 或 Pillow。

当时的主 SysAgent deb 包含桌面应用和经 root 服务执行的系统资源采集，并依赖独立 AgentSight runtime deb；完整离线包另含 AppImage、VSIX 与 `agentsight-runtime/`。AppImage/VSIX 不自行安装系统采集服务，VSIX 不内嵌 AgentSight 二进制；不把旧 FastAPI Demo 骨架作为真实诊断后端。0.2.18 的组成与此不同：资源采集改用当前用户直接调用系统 sysak，root 服务只保留 AgentSight 采集控制，根入口不再生成 AppImage，见上文各节。

## 构建（0.2.17 及早期历史）

```bash
cd sysom_idc/sysagent-idc
npm ci
npm run build:electron
```

网络访问 GitHub 较慢或不可用时：

```bash
npm run build:electron:mirror
```

该脚本通过环境变量选择 Electron 与 Electron Builder 工具的 npmmirror 镜像，不修改系统或 npm 全局配置。

如果连 `npm ci` 中的 Electron 下载也较慢，可运行：

```bash
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm ci
```

从 0.2.5 起，产品版本统一来自根目录 `package.json`（当时路径为 `sysom_idc/package.json`），不要单独修改桌面或插件版本；当时根目录、桌面及 IDE 清单/lockfile 使用 0.2.17，AgentSight 独立保持 0.16.0。当前统一版本为 0.2.18，见上文。共享页面改动后需分别构建桌面和 IDE，不能只重打 runtime 或沿用旧 UI 发布件。

早期 `npm --prefix sysom_idc run release` 是 Demo 统一发行流程，生成 deb、AppImage、离线 HTML、VSIX 与 `release-<version>.json`；它不是当前真实版离线包安装入口，也不能用其历史通过记录代替本轮验证。本批次在下述独立目录组包，校验、运行验证完成后才清理旧发布文件；历史记录保留。打包不自动安装、提交或上传，不覆盖已完成批次。

## 0.2.17 批次产物（历史）

当时批次目录为 `sysom_idc/sysagent-idc/release/idc-0.2.17-sysagent-20261113/`，交付清单：

```text
idc-0.2.17-sysagent-20261113/
├── SysAgent管家-0.2.17-linux-x64-offline.tar.gz
├── sysagent-idc_0.2.17_amd64.deb
├── sysom-agentsight-runtime_0.16.0_amd64.deb
├── SysAgent管家-0.2.17.AppImage
├── sysagent-ide-0.2.17.vsix
├── install-debs.sh
├── agentsight-runtime/
└── SHA256SUMS
```

离线包包含本批次安装件与校验清单，不含系统依赖仓库；安装入口不联网下载。不要只交付主 deb、遗漏 runtime，或把旧 Demo HTML 当成真实版入口。AppImage 需同目录独立 runtime 或已安装 runtime deb；完整系统资源功能仍需两个 deb。

真实主机采集默认关闭，必须显式 `sh ./install-debs.sh --enable-agent-collection` 接受主机级明文/参数及本地完整会话保存；匹配规则不是严格进程隔离，`traceEnabled:false` 不是本地数据库脱敏。只有 trace 服务获得包括权限较大的 `CAP_SYS_ADMIN` 在内的采集能力，API/GUI/IDE 不获得。托管数据库合计 50 MiB 是周期性软清理目标，不是硬配额；WAL、忙锁和空页可使占用超出。停用保留历史，不自动发起模型调用。

## 历史 Demo 产物说明

0.2.6 的输出位置（历史记录，不作为当前安装入口）：以下目录使用改名后的工作目录路径，历史产物文件名保留原名；旧文件不因文档名称更新而被重命名，也不保证仍可获取。

```text
sysom_idc/
├── sysagent-idc/release/
│   ├── SysOM管家-0.2.6.AppImage
│   ├── sysom-guard_0.2.6_amd64.deb
│   ├── SysOM管家-0.2.6-demo.html
│   ├── SHA256SUMS-0.2.6
│   └── linux-unpacked/
├── sysagent-ide-extension/release/
│   ├── sysom-ide-0.2.6.vsix
│   └── SHA256SUMS-0.2.6
└── release/
    ├── release-0.2.6.json
    └── SHA256SUMS-0.2.6
```

0.2.6 新增本机 GPU 只读识别：无 GPU 时隐藏诊断页面、首页卡片、体检项、性能标签和告警选项；支持用 `SYSOM_GPU=0|1` 手动指定，纯浏览器可用 `?gpu=0|1`。Linux 无 DRM render 节点时关闭 Chromium 硬件加速，避免 GPU 初始化报错，不绕过沙箱。

0.2.6 的系统应用（含 Ubuntu Dock 与应用列表）、窗口、标题栏、主页健康中心与关于窗口统一使用浅蓝悬浮小管家 Logo（淡蓝圆环与绿色状态点）。启动直达主页，最小化或关闭主页后显示可拖动的原生桌面小管家；模拟新异常会抖动提示。右键小管家选择“退出”才能完全退出。业务操作仍为模拟，FastAPI 骨架未接入。

单文件离线版由 `npm run build:html` 单独生成，只能在浏览器内模拟桌面效果，不具备原生浮窗。原始参考 demo 保持不变。

`linux-unpacked/` 是完整的 Electron 应用目录，不要只复制其中的主可执行文件；AppImage 和 deb 是可单独交付的打包文件。

0.1.0 保留为历史交付版本，它的默认安装脚本会错误地依赖 root 的 user namespace 探测来决定沙箱权限。0.1.1 使用专用安装脚本设置 root 所有权和 `4755` 权限，避免 Ubuntu 桌面 AppArmor 限制导致的启动失败。

## 安装 deb（0.2.17 历史入口）

将 `SysAgent管家-0.2.17-linux-x64-offline.tar.gz` 解压到空目录，彻底退出旧 SysAgent 和 IDE 客户端，再以将要使用应用的普通用户在解压目录执行：

```bash
sha256sum --check SHA256SUMS
sh ./install-debs.sh
sysagent-idc
```

安装入口需要管理员授权，通过 `dpkg --install` 安装两个本地 deb；不联网下载，同版本也重新安装。缺依赖时由管理员补齐后重新执行，不自动补齐或回滚，不推荐单装主 deb。真实主机采集需另行显式授权上述开关，普通安装不开启。

也可在 Ubuntu 应用菜单打开“SysAgent管家”。已安装的应用在 `/opt/SysAgent管家`；移动源码不影响它。GUI/IDE 以普通用户运行；构建和普通运行验收不需要 sudo。

升级前先完全退出旧版；最小化不等于退出，0.2.1 及以后版本可右键桌面小管家选择“退出”。安装后重新启动，已有进程不会自动换成新版本或新图标；若 Dock 仍显示旧的齿轮图标，注销并重新登录一次即可刷新。

## AppImage（历史产物，当前根入口不生成）

带 FUSE 2 的环境可以直接运行 AppImage。Ubuntu 环境缺少 `libfuse.so.2` 时，无需修改系统也可执行：

```bash
APPIMAGE_EXTRACT_AND_RUN=1 "sysom_idc/sysagent-idc/release/idc-0.2.17-sysagent-20261113/SysAgent管家-0.2.17.AppImage"
```

AppImage 已有执行权限。复制到其他机器后若执行权限丢失，再为该 AppImage 添加执行权限即可。

## 旧版沙箱错误

若旧版提示 `setuid_sandbox_host.cc` 和 `mode 4755`，优先按当前三 deb 入口升级到 0.2.18（见上文）；也可只修复指定的沙箱辅助程序：

```bash
stat -c '%U:%G %a %n' "/opt/SysAgent管家/chrome-sandbox"
sudo chown root:root "/opt/SysAgent管家/chrome-sandbox"
sudo chmod 4755 "/opt/SysAgent管家/chrome-sandbox"
sysagent-idc
```

只对这个安装目录中的 Chromium 沙箱辅助程序设置该权限，不要递归设置 SUID，不要给应用主程序设置 SUID，也不要为了启动应用关闭 AppArmor 或系统安全策略。

## 0.2.17/0.2.16 构建内容与发布前检查（历史）

0.2.17 前置结论与按类型归组的问题，直接跳转只读证据；“数据范围”仅保留时间和覆盖状态，不展示内部部署说明或原始错误。进程探活支持名称/PID、角色/状态过滤和每页 20 条分页，筛选或刷新回第一页，本地交互不追加采集或影响 KPI。会话与 Token 显式包含辅助调用，与延迟口径一致；输入已含缓存用量，报告缓存 60 秒后重采集，拒绝窗外会话。Token 为已记录用量，旧记录缺失 usage 可能已存为 0，不能可靠恢复或宣称完整消耗；截断列表总数仍未知。保留四视图、真实延迟、证据与已有会话跳转，停用保留历史、失败标记旧结果；不取正文或自动操作，不发起付费调用。

0.2.17 当时双端构建成功，隔离 AppImage 原生验收 30/30、IDE 原生验收 24/24 通过。这些数量绑定当时的发布包，不适用于 0.2.18，也不沿用历史哈希；当前验证状态见上文“发布前检查（当前）”。

**0.2.16 历史验证（不是 0.2.17 结果）：** 双端类型检查、独立构建及打包通过，1,372 项定向回归通过（包含 30 项 UI 交互测试）；不是全量历史测试套件通过声明。当时浏览器分页/过滤/证据与空数据恢复验证通过，AppImage 原生验收 30/30、IDE VSIX 原生验收 24/24 通过。以下保留维护者检查步骤，桌面和 IDE 必须分别构建：

```bash
cd sysom_idc/sysagent-idc
npm test
npm run build
sh -n build/after-install.sh
cd ../sysagent-ide-extension
npm run typecheck
npm run build
```

组包后，从 `sysom_idc` 的上级目录检查两个 deb 的元信息与批次校验清单：

```bash
dpkg-deb --info sysom_idc/sysagent-idc/release/idc-0.2.17-sysagent-20261113/sysagent-idc_0.2.17_amd64.deb
dpkg-deb --info sysom_idc/sysagent-idc/release/idc-0.2.17-sysagent-20261113/sysom-agentsight-runtime_0.16.0_amd64.deb
cd sysom_idc/sysagent-idc/release/idc-0.2.17-sysagent-20261113
sha256sum --check SHA256SUMS
```

0.2.16 历史交付件曾分别运行原生验收（AppImage 30/30、IDE VSIX 24/24），覆盖结论与按类型分组的问题、事件证据跳转、45 进程 20/20/5 分页与名称/PID/角色/状态组合过滤、筛选重置页码且全局统计不变、空/部分/不可用/完整数据、刷新失败保留旧结果、键盘标签与多宽度布局，未发现渲染器错误、CSP 违规、私有测试字段泄漏或渲染器直连 AgentSight。当时桌面包 app.asar 内 299 个构建文件和 12 个 electron 文件与 0.2.16 构建一致，deb 与 AppImage 内 app.asar 相同，VSIX 的 332 个构建文件一致；安装入口（版本替换后与模板一致）、runtime helper 和两份 service 与源码核对通过。离线包仅含 15 项允许文件（14 项内容文件及 SHA256SUMS），所有内容哈希及归档哈希通过；0.2.16 历史离线归档 SHA256 为 `8536e6bf038ad11ac99ae460f7d3e6a2ef22d7f1909f1cecdbe93d48337f1e2e`，不属于 0.2.17。该次 0.2.16 验证未重新安装系统服务或改变真实采集授权，其他系统、TLS/协议和硬配额压力未逐一认证。旧发布文件已清理，保留历史文档和验证资料。旧 Demo 二进制工具见[开发说明](./DEVELOPMENT.md)，不替代新 UI 验收；本地打包不代表已公开发布或上传。

## 0.2.6 全发行版验收记录（2026-11-09）

- 根目录、桌面、VSIX 的清单与 lockfile 统一为 0.2.6。
- 13 项模型/API/GPU 检测测试通过；包含无 GPU 评分、无效 GPU 操作拒绝、PCI 厂商识别、环境覆盖，以及 Windows 无驱动时的 PNP 硬件 ID 和 macOS 显卡输出样本。
- 开发网页与离线 HTML 各通过有 GPU 的 11 组交互和无 GPU 的 4 组检查：隐藏导航、资源卡片、体检项、性能标签、告警选项和本机详情 GPU 字段。离线 HTML 无 HTTP 请求。
- VSIX 模拟宿主 21 项验收通过；源码和最终 VSIX 解包后的扩展均在隔离 VS Code 1.145.2 中通过 4 项真实 IDE 冒烟测试，实际页面为 v0.2.6，确认 `SYSOM_GPU=0` 时只有四张资源卡片且无 GPU 导航。
- AppImage 与 deb 解包运行各通过 6 组原生窗口行为和双 GPU 模式界面验收，控制台无错误，正常退出码为 0；本机无 DRM render 节点时未再出现 `Exiting GPU process due to errors during initialization`，没有绕过 Chromium 沙箱。
- 四份交付文件 SHA256 复核通过：完整清单见 [sysom_idc/release/release-0.2.6.json](../release/release-0.2.6.json)，总校验和见 [sysom_idc/release/SHA256SUMS-0.2.6](../release/SHA256SUMS-0.2.6)。未自动安装、升级、提交或上传。
- 原生运行在 Linux 验收；Windows/macOS 仅验证查询逻辑的模拟输出，未在对应系统上实测。硬件识别只读，所有业务操作仍为模拟，FastAPI 后端保持空置。

## 0.2.5 全发行版验收记录（2026-11-07）

- 根目录统一版本、桌面/VSIX 清单与 lockfile 均为 0.2.5；界面产品版本由同一版本源注入。
- 11 项模型/API 测试与 IDE 类型检查通过。
- VSIX 模拟宿主 21 项验收通过；源码扩展与最终 VSIX 解压后的扩展分别在隔离 VS Code 1.145.2 中通过 4 项冒烟测试，实际页面显示 v0.2.5。
- 离线 HTML 通过 11 组页面交互及四种宽度验收，控制台无错误，HTTP 请求为零。
- AppImage 免 FUSE 运行及 deb 解包运行各通过 6 组原生窗口和 11 组页面验收，包含拖动、五次系统最小化/Enter 恢复、模拟告警与 WM_CLASS 核对；控制台无错误，退出码为 0，未绕过 Chromium 沙箱。
- deb、AppImage、离线 HTML、VSIX 四份交付文件 SHA256 校验通过；完整批次见 [sysom_idc/release/release-0.2.5.json](../release/release-0.2.5.json)，总校验和见 [sysom_idc/release/SHA256SUMS-0.2.5](../release/SHA256SUMS-0.2.5)。已完成版本禁止覆盖。
- 未自动安装桌面应用或插件，未提交或上传市场。全部业务仍为模拟，未访问或修改真实设备，FastAPI 业务后端保持空置。

## 0.1.1 本机验收记录（2026-11-06）

- 类型检查、Vite 构建与 Electron Builder 打包通过。
- 新目录下的前端六页面截图与 FastAPI 模拟接口测试通过。
- AppImage 免 FUSE 运行及 deb 解包后的运行测试通过，包含六页面、日志空结果与恢复、弹窗开关及正常退出，控制台无错误。
- deb 中的 postinst 与源码脚本一致；使用模拟命令确认设置 root 所有权和 4755 权限，没有在验收中修改实际安装目录权限。
- apt 模拟升级从 0.1.0 到 0.1.1 通过，没有自动执行真实升级。
- 校验和文件：[SHA256SUMS-0.1.1](../sysagent-idc/release/SHA256SUMS-0.1.1)。

## 0.1.2 本机验收记录（2026-11-06）

- 类型检查、Vite 构建与 Electron Builder 打包通过。
- 新图标的网页加载及 128 像素预览检查通过；PNG 为 1024 × 1024，外角透明。
- AppImage 免 FUSE 运行通过，包含图标资源、六页面、日志空结果与恢复、弹窗开关及正常退出，控制台无错误。
- deb 中的 1024 像素桌面图标与源码 PNG 一致，桌面入口引用正确；postinst 与源码脚本一致，保留沙箱权限修复。
- apt 模拟升级从 0.1.0 到 0.1.2 通过，没有自动执行真实升级。
- 校验和文件：[SHA256SUMS-0.1.2](../sysagent-idc/release/SHA256SUMS-0.1.2)。

## 0.2.0 本机验收记录（2026-11-07）

- 根据原始 demo 重新生成可维护 TSX 源码，原始 HTML 与旧版前端备份保留。
- 严格类型检查、Vite 构建、离线 HTML 构建与 Electron Builder 打包通过。
- 11 项模型/API 测试通过，包含原始评分与清理逻辑对照、Session 范围保护、版本冲突和 HTTP 参数校验。
- 原始 demo、开发网页和单文件离线版通过相同的 11 组完整交互验收，包含四种宽度；控制台无错误，离线版 HTTP 请求为零。
- 固定时间并等待字体加载后，六个页面在 1440 和 390 像素宽度的可见截图与原始 demo 像素一致；记录在 `sysom_idc/sysagent-analysis/tests/output/fixed-visual-diff.json`。
- AppImage 免 FUSE 运行与 deb 解包运行均通过完整交互、图标、preload、本地协议及正常退出验收；没有绕过 Chromium 沙箱。
- deb 的 postinst、1024 像素透明图标与源码一致；安装脚本语法检查通过。
- apt 模拟从已安装的 0.1.2 升级到 0.2.0 通过，没有执行实际安装或升级。
- 三个交付文件的校验和验证通过：[SHA256SUMS-0.2.0](../sysagent-idc/release/SHA256SUMS-0.2.0)。
- 所有业务操作仅为模拟，不访问或修改真实设备；FastAPI 业务逻辑仍为空，未接入前端。

## 0.2.1 本机验收记录（2026-11-07）

- 严格类型检查、Vite 构建、离线 HTML 构建及 Electron Builder 打包通过，11 项模型/API 回归测试通过。
- AppImage 免 FUSE 运行和 deb 解包运行分别通过 6 组原生窗口与 11 组页面验收；控制台无错误，正常退出码为 0。
- 验证主页直开、最小化/关闭收起为透明置顶小管家、真实桌面拖动、点击/Enter 恢复、拖动取消、状态与位置保留，以及主窗口隐藏时的模拟异常抖动和提示关闭。
- 在本机 2 倍缩放屏幕上，通过 Electron 工作区坐标和 xwininfo 核对浮窗实际显示于桌面右下角，没有绕过 Chromium 沙箱或修改系统安全策略。
- 开发网页和离线版分别通过 11 组页面交互及四种宽度验收；离线版 HTTP 请求为零。
- 应用图标为主页同款绿色盾牌，1024 × 1024 PNG 外角透明；deb 桌面图标和 postinst 与源码一致，桌面入口及安装脚本语法检查通过。
- apt 模拟从已安装的 0.2.0 升级到 0.2.1 通过，没有执行实际安装或升级。
- 三个交付文件的校验和验证通过：[SHA256SUMS-0.2.1](../sysagent-idc/release/SHA256SUMS-0.2.1)。
- 原始 demo 与历史交付文件保留；全部业务操作和告警仍为模拟，不访问或修改真实设备，FastAPI 后端逻辑未实现且未接入。

## 0.2.2 本机验收记录（2026-11-07）

- 系统应用与窗口图标恢复为浅蓝色 SysAgent 小管家（淡蓝圆环与绿色状态点）；矢量图与原 0.2.0 交付包一致，主页左上角盾牌不变。
- 与 0.2.1 对照，主进程窗口代码、preload 与前端入口未变化；保留主页直开、收起、拖动、点击/Enter 恢复和模拟异常抖动。
- 类型检查、Vite/离线 HTML/Electron 打包与 11 项模型/API 测试通过；网页和离线版各通过 11 组交互验收，离线版 HTTP 请求为零。
- AppImage 和 deb 解包运行各通过 6 组原生窗口及 11 组页面验收，控制台无错误，退出码为 0。
- deb 桌面图标、内嵌 SVG/PNG 与源码一致；打包运行验收增加 PNG 逐字节比对，安装脚本保持不变且语法检查通过。
- apt 模拟从已安装的 0.2.0 升级到 0.2.2 通过，没有执行实际安装或升级；三份交付文件校验和验证通过：[SHA256SUMS-0.2.2](../sysagent-idc/release/SHA256SUMS-0.2.2)。
- 不访问或修改真实设备，后端逻辑仍为空，历史交付包与原始 demo 保留。

## 0.2.3 本机验收记录（2026-11-07）

- 标题栏、主页健康中心、页脚和关于窗口改用浅蓝悬浮小管家 Logo，与系统应用、窗口及 IDE 插件沿用同一小管家形象；原始参考 demo 保持不变。
- 系统最小化时先恢复窗口的最小化状态再隐藏，避免 Linux 窗口管理器在恢复主页时重放残留的最小化事件。
- 类型检查、Vite/离线 HTML/Electron 打包与 11 项模型/API 测试通过；离线版通过 11 组交互及四种宽度验收，HTTP 请求为零。
- AppImage 两次完整运行与 deb 解包运行均通过 6 组原生窗口及 11 组页面验收；每次连续五次系统最小化/Enter 恢复，控制台无错误，退出码为 0。
- deb 安装脚本语法检查和从已安装 0.2.2 到 0.2.3 的 apt 模拟升级通过，没有执行实际升级或修改系统权限。
- 交付文件校验和见 [sysom_idc/sysagent-idc/release/SHA256SUMS-0.2.3](../sysagent-idc/release/SHA256SUMS-0.2.3)。
- 共用页面的插件 0.1.1 通过 21 项模拟宿主和 4 项真实 VS Code 验收，VSIX 在隔离目录安装成功；校验和见 [sysom_idc/sysagent-ide-extension/release/SHA256SUMS-0.1.1](../sysagent-ide-extension/release/SHA256SUMS-0.1.1)。
- 所有业务操作仍为模拟，不访问或修改真实设备，FastAPI 后端逻辑仍为空且未接入。

## 0.2.4 本机验收记录（2026-11-07）

- 问题：0.2.3 桌面入口声明 `StartupWMClass=SysOM管家`，而当时运行窗口的 WM_CLASS 为 `sysom-guard`，Ubuntu Dock 无法匹配入口，显示通用齿轮图标。
- 历史修复：`linux.desktop.StartupWMClass` 设为当时的 `sysom-guard`；`npm run icon` 额外生成 `sysom_idc/sysagent-idc/build/icons/` 下 16–1024 像素图标，deb 安装到 hicolor 全部尺寸，postinst 刷新图标缓存。
- 当时 deb 与 AppImage 内的桌面入口均为 `StartupWMClass=sysom-guard`，各含 9 个尺寸的小管家图标。
- AppImage 免 FUSE 运行与 deb 解包运行均通过 6 组原生窗口及 11 组页面验收，新增主窗口与桌面小管家的 WM_CLASS 核对；控制台无错误，退出码为 0。
- 11 项模型/API 测试和离线版 11 组交互验收通过，离线版 HTTP 请求为零；安装脚本语法检查和从已安装 0.2.3 到 0.2.4 的 apt 模拟升级通过，没有执行实际升级。
- 交付文件校验和见 [sysom_idc/sysagent-idc/release/SHA256SUMS-0.2.4](../sysagent-idc/release/SHA256SUMS-0.2.4)。
- 所有业务操作仍为模拟，不访问或修改真实设备，FastAPI 后端逻辑仍为空且未接入。
