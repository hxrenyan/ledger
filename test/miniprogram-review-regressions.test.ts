import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

const root = resolve(__dirname, '..')

function loadCjs(file: string): Record<string, any> {
  const mod = { exports: {} }
  new Function('module', 'exports', 'require', readFileSync(file, 'utf8'))(
    mod, mod.exports, (id: string) => loadCjs(resolve(dirname(file), `${id}.js`)),
  )
  return mod.exports
}

const time = loadCjs(resolve(root, 'miniprogram/utils/time.js'))
const money = loadCjs(resolve(root, 'miniprogram/utils/money.js'))
const id = loadCjs(resolve(root, 'miniprogram/utils/id.js'))

/** 运行真实页面 / 组件定义，仅替换微信接口与网络边界。 */
function loadDefinition(file: string, modules: Record<string, unknown>, wx = {}, app?: unknown, pages: unknown[] = []) {
  let def: Record<string, any> = {}
  const register = (value: Record<string, any>) => { def = value }
  new Function('require', 'wx', 'Page', 'Component', 'App', 'getApp', 'getCurrentPages',
    readFileSync(resolve(root, file), 'utf8'))(
    (name: string) => {
      if (name in modules) return modules[name]
      throw new Error(`未配置依赖：${name}`)
    }, wx, register, register, register, () => app, () => pages,
  )
  return def
}

