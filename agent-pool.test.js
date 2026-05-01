'use strict'

const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { spawn } = require('node:child_process')

const PORT = 13930
const VIEWER = path.join(__dirname, 'board-viewer.js')

let serverProcess
let boardDir

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

function poolPost (col, delta, port) {
  return request(
    { method: 'POST', path: '/api/watcher/' + encodeURIComponent(col) + '/pool', headers: { 'Content-Type': 'application/json' }, ...(port ? { port } : {}) },
    JSON.stringify({ delta })
  )
}

async function getStatus () {
  const res = await request({ method: 'GET', path: '/api/watcher/status' })
  return JSON.parse(res.body)
}

// ── Setup ─────────────────────────────────────────────────────────────────────

before(async () => {
  boardDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-pool-'))

  const config = {
    columns: ['todo', 'done', 'no-transition'],
    transitions: [{ from: 'todo', to: 'done', agent: 'done' }]
  }
  fs.writeFileSync(path.join(boardDir, 'config.json'), JSON.stringify(config))

  const commandsDir = path.join(boardDir, 'commands')
  fs.mkdirSync(commandsDir, { recursive: true })
  fs.writeFileSync(path.join(commandsDir, 'done.md'), 'Fake agent\n')

  for (const col of config.columns) fs.mkdirSync(path.join(boardDir, col), { recursive: true })

  serverProcess = spawn(process.execPath, [VIEWER, boardDir, String(PORT)], {
    stdio: ['ignore', 'pipe', 'pipe']
  })
  serverProcess.stdout.on('data', () => {})
  serverProcess.stderr.on('data', () => {})

  await waitForServer(PORT)
})

after(() => {
  if (serverProcess) serverProcess.kill()
  try { fs.rmSync(boardDir, { recursive: true, force: true }) } catch {}
})

// ── Initial state ─────────────────────────────────────────────────────────────

test('pool size is 0 for all transition columns on startup', async () => {
  const status = await getStatus()
  assert.ok('todo' in status, '"todo" must appear in status (it has a transition)')
  assert.equal(status.todo.poolSize, 0, 'poolSize must be 0 on startup')
  assert.equal(status.todo.activeCount, 0, 'activeCount must be 0 on startup')
  assert.ok(!('no-transition' in status), 'columns without transitions must not appear in status')
})

// ── Increment / decrement ─────────────────────────────────────────────────────

test('POST /pool delta:1 increments the pool size by exactly 1', async () => {
  const before = (await getStatus()).todo.poolSize
  const res = await poolPost('todo', 1)
  assert.equal(res.status, 200)
  assert.ok(JSON.parse(res.body).ok)
  assert.equal((await getStatus()).todo.poolSize, before + 1)
  await poolPost('todo', -1)
})

test('POST /pool delta:-1 decrements the pool size by exactly 1 when pool > 0', async () => {
  await poolPost('todo', 1)
  await poolPost('todo', 1)
  const before = (await getStatus()).todo.poolSize
  assert.equal(before, 2)

  const res = await poolPost('todo', -1)
  assert.equal(res.status, 200)
  assert.equal((await getStatus()).todo.poolSize, before - 1)
  await poolPost('todo', -1)
})

test('POST /pool delta:-1 returns 400 and leaves pool at 0 when already at 0', async () => {
  assert.equal((await getStatus()).todo.poolSize, 0)
  const res = await poolPost('todo', -1)
  assert.equal(res.status, 400)
  assert.equal((await getStatus()).todo.poolSize, 0)
})

// ── Status endpoint ───────────────────────────────────────────────────────────

test('GET /api/watcher/status returns integer poolSize and activeCount per transition column', async () => {
  const status = await getStatus()
  assert.ok('todo' in status)
  assert.equal(typeof status.todo.poolSize, 'number')
  assert.equal(typeof status.todo.activeCount, 'number')
  assert.equal(Math.floor(status.todo.poolSize), status.todo.poolSize)
  assert.equal(Math.floor(status.todo.activeCount), status.todo.activeCount)
})

// ── Removed endpoints ─────────────────────────────────────────────────────────

test('POST /api/watcher/:col/start and /stop return 404', async () => {
  const startRes = await request({ method: 'POST', path: '/api/watcher/todo/start' })
  const stopRes = await request({ method: 'POST', path: '/api/watcher/todo/stop' })
  assert.equal(startRes.status, 404)
  assert.equal(stopRes.status, 404)
})

// ── Invariants ────────────────────────────────────────────────────────────────

test('activeCount never exceeds poolSize', async () => {
  await poolPost('todo', 1)
  await poolPost('todo', 1)
  const status = await getStatus()
  assert.ok(status.todo.activeCount <= status.todo.poolSize)
  await poolPost('todo', -1)
  await poolPost('todo', -1)
})

test('filesystem watching stops and no agents spawn when pool size reaches 0', async () => {
  await poolPost('todo', 1)
  assert.equal((await getStatus()).todo.poolSize, 1)
  await poolPost('todo', -1)
  assert.equal((await getStatus()).todo.poolSize, 0)

  const cardPath = path.join(boardDir, 'todo', 'sentinel.md')
  fs.writeFileSync(cardPath, '# Sentinel\n')
  await new Promise(r => setTimeout(r, 800))
  assert.ok(!fs.existsSync(cardPath + '.wip'), 'no agent must have processed the card with pool at 0')
  try { fs.unlinkSync(cardPath) } catch {}
})

// ── Agent prompt: workspace instructions ──────────────────────────────────────

