/**
 * 文本归一化：把各种规避写法收敛成同一个比较形态。
 *
 * - NFKC：全角转半角、圈号/上标等兼容字符转普通字符（Ｖ→v、①→1）
 * - 小写 + 字符映射：繁体转简体、西里尔/希腊同形字母转拉丁字母，可由调用方追加映射
 * - 分隔字符（空白、标点、符号、emoji、组合符、零宽字符）在紧凑形态里被跳过，记录跳过数量
 * - 叠字合并：连续相同字符只保留一个（赌赌赌博 → 赌博）
 *
 * 性能：常用汉字与 ASCII 走查表快速路径；只有文本含组合符、emoji 序列等多码点字形时才按字形切分。
 */

/** 两两成对：繁体在前，简体在后。只收录违禁词高频字，完整繁简转换请通过 charMap 追加。 */
const TRAD_TO_SIMP =
  '賭赌開开發发錢钱銀银貸贷號号碼码現现聯联約约戀恋愛爱導导際际網网絡络槍枪彈弹藥药製制販贩賣卖買买' +
  '獨独擊击殺杀黨党國国華华紅红軍军問问題题達达視视頻频圖图書书會会員员費费優优點点帳账戶户轉转匯汇' +
  '單单劃划測测試试機机線线務务證证辦办驗验據据謠谣傳传違违規规亂乱倫伦婦妇雞鸡陰阴莖茎幹干媽妈爺爷' +
  '麼么這这個个們们為为來来對对說说話话時时間间後后過过還还進进動动樣样實实學学頭头長长體体種种經经' +
  '關关與与從从業业處处應应當当無无義义習习雙双響响億亿萬万張张劉刘陳陈趙赵鄧邓溫温濤涛錦锦澤泽漢汉' +
  '灣湾獄狱衛卫鐵铁飛飞龍龙鳳凤靈灵魚鱼鳥鸟齊齐鬥斗氣气罰罚賠赔騙骗詐诈贏赢輸输盤盘莊庄籌筹選选舉举' +
  '權权煙烟搖摇嫖嫖娼娼裸裸淫淫屌屌筆笔幣币彩彩寶宝雲云盜盗賊贼騷骚擾扰'

/** 两两成对：同形字符在前，拉丁字母在后（已小写）。 */
const HOMOGLYPHS = 'аaеeоoрpсcуyхxіiѕsјjԁdһhӏlοoαaνvρpκkτtιiυuχx'

const SEPARATOR = /[\s\p{P}\p{S}\p{M}\p{Cf}\p{Cc}]/u
/** 不可见字符：不计入插字间隔，但视为规避写法 */
const INVISIBLE = /[\p{M}\p{Cf}\p{Cc}]/u
const HAN = /\p{Script=Han}/u
/** 含这些字符时，一个字形可能由多个码点组成（组合符、emoji 序列、韩文字母组合、CRLF），需按字形切分 */
const COMPLEX = /[\p{M}\u200d\u1100-\u11ff\r\u{1f1e6}-\u{1f1ff}\u{1f3fb}-\u{1f3ff}\u{e0020}-\u{e007f}]/u
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

const MEMO_LIMIT = 50000
const HIDDEN_FLAG = 1
const REPEATED_FLAG = 2

export type NormalizeConfig = {
  /** 追加字符映射，键应为单个字符，例如 { '0': 'o', '薇': '微' } */
  charMap?: Record<string, string>
  /** 合并连续相同字符，默认 true */
  collapseRepeat?: boolean
}

/**
 * 紧凑文本：去掉分隔字符后的归一化字符序列，按列存储以减少对象分配。
 * 第 i 个字符：码点 cp[i]，原文 UTF-16 区间 [index[i], indexEnd[i])，
 * 与前一个字符之间跳过的可见分隔字形数 gap[i]，hidden(i) 表示之间夹有不可见字符，
 * repeated(i) 表示合并过后续重复字符。
 */
export class CompactText {
  length = 0
  cp: Int32Array
  index: Int32Array
  indexEnd: Int32Array
  gap: Int32Array
  flags: Uint8Array

  constructor(capacity: number) {
    const n = Math.max(8, capacity)
    this.cp = new Int32Array(n)
    this.index = new Int32Array(n)
    this.indexEnd = new Int32Array(n)
    this.gap = new Int32Array(n)
    this.flags = new Uint8Array(n)
  }

  push(cp: number, index: number, indexEnd: number, gap: number, hidden: boolean): void {
    if (this.length === this.cp.length) this.grow()
    const i = this.length++
    this.cp[i] = cp
    this.index[i] = index
    this.indexEnd[i] = indexEnd
    this.gap[i] = gap
    this.flags[i] = hidden ? HIDDEN_FLAG : 0
  }

