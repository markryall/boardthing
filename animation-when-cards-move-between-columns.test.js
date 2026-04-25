'use strict'

// Integration tests for: Animation When Cards Move Between Columns
// Acceptance criteria from .board/specification/animation-when-cards-move-between-columns.md

const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const http   = require('node:http')
const fs     = require('node:fs')
const path   = require('node:path')
const os     = require('node:os')
const { spawn } = require('node:child_process')

// ── Test infrastructure ───────────────────────────────────────────────────────

let serverProcess
let boardDir
const PORT = 13811

function request (options, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: 'localhost', port: PORT, ...options }, res => {
      let data = ''
      res.on('data', c => (data += c))
      res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }))
    })
    req.on('error', reject)
    if (body != null) req.write(typeof body === 'string' ? body : JSON.stringify(body))
    req.end()
  })
}

function waitForServer (port, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeout
    function tryConnect () {
      const req = http.request({ hostname: 'localhost', port, path: '/', method: 'GET' }, res => {
        res.resume(); resolve()
      })
      req.on('error', () => {
        if (Date.now() > deadline) return reject(new Error('Server did not start in time'))
        setTimeout(tryConnect, 100)
      })
      req.end()
    }
    tryConnect()
  })
}

before(async () => {
  boardDir = fs.mkdtempSync(path.join(os.tmpdir(), 'boardthing-animation-test-'))
  fs.mkdirSync(path.join(boardDir, 'backlog'), { recursive: true })
  fs.mkdirSync(path.join(boardDir, 'todo'), { recursive: true })

  serverProcess = spawn(process.execPath, [
    path.join(__dirname, 'board-viewer.js'),
    boardDir,
    String(PORT)
  ], { stdio: ['ignore', 'pipe', 'pipe'] })

  serverProcess.stderr.on('data', () => {})
  serverProcess.stdout.on('data', () => {})

  await waitForServer(PORT)
})

after(() => {
  if (serverProcess) serverProcess.kill()
  try { fs.rmSync(boardDir, { recursive: true, force: true }) } catch {}
})

// ── AC1: CSS @keyframes for card-arrive animation is defined ──────────────────

test('AC1 – the page CSS includes a @keyframes definition named card-arrive', async () => {
  const res = await request({ method: 'GET', path: '/' })
  assert.equal(res.status, 200)
  assert.match(
    res.body,
    /@keyframes\s+card-arrive\b/,
    'Page must include a @keyframes card-arrive animation definition'
  )
})

// ── AC2: renderBoard() tracks each card's previous column ────────────────────

test('AC2 – a persistent variable tracks each card\'s column between renderBoard() calls', async () => {
  const res = await request({ method: 'GET', path: '/' })
  assert.equal(res.status, 200)

  // A module-level variable must hold previous board state between renders.
  // Accept reasonable naming variants.
  assert.match(
    res.body,
    /\bprev(?:Board|CardCols|CardPositions|Positions|State|Cards?)\b/,
    'A module-level variable tracking previous card column positions must exist'
  )

  // renderBoard() itself must reference this variable.
  const renderBoardStart = res.body.indexOf('function renderBoard(')
  assert.ok(renderBoardStart !== -1, 'renderBoard function must be defined')
  const renderBoardChunk = res.body.slice(renderBoardStart, renderBoardStart + 3000)

  assert.match(
    renderBoardChunk,
    /\bprev(?:Board|CardCols|CardPositions|Positions|State|Cards?)\b/,
    'renderBoard() must reference the previous card-positions variable'
  )
})

// ── AC3: Moved cards receive the card-just-arrived CSS class ─────────────────

