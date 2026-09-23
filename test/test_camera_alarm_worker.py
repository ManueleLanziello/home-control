import importlib.util
from pathlib import Path
import unittest


module_path = Path(__file__).resolve().parents[1] / "src" / "camera-alarm.py"
spec = importlib.util.spec_from_file_location("camera_alarm_worker", module_path)
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class FakeCamera:
    def __init__(self, light_type="2", modes=None):
        self.state = {"enabled": "off", "alarm_type": "4", "light_type": light_type,
                      "alarm_mode": modes if modes is not None else ["sound", "light"],
                      "alarm_volume": "high", "alarm_duration": "20"}
        self.requests = []

    def getAlarm(self):
        return dict(self.state)

    def performRequest(self, payload):
        self.requests.append(payload)
        self.state.update(payload["msg_alarm"]["chn1_msg_alarm_info"])


class AlarmWorkerTests(unittest.TestCase):
    def test_master_toggle_preserves_all_other_alarm_settings(self):
        camera = FakeCamera()
        self.assertEqual(worker.set_alarm(camera, True), {"available": True, "enabled": True})
        self.assertEqual(camera.requests[0], {"method": "set", "msg_alarm": {"chn1_msg_alarm_info": {
            "alarm_type": "4", "light_type": "2", "alarm_mode": ["sound", "light"],
            "alarm_volume": "high", "alarm_duration": "20", "enabled": "on"}}})
        self.assertEqual(worker.set_alarm(camera, False), {"available": True, "enabled": False})
        self.assertEqual(camera.state["light_type"], "2")

    def test_unknown_mode_never_writes(self):
        camera = FakeCamera(modes=[])
        with self.assertRaises(RuntimeError):
            worker.set_alarm(camera, True)
        self.assertEqual(camera.requests, [])


if __name__ == "__main__":
    unittest.main()
