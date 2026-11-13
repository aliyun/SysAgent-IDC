# 开发说明

当前交付版本为 **SysAgent 0.2.17 / AgentSight 0.16.0**，发布批次为 `sysagent-idc/release/idc-0.2.17-sysagent-20261113/`，完整离线包为 `SysAgent管家-0.2.17-linux-x64-offline.tar.gz`。安装入口见[根 README](../README.md)，当前打包边界见[打包说明](./PACKAGING.md)。本文保留早期 Demo 开发和验收工具记录；其中模拟业务、版本、测试数量与统一 Demo 发行命令不代表当前真实版行为或 0.2.17 验收。

## 环境

- Ubuntu x86_64 桌面，带可用的图形会话。
- Node.js 22 或 24、npm。
- Python 3.12 和 venv，用于可选的 FastAPI 后端。
- 自动截图使用本机 Google Chrome；默认可执行文件为 `/usr/bin/google-chrome`。

应用源码入口为 `sysom_idc/sysagent-idc`，IDE 插件见 `sysom_idc/sysagent-ide-extension/README.md`。文中路径都以 `sysom_idc/` 开头，命令默认在 `sysom_idc` 的上级目录执行。

## 前端与 Electron

```bash
cd sysom_idc/sysagent-idc
npm ci
npm run dev
```

`npm run dev` 同时启动 Vite 和 Electron，开发地址为 `http://127.0.0.1:5173`。该端口需空闲；如果已有开发服务器，可直接使用该服务器，不要随意终止其他进程。

仅开发网页：

```bash
npm run dev:web
```

类型检查及静态构建：

```bash
npm run build
```

测试静态构建的桌面运行方式：

```bash
SYSOM_LOAD_DIST=1 ./node_modules/.bin/electron .
```

开发模式读取 Vite；静态构建和安装后的应用通过 `sysom://app/index.html` 加载本地资源，不依赖 Vite。

0.2.6 的 Electron 启动直接显示体检主页；系统应用、窗口、标题栏、主页健康中心及关于窗口统一使用浅蓝悬浮小管家 Logo。最小化、系统最小化或关闭主页会隐藏主窗口，显示独立透明、置顶、跳过任务栏的桌面小管家；默认放在主屏幕工作区右下角，拖动限制在显示器工作区。点击或按 Enter 恢复主页并保留快照与已拖动位置，右键小管家选择“退出”才结束进程。

主渲染进程负责演示模型，隐藏时继续运行模拟采样与告警计时；浮窗只接收经 IPC 同步的异常摘要和抖动状态，不创建第二份模型。通过主页左下角“动态告警演示”模拟 80% → 96%，可在等待期间收起主页验证桌面抖动。没有真实设备监控逻辑。浏览器版仍保持网页内桌面模拟，不会创建系统浮窗。

启动时只读识别本机 GPU：`sysom_idc/sysagent-idc/electron/gpu-detect.cjs` 读取 Linux PCI 信息、Windows 显卡信息或 macOS 显示信息；桌面 preload 与 IDE Webview 桥接把结果传给页面。`sysom_idc/sysagent-idc/src/gpu-presence.ts` 为纯浏览器提供 WebGL 渲染器判断。识别包含 NVIDIA、AMD、Intel、Apple，不把虚拟显示适配器算作硬件 GPU。未检测到或检测受限时隐藏 GPU 页面、卡片、体检、性能标签和告警选项；可用 `SYSOM_GPU=0|1` 覆盖宿主结果，浏览器可用 `?gpu=0|1`。Linux 无 DRM render 节点时关闭 Chromium 硬件加速，保持沙箱不变。

## 当前 Agent 管家：共享实时视图

`sysagent-idc/src/AgentDiagnostics.tsx` 中的 `LiveAgentDiagnostics` 是桌面与 IDE 共用的真实诊断页面，证据来源为 AgentSight → 本地 OpenAPI → report；同文件旧 `AgentDiagnostics` 仍是 Demo，不应混用。时间窗固定最近 24 小时，不新增任意时序查询或正文接口。

