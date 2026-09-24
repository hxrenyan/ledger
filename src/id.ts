/** 业务表自增主键。JWT、请求头和路径参数里是十进制字符串，库和 JSON 里是 number。 */

export type Id = number

export function parseId(value: unknown): Id | null {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0 && Number.isSafeInteger(value)) {
    return value
  }
  if (typeof value === 'string' && /^[1-9]\d*$/.test(value)) {
    const n = Number(value)
    if (Number.isSafeInteger(n) && n > 0) return n
  }
  return null
}

/** 路径参数 / 必填 id。形状不对抛「无效」，由 HTTP 层收成 400。 */
export function routeId(value: unknown, label = '编号'): Id {
  const id = parseId(value)
  if (id == null) throw new Error(`${label}无效`)
  return id
}

/** 空、0、null 表示没有；其余必须是正整数。 */
export function parseOptionalId(value: unknown, label: string): Id | null {
  if (value == null || value === '' || value === 0) return null
  const id = parseId(value)
  if (id == null) throw new Error(`${label}无效`)
  return id
}
