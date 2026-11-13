#!/usr/bin/env python
# -*- coding: utf-8 -*-
from plugin_system import *
import mem_utils
import os


@plugin(name="memcgLeak")
class MemcgLeakPlugin(PluginBase):
    """memcg 泄露检测插件，用于检测内存控制组是否存在泄露"""

    def read_memory_cgroup_num(self):
        """读取 /proc/cgroups 中的 memory cgroup 总数（活跃 + 僵尸）"""
        filename = mem_utils.get_real_path("/proc/cgroups")
        with open(filename, "r") as f:
            lines = f.readlines()
            for line in lines:
                if line.find("memory") >= 0:
                    return int(line.split()[2])
        return 0

    def count_active_memory_cgroups(self):
        """统计活跃的 memory cgroup 数量（用户态可见的）"""
        try:
            memcg_root = mem_utils.get_real_path("/sys/fs/cgroup/memory")
            if not os.path.isdir(memcg_root):
                return None
            
            count = 0
            for root, dirs, files in os.walk(memcg_root):
                # 每个包含 memory.stat 的目录都是一个 memory cgroup
                stat_file = os.path.join(root, "memory.stat")
                if os.path.isfile(stat_file):
                    count += 1
            
            return count
        except Exception:
            # 如果扫描失败（权限、文件系统问题等），返回 None
            return None

    def collect(self, context):
        collect_info = PluginCollectInfo()
        
        # 总数（来自 /proc/cgroups）
        total_cgroups = self.read_memory_cgroup_num()
        collect_info.store("memcg_num", total_cgroups)
        
        # 活跃数（来自文件系统扫描）
        active_cgroups = self.count_active_memory_cgroups()
        if active_cgroups is not None:
            collect_info.store("active_cgroups", active_cgroups)
            collect_info.store("zombie_cgroups", total_cgroups - active_cgroups)
        
        return collect_info

    def analysis(self, context):
        collect_data = context.get_collect_info("memcgLeak")
        
        # 优先使用僵尸数判断，如果没有则用总数（兼容旧版）
        zombie_cgroups = collect_data.load("zombie_cgroups")
        total_cgroups = collect_data.load("memcg_num")
        active_cgroups = collect_data.load("active_cgroups")
        
        # 判断是否泄漏
        if zombie_cgroups is not None:
            # 新版：精确统计僵尸数
            if zombie_cgroups < 1000:
                return None
            leak_num = zombie_cgroups
            leak_desc = "系统存在 %d 个僵尸 memory cgroup（活跃 %d + 僵尸 %d = 总数 %d）" % (
                zombie_cgroups, active_cgroups, zombie_cgroups, total_cgroups
            )
        else:
            # 旧版：只有总数，使用旧阈值
            if total_cgroups < 10000:
                return None
            leak_num = total_cgroups
            leak_desc = "系统 memory cgroup 总数为 %d（超出阈值 10000）" % total_cgroups

        analisys_info = PluginAnalysisInfo()
        analisys_info.title = "Memory Cgroup 泄露检测"
        analisys_info.summary = leak_desc
        analisys_info.reason = (
            "僵尸 cgroup 通常是由于 cgroup 在用户态被删除，但内核中由于以下原因未完全释放：\n"
            "1. page cache 未回收（最常见）\n"
            "2. tmpfs/shmem 文件未删除\n"
            "3. 存在僵尸子 cgroup\n"
            "4. 内核引用计数 bug"
        )
        analisys_info.suggestion = (
            "建议使用 memcgoffline 工具精确诊断每个僵尸 cgroup 的成因和关联文件。"
        )
        
        # 存储结果（兼容新旧格式）
        analisys_info.result["memcg_num"] = total_cgroups
        if zombie_cgroups is not None:
            analisys_info.result["active_cgroups"] = active_cgroups
            analisys_info.result["zombie_cgroups"] = zombie_cgroups
        
        return analisys_info
