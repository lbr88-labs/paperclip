import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock


MODULE = Path(__file__).with_name("host-deploy-gate.py")
SPEC = importlib.util.spec_from_file_location("host_deploy_gate", MODULE)
gate = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(gate)


class GateTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        now = gate.utc_now()
        self.revision = "revision-1"
        backup = self.make_file("backup.sql.gz", b"snapshot")
        receipt_body = {"result": "passed", "backupSha256": backup["sha256"],
                        "decisionRevision": self.revision,
                        "verifiedAt": (now - gate.dt.timedelta(minutes=1)).isoformat().replace("+00:00", "Z")}
        receipt = self.make_file("restore.json", json.dumps(receipt_body).encode())
        self.manifest = {
            "version": 1, "service": "paperclipai.service", "apiBaseUrl": "http://127.0.0.1:3100",
            "decision": {"issueId": "decision-1", "documentKey": "deployment-decision", "revisionId": self.revision},
            "companyIds": ["company-1"],
            "notBefore": (now - gate.dt.timedelta(minutes=3)).isoformat().replace("+00:00", "Z"),
            "expiresAt": (now + gate.dt.timedelta(minutes=3)).isoformat().replace("+00:00", "Z"),
            "hold": {"startedAt": "2026-09-26T12:00:00.000Z", "expiresAt": (now + gate.dt.timedelta(minutes=3)).isoformat().replace("+00:00", "Z")},
            "artifact": self.make_file("artifact", b"new"), "backup": {**backup, "createdAt": (now - gate.dt.timedelta(minutes=2)).isoformat().replace("+00:00", "Z")},
            "restoreReceipt": receipt, "rollback": self.make_file("rollback", b"old"),
        }
        self.path = self.root / "decision.json"
        self.manifest["commands"] = {"replace": [sys.executable, "-c", "pass"], "restart": [sys.executable, "-c", "pass"]}
        self.write_manifest()
        self.hold = {"draining": True, **self.manifest["hold"], "activeRuns": 0, "pendingWakes": 0, "quiescent": True}
        self.rows = []

    def make_file(self, name, data):
        path = self.root / name
        path.write_bytes(data)
        return {"path": str(path), "sha256": gate.digest(path)}

    def write_manifest(self):
        self.path.write_text(json.dumps(self.manifest))

    def fake_api(self, _base, _token, route):
        if route.endswith("/documents/deployment-decision"):
            return {"latestRevisionId": self.revision}
        if route == "/api/instance/task-drain":
            return self.hold
        if route == "/api/companies":
            return [{"id": "company-1"}]
        if "/live-runs?" in route:
            return self.rows
        raise AssertionError(route)

    def run_gate(self, phase, command=None):
        command = command or [sys.executable, "-c", "pass"]
        argv = [str(MODULE), "--manifest", str(self.path), "--phase", phase, "--settle-seconds", "0.001", "--", *command]
        with mock.patch.object(sys, "argv", argv), mock.patch.object(gate, "api", side_effect=self.fake_api), mock.patch.dict("os.environ", {"PAPERCLIP_DEPLOY_API_TOKEN": "fake"}):
            return gate.main()

    def test_revision_changed_during_settle_blocks_launch(self):
        with mock.patch.object(gate.time, "sleep", side_effect=lambda _: setattr(self, "revision", "superseded")), mock.patch.object(gate.subprocess, "run") as launch:
            self.assertEqual(self.run_gate("replace"), 1)
            launch.assert_not_called()

    def test_expiry_during_final_receipt_hash_blocks_launch(self):
        now = gate.utc_now()
        clock = [now]
        calls = 0
        original = gate.check_receipts
        def receipts(manifest):
            nonlocal calls
            calls += 1
            original(manifest)
            if calls == 2:
                clock[0] = now + gate.dt.timedelta(minutes=4)
        with mock.patch.object(gate, "utc_now", side_effect=lambda: clock[0]), mock.patch.object(gate, "check_receipts", side_effect=receipts), mock.patch.object(gate.subprocess, "run") as launch:
            self.assertEqual(self.run_gate("replace"), 1)
            launch.assert_not_called()

    def test_hold_revoked_during_final_receipt_hash_blocks_launch(self):
        calls = 0
        original = gate.check_receipts
        def receipts(manifest):
            nonlocal calls
            calls += 1
            original(manifest)
            if calls == 2:
                self.hold["draining"] = False
        with mock.patch.object(gate, "check_receipts", side_effect=receipts), mock.patch.object(gate.subprocess, "run") as launch:
            self.assertEqual(self.run_gate("replace"), 1)
            launch.assert_not_called()

    def test_two_phase_single_use(self):
        marker = self.root / "ran"
        command = [sys.executable, "-c", f"open({str(marker)!r}, 'a').write('x')"]
        self.manifest["commands"] = {"replace": command, "restart": command}
        self.write_manifest()
        self.assertEqual(self.run_gate("replace", command), 0)
        self.assertEqual(self.run_gate("replace", command), 1)
        self.assertEqual(self.run_gate("restart", command), 0)
        self.assertEqual(self.run_gate("restart", command), 1)
        self.assertEqual(marker.read_text(), "xx")

    def test_pidless_reconnecting_row_blocks_command(self):
        self.rows = [{"id": "run-1", "companyId": "company-1", "status": "running", "livenessState": "reconnecting", "workerPid": None}]
        marker = self.root / "ran"
        command = [sys.executable, "-c", f"open({str(marker)!r}, 'w').write('bad')"]
        self.manifest["commands"]["replace"] = command
        self.write_manifest()
        self.assertEqual(self.run_gate("replace", command), 1)
        self.assertFalse(marker.exists())

    def test_expiry_and_missing_hold_fail_closed(self):
        self.manifest["expiresAt"] = "2020-01-01T00:00:00Z"
        self.write_manifest()
        self.assertEqual(self.run_gate("replace"), 1)
        self.manifest["expiresAt"] = (gate.utc_now() + gate.dt.timedelta(minutes=3)).isoformat().replace("+00:00", "Z")
        self.write_manifest()
        self.hold["draining"] = False
        self.assertEqual(self.run_gate("replace"), 1)

    def test_revision_backup_and_saturated_inventory_fail_closed(self):
        self.revision = "superseded"
        self.assertEqual(self.run_gate("replace"), 1)
        self.revision = "revision-1"
        Path(self.manifest["backup"]["path"]).write_bytes(b"changed")
        self.assertEqual(self.run_gate("replace"), 1)
        Path(self.manifest["backup"]["path"]).write_bytes(b"snapshot")
        self.rows = [{"id": str(i), "companyId": "company-1", "status": "queued"} for i in range(50)]
        self.assertEqual(self.run_gate("replace"), 1)

    def test_changed_queued_inventory_aborts_with_timestamped_report(self):
        calls = 0
        original = self.fake_api

        def changing_api(base, token, route):
            nonlocal calls
            if "/live-runs?" in route:
                calls += 1
                return [] if calls == 1 else [{"id": "new-queue", "companyId": "company-1", "status": "queued"}]
            return original(base, token, route)

        with mock.patch.object(self, "fake_api", side_effect=changing_api):
            self.assertEqual(self.run_gate("replace"), 1)
        events = [json.loads(line) for line in self.path.with_suffix(".report.jsonl").read_text().splitlines()]
        self.assertEqual(events[-1]["gate"], "abort")
        self.assertIn("at", events[-1])
        inventories = [event for event in events if event["gate"].startswith("inventory-")]
        self.assertEqual(inventories[0]["running"], 0)
        self.assertEqual(inventories[1]["queued"], 1)


if __name__ == "__main__":
    unittest.main()
