'use strict'

// Integration tests for: Console Logging feature
// Acceptance criteria from .board/implementation/console-logging.md

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
const PORT = 13794

// Accumulated lines from the server's stdout and stderr
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

// Poll stdoutLines (starting from `fromIndex`) until `pattern` matches a line,
// or the timeout expires.
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
  boardDir = fs.mkdtempSync(path.join(os.tmpdir(), 'boardthing-logging-test-'))

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
  // Let any startup stdout lines settle
  await new Promise(r => setTimeout(r, 200))
})

after(() => {
  if (serverProcess) serverProcess.kill()
  try { fs.rmSync(boardDir, { recursive: true, force: true }) } catch {}
})

// Helper: write a card file into a column directory
function createCardFile (col, filename, content = '# Test card\n') {
  const dir = path.join(boardDir, col)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, filename), content)
}

// ISO-8601 with local timezone offset, second precision
// e.g. 2026-04-25T17:39:00+10:00
const ISO_TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+\-]\d{2}:\d{2}$/
const LOG_LINE_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+\-]\d{2}:\d{2}) (\[boardthing\]) (.+)$/

function parseLogLine (line) {
  const m = line.match(LOG_LINE_RE)
  return m ? { timestamp: m[1], label: m[2], message: m[3] } : null
}

// ── AC1: agent starts → log line with timestamp, [boardthing], agent type, card name ──

// NOTE: spawning a real claude agent is not feasible in an automated test
// environment, so we verify the source code calls boardLog at the correct site.
test('AC1 – when an agent starts a log line is emitted with timestamp [boardthing] agent-type and card name', () => {
  const src = fs.readFileSync(path.join(__dirname, 'board-viewer.js'), 'utf8')

  // boardLog must be called with agentType + ' ' + cardSlug + ' started' before the spawn call
  assert.match(
    src,
    /boardLog\(agentType \+ ' ' \+ cardSlug \+ ' started'\)/,
    'boardLog must be called with agentType, cardSlug, and "started" before spawn()'
  )
  // That call must appear before the spawn('claude', ...) call
  const logPos   = src.indexOf("boardLog(agentType + ' ' + cardSlug + ' started')")
  const spawnPos = src.indexOf("spawn('claude'")
  assert.ok(logPos !== -1, 'start boardLog must exist')
  assert.ok(spawnPos !== -1, 'spawn call must exist')
  assert.ok(logPos < spawnPos, 'start log must appear before spawn()')
})

// ── AC2: agent finishes successfully → log line containing "success" ──────────

test('AC2 – when an agent finishes successfully a log line is emitted containing "success"', () => {
  const src = fs.readFileSync(path.join(__dirname, 'board-viewer.js'), 'utf8')

  assert.match(
    src,
    /boardLog\(agentType \+ ' ' \+ cardSlug \+ ' success'\)/,
    'boardLog must be called with agentType, cardSlug, and "success" on exit code 0'
  )
  // The success log must be guarded by code === 0
  assert.match(src, /if \(code === 0\)/, 'code === 0 check must exist')
  const codeCheckPos   = src.indexOf('if (code === 0)')
  const successLogPos  = src.indexOf("boardLog(agentType + ' ' + cardSlug + ' success')")
  assert.ok(codeCheckPos < successLogPos, '"success" log must appear after the code === 0 check')
})

// ── AC3: agent terminates with error → log line containing "failed" ───────────

test('AC3 – when an agent terminates with an error a log line is emitted containing "failed"', () => {
  const src = fs.readFileSync(path.join(__dirname, 'board-viewer.js'), 'utf8')

  assert.match(
    src,
    /boardLog\(agentType \+ ' ' \+ cardSlug \+ ' failed'\)/,
    'boardLog must be called with agentType, cardSlug, and "failed" on non-zero exit'
  )
  // Find the proc.on('close', ...) handler and verify the else-branch structure
  // The close handler should contain: if (code === 0) { ...success... } else { ...failed... }
  const closeHandlerMatch = src.match(/proc\.on\('close'[\s\S]*?\}\)\s*\}/)
  assert.ok(closeHandlerMatch, 'proc.on("close", ...) handler must exist in the source')
  const closeHandler = closeHandlerMatch[0]
  assert.match(
    closeHandler,
    /\} else \{[\s\S]*?boardLog\(agentType \+ ' ' \+ cardSlug \+ ' failed'\)/,
    '"failed" boardLog must appear inside the else branch of the close handler'
  )
})

