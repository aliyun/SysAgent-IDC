#!/usr/bin/env python
# -*- coding: utf-8 -*-
from plugin_system import *
import mem_utils


@plugin(name="memgraph")
@plugin_requires("meminfo")
@plugin_pod_support()
class MemgraphPlugin(PluginBase):
    """内存大图插件，对全局内存、用户态内存和内核态内存的占用进行拆解和分析"""

    def collect(self, context):
        return None

    def analysis_pod(self, context):
        analysis = PluginAnalysisInfo()
        analysis.title = "Pod及其容器内存占用情况"
        pod_meminfo = context.get_collect_info("meminfo")
        pod_name = context.get_collect_info("podDetect").load("pod_name")

        # 1. 计算 Pod 内存使用情况
        item_map = {
            "usage": "内存使用(usage_in_bytes)",
            "limit": "内存限制(limit_in_bytes)",
            "cache": "缓存内存(cache)",
            "rss": "匿名内存(rss)",
            "rss_huge": "匿名透明大页内存(rss_huge)",
            "shmem": "共享内存(shmem)",
            "inactive_anon": "不活跃匿名内存(inactive_anon)",
            "active_anon": "活跃匿名内存(active_anon)",
            "inactive_file": "不活跃文件内存(inactive_file)",
            "active_file": "活跃文件内存(active_file)",
            "mlocked": "锁定内存(unevictable)",
        }

        for name, value in pod_meminfo.data.items():
            analysis.result[name] = {}
            if name == pod_name:
                title = u"Pod %s 内存使用情况" % pod_name
            else:
                title = u"容器 %s 内存使用情况" % name
            headers = ["内存项", "内存大小"]
            data = []

            if value["limit"] == 9223372036854771712:
                usage_ratio = 0
            else:
                usage_ratio = (float(value["usage"]) / float(value["limit"])) * 100
            data.append(["内存使用率(usage/limit)", "%.2f%%" % usage_ratio])
            analysis.result[name]["usage_ratio"] = usage_ratio
            working_set = value["usage"] - value["inactive_file"]
            data.append(
                [
                    "K8s工作内存(working_set)",
                    mem_utils.format_unit(working_set, is_bytes=True),
                ]
            )
            analysis.result[name]["working_set"] = working_set

            for k, v in value.items():
                data.append([item_map[k], mem_utils.format_unit(v, is_bytes=True)])
                analysis.result[name][k] = v

            res_str = mem_utils.print_table(headers, data, title, show=False)
            analysis.render_text += res_str + "\n"

        return analysis

    def analysis_host(self, context):
        analysis = PluginAnalysisInfo()
        analysis.title = "内存占用情况"
        meminfo = context.get_collect_info("meminfo")

        # 计算总体内存使用情况
        # 总内存 = MemTotal + ReservedMem（预留内存）
        reserved = meminfo.load("ReservedMem", 0)
        total = meminfo.load("MemTotal") + reserved
        free = meminfo.load("MemFree")
        user_used = meminfo.load("userUsed")
        kernel_used = meminfo.load("kernelUsed")
        avaliable = meminfo.load("MemAvailable")
        # @see https://gitlab.com/procps-ng/procps/-/blob/master/src/free.c?ref_type=heads
        # used = total - free - buff/cache
        # buff/cache = Buffers + Cached(包含 Shmem) + SReclaimable - shmem
        shmem = meminfo.load("Shmem", 0)
        used = (
            total
            - free
            - (
                meminfo.load("Buffers")
                + meminfo.load("Cached")
                + meminfo.load("SReclaimable")
                - shmem
            )
        )

        analysis.result["total"] = total
        analysis.result["free"] = free
        analysis.result["used"] = used
        analysis.result["avaliable"] = avaliable
        analysis.result["shmem"] = shmem
        analysis.result["reserved"] = reserved
        analysis.result["userUsed"] = user_used
        analysis.result["kernelUsed"] = kernel_used

        # 拆解用户态内存使用情况
        # userUsed = Active(anon) + Inactive(anon) + Cached + Buffer - Shmem + Mlocked + huge2M + huge1G
        user = {}
        user["anon"] = meminfo.load("Active(anon)") + meminfo.load("Inactive(anon)")
        user["filecache"] = meminfo.load("Cached") - shmem
        user["buffers"] = meminfo.load("Buffers")
        user["mlock"] = meminfo.load("Mlocked")
        if "huge2M" in meminfo.data:
            user["huge2M"] = meminfo.data["huge2M"]
        if "huge1G" in meminfo.data:
            user["huge1G"] = meminfo.data["huge1G"]
        user["shmem"] = shmem
        analysis.result["user"] = user

        # 拆解内核态内存使用情况
        kernel = {}
        kernel["reserved"] = reserved
        kernel["SReclaimable"] = meminfo.load("SReclaimable")
        kernel["SUnreclaim"] = meminfo.load("SUnreclaim")
        kernel["KernelStack"] = meminfo.load("KernelStack")
        kernel["PageTables"] = meminfo.load("PageTables")
        kernel["VmallocUsed"] = meminfo.load("VmallocUsed")
        kernel["allocPage"] = meminfo.load("allocPage")
        kernel["percpu"] = meminfo.load("Percpu", 0)
        analysis.result["kernel"] = kernel

        # 系统内存概览
        title = "系统内存概览"
        headers = ["内存项", "内存大小"]
        data = [
            ["总内存(Total)", mem_utils.format_unit(total)],
            ["空闲内存(Free)", mem_utils.format_unit(free)],
            ["已用内存(Used)", mem_utils.format_unit(used)],
            ["可用内存(Available)", mem_utils.format_unit(avaliable)],
            ["预留内存(Reserved)", mem_utils.format_unit(reserved)],
        ]
        res_str = mem_utils.print_table(headers, data, title, show=False)
        title = "用户态内存使用情况"
        headers = ["内存项", "内存大小"]
        item_map = {
            "anon": "堆栈内存(Anon)",
            "filecache": "文件缓存(Filecache)",
            "buffers": "缓冲区内存(Buffers)",
            "mlock": "锁定内存(Mlock)",
            "huge2M": "2M大页内存(Hugepagesz_2M)",
            "huge1G": "1G大页内存(Hugepagesz_1G)",
            "shmem": "共享内存(Shmem)",
        }

        data = []
        for item in user:
            if user[item] <= 0:
                continue
            data.append([item_map.get(item, item), mem_utils.format_unit(user[item])])
        res_str += "\n"
        res_str += mem_utils.print_table(headers, data, title, show=False)

        title = "内核态内存使用情况"
        headers = ["内存项", "内存大小"]
        data = []
        item_map = {
            "SReclaimable": "Slab可回收内存(SReclaimable)",
            "SUnreclaim": "Slab不可回收内存(SUnreclaim)",
            "KernelStack": "内核栈内存(KernelStack)",
            "PageTables": "页表内存(PageTables)",
            "VmallocUsed": "Vmalloc内存(VmallocUsed)",
            "allocPage": "AllocPage内存",
            "percpu": "Percpu内存",
            "reserved": "预留内存(Reserved)",
        }
        for item in kernel:
            if kernel[item] <= 0:
                continue
            data.append([item_map.get(item, item), mem_utils.format_unit(kernel[item])])
        res_str += "\n"
        res_str += mem_utils.print_table(headers, data, title, show=False)
        analysis.render_text = res_str
        return analysis

    def analysis(self, context):
        enable_pod = self.params.get("enable_pod", False)
        if enable_pod:
            return self.analysis_pod(context)
        return self.analysis_host(context)
