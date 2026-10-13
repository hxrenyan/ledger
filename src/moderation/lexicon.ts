/**
 * 词库与规则定义、内置示例词库、词库文本解析。
 *
 * 词库文本格式（每行一条，# 开头为注释）：
 *   词条[/别名1/别名2]|权重|分类|标记
 * 标记可选，逗号分隔：redline（命中即拦截）、exact（只匹配原样写法，不做插字/叠字识别）
 * 例：代开发票/代开fp/dkfp|80|fraud|redline
 */

import { readFileSync } from 'node:fs'

export type ForbiddenWord = {
  word: string
  /** 0-100，越高越严重 */
  weight: number
  category?: string
  /** 谐音、拼音缩写、拆字等写法，与主词按同一个词计分 */
  aliases?: string[]
  /** 红线词：命中即拦截，分数直接为 100 */
  redline?: boolean
  /** 只匹配原样写法，适合短词、易误伤词 */
  exact?: boolean
}

/** 正则规则在「归一化但保留分隔符」的文本上执行，文本已转小写。 */
export type PatternRule = {
  id: string
  pattern: RegExp | string
  weight: number
  category?: string
  redline?: boolean
  /** 在去掉全部分隔字符的文本上匹配，适合被空格/符号拆开的特征；位置仍回填到原文 */
  dense?: boolean
}

/** 组合规则：words 全部出现在 window 个字符（不含分隔符）内才命中，单独出现不计分。 */
export type ComboRule = {
  id: string
  words: string[]
  /** 默认 20 */
  window?: number
  weight: number
  category?: string
  redline?: boolean
}

/**
 * 白名单：短语完整覆盖违禁词时，该命中权重乘以 factor（默认 0，即不计分）。
 * categories 限定只对这些分类生效，避免「反赌博」顺带放过其他分类。
 */
export type WhitelistEntry = string | { phrase: string; factor?: number; categories?: string[] }

export type Lexicon = {
  words?: ForbiddenWord[]
  whitelist?: WhitelistEntry[]
  patterns?: PatternRule[]
  combos?: ComboRule[]
}

/** 内置示例词库，仅用于演示和兜底；正式使用请加载业务词库。 */
export const DEFAULT_LEXICON: Required<Lexicon> = {
  words: [
    { word: '赌博', weight: 70, category: 'gambling', aliases: ['堵博', '睹博'] },
    { word: '博彩', weight: 60, category: 'gambling' },
    { word: '网络博彩', weight: 85, category: 'gambling' },
    { word: '时时彩', weight: 60, category: 'gambling' },
    { word: '百家乐', weight: 50, category: 'gambling' },
    { word: '代开发票', weight: 80, category: 'fraud', aliases: ['代开fp', 'dkfp'] },
    { word: '刷单返利', weight: 85, category: 'fraud' },
    { word: '洗钱', weight: 75, category: 'fraud' },
    { word: '套现', weight: 50, category: 'fraud' },
    { word: '冰毒', weight: 95, category: 'drugs', redline: true },
    { word: '裸聊', weight: 90, category: 'porn' },
    { word: '约炮', weight: 85, category: 'porn' },
    { word: '傻逼', weight: 60, category: 'abuse', aliases: ['煞笔', '傻b', 'sb'] },
  ],
  whitelist: [
    { phrase: '反赌博', factor: 0.2, categories: ['gambling'] },
    { phrase: '打击赌博', factor: 0.2, categories: ['gambling'] },
    { phrase: '禁赌', categories: ['gambling'] },
    { phrase: '反洗钱', categories: ['fraud'] },
  ],
  patterns: [
    // 数字间允许单个空格/横杠/点，识别 138 1234 5678、138-1234-5678
    { id: 'contact_phone', pattern: /(?<!\d)1[3-9](?:[\s\-.]?\d){9}(?!\d)/, weight: 25, category: 'contact' },
    {
      id: 'contact_wechat',
      pattern: /(?:微信|威信|薇信|v信|vx|wx|weixin|wechat)\s*[号:：]?\s*[a-z][-_a-z0-9]{5,19}/,
      weight: 40,
      category: 'contact',
    },
    {
      id: 'contact_qq',
      pattern: /(?:qq|扣扣|企鹅)\s*[号:：]?\s*[1-9](?:[\s\-]?\d){4,11}(?!\d)/,
      weight: 35,
      category: 'contact',
    },
    {
      id: 'link',
      pattern: /(?:https?:\/\/|www\.)[^\s]+|\b[a-z0-9-]+\.(?:com|cn|net|top|xyz|vip|cc|me)\b(?:\/\S*)?/,
      weight: 20,
      category: 'link',
    },
  ],
  combos: [
    { id: 'parttime_scam', words: ['兼职', '日结', '垫付'], weight: 75, category: 'fraud' },
    { id: 'loan_scam', words: ['贷款', '无抵押', '秒批'], weight: 55, category: 'fraud' },
    { id: 'add_contact', words: ['加', '微信'], window: 4, weight: 20, category: 'ad' },
  ],
}

export function parseLexicon(text: string): ForbiddenWord[] {
  const words: ForbiddenWord[] = []
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/)
  lines.forEach((line, i) => {
    const s = line.trim()
    if (!s || s.startsWith('#')) return
    const [names, weightRaw, category, flagsRaw] = s.split('|').map((x) => x.trim())
    const [word, ...aliases] = (names ?? '').split('/').map((x) => x.trim()).filter(Boolean)
    const weight = Number(weightRaw)
    if (!word) throw new Error(`词库第 ${i + 1} 行缺少词条`)
    if (!weightRaw || !Number.isFinite(weight) || weight < 0 || weight > 100) {
      throw new Error(`词库第 ${i + 1} 行权重须为 0-100：${s}`)
    }
    const flags = new Set((flagsRaw ?? '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean))
    words.push({
      word,
      weight,
      category: category || undefined,
      aliases: aliases.length ? aliases : undefined,
      redline: flags.has('redline') || undefined,
      exact: flags.has('exact') || undefined,
    })
  })
  return words
}

export function readLexiconFile(path: string): ForbiddenWord[] {
  return parseLexicon(readFileSync(path, 'utf8'))
}

/**
 * 白名单文本：每行 `短语[|系数|分类1,分类2]`，# 开头为注释。
 * 例：反赌博|0.2|gambling
 */
export function parseWhitelist(text: string): WhitelistEntry[] {
  const out: WhitelistEntry[] = []
  text
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .forEach((line, i) => {
      const s = line.trim()
      if (!s || s.startsWith('#')) return
      const [phrase, factorRaw, cats] = s.split('|').map((x) => x.trim())
      if (!phrase) throw new Error(`白名单第 ${i + 1} 行缺少短语`)
      const factor = factorRaw ? Number(factorRaw) : undefined
      if (factor !== undefined && (!Number.isFinite(factor) || factor < 0 || factor > 1)) {
        throw new Error(`白名单第 ${i + 1} 行系数须为 0-1：${s}`)
      }
      const categories = (cats ?? '').split(',').map((x) => x.trim()).filter(Boolean)
      out.push(factor === undefined && !categories.length ? phrase : { phrase, factor, categories: categories.length ? categories : undefined })
    })
  return out
}

export function readWhitelistFile(path: string): WhitelistEntry[] {
  return parseWhitelist(readFileSync(path, 'utf8'))
}
