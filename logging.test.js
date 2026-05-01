'use strict'

const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { spawn } = require('node:child_process')

const PORT = 13920
const VIEWER = path.join(__dirname, 'board-viewer.js')

let serverProcess
let boardDir
const stdoutLines = []
const stderrLines = []

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
        if (Date.now() > deadline) return reject(new Error('Server timed out on port ' + port))
        setTimeout(try_, 100)
      })
      req.end()
    }
    try_()
  })
}

function waitForLine (fromIndex, pattern, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeout
    function check () {
      const found = stdoutLines.slice(fromIndex).find(l => pattern.test ? pattern.test(l) : l.includes(pattern))
      if (found) return resolve(found)
      if (Date.now() > deadline) return reject(new Error('Timed out waiting for: ' + pattern))
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

function escapeRegex (s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// ── Setup ─────────────────────────────────────────────────────────────────────

before(async () => {
  boardDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-logging-'))

  serverProcess = spawn(process.execPath, [VIEWER, boardDir, String(PORT)], {
    stdio: ['ignore', 'pipe', 'pipe']
  })
  serverProcess.stdout.on('data', chunk => String(chunk).split('\n').filter(Boolean).forEach(l => stdoutLines.push(l)))
  serverProcess.stderr.on('data', chunk => String(chunk).split('\n').filter(Boolean).forEach(l => stderrLines.push(l)))

  await waitForServer(PORT)
  await new Promise(r => setTimeout(r, 200))
})

after(() => {
  if (serverProcess) serverProcess.kill()
  try { fs.rmSync(boardDir, { recursive: true, force: true }) } catch {}
})

// ── Log format ────────────────────────────────────────────────────────────────

test('log lines have HH:MM:SS timestamp — no date, no timezone, no [boardthing] prefix', async () => {
  createCard('backlog', 'format-test.md')
  const before = stdoutLines.length
  await request({ method: 'GET', path: '/api/card/backlog/format-test.md' })
  const line = await waitForLine(before, /\d{2}:\d{2}:\d{2}/)

  assert.match(line, /^\d{2}:\d{2}:\d{2} /, 'line must start with HH:MM:SS')
  assert.doesNotMatch(line, /^\d{4}-\d{2}-\d{2}/, 'line must not contain a date prefix')
  assert.doesNotMatch(line, /[+\-]\d{2}:\d{2}/, 'line must not contain a timezone offset')
  assert.doesNotMatch(line, /\[boardthing\]/, 'line must not contain [boardthing] label')
  assert.doesNotMatch(line, /\x1b/, 'line must not contain ANSI escape codes')
})

// ── Read event ────────────────────────────────────────────────────────────────

test('reading a card emits "HH:MM:SS read <board-relative-path>"', async () => {
  createCard('backlog', 'read-log.md')
  const relPath = path.join('backlog', 'read-log.md')
  const absPath = path.join(boardDir, relPath)

  const before = stdoutLines.length
  await request({ method: 'GET', path: '/api/card/backlog/read-log.md' })
  const line = await waitForLine(before, /\d{2}:\d{2}:\d{2}.*read/)

  assert.match(line, new RegExp('^\\d{2}:\\d{2}:\\d{2} read ' + escapeRegex(relPath) + '$'))
  assert.ok(!line.includes(absPath), 'log must use relative path, not absolute')
})

// ── Write event ───────────────────────────────────────────────────────────────

test('writing a card emits "HH:MM:SS write <board-relative-path>"', async () => {
  createCard('backlog', 'write-log.md')
  const relPath = path.join('backlog', 'write-log.md')
  const absPath = path.join(boardDir, relPath)

  const before = stdoutLines.length
  await request(
    { method: 'PUT', path: '/api/card/backlog/write-log.md', headers: { 'Content-Type': 'text/plain' } },
    '# Updated\n'
  )
  const line = await waitForLine(before, /\d{2}:\d{2}:\d{2}.*write/)

  assert.match(line, new RegExp('^\\d{2}:\\d{2}:\\d{2} write ' + escapeRegex(relPath) + '$'))
  assert.ok(!line.includes(absPath), 'log must use relative path, not absolute')
})

// ── Move event ────────────────────────────────────────────────────────────────

test('moving a card emits "HH:MM:SS move <src> <dst>" with board-relative paths', async () => {
  createCard('backlog', 'move-log.md')
  const relSrc = path.join('backlog', 'move-log.md')
  const relDst = path.join('specification', 'move-log.md')

  const before = stdoutLines.length
  await request(
    { method: 'POST', path: '/api/card/move', headers: { 'Content-Type': 'application/json' } },
    { col: 'backlog', filename: 'move-log.md', toCol: 'specification' }
  )
  const line = await waitForLine(before, /\d{2}:\d{2}:\d{2}.*move/)

  assert.match(line, new RegExp('^\\d{2}:\\d{2}:\\d{2} move ' + escapeRegex(relSrc) + ' ' + escapeRegex(relDst) + '$'))
  assert.ok(!line.includes(boardDir), 'log must use relative paths, not absolute')
})

// ── Agent log patterns (source code verification) ─────────────────────────────

test('source code emits "agentType cardSlug started" before spawning an agent', () => {
  const src = fs.readFileSync(path.join(__dirname, 'board-viewer.js'), 'utf8')
  assert.match(src, /boardLog\(agentType \+ ' ' \+ cardSlug \+ ' started'\)/, 'start log must be present in source')
  const logPos = src.indexOf("boardLog(agentType + ' ' + cardSlug + ' started')")
  const spawnPos = src.indexOf("spawn('claude'")
  assert.ok(logPos < spawnPos, 'start log must appear before spawn()')
})

test('source code emits "agentType cardSlug success" on agent exit code 0', () => {
  const src = fs.readFileSync(path.join(__dirname, 'board-viewer.js'), 'utf8')
  assert.match(src, /boardLog\(agentType \+ ' ' \+ cardSlug \+ ' success'\)/)
  assert.match(src, /if \(code === 0\)/)
  const codePos = src.indexOf('if (code === 0)')
  const successPos = src.indexOf("boardLog(agentType + ' ' + cardSlug + ' success')")
  assert.ok(codePos < successPos, 'success log must appear after the code === 0 guard')
})

test('source code emits "agentType cardSlug failed" on non-zero agent exit', () => {
  const src = fs.readFileSync(path.join(__dirname, 'board-viewer.js'), 'utf8')
  assert.match(src, /boardLog\(agentType \+ ' ' \+ cardSlug \+ ' failed'\)/)
  const closeHandler = src.match(/proc\.on\('close'[\s\S]*?\}\)\s*\}/)
  assert.ok(closeHandler, 'close handler must exist')
  assert.match(closeHandler[0], /\} else \{[\s\S]*?boardLog\(agentType \+ ' ' \+ cardSlug \+ ' failed'\)/, '"failed" must be in the else branch')
})

// ── Output streams ────────────────────────────────────────────────────────────

test('all log lines go to stdout, none to stderr', async () => {
  createCard('backlog', 'stdout-check.md')
  const stderrBefore = stderrLines.length
  const stdoutBefore = stdoutLines.length

  await request({ method: 'GET', path: '/api/card/backlog/stdout-check.md' })
  await waitForLine(stdoutBefore, /\d{2}:\d{2}:\d{2}.*read/)

  const onStderr = stderrLines.slice(stderrBefore).filter(l => /^\d{2}:\d{2}:\d{2}/.test(l))
  assert.equal(onStderr.length, 0, 'no log-format lines must appear on stderr; found: ' + JSON.stringify(onStderr))
})

test('no log output is produced when the board has no cards', async () => {
  const emptyBoard = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-empty-'))
  const emptyLines = []
  const emptyProc = spawn(process.execPath, [VIEWER, emptyBoard, '13921'], { stdio: ['ignore', 'pipe', 'pipe'] })
  emptyProc.stdout.on('data', chunk => String(chunk).split('\n').filter(Boolean).forEach(l => emptyLines.push(l)))
  emptyProc.stderr.on('data', () => {})

  try {
    await new Promise((resolve, reject) => {
      const deadline = Date.now() + 8000
      function try_ () {
        const req = http.request({ hostname: 'localhost', port: 13921, path: '/', method: 'GET' }, res => {
          res.resume(); resolve()
        })
        req.on('error', () => {
          if (Date.now() > deadline) return reject(new Error('Empty server timed out'))
          setTimeout(try_, 100)
        })
        req.end()
      }
      try_()
    })
    await new Promise(r => setTimeout(r, 1500))

    const logLines = emptyLines.filter(l => /^\d{2}:\d{2}:\d{2}/.test(l))
    assert.equal(logLines.length, 0, 'no log lines expected with empty board; found: ' + JSON.stringify(logLines))
  } finally {
    emptyProc.kill()
    try { fs.rmSync(emptyBoard, { recursive: true, force: true }) } catch {}
  }
})
