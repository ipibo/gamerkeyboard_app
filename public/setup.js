/* Keyboard layout editor — vanilla canvas, no p5.js dependency */

const canvas = document.getElementById("canvas")
const ctx = canvas.getContext("2d")
const layoutSelect = document.getElementById("layout-select")
const addBtn = document.getElementById("add-btn")
const removeBtn = document.getElementById("remove-btn")
const saveBtn = document.getElementById("save-btn")
const statusEl = document.getElementById("status")
const kbWidthInput = document.getElementById("kb-width")
const kbHeightInput = document.getElementById("kb-height")
const busToggleWrap = document.getElementById("bus-toggle-wrap")
const busSelect = document.getElementById("bus-select")

// Each entry: { keys: [[x,y],...], offsetX, offsetY, name, order, spiBus }
let keyboards = []
let availableLayouts = []

// Connection state: [ [from, to], [from, to], ... ]
let connections = []

// Drag state
let dragging = null // index into keyboards[]
let dragStartX = 0
let dragStartY = 0
let dragOffsetX = 0
let dragOffsetY = 0
let selected = null // index of selected keyboard
let connecting = null // index of keyboard being connected FROM
let connectTo = null // index being connected TO (preview)

const KEY_RADIUS = 5
const BUS_COLORS = {
  0: ["#f2c841", "#f28b41", "#f26841", "#f2414e", "#f2a841"],
  1: ["#41a0f2", "#4169f2", "#9c41f2", "#41d4f2", "#41f2c8"],
}

function setStatus(msg, isError) {
  statusEl.textContent = msg
  statusEl.style.color = isError ? "#f55" : "#888"
}

function updateSizeInputs() {
  if (selected !== null && selected < keyboards.length) {
    const kb = keyboards[selected]
    kbWidthInput.value = kb.width || 100
    kbHeightInput.value = kb.height || 100
  }
}

function updateBusToggle() {
  if (selected !== null && selected < keyboards.length) {
    busToggleWrap.style.display = "flex"
    busSelect.value = String(keyboards[selected].spiBus || 0)
  } else {
    busToggleWrap.style.display = "none"
  }
}

function updateCanvasSize() {
  const width = parseInt(kbWidthInput.value) || 1400
  const height = parseInt(kbHeightInput.value) || 600
  canvas.width = width
  canvas.height = height
  draw()
}

// Get center point of a keyboard
function getKeyboardCenter(kb) {
  if (kb.keys.length === 0) return { x: kb.offsetX, y: kb.offsetY }
  let sumX = 0,
    sumY = 0
  kb.keys.forEach(([x, y]) => {
    sumX += x + kb.offsetX
    sumY += y + kb.offsetY
  })
  return { x: sumX / kb.keys.length, y: sumY / kb.keys.length }
}

// Load layouts from server
fetch("/api/layouts")
  .then((r) => r.json())
  .then((layouts) => {
    availableLayouts = layouts
    layoutSelect.innerHTML = layouts
      .map(
        (l) =>
          `<option value="${l.id}">${l.name} (${l.keys.length} keys)</option>`,
      )
      .join("")

    // After loading available layouts, load the saved layout configuration
    return fetch("/api/loadLayout")
  })
  .then((r) => r.json())
  .then((config) => {
    // Restore canvas size if it was saved
    if (config.canvasWidth && config.canvasHeight) {
      canvas.width = config.canvasWidth
      canvas.height = config.canvasHeight
      kbWidthInput.value = config.canvasWidth
      kbHeightInput.value = config.canvasHeight
    }

    // Reconstruct keyboards from saved config
    if (config.keyboards && config.keyboards.length > 0) {
      config.keyboards.forEach((kbData) => {
        const layout = availableLayouts.find((l) => l.id === kbData.layoutId)
        if (layout) {
          keyboards.push({
            keys: layout.keys,
            offsetX: kbData.offsetX,
            offsetY: kbData.offsetY,
            name: kbData.name,
            order: kbData.order,
            spiBus: kbData.spiBus || 0,
          })
        }
      })

      // Load connections
      if (config.connections) {
        connections = config.connections
      }

      if (keyboards.length > 0) {
        setStatus(
          `loaded ${keyboards.length} keyboards, ${connections.length} connections`,
        )
        draw()
      }
    }
  })
  .catch((err) => setStatus("failed to load data: " + err.message, true))

// Initialize canvas size inputs
kbWidthInput.value = canvas.width
kbHeightInput.value = canvas.height

addBtn.addEventListener("click", () => {
  const id = layoutSelect.value
  const layout = availableLayouts.find((l) => l.id === id)
  if (!layout) return setStatus("select a layout first", true)
  keyboards.push({
    keys: layout.keys,
    offsetX: 20 + keyboards.length * 30,
    offsetY: 20,
    name: layout.name,
    order: keyboards.length,
    spiBus: 0,
  })
  selected = keyboards.length - 1
  updateBusToggle()
  draw()
  setStatus(`added ${layout.name}`)
})