- 四张 KPI 保留近 24h 会话数、已记录输入/输出 Token、全窗口未处理中断；缺失显示 `—`。会话查询显式 `include_auxiliary=true`，包含辅助调用，与延迟口径一致；输入已含缓存，不重复累加。上游缺失 usage 可写为 0，历史记录无法可靠区分未测量与实测零，不能宣称完整消耗。会话/Token 汇总仍须完整已采集列表，截断时总数未知；拒绝统计窗外会话。
- 报告缓存仅复用 60 秒以内结果，过期和时钟回退时重采集，手动刷新绕过缓存，失败保留旧报告不延长缓存有效期。
- 前置诊断结论、按事件类型归组的待关注问题及证据跳转，不渲染内部摘要、原始覆盖原因、服务消息或原始错误。数据服务与真实采集状态独立；“数据范围”只保留时间和覆盖状态，授权说明在安装文档。
- 进程探活支持名称/PID、角色和状态组合过滤、每页 20 条分页，筛选或刷新回第一页；保留匹配/已采集数，全局统计稳定，无额外采集。需检查只含端口不可达、响应超时及有崩溃标记的退出进程，正常 CLI 无端口不判故障；解释保留在状态提示中。
- “会话”仅对报告已有 Agent / ID / Model 做本地搜索，按最后活跃时间降序、同时间按 ID 排序，不改变全窗口 KPI。展开仅看首末时间与关联中断元数据。
- “中断”提供紧凑表和复用公共 `Modal` 的只读九字段详情：事件 ID、类型、严重度、发生时间、Session ID、Call ID、PID、Agent、处理状态。仅已有会话关联允许跳转，不触发额外请求或修改处理状态。
- “延迟”可切换 E2E P95 / TTFT P95 / TPS P50 实测对比，详细表保留完整/流式调用数和 TTFT P95、E2E P95、TPS P50、TPOT P95。仅统计完整调用，TTFT / TPOT 只用于流式调用，不设自定故障阈值。
- 停用采集保留历史；刷新失败保留上次报告且显式标记“旧结果 · 刷新失败”，更新中标明仍为上次报告。不获取对话正文、不推断 Session 独占 CPU/GPU 归属、不自动修复、部署或调用付费模型。

主机级采集仍须显式 `--enable-agent-collection` 接受明文/参数及本地完整会话保存，不是严格进程隔离，也不因 `traceEnabled:false` 而脱敏本地数据库。只有独立 trace 服务获得包括权限较大的 `CAP_SYS_ADMIN` 在内的采集能力，API/GUI/IDE 不获得。托管数据库合计 50 MiB 是周期性软清理目标，不是配额；WAL、忙锁、空页可导致超出。普通安装不隐式开启采集，显式部署和已有用户配置优先保留。

共享 UI 改动后分别构建桌面与插件，不手改生成产物：

```bash
cd sysom_idc/sysagent-idc
npm run build
cd ../sysagent-ide-extension
npm run typecheck
npm run build
```

0.2.16 历史验证：双端类型检查、构建和组包通过，1,372 项定向回归通过（Agent 客户端/OpenAPI/UI 235、采集/安装/控制器/查询/GPU/健康/进程等 1,080、定向打包 57），其中 UI 30 项已计入 235；未把全量历史 SysAK 测试套件计为通过。浏览器使用独立协议测试数据和真实 SysOMOpenAPI，验证 45 进程分页/过滤、证据跳转、稳定统计、空数据与恢复及辅助调用合计 2/12/4。最终 AppImage 原生验收 30/30、IDE VSIX 原生验收 24/24 通过，包内一致性复核通过。该次 0.2.16 验证未重新安装系统服务或发起外部模型调用，此前免费回环 TLS 采集检查不替代当时的 UI 验收。0.2.17 双端构建成功，隔离 AppImage 原生验收 30/30、IDE 原生验收 24/24 通过，包含本地时间显示、刷新失败保留旧结果、分页与窄屏检查；全量回归及发布包最终校验结果见根 README，不沿用上述历史数量。

## 主要代码入口

