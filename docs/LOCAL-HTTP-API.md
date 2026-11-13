# SysAgent 管家本机查询 API

## 目标与边界

面向本机脚本、其他应用和 Agent，尽可能查询管家已有的信息，而非仅复用页面显示的 Top10。查询与执行分离：此次仅开放查询，不通过公共 HTTP 暴露进程终止、配置修改、任意命令、文件读取或上传。

当前说明对应 SysAgent 0.2.17（独立 AgentSight 0.16.0），不是旧版 0.2.6 Demo。真实资源与体检来自 sysAK IDC，部分模块已有独立证据链；是否可用以当前能力和证据状态为准。模拟、未采集、部分采集和失败不得冒充正常。旧发行件不自动获得新接口。

## 调研与选择

本机 HTTP/JSON 是常见做法，但不是唯一做法：

| 方式 | 优点 | 局限 | SysAgent 用途 |
| --- | --- | --- | --- |
| 回环 HTTP/JSON | curl、Python、Node 和其他语言均可直接调用；可提供 OpenAPI 契约 | 同机其他用户也可能访问端口；必须认证和验证 Host/Origin | 普通权限下开放查询 |
| Unix domain socket | 可结合文件权限与 peer 凭据约束调用者，不暴露 TCP 端口 | 跨平台及通用客户端接入较复杂 | 保留现有 root IDC 执行边界 |
| 应用 IPC/Webview RPC | 适合应用内部通信及受信 UI 调用 | 外部程序不便使用，属于宿主内部协议 | 保留桌面与 IDE 内部通道 |

Ollama 的官方 API 使用本机 HTTP；Docker 默认通过 Unix socket 提供 Engine API，也支持受保护的其他传输。说明这两种选择均有成熟实践，不需要将特权执行能力一起搬到公共 HTTP。

仅绑定 `127.0.0.1` 不等于安全：DNS rebinding、浏览器访问和多用户本机访问仍需考虑。MCP HTTP 传输规范要求校验 Origin、建议本机绑定和认证；Ollama 的历史 DNS rebinding 漏洞也说明 Host 校验不能省略。

选用版本化只读 HTTP API，保留普通权限进程；不改动 root 服务、授权配置和特权 socket。使用 Bearer 认证、严格回环 Host 校验、拒绝浏览器 Origin，不开启通配 CORS。凭据不出现在 URL、日志或响应数据里。本地凭据发现需要限定为当前用户可读；不能把内部写接口的 token 同时发给查询客户端。

## 查询设计要求

- 能力发现：列出真实可查询的数据集、可用状态、字段和查询参数；未知能力不默默返回 Demo。
- 完整快照：提供一次一致性读取，保留版本、采集时间、来源、状态、覆盖范围和不可用原因。
- 列表查询：按已有数据的名称、ID、类型、状态等筛选；支持分页、排序和字段投影，不执行用户表达式或 SQL。
- 明确覆盖：进程排行榜当前采集有上限，不因为 API 返回更多行而称为全系统进程数据库；未实现的时序历史或 Session 资源归属明确说明。
- 详情与报告：查询已存的资源、体检、建议、任务、结果与结构化报告，不在 GET 时隐式开始高成本诊断或改变采集配置。
- 原始证据：仅查询已解析并保留的业务证据，不提供任意路径文件读取、任意 root 命令或秘密配置。
- 错误：无数据、来源不可用、版本变化、无权限分别返回明确错误，不使用 0 或健康结论掩盖缺失。
- 契约：提供机器可读 OpenAPI 描述及 curl/Python 示例，使客户端可以自主发现和接入。
- 生命周期：进程退出时关闭查询服务；服务实例与数据版本明确，不将一次进程内缓存描述为持久化历史库。

## 现有功能与对外查询清单

