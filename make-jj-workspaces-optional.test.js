'use strict'

// Integration tests for: Make jj workspaces optional
// Acceptance criteria from .board/specification/make-jj-workspaces-optional.md

const { test } = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { spawn } = require('node:child_process')

// ── Test infrastructure ───────────────────────────────────────────────────────

function request (port, options, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: 'localhost', port, ...options }, res => {
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

function startServer (boardDir, port, extraEnv) {
  const proc = spawn(process.execPath, [
    path.join(__dirname, 'board-viewer.js'),
    boardDir,
    String(port)
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...extraEnv }
  })
  proc.stderr.on('data', () => {})
  proc.stdout.on('data', () => {})
  return proc
}

function poolPost (port, col, delta) {
  return request(port, {
    method: 'POST',
    path: '/api/watcher/' + encodeURIComponent(col) + '/pool',
    headers: { 'Content-Type': 'application/json' }
  }, JSON.stringify({ delta }))
}

function setupBoard (boardDir, config) {
  fs.writeFileSync(path.join(boardDir, 'config.json'), JSON.stringify(config, null, 2))
  const commandsDir = path.join(boardDir, 'commands')
  fs.mkdirSync(commandsDir, { recursive: true })
  const cols = (config.columns || []).map(c => typeof c === 'string' ? c : c.id)
  for (const col of cols) {
    fs.mkdirSync(path.join(boardDir, col), { recursive: true })
    // Write a fake agent command for each column that has a transition
    const trans = (config.transitions || []).find(t => t.to === col)
    if (trans) {
      const agentName = trans.agent || col
      fs.writeFileSync(path.join(commandsDir, agentName + '.md'), 'Fake agent command\n')
    }
  }
}

// ── AC1: Server starts with workspace:false and no repo ───────────────────────

test('AC1 – server starts with workspace:false and no repo field in config', async () => {
  const PORT = 13820
  const boardDir = fs.mkdtempSync(path.join(os.tmpdir(), 'boardthing-ws-opt-'))
  let serverProcess
  try {
    setupBoard(boardDir, {
      workspace: false,
      columns: ['todo', 'done'],
      transitions: [{ from: 'todo', to: 'done', agent: 'done' }]
    })

    serverProcess = startServer(boardDir, PORT)
    await waitForServer(PORT)

    const res = await request(PORT, { method: 'GET', path: '/' })
    assert.equal(res.status, 200, 'Server should respond 200 OK')
  } finally {
    if (serverProcess) serverProcess.kill()
    try { fs.rmSync(boardDir, { recursive: true, force: true }) } catch {}
  }
})

// ── AC2: Server starts when neither workspace nor repo is set ─────────────────

test('AC2 – server starts when neither workspace nor repo is set in config', async () => {
  const PORT = 13821
  const boardDir = fs.mkdtempSync(path.join(os.tmpdir(), 'boardthing-ws-opt-'))
  let serverProcess
  try {
    setupBoard(boardDir, {
      columns: ['todo', 'done'],
      transitions: [{ from: 'todo', to: 'done', agent: 'done' }]
    })

    serverProcess = startServer(boardDir, PORT)
    await waitForServer(PORT)

    const res = await request(PORT, { method: 'GET', path: '/' })
    assert.equal(res.status, 200, 'Server should respond 200 OK when neither workspace nor repo is set')
  } finally {
    if (serverProcess) serverProcess.kill()
    try { fs.rmSync(boardDir, { recursive: true, force: true }) } catch {}
  }
})

// ── AC3: Server exits non-zero when workspace:true but repo is absent ─────────

test('AC3 – server exits non-zero when workspace:true is set but repo is absent', async () => {
  const boardDir = fs.mkdtempSync(path.join(os.tmpdir(), 'boardthing-ws-opt-'))
  try {
    fs.writeFileSync(path.join(boardDir, 'config.json'), JSON.stringify({
      workspace: true,
      columns: ['todo', 'done'],
      transitions: [{ from: 'todo', to: 'done', agent: 'done' }]
    }, null, 2))

    const exitCode = await new Promise(resolve => {
      const proc = spawn(process.execPath, [
        path.join(__dirname, 'board-viewer.js'),
        boardDir,
        '13822'
      ], { stdio: 'ignore' })
      proc.on('close', resolve)
    })

    assert.notEqual(exitCode, 0, 'Server should exit non-zero when workspace:true but repo is missing')
  } finally {
    try { fs.rmSync(boardDir, { recursive: true, force: true }) } catch {}
  }
})

// ── AC4: workspace:false → spawned agent prompt has no jj workspace instructions

