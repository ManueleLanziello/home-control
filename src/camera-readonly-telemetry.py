"""Lettura C410 strettamente read-only per batteria e metadata registrazioni."""

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
    return Tapo(
        ip,
        username,
        password,
        cloudPassword=password,
        reuseSession=False,
        printDebugInformation=False,
        printWarnInformation=False,
        redactConfidentialInformation=True,
        controlPort=443,
        streamPort=8800,
    )


def nested(value: object, *path: str) -> object | None:
    current = value
    for key in path:
        if not isinstance(current, dict):
            return None
        current = current.get(key)
    return current


def recording_metadata(value: object) -> list[dict[str, object]]:
    found: list[dict[str, object]] = []
    if isinstance(value, dict):
        if isinstance(value.get("startTime"), (int, float)):
            found.append({
                "startTime": value["startTime"],
                "endTime": value.get("endTime"),
                "vedio_type": value.get("vedio_type"),
            })
        else:
            for child in value.values():
                found.extend(recording_metadata(child))
    elif isinstance(value, list):
        for child in value:
            found.extend(recording_metadata(child))
    return found


def battery(camera: Tapo) -> dict[str, object]:
    status_result = camera.getBatteryStatus()
    statistic_result = camera.getBatteryStatistic()
    status = nested(status_result, "battery", "status") or {}
    days = nested(statistic_result, "statistic", "day") or []
    latest = days[0] if isinstance(days, list) and days and isinstance(days[0], dict) else {}
    return {
        "percent": status.get("battery_percent"),
        "chargingState": status.get("battery_charging"),
        "statisticChargingState": latest.get("bat_status"),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--ip", required=True)
    parser.add_argument("--date", action="append", default=[])
    args = parser.parse_args()
    try:
        camera = create_camera(args.ip)
        result: dict[str, object] = {}
        try:
            result["battery"] = {"available": True, **battery(camera)}
        except Exception:
            result["battery"] = {"available": False}
        try:
            clips: list[dict[str, object]] = []
            for date in dict.fromkeys(args.date):
                clips.extend(recording_metadata(camera.getRecordings(date)))
            result["recordings"] = {"available": True, "clips": clips}
        except Exception:
            result["recordings"] = {"available": False, "clips": []}
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except Exception:
        print(json.dumps({"battery": {"available": False}, "recordings": {"available": False, "clips": []}}))
        return 1


if __name__ == "__main__":
    sys.exit(main())
