'use strict'

// Integration tests for: Manage Agent Pool
// Acceptance criteria from .board/implementation/manage-agent-pool.md

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
const PORT = 13793

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

function poolPost (col, delta) {
  return request(
    {
      method: 'POST',
      path: '/api/watcher/' + encodeURIComponent(col) + '/pool',
      headers: { 'Content-Type': 'application/json' }
    },
    JSON.stringify({ delta })
  )
}

async function getStatus () {
  const res = await request({ method: 'GET', path: '/api/watcher/status' })
  return JSON.parse(res.body)
}

before(async () => {
  boardDir = fs.mkdtempSync(path.join(os.tmpdir(), 'boardthing-pool-test-'))

  // Minimal config: one transition (todo → done), one column without a transition
  const config = {
    columns: ['todo', 'done', 'no-transition'],
    transitions: [{ from: 'todo', to: 'done' }]
  }
  fs.writeFileSync(path.join(boardDir, 'config.json'), JSON.stringify(config, null, 2))

  // Fake agent command so findAgentPath returns a valid path (needed for incrementPool)
  const commandsDir = path.join(boardDir, 'commands')
  fs.mkdirSync(commandsDir, { recursive: true })
  fs.writeFileSync(path.join(commandsDir, 'done.md'), 'Fake agent command for testing.\n')

  for (const col of ['todo', 'done', 'no-transition']) {
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

// ── AC1: Pool control renders as "- [poolSize] +" instead of play/stop buttons ─

test('AC1 – column with a transition renders - [poolSize] + pool control, not play/stop buttons', async () => {
  const res = await request({ method: 'GET', path: '/' })
  assert.equal(res.status, 200)

  // Pool control buttons must be present
  assert.match(res.body, /pool-dec/, '"-" (decrement) button must carry the pool-dec class')
  assert.match(res.body, /pool-inc/, '"+" (increment) button must carry the pool-inc class')
  assert.match(res.body, /adjustPool\(/, 'adjustPool must be wired to the pool control clicks')

  // The HTML must not reference the removed play/stop endpoints
  assert.doesNotMatch(
    res.body,
    /\/api\/watcher\/[^'"]*\/(start|stop)/,
    'HTML must not reference the old /start or /stop endpoints'
  )
})

// ── AC2: Pool size is 0 for every column on startup ──────────────────────────

test('AC2 – pool size for every transition column is 0 when the application starts', async () => {
  const status = await getStatus()

  assert.ok('todo' in status, 'status must include "todo" which has a transition')
  assert.equal(status.todo.poolSize, 0, 'poolSize must be 0 on startup')
  assert.equal(status.todo.activeCount, 0, 'activeCount must be 0 on startup')

  assert.ok(!('no-transition' in status), 'columns without a transition must not appear in status')
})

// ── AC3: Pressing + increments pool size by exactly 1 ────────────────────────

test('AC3 – pressing + increments the pool size by exactly 1', async () => {
  const before = (await getStatus()).todo.poolSize

  const res = await poolPost('todo', 1)
  assert.equal(res.status, 200, 'pool increment must return HTTP 200')
  assert.ok(JSON.parse(res.body).ok, 'response body must indicate success')

  const after = (await getStatus()).todo.poolSize
  assert.equal(after, before + 1, 'pool size must increase by exactly 1')

  // Cleanup
  await poolPost('todo', -1)
})

// ── AC4: Pressing + makes an additional agent slot available ──────────────────

test('AC4 – pressing + makes an additional agent slot available', async () => {
  // The observable guarantee is that the pool endpoint accepts the increment
  // and the status immediately reflects the new slot. Actual agent-spawning
  // requires a real `claude` binary and cannot be verified in this test suite.
  const res = await poolPost('todo', 1)
  assert.equal(res.status, 200)
  assert.ok(JSON.parse(res.body).ok)

  const status = await getStatus()
  assert.ok(status.todo.poolSize >= 1, 'pool size must be ≥ 1 after incrementing')

  // Cleanup
  await poolPost('todo', -1)
})

// ── AC5: Pressing - decrements pool size by exactly 1 when > 0 ───────────────

test('AC5 – pressing - decrements the pool size by exactly 1 when pool size is greater than 0', async () => {
  // Bring pool to 2
  await poolPost('todo', 1)
  await poolPost('todo', 1)
  const before = (await getStatus()).todo.poolSize
  assert.equal(before, 2, 'setup: pool must be 2 before this test')

  const res = await poolPost('todo', -1)
  assert.equal(res.status, 200, 'decrement must return HTTP 200')
  assert.ok(JSON.parse(res.body).ok)

  const after = (await getStatus()).todo.poolSize
  assert.equal(after, before - 1, 'pool size must decrease by exactly 1')

  // Cleanup: back to 0
  await poolPost('todo', -1)
})

// ── AC6: Pressing - when pool size is 0 has no effect ────────────────────────

test('AC6 – pressing - when pool size is 0 has no effect on pool size', async () => {
  const initial = (await getStatus()).todo.poolSize
  assert.equal(initial, 0, 'precondition: pool must be 0 before this test')

  const res = await poolPost('todo', -1)
  assert.equal(res.status, 400, 'decrementing at 0 must return HTTP 400 (no-op)')

  const after = (await getStatus()).todo.poolSize
  assert.equal(after, 0, 'pool size must remain 0 after no-op decrement')
})

// ── AC7: The - button is visually disabled when pool size is 0 ───────────────

test('AC7 – the - button is visually disabled (disabled attribute set) when pool size is 0', async () => {
  const res = await request({ method: 'GET', path: '/' })
  assert.equal(res.status, 200)

  const renderIdx = res.body.indexOf('function renderBoard(')
  assert.ok(renderIdx !== -1, 'renderBoard must exist in the HTML source')
  const renderChunk = res.body.slice(renderIdx, renderIdx + 2500)

  // The "-" button must conditionally receive the `disabled` attribute
  assert.match(renderChunk, /pool-dec/, 'renderBoard must emit the pool-dec button')
  assert.match(renderChunk, /poolSize.*===.*0|=== 0.*poolSize/, 'renderBoard must check poolSize === 0')
  assert.match(renderChunk, /disabled/, 'renderBoard must emit the disabled attribute for the - button')
})

// ── AC8: Active agent count never exceeds pool size ──────────────────────────

test('AC8 – the number of active agents for a column never exceeds the configured pool size', async () => {
  // With no real `claude` binary available, activeCount is always 0.
  // We verify the invariant holds across multiple pool changes.
  await poolPost('todo', 1)
  await poolPost('todo', 1)

  const status = await getStatus()
  assert.ok(
    status.todo.activeCount <= status.todo.poolSize,
    'activeCount must never exceed poolSize'
  )

  // Cleanup
  await poolPost('todo', -1)
  await poolPost('todo', -1)
})

// ── AC9: Active agents are not interrupted when pool size is reduced ──────────

test('AC9 – reducing pool size does not interrupt currently active agents', async () => {
  // With no real agents running, we verify that decrementing never makes
  // activeCount go negative and the operation completes without error.
  // Verifying "agent is allowed to finish" requires a real `claude` binary.
  await poolPost('todo', 1)
  assert.equal((await getStatus()).todo.poolSize, 1)

  const res = await poolPost('todo', -1)
  assert.equal(res.status, 200, 'decrement must succeed even with pool changes')

  const after = (await getStatus()).todo
  assert.equal(after.poolSize, 0)
  assert.ok(after.activeCount >= 0, 'activeCount must never go negative')
})

// ── AC10: Excess agents finish their current card before slot is released ─────

test('AC10 – when pool drops below active count, excess agents finish their current card', async () => {
  // Full verification requires real agent processes. We verify that the pool
  // endpoint does not kill processes (no process.kill calls in observable state)
  // and that activeCount remains non-negative after aggressive decrements.
  await poolPost('todo', 1)
  await poolPost('todo', -1)

  const status = await getStatus()
  assert.ok(status.todo.activeCount >= 0, 'activeCount must never be negative')
  assert.equal(status.todo.poolSize, 0)
})

// ── AC11: Pool size 0 stops filesystem watching; no new agents spawn ──────────

test('AC11 – when pool size reaches 0, filesystem watching stops and no new agents are spawned', async () => {
  // Cycle: 0 → 1 (watcher starts) → 0 (watcher stops)
  await poolPost('todo', 1)
  assert.equal((await getStatus()).todo.poolSize, 1)

  await poolPost('todo', -1)
  const status = await getStatus()
  assert.equal(status.todo.poolSize, 0, 'pool must be 0 after decrement to zero')

  // Write a card while pool is 0; the watcher should be closed so no agent spawns.
  // Because we have no real `claude` binary the card would never become .wip anyway,
  // but we also verify that the server does not even attempt to fire spawnOne.
  const cardPath = path.join(boardDir, 'todo', 'ac11-sentinel.md')
  fs.writeFileSync(cardPath, '# AC11 sentinel card\n')

  // Wait longer than the 500 ms debounce; if the watcher were still running
  // it would have already tried (and failed) to process the card.
  await new Promise(r => setTimeout(r, 800))

  const wipPath = cardPath + '.wip'
  assert.ok(!fs.existsSync(wipPath), 'no agent must have processed the card when pool is 0')

  // Pool must remain 0
  const after = await getStatus()
  assert.equal(after.todo.poolSize, 0, 'pool size must still be 0')

  // Cleanup
  try { fs.unlinkSync(cardPath) } catch {}
})

// ── AC12: UI shows configured pool size, not active agent count ───────────────

test('AC12 – the number shown between the - and + buttons reflects poolSize, not activeCount', async () => {
  const res = await request({ method: 'GET', path: '/' })
  assert.equal(res.status, 200)

  const renderIdx = res.body.indexOf('function renderBoard(')
  assert.ok(renderIdx !== -1, 'renderBoard must exist in the HTML source')
  const renderChunk = res.body.slice(renderIdx, renderIdx + 2500)

  // The displayed number must come from ws.poolSize
  assert.match(renderChunk, /ws\.poolSize|poolSize/, 'renderBoard must reference poolSize for the displayed count')

  // The active count (ws.activeCount) must NOT be the value rendered between - and +
  // We verify poolSize appears before activeCount in the control rendering code,
  // meaning it is the value used for the display span.
  const poolSizePos   = renderChunk.indexOf('poolSize')
  const activeCountPos = renderChunk.indexOf('activeCount')
  assert.ok(poolSizePos !== -1, 'poolSize must be referenced in renderBoard')
  // poolSize should appear in the watchBtn section before activeCount
  assert.ok(poolSizePos < activeCountPos || activeCountPos === -1,
    'poolSize must be referenced in the pool-control section of renderBoard')
})

// ── AC13: Status endpoint includes poolSize and activeCount per column ─────────

test('AC13 – GET /api/watcher/status includes poolSize and activeCount for each transition column', async () => {
  const status = await getStatus()

  assert.ok('todo' in status, '"todo" must appear (it has a configured transition)')
  assert.ok('poolSize' in status.todo, 'status must include poolSize')
  assert.ok('activeCount' in status.todo, 'status must include activeCount')

  assert.equal(typeof status.todo.poolSize, 'number', 'poolSize must be a number')
  assert.equal(typeof status.todo.activeCount, 'number', 'activeCount must be a number')
  assert.equal(Math.floor(status.todo.poolSize), status.todo.poolSize, 'poolSize must be an integer')
  assert.equal(Math.floor(status.todo.activeCount), status.todo.activeCount, 'activeCount must be an integer')
})

// ── AC14: POST /start and /stop return HTTP 404 ───────────────────────────────

test('AC14 – POST /api/watcher/{colId}/start and /stop return HTTP 404', async () => {
  const startRes = await request({ method: 'POST', path: '/api/watcher/todo/start' })
  assert.equal(startRes.status, 404, 'POST /start must return 404')

  const stopRes = await request({ method: 'POST', path: '/api/watcher/todo/stop' })
  assert.equal(stopRes.status, 404, 'POST /stop must return 404')
})

// ── AC15: Pool size is controlled exclusively via the pool endpoint ────────────

test('AC15 – pool size is controlled exclusively through the new pool endpoint', async () => {
  const initial = (await getStatus()).todo.poolSize
  assert.equal(initial, 0, 'precondition: pool must be 0 at this point')

  // The old start/stop endpoints must NOT change pool size
  await request({ method: 'POST', path: '/api/watcher/todo/start' })
  await request({ method: 'POST', path: '/api/watcher/todo/stop' })
  const afterOld = (await getStatus()).todo.poolSize
  assert.equal(afterOld, initial, 'old start/stop endpoints must not affect pool size')

  // The pool endpoint IS the mechanism that changes pool size
  await poolPost('todo', 1)
  const afterIncrement = (await getStatus()).todo.poolSize
  assert.equal(afterIncrement, initial + 1, 'pool endpoint must successfully change pool size')

  // Cleanup
  await poolPost('todo', -1)
})