test('AC4 – workspace:false: agent spawn prompt does not contain jj workspace instructions', async () => {
  const PORT = 13823
  const boardDir = fs.mkdtempSync(path.join(os.tmpdir(), 'boardthing-ws-opt-'))
  const fakeClaudeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-claude-'))
  const promptFile = path.join(fakeClaudeDir, 'captured-prompt.txt')
  let serverProcess
  try {
    // Fake claude: captures the -p argument to a file then exits
    const fakeClaudePath = path.join(fakeClaudeDir, 'claude')
    fs.writeFileSync(fakeClaudePath, [
      '#!/usr/bin/env node',
      'const fs = require("fs")',
      'const args = process.argv.slice(2)',
      'const pIdx = args.indexOf("-p")',
      'if (pIdx !== -1) fs.writeFileSync(' + JSON.stringify(promptFile) + ', args[pIdx + 1])',
      'process.exit(0)'
    ].join('\n'))
    fs.chmodSync(fakeClaudePath, '755')

    setupBoard(boardDir, {
      workspace: false,
      columns: ['todo', 'done'],
      transitions: [{ from: 'todo', to: 'done', agent: 'done' }]
    })
    // Drop a card so a spawn is triggered when pool goes up
    fs.writeFileSync(path.join(boardDir, 'todo', 'my-task.md'), '# My task\n')

    const fakeClaudeBin = fakeClaudeDir + path.delimiter + (process.env.PATH || '')
    serverProcess = startServer(boardDir, PORT, { PATH: fakeClaudeBin })
    await waitForServer(PORT)
    await poolPost(PORT, 'todo', 1)

    // Poll until fake claude writes the prompt file (up to 5 s)
    const deadline = Date.now() + 5000
    while (!fs.existsSync(promptFile)) {
      if (Date.now() > deadline) throw new Error('Fake claude was never invoked — prompt file not created within 5 s')
      await new Promise(r => setTimeout(r, 100))
    }

    const prompt = fs.readFileSync(promptFile, 'utf8')
    assert.ok(
      !prompt.includes('jj workspace add'),
      'Prompt must NOT contain "jj workspace add" when workspace:false'
    )
    assert.ok(
      !prompt.includes('## Workspace'),
      'Prompt must NOT reference "## Workspace" when workspace:false'
    )
  } finally {
    if (serverProcess) serverProcess.kill()
    try { fs.rmSync(boardDir, { recursive: true, force: true }) } catch {}
    try { fs.rmSync(fakeClaudeDir, { recursive: true, force: true }) } catch {}
  }
})

// ── AC5: repo set + workspace not false → prompt DOES contain workspace instructions

test('AC5 – repo set and workspace not false: agent spawn prompt contains jj workspace instructions', async () => {
  const PORT = 13824
  const boardDir = fs.mkdtempSync(path.join(os.tmpdir(), 'boardthing-ws-opt-'))
  const fakeClaudeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-claude-'))
  const promptFile = path.join(fakeClaudeDir, 'captured-prompt.txt')
  let serverProcess
  try {
    // Fake claude: captures the -p argument to a file then exits
    const fakeClaudePath = path.join(fakeClaudeDir, 'claude')
    fs.writeFileSync(fakeClaudePath, [
      '#!/usr/bin/env node',
      'const fs = require("fs")',
      'const args = process.argv.slice(2)',
      'const pIdx = args.indexOf("-p")',
      'if (pIdx !== -1) fs.writeFileSync(' + JSON.stringify(promptFile) + ', args[pIdx + 1])',
      'process.exit(0)'
    ].join('\n'))
    fs.chmodSync(fakeClaudePath, '755')

    setupBoard(boardDir, {
      repo: boardDir, // boardDir is an absolute path — treated as the jj repo root
      columns: ['todo', 'done'],
      transitions: [{ from: 'todo', to: 'done', agent: 'done' }]
    })
    fs.writeFileSync(path.join(boardDir, 'todo', 'my-task.md'), '# My task\n')

    const fakeClaudeBin = fakeClaudeDir + path.delimiter + (process.env.PATH || '')
    serverProcess = startServer(boardDir, PORT, { PATH: fakeClaudeBin })
    await waitForServer(PORT)
    await poolPost(PORT, 'todo', 1)

    // Poll until fake claude writes the prompt file (up to 5 s)
    const deadline = Date.now() + 5000
    while (!fs.existsSync(promptFile)) {
      if (Date.now() > deadline) throw new Error('Fake claude was never invoked — prompt file not created within 5 s')
      await new Promise(r => setTimeout(r, 100))
    }

    const prompt = fs.readFileSync(promptFile, 'utf8')
    assert.ok(
      prompt.includes('jj workspace add'),
      'Prompt MUST contain "jj workspace add" when repo is set and workspace is not false'
    )
  } finally {
    if (serverProcess) serverProcess.kill()
    try { fs.rmSync(boardDir, { recursive: true, force: true }) } catch {}
    try { fs.rmSync(fakeClaudeDir, { recursive: true, force: true }) } catch {}
  }
})
