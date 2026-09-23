"""Scarica una sola registrazione C410 e la remuxa in MP4 temporaneo."""

from __future__ import annotations

import argparse
import asyncio
from datetime import datetime
import json
import os
from pathlib import Path
import subprocess
import sys

import imageio_ffmpeg
from pytapo import Tapo
from pytapo.media_stream._utils import StreamType


def create_camera(ip: str) -> Tapo:
    username = os.environ.get("TAPO_USERNAME", "")
    password = os.environ.get("TAPO_PASSWORD", "")
    if not username or not password:
        raise RuntimeError("Credenziali Tapo non configurate.")
    return Tapo(ip, username, password, cloudPassword=password, reuseSession=False,
                printDebugInformation=False, printWarnInformation=False,
                redactConfidentialInformation=True, controlPort=443, streamPort=8800)


async def download_ts(camera: Tapo, start_time: int, end_time: int) -> bytes:
    chunks: list[bytes] = []
    session = camera.getMediaSession(StreamType.Download)
    session.set_window_size(200)
    async with session:
        payload = json.dumps({"type": "request", "seq": 1, "params": {"playback": {
            "client_id": camera.getUserID(), "channels": [0, 1], "scale": "1/1",
            "start_time": str(start_time), "end_time": str(end_time), "event_type": [1, 2],
        }, "method": "get"}})
        stream = session.transceive(payload)
        while True:
            try:
                response = await asyncio.wait_for(stream.__anext__(), timeout=120)
            except StopAsyncIteration:
                break
            if response.mimetype == "video/mp2t":
                chunks.append(response.plaintext)
            elif response.mimetype == "application/json":
                message = json.loads(response.plaintext.decode())
                status = message.get("params", {})
                if status.get("event_type") == "stream_status" and status.get("status") == "finished":
                    break
    data = b"".join(chunks)
    if not data:
        raise RuntimeError("Registrazione senza dati MPEG-TS.")
    return data


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--ip", required=True)
    parser.add_argument("--start-time", required=True, type=int)
    parser.add_argument("--end-time", required=True, type=int)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    if args.end_time <= args.start_time or args.end_time - args.start_time > 300:
        raise RuntimeError("Intervallo registrazione non valido.")
    output = Path(args.output)
    if output.name != "recording.mp4":
        raise RuntimeError("Output registrazione non valido.")
    ts_path = output.with_suffix(".ts")
    try:
        try:
            camera = create_camera(args.ip)
            # C410 initializes the playback context while listing the date; this is
            # the same sequence used by the verified read-only recording probe.
            camera.getRecordings(datetime.fromtimestamp(args.start_time).strftime("%Y%m%d"))
            ts_path.write_bytes(asyncio.run(download_ts(camera, args.start_time, args.end_time)))
        except Exception as error:
            raise RuntimeError("Scaricamento MPEG-TS non riuscito") from error
        result = subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(), "-y", "-hide_banner", "-i", str(ts_path),
                                 "-map", "0:v:0", "-c:v", "copy", "-an", str(output)],
                                stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True, timeout=60)
        if result.returncode != 0 or not output.is_file() or output.stat().st_size <= 0:
            raise RuntimeError("Remux MP4 non riuscito.")
        print(json.dumps({"available": True}))
        return 0
    finally:
        ts_path.unlink(missing_ok=True)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:
        print(json.dumps({"error": str(error)}))
        sys.exit(1)
