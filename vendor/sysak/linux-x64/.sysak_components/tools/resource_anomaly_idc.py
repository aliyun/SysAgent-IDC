import errno
import json
import os
import stat as stat_module
import sys
import time

from fdleak_metrics import process_limit_usage

ROOT_SECONDS = 1.5
ROOT_ENTRIES = 20000
ROOT_DEPTH = 4
ROOT_TOP = 10
FD_SECONDS = 1.5
MAX_PIDS = 4096
MAX_FDS = 8192


def _failure(exc):
    if getattr(exc, "errno", None) in (errno.EACCES, errno.EPERM):
        return "permission_denied"
    if getattr(exc, "errno", None) in (errno.ENOENT, errno.ENOTDIR):
        return "unavailable"
    return "error"


def _integer(text):
    text = text.strip()
    if not text or text.strip("0123456789") or len(text) > 20:
        raise ValueError("invalid integer")
    value = int(text)
    if value > 2 ** 64 - 1:
        raise ValueError("integer out of range")
    return value


def _read(path, limit, opener):
    with opener(path, "rb") as stream:
        data = stream.read(limit + 1)
    if len(data) > limit:
        raise ValueError("oversized proc field")
    return data.decode("utf-8", "replace")


def collect_root(root="/", statvfs=os.statvfs, stat=os.stat,
                 scandir=os.scandir, clock=time.monotonic,
                 open_dir=os.open, close_dir=os.close):
    scan = {"complete": True, "visited_entries": 0,
            "limit_entries": ROOT_ENTRIES, "max_depth": ROOT_DEPTH,
            "permission_denied": 0}
    result = {"status": "ok", "total_bytes": None, "used_bytes": None,
              "available_bytes": None, "inode_total": None, "inode_used": None,
              "directories": [], "scan": scan}
    reasons = set()

    def incomplete(reason):
        scan["complete"] = False
        reasons.add(reason)

    try:
        fs = statvfs(root)
        result.update(total_bytes=fs.f_blocks * fs.f_frsize,
                      used_bytes=(fs.f_blocks - fs.f_bfree) * fs.f_frsize,
                      available_bytes=fs.f_bavail * fs.f_frsize,
                      inode_total=fs.f_files,
                      inode_used=fs.f_files - fs.f_ffree)
    except OSError as exc:
        result["status"] = _failure(exc)
        incomplete("statvfs_" + result["status"])

    deadline = clock() + ROOT_SECONDS
    seen = set()
    sizes = {}
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC

    def budget():
        if clock() >= deadline:
            incomplete("deadline")
            return False
        if scan["visited_entries"] >= ROOT_ENTRIES:
            incomplete("entry_limit")
            return False
        return True

    def walk(directory_fd, depth, group, device):
        with scandir(directory_fd) as entries:
            iterator = iter(entries)
            while budget():
                try:
                    entry = next(iterator)
                except StopIteration:
                    break
                scan["visited_entries"] += 1
                if depth == 0 and entry.name in ("proc", "sys", "dev"):
                    incomplete("excluded_paths")
                    continue
                try:
                    info = stat(entry.name, dir_fd=directory_fd, follow_symlinks=False)
                    if stat_module.S_ISLNK(info.st_mode):
                        continue
                    if info.st_dev != device:
                        incomplete("cross_device")
                        continue
                    key = (info.st_dev, info.st_ino)
                    if key in seen:
                        continue
                    seen.add(key)
                    is_dir = stat_module.S_ISDIR(info.st_mode)
                    current = entry.name if depth == 0 and is_dir else group
                    if current is not None:
                        sizes[current] = sizes.get(current, 0) + info.st_blocks * 512
                    if not is_dir:
                        continue
                    if depth + 1 >= ROOT_DEPTH:
                        incomplete("max_depth")
                        continue
                    if not budget():
                        break
                    child_fd = open_dir(entry.name, flags, dir_fd=directory_fd)
                    try:
                        opened = stat(child_fd)
                        if (opened.st_dev, opened.st_ino) != key:
                            incomplete("changed_directory")
                            continue
                        walk(child_fd, depth + 1, current, device)
                    finally:
                        close_dir(child_fd)
                except OSError as exc:
                    reason = _failure(exc)
                    if reason == "permission_denied":
                        scan["permission_denied"] += 1
                    incomplete(reason)

    try:
        root_fd = open_dir(root, flags)
        try:
            root_info = stat(root_fd)
            seen.add((root_info.st_dev, root_info.st_ino))
            walk(root_fd, 0, None, root_info.st_dev)
        finally:
            close_dir(root_fd)
    except OSError as exc:
        reason = _failure(exc)
        if reason == "permission_denied":
            scan["permission_denied"] += 1
        incomplete(reason)
        if result["total_bytes"] is None:
            result["status"] = reason
    ranked = sorted(sizes.items(), key=lambda item: (-item[1], item[0]))
    result["directories"] = [{"path": os.path.join(root, name),
                               "allocated_bytes": size}
                              for name, size in ranked[:ROOT_TOP]]
    if len(ranked) > ROOT_TOP:
        incomplete("top10_omitted")
    if not scan["complete"]:
        scan["reason"] = ";".join(sorted(reasons))
        if result["status"] == "ok":
            result["status"] = "partial"
    return result


