'use strict'

// Integration tests for: Make Logging More Succinct
// Acceptance criteria from .board/specification/make-logging-more-succinct.md

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
const PORT = 13798

const stdoutLines = []
const stderrLines = []

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

function waitForLine (fromIndex, pattern, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeout
    function check () {
      const found = stdoutLines.slice(fromIndex).find(l => pattern.test ? pattern.test(l) : l.includes(pattern))
      if (found) return resolve(found)
      if (Date.now() > deadline) return reject(new Error('Timed out waiting for stdout line matching: ' + pattern))
      setTimeout(check, 50)
    }
    check()
  })
}

before(async () => {
  boardDir = fs.mkdtempSync(path.join(os.tmpdir(), 'boardthing-succinct-test-'))

  serverProcess = spawn(process.execPath, [
    path.join(__dirname, 'board-viewer.js'),
    boardDir,
    String(PORT)
  ], { stdio: ['ignore', 'pipe', 'pipe'] })

  serverProcess.stdout.on('data', chunk =>
    String(chunk).split('\n').filter(Boolean).forEach(l => stdoutLines.push(l))
  )
  serverProcess.stderr.on('data', chunk =>
    String(chunk).split('\n').filter(Boolean).forEach(l => stderrLines.push(l))
  )

  await waitForServer(PORT)
  await new Promise(r => setTimeout(r, 200))
})

after(() => {
  if (serverProcess) serverProcess.kill()
  try { fs.rmSync(boardDir, { recursive: true, force: true }) } catch {}
})

function createCardFile (col, filename, content = '# Test card\n') {
  const dir = path.join(boardDir, col)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, filename), content)
}

// HH:MM:SS only — no date, no timezone
const TIME_ONLY_RE = /^\d{2}:\d{2}:\d{2}$/

// A complete log line: HH:MM:SS <action> [args...]
// Must NOT start with a date (YYYY-) or contain [boardthing]
const LOG_LINE_RE = /^(\d{2}:\d{2}:\d{2}) (.+)$/

function parseLogLine (line) {
  const m = line.match(LOG_LINE_RE)
  return m ? { timestamp: m[1], message: m[2] } : null
}

// ── AC1: timestamp is HH:MM:SS only ──────────────────────────────────────────

test('AC1 – every log line timestamp is formatted as HH:MM:SS with no date and no timezone offset', async () => {
  const filename = 'ac1-timestamp.md'
  createCardFile('backlog', filename)

  const before = stdoutLines.length
  await request({ method: 'GET', path: '/api/card/backlog/' + filename })

  // Wait for any log line after this request
  const line = await waitForLine(before, /\d{2}:\d{2}:\d{2}/)

  const parsed = parseLogLine(line)
  assert.ok(parsed,
    'log line must match "HH:MM:SS message" format; got: ' + JSON.stringify(line))

  assert.match(parsed.timestamp, TIME_ONLY_RE,
    'timestamp must be HH:MM:SS only; got: ' + parsed.timestamp)

  // Must NOT contain a date portion
  assert.doesNotMatch(line, /^\d{4}-\d{2}-\d{2}/,
    'log line must not start with a YYYY-MM-DD date; got: ' + line)

  // Must NOT contain a timezone offset
  assert.doesNotMatch(line, /[+\-]\d{2}:\d{2}/,
    'log line must not contain a ±HH:MM timezone offset; got: ' + line)
})

// ── AC2: no [boardthing] label ────────────────────────────────────────────────

