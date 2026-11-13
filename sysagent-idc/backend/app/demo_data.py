"""Static demo payloads matching the frontend mock adapter.

The backend is intentionally a skeleton: replace these values with real
SysAgent collectors when wiring the product to actual hardware.
"""

from typing import Any

RESOURCE_NAMES = {
    "cpu": ["本地模型推理", "训练任务", "过期 Python Worker", "数据库服务", "Agent 运行时", "闲置索引 Worker", "桌面与系统服务", "完成的分析任务", "残留调试任务", "监控采集进程"],
    "energy": ["本地模型推理", "训练任务", "过期推理 Worker", "数据库服务", "Agent 运行时", "闲置索引 Worker", "桌面与系统服务", "完成的分析任务", "残留调试任务", "监控采集进程"],
    "memory": ["本地模型权重", "数据库缓存", "闲置模型缓存", "运行中推理任务", "系统服务", "过期任务中间结果", "内核与文件缓存", "完成的聚合结果", "残留调试缓存", "设备监控服务"],
    "disk": ["模型权重目录", "用户数据与项目", "过期运行日志", "正在使用的容器镜像", "当前任务检查点", "可再生工具缓存", "系统与依赖包", "过期临时目录", "已导出分析副本", "当前服务数据"],
    "gpu": ["运行中推理任务", "训练任务", "闲置模型显存缓存", "业务推理 Worker", "嵌入模型服务", "过期张量缓存", "图形与系统服务", "完成的测试任务", "残留测试上下文", "设备监控上下文"],
}

RESOURCE_VALUES = {
    "cpu": [28, 18, 13, 10, 8, 6, 4, 3, 2, 1],
    "energy": [24, 17, 11, 8, 6, 5, 4, 3, 3, 3],
    "memory": [30, 20, 12, 9, 7, 6, 4, 3, 2, 1],
    "disk": [35, 20, 14, 8, 6, 4, 3, 2, 2, 2],
    "gpu": [38, 24, 12, 6, 4, 3, 2, 1, 1, 1],
}

DISK_DETAILS = ["/models", "/workspace", "/var/log/archive", "/containers/active", "/checkpoints", "/cache/tools", "/usr", "/tmp/expired", "/exports/copies", "/services/data"]

RESOURCE_LABELS = {
    "cpu": "CPU 利用率",
    "energy": "能耗",
    "memory": "系统内存",
    "disk": "系统磁盘",
    "gpu": "GPU 利用率",
}

RESOURCE_UNITS = {
    "cpu": "整机占比",
    "energy": "能耗预算占比 · 估算",
    "memory": "总容量占比",
    "disk": "总容量占比",
    "gpu": "总 GPU 占比",
}

INSPECTIONS = [
    {"id": "agents", "label": "Agent 诊断", "important": False, "phase": 1, "status": "abnormal", "usage": None, "detail": "日志分析 Agent 队列接近上限", "evidence": ["演示工作队列 28 / 32", "请求延迟 3,200 ms；进程仍存活"]},
    {"id": "gpu", "label": "GPU 诊断", "important": False, "phase": 1, "status": "normal", "usage": None, "detail": "基础硬件检查未见异常", "evidence": ["演示 Xid / ECC 错误 0", "GPU 基础诊断与整体利用率分别计数"]},
    {"id": "root", "label": "根目录诊断", "important": True, "phase": 1, "status": "abnormal", "usage": 96, "detail": "", "evidence": []},
    {"id": "memory", "label": "内存诊断", "important": True, "phase": 1, "status": "abnormal", "usage": 94, "detail": "", "evidence": []},
    {"id": "fd", "label": "FD 诊断", "important": True, "phase": 1, "status": "abnormal", "usage": 95, "detail": "", "evidence": []},
    {"id": "logs", "label": "日志诊断", "important": False, "phase": 1, "status": "abnormal", "usage": None, "detail": "Debug 日志采样过密", "evidence": ["演示 Debug 采样 100%", "降低采样不等于清除历史日志"]},
    {"id": "load", "label": "负载诊断", "important": False, "phase": 2, "status": "unchecked", "usage": None, "detail": "二期规划 · 本次未检查", "evidence": []},
    {"id": "network", "label": "网络诊断", "important": False, "phase": 2, "status": "unchecked", "usage": None, "detail": "二期规划 · 本次未检查", "evidence": []},
    {"id": "security", "label": "安全扫描", "important": False, "phase": 2, "status": "unchecked", "usage": None, "detail": "二期规划 · 本次未检查", "evidence": []},
    {"id": "system", "label": "系统与配置", "important": False, "phase": 2, "status": "unchecked", "usage": None, "detail": "二期规划 · 本次未检查", "evidence": []},
]

