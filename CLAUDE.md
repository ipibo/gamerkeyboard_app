# CLAUDE.md

This file provides guidance for Claude (and other coding agents) when working in this repository.

## Project Summary

RGB Keyboard App is a Node.js + vanilla JS web app that:

- lets users place one or more keyboard layouts on a canvas,
- saves LED coordinates to `output/coords.txt`,
- accepts a video upload,
- converts every frame to LED color bitstrings,
- writes final frame data to `output/videoFile.txt`.

## Tech Stack

- Runtime: Node.js (CommonJS modules)
- Server: Express
- Upload handling: express-fileupload
- Image/frame processing: ffmpeg-extract-frames, ffmpeg-probe, Jimp
- Body parsing: body-parser
- Frontend: static HTML/CSS/JS in `public/` (no framework)

## Run Commands

- Install: `npm install`
- Start: `npm start`
- Dev mode: `npm run dev`
- App URL: `http://localhost:3000`

## Important Paths

- Server entry: `server.js`
- Video processing pipeline: `videoProcessor.js`
- Static pages: `public/index.html`, `public/setup.html`, `public/upload.html`
- Frontend logic: `public/setup.js`, `public/upload.js`
- Keyboard layouts: `layouts/*.json`
- Runtime output files:
  - `output/coords.txt`
  - `output/layoutConfig.json`
  - `output/videoFile.txt`
- Upload/temp area: `upload/` (plus temporary folders created during processing)
- Pi player (C): `pi_video_player.c`
- Layout conversion tool: `tools/pos-to-json.js` (converts `.pos` files to layout JSON)

## API Surface (Current)

- `GET /api/layouts` -> list available layout JSON files
- `POST /api/saveLayout` -> save coordinates + layout config
- `GET /api/loadLayout` -> load saved layout config
- `GET /api/renderProgress` -> SSE progress stream for rendering
- `POST /api/renderVideo` -> upload video and start async processing
- `POST /api/extractFirstFrame` -> extract first frame for preview

## LED Hardware: BL-HBGR32L-3-TRB-8

Datasheet in `context/BL HBGR32L 3 TRB 8.pdf`. Synchronous 2-lane serial (DIN + CIN).

**Protocol structure for full video output:**
```
Start frame      : 32 bits, all zeros  (once, beginning of video)
Per video frame  : N × 32 bits — one per LED:
                   [111][GGGGG][BBBBBBBB][GGGGGGGG][RRRRRRRR]
                    sign  5-bit   8-bit      8-bit     8-bit
                          global  Blue       Green     Red
                          bright
End frame        : 32 bits, all ones   (once, end of video)
```

- Sign bits always `111`
- Global brightness: 5-bit, `00000`=0/31 (min) … `11111`=31/31 (max)
- Color channels: 8-bit each, order is **Blue → Green → Red** (not RGB)
- `0xe0 | brightness` = `11100000 | GGGGG` = correct sign+brightness top byte
- Constant current output: 18mA typ per channel
- Supply: 5V (4.5–5.5V), clock max 15MHz

## Data Contracts To Preserve

- `coords.txt`: one key coordinate per line, format `x y`.
- `layoutConfig.json`: stores keyboard placements, connections, and canvas size.
- `videoFile.txt`: one binary string line per processed frame.
- `brightness` is clamped to integer range `1..31` and packed in top byte as `0xe0 | brightness`.

## Working Rules For Changes

- Keep module format as CommonJS (`require`, `module.exports`) unless refactor is explicitly requested.
- Preserve existing API routes and payload shapes unless changing both frontend and backend together.
- Do not silently change output file formats used by downstream tools (Pi player / renderer).
- Prefer small, targeted edits over broad rewrites.
- If adding a dependency, keep it minimal and update `package.json`.

## Local Environment Notes

- FFmpeg must be available on the system for frame extraction/probing tools to work.
- The app creates missing `output/` and `upload/` directories at startup.
- Render progress currently supports one active render flow at a time (single shared SSE state).

## Suggested Validation After Changes

1. Start server: `npm start`.
2. Open `/setup`, place keyboards, click save.
3. Confirm `output/coords.txt` and `output/layoutConfig.json` are written.
4. Open `/upload`, upload a short video, start render.
5. Confirm progress updates and `output/videoFile.txt` creation.

## Known Caveats

- In `videoProcessor.js`, frame iteration currently assumes frames are named `frame-1.png` through `frame-N.png`.
- `ffmpeg-probe` frame count (`nb_frames`) may be missing for some codecs/containers.
- The preview and setup UIs are canvas-based and sensitive to coordinate system assumptions.
