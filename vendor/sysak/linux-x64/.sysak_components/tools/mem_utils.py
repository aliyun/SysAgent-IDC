#!/usr/bin/env python3
# -*- coding: utf-8 -*-
import logging
import os
import sys
import subprocess
import unicodedata
import json
from threading import Timer
from ctypes import c_int
from ctypes import c_size_t
from ctypes import c_ulong
from ctypes import c_ubyte
from ctypes import c_void_p, c_char_p
from ctypes import c_longlong
from ctypes import CDLL
from ctypes import POINTER
from ctypes import cast
from mmap import MAP_SHARED
from mmap import PROT_READ
from mmap import PAGESIZE

logging.basicConfig(
    level=logging.INFO, format="%(asctime)s - %(name)s - %(levelname)s - %(message)s"
)
logger = logging.getLogger(__name__)
is_debug = False


jsonFormat = None

if os.geteuid() != 0:
    print("This program must be run as root. Aborting.")
    sys.exit(1)

try:
    from ctypes import c_ssize_t

    c_off_t = c_ssize_t
except ImportError:
    is_64bits = sys.maxsize > 2**32
    c_off_t = c_longlong if is_64bits else c_int

MAP_FAILED = c_ulong(-1).value
libc = CDLL(None)

_mmap = libc.mmap
_mmap.restype = c_void_p
_mmap.argtypes = c_void_p, c_size_t, c_int, c_int, c_off_t

_munmap = libc.munmap
_munmap.restype = c_void_p
_munmap.argtypes = c_void_p, c_size_t

_mincore = libc.mincore
_mincore.restypes = c_int
_mincore.argtypes = c_void_p, c_size_t, POINTER(c_ubyte)

work_path = os.getenv("SYSAK_WORK_PATH", "")

podinfo_lib = None


def set_podinfo_lib():
    global podinfo_lib
    podinfo_lib = CDLL(work_path + "/tools/libpodinfo.so")
    podinfo_lib.CGetPodInfobyIDorNameorUid.argtypes = [c_char_p]
    podinfo_lib.CGetPodInfobyIDorNameorUid.restype = c_char_p
    podinfo_lib.CGetContainersOfPod.argtypes = [c_char_p]
    podinfo_lib.CGetContainersOfPod.restype = c_char_p
    podinfo_lib.CGetContainerInfos.argtypes = []
    podinfo_lib.CGetContainerInfos.restype = c_char_p
    podinfo_lib.SetLogLevel.argtypes = [c_int]
    podinfo_lib.SetLogLevel.restype = None
    return podinfo_lib


def get_containers_of_pod(pod_name):
    """获取Pod中的容器信息

    Args:
        pod_name (str): Pod的名称/ID/UID

    Returns:
        [
            {
                "Id"              string
                "PodName"         string
                "PodId"           string
                "Pid"             int
                "Namespace"       string
                "PodCgroup"       string
                "ContainerCgroup" string
                "ContainerName"   string
                "Image"           string
                "PodIp"           string
            }
        ]
    """
    podinfo_lib.SetLogLevel(0)

    pod_name = pod_name.encode("utf-8")
    res = podinfo_lib.CGetContainersOfPod(pod_name)
    if not res:
        print("Failed to get containers info of pod %s" % pod_name)
        sys.exit(1)
    res = res.decode("utf-8")
    infos = json.loads(res)

    podinfo_lib.SetLogLevel(4)
    return infos


def get_pod_info(pod_name):
    """获取Pod的信息

    Args:
        pod_name (str): Pod的名称/ID/UID

    Returns:
        {
            "Id": "Pod ID",
            "Uid": "Pod UID",
            "Name": "Pod Name",
            "Namespace": "Pod Namespace",
            "CgroupParent": "Pod CgroupPath"
        }
    """
    podinfo_lib.SetLogLevel(0)

    pod_name = pod_name.encode("utf-8")
    res = podinfo_lib.CGetPodInfobyIDorNameorUid(pod_name)
    if not res:
        print("Failed to get pod info of %s" % pod_name)
        sys.exit(1)

    res = res.decode("utf-8")
    info = json.loads(res)

    podinfo_lib.SetLogLevel(4)
    return info


