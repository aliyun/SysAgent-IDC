#!/usr/bin/env python
# -*- coding: utf-8 -*-
from plugin_system import *
import mem_utils


@plugin(name="memfrag")
@plugin_requires("meminfo")
class MemfragDetectPlugin(PluginBase):
    """内存碎片检测插件，用于检测系统内存碎片情况"""

    def collect(self, context):
        collect_info = PluginCollectInfo()
        meminfo = context.get_collect_info("meminfo")
        mem_total = meminfo.load("MemTotal")
        key = "Normal"
        if mem_total < 1024 * 1024 * 4:
            key = "DMA32"
        filename = mem_utils.get_real_path("/proc/buddyinfo")
        with open(filename, "r") as f:
            lines = f.readlines()
            for line in lines:
                if line.find(key) >= 0:
                    frags = line.strip().split()[-8:]
                    if sum([int(count) for count in frags]) < 100:
                        collect_info.store("memfrag", True)
                    else:
                        collect_info.store("memfrag", False)
        if collect_info.load("memfrag") is None:
            collect_info.store("memfrag", False)
        return collect_info

    def analysis(self, context):
        memfrag = context.get_collect_info("memfrag").load("memfrag")
        if not memfrag:
            return None
        analysis_info = PluginAnalysisInfo()
        analysis_info.title = "内存碎片检测"
        analysis_info.summary = "当前系统内存碎片化严重"
        analysis_info.reason = "当前系统内存存在过多内存碎片，导致内存利用率降低。"
        analysis_info.suggestion = "建议通过 drop_caches 清理页面缓存，释放内存碎片。"
        analysis_info.result["memfrag"] = memfrag
        return analysis_info
