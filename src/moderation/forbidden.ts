/**
 * 本地违禁词检查。
 *
 * 三类规则：
 * - 违禁词：Aho-Corasick 匹配归一化后的紧凑文本，识别繁简、全角、同形字母、插字、叠字、
 *   夹杂字母数字、别名；配置拼音函数后还能识别同音字（威信→微信）和拼音写法（weixin）
 * - 正则：手机号、微信号、QQ、链接等结构化特征
 * - 组合：多个普通词在短窗口内同时出现（兼职 + 日结 + 垫付）
 *
 * 打分：
 *   有效权重 = 规则权重 × 分类系数 × 重复衰减 × 白名单系数 × 规避系数 × 同音系数 × 长文本系数
 *   分类分 = min(分类上限, 100 × (1 − Π(1 − wᵢ/100)))，总分 = 各分类分再按同样方式合成
 *   命中红线规则直接 100 分。
 * 判定：score ≥ blockThreshold 拦截，≥ reviewThreshold 待审，否则放行。
 */

import { AhoCorasick } from './ahoCorasick.ts'
import {
  DEFAULT_LEXICON,
  type ComboRule,
  type ForbiddenWord,
  type Lexicon,
  type PatternRule,
  type WhitelistEntry,
} from './lexicon.ts'
import { CompactText, isAsciiCode, isHan, isHanCode, Normalizer, type FlatText, type NormalizeConfig } from './normalize.ts'

export type CheckLevel = 'pass' | 'review' | 'block'
export type HitKind = 'word' | 'pattern' | 'combo'
/** 规避写法：插字、零宽字符、叠字、夹杂字母数字、同音字、拼音 */
export type Variant = 'gap' | 'hidden' | 'repeat' | 'noise' | 'homophone' | 'pinyin'

export type ScoreOptions = {
  /** 达到即拦截，默认 60 */
  blockThreshold?: number
  /** 达到即待审，默认 30；大于 blockThreshold 时按 blockThreshold 处理 */
  reviewThreshold?: number
  /** 分类权重系数，未配置为 1；设为 0 关闭该分类（含红线） */
  categoryWeights?: Record<string, number>
  /** 分类分数上限 0-100，防止同类低危命中（如多个手机号）累积成高分 */
  categoryCaps?: Record<string, number>
  /** 同一规则第 k 次命中乘以 repeatDecay^(k-1)，默认 0.5 */
  repeatDecay?: number
  /** 规避写法的权重系数，默认 0.9 */
  obfuscatedFactor?: number
  /** 同音字、拼音命中的额外系数，默认 0.7（同音误伤概率明显高于原词） */
  homophoneFactor?: number
  /** 词内两个字之间最多允许跳过的可见分隔字形数，默认 3；超过视为不连续 */
  maxGap?: number
  /** 中文词内两个汉字之间最多允许夹杂的字母数字个数（赌1博、赌ab博），默认 2，0 关闭 */
  maxNoise?: number
  /**
   * 长文本折算基准（紧凑字符数），默认 0 不折算。
   * 设置后文本超出基准时，非红线命中权重乘以 √(基准/长度)，降低长文零散命中的累积分。
   */
  lengthReference?: number
  /** 打码字符，默认 * */
  maskChar?: string
  /** 超出部分不检查，结果标记 truncated，默认 50000 */
  maxLength?: number
}

export type HomophoneConfig = {
  /** 单个汉字 → 不带声调的拼音，如 '微' → 'wei'；未知返回 undefined。可接 pinyin-pro 等字典 */
  pinyin: (ch: string) => string | undefined
  /** 是否同时把多音节中文词的拼音连写（weixin）当作别名，默认 true */
  pinyinAlias?: boolean
}

export type CheckerConfig = Lexicon & {
  /** 归一化配置影响词条索引，只能在构造时设置 */
  normalize?: NormalizeConfig
  homophone?: HomophoneConfig
  options?: ScoreOptions
  /** 结果缓存条数，默认 1000，0 关闭；只缓存 2000 字以内的文本 */
  cacheSize?: number
  /** 词库版本标签，写入结果便于排查，默认 local */
  lexiconVersion?: string
}

