'use strict'

// Integration tests for: Delete Cards feature
// Acceptance criteria from .board/implementation/delete-cards.md

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
const PORT = 13792

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

before(async () => {
  boardDir = fs.mkdtempSync(path.join(os.tmpdir(), 'boardthing-delete-test-'))

  // Create a column directory the tests will use
  fs.mkdirSync(path.join(boardDir, 'todo'), { recursive: true })

  serverProcess = spawn(process.execPath, [
    path.join(__dirname, 'board-viewer.js'),
    boardDir,
    String(PORT)
  ], { stdio: ['ignore', 'pipe', 'pipe'] })

  serverProcess.stderr.on('data', () => {}) // suppress noise
  serverProcess.stdout.on('data', () => {})

  await waitForServer(PORT)
})

after(() => {
  if (serverProcess) serverProcess.kill()
  try { fs.rmSync(boardDir, { recursive: true, force: true }) } catch {}
})

// Helper: write a card file in a column
function createCardFile (col, filename, content = '# Test card\n') {
  const dir = path.join(boardDir, col)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, filename), content)
}

// ── Criterion 1: Delete button is visible in the card modal alongside Edit ───

test('AC1 – Delete button is rendered in the modal header alongside the Edit button', async () => {
  const res = await request({ method: 'GET', path: '/' })
  assert.equal(res.status, 200)
  // Both buttons must appear in the same header block
  assert.match(res.body, /id="modal-edit-btn"/, 'Edit button must be present')
  assert.match(res.body, /id="modal-delete-btn"/, 'Delete button must be present')
  // Delete button calls deleteCard() and is in the same flex container
  assert.match(res.body, /onclick="deleteCard\(\)"/, 'Delete button must trigger deleteCard()')
})

// ── Criterion 2: Clicking Delete shows a confirmation prompt ─────────────────

test('AC2 – deleteCard() shows a browser confirm() dialog before taking action', async () => {
  const res = await request({ method: 'GET', path: '/' })
  assert.equal(res.status, 200)
  // The deleteCard function must call confirm()
  assert.match(res.body, /function deleteCard\b/, 'deleteCard function must be defined')
  assert.match(res.body, /confirm\(/, 'deleteCard must call confirm()')
})

// ── Criterion 3: Confirmed deletion removes the file and returns HTTP 200 ────

test('AC3 – DELETE /api/card/:col/:filename removes the file and returns HTTP 200', async () => {
  const filename = 'ac3-test.md'
  createCardFile('todo', filename)
  const filePath = path.join(boardDir, 'todo', filename)
  assert.ok(fs.existsSync(filePath), 'file must exist before deletion')

  const res = await request({ method: 'DELETE', path: '/api/card/todo/' + filename })

  assert.equal(res.status, 200)
  assert.ok(!fs.existsSync(filePath), 'file must be gone from disk after deletion')
})

// ── Criterion 4: Cancelled confirmation leaves the file intact ───────────────

test('AC4 – deleteCard() returns before fetching when confirm() is cancelled', async () => {
  const res = await request({ method: 'GET', path: '/' })
  assert.equal(res.status, 200)

  // The JS source must return early (before any fetch) when confirm() is falsy.
  // Verify the code pattern: `if (!confirm(...)) return` must appear before the
  // fetch call inside deleteCard.
  const deleteCardMatch = res.body.match(/async function deleteCard\b[\s\S]*?^    \}/m)
  // Simpler: grab the text between "deleteCard" and the next blank-line-terminated function
  const fnStart = res.body.indexOf('async function deleteCard()')
  assert.ok(fnStart !== -1, 'deleteCard function must exist')
  const fnChunk = res.body.slice(fnStart, fnStart + 800)

  const confirmPos = fnChunk.indexOf('confirm(')
  const fetchPos   = fnChunk.indexOf("fetch('/api/card/")
  assert.ok(confirmPos !== -1, 'confirm() must be in deleteCard')
  assert.ok(fetchPos !== -1, 'fetch must be in deleteCard')
  assert.ok(confirmPos < fetchPos, 'confirm() must appear before fetch() in deleteCard')
  // There must be a `return` between the confirm and the fetch
  const between = fnChunk.slice(confirmPos, fetchPos)
  assert.match(between, /return/, 'there must be a return statement between confirm() and fetch()')
})

// ── Criterion 5: DELETE endpoint exists with path-traversal guard ────────────

