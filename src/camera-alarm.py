"""Lettura e toggle del solo master Alarm della Tapo C410."""

from __future__ import annotations

import argparse
import json
import os

from pytapo import Tapo


def create_camera(ip: str) -> Tapo:
    username = os.environ.get("TAPO_USERNAME", "")
    password = os.environ.get("TAPO_PASSWORD", "")
    if not username or not password:
        raise RuntimeError("Credenziali Tapo non configurate.")
    return Tapo(ip, username, password, cloudPassword=password, reuseSession=False,
                printDebugInformation=False, printWarnInformation=False,
                redactConfidentialInformation=True, controlPort=443, streamPort=8800)


def normalize(value: object) -> dict[str, object]:
    if not isinstance(value, dict) or value.get("enabled") not in ("on", "off"):
        raise RuntimeError("Read-back Allarme non disponibile")
    return {"available": True, "enabled": value["enabled"] == "on"}


def read_alarm(camera: Tapo) -> dict[str, object]:
    return normalize(camera.getAlarm())


def set_alarm(camera: Tapo, enabled: bool) -> dict[str, object]:
    current = camera.getAlarm()
    if not isinstance(current, dict) or current.get("enabled") not in ("on", "off"):
        raise RuntimeError("Configurazione Allarme non disponibile")
    modes = current.get("alarm_mode")
    if not isinstance(modes, list) or not modes or any(mode not in ("sound", "light") for mode in modes):
        raise RuntimeError("Modalità Allarme non disponibili")
    if current.get("alarm_type") is None or current.get("light_type") is None:
        raise RuntimeError("Configurazione Allarme non modificabile in sicurezza")
    # PyTapo 3.4.18 setAlarm() forces light_type='0'. Use the same set
    # request shape, preserving all writable values returned by getAlarm().
    writable = ("alarm_type", "light_type", "alarm_mode", "alarm_volume", "alarm_duration")
    settings = {key: current[key] for key in writable if key in current}
    settings["enabled"] = "on" if enabled else "off"
    camera.performRequest({"method": "set", "msg_alarm": {"chn1_msg_alarm_info": settings}})
    confirmed = camera.getAlarm()
    result = normalize(confirmed)
    if result["enabled"] != enabled or any(confirmed.get(key) != current.get(key) for key in writable):
        raise RuntimeError("Read-back Allarme non coerente")
    return result


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--ip", required=True)
    parser.add_argument("--enabled", choices=("on", "off"))
    args = parser.parse_args()
    try:
        camera = create_camera(args.ip)
        result = set_alarm(camera, args.enabled == "on") if args.enabled else read_alarm(camera)
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except Exception as error:
        print(json.dumps({"available": False, "error": str(error)}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
