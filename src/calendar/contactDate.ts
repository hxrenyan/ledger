import { Lunar, Solar } from 'lunar-javascript'
import { shanghaiDate } from '../time.ts'

/** 人情页「即将到来」看未来这么多天。已经过去的不设窗口，按过了几天排在后面。 */
export const UPCOMING_DAYS = 30

/** 日子名称自己写，和事由一样最多 16 字。下面四个是改自定义之前存过的代码。 */
export const DATE_KIND_MAX = 16

const LEGACY_KIND: Record<string, string> = {
  birthday: '生日',
  anniversary: '纪念日',
  memorial: '忌日',
  fullmoon: '满月',
}

export function normalizeDateKind(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  const text = raw.trim()
  if (!text) return ''
  return LEGACY_KIND[text] ?? text
}

export function parseDateKind(raw: unknown): string {
  const kind = normalizeDateKind(raw)
  if (!kind || kind.length > DATE_KIND_MAX) throw new Error('日子名称须为 1–16 字')
  return kind
}

export function dateKindLabel(kind: string): string {
  return normalizeDateKind(kind)
}
export type CalendarKind = 'solar' | 'lunar'

export type ContactDate = {
  /** 自己写的名称，例如生日、纪念日、乔迁。 */
  kind: string
  calendar: CalendarKind
  month: number
  day: number
  /** 阳历年或农历年。空着不算年龄。 */
  year: number | null
  /** 农历闰月。阳历恒为 false。 */
  leap: boolean
}

export type Ymd = { y: number; m: number; d: number }

export type Reminder = {
  state: 'upcoming' | 'past'
  days: number
  text: string
  /** 有年份才有。名称是「生日」用「岁」，其余用「年」。 */
  age_text: string
}