// ── AC4: reading a card → log line with "read" and full file path ─────────────

test('AC4 – reading a card file emits a log line with action "read" and the full file path', async () => {
  const filename    = 'ac4-read.md'
  const expectedPath = path.resolve(path.join(boardDir, 'backlog', filename))
  createCardFile('backlog', filename)

  const before = stdoutLines.length
  await request({ method: 'GET', path: '/api/card/backlog/' + filename })

  const line = await waitForLine(before, /\[boardthing\].*read/)
  assert.ok(line.includes('read'), 'log line must contain "read"')
  assert.ok(line.includes(expectedPath), 'log line must include the full resolved file path')
})

// ── AC5: writing a card → log line with "write" and full file path ────────────

test('AC5 – writing a card file emits a log line with action "write" and the full file path', async () => {
  const filename    = 'ac5-write.md'
  const expectedPath = path.resolve(path.join(boardDir, 'backlog', filename))
  createCardFile('backlog', filename)

  const before = stdoutLines.length
  await request(
    { method: 'PUT', path: '/api/card/backlog/' + filename, headers: { 'Content-Type': 'text/plain' } },
    '# Updated content\n'
  )

  const line = await waitForLine(before, /\[boardthing\].*write/)
  assert.ok(line.includes('write'), 'log line must contain "write"')
  assert.ok(line.includes(expectedPath), 'log line must include the full resolved file path')
})

// ── AC6: renaming a card → log line with "rename", old path, new path ─────────

// BUG: Criterion 6 is not implemented. The board-viewer.js source explicitly
// documents (via a TODO comment after the boardLog function definition) that
// it cannot emit rename log lines because agent subprocesses rename card files
// directly via their own filesystem access; board-viewer.js has no rename API
// endpoint and no filesystem event detection for renames.
// This test is marked `todo` so it fails visibly without blocking the suite.
test('AC6 – renaming a card file emits a log line with "rename" the old path and the new path', { todo: 'BUG: criterion 6 not implemented — no rename API endpoint or filesystem rename detection in board-viewer.js (see TODO comment after boardLog definition)' }, async () => {
  const filename = 'ac6-rename.md'
  createCardFile('backlog', filename)
  const oldPath = path.resolve(path.join(boardDir, 'backlog', filename))
  const newPath = oldPath + '.wip'

  const before = stdoutLines.length
  // Simulate what an agent does: rename the file directly on the filesystem
  fs.renameSync(oldPath, newPath)

  try {
    const line = await waitForLine(
      before,
      l => l.includes('rename') && l.includes(oldPath) && l.includes(newPath),
      1000
    )
    assert.ok(line, 'a "rename" log line with old and new paths must be emitted')
  } finally {
    try { fs.renameSync(newPath, oldPath) } catch {}
  }
})

// ── AC7: moving a card to another column → log line with "move", src, dst ─────

test('AC7 – moving a card to a different column emits a log line with "move" source path and destination path', async () => {
  const filename = 'ac7-move.md'
  createCardFile('backlog', filename)
  const srcPath = path.resolve(path.join(boardDir, 'backlog', filename))
  const dstPath = path.resolve(path.join(boardDir, 'specification', filename))

  const before = stdoutLines.length
  const res = await request(
    { method: 'POST', path: '/api/card/move', headers: { 'Content-Type': 'application/json' } },
    { col: 'backlog', filename, toCol: 'specification' }
  )
  assert.equal(res.status, 200, 'move request must succeed')

  const line = await waitForLine(before, /\[boardthing\].*move/)
  assert.ok(line.includes('move'), 'log line must contain "move"')
  assert.ok(line.includes(srcPath), 'log line must include source path')
  assert.ok(line.includes(dstPath), 'log line must include destination path')
})

// ── AC8: all log lines to stdout, never to stderr ─────────────────────────────

