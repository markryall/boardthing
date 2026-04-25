#!/usr/bin/env node

const http = require('http')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { spawn } = require('child_process')

const BOARD_DIR = path.resolve(process.argv[2] || './.board')
const PORT = process.argv[3] || 3000

function repoTitle() {
  const dirName = path.basename(path.dirname(BOARD_DIR))
  return dirName
    .replace(/[-_]/g, ' ')
    .replace(/\b\w+/g, w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
}

const DEFAULT_COLORS = ['#3b82f6','#60a5fa','#818cf8','#7c3aed','#9333ea','#a855f7','#c026d3','#d946ef','#ec4899','#f472b6']

// ── Config ───────────────────────────────────────────────────────────────────

function loadConfig() {
  const configPath = path.join(BOARD_DIR, 'config.json')
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    if (Array.isArray(raw)) return { columns: raw, transitions: [] }
    return { transitions: [], ...raw }
  } catch (e) {
    console.error('Error: could not read ' + configPath + ': ' + e.message)
    process.exit(1)
  }
}

function validateConfig() {
  const configPath = path.join(BOARD_DIR, 'config.json')
  const config = loadConfig()
  const errors = []

  if (!config.repo) errors.push('"repo" is required')

  if (!config.columns || config.columns.length === 0) {
    errors.push('"columns" must be a non-empty array')
  }

  const columnIds = new Set((config.columns || []).map(c => typeof c === 'string' ? c : c.id))

  for (const [i, t] of (config.transitions || []).entries()) {
    const prefix = 'transition ' + i
    if (!t.from)  errors.push(prefix + ' missing "from"')
    if (!t.to)    errors.push(prefix + ' missing "to"')
    if (!t.agent) errors.push(prefix + ' missing "agent"')
    if (t.from && !columnIds.has(t.from)) errors.push(prefix + ' "from" references unknown column "' + t.from + '"')
    if (t.to   && !columnIds.has(t.to))   errors.push(prefix + ' "to" references unknown column "' + t.to + '"')
  }

  if (errors.length > 0) {
    console.error('Invalid ' + configPath + ':')
    for (const e of errors) console.error('  - ' + e)
    process.exit(1)
  }
}

function colLabel(id) {
  return id.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}

function findAgentPath(name) {
  const candidates = [
    path.join(BOARD_DIR, 'commands', name + '.md'),
    path.join(os.homedir(), '.claude', 'commands', name + '.md'),
  ]
  return candidates.find(p => { try { fs.accessSync(p); return true } catch { return false } }) || null
}

function getColumns() {
  const { columns } = loadConfig()
  return columns.map((col, i) => {
    const id    = typeof col === 'string' ? col : col.id
    const color = (typeof col === 'object' && col.color) || DEFAULT_COLORS[i % DEFAULT_COLORS.length]
    return { id, label: colLabel(id), color }
  })
}

function getTransitions() {
  const { transitions } = loadConfig()
  return (transitions || []).map(t => ({
    ...t,
    agentPath: findAgentPath(t.agent),
    label: colLabel(t.to),
  }))
}

// Returns the transition whose `from` matches colId, if any
function transitionFrom(colId) {
  return getTransitions().find(t => t.from === colId) || null
}

// ── Board ────────────────────────────────────────────────────────────────────

function readBoard() {
  const board = {}
  for (const col of getColumns()) {
    const colPath = path.join(BOARD_DIR, col.id)
    try {
      board[col.id] = fs.readdirSync(colPath)
        .filter(f => f.endsWith('.md') || f.endsWith('.md.wip'))
        .map(f => ({ name: f, wip: f.endsWith('.md.wip'), mtime: fs.statSync(path.join(colPath, f)).mtimeMs }))
        .sort((a, b) => a.mtime - b.mtime)
    } catch {
      board[col.id] = []
    }
  }
  return board
}

function renderBoardHTML() {
  const board = readBoard()
  const cols = getColumns()
  return cols.map(col => {
    const cards = board[col.id] || []
    const cardItems = cards.map(c => {
      const encodedName = encodeURIComponent(c.name)
      const title = c.name.replace(/\.md(\.wip)?$/, '').replace(/[-_]/g, ' ')
      const dragAttrs = c.wip ? '' : ` draggable="true" ondragstart="dragCard(event,'${col.id}','${encodedName}')"`
      const cls = c.wip
        ? 'bg-gray-700/50 border border-dashed border-gray-500 text-gray-400'
        : 'bg-gray-700 hover:bg-gray-600 text-gray-200'
      const pulse = c.wip ? '<span class="inline-block w-2 h-2 rounded-full bg-yellow-400 animate-pulse mr-2"></span>' : ''
      return `<div class="card cursor-pointer rounded-lg px-3 py-2 text-sm shadow-sm ${cls}" data-col="${col.id}" data-name="${encodedName}"${dragAttrs}>${pulse}${title}</div>`
    }).join('\n')
    return (
      `<div class="flex-shrink-0 rounded-xl bg-gray-800/60 border-t-2 p-3" style="min-width:200px;max-width:280px;border-top-color:${col.color}">` +
      `<div class="flex items-center justify-between mb-3">` +
      `<span class="text-xs font-semibold text-gray-400 uppercase tracking-wide">${col.label}</span>` +
      `<span class="text-xs bg-gray-700 text-gray-400 rounded-full px-2 py-0.5">${cards.length}</span>` +
      `</div>` +
      `<div class="space-y-2" ondragover="event.preventDefault()" ondrop="dropCard(event,'${col.id}')">${cardItems}</div>` +
      `</div>`
    )
  }).join('\n')
}

