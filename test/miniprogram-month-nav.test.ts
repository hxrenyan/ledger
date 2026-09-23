/**
 * 月份切换条（components/month-nav）的滚轮逻辑测试。
 *
 * 为什么值得钉：这块的边界失败起来全是静默的 ——
 *   · 截断没生效 → 用户滚到未来月份，看到一片空白明细，不报错；
 *   · 越界没钳住 → 选「2026 年」却跳到 2017 年（用越界下标取到了别的年份）；
 *   · 越界月份被派发出去 → 页面拿一个不该存在的月份去请求接口。
 * 而且它三页共用，一处错就是三处错。
 *
 * 装载方式与其它小程序测试一致：源码是 CommonJS，用 new Function 手工跑，
 * 把 Component / require / this 上的 setData 与 triggerEvent 都换成桩。
 */

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const repoRoot = resolve(__dirname, '..')
const utilsDir = join(repoRoot, 'miniprogram/utils')

/** 纯函数模块，没有 wx 依赖，直接按 CJS 跑。 */
function loadCjs(file: string): Record<string, any> {
  const mod: { exports: Record<string, any> } = { exports: {} }
  const localRequire = (spec: string) => {
    if (!spec.startsWith('.')) throw new Error(`小程序模块不应依赖外部包：${spec}`)
    return loadCjs(resolve(dirname(file), spec.endsWith('.js') ? spec : `${spec}.js`))
  }
  const fn = new Function('module', 'exports', 'require', readFileSync(file, 'utf8'))
  fn(mod, mod.exports, localRequire)
  return mod.exports
}

const time = loadCjs(join(utilsDir, 'time.js'))

type Methods = Record<string, (...args: any[]) => unknown>
type Def = { methods: Methods }

/** 把组件的 Component({...}) 定义对象抓出来。 */
function loadComponentDef(): Def {
  const src = readFileSync(join(repoRoot, 'miniprogram/components/month-nav/month-nav.js'), 'utf8')
  let captured: Def = { methods: {} }
  const factory = new Function('module', 'exports', 'require', 'Component', src)
  factory(
    { exports: {} },
    {},
    (id: string) => {
      if (id === '../../utils/time') return time
      throw new Error(`month-nav.js 里出现了预期外的 require('${id}')`)
    },
    (def: Def) => {
      captured = def
    },
  )
  return captured
}

const def = loadComponentDef()

/** 造一个最小的组件实例：data + setData（支持 'range[1]' 这种路径）+ triggerEvent。 */
function instance(props: Record<string, unknown> = {}) {
  const events: { name: string; detail: any }[] = []
  const inst: Record<string, any> = {
    data: Object.assign(
      { month: '', max: '', monthText: '', canPrev: true, canNext: true, showBack: false, range: [[], []], value: [0, 0] },
      props,
    ),
    setData(patch: Record<string, unknown>) {
      for (const [key, val] of Object.entries(patch)) {
        const path = key.match(/^([\w$]+)\[(\d+)\]$/)
        if (path) inst.data[path[1]][Number(path[2])] = val
        else inst.data[key] = val
      }
    },
    triggerEvent(name: string, detail: unknown) {
      events.push({ name, detail })
    },
  }
  Object.assign(inst, def.methods)
  return { inst, events }
}

const MONTHS_1_TO_12 = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]

describe('月份切换条：年月滚轮', () => {
  it('过往年份：月份列排满 12 个月，滚轮定位到当前月份', () => {
    const { inst } = instance({ month: '2025-03', max: '2026-09' })
    inst.sync()
    expect(inst.data.monthText).toBe('2025年3月')
    expect(inst.data.range[0][0]).toBe('2017年')
    expect(inst.data.range[0][9]).toBe('2026年')
    expect(inst.data.range[1].length).toBe(12)
    expect(inst.data.value).toEqual([8, 2])
    expect(inst.data.canPrev).toBe(true)
    expect(inst.data.canNext).toBe(true)
  })

  it('上限那年：月份列截断到上限月，右箭头置灰', () => {
    const { inst } = instance({ month: '2026-09', max: '2026-09' })
    inst.sync()
    expect(inst.data.range[1]).toEqual(['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月'])
    expect(inst.data.value).toEqual([9, 8])
    expect(inst.data.canNext).toBe(false)
  })

  it('滚到上限那年时，月份列当场收短，越界的下标被收回', () => {
    const { inst } = instance({ month: '2020-12', max: '2026-09' })
    inst.sync()
    expect(inst.data.value).toEqual([3, 11])
    // 用户把第一列滚到 2026 年
    inst.onColumn({ detail: { column: 0, value: 9 } })
    expect(inst.data.range[1].length).toBe(9)
    expect(inst.data.value[1]).toBeLessThanOrEqual(8)
  })

  it('滚月份列不重算年份列（只认第 0 列）', () => {
    const { inst } = instance({ month: '2020-12', max: '2026-09' })
    inst.sync()
    inst.onColumn({ detail: { column: 1, value: 5 } })
    expect(inst.data.range[1].length).toBe(12)
  })

  it('确定时按选中的年份重算月份列 —— 未来月份被钳到上限，不会派发出去', () => {
    const { inst, events } = instance({ month: '2025-01', max: '2026-09' })
    inst.sync()
    // 第一列选 2026 年（下标 9），第二列给一个越界的 12 月（下标 11）
    inst.onPick({ detail: { value: [9, 11] } })
    expect(events).toEqual([{ name: 'change', detail: { month: '2026-09' } }])
  })

  it('选中与当前相同的月份时不派发（页面不该白重拉一次）', () => {
    const { inst, events } = instance({ month: '2025-03', max: '2026-09' })
    inst.sync()
    inst.onPick({ detail: { value: [8, 2] } })
    expect(events).toHaveLength(0)
    // 滚轮要复位到当前月份，不能停在用户中途滚过的位置
    expect(inst.data.value).toEqual([8, 2])
  })

  it('箭头越界时不派发（置灰只挡点击，挡不住代码）', () => {
    const { inst, events } = instance({ month: '2026-09', max: '2026-09' })
    inst.sync()
    inst.next()
    expect(events).toHaveLength(0)
    // 下界之外同样拦住
    const low = instance({ month: '2017-01', max: '2026-09' })
    low.inst.sync()
    low.inst.prev()
    expect(low.events).toHaveLength(0)
  })

  it('预算页：上限传下个月时，下个月可选、再往后不行', () => {
    const { inst, events } = instance({ month: '2026-09', max: '2026-10' })
    inst.sync()
    expect(inst.data.canNext).toBe(true)
    inst.next()
    expect(events).toEqual([{ name: 'change', detail: { month: '2026-10' } }])
  })

  it('「回到本月」只在不在本月时出现', () => {
    const thisMonth = time.shanghaiMonth()
    const away = instance({ month: '2020-01', max: thisMonth })
    away.inst.sync()
    expect(away.inst.data.showBack).toBe(true)

    const here = instance({ month: thisMonth, max: thisMonth })
    here.inst.sync()
    expect(here.inst.data.showBack).toBe(false)

    // 点「回到本月」派发本月
    away.inst.back()
    expect(away.events).toEqual([{ name: 'change', detail: { month: thisMonth } }])
  })

  it('月份列为空（理论上不会发生）时不至于抛异常', () => {
    const { inst } = instance({ month: '', max: '' })
    inst.sync()
    expect(MONTHS_1_TO_12).toContain(Number(inst.data.range[1][0].replace('月', '')))
    expect(inst.data.monthText).not.toBe('')
  })
})
