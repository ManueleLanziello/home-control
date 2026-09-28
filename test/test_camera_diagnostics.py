"""No hardware: execute the existing telemetry worker with a fake PyTapo."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import patch


class DiagnosticsTest(unittest.TestCase):
    def test_getter_order_json_and_stderr(self):
        calls = []

        class FakeTapo:
            def __init__(self, *args, **kwargs):
                calls.append("Tapo")

            def getBatteryStatus(self):
                calls.append("battery")
                return {"battery": {"status": {"battery_percent": 34}}}

            def getBatteryStatistic(self):
                calls.append("statistic")
                return {}

            def getRecordings(self, date):
                calls.append("recordings")
                return []

            def getPrivacyMode(self):
                calls.append("privacy")
                return {"enabled": "off"}

            def getMotionDetection(self):
                calls.append("detection")
                return {"enabled": "on"}

            def getAlarm(self):
                calls.append("alarm")
                raise RuntimeError("SECRET must not be logged")

        with patch.dict(sys.modules, {"pytapo": types.SimpleNamespace(Tapo=FakeTapo)}):
            spec = importlib.util.spec_from_file_location("telemetry", Path(__file__).resolve().parents[1] / "src/camera-readonly-telemetry.py")
            worker = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(worker)
        with patch.dict(os.environ, {"TAPO_USERNAME": "SECRET", "TAPO_PASSWORD": "SECRET", "CAM_DIAG_ROLE": "C2", "CAM_DIAG_STARTED_AT": "0"}), patch.object(sys, "argv", ["worker", "--ip", "fixture", "--date", "20260928"]):
            stdout, stderr = io.StringIO(), io.StringIO()
            with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                self.assertEqual(worker.main(), 0)
        self.assertEqual(calls, ["Tapo", "battery", "statistic", "recordings", "privacy", "detection", "alarm"])
        payload = json.loads(stdout.getvalue())
        self.assertEqual(payload["battery"]["percent"], 34)
        self.assertFalse(payload["alarm"]["available"])
        self.assertNotIn("CAM-DIAG", stdout.getvalue())
        self.assertNotIn("SECRET", stderr.getvalue())
        self.assertIn("getter getAlarm end", stderr.getvalue())
        self.assertIn("FAIL", stderr.getvalue())
        partials = [json.loads(line[len("[CAM-RESULT] "):]) for line in stderr.getvalue().splitlines() if line.startswith("[CAM-RESULT] ")]
        self.assertEqual([next(iter(value)) for value in partials], ["battery", "battery", "recordings", "privacy", "detection"])
        self.assertEqual(partials[0]["battery"]["percent"], 34)


if __name__ == "__main__":
    unittest.main()