export type ForbiddenHit = {
  kind: HitKind
  /** 违禁词为主词，正则与组合为规则 id */
  rule: string
  category: string
  /** 原文命中片段及 UTF-16 区间 [start, end) */
  text: string
  start: number
  end: number
  /** 规则配置权重 */
  weight: number
  /** 参与计分的有效权重 */
  effectiveWeight: number
  obfuscated: boolean
  variants: Variant[]
  /** 被白名单降权 */
  whitelisted: boolean
  redline: boolean
  reason: string
}

export type CheckResult = {
  violated: boolean
  level: CheckLevel
  /** 0-100 */
  score: number
  /** 违规可能性 0-1 */
  probability: number
  redline: boolean
  /** 各分类分数（已应用上限） */
  categories: Record<string, number>
  hits: ForbiddenHit[]
  reasons: string[]
  /** 违禁词和正则命中处打码后的文本 */
  masked: string
  truncated: boolean
  /** 词库版本标签#修订号，词库或配置每次变更修订号加一 */
  version: string
}

export type CheckerMetrics = {
  checks: number
  cacheHits: number
  levels: Record<CheckLevel, number>
  /** 按命中次数倒序，键为 kind:rule */
  topRules: { rule: string; count: number }[]
}

type WordEntry = Required<Omit<ForbiddenWord, 'aliases'>> & { selfRepeat: boolean }
type WhiteEntry = { factor: number; categories: Set<string> | null }
/**
 * ascii：纯字母数字词条，需校验两侧边界；hasAscii：含字母数字，不参与夹杂字母数字的二轮匹配；
 * via：由拼音自动生成的别名
 */
type AcValue =
  | { kind: 'word'; entry: WordEntry; ascii: boolean; hasAscii: boolean; via?: 'pinyin' }
  | { kind: 'whitelist'; white: WhiteEntry }
type PinyinValue = { entry: WordEntry; cps: number[] }
type ComboValue = { combo: number; word: number }
type CompiledPattern = Required<Omit<PatternRule, 'pattern'>> & { regex: RegExp }
type CompiledCombo = Required<Omit<ComboRule, 'words'>> & { keys: number[][] }
type WordCandidate = { start: number; end: number; entry: WordEntry; variants: Variant[] }
type RawHit = Omit<ForbiddenHit, 'text' | 'effectiveWeight' | 'reason' | 'obfuscated'> & {
  dedupe: string
  /** 白名单系数 */
  factor: number
}

const DEFAULT_CATEGORY = 'default'
const CACHE_TEXT_LIMIT = 2000
const MAX_PATTERN_SOURCE = 500
const MAX_PATTERN_MATCHES = 100
const MAX_COMBO_EVENTS = 2000

const VARIANT_LABEL: Record<Variant, string> = {
  gap: '插字',
  hidden: '隐藏字符',
  repeat: '叠字',
  noise: '夹杂字母数字',
  homophone: '同音字',
  pinyin: '拼音',
}

export class ForbiddenWordChecker {
  private readonly normalizer: Normalizer
  private readonly homophone: Required<HomophoneConfig> | null
  private readonly lexiconVersion: string
  private options: Required<ScoreOptions>
  /** 词条键（含别名） → 词条，别名与主词共用同一个对象 */
  private readonly words = new Map<string, WordEntry>()
  private readonly whitelist = new Map<string, { cps: number[]; white: WhiteEntry }>()
  private readonly patterns = new Map<string, CompiledPattern>()
  private readonly combos = new Map<string, CompiledCombo>()

  private automaton: AhoCorasick<AcValue> | null = null
  private pinyinAutomaton: AhoCorasick<PinyinValue> | null = null
  private comboAutomaton: { ac: AhoCorasick<ComboValue>; list: CompiledCombo[] } | null = null
  private readonly syllableIds = new Map<string, number>()
  private readonly pinyinMemo = new Map<number, number>()

  private revision = 0
  private readonly cacheSize: number
  private readonly cache = new Map<string, CheckResult>()
  private metricsData = emptyMetrics()

  constructor(config: CheckerConfig = {}) {
    this.normalizer = new Normalizer(config.normalize)
    this.homophone = config.homophone ? { pinyinAlias: true, ...config.homophone } : null
    this.lexiconVersion = config.lexiconVersion || 'local'
    this.cacheSize = Math.max(0, Math.floor(config.cacheSize ?? 1000))
    this.options = resolveOptions(config.options ?? {})
    this.addWords(config.words ?? [])
    this.addWhitelist(config.whitelist ?? [])
    this.addPatterns(config.patterns ?? [])
    this.addCombos(config.combos ?? [])
  }

