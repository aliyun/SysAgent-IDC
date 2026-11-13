#!/usr/bin/env python
# -*- coding: utf-8 -*-
import os
import socket
import mem_utils
from plugin_system import *

# 01	1	ESTABLISHED	连接已建立
# 02	2	SYN_SENT	已发送 SYN 请求
# 03	3	SYN_RECV	已收到 SYN 请求
# 04	4	FIN_WAIT1	等待远程关闭连接
# 05	5	FIN_WAIT2	等待远程关闭连接确认
# 06	6	TIME_WAIT	连接关闭后等待超时
# 07	7	CLOSE	无连接
# 08	8	CLOSE_WAIT	等待本地关闭连接
# 09	9	LAST_ACK	等待远程关闭连接的最终确认
# 0A	10	LISTEN	监听状态
# 0B	11	CLOSING	双方同时关闭连接
tcp_state_table = {
    1: "ESTABLISHED",  # 连接已建立
    2: "SYN_SENT",  # 已发送 SYN 请求
    3: "SYN_RECV",  # 已收到 SYN 请求
    4: "FIN_WAIT1",  # 等待远程关闭连接
    5: "FIN_WAIT2",  # 等待远程关闭连接确认
    6: "TIME_WAIT",  # 连接关闭后等待超时
    7: "CLOSE",  # 无连接
    8: "CLOSE_WAIT",  # 等待本地关闭连接
    9: "LAST_ACK",  # 等待远程关闭连接的最终确认
    10: "LISTEN",  # 监听状态
    11: "CLOSING",  # 双方同时关闭连接
}

udp_state_table = {1: "ESTABLISHED", 7: "UNCONN"}  # 连接已建立  # 未连接

unix_state_table = {
    0: "FREE",
    1: "UNCONNECTED",
    2: "CONNECTING",  # 正在连接
    3: "CONNECTED",  # 已连接
    4: "DISCONNECTING",  # 正在断开连接
}


