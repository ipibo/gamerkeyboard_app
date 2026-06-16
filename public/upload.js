const form = document.getElementById("upload-form")
const brightnessInput = document.getElementById("brightness")
const brightnessVal = document.getElementById("brightness-val")
const progressWrap = document.getElementById("progress-wrap")
const progressBar = document.getElementById("progress-bar")
const progressLabel = document.getElementById("progress-label")
const resultEl = document.getElementById("result")
const framePreview = document.getElementById("frame-preview")
const frameStatus = document.getElementById("frame-status")
const videoInput = form.querySelector('input[name="video"]')
const renderButton = form.querySelector('button[type="submit"]')
const renderHint = document.getElementById("render-hint")

const KEY_RADIUS = 3
const COLORS = ["#9c41f2", "#f241a0", "#41a0f2", "#f2c841", "#41f280"]

console.log("upload.js loaded")

// Rendering is only allowed after a valid first-frame preview is available.
function setRenderButtonState(disabled, hintText = "") {
  renderButton.disabled = disabled
  if (!renderHint) return
  renderHint.textContent = hintText
  renderHint.style.display = disabled && hintText ? "block" : "none"
}

setRenderButtonState(true, "Preview required before rendering")

let previewState = {
  config: null,
  tempCanvas: null,
  zoom: 1,
  isDragging: false,
  dragStartLx: 0,
  dragStartLy: 0,
  dragStartOffsets: [],
  keyboardOffsets: [], // [{offsetX, offsetY}] — mutable, draggable as a group
  layoutKeys: [], // [[[x,y],...]] — key positions per keyboard from layout data
}

// Convert CSS-pixel coords (relative to canvas element) to canvas/layout coords
function screenToLayout(sx, sy) {
  const rect = framePreview.getBoundingClientRect()
  const cx = sx * (framePreview.width / rect.width)
  const cy = sy * (framePreview.height / rect.height)
  const w = framePreview.width
  const h = framePreview.height
  const { zoom } = previewState
  return [(cx - w / 2) / zoom + w / 2, (cy - h / 2) / zoom + h / 2]
}

function redrawPreview() {
  if (!previewState.tempCanvas) return

  const { config, tempCanvas, panX, panY, zoom, keyboardOffsets, layoutKeys } =
    previewState
  const ctx = framePreview.getContext("2d")
  const w = framePreview.width
  const h = framePreview.height

  ctx.fillStyle = "#000"
  ctx.fillRect(0, 0, w, h)

  // Draw video frame fixed — outside transform so drag/zoom don't move it
  const videoScale = Math.min(w / tempCanvas.width, h / tempCanvas.height)
  const scaledW = tempCanvas.width * videoScale
  const scaledH = tempCanvas.height * videoScale
  const vOffX = (w - scaledW) / 2
  const vOffY = (h - scaledH) / 2
  ctx.drawImage(tempCanvas, vOffX, vOffY, scaledW, scaledH)

  if (!config) return

  // Keyboard overlays inside transform so they respond to zoom
  ctx.save()
  ctx.translate(w / 2, h / 2)
  ctx.scale(zoom, zoom)
  ctx.translate(-w / 2, -h / 2)

  // Draw keyboards
  keyboardOffsets.forEach(({ offsetX, offsetY }, i) => {
    const color = COLORS[i % COLORS.length]
    const keys = layoutKeys[i] || []

    if (keys.length > 0) {
      ctx.globalAlpha = 0.9
      ctx.fillStyle = color
      keys.forEach(([kx, ky]) => {
        ctx.beginPath()
        ctx.arc(kx + offsetX, ky + offsetY, KEY_RADIUS, 0, Math.PI * 2)
        ctx.fill()
      })

      // Label above top-left key
      const minKx = Math.min(...keys.map(([x]) => x)) + offsetX
      const minKy = Math.min(...keys.map(([, y]) => y)) + offsetY
      ctx.globalAlpha = 1
      ctx.font = "bold 13px Courier New"
      ctx.fillStyle = color
      ctx.textAlign = "left"
      ctx.textBaseline = "bottom"
      ctx.fillText(config.keyboards[i].name, minKx, minKy - 4)
    } else {
      // Fallback when layout data not available
      ctx.globalAlpha = 0.8
      ctx.strokeStyle = color
      ctx.lineWidth = 3
      ctx.strokeRect(offsetX - 20, offsetY - 20, 350, 150)
      ctx.fillStyle = color
      ctx.globalAlpha = 1
      ctx.beginPath()
      ctx.arc(offsetX, offsetY, 8, 0, Math.PI * 2)
      ctx.fill()
      ctx.font = "bold 13px Courier New"
      ctx.fillStyle = color
      ctx.textAlign = "left"
      ctx.textBaseline = "bottom"
      ctx.fillText(config.keyboards[i].name, offsetX, offsetY - 24)
    }
  })

  // Draw connections
  ctx.globalAlpha = 0.5
  ctx.strokeStyle = "#aaa"
  ctx.lineWidth = 2
  config.connections.forEach(([from, to]) => {
    if (from < keyboardOffsets.length && to < keyboardOffsets.length) {
      ctx.beginPath()
      ctx.moveTo(keyboardOffsets[from].offsetX, keyboardOffsets[from].offsetY)
      ctx.lineTo(keyboardOffsets[to].offsetX, keyboardOffsets[to].offsetY)
      ctx.stroke()
    }
  })

  ctx.globalAlpha = 1
  ctx.restore()
}

