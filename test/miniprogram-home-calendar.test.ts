/**
 * 明细页「进日历默认选中今天」的边界测试。
 *
 * 为什么要钉：这段逻辑的失效方式都很安静 —— 覆盖掉用户已经选的那天、在历史月份里
 * 选中一个不存在的「今天」、或者在数据还没回来时先选中（先闪一下「这天没有记录」），
 * 都不会报错。日历这一块已经反复踩过「不报错但不对」的坑，所以把边界写死在测试里。
 *
 * 装载方式与 miniprogram-request.test.ts 一致：小程序源码是 CommonJS 而本仓库是 ESM，
 * 用 new Function 手工跑起来，并把 Page / wx / 依赖模块作为参数注入。
 */

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const repoRoot = resolve(__dirname, '..')
const utilsDir = join(repoRoot, 'miniprogram/utils')

/** 纯函数模块，没有 wx 依赖，直接按 CJS 跑。 */
function loadCjs(file: string): Record<string, unknown> {
  const mod: { exports: Record<string, unknown> } = { exports: {} }
  const localRequire = (spec: string) => {
    if (!spec.startsWith('.')) throw new Error(`小程序模块不应依赖外部包：${spec}`)
    return loadCjs(resolve(dirname(file), spec.endsWith('.js') ? spec : `${spec}.js`))
  }
  const fn = new Function('module', 'exports', 'require', readFileSync(file, 'utf8'))
  fn(mod, mod.exports, localRequire)
  return mod.exports
}

const time = loadCjs(join(utilsDir, 'time.js')) as {
  todayISO(): string
  dateLabel(date: string): string
}

type PageDef = Record<string, (...args: never[]) => unknown>

/** 把 home.js 跑起来，拿到 Page({...}) 里那个定义对象。 */
function loadHomePage(): PageDef {
  const src = readFileSync(join(repoRoot, 'miniprogram/pages/home/home.js'), 'utf8')
  let captured: PageDef = {}
  const noop = () => {
    /* 这些依赖在本用例里都不会被真正调用 */
  }
  const stubs: Record<string, unknown> = {
    '../../utils/request': { get: noop, post: noop, del: noop, queryString: () => '' },
    '../../utils/session': { getLedgerId: () => '', ensure: () => true },
    '../../utils/nav': { go: noop },
    '../../utils/money': { formatYuan: () => '0.00', signedText: () => '0.00' },
    '../../utils/time': time,
    '../../utils/ui': { toast: noop, ok: noop, fail: noop, confirm: () => Promise.resolve(true) },
  }
  const factory = new Function('module', 'exports', 'require', 'wx', 'Page', src)
  factory(
    { exports: {} },
    {},
    (id: string) => {
      if (id in stubs) return stubs[id]
      throw new Error(`home.js 里出现了预期外的 require('${id}')`)
    },
    {},
    (def: PageDef) => {
      captured = def
    },
  )
  return captured
}

const home = loadHomePage()

/** 造一个最小的页面实例：data + setData，其余方法照搬定义。 */
function pageWith(data: Record<string, unknown>): Record<string, any> {
  const page: Record<string, any> = Object.assign({}, home)
  page.data = Object.assign({}, data)
  page.setData = (patch: Record<string, unknown>) => {
    Object.assign(page.data, patch)
  }
  return page
}

const TODAY = time.todayISO()
const THIS_MONTH = TODAY.slice(0, 7)

function baseData(over: Record<string, unknown> = {}) {
  return Object.assign(
    { view: 'cal', month: THIS_MONTH, isCurrentMonth: true, selectedDay: '' },
    over,
  )
}

/** 当天两笔 + 另一天一笔，够验证「只筛当天」。 */
const ITEMS = [
  { id: 1, date: TODAY, amountText: '-12.00' },
  { id: 2, date: TODAY, amountText: '-30.00' },
  { id: 3, date: THIS_MONTH + '-01', amountText: '-99.00' },
]

describe('明细页：进日历默认选中今天', () => {
  it('本月 + 日历视图 + 未选中 + 数据到位 —— 自动选今天并列出当天明细', () => {
    const page = pageWith(baseData())
    page.all = ITEMS
    page.autoSelectToday()
    expect(page.data.selectedDay).toBe(TODAY)
    expect(page.data.dayItems.map((t: { id: number }) => t.id)).toEqual([1, 2])
  })

  it('已经有选中的那天时不覆盖用户的选择', () => {
    const other = THIS_MONTH + '-01'
    const page = pageWith(baseData({ selectedDay: other }))
    page.all = ITEMS
    page.autoSelectToday()
    expect(page.data.selectedDay).toBe(other)
  })

  it('历史月份不选：那个月里没有「今天」', () => {
    const page = pageWith(baseData({ isCurrentMonth: false, month: '2020-01' }))
    page.all = ITEMS
    page.autoSelectToday()
    expect(page.data.selectedDay).toBe('')
  })

  it('不在日历视图时不选', () => {
    const page = pageWith(baseData({ view: 'list' }))
    page.all = ITEMS
    page.autoSelectToday()
    expect(page.data.selectedDay).toBe('')
  })

  it('数据还没到位时不选 —— 否则会先闪一下「这天没有记录」', () => {
    const page = pageWith(baseData())
    page.autoSelectToday()
    expect(page.data.selectedDay).toBe('')
  })

  it('isCurrentMonth 与 month 不一致时以 month 为准（兜底）', () => {
    const page = pageWith(baseData({ isCurrentMonth: true, month: '2020-01' }))
    page.all = ITEMS
    page.autoSelectToday()
    expect(page.data.selectedDay).toBe('')
  })
})