def get_pid_net_info(pid, lite_mode=False):
    """
    获取指定 PID 的网络信息
    """

    def get_net_info(protocol, file_path, net_info):
        """
        raw:
            sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode ref pointer drops
        raw6:
            sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode ref pointer drops
        udp:
            sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode ref pointer drops
        udp6:
            sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode ref pointer drops
        udplite:
            sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode ref pointer drops
        udplite6:
            sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode ref pointer drops
        tcp:
        sl(0)  local_address(1) rem_address(2)   st(3) tx_queue(4.1) rx_queue(4.2) tr(5.1) tm->when(5.2) retrnsmt(6)   uid(7)  timeout(8) inode(9)
        0: 0100007F:8E9E 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 437261903 1 ffff8b72b20b9ec0 100 0 0 10 0
        1: 0100007F:9286 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 437261901 1 ffff8b72b20b8a40 100 0 0 10 0

        tcp6:
        sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
        0: 00000000000000000000000000000000:0CEA 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000    27        0 348608123 1 ffff8b6f92402c00 100 0 0 10 0

        Args:
            file_path (_type_): _description_

        Returns:
            _type_: _description_
        """
        with open(file_path, "r") as f:
            lines = f.readlines()
            for line in lines[1:]:  # 跳过标题行
                parts = line.strip().split()
                if len(parts) < 12:
                    continue
                # 提取信息，转成易格式，比如地址转为 IP:port 格式，队列大小转为KB，state 转为字符串
                local_address = parts[1].split(":")
                remote_address = parts[2].split(":")
                if (
                    "tcp6" in file_path
                    or "udp6" in file_path
                    or "udplite6" in file_path
                    or "raw6" in file_path
                ):
                    local_ip = socket.inet_ntop(
                        socket.AF_INET6, mem_utils.bytes_to_hex(local_address[0])[::-1]
                    )
                elif (
                    "tcp" in file_path
                    or "udp" in file_path
                    or "udplite" in file_path
                    or "raw" in file_path
                ):
                    local_ip = socket.inet_ntoa(
                        mem_utils.bytes_to_hex(local_address[0])[::-1]
                    )
                local_port = int(local_address[1], 16)
                if (
                    "tcp6" in file_path
                    or "udp6" in file_path
                    or "udplite6" in file_path
                    or "raw6" in file_path
                ):
                    remote_ip = socket.inet_ntop(
                        socket.AF_INET6, mem_utils.bytes_to_hex(remote_address[0])[::-1]
                    )
                elif (
                    "tcp" in file_path
                    or "udp" in file_path
                    or "udplite" in file_path
                    or "raw" in file_path
                ):
                    remote_ip = socket.inet_ntoa(
                        mem_utils.bytes_to_hex(remote_address[0])[::-1]
                    )
                remote_port = int(remote_address[1], 16)
                if "udp" in file_path or "raw" in file_path:
                    state = udp_state_table.get(int(parts[3], 16), "UNKNOWN")
                else:
                    state = tcp_state_table.get(int(parts[3], 16), "UNKNOWN")

                queues = parts[4].split(":")
                tx_queue = int(queues[0], 16) // 1024  # 转
                rx_queue = int(queues[1], 16) // 1024
                retrnsmt = int(parts[6], 16)
                inode = parts[9]
                if lite_mode:
                    net_info[inode] = {}
                else:
                    net_info[inode] = {
                        "protocol": protocol,
                        "local_ip": local_ip,
                        "local_port": local_port,
                        "remote_ip": remote_ip,
                        "remote_port": remote_port,
                        "state": state,
                        "tx_queue": tx_queue,
                        "rx_queue": rx_queue,
                        "retrnsmt": retrnsmt,
                    }
            return net_info

    def get_unix_net_info(file_path, net_info):
        """
        Num       RefCount Protocol Flags    Type St Inode Path
        ffff8b72cf6baac0: 00000002 00000000 00010000 0001 01 395986121 /tmp/vscode-ipc-0d2808c9-da6b-4de6-8d16-481eb31065b1.sock
        ffff8b72bcf84280: 00000002 00000000 00010000 0001 01 358505400 /tmp/vscode-remote-containers-ipc-25cb7b04-babc-4e11-a1e0-ea1b08a8f681.sock
        ffff8b75942c9300: 00000002 00000000 00010000 0001 01 381216346 /tmp/vscode-remote-containers-ipc-e985c9e2-6762-4241-a26b-cd22049a0abb.sock

        Args:
            file_path (_type_): _description_

        Returns:
            _type_: _description_
        """
        with open(file_path, "r") as f:
            lines = f.readlines()
            for line in lines[1:]:
                parts = line.strip().split()
                if len(parts) < 7:
                    continue
                # 提取信息，转成易格式，比如地址转为 IP:port 格式，队列大小转为KB，state 转为字符串
                state = unix_state_table.get(int(parts[5], 16), "UNKNOWN")
                inode = parts[6]
                path = "" if len(parts) < 8 else parts[7]
                if lite_mode:
                    net_info[inode] = {}
                else:
                    net_info[inode] = {"protocol": "unix", "path": path, "state": state}
        return net_info

    def get_netlink_net_info(file_path, net_info):
        """
        sk               Eth Pid        Groups   Rmem     Wmem     Dump  Locks    Drops    Inode
        ffff8b6f15f80000 0   0          00000000 0        0        0     2        0        348606852
        ffff8b6f0a6a0000 0   68519      00000000 0        0        0     2        0        348598154
        ffff8b732952e000 0   133        000405d1 0        0        0     2        0        348609623
        ffff8b6f966d4800 4   0          00000000 0        0        0     2        0        34860687

        Args:
            file_path (_type_): _description_

        Returns:
            _type_: _description_
        """
        with open(file_path, "r") as f:
            lines = f.readlines()
            for line in lines[1:]:
                parts = line.strip().split()
                if len(parts) < 9:
                    continue
                inode = parts[-1]
                if lite_mode:
                    net_info[inode] = {}
                else:
                    net_info[inode] = {"protocol": "netlink"}
        return net_info

    net_info = {}
    net_path = mem_utils.get_real_path("/proc/%s/net" % (pid))
    if not os.path.exists(net_path):
        return net_info

    for protocol in os.listdir(net_path):
        if protocol in [
            "tcp",
            "tcp6",
            "udp",
            "udp6",
            "udplite",
            "udplite6",
            "raw",
            "raw6",
        ]:
            get_net_info(protocol, os.path.join(net_path, protocol), net_info)
        elif protocol == "unix":
            get_unix_net_info(os.path.join(net_path, protocol), net_info)
        elif protocol == "netlink":
            get_netlink_net_info(os.path.join(net_path, protocol), net_info)
    return net_info