  /** 内置示例词库 + 自定义配置，自定义同名规则覆盖内置。 */
  static withDefaults(config: CheckerConfig = {}): ForbiddenWordChecker {
    return new ForbiddenWordChecker({
      ...config,
      words: [...DEFAULT_LEXICON.words, ...(config.words ?? [])],
      whitelist: [...DEFAULT_LEXICON.whitelist, ...(config.whitelist ?? [])],
      patterns: [...DEFAULT_LEXICON.patterns, ...(config.patterns ?? [])],
      combos: [...DEFAULT_LEXICON.combos, ...(config.combos ?? [])],
    })
  }

  get version(): string {
    return `${this.lexiconVersion}#${this.revision}`
  }

  addWords(words: ForbiddenWord[]): this {
    for (const w of words) {
      const main = this.normalizer.key(w.word)
      if (!main.cps.length) continue
      assertWeight(w.weight, w.word)
      const entry: WordEntry = {
        word: w.word,
        weight: w.weight,
        category: w.category || DEFAULT_CATEGORY,
        redline: w.redline ?? false,
        exact: w.exact ?? false,
        selfRepeat: main.collapsed,
      }
      this.deleteWord(main.key)
      for (const name of [w.word, ...(w.aliases ?? [])]) {
        const { key } = name === w.word ? main : this.normalizer.key(name)
        if (key) this.words.set(key, entry)
      }
    }
    return this.changed(true)
  }

  /** 按主词或别名删除，会连同该词的全部别名一起删除。 */
  removeWords(words: string[]): this {
    for (const w of words) this.deleteWord(this.normalizer.key(w).key)
    return this.changed(true)
  }

  addWhitelist(entries: WhitelistEntry[]): this {
    for (const e of entries) {
      const phrase = typeof e === 'string' ? e : e.phrase
      const { key, cps } = this.normalizer.key(phrase)
      if (!cps.length) continue
      const factor = typeof e === 'string' ? 0 : clamp(e.factor ?? 0, 0, 1)
      const categories = typeof e === 'string' || !e.categories?.length ? null : new Set(e.categories)
      this.whitelist.set(key, { cps, white: { factor, categories } })
    }
    return this.changed(true)
  }

  removeWhitelist(phrases: string[]): this {
    for (const p of phrases) this.whitelist.delete(this.normalizer.key(p).key)
    return this.changed(true)
  }

  addPatterns(rules: PatternRule[]): this {
    for (const r of rules) {
      assertWeight(r.weight, r.id)
      const regex = toGlobalRegex(r.pattern)
      assertSafePattern(regex.source, r.id)
      this.patterns.set(r.id, {
        id: r.id,
        weight: r.weight,
        category: r.category || DEFAULT_CATEGORY,
        redline: r.redline ?? false,
        dense: r.dense ?? false,
        regex,
      })
    }
    return this.changed(false)
  }

  addCombos(rules: ComboRule[]): this {
    for (const r of rules) {
      assertWeight(r.weight, r.id)
      const keys = r.words.map((w) => this.normalizer.key(w).cps).filter((k) => k.length)
      if (keys.length < 2) throw new Error(`组合规则至少需要两个有效词: ${r.id}`)
      this.combos.set(r.id, {
        id: r.id,
        weight: r.weight,
        category: r.category || DEFAULT_CATEGORY,
        redline: r.redline ?? false,
        window: Math.max(1, r.window ?? 20),
        keys,
      })
    }
    return this.changed(false)
  }

  removeRules(ids: string[]): this {
    for (const id of ids) {
      this.patterns.delete(id)
      this.combos.delete(id)
    }
    return this.changed(false)
  }

  setOptions(options: ScoreOptions): this {
    this.options = resolveOptions({ ...this.options, ...options })
    return this.changed(false)
  }

  stats(): { words: number; keys: number; whitelist: number; patterns: number; combos: number; version: string } {
    return {
      words: new Set(this.words.values()).size,
      keys: this.words.size,
      whitelist: this.whitelist.size,
      patterns: this.patterns.size,
      combos: this.combos.size,
      version: this.version,
    }
  }

