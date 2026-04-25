'use strict'

// Integration tests for: Make Blocked the First Column
// Acceptance criteria from .board/specification/make-blocked-the-first-column.md

const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const http   = require('node:http')
const fs     = require('node:fs')
const path   = require('node:path')
const { spawn } = require('node:child_process')

// ── Paths ─────────────────────────────────────────────────────────────────────

const BOARD_DIR    = path.join(__dirname, '.board')
const CONFIG_PATH  = path.join(BOARD_DIR, 'config.json')
const VIEWER_PATH  = path.join(__dirname, 'board-viewer.js')

// ── Test infrastructure ───────────────────────────────────────────────────────

let serverProcess
const PORT = 13803

function request (options) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: 'localhost', port: PORT, ...options }, res => {
      let data = ''
      res.on('data', c => (data += c))
      res.on('end', () => resolve({ status: res.statusCode, body: data }))
    })
    req.on('error', reject)
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
  // Start the server against the real .board directory — no fixtures, so
  // all three tests exercise the actual project configuration.
  serverProcess = spawn(process.execPath, [
    VIEWER_PATH,
    BOARD_DIR,
    String(PORT)
  ], { stdio: ['ignore', 'ignore', 'ignore'] })

  await waitForServer(PORT)
})

after(() => {
  if (serverProcess) serverProcess.kill()
})

// ── AC1: config.json has "blocked" as the first column ───────────────────────

test('AC1 – .board/config.json lists "blocked" as the first entry in the columns array', () => {
  const raw = fs.readFileSync(CONFIG_PATH, 'utf8')
  const config = JSON.parse(raw)

  assert.ok(Array.isArray(config.columns), 'config.columns must be an array')
  assert.ok(config.columns.length > 0, 'config.columns must not be empty')

  const first = typeof config.columns[0] === 'string' ? config.columns[0] : config.columns[0].id
  assert.equal(
    first,
    'blocked',
    `Expected "blocked" to be the first column in .board/config.json but got "${first}". ` +
    `Current column order: ${config.columns.map(c => (typeof c === 'string' ? c : c.id)).join(', ')}`
  )
})

// ── AC2: board HTML renders "Blocked" column header first ────────────────────

test('AC2 – the board HTML renders the "Blocked" column header before all other column headers', async () => {
  const res = await request({ method: 'GET', path: '/' })
  assert.equal(res.status, 200, 'GET / must return 200')

  // Extract column header labels in document order.
  // Column headers are rendered as:
  //   <span class="... uppercase tracking-wide">LABEL</span>
  const headerPattern = /class="[^"]*uppercase tracking-wide[^"]*">([^<]+)<\/span>/g
  const headers = []
  let m
  while ((m = headerPattern.exec(res.body)) !== null) {
    headers.push(m[1].trim())
  }

  assert.ok(headers.length > 0, 'Expected to find at least one column header in the board HTML')

  assert.equal(
    headers[0].toLowerCase(),
    'blocked',
    `Expected "Blocked" to be the first column header in the HTML but found "${headers[0]}". ` +
    `Rendered column order: ${headers.join(', ')}`
  )
})

// ── AC3: /api/config returns "blocked" as the first column ───────────────────

test('AC3 – GET /api/config returns "blocked" as the first column in the columns array', async () => {
  const res = await request({ method: 'GET', path: '/api/config' })
  assert.equal(res.status, 200, '/api/config must return 200')

  const config = JSON.parse(res.body)
  assert.ok(Array.isArray(config.columns), 'config.columns must be an array')
  assert.ok(config.columns.length > 0, 'config.columns must not be empty')

  assert.equal(
    config.columns[0].id,
    'blocked',
    `Expected /api/config to return "blocked" as the first column but got "${config.columns[0].id}". ` +
    `Returned column order: ${config.columns.map(c => c.id).join(', ')}`
  )
})
