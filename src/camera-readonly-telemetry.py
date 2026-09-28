"""Lettura C410 strettamente read-only per batteria e metadata registrazioni."""

from __future__ import annotations

import argparse
import json
import os
import sys
import time

from pytapo import Tapo


def diagnostic(phase: str, outcome: str = "OK") -> None:
    role = os.environ.get("CAM_DIAG_ROLE")
    if role not in ("C1", "C2", "C3"):
        return
    started = float(os.environ["CAM_DIAG_STARTED_AT"]) / 1000
    print(f"[CAM-DIAG] {role} epoch={time.time():.6f} +{time.time() - started:.3f}s {phase} {outcome}", file=sys.stderr, flush=True)


def observed_getter(name: str, getter, *args):
    started = time.perf_counter()
    diagnostic(f"getter {name} start")
    try:
        result = getter(*args)
    except Exception:
        diagnostic(f"getter {name} end duration={time.perf_counter() - started:.3f}s", "FAIL")
        raise
    diagnostic(f"getter {name} end duration={time.perf_counter() - started:.3f}s")
    return result


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


def partial(field: str, value: object) -> None:
    # Separate, flushed protocol: stdout remains the existing final JSON document.
    print("[CAM-RESULT] " + json.dumps({field: value}, ensure_ascii=False), file=sys.stderr, flush=True)


def battery(camera: Tapo) -> dict[str, object]:
    status_result = observed_getter("getBatteryStatus", camera.getBatteryStatus)
    diagnostic("battery status received")
    status = nested(status_result, "battery", "status") or {}
    partial("battery", {"available": True, "percent": status.get("battery_percent"), "chargingState": status.get("battery_charging")})
    statistic_result = observed_getter("getBatteryStatistic", camera.getBatteryStatistic)
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
    parser.add_argument("--recordings-only", action="store_true")
    args = parser.parse_args()
    try:
        diagnostic("Tapo session start")
        camera = create_camera(args.ip)
        diagnostic("Tapo session ready")
        result: dict[str, object] = {}
        if not args.recordings_only:
            try:
                result["battery"] = {"available": True, **battery(camera)}
                partial("battery", result["battery"])
            except Exception:
                result["battery"] = {"available": False}
        try:
            clips: list[dict[str, object]] = []
            for date in dict.fromkeys(args.date):
                clips.extend(recording_metadata(observed_getter("getRecordings", camera.getRecordings, date)))
                partial("recordings", {"available": True, "clips": clips})
            result["recordings"] = {"available": True, "clips": clips}
        except Exception:
            result["recordings"] = {"available": False, "clips": []}
        if not args.recordings_only:
            try:
                privacy = observed_getter("getPrivacyMode", camera.getPrivacyMode)
                enabled = privacy.get("enabled") if isinstance(privacy, dict) else None
                result["privacy"] = {"available": enabled in ("on", "off"), "enabled": enabled}
                partial("privacy", result["privacy"])
            except Exception:
                result["privacy"] = {"available": False}
            try:
                detection = observed_getter("getMotionDetection", camera.getMotionDetection)
                enabled = detection.get("enabled") if isinstance(detection, dict) else None
                result["detection"] = {"available": enabled in ("on", "off"), "enabled": enabled}
                partial("detection", result["detection"])
            except Exception:
                result["detection"] = {"available": False}
            try:
                alarm = observed_getter("getAlarm", camera.getAlarm)
                enabled = alarm.get("enabled") if isinstance(alarm, dict) else None
                result["alarm"] = {"available": enabled in ("on", "off"), "enabled": enabled}
                partial("alarm", result["alarm"])
            except Exception:
                result["alarm"] = {"available": False}
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except Exception:
        print(json.dumps({"battery": {"available": False}, "recordings": {"available": False, "clips": []}}))
        return 1


if __name__ == "__main__":
    sys.exit(main())
