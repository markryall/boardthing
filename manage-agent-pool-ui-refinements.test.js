'use strict'

// Integration tests for: Manage Agent Pool – UI Refinements
// Tests for AC16 (▲/▼ pool buttons) and AC17 (wider columns)
// These tests MUST FAIL until the implementation is updated.
// Based on Feedback Q1 (Option A: use arrow symbols) and Q2 (Option A: wider columns).

const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { spawn } = require('node:child_process')

// ── Test infrastructure ───────────────────────────────────────────────────────

let serverProcess
let boardDir
const PORT = 13794

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
  boardDir = fs.mkdtempSync(path.join(os.tmpdir(), 'boardthing-ui-refinements-test-'))

  // Columns include a long name ("implementation") to exercise the overflow scenario
  const config = {
    columns: ['todo', 'implementation', 'done'],
    transitions: [
      { from: 'todo', to: 'done' },
      { from: 'implementation', to: 'done' }
    ]
  }
  fs.writeFileSync(path.join(boardDir, 'config.json'), JSON.stringify(config, null, 2))

  // Fake agent command so findAgentPath returns a valid path
  const commandsDir = path.join(boardDir, 'commands')
  fs.mkdirSync(commandsDir, { recursive: true })
  fs.writeFileSync(path.join(commandsDir, 'done.md'), 'Fake agent command for testing.\n')

  for (const col of ['todo', 'implementation', 'done']) {
    fs.mkdirSync(path.join(boardDir, col), { recursive: true })
  }

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

// ── AC16: Pool buttons display ▲/▼ arrows instead of +/- symbols ─────────────
//
// Rationale: When the add-card "+" button and pool-inc "+" button both appear
// in the column header, users see the confusing sequence "- 0 + +".
// Q1 decision (Option A): replace the pool-dec "-" with "▼" and pool-inc "+"
// with "▲" so the sequence reads "▼ 0 ▲  +" — visually distinct and unambiguous.

test('AC16 – pool-dec button displays ▼ or ↓ (not "-"), and pool-inc button displays ▲ or ↑ (not "+")', async () => {
  const res = await request({ method: 'GET', path: '/' })
  assert.equal(res.status, 200)

  const renderIdx = res.body.indexOf('function renderBoard(')
  assert.ok(renderIdx !== -1, 'renderBoard must exist in the HTML source')

  // Grab enough of renderBoard to cover the entire pool control section
  const renderChunk = res.body.slice(renderIdx, renderIdx + 3000)

  // pool-dec button must exist in renderBoard
  assert.match(renderChunk, /pool-dec/, 'pool-dec button must be present in renderBoard')
  // pool-inc button must exist in renderBoard
  assert.match(renderChunk, /pool-inc/, 'pool-inc button must be present in renderBoard')

  // The decrement button content must be ▼ or ↓
  assert.ok(
    renderChunk.includes('▼') || renderChunk.includes('↓'),
    'pool-dec button must display ▼ or ↓ — currently uses "-" which conflicts with the add-card "+" button'
  )

  // The increment button content must be ▲ or ↑
  assert.ok(
    renderChunk.includes('▲') || renderChunk.includes('↑'),
    'pool-inc button must display ▲ or ↑ — currently uses "+" which duplicates the add-card "+" button'
  )
})

// ── AC17: Column max-width is at least 270px ──────────────────────────────────
//
// Rationale: Columns with long names (e.g. "IMPLEMENTATION") plus the pool
// control group and the add-card button overflow the prior 220px column width.
// Q2 decision (Option A): increase column max-width to ~280px so all controls
// fit on one line without truncation.

test('AC17 – column wrapper max-width is at least 270px so pool controls do not overflow on long column names', async () => {
  const res = await request({ method: 'GET', path: '/' })
  assert.equal(res.status, 200)

  const renderIdx = res.body.indexOf('function renderBoard(')
  assert.ok(renderIdx !== -1, 'renderBoard must exist in the HTML source')

  // The column wrapper style is set inline; search the first portion of renderBoard
  const renderChunk = res.body.slice(renderIdx, renderIdx + 1500)

  const maxWidthMatch = renderChunk.match(/max-width:\s*(\d+)px/)
  assert.ok(
    maxWidthMatch,
    'renderBoard must set an explicit max-width in pixels on the column wrapper (e.g. max-width:280px)'
  )

  const maxWidth = parseInt(maxWidthMatch[1], 10)
  assert.ok(
    maxWidth >= 270,
    'column max-width must be at least 270px (currently ' + maxWidth + 'px); ' +
    'long names like "IMPLEMENTATION" plus pool controls overflow at 220px'
  )
})