test('AC8 – all log lines are written to stdout never to stderr', async () => {
  const filename = 'ac8-stdout-check.md'
  createCardFile('backlog', filename)

  const stderrBefore = stderrLines.length
  const stdoutBefore = stdoutLines.length

  await request({ method: 'GET', path: '/api/card/backlog/' + filename })

  // Wait for log line to appear on stdout
  await waitForLine(stdoutBefore, /\[boardthing\]/)

  // Zero [boardthing] lines must appear on stderr
  const boardthingOnStderr = stderrLines.slice(stderrBefore).filter(l => l.includes('[boardthing]'))
  assert.equal(boardthingOnStderr.length, 0,
    'no [boardthing] log lines must appear on stderr; found: ' + JSON.stringify(boardthingOnStderr))
})

// ── AC9: ISO-8601 timestamp + [boardthing] label + no ANSI escape codes ───────

test('AC9 – every log line begins with ISO-8601 local-timezone timestamp then [boardthing] then message with no ANSI codes', async () => {
  const filename = 'ac9-format.md'
  createCardFile('backlog', filename)

  const before = stdoutLines.length
  await request({ method: 'GET', path: '/api/card/backlog/' + filename })

  const line = await waitForLine(before, /\[boardthing\]/)

  const parsed = parseLogLine(line)
  assert.ok(parsed,
    'log line must match "TIMESTAMP [boardthing] message" format; got: ' + JSON.stringify(line))

  assert.match(parsed.timestamp, ISO_TS_RE,
    'timestamp must be ISO-8601 with local timezone offset (±HH:MM) at second precision; got: ' + parsed.timestamp)

  assert.equal(parsed.label, '[boardthing]',
    'label must be exactly [boardthing]')

  // Timestamp must use ±HH:MM offset, not the UTC "Z" suffix
  assert.doesNotMatch(parsed.timestamp, /Z$/,
    'timestamp must use ±HH:MM timezone offset, not UTC Z')

  // No ANSI colour/style escape sequences
  assert.doesNotMatch(line, /\x1b/,
    'log line must not contain ANSI escape sequences (0x1b)')
})

// ── AC10: file paths logged without truncation, no maximum line length ─────────

test('AC10 – file paths and card names are logged without truncation or wrapping with no max line length', async () => {
  // Use a very long filename to confirm there is no line-length cap
  const longSlug = 'verylongcardname' + 'x'.repeat(160)
  const filename  = longSlug + '.md'
  const expectedPath = path.resolve(path.join(boardDir, 'backlog', filename))
  createCardFile('backlog', filename)

  const before = stdoutLines.length
  await request({ method: 'GET', path: '/api/card/backlog/' + encodeURIComponent(filename) })

  const line = await waitForLine(before, /\[boardthing\].*read/)
  assert.ok(line.includes(expectedPath),
    'the full untruncated path must appear in the log line; expected to find: ' + expectedPath)
  assert.ok(line.includes(longSlug),
    'the long card slug must appear verbatim in the log line without truncation')
})

// ── AC11: no log output when the board has no cards ───────────────────────────

test('AC11 – running the board with no cards in any column produces zero lines of log output', async () => {
  const emptyBoardDir = fs.mkdtempSync(path.join(os.tmpdir(), 'boardthing-empty-'))
  const emptyPort     = PORT + 1
  const emptyLines    = []

  const emptyServer = spawn(process.execPath, [
    path.join(__dirname, 'board-viewer.js'),
    emptyBoardDir,
    String(emptyPort)
  ], { stdio: ['ignore', 'pipe', 'pipe'] })

  emptyServer.stdout.on('data', chunk =>
    String(chunk).split('\n').filter(Boolean).forEach(l => emptyLines.push(l))
  )
  emptyServer.stderr.on('data', () => {})

  try {
    await waitForServer(emptyPort)
    // Observe for 1.5 seconds to catch any polling-based log emission
    await new Promise(r => setTimeout(r, 1500))

    const boardthingLines = emptyLines.filter(l => l.includes('[boardthing]'))
    assert.equal(boardthingLines.length, 0,
      'no [boardthing] log lines must be emitted when no cards exist; got: ' +
      JSON.stringify(boardthingLines))
  } finally {
    emptyServer.kill()
    try { fs.rmSync(emptyBoardDir, { recursive: true, force: true }) } catch {}
  }
})
