#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$SCRIPT_DIR"

FPS=$(node -e "const fs=require('fs'); const p='./output/meta.json'; if(!fs.existsSync(p)){console.log(30); process.exit(0);} const meta=JSON.parse(fs.readFileSync(p,'utf8')); const fps=parseInt(meta.fps,10); console.log(Number.isFinite(fps)&&fps>0?fps:30);")

exec ./pi_video_player_two_busses \
  output/videoFile_bus0.txt \
  output/videoFile_bus1.txt \
  "$FPS"
