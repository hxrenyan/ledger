/**
 * 人情往来识别。
 *
 * 随礼 / 礼金 / 份子 / 压岁钱不是普通分类，要落到 gifts。
 * 账单行和自然语言共用这一套判断：认得出对方姓名才算，避免把「美团红包」当成人情。
 */

import { parseAmountCents } from './values.ts'
import { shanghaiDate } from '../time.ts'

export type FavorKind = 'give' | 'receive'

export type FavorHit = {
  contactName: string
  giftKind: FavorKind
  occasion: string
}

const GIFT_MARK = /随礼|随份子|份子钱|份子|礼金|人情|随了|压岁钱|压岁/
const NOT_PERSON = /微信|支付宝|美团|饿了么|京东|淘宝|拼多多|银行|转账|商户|收款|付款|红包|余额|零钱/
const OCCASIONS: { re: RegExp; name: string }[] = [
  { re: /结婚|婚礼/, name: '结婚' },
  { re: /满月/, name: '满月' },
  { re: /乔迁|搬家/, name: '搬家' },
  { re: /寿宴|做寿|寿辰/, name: '寿宴' },
  { re: /升学/, name: '升学' },
  { re: /丧事|白事|吊唁/, name: '丧事' },
  { re: /过年|压岁/, name: '过年' },
  { re: /生日/, name: '生日' },
]

export function isPersonName(name: string): boolean {
  return /^[\u4e00-\u9fa5]{2,4}$/.test(name) && !NOT_PERSON.test(name)
}

export function detectFavor(text: string, direction: 'expense' | 'income' | 'skip' = 'expense'): FavorHit | null {
  const raw = text.replace(/\s+/g, '')
  if (!raw) return null
  const person = extractPerson(raw)
  const marked = GIFT_MARK.test(raw) || (OCCASIONS.some((o) => o.re.test(raw)) && /给|送|收|随/.test(raw))
  const redPacket = /红包/.test(raw) && !!person
  if (!marked && !redPacket) return null
  if (!person) return null

  let giftKind: FavorKind = direction === 'income' ? 'receive' : 'give'
  if (/收到|收了|来自|收入/.test(raw)) giftKind = 'receive'
  else if (/送给|给|随了|随礼|支出|支付/.test(raw)) giftKind = 'give'

  return {
    contactName: person,
    giftKind,
    occasion: OCCASIONS.find((o) => o.re.test(raw))?.name ?? '',
  }
}

function extractPerson(raw: string): string {
  const patterns = [
    /(?:送给|给|收到|收了|来自)([\u4e00-\u9fa5]{2,6})/,
    /([\u4e00-\u9fa5]{2,6})(?:的)?(?:随礼|随了|随份子|礼金|份子)/,
  ]
  for (const re of patterns) {
    const name = cleanName(raw.match(re)?.[1] ?? '')
    if (isPersonName(name)) return name
  }
  return ''
}

function cleanName(name: string): string {
  let out = name
  for (const occasion of OCCASIONS) out = out.replace(occasion.re, '')
  return out.replace(/随礼|随份子|份子钱|份子|礼金|人情|随了|压岁钱|压岁|红包/g, '')
}

export function extractAmountCents(text: string): number | null {
  const matched = text.match(/(\d{1,3}(?:,\d{3})+|\d+)(\.\d{1,2})?\s*(?:元|块|圆)?/)
  if (!matched) return null
  const cents = parseAmountCents(`${matched[1]}${matched[2] ?? ''}`)
  if (cents === null || cents <= 0) return null
  return cents
}

/** 今天 / 昨天 / 前天 / 明确日期。没有就用上海当天。 */
export function extractDateYmd(text: string, now = Date.now()): string {
  const ymd = text.match(/(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})/)
  if (ymd) {
    const y = ymd[1]
    const m = ymd[2].padStart(2, '0')
    const d = ymd[3].padStart(2, '0')
    return `${y}-${m}-${d}`
  }
  if (text.includes('前天')) return shanghaiDate(now - 2 * 86400000)
  if (text.includes('昨天')) return shanghaiDate(now - 86400000)
  return shanghaiDate(now)
}

export type Utterance =
  | {
      kind: 'entry'
      raw: string
      date: string
      amountCents: number
      direction: 'expense' | 'income'
      note: string
      favor: FavorHit | null
    }
  | { kind: 'skip'; raw: string; reason: string }

/** 按句拆开。一句一笔，认不出金额的留下原因。 */
export function parseUtterances(text: string, now = Date.now()): Utterance[] {
  const parts = text
    .split(/[\n。；;]+/)
    .map((s) => s.trim())
    .filter(Boolean)
  return parts.map((raw) => parseOne(raw, now))
}

function parseOne(raw: string, now: number): Utterance {
  const compact = raw.replace(/\s+/g, '')
  const favor = detectFavor(raw)
  if (GIFT_MARK.test(compact) && !favor) return { kind: 'skip', raw, reason: '像人情往来，但没认出对方姓名' }
  const amountCents = extractAmountCents(raw)
  if (!amountCents) return { kind: 'skip', raw, reason: '没认出金额' }
  const direction: 'expense' | 'income' = favor
    ? favor.giftKind === 'receive'
      ? 'income'
      : 'expense'
    : /收到|收入|工资|退款|报销/.test(raw)
      ? 'income'
      : 'expense'
  const note = raw.replace(/\s+/g, ' ').slice(0, 80)
  return { kind: 'entry', raw, date: extractDateYmd(raw, now), amountCents, direction, note, favor }
}
