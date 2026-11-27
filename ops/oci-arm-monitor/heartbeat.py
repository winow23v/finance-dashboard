"""Queue one current status report for the most recent scheduled KST slot."""
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

from status_snapshot import (
    BLOCK_REASONS, INSTANCE_STATES, PROVISION_STATES, STATUS_PATH, choice, collect_host, count, flag, number,
    read_json, retry_snapshot_events, timestamp, utc_now,
)

SEOUL = ZoneInfo("Asia/Seoul")


PROVISION_LABELS = {
    "WAITING_ELIGIBILITY": "무료 자격 확인 대기", "CAPACITY_WAIT": "수용 공간 대기",
    "SUBMITTING": "요청 제출 중", "UNKNOWN_RESULT": "결과 미확인", "PROVISIONING": "생성 중",
    "COMPLETED": "생성 완료", "BLOCKED": "생성 차단",
}
BLOCK_LABELS = {
    "ARM_QUOTA_UNAVAILABLE": "Oracle 할당량 부족", "ARM_SHAPE_UNAVAILABLE": "Oracle Shape 사용 불가",
    "FREE_ELIGIBILITY_UNVERIFIED": "무료 이용 자격 미검증 (자체 정책)",
    "AUTO_CREATE_DISABLED": "자동 생성 비활성 (자체 정책)", "CAPACITY_WAIT": "수용 공간 대기",
    "UNKNOWN_RESULT": "생성 결과 대조 필요", "DUPLICATE_RISK": "중복 생성 위험 (자체 정책)",
    "LIMIT_REACHED": "생성 한도 도달 (자체 정책)", "SAFETY_GATE": "자체 안전 정책",
}
INSTANCE_LABELS = {
    "PROVISIONING": "프로비저닝 중", "STARTING": "시작 중", "RUNNING": "실행 중",
    "STOPPING": "중지 중", "STOPPED": "중지됨", "CREATING_IMAGE": "이미지 생성 중",
    "MOVING": "이동 중", "TERMINATING": "종료 중", "TERMINATED": "종료됨",
}


def kst_time(value):
    value = timestamp(value)
    return datetime.fromisoformat(value).astimezone(SEOUL).strftime("%Y-%m-%d %H:%M:%S KST") if value else "미확인"


def memory(value):
    value = count(value)
    if value is None:
        return "미확인"
    if value >= 1024 ** 3:
        return f"{value / 1024 ** 3:.2f} GiB"
    return f"{value / 1024 ** 2:.1f} MiB"


def percentage(value):
    value = number(value)
    return f"{value}%" if value is not None else "미확인"


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


def host_report(host):
    if not host:
        return ["기존 VPS 상태: 수집 실패"]
    return [
        f"기존 VPS 수집 시각: {kst_time(host.get('sampled_at'))}",
        f"기존 VPS CPU: {percentage(host.get('cpu_usage_percent'))}",
        f"가용 RAM: {memory(host.get('memory_available_bytes'))}",
        f"Swap 사용: {memory(host.get('swap_used_bytes'))}",
        f"디스크 사용: {percentage(host.get('disk_used_percent'))}",
    ]


def build_report(snapshot, now, host):
    lines = ["[OCI ARM 정기 상태 보고]", f"보고 기준: {now.astimezone(SEOUL):%Y-%m-%d %H:%M %Z}"]
    if not snapshot or snapshot.get("schema_version") != 1:
        return "\n".join(lines + ["감시 상태: 스냅샷 없음 또는 손상", "", "③ 기존 VPS 상태"] + host_report(host))
    arm = section(snapshot, "arm")
    monitor = section(snapshot, "monitor")
    provisioning = section(snapshot, "provisioning")
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
    label = "" if freshness == "최근 조회" else " (마지막 저장값)"
    status = choice(provisioning.get("status"), PROVISION_STATES)
    block = choice(provisioning.get("block_reason"), BLOCK_REASONS)
    next_time = kst_time(monitor.get("next_run_at"))
    if monitor.get("next_run_source") == "monotonic_estimate" and next_time != "미확인":
        next_time += " (시계 환산 예상)"
    lines += [
        "", "① 신규 ARM 서버",
        f"생성 상태: {display(PROVISION_LABELS.get(status))}",
        f"CPU 확보 / 목표{label}: {display(number(arm.get('available_ocpus')))} / "
        f"{display(number(arm.get('target_ocpus')))} OCPU",
        f"RAM 확보 / 목표{label}: {display(number(arm.get('available_memory_gb')))} / "
        f"{display(number(arm.get('target_memory_gb')))} GiB",
        f"ARM Shape 가용: {yes_no(arm.get('shape_available'))}",
        "실제 물리 수용 공간: 미확인",
        f"생성 완료: {yes_no(provisioning.get('created'))}",
        f"생성 시도: {display(count(provisioning.get('attempts')))}회",
    ]
    observed_at = timestamp(provisioning.get("instance_observed_at"))
    lifecycle = choice(provisioning.get("instance_lifecycle_state"), INSTANCE_STATES)
    if lifecycle and observed_at and datetime.fromisoformat(observed_at) <= now:
        lines.append(f"인스턴스 마지막 관측: {INSTANCE_LABELS[lifecycle]} ({kst_time(observed_at)})")
    lines += [
        "", "② 무료 생성 안전장치",
        f"무료 조건 검증: {yes_no(arm.get('free_eligibility_verified'))}",
        f"자동 생성 설정: {yes_no(provisioning.get('auto_create_enabled'))}",
        f"유료 생성 허용: {yes_no(provisioning.get('paid_creation_allowed'))}",
        f"생성 차단 사유: {display(BLOCK_LABELS.get(block))}",
        "", "③ 기존 VPS 상태", *host_report(host),
        "", "④ 모니터링",
        f"감시 상태: {freshness}",
        f"마지막 OCI 조회 성공: {kst_time(checked)}",
        f"다음 감시 예정: {next_time}",
        f"현재 조치: {display(BLOCK_LABELS.get(block) or PROVISION_LABELS.get(status))}",
    ]
    return "\n".join(lines)


def queue_report(enqueue, *, path=STATUS_PATH, now=None, host_reader=collect_host):
    try:
        host = host_reader()
    except (OSError, ValueError, KeyError, IndexError):
        host = None
    now = now or utc_now()
    message = build_report(read_json(path), now, host)
    # The existing queue's UNIQUE event_key is the deduplication boundary.
    return enqueue(report_key(now), message)


def main():
    try:
        from notification_queue import enqueue

        queue_report(enqueue)
    except Exception:
        raise SystemExit("OCI ARM heartbeat could not enqueue a report") from None
    finally:
        retry_snapshot_events(Path(__file__).resolve().parent)


if __name__ == "__main__":
    main()
