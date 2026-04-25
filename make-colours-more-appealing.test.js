'use strict'

// Integration tests for: Make Colours More Appealing
// Acceptance criteria from .board/specification/make-colours-more-appealing.md

const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const http   = require('node:http')
const fs     = require('node:fs')
const path   = require('node:path')
const os     = require('node:os')
const { spawn } = require('node:child_process')

// ── Colour helpers ────────────────────────────────────────────────────────────

/**
 * Convert a CSS hex colour (e.g. '#3b82f6') to HSL.
 * Returns { h: 0-360, s: 0-100, l: 0-100 }.
 */
function hexToHsl (hex) {
  const r = parseInt(hex.slice(1, 3), 16) / 255
  const g = parseInt(hex.slice(3, 5), 16) / 255
  const b = parseInt(hex.slice(5, 7), 16) / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  if (max === min) return { h: 0, s: 0, l: l * 100 }
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6
  else if (max === g) h = ((b - r) / d + 2) / 6
  else h = ((r - g) / d + 4) / 6
  return { h: h * 360, s: s * 100, l: l * 100 }
}

/**
 * Returns true when a hex colour is within the pink/blue/purple spectrum:
 *   hue ∈ [185°, 360°]  AND  saturation ≥ 60%
 */
function isInSpectrum (hex) {
  const { h, s } = hexToHsl(hex)
  return h >= 185 && h <= 360 && s >= 60
}

// ── Parse DEFAULT_COLORS from source ─────────────────────────────────────────

function parseDefaultColors () {
  const src = fs.readFileSync(path.join(__dirname, 'board-viewer.js'), 'utf8')
  const m = src.match(/const DEFAULT_COLORS\s*=\s*(\[[^\]]+\])/)
  assert.ok(m, 'DEFAULT_COLORS constant must exist in board-viewer.js')
  // Single-quoted hex strings → valid JSON
  const json = m[1].replace(/'/g, '"')
  return JSON.parse(json)
}

// ── Test infrastructure (for server-based tests) ──────────────────────────────

let serverProcess
let boardDir
const PORT = 13802

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

before(async () => {
  // Use a fresh temp dir with NO config.json so DEFAULT_COLORS are used
  boardDir = fs.mkdtempSync(path.join(os.tmpdir(), 'boardthing-colours-test-'))

  serverProcess = spawn(process.execPath, [
    path.join(__dirname, 'board-viewer.js'),
    boardDir,
    String(PORT)
  ], { stdio: ['ignore', 'ignore', 'ignore'] })

  await waitForServer(PORT)
})

after(() => {
  if (serverProcess) serverProcess.kill()
  try { fs.rmSync(boardDir, { recursive: true, force: true }) } catch {}
})

// ── AC1: every DEFAULT_COLOR has hue ∈ [185°, 360°] ─────────────────────────

test('AC1 – every entry in DEFAULT_COLORS has a hue between 185° and 360° (blue-to-pink spectrum)', () => {
  const colors = parseDefaultColors()
  assert.ok(colors.length > 0, 'DEFAULT_COLORS must not be empty')

  const violations = colors.filter(hex => {
    const { h } = hexToHsl(hex)
    return h < 185 || h > 360
  })

  assert.deepEqual(
    violations,
    [],
    'The following DEFAULT_COLORS have hue outside [185°, 360°] and are not in the pink/blue/purple spectrum: ' +
    violations.map(hex => `${hex} (h=${hexToHsl(hex).h.toFixed(1)}°)`).join(', ')
  )
})

// ── AC2: every DEFAULT_COLOR has HSL saturation ≥ 60% ───────────────────────

test('AC2 – every entry in DEFAULT_COLORS has an HSL saturation of at least 60% (no grey or near-grey tones)', () => {
  const colors = parseDefaultColors()
  assert.ok(colors.length > 0, 'DEFAULT_COLORS must not be empty')

  const violations = colors.filter(hex => hexToHsl(hex).s < 60)

  assert.deepEqual(
    violations,
    [],
    'The following DEFAULT_COLORS are too desaturated (grey-like) — saturation must be ≥ 60%: ' +
    violations.map(hex => `${hex} (s=${hexToHsl(hex).s.toFixed(1)}%)`).join(', ')
  )
})

// ── AC3: DEFAULT_COLORS has at least 8 entries ───────────────────────────────

test('AC3 – DEFAULT_COLORS contains at least 8 colour entries', () => {
  const colors = parseDefaultColors()
  assert.ok(
    colors.length >= 8,
    `DEFAULT_COLORS must contain at least 8 entries for boards with many columns; found ${colors.length}`
  )
})

// ── AC4: /api/config returns only pink/blue/purple column colours ─────────────

test('AC4 – GET /api/config returns column color values that are all within the pink/blue/purple spectrum', async () => {
  const res = await request({ method: 'GET', path: '/api/config' })
  assert.equal(res.status, 200, '/api/config must return 200')

  const config = JSON.parse(res.body)
  assert.ok(Array.isArray(config.columns), 'config.columns must be an array')
  assert.ok(config.columns.length > 0, 'config.columns must not be empty')

  const violations = config.columns.filter(col => !isInSpectrum(col.color))

  assert.deepEqual(
    violations.map(c => ({ id: c.id, color: c.color })),
    [],
    'The following columns have colors outside the pink/blue/purple spectrum (hue [185°,360°], sat ≥ 60%): ' +
    violations.map(c => {
      const { h, s } = hexToHsl(c.color)
      return `${c.id}: ${c.color} (h=${h.toFixed(1)}°, s=${s.toFixed(1)}%)`
    }).join(', ')
  )
})
