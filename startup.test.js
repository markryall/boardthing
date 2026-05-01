'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { spawn } = require('node:child_process')

const VIEWER = path.join(__dirname, 'board-viewer.js')

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

function get (port, urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: 'localhost', port, path: urlPath, method: 'GET' }, res => {
      let data = ''
      res.on('data', c => data += c)
      res.on('end', () => resolve({ status: res.statusCode, body: data }))
    })
    req.on('error', reject)
    req.end()
  })
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

test('bootstrap creates config.json, column dirs, and commands dir when board dir does not exist', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-startup-'))
  const boardDir = path.join(tmpRoot, 'new-board')
  let proc
  try {
    proc = spawn(process.execPath, [VIEWER, boardDir, '13900'], { stdio: 'ignore' })
    await waitForServer(13900)

    assert.ok(fs.existsSync(path.join(boardDir, 'config.json')), 'config.json must be created')
    assert.ok(fs.existsSync(path.join(boardDir, 'commands')), 'commands dir must be created')

    const config = JSON.parse(fs.readFileSync(path.join(boardDir, 'config.json'), 'utf8'))
    assert.ok(Array.isArray(config.columns) && config.columns.length > 0, 'config must have columns')

    for (const col of config.columns) {
      const id = typeof col === 'string' ? col : col.id
      assert.ok(fs.existsSync(path.join(boardDir, id)), `column dir "${id}" must exist`)
    }
  } finally {
    if (proc) proc.kill()
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }) } catch {}
  }
})

test('default config includes spec, implement, and review transitions with command files', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-startup-'))
  const boardDir = path.join(tmpRoot, 'new-board')
  let proc
  try {
    proc = spawn(process.execPath, [VIEWER, boardDir, '13901'], { stdio: 'ignore' })
    await waitForServer(13901)

    const config = JSON.parse(fs.readFileSync(path.join(boardDir, 'config.json'), 'utf8'))
    const agents = (config.transitions || []).map(t => t.agent)
    assert.ok(agents.includes('spec'), 'default config must include spec transition')
    assert.ok(agents.includes('implement'), 'default config must include implement transition')
    assert.ok(agents.includes('review'), 'default config must include review transition')

    assert.ok(fs.existsSync(path.join(boardDir, 'commands', 'spec.md')))
    assert.ok(fs.existsSync(path.join(boardDir, 'commands', 'implement.md')))
    assert.ok(fs.existsSync(path.join(boardDir, 'commands', 'review.md')))
  } finally {
    if (proc) proc.kill()
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }) } catch {}
  }
})

// ── Config validation ──────────────────────────────────────────────────────────

test('server starts when workspace is false and repo is absent', async () => {
  const boardDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-startup-'))
  let proc
  try {
    fs.writeFileSync(path.join(boardDir, 'config.json'), JSON.stringify({
      workspace: false,
      columns: ['todo', 'done'],
      transitions: []
    }))
    proc = spawn(process.execPath, [VIEWER, boardDir, '13902'], { stdio: 'ignore' })
    await waitForServer(13902)
    const res = await get(13902, '/')
    assert.equal(res.status, 200)
  } finally {
    if (proc) proc.kill()
    try { fs.rmSync(boardDir, { recursive: true, force: true }) } catch {}
  }
})

test('server starts when neither workspace nor repo is set in config', async () => {
  const boardDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-startup-'))
  let proc
  try {
    fs.writeFileSync(path.join(boardDir, 'config.json'), JSON.stringify({
      columns: ['todo', 'done'],
      transitions: []
    }))
    proc = spawn(process.execPath, [VIEWER, boardDir, '13903'], { stdio: 'ignore' })
    await waitForServer(13903)
    const res = await get(13903, '/')
    assert.equal(res.status, 200)
  } finally {
    if (proc) proc.kill()
    try { fs.rmSync(boardDir, { recursive: true, force: true }) } catch {}
  }
})

test('server exits non-zero when workspace:true but repo is absent', async () => {
  const boardDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-startup-'))
  try {
    fs.writeFileSync(path.join(boardDir, 'config.json'), JSON.stringify({
      workspace: true,
      columns: ['todo', 'done'],
      transitions: []
    }))
    const exitCode = await new Promise(resolve => {
      const proc = spawn(process.execPath, [VIEWER, boardDir, '13904'], { stdio: 'ignore' })
      proc.on('close', resolve)
    })
    assert.notEqual(exitCode, 0, 'server must exit non-zero when workspace:true but repo is absent')
  } finally {
    try { fs.rmSync(boardDir, { recursive: true, force: true }) } catch {}
  }
})

// ── /api/config endpoint ──────────────────────────────────────────────────────

test('/api/config returns columns array with id, label, and color for each column', async () => {
  const boardDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-startup-'))
  let proc
  try {
    fs.writeFileSync(path.join(boardDir, 'config.json'), JSON.stringify({
      columns: ['backlog', 'done'],
      transitions: []
    }))
    proc = spawn(process.execPath, [VIEWER, boardDir, '13905'], { stdio: 'ignore' })
    await waitForServer(13905)

    const res = await get(13905, '/api/config')
    assert.equal(res.status, 200)
    const { columns } = JSON.parse(res.body)
    assert.ok(Array.isArray(columns) && columns.length >= 2)
    for (const col of columns) {
      assert.ok(typeof col.id === 'string', 'column must have id')
      assert.ok(typeof col.label === 'string', 'column must have label')
      assert.ok(typeof col.color === 'string', 'column must have color')
    }
  } finally {
    if (proc) proc.kill()
    try { fs.rmSync(boardDir, { recursive: true, force: true }) } catch {}
  }
})

test('/api/config returns transitions array with from and to fields', async () => {
  const boardDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-startup-'))
  let proc
  try {
    const commandsDir = path.join(boardDir, 'commands')
    fs.mkdirSync(commandsDir, { recursive: true })
    fs.writeFileSync(path.join(commandsDir, 'done.md'), 'fake\n')
    fs.writeFileSync(path.join(boardDir, 'config.json'), JSON.stringify({
      columns: ['todo', 'done'],
      transitions: [{ from: 'todo', to: 'done', agent: 'done' }]
    }))
    proc = spawn(process.execPath, [VIEWER, boardDir, '13906'], { stdio: 'ignore' })
    await waitForServer(13906)

    const res = await get(13906, '/api/config')
    const { transitions } = JSON.parse(res.body)
    assert.ok(Array.isArray(transitions))
    assert.equal(transitions.length, 1)
    assert.equal(transitions[0].from, 'todo')
    assert.equal(transitions[0].to, 'done')
  } finally {
    if (proc) proc.kill()
    try { fs.rmSync(boardDir, { recursive: true, force: true }) } catch {}
  }
})