def collect_fd(proc_root="/proc", opener=open, scandir=os.scandir,
               clock=time.monotonic):
    coverage = {"complete": True, "observed_processes": 0,
                "denied_processes": 0, "truncated": False}
    result = {"status": "ok", "allocated": None, "unused": None,
              "file_max": None, "nr_open": None, "processes": [], "coverage": coverage}
    reasons, failures = set(), []
    deadline = clock() + FD_SECONDS

    def incomplete(reason, truncated=False):
        coverage["complete"] = False
        coverage["truncated"] |= truncated
        reasons.add(reason)

    def remaining():
        if clock() >= deadline:
            incomplete("deadline", True)
            return False
        return True

    for filename in ("file-nr", "file-max", "nr_open"):
        if not remaining():
            break
        try:
            text = _read(os.path.join(proc_root, "sys/fs", filename), 128, opener)
            if filename == "file-nr":
                fields = text.split()
                if len(fields) != 3:
                    raise ValueError("invalid file-nr")
                allocated, unused, _ = [_integer(field) for field in fields]
                if unused > allocated:
                    raise ValueError("invalid unused count")
                # Preserve IDC's allocated == actually used file handles contract.
                result.update(allocated=allocated - unused, unused=unused)
            else:
                value = _integer(text)
                if value <= 0:
                    raise ValueError("invalid file limit")
                result[filename.replace("-", "_")] = value
        except (OSError, ValueError) as exc:
            failure = _failure(exc)
            failures.append(failure)
            incomplete(filename + "_" + failure)

    def scan_processes():
        with scandir(proc_root) as entries:
            iterator = iter(entries)
            visited = 0
            # Also bound non-PID proc entries in a malformed/injected procfs.
            while remaining():
                if visited >= ROOT_ENTRIES:
                    incomplete("proc_entry_limit", True)
                    break
                try:
                    entry = next(iterator)
                except StopIteration:
                    break
                visited += 1
                if not entry.name or entry.name.strip("0123456789"):
                    continue
                if coverage["observed_processes"] >= MAX_PIDS:
                    incomplete("pid_limit", True)
                    break
                coverage["observed_processes"] += 1
                if len(entry.name) > 10 or not 0 < int(entry.name) <= 2 ** 31 - 1:
                    incomplete("invalid_pid")
                    continue
                path = os.path.join(proc_root, entry.name)
                proc = {"pid": int(entry.name), "name": None, "status": "ok",
                        "fd_count": None, "fd_count_lower_bound": None,
                        "fd_count_exact": False, "soft_limit": None, "hard_limit": None,
                        "soft_unlimited": False, "hard_unlimited": False, "usage_pct": None}
                proc_reasons, proc_failures = set(), set()

                def proc_incomplete(reason, failure=None, truncated=False):
                    proc_reasons.add(reason)
                    if failure is not None:
                        proc_failures.add(failure)
                        failures.append(failure)
                    incomplete(reason, truncated)

                for field in ("comm", "limits", "fd"):
                    if not remaining():
                        proc_incomplete("deadline", truncated=True)
                        break
                    try:
                        if field == "comm":
                            proc["name"] = _read(os.path.join(path, field), 256, opener).strip() or None
                            if proc["name"] is None:
                                proc_incomplete("missing_comm")
                        elif field == "limits":
                            # Read bounded lines only through Max open files.
                            found = False
                            with opener(os.path.join(path, field), "rb") as stream:
                                consumed = 0
                                while remaining() and consumed < 16384:
                                    line = stream.readline(min(1024, 16384 - consumed) + 1)
                                    if not line:
                                        break
                                    consumed += len(line)
                                    if consumed > 16384 or len(line) > 1024:
                                        raise ValueError("oversized limits")
                                    if line.startswith(b"Max open files"):
                                        parts = line.decode("ascii").split()
                                        if len(parts) != 6 or parts[:3] != ["Max", "open", "files"] or parts[5] != "files":
                                            raise ValueError("invalid open files limit")
                                        soft_unlimited = parts[3] == "unlimited"
                                        hard_unlimited = parts[4] == "unlimited"
                                        soft = None if soft_unlimited else _integer(parts[3])
                                        hard = None if hard_unlimited else _integer(parts[4])
                                        if (not hard_unlimited and (soft_unlimited or soft > hard)):
                                            raise ValueError("invalid hard limit")
                                        proc.update(soft_limit=soft, hard_limit=hard,
                                                    soft_unlimited=soft_unlimited,
                                                    hard_unlimited=hard_unlimited)
                                        found = True
                                        break
                            if not remaining():
                                proc_incomplete("deadline", truncated=True)
                            elif not found:
                                proc_incomplete("missing_open_files_limit")
                            elif proc["soft_limit"] is None or proc["soft_limit"] <= 0:
                                # Accurate FD count is still not a finite pressure ratio.
                                proc_incomplete("missing_or_unlimited_soft_limit")
                        else:
                            count = 0
                            with scandir(os.path.join(path, field)) as fds:
                                proc["fd_count_lower_bound"] = 0
                                fd_iterator = iter(fds)
                                while remaining():
                                    try:
                                        fd_entry = next(fd_iterator)
                                    except StopIteration:
                                        proc["fd_count"] = count
                                        proc["fd_count_exact"] = True
                                        break
                                    if not fd_entry.name or fd_entry.name.strip("0123456789"):
                                        raise ValueError("invalid fd entry")
                                    count += 1
                                    proc["fd_count_lower_bound"] = count
                                    # One extra entry distinguishes an exact boundary
                                    # from truncation; never inspect FD targets.
                                    if count > MAX_FDS:
                                        proc_incomplete("fd_limit", truncated=True)
                                        break
                            # A lower bound is not an exact count; do not label it normal.
                            if not proc["fd_count_exact"] and "fd_limit" not in proc_reasons:
                                proc_incomplete("deadline", truncated=True)
                    except (OSError, ValueError, UnicodeError) as exc:
                        failure = _failure(exc)
                        proc_incomplete(field + "_" + failure, failure)
                if "permission_denied" in proc_failures:
                    coverage["denied_processes"] += 1
                if proc_reasons:
                    proc["reason"] = ";".join(sorted(proc_reasons))
                    proc["status"] = ("permission_denied" if "permission_denied" in proc_failures else
                                      "error" if "error" in proc_failures else
                                      "unavailable" if "unavailable" in proc_failures else "partial")
                proc["usage_pct"] = process_limit_usage(
                    proc["fd_count"], proc["soft_limit"], not proc_reasons)
                result["processes"].append(proc)

    try:
        if remaining():
            scan_processes()
    except OSError as exc:
        failure = _failure(exc)
        failures.append(failure)
        incomplete("procfs_" + failure)
    result["processes"].sort(key=lambda proc: proc["pid"])
    if not coverage["complete"]:
        coverage["reason"] = ";".join(sorted(reasons))
        has_data = any(result[key] is not None for key in ("allocated", "file_max", "nr_open")) or any(
            proc["fd_count_lower_bound"] is not None for proc in result["processes"])
        result["status"] = "partial" if has_data else (
            "permission_denied" if "permission_denied" in failures else
            "error" if "error" in failures else "unavailable")
    return result


