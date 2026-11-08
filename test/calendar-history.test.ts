import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { compileScript, parse } from '@vue/compiler-sfc'
import ts from 'typescript'
import * as vue from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as serverTime from '../src/time.ts'

type Note = { id: number; day: string; body: string; created_at: number; updated_at: number }
const root = resolve(__dirname, '..')
const note = (id: number, day: string): Note => ({ id, day, body: `记事 ${id}`, created_at: id, updated_at: id })
const initial = [note(1, '2026-10-01'), note(2, '2024-03-05'), note(3, '2024-03-18'), note(4, '2024-03-18'), note(5, '2011-01-01'), note(6, '2026-10-27')]
const asOf = '2026-10-26'

function summary(notes: Note[]) {
  const years: any[] = []
  for (const month of [...new Set(notes.filter((n) => n.day <= asOf).map((n) => n.day.slice(0, 7)))].sort().reverse()) {
    const rows = notes.filter((n) => n.day.slice(0, 7) === month && n.day <= asOf)
    const days = [...new Set(rows.map((n) => n.day))].sort()
    const year = Number(month.slice(0, 4))
    if (years.at(-1)?.year !== year) years.push({ year, count: 0, recorded_days: 0, months: [] })
    const group = years.at(-1)
    group.months.push({ month, count: rows.length, recorded_days: days.length, first_day: days[0], last_day: days.at(-1) })
    group.count += rows.length; group.recorded_days += days.length
  }
  return { as_of: asOf, total_count: years.reduce((n, y) => n + y.count, 0), recorded_days: years.reduce((n, y) => n + y.recorded_days, 0), years }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

/** 执行双端真实页面，替换网络和宿主，验证同一组业务行为。 */
function harness(platform: '小程序' | 'H5') {
  let notes = structuredClone(initial)
  let account = 'account-1'
  const confirm = vi.fn(() => true)
  const scroll = vi.fn()
  const request = vi.fn(async (path: string): Promise<any> => {
    if (path.endsWith('/history')) return summary(notes)
    const url = new URL(path, 'https://test.local')
    if (url.searchParams.has('day')) return { items: notes.filter((n) => n.day === url.searchParams.get('day')) }
    return { items: notes.filter((n) => n.day.slice(0, 7) === url.searchParams.get('month')), days: [] }
  })
  let state: Record<string, any>
  let invoke: (name: string, ...args: any[]) => any
  let get: (name: string) => any
  let set: (name: string, value: any) => void
  let h: () => any
  if (platform === '小程序') {
    const time = { exports: {} }
    new Function('module', 'exports', readFileSync(resolve(root, 'miniprogram/utils/time.js'), 'utf8'))(time, time.exports)
    const modules: Record<string, any> = {
      '../../utils/request': { request: ({ path }: { path: string }) => request(path) },
      '../../utils/session': { getToken: () => account }, '../../utils/time': time.exports,
      '../../utils/ui': { confirm: async () => confirm(), ok: vi.fn() },
    }
    let page: any
    new Function('require', 'wx', 'Page', readFileSync(resolve(root, 'miniprogram/pages/tool-calendar/tool-calendar.js'), 'utf8'))(
      (id: string) => modules[id], { pageScrollTo: scroll, nextTick: (fn: () => void) => fn() }, (value: any) => { page = value },
    )
    state = { ...page, data: structuredClone(page.data) }
    state.setData = (patch: any) => Object.assign(state.data, patch)
    Object.assign(state.data, { month: '2026-10', selected: asOf, today: asOf, items: [] })
    get = (name) => state.data[name === 'saving' ? 'busy' : name]
    set = (name, value) => { state.data[name === 'saving' ? 'busy' : name] = value; if (name === 'saving') state._saving = value }
    h = () => state.data.history
    invoke = (name, ...args) => {
      if (name === 'selectHistoryYear') return state[name]({ currentTarget: { dataset: { year: args[0] } } })
      if (name === 'viewHistoryDay') return state[name]({ currentTarget: { dataset: { id: args[0].id } } })
      return state[name](...args)
    }
  } else {
    const filename = resolve(root, 'web/src/pages/tools/CalendarPage.vue')
    const { descriptor } = parse(readFileSync(filename, 'utf8'), { filename })
    const source = ts.transpileModule(compileScript(descriptor, { id: 'history-tests' }).content, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText
    const modules: Record<string, any> = {
      vue: { ...vue, onMounted: vi.fn(), onUnmounted: vi.fn(), watch: vi.fn() },
      'vue-router': { useRouter: () => ({ push: vi.fn() }) }, '@server/time.ts': serverTime,
      '../../tools/session.ts': { api: request, authHeaders: () => ({ authorization: account }) },
    }
    const component = { exports: {} as any }
    new Function('module', 'exports', 'require', 'window', 'document', source)(
      component, component.exports, (id: string) => { if (!(id in modules)) throw new Error(`未配置依赖：${id}`); return modules[id] },
      { localStorage: { getItem: () => null }, confirm }, { body: { style: { overflow: '' } } },
    )
    state = component.exports.default.setup({}, { expose: vi.fn() })
    state.month.value = '2026-10'; state.selected.value = asOf
    state.dayCardRef.value = { querySelector: () => ({ scrollIntoView: scroll }) }
    get = (name) => state[name].value
    set = (name, value) => { state[name].value = value }
    h = () => state.history
    invoke = (name, ...args) => state[name](...args)
  }
  return { invoke, get, set, history: h, request, confirm, scroll,
    notes(value: Note[]) { notes = value }, account(value: string) { account = value },
    preview: () => platform === '小程序' ? h().groups.flatMap((g: any) => g.items) : state.historyGroups.value.flatMap((g: any) => g.items),
  }
}

afterEach(() => vi.restoreAllMocks())

describe.each(['小程序', 'H5'] as const)('%s 年月目录', (platform) => {
  it('独立预览历史年月，按天倒序且同日按写入顺序，不显示未来', async () => {
    const h = harness(platform)
    h.set('draft', '正在编辑'); h.set('q', '旧搜索'); h.set('listFilter', 'upcoming')
    await h.invoke('openHistory')
    expect(h.history().summary.years.map((y: any) => y.year)).toEqual([2026, 2024, 2011])
    expect(h.preview().map((n: Note) => n.id)).toEqual([1])
    await h.invoke('selectHistoryMonth', '2024-03')
    expect(h.preview().map((n: Note) => n.id)).toEqual([3, 4, 2])
    expect(h.history().older).toBe('2011-01')
    expect(h.history().newer).toBe('2026-10')
    h.invoke('closeHistory')
    expect(h.get('draft')).toBe('正在编辑'); expect(h.get('month')).toBe('2026-10')
    expect(h.get('q')).toBe('旧搜索'); expect(h.get('listFilter')).toBe('upcoming')
    await h.invoke('openHistory')
    expect(h.history().month).toBe('2024-03')
    await h.invoke('selectHistoryYear', 2011)
    expect(h.history().month).toBe('2011-01'); expect(h.history().older).toBe('')
  })

  it('默认选择选中年份的最近月，删空后回退且提示', async () => {
    const h = harness(platform)
    h.set('month', '2024-12')
    await h.invoke('openHistory')
    expect(h.history().month).toBe('2024-03')
    h.invoke('closeHistory'); h.notes(initial.filter((n) => !n.day.startsWith('2024')))
    await h.invoke('openHistory')
    expect(h.history().month).toBe('2026-10')
    expect(h.history().notice).toContain('原月份已无历史记录')
  })

  it('大月份逐批显示并恢复已展开条数', async () => {
    const h = harness(platform)
    h.notes(Array.from({ length: 65 }, (_, i) => note(i + 1, '2024-03-05')))
    await h.invoke('openHistory')
    expect(h.preview()).toHaveLength(30)
    h.invoke('moreHistory'); expect(h.preview()).toHaveLength(60)
    h.invoke('closeHistory'); await h.invoke('openHistory')
    expect(h.preview()).toHaveLength(60)
    h.invoke('moreHistory'); expect(h.preview()).toHaveLength(65)
  })

  it('快速切月只采用最后一次响应，关闭后返回不改变目录', async () => {
    const h = harness(platform)
    await h.invoke('openHistory')
    const pending = deferred<any>()
    h.request.mockImplementationOnce(() => pending.promise)
    const a = h.invoke('selectHistoryMonth', '2024-03')
    await h.invoke('selectHistoryMonth', '2011-01')
    pending.resolve({ items: initial.filter((n) => n.day.startsWith('2024')) }); await a
    expect(h.preview().map((n: Note) => n.id)).toEqual([5])
    const closing = deferred<any>()
    h.request.mockImplementationOnce(() => closing.promise)
    const b = h.invoke('selectHistoryMonth', '2024-03')
    h.invoke('closeHistory'); closing.resolve({ items: [note(99, '2024-03-01')] }); await b
    expect(h.history().open).toBe(false); expect(h.preview()).toEqual([])
  })

  it('汇总与预览失败有独立错误，不能当作空记录', async () => {
    const h = harness(platform)
    h.request.mockRejectedValueOnce(new Error('目录网络失败'))
    await h.invoke('openHistory'); expect(h.history().error).toBe('目录网络失败')
    await h.invoke('refreshHistory'); expect(h.history().error).toBe('')
    h.request.mockRejectedValueOnce(new Error('月份失败'))
    await h.invoke('selectHistoryMonth', '2024-03')
    expect(h.history().previewError).toBe('月份失败'); expect(h.preview()).toEqual([])
    await h.invoke('selectHistoryMonth', '2024-03'); expect(h.preview()).toHaveLength(3)
  })

  it('统计持续变化仅自动协调一次，不会循环请求', async () => {
    const h = harness(platform)
    const stable = summary(initial)
    h.request.mockImplementation(async (path) => path.endsWith('/history') ? stable : { items: [] })
    await h.invoke('openHistory')
    expect(h.request.mock.calls.filter(([path]) => path.endsWith('/history'))).toHaveLength(2)
    expect(h.history().notice).toContain('记录有更新')
    expect(h.history().previewLoading).toBe(false)
  })

  it('草稿取消确认保留现场，保存期间阻止跳转，确认后定位原记录', async () => {
    const h = harness(platform)
    await h.invoke('openHistory'); await h.invoke('selectHistoryMonth', '2024-03')
    h.set('draft', '未保存'); h.confirm.mockReturnValue(false)
    await h.invoke('viewHistoryDay', initial[2])
    expect(h.history().open).toBe(true); expect(h.get('draft')).toBe('未保存'); expect(h.get('selected')).toBe(asOf)
    h.set('saving', true); h.confirm.mockReturnValue(true)
    await h.invoke('viewHistoryDay', initial[2]); expect(h.history().notice).toContain('等待')
    h.set('saving', false); h.set('q', '旧搜索'); h.set('listFilter', 'upcoming')
    await h.invoke('viewHistoryDay', initial[2]); await Promise.resolve()
    expect(h.history().open).toBe(false); expect(h.get('draft')).toBe('')
    expect(h.get('selected')).toBe('2024-03-18'); expect(h.get('highlightedId')).toBe(3)
    expect(h.get('q')).toBe(''); expect(h.get('listFilter')).toBe('all'); expect(h.scroll).toHaveBeenCalled()
  })

  it('目标加载失败可重试，目标删除刷新目录并保留在预览', async () => {
    const h = harness(platform)
    await h.invoke('openHistory'); await h.invoke('selectHistoryMonth', '2024-03')
    h.request.mockRejectedValueOnce(new Error('当天请求失败'))
    await h.invoke('viewHistoryDay', initial[2]); expect(h.history().previewError).toBe('当天请求失败')
    expect(h.history().open).toBe(true); expect(h.get('selected')).toBe(asOf)
    h.notes(initial.filter((n) => n.id !== 3))
    await h.invoke('viewHistoryDay', initial[2])
    expect(h.history().notice).toContain('已不存在'); expect(h.history().open).toBe(true)
    expect(h.preview().map((n: Note) => n.id)).toEqual([4, 2]); expect(h.history().navigating).toBe(false)
    const delayedSummary = deferred<any>()
    h.request.mockResolvedValueOnce({ items: [] }).mockImplementationOnce(() => delayedSummary.promise)
    const oldRemoval = h.invoke('viewHistoryDay', initial[3])
    await Promise.resolve()
    h.invoke('closeHistory'); await h.invoke('openHistory')
    delayedSummary.resolve(summary(initial)); await oldRemoval
    expect(h.history().notice).toBe('')
  })

  it('定位等待期间新增草稿或关闭重开目录，旧定位不清空新状态', async () => {
    const h = harness(platform)
    await h.invoke('openHistory'); await h.invoke('selectHistoryMonth', '2024-03')
    h.set('draft', '确认过的草稿')
    const waiting = deferred<any>()
    h.request.mockImplementationOnce(() => waiting.promise)
    const jump = h.invoke('viewHistoryDay', initial[2])
    await Promise.resolve()
    h.set('draft', '后来输入的新草稿')
    waiting.resolve({ items: [initial[2]] }); await jump
    expect(h.get('draft')).toBe('后来输入的新草稿'); expect(h.get('selected')).toBe(asOf)
    expect(h.history().notice).toContain('草稿已更新')
    h.set('draft', '')
    const closing = deferred<any>()
    h.request.mockImplementationOnce(() => closing.promise)
    const oldJump = h.invoke('viewHistoryDay', initial[2])
    h.invoke('closeHistory'); await h.invoke('openHistory')
    closing.resolve({ items: [initial[2]] }); await oldJump
    expect(h.history().open).toBe(true); expect(h.get('selected')).toBe(asOf)
    expect(h.history().navigating).toBe(false)
  })

  it('账号变化使在途响应失效，再打开清除旧年月与正文', async () => {
    const h = harness(platform)
    await h.invoke('openHistory'); await h.invoke('selectHistoryMonth', '2024-03')
    const pending = deferred<any>()
    h.request.mockImplementationOnce(() => pending.promise)
    const loading = h.invoke('selectHistoryMonth', '2011-01')
    h.account('account-2'); pending.resolve({ items: initial }); await loading
    expect(h.preview()).toEqual([])
    h.invoke('closeHistory'); h.notes([]); await h.invoke('openHistory')
    expect(h.history().summary.years).toEqual([]); expect(h.history().month).toBe('')
  })
})