| 功能 | 查询信息／数据集 | 真实性及限制 |
| --- | --- | --- |
| 采集器 | `status`：安装、启停、周期、下一次巡检、最近资源／体检任务、错误 | 普通权限控制器状态；不公开内部写 token |
| 整体体检 | `snapshot`、`summary`、`report`、`inspections`、`optimizations` | 保留分数算法、未检查／受限、证据和建议；健康页面 Agent／日志／网络／I/O 部分项尚无证据链 |
| CPU／内存／磁盘／能耗／GPU | `resources`、`resource-rows` | 完整已存资源和排行，不限 UI Top10；进程采集整体 Top20 与 Agent Top20 去重，单资源最多约 40 行，并非全进程库 |
| 进程资源 | `resource-rows` 的 PID、starttime、usage、quantity、agentKind | 内存是 RSS；磁盘行是 B/s I/O 速率，不是进程／目录磁盘占用；清理资格仅信息，不开放执行 |
| GPU 当前状态 | `gpu-devices`、`gpu-findings`、`gpu-jobs` | 卡级遥测、sysAK AI 检查及短采样窗口的进程诊断；按需运行，无 GPU／未运行／部分／失败均明确 |
| Agent 运行与诊断 | `agent-processes`、`agent-findings`、`agent-coverage` | 独立 AgentSight 服务提供证据，SysAgent OpenAPI 分析；与健康页面 Agent 检查项分开 |
| Agent Session | `agent-sessions` | 模型、会话数、token、首末时间；没有对话正文或 Session 真实资源归属 |
| Agent 中断与耗时 | `agent-interruptions`、`agent-latency` | 已消费的中断事件、严重度、解决状态、TTFT／E2E／TPS／TPOT；保留覆盖原因 |
| 操作与任务 | `operations`、`tasks` | 操作最多 30 条；成功采集／诊断任务最多 100 条，仅本进程生命周期，不是持久化任务数据库 |
| 导出报告 | `report` | 根据已有缓存生成结构化 JSON 与健康报告文本，不另行采集；无历史报告库 |
| 设备列表、日志样例、GPU 离线案例 | 能力发现标明不开放为真实数据 | 静态 Demo、React 局部状态及离线样例，不冒充本机事实；不代理 AgentSight 任意路径 |

控制器／内部 OpenAPI 的 `mode: "mock"` 是现有部署标签，不表示快照一定为模拟。外部程序应结合 `state.mode: "collected"`、任务 `simulated: false`、来源、时间和覆盖状态判断；任何缺证据／受限结果都不代表健康。

Agent 证据当前固定最近 24 小时，最多 256 个进程、500 个会话和 200 个未解决中断。API 分页只对已有缓存分页，不能拓宽上游窗口或补齐未采到的信息；每个数据集的元信息和目录限制优先于上述概述。

## 0.2.17 Agent 管家视图与查询边界

桌面和 IDE 共用紧凑的实时诊断视图，固定最近 24 小时。四张 KPI（会话数、输入 Token、输出 Token、全窗口未处理中断）始终保留，未返回报告或数值缺失显示 `—`，`0` 仅表示来源记录为零；会话与 Token 包含辅助调用，输入已含缓存用量，上游缺失 usage 可能未计入。API 与真实采集状态独立；“数据范围”仅保留统计时间、更新时间和覆盖状态，来源部署与授权说明见安装文档，不在诊断页重复展示。

- 默认“总览”前置诊断结论与按类型归组的问题，可跳转只读证据；展示实测延迟对比和进程探活。进程支持名称/PID、角色/状态组合筛选和每页 20 条分页，筛选回第一页且全窗口统计不变；HTTP 响应不代表业务健康，正常 CLI 无监听端口不视为故障。
- “会话”只对已有列表进行 Agent / ID / Model 搜索，按最后活跃时间降序、同时间按 ID 排序；全窗口 KPI 不受搜索影响。展开仅看首末时间与关联中断元数据，不请求正文。
- “中断”以紧凑表和只读九字段弹窗展示事件 ID、类型、严重度、发生时间、Session ID、Call ID、PID、Agent、处理状态。仅在报告已有关联会话时可跳转，不请求补采或修改状态。明细条数不代替全窗口未处理中断 count。
- “延迟”按 E2E P95 / TTFT P95 / TPS P50 切换实测对比；详细表保留完整调用数、流式调用数及 TTFT P95、E2E P95、TPS P50、TPOT P95。仅统计完整调用，TTFT / TPOT 仅适用于流式调用，无自定故障阈值。

页面搜索、展开、切换指标和查看事件只是本地报告交互，不改变 HTTP 查询参数、采集授权或数据来源，不直接获取对话正文、不提供 Session 独占 CPU/GPU 归属、不自动修复、部署或发起付费调用。停用采集保留已有历史。刷新失败仍显示上次报告并明确标记“旧结果 · 刷新失败”，更新中亦标明尚未更新；不能将旧结果当作本次采集成功。公共 GET 仍只读取宿主缓存，UI 的刷新诊断沿用内部报告通道，不新增公共执行接口。

## HTTP 路径

所有路径均需独立查询 Bearer token；只有 `GET`。数据尚未采集时 `snapshot` 返回 `null` 并附缓存时间；需要结果的数据集／分数／报告返回 `503`，不自动采集。已有部分或不可用证据保留原状态，而不是伪造完整数据。

