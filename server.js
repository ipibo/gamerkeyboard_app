/* eslint-disable no-console */
const express = require("express")
const bodyParser = require("body-parser")
const fileUpload = require("express-fileupload")
const fs = require("fs")
const path = require("path")
const { processVideo } = require("./videoProcessor")

const app = express()
const PORT = 3000
const LAYOUTS_DIR = path.join(__dirname, "layouts")
const OUTPUT_DIR = path.join(__dirname, "output")
const UPLOAD_DIR = path.join(__dirname, "upload")
const COORDS_PATH = path.join(OUTPUT_DIR, "coords.txt")
const OUTPUT_BIN = path.join(OUTPUT_DIR, "videoFile.txt")
const LAYOUT_CONFIG_PATH = path.join(OUTPUT_DIR, "layoutConfig.json")

function makefolder(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

makefolder(OUTPUT_DIR)
makefolder(UPLOAD_DIR)

let previewCache = null

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

  const lines = coords.map(([x, y]) => `${x} ${y}`).join("\n")
  try {
    fs.writeFileSync(COORDS_PATH, lines)

    // Save layout config (keyboards positions and connections)
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

app.post("/api/renderVideo", async (req, res) => {
  if (!req.files || !req.files.video) {
    return res.status(400).json({ error: "no video file" })
  }

  const brightness = Math.min(
    31,
    Math.max(1, parseInt(req.body.brightness, 10) || 31),
  )

  if (!fs.existsSync(COORDS_PATH)) {
    return res
      .status(400)
      .json({ error: "no coords saved yet — set up keyboard layout first" })
  }

  // Accept coords override from upload preview (user repositioned keyboards)
  console.log("renderVideo: req.body.coords =", req.body.coords ? `string[${req.body.coords.length}]` : req.body.coords)
  let coordsPath = COORDS_PATH
  let tempCoordsPath = null
  if (req.body.coords) {
    try {
      const coordsArray = JSON.parse(req.body.coords)
      if (Array.isArray(coordsArray) && coordsArray.length > 0) {
        tempCoordsPath = path.join(UPLOAD_DIR, "coords_render_tmp.txt")
        fs.writeFileSync(tempCoordsPath, coordsArray.map(([x, y]) => `${x} ${y}`).join("\n"))
        coordsPath = tempCoordsPath
      }
    } catch {
      // fall back to saved coords
    }
  }

  // Save uploaded video to upload/
  const ext = path.extname(req.files.video.name) || ".mp4"
  const videoPath = path.join(UPLOAD_DIR, `video${ext}`)
  await req.files.video.mv(videoPath)

  renderState = null
  previewCache = null

  res.json({ ok: true, message: "render started" })

  // Process asynchronously after responding
  setImmediate(async () => {
    try {
      emitProgress({ current: 0, total: 0, done: false })
      await processVideo(
        videoPath,
        coordsPath,
        OUTPUT_BIN,
        brightness,
        (current, total) => {
          emitProgress({ current, total, done: false })
        },
      )
      emitProgress({ current: 1, total: 1, done: true, output: OUTPUT_BIN })
    } catch (err) {
      console.error("render error:", err)
      emitProgress({ error: err.message, done: true })
    } finally {
      if (tempCoordsPath && fs.existsSync(tempCoordsPath)) fs.unlinkSync(tempCoordsPath)
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

app.get("/api/preview/info", async (req, res) => {
  try {
    if (!fs.existsSync(COORDS_PATH))
      return res.json({ ready: false, reason: "No coords saved — set up keyboard layout first" })
    if (!fs.existsSync(OUTPUT_BIN))
      return res.json({ ready: false, reason: "No video rendered yet" })

    const cStat = fs.statSync(COORDS_PATH)
    const vStat = fs.statSync(OUTPUT_BIN)
    if (
      previewCache &&
      previewCache.coordsMtime === cStat.mtimeMs &&
      previewCache.videoMtime === vStat.mtimeMs
    ) {
      return res.json({ ready: true, ...previewCache })
    }

    const rawCoords = fs.readFileSync(COORDS_PATH, "utf8").trim().split("\n")
    const coords = rawCoords.map((line) => {
      const [x, y] = line.trim().split(/\s+/).map(Number)
      return [x, y]
    })
    const totalLines = await countLines(OUTPUT_BIN)
    const frameCount = Math.max(0, totalLines - 2)

    previewCache = {
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
      if (!fs.existsSync(OUTPUT_BIN))
        return res.status(404).json({ error: "video not rendered" })
      return res.status(400).json({ error: "call /api/preview/info first" })
    }

    const { ledCount, frameCount } = previewCache
    if (!ledCount) return res.json({ start, frames: [] })

    const clampedCount = Math.min(count, frameCount - start)
    if (clampedCount <= 0) return res.json({ start, frames: [] })

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
