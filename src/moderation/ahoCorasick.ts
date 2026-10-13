/**
 * Aho-Corasick 多模式匹配，输入为整数符号序列（码点或拼音编号），返回全部（含重叠）命中。
 *
 * 构建期用 Map 字典树；build() 后压缩为 CSR 数组：每个节点的子边按符号排序、二分查找，
 * 根节点额外用直接寻址表加速。输出用「本节点模式链表 + 字典后缀链接」，不复制输出集合。
 * 10 万词条约为 Map 实现内存的 1/5。
 */

export type AcMatch<T> = { start: number; end: number; value: T }

const ROOT_TABLE_LIMIT = 0x10000

export class AhoCorasick<T> {
  private trie: Map<number, number>[] | null = [new Map()]
  private readonly values: T[] = []
  private readonly lens: number[] = []
  private readonly nodeOf: number[] = []

  private edgeStart = new Int32Array(2)
  private edgeSym = new Int32Array(0)
  private edgeTo = new Int32Array(0)
  private rootTable = new Int32Array(0)
  private fail = new Int32Array(1)
  private outHead = new Int32Array(1).fill(-1)
  private dictLink = new Int32Array(1).fill(-1)
  private patNext = new Int32Array(0)
  private patLen = new Int32Array(0)

  add(syms: ArrayLike<number>, value: T): void {
    const trie = this.trie
    if (!trie) throw new Error('自动机已构建，不能再添加模式')
    if (!syms.length) return
    let s = 0
    for (let i = 0; i < syms.length; i++) {
      const c = syms[i]
      let t = trie[s].get(c)
      if (t === undefined) {
        t = trie.length
        trie.push(new Map())
        trie[s].set(c, t)
      }
      s = t
    }
    this.values.push(value)
    this.lens.push(syms.length)
    this.nodeOf.push(s)
  }

  get size(): number {
    return this.values.length
  }

  build(): this {
    const trie = this.trie
    if (!trie) return this
    const n = trie.length

    this.edgeStart = new Int32Array(n + 1)
    let edges = 0
    for (let s = 0; s < n; s++) {
      this.edgeStart[s] = edges
      edges += trie[s].size
    }
    this.edgeStart[n] = edges
    this.edgeSym = new Int32Array(edges)
    this.edgeTo = new Int32Array(edges)
    for (let s = 0; s < n; s++) {
      const kids = [...trie[s].entries()].sort((a, b) => a[0] - b[0])
      let e = this.edgeStart[s]
      for (const [c, t] of kids) {
        this.edgeSym[e] = c
        this.edgeTo[e++] = t
      }
    }

    let maxRoot = -1
    for (const c of trie[0].keys()) if (c < ROOT_TABLE_LIMIT && c > maxRoot) maxRoot = c
    this.rootTable = new Int32Array(maxRoot + 1)
    for (const [c, t] of trie[0]) if (c < ROOT_TABLE_LIMIT) this.rootTable[c] = t
    this.trie = null

    const p = this.values.length
    this.outHead = new Int32Array(n).fill(-1)
    this.patNext = new Int32Array(p)
    this.patLen = Int32Array.from(this.lens)
    for (let i = 0; i < p; i++) {
      const node = this.nodeOf[i]
      this.patNext[i] = this.outHead[node]
      this.outHead[node] = i
    }
    this.lens.length = 0
    this.nodeOf.length = 0

    this.fail = new Int32Array(n)
    this.dictLink = new Int32Array(n).fill(-1)
    const queue = new Int32Array(n)
    let tail = 0
    for (let e = this.edgeStart[0]; e < this.edgeStart[1]; e++) queue[tail++] = this.edgeTo[e]
    for (let head = 0; head < tail; head++) {
      const r = queue[head]
      for (let e = this.edgeStart[r]; e < this.edgeStart[r + 1]; e++) {
        const s = this.edgeTo[e]
        const c = this.edgeSym[e]
        queue[tail++] = s
        if (r === 0) continue
        let f = this.fail[r]
        let t = this.child(f, c)
        while (t < 0 && f) {
          f = this.fail[f]
          t = this.child(f, c)
        }
        const fs = t > 0 && t !== s ? t : 0
        this.fail[s] = fs
        this.dictLink[s] = this.outHead[fs] >= 0 ? fs : this.dictLink[fs]
      }
    }
    return this
  }

  search(syms: ArrayLike<number>): AcMatch<T>[] {
    if (this.trie) this.build()
    const res: AcMatch<T>[] = []
    if (!this.values.length) return res
    let s = 0
    for (let i = 0; i < syms.length; i++) {
      const c = syms[i]
      let t = this.child(s, c)
      while (t < 0 && s) {
        s = this.fail[s]
        t = this.child(s, c)
      }
      s = t < 0 ? 0 : t
      for (let node = this.outHead[s] >= 0 ? s : this.dictLink[s]; node >= 0; node = this.dictLink[node]) {
        for (let k = this.outHead[node]; k >= 0; k = this.patNext[k]) {
          res.push({ start: i - this.patLen[k] + 1, end: i, value: this.values[k] })
        }
      }
    }
    return res
  }

  /** 子节点编号，不存在返回 -1 */
  private child(s: number, c: number): number {
    if (c < 0) return -1
    if (s === 0 && c < ROOT_TABLE_LIMIT) return c < this.rootTable.length ? this.rootTable[c] || -1 : -1
    let lo = this.edgeStart[s]
    let hi = this.edgeStart[s + 1] - 1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      const v = this.edgeSym[mid]
      if (v === c) return this.edgeTo[mid]
      if (v < c) lo = mid + 1
      else hi = mid - 1
    }
    return -1
  }
}