| 路径 | 内容 |
| --- | --- |
| `/api/v1/capabilities` | 目录、可查询字段、来源、限制与未开放功能 |
| `/api/v1/status` | 控制器与本机查询服务状态 |
| `/api/v1/snapshot` | 一次一致性读取 status、health state、Agent 诊断和任务缓存 |
| `/api/v1/summary` | 与界面一致的健康分数、评分范围、未知／不可用数量 |
| `/api/v1/report` | 全量结构化报告及健康文本；文本排行沿用界面 Top10，JSON 保留完整缓存 |
| `/api/v1/datasets/{name}` | 指定数据集筛选、排序、投影、分页 |
| `/api/v1/datasets/{name}/{id}` | 指定缓存对象详情 |
| `/api/v1/openapi.json` | OpenAPI 3.1 契约（与内部 `/openapi/v1` 契约分离） |

### 列表参数

- `filter.<field>=value`：精确匹配；同字段重复值为 OR，不同字段为 AND；标量数组按包含元素匹配（例如 `filter.ports=7396`、`filter.gpuIndices=0`）。
- `min.<field>`／`max.<field>`：数字或 ISO 时间范围，具体合法字段以目录为准。
- `q`：已有数据文本检索，不执行表达式或正则。
- `sort=-usage,pid`：逗号字段，`-` 为降序。
- `fields=id,resource,name,pid,usage`：字段投影；未指定时返回完整对象。
- `offset`／`limit`：默认 0／100；每页上限 1000。`total` 是筛选后缓存条数，`next_offset` 指示下一页。
- `revision`：资源快照版本前置条件；不匹配返回 `409`，用于避免跨版本拼接排行。Agent 有独立采样时间，客户端跨页应同时核对元信息中的时间。

未知字段、非法参数、非规范路径、尝试访问对象原型均拒绝。资源排行保留原始 `id`，详情使用 `queryId`（`resource:原始id`），应整体 URI 编码。合成 ID 仅在当前快照中有效，目录注明身份规则；有 PID 的进程应联合 starttime 核对身份。缓存未落盘，重启会失去任务与结果历史。

## 启动、发现与接入

桌面在创建控制器时、IDE 在扩展激活时自动启动回环查询服务；每个实例随机端口、独立 token。**不固定占用 8787 或 AgentSight 的端口**，不将原有内部采集接口 token 发给外部程序。

凭据文件为宿主存储目录下的 `local-api/<instance UUID>.json`：

- 桌面：Electron `app.getPath('userData')/local-api/`。
- IDE：VS Code／Qoder IDE 扩展的 `context.globalStorageUri/local-api/`，扩展标识为 `sysagent-local.sysagent-ide`。
- Linux 常见默认路径分别是 `$XDG_CONFIG_HOME/sysagent-idc/local-api/`（未设置时 `~/.config`）和 VS Code 的 `~/.config/Code/User/globalStorage/sysagent-local.sysagent-ide/local-api/`；产品名称或自定义 profile 可改变路径，不应硬编码。
- 目录仅当前用户访问（0700），JSON 文件仅当前用户读取（0600），直接父目录必须由当前用户拥有且不可由组／其他用户写入。既有不安全权限或符号链接会使查询服务拒绝启动，不自动改权限；原体检功能保留，`status.query_api.error` 提供失败状态。
- JSON 含 `base_url`、`token`、`instance_id`、`host_kind`、`pid`、`device_id`、启动时间。不要将该文件上传或提交，亦不要把 token 放入 URL。
- 正常退出删除自身凭据并关闭端口；崩溃可能留下旧文件，客户端应尝试连接并核对 instance，不依据文件存在就判断存活。多个桌面／IDE 实例的数据**不共享**；关闭所有宿主后没有常驻 HTTP 服务。

先在管家界面获取资源或运行相应 GPU／Agent 诊断，再从其他程序读取缓存。API 的 GET 本身永远不触发采集；后台已有巡检计划仍按原规则运行。

### Python（仅标准库）

将 `SYSOM_QUERY_DISCOVERY` 设置为所选实例的实际 JSON 文件路径；下面代码只打印查询结果，不打印凭据：

```python
import json, os, urllib.parse, urllib.request

with open(os.environ['SYSOM_QUERY_DISCOVERY'], encoding='utf-8') as file:
    endpoint = json.load(file)


def query(route, parameters=None):
    url = endpoint['base_url'] + route
    if parameters:
        url += '?' + urllib.parse.urlencode(parameters)
    request = urllib.request.Request(url, headers={
        'Authorization': 'Bearer ' + endpoint['token'],
    })
    with urllib.request.urlopen(request, timeout=5) as response:
        return json.load(response)

print(json.dumps(query('/api/v1/capabilities'), ensure_ascii=False, indent=2))
print(json.dumps(query('/api/v1/datasets/resource-rows', {
    'filter.resource': 'cpu', 'sort': '-usage',
    'fields': 'id,resource,name,pid,starttime,agentKind,usage,quantity',
    'limit': 100,
}), ensure_ascii=False, indent=2))
```

