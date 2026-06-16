/* eslint-disable no-console */
const express = require("express")
const bodyParser = require("body-parser")
const fileUpload = require("express-fileupload")
const fs = require("fs")
const path = require("path")
const { spawn } = require("child_process")
const probe = require("ffmpeg-probe")
const { processVideoAllBuses, writeVideoMeta } = require("./videoProcessor")

const app = express()
const PORT = 3000
const LAYOUTS_DIR = path.join(__dirname, "layouts")
const OUTPUT_DIR = path.join(__dirname, "output")
const UPLOAD_DIR = path.join(__dirname, "upload")
const COORDS_PATH = path.join(OUTPUT_DIR, "coords.txt")
const NUM_BUSES = 4
const COORDS_BUS = Array.from({ length: NUM_BUSES }, (_, busIndex) =>
  path.join(OUTPUT_DIR, `coords_bus${busIndex}.txt`),
)
const OUTPUT_BIN = path.join(OUTPUT_DIR, "videoFile.txt")
const OUTPUT_BIN_BUS = Array.from({ length: NUM_BUSES }, (_, busIndex) =>
  path.join(OUTPUT_DIR, `videoFile_bus${busIndex}.txt`),
)
const META_PATH = path.join(OUTPUT_DIR, "meta.json")
const LAYOUT_CONFIG_PATH = path.join(OUTPUT_DIR, "layoutConfig.json")
const PLAYER_BINARY_PATH = path.join(__dirname, "pi_video_player_four_busses")

function makefolder(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

function readCoordsFile(filePath) {
  if (!fs.existsSync(filePath)) return []
  return fs
    .readFileSync(filePath, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const parts = line.trim().split(" ")
      return [parseFloat(parts[0]), parseFloat(parts[1])]
    })
}

function scaleCoords(
  coords,
  canvasWidth,
  canvasHeight,
  videoWidth,
  videoHeight,
) {
  if (!canvasWidth || !canvasHeight || !videoWidth || !videoHeight)
    return coords
  const scaleX = videoWidth / canvasWidth
  const scaleY = videoHeight / canvasHeight
  return coords.map(([x, y]) => [x * scaleX, y * scaleY])
}

makefolder(OUTPUT_DIR)
makefolder(UPLOAD_DIR)

let previewCache = null
let playerProcess = null
let playerState = "stopped"
let playerFps = 30
let playerBrightness = 1

function readPlayerFps() {
  const fallbackFps = 30
  if (!fs.existsSync(META_PATH)) return fallbackFps

  try {
    const meta = JSON.parse(fs.readFileSync(META_PATH, "utf8"))
    const parsedFps = parseInt(meta.fps, 10)
    if (!Number.isFinite(parsedFps) || parsedFps < 1) {
      return fallbackFps
    }
    return parsedFps
  } catch (readError) {
    console.warn(`Could not read ${META_PATH}: ${readError.message}`)
    return fallbackFps
  }
}

function attachPlayerLifecycleHandlers() {
  if (!playerProcess) return

  playerProcess.on("close", (exitCode, signal) => {
    console.log(`Player stopped (code=${exitCode}, signal=${signal || "none"})`)
    playerProcess = null
    playerState = "stopped"
  })

  playerProcess.on("error", (spawnError) => {
    console.error(`Player error: ${spawnError.message}`)
    playerProcess = null
    playerState = "stopped"
  })
}

function stopPlayerProcess(signalName = "SIGTERM") {
  return new Promise((resolve) => {
    if (!playerProcess) {
      playerState = "stopped"
      resolve(false)
      return
    }

    const processToStop = playerProcess
    processToStop.once("close", () => resolve(true))
    try {
      processToStop.kill(signalName)
    } catch (killError) {
      console.warn(`Could not signal player process: ${killError.message}`)
      resolve(false)
    }
  })
}

function countCoordsLines(filePath) {
  if (!fs.existsSync(filePath)) return 0
  const raw = fs.readFileSync(filePath, "utf8")
  return raw.split("\n").filter((line) => line.trim() !== "").length
}