  hidden(i: number): boolean {
    return (this.flags[i] & HIDDEN_FLAG) !== 0
  }

  repeated(i: number): boolean {
    return (this.flags[i] & REPEATED_FLAG) !== 0
  }

  markRepeated(i: number, indexEnd: number): void {
    this.flags[i] |= REPEATED_FLAG
    this.indexEnd[i] = indexEnd
  }

  /** 有效部分的码点视图（不复制） */
  codes(): Int32Array {
    return this.cp.subarray(0, this.length)
  }

  private grow(): void {
    const n = this.cp.length * 2
    const copy = <A extends Int32Array | Uint8Array>(a: A, b: A): A => (b.set(a), b)
    this.cp = copy(this.cp, new Int32Array(n))
    this.index = copy(this.index, new Int32Array(n))
    this.indexEnd = copy(this.indexEnd, new Int32Array(n))
    this.gap = copy(this.gap, new Int32Array(n))
    this.flags = copy(this.flags, new Uint8Array(n))
  }
}

/**
 * 保留分隔符的归一化文本，供正则规则使用。
 * start/end 为每个 UTF-16 单元对应的原文区间；为 null 表示与原文逐单元一一对应（下标即原文下标）。
 */
export type FlatText = { text: string; start: number[] | null; end: number[] | null }

type CompactState = { gap: number; hidden: boolean }

export class Normalizer {
  private readonly map = new Map<string, string>()
  /** 单码点 → 归一化结果（单码点用数字，多码点用字符串），覆盖汉字/ASCII 快速路径和其余字符的记忆化 */
  private readonly cpMap = new Map<number, number | string>()
  private readonly memo = new Map<number, number | string>()
  private readonly sepMemo = new Map<number, boolean>()
  private readonly invisibleMemo = new Map<number, boolean>()
  private readonly collapseRepeat: boolean

  constructor(config: NormalizeConfig = {}) {
    addPairs(this.map, TRAD_TO_SIMP)
    addPairs(this.map, HOMOGLYPHS)
    for (const [from, to] of Object.entries(config.charMap ?? {})) {
      this.map.set(from.normalize('NFKC').toLowerCase(), to.normalize('NFKC').toLowerCase())
    }
    for (const [from, to] of this.map) {
      const f = Array.from(from)
      if (f.length !== 1) continue
      const t = Array.from(to)
      this.cpMap.set(f[0].codePointAt(0)!, t.length === 1 ? t[0].codePointAt(0)! : to)
    }
    this.collapseRepeat = config.collapseRepeat ?? true
  }

  char(raw: string): string {
    let out = ''
    for (const c of raw.normalize('NFKC').toLowerCase()) out += this.map.get(c) ?? c
    return out
  }

  /** 单个码点的归一化结果。常用汉字 NFKC 不变、ASCII 只需转小写，直接查映射表。 */
  mapCp(cp: number): number | string {
    if (cp >= 0x4e00 && cp <= 0x9fff) return this.cpMap.get(cp) ?? cp
    if (cp < 128) {
      const lower = cp >= 65 && cp <= 90 ? cp + 32 : cp
      return this.cpMap.get(lower) ?? lower
    }
    let r = this.memo.get(cp)
    if (r === undefined) {
      const s = this.char(String.fromCodePoint(cp))
      const parts = Array.from(s)
      r = parts.length === 1 ? parts[0].codePointAt(0)! : s
      if (this.memo.size < MEMO_LIMIT) this.memo.set(cp, r)
    }
    return r
  }

  compact(text: string): CompactText {
    const out = new CompactText(text.length + 8)
    const st: CompactState = { gap: 0, hidden: false }
    if (!COMPLEX.test(text)) {
      const cps: number[] = []
      for (let i = 0; i < text.length; ) {
        const cp = text.codePointAt(i)!
        const w = cp > 0xffff ? 2 : 1
        const m = this.mapCp(cp)
        cps.length = 0
        if (typeof m === 'number') cps.push(m)
        else for (const c of m) cps.push(c.codePointAt(0)!)
        this.feed(out, st, cps, i, i + w)
        i += w
      }
      return out
    }
    for (const { segment, index } of graphemes.segment(text)) {
      const cps: number[] = []
      for (const c of this.char(segment)) cps.push(c.codePointAt(0)!)
      this.feed(out, st, cps, index, index + segment.length)
    }
    return out
  }

