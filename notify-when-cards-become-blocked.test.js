'use strict'

// Integration tests for: Notify When Cards Become Blocked
// Acceptance criteria from .board/specification/notify-when-cards-become-blocked.md
//
// Strategy: a fake `osascript` executable (a tiny shell script that records its
// arguments to a temp file) is placed in a temp bin dir that is prepended to
// PATH when spawning the board-viewer server. Tests then assert whether and how
// osascript was called.

const { test, before, after, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
const http   = require('node:http')
const fs     = require('node:fs')
const path   = require('node:path')
const os     = require('node:os')
const { spawn } = require('node:child_process')

// ── Helpers ───────────────────────────────────────────────────────────────────

const PORT = 13811

let serverProcess
let boardDir
let fakeBinDir
let osascriptLogFile

// Each test gets a fresh log file; before each test we truncate it.
function clearOsascriptLog () {
  fs.writeFileSync(osascriptLogFile, '')
}

function readOsascriptLog () {
  try { return fs.readFileSync(osascriptLogFile, 'utf8') } catch { return '' }
}

function request (options, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: 'localhost', port: PORT, ...options }, res => {
      let data = ''
      res.on('data', c => (data += c))
      res.on('end', () => resolve({ status: res.statusCode, body: data }))
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

// Poll until predicate returns truthy or timeout expires.
function waitUntil (predicate, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeout
    function check () {
      const result = predicate()
      if (result) return resolve(result)
      if (Date.now() > deadline) return reject(new Error('waitUntil timed out'))
      setTimeout(check, 50)
    }
    check()
  })
}

function createCardFile (col, filename, content = '# Test card\n') {
  const dir = path.join(boardDir, col)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, filename), content)
}

// ── Test setup ────────────────────────────────────────────────────────────────

before(async () => {
  boardDir       = fs.mkdtempSync(path.join(os.tmpdir(), 'boardthing-blocked-notify-'))
  fakeBinDir     = fs.mkdtempSync(path.join(os.tmpdir(), 'boardthing-fakebin-'))
  osascriptLogFile = path.join(fakeBinDir, 'osascript-calls.log')
  fs.writeFileSync(osascriptLogFile, '')

  // Create a minimal valid config so the server passes validateConfig()
  const config = {
    repo: boardDir,
    columns: ['backlog', 'specification', 'implementation', 'done', 'blocked'],
    transitions: []
  }
  fs.writeFileSync(path.join(boardDir, 'config.json'), JSON.stringify(config, null, 2))

  // Create a fake osascript that records every argument it receives, one per line,
  // separated by a record separator so we can parse multi-argument invocations.
  const fakeOsascript = path.join(fakeBinDir, 'osascript')
  fs.writeFileSync(fakeOsascript,
    '#!/bin/sh\n' +
    'printf "%s\\0" "$@" >> ' + JSON.stringify(osascriptLogFile) + '\n' +
    'printf "\\n" >> ' + JSON.stringify(osascriptLogFile) + '\n'
  )
  fs.chmodSync(fakeOsascript, 0o755)

  // Spawn the server with the fake bin dir first on PATH
  const env = { ...process.env, PATH: fakeBinDir + ':' + process.env.PATH }

  serverProcess = spawn(process.execPath, [
    path.join(__dirname, 'board-viewer.js'),
    boardDir,
    String(PORT)
  ], { stdio: ['ignore', 'pipe', 'pipe'], env })

  serverProcess.stdout.on('data', () => {})
  serverProcess.stderr.on('data', () => {})

  await waitForServer(PORT)
  await new Promise(r => setTimeout(r, 200))
})

after(() => {
  if (serverProcess) serverProcess.kill()
  try { fs.rmSync(boardDir,   { recursive: true, force: true }) } catch {}
  try { fs.rmSync(fakeBinDir, { recursive: true, force: true }) } catch {}
})

beforeEach(() => clearOsascriptLog())

// ── AC1: moving to blocked invokes osascript ──────────────────────────────────

test('AC1 – moving a card to blocked invokes osascript', async () => {
  createCardFile('backlog', 'ac1-blocked-card.md')
  clearOsascriptLog()

  const res = await request(
    { method: 'POST', path: '/api/card/move', headers: { 'Content-Type': 'application/json' } },
    { col: 'backlog', filename: 'ac1-blocked-card.md', toCol: 'blocked' }
  )
  assert.equal(res.status, 200, 'move request must return 200')

  // Wait for osascript to be invoked asynchronously
  await waitUntil(() => readOsascriptLog().trim().length > 0)

  const log = readOsascriptLog()
  assert.ok(log.trim().length > 0,
    'osascript must have been invoked when a card is moved to blocked; log was empty')
})

// ── AC2: notification title is "Card Blocked" ─────────────────────────────────

