import { yuanExprToCents } from '@server/money.ts'

export function formatYuan(cents: number): string {
  const sign = cents < 0 ? '-' : ''
  const abs = Math.abs(Math.trunc(cents))
  const y = Math.floor(abs / 100)
  const f = String(abs % 100).padStart(2, '0')
  return `${sign}${y}.${f}`
}

export function yuanInputToCents(raw: string): number | null {
  return yuanExprToCents(raw)
}