def get_pid_net_namespace_id(pid):
    """获取进程的 net namespace id

    lrwxrwxrwx 1 root root 0 Jul 28 10:30 /proc/64858/ns/net -> 'net:[4026531994]'

    Args:
        pid (int): 进程ID

    Returns:
        int: net namespace id
    """
    net_path = mem_utils.get_real_path("/proc/%s/ns/net" % (pid))
    try:
        # 检查进程是否存在
        if not os.path.exists(mem_utils.get_real_path("/proc/%s" % (pid))):
            return None

        # 读取符号链接
        link_target = os.readlink(net_path)
        return link_target

    except Exception as e:
        mem_utils.log_exception_in_debug_mode(e)
        return None


def get_sockstat_by_pid(pid):
    """获取 PID 所在网络命名空间的 socket 统计信息"""

    def parse_line(line):
        """通用解析函数：将一行 sockstat 内容按 key-value 解析"""
        if not line or "used" not in line and "inuse" not in line:
            return {}
        parts = line.strip().split()
        kv_pairs = {}
        i = 0
        while i < len(parts):
            key = parts[i]
            if key.endswith(":"):
                key = key[:-1]
            i += 1
            values = []
            while i < len(parts) and parts[i].isdigit():
                values.append(parts[i])
                i += 1
            if values:
                # 多个值用下划线连接
                kv_pairs[key] = (
                    int(values[0]) if len(values) == 1 else [int(v) for v in values]
                )
        return kv_pairs

    sockstat_path = mem_utils.get_real_path("/proc/%s/net/sockstat" % (pid))
    try:
        # 检查进程是否存在
        if not os.path.exists(sockstat_path):
            return None

        # 读取文件
        result = {
            "socket_used": 0,
            "tcp_inuse": 0,
            "tcp_orphan": 0,
            "tcp_tw": 0,
            "tcp_alloc": 0,
            "tcp_mem": 0,
            "udp_inuse": 0,
            "udp_mem": 0,
            "udplite_inuse": 0,
            "raw_inuse": 0,
            "frag_inuse": 0,
            "frag_mem": 0,
        }
        with open(sockstat_path, "r") as f:
            for line in f.readlines():
                if line.startswith("sockets:"):
                    parsed = parse_line(line)
                    result["socket_used"] = parsed.get("used", 0)
                elif line.startswith("TCP:"):
                    parsed = parse_line(line)
                    result["tcp_inuse"] = parsed.get("inuse", 0)
                    result["tcp_orphan"] = parsed.get("orphan", 0)
                    result["tcp_tw"] = parsed.get("tw", 0)
                    result["tcp_alloc"] = parsed.get("alloc", 0)
                    result["tcp_mem"] = parsed.get("mem", 0)
                elif line.startswith("UDP:"):
                    parsed = parse_line(line)
                    result["udp_inuse"] = parsed.get("inuse", 0)
                    result["udp_mem"] = parsed.get("mem", 0)
                elif line.startswith("UDPLITE:") or line.startswith("RAW:"):
                    parsed = parse_line(line)
                    protocol = line.split(":")[0].lower()
                    result["%s_inuse" % (protocol)] = parsed.get("inuse", 0)
                elif line.startswith("FRAG:"):
                    parsed = parse_line(line)
                    result["frag_inuse"] = parsed.get("inuse", 0)
                    result["frag_mem"] = parsed.get("memory", 0)
        return result
    except Exception as e:
        mem_utils.log_exception_in_debug_mode(e)
        return None

