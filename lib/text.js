/**
 * Text utilities for the loose-leaf notebook: tokenization, scoring, tagging.
 *
 * Everything here is pure and dependency-free so it can be exercised outside
 * the Harness (see test/run.mjs).
 */

const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/

const LATIN_RUN = /[a-z0-9_]{2,}/g
const CJK_RUN = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]+/g

/** Tokens: latin words plus CJK unigrams and bigrams. */
export function tokenize(input) {
  const text = String(input ?? '').toLowerCase()
  const tokens = []
  for (const match of text.matchAll(LATIN_RUN)) tokens.push(match[0])
  for (const match of text.matchAll(CJK_RUN)) {
    const run = match[0]
    for (let i = 0; i < run.length; i += 1) {
      tokens.push(run[i])
      if (i + 1 < run.length) tokens.push(run.slice(i, i + 2))
    }
  }
  return tokens
}

/** Rough token count: one CJK character, four latin characters. */
export function estimateTokens(input) {
  let cjk = 0
  let other = 0
  for (const char of String(input ?? '')) {
    if (CJK.test(char)) cjk += 1
    else other += 1
  }
  return cjk + Math.ceil(other / 4)
}

export function clip(input, max) {
  const text = String(input ?? '')
  if (!Number.isFinite(max) || max <= 0 || text.length <= max) return { text, truncated: false }
  return { text: `${text.slice(0, Math.max(0, max - 1))}…`, truncated: true }
}

/** Collapse whitespace and drop control noise while keeping paragraph breaks. */
export function normalize(input) {
  return String(input ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

const TAG_RULES = [
  ['感情', /喜欢你|我爱你|爱你|想你|抱抱|亲亲|心疼|难过|开心|生气|害怕|孤单|陪着?我|心动|告白|温柔|可爱|笨蛋|傻瓜|舍不得|在乎|思念|眼泪|哭|么么|宝贝|亲爱的/],
  ['重要节点', /第一次|决定|约定|答应|承诺|以后|永远|生日|纪念|告别|说好|里程碑|从今|再不/],
  ['回忆', /记得|之前|那次|当时|以前|回忆|曾经|上次|那时候|还记得|想起来/],
  ['偏好', /我喜欢|你喜欢|讨厌|习惯|最爱|不喜欢|更想|偏好|口味/],
  ['技术', /代码|报错|插件|配置|安装|命令|bug|token|函数|接口|日志|部署|编译|依赖|仓库|脚本/],
  ['日常', /吃饭|睡觉|上班|下班|天气|周末|今天|明天|早上|晚上|困|累|摸鱼|咖啡|奶茶/],
]

/**
 * Tag an entry from its text. Tags are a lightweight browsing axis, not a
 * second model call: recall quality comes from full-text search.
 */
export function classify(text, extraRules = {}) {
  const tags = []
  for (const [tag, pattern] of TAG_RULES) {
    if (pattern.test(text)) tags.push(tag)
  }
  for (const [tag, pattern] of Object.entries(extraRules)) {
    if (tags.includes(tag)) continue
    try {
      const re = pattern instanceof RegExp ? pattern : new RegExp(pattern)
      if (re.test(text)) tags.push(tag)
    } catch {
      // A malformed user-supplied pattern must not break ingestion.
    }
  }
  return tags.slice(0, 4)
}

const STOPWORDS = new Set(['的', '了', '是', '我', '你', '他', '她', '它', '们', '在', '和', '与', '就', '也', '都', '而', '及', '或'])

export function queryTerms(input) {
  const seen = new Set()
  const terms = []
  for (const token of tokenize(input)) {
    if (token.length === 1 && STOPWORDS.has(token)) continue
    if (seen.has(token)) continue
    seen.add(token)
    terms.push(token)
  }
  return terms
}

/**
 * Score one document against query terms with an IDF-weighted overlap.
 * `df` maps term -> number of documents containing it; `total` is the corpus size.
 */
export function scoreDocument(terms, termFreq, df, total, docLength, avgLength) {
  const k1 = 1.2
  const b = 0.75
  let score = 0
  for (const term of terms) {
    const tf = termFreq.get(term)
    if (!tf) continue
    const n = df.get(term) ?? 0
    const idf = Math.log(1 + (total - n + 0.5) / (n + 0.5))
    const norm = tf * (k1 + 1) / (tf + k1 * (1 - b + b * (docLength / Math.max(1, avgLength))))
    score += idf * norm
  }
  return score
}

export function formatTime(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '未知时间'
  const date = new Date(ms)
  const pad = value => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export const TIER_LABEL = { near: '近', mid: '中', far: '远' }
export const KIND_LABEL = { human: '对方', self: '自己', reflection: '思考' }
