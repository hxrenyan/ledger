/**
 * 日历语音：从一句口语里拆出日期和事情。
 *
 * 只认阳历。没说日期就落在上海当天；说了相对日、星期、几月几号，就落到对应那一天。
 * 事情是去掉日期后剩下的正文。一句里可以有多件，按日期切开。
 */

import { addDays, shanghaiDate } from '../time.ts'

const BODY_MAX = 200

export type SpokenNote = {
  day: string
  body: string
  /** 正文超过 200 字，已按字符截断。 */
  clipped: boolean
}

type Span = {
  index: number
  length: number
  /** 认不出合法阳历时留空，只用来挡住更短的误匹配，不单独成一条。 */
  day: string | null
}

const CN_DIGIT: Record<string, number> = {
  零: 0,
  〇: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
}

const WEEKDAY: Record<string, number> = {
  日: 0,
  天: 0,
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
}

const NUM = '(?:\\d{1,2}|[零〇一二两三四五六七八九十廿]{1,3})'
const WEEK_PREFIX =
  '上上个星期|上上星期|上上周|上上礼拜|下下个星期|下下星期|下下周|下下礼拜|上个星期|上星期|上周|上礼拜|下个星期|下星期|下周|下礼拜|这个星期|这星期|这周|本星期|本周|这个礼拜|这礼拜|本礼拜'

/** 句首口头语。长的放前面，避免「帮我记」先吃掉「帮我记一下」。 */
const FILLER = /^(?:帮我记住|帮我记一下|提醒我一下|帮我记|提醒我|记一下|记得|帮我)+/
/** 两件事情之间的连接词。只从日期切出来的片段上去掉，避免把「还有事」收成「事」。 */
const CONNECTOR = /^(?:然后|还要|还有|另外|以及|一下)+/
const TRAILING = /(?:然后|还要|还有|另外|以及|和)+$/

export function parseSpokenNotes(text: string, now = Date.now()): SpokenNote[] {
  const raw = toHalfWidth(text).replace(/\s+/g, '').trim()
  if (!raw) return []
  const today = shanghaiDate(now)
  const hits = findHits(raw, today).filter((hit) => hit.day)
  if (!hits.length) {
    const body = cleanBody(raw, 'plain')
    if (!body) return []
    return [clip(today, body)]
  }

  const items: SpokenNote[] = []
  const head = cleanBody(raw.slice(0, hits[0].index), 'event')
  if (head) items.push(clip(today, head))
  for (let i = 0; i < hits.length; i++) {
    const start = hits[i].index + hits[i].length
    const end = i + 1 < hits.length ? hits[i + 1].index : raw.length
    const body = cleanBody(raw.slice(start, end), 'event')
    if (!body) continue
    items.push(clip(hits[i].day as string, body))
  }
  if (items.length) return items.slice(0, 20)
  return [{ day: hits[0].day as string, body: '', clipped: false }]
}

function clip(day: string, body: string): SpokenNote {
  const chars = [...body]
  if (chars.length <= BODY_MAX) return { day, body, clipped: false }
  return { day, body: chars.slice(0, BODY_MAX).join(''), clipped: true }
}