def check_is_java_process(pid):
    def checkJavaMaps(pid):
        """
        检查进程是否加载了libjvm.so库
        """
        path = mem_utils.get_real_path("/proc/") + pid + "/maps"
        try:
            with open(path, 'r') as fd:
                for line in fd:
                    if "libjvm.so" in line:
                        return True
        except Exception as e:
            mem_utils.log_exception_in_debug_mode(e)
            pass

        return False
    
    def readJavaComnand(pid):
        """ 
        检查进程名是否带有 java 关键字
        """
        path = mem_utils.get_real_path("/proc/") + pid + "/comm"
        try:
            with open(path, 'r') as f:
                comn = f.read()
                comm = comn.rstrip()
                if "java" in comm:
                    return True
                else:
                    return False
        except Exception as e:
            mem_utils.log_exception_in_debug_mode(e)
            pass

    if not pid:
        return False
    return checkJavaMaps(pid) and readJavaComnand(pid)


def detect_process_language(pid):
    """
    识别进程的语言类型（参考 pymem 的识别逻辑）
    
    返回值: "python", "java", "go", "nodejs", "native", "unknown"
    """
    try:
        root = mem_utils.get_real_path("/proc/")
        exe_path = root + pid + "/exe"
        
        # 1. 读取 /proc/{pid}/exe 符号链接
        try:
            exe = os.readlink(exe_path)
            exe_name = os.path.basename(exe)
            exe_lower = exe_name.lower()
            
            # Python: 参考 pymem 的识别逻辑
            # - python, python2, python3, python3.6, python3.11, etc.
            # - platform-python, platform-python3.6 (RHEL 8/AlmaLinux/CentOS 8)
            is_python = (
                exe_name.startswith("python")
                or exe_name.startswith("platform-python")
            )
            if is_python:
                return "python"
            
            # Java: 使用已有的专门检测函数（检查 libjvm.so）
            if "java" in exe_lower or check_is_java_process(pid):
                return "java"
            
            # Node.js: /usr/bin/node, /usr/local/bin/node
            if exe_name.startswith("node"):
                return "nodejs"
            
            # Go: 检查 ELF 是否包含 go 特征
            if check_is_go_binary(exe):
                return "go"
                
        except Exception:
            pass
        
        # 2. 如果 exe 无法读取，尝试从 cmdline 获取第一个参数（作为 fallback）
        # 注意：这里只用于无法读取 exe 的情况，避免像 "bash -c python" 的误判
        cmdline_file = root + pid + "/cmdline"
        if os.path.exists(cmdline_file):
            try:
                with open(cmdline_file, 'r') as f:
                    cmdline = f.read()
                    # cmdline 以 \x00 分隔参数
                    parts = cmdline.split('\x00')
                    if parts:
                        first_arg = parts[0]
                        if first_arg:
                            arg_basename = os.path.basename(first_arg)
                            
                            # 只有当第一个参数本身就是解释器时才识别
                            if arg_basename.startswith("python") or arg_basename.startswith("platform-python"):
                                return "python"
                            if arg_basename.startswith("java"):
                                return "java"
                            if arg_basename.startswith("node"):
                                return "nodejs"
            except Exception:
                pass
        
        # 3. 如果都没识别出来，默认为 native (C/C++/Rust等)
        return "native"
        
    except Exception as e:
        mem_utils.log_exception_in_debug_mode(e)
        return "unknown"


