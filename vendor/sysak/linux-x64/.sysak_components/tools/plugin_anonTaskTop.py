#!/usr/bin/env python
# -*- coding: utf-8 -*-
from plugin_system import *
import mem_utils


@plugin(name="anonTaskTop")
@plugin_requires("taskProc")
class AnonTaskTopPlugin(PluginBase):
    """AnonTaskTop 插件，用于输出根据匿名内存排序的 Top N 的任务信息"""

    def collect(self, context):
        return None

    def one_task_table(self, taskInfo, taskSortedByAnon, topN, con_name=None):
        if con_name:
            title = u"容器 %s 内存占用匿名内存 Top %s" % (
                con_name,
                topN,
            )
        else:
            title = None

        headers = [
            "进程名",
            "进程ID",
            "RssAnon",
            "VmRSS",
            "RssFile",
            "Shmem",
        ]
        render_text = ""
        data = []
        num = 0
        for key, _ in taskSortedByAnon:
            task = taskInfo[key]
            num += 1
            if num > topN:
                break
            data.append(
                [
                    task["Name"],
                    key,
                    mem_utils.format_unit(task["RssAnon"], simple=True),
                    mem_utils.format_unit(task["VmRSS"], simple=True),
                    mem_utils.format_unit(task["RssFile"], simple=True),
                    mem_utils.format_unit(task["RssShmem"], simple=True),
                ]
            )
        render_text += mem_utils.print_table(headers, data, title, show=False)

        return render_text

    def analysis_host(self, topN, context):
        # 从 taskProc 插件读取任务信息和内存排序信息
        task_proc_collect_info = context.get_collect_info("taskProc")
        taskInfo = task_proc_collect_info.load("taskInfo")
        taskSortedByAnon = task_proc_collect_info.load("taskSortedByAnon")
        analysis_info = PluginAnalysisInfo()

        title = "进程占用匿名内存 Top %s" % topN
        analysis_info.title = title
        render_text = self.one_task_table(taskInfo, taskSortedByAnon, topN)
        analysis_info.render_text += render_text

        return analysis_info

    def analysis_pod(self, topN, context):
        # 从 taskProc 插件读取任务信息和内存排序信息
        task_proc_collect_info = context.get_collect_info("taskProc")
        pod_name = context.get_collect_info("podDetect").load("pod_name")
        analysis_info = PluginAnalysisInfo()

        title = "进程占用匿名内存 Top %s" % topN
        analysis_info.title = title

        for con_name, con_info in task_proc_collect_info.data.items():
            # skip pod itself, only show containers
            # because pod cgroup itself has no process
            if con_name == pod_name:
                continue

            render_text = self.one_task_table(
                con_info["taskInfo"], con_info["taskSortedByAnon"], topN, con_name
            )
            analysis_info.render_text += render_text

        return analysis_info

    def analysis(self, context):
        # 从参数中读取需要展示的 Top N 数量
        topN = self.params.get("topN", 30)
        enable_pod = self.params.get("enable_pod", False)

        if enable_pod:
            return self.analysis_pod(topN, context)
        return self.analysis_host(topN, context)
