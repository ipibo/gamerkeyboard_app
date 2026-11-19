#!/usr/bin/env python3
"""Physical shutdown button for the Gamerkeyboard LED installation (Pi 5).

Hold the button for HOLD_SECONDS:
  1. every running pi_video_player_four_busses gets SIGTERM; the player's own
     signal handler sends a black frame on all 4 buses and exits cleanly,
  2. the Node server is asked to stop + send one more blackout frame
     (POST /api/player/stop), so the LEDs are guaranteed dark,
  3. filesystems are synced and the Pi powers off (systemctl poweroff).

Wiring: button between BUTTON_GPIO and GND. Internal pull-up is used, so no
resistor is needed. Run as root (systemd unit) so poweroff is allowed.

Usage:  shutdown_button.py            normal mode
        shutdown_button.py --dry-run  log everything, do not stop or power off
"""

import os
import signal
import subprocess
import sys
import threading
import time
import urllib.request

from gpiozero import Button

BUTTON_GPIO = int(os.environ.get("BUTTON_GPIO", "17"))
HOLD_SECONDS = float(os.environ.get("HOLD_SECONDS", "2"))
PLAYER_STOP_URL = os.environ.get(
    "PLAYER_STOP_URL", "http://127.0.0.1:3000/api/player/stop"
)
PLAYER_PROCESS_PATTERN = "pi_video_player_four_busses"
PLAYER_EXIT_TIMEOUT_SECONDS = 5
API_TIMEOUT_SECONDS = 10
DRY_RUN = "--dry-run" in sys.argv

shutdown_lock = threading.Lock()
shutdown_in_progress = False


def log(message):
    print(f"[shutdown-button] {message}", flush=True)


def player_is_running():
    pgrep_result = subprocess.run(
        ["pgrep", "-f", PLAYER_PROCESS_PATTERN], capture_output=True
    )
    return pgrep_result.returncode == 0


def stop_player_processes():
    """SIGTERM every player process and wait until they have sent black + exited."""
    if not player_is_running():
        log("No player process running")
        return True

    log("Sending SIGTERM to player process(es)")
    subprocess.run(["pkill", "-TERM", "-f", PLAYER_PROCESS_PATTERN])

    wait_deadline = time.monotonic() + PLAYER_EXIT_TIMEOUT_SECONDS
    while time.monotonic() < wait_deadline:
        if not player_is_running():
            log("Player exited cleanly")
            return True
        time.sleep(0.1)

    log("Player did not exit in time, sending SIGKILL")
    subprocess.run(["pkill", "-KILL", "-f", PLAYER_PROCESS_PATTERN])
    return False


def request_server_blackout():
    """Ask the Node server to stop its player and push a blackout frame."""
    stop_request = urllib.request.Request(
        PLAYER_STOP_URL,
        data=b"{}",
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(
            stop_request, timeout=API_TIMEOUT_SECONDS
        ) as stop_response:
            log(f"Server blackout response: {stop_response.status}")
            return True
    except Exception as request_error:  # server down is not fatal here
        log(f"Server blackout failed (continuing): {request_error}")
        return False


def handle_button_held():
    global shutdown_in_progress
    with shutdown_lock:
        if shutdown_in_progress:
            return
        shutdown_in_progress = True

    log(f"Button held {HOLD_SECONDS}s on GPIO{BUTTON_GPIO}: shutting down")

    if DRY_RUN:
        log("DRY RUN: would stop player, send blackout, sync and power off")
        shutdown_in_progress = False
        return

    stop_player_processes()
    request_server_blackout()

    log("Syncing filesystems")
    subprocess.run(["sync"])

    log("Powering off")
    subprocess.run(["systemctl", "poweroff"])


def main():
    shutdown_button = Button(
        BUTTON_GPIO, pull_up=True, bounce_time=0.05, hold_time=HOLD_SECONDS
    )
    shutdown_button.when_pressed = lambda: log("Button pressed (keep holding)")
    shutdown_button.when_held = handle_button_held

    mode_label = "DRY RUN" if DRY_RUN else "LIVE"
    log(f"Watching GPIO{BUTTON_GPIO}, hold {HOLD_SECONDS}s to power off ({mode_label})")
    signal.pause()


if __name__ == "__main__":
    main()
