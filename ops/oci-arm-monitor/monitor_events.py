"""Report changes supported by observed snapshots through the existing queue."""
import json
import os
import sqlite3
import stat
import uuid
from contextlib import closing
from pathlib import Path

BACKLOG_THRESHOLD = 10
# Keep retries bounded so recovering a large backlog does not monopolize a run.
DELIVERY_BATCH = 32
QUOTA_FIELDS = {
    "ad_available_ocpus": "AD CPU", "ad_available_memory_gb": "AD RAM",
    "regional_available_ocpus": "리전 CPU", "regional_available_memory_gb": "리전 RAM",
    "available_ocpus": "CPU 확보량", "available_memory_gb": "RAM 확보량",
}


def changes(previous, current):
    if not previous:
        return
    before_arm, arm = previous.get("arm", {}), current["arm"]
    before_p, provision = previous.get("provisioning", {}), current["provisioning"]
    before_m, monitor = previous.get("monitor", {}), current["monitor"]
    quota_changes = [
        f"{label}: {before_arm[field]} → {arm[field]}"
        for field, label in QUOTA_FIELDS.items()
        if before_arm.get(field) is not None and arm.get(field) is not None and before_arm[field] != arm[field]
    ]
    if quota_changes:
        yield "QUOTA_CHANGED", "정보", "CPU/RAM 할당량 변경", "\n".join(quota_changes)
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



def event_store_path(snapshot_path):
    return Path(snapshot_path).with_suffix(".events.db")


def open_store(path, *, create):
    flags = os.O_NOFOLLOW | os.O_NONBLOCK | (os.O_CREAT | os.O_RDWR if create else os.O_RDONLY)
    fd = os.open(path, flags, 0o600)
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise ValueError("Invalid snapshot event store")
    finally:
        os.close(fd)
    return sqlite3.connect(Path(path).absolute().as_uri() + "?mode=rw", uri=True, timeout=1)


def capture_events(snapshot_path, initial, current):
    """Atomically reserve event keys and advance the observed baseline."""
    fields = {
        "arm": (*QUOTA_FIELDS, "shape_available", "meets_target", "free_eligibility_verified"),
        "provisioning": ("status",),
        "monitor": ("last_check_failed",),
        "notification": ("pending_count",),
    }
    payload = json.dumps({
        section: {field: current[section].get(field) for field in names}
        for section, names in fields.items()
    }, separators=(",", ":"))
    with closing(open_store(event_store_path(snapshot_path), create=True)) as db, db:
        db.execute("BEGIN IMMEDIATE")
        db.execute("CREATE TABLE IF NOT EXISTS baseline (id INTEGER PRIMARY KEY CHECK (id = 1), snapshot TEXT NOT NULL)")
        db.execute("""CREATE TABLE IF NOT EXISTS pending (
            id INTEGER PRIMARY KEY, event_key TEXT NOT NULL UNIQUE, message TEXT NOT NULL
        )""")
        baseline = db.execute("SELECT snapshot FROM baseline WHERE id = 1").fetchone()
        previous = json.loads(baseline[0]) if baseline else initial
        if baseline and baseline[0] == payload:
            return
        for code, priority, title, body in changes(previous, current):
            if code in ("UNKNOWN_RESULT", "FREE_REVIEW"):
                # The operational orchestrator already owns these event keys.
                continue
            db.execute("INSERT INTO pending(event_key, message) VALUES (?, ?)", (
                f"MONITOR_{code}_{uuid.uuid4().hex}", f"[{priority}] {title}\n{body}",
            ))
        db.execute("INSERT OR REPLACE INTO baseline(id, snapshot) VALUES (1, ?)", (payload,))


def deliver_events(snapshot_path, enqueue):
    """Acknowledge only committed queue inserts or duplicates of the same key."""
    try:
        db = open_store(event_store_path(snapshot_path), create=False)
    except FileNotFoundError:
        return
    with closing(db):
        rows = db.execute(
            "SELECT event_key, message FROM pending ORDER BY id LIMIT ?", (DELIVERY_BATCH,)
        ).fetchall()
        acknowledged = []
        try:
            for key, message in rows:
                enqueue(key, message)
                acknowledged.append((key,))
        finally:
            if acknowledged:
                # Never hold the journal's write lock during the external SQLite enqueue.
                # A concurrent retry may replay a key. The notification queue deduplicates it.
                with db:
                    db.executemany("DELETE FROM pending WHERE event_key = ?", acknowledged)