  metrics(top = 20): CheckerMetrics {
    const m = this.metricsData
    const topRules = [...m.rules.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, top)
      .map(([rule, count]) => ({ rule, count }))
    return { checks: m.checks, cacheHits: m.cacheHits, levels: { ...m.levels }, topRules }
  }

  resetMetrics(): this {
    this.metricsData = emptyMetrics()
    return this
  }

  /** override 只影响本次检查。返回值是独立副本，可以放心修改。 */
  check(text: string, override?: ScoreOptions): CheckResult {
    const source = typeof text === 'string' ? text : ''
    const cacheKey = this.cacheSize && source.length <= CACHE_TEXT_LIMIT ? `${override ? JSON.stringify(override) : ''}\u0000${source}` : null

    let result = cacheKey ? this.cache.get(cacheKey) : undefined
    if (result && cacheKey) {
      this.cache.delete(cacheKey)
      this.cache.set(cacheKey, result)
      this.metricsData.cacheHits++
    } else {
      result = this.evaluate(source, override ? resolveOptions({ ...this.options, ...override }) : this.options)
      if (cacheKey) {
        this.cache.set(cacheKey, result)
        if (this.cache.size > this.cacheSize) this.cache.delete(this.cache.keys().next().value as string)
      }
    }
    this.record(result)
    return structuredClone(result)
  }

  checkMany(texts: string[], override?: ScoreOptions): CheckResult[] {
    return texts.map((t) => this.check(t, override))
  }

  private evaluate(source: string, opts: Required<ScoreOptions>): CheckResult {
    const truncated = source.length > opts.maxLength
    const input = truncated ? source.slice(0, opts.maxLength) : source
    const chars = this.normalizer.compact(input)
    const raw = [...this.matchWords(chars, opts), ...this.matchPatterns(input), ...this.matchCombos(chars)]
    return this.score(source, chars.length, raw, opts, truncated)
  }

  private matchWords(chars: CompactText, opts: Required<ScoreOptions>): RawHit[] {
    if (!chars.length || !this.words.size) return []
    const ac = this.getAutomaton()
    const cp = chars.cp
    const white: { start: number; end: number; white: WhiteEntry }[] = []
    const candidates: WordCandidate[] = []

    for (const m of ac.search(chars.codes())) {
      const v = m.value
      if (v.kind === 'whitelist') {
        white.push({ start: m.start, end: m.end, white: v.white })
        continue
      }
      // 纯字母数字词条要求两侧不紧贴字母数字，避免 sb 命中 usb
      if (v.ascii && !asciiBounded(chars, m.start, m.end)) continue
      const c = inspectWord(chars, m.start, m.end, v.entry, v.via ? [v.via] : [], opts)
      if (c) candidates.push(c)
    }

    // 二轮：去掉汉字之间夹杂的少量字母数字再匹配（赌1博），只接受真正跨越了夹杂字符的中文词条
    const keep = stripNoise(chars, opts.maxNoise)
    if (keep) {
      for (const m of ac.search(keep.map((k) => cp[k]))) {
        if (m.value.kind === 'whitelist' || m.value.hasAscii) continue
        const start = keep[m.start]
        const end = keep[m.end]
        if (end - start === m.end - m.start) continue
        const c = inspectWord(chars, start, end, m.value.entry, ['noise'], opts)
        if (c) candidates.push(c)
      }
    }

    // 三轮：同音字，按拼音序列匹配，跳过字面完全相同（一轮已命中）的位置
    if (this.homophone) {
      const pac = this.getPinyinAutomaton()
      const tokens = new Int32Array(chars.length)
      for (let i = 0; i < chars.length; i++) tokens[i] = isHanCode(cp[i]) ? this.pinyinId(cp[i]) : -1
      for (const m of pac.search(tokens)) {
        const literal = m.value.cps.every((c, k) => cp[m.start + k] === c)
        if (literal) continue
        const c = inspectWord(chars, m.start, m.end, m.value.entry, ['homophone'], opts)
        if (c) candidates.push(c)
      }
    }

    // 红线优先、高权重优先、再长词优先，避免低权重长词盖住红线词；已占用的位置不再重复计分
    candidates.sort(
      (a, b) =>
        Number(b.entry.redline) - Number(a.entry.redline) ||
        b.entry.weight - a.entry.weight ||
        b.end - b.start - (a.end - a.start) ||
        a.start - b.start,
    )
    const taken = new Uint8Array(chars.length)
    const hits: RawHit[] = []
    for (const c of candidates) {
      let factor = 1
      for (const w of white) {
        if (w.start > c.start || c.end > w.end) continue
        if (w.white.categories && !w.white.categories.has(c.entry.category)) continue
        factor = Math.min(factor, w.white.factor)
      }
      if (factor <= 0) continue
      let free = true
      for (let k = c.start; k <= c.end && free; k++) if (taken[k]) free = false
      if (!free) continue
      taken.fill(1, c.start, c.end + 1)
      hits.push({
        kind: 'word',
        rule: c.entry.word,
        dedupe: `word:${c.entry.word}`,
        category: c.entry.category,
        start: chars.index[c.start],
        end: chars.indexEnd[c.end],
        weight: c.entry.weight,
        variants: c.variants,
        whitelisted: factor < 1,
        factor,
        // 同音、拼音属于模糊匹配，只计分不触发红线
        redline: c.entry.redline && !c.variants.includes('homophone') && !c.variants.includes('pinyin'),
      })
    }
    return hits
  }

