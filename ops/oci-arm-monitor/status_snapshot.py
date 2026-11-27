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
            "available_ocpus", "available_memory_gb", "ad_available_ocpus", "ad_available_memory_gb", "regional_available_ocpus",
            "regional_available_memory_gb",
        )},
        "meets_target": flag(quota.get("meets_target")),
    }


def record_oci_result(quota=None, *, failed, path=OCI_RESULT_PATH, now=None, unless_checked_since=None):
    """Call once at the end of the existing OCI query, with its real result."""
    checked_at = timestamp(now or utc_now())
    if checked_at is None or type(failed) is not bool or (not failed and not isinstance(quota, dict)):
        raise ValueError("Invalid OCI result")
    since = timestamp(unless_checked_since)
    if unless_checked_since is not None and (since is None or not failed):
        raise ValueError("Invalid timeout start time")
    path = Path(path)
    lock_fd = os.open(path.with_suffix(".lock"), os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(lock_fd, "rb+") as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        old = read_json(path) or {}
        last_attempt = timestamp(old.get("last_attempt_at"))
        if last_attempt and (last_attempt > checked_at or (since and last_attempt >= since)):
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


def timer_schedule(realtime, monotonic, *, wall, running_clock, waking=False):
    candidates = []
    if realtime > wall:
        candidates.append((realtime, "calendar"))
    if not waking and monotonic > running_clock:
        candidates.append((wall + monotonic - running_clock, "monotonic_estimate"))
    if not candidates:
        return None, None
    seconds, source = min(candidates)
    return timestamp(datetime.fromtimestamp(seconds, timezone.utc)), source


def timer_property(name, property_name, signature):
    escaped = "".join(char if char.isalnum() else f"_{ord(char):02x}" for char in name)
    result = subprocess.run(
        ["busctl", "--system", "get-property", "org.freedesktop.systemd1",
         f"/org/freedesktop/systemd1/unit/{escaped}", "org.freedesktop.systemd1.Timer", property_name],
        check=True, timeout=1, capture_output=True, text=True,
    )
    kind, value = result.stdout.strip().split()
    if kind != signature:
        raise ValueError("Unexpected systemd timer property type")
    return value


def collect_timers():
    timers = {}
    for name in TIMER_NAMES:
        state = next_run = source = None
        try:
            result = subprocess.run(
                ["systemctl", "show", "-p", "ActiveState", "--value", name],
                check=True, timeout=1, capture_output=True, text=True,
            )
            state = result.stdout.strip()
            if state in ("active", "activating"):
                real = int(timer_property(name, "NextElapseUSecRealtime", "t")) / 1_000_000
                mono = int(timer_property(name, "NextElapseUSecMonotonic", "t")) / 1_000_000
                waking = mono > 0 and timer_property(name, "WakeSystem", "b") == "true"
                next_run, source = timer_schedule(
                    real, mono, wall=time.time(), running_clock=time.monotonic(), waking=waking,
                )
        except (OSError, ValueError, OverflowError, subprocess.SubprocessError):
            pass
        timers[name] = {"state": state, "next_run_at": next_run, "next_run_source": source}
    return timers


def build_snapshot(*, region, policy, provisioning, notification, interval_seconds,
                   result_path=OCI_RESULT_PATH, host_reader=collect_host, timer_reader=collect_timers):
    """Use normalized inputs from the calling monitor, never raw operational JSON."""
    if not isinstance(region, str) or not re.fullmatch(r"[a-z]{2}(?:-[a-z]+)+-\d+", region):
        region = None
    result = read_json(result_path) or {}
    quota = public_quota(result.get("quota") or {})
    timers = timer_reader()
    host = host_reader()
    block_reason = provisioning.get("block_reason")
    if "block_reason" not in provisioning:
        block_reason = operational_block_reason(provisioning.get("status"), policy, quota)
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
            "block_reason": choice(block_reason, BLOCK_REASONS),
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
            "next_run_source": choice(timers.get(TIMER_NAMES[0], {}).get("next_run_source"), ("calendar", "monotonic_estimate")),
            "timers": {name: {
                "state": choice(timers.get(name, {}).get("state"), ("active", "inactive", "failed", "activating", "deactivating")),
                "next_run_at": timestamp(timers.get(name, {}).get("next_run_at")),
                "next_run_source": choice(timers.get(name, {}).get("next_run_source"), ("calendar", "monotonic_estimate")),
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
    return status


def write_snapshot(*, path=STATUS_PATH, **inputs):
    status = build_snapshot(**inputs)
    atomic_json(path, status)
    return status


def normalize_operational_quota(state, policy):
    ad_cpu, regional_cpu = (number(state.get(field)) for field in ("ad_cpu", "region_cpu"))
    ad_ram, regional_ram = (number(state.get(field)) for field in ("ad_ram", "region_ram"))
    cpu = min(ad_cpu, regional_cpu) if ad_cpu is not None and regional_cpu is not None else None
    ram = min(ad_ram, regional_ram) if ad_ram is not None and regional_ram is not None else None
    shape = state.get("arm_shape")
    available = False if shape == "WAIT_ARM_SHAPE" else flag(shape)
    target_cpu = number(policy.get("target_ocpus"))
    target_ram = number(policy.get("target_memory_gb"))
    meets_target = None
    if None not in (cpu, ram, target_cpu, target_ram) and target_cpu > 0 and target_ram > 0:
        meets_target = cpu >= target_cpu and ram >= target_ram
    return {
        "availability_domain": choice(state.get("availability_domain"), ("AD-1", "AD-2", "AD-3")),
        "ad_available_ocpus": ad_cpu,
        "ad_available_memory_gb": ad_ram,
        "available_ocpus": cpu,
        "available_memory_gb": ram,
        "regional_available_ocpus": regional_cpu,
        "regional_available_memory_gb": regional_ram,
        "shape_available": available,
        "meets_target": meets_target,
    }


def record_operational_oci_result(state=None, *, failed, root, path=OCI_RESULT_PATH, now=None):
    """Record the result of an existing OCI query at its success or failure boundary."""
    if failed is not False:
        return record_oci_result(failed=failed, path=path, now=now)
    if not isinstance(state, dict):
        raise ValueError("Successful OCI result requires query data")
    policy = read_json(Path(root) / "policy.json") or {}
    quota = normalize_operational_quota(state, policy)
    if quota["available_ocpus"] is None or quota["available_memory_gb"] is None:
        raise ValueError("Successful OCI result requires AD and regional quotas")
    record_oci_result(quota, failed=False, path=path, now=now)


def operational_block_reason(status, policy, quota):
    if status not in PROVISION_STATES or status == "COMPLETED":
        return None
    if status in ("CAPACITY_WAIT", "UNKNOWN_RESULT"):
        return status
    if policy.get("free_eligibility_verified") is False:
        return "FREE_ELIGIBILITY_UNVERIFIED"
    if policy.get("auto_create_enabled") is False:
        return "AUTO_CREATE_DISABLED"
    if quota["shape_available"] is False:
        return "ARM_SHAPE_UNAVAILABLE"
    if quota["meets_target"] is False:
        return "ARM_QUOTA_UNAVAILABLE"
    return "SAFETY_GATE" if status == "BLOCKED" else None


def write_operational_snapshot(root, *, notification, interval_seconds, observation=None,
                               path=STATUS_PATH, result_path=OCI_RESULT_PATH,
                               host_reader=collect_host, timer_reader=collect_timers):
    """Read production files without writing them or treating their contents as a new query."""
    root = Path(root)
    state = read_json(root / "state.json") or {}
    provision = read_json(root / "provision_state.json") or {}
    policy = read_json(root / "policy.json") or {}
    region = policy.get("region")
    if region is None:
        region = state.get("region")
    if state.get("region") is not None and state["region"] != region:
        region = None

    auto_create = (flag(policy.get("auto_create_enabled")), flag(provision.get("auto_create_enabled")))
    public_policy = {
        "target_ocpus": number(policy.get("target_ocpus")),
        "target_memory_gb": number(policy.get("target_memory_gb")),
        "free_eligibility_verified": flag(policy.get("free_eligibility_verified")),
        "auto_create_enabled": False if False in auto_create else True if auto_create == (True, True) else None,
    }
    status = choice(provision.get("status"), PROVISION_STATES)
    instance_id = provision.get("instance_id")
    has_instance = isinstance(instance_id, str) and bool(instance_id.strip())
    created = None
    if status == "COMPLETED" and has_instance:
        created = True
    elif status and status != "COMPLETED":
        created = False
    observation = observation if isinstance(observation, dict) else {}
    observed_at = timestamp(observation.get("observed_at"))
    lifecycle = choice(observation.get("lifecycle_state"), INSTANCE_STATES)
    observed = has_instance and observation.get("instance_id") == instance_id and observed_at and lifecycle
    public_provision = {
        "status": status,
        "created": created,
        "attempts": count(provision.get("attempt_count")),
        "last_attempt_at": timestamp(provision.get("last_attempt_at")),
        "completed_at": timestamp(provision.get("completed_at")),
        "instance_lifecycle_state": lifecycle if observed else None,
        "instance_observed_at": observed_at if observed else None,
    }
    try:
        snapshot = build_snapshot(
            region=region, policy=public_policy, provisioning=public_provision,
            notification=notification, interval_seconds=interval_seconds,
            result_path=result_path, host_reader=host_reader, timer_reader=timer_reader,
        )
        try:
            from monitor_events import capture_events

            capture_events(path, read_json(path), snapshot)
        except Exception:
            print("STATUS: Could not persist snapshot events", flush=True)
        atomic_json(path, snapshot)
        return snapshot
    finally:
        retry_snapshot_events(root, path=path)


def retry_snapshot_events(root, *, path=STATUS_PATH):
    try:
        from monitor_events import deliver_events

        def enqueue_event(key, message):
            from notification_queue import enqueue

            enqueue(key, message, root=root)

        deliver_events(path, enqueue_event)
    except Exception:
        print("STATUS: Snapshot events remain pending", flush=True)


def read_notification_status(root):
    """Read the production queue's metadata without loading messages or modifying the DB."""
    import sqlite3
    from contextlib import closing

    uri = (Path(root) / "notifications.db").resolve().as_uri() + "?mode=ro"
    try:
        with closing(sqlite3.connect(uri, uri=True, timeout=1)) as db:
            pending, last_sent = db.execute("""
                SELECT
                    (SELECT COUNT(*) FROM notifications WHERE status = 'PENDING'),
                    (SELECT sent_at FROM notifications
                        WHERE status = 'SENT' AND julianday(sent_at) IS NOT NULL
                        ORDER BY julianday(sent_at) DESC LIMIT 1)
            """).fetchone()
    except sqlite3.Error:
        return {}
    return {"pending_count": pending, "last_success_at": timestamp(last_sent)}