test('AC5 – DELETE /api/card/:col/:filename endpoint exists and guards path traversal', async () => {
  // Verify the endpoint exists and is reachable (a missing file → 400, not 404)
  const res = await request({ method: 'DELETE', path: '/api/card/todo/nonexistent.md' })
  // Any response other than 404 proves the route is handled
  assert.notEqual(res.status, 404, 'DELETE route must be handled (not fall through to 404)')

  // Path-traversal: encode a `../` in the column segment so decodeURIComponent
  // produces `../outside`, causing path.resolve to land outside BOARD_DIR.
  // %2F in a URL path segment is not treated as a separator by new URL(), so
  // the regex captures it as part of col, then decodeURIComponent decodes it.
  const traversalRes = await request({
    method: 'DELETE',
    path: '/api/card/..%2Foutside/something.md'
  })
  assert.equal(traversalRes.status, 403, 'path traversal attempt must return 403')
})

// ── Criterion 6: DELETE returns 400 if the file does not exist ───────────────

test('AC6 – DELETE returns HTTP 400 when the target file does not exist', async () => {
  const res = await request({ method: 'DELETE', path: '/api/card/todo/no-such-file.md' })
  assert.equal(res.status, 400)
})

// ── Criterion 7: DELETE returns 403 if the resolved path is outside BOARD_DIR ─

test('AC7 – DELETE returns HTTP 403 for paths that escape BOARD_DIR', async () => {
  // Encode `../` in the column name; decodeURIComponent on the server turns it
  // into a path component that escapes BOARD_DIR.
  const res = await request({
    method: 'DELETE',
    path: '/api/card/..%2Fescaped/something.md'
  })
  assert.equal(res.status, 403)
})

// ── Criterion 8: Successful deletion closes the modal and refreshes the board ─

test('AC8 – deleteCard() closes the modal and calls refresh() after a successful response', async () => {
  const res = await request({ method: 'GET', path: '/' })
  assert.equal(res.status, 200)

  // Find deleteCard and verify closeModal + refresh are called on res.ok
  const fnStart = res.body.indexOf('async function deleteCard()')
  assert.ok(fnStart !== -1, 'deleteCard function must exist')
  const fnChunk = res.body.slice(fnStart, fnStart + 800)

  assert.match(fnChunk, /closeModal\(/, 'closeModal() must be called inside deleteCard')
  assert.match(fnChunk, /refresh\(\)/, 'refresh() must be called inside deleteCard')

  // Both must appear after the fetch (i.e. they are inside the success block)
  const fetchPos     = fnChunk.indexOf("fetch('/api/card/")
  const closePos     = fnChunk.indexOf('closeModal(')
  const refreshPos   = fnChunk.indexOf('refresh()')
  assert.ok(closePos > fetchPos,   'closeModal() must come after fetch()')
  assert.ok(refreshPos > fetchPos, 'refresh() must come after fetch()')
})

// ── Criterion 9: Delete button is hidden for .wip cards ──────────────────────

test('AC9 – Delete button is hidden when the card filename ends in .wip', async () => {
  const res = await request({ method: 'GET', path: '/' })
  assert.equal(res.status, 200)

  // The openCard function must check for .wip and hide the delete button
  const openCardStart = res.body.indexOf('async function openCard(')
  assert.ok(openCardStart !== -1, 'openCard function must exist')
  const openCardChunk = res.body.slice(openCardStart, openCardStart + 1200)

  assert.match(openCardChunk, /\.wip/, 'openCard must reference .wip')
  assert.match(openCardChunk, /modal-delete-btn/, 'openCard must reference the delete button')
  assert.match(openCardChunk, /hidden/, 'openCard must add/remove "hidden" class on the delete button')

  // The hidden class must be ADDED (not removed) when .wip is detected
  const wipIdx = openCardChunk.indexOf('.wip')
  // Look for classList.add('hidden') after the .wip check
  const afterWip = openCardChunk.slice(wipIdx, wipIdx + 200)
  assert.match(afterWip, /classList\.add\(.*hidden.*\)/, '.wip branch must add the hidden class')
})

// ── Criterion 10: DELETE returns 409 for .wip files ─────────────────────────

test('AC10 – DELETE returns HTTP 409 when the filename ends in .wip', async () => {
  const filename = 'ac10-test.md.wip'
  createCardFile('todo', filename)

  const res = await request({ method: 'DELETE', path: '/api/card/todo/' + filename })

  assert.equal(res.status, 409)
  // File must still exist (server-side guard refused to delete it)
  assert.ok(fs.existsSync(path.join(boardDir, 'todo', filename)), 'file must remain on disk')
})