function findHits(text: string, today: string): Span[] {
  const found: Span[] = []
  const push = (re: RegExp, day: (match: RegExpExecArray) => string | null) => {
    const pattern = new RegExp(re.source, 'g')
    let match: RegExpExecArray | null
    while ((match = pattern.exec(text))) {
      found.push({ index: match.index, length: match[0].length, day: day(match) })
    }
  }

  push(new RegExp(`(\\d{4})年(${NUM})月(${NUM})[日号]`), (match) => {
    if (lunarBefore(text, match.index)) return null
    const year = Number(match[1])
    const month = readNumber(match[2] ?? '', 12)
    const day = readNumber(match[3] ?? '', 31)
    if (month == null || day == null) return null
    return ymd(year, month, day)
  })
  push(new RegExp(`(下下个?月|下个?月|这个?月|本月)(${NUM})[日号]`), (match) => {
    if (lunarBefore(text, match.index)) return null
    const day = readNumber(match[2] ?? '', 31)
    if (day == null) return null
    const word = match[1] ?? ''
    const delta = word.startsWith('下下') ? 2 : word.startsWith('下') ? 1 : 0
    return shiftMonth(today, delta, day)
  })
  push(new RegExp(`(${NUM})月(${NUM})[日号]`), (match) => {
    if (lunarBefore(text, match.index)) return null
    const month = readNumber(match[1] ?? '', 12)
    const day = readNumber(match[2] ?? '', 31)
    if (month == null || day == null) return null
    return upcomingMonthDay(today, month, day)
  })
  push(/大后天|大前天|后天|前天|明天|昨日|昨天|今天|今日|明日/g, (match) => {
    const delta: Record<string, number> = {
      大后天: 3,
      后天: 2,
      明天: 1,
      明日: 1,
      今天: 0,
      今日: 0,
      昨天: -1,
      昨日: -1,
      前天: -2,
      大前天: -3,
    }
    return addDays(today, delta[match[0]] ?? 0)
  })
  push(new RegExp(`(${WEEK_PREFIX})([一二三四五六日天])`, 'g'), (match) => {
    const name = match[2] ?? ''
    const weekday = WEEKDAY[name]
    if (weekday == null) return null
    return weekdayOn(today, weekShift(match[1] ?? ''), weekday)
  })
  push(/(?<![上下这本个])(?:星期|礼拜|周)([一二三四五六日天])/g, (match) => {
    const weekday = WEEKDAY[match[1] ?? '']
    if (weekday == null) return null
    return weekdayOn(today, 'upcoming', weekday)
  })
  push(/上上周末|下下周末|上周末|下周末|这周末|本周末|周末/g, (match) => weekendOn(today, match[0]))
  push(/下下个月底|下个月底|这个月底|本月底|月底|下下个月初|下个月初|这个月初|本月初|月初/g, (match) => {
    const word = match[0]
    const delta = word.startsWith('下下') ? 2 : word.startsWith('下') ? 1 : 0
    if (word.endsWith('初')) {
      if (delta === 0) {
        const first = shiftMonth(today, 0, 1)
        if (first && first >= today) return first
        return shiftMonth(today, 1, 1)
      }
      return shiftMonth(today, delta, 1)
    }
    return monthEnd(today, delta)
  })
  push(new RegExp(`(?<![月\\d年月日])(${NUM})[日号]`, 'g'), (match) => {
    const day = readNumber(match[1] ?? '', 31)
    if (day == null) return null
    return upcomingDay(today, day)
  })

  const kept: Span[] = []
  let cursor = 0
  while (cursor < text.length) {
    const next = found.filter((span) => span.index >= cursor)
    if (!next.length) break
    const start = Math.min(...next.map((span) => span.index))
    const best = next
      .filter((span) => span.index === start)
      .sort((a, b) => b.length - a.length)[0]
    if (!best) break
    if (best.day) kept.push(best)
    cursor = best.index + best.length
  }
  return kept
}

function lunarBefore(text: string, index: number): boolean {
  return /农历|阴历/.test(text.slice(Math.max(0, index - 4), index))
}

function cleanBody(raw: string, mode: 'event' | 'plain'): string {
  let text = raw.trim()
  let prev = ''
  while (text && text !== prev) {
    prev = text
    text = text.replace(FILLER, '')
    if (mode === 'event') text = text.replace(CONNECTOR, '').replace(TRAILING, '')
    text = text.replace(/^[，,。；;、\s]+/, '').replace(/[，,。；;、\s]+$/, '').trim()
  }
  return text
}

function readNumber(raw: string, max: number): number | null {
  const value = parseCnNumber(raw)
  if (value == null || value < 1 || value > max) return null
  return value
}

