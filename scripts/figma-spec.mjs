#!/usr/bin/env node
// Stable Figma spec reader: login (token) -> read detailed design params -> persist to disk.
// Pure REST (Figma API v1). No MCP, no browser, no headless flakiness. Deterministic + cacheable.
//
// Auth (either name works):
//   export FIGMA_TOKEN=<Personal Access Token>      # preferred
//   export FIGMA_API_KEY=<Personal Access Token>    # alias (matches lark-bot MCP env)
//   Create at Figma -> Settings -> Security -> Personal access tokens.
//   Scopes: "File content" (read) required; "Variables" (read) optional for token defs.
//
// Usage:
//   node figma-spec.mjs <urlOrFileKey> [nodeId[,nodeId...]] [--out <dir>] [--depth=N] [--no-image] [--raw]
//
//   node-id may be omitted when the URL carries ?node-id=... .
//
// Examples:
//   node figma-spec.mjs "https://www.figma.com/design/KEY/x?node-id=19782-4898"
//   node figma-spec.mjs KEY 19782-4898 --out ./prds/PR-02172/evidence/figma
//
// Output (to <out>/<fileKey>-<firstNodeId>/):
//   spec.json   normalized geometry tree + variables/styles + raw (with --raw) + meta
//   spec.md     agent/human-readable geometry tree + token list (read this before writing pages)
//   preview-<nodeId>@2x.png   rendered PNG per node (unless --no-image)
// On success prints:  FIGMA_SPEC_WRITTEN: <absolute spec dir>
//   (this sentinel is the machine-checkable proof the design was actually read.)

import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'

const TOKEN = process.env.FIGMA_TOKEN || process.env.FIGMA_API_KEY
if (!TOKEN) {
  console.error('ERROR: set FIGMA_TOKEN (or FIGMA_API_KEY) to a Figma personal access token.')
  process.exit(2)
}

const argv = process.argv.slice(2)
// Flags that consume the following token as their value (must be skipped when
// collecting positionals, else e.g. `--out /tmp/x` leaks `/tmp/x` into node-id).
const VALUE_FLAGS = new Set(['--out'])
const flags = []
const positionals = []
const valueOf = {}
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (VALUE_FLAGS.has(a)) {
    valueOf[a] = argv[i + 1] ?? null
    i++ // consume the value token
  } else if (a.startsWith('--')) {
    flags.push(a)
  } else {
    positionals.push(a)
  }
}
const flagValue = (name) => valueOf[name] ?? null
const hasFlag = (name) => flags.includes(name)
const depthFlag = flags.find((f) => f.startsWith('--depth='))
const MAX_DEPTH = depthFlag ? Number(depthFlag.split('=')[1]) : 8
const WANT_IMAGE = !hasFlag('--no-image')
const WANT_RAW = hasFlag('--raw')

const [urlOrKey, nodeArg] = positionals
if (!urlOrKey) {
  console.error('Usage: node figma-spec.mjs <urlOrFileKey> [nodeId[,nodeId...]] [--out <dir>] [--depth=N] [--no-image] [--raw]')
  process.exit(2)
}

// Accept a raw file key or a full Figma URL (design/file/proto/board).
const parseFileKey = (s) => {
  const m = s.match(/figma\.com\/(?:design|file|proto|board)\/([a-zA-Z0-9]+)/)
  return m ? m[1] : s
}
// node-id lives in the URL query as e.g. ?node-id=19782-4898 ; API wants ':' not '-'.
const parseNodeIdsFromUrl = (s) => {
  const m = s.match(/[?&]node-id=([0-9]+[-:][0-9]+)/i)
  return m ? [m[1]] : []
}
const toApiId = (id) => id.trim().replace(/-/g, ':')

const fileKey = parseFileKey(urlOrKey)
const rawIds = (nodeArg ? nodeArg.split(',') : parseNodeIdsFromUrl(urlOrKey)).map((x) => x.trim()).filter(Boolean)
if (!rawIds.length) {
  console.error('ERROR: no node-id given (pass one, or use a URL that contains ?node-id=...).')
  process.exit(2)
}
const ids = rawIds.map(toApiId)

const api = async (path) => {
  const res = await fetch(`https://api.figma.com/v1${path}`, { headers: { 'X-Figma-Token': TOKEN } })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    const err = new Error(`Figma API ${res.status} ${res.statusText} for ${path}`)
    err.status = res.status
    err.body = body
    throw err
  }
  return res.json()
}