DEVICES = [
    {"id": "dc-02", "name": "本地 AI 工作站", "kind": "server", "address": "192.168.1.100", "status": "warning", "cpu": 93, "memory": 94, "gpu": 92, "health": 10, "uptime": "12 天 8 小时", "hardware": "NVIDIA A100 × 2", "memorySize": "256 GB", "local": True},
    {"id": "dc-01", "name": "GPU 训练节点", "kind": "server", "address": "10.24.8.21", "status": "healthy", "cpu": 42, "memory": 51, "gpu": 78, "health": 92, "uptime": "28 天 16 小时", "hardware": "NVIDIA A100 × 8", "memorySize": "512 GB"},
    {"id": "mini-dev", "name": "Yoga mini · 开发端", "kind": "mini", "address": "192.168.1.108", "status": "healthy", "cpu": 24, "memory": 46, "gpu": None, "health": 97, "uptime": "6 天 3 小时", "hardware": "CPU 推理 · 示例配置", "memorySize": "32 GB"},
    {"id": "micro-office", "name": "微主机 · 办公网", "kind": "micro", "address": "192.168.1.112", "status": "healthy", "cpu": 18, "memory": 38, "gpu": None, "health": 96, "uptime": "18 天 5 小时", "hardware": "无独立 GPU", "memorySize": "16 GB"},
    {"id": "mini-lab", "name": "Yoga mini · 实验室", "kind": "mini", "address": "192.168.1.120", "status": "healthy", "cpu": 12, "memory": 31, "gpu": None, "health": 98, "uptime": "3 天 11 小时", "hardware": "CPU 推理 · 示例配置", "memorySize": "32 GB"},
    {"id": "micro-edge", "name": "微主机 · 边缘节点", "kind": "micro", "address": "10.24.8.32", "status": "offline", "cpu": 0, "memory": 0, "gpu": None, "health": 0, "uptime": "上次在线 15 分钟前", "hardware": "无独立 GPU", "memorySize": "16 GB"},
]

LOG_ENTRIES = [
    {"time": "14:28:04.182", "level": "INFO", "service": "inference-gateway", "message": "request completed · model=local-qwen · latency=842ms"},
    {"time": "14:28:05.036", "level": "INFO", "service": "agent-runtime", "message": "checkpoint saved · task=log-analysis-012 · batch=184"},
    {"time": "14:28:06.214", "level": "WARN", "service": "agent-runtime", "message": "worker queue approaching limit · active=28 · capacity=32"},
    {"time": "14:28:07.893", "level": "INFO", "service": "node-collector", "message": "metrics collected · cpu=32% · memory=68% · gpu=56%"},
    {"time": "14:28:09.127", "level": "ERROR", "service": "workspace-web", "message": "database query timeout · query_id=sql-078 · duration=3200ms"},
    {"time": "14:28:10.422", "level": "INFO", "service": "inference-gateway", "message": "request completed · model=local-qwen · latency=761ms"},
    {"time": "14:28:12.081", "level": "WARN", "service": "workspace-web", "message": "slow query detected · query_id=sql-078 · rows_examined=48219"},
    {"time": "14:28:14.736", "level": "INFO", "service": "agent-runtime", "message": "local aggregation completed · input=12000 · groups=38"},
]


def build_resources() -> dict[str, dict[str, Any]]:
    resources: dict[str, dict[str, Any]] = {}
    for resource_id, names in RESOURCE_NAMES.items():
        rows = [
            {
                "id": f"{resource_id}-{index}",
                "name": name,
                "usage": RESOURCE_VALUES[resource_id][index],
                "detail": DISK_DETAILS[index] if resource_id == "disk" else f"演示对象 {index + 1:02d}",
            }
            for index, name in enumerate(names)
        ]
        resources[resource_id] = {
            "id": resource_id,
            "label": RESOURCE_LABELS[resource_id],
            "usage": sum(row["usage"] for row in rows),
            "capacity": 256 if resource_id == "memory" else 1000 if resource_id == "disk" else None,
            "unit": RESOURCE_UNITS[resource_id],
            "rows": rows,
        }
    return resources


def health_snapshot() -> dict[str, Any]:
    return {
        "revision": 1,
        "sampledAt": "15:22:40",
        "score": 10.0,
        "resources": build_resources(),
        "inspections": INSPECTIONS,
        "operations": [],
    }
