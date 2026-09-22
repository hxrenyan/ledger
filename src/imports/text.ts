/**
 * 源文件 → 二维表（string[][]）。
 *
 * - CSV / TSV：自己实现 RFC4180 风格解析（引号内逗号、引号内换行、双写引号转义、CRLF）
 * - JSON：数组对象、嵌套对象数组、数组的数组、NDJSON 都能收敛成表头 + 行
 *
 * 编码嗅探不在这里做：GBK 只能在浏览器里可靠解码（workerd 对 legacy 多字节编码有已知缺陷），
 * 前端解码成 UTF-8 文本后再送进来。
 */

import { getCell, stripBom } from './values.ts'

export const MAX_ROWS = 20000
export const MAX_COLS = 200

export type TableInput = {
  rows: string[][]
  delimiter?: string
  via: 'csv' | 'json'
}

export function textToTable(text: string): TableInput | null {
  const body = stripBom(text)
  const trimmed = body.trim()
  if (!trimmed) return null

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    const rows = jsonToRows(trimmed)
    if (rows && rows.length) return { rows: cap(rows), via: 'json' }
  }
  const { rows, delimiter } = parseDelimited(body)
  if (!rows.length) return null
  return { rows: cap(rows), delimiter, via: 'csv' }
}

function cap(rows: string[][]): string[][] {
  return rows.slice(0, MAX_ROWS).map((r) => r.slice(0, MAX_COLS))
}

export function parseDelimited(text: string, delimiter?: string): { rows: string[][]; delimiter: string } {
  const input = stripBom(text).replace(/^\uFEFF/, '')
  const delim = delimiter ?? guessDelimiter(input)
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false

  for (let i = 0; i < input.length; i++) {
    const ch = input[i]
    if (quoted) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"'
          i++
        } else {
          quoted = false
        }
      } else {
        field += ch
      }
      continue
    }
    if (ch === '"') {
      quoted = true
    } else if (ch === delim) {
      row.push(field)
      field = ''
    } else if (ch === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else if (ch !== '\r') {
      field += ch
    }
  }
  if (field !== '' || row.length) {
    row.push(field)
    rows.push(row)
  }
  return { rows, delimiter: delim }
}

/** 取前若干行中「引号外出现次数最多且稳定」的候选分隔符。 */
export function guessDelimiter(text: string): string {
  const candidates = ['\t', ',', ';', '|']
  const lines = text.split(/\r?\n/).filter((l) => l.trim()).slice(0, 10)
  let best = ','
  let bestScore = -1
  for (const c of candidates) {
    let max = 0
    for (const line of lines) {
      const n = countOutsideQuotes(line, c)
      if (n > max) max = n
    }
    // 同分时保留候选顺序（制表符优先）
    if (max > bestScore) {
      bestScore = max
      best = c
    }
  }
  return best
}

function countOutsideQuotes(line: string, ch: string): number {
  let n = 0
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (c === '"') quoted = !quoted
    else if (!quoted && c === ch) n++
  }
  return n
}

/** 逗号 / 制表符 / 分号 / 竖线 都当分隔符处理（自动嗅探）。 */
export function looksLikeDelimited(text: string): boolean {
  return text.includes(',') || text.includes('\t') || text.includes(';') || text.includes('|')
}

export function jsonToRows(text: string): string[][] | null {
  const parsed = tryParseJson(text)
  if (parsed === undefined) return null
  return normalizeJson(parsed)
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    /* 继续尝试 NDJSON */
  }
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  if (lines.length < 1) return undefined
  const items: unknown[] = []
  for (const line of lines) {
    if (!line.startsWith('{') && !line.startsWith('[')) return undefined
    try {
      items.push(JSON.parse(line))
    } catch {
      return undefined
    }
  }
  return items.length ? items : undefined
}

function normalizeJson(root: unknown): string[][] | null {
  if (Array.isArray(root) && root.length && root.every((r) => Array.isArray(r))) {
    return (root as unknown[][]).map((r) => r.map(cellValue))
  }
  const arr = findBestArray(root)
  if (!arr || !arr.length) return null
  if (arr.every((x) => Array.isArray(x))) {
    return (arr as unknown[][]).map((r) => r.map(cellValue))
  }
  const objs = arr
    .filter((x) => x && typeof x === 'object' && !Array.isArray(x))
    .map((x) => flatten(x as Record<string, unknown>))
  if (!objs.length) return null
  const keys = collectKeys(objs)
  if (!keys.length) return null
  return [keys, ...objs.map((o) => keys.map((k) => cellValue(o[k])))]
}

/** 广度优先找「最长的对象数组」，兼容 {data:{list:[...]}} 这类包一层的外壳。 */
function findBestArray(root: unknown): unknown[] | null {
  const queue: unknown[] = [root]
  let best: unknown[] | null = null
  let guard = 0
  while (queue.length && guard++ < 500) {
    const node = queue.shift()
    if (Array.isArray(node)) {
      const objs = node.filter((x) => x && typeof x === 'object').length
      if (node.length && objs >= node.length * 0.5 && (!best || node.length > best.length)) {
        best = node
      }
      for (const el of node.slice(0, 10)) {
        if (el && typeof el === 'object') queue.push(el)
      }
    } else if (node && typeof node === 'object' && !(node instanceof Date)) {
      for (const v of Object.values(node as Record<string, unknown>)) queue.push(v)
    }
  }
  return best
}

function collectKeys(objs: Record<string, unknown>[]): string[] {
  const keys: string[] = []
  const seen = new Set<string>()
  for (const o of objs.slice(0, 200)) {
    for (const k of Object.keys(o)) {
      if (!seen.has(k)) {
        seen.add(k)
        keys.push(k)
      }
    }
  }
  return keys
}

function flatten(o: Record<string, unknown>, prefix = '', depth = 0, out: Record<string, unknown> = {}): Record<string, unknown> {
  for (const [k, v] of Object.entries(o)) {
    const key = prefix ? `${prefix}.${k}` : k
    if (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date) && depth < 1) {
      flatten(v as Record<string, unknown>, key, depth + 1, out)
    } else {
      out[key] = v
    }
  }
  return out
}

function cellValue(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : ''
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  if (Array.isArray(v)) {
    return v.map(cellValue).filter(Boolean).join(' / ').slice(0, 200)
  }
  return JSON.stringify(v).slice(0, 200)
}

export { getCell }
