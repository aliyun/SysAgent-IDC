#!/usr/bin/env python
# -*- coding: utf-8 -*-
from plugin_system import *
import mem_utils


@plugin(name="podDetect")
@plugin_pod_support()
class PodDetectPlugin(PluginBase):
    """PodDetect 插件，用于检测指定 Pod 的相关信息"""

    def collect(self, context):
        pod_name = self.params.get("pod_name", "")
        enable_pod = self.params.get("enable_pod", False)
        # skip pod detection if not enabled
        if not enable_pod:
            return None

        pod_info = mem_utils.get_pod_info(pod_name)
        containers = mem_utils.get_containers_of_pod(pod_name)
        cgroup_version = "v1" if mem_utils.is_cgroup_v1() else "v2"
        cgroup_root = mem_utils.memory_cgroup_root()

        collect_info = PluginCollectInfo()
        collect_info.store("pod_name", pod_name)
        collect_info.store("namespace", pod_info.get("Namespace", ""))
        collect_info.store("pod_info", pod_info)
        collect_info.store("containers", containers)
        collect_info.store("cgroup_version", cgroup_version)
        collect_info.store("cgroup_root", cgroup_root)
        return collect_info

    def analysis(self, context):
        """
        输出pod信息到json中，供中心端分析使用，不输出到终端
        """
        analysis = PluginAnalysisInfo()
        analysis.title = "Pod 信息"
        analysis.result["pod_name"] = context.get_collect_info("podDetect").load(
            "pod_name"
        )
        analysis.result["namespace"] = context.get_collect_info("podDetect").load(
            "namespace"
        )
        containers_full = context.get_collect_info("podDetect").load("containers")
        containers = []
        for container in containers_full:
            containers.append(container.get("ContainerName", ""))

        data = []
        data.append(["Pod名称", analysis.result["pod_name"]])
        data.append(["命名空间", analysis.result["namespace"]])
        data.append(["容器列表", containers])
        res_str = mem_utils.print_table(["", ""], data, "Pod 信息", show=False)
        analysis.render_text = res_str + "\n"

        analysis.result["containers"] = containers

        return analysis