  /** 词条的比较形态；collapsed 表示词条自身含叠字（如「哈哈」），匹配时不应视为规避。 */
  key(word: string): { key: string; cps: number[]; collapsed: boolean } {
    const t = this.compact(word ?? '')
    const cps = Array.from(t.codes())
    let collapsed = false
    for (let i = 0; i < t.length; i++) if (t.repeated(i)) collapsed = true
    return { key: String.fromCodePoint(...cps), cps, collapsed }
  }

  /** dropSeparators 为 true 时去掉分隔字符，用于「w w w . x x . c o m」这类拆开写的特征。 */
  flat(text: string, dropSeparators = false): FlatText {
    const parts: string[] = []
    const srcIndex: number[] = []
    const srcEnd: number[] = []
    let identity = !dropSeparators
    for (let i = 0; i < text.length; ) {
      const cp = text.codePointAt(i)!
      const w = cp > 0xffff ? 2 : 1
      const m = this.mapCp(cp)
      let s = typeof m === 'number' ? String.fromCodePoint(m) : m
      if (dropSeparators) {
        let kept = ''
        for (const c of s) if (!this.isSeparator(c.codePointAt(0)!)) kept += c
        s = kept
      }
      if (s.length !== w) identity = false
      if (s) {
        parts.push(s)
        srcIndex.push(i)
        srcEnd.push(i + w)
      }
      i += w
    }
    const joined = parts.join('')
    if (identity) return { text: joined, start: null, end: null }
    const start: number[] = []
    const end: number[] = []
    parts.forEach((s, k) => {
      for (let u = 0; u < s.length; u++) {
        start.push(srcIndex[k])
        end.push(srcEnd[k])
      }
    })
    return { text: joined, start, end }
  }

  isSeparator(cp: number): boolean {
    if (cp >= 0x4e00 && cp <= 0x9fff) return false
    if (cp < 128) return !isAsciiCode(cp)
    let r = this.sepMemo.get(cp)
    if (r === undefined) {
      r = SEPARATOR.test(String.fromCodePoint(cp))
      if (this.sepMemo.size < MEMO_LIMIT) this.sepMemo.set(cp, r)
    }
    return r
  }

  private isInvisible(cp: number): boolean {
    if (cp < 32 || cp === 127) return true
    if (cp < 128 || (cp >= 0x4e00 && cp <= 0x9fff)) return false
    let r = this.invisibleMemo.get(cp)
    if (r === undefined) {
      r = INVISIBLE.test(String.fromCodePoint(cp))
      if (this.invisibleMemo.size < MEMO_LIMIT) this.invisibleMemo.set(cp, r)
    }
    return r
  }

  /** 处理一个字形归一化后的码点：全是不可见字符记为隐藏；全是分隔符记一个间隔；其余写入紧凑文本。 */
  private feed(out: CompactText, st: CompactState, cps: number[], index: number, end: number): void {
    let visible = false
    let invisibleOnly = true
    let hasHidden = false
    for (const c of cps) {
      if (this.isInvisible(c)) {
        hasHidden = true
        continue
      }
      invisibleOnly = false
      if (this.isSeparator(c)) continue
      visible = true
      const prev = out.length - 1
      if (this.collapseRepeat && prev >= 0 && out.cp[prev] === c && st.gap === 0 && !st.hidden) {
        out.markRepeated(prev, end)
        continue
      }
      out.push(c, index, end, st.gap, st.hidden)
      st.gap = 0
      st.hidden = false
    }
    if (invisibleOnly) {
      if (out.length) st.hidden = true
      return
    }
    if (!visible && out.length) st.gap++
    // 字形内附着在文字后的组合符/零宽连接符（如「赌̶博」）
    if (visible && hasHidden) st.hidden = true
  }
}

/** 小写字母或数字 */
export function isAsciiCode(cp: number): boolean {
  return (cp >= 48 && cp <= 57) || (cp >= 97 && cp <= 122)
}

export function isHanCode(cp: number): boolean {
  if (cp >= 0x4e00 && cp <= 0x9fff) return true
  if (cp < 0x2e80) return false
  return HAN.test(String.fromCodePoint(cp))
}

export function isHan(ch: string | undefined): boolean {
  return ch !== undefined && HAN.test(ch)
}

function addPairs(map: Map<string, string>, pairs: string): void {
  const cs = Array.from(pairs)
  if (cs.length % 2) throw new Error('字符映射表必须两两成对')
  for (let i = 0; i < cs.length; i += 2) {
    if (cs[i] !== cs[i + 1]) map.set(cs[i], cs[i + 1])
  }
}