function readCard(col, filename) {
  const resolved = path.resolve(path.join(BOARD_DIR, col, filename))
  if (!resolved.startsWith(BOARD_DIR + path.sep)) return null
  try {
    const content = fs.readFileSync(resolved, 'utf8')
    boardLog('read ' + boardRelative(resolved))
    return content
  } catch { return null }
}

function writeCard(col, filename, content) {
  const resolved = path.resolve(path.join(BOARD_DIR, col, filename))
  if (!resolved.startsWith(BOARD_DIR + path.sep)) return false
  try {
    fs.writeFileSync(resolved, content)
    boardLog('write ' + boardRelative(resolved))
    return true
  } catch { return false }
}

function createCard(colId, name, brief) {
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  const filename = slug + '.md'
  const colPath = path.join(BOARD_DIR, colId)
  const resolved = path.resolve(path.join(colPath, filename))
  if (!resolved.startsWith(BOARD_DIR + path.sep)) return null
  fs.mkdirSync(colPath, { recursive: true })
  fs.writeFileSync(resolved, '# Brief\n\n' + brief.trim() + '\n')
  boardLog('write ' + boardRelative(resolved))
  return filename
}

// ── Logging ──────────────────────────────────────────────────────────────────

function timeOnlyLocal() {
  const d = new Date()
  const pad = n => String(n).padStart(2, '0')
  return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds())
}

function boardLog(message) {
  process.stdout.write(timeOnlyLocal() + ' ' + message + '\n')
}

function boardRelative(absPath) {
  return path.relative(BOARD_DIR, absPath)
}

// TODO: Spec criterion 6 (log "rename" when an agent renames a card file, e.g. .md → .md.wip
// and back) cannot be fulfilled here because agent subprocesses rename card files directly via
// their own file-system access; board-viewer.js has no rename API endpoint. A future card should
// either add a rename API or use filesystem event detection to observe these renames.

// ── Watchers ─────────────────────────────────────────────────────────────────

const watchers = {}
// watchers[colId] = {
//   fsWatcher:   FSWatcher | null   — null when poolSize == 0
//   debounce:    Timeout | null
//   poolSize:    number             — configured target concurrent agents
//   activeCount: number             — agents currently running
//   processes:   ChildProcess[]     — running agent processes
//   transition:  object
//   spawnOne:    function           — bound spawner for this column
// }

// Build the spawnOne closure for a column. Called once per column entry.
function makeSpawnOne(fromColId, transition) {
  const fromPath = path.join(BOARD_DIR, fromColId)
  const toPath   = path.join(BOARD_DIR, transition.to)

  function spawnOne() {
    const w = watchers[fromColId]
    if (!w || w.poolSize <= 0 || w.activeCount >= w.poolSize) return
    let cards
    try { cards = fs.readdirSync(fromPath).filter(f => f.endsWith('.md') && !f.endsWith('.wip')) } catch { return }
    if (cards.length === 0) return

    const { repo: rawRepo } = loadConfig()
    const repo = rawRepo.replace(/^~/, process.env.HOME)
    const cardSlug = cards[0].replace(/\.md$/, '')
    const workspacePath = repo + '-' + cardSlug
    const cardContent = fs.readFileSync(path.join(fromPath, cards[0]), 'utf8')
    const hasWorkspace = /^## Workspace/m.test(cardContent)
    const workspaceInstructions = hasWorkspace
      ? 'Do all code changes inside the workspace recorded in the "## Workspace" section of the card. '
      : 'Create a jj workspace at ' + workspacePath + ' before doing any work ' +
        '(run: jj workspace add ' + workspacePath + ' --repo ' + repo + '). ' +
        'Do all code changes inside that workspace. ' +
        'Record the workspace path in the card under a "## Workspace" heading when done. '

    const prompt =
      'Pick up the oldest card from ' + fromPath + '/. ' +
      'Rename it to filename.md.wip while you work (as a lock). ' +
      workspaceInstructions +
      'When done, rename it back to filename.md and move it to ' + toPath + '/. ' +
      'If you cannot proceed without a human decision, move it to ' + path.join(BOARD_DIR, 'blocked') + '/ instead ' +
      'and document the question clearly in the card.'

    const agentType = transition.agent || transition.to
    boardLog(agentType + ' ' + cardSlug + ' started')

    const proc = spawn('claude', [
      '-p', prompt,
      '--system-prompt', fs.readFileSync(transition.agentPath, 'utf8'),
      '--dangerously-skip-permissions'
    ], { stdio: 'inherit' })

    w.activeCount++
    w.processes.push(proc)

    proc.on('close', (code) => {
      const w2 = watchers[fromColId]
      if (w2) {
        w2.activeCount = Math.max(0, w2.activeCount - 1)
        const idx = w2.processes.indexOf(proc)
        if (idx !== -1) w2.processes.splice(idx, 1)
        // Only spawn a replacement if pool still allows it (spec criteria 9-11)
        if (w2.poolSize > 0 && w2.activeCount < w2.poolSize) setTimeout(spawnOne, 500)
      }
      if (code === 0) {
        boardLog(agentType + ' ' + cardSlug + ' success')
      } else {
        boardLog(agentType + ' ' + cardSlug + ' failed')
      }
    })
  }

  return spawnOne
}

