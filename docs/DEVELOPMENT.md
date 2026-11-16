# 开发说明

当前交付版本为 **SysAgent 0.2.18 / GX 0.6.5-2 / AgentSight 0.16.0**，构建输出目录为 `release/build-0.2.18/`（构建后生成，当前工作树未包含发布件）。在项目根目录使用 `npm run build`；**当前随附的 `vendor/sysak/linux-x64/` 仍是旧四命令包，缺少运行时要求的 `idc_inspect`，完整包构建会在 SysAK 准备步骤失败**，详见[根 README 的已知构建缺口](../README.md#3-一键构建)。安装入口见[根 README](../README.md)，当前打包边界见[打包说明](./PACKAGING.md)。下文保留早期 Demo 开发和验收工具记录；其中模拟业务、历史版本、测试数量与旧 Demo 发行命令不代表 0.2.18 的行为或验收。

## 环境

- Ubuntu x86_64 桌面，带可用的图形会话。
- Node.js 22 或 24、npm。
- 系统已安装含 `idc_inspect` 组件的 sysAK 与 Python 3，用于真实资源采集与受控进程操作；采集以当前用户运行。
- Python 3.12 和 venv，用于可选的 FastAPI 后端骨架（未接入前端）。
- 自动截图使用本机 Google Chrome；默认可执行文件为 `/usr/bin/google-chrome`。

应用源码入口为 `sysagent-idc/`，IDE 插件见 [sysagent-ide-extension/README.md](../sysagent-ide-extension/README.md)。本文路径以仓库根目录为基准，命令默认在仓库根目录执行；进入子项目时会显式写出 `cd`。历史段落中的 `sysom_idc/` 前缀是改名前的旧仓库布局，当前仓库没有该层目录。

## 前端与 Electron

```bash
cd sysagent-idc
npm ci
npm run dev
```

`npm run dev` 同时启动 Vite 和 Electron，开发地址为 `http://127.0.0.1:5173`。该端口需空闲；如果已有开发服务器，可直接使用该服务器，不要随意终止其他进程。根目录的 `npm run dev` 不同，它只启动网页（等价于 `npm --prefix sysagent-idc run dev:web`）。

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

Electron 启动直接显示体检主页；系统应用、窗口、标题栏、主页健康中心及关于窗口统一使用浅蓝悬浮小管家 Logo。最小化、系统最小化或关闭主页会隐藏主窗口，显示独立透明、置顶、跳过任务栏的桌面小管家；默认放在主屏幕工作区右下角，拖动限制在显示器工作区。点击或按 Enter 恢复主页并保留快照与已拖动位置，右键小管家选择“退出”才结束进程。

主渲染进程持有当前快照，隐藏时继续按巡检周期读取缓存；浮窗只接收经 IPC 同步的异常摘要和抖动状态，不创建第二份模型。主页左下角“动态告警演示”仍是模拟 80% → 96% 的演示开关，可在等待期间收起主页验证桌面抖动。**资源与体检本身是真实采集**：由主进程/扩展宿主的控制器调用系统 sysAK，不是渲染进程内的模拟采样。浏览器版仍保持网页内桌面模拟，不会创建系统浮窗。

启动时只读识别本机 GPU：[electron/gpu-detect.cjs](../sysagent-idc/electron/gpu-detect.cjs) 读取 Linux PCI 信息、Windows 显卡信息或 macOS 显示信息；桌面 preload 与 IDE Webview 桥接把结果传给页面。[src/gpu-presence.ts](../sysagent-idc/src/gpu-presence.ts) 为纯浏览器提供 WebGL 渲染器判断。识别包含 NVIDIA、AMD、Intel、Apple，不把虚拟显示适配器算作硬件 GPU。未检测到或检测受限时隐藏 GPU 页面、卡片、体检、性能标签和告警选项；可用 `SYSOM_GPU=0|1` 覆盖宿主结果，浏览器可用 `?gpu=0|1`。Linux 无 DRM render 节点时关闭 Chromium 硬件加速，保持沙箱不变。

## 当前资源采集与云端巡检

控制器 [electron/idc-controller.cjs](../sysagent-idc/electron/idc-controller.cjs) 是桌面、IDE 与开发网页共用的唯一采集入口。

- **命令与 schema**：`sysak idc_inspect --request-id <UUID> -o -`，采集 envelope `schema_version = "1.1"`，`collection.profile = "inspection"`。旧 `idc` / `resource_anomaly` / `memgraph` 三命令入口已合并，不再由应用直接调用。
- **sysAK 解析顺序**：`options.sysakBinary` → `SYSOM_SYSAK_BIN` → `/usr/bin/sysak` → `/usr/local/bin/sysak` → `PATH` 各目录。组件目录取二进制 realpath 同目录的 `.sysak_components/`，否则 `/usr/local/sysak/.sysak_components/`；启动前要求 `tools/idc_inspect` 可读且 `.sysak.rules` 含对应条目，避免 sysAK 联网下载组件。失败码为 `UNSUPPORTED_PLATFORM` / `SYSAK_NOT_FOUND` / `SYSAK_COMPONENT_MISSING`，`status.collector.source` 区分 `override` 与 `system`。
- **权限**：采集与受控进程操作都以当前用户直接 spawn 系统 sysAK，不经 root helper。进程操作为 `sysak idc_inspect --process-action check|terminate`，stdin `{manager_pid, targets}`，回包仍是 `schema_version = "1.0"`；目标身份用 PID + starttime 核验，root/其他用户目标返回 `permission_denied`。`sysom-idc.service` 与 `electron/sysak-root.cjs` 现在只服务 AgentSight 采集控制（`controlAgentCollection`）。
- **时限与限额**：采集外层 45 秒（sysAK 内部预算 24 秒、硬超时 30 秒），原始 stdout 上限 8 MiB；进程操作 15 秒、响应 64 KiB；回环 OpenAPI 提交 30 秒、响应 1 MiB。sysAK 启动器会把组件诊断信息混入 stdout，控制器只取首个完整 JSON 对象。
- **展示解析**：采集结果 POST 到进程内回环 OpenAPI `/openapi/v1/collections`（`openapi-service.ts`，契约 `info.version = 1.3.0`）。外层 `mode: "mock"` 是本机部署标签，真实证据由 `state.mode = "collected"`、`task.simulated = false` 表达；两种模式下这一步都执行。
- **1.1 新增覆盖**：进程与 FD 排行导出 `starttime`，新增 `process.top_rss` 与 RAPL 能耗段，GPU 段带卡标识；`status.collection.sections` 逐段给出 `status`/`reason`，`partial` / `unavailable` 不冒充正常。
- **云端巡检**：`loadSysomConfig()` 读到 `SYSOM_POP_ENDPOINT` + `SYSOM_ACCESS_KEY_ID` + `SYSOM_ACCESS_KEY_SECRET` 时 `status.mode = "pre"`，否则 `mock`；`SYSOM_IDC_UPLOAD=0|false|no|off` 显式关闭。pre 模式下 sysAK 完成上传（步骤 1–4）并把 `request_id` 覆盖为 32 位 hex `inspection_id`，控制器据此启动步骤 5 轮询（`GetHostInspection` 3 秒间隔 / 120 秒超时，终态后 `GetInspectionReport`）。上传失败回退 UUID，不轮询，写入 `cloud_inspection.error`。子进程环境只保留 `PATH`/`LANG`/`PYTHONDONTWRITEBYTECODE`，仅 pre 模式放行 `SYSOM_*` 白名单。
- **前端呈现**：[src/HealthGuardPage.tsx](../sysagent-idc/src/HealthGuardPage.tsx) 在本地结论后追加云端进度或 `cloudConclusion()`；“体检报告”按钮在有云端报告时打开 [src/CloudReport.tsx](../sysagent-idc/src/CloudReport.tsx) 的 `CloudReportModal`（`report.itemSummaries`、`summary`、`scope`），否则打开本地报告。刷新成功提示为“资源快照与诊断结论已刷新”，评分环下不再显示等级小字。

开发网页不是隔离演示环境：`demo-api.ts` 在 Vite 开发与预览服务上挂载 `/api/idc`，创建的是真实控制器，默认调用系统 sysAK；环境里有凭据就会真实上传。只做界面调试时用 `SYSOM_IDC_UPLOAD=0`，或不要注入凭据。

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
cd sysagent-idc
npm run build
cd ../sysagent-ide-extension
npm run typecheck
npm run build
```

0.2.16 历史验证：双端类型检查、构建和组包通过，1,372 项定向回归通过（Agent 客户端/OpenAPI/UI 235、采集/安装/控制器/查询/GPU/健康/进程等 1,080、定向打包 57），其中 UI 30 项已计入 235；未把全量历史 SysAK 测试套件计为通过。浏览器使用独立协议测试数据和真实 SysOMOpenAPI，验证 45 进程分页/过滤、证据跳转、稳定统计、空数据与恢复及辅助调用合计 2/12/4。最终 AppImage 原生验收 30/30、IDE VSIX 原生验收 24/24 通过，包内一致性复核通过。该次 0.2.16 验证未重新安装系统服务或发起外部模型调用，此前免费回环 TLS 采集检查不替代当时的 UI 验收。0.2.17 当时双端构建成功，隔离 AppImage 原生验收 30/30、IDE 原生验收 24/24 通过，包含本地时间显示、刷新失败保留旧结果、分页与窄屏检查。这些数量绑定各自发布包，不是 0.2.18 结果；当前验证状态见上文“当前回归测试”，不沿用上述历史数量或哈希。

## 主要代码入口

- [src/DesktopDemo.tsx](../sysagent-idc/src/DesktopDemo.tsx)：小管家、拖动、启动器、快照轮询与动态告警演示。
- [src/App.tsx](../sysagent-idc/src/App.tsx)：窗口、导航、设备、运维、日志与公共弹窗。
- [src/HealthGuardPage.tsx](../sysagent-idc/src/HealthGuardPage.tsx)：体检、优化、报告与诊断详情；云端结论与刷新提示也在这里。
- [src/CloudReport.tsx](../sysagent-idc/src/CloudReport.tsx)：云端巡检报告弹窗、级别/状态/巡检项标签。
- [src/CollectionStatus.tsx](../sysagent-idc/src/CollectionStatus.tsx)、[src/idc-client.ts](../sysagent-idc/src/idc-client.ts)：采集启停、巡检周期与状态详情；客户端类型含 `collector`、`collection`、`cloud_inspection`。
- [src/ResourceRankings.tsx](../sysagent-idc/src/ResourceRankings.tsx)：资源 Top10 与 Agent Session 清理。
- [src/HealthPerformance.tsx](../sysagent-idc/src/HealthPerformance.tsx)：性能信息展示。
- [src/AgentDiagnostics.tsx](../sysagent-idc/src/AgentDiagnostics.tsx)：`LiveAgentDiagnostics` 为当前共享实时管家；旧组件保留进程、会话、中断与模拟恢复 Demo。
- [src/AgentOverviewCards.tsx](../sysagent-idc/src/AgentOverviewCards.tsx)：共用 Agent 概览。
- [src/GpuDiagnostics.tsx](../sysagent-idc/src/GpuDiagnostics.tsx)：GPU 事件、Profiling、效率巡检与报告。
- [src/components.tsx](../sysagent-idc/src/components.tsx)：公共图表、状态、弹窗和图标。
- [src/data.ts](../sysagent-idc/src/data.ts)、[src/agent-summary.ts](../sysagent-idc/src/agent-summary.ts)、[src/gpu-diagnostics-data.ts](../sysagent-idc/src/gpu-diagnostics-data.ts)：原始演示数据。
- [src/health-data.ts](../sysagent-idc/src/health-data.ts)：快照类型、评分公式与纯状态变换。
- [src/health-api.ts](../sysagent-idc/src/health-api.ts)、[src/standalone-api.ts](../sysagent-idc/src/standalone-api.ts)：默认离线内存 API。
- [demo-api.ts](../sysagent-idc/demo-api.ts)：Vite 开发/预览服务的 `/api/idc` 本地采集接口，内部创建**真实** `createIdcController`（不是模拟 API）。
- [electron/idc-controller.cjs](../sysagent-idc/electron/idc-controller.cjs)：采集调度、`idc_inspect` 调用、回环解析、进程操作与云巡检状态机。
- [electron/sysom-client.cjs](../sysagent-idc/electron/sysom-client.cjs)：步骤 5 只读客户端（`GetHostInspection` / `GetInspectionReport` / 轮询）、凭据加载与子进程环境白名单。
- [electron/process-control.cjs](../sysagent-idc/electron/process-control.cjs)：当前用户 `--process-action check|terminate` 调用与回包校验。
- [electron/sysak-root.cjs](../sysagent-idc/electron/sysak-root.cjs)、[build/sysak-root-runner.py](../sysagent-idc/build/sysak-root-runner.py)：固定 root 安装校验与 socket 边界，现仅用于 AgentSight 采集控制。
- [openapi-service.ts](../sysagent-idc/openapi-service.ts)、[electron/query-data.cjs](../sysagent-idc/electron/query-data.cjs)、[electron/local-query-api.cjs](../sysagent-idc/electron/local-query-api.cjs)：展示解析、公共只读查询目录与回环查询服务；`electron/generated/` 由 `npm run build:openapi` 生成，不手改。
- [src/styles/app.css](../sysagent-idc/src/styles/app.css)：原始页面与响应式样式。
- [src/styles/fonts.css](../sysagent-idc/src/styles/fonts.css)：本地字体。
- [src/styles/electron.css](../sysagent-idc/src/styles/electron.css)：Electron 拖动区域与窗口按钮。
- [electron/main.cjs](../sysagent-idc/electron/main.cjs)：窗口、自定义协议与 IPC。
- [electron/preload.cjs](../sysagent-idc/electron/preload.cjs)：隔离的 `window.sysomDesktop` 桥接。
- [scripts/build-html.mjs](../sysagent-idc/scripts/build-html.mjs)：单文件离线版构建。
- [backend/app/main.py](../sysagent-idc/backend/app/main.py)、[backend/app/routers/](../sysagent-idc/backend/app/routers/)：未接入前端的 FastAPI 骨架。

当前入口不再使用旧的 `src/pages/`、`src/api/` 结构；改名前的旧前端备份 `archive/sysom-guard-src-0.1.2/` 未随本仓库提供。

## 开发网页的本地采集接口

`demo-api.ts` 在 Vite 开发服务与 `vite preview` 上挂载 `/api/idc`，内部是真实控制器，因此这些路由会真实采集、真实结束进程，凭据齐全时还会真实上传。仅接受回环 Host，拒绝跨站 Origin，响应 `Cache-Control: no-store`，成功为 `{ok:true,data}`，失败为 `{ok:false,error:{code,message,status,retryable}}`。

| 路由 | 方法 | 说明 |
| --- | --- | --- |
| `/api/idc/status` | GET | 控制器状态，含 `mode`（`mock`/`pre`）、`collector`、`collection`、`cloud_inspection`、`query_api` |
| `/api/idc/snapshot` | GET | 资源快照；`?refresh=true|false` 显式控制是否重新采集 |
| `/api/idc/agent-diagnostic` | GET | Agent 报告；同样支持 `?refresh=` |
| `/api/idc/reset` | POST | 重置本地缓存状态 |
| `/api/idc/operations` | POST | `snapshot`/`inspect`/`cleanup`/`optimize`/`sessions-cleanup`/`alert-sample` 等操作 |
| `/api/idc/process-prepare` | POST | 进程结束前的身份复核与一次性 token |
| `/api/idc/process-execute` | POST | 消费 token 后执行受控 SIGTERM |
| `/api/idc/enabled` | POST | `{enabled}` 采集启停 |
| `/api/idc/interval` | POST | `{inspection_interval_minutes}`，1–1440 整数 |

POST 要求 `application/json`，请求体不超过 8192 字节。非法参数 400、跨站 Origin 403、未知路由 404、方法错误 405、版本冲突 409、过大请求 413、非 JSON 415。这条内部通道与[公共只读查询 API](./LOCAL-HTTP-API.md) 是不同边界：后者只有 GET、需要独立 Bearer token，且永不触发采集或上传。

## 历史 Demo：演示数据与本地 API

以下仅描述早期 Demo 路径，不描述当前 `LiveAgentDiagnostics` 或真实 IDC 采集。Demo UI 调用离线内存 API（[src/health-api.ts](../sysagent-idc/src/health-api.ts)、[src/standalone-api.ts](../sysagent-idc/src/standalone-api.ts)），每次请求延迟 180ms，不依赖 Vite 或 Python 后端。清理、优化、重新体检、告警采样、Agent 恢复与部署仅变换演示数据，不访问或修改真实设备。操作完成后重新获取完整快照，版本冲突返回 409。

运行时 Session 清理影响 CPU、能耗、内存、GPU 及 FD；磁盘 Session 清理只影响磁盘。活动 Session 和 Agent 父行受保护。初始体检分数为 10.0，全部五项优化完成后为 100.0，四项二期能力仍显示未检查。

早期 Vite 曾另外提供 `/api/demo/*`（`snapshot`、`reset`、`cleanup`、`optimize`、`inspect`、`sessions/cleanup`、`alert-sample`），与 UI 内存状态相互独立。**当前 `demo-api.ts` 已不再注册 `/api/demo`，只有上一节的 `/api/idc`**；旧路由表保留为历史记录，不能作为当前接口契约。

生成内嵌脚本、样式、图标与字体的单文件离线版：

```bash
npm run build:html
```

0.2.6 历史输出为 `sysagent-idc/release/SysOM管家-0.2.6-demo.html`，不会覆盖原始参考 demo。历史 Demo／发布文件名保留原名，不表示旧产物被重命名或仍可获取；当前工作树没有 `release/` 目录。

## 历史 Demo：可选后端骨架

在一个终端启动：

```bash
cd sysagent-idc
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

## 当前回归测试

```bash
npm test                              # 根目录：scripts/build.test.mjs + scripts/gx-package.test.cjs
npm run test:api                      # query-data + local-query-api（先生成共享 OpenAPI）
npm run check:versions
npm --prefix sysagent-idc test        # 应用全量 node --test tests/*.test.cjs
npm --prefix sysagent-ide-extension typecheck
```

应用目录当前测试文件覆盖：采集与控制器（`idc-controller`、`openapi-service`、`fixtures`）、步骤 5 客户端与凭据白名单（`sysom-client`）、云端报告渲染（`cloud-report-ui`）、受控进程操作（`process-control`）、root 辅助与打包（`sysak-root`、`sysak-root-helper`、`sysak-package`、`gx-runtime`）、AgentSight（`agentsight-client`、`agentsight-collection`、`agentsight-installer`、`agent-openapi`、`agent-diagnostics-ui`）、GPU 与查询（`gpu-diagnostics-ui`、`query-data`、`local-query-api`）以及历史评分对照（`health-score`）。这些用例使用注入替身与固定夹具，不触网、不安装服务、不发起真实采集或上传。

两个已知环境性问题：`health-score.test.cjs` 读取 `sysagent-analysis/port/c4-health-data.js`，该对照夹具未随仓库提供，会 ENOENT 失败；`sysak-package.test.cjs` 的 15 秒 `spawnSync` 上限在全量并发下偶发超时，单独运行可通过。二者都不代表采集或上传链路失败，也不要据此宣称全量通过。

云端上传链路的正向验证需要真实凭据与可达 endpoint，属于显式授权的预发实测，不在默认测试范围内；默认测试只验证状态机、凭据门槛与失败回退。

## 历史 Demo：自动对照验收

以下命令与数量属于早期 Demo 阶段。模型和 API 测试：

```bash
cd sysagent-idc
npm test
```

[tests/health-score.test.cjs](../sysagent-idc/tests/health-score.test.cjs) 包含 13 项测试，使用 `sysagent-analysis/port/c4-health-data.js` 中的原始逻辑作对照，覆盖评分、清理范围、优化、保护规则、告警、并发版本冲突及 HTTP 参数校验。**该对照夹具与原始参考 demo 未随本仓库提供，因此这 13 项当前无法运行**，保留测试文件只为历史对照。

先启动 `npm run dev:web`，再在另一终端执行（历史命令，参考材料缺失时不可用）：

```bash
npm ci --prefix sysagent-analysis
node sysagent-analysis/tests/run-acceptance.cjs "file://$PWD/SysOM管家-demo.html" reference-v026 --gpu-only
node sysagent-analysis/tests/run-acceptance.cjs "http://127.0.0.1:5173/" rebuilt-dev-v026
node sysagent-analysis/tests/run-acceptance.cjs "file://$PWD/sysagent-idc/release/SysOM管家-0.2.6-demo.html" rebuilt-offline-v026
```

共享 [tests/acceptance.cjs](../sysagent-analysis/tests/acceptance.cjs) 验证拖动和焦点、五类排行、Session 清理、满分优化、日志状态、Agent 恢复、部署确认、GPU 各流程、告警取消，以及 390/768/1100/1440 四种宽度。报告和截图写入 `sysagent-analysis/tests/output/`，离线版要求 HTTP 请求数为零。原始对照材料曾在 `sysagent-analysis/dom/` 和 `sysagent-analysis/ui/`，当前仓库只保留 `sysagent-analysis/tests/` 脚本。注意 `dev:web` 现在挂真实控制器，这类历史验收脚本不再代表隔离演示环境。

## 历史 Demo：统一发行

桌面应用与 VSIX 共用 `sysagent-idc/src/` 中的页面，各运行进程分别持有自己的缓存快照。桌面与 IDE 界面角落的产品版本由构建注入，统一来自根目录 `package.json`。部署弹窗中示例项目的 `v1.2.0` 是 demo 数据，不是产品发行版本。

早期流程是提升根目录版本后执行 `npm --prefix sysom_idc run release`，输出 deb、AppImage、离线 HTML、VSIX 四份交付文件及 `release/release-<version>.json`。**该脚本不是当前入口**：当前根目录 `npm run release` 等价于 `npm run build`（`scripts/build.mjs`），输出三个 deb 与 VSIX，不生成 AppImage 或离线 HTML，也不生成 `release-<version>.json`。不自动安装或上传。

## 历史 Demo：二进制验收工具

```bash
npm ci --prefix sysagent-analysis
APPIMAGE_EXTRACT_AND_RUN=1 node sysagent-analysis/tests/verify-package.cjs "sysagent-idc/release/SysOM管家-0.2.6.AppImage"
```

[tests/verify-package.cjs](../sysagent-analysis/tests/verify-package.cjs) 分别以 `SYSOM_GPU=1` 和 `SYSOM_GPU=0` 启动自己的测试应用，确认无 GPU 时相关界面隐藏且未出现 `viz_main_impl` 的 GPU 初始化错误，并验证本地协议、preload、内嵌 PNG 与源码图标逐字节一致、共享 UI 验收及正常退出。另调用 [tests/native-desktop.cjs](../sysagent-analysis/tests/native-desktop.cjs) 验证 6 组原生窗口行为：主页直开、主窗口隐藏与透明置顶浮窗、实际窗口拖动、点击/键盘恢复及系统最小化、隐藏时告警抖动、关闭收起与拖动取消。Linux 上额外通过 xwininfo 核对真实窗口映射状态。

需要图形会话；渲染进程远程调试和主进程 Inspector 端口仅由验收脚本启动，由操作系统分配，测试完成后断开并关闭自己的应用。验收不关闭 Chromium 沙箱，不修改系统权限。

普通开发、安装与使用不需要开启远程调试端口。