def get_container_infos():
    """获取所有容器的信息
    type ContainerInfo struct {
        Id              string
        PodName         string
        PodId           string
        Pid             int
        Namespace       string
        PodCgroup       string
        ContainerCgroup string
        ContainerName   string
        Image           string
        PodIp           string
        Labels          map[string]string
        SystemdCgroup   bool
    }
    """
    if podinfo_lib is None:
        set_podinfo_lib()
    podinfo_lib.SetLogLevel(0)
    result = podinfo_lib.CGetContainerInfos()
    container_info_dict = {}

    if not result:
        return container_info_dict

    try:
        result_str = result.decode("utf-8")
        container_info_arr = json.loads(result_str)
        container_info_dict = {
            info["ContainerCgroup"]: info for info in container_info_arr
        }
    except Exception as e:
        pass
    return container_info_dict


def get_memcg_by_pid(pid):
    """通过进程ID获取其内存cgroup路径"""
    try:
        with open(get_real_path("/proc/%s/cgroup" % pid), "r") as f:
            lines = f.readlines()
            for line in lines:
                if is_cgroup_v1():
                    if ":memory" in line:
                        return line.strip().split(":")[-1]
                else:
                    if "0::/" in line:
                        return line.strip().split(":")[-1]
    except Exception:
        pass
    return ""


def get_root_path():
    """读取环境变量 ROOT_DIR
    1. 如果环境变量存在则使用环境变量；
    2. 如果环境变量不存在默认为 /
    """
    root_dir = os.getenv("ROOT_DIR")
    if root_dir is None:
        root_dir = "/"
    return root_dir


def get_real_path(path):
    if path.startswith("/"):
        path = path[1:]
    return os.path.join(get_root_path(), path)


def is_cgroup_v1():
    """Is cgroup v1 or v2

    Returns:
        _type_: _description_
    """
    if os.path.exists(get_real_path("/sys/fs/cgroup/cgroup.controllers")):
        return False
    else:
        return True


def memory_cgroup_root():
    """Get memory root path

    Returns:
        _type_: _description_
    """
    if is_cgroup_v1():
        return get_real_path("/sys/fs/cgroup/memory")
    else:
        return get_real_path("/sys/fs/cgroup")


def is_number(s):
    """Check if a string is a number

    Args:
        s (_type_): _description_

    Returns:
        _type_: _description_
    """
    try:
        float(s)
        return True
    except ValueError:
        pass
    try:
        import unicodedata

        unicodedata.numeric(s)
        return True
    except (TypeError, ValueError):
        pass
    return False


def hugepagesz_supported(hugepagesz):
    """Check if hugepagesz is supported"""
    if int(hugepagesz) != 2 and int(hugepagesz) != 1024:
        return False
    if os.path.exists(
        get_real_path("/sys/kernel/mm/hugepages/hugepages-")
        + str(hugepagesz * 1024)
        + "kB"
    ):
        return True
    return False


def get_hugepage_used(hugesize):
    hugepath = get_real_path("/sys/kernel/mm/hugepages/hugepages-")
    hugepath += hugesize + "kB/nr_hugepages"
    fd = open(hugepath, "r")
    res = int(fd.read().strip())
    res = res * int(hugesize)
    return res


def get_vmalloc_used():
    """获取系统中的 Vmalloc 内存使用情况，单位为 KB"""
    with open(get_real_path("/proc/vmallocinfo"), "r") as f:
        lines = f.readlines()
        pages = 0
        for line in lines:
            if "vmalloc" not in line:
                continue
            if "pages=" not in line:
                continue
            res = line.strip().split("pages=")
            res = int(res[1].strip().split()[0])
            pages += res
        return pages * 4


def get_reserved_mem():
    """获取系统预留内存（Reserved Memory）大小，单位为 KB"""

    def get_dmesg_reserved_mem():
        """从 dmesg 中获取预留内存大小"""
        cmd = "dmesg | grep -w 'Memory:' | grep -w 'reserved' "
        ret = os.popen(cmd).read().strip()
        if len(ret) < 20:
            return 0
        ret = ret.strip().split("reserved")[0]
        ret = ret.strip().split()
        if len(ret) < 5:
            return 0
        res = ret[-1].strip()[:-1]
        return int(res)

    # 1. 首先尝试从 dmesg 中获取预留内存大小
    res = get_dmesg_reserved_mem()
    if res != 0:
        return res

    # 2. 如果从 dmesg 中获取失败，则尝试从 /proc/iomem 中获取
    cmd = "cat /proc/iomem | grep -wE 'Reserved|Crash kernel|Kernel code|Kernel data|Kernel bss'"
    ret = os.popen(cmd).read().split("\n")
    total = 0
    for line in ret:
        line = line.strip()
        if len(line) < 10:
            continue
        addr = line.split(":")[0].strip()
        start = addr.split("-")[0].strip()
        end = addr.split("-")[1].strip()
        size = int(end, 16) - int(start, 16)
        total += size
    return total / 1024


