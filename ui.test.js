'use strict'

const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { spawn } = require('node:child_process')

const VIEWER = path.join(__dirname, 'board-viewer.js')

// PORT_A: server inside 'my-project' parent dir (title test)
// PORT_B: server inside 'MY-cool_repo' parent dir (title test)
// PORT_G: standard server with transitions (pool controls, colours, animation, modal)
const PORT_A = 13940
const PORT_B = 13941
const PORT_G = 13942

let serverA, serverB, serverG, tmpBase

// ── Helpers ───────────────────────────────────────────────────────────────────

function waitForServer (port, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeout
    function try_ () {
      const req = http.request({ hostname: 'localhost', port, path: '/', method: 'GET' }, res => {
        res.resume(); resolve()
      })
      req.on('error', () => {
        if (Date.now() > deadline) return reject(new Error('Server timed out on port ' + port))
        setTimeout(try_, 100)
      })
      req.end()
    }
    try_()
  })
}

function get (port, urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: 'localhost', port, path: urlPath, method: 'GET' }, res => {
      let data = ''
      res.on('data', c => data += c)
      res.on('end', () => resolve({ status: res.statusCode, body: data }))
    })
    req.on('error', reject)
    req.end()
  })
}

function hexToHsl (hex) {
  const r = parseInt(hex.slice(1, 3), 16) / 255
  const g = parseInt(hex.slice(3, 5), 16) / 255
  const b = parseInt(hex.slice(5, 7), 16) / 255
  const max = Math.max(r, g, b), min = Math.min(r, g, b)
  const l = (max + min) / 2
  if (max === min) return { h: 0, s: 0, l: l * 100 }
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6
  else if (max === g) h = ((b - r) / d + 2) / 6
  else h = ((r - g) / d + 4) / 6
  return { h: h * 360, s: s * 100, l: l * 100 }
}

// ── Setup ─────────────────────────────────────────────────────────────────────

before(async () => {
  tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-ui-'))

  const boardA = path.join(tmpBase, 'my-project', '.board')
  fs.mkdirSync(boardA, { recursive: true })
  fs.writeFileSync(path.join(boardA, 'config.json'), JSON.stringify({ columns: ['backlog', 'done'], transitions: [] }))

  const boardB = path.join(tmpBase, 'MY-cool_repo', '.board')
  fs.mkdirSync(boardB, { recursive: true })
  fs.writeFileSync(path.join(boardB, 'config.json'), JSON.stringify({ columns: ['backlog', 'done'], transitions: [] }))

  const boardG = path.join(tmpBase, 'general')
  fs.mkdirSync(path.join(boardG, 'commands'), { recursive: true })
  fs.writeFileSync(path.join(boardG, 'commands', 'done.md'), 'Fake agent\n')
  fs.writeFileSync(path.join(boardG, 'config.json'), JSON.stringify({
    columns: ['backlog', 'todo', 'done', 'blocked'],
    transitions: [{ from: 'todo', to: 'done', agent: 'done' }]
  }))
  for (const col of ['backlog', 'todo', 'done', 'blocked']) fs.mkdirSync(path.join(boardG, col), { recursive: true })

  serverA = spawn(process.execPath, [VIEWER, boardA, String(PORT_A)], { stdio: 'ignore' })
  serverB = spawn(process.execPath, [VIEWER, boardB, String(PORT_B)], { stdio: 'ignore' })
  serverG = spawn(process.execPath, [VIEWER, boardG, String(PORT_G)], { stdio: 'ignore' })

  await Promise.all([waitForServer(PORT_A), waitForServer(PORT_B), waitForServer(PORT_G)])
})

after(() => {
  if (serverA) serverA.kill()
  if (serverB) serverB.kill()
  if (serverG) serverG.kill()
  try { fs.rmSync(tmpBase, { recursive: true, force: true }) } catch {}
})

// ── Page title and heading ────────────────────────────────────────────────────

