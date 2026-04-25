#!/usr/bin/env node

const http = require('http')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { spawn } = require('child_process')

const BOARD_DIR = path.resolve(process.argv[2] || './.board')
const PORT = process.argv[3] || 3000

const DEFAULT_COLORS = ['#6b7280','#3b82f6','#eab308','#f97316','#a855f7','#22c55e','#ef4444','#ec4899']

// ── Config ───────────────────────────────────────────────────────────────────

function loadConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(BOARD_DIR, 'config.json'), 'utf8'))
    if (Array.isArray(raw)) return { columns: raw, transitions: [] }
    return { transitions: [], ...raw }
  } catch {
    return {
      columns: ['backlog', 'specification', 'implementation', 'testing', 'review', 'done', 'blocked'],
      transitions: [
        { from: 'backlog',        to: 'specification'  },
        { from: 'specification',  to: 'implementation' },
        { from: 'implementation', to: 'testing'        },
        { from: 'testing',        to: 'review'         },
      ]
    }
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
    agentPath: findAgentPath(t.command || t.to),
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

function readCard(col, filename) {
  const resolved = path.resolve(path.join(BOARD_DIR, col, filename))
  if (!resolved.startsWith(BOARD_DIR + path.sep)) return null
  try { return fs.readFileSync(resolved, 'utf8') } catch { return null }
}

function writeCard(col, filename, content) {
  const resolved = path.resolve(path.join(BOARD_DIR, col, filename))
  if (!resolved.startsWith(BOARD_DIR + path.sep)) return false
  try { fs.writeFileSync(resolved, content); return true } catch { return false }
}

function createCard(colId, name, brief) {
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  const filename = slug + '.md'
  const colPath = path.join(BOARD_DIR, colId)
  const resolved = path.resolve(path.join(colPath, filename))
  if (!resolved.startsWith(BOARD_DIR + path.sep)) return null
  fs.mkdirSync(colPath, { recursive: true })
  fs.writeFileSync(resolved, '# Brief\n\n' + brief.trim() + '\n')
  return filename
}

// ── Watchers ─────────────────────────────────────────────────────────────────

const watchers = {}

function startWatcher(fromColId) {
  if (watchers[fromColId]) return false
  const transition = transitionFrom(fromColId)
  if (!transition || !transition.agentPath) return false

  const fromPath = path.join(BOARD_DIR, fromColId)
  const toPath   = path.join(BOARD_DIR, transition.to)
  try { fs.mkdirSync(fromPath, { recursive: true }) } catch {}

  const { repo } = loadConfig()

  function runAgent() {
    if (watchers[fromColId].busy) return
    let cards
    try { cards = fs.readdirSync(fromPath).filter(f => f.endsWith('.md') && !f.endsWith('.wip')) } catch { return }
    if (cards.length === 0) return

    watchers[fromColId].busy = true

    const cardSlug = cards[0].replace(/\.md$/, '')
    const workspaceInstructions = repo
      ? 'Create a jj workspace at ' + path.resolve(repo, '..', cardSlug) + ' before doing any work ' +
        '(run: jj workspace add ' + path.resolve(repo, '..', cardSlug) + ' --repo ' + repo + '). ' +
        'Do all code changes inside that workspace. ' +
        'Record the workspace path in the card under a "## Workspace" heading when done. '
      : ''

    const prompt =
      'Pick up the oldest card from ' + fromPath + '/. ' +
      'Rename it to filename.md.wip while you work (as a lock). ' +
      workspaceInstructions +
      'When done, rename it back to filename.md and move it to ' + toPath + '/. ' +
      'If you cannot proceed without a human decision, move it to ' + path.join(BOARD_DIR, 'blocked') + '/ instead ' +
      'and document the question clearly in the card.'

    const proc = spawn('claude', [
      '-p', prompt,
      '--system-prompt', fs.readFileSync(transition.agentPath, 'utf8'),
      '--dangerously-skip-permissions'
    ], { stdio: 'inherit' })
    watchers[fromColId].process = proc
    proc.on('close', () => {
      if (watchers[fromColId]) { watchers[fromColId].busy = false; watchers[fromColId].process = null }
    })
  }

  const fsWatcher = fs.watch(fromPath, (_, filename) => {
    if (!filename || !filename.endsWith('.md') || filename.endsWith('.wip')) return
    clearTimeout(watchers[fromColId].debounce)
    watchers[fromColId].debounce = setTimeout(runAgent, 500)
  })

  watchers[fromColId] = { fsWatcher, debounce: null, busy: false, process: null, transition }
  return true
}

function stopWatcher(fromColId) {
  if (!watchers[fromColId]) return false
  clearTimeout(watchers[fromColId].debounce)
  watchers[fromColId].fsWatcher.close()
  if (watchers[fromColId].process) watchers[fromColId].process.kill()
  delete watchers[fromColId]
  return true
}

function watcherStatus() {
  const s = {}
  for (const [id, w] of Object.entries(watchers)) s[id] = { running: true, busy: w.busy, to: w.transition.to }
  return s
}

// ── Bootstrap ────────────────────────────────────────────────────────────────

const DEFAULT_COMMANDS = {
  specification: `You are a spec writer. Your only job is to take a raw card brief and produce
a precise, unambiguous specification. The orchestrator will tell you which card
to pick up and where to move it when done.

Elaborate the card in-place, then move it as instructed. If there are blocking
open questions that prevent a useful spec, move it to the blocked folder instead
and document the blockers clearly.

Structure the spec as:

## Goal
One sentence describing the outcome.

## Acceptance criteria
A numbered list. Each item must be independently testable. No vague language.
Every criterion must be falsifiable.

## Out of scope
Explicitly list what this change does NOT do.

## Open questions
Anything ambiguous that needs a human decision. If none, write "None".

Do not write any code. Do not implement anything.
`,

  implementation: `You are an implementer. Your only job is to write code that satisfies a spec.
The orchestrator will tell you which card to pick up and where to move it when done.

Read the card fully before writing any code.

Rules:
- Implement only what the spec says. Nothing more.
- Do not write tests — that is a separate agent's job.
- Do not refactor surrounding code unless it directly blocks the spec.
- If a criterion is ambiguous, use the most conservative reading and leave a
  TODO comment flagging it.
- When done, stage your changes with git but do not commit.
`,

  testing: `You are a test writer. Your only job is to write tests that verify a spec.
The orchestrator will tell you which card to pick up and where to move it when done.

Read the card and the current git diff before writing any tests.

Rules:
- Write one test per acceptance criterion, named after the criterion.
- Prefer integration tests — test behaviour, not implementation details.
- Do not change production code. If you find a bug, write a failing test that
  exposes it and leave a comment, but do not fix it.
- All tests must pass before you are done. Run them and iterate until green.
`,

  review: `You are a code reviewer. Your only job is to critique the current diff.
The orchestrator will tell you which card to pick up and where to move it when done.

Read the card and run git diff HEAD before doing anything else.

Append your findings to the card under a "## Review" heading:

1. Correctness — does the code do what the spec says?
2. Missing criteria — any acceptance criteria not covered?
3. Security — injection risks, auth bypasses, data exposure?
4. Edge cases — inputs or states that could cause unexpected behaviour?
5. Verdict — APPROVED, APPROVED WITH NOTES, or CHANGES REQUIRED.

Do not fix anything. Do not write code. Critique only.
`,
}

const DEFAULT_CONFIG = {
  columns: ['backlog', 'specification', 'implementation', 'testing', 'review', 'done', 'blocked'],
  transitions: [
    { from: 'backlog',        to: 'specification'  },
    { from: 'specification',  to: 'implementation' },
    { from: 'implementation', to: 'testing'        },
    { from: 'testing',        to: 'review'         },
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
  <script src="https://cdn.tailwindcss.com?plugins=typography"></script>
  <script src="https://cdn.jsdelivr.net/npm/marked@13/marked.min.js"></script>
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github-dark.min.css">
  <script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js"></script>
  <style>
    body { background: #0f1117; }
    .card { transition: transform 0.1s, background 0.1s; }
    .card:hover { transform: translateY(-2px); }
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
          <button id="modal-save-btn" onclick="saveCard()"
                  class="hidden text-xs text-blue-400 hover:text-blue-300">Save</button>
          <button id="modal-cancel-btn" onclick="exitEditMode()"
                  class="hidden text-xs text-gray-500 hover:text-gray-300">Cancel</button>
          <button onclick="closeModal('modal')" class="text-gray-500 hover:text-white text-2xl leading-none">&times;</button>
        </div>
      </div>
      <div id="modal-body" class="overflow-y-auto p-6 prose prose-invert prose-sm max-w-none
                                   prose-headings:text-gray-200 prose-hr:border-gray-700
                                   prose-code:text-pink-400 prose-pre:p-0 prose-pre:bg-transparent"></div>
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
    marked.use({
      renderer: (() => {
        const r = new marked.Renderer()
        r.code = ({ text, lang }) => {
          const language = (lang && hljs.getLanguage(lang)) ? lang : 'plaintext'
          const html = hljs.highlight(text, { language }).value
          return '<pre class="rounded-lg overflow-x-auto"><code class="hljs language-' + language + '">' + html + '</code></pre>'
        }
        return r
      })()
    })

    let COLUMNS = [], TRANSITIONS = []

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
        wrap.style.cssText = 'min-width:200px;max-width:220px;border-top-color:' + col.color
        wrap.className = 'flex-shrink-0 rounded-xl bg-gray-800/60 border-t-2 p-3'

        const watchBtn = trans
          ? (ws
              ? '<button class="stop-watcher text-xs ' + (ws.busy ? 'text-yellow-400' : 'text-red-400 hover:text-red-300') + '" data-col="' + col.id + '" title="Stop (' + col.label + ' → ' + colInfo(trans.to).label + ')">' + (ws.busy ? '<span class="animate-spin inline-block">⟳</span>' : '■') + '</button>'
              : '<button class="start-watcher text-xs text-gray-500 hover:text-green-400" data-col="' + col.id + '" title="Start (' + col.label + ' → ' + colInfo(trans.to).label + ')">▶</button>')
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
      }
    }

    document.getElementById('board').addEventListener('click', e => {
      const card  = e.target.closest('[data-col][data-name]')
      const add   = e.target.closest('.add-card')
      const start = e.target.closest('.start-watcher')
      const stop  = e.target.closest('.stop-watcher')
      const cmd   = e.target.closest('.view-cmd')
      if (card)  openCard(card.dataset.col, card.dataset.name)
      if (add)   openAddModal(add.dataset.col)
      if (start) toggleWatcher(start.dataset.col, 'start')
      if (stop)  toggleWatcher(stop.dataset.col, 'stop')
      if (cmd)   openCommand(cmd.dataset.col)
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
      const content = await fetch('/api/card/' + encodeURIComponent(colId) + '/' + encodeURIComponent(name)).then(r => r.text())
      currentCard = { colId, name, content }
      document.getElementById('modal-body').innerHTML = marked.parse(content)
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
      document.getElementById('modal-body').innerHTML = marked.parse(content)
      exitEditMode()
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

    async function toggleWatcher(colId, action) {
      await fetch('/api/watcher/' + encodeURIComponent(colId) + '/' + action, { method: 'POST' })
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
    res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(HTML)
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

  const watcherM = url.pathname.match(/^\/api\/watcher\/([^/]+)\/(start|stop)$/)
  if (watcherM && req.method === 'POST') {
    const ok = watcherM[2] === 'start' ? startWatcher(decodeURIComponent(watcherM[1])) : stopWatcher(decodeURIComponent(watcherM[1]))
    res.writeHead(ok ? 200 : 400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok }))
  }

  const cmdM = url.pathname.match(/^\/api\/command\/([^/]+)$/)
  if (cmdM) {
    const fromColId = decodeURIComponent(cmdM[1])
    const transition = transitionFrom(fromColId)
    const agentPath = transition && findAgentPath(transition.command || transition.to)
    if (!agentPath) { res.writeHead(404); return res.end('No agent for this column') }
    try { res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end(fs.readFileSync(agentPath, 'utf8')) }
    catch { res.writeHead(404); return res.end('Not found') }
  }

  if (url.pathname === '/api/card' && req.method === 'POST') {
    const { col, name, brief } = await readBody(req)
    if (!col || !name || !brief) { res.writeHead(400); return res.end('Missing fields') }
    const filename = createCard(col, name, brief)
    if (!filename) { res.writeHead(400); return res.end('Invalid') }
    res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ filename }))
  }

  const cardM = url.pathname.match(/^\/api\/card\/([^/]+)\/([^/]+)$/)
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

bootstrap()

server.listen(PORT, () => {
  console.log('Board viewer → http://localhost:' + PORT)
  console.log('Watching:     ' + BOARD_DIR)
})
