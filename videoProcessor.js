/* eslint-disable no-console */
const extractFrame = require("ffmpeg-extract-frames")
const fs = require("fs")
const Jimp = require("jimp")
const probe = require("ffmpeg-probe")
const path = require("path")

const START_FRAME = "0".repeat(32)
const END_FRAME = "1".repeat(32)

function parseFpsValue(rawFps) {
  if (!rawFps) return null

  if (typeof rawFps === "number" && Number.isFinite(rawFps) && rawFps > 0) {
    return rawFps
  }

  if (typeof rawFps === "string") {
    if (rawFps.includes("/")) {
      const [numeratorRaw, denominatorRaw] = rawFps.split("/")
      const numerator = parseFloat(numeratorRaw)
      const denominator = parseFloat(denominatorRaw)
      if (
        Number.isFinite(numerator) &&
        Number.isFinite(denominator) &&
        denominator > 0
      ) {
        return numerator / denominator
      }
    }

    const asNumber = parseFloat(rawFps)
    if (Number.isFinite(asNumber) && asNumber > 0) {
      return asNumber
    }
  }

  return null
}

async function writeVideoMeta(videoPath, outputDir) {
  const defaultFps = 30
  let videoFps = defaultFps
  let frameCount = 0

  try {
    const probeInfo = await probe(videoPath)
    const videoStream = Array.isArray(probeInfo.streams)
      ? probeInfo.streams.find(
          (streamInfo) => streamInfo.codec_type === "video",
        ) || probeInfo.streams[0]
      : null

    const parsedFps =
      parseFpsValue(videoStream?.avg_frame_rate) ||
      parseFpsValue(videoStream?.r_frame_rate)
    if (parsedFps) {
      videoFps = parsedFps
    }

    const parsedFrameCount = parseInt(videoStream?.nb_frames, 10)
    if (Number.isFinite(parsedFrameCount) && parsedFrameCount > 0) {
      frameCount = parsedFrameCount
    }
  } catch (probeError) {
    console.warn(
      `Could not probe video metadata for ${videoPath}: ${probeError.message}`,
    )
  }

  const metaPath = path.join(outputDir, "meta.json")
  const roundedFps = Math.max(1, Math.round(videoFps))
  const meta = {
    fps: roundedFps,
    frameCount,
  }

  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2))
  return meta
}

function makefolder(folder) {
  if (!fs.existsSync(folder)) fs.mkdirSync(folder, { recursive: true })
}

function removeFolder(dir) {
  fs.rmSync(dir, { recursive: true, force: true })
}

function removeFile(filePath) {
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
}

function countExtractedFrames(folder) {
  let count = 0
  while (fs.existsSync(path.join(folder, `frame-${count + 1}.png`))) count++
  return count
}

async function analyseFrame(imagePath, coordinatesOfKeys, brightness) {
  const image = await Jimp.read(imagePath)
  const byte0 = 0xe0 | (brightness & 0x1f)
  return coordinatesOfKeys
    .map((c) => {
      const rgba = Jimp.intToRGBA(
        image.getPixelColor(Math.round(c[0]), Math.round(c[1])),
      )
      const word = (byte0 << 24) | (rgba.b << 16) | (rgba.g << 8) | rgba.r
      return (word >>> 0).toString(2).padStart(32, "0")
    })
    .join("")
}

async function processVideo(
  videoPath,
  coordinatesOfKeys,
  outputPath,
  brightness,
  onProgress,
) {
  const tmpFolder = path.join(
    path.dirname(outputPath),
    `../tmp_${path.basename(outputPath, path.extname(outputPath))}`,
  )
  makefolder(tmpFolder)
  removeFile(outputPath)

  if (coordinatesOfKeys.length === 0) {
    const out = fs.createWriteStream(outputPath)
    out.write(START_FRAME + "\n")
    out.write(END_FRAME + "\n")
    await new Promise((resolve, reject) =>
      out.end((err) => (err ? reject(err) : resolve())),
    )
    onProgress(0, 0)
    console.log(`Zero LEDs — wrote empty output: ${outputPath}`)
    return
  }

  await extractFrame({
    input: videoPath,
    output: path.join(tmpFolder, "frame-%d.png"),
  })

  let numFrames
  try {
    const info = await probe(videoPath)
    numFrames = parseInt(info.streams[0].nb_frames, 10)
    if (!numFrames || isNaN(numFrames)) throw new Error("nb_frames missing")
  } catch {
    numFrames = countExtractedFrames(tmpFolder)
  }

  console.log(
    `Processing ${numFrames} frames, ${coordinatesOfKeys.length} LEDs each`,
  )

  const out = fs.createWriteStream(outputPath)
  out.write(START_FRAME + "\n")

  for (let i = 1; i <= numFrames; i++) {
    const framePath = path.join(tmpFolder, `frame-${i}.png`)
    if (fs.existsSync(framePath)) {
      const frameLine = await analyseFrame(
        framePath,
        coordinatesOfKeys,
        brightness,
      )
      out.write(frameLine + "\n")
    }
    if (i % 100 === 0 || i === numFrames) {
      onProgress(i, numFrames)
    }
  }

  out.write(END_FRAME + "\n")
  await new Promise((resolve, reject) =>
    out.end((err) => (err ? reject(err) : resolve())),
  )

  removeFolder(tmpFolder)
  console.log(`Done. Output: ${outputPath}`)
}

module.exports = { processVideo, writeVideoMeta }