test('AC3 – renderBoard() applies class "card-just-arrived" to cards detected as having changed column', async () => {
  const res = await request({ method: 'GET', path: '/' })
  assert.equal(res.status, 200)

  const renderBoardStart = res.body.indexOf('function renderBoard(')
  assert.ok(renderBoardStart !== -1, 'renderBoard function must be defined')
  const renderBoardChunk = res.body.slice(renderBoardStart, renderBoardStart + 3000)

  assert.match(
    renderBoardChunk,
    /card-just-arrived/,
    'renderBoard() must reference the CSS class "card-just-arrived"'
  )
  assert.match(
    renderBoardChunk,
    /classList\.add\(['"]card-just-arrived['"]\)/,
    'renderBoard() must call classList.add("card-just-arrived") for cards that moved'
  )
})

// ── AC4: Stationary cards do NOT receive the animation class ─────────────────

test('AC4 – the card-just-arrived class is only added inside a conditional, not applied to every card', async () => {
  const res = await request({ method: 'GET', path: '/' })
  assert.equal(res.status, 200)

  const renderBoardStart = res.body.indexOf('function renderBoard(')
  assert.ok(renderBoardStart !== -1, 'renderBoard function must be defined')
  const renderBoardChunk = res.body.slice(renderBoardStart, renderBoardStart + 3000)

  // Locate where the class is added.
  const addIdx1 = renderBoardChunk.indexOf("classList.add('card-just-arrived')")
  const addIdx2 = renderBoardChunk.indexOf('classList.add("card-just-arrived")')
  const addPosition = Math.max(addIdx1, addIdx2)
  assert.ok(addPosition !== -1, 'classList.add("card-just-arrived") must be present in renderBoard()')

  // Within the 400 characters preceding the add call there must be an `if` guard.
  const precedingCode = renderBoardChunk.slice(Math.max(0, addPosition - 400), addPosition)
  assert.match(
    precedingCode,
    /\bif\b/,
    'classList.add("card-just-arrived") must be inside a conditional block, not applied unconditionally'
  )
})

// ── AC5: No animation class on the very first renderBoard() call ──────────────

test('AC5 – when renderBoard() runs for the first time (no previous state), no card gets card-just-arrived', async () => {
  const res = await request({ method: 'GET', path: '/' })
  assert.equal(res.status, 200)

  // The previous-state variable must be initialised to a falsy/empty sentinel
  // so the first render can detect "no prior data" and skip animations.
  assert.match(
    res.body,
    /\bprev(?:Board|CardCols|CardPositions|Positions|State|Cards?)\s*=\s*(?:null|undefined|\{\}|\[\])/,
    'The previous card-positions variable must be initialised to null, undefined, {}, or [] before first use'
  )

  // renderBoard() must guard the animation path with a check on that variable.
  const renderBoardStart = res.body.indexOf('function renderBoard(')
  assert.ok(renderBoardStart !== -1, 'renderBoard function must be defined')
  const renderBoardChunk = res.body.slice(renderBoardStart, renderBoardStart + 3000)

  // The add call must only be reachable when previous state exists.
  // A simple heuristic: the previous-state variable appears before the add call in the function.
  const addIdx1 = renderBoardChunk.indexOf("classList.add('card-just-arrived')")
  const addIdx2 = renderBoardChunk.indexOf('classList.add("card-just-arrived")')
  const addPosition = Math.max(addIdx1, addIdx2)
  const prevVarMatch = renderBoardChunk.match(/\bprev(?:Board|CardCols|CardPositions|Positions|State|Cards?)\b/)
  assert.ok(prevVarMatch, 'renderBoard() must reference the previous-state variable')
  assert.ok(
    prevVarMatch.index < addPosition,
    'The previous-state variable must be checked before the animation class is added'
  )
})

// ── AC6: card-just-arrived is removed on animationend so moves re-trigger it ──

test('AC6 – an animationend listener removes card-just-arrived so a subsequent move replays the animation', async () => {
  const res = await request({ method: 'GET', path: '/' })
  assert.equal(res.status, 200)

  assert.match(
    res.body,
    /animationend/,
    'The page JS must register an animationend event listener'
  )
  assert.match(
    res.body,
    /classList\.remove\(['"]card-just-arrived['"]\)/,
    'The animationend handler must call classList.remove("card-just-arrived")'
  )

  // The remove call must be in close proximity to the animationend binding.
  const animEndIdx = res.body.indexOf('animationend')
  assert.ok(animEndIdx !== -1)
  const animEndChunk = res.body.slice(animEndIdx, animEndIdx + 300)
  assert.match(
    animEndChunk,
    /card-just-arrived/,
    'The animationend listener/handler must reference "card-just-arrived"'
  )
})
