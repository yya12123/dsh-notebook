import { createTools } from '../lib/tools.js'
import { estimateTokens } from '../lib/text.js'

const config = {
  entryChars: 4000, abstractChars: 140, midTurns: 20, searchLimit: 8,
  readMaxChars: 2400, instructions: true, includeSubagents: false, tagRules: {},
}
const tools = createTools({ registry: {}, sessions: { get: () => undefined }, config })
const projected = tools.map(({ name, description, parameters, output }) => ({
  name, description, parameters, outputSchema: output.schema,
}))
const json = JSON.stringify(projected)
console.log('tool schema json chars:', json.length)
console.log('approx tokens (chars/3.2):', Math.ceil(json.length / 3.2))
for (const tool of projected) {
  const size = JSON.stringify(tool).length
  console.log(`  ${tool.name}: ${size} chars ≈ ${Math.ceil(size / 3.2)} tokens`)
}
const section = [
  '## 活页笔记本',
  '这个会话有一本活页笔记本，按时间分层：近 = 仍在上下文里的消息；中 / 远 = 已经被压缩、只存在于笔记本里的旧消息。',
  '需要旧细节时，先用 notebook_search 按关键词找条目，再用 notebook_read 读原文；把重要节点、约定、回忆用 notebook_mark 做成书签，也可以写下自己的思考。',
].join('\n')
console.log('prompt section chars:', section.length, '≈ tokens:', estimateTokens(section))
