import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createApp } from '../src/app.ts'
import { ensureMigrated } from '../src/db/migrate.ts'
import { createSqliteDb } from '../src/db/sqlite.ts'

const root = resolve(__dirname, '..')

function load(file: string, wx: Record<string, any>, modules: Record<string, any> = {}): any {
  const mod = { exports: {} }
  let definition: any
  new Function('require', 'module', 'exports', 'wx', 'Component', 'Page', readFileSync(resolve(root, file), 'utf8'))(
    (name: string) => modules[name] || load(resolve(dirname(file), name + '.js'), wx, modules),
    mod, mod.exports, wx, (def: any) => { definition = def }, (def: any) => { definition = def },
  )
  if (!definition) return mod.exports
  const instance = { ...definition, ...definition.methods, data: structuredClone(definition.data), triggerEvent: vi.fn() }
  instance.setData = (patch: any, callback?: () => void) => { Object.assign(instance.data, patch); callback?.() }
  return instance
}

function storage() {
  const values = new Map<string, any>()
  return {
    getStorageSync: (key: string) => values.get(key),
    setStorageSync: vi.fn((key: string, value: any) => values.set(key, value)),
  }
}

describe('记录人展示偏好', () => {
  it('默认仅多人显示；按账号保存，单人始终隐藏', () => {
    const wx = storage()
    wx.setStorageSync('ledger.user', { id: 1 })
    const session = load('miniprogram/utils/session.js', wx, { './nav': {} })
    expect(session.showRecorder(1)).toBe(false)
    expect(session.showRecorder(undefined)).toBe(false)
    expect(session.showRecorder(2)).toBe(true)
    session.setRecorderPreference(false)
    expect(session.showRecorder(2)).toBe(false)
    wx.setStorageSync('ledger.user', { id: 2 })
    expect(session.showRecorder(2)).toBe(true)
    wx.setStorageSync('ledger.user', { id: 1 })
    expect(session.recorderPreference()).toBe(false)
    session.setRecorderPreference(true)
    expect(session.showRecorder(1)).toBe(false)
  })

  it('明细、人情和联系人明细保留接口记录人，设置开关写入真实偏好', async () => {
    const wx = { ...storage(), setNavigationBarTitle: vi.fn() }
    wx.setStorageSync('ledger.user', { id: 1 })
    const session = load('miniprogram/utils/session.js', wx, { './nav': {} })
    const record = { id: 1, contact_id: 1, kind: 'give', amount_cents: 100, occurred_at: Date.now(), created_by_name: '家人' }
    const request = { get: vi.fn((url: string) => Promise.resolve(url.includes('/gifts') ? { member_count: 2, items: [record] } : { items: [{ id: 1, name: '朋友' }] })) }
    const modules = { '../../utils/session': session, '../../utils/request': request, '../../utils/nav': {}, '../../utils/ui': {} }
    const home = load('miniprogram/pages/home/home.js', wx, modules)
    expect(home.decorate({ ...record, kind: 'expense' }).recorder).toBe('家人')
    const favors = load('miniprogram/pages/favors/favors.js', wx, modules)
    expect(favors.decorate(record).recorder).toBe('家人')
    await favors.load()
    expect(favors.data.showRecorder).toBe(true)
    const person = load('miniprogram/pages/favor-person/favor-person.js', wx, modules)
    person.data.contactId = 1
    await person.load()
    expect(person.data.showRecorder).toBe(true)
    expect(person.data.items[0].recorder).toBe('家人')
    const settings = load('miniprogram/pages/settings/settings.js', wx, modules)
    settings.toggleRecorder({ detail: { value: false } })
    expect(settings.data.showRecorder).toBe(false)
    await favors.load()
    await person.load()
    expect(favors.data.showRecorder).toBe(false)
    expect(person.data.showRecorder).toBe(false)
  })
})