function incrementPool(fromColId) {
  const transition = transitionFrom(fromColId)
  if (!transition || !transition.agentPath) return false

  const fromPath = path.join(BOARD_DIR, fromColId)
  try { fs.mkdirSync(fromPath, { recursive: true }) } catch {}

  if (!watchers[fromColId]) {
    watchers[fromColId] = {
      fsWatcher:   null,
      debounce:    null,
      poolSize:    0,
      activeCount: 0,
      processes:   [],
      transition,
      spawnOne:    makeSpawnOne(fromColId, transition)
    }
  }

  const w = watchers[fromColId]
  w.poolSize++

  // Start filesystem watcher on first slot (spec criterion 4)
  if (!w.fsWatcher) {
    w.fsWatcher = fs.watch(fromPath, (_, filename) => {
      if (!filename || !filename.endsWith('.md') || filename.endsWith('.wip')) return
      const w2 = watchers[fromColId]
      if (!w2) return
      clearTimeout(w2.debounce)
      w2.debounce = setTimeout(w2.spawnOne, 500)
    })
  }

  // Try to fill the new slot immediately (spec criterion 4)
  setTimeout(w.spawnOne, 500)
  return true
}

function decrementPool(fromColId) {
  const w = watchers[fromColId]
  if (!w || w.poolSize <= 0) return false  // spec criterion 6: no-op at 0

  w.poolSize--

  // Stop filesystem watching when pool reaches 0 (spec criterion 11)
  // Active agents are NOT killed — they finish their current card naturally
  if (w.poolSize === 0) {
    clearTimeout(w.debounce)
    w.debounce = null
    if (w.fsWatcher) { w.fsWatcher.close(); w.fsWatcher = null }
  }

  return true
}

function watcherStatus() {
  // Return all columns with transitions, even those at poolSize 0 (spec criterion 13)
  const s = {}
  for (const t of getTransitions()) {
    const w = watchers[t.from]
    s[t.from] = { poolSize: w ? w.poolSize : 0, activeCount: w ? w.activeCount : 0, to: t.to }
  }
  return s
}

// ── Bootstrap ────────────────────────────────────────────────────────────────

const DEFAULT_COMMANDS = {
  spec: `You are a spec writer and test designer. Your job is to take a raw card brief,
produce a precise specification, and write executable failing tests that define done.
The orchestrator will tell you which card to pick up and where to move it when done.

Step 1 — Write the spec. Elaborate the card in-place with this structure:

## Goal
One sentence describing the outcome.

## Acceptance criteria
A numbered list. Each item must be independently testable. No vague language.
Every criterion must be falsifiable.

## Out of scope
Explicitly list what this change does NOT do.

## Open questions
Anything ambiguous that needs a human decision. If none, write "None".

If there are blocking open questions, move the card to the blocked folder instead
and document the blockers clearly. Do not proceed to step 2.

Step 2 — Write failing tests. One test per acceptance criterion, named after it.
Tests must fail because the implementation does not exist yet — not due to syntax errors.
Prefer integration tests that test behaviour, not implementation details.
Record the test file path(s) in the card under a "## Tests" heading.

Do not write any implementation code.
`,

  implement: `You are an implementer. Your only job is to write code that makes the failing tests pass.
The orchestrator will tell you which card to pick up and where to move it when done.

Read the card fully before writing any code. Do all your work inside the workspace recorded
in the card under "## Workspace" — jj tracks changes automatically, no staging needed.
The test files are listed under "## Tests" in the card.

Rules:
- Run the tests first to confirm they fail, then implement until they pass.
- Implement only what is needed to make the tests pass. Nothing more.
- Do not modify the tests.
- Do not refactor surrounding code unless it directly blocks the spec.
- All tests must be green before you move the card on.
`,

  review: `You are a code reviewer. Your only job is to critique the current diff and merge it if approved.
The orchestrator will tell you which card to pick up and where to move it when done.

Read the card before doing anything else. Run \`jj diff\` inside the workspace recorded
in the card under "## Workspace" to see the changes under review.

Append your findings to the card under a "## Review" heading:

1. Correctness — does the code do what the spec says?
2. Missing criteria — any acceptance criteria not covered?
3. Security — injection risks, auth bypasses, data exposure?
4. Edge cases — inputs or states that could cause unexpected behaviour?
5. Verdict — APPROVED, APPROVED WITH NOTES, or CHANGES REQUIRED.

If the verdict is APPROVED or APPROVED WITH NOTES:
- In the main repo, rebase the workspace changes onto the default branch and forget the workspace:
    jj rebase -d trunk() --branch <workspace_change_id>
    jj workspace forget <workspace_path>
- The workspace path is in the card under "## Workspace".

Do not fix anything. Do not write code. Critique only — merging on approval is the sole exception.
`,
}

