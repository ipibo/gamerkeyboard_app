/* eslint-disable no-console */
const extractFrame = require("ffmpeg-extract-frames")
const fs = require("fs")
const Jimp = require("jimp")
const probe = require("ffmpeg-probe")
const path = require("path")
const { spawn } = require("child_process")

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

/**
 * Build one LED bitstring line for a single bus by sampling pixels from a raw
 * RGBA frame buffer. No PNG decode — reads bytes directly.
 */
function buildBusLine(frameBuffer, frameWidth, frameHeight, coordinatesOfKeys, byte0) {
  let line = ""
  for (let ledIndex = 0; ledIndex < coordinatesOfKeys.length; ledIndex++) {
    const coordinate = coordinatesOfKeys[ledIndex]
    let pixelX = Math.round(coordinate[0])
    let pixelY = Math.round(coordinate[1])
    if (pixelX < 0) pixelX = 0
    else if (pixelX >= frameWidth) pixelX = frameWidth - 1
    if (pixelY < 0) pixelY = 0
    else if (pixelY >= frameHeight) pixelY = frameHeight - 1

    const pixelOffset = (pixelY * frameWidth + pixelX) * 4
    const red = frameBuffer[pixelOffset]
    const green = frameBuffer[pixelOffset + 1]
    const blue = frameBuffer[pixelOffset + 2]
    const word = (byte0 << 24) | (blue << 16) | (green << 8) | red
    line += (word >>> 0).toString(2).padStart(32, "0")
  }
  return line
}

/**
 * Render all SPI buses in a single pass. ffmpeg streams raw RGBA frames over
 * stdout; each frame is decoded once and sampled for every bus. Avoids PNG
 * encode/decode and re-extracting the video per bus.
 *
 * @param {string} videoPath
 * @param {Array<Array<[number,number]>>} busCoords  coords per bus (video pixel space)
 * @param {string[]} outputPaths  output file per bus, same length as busCoords
 * @param {number} brightness  1..31
 * @param {(current:number, total:number) => void} onProgress
 */
async function processVideoAllBuses(
  videoPath,
  busCoords,
  outputPaths,
  brightness,
  onProgress,
) {
  // Frame geometry from probe.
  let frameWidth = 0
  let frameHeight = 0
  let estimatedFrameCount = 0
  try {
    const info = await probe(videoPath)
    const videoStream = info.streams.find((s) => s.codec_type === "video")
    frameWidth = videoStream.width
    frameHeight = videoStream.height
    const probedCount = parseInt(videoStream.nb_frames, 10)
    if (Number.isFinite(probedCount) && probedCount > 0) {
      estimatedFrameCount = probedCount
    } else {
      const fps =
        parseFpsValue(videoStream.avg_frame_rate) ||
        parseFpsValue(videoStream.r_frame_rate)
      const duration = parseFloat(info.format?.duration || videoStream.duration)
      if (fps && Number.isFinite(duration)) {
        estimatedFrameCount = Math.round(fps * duration)
      }
    }
  } catch (probeError) {
    throw new Error(`Could not probe video geometry: ${probeError.message}`)
  }

  if (!frameWidth || !frameHeight) {
    throw new Error("Video width/height unavailable — cannot sample pixels")
  }

  const frameByteLength = frameWidth * frameHeight * 4
  const byte0 = 0xe0 | (brightness & 0x1f)

  // Open one write stream per bus, start frame up front.
  const busStreams = outputPaths.map((outputPath) => {
    removeFile(outputPath)
    const stream = fs.createWriteStream(outputPath)
    stream.write(START_FRAME + "\n")
    return stream
  })

  console.log(
    `Streaming ${frameWidth}x${frameHeight} frames; buses: ${busCoords
      .map((coords, busIndex) => `bus${busIndex}=${coords.length}`)
      .join(" ")}`,
  )

  const ffmpeg = spawn("ffmpeg", [
    "-i",
    videoPath,
    "-f",
    "rawvideo",
    "-pix_fmt",
    "rgba",
    "-v",
    "error",
    "-",
  ])

  let pending = Buffer.alloc(0)
  let frameIndex = 0
  let ffmpegStderr = ""

  ffmpeg.stderr.on("data", (chunk) => {
    ffmpegStderr += chunk.toString()
  })

  await new Promise((resolve, reject) => {
    ffmpeg.stdout.on("data", (chunk) => {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk

      while (pending.length >= frameByteLength) {
        const frameBuffer = pending.subarray(0, frameByteLength)
        pending = pending.subarray(frameByteLength)

        for (let busIndex = 0; busIndex < busCoords.length; busIndex++) {
          const coords = busCoords[busIndex]
          // Empty buses emit only start+end frames (handled at close).
          if (coords.length === 0) continue
          const line = buildBusLine(
            frameBuffer,
            frameWidth,
            frameHeight,
            coords,
            byte0,
          )
          busStreams[busIndex].write(line + "\n")
        }

        frameIndex++
        if (frameIndex % 100 === 0) {
          onProgress(frameIndex, estimatedFrameCount || frameIndex)
        }
      }
    })

    ffmpeg.on("error", reject)
    ffmpeg.on("close", (code) => {
      if (code !== 0) {
        reject(
          new Error(`ffmpeg exited with code ${code}: ${ffmpegStderr.trim()}`),
        )
      } else {
        resolve()
      }
    })
  })

  // End frame + flush all buses.
  await Promise.all(
    busStreams.map(
      (stream) =>
        new Promise((resolve, reject) => {
          stream.write(END_FRAME + "\n")
          stream.end((err) => (err ? reject(err) : resolve()))
        }),
    ),
  )

  onProgress(frameIndex, frameIndex)
  console.log(`Done. Rendered ${frameIndex} frames across ${outputPaths.length} buses.`)
}

module.exports = { processVideo, processVideoAllBuses, writeVideoMeta }