  private matchPatterns(input: string): RawHit[] {
    if (!input || !this.patterns.size) return []
    let loose: FlatText | null = null
    let dense: FlatText | null = null
    const hits: RawHit[] = []
    for (const p of this.patterns.values()) {
      const flat = p.dense ? (dense ??= this.normalizer.flat(input, true)) : (loose ??= this.normalizer.flat(input))
      p.regex.lastIndex = 0
      let m: RegExpExecArray | null
      let n = 0
      while (n < MAX_PATTERN_MATCHES && (m = p.regex.exec(flat.text))) {
        if (!m[0].length) {
          p.regex.lastIndex++
          continue
        }
        n++
        hits.push({
          kind: 'pattern',
          rule: p.id,
          dedupe: `pattern:${p.id}`,
          category: p.category,
          start: flat.start ? flat.start[m.index] : m.index,
          end: flat.end ? flat.end[m.index + m[0].length - 1] : m.index + m[0].length,
          weight: p.weight,
          variants: [],
          whitelisted: false,
          factor: 1,
          redline: p.redline,
        })
      }
    }
    return hits
  }

  private matchCombos(chars: CompactText): RawHit[] {
    if (!chars.length || !this.combos.size) return []
    const { ac, list } = this.getComboAutomaton()
    const events = list.map(() => [] as { start: number; end: number; w: number }[])
    for (const m of ac.search(chars.codes())) {
      const bucket = events[m.value.combo]
      if (bucket.length < MAX_COMBO_EVENTS) bucket.push({ start: m.start, end: m.end, w: m.value.word })
    }

    const hits: RawHit[] = []
    list.forEach((c, i) => {
      const best = smallestWindow(events[i], c.keys.length)
      if (!best || best.end - best.start + 1 > c.window) return
      hits.push({
        kind: 'combo',
        rule: c.id,
        dedupe: `combo:${c.id}`,
        category: c.category,
        start: chars.index[best.start],
        end: chars.indexEnd[best.end],
        weight: c.weight,
        variants: [],
        whitelisted: false,
        factor: 1,
        redline: c.redline,
      })
    })
    return hits
  }

  private score(source: string, length: number, raw: RawHit[], opts: Required<ScoreOptions>, truncated: boolean): CheckResult {
    const lengthFactor = opts.lengthReference > 0 && length > opts.lengthReference ? Math.sqrt(opts.lengthReference / length) : 1
    raw.sort((a, b) => a.start - b.start || b.end - a.end)

    const repeats = new Map<string, number>()
    const hits: ForbiddenHit[] = []
    for (const r of raw) {
      const categoryFactor = opts.categoryWeights[r.category] ?? 1
      if (categoryFactor <= 0) continue
      const seen = repeats.get(r.dedupe) ?? 0
      repeats.set(r.dedupe, seen + 1)

      const obfuscated = r.variants.length > 0
      let w = r.weight * categoryFactor * Math.pow(opts.repeatDecay, seen) * r.factor
      if (obfuscated) w *= opts.obfuscatedFactor
      if (r.variants.includes('homophone') || r.variants.includes('pinyin')) w *= opts.homophoneFactor
      if (!r.redline) w *= lengthFactor
      w = clamp(w, 0, 100)
      if (w <= 0 && !r.redline) continue

      const { dedupe: _d, factor: _f, ...rest } = r
      const hit: ForbiddenHit = { ...rest, text: source.slice(r.start, r.end), effectiveWeight: round2(w), obfuscated, reason: '' }
      hit.reason = describe(hit)
      hits.push(hit)
    }

    const categories: Record<string, number> = {}
    for (const cat of new Set(hits.map((h) => h.category))) {
      const own = hits.filter((h) => h.category === cat)
      const cap = clamp(opts.categoryCaps[cat] ?? 100, 0, 100)
      categories[cat] = own.some((h) => h.redline) ? 100 : Math.min(cap, combine(own.map((h) => h.effectiveWeight)))
    }
    const redline = hits.some((h) => h.redline)
    const score = redline ? 100 : combine(Object.values(categories))
    const level: CheckLevel = score >= opts.blockThreshold ? 'block' : score >= opts.reviewThreshold ? 'review' : 'pass'

    return {
      violated: level === 'block',
      level,
      score,
      probability: score / 100,
      redline,
      categories,
      hits,
      reasons: hits.map((h) => h.reason),
      masked: mask(source, hits, opts.maskChar),
      truncated,
      version: this.version,
    }
  }

