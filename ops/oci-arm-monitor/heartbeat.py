"""Queue one current status report for the most recent scheduled KST slot."""
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from status_snapshot import (
    BLOCK_REASONS, PROVISION_STATES, STATUS_PATH, choice, count, flag, number,
    read_json, timestamp, utc_now,
)

SEOUL = ZoneInfo("Asia/Seoul")


def report_key(now):
    local = now.astimezone(SEOUL)
    if local.hour < 8:
        local -= timedelta(days=1)
        slot = "PM"
    else:
        slot = "AM" if local.hour < 20 else "PM"
    return f"HEARTBEAT_{local:%Y%m%d}_{slot}"


def display(value):
    return "미확인" if value is None else str(value)


def yes_no(value):
    return {True: "예", False: "아니요", None: "미확인"}[flag(value)]


def section(snapshot, key):
    value = snapshot.get(key)
    return value if isinstance(value, dict) else {}


def build_report(snapshot, now):
    lines = [f"보고 기준: {now.astimezone(SEOUL):%Y-%m-%d %H:%M %Z}"]
    if not snapshot or snapshot.get("schema_version") != 1:
        return "\n".join(lines + ["감시 상태: 스냅샷 없음 또는 손상"])
    arm = section(snapshot, "arm")
    monitor = section(snapshot, "monitor")
    provisioning = section(snapshot, "provisioning")
    host = section(snapshot, "host")
    checked = timestamp(monitor.get("last_success_at"))
    age = (now - datetime.fromisoformat(checked)).total_seconds() if checked else None
    failed = flag(monitor.get("last_check_failed"))
    if age is None or age < 0 or failed is None:
        freshness = "조회 결과 미확인"
    elif age > 10800:
        freshness = "심각한 지연"
    elif age > 4500:
        freshness = "조회 지연"
    else:
        freshness = "최근 조회"
    if failed:
        freshness += " / 마지막 OCI 조회 실패"
    label = "할당량" if freshness == "최근 조회" else "마지막으로 저장된 할당량"
    lines += [
        f"감시 상태: {freshness}",
        f"{label}: CPU {display(number(arm.get('available_ocpus')))} OCPU, "
        f"RAM {display(number(arm.get('available_memory_gb')))} GB",
        f"ARM Shape 사용 가능: {yes_no(arm.get('shape_available'))}",
        f"신규 VPS 생성: {yes_no(provisioning.get('created'))} "
        f"({display(choice(provisioning.get('status'), PROVISION_STATES))}), "
        f"시도 {display(count(provisioning.get('attempts')))}회",
        f"자동 생성 설정: {yes_no(provisioning.get('auto_create_enabled'))}, "
        f"차단 사유: {display(choice(provisioning.get('block_reason'), BLOCK_REASONS))}",
        f"마지막 OCI 조회 성공: {display(checked)}",
        f"다음 감시 실행: {display(timestamp(monitor.get('next_run_at')))}",
        f"기존 VPS CPU: {display(number(host.get('cpu_usage_percent')))}%, "
        f"가용 RAM: {display(count(host.get('memory_available_bytes')))} bytes, "
        f"Swap 사용: {display(count(host.get('swap_used_bytes')))} bytes, "
        f"Disk 사용: {display(number(host.get('disk_used_percent')))}%",
    ]
    return "\n".join(lines)


def queue_report(enqueue, *, path=STATUS_PATH, now=None):
    now = now or utc_now()
    message = build_report(read_json(path), now)
    # The existing queue's UNIQUE event_key is the deduplication boundary.
    return enqueue(event_key=report_key(now), title="OCI ARM 상태 보고", message=message)


def main():
    try:
        from notification_queue import enqueue

        queue_report(enqueue)
    except Exception:
        raise SystemExit("OCI ARM heartbeat could not enqueue a report") from None


if __name__ == "__main__":
    main()
