"""Build public status from monitor observations without making OCI requests."""
import fcntl
import json
import math
import os
import re
import subprocess
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path
from shutil import disk_usage

STATUS_PATH = Path("/var/lib/oci-arm-monitor/status.json")
OCI_RESULT_PATH = STATUS_PATH.with_name("oci-result.json")
TIMER_NAMES = ("oci-arm-monitor.timer", "oci-arm-retry.timer", "oci-arm-notify.timer")
PROVISION_STATES = (
    "WAITING_ELIGIBILITY", "CAPACITY_WAIT", "SUBMITTING", "UNKNOWN_RESULT",
    "PROVISIONING", "COMPLETED", "BLOCKED",
)
BLOCK_REASONS = (
    "ARM_QUOTA_UNAVAILABLE", "ARM_SHAPE_UNAVAILABLE", "FREE_ELIGIBILITY_UNVERIFIED",
    "AUTO_CREATE_DISABLED", "CAPACITY_WAIT", "UNKNOWN_RESULT", "DUPLICATE_RISK",
    "LIMIT_REACHED", "SAFETY_GATE",
)
INSTANCE_STATES = (
    "PROVISIONING", "STARTING", "RUNNING", "STOPPING", "STOPPED",
    "CREATING_IMAGE", "MOVING", "TERMINATING", "TERMINATED",
)


def utc_now():
    return datetime.now(timezone.utc)


def timestamp(value):
    if isinstance(value, str):
        try:
            value = datetime.fromisoformat(value[:-1] + "+00:00" if value.endswith("Z") else value)
        except ValueError:
            return None
    if isinstance(value, datetime) and value.utcoffset() is not None:
        return value.astimezone(timezone.utc).isoformat(timespec="milliseconds")
    return None


def number(value):
    if type(value) is int and 0 <= value <= 2**53 - 1:
        return value
    if type(value) is float and math.isfinite(value) and 0 <= value <= 2**53 - 1:
        return value
    return None


def count(value):
    return number(value) if type(value) is int else None


def flag(value):
    return value if type(value) is bool else None


def choice(value, allowed):
    return value if value in allowed else None


def read_json(path):
    try:
        with Path(path).open("rb") as source:
            data = source.read(32769)
        document = json.loads(data) if len(data) <= 32768 else None
    except (OSError, ValueError, RecursionError):
        return None
    return document if isinstance(document, dict) else None


def atomic_json(path, document, mode=0o640):
    path = Path(path)
    payload = json.dumps(document, allow_nan=False, separators=(",", ":")).encode()
    if len(payload) > 32768:
        raise ValueError("Status document exceeds 32 KiB")
    fd, temporary = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.")
    try:
        with os.fdopen(fd, "wb") as output:
            os.fchmod(output.fileno(), mode)
            output.write(payload)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
        directory_fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    finally:
        Path(temporary).unlink(missing_ok=True)


def public_quota(quota):
    quota = quota if isinstance(quota, dict) else {}
    return {
        "availability_domain": choice(quota.get("availability_domain"), ("AD-1", "AD-2", "AD-3")),
        "shape_available": flag(quota.get("shape_available")),
        **{field: number(quota.get(field)) for field in (
            "available_ocpus", "available_memory_gb", "regional_available_ocpus",
            "regional_available_memory_gb",
        )},
        "meets_target": flag(quota.get("meets_target")),
    }


