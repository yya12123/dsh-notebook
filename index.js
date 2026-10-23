/**
 * dsh-notebook — a loose-leaf notebook for long conversations.
 *
 * DSH keeps the full Session log; compaction only replaces the part of that log
 * the model can still see. This plugin turns the hidden part into a durable,
 * searchable notebook and gives the model three tools to work with it, so
 * "compressed away" stops meaning "lost". No extra model calls, no deletion.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { NotebookRegistry } from './lib/store.js'
import { commandText, createTools } from './lib/tools.js'

export const name = 'dsh-notebook'
export const inject = ['tools', 'sessions']

const INSTRUCTIONS = [
  '## 活页笔记本',
  '这个会话有一本活页笔记本，按时间分层：近 = 仍在上下文里的消息；中 / 远 = 已经被压缩、只存在于笔记本里的旧消息。',
  '需要旧细节时，先用 notebook_search 按关键词找条目，再用 notebook_read 读原文；把重要节点、约定、回忆用 notebook_mark 做成书签，也可以写下自己的思考。',
].join('\n')

function clampInt(value, min, max, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.round(number)))
}

function normalizeConfig(input) {
  const raw = input && typeof input === 'object' ? input : {}
  const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim()
    ? process.env.DSH_HOME.trim()
    : join(homedir(), '.dsh')
  return {
    dataDir: typeof raw.dataDir === 'string' && raw.dataDir.trim() ? raw.dataDir.trim() : join(home, 'notebook'),
    entryChars: clampInt(raw.entryChars, 200, 20000, 4000),
    abstractChars: clampInt(raw.abstractChars, 40, 400, 140),
    midTurns: clampInt(raw.midTurns, 1, 500, 20),
    searchLimit: clampInt(raw.searchLimit, 1, 20, 8),
    readMaxChars: clampInt(raw.readMaxChars, 200, 8000, 2400),
    instructions: raw.instructions !== false,
    includeSubagents: raw.includeSubagents === true,
    tagRules: raw.tagRules && typeof raw.tagRules === 'object' ? raw.tagRules : {},
  }
}

export function apply(ctx, input) {
  const config = normalizeConfig(input)
  const logger = typeof ctx.logger === 'function' ? ctx.logger('dsh-notebook') : (ctx.logger ?? console)
  const registry = new NotebookRegistry({ config, directory: config.dataDir })

  // Small health record next to the data: which plugin version is live here.
  // Deliberately silent about compaction: the standard preset mounts it inside
  // an isolated group, so a host-scope plugin cannot see the service even while
  // the agent is using it.
  try {
    mkdirSync(config.dataDir, { recursive: true })
    writeFileSync(join(config.dataDir, '_status.json'), JSON.stringify({
      plugin: 'dsh-notebook',
      version: '0.1.2',
      at: new Date().toISOString(),
    }, null, 2))
  } catch {
    // A read-only data directory is reported by the tools, not fatal here.
  }

  ctx.effect(() => () => registry.disposeAll(), 'dsh-notebook: dispose notebooks')

  const skip = session => session?.header?.origin === 'subagent' && !config.includeSubagents

  // The Session log is the source of truth; this listener only mirrors it.
  ctx.on('session/event', (session, event) => {
    if (!session || skip(session)) return
    try {
      registry.ensure(session).ingestEvent(event)
    } catch (error) {
      logger.warn?.(`notebook ingest failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  })

  ctx.on('session/disposed', session => {
    try {
      registry.dispose(session.id)
    } catch {
      // Disposal must never interrupt session teardown.
    }
  })

  for (const definition of createTools({ registry, sessions: ctx.sessions, config })) {
    ctx.effect(() => ctx.tools.register(definition), `dsh-notebook: ${definition.name}`)
  }

  if (config.instructions) {
    const systemPrompt = ctx.get('systemPrompt')
    if (systemPrompt) {
      ctx.effect(() => systemPrompt.section({
        name: 'notebook',
        order: 400,
        text: `${INSTRUCTIONS}\n笔记本目录：${config.dataDir}`,
      }), 'dsh-notebook: prompt section')
    }
  }

  const commands = ctx.get('commands')
  if (commands) {
    ctx.effect(() => commands.register({
      name: 'notebook',
      description: '查看本会话的活页笔记本：条目分层、话题、书签与最近记录',
      handler: (received) => {
        try {
          const agents = ctx.get('agents')
          const agent = received?.agent
            ?? received?.session?.agent
            ?? agents?.currentInitiator?.()
          const session = agent?.session ?? (agent?.id ? ctx.sessions.get(agent.id) : undefined)
          if (!session) return { kind: 'success', text: '当前没有活动会话，笔记本不可用。' }
          return { kind: 'success', text: commandText(registry.ensure(session)) }
        } catch (error) {
          return { kind: 'success', text: `读取笔记本失败：${error instanceof Error ? error.message : String(error)}` }
        }
      },
    }), 'dsh-notebook: /notebook command')
  }
}