test('AC2 – log lines do not include [boardthing] or any bracketed prefix label', async () => {
  const filename = 'ac2-nolabel.md'
  createCardFile('backlog', filename)

  const before = stdoutLines.length
  await request({ method: 'GET', path: '/api/card/backlog/' + filename })

  // We expect a log line to appear; wait for it by the time-only pattern
  const line = await waitForLine(before, /\d{2}:\d{2}:\d{2}.*read/)

  assert.doesNotMatch(line, /\[boardthing\]/,
    'log line must not contain [boardthing]; got: ' + line)

  // No bracketed label of any kind before the action word
  assert.doesNotMatch(line, /^\d{2}:\d{2}:\d{2} \[/,
    'log line must not have a bracketed prefix after the timestamp; got: ' + line)
})

// ── AC3: read paths are board-relative ───────────────────────────────────────

test('AC3 – file paths in read log lines are relative to the board directory not absolute', async () => {
  const filename = 'ac3-readpath.md'
  createCardFile('backlog', filename)

  const relPath = path.join('backlog', filename)     // e.g. "backlog/ac3-readpath.md"
  const absPath = path.join(boardDir, relPath)

  const before = stdoutLines.length
  await request({ method: 'GET', path: '/api/card/backlog/' + filename })

  const line = await waitForLine(before, /\d{2}:\d{2}:\d{2}.*read/)

  assert.ok(line.includes(relPath),
    'log line must contain the board-relative path "' + relPath + '"; got: ' + line)

  assert.ok(!line.includes(absPath),
    'log line must NOT contain the absolute path "' + absPath + '"; got: ' + line)
})

// ── AC4: move paths are board-relative ───────────────────────────────────────

test('AC4 – file paths in move log lines are relative to the board directory', async () => {
  const filename = 'ac4-movepath.md'
  createCardFile('backlog', filename)

  const relSrc = path.join('backlog', filename)
  const relDst = path.join('specification', filename)
  const absSrc = path.join(boardDir, relSrc)
  const absDst = path.join(boardDir, relDst)

  const before = stdoutLines.length
  const res = await request(
    { method: 'POST', path: '/api/card/move', headers: { 'Content-Type': 'application/json' } },
    { col: 'backlog', filename, toCol: 'specification' }
  )
  assert.equal(res.status, 200, 'move request must succeed')

  const line = await waitForLine(before, /\d{2}:\d{2}:\d{2}.*move/)

  assert.ok(line.includes(relSrc),
    'log line must contain board-relative source "' + relSrc + '"; got: ' + line)

  assert.ok(line.includes(relDst),
    'log line must contain board-relative destination "' + relDst + '"; got: ' + line)

  assert.ok(!line.includes(absSrc),
    'log line must NOT contain absolute source path; got: ' + line)

  assert.ok(!line.includes(absDst),
    'log line must NOT contain absolute destination path; got: ' + line)
})

// ── AC5: move log line format is exactly "HH:MM:SS move <rel-src> <rel-dst>" ─

test('AC5 – a move log line matches exactly "HH:MM:SS move <rel-src> <rel-dst>" with no extra fields', async () => {
  const filename = 'ac5-moveformat.md'
  createCardFile('backlog', filename)

  const relSrc = path.join('backlog', filename)
  const relDst = path.join('specification', filename)

  const before = stdoutLines.length
  await request(
    { method: 'POST', path: '/api/card/move', headers: { 'Content-Type': 'application/json' } },
    { col: 'backlog', filename, toCol: 'specification' }
  )

  const line = await waitForLine(before, /\d{2}:\d{2}:\d{2}.*move/)

  // Exact structure: HH:MM:SS move <relSrc> <relDst>
  const expectedPattern = new RegExp(
    '^\\d{2}:\\d{2}:\\d{2} move ' +
    relSrc.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
    ' ' +
    relDst.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
    '$'
  )
  assert.match(line, expectedPattern,
    'move log line must exactly match "HH:MM:SS move <rel-src> <rel-dst>"; got: ' + line)
})

// ── AC6: read log line format is exactly "HH:MM:SS read <rel-path>" ──────────

test('AC6 – a read log line matches exactly "HH:MM:SS read <rel-path>" with no extra fields', async () => {
  const filename = 'ac6-readformat.md'
  createCardFile('backlog', filename)

  const relPath = path.join('backlog', filename)

  const before = stdoutLines.length
  await request({ method: 'GET', path: '/api/card/backlog/' + filename })

  const line = await waitForLine(before, /\d{2}:\d{2}:\d{2}.*read/)

  const expectedPattern = new RegExp(
    '^\\d{2}:\\d{2}:\\d{2} read ' +
    relPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
    '$'
  )
  assert.match(line, expectedPattern,
    'read log line must exactly match "HH:MM:SS read <rel-path>"; got: ' + line)
})

// ── AC7: write log line format is exactly "HH:MM:SS write <rel-path>" ────────

test('AC7 – a write log line matches exactly "HH:MM:SS write <rel-path>" with no extra fields', async () => {
  const filename = 'ac7-writeformat.md'
  createCardFile('backlog', filename)

  const relPath = path.join('backlog', filename)

  const before = stdoutLines.length
  await request(
    { method: 'PUT', path: '/api/card/backlog/' + filename, headers: { 'Content-Type': 'text/plain' } },
    '# Updated content\n'
  )

  const line = await waitForLine(before, /\d{2}:\d{2}:\d{2}.*write/)

  const expectedPattern = new RegExp(
    '^\\d{2}:\\d{2}:\\d{2} write ' +
    relPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
    '$'
  )
  assert.match(line, expectedPattern,
    'write log line must exactly match "HH:MM:SS write <rel-path>"; got: ' + line)
})
