'use strict'

const { test, before, after, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { spawn } = require('node:child_process')

const PORT = 13910
const VIEWER = path.join(__dirname, 'board-viewer.js')

let serverProcess
let boardDir
let fakeBinDir
let osascriptLogFile

// ── Helpers ───────────────────────────────────────────────────────────────────

function request (options, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: 'localhost', port: PORT, ...options }, res => {
      let data = ''
      res.on('data', c => data += c)
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
    function try_ () {
      const req = http.request({ hostname: 'localhost', port, path: '/', method: 'GET' }, res => {
        res.resume(); resolve()
      })
      req.on('error', () => {
        if (Date.now() > deadline) return reject(new Error('Server did not start in time'))
        setTimeout(try_, 100)
      })
      req.end()
    }
    try_()
  })
}

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

function createCard (col, filename, content = '# Test\n') {
  const dir = path.join(boardDir, col)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, filename), content)
}

function clearOsascriptLog () { fs.writeFileSync(osascriptLogFile, '') }
function readOsascriptLog () {
  try { return fs.readFileSync(osascriptLogFile, 'utf8') } catch { return '' }
}

// ── Setup ─────────────────────────────────────────────────────────────────────

before(async () => {
  boardDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-cards-'))
  fakeBinDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-fakebin-'))
  osascriptLogFile = path.join(fakeBinDir, 'osascript.log')
  fs.writeFileSync(osascriptLogFile, '')

  const fakeOsascript = path.join(fakeBinDir, 'osascript')
  fs.writeFileSync(fakeOsascript,
    '#!/bin/sh\n' +
    'printf "%s\\0" "$@" >> ' + JSON.stringify(osascriptLogFile) + '\n' +
    'printf "\\n" >> ' + JSON.stringify(osascriptLogFile) + '\n'
  )
  fs.chmodSync(fakeOsascript, 0o755)

  const config = {
    columns: ['backlog', 'specification', 'implementation', 'done', 'blocked'],
    transitions: []
  }
  fs.writeFileSync(path.join(boardDir, 'config.json'), JSON.stringify(config))
  for (const col of config.columns) fs.mkdirSync(path.join(boardDir, col), { recursive: true })

  const env = { ...process.env, PATH: fakeBinDir + ':' + process.env.PATH }
  serverProcess = spawn(process.execPath, [VIEWER, boardDir, String(PORT)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env
  })
  serverProcess.stdout.on('data', () => {})
  serverProcess.stderr.on('data', () => {})

  await waitForServer(PORT)
  await new Promise(r => setTimeout(r, 200))
})

after(() => {
  if (serverProcess) serverProcess.kill()
  try { fs.rmSync(boardDir, { recursive: true, force: true }) } catch {}
  try { fs.rmSync(fakeBinDir, { recursive: true, force: true }) } catch {}
})

beforeEach(() => clearOsascriptLog())

// ── GET /api/board ────────────────────────────────────────────────────────────

test('GET /api/board returns an object keyed by column id with card arrays', async () => {
  const res = await request({ method: 'GET', path: '/api/board' })
  assert.equal(res.status, 200)
  const board = JSON.parse(res.body)
  for (const col of ['backlog', 'specification', 'done', 'blocked']) {
    assert.ok(col in board, `board must include column "${col}"`)
    assert.ok(Array.isArray(board[col]), `board["${col}"] must be an array`)
  }
})

// ── POST /api/card ────────────────────────────────────────────────────────────

test('POST /api/card creates a markdown file in the specified column', async () => {
  const res = await request(
    { method: 'POST', path: '/api/card', headers: { 'Content-Type': 'application/json' } },
    { col: 'backlog', name: 'My New Card', brief: 'A brief description.' }
  )
  assert.equal(res.status, 200)
  const { filename } = JSON.parse(res.body)
  assert.ok(filename.endsWith('.md'), 'created card must have .md extension')
  assert.ok(fs.existsSync(path.join(boardDir, 'backlog', filename)), 'card file must exist on disk')
})

// ── GET /api/card/:col/:filename ──────────────────────────────────────────────

test('GET /api/card/:col/:filename returns the card content', async () => {
  const content = '# Brief\n\nGet test.\n'
  createCard('backlog', 'get-test.md', content)
  const res = await request({ method: 'GET', path: '/api/card/backlog/get-test.md' })
  assert.equal(res.status, 200)
  assert.equal(res.body, content)
})

// ── PUT /api/card/:col/:filename ──────────────────────────────────────────────

test('PUT /api/card/:col/:filename updates the card content on disk', async () => {
  createCard('backlog', 'put-test.md', '# Original\n')
  const updated = '# Updated\n\nNew content.\n'
  const res = await request(
    { method: 'PUT', path: '/api/card/backlog/put-test.md', headers: { 'Content-Type': 'text/plain' } },
    updated
  )
  assert.equal(res.status, 200)
  assert.equal(fs.readFileSync(path.join(boardDir, 'backlog', 'put-test.md'), 'utf8'), updated)
})

// ── POST /api/card/move ───────────────────────────────────────────────────────