def check_is_go_binary(exe_path):
    """
    检查二进制是否为 Go 编译的（简化版）
    Go 编译的二进制通常包含 .go.buildinfo 或 .gopclntab section
    """
    try:
        # 方法1: 检查文件中是否有 go 特征字符串（简单但有效）
        # 避免读取整个文件，只读取前 1MB
        with open(exe_path, 'rb') as f:
            header = f.read(1024 * 1024)
            # Go 编译的二进制通常包含这些字符串
            if b'.gopclntab' in header or b'.go.buildinfo' in header or b'go.itab' in header:
                return True
    except Exception as e:
        mem_utils.log_exception_in_debug_mode(e)
        pass
    return False

@plugin(name="taskProc")
@plugin_pod_support()
class TaskProcPlugin(PluginBase):
    """任务 proc 信息采集插件, 如果在容器中运行诊断，需要共享pid namespace参数

    输出：
    1. taskInfo: 任务的内存信息，包含PID，名称，用户态匿名内存（RssAnon），用户态文件内存（RssFile），
    用户态共享内存（RssShmem），任务实际使用的物理内存（VmRSS）。
        {
            "1": {
                "Name": "systemd",
                "Pid": "1",
                "RssAnon": 3208,
                "RssFile": 4820,
                "RssShmem": 0,
                "VmRSS": 8028
            }
            ...
        }

    2. taskSortedByAnon: 任务按照匿名内存降序排序。
        [["1212062", 2953484], ["1298842", 2939456], ["<任务ID>", <匿名内存用量，单位KB>]]

    3. taskSortedByVmRss: 任务安装实际占用的物理内存排序。
        [["1212062", 2953484], ["1298842", 2939456], ["<任务ID>", <物理内存用量，单位KB>]]

    4. filePidMap: 文件和进程的映射关系。
       {"/dev/shm/test": ["1234", "5678"], "/tmp/test": ["1234", "5678"]}

    5. memTop: Top 30 内存占用的任务信息
    """

    def scan_proc_file(self, file_map, pid, net_info_map):
        """扫描指定

        Args:
            file_map (_type_): filename -> [pid1, pid2, ...]
            通过这个映射关系，可以知道哪些文件被哪些进程打开
            例如：{"/dev/shm/test": ["1234", "5678"], "/tmp/test": ["1234", "5678"]}
            sockets (_type_): [socket1_inode, socket2_inode, ...]
            通过这个列表，可以知道系统中有哪些 socket 文件被打开
            pid (_type_): 目标进程
        """
        # 根据是否使能了 socket 扫描，决定是否扫描 socket 文件
        enable_socket_scan = self.params.get("enable_socket_scan", True)
        filename = mem_utils.get_real_path("/proc/") + pid + "/fd"
        result = {"socket_count": 0}
        try:
            may_leak_socket_inodes = []
            all_socket_inodes = []
            for fd in os.listdir(filename):
                fd_path = filename + "/" + fd
                if os.path.isdir(fd_path):
                    continue
                if not os.path.exists(fd_path):
                    continue
                tmp = os.readlink(fd_path).strip()
                if len(tmp) < 2:
                    continue
                if tmp[0] != "/":
                    if not enable_socket_scan and "socket" not in tmp:
                        continue
                # if tmp[0:5] == "/dev/":
                #     continue
                if tmp[0:6] == "/proc/":
                    continue
                if tmp[0:5] == "/sys/":
                    continue
                if tmp not in file_map:
                    file_map[tmp] = []
                file_map[tmp].append(pid)
                if "socket:[" in tmp:
                    # 处理 socket 文件
                    inode = tmp.strip().split("[")
                    if len(inode) < 2:
                        continue
                    result["socket_count"] += 1
                    inode = inode[1][:-1].strip()
                    all_socket_inodes.append(inode)
                    if inode not in net_info_map:
                        may_leak_socket_inodes.append(inode)
            result["may_leak_socket_inodes"] = may_leak_socket_inodes
            result["all_socket_inodes"] = all_socket_inodes
        except Exception as e:
            mem_utils.log_exception_in_debug_mode(e)
            pass
        return result

    def get_cgroup_procs(self, cgroup_path):
        pids = []
        with open(cgroup_path + "/cgroup.procs", "r") as f:
            for line in f.readlines():
                pids.append(line.strip())
        return pids

    def collect(self, context):

        def collect_task_info(pids, root):
            # 任务的内存信息，包含PID，名称，用户态匿名内存（RssAnon），用户态文件内存（RssFile），
            # 用户态共享内存（RssShmem），任务实际使用的物理内存（VmRSS）
            taskInfo = {}
            taskMem = {}
            taskAnon = {}
            filePidMap = {}
            socketInfo = {}
            taskSockets = {}
            # 注意：通过 /proc/net/* 查到的只是 host 网络命名空间的 socket，如果容器不是host模式查不到

            # 先使用 LITE 模式获取一遍所有网络命名空间的 socket 信息
            net_namespace_net_info_map = {}
            pid_net_namespace_map = {}
            for pid in pids:
                try:
                    if not os.path.exists(root + pid):
                        continue
                    if not mem_utils.is_number(pid):
                        continue
                    # 获取进程的网络命名空间
                    net_namespace_id = get_pid_net_namespace_id(pid)
                    pid_net_namespace_map[pid] = net_namespace_id
                    if net_namespace_id not in net_namespace_net_info_map:
                        net_namespace_net_info_map[net_namespace_id] = get_pid_net_info(
                            pid, True
                        )
                except Exception as e:
                    mem_utils.log_exception_in_debug_mode(e)
                    # 忽略异常
                    pass

            pid_socket_scan_result = {}
            container_infos = mem_utils.get_container_infos()
            for pid in pids:
                try:
                    if not os.path.exists(root + pid):
                        continue
                    if not mem_utils.is_number(pid):
                        continue
                    filename = root + pid + "/status"
                    net_info = None
                    if pid_net_namespace_map[pid] is not None:
                        net_info = net_namespace_net_info_map[
                            pid_net_namespace_map[pid]
                        ]
                    result = self.scan_proc_file(filePidMap, pid, net_info)
                    pid_socket_scan_result[pid] = result
                    with open(filename, "r") as f:
                        lines = f.readlines()
                        if "".join(lines).find("RssAnon") == -1:
                            continue
                        task = {}
                        for line in lines:
                            values = line.strip().split()
                            if len(values) < 2:
                                continue
                            key = values[0][:-1]
                            # get memory usage
                            value = values[1]
                            task[key] = value
                        tmp = {}
                        tmp["Name"] = task["Name"]
                        tmp["Pid"] = task["Pid"]
                        tmp["RssAnon"] = int(task["RssAnon"])
                        tmp["RssFile"] = int(task["RssFile"])
                        tmp["RssShmem"] = int(task["RssShmem"])
                        tmp["VmRSS"] = int(task["VmRSS"])
                        taskInfo[pid] = tmp
                        taskAnon[pid] = int(task["RssAnon"])
                        taskMem[pid] = int(task["VmRSS"])

                    # 获取cmdline
                    cmdline_file = root + pid + "/cmdline"
                    if os.path.exists(cmdline_file):
                        with open(cmdline_file, "r") as f:
                            cmdline = f.read().strip()
                            if cmdline:
                                taskInfo[pid]["cmdline"] = cmdline.replace("\x00", " ")

                    # 获取 memcg，根据 memcg 获取容器名称
                    memcg = mem_utils.get_memcg_by_pid(pid)
                    taskInfo[pid]["memcg"] = memcg
                    if memcg in container_infos:
                        taskInfo[pid]["ContainerInfo"] = container_infos[memcg]
                        
                    # 识别进程语言类型
                    taskInfo[pid]["ProcessType"] = detect_process_language(pid)

                except Exception as e:
                    mem_utils.log_exception_in_debug_mode(e)
                    # 忽略异常
                    pass

            # 再获取一遍所有网络命名空间的 socket 信息，用来确认是否有 socket 泄漏
            net_namespace_net_info_map = {}
            namespace_sockstat = {}
            for pid in pids:
                try:
                    if not os.path.exists(root + pid):
                        continue
                    if not mem_utils.is_number(pid):
                        continue
                    # 获取进程的网络命名空间
                    net_namespace_id = get_pid_net_namespace_id(pid)
                    pid_net_namespace_map[pid] = net_namespace_id
                    if net_namespace_id not in net_namespace_net_info_map:
                        net_namespace_net_info_map[net_namespace_id] = get_pid_net_info(
                            pid, False
                        )
                        result = get_sockstat_by_pid(pid)
                        result["namespace"] = net_namespace_id
                        if result is not None:
                            namespace_sockstat[net_namespace_id] = result
                        socketInfo.update(net_namespace_net_info_map[net_namespace_id])
                    net_info = net_namespace_net_info_map[net_namespace_id]
                    scan_result = pid_socket_scan_result[pid]
                    if scan_result["socket_count"] > 0:
                        taskSockets[pid] = {
                            "socket_count": scan_result["socket_count"],
                            "all_socket_inodes": scan_result["all_socket_inodes"],
                        }
                        leak_inodes = []
                        if scan_result["may_leak_socket_inodes"]:
                            for inode in scan_result["may_leak_socket_inodes"]:
                                if inode not in net_info:
                                    leak_inodes.append(inode)
                        taskSockets[pid]["leak_socket_inodes"] = leak_inodes
                except Exception as e:
                    mem_utils.log_exception_in_debug_mode(e)
                    # 忽略异常
                    pass

            # 任务按照匿名内存降序排序
            taskSortedByAnon = sorted(
                taskAnon.items(), key=lambda kv: (kv[1], kv[0]), reverse=True
            )
            # 任务安装实际占用的物理内存排序
            taskSortedByVmRss = sorted(
                taskMem.items(), key=lambda kv: (kv[1], kv[0]), reverse=True
            )

            res = {
                "taskInfo": taskInfo,
                "taskSortedByAnon": taskSortedByAnon,
                "taskSortedByVmRss": taskSortedByVmRss,
                "filePidMap": filePidMap,
                "socketInfo": socketInfo,
                "taskSockets": taskSockets,
                "namespaceSockstat": namespace_sockstat,
            }
            return res

        collect_info = PluginCollectInfo()
        pids = []
        root = mem_utils.get_real_path("/proc/")
        enable_pod = self.params.get("enable_pod", False)

        if enable_pod:
            pod_info = context.get_collect_info("podDetect").load("pod_info")
            containers = context.get_collect_info("podDetect").load("containers")
            cgroup_root = context.get_collect_info("podDetect").load("cgroup_root")
            pod_cgroup = cgroup_root + pod_info.get("CgroupParent", "")
            pod_name = pod_info.get("Name", "")

            # normally, pod cgroup should have no process
            # but we still collect it for completeness
            pids = self.get_cgroup_procs(pod_cgroup)
            res = collect_task_info(pids, root)
            collect_info.store(pod_name, res)

            for container in containers:
                con_name = container.get("ContainerName", "")
                con_cgroup = cgroup_root + container.get("ContainerCgroup", "")
                pids = self.get_cgroup_procs(con_cgroup)
                res = collect_task_info(pids, root)
                collect_info.store(con_name, res)

        else:
            pids = os.listdir(root)
            res = collect_task_info(pids, root)
            for key in res:
                collect_info.store(key, res[key])
        return collect_info

    def analysis(self, context):
        return None
