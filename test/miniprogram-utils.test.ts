/**
 * 小程序工具层与后端实现的契约测试。
 *
 * 为什么值得单独钉：miniprogram/utils/money.js 与 src/money.ts 是同一套金额语义的
 * 两份实现（小程序打不了 TS 包），utils/gbk.js 又是「服务端不存在的」解码逻辑。
 * 一旦两边算法飘了，表现是「同样的输入在小程序里能算、在网页里报错」这类怪问题，
 * 事后很难定位，所以在这里用同一批用例对拍。
 *
 * 装载方式：小程序源码是 CommonJS，而本仓库是 ESM（package.json type=module），
 * 直接 import 会被 Node 当成 ESM 而报 module is not defined，
 * 所以用 new Function 手工把源码跑起来（与 test/miniprogram-request.test.ts 同一套路）。
 */

import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { centsToYuan, yuanExprToCents as serverExprToCents } from '../src/money.ts'
import { addMonth, daysInShanghaiMonth, shanghaiMonth } from '../src/time.ts'

type Module = Record<string, unknown>

/** 加载一个小程序侧的 CommonJS 模块（含相对路径依赖）。 */
function loadCjs(file: string, cache = new Map<string, Module>()): Module {
  const hit = cache.get(file)
  if (hit) return hit
  const mod: { exports: Module } = { exports: {} }
  // 先放进缓存，避免循环 require 时无限递归。
  cache.set(file, mod.exports)
  const localRequire = (spec: string) => {
    if (!spec.startsWith('.')) throw new Error(`小程序模块不应依赖外部包：${spec}`)
    const target = resolve(dirname(file), spec.endsWith('.js') ? spec : `${spec}.js`)
    return loadCjs(target, cache)
  }
  const fn = new Function('module', 'exports', 'require', readFileSync(file, 'utf8'))
  fn(mod, mod.exports, localRequire)
  cache.set(file, mod.exports)
  return mod.exports
}

const utilsDir = resolve(__dirname, '../miniprogram/utils')
const money = loadCjs(resolve(utilsDir, 'money.js')) as {
  formatYuan(cents: number): string
  yuanExprToCents(raw: string): number | null
}
const time = loadCjs(resolve(utilsDir, 'time.js')) as {
  shanghaiMonth(ms?: number): string
  addMonth(month: string, delta: number): string
  addDays(date: string, delta: number): string
  daysInMonth(month: string): number
  CAL_WEEK: string[]
  calendarGrid(month: string, marked: Record<string, boolean>): {
    cells: { date: string; blank: boolean; has: boolean; day: number }[]
  }
  pickerYears(maxMonth: string, span?: number): number[]
  pickerMonths(year: number | string, maxMonth: string): number[]
  pickerIndex(month: string, years: number[]): number
}
const fileText = loadCjs(resolve(utilsDir, 'fileText.js')) as {
  fromBytes(data: Uint8Array): string
}

describe('金额表达式：小程序与后端同解', () => {
  const cases = [
    '12+8',
    '3*4',
    '100-30',
    '120/3',
    '12.5+0.5',
    '1+2*3',
    '１００', // 全角数字：正则不认，两边都应判非法
    '0',
    '-5',
    '12+',
    'abc',
    '',
    '1/0', // 除零
    '9999999999999', // 超上限
    '12＋8', // 全角加号，两边都要先归一化
    '3×4',
  ]

  it('逐例与 src/money.ts 结果一致', () => {
    for (const raw of cases) {
      let expected: number | null = null
      try {
        expected = serverExprToCents(raw)
      } catch {
        expected = null
      }
      expect(money.yuanExprToCents(raw), `输入 ${JSON.stringify(raw)}`).toBe(expected)
    }
  })

  it('展示格式与 centsToYuan 一致', () => {
    for (const cents of [0, 1, 99, 100, 12345, -12345, -1]) {
      expect(money.formatYuan(cents)).toBe(centsToYuan(cents))
    }
  })
})

