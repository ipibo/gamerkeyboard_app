#!/bin/bash
set -uo pipefail

# Wait for the Node server, then start playback via the dashboard API.
SERVER_URL="${SERVER_URL:-http://127.0.0.1:3000}"
BOOT_BRIGHTNESS="${BOOT_BRIGHTNESS:-1}"
BOOT_ENTRY_ID="${BOOT_ENTRY_ID:-}"
MAX_WAIT_SECONDS=60

for ((waitedSeconds = 0; waitedSeconds < MAX_WAIT_SECONDS; waitedSeconds++)); do
  if curl -fs -o /dev/null "$SERVER_URL/api/player/status"; then
    break
  fi
  sleep 1
done

if [[ -n "$BOOT_ENTRY_ID" ]]; then
  startPayload="{\"brightness\": $BOOT_BRIGHTNESS, \"id\": \"$BOOT_ENTRY_ID\"}"
else
  startPayload="{\"brightness\": $BOOT_BRIGHTNESS}"
fi

echo "Starting player: $startPayload"
curl -fsS -X POST -H "Content-Type: application/json" \
  -d "$startPayload" "$SERVER_URL/api/player/start"
echo