const DEFAULT_CONFIG = {
  columns: ['backlog', 'specification', 'implementation', 'done', 'blocked'],
  transitions: [
    { from: 'backlog',        to: 'specification',  agent: 'spec'      },
    { from: 'specification',  to: 'implementation', agent: 'implement' },
    { from: 'implementation', to: 'done',           agent: 'review'    },
  ]
}

function bootstrap() {
  fs.mkdirSync(BOARD_DIR, { recursive: true })

  const configPath = path.join(BOARD_DIR, 'config.json')
  if (!fs.existsSync(configPath))
    fs.writeFileSync(configPath, JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n')

  const commandsDir = path.join(BOARD_DIR, 'commands')
  fs.mkdirSync(commandsDir, { recursive: true })

  for (const [name, content] of Object.entries(DEFAULT_COMMANDS)) {
    const filePath = path.join(commandsDir, name + '.md')
    if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, content)
  }

  for (const col of getColumns())
    fs.mkdirSync(path.join(BOARD_DIR, col.id), { recursive: true })
}

// ── HTTP helpers ─────────────────────────────────────────────────────────────

function readBody(req) {
  return new Promise(resolve => {
    let body = ''
    req.on('data', chunk => body += chunk)
    req.on('end', () => { try { resolve(JSON.parse(body)) } catch { resolve({}) } })
  })
}