test('HTML title and h1 are derived from the parent directory name of the board dir', async () => {
  const html = (await get(PORT_A, '/')).body
  assert.match(html, /<title>My Project<\/title>/, 'title must be "My Project"')
  assert.match(html, /<h1[^>]*>My Project<\/h1>/, 'h1 must be "My Project"')
})

test('hyphens and underscores in the directory name are replaced with spaces and title-cased', async () => {
  const html = (await get(PORT_B, '/')).body
  assert.match(html, /<title>My Cool Repo<\/title>/, 'title must be "My Cool Repo"')
  assert.match(html, /<h1[^>]*>My Cool Repo<\/h1>/, 'h1 must be "My Cool Repo"')
})

// ── Column colours ────────────────────────────────────────────────────────────

test('DEFAULT_COLORS are all in the blue-to-pink spectrum (hue 185°–360°, saturation ≥ 60%) and has at least 8 entries', () => {
  const src = fs.readFileSync(path.join(__dirname, 'board-viewer.js'), 'utf8')
  const m = src.match(/const DEFAULT_COLORS\s*=\s*(\[[^\]]+\])/)
  assert.ok(m, 'DEFAULT_COLORS must exist in board-viewer.js')
  const colors = JSON.parse(m[1].replace(/'/g, '"'))
  assert.ok(colors.length >= 8, 'DEFAULT_COLORS must have at least 8 entries')
  for (const hex of colors) {
    const { h, s } = hexToHsl(hex)
    assert.ok(h >= 185 && h <= 360, `${hex} hue ${h.toFixed(1)}° must be in [185°, 360°]`)
    assert.ok(s >= 60, `${hex} saturation ${s.toFixed(1)}% must be ≥ 60%`)
  }
})

test('/api/config returns column colors within the blue-to-pink spectrum', async () => {
  const { columns } = JSON.parse((await get(PORT_G, '/api/config')).body)
  for (const col of columns) {
    const { h, s } = hexToHsl(col.color)
    assert.ok(h >= 185 && h <= 360, `column "${col.id}" color ${col.color} hue out of range`)
    assert.ok(s >= 60, `column "${col.id}" color ${col.color} saturation too low`)
  }
})

// ── Animation ─────────────────────────────────────────────────────────────────

test('page CSS defines @keyframes card-arrive animation', async () => {
  const html = (await get(PORT_G, '/')).body
  assert.match(html, /@keyframes\s+card-arrive\b/)
})

test('renderBoard tracks previous card column positions in a module-level variable', async () => {
  const html = (await get(PORT_G, '/')).body
  assert.match(html, /\bprev(?:Board|CardCols|CardPositions|Positions|State|Cards?)\b/, 'prev positions variable must exist')
  const renderIdx = html.indexOf('function renderBoard(')
  assert.ok(renderIdx !== -1)
  const chunk = html.slice(renderIdx, renderIdx + 3000)
  assert.match(chunk, /\bprev(?:Board|CardCols|CardPositions|Positions|State|Cards?)\b/, 'renderBoard must reference the prev positions variable')
})

test('renderBoard applies card-just-arrived class only to cards that changed column', async () => {
  const html = (await get(PORT_G, '/')).body
  const renderIdx = html.indexOf('function renderBoard(')
  const chunk = html.slice(renderIdx, renderIdx + 3000)
  assert.match(chunk, /classList\.add\(['"]card-just-arrived['"]\)/)
  const addPos = Math.max(chunk.indexOf("classList.add('card-just-arrived')"), chunk.indexOf('classList.add("card-just-arrived")'))
  const preceding = chunk.slice(Math.max(0, addPos - 400), addPos)
  assert.match(preceding, /\bif\b/, 'card-just-arrived must only be added inside a conditional')
})

test('prev positions variable initialises to null so the first renderBoard call animates nothing', async () => {
  const html = (await get(PORT_G, '/')).body
  assert.match(html, /\bprev(?:Board|CardCols|CardPositions|Positions|State|Cards?)\s*=\s*(?:null|undefined|\{\}|\[\])/, 'prev variable must start falsy/empty')
})

test('animationend listener removes card-just-arrived class so re-entry can replay the animation', async () => {
  const html = (await get(PORT_G, '/')).body
  assert.match(html, /animationend/, 'animationend listener must be registered')
  assert.match(html, /classList\.remove\(['"]card-just-arrived['"]\)/)
})

// ── Pool controls ─────────────────────────────────────────────────────────────

test('pool control buttons use ▲/▼ arrow symbols, not +/- characters', async () => {
  const html = (await get(PORT_G, '/')).body
  const renderIdx = html.indexOf('function renderBoard(')
  assert.ok(renderIdx !== -1)
  const chunk = html.slice(renderIdx, renderIdx + 3000)
  assert.ok(chunk.includes('▼') || chunk.includes('↓'), 'pool-dec button must use ▼ or ↓')
  assert.ok(chunk.includes('▲') || chunk.includes('↑'), 'pool-inc button must use ▲ or ↑')
})

test('column max-width is at least 270px so pool controls do not overflow on long column names', async () => {
  const html = (await get(PORT_G, '/')).body
  const renderIdx = html.indexOf('function renderBoard(')
  const chunk = html.slice(renderIdx, renderIdx + 1500)
  const m = chunk.match(/max-width:\s*(\d+)px/)
  assert.ok(m, 'column wrapper must set an explicit max-width in pixels')
  assert.ok(parseInt(m[1], 10) >= 270, `max-width must be ≥ 270px; got ${m[1]}px`)
})

// ── Card modal ────────────────────────────────────────────────────────────────

test('card modal has a Delete button alongside the Edit button', async () => {
  const html = (await get(PORT_G, '/')).body
  assert.match(html, /id="modal-edit-btn"/)
  assert.match(html, /id="modal-delete-btn"/)
  assert.match(html, /onclick="deleteCard\(\)"/)
})

test('deleteCard() calls confirm() before making the DELETE request', async () => {
  const html = (await get(PORT_G, '/')).body
  const fnStart = html.indexOf('async function deleteCard()')
  assert.ok(fnStart !== -1, 'deleteCard function must exist')
  const chunk = html.slice(fnStart, fnStart + 800)
  const confirmPos = chunk.indexOf('confirm(')
  const fetchPos = chunk.indexOf("fetch('/api/card/")
  assert.ok(confirmPos !== -1, 'confirm() must be called in deleteCard')
  assert.ok(confirmPos < fetchPos, 'confirm() must appear before fetch()')
  assert.match(chunk.slice(confirmPos, fetchPos), /return/, 'a return must appear between confirm() and fetch()')
})

test('Delete button is hidden when the card filename ends in .wip', async () => {
  const html = (await get(PORT_G, '/')).body
  const openCardStart = html.indexOf('async function openCard(')
  assert.ok(openCardStart !== -1, 'openCard function must exist')
  const chunk = html.slice(openCardStart, openCardStart + 1200)
  assert.match(chunk, /\.wip/)
  assert.match(chunk, /modal-delete-btn/)
  const wipIdx = chunk.indexOf('.wip')
  assert.match(chunk.slice(wipIdx, wipIdx + 200), /classList\.add\(.*hidden.*\)/, '.wip branch must add hidden class to delete button')
})

test('deleteCard() closes the modal and calls refresh() after a successful deletion', async () => {
  const html = (await get(PORT_G, '/')).body
  const fnStart = html.indexOf('async function deleteCard()')
  const chunk = html.slice(fnStart, fnStart + 800)
  const fetchPos = chunk.indexOf("fetch('/api/card/")
  const closePos = chunk.indexOf('closeModal(')
  const refreshPos = chunk.indexOf('refresh()')
  assert.ok(closePos > fetchPos, 'closeModal() must come after the fetch call')
  assert.ok(refreshPos > fetchPos, 'refresh() must come after the fetch call')
})
