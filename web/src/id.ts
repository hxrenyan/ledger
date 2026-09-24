/** 把接口、路径参数、localStorage 里的主键收成正整数。空值返回 null。 */
export function toId(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0 && Number.isSafeInteger(value)) return value
  if (typeof value === 'string' && /^[1-9]\d*$/.test(value)) {
    const n = Number(value)
    if (Number.isSafeInteger(n) && n > 0) return n
  }
  return null
}