// ── HTML ─────────────────────────────────────────────────────────────────────

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Board</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    body { background: #0f1117; }
    .card { transition: transform 0.1s, background 0.1s; }
    .card:hover { transform: translateY(-2px); }
    @keyframes card-arrive {
      from { opacity: 0; transform: translateY(-8px); }
      to   { opacity: 1; transform: translateY(0); }
    }
    .card-just-arrived { animation: card-arrive 0.4s ease-out; }
  </style>
</head>
<body class="text-gray-100 min-h-screen p-6">

  <div class="flex items-center justify-between mb-6">
    <h1 class="text-xl font-bold tracking-tight">Board</h1>
    <span id="updated" class="text-xs text-gray-600"></span>
  </div>

  <div class="w-full overflow-x-auto pb-2">
    <div id="board" class="flex gap-4 pb-4 items-start" style="min-width: max-content"></div>
  </div>

  <!-- Card modal -->
  <div id="modal" class="fixed inset-0 z-50 hidden bg-black/70 backdrop-blur-sm flex items-center justify-center p-6"
       onclick="if(event.target===this)closeModal('modal')">
    <div class="bg-gray-900 border border-gray-700 rounded-2xl shadow-2xl w-full max-w-3xl max-h-[88vh] flex flex-col">
      <div class="flex items-start justify-between gap-4 px-6 py-4 border-b border-gray-800">
        <div>
          <p id="modal-col" class="text-xs font-medium mb-1"></p>
          <h2 id="modal-title" class="text-base font-semibold text-white"></h2>
        </div>
        <div class="flex items-center gap-3 mt-1">
          <button id="modal-edit-btn" onclick="enterEditMode()"
                  class="text-xs text-gray-500 hover:text-gray-300">Edit</button>
          <button id="modal-delete-btn" onclick="deleteCard()"
                  class="text-xs text-red-500 hover:text-red-400">Delete</button>
          <button id="modal-save-btn" onclick="saveCard()"
                  class="hidden text-xs text-blue-400 hover:text-blue-300">Save</button>
          <button id="modal-cancel-btn" onclick="exitEditMode()"
                  class="hidden text-xs text-gray-500 hover:text-gray-300">Cancel</button>
          <select id="modal-move" onchange="moveCard(this.value)"
                  class="text-xs text-gray-500 bg-gray-800 border border-gray-700 rounded px-2 py-1 focus:outline-none hover:border-gray-500"></select>
          <button onclick="closeModal('modal')" class="text-gray-500 hover:text-white text-2xl leading-none">&times;</button>
        </div>
      </div>
      <div id="modal-body" class="overflow-y-auto p-6 text-sm text-gray-300"></div>
      <textarea id="modal-editor"
                class="hidden flex-1 m-4 p-4 bg-gray-800 border border-gray-700 rounded-lg text-sm text-gray-200 font-mono resize-none focus:outline-none focus:border-blue-500 min-h-[300px]"></textarea>
    </div>
  </div>

  <!-- Command modal -->
  <div id="cmd-modal" class="fixed inset-0 z-50 hidden bg-black/70 backdrop-blur-sm flex items-center justify-center p-6"
       onclick="if(event.target===this)closeModal('cmd-modal')">
    <div class="bg-gray-900 border border-gray-700 rounded-2xl shadow-2xl w-full max-w-2xl max-h-[88vh] flex flex-col">
      <div class="flex items-center justify-between px-6 py-4 border-b border-gray-800">
        <h2 id="cmd-title" class="text-base font-semibold text-white"></h2>
        <button onclick="closeModal('cmd-modal')" class="text-gray-500 hover:text-white text-2xl leading-none">&times;</button>
      </div>
      <pre id="cmd-body" class="overflow-y-auto p-6 text-xs text-gray-300 whitespace-pre-wrap"></pre>
    </div>
  </div>

  <!-- Add card modal -->
  <div id="add-modal" class="fixed inset-0 z-50 hidden bg-black/70 backdrop-blur-sm flex items-center justify-center p-6"
       onclick="if(event.target===this)closeModal('add-modal')">
    <div class="bg-gray-900 border border-gray-700 rounded-2xl shadow-2xl w-full max-w-lg">
      <div class="flex items-center justify-between px-6 py-4 border-b border-gray-800">
        <h2 id="add-title" class="text-base font-semibold text-white"></h2>
        <button onclick="closeModal('add-modal')" class="text-gray-500 hover:text-white text-2xl leading-none">&times;</button>
      </div>
      <form id="add-form" class="p-6 space-y-4">
        <input type="hidden" id="add-col">
        <div>
          <label class="block text-xs text-gray-400 mb-1">Name</label>
          <input id="add-name" type="text" required autocomplete="off"
                 class="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500">
        </div>
        <div>
          <label class="block text-xs text-gray-400 mb-1">Brief</label>
          <textarea id="add-brief" rows="5" required
                    class="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500 resize-none"></textarea>
        </div>
        <div class="flex justify-end gap-3">
          <button type="button" onclick="closeModal('add-modal')"
                  class="px-4 py-2 text-sm text-gray-400 hover:text-white">Cancel</button>
          <button type="submit"
                  class="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded-lg">Add</button>
        </div>
      </form>
    </div>
  </div>

  <script>
    function dragCard(event, col, encodedName) {
      event.dataTransfer.setData('text/plain', JSON.stringify({ col: col, filename: decodeURIComponent(encodedName) }))
    }

    async function dropCard(event, toCol) {
      event.preventDefault()
      const data = JSON.parse(event.dataTransfer.getData('text/plain'))
      await fetch('/api/card/move', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ col: data.col, filename: data.filename, toCol: toCol })
      })
      refresh()
    }

    function renderContent(el, text) {
      const pre = document.createElement('pre')
      pre.style.whiteSpace = 'pre-wrap'
      pre.textContent = text
      el.replaceChildren(pre)
    }

    let COLUMNS = [], TRANSITIONS = []
    let prevCardCols = null

    function cardTitle(f) { return f.replace(/\\.md(\\.wip)?$/, '').replace(/[-_]/g, ' ') }
    function colInfo(id)  { return COLUMNS.find(c => c.id === id) || { label: id, color: '#888' } }
    function transitionFrom(id) { return TRANSITIONS.find(t => t.from === id) || null }

    async function loadConfig() {
      const cfg = await fetch('/api/config').then(r => r.json())
      COLUMNS     = cfg.columns
      TRANSITIONS = cfg.transitions
    }

    async function refresh() {
      const [board, status] = await Promise.all([
        fetch('/api/board').then(r => r.json()).catch(() => null),
        fetch('/api/watcher/status').then(r => r.json()).catch(() => ({}))
      ])
      if (!board) return
      renderBoard(board, status)
      document.getElementById('updated').textContent = 'refreshed ' + new Date().toLocaleTimeString()
    }

    function renderBoard(board, status) {
      const el = document.getElementById('board')
      el.innerHTML = ''
      for (const col of COLUMNS) {
        const cards = board[col.id] || []
        const ws    = status[col.id]
        const trans = transitionFrom(col.id)
        const wrap  = document.createElement('div')
        wrap.style.cssText = 'min-width:200px;max-width:280px;border-top-color:' + col.color
        wrap.className = 'flex-shrink-0 rounded-xl bg-gray-800/60 border-t-2 p-3'

        const poolSize = (trans && ws) ? (ws.poolSize || 0) : 0
        const watchBtn = trans
          ? '<button class="pool-dec text-xs ' + (poolSize === 0 ? 'text-gray-600 opacity-50' : 'text-gray-500 hover:text-gray-300') + '" data-col="' + col.id + '" title="Decrease pool size"' + (poolSize === 0 ? ' disabled' : '') + '>▼</button>' +
            '<span class="text-xs text-gray-400 tabular-nums px-1">' + poolSize + '</span>' +
            '<button class="pool-inc text-xs text-gray-500 hover:text-gray-300" data-col="' + col.id + '" title="Increase pool size">▲</button>'
          : ''

        const cmdBtn = trans && trans.agentPath
          ? '<button class="view-cmd text-xs text-gray-600 hover:text-gray-300" data-col="' + col.id + '" title="View command">⚙</button>'
          : ''

        wrap.innerHTML =
          '<div class="flex items-center justify-between mb-3">' +
            '<div class="flex items-center gap-1">' + cmdBtn +
              '<span class="text-xs font-semibold text-gray-400 uppercase tracking-wide">' + col.label + '</span>' +
            '</div>' +
            '<div class="flex items-center gap-2">' +
              '<span class="text-xs bg-gray-700 text-gray-400 rounded-full px-2 py-0.5">' + cards.length + '</span>' +
              watchBtn +
              '<button class="add-card text-gray-500 hover:text-gray-300 text-sm leading-none" data-col="' + col.id + '" title="Add card">+</button>' +
            '</div>' +
          '</div>' +
          '<div class="space-y-2">' +
            cards.map(c =>
              '<div class="card cursor-pointer rounded-lg px-3 py-2 text-sm shadow-sm ' +
                (c.wip ? 'bg-gray-700/50 border border-dashed border-gray-500 text-gray-400' : 'bg-gray-700 hover:bg-gray-600 text-gray-200') + '"' +
                ' data-col="' + col.id + '" data-name="' + encodeURIComponent(c.name) + '">' +
                (c.wip ? '<span class="inline-block w-2 h-2 rounded-full bg-yellow-400 animate-pulse mr-2"></span>' : '') +
                cardTitle(c.name) +
              '</div>'
            ).join('') +
          '</div>'

        el.appendChild(wrap)
        if (prevCardCols) for (const c of cards) {
          if (prevCardCols[c.name] !== undefined && prevCardCols[c.name] !== col.id) {
            const ce = wrap.querySelector('[data-name="' + encodeURIComponent(c.name) + '"]')
            if (ce) {
              ce.classList.add('card-just-arrived')
              ce.addEventListener('animationend', () => ce.classList.remove('card-just-arrived'), { once: true })
            }
          }
        }
      }

      // Update previous card column tracking
      prevCardCols = {}
      for (const col of COLUMNS) {
        const cards = board[col.id] || []
        for (const c of cards) prevCardCols[c.name] = col.id
      }
    }

    document.getElementById('board').addEventListener('click', e => {
      const card    = e.target.closest('[data-col][data-name]')
      const add     = e.target.closest('.add-card')
      const poolDec = e.target.closest('.pool-dec')
      const poolInc = e.target.closest('.pool-inc')
      const cmd     = e.target.closest('.view-cmd')
      if (card)    openCard(card.dataset.col, card.dataset.name)
      if (add)     openAddModal(add.dataset.col)
      if (poolDec) adjustPool(poolDec.dataset.col, -1)
      if (poolInc) adjustPool(poolInc.dataset.col, 1)
      if (cmd)     openCommand(cmd.dataset.col)
    })

    let currentCard = null

    async function openCard(colId, encoded) {
      const name = decodeURIComponent(encoded)
      const col  = colInfo(colId)
      document.getElementById('modal-col').textContent   = col.label
      document.getElementById('modal-col').style.color   = col.color
      document.getElementById('modal-title').textContent = cardTitle(name)
      document.getElementById('modal-body').innerHTML    = '<p class="text-gray-500 text-sm">Loading...</p>'
      document.getElementById('modal').classList.remove('hidden')
      exitEditMode()
      const deleteBtn = document.getElementById('modal-delete-btn')
      if (name.endsWith('.wip')) {
        deleteBtn.classList.add('hidden')
      } else {
        deleteBtn.classList.remove('hidden')
      }
      const content = await fetch('/api/card/' + encodeURIComponent(colId) + '/' + encodeURIComponent(name)).then(r => r.text())
      currentCard = { colId, name, content }
      renderContent(document.getElementById('modal-body'), content)
      const sel = document.getElementById('modal-move')
      sel.innerHTML = '<option value="">Move to\u2026</option>' +
        COLUMNS.filter(c => c.id !== colId).map(c => '<option value="' + c.id + '">' + c.label + '</option>').join('')
    }

    function enterEditMode() {
      if (!currentCard) return
      document.getElementById('modal-body').classList.add('hidden')
      document.getElementById('modal-editor').value = currentCard.content
      document.getElementById('modal-editor').classList.remove('hidden')
      document.getElementById('modal-edit-btn').classList.add('hidden')
      document.getElementById('modal-save-btn').classList.remove('hidden')
      document.getElementById('modal-cancel-btn').classList.remove('hidden')
      document.getElementById('modal-editor').focus()
    }

    function exitEditMode() {
      document.getElementById('modal-body').classList.remove('hidden')
      document.getElementById('modal-editor').classList.add('hidden')
      document.getElementById('modal-edit-btn').classList.remove('hidden')
      document.getElementById('modal-save-btn').classList.add('hidden')
      document.getElementById('modal-cancel-btn').classList.add('hidden')
    }

    async function saveCard() {
      if (!currentCard) return
      const content = document.getElementById('modal-editor').value
      await fetch('/api/card/' + encodeURIComponent(currentCard.colId) + '/' + encodeURIComponent(currentCard.name), {
        method: 'PUT',
        headers: { 'Content-Type': 'text/plain' },
        body: content
      })
      currentCard.content = content
      renderContent(document.getElementById('modal-body'), content)
      exitEditMode()
    }

    async function deleteCard() {
      if (!currentCard) return
      if (!confirm('Delete "' + cardTitle(currentCard.name) + '"? This cannot be undone.')) return
      const res = await fetch('/api/card/' + encodeURIComponent(currentCard.colId) + '/' + encodeURIComponent(currentCard.name), {
        method: 'DELETE'
      })
      if (res.ok) {
        closeModal('modal')
        refresh()
      }
    }

    async function openCommand(colId) {
      document.getElementById('cmd-title').textContent = colInfo(colId).label + ' — command'
      document.getElementById('cmd-body').textContent  = 'Loading...'
      document.getElementById('cmd-modal').classList.remove('hidden')
      const content = await fetch('/api/command/' + encodeURIComponent(colId)).then(r => r.text())
      document.getElementById('cmd-body').textContent = content
    }

    function openAddModal(colId) {
      document.getElementById('add-col').value   = colId
      document.getElementById('add-title').textContent = 'Add card — ' + colInfo(colId).label
      document.getElementById('add-name').value  = ''
      document.getElementById('add-brief').value = ''
      document.getElementById('add-modal').classList.remove('hidden')
      setTimeout(() => document.getElementById('add-name').focus(), 50)
    }

    document.getElementById('add-form').addEventListener('submit', async e => {
      e.preventDefault()
      await fetch('/api/card', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          col:   document.getElementById('add-col').value,
          name:  document.getElementById('add-name').value,
          brief: document.getElementById('add-brief').value
        })
      })
      closeModal('add-modal')
      refresh()
    })

    async function moveCard(toCol) {
      if (!toCol || !currentCard) return
      await fetch('/api/card/move', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ col: currentCard.colId, filename: currentCard.name, toCol })
      })
      closeModal('modal')
      refresh()
    }

    async function adjustPool(colId, delta) {
      await fetch('/api/watcher/' + encodeURIComponent(colId) + '/pool', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ delta })
      })
      refresh()
    }

    function closeModal(id) { document.getElementById(id).classList.add('hidden') }
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') ['modal','cmd-modal','add-modal'].forEach(closeModal)
    })

    async function init() { await loadConfig(); refresh(); setInterval(refresh, 3000) }
    init()
  </script>