const LUNAR_MONTHS = ['', '正月', '二月', '三月', '四月', '五月', '六月', '七月', '八月', '九月', '十月', '冬月', '腊月']
const SOLAR_MAX_DAY = [0, 31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

export function todayYmd(now = Date.now()): Ymd {
  const [y, m, d] = shanghaiDate(now).split('-').map(Number)
  return { y: y ?? 0, m: m ?? 0, d: d ?? 0 }
}

export function dateLabel(date: ContactDate): string {
  const year = date.year ? `${date.year}年` : ''
  if (date.calendar === 'solar') return `阳历 ${year}${date.month}月${date.day}日`
  const month = (date.leap ? '闰' : '') + (LUNAR_MONTHS[date.month] ?? '')
  return `农历 ${year}${month}${lunarDayText(date.day)}`
}

/** 校验并收成可入库的日子。不合法时抛出带「无效」或「须为」的错误，由接口转成 400。 */
export function parseContactDate(raw: unknown, today: Ymd): ContactDate {
  if (!raw || typeof raw !== 'object') throw new Error('日期无效')
  const body = raw as Record<string, unknown>
  const kind = parseDateKind(body.kind)
  const calendar = body.calendar
  if (calendar !== 'solar' && calendar !== 'lunar') throw new Error('历法须为阳历或农历')
  const month = readInt(body.month)
  const day = readInt(body.day)
  if (month == null || day == null) throw new Error('月日无效')
  let year: number | null = null
  if (body.year != null && body.year !== '') {
    year = readInt(body.year)
    if (year == null) throw new Error('年份无效')
  }
  if (calendar === 'solar' && body.leap) throw new Error('阳历没有闰月')
  const leap = calendar === 'lunar' && body.leap === true
  if (year != null && (year < 1900 || year > today.y)) throw new Error('年份无效')
  const date: ContactDate = { kind, calendar, month, day, year, leap }
  if (year != null) {
    const birth = occurrenceOnYear(date, year)
    if (!birth) throw new Error('日期无效，这一天在该年不存在')
    if (cmp(birth, today) > 0) throw new Error('年份无效，不能晚于今天')
  } else if (calendar === 'solar') {
    const max = SOLAR_MAX_DAY[month] ?? 0
    if (day < 1 || day > max) throw new Error('月日无效')
  } else if (month < 1 || month > 12 || day < 1 || day > 30) {
    throw new Error('月日无效')
  }
  return date
}

/**
 * 下次日子落在今天起 30 天内：还剩几天，当天是「今天」。
 * 否则如果这一天已经过了：过了几天。更远且还没到的不出现。
 * 有年份时按那一天到今天算出「几岁几个月几天」。名称是「生日」用「岁」，其余用「年」。
 */
export function buildReminder(date: ContactDate | null, today: Ymd): Reminder | null {
  if (!date) return null
  const next = nextOccurrence(date, today)
  if (!next) return null
  const birth = date.year == null ? null : occurrenceOnYear(date, date.year)
  const age = birth && cmp(birth, today) <= 0 ? formatAge(birth, today, date.kind === '生日' ? '岁' : '年') : ''
  const daysUntil = diffDays(today, next)
  if (daysUntil >= 0 && daysUntil <= UPCOMING_DAYS) {
    return {
      state: 'upcoming',
      days: daysUntil,
      text: daysUntil === 0 ? '今天' : `还剩 ${daysUntil} 天`,
      age_text: age,
    }
  }
  const prev = prevOccurrence(date, today)
  if (!prev) return null
  if (birth && cmp(prev, birth) < 0) return null
  const daysSince = diffDays(prev, today)
  if (daysSince <= 0) return null
  return { state: 'past', days: daysSince, text: `过了 ${daysSince} 天`, age_text: age }
}

function formatAge(birth: Ymd, today: Ymd, unit: '岁' | '年'): string {
  const parts = ageParts(birth, today)
  if (!parts) return ''
  return `${parts.years}${unit}${parts.months}个月${parts.days}天`
}

/** 先数满整年，再数满整月，剩下的是天。某月没有同一天时算到该月最后一天。 */
function ageParts(birth: Ymd, today: Ymd): { years: number; months: number; days: number } | null {
  if (cmp(birth, today) > 0) return null
  let years = today.y - birth.y
  if (cmp(addMonths(birth, years * 12), today) > 0) years -= 1
  let months = 0
  while (months < 12 && cmp(addMonths(birth, years * 12 + months + 1), today) <= 0) months += 1
  const anchor = addMonths(birth, years * 12 + months)
  return { years, months, days: diffDays(anchor, today) }
}

function nextOccurrence(date: ContactDate, today: Ymd): Ymd | null {
  if (date.calendar === 'solar') return scanSolar(date.month, date.day, today, 1)
  return scanLunar(date, today, 1)
}

function prevOccurrence(date: ContactDate, today: Ymd): Ymd | null {
  if (date.calendar === 'solar') return scanSolar(date.month, date.day, today, -1)
  return scanLunar(date, today, -1)
}

function scanSolar(month: number, day: number, today: Ymd, dir: 1 | -1): Ymd | null {
  const start = dir > 0 ? today.y : today.y
  for (let i = 0; i <= 8; i++) {
    const year = start + dir * i
    if (!isSolar(year, month, day)) continue
    const date = { y: year, m: month, d: day }
    if (dir > 0 && cmp(date, today) >= 0) return date
    if (dir < 0 && cmp(date, today) < 0) return date
  }
  return null
}

function scanLunar(date: ContactDate, today: Ymd, dir: 1 | -1): Ymd | null {
  const start = lunarYear(today) + (dir < 0 ? 1 : -1)
  for (let i = 0; i <= 8; i++) {
    const year = start + dir * i
    const solar = lunarToSolar(year, date.month, date.day, date.leap)
    if (!solar) continue
    if (dir > 0 && cmp(solar, today) >= 0) return solar
    if (dir < 0 && cmp(solar, today) < 0) return solar
  }
  return null
}

function occurrenceOnYear(date: ContactDate, year: number): Ymd | null {
  if (date.calendar === 'solar') {
    if (!isSolar(year, date.month, date.day)) return null
    return { y: year, m: date.month, d: date.day }
  }
  return lunarToSolar(year, date.month, date.day, date.leap)
}

function lunarToSolar(year: number, month: number, day: number, leap: boolean): Ymd | null {
  try {
    const lunar = Lunar.fromYmd(year, leap ? -month : month, day)
    const solar = lunar.getSolar()
    return { y: solar.getYear(), m: solar.getMonth(), d: solar.getDay() }
  } catch {
    return null
  }
}

function lunarYear(today: Ymd): number {
  return Solar.fromYmd(today.y, today.m, today.d).getLunar().getYear()
}

function lunarDayText(day: number): string {
  const n = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十']
  if (day <= 10) return `初${n[day] ?? ''}`
  if (day < 20) return `十${n[day - 10] ?? ''}`
  if (day === 20) return '二十'
  if (day < 30) return `廿${n[day - 20] ?? ''}`
  return '三十'
}

function addMonths(date: Ymd, months: number): Ymd {
  const index = date.y * 12 + (date.m - 1) + months
  const y = Math.floor(index / 12)
  const m = (index % 12) + 1
  const d = Math.min(date.d, daysInMonth(y, m))
  return { y, m, d }
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate()
}

function isSolar(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1) return false
  return d <= daysInMonth(y, m)
}

function diffDays(from: Ymd, to: Ymd): number {
  const a = Date.UTC(from.y, from.m - 1, from.d)
  const b = Date.UTC(to.y, to.m - 1, to.d)
  return Math.round((b - a) / 86400000)
}

function cmp(a: Ymd, b: Ymd): number {
  if (a.y !== b.y) return a.y - b.y
  if (a.m !== b.m) return a.m - b.m
  return a.d - b.d
}

function readInt(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isInteger(raw)) return raw
  if (typeof raw === 'string' && /^-?\d+$/.test(raw.trim())) return Number(raw.trim())
  return null
}