  private record(result: CheckResult): void {
    const m = this.metricsData
    m.checks++
    m.levels[result.level]++
    for (const h of result.hits) {
      const key = `${h.kind}:${h.rule}`
      m.rules.set(key, (m.rules.get(key) ?? 0) + 1)
    }
  }

  /** 任何词库或配置变更都会升级修订号并清空缓存；wordsChanged 时重建词条自动机。 */
  private changed(wordsChanged: boolean): this {
    if (wordsChanged) {
      this.automaton = null
      this.pinyinAutomaton = null
    }
    this.comboAutomaton = null
    this.revision++
    this.cache.clear()
    return this
  }

  private deleteWord(key: string): void {
    const entry = this.words.get(key)
    if (!entry) return
    for (const [k, v] of this.words) if (v === entry) this.words.delete(k)
  }

  private getAutomaton(): AhoCorasick<AcValue> {
    if (this.automaton) return this.automaton
    const ac = new AhoCorasick<AcValue>()
    const isAscii = (key: string) => /^[a-z0-9]+$/.test(key)
    for (const [key, entry] of this.words) {
      ac.add(toCodes(key), { kind: 'word', entry, ascii: isAscii(key), hasAscii: /[a-z0-9]/.test(key) })
    }
    if (this.homophone?.pinyinAlias) {
      for (const [key, entry] of this.words) {
        const tokens = this.pinyinTokens(key, entry)
        if (!tokens) continue
        const alias = tokens.join('')
        if (this.words.has(alias)) continue
        ac.add(toCodes(alias), { kind: 'word', entry, ascii: isAscii(alias), hasAscii: true, via: 'pinyin' })
      }
    }
    for (const { cps, white } of this.whitelist.values()) ac.add(cps, { kind: 'whitelist', white })
    this.automaton = ac.build()
    return ac
  }

  /** 拼音按音节编号成整数符号；只登记词库里出现过的音节，文本里其他音节直接视为不匹配。 */
  private getPinyinAutomaton(): AhoCorasick<PinyinValue> {
    if (this.pinyinAutomaton) return this.pinyinAutomaton
    this.syllableIds.clear()
    this.pinyinMemo.clear()
    const ac = new AhoCorasick<PinyinValue>()
    for (const [key, entry] of this.words) {
      const tokens = this.pinyinTokens(key, entry)
      if (!tokens) continue
      const ids = tokens.map((t) => {
        let id = this.syllableIds.get(t)
        if (id === undefined) this.syllableIds.set(t, (id = this.syllableIds.size))
        return id
      })
      ac.add(ids, { entry, cps: toCodes(key) })
    }
    this.pinyinAutomaton = ac.build()
    return ac
  }

  private pinyinId(cp: number): number {
    let id = this.pinyinMemo.get(cp)
    if (id === undefined) {
      const p = this.homophone?.pinyin(String.fromCodePoint(cp))?.trim().toLowerCase()
      id = p ? (this.syllableIds.get(p) ?? -1) : -1
      if (this.pinyinMemo.size < 50000) this.pinyinMemo.set(cp, id)
    }
    return id
  }