removeBtn.addEventListener("click", () => {
  if (selected === null) return setStatus("select a keyboard first", true)

  // Remove connections involving this keyboard
  connections = connections.filter(
    ([from, to]) => from !== selected && to !== selected,
  )

  // Adjust connection indices for keyboards after the removed one
  connections = connections.map(([from, to]) => [
    from > selected ? from - 1 : from,
    to > selected ? to - 1 : to,
  ])

  keyboards.splice(selected, 1)

  // Re-order keyboards
  keyboards.forEach((kb, i) => {
    kb.order = i
  })

  selected = null
  updateBusToggle()
  draw()
  setStatus("removed")
})

saveBtn.addEventListener("click", () => {
  if (keyboards.length === 0) return setStatus("no keyboards placed", true)
  const coords = []
  keyboards.forEach((kb) => {
    kb.keys.forEach(([x, y]) => coords.push([x + kb.offsetX, y + kb.offsetY]))
  })
  setStatus("saving…")
  fetch("/api/saveLayout", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      coords,
      canvasWidth: canvas.width,
      canvasHeight: canvas.height,
      keyboards: keyboards.map((kb, i) => {
        const layout = availableLayouts.find((l) => l.keys === kb.keys)
        return {
          index: i,
          order: kb.order,
          name: kb.name,
          layoutId: layout ? layout.id : "unknown",
          offsetX: kb.offsetX,
          offsetY: kb.offsetY,
          spiBus: kb.spiBus || 0,
        }
      }),
      connections,
    }),
  })
    .then((r) => r.json())
    .then((data) => {
      if (data.error) throw new Error(data.error)
      setStatus(
        `saved ${data.count} key positions, ${connections.length} connections`,
      )
    })
    .catch((err) => setStatus(`save failed: ${err.message}`, true))
})

// Handle canvas size changes
kbWidthInput.addEventListener("change", () => {
  updateCanvasSize()
  setStatus(`canvas width set to ${canvas.width}`)
})

kbHeightInput.addEventListener("change", () => {
  updateCanvasSize()
  setStatus(`canvas height set to ${canvas.height}`)
})

busSelect.addEventListener("change", () => {
  if (selected !== null && selected < keyboards.length) {
    keyboards[selected].spiBus = parseInt(busSelect.value, 10)
    draw()
  }
})

function draw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  ctx.fillStyle = "#161616"
  ctx.fillRect(0, 0, canvas.width, canvas.height)

  // Draw connections first (so they appear behind keyboards)
  connections.forEach(([from, to]) => {
    if (from < keyboards.length && to < keyboards.length) {
      const fromCenter = getKeyboardCenter(keyboards[from])
      const toCenter = getKeyboardCenter(keyboards[to])
      ctx.strokeStyle = "#444"
      ctx.lineWidth = 2
      ctx.setLineDash([4, 4])
      ctx.beginPath()
      ctx.moveTo(fromCenter.x, fromCenter.y)
      ctx.lineTo(toCenter.x, toCenter.y)
      ctx.stroke()
      ctx.setLineDash([])

      // Draw arrow head
      const angle = Math.atan2(
        toCenter.y - fromCenter.y,
        toCenter.x - fromCenter.x,
      )
      const headlen = 15
      ctx.strokeStyle = "#666"
      ctx.beginPath()
      ctx.moveTo(
        toCenter.x - headlen * Math.cos(angle - Math.PI / 6),
        toCenter.y - headlen * Math.sin(angle - Math.PI / 6),
      )
      ctx.lineTo(toCenter.x, toCenter.y)
      ctx.lineTo(
        toCenter.x - headlen * Math.cos(angle + Math.PI / 6),
        toCenter.y - headlen * Math.sin(angle + Math.PI / 6),
      )
      ctx.stroke()
    }
  })

  // Draw connection preview line while connecting
  if (connecting !== null && connectTo !== null) {
    const fromCenter = getKeyboardCenter(keyboards[connecting])
    const toCenter = getKeyboardCenter(keyboards[connectTo])
    ctx.strokeStyle = "#9c41f2"
    ctx.lineWidth = 2.5
    ctx.setLineDash([2, 2])
    ctx.beginPath()
    ctx.moveTo(fromCenter.x, fromCenter.y)
    ctx.lineTo(toCenter.x, toCenter.y)
    ctx.stroke()
    ctx.setLineDash([])
  }

  keyboards.forEach((kb, kbIndex) => {
    const busColors = BUS_COLORS[kb.spiBus] || BUS_COLORS[0]
    const color = busColors[kbIndex % busColors.length]
    const isSelected = kbIndex === selected

    // bounding box
    if (isSelected) {
      const xs = kb.keys.map(([x]) => x + kb.offsetX)
      const ys = kb.keys.map(([, y]) => y + kb.offsetY)
      const minX = Math.min(...xs) - 10
      const minY = Math.min(...ys) - 10
      const maxX = Math.max(...xs) + 10
      const maxY = Math.max(...ys) + 10
      ctx.strokeStyle = color
      ctx.lineWidth = 1.5
      ctx.setLineDash([4, 4])
      ctx.strokeRect(minX, minY, maxX - minX, maxY - minY)
      ctx.setLineDash([])
    }

    kb.keys.forEach(([x, y]) => {
      ctx.beginPath()
      ctx.arc(x + kb.offsetX, y + kb.offsetY, KEY_RADIUS, 0, Math.PI * 2)
      ctx.fillStyle = isSelected ? color : color + "88"
      ctx.fill()
    })

    // label with order
    ctx.fillStyle = color
    ctx.font = "11px Courier New"
    ctx.fillText(
      `${kb.name} [${kbIndex}] B${kb.spiBus || 0}`,
      kb.offsetX + 2,
      kb.offsetY - 2,
    )
  })
}

