const statusPill = document.getElementById("status-pill")
const fpsValue = document.getElementById("fps-value")
const pidValue = document.getElementById("pid-value")
const messageEl = document.getElementById("message")

const startButton = document.getElementById("start-btn")
const stopButton = document.getElementById("stop-btn")
const pauseButton = document.getElementById("pause-btn")
const resumeButton = document.getElementById("resume-btn")

function setMessage(text, type) {
  messageEl.textContent = text || ""
  messageEl.className = type || ""
}

function updateStatusUi(status) {
  const state = status.state || "stopped"
  statusPill.textContent = state
  statusPill.className = `status-pill state-${state}`

  fpsValue.textContent = status.fps || 30
  pidValue.textContent = status.pid || "-"

  const isRunning = state === "running"
  const isPaused = state === "paused"

  startButton.disabled = isRunning || isPaused
  stopButton.disabled = state === "stopped"
  pauseButton.disabled = !isRunning
  resumeButton.disabled = !isPaused
}

async function requestJson(url, method) {
  const response = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
  })
  const payload = await response.json()
  if (!response.ok || payload.error) {
    throw new Error(payload.error || `Request failed: ${response.status}`)
  }
  return payload
}

async function refreshStatus() {
  try {
    const status = await requestJson("/api/player/status", "GET")
    updateStatusUi(status)
  } catch (error) {
    setMessage(error.message, "err")
  }
}

async function runAction(url, actionName) {
  try {
    const payload = await requestJson(url, "POST")
    updateStatusUi(payload)
    setMessage(`${actionName} successful`, "ok")
  } catch (error) {
    setMessage(error.message, "err")
  }
}

startButton.addEventListener("click", () =>
  runAction("/api/player/start", "Start"),
)
stopButton.addEventListener("click", () =>
  runAction("/api/player/stop", "Stop"),
)
pauseButton.addEventListener("click", () =>
  runAction("/api/player/pause", "Pause"),
)
resumeButton.addEventListener("click", () =>
  runAction("/api/player/resume", "Resume"),
)

refreshStatus()
setInterval(refreshStatus, 2000)