def format_unit(value, simple=False, is_bytes=False):
    value = int(value)

    # if is_bytes is True, then the value is in bytes
    if is_bytes:
        if value < 1024:
            return "%s B" % round(value, 2)
        value = value / 1024

    if value > 5 * 1024 * 1024:
        if simple:
            return "%s GB" % round(value / (1024 * 1024), 2)
        else:
            return "%s KB (%s GB)" % (value, round(value / (1024 * 1024), 2))
    elif value > 10 * 1024:
        if simple:
            return "%s MB" % round(value / (1024), 2)
        else:
            return "%s KB (%s MB)" % (value, round(value / (1024), 2))
    else:
        return "%s KB" % round(value, 2)


def cal_cache_size(filename):
    """使用 mincore 系统调用计算文件的缓存大小"""
    if os.path.isfile(filename) and os.access(filename, os.R_OK):
        with open(filename, "r") as f:
            size = os.fstat(f.fileno()).st_size
            if size == 0:
                return 0
            addr = _mmap(0, size, PROT_READ, MAP_SHARED, f.fileno(), 0)
            if addr == MAP_FAILED:
                return 0

            nr_pages = int((size + PAGESIZE - 1) / PAGESIZE)
            vec = (c_ubyte * nr_pages)()
            ret = _mincore(addr, size, cast(vec, POINTER(c_ubyte)))
            if ret != 0:
                _munmap(addr, size)
                return 0
            cached = list(vec).count(1)
            _munmap(addr, size)
            return cached
    else:
        return 0


def run_cmd(cmd, timeout=None):
    code, result, error = 0, "", ""
    output = ""
    if isinstance(cmd, str):
        cmd = cmd.split()

    process = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    timer = (
        Timer(timeout, lambda process: process.kill(), [process])
        if timeout is not None
        else None
    )
    try:
        if timer:
            timer.start()
        output, error = process.communicate()
        code = process.returncode
    except Exception as e:
        code = -1
        error = str(e)
    finally:
        if timer:
            timer.cancel()

    if isinstance(output, bytes):
        result = output.decode("utf-8")
    else:
        result = output

    return code, result.strip(), error


import sys
import unicodedata

# 兼容 Python 2 和 Python 3 的字符串类型判断和转换
if sys.version_info[0] < 3:

    def to_unicode(s):
        if isinstance(s, str):
            try:
                return s.decode("utf-8")
            except (UnicodeDecodeError, UnicodeEncodeError):
                # 忽略无法解码的字符，替换为 '?'
                return s.decode("utf-8", errors="replace")
        return s

else:

    def to_unicode(s):
        if isinstance(s, bytes):
            try:
                return s.decode("utf-8")
            except (UnicodeDecodeError, UnicodeEncodeError):
                # 忽略无法解码的字符，替换为 '?'
                return s.decode("utf-8", errors="replace")
        return s


def get_display_width(s):
    """计算字符串在终端输出时的宽度"""
    s = to_unicode(s)
    width = 0
    for char in s:
        if unicodedata.east_asian_width(char) in "WF":
            width += 2  # 宽字符（中文等）
        else:
            width += 1  # 窄字符（英文等）
    return width


def do_ljust(s, width):
    """左对齐字符串并填充空格"""
    s = to_unicode(s)
    # 统计有几个宽字符
    w_count = 0
    for char in s:
        if unicodedata.east_asian_width(char) in "WF":
            w_count += 1
    return s.ljust(width - w_count)