draw()

// Hit-test: which keyboard contains point (px, py)?
function hitTest(px, py) {
  for (let i = keyboards.length - 1; i >= 0; i--) {
    const kb = keyboards[i]
    for (const [x, y] of kb.keys) {
      const dx = px - (x + kb.offsetX)
      const dy = py - (y + kb.offsetY)
      if (Math.sqrt(dx * dx + dy * dy) < 12) return i
    }
  }
  return null
}

canvas.addEventListener("mousedown", (e) => {
  const rect = canvas.getBoundingClientRect()
  const px = e.clientX - rect.left
  const py = e.clientY - rect.top
  const hit = hitTest(px, py)

  // Right-click or Ctrl/Cmd + Click: connect keyboards
  if ((e.button === 2 || e.ctrlKey || e.metaKey) && hit !== null) {
    if (connecting === null) {
      connecting = hit
      canvas.style.cursor = "crosshair"
      setStatus(`connecting from keyboard ${hit}…`)
      draw()
    } else if (connecting !== hit) {
      // Complete the connection
      const conn = [connecting, hit]
      if (!connections.some(([a, b]) => a === conn[0] && b === conn[1])) {
        connections.push(conn)
        setStatus(`connected ${connecting} → ${hit}`)
      } else {
        setStatus("connection already exists")
      }
      connecting = null
      connectTo = null
      canvas.style.cursor = "crosshair"
      draw()
    }
    e.preventDefault()
    return
  }

  // Left-click: drag/select
  if (hit !== null) {
    dragging = hit
    selected = hit
    dragStartX = px
    dragStartY = py
    dragOffsetX = keyboards[hit].offsetX
    dragOffsetY = keyboards[hit].offsetY
    canvas.style.cursor = "grabbing"
    updateBusToggle()
    draw()
  } else {
    selected = null
    connecting = null
    connectTo = null
    updateBusToggle()
    draw()
  }
})

canvas.addEventListener("mousemove", (e) => {
  const rect = canvas.getBoundingClientRect()
  const px = e.clientX - rect.left
  const py = e.clientY - rect.top
  const hit = hitTest(px, py)

  // Update connection preview
  if (connecting !== null && hit !== null && hit !== connecting) {
    connectTo = hit
    draw()
  } else if (connecting !== null && (hit === null || hit === connecting)) {
    connectTo = null
    draw()
  }

  // Drag keyboard
  if (dragging === null) return
  keyboards[dragging].offsetX = dragOffsetX + (px - dragStartX)
  keyboards[dragging].offsetY = dragOffsetY + (py - dragStartY)
  draw()
})

canvas.addEventListener("mouseup", () => {
  dragging = null
  canvas.style.cursor = "crosshair"
})

canvas.addEventListener("mouseleave", () => {
  dragging = null
  connectTo = null
  canvas.style.cursor = "crosshair"
})

canvas.addEventListener("contextmenu", (e) => {
  e.preventDefault()
})

// Arrow keys for fine adjustment
document.addEventListener("keydown", (e) => {
  if (selected === null) return
  const step = e.shiftKey ? 10 : 1
  const kb = keyboards[selected]
  if (e.key === "ArrowLeft") kb.offsetX -= step
  else if (e.key === "ArrowRight") kb.offsetX += step
  else if (e.key === "ArrowUp") kb.offsetY -= step
  else if (e.key === "ArrowDown") kb.offsetY += step
  else if (e.key === "c" && e.ctrlKey) {
    // Ctrl+C: copy selected keyboard
    e.preventDefault()
    if (selected !== null) {
      const kb = keyboards[selected]
      keyboards.push({
        keys: kb.keys.map((k) => [...k]),
        offsetX: kb.offsetX + 50,
        offsetY: kb.offsetY + 50,
        name: kb.name + " (copy)",
        order: keyboards.length,
        spiBus: kb.spiBus || 0,
      })
      selected = keyboards.length - 1
      updateBusToggle()
      draw()
      setStatus("keyboard copied")
    }
    return
  } else if (e.key === "Backspace" && connecting === null) {
    // Backspace: delete selected keyboard
    e.preventDefault()
    removeBtn.click()
    return
  } else if (e.key === "Escape") {
    // Escape: cancel connection
    connecting = null
    connectTo = null
    canvas.style.cursor = "crosshair"
    draw()
    return
  } else {
    return
  }
  e.preventDefault()
  draw()
})