// LED count for a bus, with legacy fallback: bus 0 reads combined coords.txt
// when the per-bus file is absent (old layouts saved before the bus split).
function countBusLedCount(busIndex) {
  if (fs.existsSync(COORDS_BUS[busIndex])) {
    return countCoordsLines(COORDS_BUS[busIndex])
  }
  if (busIndex === 0) {
    return countCoordsLines(COORDS_PATH)
  }
  return 0
}

function buildBlackoutFileContent(ledCount) {
  const startFrame = "0".repeat(32)
  const endFrame = "1".repeat(32)
  if (ledCount < 1) {
    return `${startFrame}\n${endFrame}\n`
  }

  const blackLedBits = "11100010000000000000000000000000"
  const blackFrame = blackLedBits.repeat(ledCount)
  return `${startFrame}\n${blackFrame}\n${endFrame}\n`
}

// Builds a test "video": 256 frames ramping every LED from black (0,0,0)
// to white (255,255,255). Global brightness byte uses full 0b11111111 (max)
// so the fade is clearly visible. Channel order matches the player: B, G, R.
function buildFadeFileContent(ledCount) {
  const startFrame = "0".repeat(32)
  const endFrame = "1".repeat(32)
  if (ledCount < 1) {
    return `${startFrame}\n${endFrame}\n`
  }

  const globalBits = "11111111"
  const frameLines = []
  for (let value = 0; value <= 255; value++) {
    const channelBits = value.toString(2).padStart(8, "0")
    const ledBits = globalBits + channelBits + channelBits + channelBits
    frameLines.push(ledBits.repeat(ledCount))
  }
  return `${startFrame}\n${frameLines.join("\n")}\n${endFrame}\n`
}

function sendBlackoutFrame() {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(PLAYER_BINARY_PATH)) {
      reject(
        new Error(
          "Player binary missing — compile pi_video_player_four_busses first",
        ),
      )
      return
    }

    if (!OUTPUT_BIN_BUS.every((busPath) => fs.existsSync(busPath))) {
      reject(new Error("Rendered bus files missing — render a video first"))
      return
    }

    const blackoutPaths = OUTPUT_BIN_BUS.map((_, busIndex) => {
      const ledCount = countBusLedCount(busIndex)
      const blackoutPath = path.join(OUTPUT_DIR, `blackout_bus${busIndex}.txt`)
      fs.writeFileSync(blackoutPath, buildBlackoutFileContent(ledCount))
      return blackoutPath
    })

    const blackoutFps = Math.max(30, readPlayerFps())
    const blackoutArgs = [...blackoutPaths, String(blackoutFps)]

    const blackoutProcess = spawn(PLAYER_BINARY_PATH, blackoutArgs, {
      cwd: __dirname,
      stdio: ["ignore", "ignore", "pipe"],
    })

    const blackoutKillTimer = setTimeout(() => {
      try {
        blackoutProcess.kill("SIGTERM")
      } catch {
        // ignore kill race; close handler resolves/rejects outcome.
      }
    }, 150)

    let stderrText = ""
    if (blackoutProcess.stderr) {
      blackoutProcess.stderr.on("data", (chunk) => {
        stderrText += chunk.toString()
      })
    }

    blackoutProcess.on("error", (spawnError) => {
      clearTimeout(blackoutKillTimer)
      reject(new Error(`Blackout process error: ${spawnError.message}`))
    })

    blackoutProcess.on("close", (exitCode, signalName) => {
      clearTimeout(blackoutKillTimer)
      if (exitCode === 0 || signalName === "SIGTERM") {
        resolve(true)
        return
      }
      const details = stderrText.trim()
      reject(
        new Error(
          details
            ? `Blackout failed: ${details}`
            : `Blackout failed with exit code ${exitCode}`,
        ),
      )
    })
  })
}