const toHex = (c) => {
  if (!c) return null
  const n = (v) => Math.round(v * 255).toString(16).padStart(2, '0')
  const hex = `#${n(c.r)}${n(c.g)}${n(c.b)}`
  return c.a != null && c.a < 1 ? `${hex}@${c.a.toFixed(2)}` : hex
}
const fillList = (fills) =>
  Array.isArray(fills)
    ? fills
        .filter((f) => f.visible !== false)
        .map((f) => (f.type === 'SOLID' ? toHex(f.color) : f.type?.startsWith('GRADIENT') ? f.type : f.type === 'IMAGE' ? 'IMAGE' : f.type))
        .filter(Boolean)
    : []

const effectList = (effects) =>
  Array.isArray(effects)
    ? effects
        .filter((e) => e.visible !== false && /SHADOW|BLUR/.test(e.type))
        .map((e) => ({
          type: e.type,
          color: e.color ? toHex(e.color) : null,
          offset: e.offset ? { x: e.offset.x, y: e.offset.y } : null,
          radius: e.radius ?? null,
          spread: e.spread ?? null,
        }))
    : []

// Normalize one node into a compact, page-writing-oriented spec object.
const normalize = (node, depth) => {
  const b = node.absoluteBoundingBox
  const out = {
    id: node.id,
    type: node.type,
    name: node.name,
    size: b ? { w: Math.round(b.width), h: Math.round(b.height) } : null,
    cornerRadius: node.rectangleCornerRadii ?? (node.cornerRadius != null ? node.cornerRadius : null),
    stroke: Array.isArray(node.strokes) && node.strokes.length
      ? { colors: fillList(node.strokes), weight: node.strokeWeight ?? null, align: node.strokeAlign ?? null }
      : null,
    fills: fillList(node.fills),
    opacity: node.opacity != null && node.opacity < 1 ? node.opacity : null,
    layout:
      node.layoutMode && node.layoutMode !== 'NONE'
        ? {
            mode: node.layoutMode,
            gap: node.itemSpacing ?? 0,
            padding: { t: node.paddingTop ?? 0, r: node.paddingRight ?? 0, b: node.paddingBottom ?? 0, l: node.paddingLeft ?? 0 },
            align: `${node.primaryAxisAlignItems ?? '-'}/${node.counterAxisAlignItems ?? '-'}`,
          }
        : null,
    effects: effectList(node.effects),
    text: node.characters != null ? node.characters : null,
    font: node.style?.fontSize
      ? {
          size: node.style.fontSize,
          weight: node.style.fontWeight ?? null,
          family: node.style.fontFamily ?? null,
          lineHeight: node.style.lineHeightPx ?? null,
          letterSpacing: node.style.letterSpacing ?? null,
        }
      : null,
  }
  for (const k of Object.keys(out)) {
    if (out[k] == null || (Array.isArray(out[k]) && !out[k].length)) delete out[k]
  }
  out.children = depth >= MAX_DEPTH ? [] : (node.children ?? []).map((c) => normalize(c, depth + 1))
  if (!out.children.length) delete out.children
  return out
}

// Render the normalized tree as an indented, greppable text block for spec.md.
const renderLines = (node, depth, lines) => {
  const parts = [
    `${'  '.repeat(depth)}${node.type}`,
    `"${node.name}"`,
    `#${node.id}`,
    node.size && `size=${node.size.w}x${node.size.h}`,
    node.cornerRadius != null && `r=${Array.isArray(node.cornerRadius) ? `[${node.cornerRadius.join(',')}]` : node.cornerRadius}`,
    node.stroke && `stroke=${node.stroke.colors.join(',')}@${node.stroke.weight}px`,
    node.fills?.length && `fill=${node.fills.join(',')}`,
    node.opacity != null && `opacity=${node.opacity}`,
    node.layout && `${node.layout.mode} gap=${node.layout.gap} p=[${node.layout.padding.t},${node.layout.padding.r},${node.layout.padding.b},${node.layout.padding.l}] align=${node.layout.align}`,
    node.effects?.length && `effects=${node.effects.map((e) => `${e.type}(${e.color} ${e.offset ? `${e.offset.x},${e.offset.y}` : ''} blur=${e.radius}${e.spread ? ` spread=${e.spread}` : ''})`).join('; ')}`,
    node.font && `font=${node.font.size}/${node.font.weight ?? ''} ${node.font.family ?? ''} lh=${node.font.lineHeight ?? '-'}`,
    node.text != null && `text=${JSON.stringify(node.text)}`,
  ].filter(Boolean)
  lines.push(parts.join('  '))
  for (const c of node.children ?? []) renderLines(c, depth + 1, lines)
}