test('agent spawn prompt contains no jj workspace instructions when workspace is false', async () => {
  const testBoard = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-pool-ws-'))
  const fakeClaudeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-fakeclaude-'))
  const promptFile = path.join(fakeClaudeDir, 'prompt.txt')
  let proc
  try {
    const fakeClaude = path.join(fakeClaudeDir, 'claude')
    fs.writeFileSync(fakeClaude, [
      '#!/usr/bin/env node',
      'const fs = require("fs")',
      'const args = process.argv.slice(2)',
      'const pIdx = args.indexOf("-p")',
      'if (pIdx !== -1) fs.writeFileSync(' + JSON.stringify(promptFile) + ', args[pIdx + 1])',
      'process.exit(0)'
    ].join('\n'))
    fs.chmodSync(fakeClaude, '755')

    const commandsDir = path.join(testBoard, 'commands')
    fs.mkdirSync(commandsDir, { recursive: true })
    fs.writeFileSync(path.join(commandsDir, 'done.md'), 'Fake agent\n')
    fs.mkdirSync(path.join(testBoard, 'todo'), { recursive: true })
    fs.writeFileSync(path.join(testBoard, 'todo', 'task.md'), '# Task\n')
    fs.writeFileSync(path.join(testBoard, 'config.json'), JSON.stringify({
      workspace: false,
      columns: ['todo', 'done'],
      transitions: [{ from: 'todo', to: 'done', agent: 'done' }]
    }))

    const env = { ...process.env, PATH: fakeClaudeDir + path.delimiter + process.env.PATH }
    proc = spawn(process.execPath, [VIEWER, testBoard, '13931'], { stdio: 'ignore', env })
    await waitForServer(13931)

    await new Promise((resolve, reject) => {
      const req = http.request({ hostname: 'localhost', port: 13931, path: '/api/watcher/todo/pool', method: 'POST', headers: { 'Content-Type': 'application/json' } }, res => { res.resume(); resolve() })
      req.on('error', reject)
      req.write(JSON.stringify({ delta: 1 }))
      req.end()
    })

    const deadline = Date.now() + 5000
    while (!fs.existsSync(promptFile)) {
      if (Date.now() > deadline) throw new Error('Fake claude was never invoked')
      await new Promise(r => setTimeout(r, 100))
    }

    const prompt = fs.readFileSync(promptFile, 'utf8')
    assert.ok(!prompt.includes('jj workspace add'), 'prompt must not contain jj workspace instructions when workspace:false')
    assert.ok(!prompt.includes('## Workspace'), 'prompt must not reference ## Workspace when workspace:false')
  } finally {
    if (proc) proc.kill()
    try { fs.rmSync(testBoard, { recursive: true, force: true }) } catch {}
    try { fs.rmSync(fakeClaudeDir, { recursive: true, force: true }) } catch {}
  }
})

test('agent spawn prompt contains jj workspace instructions when repo is set and workspace is not false', async () => {
  const testBoard = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-pool-ws-'))
  const fakeClaudeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-fakeclaude-'))
  const promptFile = path.join(fakeClaudeDir, 'prompt.txt')
  let proc
  try {
    const fakeClaude = path.join(fakeClaudeDir, 'claude')
    fs.writeFileSync(fakeClaude, [
      '#!/usr/bin/env node',
      'const fs = require("fs")',
      'const args = process.argv.slice(2)',
      'const pIdx = args.indexOf("-p")',
      'if (pIdx !== -1) fs.writeFileSync(' + JSON.stringify(promptFile) + ', args[pIdx + 1])',
      'process.exit(0)'
    ].join('\n'))
    fs.chmodSync(fakeClaude, '755')

    const commandsDir = path.join(testBoard, 'commands')
    fs.mkdirSync(commandsDir, { recursive: true })
    fs.writeFileSync(path.join(commandsDir, 'done.md'), 'Fake agent\n')
    fs.mkdirSync(path.join(testBoard, 'todo'), { recursive: true })
    fs.writeFileSync(path.join(testBoard, 'todo', 'task.md'), '# Task\n')
    fs.writeFileSync(path.join(testBoard, 'config.json'), JSON.stringify({
      repo: testBoard,
      columns: ['todo', 'done'],
      transitions: [{ from: 'todo', to: 'done', agent: 'done' }]
    }))

    const env = { ...process.env, PATH: fakeClaudeDir + path.delimiter + process.env.PATH }
    proc = spawn(process.execPath, [VIEWER, testBoard, '13932'], { stdio: 'ignore', env })
    await waitForServer(13932)

    await new Promise((resolve, reject) => {
      const req = http.request({ hostname: 'localhost', port: 13932, path: '/api/watcher/todo/pool', method: 'POST', headers: { 'Content-Type': 'application/json' } }, res => { res.resume(); resolve() })
      req.on('error', reject)
      req.write(JSON.stringify({ delta: 1 }))
      req.end()
    })

    const deadline = Date.now() + 5000
    while (!fs.existsSync(promptFile)) {
      if (Date.now() > deadline) throw new Error('Fake claude was never invoked')
      await new Promise(r => setTimeout(r, 100))
    }

    const prompt = fs.readFileSync(promptFile, 'utf8')
    assert.ok(prompt.includes('jj workspace add'), 'prompt must contain jj workspace instructions when repo is set')
  } finally {
    if (proc) proc.kill()
    try { fs.rmSync(testBoard, { recursive: true, force: true }) } catch {}
    try { fs.rmSync(fakeClaudeDir, { recursive: true, force: true }) } catch {}
  }
})