function parseCnNumber(raw: string): number | null {
  if (/^\d{1,4}$/.test(raw)) return Number(raw)
  let text = raw
  if (text.startsWith('廿')) text = `二十${text.slice(1)}`
  if (text === '十') return 10
  const ten = text.indexOf('十')
  if (ten >= 0) {
    const high = ten === 0 ? 1 : CN_DIGIT[text[ten - 1] ?? '']
    const lowChar = text[ten + 1]
    const low = lowChar ? CN_DIGIT[lowChar] : 0
    if (high == null || low == null || text.length > ten + 2) return null
    return high * 10 + low
  }
  if (text.length === 1) return CN_DIGIT[text] ?? null
  return null
}

function ymd(year: number, month: number, day: number): string | null {
  if (year < 1900 || year > 2200 || month < 1 || month > 12 || day < 1) return null
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate()
  if (day > last) return null
  return `${year}-${pad(month)}-${pad(day)}`
}

function upcomingMonthDay(today: string, month: number, day: number): string | null {
  const year = Number(today.slice(0, 4))
  const current = ymd(year, month, day)
  if (current && current >= today) return current
  return ymd(year + 1, month, day)
}

function upcomingDay(today: string, day: number): string | null {
  const [year, month] = today.split('-').map(Number)
  const current = ymd(year ?? 0, month ?? 1, day)
  if (current && current >= today) return current
  const nextMonth = (month ?? 1) === 12 ? 1 : (month ?? 1) + 1
  const nextYear = (month ?? 1) === 12 ? (year ?? 0) + 1 : year ?? 0
  return ymd(nextYear, nextMonth, day)
}

function shiftMonth(today: string, delta: number, day: number): string | null {
  const [year, month] = today.split('-').map(Number)
  const date = new Date(Date.UTC(year ?? 0, (month ?? 1) - 1 + delta, 1))
  return ymd(date.getUTCFullYear(), date.getUTCMonth() + 1, day)
}

function monthEnd(today: string, delta: number): string | null {
  const [year, month] = today.split('-').map(Number)
  const date = new Date(Date.UTC(year ?? 0, (month ?? 1) + delta, 0))
  return ymd(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate())
}

function weekShift(prefix: string): 'last2' | 'last' | 'next2' | 'next' | 'this' {
  if (prefix.startsWith('上上')) return 'last2'
  if (prefix.startsWith('下下')) return 'next2'
  if (prefix.startsWith('上')) return 'last'
  if (prefix.startsWith('下')) return 'next'
  return 'this'
}

function weekdayOn(today: string, which: 'last2' | 'last' | 'next2' | 'next' | 'this' | 'upcoming', weekday: number): string {
  const monday = mondayOf(today)
  const offset = weekday === 0 ? 6 : weekday - 1
  const thisWeek = addDays(monday, offset)
  if (which === 'last2') return addDays(thisWeek, -14)
  if (which === 'last') return addDays(thisWeek, -7)
  if (which === 'next2') return addDays(thisWeek, 14)
  if (which === 'next') return addDays(thisWeek, 7)
  if (which === 'this') return thisWeek
  return thisWeek >= today ? thisWeek : addDays(thisWeek, 7)
}

function weekendOn(today: string, word: string): string {
  const monday = mondayOf(today)
  const saturday = addDays(monday, 5)
  if (word.startsWith('上上')) return addDays(saturday, -14)
  if (word.startsWith('下下')) return addDays(saturday, 14)
  if (word.startsWith('上')) return addDays(saturday, -7)
  if (word.startsWith('下')) return addDays(saturday, 7)
  if (word === '周末') {
    const weekday = weekdayOf(today)
    if (weekday === 0 || weekday === 6) return today
    return saturday
  }
  if (weekdayOf(today) === 0) return today
  return saturday
}

function mondayOf(day: string): string {
  const weekday = weekdayOf(day)
  return addDays(day, weekday === 0 ? -6 : 1 - weekday)
}

function weekdayOf(day: string): number {
  const [year, month, date] = day.split('-').map(Number)
  return new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, date ?? 1)).getUTCDay()
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

function toHalfWidth(text: string): string {
  return text.replace(/[\uFF10-\uFF19]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xff10 + 0x30))
}