describe('时间口径：与 src/time.ts 一致', () => {
  it('当月与月份加减', () => {
    const fixed = Date.UTC(2026, 8, 23, 4, 0, 0)
    expect(time.shanghaiMonth(fixed)).toBe(shanghaiMonth(fixed))
    for (const delta of [-14, -1, 0, 1, 13]) {
      expect(time.addMonth('2026-09', delta)).toBe(addMonth('2026-09', delta))
    }
  })

  it('月份天数（含闰年 2 月）', () => {
    for (const month of ['2026-02', '2024-02', '2026-09', '2026-12']) {
      expect(time.daysInMonth(month)).toBe(daysInShanghaiMonth(month))
    }
  })

  it('跨月/跨年日期加减', () => {
    expect(time.addDays('2026-09-30', 1)).toBe('2026-10-01')
    expect(time.addDays('2026-01-01', -1)).toBe('2025-12-31')
    expect(time.addDays('2024-02-28', 1)).toBe('2024-02-29')
  })

  it('日历首格对齐周一，表头与网格同起点，且有流水的日期被标记', () => {
    // 表头顺序和网格起点必须一致：表头「一」开头，格子就得从周一排，
    // 否则整月日期错开一格。两者都在 utils/time.js 里定义。
    expect(time.CAL_WEEK).toEqual(['一', '二', '三', '四', '五', '六', '日'])
    const { cells } = time.calendarGrid('2026-09', { '2026-09-23': true })
    // 2026-09-01 是周二，周一开头只补 1 个空格子
    expect(cells[0].blank).toBe(true)
    expect(cells[1].date).toBe('2026-09-01')
    expect(time.CAL_WEEK[1]).toBe('二')
    expect(cells.filter((c) => !c.blank).length).toBe(30)
    const marked = cells.find((c) => c.date === '2026-09-23')
    expect(marked?.has).toBe(true)
    expect(cells.find((c) => c.date === '2026-09-24')?.has).toBe(false)
  })
})

/**
 * 月份选择（点月份标签弹出的年 / 月滚轮）。
 *
 * 这几条规则失败起来都很安静：多出一个未来月份，用户滚过去只会看到一片空的明细，
 * 不报错；月份列和年份列对不上，则会「选 2026 年却跳到 2017 年」。所以写死在测试里。
 */
describe('月份选择器：不许出现未来月份', () => {
  it('年份列是近 10 年（含上限年），升序', () => {
    expect(time.pickerYears('2026-09')).toEqual([2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026])
    // 上限跨年时跟着走（12 月的预算页上限是次年 1 月）
    const crossed = time.pickerYears('2027-01')
    expect(crossed[0]).toBe(2018)
    expect(crossed[crossed.length - 1]).toBe(2027)
  })

  it('上限那年只排到上限月', () => {
    expect(time.pickerMonths(2026, '2026-09')).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
    // 过往年份排满 12 个月
    expect(time.pickerMonths(2020, '2026-09')).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
  })

  it('上限是下个月时，本月之后的那个月可选（预算允许提前设）', () => {
    expect(time.pickerMonths(2026, '2026-10')).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  })

  it('pickerIndex 定位到年份列里那一项；越界退回最后一年', () => {
    const years = time.pickerYears('2026-09')
    expect(time.pickerIndex('2026-09', years)).toBe(9)
    expect(time.pickerIndex('2017-01', years)).toBe(0)
    // 比年份列更早的月份不该把滚轮甩到第 0 项
    expect(time.pickerIndex('2015-06', years)).toBe(years.length - 1)
  })
})

describe('文本解码：UTF-8 与 GBK', () => {
  const gbkBytes = (text: string): Uint8Array =>
    new Uint8Array(execSync(`printf '%s' ${JSON.stringify(text)} | iconv -f UTF-8 -t GBK`))

  it('解 GBK（银行/微信账单常见的编码）', () => {
    const text = '2026年09月23日 午饭 35.00元'
    expect(fileText.fromBytes(gbkBytes(text))).toBe(text)
  })

  it('解 UTF-8 与带 BOM 的 UTF-8', () => {
    const text = '备注,金额\n午饭,35.00'
    const plain = new Uint8Array(Buffer.from(text, 'utf8'))
    expect(fileText.fromBytes(plain)).toBe(text)
    const bom = new Uint8Array(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')]))
    expect(fileText.fromBytes(bom)).toBe(text)
  })

  it('ASCII 混合中文的 GBK 字节不会串位', () => {
    const text = 'abc,交通,12.30,OK'
    expect(fileText.fromBytes(gbkBytes(text))).toBe(text)
  })
})
