#!/usr/bin/env python
# -*- coding: utf-8 -*-
import os
import json
import tempfile
from plugin_system import *
import mem_utils


@plugin(name="cache")
@plugin_requires("taskProc", "meminfo")
@plugin_pod_support()
class CachePlugin(PluginBase):
    """Cache 插件，用于扫描系统 Cache 的使用情况

    启用条件：
        - 参数带 -f

    输出：
    1. filecache: 文件 Cache 使用情况
        节点：
            [
                ["/tmp/test", {"cached": 1024, "size": 1024, "task": ["systemd(1)"]}],
                ...
            ]
        pod：
            {
                "container1": [
                    ["/tmp/test", {"cached": 1024, "size": 1024, "task": ["systemd(1)"]}],
                    ...
                ],
                "container2": [
                    ["/tmp/test", {"cached": 1024, "size": 1024, "task": ["systemd(1)"]}],
                    ...
                ]]
            }
    2. filecache_shm: 共享内存文件 Cache 使用情况
        节点：
            [
                ["/dev/shm/test", {"cached": 1024, "size": 1024, "task": ["systemd(1)"], "shmem_kind": "Shmem"}],
                ...
            ]
        Pod:
            {
                "container1": [
                    ["/dev/shm/test", {"cached": 1024, "size": 1024, "task": ["systemd(1)"], "shmem_kind": "Shmem"}],
                    ...
                ],
                "container2": [
                    ["/dev/shm/test", {"cached": 1024, "size": 1024, "task": ["systemd(1)"], "shmem_kind": "Shmem"}],
            }
    """

    def get_cache_file_pid(self, filePidMap, taskInfo, filename):
        res = []
        if filename not in filePidMap:
            return res
        for pid in filePidMap[filename]:
            if pid not in taskInfo:
                continue
            name = taskInfo[pid]["Name"]
            res.append("{}({})".format(name, pid))
        return res

    def get_file_cache_by_mincore(self, filePidMap, taskInfo):
        """通过 mincore 系统调用来计算文件的缓存大小。"""
        collect_info = PluginCollectInfo()
        topN = self.params.get("topN", 30)
        filecache_map, total_cache = {}, 0
        for file in filePidMap.keys():
            cache = mem_utils.cal_cache_size(file)
            total_cache += cache
            if cache > 0:
                filecache_map[file] = cache
        sorted_filecache = sorted(
            filecache_map.items(), key=lambda kv: (kv[1], kv[0]), reverse=True
        )
        filecache = []
        count = 0
        for k, v in sorted_filecache:
            filecache.append(
                {
                    "file": k,
                    "cached": int(v) * 4,
                    "size": int(v) * 4,
                    "task": self.get_cache_file_pid(filePidMap, taskInfo, k),
                },
            )
            count += 1
            if count >= topN:
                break
        filecache = {
            "filecache": filecache,
        }
        collect_info.store("host", filecache)
        return collect_info

    def get_file_cache_by_podmem(self, context, enable_pod=False):
        """通过 podmem 工具扫描系统的文件 Cache 使用情况"""

        def extract_real_file_path(file):
            """
            Pod 模式下，尝试还原容器的真实路径
            /ostree/deploy/LifseaOS/deploy/9401830260e19a6e0c84aad1f3ee493dc634ca208b669dff63159b41e366ce28.0/var/ostree/deploy/LifseaOS/var/lib/containerd/io.containerd.snapshotter.v1.overlayfs/snapshots/29/fs/var/log/ntgh_data.log
                ↓
            /var/log/ntgh_data.log

            支持多种路径格式:
            - /var/lib/containerd/io.containerd.snapshotter.v1.overlayfs/snapshots/.../fs/...
            - /var/lib/container/containerd/io.containerd.snapshotter.v1.overlayfs/snapshots/.../fs/...

            Args:
                file (str): 容器内的文件路径
            """
            # 搜索关键特征路径，而不是完整前缀
            overly_index = file.find(
                "io.containerd.snapshotter.v1.overlayfs/snapshots/"
            )
            if overly_index != -1:
                fs_index = file.find("/fs/", overly_index)
                if fs_index != -1:
                    return file[fs_index + 3 :]
            return file

        def convert_podmem_file_cache_item(item, filePidMap, taskInfo):
            file = item.get("file", "")
            if enable_pod:
                file = extract_real_file_path(file)
            shmem = int(item.get("shmem", -1))
            shmem_kind = item.get("shmem_kind", "").strip()
            if shmem > 0:
                return {
                    "file": file,
                    "cached": item.get("cached", 0),
                    "size": item.get("size", 0),
                    "task": self.get_cache_file_pid(filePidMap, taskInfo, file),
                    "shmem_kind": shmem_kind,
                }
            else:
                return {
                    "file": file,
                    "cached": item.get("cached", 0),
                    "size": item.get("size", 0),
                    "task": self.get_cache_file_pid(filePidMap, taskInfo, file),
                }

        def get_one_file_cache(filecache_ins, filePidMap, taskInfo):
            filecache = []
            filecache_shm = []

            if "filecache_file" in filecache_ins and "shmem_file" in filecache_ins:
                # V2 版本，支持 cache 和 shmem 单独统计排序
                cache = filecache_ins["filecache_file"]
                for item in cache:
                    filecache.append(
                        convert_podmem_file_cache_item(item, filePidMap, taskInfo)
                    )
                shmem = filecache_ins["shmem_file"]
                for item in shmem:
                    filecache_shm.append(
                        convert_podmem_file_cache_item(item, filePidMap, taskInfo)
                    )
            elif "sort_file" in filecache_ins:
                # V1 版本，只支持 cache 和 shmem 放在一起排序
                system_file_cache_top = filecache_ins["sort_file"]
                for idx, item in enumerate(system_file_cache_top):
                    shmem = int(item.get("shmem", -1))
                    if idx < topN:
                        filecache.append(
                            convert_podmem_file_cache_item(item, filePidMap, taskInfo)
                        )
                    if shmem > 0:
                        filecache_shm.append(
                            convert_podmem_file_cache_item(item, filePidMap, taskInfo)
                        )

            return filecache, filecache_shm

        collect_info = PluginCollectInfo()
        podmem_path = os.getenv("PODMEM_PATH", None)
        if not podmem_path:
            script_dir = os.path.dirname(os.path.abspath(__file__))
            podmem_path = os.path.join(script_dir, "podmem")

        # 从 params 读取参数（向后兼容）
        topN = self.params.get("topN", 30)
        sample_rate = self.params.get("sample_rate", 0)

        mem_total = 0
        with open(mem_utils.get_real_path("/proc/meminfo"), "r") as f:
            lines = f.readlines()
            for line in lines:
                items = line.strip().split()
                if len(items) < 3:
                    continue
                name = items[0].strip()[:-1]
                size = int(items[1].strip())
                if name == "MemTotal":
                    mem_total = size
                    break

        with tempfile.NamedTemporaryFile() as tmpfile:
            pod_name = ""
            # 自动计算采样率（如果用户未指定，即 sample_rate == 0）
            if sample_rate == 0:
                scan_rate = "100"
                if mem_total > 32 * 1024 * 1024:  # > 32GB
                    scan_rate = "500"
                if mem_total > 64 * 1024 * 1024:  # > 64GB
                    scan_rate = "1000"
            else:
                scan_rate = str(sample_rate)

            # 使用 podmem 工具扫描 filecache 和 shmem
            if enable_pod:
                pod_name = context.get_collect_info("podDetect").load("pod_name")
                cmd = [
                    podmem_path,
                    "-r",
                    scan_rate,
                    "-t",
                    str(topN),  # 使用自定义 topN
                    "-j",
                    tmpfile.name,
                    "-p",
                    pod_name,
                ]
            else:
                cmd = [
                    podmem_path,
                    "-r",
                    scan_rate,
                    "-t",
                    str(topN),  # 使用自定义 topN
                    "-j",
                    tmpfile.name,
                    "-s",
                ]

            # run podmem, set timeout to 180s
            code, result, error = mem_utils.run_cmd(cmd, timeout=180)
            if code != 0:
                raise Exception("Failed to run podmem %s" % error)
            with open(tmpfile.name, "r") as f:
                data = json.loads(f.read())
                if not enable_pod:
                    # host mode
                    task_proc_collect_info = context.get_collect_info("taskProc")
                    taskInfo = task_proc_collect_info.load("taskInfo")
                    filePidMap = task_proc_collect_info.load("filePidMap")
                    system_filecache = data.get("data", {}).get("system", {})[0]
                    filecache_res, filecache_shm_res = get_one_file_cache(
                        system_filecache, filePidMap, taskInfo
                    )
                    collect_info.store(
                        "host",
                        {
                            "filecache": filecache_res,
                            "filecache_shm": filecache_shm_res,
                        },
                    )
                    return collect_info

                # pod mode
                pod_filecache = data.get("data", {}).get(pod_name, {})
                for cons_filecache in pod_filecache:
                    taskInfo = {}
                    filePidMap = {}
                    cname = cons_filecache.get("cname", "")
                    task_proc_collect_info = context.get_collect_info("taskProc")
                    if task_proc_collect_info.exists(cname):
                        taskInfo = task_proc_collect_info.load(cname).get(
                            "taskInfo", {}
                        )
                        filePidMap = task_proc_collect_info.load(cname).get(
                            "filePidMap", {}
                        )
                    con_filecache, cons_filecache_shm = get_one_file_cache(
                        cons_filecache, filePidMap, taskInfo
                    )

                    collect_info.store(
                        cname,
                        {
                            "filecache": con_filecache,
                            "filecache_shm": cons_filecache_shm,
                        },
                    )

            return collect_info

    def should_scan_cache(self, context, enable_pod):
        """判断是否需要扫描缓存，只有当 filecache + shmem 占用总使用内存的 30% 以上才扫描
        
        特殊情况：如果设置了 force_scan 参数（CLI 明确调用），则始终扫描
        
        Args:
            context: 插件上下文
            enable_pod: 是否为 pod 模式
            
        Returns:
            bool: True 表示需要扫描，False 表示不需要扫描
        """
        # 检查是否强制扫描（CLI 明确调用）
        force_scan = self.params.get("force_scan", False)
        if force_scan:
            if mem_utils.is_debug:
                print("[Cache] force_scan=True, skipping threshold check")
            return True
        
        CACHE_THRESHOLD = 0.30  # 30% 阈值
        
        try:
            meminfo_collect = context.get_collect_info("meminfo")
            if meminfo_collect is None:
                # 如果 meminfo 插件未运行，默认执行扫描
                return True
            
            if enable_pod:
                # Pod 模式：检查 pod 的内存信息
                pod_name = context.get_collect_info("podDetect").load("pod_name")
                if not meminfo_collect.exists(pod_name):
                    # 如果没有 pod 内存信息，默认执行扫描
                    if mem_utils.is_debug:
                        print("[Cache] Pod %s: no meminfo found, will scan cache" % pod_name)
                    return True
                    
                pod_meminfo = meminfo_collect.load(pod_name)
                cache = pod_meminfo.get("cache", 0)  # filecache
                shmem = pod_meminfo.get("shmem", 0)  # shmem
                usage = pod_meminfo.get("usage", 0)  # 总使用内存
                
                if usage <= 0:
                    # 使用内存为 0，不需要扫描
                    if mem_utils.is_debug:
                        print("[Cache] Pod %s: usage=0, skip cache scan" % pod_name)
                    return False
                    
                cache_ratio = float(cache + shmem) / usage
                if mem_utils.is_debug:
                    print(
                        "[Cache] Pod %s: cache=%s, shmem=%s, usage=%s, "
                        "ratio=%.2f%%, threshold=%.2f%%" % (
                            pod_name, cache, shmem, usage,
                            cache_ratio * 100, CACHE_THRESHOLD * 100
                        )
                    )
                
                return cache_ratio >= CACHE_THRESHOLD
            else:
                # Host 模式：检查主机内存信息
                cached = meminfo_collect.load("Cached")  # KB
                buffers = meminfo_collect.load("Buffers")  # KB
                shmem = meminfo_collect.load("Shmem")  # KB
                mem_total = meminfo_collect.load("MemTotal")  # KB
                mem_free = meminfo_collect.load("MemFree")  # KB
                
                # 计算总使用内存
                mem_used = mem_total - mem_free
                if mem_used <= 0:
                    # 使用内存为 0，不需要扫描
                    if mem_utils.is_debug:
                        print("[Cache] Host: mem_used=0, skip cache scan")
                    return False
                
                # filecache = Cached + Buffers, shmem = Shmem
                filecache = cached + buffers
                cache_ratio = float(filecache + shmem) / mem_used
                
                if mem_utils.is_debug:
                    print(
                        "[Cache] Host: filecache=%sKB, shmem=%sKB, mem_used=%sKB, "
                        "ratio=%.2f%%, threshold=%.2f%%" % (
                            filecache, shmem, mem_used,
                            cache_ratio * 100, CACHE_THRESHOLD * 100
                        )
                    )
                
                return cache_ratio >= CACHE_THRESHOLD
                
        except Exception as e:
            mem_utils.log_exception_in_debug_mode(e)
            # 如果判断失败，默认执行扫描
            if mem_utils.is_debug:
                print("[Cache] Error checking cache ratio, will scan cache by default")
            return True

    def collect(self, context):
        enable_pod = self.params.get("enable_pod", False)
        res = PluginCollectInfo()
        
        # 判断是否需要扫描缓存
        if not self.should_scan_cache(context, enable_pod):
            if mem_utils.is_debug:
                print("[Cache] Cache ratio is below 30% threshold, skipping podmem scan")
            return res
        
        try:
            res = self.get_file_cache_by_podmem(context=context, enable_pod=enable_pod)
        except Exception as e:
            mem_utils.log_exception_in_debug_mode(e)
            # if podmem failed and enable_pod is True, return empty result
            if enable_pod:
                return res
            task_proc_collect_info = context.get_collect_info("taskProc")
            taskInfo = task_proc_collect_info.load("taskInfo")
            filePidMap = task_proc_collect_info.load("filePidMap")
            res = self.get_file_cache_by_mincore(filePidMap, taskInfo)

        return res

    def analysis_one_table(self, filecache, filecache_shm, topN, cname=None):
        # print file cache
        title = u"文件 Cache Top %s" % topN
        if cname:
            title = u"容器 %s " % cname + title
        headers = ["文件名", "缓存大小", "关联任务"]
        data = []
        max_col_lengths = [80, 30, 30]
        res_str = ""
        for value in filecache:
            data.append(
                [
                    value["file"],
                    mem_utils.format_unit(value["cached"]),
                    ",".join(value["task"]),
                ]
            )
        res_str += mem_utils.print_table(
            headers, data, title, max_col_lengths, show=False
        )

        # print file cache shm
        title = u"共享内存文件 Cache Top %s" % topN
        if cname:
            title = u"容器 %s" % cname + title
        headers = ["文件名", "缓存大小", "共享内存类型", "关联任务"]
        max_col_lengths = [80, 30, 30, 30]
        data = []
        for value in filecache_shm:
            data.append(
                [
                    value["file"],
                    mem_utils.format_unit(value["cached"]),
                    value["shmem_kind"],
                    ",".join(value["task"]),
                ]
            )
        res_str += mem_utils.print_table(
            headers, data, title, max_col_lengths, show=False
        )

        return res_str

    def analysis_pod(self, cache_info, topN):
        analysis_info = PluginAnalysisInfo()
        analysis_info.title = "Cache"
        res_str = ""
        for cname, value in cache_info.items():
            filecache = value.get("filecache", [])
            filecache_shm = value.get("filecache_shm", [])
            analysis_info.result[cname] = {
                "filecache": filecache,
                "filecache_shm": filecache_shm,
            }
            res_str += self.analysis_one_table(filecache, filecache_shm, topN, cname)
        analysis_info.render_text = res_str
        return analysis_info

    def analysis_host(self, cache_info, topN):
        analysis_info = PluginAnalysisInfo()
        analysis_info.title = "Cache"
        filecache = cache_info.get("filecache", [])
        filecache_shm = cache_info.get("filecache_shm", [])
        res_str = self.analysis_one_table(filecache, filecache_shm, topN)
        analysis_info.result["filecache"] = filecache
        analysis_info.result["filecache_shm"] = filecache_shm
        analysis_info.render_text = res_str
        return analysis_info

    def analysis(self, context):
        topN = self.params.get("topN", 30)
        enable_pod = self.params.get("enable_pod", False)
        cache_collect_info = context.get_collect_info("cache")
        
        # 如果 collect 阶段跳过了扫描（缓存占比低于阈值），返回空的分析结果
        if enable_pod:
            if not cache_collect_info.data:
                # Pod 模式下没有数据，返回空结果
                analysis_info = PluginAnalysisInfo()
                analysis_info.title = "Cache"
                return analysis_info
            return self.analysis_pod(cache_collect_info.data, topN)
        else:
            host_data = cache_collect_info.load("host")
            if host_data is None:
                # Host 模式下没有数据，返回空结果
                analysis_info = PluginAnalysisInfo()
                analysis_info.title = "Cache"
                return analysis_info
            return self.analysis_host(host_data, topN)