  private getComboAutomaton(): { ac: AhoCorasick<ComboValue>; list: CompiledCombo[] } {
    if (this.comboAutomaton) return this.comboAutomaton
    const ac = new AhoCorasick<ComboValue>()
    const list = [...this.combos.values()]
    list.forEach((c, combo) => c.keys.forEach((key, word) => ac.add(key, { combo, word })))
    this.comboAutomaton = { ac: ac.build(), list }
    return this.comboAutomaton
  }

  /** 至少两个汉字、全部可转拼音、非 exact 的词条才参与同音匹配；单字同音误伤太高。 */
  private pinyinTokens(key: string, entry: WordEntry): string[] | null {
    if (!this.homophone || entry.exact) return null
    const chars = Array.from(key)
    if (chars.length < 2 || !chars.every((c) => isHan(c))) return null
    const tokens: string[] = []
    for (const c of chars) {
      const p = this.homophone.pinyin(c)?.trim().toLowerCase()
      if (!p || !/^[a-z]+$/.test(p)) return null
      tokens.push(p)
    }
    return tokens
  }
}

function resolveOptions(o: ScoreOptions): Required<ScoreOptions> {
  const blockThreshold = clamp(o.blockThreshold ?? 60, 0, 100)
  return {
    blockThreshold,
    reviewThreshold: Math.min(clamp(o.reviewThreshold ?? 30, 0, 100), blockThreshold),
    categoryWeights: { ...(o.categoryWeights ?? {}) },
    categoryCaps: { ...(o.categoryCaps ?? {}) },
    repeatDecay: clamp(o.repeatDecay ?? 0.5, 0, 1),
    obfuscatedFactor: clamp(o.obfuscatedFactor ?? 0.9, 0, 1),
    homophoneFactor: clamp(o.homophoneFactor ?? 0.7, 0, 1),
    maxGap: Math.max(0, Math.floor(o.maxGap ?? 3)),
    maxNoise: Math.max(0, Math.floor(o.maxNoise ?? 2)),
    lengthReference: Math.max(0, Math.floor(o.lengthReference ?? 0)),
    maskChar: o.maskChar || '*',
    maxLength: Math.max(1, Math.floor(o.maxLength ?? 50000)),
  }
}

function emptyMetrics() {
  return {
    checks: 0,
    cacheHits: 0,
    levels: { pass: 0, review: 0, block: 0 } as Record<CheckLevel, number>,
    rules: new Map<string, number>(),
  }
}

function toGlobalRegex(p: RegExp | string): RegExp {
  if (typeof p === 'string') return new RegExp(p, 'giu')
  return p.flags.includes('g') ? new RegExp(p.source, p.flags) : new RegExp(p.source, p.flags + 'g')
}

/**
 * 拒绝明显可能灾难性回溯的正则：被量词修饰的分组内部还含有 * + {} 量词，如 (a+)+、(\w*)*。
 * 只是启发式检查，外部来源的规则仍建议人工审核。
 */
function assertSafePattern(source: string, id: string): void {
  if (source.length > MAX_PATTERN_SOURCE) throw new Error(`正则过长（>${MAX_PATTERN_SOURCE}）: ${id}`)
  const stack: boolean[] = []
  let inClass = false
  for (let i = 0; i < source.length; i++) {
    const ch = source[i]
    if (ch === '\\') {
      i++
      continue
    }
    if (inClass) {
      if (ch === ']') inClass = false
      continue
    }
    if (ch === '[') {
      inClass = true
    } else if (ch === '(') {
      stack.push(false)
    } else if (ch === ')') {
      const inner = stack.pop() ?? false
      const next = source[i + 1]
      if (inner && (next === '*' || next === '+' || next === '{')) {
        throw new Error(`正则存在嵌套量词，可能导致回溯爆炸: ${id}`)
      }
      if (inner && stack.length) stack[stack.length - 1] = true
    } else if ((ch === '*' || ch === '+' || ch === '{') && stack.length) {
      stack[stack.length - 1] = true
    }
  }
}

function combine(weights: number[]): number {
  let safe = 1
  for (const w of weights) safe *= 1 - w / 100
  return Math.round((1 - safe) * 100)
}

