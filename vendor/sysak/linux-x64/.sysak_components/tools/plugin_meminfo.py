#!/usr/bin/env python
# -*- coding: utf-8 -*-
import os
import sys
from plugin_system import *
from collections import OrderedDict
import mem_utils


@plugin(name="meminfo")
@plugin_requires("podDetect")
@plugin_pod_support()
class MeminfoPlugin(PluginBase):
    """内存信息插件，用于收集系统/pod内存信息

    Args:
        MemgraphPluginBase (_type_): _description_
    """

    def get_cgroup_mem(self, context, cgroup_path):
        """获取 cgroup 的内存信息

        Returns:
            {
                "usage": cgroup内存使用情况,
                "limit": cgroup内存限制,
                "cache": cgroup缓存内存,
                "rss": cgroup匿名内存,
                "rss_huge": cgroup大页内存（匿名）,
                "shmem": cgroup共享内存,
                "inactive_anon": cgroup不活跃匿名内存,
                "active_anon": cgroup活跃匿名内存,
                "inactive_file": cgroup不活跃文件内存,
                "active_file": cgroup活跃文件内存,
            }
            }
        """
        meminfo = OrderedDict()
        is_v1 = context.get_collect_info("podDetect").load("cgroup_version") == "v1"
        dfile = "/memory.stat"
        usage = "/memory.usage_in_bytes" if is_v1 else "/memory.current"
        limit = "/memory.limit_in_bytes" if is_v1 else "/memory.max"

        mem_stat = (
            {
                "total_cache": "cache",
                "total_rss": "rss",
                "total_rss_huge": "rss_huge",
                "total_shmem": "shmem",
                "total_inactive_anon": "inactive_anon",
                "total_active_anon": "active_anon",
                "total_inactive_file": "inactive_file",
                "total_active_file": "active_file",
                "total_unevictable": "mlocked",
            }
            if is_v1
            else {
                "file": "cache",
                "anon": "rss",
                "anon_thp": "rss_huge",
                "shmem": "shmem",
                "inactive_anon": "inactive_anon",
                "active_anon": "active_anon",
                "inactive_file": "inactive_file",
                "active_file": "active_file",
                "unevictable": "mlocked",
            }
        )

        with open(cgroup_path + usage, "r") as f:
            meminfo["usage"] = int(f.read().strip())

        with open(cgroup_path + limit, "r") as f:
            res = f.read().strip()
            if res == "max":
                meminfo["limit"] = sys.maxsize
            else:
                meminfo["limit"] = int(res)

        with open(cgroup_path + dfile, "r") as f:
            lines = f.readlines()
            for line in lines:
                items = line.strip().split()
                if len(items) < 2:
                    continue
                key = items[0].strip()
                value = int(items[1].strip())
                if key in mem_stat:
                    meminfo[mem_stat[key]] = value

        return meminfo

    def collect_pod(self, context):
        """收集 Pod及其容器的内存信息

        collect_info = {
            "pod_name": {
                .... //内存信息
            },
            "container1_name": {
                .... //内存信息
            },
            "container2_name": {
                .... //内存信息
            }
        }
        """
        collect_info = PluginCollectInfo()
        pod_info = context.get_collect_info("podDetect").load("pod_info")
        containers = context.get_collect_info("podDetect").load("containers")
        cgroup_root = context.get_collect_info("podDetect").load("cgroup_root")

        pod_cgroup = cgroup_root + pod_info.get("CgroupParent", "")
        pod_name = pod_info.get("Name", "")
        if os.path.exists(pod_cgroup):
            pod_mem = self.get_cgroup_mem(context, pod_cgroup)
            collect_info.store(pod_name, pod_mem)

        for container in containers:
            con_name = container.get("ContainerName", "")
            con_cgroup = cgroup_root + container.get("ContainerCgroup", "")
            if os.path.exists(con_cgroup):
                container_mem = self.get_cgroup_mem(context, con_cgroup)
                collect_info.store(con_name, container_mem)

        return collect_info

    def collect_host(self, context):
        """收集主机内存信息

        输出：
        1. MemTotal: 系统总内存
        2. MemFree: 系统空闲内存
        3. MemAvailable: 可用内存
        4. Buffers: 缓存内存
        5. Cached: 缓存内存
        6. SwapCached: 交换缓存
        7. Active(anon): 用户态匿名内存
        8. Inactive(anon): 用户态匿名内存
        9. Active(file): 用户态文件内存
        10. Inactive(file): 用户态文件内存
        11. Mlocked: 锁定内存
        12. SwapTotal: 交换区总内存
        13. SwapFree: 交换区空闲内存
        14. Dirty: 脏内存
        15. Writeback: 写回内存
        16. AnonPages: 匿名页
        17. Mapped: 映射内存
        18. Shmem: 共享内存
        19. Slab: Slab 内存
        20. KernelStack: 内核栈
        21. PageTables: 页表内存
        22. VmallocTotal: Vmalloc 总内存
        23. VmallocUsed: Vmalloc 使用情况
        24. Percpu: Per-CPU 内存（低版本内核可能没有这个信息）
        25. Hugepagesize: HugePages 大小
        ...（省略可以从 /proc/meminfo 获取的其它信息）
        26. 2048: 2M HugePages 使用情况
        27. 1048576: 1G HugePages 使用情况
        28. userUsed: 用户态内存使用情况
        29. kernelUsed: 内核态内存使用情况
        30. res: 预留内存大小
        3.1 allocPage: 分配的页数
        """
        collect_info = PluginCollectInfo()

        # 1. 首先读取 /proc/meminfo 文件，获取内存信息
        with open(mem_utils.get_real_path("/proc/meminfo"), "r") as f:
            lines = f.readlines()
            for line in lines:
                items = line.strip().split()
                if len(items) < 2:
                    continue
                name = items[0].strip()[:-1]
                size = int(items[1].strip())
                collect_info.store(name, size)

        # 2. 读取 HugePages 信息
        if mem_utils.hugepagesz_supported(2):
            huge2M = mem_utils.get_hugepage_used("2048")
            # 兼容旧版sysak
            collect_info.store("2048", huge2M)
            collect_info.store("huge2M", huge2M)
        if mem_utils.hugepagesz_supported(1024):
            huge1G = mem_utils.get_hugepage_used("1048576")
            # 兼容旧版sysak
            collect_info.store("1048576", huge1G)
            collect_info.store("huge1G", huge1G)

        # 3. 读取 VmallocUsed 信息
        # 始终使用 /proc/vmallocinfo 的 pages= 字段计算物理页使用量。
        # /proc/meminfo 的 VmallocUsed 在 kernel 3.10（CentOS 7.6）上表示
        # vmalloc 虚拟地址空间大小而非物理页数，会导致 allocPage 严重低估。
        collect_info.store("VmallocUsed", mem_utils.get_vmalloc_used())

        # 4. 读取预留内存大小
        if collect_info.load("res") is None:
            # 兼容旧版sysak
            collect_info.store("res", mem_utils.get_reserved_mem())
            collect_info.store("ReservedMem", collect_info.load("res"))

        # 5. 计算用户态内存使用情况
        # userUsed = Active(anon) + Inactive(anon) + Cached + Buffer - Shmem + Mlocked + huge2M + huge1G
        # Active(file) + Inactive(file) ≈ Cached + Buffers - Shmem
        # Shmem 会同时记入 Anon 和 Cached，需要减去
        user = collect_info.load("Active(anon)") + collect_info.load("Inactive(anon)")
        user += (
            collect_info.load("Cached")
            + collect_info.load("Buffers")
            - collect_info.load("Shmem", 0)
        )
        user += collect_info.load("Mlocked")
        if "huge2M" in collect_info.data:
            user += collect_info.data["huge2M"]
        if "huge1G" in collect_info.data:
            user += collect_info.data["huge1G"]
        collect_info.store("userUsed", user)

        # 6. 计算内核态内存使用情况
        kernelOther = collect_info.load("Slab", 0) + collect_info.load("KernelStack", 0)
        kernelOther += collect_info.load("PageTables") + collect_info.load(
            "VmallocUsed", 0
        )
        kernelOther += collect_info.load("Percpu", 0)

        pageUsed = (
            collect_info.load("MemTotal")
            - collect_info.load("MemFree")
            - user
            - kernelOther
        )
        if pageUsed < 1:
            pageUsed = 1024
        collect_info.store("allocPage", pageUsed)
        collect_info.store(
            "kernelUsed", pageUsed + kernelOther + collect_info.load("res")
        )
        return collect_info

    def collect(self, context):
        enable_pod = self.params.get("enable_pod", False)
        if enable_pod:
            return self.collect_pod(context)
        return self.collect_host(context)

    def analysis(self, context):
        """meminfo 插件只提供了收集数据的功能，不提供分析功能"""
        return None