function instance(def: Record<string, any>, data = {}) {
  const inst: Record<string, any> = { ...def, ...def.methods, data: structuredClone({ ...def.data, ...data }) }
  inst.setData = (patch: Record<string, unknown>) => {
    for (const [key, value] of Object.entries(patch)) {
      const path = key.replaceAll('[', '.').replaceAll(']', '').split('.')
      const parent = path.slice(0, -1).reduce((node, part) => node[part], inst.data)
      parent[path[path.length - 1]] = value
    }
  }
  return inst
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

const notes = [
  { id: 1, day: '2026-10-19', body: '十九日的记事', created_at: 1, updated_at: 1 },
  { id: 2, day: '2026-10-20', body: '二十日的新记事', created_at: 2, updated_at: 2 },
]
const monthBody = { days: notes.map((item) => ({ day: item.day, count: 1 })), items: notes }

function calendarPage(request: unknown) {
  const def = loadDefinition('miniprogram/pages/tool-calendar/tool-calendar.js', {
    '../../utils/request': request, '../../utils/session': {}, '../../utils/time': time, '../../utils/ui': {},
  })
  const page = instance(def, { month: '2026-10', selected: '2026-10-19', today: '2026-10-19' })
  page._monthItems = notes.map((note) => ({ ...note, body: '缓存的旧记事' }))
  return page
}

describe('日历刷新与日期选择', () => {
  it.each(['2026-10-20', '2026-10-21'])('刷新途中切到 %s，使用新月数据筛选当前日期', async (selected) => {
    const month = deferred<unknown>()
    const day = deferred<unknown>()
    const request = vi.fn(({ path }: { path: string }) => path.includes('?month=') ? month.promise : day.promise)
    const page = calendarPage({ request })
    const loading = page.load()
    page.pickDate(selected, false)
    expect(request).toHaveBeenCalledTimes(2)
    day.resolve({ items: [notes[0]] })
    month.resolve(monthBody)
    await loading
    expect(page.data.selected).toBe(selected)
    expect(page.data.dayTitle).toBe(time.dateLabel(selected))
    expect(page.data.items.map((item: any) => item.id)).toEqual(selected.endsWith('20') ? [2] : [])
    if (selected.endsWith('20')) expect(page.data.items[0].body).toBe('二十日的新记事')
    expect(page.data.items.every((item: any) => item.day === selected)).toBe(true)
    expect(page.data.monthCount).toBe(2)
    expect(page.data.groups).toHaveLength(2)
    expect(page.data.loading).toBe(false)
  })

  it('旧服务端未返回月明细时，补拉当前日期，不能使用发起时的日明细', async () => {
    const oldMonth = deferred<unknown>()
    const request = vi.fn(({ path }: { path: string }) => {
      if (path.includes('?month=')) return request.mock.calls.length === 1 ? oldMonth.promise : Promise.resolve({ days: monthBody.days })
      return Promise.resolve({ items: path.endsWith('20') ? [notes[1]] : [notes[0]] })
    })
    const page = calendarPage({ request })
    const loading = page.load()
    page.pickDate('2026-10-20', false)
    oldMonth.resolve({ days: monthBody.days })
    await loading
    expect(request).toHaveBeenCalledWith({ path: '/api/v1/day-notes?day=2026-10-20' })
    expect(page.data.items.map((item: any) => item.id)).toEqual([2])
    expect(page.data.loading).toBe(false)
  })

  it('切月后才返回的旧月份请求不能覆盖新月份', async () => {
    const oldMonth = deferred<unknown>()
    const request = vi.fn(({ path }: { path: string }) => {
      if (path.endsWith('month=2026-10')) return oldMonth.promise
      if (path.includes('?month=')) return Promise.resolve({ days: [], items: [] })
      return Promise.resolve({ items: path.endsWith('2026-10-19') ? [notes[0]] : [] })
    })
    const page = calendarPage({ request })
    const loading = page.load()
    page.pickDate('2026-11-01', false)
    await vi.waitFor(() => expect(page.data.loading).toBe(false))
    oldMonth.resolve(monthBody)
    await loading
    expect(page.data.month).toBe('2026-11')
    expect(page.data.selected).toBe('2026-11-01')
    expect(page.data.items).toEqual([])
    expect(page.data.monthCount).toBe(0)
  })
})

function photoPanel(preview: unknown, options: { reject?: boolean; text?: string; confirm?: boolean } = {}) {
  const post = vi.fn(() => options.reject ? Promise.reject(new Error('文本整理超时')) : Promise.resolve(preview))
  const ui = { toast: vi.fn(), fail: vi.fn() }
  const def = loadDefinition('miniprogram/components/ai-panel/ai-panel.js', {
    '../../utils/request': { post, scanImage: vi.fn().mockResolvedValue({ text: options.text ?? '云端识别文字35元' }) },
    '../../utils/session': {}, '../../utils/image': { prepare: vi.fn().mockResolvedValue({ filePath: 'cloud.jpg' }) },
    '../../utils/localOcr': {}, '../../utils/money': money, '../../utils/time': time, '../../utils/ui': ui,
  }, { showModal: ({ success }: any) => success({ confirm: options.confirm !== false }) })
  const panel = instance(def, { mode: 'photo', canCloudRetry: true, ocrSource: 'local', text: '本机原文', rawText: '本机完整原文' })
  panel.photoGen = 0
  panel.photoPicked = { filePath: 'local.jpg' }
  panel.applyPreview({ items: [{ direction: 'expense', amount_cents: 3500, note: '原备注', status: 'ok' }], parser: 'ai' }, '')
  panel.onAmount({ currentTarget: { dataset: { i: 0 } }, detail: { value: '42.50' } })
  panel.onNote({ currentTarget: { dataset: { i: 0 } }, detail: { value: '用户修改的备注' } })
  expect(panel.data.items[0]).toMatchObject({ amountText: '42.50', noteText: '用户修改的备注' })
  return { panel, post, ui }
}

describe('云端重试保留未保存核对内容', () => {
  it.each([
    { items: [], parser: 'none', ai_error: '文本模型超时' },
    { items: [], parser: 'ai', ai_error: '' },
    null,
  ])('解析失败或无记录时恢复完整快照：%j', async (preview) => {
    const { panel, ui } = photoPanel(preview)
    const keep = structuredClone(panel.snapshot())
    const apply = vi.spyOn(panel, 'applyPreview')
    panel.cloudRetry()
    expect(panel.data.state).toBe('busy')
    await vi.waitFor(() => expect(panel.data.state).toBe('editing'))
    expect(panel.snapshot()).toEqual(keep)
    expect(apply).not.toHaveBeenCalled()
    expect(ui.toast).toHaveBeenCalled()
    expect(panel.slowTip).toBeNull()
  })

  it('网络拒绝时保留手工修改并提示失败', async () => {
    const { panel, ui } = photoPanel(null, { reject: true })
    const keep = structuredClone(panel.snapshot())
    panel.cloudRetry()
    await vi.waitFor(() => expect(panel.data.state).toBe('editing'))
    expect(panel.snapshot()).toEqual(keep)
    expect(ui.fail).toHaveBeenCalled()
    expect(panel.slowTip).toBeNull()
  })

  it('云端没有认出字时保留原核对内容', async () => {
    const { panel, post } = photoPanel(null, { text: '' })
    const keep = structuredClone(panel.snapshot())
    panel.cloudRetry()
    await vi.waitFor(() => expect(panel.data.state).toBe('editing'))
    expect(panel.snapshot()).toEqual(keep)
    expect(post).not.toHaveBeenCalled()
  })

  it('有可用结果时替换为新的云端预览', async () => {
    const { panel, post } = photoPanel({ items: [{ direction: 'expense', amount_cents: 8800, note: '新备注', status: 'ok' }], parser: 'ai' })
    panel.cloudRetry()
    await vi.waitFor(() => expect(panel.data.state).toBe('editing'))
    expect(panel.data.items[0]).toMatchObject({ amountText: '88.00', noteText: '新备注' })
    expect(panel.data.ocrSource).toBe('cloud')
    expect(panel.data.canCloudRetry).toBe(false)
    expect(post).toHaveBeenCalledWith('/api/v1/imports/receipt', { text: '云端识别文字35元' }, { timeout: 120000 })
  })

  it('取消确认时不发起请求、不改变核对内容', () => {
    const { panel, post } = photoPanel(null, { confirm: false })
    const keep = structuredClone(panel.snapshot())
    panel.cloudRetry()
    expect(panel.snapshot()).toEqual(keep)
    expect(post).not.toHaveBeenCalled()
  })
})

function contactPage() {
  const request = vi.fn().mockResolvedValue({})
  const def = loadDefinition('miniprogram/pages/contact-form/contact-form.js', {
    '../../utils/id': id, '../../utils/request': { request }, '../../utils/session': {}, '../../utils/ui': {},
  }, { navigateBack: vi.fn() })
  const dates = [
    { key: 'first', kind: '生日', calendar: 'lunar', month: 10, day: 19, year: '2000', leap: true },
    { key: 'second', kind: '纪念日', calendar: 'solar', month: 10, day: 20, year: '2020', leap: false },
  ]
  return { page: instance(def, { id: '7', isNew: false, name: '小王', dates }), request }
}
const dateEvent = (index: number) => ({ currentTarget: { dataset: { index } } })

describe('联系人删除与编辑器状态', () => {
  it('删除正在编辑的日子后保存，不把删除项重新加入', () => {
    const { page, request } = contactPage()
    page.editDate(dateEvent(0))
    page.removeDate(dateEvent(0))
    expect(page.data).toMatchObject({ editingIndex: -1, selected: '', year: '', leap: false, showDate: false })
    expect(page.currentDraft()).toBeNull()
    page.save()
    expect(request).toHaveBeenCalledWith({
      path: '/api/v1/contacts/7', method: 'PATCH',
      data: { name: '小王', relation: '', dates: [{ kind: '纪念日', calendar: 'solar', month: 10, day: 20, year: 2020, leap: false }] },
    })
  })

  it('删除编辑项之前的日子时修正下标并保留当前编辑内容', () => {
    const { page, request } = contactPage()
    page.editDate(dateEvent(1))
    page.onYear({ detail: { value: '2021' } })
    page.removeDate(dateEvent(0))
    expect(page.data).toMatchObject({ editingIndex: 0, selected: '纪念日', showDate: true, year: '2021' })
    page.save()
    expect(request.mock.calls[0][0].data.dates).toEqual([{ kind: '纪念日', calendar: 'solar', month: 10, day: 20, year: 2021, leap: false }])
  })
})

function updateApp(request = {}) {
  const callbacks: Record<string, () => void> = {}
  const manager = {
    onUpdateReady: vi.fn((cb: () => void) => { callbacks.ready = cb }),
    onUpdateFailed: vi.fn((cb: () => void) => { callbacks.failed = cb }),
    applyUpdate: vi.fn(),
  }
  const pages: Record<string, any>[] = []
  const wx = {
    getUpdateManager: () => manager,
    getAccountInfoSync: () => ({ miniProgram: { envVersion: 'release', version: '1.0.0' } }),
    switchTab: vi.fn(({ url }: { url: string }) => { pages.splice(0, pages.length, { route: url.slice(1) }) }),
    reLaunch: vi.fn(({ url }: { url: string }) => { pages.splice(0, pages.length, { route: url.slice(1) }) }),
  }
  const app = instance(loadDefinition('miniprogram/app.js', { './config': {}, './utils/session': {}, './utils/request': request },
    wx, undefined, pages))
  app.globalData = { ...app.globalData }
  app.bindUpdateManager()
  const page = instance(loadDefinition('miniprogram/pages/force-update/force-update.js', {},
    { getUpdateManager: () => manager }, app))
  page.route = 'pages/force-update/force-update'
  return { app, page, pages, manager, callbacks, wx }
}

describe('强制更新下载事件', () => {
  it('页面已显示后下载失败，立即展示失败状态；重新检查仍保留失败状态', () => {
    const { app, page, pages, callbacks } = updateApp()
    pages.push(page)
    page.onShow()
    expect(page.data.failed).toBe(false)
    callbacks.failed()
    expect(app.globalData.updateFailed).toBe(true)
    expect(page.data.failed).toBe(true)
    app.checkClient = vi.fn()
    page.retry()
    expect(app.globalData.updateFailed).toBe(true)
    expect(page.data.failed).toBe(true)
    expect(app.checkClient).toHaveBeenCalledOnce()
  })

  it.each([true, false])('重新检查门槛为 %s 时，失败提示保留，只有门槛解除才离开更新页', async (required) => {
    const check = deferred<unknown>()
    const get = vi.fn(() => check.promise)
    const { app, page, pages, manager, callbacks, wx } = updateApp({ get })
    pages.push(page)
    app.globalData.updateRequired = true
    callbacks.failed()
    const checking = page.retry()
    expect(page.data.failed).toBe(true)
    expect(app.globalData.updateFailed).toBe(true)
    check.resolve({ update_required: required })
    await checking
    expect(get).toHaveBeenCalledWith('/api/v1/app/client?version=1.0.0', null, { withLedger: false })
    expect(app.globalData.updateRequired).toBe(required)
    expect(app.globalData.updateFailed).toBe(true)
    expect(page.data.failed).toBe(true)
    expect(pages[0].route).toBe(required ? 'pages/force-update/force-update' : 'pages/home/home')
    expect(wx.switchTab).toHaveBeenCalledTimes(required ? 0 : 1)
    expect(manager.applyUpdate).not.toHaveBeenCalled()
  })

  it('重新检查请求失败时仍展示下载失败和恢复入口', async () => {
    const get = vi.fn().mockRejectedValue(new Error('网络不可用'))
    const { app, page, pages, callbacks, wx } = updateApp({ get })
    pages.push(page)
    app.globalData.updateRequired = true
    callbacks.failed()
    await page.retry()
    expect(app.globalData).toMatchObject({ updateRequired: true, updateFailed: true })
    expect(page.data.failed).toBe(true)
    expect(wx.switchTab).not.toHaveBeenCalled()
    expect(pages[0].route).toBe('pages/force-update/force-update')
  })

  it('新包已经就绪时重新检查只应用更新，不再请求门槛', () => {
    const { app, page, manager } = updateApp()
    app.globalData.updateReady = true
    app.checkClient = vi.fn()
    page.retry()
    expect(manager.applyUpdate).toHaveBeenCalledOnce()
    expect(app.checkClient).not.toHaveBeenCalled()
  })

  it('失败后真正收到就绪事件时清除全局失败标记并自动应用更新', () => {
    const { app, page, pages, callbacks, manager } = updateApp()
    pages.push(page)
    app.globalData.updateRequired = true
    callbacks.failed()
    expect(page.data.failed).toBe(true)
    callbacks.ready()
    expect(app.globalData).toMatchObject({ updateReady: true, updateFailed: false })
    expect(manager.applyUpdate).toHaveBeenCalledOnce()
  })

  it('页面打开前下载失败，进入时读取失败状态', () => {
    const { app, page, callbacks } = updateApp()
    callbacks.failed()
    expect(app.globalData.updateFailed).toBe(true)
    page.onShow()
    expect(page.data.failed).toBe(true)
  })

  it('普通页面不接收更新页状态；更新就绪仍自动应用且不会重复绑定', () => {
    const { app, pages, callbacks, manager } = updateApp()
    const ordinary = { route: 'pages/home/home', setData: vi.fn() }
    pages.push(ordinary)
    callbacks.failed()
    expect(ordinary.setData).not.toHaveBeenCalled()
    app.globalData.updateRequired = true
    callbacks.ready()
    expect(app.globalData).toMatchObject({ updateReady: true, updateFailed: false })
    expect(manager.applyUpdate).toHaveBeenCalledOnce()
    app.bindUpdateManager()
    expect(manager.onUpdateReady).toHaveBeenCalledOnce()
    expect(manager.onUpdateFailed).toHaveBeenCalledOnce()
  })
})