async function startPlayerProcess({
  forceRestart = false,
  busPaths = OUTPUT_BIN_BUS,
  fps = null,
  brightness = playerBrightness,
} = {}) {
  if (!fs.existsSync(PLAYER_BINARY_PATH)) {
    throw new Error(
      "Player binary missing — compile pi_video_player_four_busses first",
    )
  }

  if (!busPaths.every((busPath) => fs.existsSync(busPath))) {
    throw new Error("Rendered bus files missing — render a video first")
  }

  if (playerProcess) {
    if (!forceRestart) {
      throw new Error("Player already running")
    }
    await stopPlayerProcess("SIGTERM")
  }

  const renderFps = fps !== null ? fps : readPlayerFps()
  const clampedBrightness = Math.min(31, Math.max(1, parseInt(brightness, 10) || 1))
  playerBrightness = clampedBrightness
  const args = [
    ...busPaths,
    String(renderFps),
    "--brightness",
    String(clampedBrightness),
  ]
  playerProcess = spawn(PLAYER_BINARY_PATH, args, {
    cwd: __dirname,
    stdio: ["ignore", "ignore", "pipe"],
  })

  playerState = "running"
  playerFps = renderFps
  attachPlayerLifecycleHandlers()

  if (playerProcess.stderr) {
    playerProcess.stderr.on("data", (chunk) => {
      const stderrText = chunk.toString().trim()
      if (stderrText) {
        console.error(`[player] ${stderrText}`)
      }
    })
  }

  return {
    state: playerState,
    fps: playerFps,
    brightness: playerBrightness,
    pid: playerProcess.pid,
  }
}

function countLines(filePath) {
  return new Promise((resolve, reject) => {
    let n = 0
    const rl = require("readline").createInterface({
      input: fs.createReadStream(filePath),
      crlfDelay: Infinity,
    })
    rl.on("line", () => n++)
    rl.on("close", () => resolve(n))
    rl.on("error", reject)
  })
}

function readFrameLines(filePath, startLine, count) {
  return new Promise((resolve, reject) => {
    const lines = []
    let lineNum = 0
    const rl = require("readline").createInterface({
      input: fs.createReadStream(filePath),
      crlfDelay: Infinity,
    })
    rl.on("line", (line) => {
      if (lineNum >= startLine && lineNum < startLine + count) lines.push(line)
      if (lineNum >= startLine + count) rl.close()
      lineNum++
    })
    rl.on("close", () => resolve(lines))
    rl.on("error", reject)
  })
}

function decodeFrame(frameStr, ledCount) {
  const rgb = []
  for (let i = 0; i < ledCount; i++) {
    const o = i * 32
    rgb.push(
      parseInt(frameStr.slice(o + 24, o + 32), 2),
      parseInt(frameStr.slice(o + 16, o + 24), 2),
      parseInt(frameStr.slice(o + 8, o + 16), 2),
    )
  }
  return rgb
}

app.use(express.static(path.join(__dirname, "public")))
app.use(bodyParser.urlencoded({ extended: false }))
app.use(bodyParser.json())
app.use(fileUpload({ useTempFiles: false }))

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public/index.html"))
})

app.get("/setup", (req, res) => {
  res.sendFile(path.join(__dirname, "public/setup.html"))
})

app.get("/upload", (req, res) => {
  res.sendFile(path.join(__dirname, "public/upload.html"))
})

app.get("/dashboard", (req, res) => {
  res.sendFile(path.join(__dirname, "public/dashboard.html"))
})

