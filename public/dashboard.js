const statusPill = document.getElementById("status-pill")
const fpsValue = document.getElementById("fps-value")
const pidValue = document.getElementById("pid-value")
const messageEl = document.getElementById("message")

const startButton = document.getElementById("start-btn")
const stopButton = document.getElementById("stop-btn")
const pauseButton = document.getElementById("pause-btn")
const resumeButton = document.getElementById("resume-btn")
const fadeButton = document.getElementById("fade-btn")

const brightnessInput = document.getElementById("brightness")
const brightnessVal = document.getElementById("brightness-val")
const brightnessWarning = document.getElementById("brightness-warning")

const libraryList = document.getElementById("library-list")
const libraryEmpty = document.getElementById("library-empty")
const importInput = document.getElementById("import-input")

let selectedEntryId = null
let playingEntryId = null

brightnessInput.addEventListener("input", () => {
  brightnessVal.textContent = brightnessInput.value
  brightnessWarning.style.display =
    parseInt(brightnessInput.value, 10) > 1 ? "block" : "none"
})

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

  startButton.disabled = isRunning || isPaused || !selectedEntryId
  stopButton.disabled = state === "stopped"
  pauseButton.disabled = !isRunning
  resumeButton.disabled = !isPaused
  fadeButton.disabled = isRunning || isPaused

  // Track which library entry the player has loaded so the list can highlight it.
  const nextPlayingId = status.entryId || null
  if (nextPlayingId !== playingEntryId) {
    playingEntryId = nextPlayingId
    highlightLibrary()
  }
}

async function requestJson(url, method, body) {
  const response = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
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

async function runAction(url, actionName, body) {
  try {
    const payload = await requestJson(url, "POST", body)
    updateStatusUi(payload)
    setMessage(`${actionName} successful`, "ok")
  } catch (error) {
    setMessage(error.message, "err")
  }
}

startButton.addEventListener("click", () => {
  if (!selectedEntryId) {
    setMessage("Select a render from the library first", "err")
    return
  }
  playEntry(selectedEntryId)
})

function playEntry(entryId) {
  selectedEntryId = entryId
  highlightLibrary()
  runAction("/api/player/start", "Start", {
    id: entryId,
    brightness: parseInt(brightnessInput.value, 10),
  })
}
stopButton.addEventListener("click", () =>
  runAction("/api/player/stop", "Stop"),
)
pauseButton.addEventListener("click", () =>
  runAction("/api/player/pause", "Pause"),
)
resumeButton.addEventListener("click", () =>
  runAction("/api/player/resume", "Resume"),
)
fadeButton.addEventListener("click", () =>
  runAction("/api/player/fade", "Fade test"),
)

// ---- Render library ----------------------------------------------------------

function formatDate(isoString) {
  const date = new Date(isoString)
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString()
}

function highlightLibrary() {
  libraryList.querySelectorAll(".library-item").forEach((item) => {
    const { id } = item.dataset
    item.classList.toggle(
      "selected",
      id === selectedEntryId || id === playingEntryId,
    )
  })
}

function renderLibrary(entries) {
  libraryList.innerHTML = ""
  libraryEmpty.style.display = entries.length === 0 ? "block" : "none"

  entries.forEach((entry) => {
    const item = document.createElement("li")
    item.className = "library-item"
    item.dataset.id = entry.id

    const thumb = entry.hasThumb
      ? `<img src="/api/library/${encodeURIComponent(entry.id)}/thumb" alt="" />`
      : `<span class="thumb-fallback"></span>`

    const ledTotal = (entry.busLedCounts || []).reduce(
      (sum, count) => sum + count,
      0,
    )
    const sub = `${formatDate(entry.createdAt)} · ${entry.frameCount || 0} frames · ${ledTotal} LEDs · ${entry.fps || "?"} fps`

    item.innerHTML = `
      ${thumb}
      <div class="library-meta">
        <span class="name"></span>
        <span class="sub"></span>
      </div>
      <div class="library-actions">
        <button type="button" class="play">Play</button>
        <a class="export" href="/api/library/${encodeURIComponent(entry.id)}/export">Export</a>
        <button type="button" class="delete">Delete</button>
      </div>`

    item.querySelector(".name").textContent = entry.name || entry.id
    item.querySelector(".sub").textContent = sub

    item.addEventListener("click", (event) => {
      if (event.target.closest("a")) return // let export link work normally
      selectedEntryId = entry.id
      highlightLibrary()
      refreshStatus()
    })
    item.querySelector(".play").addEventListener("click", (event) => {
      event.stopPropagation()
      playEntry(entry.id)
    })
    item.querySelector(".delete").addEventListener("click", async (event) => {
      event.stopPropagation()
      if (!confirm(`Delete "${entry.name || entry.id}"?`)) return
      try {
        await requestJson(
          `/api/library/${encodeURIComponent(entry.id)}`,
          "DELETE",
        )
        if (selectedEntryId === entry.id) selectedEntryId = null
        setMessage("Deleted", "ok")
        await loadLibrary()
        refreshStatus()
      } catch (error) {
        setMessage(error.message, "err")
      }
    })

    libraryList.appendChild(item)
  })

  highlightLibrary()
}

async function loadLibrary() {
  try {
    const data = await requestJson("/api/library", "GET")
    playingEntryId = data.playingEntryId || null
    renderLibrary(data.entries || [])
  } catch (error) {
    setMessage(error.message, "err")
  }
}

importInput.addEventListener("change", async (event) => {
  const file = event.target.files[0]
  if (!file) return
  const formData = new FormData()
  formData.append("bundle", file)
  setMessage("Importing…", "")
  try {
    const response = await fetch("/api/library/import", {
      method: "POST",
      body: formData,
    })
    const payload = await response.json()
    if (!response.ok || payload.error) {
      throw new Error(payload.error || "import failed")
    }
    setMessage("Imported", "ok")
    selectedEntryId = payload.id
    await loadLibrary()
  } catch (error) {
    setMessage(error.message, "err")
  } finally {
    importInput.value = ""
  }
})

refreshStatus()
loadLibrary()
setInterval(refreshStatus, 2000)