test('AC2 – the notification title passed to osascript is "Card Blocked"', async () => {
  createCardFile('backlog', 'ac2-title-check.md')
  clearOsascriptLog()

  await request(
    { method: 'POST', path: '/api/card/move', headers: { 'Content-Type': 'application/json' } },
    { col: 'backlog', filename: 'ac2-title-check.md', toCol: 'blocked' }
  )

  await waitUntil(() => readOsascriptLog().includes('Card Blocked'))

  const log = readOsascriptLog()
  assert.ok(log.includes('Card Blocked'),
    'osascript must be called with a notification title of "Card Blocked"; got: ' + JSON.stringify(log))
})

// ── AC3: notification body contains human-readable card name ──────────────────

test('AC3 – the notification body contains the human-readable card name', async () => {
  createCardFile('backlog', 'ac3-my-blocked-card.md')
  clearOsascriptLog()

  await request(
    { method: 'POST', path: '/api/card/move', headers: { 'Content-Type': 'application/json' } },
    { col: 'backlog', filename: 'ac3-my-blocked-card.md', toCol: 'blocked' }
  )

  // Human-readable form: hyphens → spaces, no .md extension → "ac3 my blocked card"
  await waitUntil(() => readOsascriptLog().includes('ac3 my blocked card'))

  const log = readOsascriptLog()
  assert.ok(log.includes('ac3 my blocked card'),
    'osascript must be called with a body containing the human-readable card name ' +
    '("ac3 my blocked card"); got: ' + JSON.stringify(log))
})

// ── AC4: HTTP 200 is returned even when osascript fails ───────────────────────

test('AC4 – POST /api/card/move returns HTTP 200 even if osascript fails', async () => {
  // Replace fake osascript with one that exits non-zero (simulates failure)
  const fakeOsascript = path.join(fakeBinDir, 'osascript')
  const originalScript = fs.readFileSync(fakeOsascript, 'utf8')
  fs.writeFileSync(fakeOsascript,
    '#!/bin/sh\n' +
    'printf "%s\\0" "$@" >> ' + JSON.stringify(osascriptLogFile) + '\n' +
    'printf "\\n" >> ' + JSON.stringify(osascriptLogFile) + '\n' +
    'exit 1\n'           // simulate osascript failure
  )
  fs.chmodSync(fakeOsascript, 0o755)

  createCardFile('backlog', 'ac4-osascript-fails.md')
  clearOsascriptLog()

  try {
    const res = await request(
      { method: 'POST', path: '/api/card/move', headers: { 'Content-Type': 'application/json' } },
      { col: 'backlog', filename: 'ac4-osascript-fails.md', toCol: 'blocked' }
    )

    assert.equal(res.status, 200,
      'HTTP response must be 200 even when osascript exits non-zero; got: ' + res.status)

    // Also assert osascript WAS attempted (so the test fails without implementation)
    await waitUntil(() => readOsascriptLog().trim().length > 0)
    const log = readOsascriptLog()
    assert.ok(log.trim().length > 0,
      'osascript must have been invoked even though it failed')
  } finally {
    // Restore non-failing fake osascript
    fs.writeFileSync(fakeOsascript, originalScript)
    fs.chmodSync(fakeOsascript, 0o755)
  }
})

// ── AC5: moving to non-blocked column does NOT invoke osascript ───────────────

test('AC5 – moving a card to a non-blocked column does NOT invoke osascript', async () => {
  createCardFile('backlog', 'ac5-non-blocked.md')
  clearOsascriptLog()

  const res = await request(
    { method: 'POST', path: '/api/card/move', headers: { 'Content-Type': 'application/json' } },
    { col: 'backlog', filename: 'ac5-non-blocked.md', toCol: 'specification' }
  )
  assert.equal(res.status, 200, 'move to specification must succeed')

  // Wait a moment to give any (incorrect) async notification time to fire
  await new Promise(r => setTimeout(r, 500))

  const log = readOsascriptLog()
  assert.equal(log.trim(), '',
    'osascript must NOT be invoked when moving to a non-blocked column; got: ' + JSON.stringify(log))
})

// ── AC6: no new npm dependencies introduced ───────────────────────────────────

test('AC6 – no new npm dependencies are introduced', () => {
  const src = fs.readFileSync(path.join(__dirname, 'board-viewer.js'), 'utf8')

  // Collect all top-level require() calls
  const requires = [...src.matchAll(/\brequire\(['"]([^'"]+)['"]\)/g)].map(m => m[1])

  // Node.js built-in module names (subset relevant to this project)
  const builtins = new Set([
    'node:http', 'node:fs', 'node:path', 'node:os', 'node:child_process',
    'node:assert', 'node:assert/strict', 'node:test', 'node:url', 'node:stream',
    'node:events', 'node:buffer', 'node:util', 'node:crypto', 'node:net',
    'http', 'fs', 'path', 'os', 'child_process', 'assert', 'url',
    'stream', 'events', 'buffer', 'util', 'crypto', 'net',
  ])

  const thirdParty = requires.filter(r => !builtins.has(r) && !r.startsWith('.') && !r.startsWith('/'))

  assert.deepEqual(thirdParty, [],
    'board-viewer.js must not require any third-party npm modules; found: ' + JSON.stringify(thirdParty))
})
