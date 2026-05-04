const state = {
  coords: [],
  frameCount: 0,
  ledCount: 0,
  currentFrame: 0,
  playing: false,
  fps: 25,
  speedMultiplier: 1,
  lastTickTs: null,
  frameBuffer: new Map(),
  fetchInFlight: false,
  BATCH_SIZE: 50,
  scale: 1,
  zoomMultiplier: 1,
  glowEnabled: true,
  bounds: { w: 0, h: 0 },
  canvas: null,
  ctx: null,
}

// DOM refs
let btnPlay, frameSlider, frameLabel, speedSelect, zoomSlider, zoomLabel,
    statusText, notReady, notReadyMsg

function updateScale() {
  const wrap = document.getElementById("canvas-wrap")
  const availW = wrap.clientWidth - 40
  const availH = wrap.clientHeight - 40
  const fitScale = Math.min(availW / state.bounds.w, availH / state.bounds.h)
  state.scale = fitScale * state.zoomMultiplier
  state.canvas.width = Math.round(state.bounds.w * state.scale)
  state.canvas.height = Math.round(state.bounds.h * state.scale)
}

function updateSlider() {
  frameSlider.value = state.currentFrame
  frameLabel.textContent = `${state.currentFrame + 1} / ${state.frameCount}`
}

function renderFrame(frameIndex) {
  const rgb = state.frameBuffer.get(frameIndex)
  if (!rgb) return

  const { ctx, coords, scale, glowEnabled } = state
  const w = state.canvas.width
  const h = state.canvas.height
  const r = 5 * scale

  ctx.fillStyle = "#000"
  ctx.fillRect(0, 0, w, h)

  for (let i = 0; i < coords.length; i++) {
    const R = rgb[i * 3]
    const G = rgb[i * 3 + 1]
    const B = rgb[i * 3 + 2]
    if (R === 0 && G === 0 && B === 0) continue

    const cx = coords[i][0] * scale
    const cy = coords[i][1] * scale
    const color = `rgb(${R},${G},${B})`

    ctx.shadowBlur = glowEnabled ? 15 * scale : 0
    ctx.shadowColor = color
    ctx.fillStyle = color
    ctx.beginPath()
    ctx.arc(cx, cy, r, 0, Math.PI * 2)
    ctx.fill()
  }

  ctx.shadowBlur = 0
  updateSlider()
}

async function fetchBatch(startFrame) {
  if (state.fetchInFlight) return
  state.fetchInFlight = true
  try {
    const res = await fetch(
      `/api/preview/frames?start=${startFrame}&count=${state.BATCH_SIZE}`,
    )
    const data = await res.json()
    data.frames.forEach((rgb, i) => {
      state.frameBuffer.set(startFrame + i, rgb)
    })

    // Evict oldest frames beyond 150 to cap memory
    if (state.frameBuffer.size > 150) {
      const keys = [...state.frameBuffer.keys()].sort((a, b) => a - b)
      keys.slice(0, state.frameBuffer.size - 150).forEach((k) =>
        state.frameBuffer.delete(k),
      )
    }

    if (startFrame === 0 && state.frameBuffer.has(0)) {
      renderFrame(0)
      statusText.textContent = `Frame 1 / ${state.frameCount}`
    }
  } finally {
    state.fetchInFlight = false
  }
}

function maybePrefetch() {
  if (state.fetchInFlight) return
  // Find highest buffered frame at or beyond current
  let maxBuffered = state.currentFrame - 1
  state.frameBuffer.forEach((_, k) => {
    if (k >= state.currentFrame && k > maxBuffered) maxBuffered = k
  })
  const gap = maxBuffered - state.currentFrame
  if (gap < state.BATCH_SIZE * 0.5) {
    const nextStart = maxBuffered + 1
    if (nextStart < state.frameCount) fetchBatch(nextStart)
  }
}

function animLoop(ts) {
  if (!state.playing) return

  if (state.lastTickTs === null) state.lastTickTs = ts

  const elapsed = ts - state.lastTickTs
  const frameDuration = 1000 / (state.fps * state.speedMultiplier)

  if (elapsed >= frameDuration) {
    const framesAdv = Math.floor(elapsed / frameDuration)
    state.lastTickTs = ts - (elapsed % frameDuration)
    const next = state.currentFrame + framesAdv

    if (next >= state.frameCount) {
      state.currentFrame = state.frameCount - 1
      state.playing = false
      btnPlay.textContent = "Play"
      btnPlay.classList.remove("active")
      renderFrame(state.currentFrame)
      return
    }

    state.currentFrame = next
    maybePrefetch()

    if (state.frameBuffer.has(state.currentFrame)) {
      renderFrame(state.currentFrame)
      statusText.textContent = `Frame ${state.currentFrame + 1} / ${state.frameCount}`
    } else {
      statusText.textContent = "Buffering…"
      state.lastTickTs = ts
    }
  }

  requestAnimationFrame(animLoop)
}