- [src/DesktopDemo.tsx](../sysagent-idc/src/DesktopDemo.tsx)：小管家、拖动、启动器、快照轮询与动态告警演示。
- [src/App.tsx](../sysagent-idc/src/App.tsx)：窗口、导航、设备、运维、日志与公共弹窗。
- [src/HealthGuardPage.tsx](../sysagent-idc/src/HealthGuardPage.tsx)：体检、优化、报告与诊断详情。
- [src/ResourceRankings.tsx](../sysagent-idc/src/ResourceRankings.tsx)：资源 Top10 与 Agent Session 清理。
- [src/HealthPerformance.tsx](../sysagent-idc/src/HealthPerformance.tsx)：性能信息展示。
- [src/AgentDiagnostics.tsx](../sysagent-idc/src/AgentDiagnostics.tsx)：`LiveAgentDiagnostics` 为当前共享实时管家；旧组件保留进程、会话、中断与模拟恢复 Demo。
- [src/AgentOverviewCards.tsx](../sysagent-idc/src/AgentOverviewCards.tsx)：共用 Agent 概览。
- [src/GpuDiagnostics.tsx](../sysagent-idc/src/GpuDiagnostics.tsx)：GPU 事件、Profiling、效率巡检与报告。
- [src/components.tsx](../sysagent-idc/src/components.tsx)：公共图表、状态、弹窗和图标。
- [src/data.ts](../sysagent-idc/src/data.ts)、[src/agent-summary.ts](../sysagent-idc/src/agent-summary.ts)、[src/gpu-diagnostics-data.ts](../sysagent-idc/src/gpu-diagnostics-data.ts)：原始演示数据。
- [src/health-data.ts](../sysagent-idc/src/health-data.ts)：快照类型、评分公式与纯状态变换。
- [src/health-api.ts](../sysagent-idc/src/health-api.ts)、[src/standalone-api.ts](../sysagent-idc/src/standalone-api.ts)：默认离线内存 API。
- [demo-api.ts](../sysagent-idc/demo-api.ts)：Vite 开发服务的独立模拟 HTTP API。
- [src/styles/app.css](../sysagent-idc/src/styles/app.css)：原始页面与响应式样式。
- [src/styles/fonts.css](../sysagent-idc/src/styles/fonts.css)：本地字体。
- [src/styles/electron.css](../sysagent-idc/src/styles/electron.css)：Electron 拖动区域与窗口按钮。
- [electron/main.cjs](../sysagent-idc/electron/main.cjs)：窗口、自定义协议与 IPC。
- [electron/preload.cjs](../sysagent-idc/electron/preload.cjs)：隔离的 `window.sysomDesktop` 桥接。
- [scripts/build-html.mjs](../sysagent-idc/scripts/build-html.mjs)：单文件离线版构建。
- [backend/app/main.py](../sysagent-idc/backend/app/main.py)、[backend/app/routers/](../sysagent-idc/backend/app/routers/)：未接入前端的 FastAPI 骨架。

旧前端源码保存在 `sysom_idc/archive/sysom-guard-src-0.1.2/`，当前入口不再使用旧的 `src/pages/`、`src/api/` 结构。

## 历史 Demo：演示数据与本地 API

以下仅描述早期 Demo 路径，不描述当前 `LiveAgentDiagnostics` 或真实 IDC 采集。Demo UI 调用离线内存 API，每次请求延迟 180ms，不依赖 Vite 或 Python 后端。清理、优化、重新体检、告警采样、Agent 恢复与部署仅变换演示数据，不访问或修改真实设备。操作完成后重新获取完整快照，版本冲突返回 409。

运行时 Session 清理影响 CPU、能耗、内存、GPU 及 FD；磁盘 Session 清理只影响磁盘。活动 Session 和 Agent 父行受保护。初始体检分数为 10.0，全部五项优化完成后为 100.0，四项二期能力仍显示未检查。

Vite 另外提供 `/api/demo`，与默认 UI 内存状态相互独立：

| 接口 | 参数 |
| --- | --- |
| `GET /api/demo/snapshot` | 无，返回完整快照 |
| `POST /api/demo/reset` | `{}`，返回初始完整快照 |
| `POST /api/demo/cleanup` | `resource, ids, revision` |
| `POST /api/demo/optimize` | `ids, revision` |
| `POST /api/demo/inspect` | `revision` |
| `POST /api/demo/sessions/cleanup` | `resource, agentId, sessionIds, revision` |
| `POST /api/demo/alert-sample` | `target, usage, revision`，usage 为 80 或 96 |

POST 要求 `application/json`，请求体不超过 8192 字节。除 reset 外，变更返回新 revision，随后读取 snapshot。非法参数为 400，跨站 Origin 为 403，未知路由为 404，方法错误为 405，版本冲突为 409，过大请求为 413，非 JSON 为 415。

生成内嵌脚本、样式、图标与字体的单文件离线版：

```bash
npm run build:html
```

0.2.6 历史输出为 `sysom_idc/sysagent-idc/release/SysOM管家-0.2.6-demo.html`，不会覆盖原始参考 demo。本文源码目录使用改名后的路径；历史 Demo／发布文件名保留原名，不表示旧产物被重命名或仍可获取。

## 历史 Demo：可选后端骨架

在一个终端启动：

```bash
cd sysom_idc/sysagent-idc
npm run backend:setup
npm run backend
```

服务监听 `127.0.0.1:8787`，接口前缀 `/api`。当前前端不访问该服务，也不需要启动 Python；旧版 `VITE_API_MODE` 和 `VITE_API_BASE` 开关不再使用。

| 接口 | 当前行为 |
| --- | --- |
| `GET /api/healthz` | 健康检查 |
| `GET /api/health/snapshot` | 模拟体检快照 |
| `POST /api/health/scan` | 接收请求，不运行真实体检 |
| `POST /api/health/optimize` | 接收 items，不修改系统 |
| `GET /api/devices` | 模拟设备列表 |
| `GET /api/gpu` | 占位对象 |
| `POST /api/gpu/{device_id}/scan` | 接收请求，不访问 GPU |
| `GET /api/agents` | 占位对象 |
| `POST /api/agents/{agent_id}/restart` | 接收请求，不重启进程 |
| `GET /api/ops/deployments` | 空列表 |
| `POST /api/ops/deploy` | 返回模拟 jobId |
| `GET /api/logs/entries` | 内置日志 |
| `GET /api/logs/tasks` | 空列表 |

