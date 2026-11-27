import json
import sqlite3
import stat
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

from heartbeat import queue_report, report_key
from status_snapshot import PROVISION_STATES, atomic_json, record_oci_result, write_snapshot

NOW = datetime(2026, 11, 27, 0, tzinfo=timezone.utc)
SECRET = "private-fixture-marker"


class StatusTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.path = Path(temporary.name) / "status.json"
        self.result = self.path.with_name("oci-result.json")

    def snapshot(self, status="WAITING_ELIGIBILITY"):
        return write_snapshot(
            region="ap-chuncheon-1", path=self.path, result_path=self.result,
            policy={"target_ocpus": 2, "target_memory_gb": 12, "free_eligibility_verified": False,
                    "auto_create_enabled": False, "signing_key": SECRET},
            provisioning={"status": status, "created": status == "COMPLETED", "attempts": 0,
                          "instance_lifecycle_state": "RUNNING" if status == "COMPLETED" else None,
                          "instance_observed_at": NOW if status == "COMPLETED" else None,
                          "block_reason": "FREE_ELIGIBILITY_UNVERIFIED", "ocid": SECRET},
            notification={"pending_count": 1, "ntfy_topic": SECRET}, interval_seconds=3600,
            host_reader=lambda: {"cpu_usage_percent": 5, "ip": SECRET}, timer_reader=lambda: {},
        )

    def test_success_failure_and_public_fields(self):
        record_oci_result({"available_ocpus": 2, "available_memory_gb": 12, "shape_available": True,
                           "retry_token": SECRET}, failed=False, path=self.result, now=NOW)
        first = self.snapshot()
        with self.path.open() as old_file:
            record_oci_result(failed=True, path=self.result, now=NOW + timedelta(hours=1))
            second = self.snapshot()
            self.assertEqual(json.load(old_file), first)
        self.assertEqual(second["arm"]["available_ocpus"], 2)
        self.assertEqual(first["monitor"]["last_success_at"], second["monitor"]["last_success_at"])
        self.assertIsNotNone(second["monitor"]["last_failure_at"])
        self.assertTrue(second["monitor"]["last_check_failed"])
        self.assertNotIn(SECRET, self.path.read_text() + self.result.read_text())
        self.assertEqual(stat.S_IMODE(self.path.stat().st_mode), 0o640)

    def test_provisioning_states_and_missing_or_invalid_result(self):
        for state in PROVISION_STATES:
            with self.subTest(state=state):
                snapshot = self.snapshot(state)
                self.assertEqual(snapshot["provisioning"]["status"], state)
                self.assertEqual(snapshot["provisioning"]["created"], state == "COMPLETED")
                self.assertIsNone(snapshot["monitor"]["last_success_at"])
        self.assertEqual(self.snapshot("COMPLETED")["provisioning"]["instance_lifecycle_state"], "RUNNING")
        self.result.write_text("{")
        self.assertIsNone(self.snapshot()["monitor"]["last_success_at"])

    def test_failed_replace_preserves_previous_snapshot(self):
        old = self.snapshot()
        with patch("status_snapshot.os.replace", side_effect=OSError):
            with self.assertRaises(OSError):
                atomic_json(self.path, {})
        self.assertEqual(json.loads(self.path.read_text()), old)
        self.assertEqual(list(self.path.parent.glob(".status.json.*")), [])

    def test_slot_catchup_and_queue_uniqueness(self):
        connection = sqlite3.connect(self.path.with_name("notifications.db"))
        self.addCleanup(connection.close)
        connection.execute("CREATE TABLE reports(event_key TEXT UNIQUE, title TEXT, message TEXT)")

        def enqueue(**entry):
            connection.execute("INSERT OR IGNORE INTO reports VALUES (:event_key, :title, :message)", entry)

        record_oci_result({"available_ocpus": 2}, failed=False, path=self.result, now=NOW)
        self.snapshot()
        am = NOW
        pm = NOW + timedelta(hours=11)
        before_am = NOW + timedelta(hours=22)
        for now in (am, am, pm, before_am):
            queue_report(enqueue, path=self.path, now=now)
        rows = connection.execute("SELECT event_key, message FROM reports ORDER BY event_key").fetchall()
        self.assertEqual([key for key, _ in rows], ["HEARTBEAT_20261127_AM", "HEARTBEAT_20261127_PM"])
        self.assertEqual(report_key(before_am), report_key(pm))
        self.assertIn("최근 조회", rows[0][1])
        self.assertIn("심각한 지연", rows[1][1])
        self.assertNotIn(SECRET, str(rows))

    def test_failed_check_and_queue_error(self):
        record_oci_result(failed=True, path=self.result, now=NOW)
        self.snapshot()
        with patch("builtins.print") as output:
            def enqueue(**entry):
                self.assertIn("마지막 OCI 조회 실패", entry["message"])
                raise sqlite3.OperationalError("test")

            with self.assertRaises(sqlite3.OperationalError):
                queue_report(enqueue, path=self.path, now=NOW)
            output.assert_not_called()


if __name__ == "__main__":
    unittest.main()
