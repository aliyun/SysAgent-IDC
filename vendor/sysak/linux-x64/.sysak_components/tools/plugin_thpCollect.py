#!/usr/bin/env python
# -*- coding: utf-8 -*-
from plugin_system import *
import mem_utils


@plugin(name="thpCollect")
@plugin_requires("meminfo")
class ThpCollectPlugin(PluginBase):
    """透明大页（THP）数据采集插件"""

    def collect(self, context):
        collect_info = PluginCollectInfo()
        meminfo = context.get_collect_info("meminfo")

        # 1. THP 全局状态
        collect_info.store("thp_status", mem_utils.get_thp_status())

        # 2. THP 相关 meminfo（复用 meminfo 已采集数据）
        thp_meminfo = {
            "anon_huge_pages_kb": meminfo.load("AnonHugePages", 0),
            "shmem_huge_pages_kb": meminfo.load("ShmemHugePages", 0),
            "huge_pages_total": meminfo.load("HugePages_Total", 0),
            "huge_pages_free": meminfo.load("HugePages_Free", 0),
            "huge_pages_rsvd": meminfo.load("HugePages_Rsvd", 0),
            "huge_pages_surp": meminfo.load("HugePages_Surp", 0),
            "hugepagesize_kb": meminfo.load("Hugepagesize", 0),
        }
        collect_info.store("thp_meminfo", thp_meminfo)

        # 3. Top 30 进程 THP 用量（优化：若无 THP 使用则跳过）
        if thp_meminfo["anon_huge_pages_kb"] > 0:
            collect_info.store("thp_top_processes",
                              mem_utils.get_thp_top_processes(topN=30))
        else:
            collect_info.store("thp_top_processes", [])

        # 4. cgroup 级 THP 统计
        collect_info.store("thp_cgroup", mem_utils.get_cgroup_thp())

        # 5. THP reclaim（Alibaba Cloud Linux 特有，不存在则返回 supported=false）
        collect_info.store("thp_reclaim", mem_utils.get_thp_reclaim_status())

        return collect_info

    def analysis(self, context):
        """端侧不做分析，仅输出采集结果到 JSON"""
        collect_data = context.get_collect_info("thpCollect")
        if collect_data is None:
            return None

        analysis_info = PluginAnalysisInfo()
        analysis_info.result = {
            "thp_status": collect_data.load("thp_status"),
            "thp_meminfo": collect_data.load("thp_meminfo"),
            "thp_top_processes": collect_data.load("thp_top_processes"),
            "thp_cgroup": collect_data.load("thp_cgroup"),
            "thp_reclaim": collect_data.load("thp_reclaim"),
        }
        return analysis_info