describe('可拖动快捷入口', () => {
  function floating(saved?: unknown) {
    const wx = { ...storage(), getWindowInfo: () => ({ windowWidth: 375, windowHeight: 650, screenHeight: 800, safeArea: { bottom: 766 } }) }
    if (saved !== undefined) wx.setStorageSync('ledger.floatingActions.position', saved)
    const component = load('miniprogram/components/floating-actions/floating-actions.js', wx)
    component.restorePosition()
    return { wx, component }
  }

  it('默认在可用区域右下角，点击派发添加', () => {
    const { component } = floating()
    expect(component.data.x).toBe(component.maxX)
    expect(component.data.y).toBe(component.maxY)
    component.startTouch({ touches: [{ clientX: 10, clientY: 10 }] })
    component.add()
    expect(component.triggerEvent.mock.calls).toEqual([['add']])
  })

  it('拖动不误触，位置归一化保存并在下次进入恢复', () => {
    const { wx, component } = floating()
    component.startTouch({ touches: [{ clientX: 10, clientY: 10 }] })
    component.moveTouch({ touches: [{ clientX: 80, clientY: 100 }] })
    component.changePosition({ detail: { source: 'touch', x: 40, y: 50 } })
    component.endTouch()
    component.add()
    expect(component.triggerEvent).not.toHaveBeenCalled()
    const saved = wx.getStorageSync('ledger.floatingActions.position')
    const next = floating(saved).component
    component.position = { x: 0, y: 0 }
    component.pageLifetimes.show.call(component)
    expect(component.data.x).toBeCloseTo(40)
    expect(component.data.y).toBeCloseTo(50)
    expect(next.data.x).toBeCloseTo(40)
    expect(next.data.y).toBeCloseTo(50)
    next.startTouch({ touches: [{ clientX: 1, clientY: 1 }] })
    next.add()
    expect(next.triggerEvent).toHaveBeenCalledWith('add')
  })

  it('异常缓存和越界坐标不让入口移出窗口，忽略程序性位置事件', () => {
    const { component } = floating({ x: Infinity, y: -2 })
    expect(component.data.x).toBe(component.maxX)
    expect(component.data.y).toBe(0)
    component.changePosition({ detail: { source: 'touch', x: -50, y: 9999 } })
    expect(component.position).toEqual({ x: 0, y: component.maxY })
    component.changePosition({ detail: { source: '', x: 100, y: 100 } })
    expect(component.position).toEqual({ x: 0, y: component.maxY })
  })
})

