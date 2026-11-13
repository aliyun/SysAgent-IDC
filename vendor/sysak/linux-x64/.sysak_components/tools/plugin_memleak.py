#!/usr/bin/env python
# -*- coding: utf-8 -*-
import os
from plugin_system import *
import mem_utils


@plugin(name="memleak")
@plugin_requires("meminfo")
class MemleakPlugin(PluginBase):
    def collect(self, context):
        def should_trigger_memleak(total, usage):
            """分级内存泄露触发阈值判定（total/usage 单位均为 KB）。

            设计依据：
            原始阈值为固定绝对值（使用量 > 10GB，或 > 总内存 10% 且 > 1.5GB），
            在小规格机器上永远无法触发。例如 2GB VM 即便泄露 300-400MB
            （占比 17-22%），因绝对值达不到 1.5GB 而被漏判，导致 memgraph
            诊断链路在小内存测试环境下无法完成端到端验证。

            因此按机器总内存分三档设置阈值，兼顾灵敏度与抗噪声：
            - 小规格（≤ 4GB，测试环境）：占比 > 15% 且绝对值 > 150MB 即触发，
              覆盖 2-4GB VM 上 15-20% 的注入泄露。
            - 中等规格（≤ 16GB）：占比 > 10% 且绝对值 > 512MB 触发。
            - 大规格（> 16GB，生产环境）：保持原逻辑（> 10GB 或
              占比 > 10% 且 > 1.5GB），避免在大内存机器上产生噪声告警，
              保证向后兼容。
            """
            if total <= 0:
                return False
            if total <= 4 * 1024 * 1024:  # ≤ 4GB 小规格测试环境
                return usage > total * 0.15 and usage > 150 * 1024
            elif total <= 16 * 1024 * 1024:  # ≤ 16GB 中等规格
                return usage > total * 0.10 and usage > 512 * 1024
            else:  # > 16GB 大规格生产环境，保持原逻辑
                return (usage > 10 * 1024 * 1024) or (
                    (usage > total * 0.10) and (usage > 1024 * 1024 * 1.5)
                )

        def is_slab_memleak(meminfo):
            """判断是否存在 slab 内存泄露（分级阈值，见 should_trigger_memleak）"""
            total = meminfo.load("MemTotal", 0)
            uslab_usage = meminfo.load("SUnreclaim", 0)
            return should_trigger_memleak(total, uslab_usage)

        def is_alloc_page_memelak(meminfo):
            """判断是否存在 page 内存泄露（分级阈值，见 should_trigger_memleak）"""
            total = meminfo.load("MemTotal", 0)
            page_usage = meminfo.load("allocPage", 0)
            return should_trigger_memleak(total, page_usage)

        def is_vmalmalloc_memleak(meminfo):
            """判断是否存在 vmalloc 内存泄露（分级阈值，见 should_trigger_memleak）"""
            total = meminfo.load("MemTotal", 0)
            vmalloc_usage = meminfo.load("VmallocUsed", 0)
            return should_trigger_memleak(total, vmalloc_usage)

        def check_top_uslab(res):
            cmd = "slabtop -o -s c"
            code, stdout, error = mem_utils.run_cmd(cmd)
            touchslab = False
            for line in stdout.split("\n"):
                if line.find("CACHE SIZE") >= 0:
                    touchslab = True
                    continue
                if not touchslab:
                    continue
                slabname = line.split()[-1]
                cache_size = line.split()[-2]
                if os.path.exists("/sys/kernel/slab/%s/reclaim_account" % slabname):
                    with open("/sys/kernel/slab/%s/reclaim_account" % slabname) as fin:
                        reclaim_account = fin.read().strip()
                    if reclaim_account == "0":
                        break
            return slabname, cache_size

        def detect_memleak(mleak_type, memleak_detect_duration):
            """调用 sysak memleak 进行内核内存泄露检测"""
            script_dir = os.path.dirname(os.path.abspath(__file__))
            memleak_bin_path = os.path.join(script_dir, "memleak")
            if not os.path.exists(memleak_bin_path):
                return ""
            try:
                code, result, error = mem_utils.run_cmd(
                    [
                        memleak_bin_path,
                        "-t",
                        mleak_type,
                        "-i",
                        "{}".format(memleak_detect_duration),
                    ]
                )
                if code != 0:
                    if code < 0 and result:
                        return result
                    print("Failed to run memleak")
                    return ""
                return result
            except Exception as e:
                print("Failed to run memleak: %s" % e)
            return ""

        memleak_detect_duration = self.params.get("memleak_detect_duration", 60)

        meminfo = context.get_collect_info("meminfo")
        leak = False
        leak_type = None
        usage = 0
        mleak_result = ""

        if is_slab_memleak(meminfo):
            leak = True
            leak_type = "SUnreclaim"
            usage = meminfo.load("SUnreclaim", 0)
            mleak_result = detect_memleak("slab", memleak_detect_duration)
        elif is_alloc_page_memelak(meminfo):
            leak = True
            leak_type = "AllocPage"
            usage = meminfo.load("allocPage", 0)
            mleak_result = detect_memleak("page", memleak_detect_duration)
        elif is_vmalmalloc_memleak(meminfo):
            leak = True
            leak_type = "Vmalloc"
            usage = meminfo.load("VmallocUsed", 0)
            mleak_result = detect_memleak("vmalloc", memleak_detect_duration)
        else:
            return None

        collect_info = PluginCollectInfo()
        collect_info.store("leak", leak)
        collect_info.store("type", leak_type)
        collect_info.store("usage", usage)
        collect_info.store("mleak", mleak_result)
        return collect_info

    def analysis(self, context):
        collect_info = context.get_collect_info("memleak")
        if collect_info is None:
            return None
        leak = collect_info.load("leak", False)
        leak_type = collect_info.load("type")
        usage = collect_info.load("usage", 0)
        if not leak or not leak_type or not usage:
            return None
        mleak = collect_info.load("mleak", "")

        analisys_info = PluginAnalysisInfo()
        analisys_info.title = "内存泄露检测"
        analisys_info.summary = (
            "系统上存在 %s 类型的内存泄露, 该类型的内存占用为 %s"
            % (leak_type, mem_utils.format_unit(usage))
        )
        analisys_info.suggestion = "建议使用memleak工具进行进一步排查"
        analisys_info.result = {
            "leak": leak,
            "type": leak_type,
            "usage": usage,
            "mleak": mleak,
        }
        analisys_info.render_text = (
            mem_utils.to_unicode(analisys_info.summary)
            + mem_utils.to_unicode("\n")
            + mem_utils.to_unicode(mleak)
        )
        return analisys_info
