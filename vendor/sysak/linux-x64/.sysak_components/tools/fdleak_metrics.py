"""Pure FD pressure metrics shared by legacy analyzers and read-only IDC."""

FD_ALERT_RATIO = 0.9
FD_ALERT_PCT = 90.0


def usage_pct(used, limit):
    if used < 0 or limit <= 0:
        return -1.0
    return round(100.0 * used / limit, 2)


def process_limit_usage(fd_count, soft_limit, complete=True):
    """Unchecked/truncated observations cannot establish normal FD pressure."""
    if not complete or fd_count is None or soft_limit is None or soft_limit <= 0:
        return None
    return usage_pct(fd_count, soft_limit)
