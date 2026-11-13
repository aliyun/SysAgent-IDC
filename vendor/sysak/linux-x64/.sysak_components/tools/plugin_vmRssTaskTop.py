#!/usr/bin/env python
# -*- coding: utf-8 -*-
from plugin_system import *
import mem_utils


@plugin(name="vmRssTaskTop")
@plugin_requires("taskProc")
@plugin_pod_support()
class VmRssTaskTopPlugin(PluginBase):
    """VmRssTaskTop 插件，用于输出根据任务实际占用物理内存排序的 Top N 的任务信息"""

    def collect(self, context):
        return None

    def one_task_table(self, taskInfo, taskSortedByVmRss, topN, con_name=None):
        if con_name:
            title = u"容器 %s 内存占用物理内存 Top %s" % (
                con_name,
                topN,
            )
        else:
            title = None

        headers = [
            "进程名",
            "进程ID",
            "VmRSS",
            "RssAnon",
            "RssFile",
            "Shmem",
            "Pod名称/容器名称/Cgroup路径"
        ]
        data = []
        num = 0
        render_text = ""

        tmp_mem = []
        for key, value in taskSortedByVmRss:
            task = taskInfo[key]
            # analysis_info.result.append(task)
            tmp_task = task.copy()
            tmp_task["pid"] = key
            tmp_task["total_mem"] = value
            tmp_task["comm"] = taskInfo[key]["Name"]
            tmp_mem.append(tmp_task)
            num += 1
            if num > topN:
                break
            container_description = "ContainerCgroup: %s" % task.get("memcg", "")
            if "ContainerInfo" in tmp_task:
                container_info = tmp_task["ContainerInfo"]
                container_description = "PodName: %s | ContainerName: %s" % (
                    container_info.get("PodName", ""),
                    container_info.get("ContainerName", ""),
                )
            data.append(
                [
                    task["Name"],
                    key,
                    mem_utils.format_unit(task["VmRSS"], simple=True),
                    mem_utils.format_unit(task["RssAnon"], simple=True),
                    mem_utils.format_unit(task["RssFile"], simple=True),
                    mem_utils.format_unit(task["RssShmem"], simple=True),
                    container_description
                ]
            )
        render_text += mem_utils.print_table(headers, data, title, show=False)

        return render_text, tmp_mem

    def analysis_host(self, topN, context):
        # 从 taskProc 插件读取任务信息和内存排序信息
        task_proc_collect_info = context.get_collect_info("taskProc")
        taskInfo = task_proc_collect_info.load("taskInfo")
        taskSortedByVmRss = task_proc_collect_info.load("taskSortedByVmRss")
        analysis_info = PluginAnalysisInfo()

        title = u"进程占用物理内存 Top %s" % topN
        analysis_info.title = title
        render_text, tmp_mem = self.one_task_table(taskInfo, taskSortedByVmRss, topN)
        analysis_info.render_text += render_text
        analysis_info.result = tmp_mem

        return analysis_info

    def analysis_pod(self, topN, context):
        # 从 taskProc 插件读取容器任务信息和内存排序信息
        task_proc_collect_info = context.get_collect_info("taskProc")
        pod_name = context.get_collect_info("podDetect").load("pod_name")
        analysis_info = PluginAnalysisInfo()

        title = u"进程占用物理内存 Top %s" % topN
        analysis_info.title = title

        for con_name, con_info in task_proc_collect_info.data.items():
            # skip pod itself, only show containers
            # because pod cgroup itself has no process
            if con_name == pod_name:
                continue
            
            render_text, tmp_mem = self.one_task_table(
                con_info["taskInfo"], con_info["taskSortedByVmRss"], topN, con_name
            )
            analysis_info.render_text += render_text

            if con_name not in analysis_info.result:
                analysis_info.result[con_name] = []
            analysis_info.result[con_name] = tmp_mem

        return analysis_info

    def analysis(self, context):
        # 从参数中读取需要展示的 Top N 数量
        topN = self.params.get("topN", 30)
        enable_pod = self.params.get("enable_pod", False)

        if enable_pod:
            return self.analysis_pod(topN, context)
        return self.analysis_host(topN, context)
