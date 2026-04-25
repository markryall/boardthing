'use strict'

// Integration tests for: Change Title And Heading In Page To Repository Name
// Acceptance criteria from .board/specification/change-title-and-heading-in-page-to-repository-name.md

const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const http   = require('node:http')
const fs     = require('node:fs')
const path   = require('node:path')
const os     = require('node:os')
const { spawn } = require('node:child_process')

// ── Test infrastructure ───────────────────────────────────────────────────────

const VIEWER_PATH = path.join(__dirname, 'board-viewer.js')

// Two servers are used — one per directory-name fixture.
// Each test targets the appropriate port.
const PORT_HYPHEN     = 13812   // server whose repo dir is named "my-project"
const PORT_MIXED_CASE = 13813   // server whose repo dir is named "MY-cool_repo"

let serverHyphen
let serverMixed
let tmpBase

// Directory layout created in before():
//
//   tmpBase/
//     my-project/          ← path.dirname(BOARD_DIR) for the hyphen server
//       .board/            ← BOARD_DIR (contains config.json)
//     MY-cool_repo/        ← path.dirname(BOARD_DIR) for the mixed-case server
//       .board/            ← BOARD_DIR (contains config.json)

function makeConfig (boardDir) {
  return JSON.stringify({
    repo: boardDir,
    columns: ['backlog', 'done'],
    transitions: []
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
        if (Date.now() > deadline) return reject(new Error('Server on port ' + port + ' did not start in time'))
        setTimeout(tryConnect, 100)
      })
      req.end()
    }
    tryConnect()
  })
}

function getHTML (port) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: 'localhost', port, path: '/', method: 'GET' }, res => {
      let data = ''
      res.on('data', c => (data += c))
      res.on('end', () => resolve(data))
    })
    req.on('error', reject)
    req.end()
  })
}

function spawnServer (boardDir, port) {
  return spawn(process.execPath, [VIEWER_PATH, boardDir, String(port)], {
    stdio: ['ignore', 'ignore', 'ignore']
  })
}

before(async () => {
  tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'boardthing-title-test-'))

  // Fixture 1: repo named "my-project"
  const hyphenRepoDir = path.join(tmpBase, 'my-project')
  const hyphenBoardDir = path.join(hyphenRepoDir, '.board')
  fs.mkdirSync(hyphenBoardDir, { recursive: true })
  fs.writeFileSync(path.join(hyphenBoardDir, 'config.json'), makeConfig(hyphenBoardDir))

  // Fixture 2: repo named "MY-cool_repo" (mixed case + hyphen + underscore)
  const mixedRepoDir = path.join(tmpBase, 'MY-cool_repo')
  const mixedBoardDir = path.join(mixedRepoDir, '.board')
  fs.mkdirSync(mixedBoardDir, { recursive: true })
  fs.writeFileSync(path.join(mixedBoardDir, 'config.json'), makeConfig(mixedBoardDir))

  serverHyphen = spawnServer(hyphenBoardDir, PORT_HYPHEN)
  serverMixed  = spawnServer(mixedBoardDir, PORT_MIXED_CASE)

  await Promise.all([
    waitForServer(PORT_HYPHEN),
    waitForServer(PORT_MIXED_CASE)
  ])
})

after(() => {
  if (serverHyphen) serverHyphen.kill()
  if (serverMixed)  serverMixed.kill()
  if (tmpBase) fs.rmSync(tmpBase, { recursive: true, force: true })
})

// ── AC1: <title> contains the repo name ──────────────────────────────────────

test('AC1 – HTML <title> contains the parent directory name instead of the hardcoded "Board"', async () => {
  const html = await getHTML(PORT_HYPHEN)
  assert.match(
    html,
    /<title>My Project<\/title>/,
    'Expected <title>My Project</title> in the HTML but it was not found. ' +
    'The title should be derived from the parent directory name of BOARD_DIR ' +
    '("my-project" → "My Project").'
  )
})

// ── AC2: <h1> contains the repo name ─────────────────────────────────────────

test('AC2 – HTML <h1> heading contains the parent directory name instead of the hardcoded "Board"', async () => {
  const html = await getHTML(PORT_HYPHEN)
  assert.match(
    html,
    /<h1[^>]*>My Project<\/h1>/,
    'Expected an <h1> element with text "My Project" in the HTML but it was not found. ' +
    'The heading should be derived from the parent directory name of BOARD_DIR ' +
    '("my-project" → "My Project").'
  )
})

// ── AC3: hyphens replaced with spaces ────────────────────────────────────────

test('AC3 – hyphens in the directory name are replaced with spaces in the title and heading', async () => {
  const html = await getHTML(PORT_MIXED_CASE)
  // "MY-cool_repo" → hyphens replaced → "MY cool_repo" (at minimum)
  // Full expectation includes title-case + underscore handling too.
  assert.match(
    html,
    /<title>My Cool Repo<\/title>/,
    'Expected <title>My Cool Repo</title> — hyphens should be replaced with spaces. ' +
    'Directory name was "MY-cool_repo".'
  )
  assert.match(
    html,
    /<h1[^>]*>My Cool Repo<\/h1>/,
    'Expected <h1> text "My Cool Repo" — hyphens should be replaced with spaces. ' +
    'Directory name was "MY-cool_repo".'
  )
})

// ── AC4: underscores replaced with spaces ────────────────────────────────────

test('AC4 – underscores in the directory name are replaced with spaces in the title and heading', async () => {
  const html = await getHTML(PORT_MIXED_CASE)
  const titleMatch = html.match(/<title>([^<]+)<\/title>/)
  assert.ok(titleMatch, 'Expected a <title> element in the HTML')

  // First ensure the title has moved away from the hardcoded default.
  assert.notEqual(
    titleMatch[1],
    'Board',
    'Expected <title> to reflect the directory name, not stay as the hardcoded "Board".'
  )

  // Then confirm no underscores remain — the underscore between "cool" and "repo" must be gone.
  assert.ok(
    !titleMatch[1].includes('_'),
    `Expected no underscores in the <title> text but found: "${titleMatch[1]}". ` +
    'Underscores in the directory name should be replaced with spaces.'
  )
})

// ── AC5: title case (first letter capitalised, rest lowercased per word) ──────

test('AC5 – the displayed name is in title case (first letter of each word capitalised, rest lowercased)', async () => {
  const html = await getHTML(PORT_MIXED_CASE)
  // "MY-cool_repo" must become "My Cool Repo", not "MY Cool Repo" or "my cool repo"
  assert.match(
    html,
    /<title>My Cool Repo<\/title>/,
    'Expected <title>My Cool Repo</title> (title case with each word first-letter-up, rest-down). ' +
    'Directory name was "MY-cool_repo"; "MY" should become "My", not stay as "MY".'
  )
})
