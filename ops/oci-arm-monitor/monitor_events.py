"""Report changes supported by observed snapshots through the existing queue."""
import hashlib
import json

BACKLOG_THRESHOLD = 10


def changes(previous, current):
    if not previous:
        return
    before_arm, arm = previous.get("arm", {}), current["arm"]
    before_p, provision = previous.get("provisioning", {}), current["provisioning"]
    before_m, monitor = previous.get("monitor", {}), current["monitor"]
    if arm["shape_available"] is not None and before_arm.get("shape_available") != arm["shape_available"]:
        yield "SHAPE_CHANGED", "정보", "ARM Shape 가용 상태 변경", "가용" if arm["shape_available"] else "사용 불가"
    if arm["meets_target"] is True and before_arm.get("meets_target") is not True:
        yield "TARGET_QUOTA", "정보", "ARM 목표 할당량 확보", "AD와 리전의 최소 할당량이 목표를 충족합니다."
    if arm["free_eligibility_verified"] is False and before_arm.get("free_eligibility_verified") is not False:
        yield "FREE_REVIEW", "주의", "무료 이용 자격 검토 필요", "자체 안전 정책에서 무료 자격 확인을 요구합니다."
    if provision["status"] != before_p.get("status"):
        if provision["status"] == "UNKNOWN_RESULT":
            yield "UNKNOWN_RESULT", "중요", "생성 결과 미확인", "기존 요청을 대조해야 합니다."
        if provision["status"] == "CAPACITY_WAIT":
            yield "CAPACITY_WAIT", "주의", "생성 상태가 수용 공간 대기로 변경", "실제 OCI 응답은 운영 기록에서 확인해야 합니다."
    if monitor["last_check_failed"] is True and before_m.get("last_check_failed") is not True:
        yield "OCI_QUERY_FAILED", "중요", "OCI 조회 실패", "마지막 성공값을 유지합니다."
    if monitor["last_check_failed"] is False and before_m.get("last_check_failed") is True:
        yield "OCI_QUERY_RECOVERED", "정보", "OCI 조회 복구", "새 할당량 조회가 성공했습니다."
    pending = current["notification"].get("pending_count")
    before_pending = previous.get("notification", {}).get("pending_count")
    if pending is not None and pending >= BACKLOG_THRESHOLD and (
        before_pending is None or before_pending < BACKLOG_THRESHOLD
    ):
        yield "NOTIFICATION_BACKLOG", "주의", "ntfy 알림 큐 적체", f"발송 대기 {pending}건"


def enqueue_changes(previous, current, enqueue):
    for code, priority, title, body in changes(previous, current):
        if code in ("UNKNOWN_RESULT", "FREE_REVIEW"):
            # These are owned by the operational orchestrator's existing event keys.
            continue
        baseline = json.dumps(previous, sort_keys=True, separators=(",", ":")).encode()
        key = hashlib.sha256(baseline + code.encode()).hexdigest()[:24]
        enqueue(f"MONITOR_{code}_{key}", f"[{priority}] {title}\n{body}")