def record_oci_result(quota=None, *, failed, path=OCI_RESULT_PATH, now=None):
    """Call once at the end of the existing OCI query, with its real result."""
    checked_at = timestamp(now or utc_now())
    if checked_at is None or type(failed) is not bool or (not failed and not isinstance(quota, dict)):
        raise ValueError("Invalid OCI result")
    path = Path(path)
    lock_fd = os.open(path.with_suffix(".lock"), os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(lock_fd, "rb+") as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        old = read_json(path) or {}
        last_attempt = timestamp(old.get("last_attempt_at"))
        if last_attempt and last_attempt > checked_at:
            return
        result = {
            "last_attempt_at": checked_at,
            "last_check_failed": failed,
            "last_success_at": timestamp(old.get("last_success_at")) if failed else checked_at,
            "last_failure_at": checked_at if failed else timestamp(old.get("last_failure_at")),
            "quota": public_quota((old.get("quota") or {}) if failed else quota),
        }
        atomic_json(path, result, mode=0o600)


def cpu_counters():
    with open("/proc/stat", encoding="ascii") as source:
        values = [int(value) for value in source.readline().split()[1:9]]
    return sum(values), values[3] + values[4]


def collect_host():
    total_before, idle_before = cpu_counters()
    time.sleep(0.1)
    total, idle = cpu_counters()
    delta = total - total_before
    with open("/proc/meminfo", encoding="ascii") as source:
        memory = {line.split(":")[0]: int(line.split()[1]) * 1024 for line in source}
    used_disk = disk_usage("/")
    with open("/proc/uptime", encoding="ascii") as source:
        uptime = float(source.read().split()[0])
    return {
        "sampled_at": timestamp(utc_now()),
        "cpu_usage_percent": round(100 * (delta - (idle - idle_before)) / delta, 2) if delta > 0 else None,
        "load_average": list(os.getloadavg()),
        "memory_total_bytes": memory.get("MemTotal"),
        "memory_available_bytes": memory.get("MemAvailable"),
        "swap_used_bytes": memory["SwapTotal"] - memory["SwapFree"],
        "disk_used_percent": round(100 * used_disk.used / used_disk.total, 2),
        "uptime_seconds": uptime,
    }


def collect_timers():
    timers = {}
    for name in TIMER_NAMES:
        props = {}
        try:
            result = subprocess.run(
                ["systemctl", "show", "-p", "ActiveState", "-p", "NextElapseUSecRealtime", name],
                check=True, timeout=3, capture_output=True, text=True,
                env={**os.environ, "TZ": "UTC", "LC_ALL": "C"},
            )
            props = dict(line.split("=", 1) for line in result.stdout.splitlines() if "=" in line)
            next_at = props.get("NextElapseUSecRealtime", "")
            date = datetime.strptime(next_at, "%a %Y-%m-%d %H:%M:%S UTC").replace(tzinfo=timezone.utc)
            next_run_at = timestamp(date)
        except (OSError, ValueError, subprocess.SubprocessError):
            next_run_at = None
        timers[name] = {
            "state": choice(props.get("ActiveState"), ("active", "inactive", "failed", "activating", "deactivating")),
            "next_run_at": next_run_at,
        }
    return timers


def write_snapshot(*, region, policy, provisioning, notification, interval_seconds,
                   path=STATUS_PATH, result_path=OCI_RESULT_PATH,
                   host_reader=collect_host, timer_reader=collect_timers):
    """Use normalized inputs from the calling monitor, never raw operational JSON."""
    if not isinstance(region, str) or not re.fullmatch(r"[a-z]{2}(?:-[a-z]+)+-\d+", region):
        raise ValueError("Invalid region")
    result = read_json(result_path) or {}
    quota = public_quota(result.get("quota") or {})
    timers = timer_reader()
    host = host_reader()
    load = host.get("load_average") or ()
    status = {
        "schema_version": 1,
        "region": region,
        "arm": {
            **quota,
            "target_ocpus": number(policy.get("target_ocpus")),
            "target_memory_gb": number(policy.get("target_memory_gb")),
            "free_eligibility_verified": flag(policy.get("free_eligibility_verified")),
        },
        "provisioning": {
            "status": choice(provisioning.get("status"), PROVISION_STATES),
            "created": flag(provisioning.get("created")),
            "attempts": count(provisioning.get("attempts")),
            "auto_create_enabled": flag(policy.get("auto_create_enabled")),
            "block_reason": choice(provisioning.get("block_reason"), BLOCK_REASONS),
            "last_attempt_at": timestamp(provisioning.get("last_attempt_at")),
            "completed_at": timestamp(provisioning.get("completed_at")),
            "instance_lifecycle_state": choice(provisioning.get("instance_lifecycle_state"), INSTANCE_STATES),
            "instance_observed_at": timestamp(provisioning.get("instance_observed_at")),
        },
        "monitor": {
            "last_success_at": timestamp(result.get("last_success_at")),
            "last_failure_at": timestamp(result.get("last_failure_at")),
            "last_check_failed": flag(result.get("last_check_failed")),
            "interval_seconds": count(interval_seconds),
            "next_run_at": timestamp(timers.get(TIMER_NAMES[0], {}).get("next_run_at")),
            "timers": {name: {
                "state": choice(timers.get(name, {}).get("state"), ("active", "inactive", "failed", "activating", "deactivating")),
                "next_run_at": timestamp(timers.get(name, {}).get("next_run_at")),
            } for name in TIMER_NAMES},
        },
        "notification": {
            "pending_count": count(notification.get("pending_count")),
            "last_success_at": timestamp(notification.get("last_success_at")),
        },
        "host": {
            "sampled_at": timestamp(host.get("sampled_at")),
            "load_average": [number(value) for value in load[:3]],
            **{field: number(host.get(field)) for field in (
                "cpu_usage_percent", "memory_total_bytes", "memory_available_bytes",
                "swap_used_bytes", "disk_used_percent", "uptime_seconds",
            )},
        },
    }
    atomic_json(path, status)
    return status