describe('设置与加号入口配置', () => {
  function setup() {
    const wx = { ...storage(), showToast: vi.fn(), getWindowInfo: () => ({ windowWidth: 375 }) }
    wx.setStorageSync('ledger.user', { id: 1 })
    wx.setStorageSync('ledger.token', 'test-token')
    const session = load('miniprogram/utils/session.js', wx, { './nav': {} })
    const nav = { go: vi.fn() }
    const modules = { '../../utils/session': session, '../../utils/nav': nav }
    const settings = load('miniprogram/pages/settings/settings.js', wx, modules)
    const home = load('miniprogram/pages/home/home.js', wx, modules)
    settings.onShow()
    return { wx, session, nav, settings, home }
  }

  it('默认顺序保持原样，隐藏和排序立即保存且按账号隔离', () => {
    const { wx, session, settings } = setup()
    expect(settings.data.actions.map((item: any) => item.type)).toEqual(['tx', 'gift', 'speak', 'note', 'import'])
    settings.toggleAction({ currentTarget: { dataset: { type: 'gift' } }, detail: { value: false } })
    settings.startDrag({ currentTarget: { dataset: { type: 'speak' } }, touches: [{ clientY: 200 }] })
    settings.moveDrag({ touches: [{ clientY: 152 }] })
    settings.endDrag()
    expect(session.availableAddActions(true, true).map((item: any) => item.type)).toEqual(['tx', 'speak', 'note', 'import'])
    expect(session.addActionPreference()[1].type).toBe('speak')
    settings.onShow()
    expect(settings.data.actions.find((item: any) => item.type === 'gift').enabled).toBe(false)
    wx.setStorageSync('ledger.user', { id: 2 })
    expect(session.addActionPreference().every((item: any) => item.enabled)).toBe(true)
    expect(session.addActionPreference()[1].type).toBe('gift')
  })

  it('至少保留一项；边界移动无效；损坏、重复及未知缓存被归一化', () => {
    const { wx, session, settings } = setup()
    session.setAddActionPreference(session.addActionPreference().map((item: any) => ({ ...item, enabled: item.type === 'tx' })))
    settings.toggleAction({ currentTarget: { dataset: { type: 'tx' } }, detail: { value: false } })
    expect(wx.showToast).toHaveBeenCalledWith({ title: '至少保留一个入口', icon: 'none' })
    expect(settings.data.actions[0].enabled).toBe(true)
    settings.startDrag({ currentTarget: { dataset: { type: 'tx' } }, touches: [{ clientY: 100 }] })
    settings.moveDrag({ touches: [{ clientY: -100 }] })
    settings.endDrag()
    expect(session.addActionPreference()[0].type).toBe('tx')
    wx.setStorageSync('ledger.addActions.1', [{ type: 'gift', enabled: false }, { type: 'gift' }, null, { type: 'unknown' }])
    const actions = session.addActionPreference()
    expect(actions).toHaveLength(5)
    expect(actions[0]).toMatchObject({ type: 'gift', enabled: false })
    expect(actions.filter((item: any) => item.type === 'gift')).toHaveLength(1)
    session.setAddActionPreference(actions.map((item: any) => ({ ...item, enabled: false })))
    expect(session.addActionPreference().some((item: any) => item.enabled)).toBe(true)
  })

  it('拖动跨多行、反向回拖，松手才保存且保留开关状态', () => {
    const { session, settings } = setup()
    settings.toggleAction({ currentTarget: { dataset: { type: 'gift' } }, detail: { value: false } })
    settings.startDrag({ currentTarget: { dataset: { type: 'gift' } }, touches: [{ clientY: 100 }] })
    settings.moveDrag({ touches: [{ clientY: 1000 }] })
    expect(settings.data.actions.map((item: any) => item.type)).toEqual(['tx', 'speak', 'note', 'import', 'gift'])
    expect(session.addActionPreference()[1].type).toBe('gift')
    settings.moveDrag({ touches: [{ clientY: 52 }] })
    expect(settings.data.actions[0].type).toBe('gift')
    expect(settings.data.dragOffset).toBe(0)
    settings.endDrag()
    expect(session.addActionPreference()[0]).toMatchObject({ type: 'gift', enabled: false })
    expect(settings.data.dragType).toBe('')
    settings.onShow()
    expect(settings.data.actions[0].type).toBe('gift')
  })

  it('触摸取消和页面离开撤销未保存排序；轻触、非法触摸不改变顺序', () => {
    const { session, settings } = setup()
    const original = session.addActionPreference()
    settings.startDrag({ currentTarget: { dataset: { type: 'tx' } }, touches: [] })
    settings.moveDrag({ touches: [{ clientY: 300 }] })
    settings.endDrag()
    expect(settings.data.actions).toEqual(original)
    settings.startDrag({ currentTarget: { dataset: { type: 'tx' } }, touches: [{ clientY: 100 }] })
    settings.moveDrag({ touches: [{ clientY: 110 }] })
    settings.endDrag()
    expect(session.addActionPreference()).toEqual(original)
    for (const cancel of ['cancelDrag', 'onHide']) {
      settings.startDrag({ currentTarget: { dataset: { type: 'tx' } }, touches: [{ clientY: 100 }] })
      settings.moveDrag({ touches: [{ clientY: 300 }] })
      settings[cancel]()
      expect(settings.data.actions).toEqual(original)
      expect(session.addActionPreference()).toEqual(original)
      expect(settings.data.dragType).toBe('')
    }
  })

  it.each(['tx', 'gift', 'speak', 'note', 'import'])('只启用 %s 时直接执行，不展开菜单', (type) => {
    const { session, nav, home } = setup()
    session.setAddActionPreference(session.addActionPreference().map((item: any) => ({ ...item, enabled: item.type === type })))
    home.openAdd()
    expect(home.data.showAdd).toBe(false)
    if (type === 'speak' || type === 'note') {
      expect(home.data.showVoice).toBe(true)
      expect(home.data.voiceTarget).toBe(type === 'note' ? 'note' : 'tx')
    } else if (type === 'import') {
      expect(nav.go).toHaveBeenCalledWith('import')
    } else {
      expect(nav.go).toHaveBeenCalledWith(type === 'tx' ? 'tx-form' : 'gift-form', {})
    }
  })

  it('多项按配置排序，过滤当前不可用能力；过滤后只剩一项同样直达', () => {
    const { session, home, nav } = setup()
    const actions = session.addActionPreference()
    session.setAddActionPreference([actions[2], actions[1], actions[0], actions[3], actions[4]])
    home.openAdd()
    expect(home.data.showAdd).toBe(true)
    expect(home.data.addItems.map((item: any) => item.type)).toEqual(['speak', 'gift', 'tx', 'note', 'import'])
    session.setAddActionPreference(actions.map((item: any) => ({ ...item, enabled: ['speak', 'tx'].includes(item.type) })))
    home.data.canAi = false
    home.openAdd()
    expect(nav.go).toHaveBeenCalledWith('tx-form', {})
    expect(home.data.showAdd).toBe(false)
    home.onAddSelect({ detail: { type: 'import' } })
    expect(nav.go).toHaveBeenCalledTimes(1)
  })

  it('唯一入口不可用时提示，不偷偷执行其他功能；游客点击仍先登录', () => {
    const { wx, session, home } = setup()
    session.setAddActionPreference(session.addActionPreference().map((item: any) => ({ ...item, enabled: item.type === 'note' })))
    home.data.canSpeak = false
    home.openAdd()
    expect(home.data.showAdd).toBe(false)
    expect(wx.showToast).toHaveBeenCalledWith(expect.objectContaining({ title: '所选入口暂不可用，请到设置调整' }))
    session.goLogin = vi.fn()
    wx.setStorageSync('ledger.token', '')
    home.openAdd()
    expect(session.goLogin).toHaveBeenCalledOnce()
  })

  it('设置从我的可访问，游客也可访问，记录人沿用旧缓存', () => {
    const { wx, session, nav, settings } = setup()
    session.setRecorderPreference(false)
    settings.onShow()
    expect(settings.data.showRecorder).toBe(false)
    wx.setStorageSync('ledger.token', '')
    const me = load('miniprogram/pages/me/me.js', wx, { '../../utils/session': session, '../../utils/nav': nav })
    me.go({ currentTarget: { dataset: { key: 'settings' } } })
    expect(nav.go).toHaveBeenCalledWith('settings')
  })
})

