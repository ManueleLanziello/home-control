"""Lettura read-only degli eventi detection recenti C410."""

from __future__ import annotations

import argparse
import json
import os
import sys

from pytapo import Tapo


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--ip", required=True)
    args = parser.parse_args()
    username = os.environ.get("TAPO_USERNAME", "")
    password = os.environ.get("TAPO_PASSWORD", "")
    if not username or not password:
        raise RuntimeError("Credenziali Tapo non configurate.")
    camera = Tapo(args.ip, username, password, cloudPassword=password, reuseSession=False,
                  printDebugInformation=False, printWarnInformation=False,
                  redactConfidentialInformation=True, controlPort=443, streamPort=8800)
    events = []
    for event in camera.getEvents():
        if not isinstance(event, dict):
            continue
        start_time = event.get("start_time")
        end_time = event.get("end_time")
        if isinstance(start_time, (int, float)) and isinstance(end_time, (int, float)):
            events.append({"start_time": start_time, "end_time": end_time})
    print(json.dumps({"available": True, "events": events}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        print(json.dumps({"available": False, "events": []}))
        sys.exit(1)
