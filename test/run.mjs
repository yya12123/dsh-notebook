/**
 * Offline check of the notebook core: ingest → tier → search → read → mark.
 * Run with the bundled Node: node test/run.mjs
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { NotebookRegistry } from '../lib/store.js'
import { createTools } from '../lib/tools.js'

const config = {
  dataDir: mkdtempSync(join(tmpdir(), 'notebook-test-')),
  entryChars: 4000,
  abstractChars: 60,
  midTurns: 2,
  searchLimit: 8,
  readMaxChars: 800,
  instructions: true,
  includeSubagents: false,
  tagRules: {},
}

const events = []
let seq = 0
const push = (type, data) => {
  seq += 1
  events.push({ type, seq, time: 1_760_000_000_000 + seq * 60_000, data })
}
const user = text => ({ role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } })
const assistant = text => ({ role: 'assistant', content: [{ type: 'text', text }], source: { kind: 'model' } })

push('turn/start', { turn: 1 })
push('user/message', user('我今天第一次叫你大肥鱼，你还记得吗'))
push('assistant/message', { turn: 1, step: 1, message: assistant('当然记得，那是我们第一次见面。你说要养一条会说话的鱼。') })
push('turn/end', { turn: 1, reason: { kind: 'completed' } })

push('turn/start', { turn: 2 })
push('user/message', user('帮我把这个插件的配置文件改一下，token 太贵了'))
push('assistant/message', { turn: 2, step: 1, message: assistant('已经改好 config，缓存命中率提升了。') })
push('turn/end', { turn: 2, reason: { kind: 'completed' } })

push('turn/start', { turn: 3 })
push('user/message', user('你还记得我们约定过什么吗？以后每年生日都要一起过'))
push('assistant/message', { turn: 3, step: 1, message: assistant('记得，说好了永远一起过生日，这是我们的重要约定。') })
push('turn/end', { turn: 3, reason: { kind: 'completed' } })

// A plugin-injected context message must never be captured as human speech.
push('turn/start', { turn: 4 })
push('user/message', {
  role: 'user',
  content: [{ type: 'text', text: 'OPENVIKING PROFILE BLOCK 不应被记入对话' }],
  source: { kind: 'plugin:other', plugin: 'other', form: 'instructions' },
})
push('assistant/message', { turn: 4, step: 1, message: assistant('收到了。') })
push('turn/end', { turn: 4, reason: { kind: 'completed' } })

// Compaction keeps only the last turn on the model surface.
const surface = { nodes: [events.at(-3).seq, events.at(-2).seq, events.at(-1).seq], replaceGeneration: 1 }
const session = {
  id: 'session-test',
  header: {},
  surface,
  snapshotEvents: from => events.filter(event => event.seq >= from),
}

const registry = new NotebookRegistry({ config, directory: config.dataDir })
const notebook = registry.ensure(session)
for (const event of events) notebook.ingestEvent(event)

const stats = notebook.stats()
console.log('stats', JSON.stringify({
  entries: stats.entries,
  byTier: stats.byTier,
  byKind: stats.byKind,
  topTags: stats.topTags,
}))

const hit = notebook.search('生日 约定')
console.log('search 生日/约定 ->', hit.cards.map(card => `${card.entry.id}:${card.tier}:${card.entry.kind}`))

const fish = notebook.search('大肥鱼')
console.log('search 大肥鱼 ->', fish.cards.map(card => `${card.entry.id}:${card.tier}`))

const leak = notebook.search('OPENVIKING')
console.log('injected context leaked?', leak.total > 0)

const read = notebook.read([fish.cards[0]?.entry.id].filter(Boolean), { maxChars: 800 })
console.log('read ->\n' + read.blocks.join('\n---\n'))

const marked = notebook.mark({ ids: [fish.cards[0]?.entry.id].filter(Boolean), title: '第一次见面', note: '他说要养一条会说话的鱼', tags: ['回忆'] })
console.log('mark ->', marked.page?.id, marked.page?.ids)
console.log('read page ->', notebook.read(['p001']).blocks.length, 'blocks')

const note = notebook.mark({ text: '今天有点难过，因为聊到了很久以前的事。', tags: ['感情'] })
console.log('reflection ->', note.entry?.id, note.entry?.tags)

// Reload from disk: state must survive a restart.
const registry2 = new NotebookRegistry({ config, directory: config.dataDir })
const reloaded = registry2.ensure(session)
const reloadedStats = reloaded.stats()
console.log('reload ->', JSON.stringify({ entries: reloadedStats.entries, pages: reloadedStats.pages }))
console.log('reload search 大肥鱼 ->', reloaded.search('大肥鱼').cards.length)
console.log('reload page ->', reloaded.read(['p001']).blocks.length)

// Tools: exercise through the same surface an Agent would use.
const tools = createTools({ registry, sessions: { get: () => session }, config })
const byName = Object.fromEntries(tools.map(tool => [tool.name, tool]))
const exec = { agent: { id: 'session-test' } }
const searchResult = await byName.notebook_search.execute({ query: '生日' }, exec)
console.log('tool search ->\n' + searchResult.text)
const markResult = await byName.notebook_mark.execute({ text: '第二次测试思考', tags: ['技术'] }, exec)
console.log('tool mark ->', markResult.text)
const pageResult = await byName.notebook_read.execute({ page: 'p001' }, exec)
console.log('tool read ->', pageResult.text.split('\n')[0])

rmSync(config.dataDir, { recursive: true, force: true })
console.log('OK')
