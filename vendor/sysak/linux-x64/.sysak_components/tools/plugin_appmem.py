#!/usr/bin/env python
# -*- coding: utf-8 -*-
import tempfile
import json
import os
from plugin_system import *

@plugin(name="appMem")
@plugin_requires("taskProc")
@plugin_pod_support()
class AppMemPlugin(PluginBase):
    """ 插件分析应用内存"""
    
    def collect_java_mem(self, pid):
        """ call javamem to diagnose specific java process"""
        java_mem_info = {}
        script_dir = os.path.dirname(os.path.abspath(__file__))
        javamem_path = os.path.join(script_dir, "javamem")
        with tempfile.NamedTemporaryFile() as tmpfile:
            cmd = [
                javamem_path,
                "-g",
                "-p", str(pid),
                "-j",
                tmpfile.name,
            ]
            code, _, error = mem_utils.run_cmd(cmd, timeout=180)
            if code != 0:
                print("Failed to run javamem for pid: %s, reason %s" % (pid, error))
                return java_mem_info
            
            try:
                with open(tmpfile.name, "r") as f:
                    result = json.load(f)
                    java_mem_info = result
            except Exception as e:
                print("Failed to parse javamem result for pid: %s, reason %s" % (pid, e))
        
        return java_mem_info
    
    def java_profiling(self, pid, profiling_duration):
        script_dir = os.path.dirname(os.path.abspath(__file__))
        javamem_path = os.path.join(script_dir, "javamem")
        cmd = [
            javamem_path, "-p", str(pid), "-n", 
            "--livetrace", "--duration", str(profiling_duration)
        ]
        code, _, error = mem_utils.run_cmd(cmd, timeout=180)
        if code != 0:
            print("Failed to run java profiling for pid: %s, reason %s" % (pid, error))

    def collect_one(self, taskinfo, enable_pod):
        app_type = self.params.get("app_type", "")
        target_pid = self.params.get("pid", None)
        profiling_duration = self.params.get("profiling_duration", 0)
        
        app_mem_info = {
            "app_mem": {}
        }
    
        # 遍历rss最大进程, 触发应用内存大图诊断
        java_mem = {}
        java_profiling = []
        tasks_info = taskinfo.get("taskInfo", {})
        for pid, _ in taskinfo.get("taskSortedByVmRss", []):
            process_info = tasks_info.get(pid)
            if not process_info:
                continue

            if process_info.get("ProcessType") == "java":
                if not (app_type == "all" or app_type == "java"):
                    continue
                
                # 节点只处理top 3 java进程，容器只处理top 1
                if enable_pod:
                    if len(java_mem) >= 1:
                        continue
                else:           
                    if len(java_mem) > 2:
                        continue
                
                info = self.collect_java_mem(pid)
                if info:
                    java_mem[pid] = info
                
                # 如果没有指定pid，且设置了profiling_duration，则对内存最大的进程进行java profiling
                if not target_pid and profiling_duration > 0 and len(java_profiling) == 0:
                    # self.java_profiling(pid, profiling_duration)
                    java_profiling.append(pid)
        
        # 对指定的进程进行java profiling
        if target_pid and profiling_duration > 0:
            for pid in tasks_info.keys():
                if pid not in java_mem:
                    info = self.collect_java_mem(pid)
                    if info:
                        java_mem[pid] = info
                
                if pid == target_pid:
                    # self.java_profiling(pid, profiling_duration)
                    java_profiling.append(pid)
        
        # if profiling_duration > 0 and len(java_profiling) <= 0:
        #     print("Warn: No java process to profile for pid: %s" % target_pid)
        
        for k, v in java_mem.items():
            app_mem_info["app_mem"][k] = v

        if len(java_profiling) > 0:
            app_mem_info["app_mem"]["profiling_pids"] = java_profiling

        return app_mem_info

    def collect(self, context):
        collect_info = PluginCollectInfo()
        enable_pod = self.params.get("enable_pod", False)
        task_proc_collect_info = context.get_collect_info("taskProc")
        # taskInfo = task_proc_collect_info.load("taskInfo")
        if enable_pod:
            pod_name = context.get_collect_info("podDetect").load("pod_name")
            for con_name, con_info in task_proc_collect_info.data.items():
                # skip pod itself, only show containers
                # because pod cgroup itself has no process
                if con_name == pod_name:
                    continue
                
                app_mem = self.collect_one(con_info, enable_pod)                
                collect_info.store(con_name, app_mem)
        else:
            app_mem = self.collect_one(task_proc_collect_info.data, enable_pod)
            for key in app_mem:
                collect_info.store(key, app_mem[key])
        
        return collect_info
    
    def analysis(self, context):
        analysis_info = PluginAnalysisInfo()
        analysis_info.result = context.get_collect_info("appMem").data
        # version 2.0 通知中心端使用新的profiling方式
        analysis_info.result["version"] = "2.0"
        # TODO: 工具侧展示诊断结果，目前只透出json供中心端使用
        
        return analysis_info