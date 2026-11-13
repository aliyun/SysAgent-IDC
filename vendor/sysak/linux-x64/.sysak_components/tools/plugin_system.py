#!/usr/bin/env python3
# -*- coding: utf-8 -*-
import abc
import mem_utils

###############################################################################
# 插件系统
###############################################################################

plugins = {}


def plugin(name=None):
    """插件装饰器，用于注册插件"""

    def decorator(cls):
        if name:
            plugins[name] = cls
        else:
            plugins[cls.__name__] = cls
        return cls

    return decorator


def plugin_requires(*dependencies):
    """插件依赖装饰器"""

    def decorator(cls):
        cls.required_plugins = dependencies
        return cls

    return decorator


def plugin_pod_support():
    """插件支持 Pod 模式"""

    def decorator(cls):
        cls.enable_pod = True
        return cls

    return decorator


class PluginContext:
    def __init__(self):
        self.collect_infos = {}
        self.analysis_infos = {}
        self.enable_plugins = []

    def get_collect_info(self, plugin_name):
        return self.collect_infos.get(plugin_name, None)

    def set_collect_info(self, plugin_name, collect_info):
        self.collect_infos[plugin_name] = collect_info

    def get_analysis_info(self, plugin_name):
        return self.analysis_infos.get(plugin_name, None)

    def set_analysis_info(self, plugin_name, analysis_info):
        self.analysis_infos[plugin_name] = analysis_info

    def generate_json_result(self):
        """生成 json 格式的诊断结果"""
        res = {"version": "2.0"}
        for plugin_item in self.enable_plugins:
            plugin_name = plugin_item["name"]
            analysis_info = self.get_analysis_info(plugin_name)
            if analysis_info is not None:
                res[plugin_name] = analysis_info.result
        return res

    def generate_render_text(self):
        """生成输出到终端的文本信息"""
        render_text = ""
        for plugin_item in self.enable_plugins:
            plugin_name = plugin_item["name"]
            analysis_info = self.get_analysis_info(plugin_name)
            if analysis_info is not None:
                title = analysis_info.title
                if not title:
                    title = plugin_name
                if len(render_text) > 0:
                    render_text += "\n\n"
                render_text += mem_utils.print_title(title, 80, show=False)
                if (
                    analysis_info.summary
                    and analysis_info.reason
                    and analysis_info.suggestion
                ):
                    render_text += mem_utils.to_unicode(
                        mem_utils.print_text(
                            "概述：\n%s" % analysis_info.summary, 82, show=False
                        )
                    )
                    render_text += mem_utils.to_unicode("\n")
                    render_text += mem_utils.to_unicode(
                        mem_utils.print_text(
                            "异常原因：\n%s" % analysis_info.reason, 82, show=False
                        )
                    )
                    render_text += mem_utils.to_unicode("\n")
                    render_text += mem_utils.to_unicode(
                        mem_utils.print_text(
                            "处理建议：\n%s" % analysis_info.suggestion, 82, show=False
                        )
                    )
                render_text += mem_utils.to_unicode(analysis_info.render_text)
        return render_text


class PluginCollectInfo:
    def __init__(self):
        self.data = {}

    def load(self, k, default=None):
        return self.data.get(k, default)

    def store(self, k, v):
        self.data[k] = v

    def exists(self, k):
        return k in self.data


class PluginAnalysisInfo:
    def __init__(self):
        self.title = ""
        self.summary = ""
        self.reason = ""
        self.suggestion = ""
        self.result = {}
        self.render_text = ""


class PluginBase:
    __metaclass__ = abc.ABCMeta

    def __init__(self, **kwargs):
        self.params = kwargs

    @abc.abstractmethod
    def collect(self, context):
        """插件可以在本钩子收集数据，并将收集的数据存储到 context 当中
        但是不应该在此阶段进行结论分析
        1. 在调用本插件的分析钩子之前，插件系统会保证所有通过 @memgraph_plugin_requires
           依赖的插件的信息都已经收集完成，但不保证其他插件的信息已经收集完成；
        2. 插件应当在此阶段收集数据，并将数据输出到 Context。
        @params: context: MemgraphPluginContext
        @return: MemgraphPluginCollectInfo
        """
        pass

    @abc.abstractmethod
    def analysis(self, context):
        """插件可以在本钩子进行结论分析，并将结论存储到 context 当中
        1. 在调用结论分析之前，插件系统会保证所有插件的信息收集都已经完成了；
        2. 插件应当在此阶段根据此前本插件收集的信息，或者结合 @memgraph_plugin_requires
           中依赖的插件的信息，进行结论分析，并将分析结果输出到 Contenxt。
           （不要读取 @memgraph_plugin_requires 没有定义的插件的信息，不保证插件存在）
        @params: context: MemgraphPluginContext
        @return: MemgraphPluginAnalysisInfo
        """
        pass

    @classmethod
    def supoort_pod(cls):
        return getattr(cls, "enable_pod", False)


def execute_plugins(selected_plugins=None, enable_pod=False):
    """根据依赖关系，执行已经注册的插件"""
    # 跟踪已经执行的插件
    executed = {}
    context = PluginContext()

    def execute_collect(plugin_name, plugin_params_map, enable_pod):
        if plugin_name in executed:
            return
        plugin_class = plugins.get(plugin_name)

        if plugin_class is None:
            raise ValueError("Plugin %s is not registered." % plugin_name)

        # if enable_pod and the plugin not support pod, skip it
        if enable_pod and not plugin_class.supoort_pod():
            return

        # 递归执行依赖的插件
        if hasattr(plugin_class, "required_plugins"):
            for required_plugin in plugin_class.required_plugins:
                execute_collect(required_plugin, plugin_params_map, enable_pod)

        params = plugin_params_map.get(plugin_name, {})
        # 如果插件支持 pod 模式，传递 enable_pod 参数
        if plugin_class.supoort_pod():
            params["enable_pod"] = enable_pod
        # 执行当前插件
        instance = plugin_class(**params)
        collect_info = instance.collect(context)
        context.set_collect_info(plugin_name, collect_info)
        executed[plugin_name] = instance

    # 如果没有指定哪些插件开启，默认开启所有插件
    if selected_plugins is None:
        if not enable_pod:
            plugins.pop("podDetect")
        selected_plugins = [{"name": name, "params": {}} for name in plugins.keys()]

    context.enable_plugins = selected_plugins

    plugin_params_map = {}
    for plugin_item in selected_plugins:
        plugin_params_map[plugin_item["name"]] = plugin_item["params"]

    # 执行所有插件的收集数据阶段
    for plugin_item in selected_plugins:
        try:
            execute_collect(plugin_item["name"], plugin_params_map, enable_pod)
        except Exception as e:
            mem_utils.log_exception_in_debug_mode(e)

    # 执行所有插件的分析阶段
    for plugin_item in selected_plugins:
        plugin_name = plugin_item["name"]
        if plugin_name not in executed:
            continue
        instance = executed[plugin_name]
        try:
            analysis_info = instance.analysis(context)
            context.set_analysis_info(plugin_name, analysis_info)
        except Exception as e:
            mem_utils.log_exception_in_debug_mode(e)

    return context