describe('记录人接口契约', () => {
  it('返回真实创建者、当前成员数，修改记录不改归属，离开和跨账本不串数据', async () => {
    const db = createSqliteDb(':memory:')
    await ensureMigrated(db)
    const app = createApp({ db, jwtSecret: 'test-secret-test-secret' })
    async function call(path: string, headers: Record<string, string> = {}, body?: unknown, method?: string) {
      const res = await app.request(path, { method: method || (body ? 'POST' : 'GET'), headers: { ...headers, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
      const result = await res.json() as any
      expect(res.status).toBeLessThan(300)
      return result
    }
    const owner = await call('/api/v1/auth/register', {}, { username: 'recowner', password: 'password1', nickname: '主人' })
    const guest = await call('/api/v1/auth/register', {}, { username: 'recguest', password: 'password1', nickname: '家人' })
    const headers = { authorization: `Bearer ${owner.token}`, 'x-ledger-id': String(owner.ledgers[0].id) }
    const guestHeaders = { authorization: `Bearer ${guest.token}`, 'x-ledger-id': String(owner.ledgers[0].id) }
    const list = '/api/v1/transactions'
    expect((await call(list, headers)).member_count).toBe(1)
    const members = await call('/api/v1/members', headers)
    await call('/api/v1/ledgers/join', { authorization: `Bearer ${guest.token}` }, { code: members.invite_code })
    const accounts = await call('/api/v1/accounts', headers)
    const categories = await call('/api/v1/categories', headers)
    const contact = await call('/api/v1/contacts', headers, { name: '朋友' })
    const transaction = await call(list, guestHeaders, { kind: 'expense', account_id: accounts.items[0].id, category_id: categories.items.find((c: any) => c.kind === 'expense').id, amount_cents: 100 })
    const gift = await call('/api/v1/gifts', guestHeaders, { kind: 'give', contact_id: contact.id, amount_cents: 200 })
    const transactions = await call(list, headers)
    expect(transactions.member_count).toBe(2)
    expect(transactions.items.find((row: any) => row.id === transaction.id).created_by_name).toBe('家人')
    const gifts = await call('/api/v1/gifts?contact_id=' + contact.id, headers)
    expect(gifts.member_count).toBe(2)
    expect(gifts.items.find((row: any) => row.id === gift.id).created_by_name).toBe('家人')
    await call('/api/v1/gifts/' + gift.id, headers, { kind: 'give', contact_id: contact.id, amount_cents: 300 }, 'PATCH')
    expect((await call('/api/v1/gifts', headers)).items[0].created_by_name).toBe('家人')
    const ownGuestHeaders = { ...guestHeaders, 'x-ledger-id': String(guest.ledgers[0].id) }
    expect((await call('/api/v1/gifts', ownGuestHeaders)).items).toHaveLength(0)
    expect((await call(list, ownGuestHeaders)).items).toHaveLength(0)
    await call('/api/v1/members/' + guest.user.id, headers, undefined, 'DELETE')
    expect((await call(list, headers)).member_count).toBe(1)
    expect((await call('/api/v1/gifts', headers)).member_count).toBe(1)
    expect((await call('/api/v1/gifts', headers)).items[0].created_by_name).toBe('家人')
    await db.run(`UPDATE users SET nickname = '   ' WHERE id = ?`, [guest.user.id])
    expect((await call('/api/v1/gifts', headers)).items[0].created_by_name).toBe('recguest')
    expect((await call(list, headers)).items[0].created_by_name).toBe('recguest')
    await db.run(`UPDATE gifts SET created_by = ? WHERE id = ?`, [999999, gift.id])
    expect((await call('/api/v1/gifts', headers)).items[0].created_by_name).toBe('未知记录人')
  })
})
