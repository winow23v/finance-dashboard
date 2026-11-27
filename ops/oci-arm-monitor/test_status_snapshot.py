import json
import sqlite3
import stat
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

from heartbeat import queue_report, report_key
from status_snapshot import (
    PROVISION_STATES, atomic_json, record_oci_result, record_operational_oci_result,
    write_operational_snapshot, write_snapshot,
)

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
        connection.execute("CREATE TABLE notifications(event_key TEXT UNIQUE NOT NULL, message TEXT)")

        root = self.path.parent

        def enqueue(event_key, message, root=root):
            self.assertEqual(root, self.path.parent)
            connection.execute("INSERT OR IGNORE INTO notifications VALUES (?, ?)", (event_key, message))

        record_oci_result({"available_ocpus": 2}, failed=False, path=self.result, now=NOW)
        self.snapshot()
        am = NOW
        pm = NOW + timedelta(hours=11)
        before_am = NOW + timedelta(hours=22)
        for now in (am, am, pm, before_am):
            queue_report(enqueue, path=self.path, now=now, host_reader=lambda: {})
        rows = connection.execute("SELECT event_key, message FROM notifications ORDER BY event_key").fetchall()
        self.assertEqual([key for key, _ in rows], ["HEARTBEAT_20261127_AM", "HEARTBEAT_20261127_PM"])
        self.assertEqual(report_key(before_am), report_key(pm))
        self.assertTrue(rows[0][1].startswith("OCI ARM 상태 보고\n"))
        self.assertIn("최근 조회", rows[0][1])
        self.assertIn("심각한 지연", rows[1][1])
        self.assertNotIn(SECRET, str(rows))

    def test_failed_check_and_queue_error(self):
        record_oci_result(failed=True, path=self.result, now=NOW)
        self.snapshot()
        with patch("builtins.print") as output:
            def enqueue(event_key, message, root=self.path.parent):
                self.assertIn("마지막 OCI 조회 실패", message)
                raise sqlite3.OperationalError("test")

            with self.assertRaises(sqlite3.OperationalError):
                queue_report(enqueue, path=self.path, now=NOW, host_reader=lambda: {})
            output.assert_not_called()


    def operational_files(self, *, status="WAITING_ELIGIBILITY"):
        root = self.path.parent
        state = {"region": "ap-chuncheon-1", "ad_cpu": 4, "ad_ram": 12,
                 "region_cpu": 2, "region_ram": 24, "arm_shape": "WAIT_ARM_SHAPE"}
        provision = {"status": status, "attempt_count": 0, "instance_id": SECRET,
                     "last_attempt_at": NOW.isoformat(), "completed_at": NOW.isoformat(),
                     "auto_create_enabled": False}
        policy = {"region": "ap-chuncheon-1", "target_ocpus": 2, "target_memory_gb": 12,
                  "free_eligibility_verified": False, "auto_create_enabled": True}
        for name, data in (("state", state), ("provision_state", provision), ("policy", policy)):
            (root / f"{name}.json").write_text(json.dumps(data))
        return root, state

    def operational_snapshot(self, root, observation=None):
        return write_operational_snapshot(root, notification={"pending_count": 0}, interval_seconds=3600,
                                          observation=observation, path=self.path, result_path=self.result,
                                          host_reader=lambda: {}, timer_reader=lambda: {})

    def test_correct_operational_mapping_without_modifying_input(self):
        root, state = self.operational_files()
        source = {path: path.read_bytes() for path in root.glob("*.json")}
        self.assertIsNone(self.operational_snapshot(root)["monitor"]["last_success_at"])
        record_operational_oci_result(state, failed=False, root=root, path=self.result, now=NOW)
        status = self.operational_snapshot(root)
        self.assertEqual((status["arm"]["available_ocpus"], status["arm"]["available_memory_gb"]), (2, 12))
        self.assertEqual((status["arm"]["regional_available_ocpus"], status["arm"]["regional_available_memory_gb"]), (2, 24))
        self.assertIs(status["arm"]["shape_available"], False)
        self.assertEqual(status["provisioning"]["attempts"], 0)
        self.assertIs(status["provisioning"]["auto_create_enabled"], False)
        self.assertEqual(status["provisioning"]["block_reason"], "FREE_ELIGIBILITY_UNVERIFIED")
        self.assertNotIn(SECRET, self.path.read_text())
        self.assertEqual({path: path.read_bytes() for path in source}, source)

    def test_bad_operational_data_cannot_refresh_success(self):
        root, state = self.operational_files()
        record_operational_oci_result(state, failed=False, root=root, path=self.result, now=NOW)
        later = NOW + timedelta(hours=1)
        del state["region_ram"]
        with self.assertRaises(ValueError):
            record_operational_oci_result(state, failed=False, root=root, path=self.result, now=later)
        record_operational_oci_result(failed=True, root=root, path=self.result, now=later)
        (root / "provision_state.json").write_text("{")
        snapshot = self.operational_snapshot(root)
        self.assertIsNone(snapshot["provisioning"]["status"])
        self.assertIsNone(snapshot["provisioning"]["attempts"])
        self.assertTrue(snapshot["monitor"]["last_check_failed"])
        self.assertEqual(datetime.fromisoformat(snapshot["monitor"]["last_success_at"]), NOW)
        self.assertEqual(snapshot["arm"]["available_memory_gb"], 12)

    def test_completed_requires_independent_matching_observation_for_running(self):
        root, _ = self.operational_files(status="COMPLETED")
        self.assertTrue(self.operational_snapshot(root)["provisioning"]["created"])
        observation = {"instance_id": "different", "lifecycle_state": "RUNNING", "observed_at": NOW}
        self.assertIsNone(self.operational_snapshot(root, observation)["provisioning"]["instance_lifecycle_state"])
        observation["instance_id"] = SECRET
        status = self.operational_snapshot(root, observation)["provisioning"]
        self.assertEqual(status["instance_lifecycle_state"], "RUNNING")
        self.assertNotIn(SECRET, self.path.read_text())


    def test_completed_heartbeat_rechecks_host_and_labels_past_instance_observation(self):
        root, state = self.operational_files(status="COMPLETED")
        record_operational_oci_result(state, failed=False, root=root, path=self.result, now=NOW)
        self.operational_snapshot(root, {
            "instance_id": SECRET, "lifecycle_state": "RUNNING", "observed_at": NOW,
        })
        now = NOW + timedelta(days=1)
        previous = self.path.read_bytes()

        def enqueue(event_key, message, root=root):
            self.assertEqual(event_key, "HEARTBEAT_20261128_AM")
            self.assertIn("심각한 지연", message)
            self.assertIn("인스턴스 마지막 관측: RUNNING (2026-11-27", message)
            self.assertIn("기존 VPS 수집 시각: 2026-11-28", message)
            self.assertIn("기존 VPS CPU: 42%", message)
            self.assertNotIn(SECRET, message)

        queue_report(enqueue, path=self.path, now=now, host_reader=lambda: {
            "sampled_at": now, "cpu_usage_percent": 42,
        })
        self.assertEqual(self.path.read_bytes(), previous)

    def test_host_sampling_failure_does_not_hide_missing_monitor_snapshot(self):
        def host_reader():
            raise OSError("test")

        def enqueue(event_key, message, root=self.path.parent):
            self.assertIn("스냅샷 없음 또는 손상", message)
            self.assertIn("기존 VPS 상태: 수집 실패", message)

        queue_report(enqueue, path=self.path, now=NOW, host_reader=host_reader)


if __name__ == "__main__":
    unittest.main()