function togglePlay() {
  state.playing = !state.playing
  state.lastTickTs = null
  btnPlay.textContent = state.playing ? "Pause" : "Play"
  btnPlay.classList.toggle("active", state.playing)
  if (state.playing) requestAnimationFrame(animLoop)
}

async function init() {
  btnPlay = document.getElementById("btn-play")
  frameSlider = document.getElementById("frame-slider")
  frameLabel = document.getElementById("frame-label")
  speedSelect = document.getElementById("speed-select")
  zoomSlider = document.getElementById("zoom-slider")
  zoomLabel = document.getElementById("zoom-label")
  statusText = document.getElementById("status-text")
  notReady = document.getElementById("not-ready")
  notReadyMsg = document.getElementById("not-ready-msg")
  state.canvas = document.getElementById("preview-canvas")
  state.ctx = state.canvas.getContext("2d")

  let info
  try {
    const res = await fetch("/api/preview/info")
    info = await res.json()
  } catch {
    statusText.textContent = "Error loading info"
    return
  }

  if (!info.ready) {
    notReadyMsg.textContent = info.reason
    notReady.classList.add("visible")
    statusText.textContent = "Not ready"
    return
  }

  state.coords = info.coords
  state.frameCount = info.frameCount
  state.ledCount = info.ledCount

  const xs = info.coords.map((c) => c[0])
  const ys = info.coords.map((c) => c[1])
  state.bounds.w = Math.max(...xs) + 30
  state.bounds.h = Math.max(...ys) + 30

  updateScale()

  frameSlider.max = info.frameCount - 1
  frameLabel.textContent = `1 / ${info.frameCount}`
  btnPlay.disabled = false
  frameSlider.disabled = false

  statusText.textContent = "Fetching first batch…"
  await fetchBatch(0)

  // Controls
  btnPlay.addEventListener("click", togglePlay)

  frameSlider.addEventListener("input", () => {
    state.currentFrame = parseInt(frameSlider.value)
    state.lastTickTs = null
    maybePrefetch()
    if (state.frameBuffer.has(state.currentFrame)) {
      renderFrame(state.currentFrame)
      statusText.textContent = `Frame ${state.currentFrame + 1} / ${state.frameCount}`
    } else {
      statusText.textContent = "Buffering…"
      fetchBatch(state.currentFrame)
    }
  })

  speedSelect.addEventListener("change", () => {
    state.speedMultiplier = parseFloat(speedSelect.value)
    state.lastTickTs = null
  })

  zoomSlider.addEventListener("input", () => {
    state.zoomMultiplier = parseFloat(zoomSlider.value)
    zoomLabel.textContent = `${state.zoomMultiplier.toFixed(1)}×`
    updateScale()
    renderFrame(state.currentFrame)
  })

  document.getElementById("btn-glow").addEventListener("click", function () {
    state.glowEnabled = !state.glowEnabled
    this.classList.toggle("active", state.glowEnabled)
    renderFrame(state.currentFrame)
  })

  document.addEventListener("keydown", (e) => {
    if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT") return
    if (e.key === " ") {
      e.preventDefault()
      togglePlay()
    } else if (e.key === "ArrowRight") {
      e.preventDefault()
      state.currentFrame = Math.min(state.currentFrame + 1, state.frameCount - 1)
      if (state.frameBuffer.has(state.currentFrame)) renderFrame(state.currentFrame)
      else statusText.textContent = "Buffering…"
      maybePrefetch()
    } else if (e.key === "ArrowLeft") {
      e.preventDefault()
      state.currentFrame = Math.max(state.currentFrame - 1, 0)
      if (state.frameBuffer.has(state.currentFrame)) renderFrame(state.currentFrame)
    }
  })

  let resizeTimer
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer)
    resizeTimer = setTimeout(() => {
      updateScale()
      renderFrame(state.currentFrame)
    }, 100)
  })
}

document.addEventListener("DOMContentLoaded", init)