现有 FastAPI 端点只提供模拟响应和占位对象，真实采集、诊断、重启、部署与优化逻辑为空。接入真实后端需要另行实现接口契约与页面数据来源，不要把占位响应当成真实能力。

虚拟环境与 Node 依赖不作为源码提交。迁移到其他路径或机器后，用 `npm ci` 和 `npm run backend:setup` 重新创建环境。

## 历史 Demo：自动对照验收

模型和 API 测试：

```bash
cd sysom_idc/sysagent-idc
npm test
```

[tests/health-score.test.cjs](../sysagent-idc/tests/health-score.test.cjs) 包含 13 项测试，使用 `sysom_idc/sysagent-analysis/port/c4-health-data.js` 中的原始逻辑作对照，覆盖评分、清理范围、优化、保护规则、告警、并发版本冲突及 HTTP 参数校验；保留该测试夹具。

先启动 `npm run dev:web`，再在另一终端执行：

```bash
npm ci --prefix sysom_idc/sysagent-analysis
node sysom_idc/sysagent-analysis/tests/run-acceptance.cjs "file://$PWD/sysom_idc/SysOM管家-demo.html" reference-v026 --gpu-only
node sysom_idc/sysagent-analysis/tests/run-acceptance.cjs "http://127.0.0.1:5173/" rebuilt-dev-v026
node sysom_idc/sysagent-analysis/tests/run-acceptance.cjs "file://$PWD/sysom_idc/sysagent-idc/release/SysOM管家-0.2.6-demo.html" rebuilt-offline-v026
```

共享 [tests/acceptance.cjs](../sysagent-analysis/tests/acceptance.cjs) 验证拖动和焦点、五类排行、Session 清理、满分优化、日志状态、Agent 恢复、部署确认、GPU 各流程、告警取消，以及 390/768/1100/1440 四种宽度。报告和截图写入 `sysom_idc/sysagent-analysis/tests/output/`，离线版要求 HTTP 请求数为零。原始对照材料在 `sysom_idc/sysagent-analysis/dom/` 和 `sysom_idc/sysagent-analysis/ui/`。

## 历史 Demo：统一发行

桌面应用与 VSIX 共用 `sysom_idc/sysagent-idc/src/` 中的页面和模拟模型，各运行进程分别持有自己的内存快照。桌面与 IDE 界面角落的产品版本由构建注入，统一来自 `sysom_idc/package.json`。部署弹窗中示例项目的 `v1.2.0` 是 demo 数据，不是产品发行版本。

功能变更后提升根目录版本并执行 `npm --prefix sysom_idc run release`。该命令同步桌面与 IDE 工程的 package 和 lockfile，完整测试后输出 deb、AppImage、离线 HTML、VSIX 四份交付文件及 `sysom_idc/release/release-<version>.json` 和总校验和。最终 VSIX 会解压后在隔离 VS Code 中实际运行验收；任何已完成版本均拒绝再次覆盖，需先提升版本。不自动安装或上传。

## 历史 Demo：二进制验收工具

```bash
npm ci --prefix sysom_idc/sysagent-analysis
APPIMAGE_EXTRACT_AND_RUN=1 node sysom_idc/sysagent-analysis/tests/verify-package.cjs "sysom_idc/sysagent-idc/release/SysOM管家-0.2.6.AppImage"
```

[tests/verify-package.cjs](../sysagent-analysis/tests/verify-package.cjs) 分别以 `SYSOM_GPU=1` 和 `SYSOM_GPU=0` 启动自己的测试应用，确认无 GPU 时相关界面隐藏且未出现 `viz_main_impl` 的 GPU 初始化错误，并验证本地协议、preload、内嵌 PNG 与源码图标逐字节一致、共享 UI 验收及正常退出。另调用 [tests/native-desktop.cjs](../sysagent-analysis/tests/native-desktop.cjs) 验证 6 组原生窗口行为：主页直开、主窗口隐藏与透明置顶浮窗、实际窗口拖动、点击/键盘恢复及系统最小化、隐藏时告警抖动、关闭收起与拖动取消。Linux 上额外通过 xwininfo 核对真实窗口映射状态。

需要图形会话；渲染进程远程调试和主进程 Inspector 端口仅由验收脚本启动，由操作系统分配，测试完成后断开并关闭自己的应用。验收不关闭 Chromium 沙箱，不修改系统权限。

普通开发、安装与使用不需要开启远程调试端口。