</body>
</html>`

// ── Server ────────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x')

  if (url.pathname === '/') {
    const boardContent = renderBoardHTML()
    const title = repoTitle()
    const html = HTML
      .replace('<title>Board</title>', '<title>' + title + '</title>')
      .replace('>Board</h1>', '>' + title + '</h1>')
      .replace(
        'id="board" class="flex gap-4 pb-4 items-start" style="min-width: max-content">',
        'id="board" class="flex gap-4 pb-4 items-start" style="min-width: max-content">' + boardContent
      )
    res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(html)
  }
  if (url.pathname === '/api/config') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    return res.end(JSON.stringify({ columns: getColumns(), transitions: getTransitions() }))
  }
  if (url.pathname === '/api/board') {
    res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(readBoard()))
  }
  if (url.pathname === '/api/watcher/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(watcherStatus()))
  }

  // Removed: POST /api/watcher/{colId}/start and /stop — spec criterion 14
  if (url.pathname.match(/^\/api\/watcher\/[^/]+\/(start|stop)$/) && req.method === 'POST') {
    res.writeHead(404); return res.end('Not found')
  }

  // New pool-size control endpoint — spec criterion 15
  const poolM = url.pathname.match(/^\/api\/watcher\/([^/]+)\/pool$/)
  if (poolM && req.method === 'POST') {
    const colId = decodeURIComponent(poolM[1])
    const { delta } = await readBody(req)
    let ok = false
    if (delta === 1)  ok = incrementPool(colId)
    if (delta === -1) ok = decrementPool(colId)
    res.writeHead(ok ? 200 : 400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok }))
  }

  const cmdM = url.pathname.match(/^\/api\/command\/([^/]+)$/)
  if (cmdM) {
    const fromColId = decodeURIComponent(cmdM[1])
    const transition = transitionFrom(fromColId)
    const agentPath = transition && findAgentPath(transition.agent || transition.to)
    if (!agentPath) { res.writeHead(404); return res.end('No agent for this column') }
    try { res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end(fs.readFileSync(agentPath, 'utf8')) }
    catch { res.writeHead(404); return res.end('Not found') }
  }

  if (url.pathname === '/api/card/move' && req.method === 'POST') {
    const { col, filename, toCol } = await readBody(req)
    if (!col || !filename || !toCol) { res.writeHead(400); return res.end('Missing fields') }
    const cols = getColumns()
    if (!cols.find(c => c.id === col) || !cols.find(c => c.id === toCol)) { res.writeHead(400); return res.end('Invalid column') }
    const fromResolved = path.resolve(path.join(BOARD_DIR, col, filename))
    const toDir = path.resolve(path.join(BOARD_DIR, toCol))
    const toResolved = path.resolve(path.join(toDir, filename))
    if (!fromResolved.startsWith(BOARD_DIR + path.sep) || !toResolved.startsWith(BOARD_DIR + path.sep)) {
      res.writeHead(400); return res.end('Invalid path')
    }
    try {
      fs.mkdirSync(toDir, { recursive: true })
      fs.renameSync(fromResolved, toResolved)
      boardLog('move ' + boardRelative(fromResolved) + ' ' + boardRelative(toResolved))
      res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: true }))
    } catch { res.writeHead(500); return res.end('Failed') }
  }

  if (url.pathname === '/api/card' && req.method === 'POST') {
    const { col, name, brief } = await readBody(req)
    if (!col || !name || !brief) { res.writeHead(400); return res.end('Missing fields') }
    const filename = createCard(col, name, brief)
    if (!filename) { res.writeHead(400); return res.end('Invalid') }
    res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ filename }))
  }

  const cardM = url.pathname.match(/^\/api\/card\/([^/]+)\/([^/]+)$/)
  if (cardM && req.method === 'DELETE') {
    const col = decodeURIComponent(cardM[1])
    const filename = decodeURIComponent(cardM[2])
    if (filename.endsWith('.wip')) { res.writeHead(409); return res.end('Cannot delete a card currently being processed') }
    const resolved = path.resolve(path.join(BOARD_DIR, col, filename))
    if (!resolved.startsWith(BOARD_DIR + path.sep)) { res.writeHead(403); return res.end('Forbidden') }
    if (!fs.existsSync(resolved)) { res.writeHead(400); return res.end('File not found') }
    try { fs.unlinkSync(resolved); res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: true })) }
    catch { res.writeHead(500); return res.end('Failed') }
  }
  if (cardM && req.method === 'PUT') {
    const body = await new Promise(resolve => { let b = ''; req.on('data', c => b += c); req.on('end', () => resolve(b)) })
    const ok = writeCard(decodeURIComponent(cardM[1]), decodeURIComponent(cardM[2]), body)
    res.writeHead(ok ? 200 : 400); return res.end(ok ? 'OK' : 'Failed')
  }
  if (cardM) {
    const content = readCard(decodeURIComponent(cardM[1]), decodeURIComponent(cardM[2]))
    if (!content) { res.writeHead(404); return res.end('Not found') }
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end(content)
  }

  if (url.pathname.startsWith('/files/')) {
    const relative = decodeURIComponent(url.pathname.slice(7))
    const resolved = path.resolve(path.join(BOARD_DIR, relative))
    if (!resolved.startsWith(BOARD_DIR + path.sep)) { res.writeHead(403); return res.end('Forbidden') }
    const mime = { '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg',
                   '.gif':'image/gif', '.webp':'image/webp', '.svg':'image/svg+xml' }[path.extname(resolved).toLowerCase()]
    if (!mime) { res.writeHead(415); return res.end('Unsupported type') }
    try { res.writeHead(200, { 'Content-Type': mime }); return res.end(fs.readFileSync(resolved)) }
    catch { res.writeHead(404); return res.end('Not found') }
  }

  res.writeHead(404); res.end('Not found')
})

validateConfig()

bootstrap()

server.listen(PORT, () => {
  console.log('Board viewer → http://localhost:' + PORT)
  console.log('Watching:     ' + BOARD_DIR)
})