function describe(h: ForbiddenHit): string {
  const kind = h.kind === 'word' ? '违禁词' : h.kind === 'pattern' ? '正则规则' : '组合规则'
  const tags = [h.category, `权重 ${h.effectiveWeight}`]
  if (h.redline) tags.push('红线')
  if (h.variants.length) tags.push(`规避写法：${h.variants.map((v) => VARIANT_LABEL[v]).join('、')}`)
  if (h.whitelisted) tags.push('白名单降权')
  return `${kind}「${h.rule}」命中「${h.text}」(${tags.join('，')})`
}

function mask(source: string, hits: ForbiddenHit[], maskChar: string): string {
  const covered = new Uint8Array(source.length)
  for (const h of hits) if (h.kind !== 'combo') covered.fill(1, h.start, h.end)
  let out = ''
  let i = 0
  for (const ch of source) {
    out += covered[i] && !/\s/.test(ch) ? maskChar : ch
    i += ch.length
  }
  return out
}

/** 校验插字间隔并收集规避写法；不合格返回 null。extra 为匹配方式自带的变体（夹杂、同音、拼音）。 */
function inspectWord(
  chars: CompactText,
  start: number,
  end: number,
  entry: WordEntry,
  extra: Variant[],
  opts: Required<ScoreOptions>,
): WordCandidate | null {
  let variants: Variant[] = extra
  const add = (v: Variant) => {
    if (!variants.includes(v)) variants = [...variants, v]
  }
  for (let k = start; k <= end; k++) {
    if (k > start) {
      const gap = chars.gap[k]
      if (gap > opts.maxGap) return null
      if (gap > 0) add('gap')
      if (chars.hidden(k)) add('hidden')
    }
    if (chars.repeated(k) && !entry.selfRepeat) add('repeat')
  }
  if (entry.exact && variants.length) return null
  return { start, end, entry, variants }
}

function asciiBounded(chars: CompactText, start: number, end: number): boolean {
  if (start > 0 && chars.gap[start] === 0 && isAsciiCode(chars.cp[start - 1])) return false
  if (end + 1 < chars.length && chars.gap[end + 1] === 0 && isAsciiCode(chars.cp[end + 1])) return false
  return true
}

function toCodes(s: string): number[] {
  const out: number[] = []
  for (const c of s) out.push(c.codePointAt(0)!)
  return out
}

/** 去掉两侧都是汉字、长度不超过 maxNoise 的字母数字串，返回保留字符的下标；没有可去的返回 null。 */
function stripNoise(chars: CompactText, maxNoise: number): number[] | null {
  if (maxNoise <= 0) return null
  const cp = chars.cp
  let any = false
  for (let i = 0; i < chars.length && !any; i++) if (isAsciiCode(cp[i])) any = true
  if (!any) return null
  const keep: number[] = []
  let changed = false
  for (let i = 0; i < chars.length; ) {
    if (!isAsciiCode(cp[i])) {
      keep.push(i++)
      continue
    }
    let j = i
    while (j < chars.length && isAsciiCode(cp[j])) j++
    if (j - i <= maxNoise && i > 0 && j < chars.length && isHanCode(cp[i - 1]) && isHanCode(cp[j])) {
      changed = true
    } else {
      for (let k = i; k < j; k++) keep.push(k)
    }
    i = j
  }
  return changed ? keep : null
}

/** 覆盖全部 n 个词的最短区间（紧凑字符下标），滑动窗口 + 单调队列维护窗口内最大结束位置，O(m log m)。 */
function smallestWindow(events: { start: number; end: number; w: number }[], n: number): { start: number; end: number } | null {
  events.sort((a, b) => a.start - b.start)
  const count = new Array<number>(n).fill(0)
  const maxEnd: number[] = []
  let head = 0
  let have = 0
  let best: { start: number; end: number } | null = null
  for (let l = 0, r = 0; r < events.length; r++) {
    while (maxEnd.length > head && events[maxEnd[maxEnd.length - 1]].end <= events[r].end) maxEnd.pop()
    maxEnd.push(r)
    if (count[events[r].w]++ === 0) have++
    while (have === n) {
      while (maxEnd[head] < l) head++
      const start = events[l].start
      const end = events[maxEnd[head]].end
      if (!best || end - start < best.end - best.start) best = { start, end }
      if (--count[events[l].w] === 0) have--
      l++
    }
  }
  return best
}

function assertWeight(weight: number, name: string): void {
  if (!Number.isFinite(weight) || weight < 0 || weight > 100) throw new Error(`权重须为 0-100: ${name}`)
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n))
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}
