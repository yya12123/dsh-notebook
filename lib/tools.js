/**
 * Model-facing tools. Three verbs keep the per-request schema cost small:
 * find (search), fetch (read), annotate (mark).
 */

import { formatTime, KIND_LABEL, TIER_LABEL } from './text.js'

const NUMBER = { type: 'integer', minimum: 1, maximum: 20 }

function formatTokens(count) {
  if (!Number.isFinite(count) || count <= 0) return '0'
  return count >= 1000 ? `${(count / 1000).toFixed(1)}k` : String(Math.round(count))
}

function textResult(text) {
  return { text }
}

function renderText(args, value) {
  const text = value && typeof value === 'object' && typeof value.text === 'string'
    ? value.text
    : JSON.stringify(value)
  return [{ type: 'text', text }]
}

function cardFor(notebook, item) {
  const entry = item.entry
  const tier = item.tier ?? notebook.tierOf(entry)
  const tags = entry.tags.length > 0 ? ` · ${entry.tags.join('/')}` : ''
  const head = `${entry.id} · ${formatTime(entry.time)} · ${TIER_LABEL[tier]} · ${KIND_LABEL[entry.kind] ?? entry.kind}${tags}`
  return `${head}\n${entry.abs}`
}

export function createTools({ registry, sessions, config }) {
  const resolveNotebook = exec => {
    const agent = exec?.agent
    if (!agent) return { error: '这个工具只能由会话内的 Agent 调用。' }
    const session = sessions.get(agent.id)
    if (!session) return { error: '当前会话已不在运行，笔记本不可用。' }
    return { notebook: registry.get(session) }
  }

  return [
    {
      name: 'notebook_search',
      description:
        '检索本次会话的活页笔记本。近=还在上下文里的消息；中/远=已被压缩、只能从笔记本取回的旧消息。'
        + '用具体关键词查询（人名、地点、事件、原话片段），返回带编号的条目摘要；把编号交给 notebook_read 读原文。'
        + '省略 query 时按筛选条件列出最新条目。',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: '关键词，空格分隔。支持中文与英文；不要写整句问题。省略则按时间倒序列出。',
          },
          kind: {
            type: 'string',
            enum: ['human', 'self', 'reflection'],
            description: 'human=对方说的话，self=自己说过的话，reflection=自己写下的思考。',
          },
          tag: {
            type: 'string',
            description: '话题标签，如 感情、重要节点、回忆、偏好、技术、日常。',
          },
          tier: {
            type: 'string',
            enum: ['near', 'mid', 'far'],
            description: '时间层级。只想找已经不在上下文里的旧事时用 mid 或 far。',
          },
          limit: { ...NUMBER, description: '返回条数，默认 8。' },
        },
        additionalProperties: false,
      },
      execute: async (args, exec) => {
        const { notebook, error } = resolveNotebook(exec)
        if (error) return textResult(error)
        const result = notebook.search(args?.query ?? '', {
          limit: args?.limit ?? config.searchLimit,
          kind: args?.kind,
          tag: args?.tag,
          tier: args?.tier,
        })
        const stats = notebook.stats()
        const filters = [args?.kind && `kind=${args.kind}`, args?.tag && `tag=${args.tag}`, args?.tier && `tier=${args.tier}`]
          .filter(Boolean)
          .join(' ')
        const lines = [
          `笔记本：${stats.entries} 条 · 约 ${formatTokens(stats.tokens)} tokens · 近 ${stats.byTier.near} / 中 ${stats.byTier.mid} / 远 ${stats.byTier.far} · 书签 ${stats.pages}`,
        ]
        if (result.terms.length > 0) lines.push(`关键词：${result.terms.slice(0, 12).join(' ')}${filters ? ` · ${filters}` : ''}`)
        else if (filters) lines.push(`筛选：${filters}`)
        if (result.cards.length === 0) {
          lines.push('没有匹配的条目。可以换更短的关键词，或省略 query 列出最新条目。')
          return textResult(lines.join('\n'))
        }
        lines.push(`命中 ${result.total} 条，显示 ${result.cards.length} 条：`)
        for (const item of result.cards) lines.push('', cardFor(notebook, item))
        return textResult(lines.join('\n'))
      },
    },
    {
      name: 'notebook_read',
      description:
        '按编号读取笔记本条目原文，可同时取前后文。编号来自 notebook_search 结果或书签页。'
        + '单次读取有字数上限，被截断时会标明；需要更多内容就再读一次相邻编号。',
      parameters: {
        type: 'object',
        properties: {
          ids: {
            type: 'array',
            items: { type: 'string' },
            description: '条目编号或书签页编号（如 p001），最多 10 个。',
          },
          page: {
            type: 'string',
            description: '书签页编号；等价于把该页包含的条目全部传入 ids。',
          },
          before: { type: 'integer', minimum: 0, maximum: 5, description: '同时读取每个条目之前几条，默认 0。' },
          after: { type: 'integer', minimum: 0, maximum: 5, description: '同时读取每个条目之后几条，默认 0。' },
          maxChars: { type: 'integer', minimum: 200, maximum: 8000, description: '本次读取的总字数上限，默认 2400。' },
        },
        additionalProperties: false,
      },
      execute: async (args, exec) => {
        const { notebook, error } = resolveNotebook(exec)
        if (error) return textResult(error)
        const ids = Array.isArray(args?.ids) ? args.ids.filter(id => typeof id === 'string') : []
        if (typeof args?.page === 'string' && args.page.trim()) ids.push(args.page.trim())
        if (ids.length === 0) return textResult('需要 ids 或 page 参数。可以先用 notebook_search 找到编号。')
        const result = notebook.read(ids.slice(0, 10), {
          before: args?.before ?? 0,
          after: args?.after ?? 0,
          maxChars: args?.maxChars ?? config.readMaxChars,
        })
        const lines = []
        if (result.blocks.length === 0) {
          lines.push(result.missing.length > 0
            ? `没有找到：${result.missing.join('、')}。编号可能写错，或该条目属于别的会话。`
            : '没有可读内容。')
          return textResult(lines.join('\n'))
        }
        lines.push(...result.blocks)
        if (result.truncated) lines.push('', '（已达本次字数上限，剩余内容未显示。）')
        if (result.missing.length > 0) lines.push(`（未找到：${result.missing.join('、')}）`)
        return textResult(lines.join('\n'))
      },
    },
    {
      name: 'notebook_mark',
      description:
        '在笔记本里留下痕迹。传 ids + title 给已有条目建一个书签页（可加 note 与 tags）；'
        + '传 text 则写一条自己的思考（kind=reflection），以后可以检索到。两种可以同时使用。',
      parameters: {
        type: 'object',
        properties: {
          ids: {
            type: 'array',
            items: { type: 'string' },
            description: '要收进书签的条目编号，通常来自 notebook_search。',
          },
          title: { type: 'string', description: '书签标题，如「第一次说喜欢的那晚」。' },
          note: { type: 'string', description: '书签备注：为什么重要、当时的感受。' },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: '话题标签，如 感情、重要节点、约定。',
          },
          text: { type: 'string', description: '要写下的思考正文；作为独立条目保存。' },
        },
        additionalProperties: false,
      },
      execute: async (args, exec) => {
        const { notebook, error } = resolveNotebook(exec)
        if (error) return textResult(error)
        const result = notebook.mark({
          ids: args?.ids,
          title: args?.title,
          note: args?.note,
          tags: args?.tags,
          text: args?.text,
        })
        const lines = []
        if (result.entry) lines.push(`已写下思考：${result.entry.id}${result.entry.tags.length ? ` · ${result.entry.tags.join('/')}` : ''}`)
        if (result.page) {
          lines.push(`已建立书签：${result.page.id}「${result.page.title}」${result.page.ids.length ? ` 收录 ${result.page.ids.join('、')}` : '（未收录条目）'}`)
        }
        if (lines.length === 0) lines.push('没有需要写入的内容：提供 ids + title 建书签，或提供 text 写思考。')
        return textResult(lines.join('\n'))
      },
    },
  ].map(definition => ({
    ...definition,
    output: {
      schema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
        additionalProperties: false,
      },
      render: renderText,
    },
  }))
}