def print_title(title, box_width=50, show=True, hide_border=False):
    """打印一个居中的标题框"""
    res = ""
    if not hide_border:
        res += "-" * box_width + "\n"

    words = title.split("\n")
    rel_words = []
    for word in words:
        if get_display_width(word) > box_width - 2:
            current_line = ""
            for char in word:
                if get_display_width(current_line + char) <= box_width - 2:
                    current_line += char
                else:
                    rel_words.append(current_line)
                    current_line = char
            if current_line:
                rel_words.append(current_line)
        else:
            rel_words.append(word)

    current_line = ""
    lines = []
    for word in rel_words:
        if get_display_width(current_line + " " + word) <= box_width - 2:
            current_line += (" " + word).strip()
        else:
            lines.append(current_line)
            current_line = word
    if current_line:
        lines.append(current_line)

    for line in lines:
        total_space = box_width - 2 - get_display_width(line)
        left_space = total_space // 2
        right_space = total_space - left_space
        if hide_border:
            res += (
                " " * (left_space + 1)
                + to_unicode(line)
                + " " * (right_space + 1)
                + "\n"
            )
        else:
            res += "|" + " " * left_space + to_unicode(line) + " " * right_space + "|\n"

    if not hide_border:
        res += "-" * box_width + "\n"

    if show:
        print(res.encode("utf-8") if sys.version_info[0] < 3 else res)
    return res


def print_text(text, line_width=-1, show=True):
    """打印文本，如果 line_width 不为 -1 则限制每行的宽度"""
    res = ""
    lines = text.split("\n")
    for line in lines:
        if line_width != -1:
            current_line = ""
            for word in line.split():
                if get_display_width(current_line + " " + word) <= line_width:
                    current_line += (" " + word).strip()
                else:
                    res += current_line + "\n"
                    current_line = word
            if current_line:
                res += current_line + "\n"
        else:
            res += line + "\n"

    if show:
        print(res.encode("utf-8") if sys.version_info[0] < 3 else res)
    return res


def print_table(headers, data, title=None, max_col_lengths=None, show=True):
    """打印一个带有标题的表格，并支持列宽限制与多行显示"""

    def split_text_by_display_width(text, max_width):
        lines = []
        current_line = ""
        current_width = 0
        for char in text:
            char_width = get_display_width(char)
            if current_width + char_width > max_width:
                lines.append(current_line)
                current_line = char
                current_width = char_width
            else:
                current_line += char
                current_width += char_width
        if current_line:
            lines.append(current_line)
        return lines

    result = "" if sys.version_info[0] >= 3 else ""

    # 确保 headers 是 Unicode 字符串
    headers = [to_unicode(header) for header in headers]

    col_widths = [get_display_width(header) for header in headers]

    for i, header in enumerate(headers):
        if max_col_lengths and max_col_lengths[i] is not None:
            col_widths[i] = min(col_widths[i], max_col_lengths[i])

    for row in data:
        for i, item in enumerate(row):
            item_width = get_display_width(to_unicode(str(item)))
            if max_col_lengths and max_col_lengths[i] is not None:
                col_widths[i] = min(max(col_widths[i], item_width), max_col_lengths[i])
            else:
                col_widths[i] = max(col_widths[i], item_width)

    total_width = sum(col_widths) + 3 * (len(col_widths) - 1) + 2
    if title is not None:
        result += (
            print_title(
                title, box_width=total_width + 2, show=False, hide_border=True
            ).strip("\n")
            + "\n"
        )

    result += "+" + "-" * (total_width) + "+\n"
    header_row = " | ".join(
        do_ljust(header, col_widths[i]) for i, header in enumerate(headers)
    )
    result += "| " + header_row + " |\n"
    result += "+" + "-" * (total_width) + "+\n"

    for row in data:
        rows_to_print = []
        for i, item in enumerate(row):
            max_length = (
                max_col_lengths[i]
                if max_col_lengths and max_col_lengths[i] is not None
                else col_widths[i]
            )
            lines = split_text_by_display_width(to_unicode(str(item)), max_length)
            rows_to_print.append(lines)

        max_lines = max(len(cell) for cell in rows_to_print)
        for line_index in range(max_lines):
            result += "|"
            for i, cell_lines in enumerate(rows_to_print):
                if line_index < len(cell_lines):
                    result += (
                        " " + do_ljust(cell_lines[line_index], col_widths[i]) + " |"
                    )
                else:
                    result += " " + " " * col_widths[i] + " |"
            result += "\n"

    result += "+" + "-" * (total_width) + "+\n"

    if show:
        print(result.encode("utf-8") if sys.version_info[0] < 3 else result)

    return result


def bytes_to_hex(bytes_data):
    if sys.version_info[0] >= 3:
        # Python 3
        return bytes.fromhex(bytes_data)
    else:
        # Python 2
        return bytes_data.decode("hex")


