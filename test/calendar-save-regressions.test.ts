import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { compileScript, parse } from '@vue/compiler-sfc'
import ts from 'typescript'
import * as vue from 'vue'
import { describe, expect, it, vi } from 'vitest'
import * as serverTime from '../src/time.ts'

const root = resolve(__dirname, '..')
const day = '2026-10-19'
type Note = { id: number; day: string; body: string; created_at: number; updated_at: number }
const original: Note = { id: 1, day, body: '原来的记事', created_at: 1, updated_at: 1 }
const another: Note = { ...original, id: 2, body: '第二条记事' }
const created: Note = { ...original, id: 3, body: '提交的正文' }

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

/** 执行真实小程序页面及 H5 setup，仅替换网络、路由和宿主接口。 */
function harness(platform: '小程序' | 'H5') {
  const pending = deferred<Note>()
  let notes = [original, another]
  let refreshFailure = false
  const mutate = vi.fn(() => pending.promise)
  const request = vi.fn(({ path, method }: { path: string; method?: string }) => {
    if (method) return mutate()
    if (refreshFailure) return Promise.reject(new Error('刷新失败'))
    if (path.includes('?month=')) return Promise.resolve({ items: notes, days: [{ day, count: notes.length }] })
    return Promise.resolve({ items: notes.filter((note) => path.endsWith(note.day)) })
  })
  let state: Record<string, any>
  let invoke: (name: string, ...args: any[]) => any
  let write: (text: string) => void
  let value: (name: string) => any
  let setError: (text: string) => void
  if (platform === '小程序') {
    const timeModule = { exports: {} }
    new Function('module', 'exports', readFileSync(resolve(root, 'miniprogram/utils/time.js'), 'utf8'))(timeModule, timeModule.exports)
    let definition: Record<string, any> = {}
    const modules: Record<string, unknown> = {
      '../../utils/request': { request }, '../../utils/session': {},
      '../../utils/time': timeModule.exports, '../../utils/ui': { ok: vi.fn() },
    }
    new Function('require', 'wx', 'Page', readFileSync(resolve(root, 'miniprogram/pages/tool-calendar/tool-calendar.js'), 'utf8'))(
      (id: string) => modules[id], { pageScrollTo: vi.fn() }, (page: Record<string, any>) => { definition = page },
    )
    state = { ...definition, data: structuredClone(definition.data) }
    state.setData = (patch: Record<string, unknown>) => Object.assign(state.data, patch)
    Object.assign(state.data, { selected: day, today: day, month: '2026-10', items: notes })
    state._monthItems = notes.slice()
    invoke = (name, ...args) => {
      if (['pick', 'jumpDay'].includes(name)) return state.pickDate(args[0], false)
      if (name === 'applyMonth') return state.applyMonth(args[0], '', false)
      if (name === 'jumpAdd') return state.jumpAdd({ currentTarget: { dataset: { date: args[0] } } })
      if (['startEdit', 'jumpEdit'].includes(name)) return state[name]({ currentTarget: { dataset: args[0] } })
      return state[name](...args)
    }
    write = (text) => state.onDraft({ detail: { value: text } })
    value = (name) => state.data[name === 'saving' ? 'busy' : name]
    setError = (text) => { state.data.error = text }
  } else {
    const filename = resolve(root, 'web/src/pages/tools/CalendarPage.vue')
    const { descriptor } = parse(readFileSync(filename, 'utf8'), { filename })
    const compiled = compileScript(descriptor, { id: 'calendar-save-regressions' })
    const source = ts.transpileModule(compiled.content, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText
    const component = { exports: {} as Record<string, any> }
    const modules: Record<string, unknown> = {
      vue: { ...vue, watch: vi.fn(), onMounted: vi.fn(), nextTick: vi.fn(() => Promise.resolve()) },
      'vue-router': { useRouter: () => ({ push: vi.fn() }) }, '@server/time.ts': serverTime,
      '../../tools/session.ts': { api: (path: string, init: RequestInit = {}) => request({ path, method: init.method }) },
    }
    new Function('module', 'exports', 'require', 'window', source)(component, component.exports,
      (id: string) => { if (!(id in modules)) throw new Error(`未配置依赖：${id}`); return modules[id] },
      { localStorage: { getItem: () => null } },
    )
    state = component.exports.default.setup({}, { expose: vi.fn() })
    state.selected.value = day
    state.month.value = '2026-10'
    state.monthItems.value = notes.slice()
    invoke = (name, ...args) => state[name](...args)
    write = (text) => { state.draft.value = text }
    value = (name) => state[name].value
    setError = (text) => { state.error.value = text }
  }
  return {
    invoke, write, value, setError, request, mutate,
    resolve(note = created) { notes = notes.filter((row) => row.id !== note.id).concat(note); pending.resolve(note) },
    reject() { pending.reject(new Error('保存失败')) },
    failRefresh() { refreshFailure = true },
  }
}

describe.each(['小程序', 'H5'] as const)('%s 日历保存编辑会话', (platform) => {
  it.each([
    { name: '切换日期后新增', action: (h: ReturnType<typeof harness>) => { h.invoke('pick', '2026-10-20'); h.invoke('startAdd') } },
    { name: '切月后新增', action: (h: ReturnType<typeof harness>) => { h.invoke('applyMonth', '2026-11'); h.invoke('startAdd') } },
    { name: '取消后重开相同正文', action: (h: ReturnType<typeof harness>) => { h.invoke('cancelEdit'); h.invoke('startAdd') } },
    { name: '一览新增', action: (h: ReturnType<typeof harness>) => h.invoke('jumpAdd', '2026-10-20') },
    { name: '切换编辑条目', action: (h: ReturnType<typeof harness>) => h.invoke('startEdit', another) },
    { name: '一览编辑', action: (h: ReturnType<typeof harness>) => h.invoke('jumpEdit', another) },
  ])('$name 后旧请求成功不清空草稿或错误', async ({ action }) => {
    const h = harness(platform)
    h.invoke('startAdd')
    h.write(created.body)
    const saving = h.invoke('save')
    action(h)
    h.write(created.body)
    h.setError('新会话的错误')
    const editing = h.value('editingId')
    const adding = h.value('adding')
    h.resolve()
    await saving
    expect(h.value('draft')).toBe(created.body)
    expect(h.value('editingId')).toBe(editing)
    expect(h.value('adding')).toBe(adding)
    expect(h.value('error')).toBe('新会话的错误')
    expect(h.value('saving')).toBe(false)
  })

  it('旧请求失败不覆盖新会话的提示', async () => {
    const h = harness(platform)
    h.invoke('startAdd'); h.write(created.body)
    const saving = h.invoke('save')
    h.invoke('cancelEdit'); h.invoke('startAdd'); h.write('新的正文'); h.setError('新会话的错误')
    h.reject()
    await saving
    expect(h.value('draft')).toBe('新的正文')
    expect(h.value('error')).toBe('新会话的错误')
    expect(h.value('saving')).toBe(false)
  })

  it('原新增会话继续输入时保留正文，下一次保存修改已创建记录', async () => {
    const h = harness(platform)
    h.invoke('startAdd'); h.write(created.body)
    const saving = h.invoke('save')
    h.write('提交之后继续输入的正文')
    h.resolve()
    await saving
    expect(h.value('draft')).toBe('提交之后继续输入的正文')
    expect(h.value('editingId')).toBe(created.id)
    expect(h.value('adding')).toBe(false)
    await h.invoke('save')
    expect(h.request.mock.calls.filter(([req]) => req.method).map(([req]) => [req.path, req.method])).toEqual([
      ['/api/v1/day-notes', 'POST'], ['/api/v1/day-notes/3', 'PATCH'],
    ])
    expect(h.value('draft')).toBe('')
  })

  it('已存在记事继续输入时保留正文和编辑条目', async () => {
    const h = harness(platform)
    h.invoke('startEdit', original); h.write(created.body)
    const saving = h.invoke('save')
    h.write('继续修改')
    h.resolve({ ...original, body: created.body })
    await saving
    expect(h.value('draft')).toBe('继续修改')
    expect(h.value('editingId')).toBe(original.id)
  })

  it('新增继续输入且列表刷新失败时，输入框仍挂在已创建记录下', async () => {
    const h = harness(platform)
    h.invoke('startAdd'); h.write(created.body)
    const saving = h.invoke('save')
    h.write('继续输入的正文')
    h.failRefresh(); h.resolve()
    await saving
    expect(h.value('draft')).toBe('继续输入的正文')
    expect(h.value('editingId')).toBe(created.id)
    expect(h.value('items').some((note: Note) => note.id === created.id)).toBe(true)
    expect(h.value('error')).toBe('刷新失败')
    expect(h.value('saving')).toBe(false)
  })

  it('原会话正常成功关闭输入框并刷新列表', async () => {
    const h = harness(platform)
    h.invoke('startAdd'); h.write(created.body)
    const saving = h.invoke('save')
    h.resolve()
    await saving
    expect(h.value('draft')).toBe('')
    expect(h.value('adding')).toBe(false)
    expect(h.value('items').some((note: Note) => note.id === created.id)).toBe(true)
    expect(h.value('saving')).toBe(false)
  })

  it('原会话保存失败保留草稿并显示失败原因', async () => {
    const h = harness(platform)
    h.invoke('startAdd'); h.write(created.body)
    const saving = h.invoke('save')
    h.reject()
    await saving
    expect(h.value('draft')).toBe(created.body)
    expect(h.value('adding')).toBe(true)
    expect(h.value('error')).toBe('保存失败')
    expect(h.value('saving')).toBe(false)
  })

  it('旧提交刷新失败也不覆盖新会话已有提示', async () => {
    const h = harness(platform)
    h.invoke('startAdd'); h.write(created.body)
    const saving = h.invoke('save')
    h.invoke('cancelEdit'); h.invoke('startAdd'); h.write('新的正文'); h.setError('新会话的错误')
    h.failRefresh(); h.resolve()
    await saving
    expect(h.value('draft')).toBe('新的正文')
    expect(h.value('error')).toBe('新会话的错误')
    expect(h.value('saving')).toBe(false)
  })
})