def collect_fd_usage(proc_root="/proc", opener=open, scandir=os.scandir,
                     clock=time.monotonic):
    fd = collect_fd(proc_root, opener, scandir, clock)
    used, unused = fd["allocated"], fd["unused"]
    # Shared handles make global usage different from summed process FD counts.
    return {"schema_version": "1.0", "mode": "fd_usage", "read_only": True,
            "status": fd["status"],
            "system": {"file_max": fd["file_max"], "nr_open": fd["nr_open"],
                       "allocated_file_handles": None if used is None or unused is None else used + unused,
                       "unused_file_handles": unused, "used_file_handles": used,
                       "usage_pct": process_limit_usage(used, fd["file_max"])},
            "processes": fd["processes"], "coverage": fd["coverage"]}


def main_fd_usage(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    base = ["--run", "fdleak", "--fd-usage"]
    if argv not in (base, ["-j"] + base, ["--json"] + base):
        print("safe usage: resource_anomaly [-j|--json] --run fdleak --fd-usage "
              "(no other arguments)", file=sys.stderr)
        return 2
    sys.dont_write_bytecode = True
    print(json.dumps(collect_fd_usage(), allow_nan=False))
    return 0


def collect(root="/", proc_root="/proc", opener=open, scandir=os.scandir,
            stat=os.stat, statvfs=os.statvfs, clock=time.monotonic,
            open_dir=os.open, close_dir=os.close):
    return {"schema_version": "1.0", "mode": "idc", "read_only": True,
            "root": collect_root(root, statvfs, stat, scandir, clock, open_dir, close_dir),
            "fd": collect_fd(proc_root, opener, scandir, clock)}


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    if argv != ["--idc"]:
        print("safe usage: resource_anomaly --idc (no other arguments)", file=sys.stderr)
        return 2
    sys.dont_write_bytecode = True
    print(json.dumps(collect(), allow_nan=False))
    return 0