app.get("/api/layouts", (req, res) => {
  try {
    const files = fs.readdirSync(LAYOUTS_DIR).filter((f) => f.endsWith(".json"))
    const layouts = files.map((f) => {
      const data = JSON.parse(
        fs.readFileSync(path.join(LAYOUTS_DIR, f), "utf8"),
      )
      return { id: f.replace(".json", ""), name: data.name, keys: data.keys }
    })
    res.json(layouts)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.post("/api/saveLayout", (req, res) => {
  const { coords, keyboards, connections, canvasWidth, canvasHeight } = req.body
  if (!Array.isArray(coords))
    return res.status(400).json({ error: "coords must be array" })

  // Split flat coords array into per-bus arrays using layout key counts
  const coordsByBus = Array.from({ length: NUM_BUSES }, () => [])
  let coordIndex = 0
  if (Array.isArray(keyboards)) {
    keyboards.forEach((kbData) => {
      const layoutFile = path.join(LAYOUTS_DIR, `${kbData.layoutId}.json`)
      let keyCount = 0
      try {
        const layoutData = JSON.parse(fs.readFileSync(layoutFile, "utf8"))
        keyCount = layoutData.keys.length
      } catch {
        // Unknown layout — skip its coords
      }
      const busIndex =
        Number.isInteger(kbData.spiBus) &&
        kbData.spiBus >= 0 &&
        kbData.spiBus < NUM_BUSES
          ? kbData.spiBus
          : 0
      const busCoords = coordsByBus[busIndex]
      for (
        let ledIndex = 0;
        ledIndex < keyCount && coordIndex < coords.length;
        ledIndex++, coordIndex++
      ) {
        busCoords.push(coords[coordIndex])
      }
    })
  }
  // Any remaining coords fall to bus 0
  while (coordIndex < coords.length) {
    coordsByBus[0].push(coords[coordIndex++])
  }

  const formatCoords = (busCoords) =>
    busCoords.map(([x, y]) => `${x} ${y}`).join("\n")
  const combinedLines = formatCoords(coordsByBus.flat())

  try {
    coordsByBus.forEach((busCoords, busIndex) => {
      fs.writeFileSync(COORDS_BUS[busIndex], formatCoords(busCoords))
    })
    fs.writeFileSync(COORDS_PATH, combinedLines)

    const config = {
      keyboards: keyboards || [],
      connections: connections || [],
      canvasWidth: canvasWidth || 1400,
      canvasHeight: canvasHeight || 600,
      savedAt: new Date().toISOString(),
    }
    fs.writeFileSync(LAYOUT_CONFIG_PATH, JSON.stringify(config, null, 2))

    res.json({ ok: true, path: COORDS_PATH, count: coords.length })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.get("/api/loadLayout", (req, res) => {
  try {
    if (!fs.existsSync(LAYOUT_CONFIG_PATH)) {
      return res.json({ keyboards: [], connections: [] })
    }
    const config = JSON.parse(fs.readFileSync(LAYOUT_CONFIG_PATH, "utf8"))
    res.json(config)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// SSE progress state — simple single-render-at-a-time
let renderClients = []
let renderState = null // { current, total, done, error }

function emitProgress(data) {
  renderState = data
  const msg = `data: ${JSON.stringify(data)}\n\n`
  renderClients.forEach((c) => c.write(msg))
  if (data.done || data.error) {
    renderClients.forEach((c) => c.end())
    renderClients = []
    renderState = null // clear so the next render doesn't replay a stale terminal state
  }
}

app.get("/api/renderProgress", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream")
  res.setHeader("Cache-Control", "no-cache")
  res.setHeader("Connection", "keep-alive")
  res.flushHeaders()

  // Send current state immediately if already running
  if (renderState) {
    res.write(`data: ${JSON.stringify(renderState)}\n\n`)
    if (renderState.done || renderState.error) {
      res.end()
      return
    }
  }

  renderClients.push(res)
  req.on("close", () => {
    renderClients = renderClients.filter((c) => c !== res)
  })
})

app.post("/api/player/start", async (req, res) => {
  try {
    const status = await startPlayerProcess({ brightness: req.body.brightness })
    res.json({ ok: true, ...status })
  } catch (startError) {
    res.status(400).json({ ok: false, error: startError.message })
  }
})

app.post("/api/player/stop", async (req, res) => {
  if (playerProcess) {
    const stopped = await stopPlayerProcess("SIGTERM")
    try {
      await sendBlackoutFrame()
      playerState = "stopped"
      return res.json({
        ok: true,
        state: playerState,
        stopped,
        blackSent: true,
      })
    } catch (blackoutError) {
      playerState = "stopped"
      return res.status(500).json({
        ok: false,
        state: playerState,
        stopped,
        blackSent: false,
        error: blackoutError.message,
      })
    }
  }

  try {
    await sendBlackoutFrame()
    playerState = "stopped"
    res.json({ ok: true, state: playerState, stopped: false, blackSent: true })
  } catch (blackoutError) {
    playerState = "stopped"
    res.status(500).json({
      ok: false,
      state: playerState,
      stopped: false,
      blackSent: false,
      error: blackoutError.message,
    })
  }
})

app.post("/api/player/black", async (req, res) => {
  await stopPlayerProcess("SIGTERM")
  playerState = "stopped"

  try {
    await sendBlackoutFrame()
    res.json({ ok: true, state: playerState, blackSent: true })
  } catch (blackoutError) {
    res.status(500).json({
      ok: false,
      state: playerState,
      blackSent: false,
      error: blackoutError.message,
    })
  }
})

app.post("/api/player/fade", async (req, res) => {
  try {
    const ledCounts = OUTPUT_BIN_BUS.map((_, busIndex) =>
      countBusLedCount(busIndex),
    )

    if (ledCounts.every((ledCount) => ledCount < 1)) {
      return res
        .status(400)
        .json({ ok: false, error: "No coords saved — set up a layout first" })
    }

    const fadePaths = ledCounts.map((ledCount, busIndex) => {
      const fadePath = path.join(OUTPUT_DIR, `fade_bus${busIndex}.txt`)
      fs.writeFileSync(fadePath, buildFadeFileContent(ledCount))
      return fadePath
    })

    // 60 fps -> ~4.3 s per 0->255 ramp; player loops the file, so it repeats.
    const status = await startPlayerProcess({
      forceRestart: true,
      busPaths: fadePaths,
      fps: 60,
    })
    res.json({ ok: true, ...status })
  } catch (fadeError) {
    res.status(400).json({ ok: false, error: fadeError.message })
  }
})

app.post("/api/player/pause", (req, res) => {
  if (!playerProcess || playerState !== "running") {
    return res.status(400).json({ ok: false, error: "Player is not running" })
  }

  playerProcess.kill("SIGSTOP")
  playerState = "paused"
  res.json({ ok: true, state: playerState, fps: playerFps })
})

app.post("/api/player/resume", (req, res) => {
  if (!playerProcess || playerState !== "paused") {
    return res.status(400).json({ ok: false, error: "Player is not paused" })
  }

  playerProcess.kill("SIGCONT")
  playerState = "running"
  res.json({ ok: true, state: playerState, fps: playerFps })
})

app.get("/api/player/status", (req, res) => {
  res.json({
    state: playerState,
    fps: playerFps,
    brightness: playerBrightness,
    pid: playerProcess ? playerProcess.pid : null,
  })
})

app.post("/api/renderVideo", async (req, res) => {
  if (!req.files || !req.files.video) {
    return res.status(400).json({ error: "no video file" })
  }

  // Always render at minimum brightness (safe floor). Live brightness is now
  // applied at playback by the player (--brightness) and set in the dashboard,
  // so no re-render is needed to change it.
  const brightness = 1

  // Validate coords source: either override from preview or saved coord files
  const hasCoordOverride = req.body.coordsBus0 !== undefined
  if (
    !hasCoordOverride &&
    !fs.existsSync(COORDS_BUS[0]) &&
    !fs.existsSync(COORDS_PATH)
  ) {
    return res
      .status(400)
      .json({ error: "no coords saved yet — set up keyboard layout first" })
  }

  // Save uploaded video to upload/
  const ext = path.extname(req.files.video.name) || ".mp4"
  const videoPath = path.join(UPLOAD_DIR, `video${ext}`)
  await req.files.video.mv(videoPath)

  // Capture per-bus coord override fields now (before setImmediate)
  const coordsBusBody = OUTPUT_BIN_BUS.map(
    (_, busIndex) => req.body[`coordsBus${busIndex}`],
  )

  renderState = null
  previewCache = null

  res.json({ ok: true, message: "render started" })

  // Process all buses in parallel after responding
  setImmediate(async () => {
    try {
      emitProgress({ current: 0, total: 0, done: false })

      const renderMeta = await writeVideoMeta(videoPath, OUTPUT_DIR)
      playerFps = renderMeta.fps

      // Resolve LED coordinates: preview-adjusted coords take priority over saved files
      let busCoords
      if (coordsBusBody[0] !== undefined) {
        busCoords = coordsBusBody.map((body) =>
          body ? JSON.parse(body) : [],
        )
        console.log(
          `Using preview-adjusted coords: ${busCoords
            .map((c, i) => `bus${i}=${c.length}`)
            .join(" ")} LEDs`,
        )
      } else {
        // Read saved coord files and scale from canvas space to video pixel space
        let canvasWidth = null
        let canvasHeight = null
        try {
          const layoutConfig = JSON.parse(
            fs.readFileSync(LAYOUT_CONFIG_PATH, "utf8"),
          )
          canvasWidth = layoutConfig.canvasWidth
          canvasHeight = layoutConfig.canvasHeight
        } catch {
          console.warn(
            "Could not read layoutConfig.json — coord scaling skipped",
          )
        }

        let videoWidth = null
        let videoHeight = null
        try {
          const videoInfo = await probe(videoPath)
          const videoStream = videoInfo.streams.find(
            (s) => s.codec_type === "video",
          )
          if (videoStream) {
            videoWidth = videoStream.width
            videoHeight = videoStream.height
          }
        } catch {
          console.warn(
            "Could not probe video dimensions — coord scaling skipped",
          )
        }

        busCoords = COORDS_BUS.map((busPath, busIndex) => {
          const raw =
            busIndex === 0 && !fs.existsSync(busPath)
              ? readCoordsFile(COORDS_PATH)
              : readCoordsFile(busPath)
          return scaleCoords(
            raw,
            canvasWidth,
            canvasHeight,
            videoWidth,
            videoHeight,
          )
        })
        console.log(
          `Using saved coords (scaled ${canvasWidth}x${canvasHeight} → ${videoWidth}x${videoHeight}): ${busCoords
            .map((c, i) => `bus${i}=${c.length}`)
            .join(" ")} LEDs`,
        )
      }

      await processVideoAllBuses(
        videoPath,
        busCoords,
        OUTPUT_BIN_BUS,
        brightness,
        (current, total) => {
          emitProgress({ current, total, done: false })
        },
      )

      emitProgress({
        current: 1,
        total: 1,
        done: true,
        output: OUTPUT_BIN_BUS[0],
      })

      try {
        await startPlayerProcess({ forceRestart: true })
      } catch (playerStartError) {
        console.warn(
          `Render finished, but player did not auto-start: ${playerStartError.message}`,
        )
      }
    } catch (err) {
      console.error("render error:", err)
      emitProgress({ error: err.message, done: true })
    }
  })
})

app.post("/api/extractFirstFrame", async (req, res) => {
  console.log("extractFirstFrame called")
  if (!req.files || !req.files.video) {
    console.log("No video file in request")
    return res.status(400).json({ error: "no video file" })
  }

  const extractFrame = require("ffmpeg-extract-frames")

  const ext = path.extname(req.files.video.name) || ".mp4"
  const videoPath = path.join(UPLOAD_DIR, `preview${ext}`)
  const tmpDir = path.join(UPLOAD_DIR, "tmp")

  try {
    makefolder(tmpDir)
    await req.files.video.mv(videoPath)

    await extractFrame({
      input: videoPath,
      output: path.join(tmpDir, "frame-%d.png"),
      start: 0,
      count: 1,
    })

    const framePath = path.join(tmpDir, "frame-1.png")
    if (!fs.existsSync(framePath)) {
      const frame0Path = path.join(tmpDir, "frame-0.png")
      if (fs.existsSync(frame0Path)) {
        const base64 = fs.readFileSync(frame0Path).toString("base64")
        fs.rmSync(tmpDir, { recursive: true, force: true })
        fs.unlinkSync(videoPath)
        return res.json({ ok: true, data: `data:image/png;base64,${base64}` })
      }
      throw new Error("could not extract first frame")
    }

    const base64 = fs.readFileSync(framePath).toString("base64")
    fs.rmSync(tmpDir, { recursive: true, force: true })
    fs.unlinkSync(videoPath)

    res.json({ ok: true, data: `data:image/png;base64,${base64}` })
  } catch (err) {
    console.error("first frame extraction error:", err)
    res.status(500).json({ error: err.message })
  }
})

app.get("/preview", (req, res) =>
  res.sendFile(path.join(__dirname, "public/preview.html")),
)

function parseCoordsFile(filePath) {
  const raw = fs.readFileSync(filePath, "utf8").trim()
  if (!raw) return []
  return raw.split("\n").map((line) => {
    const [x, y] = line.trim().split(/\s+/).map(Number)
    return [x, y]
  })
}

app.get("/api/preview/info", async (req, res) => {
  try {
    const hasBusLayout = fs.existsSync(COORDS_BUS[0])
    const hasBusRender = fs.existsSync(OUTPUT_BIN_BUS[0])

    if (!hasBusLayout && !fs.existsSync(COORDS_PATH))
      return res.json({
        ready: false,
        reason: "No coords saved — set up keyboard layout first",
      })
    if (!hasBusRender && !fs.existsSync(OUTPUT_BIN))
      return res.json({ ready: false, reason: "No video rendered yet" })

    if (hasBusRender) {
      // Multi-bus mode: read per-bus coord and video files
      const bus0CoordsStat = fs.statSync(COORDS_BUS[0])
      const bus0VideoStat = fs.statSync(OUTPUT_BIN_BUS[0])
      if (
        previewCache &&
        previewCache.dualBusMode &&
        previewCache.coordsMtime === bus0CoordsStat.mtimeMs &&
        previewCache.videoMtime === bus0VideoStat.mtimeMs
      ) {
        return res.json({ ready: true, ...previewCache })
      }

      const busCoords = COORDS_BUS.map((busPath) =>
        fs.existsSync(busPath) ? parseCoordsFile(busPath) : [],
      )
      const coords = busCoords.flat()
      const totalLines = await countLines(OUTPUT_BIN_BUS[0])
      const frameCount = Math.max(0, totalLines - 2)

      previewCache = {
        dualBusMode: true,
        coords,
        frameCount,
        ledCount: coords.length,
        busLedCounts: busCoords.map((c) => c.length),
        coordsMtime: bus0CoordsStat.mtimeMs,
        videoMtime: bus0VideoStat.mtimeMs,
      }
      return res.json({ ready: true, ...previewCache })
    }

    // Single-bus fallback (legacy videoFile.txt)
    const cStat = fs.statSync(COORDS_PATH)
    const vStat = fs.statSync(OUTPUT_BIN)
    if (
      previewCache &&
      !previewCache.dualBusMode &&
      previewCache.coordsMtime === cStat.mtimeMs &&
      previewCache.videoMtime === vStat.mtimeMs
    ) {
      return res.json({ ready: true, ...previewCache })
    }

    const coords = parseCoordsFile(COORDS_PATH)
    const totalLines = await countLines(OUTPUT_BIN)
    const frameCount = Math.max(0, totalLines - 2)

    previewCache = {
      dualBusMode: false,
      coords,
      frameCount,
      ledCount: coords.length,
      coordsMtime: cStat.mtimeMs,
      videoMtime: vStat.mtimeMs,
    }
    res.json({ ready: true, ...previewCache })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.get("/api/preview/frames", async (req, res) => {
  try {
    const start = Math.max(0, parseInt(req.query.start) || 0)
    const count = Math.min(100, Math.max(1, parseInt(req.query.count) || 50))

    if (!previewCache) {
      if (!fs.existsSync(OUTPUT_BIN_BUS[0]) && !fs.existsSync(OUTPUT_BIN))
        return res.status(404).json({ error: "video not rendered" })
      return res.status(400).json({ error: "call /api/preview/info first" })
    }

    const { ledCount, frameCount, dualBusMode, busLedCounts } = previewCache
    if (!ledCount) return res.json({ start, frames: [] })

    const clampedCount = Math.min(count, frameCount - start)
    if (clampedCount <= 0) return res.json({ start, frames: [] })

    if (dualBusMode) {
      // Read each bus's frame lines in parallel, then concat per-bus RGB in bus order
      const busLineSets = await Promise.all(
        busLedCounts.map((ledCountForBus, busIndex) =>
          ledCountForBus > 0
            ? readFrameLines(OUTPUT_BIN_BUS[busIndex], start + 1, clampedCount)
            : Promise.resolve([]),
        ),
      )
      const frames = []
      for (let frameIndex = 0; frameIndex < clampedCount; frameIndex++) {
        const mergedRgb = []
        busLedCounts.forEach((ledCountForBus, busIndex) => {
          const line = busLineSets[busIndex][frameIndex]
          if (line && ledCountForBus > 0) {
            mergedRgb.push(...decodeFrame(line, ledCountForBus))
          }
        })
        frames.push(mergedRgb)
      }
      return res.json({ start, frames })
    }

    const rawLines = await readFrameLines(OUTPUT_BIN, start + 1, clampedCount)
    const frames = rawLines.map((line) => decodeFrame(line, ledCount))
    res.json({ start, frames })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.listen(PORT, () => {
  console.log(`RGB keyboard app running on http://localhost:${PORT}`)
})
