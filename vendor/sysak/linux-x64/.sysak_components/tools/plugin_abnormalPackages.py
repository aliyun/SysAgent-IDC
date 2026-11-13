#!/usr/bin/env python
# -*- coding: utf-8 -*-
from plugin_system import *
import mem_utils


@plugin(name="abnormalPackages")
class AbnormalPackagesPlugin(PluginBase):
    """异常包插件，用于检测系统中存在内存泄露的异常包"""

    def check_package_eq(self, package_name, package_version):
        code, res, _ = mem_utils.run_cmd(
            "rpm -q --queryformat '%{VERSION}-%{Release}' " + package_name
        )
        return code == 0 and res.strip() == package_version.strip()

    def batch_check_package_eq(self, package_list):
        results = []
        for package_name, package_version in package_list:
            if self.check_package_eq(package_name, package_version):
                results.append((package_name, package_version))
        return results

    def collect(self, context):
        collect_info = PluginCollectInfo()
        res = self.batch_check_package_eq(
            [
                ("polkit", "0.112-26.1"),
                ("systemd", "219-19.7"),
            ]
        )

        collect_info.store("leak_rpm", res)
        return collect_info

    def analysis(self, context):
        collect_info = context.get_collect_info("abnormalPackages")
        leak_rpm = collect_info.load("leak_rpm")
        if not leak_rpm:
            return None
        analysis_info = PluginAnalysisInfo()
        analysis_info.title = "存在内存泄露异常包检测"
        packages = ", ".join(
            [
                "{}-{}".format(package_item[0], package_item[1])
                for package_item in leak_rpm
            ]
        )
        analysis_info.summary = (
            "检测到系统安装了存在内存泄露的软件包，请及时处理: \n%s" % packages
        )
        analysis_info.suggestion = "建议卸载或升级以下软件包：" + packages
        render_text = analysis_info.summary
        analysis_info.render_text = render_text
        return analysis_info