#############################################################################
# 调试日志输出
#############################################################################


def log_exception_in_debug_mode(e):
    """在调试模式下记录异常信息"""
    if is_debug:
        logger.exception(e)


#############################################################################
# THP (Transparent HugePages) 工具函数
#############################################################################


def _parse_bracket_value(content):
    """从形如 'always [madvise] never' 的字符串中解析方括号内的当前值"""
    import re
    m = re.search(r'\[([^\]]+)\]', content)
    if m:
        return m.group(1)
    return ""


def get_thp_status():
    """读取 THP 全局配置状态

    Returns:
        dict: {
            "enabled": str,
            "defrag": str,
            "hugetext_enabled": str,
            "khugepaged": {
                "scan_sleep_millisecs": int,
                "pages_to_scan": int,
                "alloc_sleep_millisecs": int
            }
        }
    """
    result = {
        "enabled": "",
        "defrag": "",
        "hugetext_enabled": "not_supported",
        "khugepaged": {
            "scan_sleep_millisecs": 0,
            "pages_to_scan": 0,
            "alloc_sleep_millisecs": 0,
        }
    }

    # enabled
    try:
        path = get_real_path("/sys/kernel/mm/transparent_hugepage/enabled")
        with open(path, "r") as f:
            result["enabled"] = _parse_bracket_value(f.read().strip())
    except Exception:
        pass

    # defrag
    try:
        path = get_real_path("/sys/kernel/mm/transparent_hugepage/defrag")
        with open(path, "r") as f:
            result["defrag"] = _parse_bracket_value(f.read().strip())
    except Exception:
        pass

    # hugetext_enabled
    try:
        path = get_real_path("/sys/kernel/mm/transparent_hugepage/hugetext_enabled")
        with open(path, "r") as f:
            result["hugetext_enabled"] = f.read().strip()
    except Exception:
        result["hugetext_enabled"] = "not_supported"

    # khugepaged
    khugepaged_files = {
        "scan_sleep_millisecs": "/sys/kernel/mm/transparent_hugepage/khugepaged/scan_sleep_millisecs",
        "pages_to_scan": "/sys/kernel/mm/transparent_hugepage/khugepaged/pages_to_scan",
        "alloc_sleep_millisecs": "/sys/kernel/mm/transparent_hugepage/khugepaged/alloc_sleep_millisecs",
    }
    for key, fpath in khugepaged_files.items():
        try:
            path = get_real_path(fpath)
            with open(path, "r") as f:
                result["khugepaged"][key] = int(f.read().strip())
        except Exception:
            pass

    return result


def get_proc_thp_summary(pid):
    """解析 /proc/<pid>/smaps，返回该进程的 THP 聚合摘要

    Args:
        pid: 进程 ID

    Returns:
        dict or None: 正常返回 THP 摘要 dict，异常时返回 None
    """
    summary = {
        "anon_huge_pages_kb": 0,
        "shmem_huge_pages_kb": 0,
        "shmem_pmd_mapped_kb": 0,
        "file_pmd_mapped_kb": 0,
        "rss_anon_kb": 0,
    }

    # 从 smaps 读取 THP 相关字段
    try:
        smaps_path = get_real_path("/proc/%s/smaps" % pid)
        with open(smaps_path, "r") as f:
            for line in f:
                if line.startswith("AnonHugePages:"):
                    summary["anon_huge_pages_kb"] += int(line.split()[1])
                elif line.startswith("ShmemHugePages:"):
                    summary["shmem_huge_pages_kb"] += int(line.split()[1])
                elif line.startswith("ShmemPmdMapped:"):
                    summary["shmem_pmd_mapped_kb"] += int(line.split()[1])
                elif line.startswith("FilePmdMapped:"):
                    summary["file_pmd_mapped_kb"] += int(line.split()[1])
    except Exception:
        return None

    # 从 status 读取 RssAnon
    try:
        status_path = get_real_path("/proc/%s/status" % pid)
        with open(status_path, "r") as f:
            for line in f:
                if line.startswith("RssAnon:"):
                    summary["rss_anon_kb"] = int(line.split()[1])
                    break
    except Exception:
        pass

    return summary