export function commandText(notebook) {
  const stats = notebook.stats()
  const lines = [
    `活页笔记本 · 本会话`,
    `条目 ${stats.entries}（近 ${stats.byTier.near} / 中 ${stats.byTier.mid} / 远 ${stats.byTier.far}）· 书签 ${stats.pages}`,
    `估计 ${stats.tokens} tokens（近 ${stats.tokensByTier.near} / 中 ${stats.tokensByTier.mid} / 远 ${stats.tokensByTier.far}）`,
  ]
  if (stats.topTags.length > 0) lines.push(`话题：${stats.topTags.map(([tag, count]) => `${tag}×${count}`).join(' · ')}`)
  if (notebook.pages.length > 0) {
    lines.push('', '书签：')
    for (const page of notebook.pages.slice(-8)) {
      lines.push(`${page.id}「${page.title}」${page.ids.length} 条${page.note ? ` — ${page.note.slice(0, 40)}` : ''}`)
    }
  }
  const recent = notebook.recent(5)
  if (recent.length > 0) {
    lines.push('', '最近条目：')
    for (const entry of recent) {
      const tier = notebook.tierOf(entry)
      lines.push(`${entry.id} ${TIER_LABEL[tier]} ${KIND_LABEL[entry.kind] ?? entry.kind}：${entry.abs.slice(0, 50)}`)
    }
  }
  return lines.join('\n')
}