// Mouse wheel zoom
framePreview.addEventListener("wheel", (e) => {
  if (!previewState.config) return
  e.preventDefault()
  const zoomFactor = e.deltaY > 0 ? 0.9 : 1.1
  previewState.zoom = Math.max(
    0.1,
    Math.min(10, previewState.zoom * zoomFactor),
  )
  redrawPreview()
})

// Drag moves entire keyboard layout as one unit
framePreview.addEventListener("mousedown", (e) => {
  if (!previewState.config || previewState.keyboardOffsets.length === 0) return
  const rect = framePreview.getBoundingClientRect()
  const [lx, ly] = screenToLayout(e.clientX - rect.left, e.clientY - rect.top)
  previewState.isDragging = true
  previewState.dragStartLx = lx
  previewState.dragStartLy = ly
  previewState.dragStartOffsets = previewState.keyboardOffsets.map((o) => ({
    ...o,
  }))
  framePreview.style.cursor = "grabbing"
})

document.addEventListener("mousemove", (e) => {
  if (!previewState.isDragging || !previewState.config) return
  const rect = framePreview.getBoundingClientRect()
  const [lx, ly] = screenToLayout(e.clientX - rect.left, e.clientY - rect.top)
  const dLx = lx - previewState.dragStartLx
  const dLy = ly - previewState.dragStartLy
  previewState.keyboardOffsets.forEach((kb, i) => {
    kb.offsetX = Math.round(previewState.dragStartOffsets[i].offsetX + dLx)
    kb.offsetY = Math.round(previewState.dragStartOffsets[i].offsetY + dLy)
  })
  redrawPreview()
})

document.addEventListener("mouseup", () => {
  previewState.isDragging = false
  framePreview.style.cursor = "default"
})

const brightnessWarning = document.getElementById("brightness-warning")

brightnessInput.addEventListener("input", () => {
  brightnessVal.textContent = brightnessInput.value
  brightnessWarning.style.display =
    parseInt(brightnessInput.value) > 1 ? "block" : "none"
})

// Handle video file selection for frame extraction
videoInput.addEventListener("change", async (e) => {
  const file = e.target.files[0]
  if (!file) {
    framePreview.style.display = "none"
    frameStatus.style.display = "block"
    frameStatus.textContent = "Upload a video to see preview"
    setRenderButtonState(true, "Preview required before rendering")
    return
  }

  setRenderButtonState(true, "Extracting first frame before rendering")
  frameStatus.style.display = "none"
  frameStatus.style.color = ""

  try {
    const [layoutRes, layoutsRes] = await Promise.all([
      fetch("/api/loadLayout"),
      fetch("/api/layouts"),
    ])
    const config = await layoutRes.json()
    const allLayouts = await layoutsRes.json()

    frameStatus.textContent = "Extracting first frame…"
    frameStatus.style.display = "block"
    const frameFormData = new FormData()
    frameFormData.append("video", file)
    const frameRes = await fetch("/api/extractFirstFrame", {
      method: "POST",
      body: frameFormData,
    })
    const frameData = await frameRes.json()
    if (!frameRes.ok || frameData.error)
      throw new Error(frameData.error || "frame extraction failed")
    frameStatus.style.display = "none"

    const tempCanvas = document.createElement("canvas")
    await new Promise((resolve, reject) => {
      const img = new Image()
      img.onload = () => {
        tempCanvas.width = img.naturalWidth
        tempCanvas.height = img.naturalHeight
        tempCanvas.getContext("2d").drawImage(img, 0, 0)
        resolve()
      }
      img.onerror = reject
      img.src = frameData.data
    })

    framePreview.width = tempCanvas.width
    framePreview.height = tempCanvas.height

    if (config.keyboards && config.keyboards.length > 0) {
      // Scale keyboard positions from setup-canvas space to video-pixel space
      const scaleX = tempCanvas.width / (config.canvasWidth || tempCanvas.width)
      const scaleY =
        tempCanvas.height / (config.canvasHeight || tempCanvas.height)

      previewState.keyboardOffsets = config.keyboards.map((kb) => ({
        offsetX: kb.offsetX * scaleX,
        offsetY: kb.offsetY * scaleY,
      }))
      previewState.layoutKeys = config.keyboards.map((kb) => {
        const layout = allLayouts.find((l) => l.id === kb.layoutId)
        return layout
          ? layout.keys.map(([kx, ky]) => [kx * scaleX, ky * scaleY])
          : []
      })
      previewState.config = config
    }

    previewState.tempCanvas = tempCanvas
    previewState.zoom = 1

    redrawPreview()
    framePreview.style.display = "block"
    setRenderButtonState(false)
  } catch (err) {
    console.error("Error:", err)
    frameStatus.textContent = `Error: ${err.message}`
    frameStatus.style.color = "#f55"
    frameStatus.style.display = "block"
    setRenderButtonState(true, "Preview failed - upload a valid video")
  }
})