def get_thp_top_processes(topN=30):
    """扫描所有进程，返回 THP 用量 Top N 的进程列表

    Args:
        topN: 返回前 N 个进程，默认 30

    Returns:
        list: 按 anon_huge_pages_kb 降序排序的进程列表
    """
    proc_path = get_real_path("/proc")
    results = []

    try:
        entries = os.listdir(proc_path)
    except Exception:
        return results

    for entry in entries:
        if not entry.isdigit():
            continue
        pid = int(entry)

        summary = get_proc_thp_summary(pid)
        if summary is None:
            continue
        if summary["anon_huge_pages_kb"] == 0:
            continue

        # 读取进程名
        comm = ""
        try:
            comm_path = get_real_path("/proc/%s/comm" % pid)
            with open(comm_path, "r") as f:
                comm = f.read().strip()
        except Exception:
            comm = "<unknown>"

        # 计算 thp_ratio，封顶到 1.0
        rss_anon = summary["rss_anon_kb"]
        if rss_anon > 0:
            thp_ratio = min(summary["anon_huge_pages_kb"] / float(rss_anon), 1.0)
        else:
            thp_ratio = 0.0

        results.append({
            "pid": pid,
            "comm": comm,
            "anon_huge_pages_kb": summary["anon_huge_pages_kb"],
            "shmem_huge_pages_kb": summary["shmem_huge_pages_kb"],
            "file_pmd_mapped_kb": summary["file_pmd_mapped_kb"],
            "rss_anon_kb": rss_anon,
            "thp_ratio": thp_ratio,
        })

    # 按 anon_huge_pages_kb 降序排序
    results.sort(key=lambda x: x["anon_huge_pages_kb"], reverse=True)
    return results[:topN]


def get_cgroup_thp():
    """采集根 cgroup 的 THP 统计信息

    Returns:
        dict: {
            "cgroup_version": "v1" | "v2",
            "total_rss_huge_kb": int,
            "anon_thp_kb": int,
        }
    """
    result = {}

    try:
        stat_path = os.path.join(memory_cgroup_root(), "memory.stat")
        with open(stat_path, "r") as f:
            lines = f.readlines()
    except Exception:
        return result

    if is_cgroup_v1():
        result["cgroup_version"] = "v1"
        result["total_rss_huge_kb"] = 0
        result["anon_thp_kb"] = 0
        for line in lines:
            parts = line.strip().split()
            if len(parts) >= 2 and parts[0] == "total_rss_huge":
                result["total_rss_huge_kb"] = int(parts[1]) // 1024
                break
    else:
        result["cgroup_version"] = "v2"
        result["total_rss_huge_kb"] = 0
        result["anon_thp_kb"] = 0
        for line in lines:
            parts = line.strip().split()
            if len(parts) >= 2 and parts[0] == "anon_thp":
                # v2 memory.stat 中 anon_thp 单位为字节
                result["anon_thp_kb"] = int(parts[1]) // 1024
                break

    return result


def get_thp_reclaim_status():
    """读取 Alibaba Cloud Linux 的 THP reclaim 状态

    Returns:
        dict: {
            "supported": bool,
            "mode": str,
            "queue_length": int,
            "split_hugepage": int,
            "reclaim_subpage": int,
        }
    """
    result = {
        "supported": False,
        "mode": "",
        "queue_length": 0,
        "split_hugepage": 0,
        "reclaim_subpage": 0,
    }

    # 读取 mode
    try:
        mode_path = os.path.join(memory_cgroup_root(), "memory.thp_reclaim")
        with open(mode_path, "r") as f:
            content = f.read().strip()
            result["mode"] = _parse_bracket_value(content)
            result["supported"] = True
    except Exception:
        return result

    # 读取 stat（多 NUMA 求和）
    try:
        stat_path = os.path.join(memory_cgroup_root(), "memory.thp_reclaim_stat")
        with open(stat_path, "r") as f:
            for line in f:
                parts = line.strip().split()
                if len(parts) < 2:
                    continue
                key = parts[0]
                if key == "queue_length":
                    result["queue_length"] = sum(int(v) for v in parts[1:] if v.isdigit())
                elif key == "split_hugepage":
                    result["split_hugepage"] = sum(int(v) for v in parts[1:] if v.isdigit())
                elif key == "reclaim_subpage":
                    result["reclaim_subpage"] = sum(int(v) for v in parts[1:] if v.isdigit())
    except Exception:
        pass

    return result
