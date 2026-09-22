"""Master rilevazione C410: setter con read-back obbligatorio."""

from __future__ import annotations

import argparse
import json
import os
import sys

from pytapo import Tapo


def create_camera(ip: str) -> Tapo:
    username = os.environ.get("TAPO_USERNAME", "")
    password = os.environ.get("TAPO_PASSWORD", "")
    if not username or not password:
        raise RuntimeError("Credenziali Tapo non configurate.")
    return Tapo(ip, username, password, cloudPassword=password, reuseSession=False,
                printDebugInformation=False, printWarnInformation=False,
                redactConfidentialInformation=True, controlPort=443, streamPort=8800)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--ip", required=True)
    parser.add_argument("--enabled", choices=("on", "off"))
    args = parser.parse_args()
    try:
        camera = create_camera(args.ip)
        if args.enabled is not None:
            camera.setMotionDetection(args.enabled == "on")
        detection = camera.getMotionDetection()
        enabled = detection.get("enabled") if isinstance(detection, dict) else None
        if enabled not in ("on", "off"):
            raise RuntimeError("Read-back Rilevazione non valido.")
        print(json.dumps({"available": True, "enabled": enabled == "on"}))
        return 0
    except Exception:
        print(json.dumps({"available": False, "enabled": None}))
        return 1


if __name__ == "__main__":
    sys.exit(main())
