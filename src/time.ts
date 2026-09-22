/** 上海无夏令时，按 UTC+8 切月份。 */

const SH_OFFSET = 8 * 3600 * 1000

export function shanghaiDate(ms = Date.now()): string {
  return new Date(ms + SH_OFFSET).toISOString().slice(0, 10)
}

export function shanghaiMonth(ms = Date.now()): string {
  return shanghaiDate(ms).slice(0, 7)
}

/** YYYY-MM-DD → 当天上海正午，避免落在日界附近。 */
export function dateToOccurredAt(dateStr: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) throw new Error('日期格式应为 YYYY-MM-DD')
  const [y, m, d] = dateStr.split('-').map(Number)
  return Date.UTC(y, m - 1, d, 4, 0, 0, 0)
}

export function occurredAtToDate(ms: number): string {
  return shanghaiDate(ms)
}

/** 返回 [start, end) 的 UTC 毫秒，月份按上海日历。 */
export function shanghaiMonthRange(month: string): { start: number; end: number } {
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error('月份格式应为 YYYY-MM')
  const [y, m] = month.split('-').map(Number)
  const start = Date.UTC(y, m - 1, 1) - SH_OFFSET
  const end = Date.UTC(y, m, 1) - SH_OFFSET
  return { start, end }
}

export function addDays(dateStr: string, delta: number): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) throw new Error('日期格式应为 YYYY-MM-DD')
  const [y, m, d] = dateStr.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d + delta))
  const yy = dt.getUTCFullYear()
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(dt.getUTCDate()).padStart(2, '0')
  return `${yy}-${mm}-${dd}`
}

export function addMonth(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number)
  const d = new Date(Date.UTC(y, m - 1 + delta, 1))
  const yy = d.getUTCFullYear()
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0')
  return `${yy}-${mm}`
}

export function shanghaiDayRange(dateStr: string): { start: number; end: number } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) throw new Error('日期格式应为 YYYY-MM-DD')
  const [y, m, d] = dateStr.split('-').map(Number)
  const start = Date.UTC(y, m - 1, d) - SH_OFFSET
  const end = Date.UTC(y, m - 1, d + 1) - SH_OFFSET
  return { start, end }
}

export function shanghaiYearRange(year: number): { start: number; end: number } {
  return { start: Date.UTC(year, 0, 1) - SH_OFFSET, end: Date.UTC(year + 1, 0, 1) - SH_OFFSET }
}

export function daysInShanghaiMonth(month: string): number {
  const [y, m] = month.split('-').map(Number)
  return new Date(Date.UTC(y, m, 0)).getUTCDate()
}

export function nextMonthSameDay(occurredAt: number): number {
  const date = occurredAtToDate(occurredAt)
  const [y, m, d] = date.split('-').map(Number)
  const nm = m === 12 ? 1 : m + 1
  const ny = m === 12 ? y + 1 : y
  const dim = new Date(Date.UTC(ny, nm, 0)).getUTCDate()
  const day = Math.min(d, dim)
  return dateToOccurredAt(`${ny}-${String(nm).padStart(2, '0')}-${String(day).padStart(2, '0')}`)
}