// Handle form submission
form.addEventListener("submit", async (e) => {
  e.preventDefault()
  const formData = new FormData(form)

  // Send per-bus video-pixel coords derived from the (possibly adjusted) preview state
  if (
    previewState.config &&
    previewState.keyboardOffsets.length > 0 &&
    previewState.layoutKeys.length > 0
  ) {
    const NUM_BUSES = 4
    const coordsByBus = Array.from({ length: NUM_BUSES }, () => [])
    previewState.keyboardOffsets.forEach(({ offsetX, offsetY }, i) => {
      const keys = previewState.layoutKeys[i] || []
      const rawBus = previewState.config.keyboards[i]?.spiBus || 0
      const spiBus = rawBus >= 0 && rawBus < NUM_BUSES ? rawBus : 0
      const targetBus = coordsByBus[spiBus]
      keys.forEach(([kx, ky]) => targetBus.push([kx + offsetX, ky + offsetY]))
    })
    coordsByBus.forEach((busCoords, busIndex) => {
      formData.append(`coordsBus${busIndex}`, JSON.stringify(busCoords))
    })
    console.log(
      "coords override:",
      coordsByBus.map((c, i) => `bus${i}=${c.length}`).join(" "),
      "LEDs",
    )
  }

  progressWrap.style.display = "flex"
  progressBar.value = 0
  progressLabel.textContent = "Uploading…"
  setRenderButtonState(true, "Rendering in progress")

  let sse = null

  sse = new EventSource("/api/renderProgress")
  sse.onmessage = (ev) => {
    const data = JSON.parse(ev.data)

    if (data.error) {
      progressLabel.textContent = `Error: ${data.error}`
      resultEl.textContent = `Render failed: ${data.error}`
      resultEl.className = "err"
      sse.close()
      setRenderButtonState(false)
      return
    }

    if (data.total > 0) {
      const pct = Math.round((data.current / data.total) * 100)
      progressBar.value = pct
      progressLabel.textContent = `Frame ${data.current} / ${data.total} (${pct}%)`
    } else {
      progressLabel.textContent = "Processing…"
    }

    if (data.done) {
      progressBar.value = 100
      progressLabel.textContent = "Done"
      resultEl.textContent =
        "videoFile_bus0.txt … videoFile_bus3.txt written successfully"
      resultEl.className = "ok"
      sse.close()
      setRenderButtonState(false)
    }
  }

  sse.onerror = () => {
    if (!resultEl.textContent) {
      progressLabel.textContent = "Connection lost"
    }
    sse.close()
    setRenderButtonState(false)
  }

  try {
    const res = await fetch("/api/renderVideo", {
      method: "POST",
      body: formData,
    })
    const data = await res.json()
    if (!res.ok || data.error) {
      throw new Error(data.error || "upload failed")
    }
    progressLabel.textContent = "Render started…"
  } catch (err) {
    sse.close()
    progressWrap.style.display = "none"
    resultEl.textContent = `Error: ${err.message}`
    resultEl.className = "err"
    setRenderButtonState(false)
  }
})
