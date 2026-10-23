/**
 * The notebook: a derived, append-only index over one Session log.
 *
 * The Session log stays the source of truth. This store only records what the
 * model wrote and read, so it can be rebuilt from the log at any time. Each
 * session keeps one JSONL file of entries and pages; loading replays it.
 */

import { mkdirSync, appendFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

import {
  classify,
  clip,
  estimateTokens,
  formatTime,
  KIND_LABEL,
  normalize,
  queryTerms,
  scoreDocument,
  TIER_LABEL,
  tokenize,
} from './text.js'

const TIERS = new Set(['near', 'mid', 'far'])
const KINDS = new Set(['human', 'self', 'reflection'])

function textOfMessage(message) {
  if (!message || !Array.isArray(message.content)) return ''
  const parts = []
  for (const block of message.content) {
    if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return normalize(parts.join('\n'))
}

function isHumanInput(message) {
  const source = message?.source
  if (!source) return true
  // Context injected by plugins, skills, the runtime, or compaction carries a
  // non-user kind. Only messages the human actually typed are conversation.
  return source.kind === 'user'
}

function pad(value, width) {
  return String(value).padStart(width, '0')
}

export class Notebook {
  constructor(options) {
    this.sessionId = options.sessionId
    this.file = options.file
    this.config = options.config
    this.entries = []
    this.byId = new Map()
    this.pages = []
    this.turn = 0
    this.cursor = 0
    this.reflectionSeq = 0
    this.pending = []
    this.batching = false
    this.loaded = false
    this.surfaceKey = ''
    this.surfaceSet = new Set()
    this.termCache = new WeakMap()
    this.dfCache = null
    this.avgLength = 0
    this.empty = true
  }

  // ---------------------------------------------------------------- storage

  load() {
    if (this.loaded) return this
    this.loaded = true
    if (!existsSync(this.file)) return this
    let raw = ''
    try {
      raw = readFileSync(this.file, 'utf8')
    } catch {
      return this
    }
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      let record
      try {
        record = JSON.parse(line)
      } catch {
        continue
      }
      if (record?.t === 'entry' && record.e?.id) this.acceptEntry(record.e)
      else if (record?.t === 'page' && record.p?.id) this.acceptPage(record.p)
    }
    this.empty = this.entries.length === 0 && this.pages.length === 0
    return this
  }

  acceptEntry(entry) {
    if (this.byId.has(entry.id)) return
    if (entry.seq != null) {
      if (entry.seq <= this.cursor) {
        this.cursor = Math.max(this.cursor, entry.seq)
      } else {
        this.cursor = entry.seq
      }
    }
    const normalized = {
      id: entry.id,
      seq: entry.seq ?? null,
      turn: Number(entry.turn) || 0,
      time: Number(entry.time) || 0,
      kind: KINDS.has(entry.kind) ? entry.kind : 'human',
      tags: Array.isArray(entry.tags) ? entry.tags.filter(tag => typeof tag === 'string') : [],
      text: String(entry.text ?? ''),
      abs: String(entry.abs ?? ''),
      chars: Number(entry.chars) || 0,
      tokens: Number(entry.tokens) || 0,
    }
    this.entries.push(normalized)
    this.byId.set(normalized.id, normalized)
    this.turn = Math.max(this.turn, normalized.turn)
    if (normalized.kind === 'reflection') {
      const match = /^r(\d+)$/.exec(normalized.id)
      if (match) this.reflectionSeq = Math.max(this.reflectionSeq, Number(match[1]))
    }
    return normalized
  }

  acceptPage(page) {
    if (this.pages.some(existing => existing.id === page.id)) return
    this.pages.push({
      id: page.id,
      title: String(page.title ?? ''),
      note: String(page.note ?? ''),
      ids: Array.isArray(page.ids) ? page.ids.filter(id => typeof id === 'string') : [],
      tags: Array.isArray(page.tags) ? page.tags.filter(tag => typeof tag === 'string') : [],
      time: Number(page.time) || 0,
      turn: Number(page.turn) || 0,
    })
  }

  persist(record) {
    this.pending.push(JSON.stringify(record))
    if (!this.batching) this.flush()
  }

  flush() {
    if (this.pending.length === 0) return
    const payload = `${this.pending.join('\n')}\n`
    this.pending = []
    try {
      mkdirSync(this.directory(), { recursive: true })
      appendFileSync(this.file, payload, 'utf8')
    } catch {
      // A read-only home must not break conversation: the in-memory notebook
      // keeps working for this process.
    }
  }

  directory() {
    const index = Math.max(this.file.lastIndexOf('/'), this.file.lastIndexOf('\\'))
    return index > 0 ? this.file.slice(0, index) : '.'
  }

  // ------------------------------------------------------------------ ingest

  /** Replay every committed event the notebook has not seen yet. */
  replay(session) {
    const from = Math.max(0, this.cursor)
    let events = []
    try {
      events = session.snapshotEvents(from)
    } catch {
      return this
    }
    this.batching = true
    for (const event of events) this.ingestEvent(event)
    this.batching = false
    this.flush()
    return this
  }

  ingestEvent(event) {
    if (!event || typeof event.type !== 'string') return null
    if (event.type === 'turn/start') {
      this.turn = Math.max(this.turn, Number(event.data?.turn) || 0)
      return null
    }
    if (event.type === 'turn/end') {
      this.turn = Math.max(this.turn, Number(event.data?.turn) || 0)
      return null
    }
    if (event.type === 'user/message') {
      const message = event.data
      if (!isHumanInput(message)) return null
      return this.addEntry({
        seq: event.seq,
        time: event.time,
        turn: Number(message?.turn) || this.turn,
        kind: 'human',
        text: textOfMessage(message),
      })
    }
    if (event.type === 'assistant/message') {
      const message = event.data?.message
      const text = textOfMessage(message)
      if (!text) return null
      return this.addEntry({
        seq: event.seq,
        time: event.time,
        turn: Number(event.data?.turn) || this.turn,
        kind: 'self',
        text,
      })
    }
    return null
  }

  addEntry(input) {
    const text = normalize(input.text)
    if (!text) return null
    const id = input.seq != null
      ? `n${pad(input.seq, 6)}`
      : `r${pad(++this.reflectionSeq, 4)}`
    if (this.byId.has(id)) return null
    const cap = clip(text, this.config.entryChars)
    const entry = {
      id,
      seq: input.seq ?? null,
      turn: input.turn,
      time: input.time ?? Date.now(),
      kind: input.kind,
      tags: input.tags ?? classify(text, this.config.tagRules),
      text: cap.text,
      abs: clip(text, this.config.abstractChars).text,
      chars: cap.text.length,
      tokens: estimateTokens(cap.text),
    }
    const stored = this.acceptEntry(entry)
    this.termCache = new WeakMap()
    this.dfCache = null
    this.empty = false
    this.persist({ v: 1, t: 'entry', e: stored })
    return stored
  }

  // ------------------------------------------------------------------ tiers

  /** Refresh the archive view: which seqs still sit on the model surface. */
  syncSurface(session) {
    const surface = session?.surface
    if (!surface || !Array.isArray(surface.nodes)) return
    const key = `${surface.replaceGeneration ?? 0}:${surface.nodes.length}:${surface.nodes[surface.nodes.length - 1] ?? 0}`
    if (key === this.surfaceKey) return
    this.surfaceKey = key
    this.surfaceSet = new Set(surface.nodes)
  }

  tierOf(entry) {
    const archived = entry.seq == null ? true : !this.surfaceSet.has(entry.seq)
    if (!archived) return 'near'
    const midFloor = this.turn - this.config.midTurns
    return entry.turn >= midFloor ? 'mid' : 'far'
  }

  // ----------------------------------------------------------------- search

  termsOf(entry) {
    let cached = this.termCache.get(entry)
    if (cached) return cached
    const tokens = tokenize(entry.text)
    const freq = new Map()
    for (const token of tokens) freq.set(token, (freq.get(token) ?? 0) + 1)
    cached = { freq, length: tokens.length }
    this.termCache.set(entry, cached)
    return cached
  }

  corpusStats() {
    if (this.dfCache) return this.dfCache
    const df = new Map()
    let total = 0
    let length = 0
    for (const entry of this.entries) {
      const { freq, length: docLength } = this.termsOf(entry)
      for (const term of freq.keys()) df.set(term, (df.get(term) ?? 0) + 1)
      total += 1
      length += docLength
    }
    this.dfCache = { df, total, avgLength: total > 0 ? length / total : 0 }
    return this.dfCache
  }

  search(query, options = {}) {
    const terms = queryTerms(query ?? '')
    const limit = Math.min(Math.max(1, options.limit ?? this.config.searchLimit), 20)
    const kindFilter = KINDS.has(options.kind) ? options.kind : null
    const tierFilter = TIERS.has(options.tier) ? options.tier : null
    const tagFilter = typeof options.tag === 'string' && options.tag.trim() ? options.tag.trim() : null

    const { df, total, avgLength } = this.corpusStats()
    const scored = []
    for (const entry of this.entries) {
      if (kindFilter && entry.kind !== kindFilter) continue
      if (tagFilter && !entry.tags.includes(tagFilter)) continue
      const tier = this.tierOf(entry)
      if (tierFilter && tier !== tierFilter) continue
      const { freq, length } = this.termsOf(entry)
      const score = terms.length > 0
        ? scoreDocument(terms, freq, df, total, length, avgLength)
        : 0
      if (terms.length > 0 && score <= 0) continue
      scored.push({ entry, score, tier })
    }

    scored.sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score
      return right.entry.time - left.entry.time
    })

    return {
      terms,
      total: scored.length,
      cards: scored.slice(0, limit).map(item => ({ ...item, tier: item.tier })),
    }
  }

  // ------------------------------------------------------------------- read

  resolve(id) {
    const value = String(id ?? '').trim()
    if (!value) return null
    if (this.byId.has(value)) return { type: 'entry', entry: this.byId.get(value) }
    if (this.pages.some(page => page.id === value)) {
      return { type: 'page', page: this.pages.find(page => page.id === value) }
    }
    return null
  }

  read(ids, options = {}) {
    const before = Math.min(Math.max(0, options.before ?? 0), 20)
    const after = Math.min(Math.max(0, options.after ?? 0), 20)
    const maxChars = Math.max(200, options.maxChars ?? this.config.readMaxChars)
    const selected = []
    let missing = []

    for (const id of ids) {
      const resolved = this.resolve(id)
      if (!resolved) {
        missing.push(String(id))
        continue
      }
      if (resolved.type === 'page') {
        for (const entryId of resolved.page.ids) {
          const entry = this.byId.get(entryId)
          if (entry) selected.push({ entry, via: resolved.page.id })
        }
        continue
      }
      const index = this.entries.indexOf(resolved.entry)
      const from = Math.max(0, index - before)
      const to = Math.min(this.entries.length, index + after + 1)
      for (let cursor = from; cursor < to; cursor += 1) selected.push({ entry: this.entries[cursor], via: null })
    }

    // Deduplicate while keeping the first position.
    const seen = new Set()
    const unique = []
    for (const item of selected) {
      if (seen.has(item.entry.id)) continue
      seen.add(item.entry.id)
      unique.push(item)
    }

    let budget = maxChars
    const blocks = []
    let omitted = 0
    for (const item of unique) {
      const entry = item.entry
      const header = `[${entry.id}] ${formatTime(entry.time)} · ${TIER_LABEL[this.tierOf(entry)]} · ${KIND_LABEL[entry.kind] ?? entry.kind}${entry.tags.length ? ` · ${entry.tags.join('/')}` : ''}`
      const body = entry.text
      if (body.length + 1 > budget) {
        const part = clip(body, Math.max(80, budget))
        blocks.push(`${header}\n${part.text}`)
        budget -= part.text.length
        omitted += 1
        if (budget <= 80) break
        continue
      }
      blocks.push(`${header}\n${body}`)
      budget -= body.length + 1
    }

    return {
      blocks,
      missing,
      truncated: omitted > 0,
      remaining: Math.max(0, budget),
    }
  }

  // ------------------------------------------------------------------- mark

  mark(input = {}) {
    const result = { entry: null, page: null }
    const tags = Array.isArray(input.tags) ? input.tags.filter(tag => typeof tag === 'string' && tag.trim()).slice(0, 6) : []

    if (typeof input.text === 'string' && input.text.trim()) {
      result.entry = this.addEntry({
        seq: null,
        time: Date.now(),
        turn: this.turn,
        kind: 'reflection',
        tags: tags.length > 0 ? tags : classify(input.text, this.config.tagRules),
        text: input.text,
      })
    }

    const ids = Array.isArray(input.ids) ? input.ids.filter(id => typeof id === 'string') : []
    if (ids.length > 0 || (typeof input.title === 'string' && input.title.trim())) {
      const nextPage = this.pages.reduce((max, page) => {
        const match = /^p(\d+)$/.exec(page.id)
        return match ? Math.max(max, Number(match[1])) : max
      }, 0) + 1
      const page = {
        id: `p${pad(nextPage, 3)}`,
        title: String(input.title ?? '').trim() || '未命名书签',
        note: String(input.note ?? '').trim(),
        ids: ids.filter(id => this.byId.has(id)),
        tags,
        time: Date.now(),
        turn: this.turn,
      }
      this.acceptPage(page)
      this.empty = false
      this.persist({ v: 1, t: 'page', p: page })
      result.page = page
    }

    return result
  }

  // ------------------------------------------------------------------ state

  stats() {
    const byTier = { near: 0, mid: 0, far: 0 }
    const byKind = { human: 0, self: 0, reflection: 0 }
    const tokensByTier = { near: 0, mid: 0, far: 0 }
    const tags = new Map()
    let chars = 0
    let tokens = 0
    for (const entry of this.entries) {
      const tier = this.tierOf(entry)
      byTier[tier] += 1
      tokensByTier[tier] += entry.tokens
      byKind[entry.kind] = (byKind[entry.kind] ?? 0) + 1
      chars += entry.chars
      tokens += entry.tokens
      for (const tag of entry.tags) tags.set(tag, (tags.get(tag) ?? 0) + 1)
    }
    return {
      sessionId: this.sessionId,
      entries: this.entries.length,
      pages: this.pages.length,
      chars,
      tokens,
      tokensByTier,
      byTier,
      byKind,
      topTags: [...tags.entries()].sort((left, right) => right[1] - left[1]).slice(0, 8),
      turn: this.turn,
      cursor: this.cursor,
    }
  }

  recent(limit = 8) {
    return this.entries.slice(-Math.max(1, limit)).reverse()
  }
}

export class NotebookRegistry {
  constructor(options) {
    this.config = options.config
    this.directory = options.directory
    this.notebooks = new Map()
  }

  pathFor(sessionId) {
    return join(this.directory, `${String(sessionId).replace(/[^\w.-]/g, '_')}.jsonl`)
  }

  ensure(session) {
    const id = String(session.id)
    let notebook = this.notebooks.get(id)
    if (!notebook) {
      notebook = new Notebook({
        sessionId: id,
        file: this.pathFor(id),
        config: this.config,
      })
      notebook.load()
      notebook.replay(session)
      this.notebooks.set(id, notebook)
    }
    notebook.syncSurface(session)
    return notebook
  }

  get(session) {
    return session ? this.ensure(session) : undefined
  }

  dispose(sessionId) {
    const id = String(sessionId)
    const notebook = this.notebooks.get(id)
    if (!notebook) return
    notebook.flush()
    this.notebooks.delete(id)
  }

  disposeAll() {
    for (const notebook of this.notebooks.values()) notebook.flush()
    this.notebooks.clear()
  }
}
