#!/bin/bash
set -euo pipefail

# Compile the 4-bus Pi video player. Run on the Raspberry Pi (needs Linux
# spidev headers). Uses raw spidev ioctl + pthreads — no wiringPi dependency.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$SCRIPT_DIR"

gcc -O2 -Wall -o pi_video_player_four_busses pi_video_player_four_busses.c -lpthread

echo "Built pi_video_player_four_busses"
