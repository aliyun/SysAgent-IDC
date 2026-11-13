#!/usr/bin/env python
# -*- coding: utf-8 -*-
from plugin_system import *
import mem_utils


@plugin(name="socketCheck")
@plugin_requires("taskProc")
@plugin_pod_support()
class SocketCheckPlugin(PluginBase):
    """SocketCheck 插件，用来扫描系统的 TCP memory 和 UDP memory 使用情况"""

    def collect(self, context):
        pass

    def analysis(self, context):
        """
        输出pod信息到json中，供中心端分析使用，不输出到终端
        """
        # sockstat_info = context.get_collect_info("sockstat")
        taskInfo = context.get_collect_info("taskProc").load("taskInfo", {})
        # 记录了 socket_inode -> socket 信息的映射关系
        # 442998820 : {
        #     "protocol": "tcp",
        #     "local_ip": "1.0.0.127",
        #     "local_port": 35590,
        #     "remote_ip": "1.0.0.127",
        #     "remote_port": 36510,
        #     "state": "ESTABLISHED",
        #     "tx_queue": 0,
        #     "rx_queue": 0,
        #     "retrnsmt": 0
        # }
        socketInfo = context.get_collect_info("taskProc").load("socketInfo", {})
        # 记录了每个进程，所有 inode socket 以及泄露的 inode socket
        taskSockets = context.get_collect_info("taskProc").load("taskSockets", {})
        namespaceSockstat = context.get_collect_info("taskProc").load(
            "namespaceSockstat", {}
        )

        # 初始化变量
        protocol_state_send_top = {}
        protocol_state_recv_top = {}
        protocol_state_count_top = {}
        protocol_state_map = {}
        socket_used_top = {}
        leak_socket_used_top = {}

        for pid in taskSockets:
            for inode in taskSockets[pid]["all_socket_inodes"]:
                socket_inode_info = socketInfo.get(inode, None)
                if pid not in socket_used_top:
                    socket_used_top[pid] = 0
                socket_used_top[pid] += 1
                if socket_inode_info is None:
                    if pid not in leak_socket_used_top:
                        leak_socket_used_top[pid] = 0
                    leak_socket_used_top[pid] += 1
                    if "LEAK" not in protocol_state_map:
                        protocol_state_map["LEAK"] = {}
                    if "LEAK" not in protocol_state_map["LEAK"]:
                        protocol_state_map["LEAK"]["LEAK"] = {
                            "count": 0,
                            "send_q": 0,
                            "recv_q": 0,
                        }
                    protocol_state_map["LEAK"]["LEAK"]["count"] += 1
                    continue

                protocol = socket_inode_info.get("protocol", "unknown")
                state = socket_inode_info.get("state", "unknown")
                recv_q = socket_inode_info.get("rx_queue", 0)
                send_q = socket_inode_info.get("tx_queue", 0)

                if protocol not in protocol_state_send_top:
                    protocol_state_send_top[protocol] = {}
                    protocol_state_recv_top[protocol] = {}
                    protocol_state_count_top[protocol] = {}

                # 更新发送和接收队列统计
                if state not in protocol_state_send_top[protocol]:
                    protocol_state_send_top[protocol][state] = {}
                    protocol_state_recv_top[protocol][state] = {}
                    protocol_state_count_top[protocol][state] = {}

                if protocol not in protocol_state_map:
                    protocol_state_map[protocol] = {}

                if state not in protocol_state_map[protocol]:
                    protocol_state_map[protocol][state] = {
                        "count": 0,
                        "send_q": 0,
                        "recv_q": 0,
                    }

                # 更新协议状态统计
                protocol_state_map[protocol][state]["count"] += 1
                protocol_state_map[protocol][state]["send_q"] += send_q
                protocol_state_map[protocol][state]["recv_q"] += recv_q

                if pid not in protocol_state_send_top[protocol][state]:
                    protocol_state_send_top[protocol][state][pid] = 0
                    protocol_state_recv_top[protocol][state][pid] = 0
                    protocol_state_count_top[protocol][state][pid] = 0

                # 更新发送和接收队列统计
                protocol_state_send_top[protocol][state][pid] += send_q
                protocol_state_recv_top[protocol][state][pid] += recv_q
                protocol_state_count_top[protocol][state][pid] += 1

        # 过滤掉发送和接收队列小于 1 的 protocol_state_send_top 和 protocol_state_recv_top
        protocol_state_send_top = {
            protocol: {
                state: {
                    pid: send_q
                    for pid, send_q in protocol_state_send_top[protocol][state].items()
                    if send_q >= 1
                }
                for state in protocol_state_send_top[protocol]
            }
            for protocol in protocol_state_send_top
        }
        protocol_state_recv_top = {
            protocol: {
                state: {
                    pid: recv_q
                    for pid, recv_q in protocol_state_recv_top[protocol][state].items()
                    if recv_q >= 1
                }
                for state in protocol_state_recv_top[protocol]
            }
            for protocol in protocol_state_recv_top
        }

        # 得到每个 <protocol, state> 按发送队列大小排序的 top 10 进程
        top_send_tasks = {}
        for protocol, states in protocol_state_send_top.items():
            top_send_tasks[protocol] = {}
            for state, pids in states.items():
                sorted_pids = sorted(pids.items(), key=lambda x: x[1], reverse=True)
                top_send_tasks[protocol][state] = sorted_pids[:20]
        top_recv_tasks = {}
        for protocol, states in protocol_state_recv_top.items():
            top_recv_tasks[protocol] = {}
            for state, pids in states.items():
                sorted_pids = sorted(pids.items(), key=lambda x: x[1], reverse=True)
                top_recv_tasks[protocol][state] = sorted_pids[:20]
        top_count_tasks = {}
        for protocol, states in protocol_state_count_top.items():
            top_count_tasks[protocol] = {}
            for state, pids in states.items():
                sorted_pids = sorted(pids.items(), key=lambda x: x[1], reverse=True)
                top_count_tasks[protocol][state] = sorted_pids[:20]
        top_leak_socket_used = sorted(
            leak_socket_used_top.items(), key=lambda x: x[1], reverse=True
        )[:20]
        top_socket_used = sorted(
            socket_used_top.items(), key=lambda x: x[1], reverse=True
        )[:20]

        # 构建 PluginAnalysisInfo
        analysis_info = PluginAnalysisInfo()
        analysis_info.title = "Socket 连接分析"
        analysis_info.summary = "展示系统中 socket 的详细使用情况及异常检测"
        analysis_info.render_text = ""

        ##########################################################################
        # 各网络命名空间的统计信息
        ##########################################################################
        headers = [
            "网络命名空间",
            "Socket数量",
            "TCP 套接字数量",
            "UDP 套接字数量",
            "TCP 套接字使用内存",
            "UDP 套接字使用内存",
        ]
        table_data = []
        for namespace in namespaceSockstat:
            item = namespaceSockstat[namespace]
            table_data.append(
                [
                    item.get("namespace", namespace),
                    item.get("socket_used", 0),
                    item.get("tcp_inuse", 0),
                    item.get("udp_inuse", 0),
                    mem_utils.format_unit(
                        item.get("tcp_mem", 0) * 4, is_bytes=False, simple=True
                    ),
                    mem_utils.format_unit(
                        item.get("udp_mem", 0) * 4, is_bytes=False, simple=True
                    ),
                ]
            )

        analysis_info.render_text += mem_utils.print_table(
            headers, table_data, title="各网络命名空间统计信息", show=False
        )

        ##########################################################################
        # 各连接状态统计信息
        ##########################################################################

        # 添加协议所有状态的统计行
        all_count, all_send_q, all_recv_q = 0, 0, 0
        for protocol, states in protocol_state_map.items():
            total_count = sum(data["count"] for data in states.values())
            total_send_q = sum(data["send_q"] for data in states.values())
            total_recv_q = sum(data["recv_q"] for data in states.values())
            if protocol != "LEAK":
                if "all" not in protocol_state_map[protocol]:
                    protocol_state_map[protocol]["all"] = {
                        "count": total_count,
                        "send_q": total_send_q,
                        "recv_q": total_recv_q,
                    }
                else:
                    protocol_state_map[protocol]["all"]["count"] += total_count
                    protocol_state_map[protocol]["all"]["send_q"] += total_send_q
                    protocol_state_map[protocol]["all"]["recv_q"] += total_recv_q
            all_count += total_count
            all_send_q += total_send_q
            all_recv_q += total_recv_q
        protocol_state_map["all"] = {}
        protocol_state_map["all"]["all"] = {
            "count": all_count,
            "send_q": all_send_q,
            "recv_q": all_recv_q,
        }

        headers = ["协议", "状态", "数量", "发送队列总大小", "接收队列总大小"]
        table_data = []
        for protocol, states in protocol_state_map.items():
            for state, data in states.items():
                table_data.append(
                    [
                        protocol,
                        state,
                        data.get("count", 0),
                        mem_utils.format_unit(
                            data.get("send_q", 0), is_bytes=False, simple=True
                        ),
                        mem_utils.format_unit(
                            data.get("recv_q", 0), is_bytes=False, simple=True
                        ),
                    ]
                )

        analysis_info.render_text += mem_utils.print_table(
            headers, table_data, title="各状态队列大小", show=False
        )

        all_need_pid_info = []
        ##########################################################################
        # Socket 泄露 Top20 进程
        ##########################################################################
        headers = ["进程名", "PID", "Socket数量", "泄露 Socket 数量", "泄露inodes"]
        data = []
        for pid, count in top_leak_socket_used:
            comm = ""
            if str(pid) in taskInfo:
                comm = taskInfo[str(pid)].get("Name", "Unknown")
            all_need_pid_info.append(pid)
            data.append(
                [
                    comm,
                    pid,
                    socket_used_top[pid],
                    count,
                    ",".join(taskSockets[pid].get("leak_socket_inodes", [])[:5]),
                ]
            )
            taskInfo[pid]["leak_socket_inodes"] = taskSockets[pid].get(
                "leak_socket_inodes", []
            )[:10]
        analysis_info.render_text += mem_utils.print_table(
            headers,
            data,
            title="Socket 泄露 Top20 进程",
            show=False,
        )

        ##########################################################################
        # Socket 使用 Top20 进程
        ##########################################################################
        headers = ["进程名", "PID", "Socket数量"]
        data = []
        for pid, count in top_socket_used:
            comm = ""
            if str(pid) in taskInfo:
                comm = taskInfo[str(pid)].get("Name", "Unknown")
            all_need_pid_info.append(pid)
            data.append([comm, pid, count])
        analysis_info.render_text += mem_utils.print_table(
            headers,
            data,
            title="Socket 使用 Top20 进程",
            show=False,
        )

        ##########################################################################
        # 各状态 TopN 发送队列/接收队列进程
        ##########################################################################

        # 如果 <protocol, state> send or recv的topN进程不为空，则打印对应的子表格
        for protocol, states in top_send_tasks.items():
            for state, pids in states.items():
                if not pids:
                    continue
                headers = ["进程名", "PID", "发送队列大小"]
                data = []
                for pid, send_q in pids:
                    all_need_pid_info.append(pid)
                    comm = ""
                    if str(pid) in taskInfo:
                        comm = taskInfo[str(pid)].get("Name", "Unknown")
                    data.append(
                        [
                            comm,
                            pid,
                            mem_utils.format_unit(send_q, is_bytes=False, simple=True),
                        ]
                    )
                analysis_info.render_text += mem_utils.print_table(
                    headers,
                    data,
                    title="%s %s 发送队列 Top 20" % (protocol, state),
                    show=False,
                )
        for protocol, states in top_recv_tasks.items():
            for state, pids in states.items():
                if not pids:
                    continue
                headers = ["进程名", "PID", "接收队列大小"]
                data = []
                for pid, recv_q in pids:
                    all_need_pid_info.append(pid)
                    comm = ""
                    if str(pid) in taskInfo:
                        comm = taskInfo[str(pid)].get("Name", "Unknown")
                    data.append(
                        [
                            comm,
                            pid,
                            mem_utils.format_unit(recv_q, is_bytes=False, simple=True),
                        ]
                    )
                analysis_info.render_text += mem_utils.print_table(
                    headers,
                    data,
                    title="%s %s 接收队列 Top 20" % (protocol, state),
                    show=False,
                )

        for protocol, states in top_count_tasks.items():
            for state, pids in states.items():
                if not pids:
                    continue
                headers = ["进程名", "PID", "Socket数"]
                data = []
                for pid, count in pids:
                    all_need_pid_info.append(pid)
                    comm = ""
                    if str(pid) in taskInfo:
                        comm = taskInfo[str(pid)].get("Name", "Unknown")
                    data.append([comm, pid, count])
                analysis_info.render_text += mem_utils.print_table(
                    headers,
                    data,
                    title="%s %s Socket数 Top 20" % (protocol, state),
                    show=False,
                )

        # # CLOSE-WAIT 异常检测
        # total_connections = sum(sock_stat_map.values())
        # close_wait_count = sock_stat_map.get("CLOSE-WAIT", 0)
        # if close_wait_count > 1000 and close_wait_count / total_connections > 0.5:
        #     analysis_info.render_text += (
        #         "\n\n⚠️ 异常警告：CLOSE-WAIT 连接数过高！\n"
        #         f"当前 CLOSE-WAIT 数量: {close_wait_count}\n"
        #         f"占总连接数比例: {(close_wait_count / total_connections) * 100:.2f}%\n"
        #         f"可能原因：服务端未正确关闭连接，导致资源泄漏。建议检查进程 '{top_task[0]}'。\n"
        #     )
        #     analysis_info.warning = {
        #         "type": "CLOSE-WAIT 泄漏",
        #         "count": close_wait_count,
        #         "reason": "服务端程序未正确关闭连接，客户端已关闭但服务端未发送 FIN，导致 sock 和内存泄漏。",
        #         "suggestion": f"建议排查进程 {top_task[0]} 的网络处理逻辑。",
        #     }

        # 根据 pid 列表，从 taskInfo 中获取对应的进程信息
        # 确保所有有socket的进程都被包含
        all_need_pid_info = list(set(all_need_pid_info))
        # 添加所有在socket_used_top中的进程
        for pid, count in socket_used_top.items():
            if pid not in all_need_pid_info:
                all_need_pid_info.append(pid)
        
        task_info = {}
        for pid in all_need_pid_info:
            if str(pid) in taskInfo:
                task_info[str(pid)] = taskInfo.get(str(pid), {"Name": "Unknown"})
                # 添加socket统计信息到task_info
                task_info[str(pid)]["socket_count"] = socket_used_top.get(pid, 0)
                task_info[str(pid)]["leak_socket_count"] = leak_socket_used_top.get(pid, 0)
        
        # 结构化结果
        analysis_info.result = {
            "protocol_state_map": protocol_state_map,
            "top_send_tasks": top_send_tasks,
            "top_recv_tasks": top_recv_tasks,
            "top_leak_socket_used": top_leak_socket_used,
            "top_count_tasks": top_count_tasks,
            "task_info": task_info,
            "namespace_sockstats": namespaceSockstat,
            "process_socket_top": top_socket_used,  # 添加: 进程socket使用排行
        }
        return analysis_info
