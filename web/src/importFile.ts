/**
 * 导入文件的读取：编码嗅探 + Excel 解析。
 *
 * 为什么解码放在浏览器：
 * 微信/支付宝导出的账单是 GBK，而 workerd 对 legacy 多字节编码（GBK/Big5）有已知缺陷，
 * 浏览器 TextDecoder 则是可靠的。所以 CSV/JSON 在本地解码成 UTF-8 文本再上传，
 * Excel 由 SheetJS 解析成二维表上传 —— 原始文件不出浏览器。
 */

export type ReadResult =
  | { kind: 'rows'; filename: string; rows: string[][]; sheet: string; sheets: string[] }
  | { kind: 'text'; filename: string; text: string; encoding: string }

const EXCEL_EXT = new Set(['xlsx', 'xls', 'xlsm', 'xlsb'])

export function fileExt(name: string): string {
  const i = name.lastIndexOf('.')
  return i >= 0 ? name.slice(i + 1).toLowerCase() : ''
}

export async function readImportFile(file: File, sheet?: string): Promise<ReadResult> {
  const ext = fileExt(file.name)
  if (EXCEL_EXT.has(ext)) {
    return readExcel(file, sheet)
  }
  const { text, encoding } = decodeBytes(new Uint8Array(await file.arrayBuffer()))
  return { kind: 'text', filename: file.name, text, encoding }
}

async function readExcel(file: File, sheet?: string): Promise<ReadResult> {
  // SheetJS 只在打开导入页时才加载（动态 import 会单独切 chunk）
  const XLSX = await import('xlsx')
  const buf = await file.arrayBuffer()
  const wb = XLSX.read(buf, { type: 'array' })
  const sheets = wb.SheetNames
  if (!sheets.length) throw new Error('工作簿里没有工作表')
  const target = sheet && sheets.includes(sheet) ? sheet : sheets[0]
  const ws = wb.Sheets[target]
  if (!ws) throw new Error(`找不到工作表 ${target}`)
  const raw = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: false, defval: '', blankrows: true })
  const rows = raw.map((row) => (Array.isArray(row) ? row.map((cell) => (cell === null || cell === undefined ? '' : String(cell))) : []))
  return { kind: 'rows', filename: file.name, rows, sheet: target, sheets }
}

/** BOM → 严格 UTF-8 试解 → 回退 GBK。 */
export function decodeBytes(bytes: Uint8Array): { text: string; encoding: string } {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { text: new TextDecoder('utf-8').decode(bytes.subarray(3)), encoding: 'utf-8 (BOM)' }
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { text: new TextDecoder('utf-16le').decode(bytes.subarray(2)), encoding: 'utf-16le' }
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return { text: new TextDecoder('utf-16be').decode(bytes.subarray(2)), encoding: 'utf-16be' }
  }
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: 'utf-8' }
  } catch {
    // 非法 UTF-8 序列：按 GBK 解（微信/支付宝账单常见）
    try {
      return { text: new TextDecoder('gbk').decode(bytes), encoding: 'gbk' }
    } catch {
      return { text: new TextDecoder('utf-8').decode(bytes), encoding: 'utf-8（回退）' }
    }
  }
}