### curl（不把 token 放在进程命令行）

凭据经 stdin 传给 curl 的配置输入；命令不输出 token，不使用 `-v`：

```bash
python3 - <<'PY' | curl --silent --show-error --fail --config -
import json, os
with open(os.environ['SYSOM_QUERY_DISCOVERY'], encoding='utf-8') as file:
    endpoint = json.load(file)
print('url = ' + json.dumps(endpoint['base_url'] + '/api/v1/snapshot'))
print('header = ' + json.dumps('Authorization: Bearer ' + endpoint['token']))
PY
```

## 构建与验证

本接口改动位于 `sysom_idc/sysagent-idc/electron/`，桌面和 IDE 通过同一个控制器启动；查询目录与契约来自 `query-data.cjs`。桌面报告函数通过 `openapi-service.ts` 导出并由既有 `build:openapi` 生成共享 CommonJS，IDE 直接复用相同 TypeScript 源函数，不能手改 generated 文件。源码构建需先在 `sysom_idc/sysagent-idc` 执行 `npm run build`，再在 `sysom_idc/sysagent-ide-extension` 执行 `npm run typecheck && npm run build`。

0.2.17 双端构建成功，隔离 AppImage 原生验收 30/30、IDE 原生验收 24/24 通过；全量回归及最终发布包校验结果见根 README，不沿用旧版本数量或哈希。

**0.2.15 历史验证：** 当时包含共享紧凑 Agent 管家及既有只读本机查询链路，不新增正文、进程执行或自动动作接口。双端分别构建成功，1,359 项定向回归通过；最终 AppImage 实际验收 23 项、VS Code 1.145.2 IDE 验收 15 项通过，覆盖有界 AgentSight → OpenAPI → 页面证据链与缺失/零值、来源失败和只读交互。包内代码与当时构建一致，离线包逐文件及归档校验通过；该次验证未重新安装，也未认证所有真实采集场景，不能作为 0.2.17 结果。当前打包说明见[打包文档](./PACKAGING.md)；生成/解压新包不替换已安装软件，需按[根 README](../README.md)安装并重启。

### 历史查询接口开发验证（0.2.14 源码）

以下是此前接口开发验证，不能视为 0.2.15 新 UI 验收。当时接口尚未进入旧 0.2.14 发行件；该次未安装、不改 root 服务、未发布、不发送真实进程信号。桌面 `npm run build`、IDE `npm run typecheck` 与 `npm run build` 通过，新增查询／HTTP 测试 36/36（含真实 HTTP 响应对 OpenAPI Schema 校验、编码详情 ID、端口／GPU 索引筛选、完整排行、缓存无采集副作用、认证／Host／Origin／写请求拒绝与生命周期）。另通过控制器与 Agent 缓存／有界任务记录回归。全量 Node 回归退出 0；后续契约／数组筛选修正重跑新增 36 项，UI 模型与进程控制关键回归 228/228 通过，当时统一版本检查为 0.2.14。

隔离 VS Code 1.145.2 使用最终构建扩展通过 5 项宿主检查与 Webview 验收：实际启动 HTTP、0600 凭据发现、认证快照查询、未认证 401／写入 405、缺证据保持空值；严格 CSP 页面无脚本错误、无溢出、无伪造分数，无宿主子进程／信号／外部请求尝试。首次缺服务验收等待状态超时；最终在测试进程中仅对固定安装证据路径注入缺失夹具后通过，不改变机器上的安装、权限或服务。

真实 root 成功采集、真实 GPU／AgentSight 服务端数据及原生 Electron GUI 该次没有重新验收；正向数据查询以既有解析链与隔离证据夹具验证，不将缺服务测试视为真实采集通过。

## 调研来源

- [Ollama API Introduction](https://docs.ollama.com/api/introduction)
- [Docker：保护 daemon socket](https://docs.docker.com/engine/security/protect-access/)
- [MCP Streamable HTTP：安全要求](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http)
- [NCC Group：Ollama DNS rebinding 漏洞](https://www.nccgroup.com/research/technical-advisory-ollama-dns-rebinding-attack-cve-2024-28224/)
- [OpenAPI Initiative：机器可读 API 描述](https://learn.openapis.org/)