const main = async () => {
  const fetchedAt = new Date().toISOString()
  // 1. Geometry tree for the requested nodes.
  const data = await api(`/files/${fileKey}/nodes?ids=${encodeURIComponent(ids.join(','))}`)

  const normalized = []
  const styleRefs = {}
  const missing = []
  for (const id of ids) {
    const entry = data.nodes[id]
    if (!entry?.document) {
      missing.push(id)
      continue
    }
    normalized.push(normalize(entry.document, 0))
    Object.assign(styleRefs, entry.styles || {})
  }
  if (!normalized.length) {
    console.error(`ERROR: none of the requested nodes were readable (missing/no access): ${missing.join(', ')}`)
    console.error('Check the node-id and that the token can access this file.')
    process.exit(1)
  }

  // 2. Local variables (design tokens) — best effort; needs Enterprise + variables scope.
  let variables = null
  try {
    const v = await api(`/files/${fileKey}/variables/local`)
    const collections = v.meta?.variableCollections || {}
    const vars = v.meta?.variables || {}
    variables = { collections: Object.values(collections).map((c) => ({ id: c.id, name: c.name, modes: c.modes })), count: Object.keys(vars).length, variables: vars }
  } catch (e) {
    variables = { error: `${e.status || ''} ${e.message}`.trim(), note: 'variables/local unavailable (needs Enterprise plan + variables:read scope); tokens omitted' }
  }

  // 3. Rendered PNGs — download bytes to disk (not just URLs, so the artifact is self-contained).
  const images = {}
  if (WANT_IMAGE) {
    try {
      const img = await api(`/images/${fileKey}?ids=${encodeURIComponent(ids.join(','))}&scale=2&format=png`)
      for (const [id, url] of Object.entries(img.images || {})) images[id] = url
    } catch (e) {
      images.__error = `${e.status || ''} ${e.message}`.trim()
    }
  }

  // 4. Persist.
  const firstNodeSlug = ids[0].replace(/:/g, '-')
  const outBase = flagValue('--out') || process.env.FIGMA_SPEC_OUT || './figma-spec'
  const outDir = resolve(outBase, `${fileKey}-${firstNodeSlug}`)
  mkdirSync(outDir, { recursive: true })

  const spec = {
    meta: { fileKey, nodeIds: ids, fetchedAt, source: `https://www.figma.com/design/${fileKey}?node-id=${firstNodeSlug}`, depth: MAX_DEPTH },
    nodes: normalized,
    styles: styleRefs,
    variables,
    ...(missing.length ? { missingNodes: missing } : {}),
    ...(WANT_RAW ? { raw: data } : {}),
  }
  writeFileSync(join(outDir, 'spec.json'), JSON.stringify(spec, null, 2))

  const mdLines = [
    `# Figma spec — ${fileKey}`,
    ``,
    `- fetchedAt: ${fetchedAt}`,
    `- nodes: ${ids.join(', ')}`,
    `- source: ${spec.meta.source}`,
    variables?.error ? `- variables: unavailable (${variables.error})` : `- variables: ${variables?.count ?? 0} across ${variables?.collections?.length ?? 0} collections`,
    ``,
    `## Geometry tree`,
    '```',
  ]
  for (const n of normalized) {
    const lines = []
    renderLines(n, 0, lines)
    mdLines.push(...lines, '')
  }
  mdLines.push('```')
  if (variables && !variables.error && variables.count) {
    mdLines.push('', '## Variables / tokens')
    for (const v of Object.values(variables.variables)) {
      mdLines.push(`- ${v.name} (${v.resolvedType})`)
    }
  }
  if (Object.keys(styleRefs).length) {
    mdLines.push('', '## Style references')
    for (const s of Object.values(styleRefs)) mdLines.push(`- ${s.styleType}: ${s.name}`)
  }
  writeFileSync(join(outDir, 'spec.md'), mdLines.join('\n'))

  const pngFiles = []
  for (const [id, url] of Object.entries(images)) {
    if (id === '__error' || !url) continue
    try {
      const res = await fetch(url)
      if (!res.ok) continue
      const buf = Buffer.from(await res.arrayBuffer())
      const fname = `preview-${id.replace(/:/g, '-')}@2x.png`
      writeFileSync(join(outDir, fname), buf)
      pngFiles.push(fname)
    } catch {
      /* skip a failed image, spec.json/md still written */
    }
  }

  // 5. Report.
  console.log(`nodes read: ${normalized.length}${missing.length ? ` (missing: ${missing.join(', ')})` : ''}`)
  console.log(`variables: ${variables?.error ? 'unavailable' : `${variables.count} token(s)`}`)
  console.log(`images: ${pngFiles.length} png(s)${images.__error ? ` (error: ${images.__error})` : ''}`)
  console.log(`files: spec.json, spec.md${pngFiles.length ? `, ${pngFiles.join(', ')}` : ''}`)
  console.log(`FIGMA_SPEC_WRITTEN: ${outDir}`)
}

main().catch((e) => {
  console.error(e.status ? `Figma API ${e.status}: ${e.message}\n${e.body || ''}` : e.stack || String(e))
  process.exit(1)
})