test('POST /api/card/move moves a card file from one column directory to another', async () => {
  createCard('backlog', 'move-test.md', '# Move\n')
  const res = await request(
    { method: 'POST', path: '/api/card/move', headers: { 'Content-Type': 'application/json' } },
    { col: 'backlog', filename: 'move-test.md', toCol: 'specification' }
  )
  assert.equal(res.status, 200)
  assert.ok(!fs.existsSync(path.join(boardDir, 'backlog', 'move-test.md')), 'card must leave source column')
  assert.ok(fs.existsSync(path.join(boardDir, 'specification', 'move-test.md')), 'card must arrive in dest column')
})

// ── DELETE /api/card/:col/:filename ──────────────────────────────────────────

test('DELETE /api/card/:col/:filename removes the file and returns 200', async () => {
  createCard('backlog', 'delete-ok.md')
  const res = await request({ method: 'DELETE', path: '/api/card/backlog/delete-ok.md' })
  assert.equal(res.status, 200)
  assert.ok(!fs.existsSync(path.join(boardDir, 'backlog', 'delete-ok.md')), 'file must be removed from disk')
})

test('DELETE returns 400 when the target file does not exist', async () => {
  const res = await request({ method: 'DELETE', path: '/api/card/backlog/nonexistent.md' })
  assert.equal(res.status, 400)
})

test('DELETE returns 409 when the filename ends in .wip', async () => {
  createCard('backlog', 'wip-card.md.wip')
  const res = await request({ method: 'DELETE', path: '/api/card/backlog/wip-card.md.wip' })
  assert.equal(res.status, 409)
  assert.ok(fs.existsSync(path.join(boardDir, 'backlog', 'wip-card.md.wip')), '.wip card must not be deleted')
})

test('DELETE returns 403 for path traversal attempts', async () => {
  const res = await request({ method: 'DELETE', path: '/api/card/..%2Foutside/something.md' })
  assert.equal(res.status, 403)
})

// ── Blocked card notifications ────────────────────────────────────────────────

test('moving a card to blocked invokes osascript with a system notification', async () => {
  createCard('backlog', 'blocked-notify.md')
  const res = await request(
    { method: 'POST', path: '/api/card/move', headers: { 'Content-Type': 'application/json' } },
    { col: 'backlog', filename: 'blocked-notify.md', toCol: 'blocked' }
  )
  assert.equal(res.status, 200)
  await waitUntil(() => readOsascriptLog().trim().length > 0)
  assert.ok(readOsascriptLog().trim().length > 0, 'osascript must be invoked when moving to blocked')
})

test('blocked notification title is "Card Blocked"', async () => {
  createCard('backlog', 'blocked-title.md')
  await request(
    { method: 'POST', path: '/api/card/move', headers: { 'Content-Type': 'application/json' } },
    { col: 'backlog', filename: 'blocked-title.md', toCol: 'blocked' }
  )
  await waitUntil(() => readOsascriptLog().includes('Card Blocked'))
  assert.ok(readOsascriptLog().includes('Card Blocked'))
})

test('blocked notification body contains the human-readable card name', async () => {
  createCard('backlog', 'my-feature-card.md')
  await request(
    { method: 'POST', path: '/api/card/move', headers: { 'Content-Type': 'application/json' } },
    { col: 'backlog', filename: 'my-feature-card.md', toCol: 'blocked' }
  )
  await waitUntil(() => readOsascriptLog().includes('my feature card'))
  assert.ok(readOsascriptLog().includes('my feature card'))
})

test('POST /api/card/move returns 200 even when osascript exits non-zero', async () => {
  const fakeOsascript = path.join(fakeBinDir, 'osascript')
  const original = fs.readFileSync(fakeOsascript, 'utf8')
  fs.writeFileSync(fakeOsascript,
    '#!/bin/sh\n' +
    'printf "%s\\0" "$@" >> ' + JSON.stringify(osascriptLogFile) + '\n' +
    'printf "\\n" >> ' + JSON.stringify(osascriptLogFile) + '\n' +
    'exit 1\n'
  )
  fs.chmodSync(fakeOsascript, 0o755)
  try {
    createCard('backlog', 'blocked-fail.md')
    const res = await request(
      { method: 'POST', path: '/api/card/move', headers: { 'Content-Type': 'application/json' } },
      { col: 'backlog', filename: 'blocked-fail.md', toCol: 'blocked' }
    )
    assert.equal(res.status, 200, 'must return 200 even when osascript fails')
    await waitUntil(() => readOsascriptLog().trim().length > 0)
    assert.ok(readOsascriptLog().trim().length > 0, 'osascript must still be attempted even when it fails')
  } finally {
    fs.writeFileSync(fakeOsascript, original)
    fs.chmodSync(fakeOsascript, 0o755)
  }
})

test('moving to a non-blocked column does NOT invoke osascript', async () => {
  createCard('backlog', 'non-blocked.md')
  await request(
    { method: 'POST', path: '/api/card/move', headers: { 'Content-Type': 'application/json' } },
    { col: 'backlog', filename: 'non-blocked.md', toCol: 'specification' }
  )
  await new Promise(r => setTimeout(r, 500))
  assert.equal(readOsascriptLog().trim(), '', 'osascript must NOT be invoked for non-blocked moves')
})
