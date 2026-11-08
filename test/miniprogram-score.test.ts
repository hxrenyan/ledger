import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

function setup() {
  let def: any
  let token = 'user-token'
  let userId = 1
  let subscriber: any
  const stop = vi.fn()
  const heartbeat = { subscribe: vi.fn((_key, options) => { subscriber = options; return stop }), markSynced: vi.fn() }
  const room: any = { id: 1, owner_id: 1, rev: 1, status: 'active', players: [
    { id: 'p1', name: '张三', score: 0 }, { id: 'p2', name: '李四', score: 0 },
  ], members: [1] }
  const request = {
    get: vi.fn((path: string) => Promise.resolve(path.endsWith('/entries') ? { items: [], next: null } : structuredClone(room))),
    post: vi.fn(), request: vi.fn(),
  }
  const ui = { fail: vi.fn(), toast: vi.fn(), confirm: vi.fn().mockResolvedValue(true), actions: vi.fn().mockResolvedValue(2) }
  const session = { getToken: () => token, getUser: () => ({ id: userId }), goLogin: vi.fn() }
  const modules: any = { '../../utils/request': request, '../../utils/session': session, '../../utils/nav': {}, '../../utils/ui': ui }
  new Function('require', 'Page', 'getApp', 'wx', readFileSync(resolve('miniprogram/pages/score/score.js'), 'utf8'))(
    (name: string) => modules[name], (value: any) => { def = value }, () => ({ heartbeat, globalData: {} }), {})
  const page = { ...def, data: structuredClone(def.data), setData(patch: any) { Object.assign(this.data, patch) } }
  page.onLoad({ id: '1' })
  return { page, request, session, heartbeat, room, ui, stop, getSubscriber: () => subscriber,
    changeToken: (value: string) => { token = value }, setUserId: (value: number) => { userId = value } }
}

describe('记分页', () => {
  it('后端仍执行旧账本校验时，显示明确的服务版本提示', async () => {
    const { page, request } = setup()
    request.get.mockRejectedValue({ message: '缺少账本', status: 400 })
    page.onShow()
    await vi.waitFor(() => expect(page.data.error).toContain('记分服务尚未更新'))
  })

  it('进入订阅5秒资源、离开取消，更新不清输入草稿', async () => {
    const { page, heartbeat, request, room, stop, getSubscriber } = setup()
    page.onShow(); await vi.waitFor(() => expect(heartbeat.subscribe).toHaveBeenCalled())
    page.openTransfer({ currentTarget: { dataset: { mode: 'proxy' } } })
    expect(page.data.transferOpen).toBe(true)
    page.inputDelta({ detail: { value: '5' } })
    request.get.mockImplementation((path: string) => Promise.resolve(path.endsWith('/entries') ? { items: [], next: null } : { ...room, rev: 2 }))
    const rev = await getSubscriber().refresh({ isCurrent: () => true })
    expect(rev).toBe(2)
    expect(page.data.delta).toBe('5')
    expect(heartbeat.subscribe.mock.calls[0][1].interval).toBe(5000)
    page.onHide(); expect(stop).toHaveBeenCalled()
  })

  it('普通成员只能从自动绑定身份给其他玩家转正分', async () => {
    const { page, request, room, setUserId } = setup()
    setUserId(2)
    room.players[1].user_id = 2
    page.visible = true
    page.generation = 1
    page.roomId = 1
    page.data.room = room
    page.data.userId = 2
    page.data.transferPlayers = room.players
    page.openTransfer({ currentTarget: { dataset: { id: 'p1' } } })
    expect(page.data.fromPlayerId).toBe('p2')
    expect(page.data.toPlayerId).toBe('p1')
    page.inputDelta({ detail: { value: '7' } })
    request.post.mockResolvedValue({ room: { ...room, rev: 2 } })
    await page.saveEntry()
    expect(request.post.mock.calls[0][1]).toMatchObject({ to_player_id: 'p1', delta: 7 })
    expect(request.post.mock.calls[0][1]).not.toHaveProperty('from_player_id')
  })

  it('超时保留操作号，重试沿用，不重复生成新操作', async () => {
    const { page, heartbeat, request, room } = setup()
    page.onShow(); await vi.waitFor(() => expect(heartbeat.subscribe).toHaveBeenCalled())
    page.data.owner = true
    page.openTransfer({ currentTarget: { dataset: { mode: 'proxy' } } })
    page.pickFrom({ currentTarget: { dataset: { id: 'p1' } } })
    page.pickTo({ currentTarget: { dataset: { id: 'p2' } } })
    page.inputDelta({ detail: { value: '10' } })
    request.post.mockRejectedValueOnce({ status: 0 })
    await page.saveEntry()
    const first = request.post.mock.calls[0][1]
    request.post.mockResolvedValue({ room: { ...room, rev: 2, players: [{ ...room.players[0], score: 10 }] } })
    await page.saveEntry()
    expect(request.post.mock.calls[1][1].request_id).toBe(first.request_id)
    expect(request.post.mock.calls[1][1]).toMatchObject({ from_player_id: 'p1', to_player_id: 'p2', delta: 10 })
    expect(page.data.room.players[0].score).toBe(10)
    expect(page.data.transferOpen).toBe(false)
    expect(page.data.pending).toBe(false)
  })

  it('房主默认本人转出，点代转按钮才可指定双方并互换', () => {
    const { page, room, ui } = setup()
    room.players.push({ id: 'p3', name: '王五', score: 0 })
    room.players[0].user_id = 1
    page.data.room = room
    page.data.owner = true
    page.data.userId = 1
    page.data.transferPlayers = room.players
    page.openTransfer({ currentTarget: { dataset: { id: 'p3' } } })
    expect(page.data).toMatchObject({ proxy: false, fromPlayerId: 'p1', toPlayerId: 'p3' })
    page.pickFrom({ currentTarget: { dataset: { id: 'p2' } } })
    expect(page.data.fromPlayerId).toBe('p1')
    page.pickTo({ currentTarget: { dataset: { id: 'p1' } } })
    expect(ui.fail).toHaveBeenCalledWith({ message: '不能转给自己' })
    page.data.transferOpen = false
    page.openTransfer({ currentTarget: { dataset: { mode: 'proxy' } } })
    expect(page.data).toMatchObject({ proxy: true, fromPlayerId: '', toPlayerId: '' })
    page.pickFrom({ currentTarget: { dataset: { id: 'p2' } } })
    page.pickTo({ currentTarget: { dataset: { id: 'p3' } } })
    expect(page.data).toMatchObject({ fromPlayerId: 'p2', toPlayerId: 'p3' })
    page.pickFrom({ currentTarget: { dataset: { id: 'p3' } } })
    expect(page.data).toMatchObject({ fromPlayerId: 'p3', toPlayerId: 'p2' })
  })

  it('房主无本人身份点转分：先绑定身份，再只选转给谁，不出现转出方', async () => {
    const { page, room, request, ui } = setup()
    room.players.push({ id: 'p3', name: '王五', score: 0 })
    page.visible = true
    page.generation = 1
    page.roomId = 1
    page.data.room = room
    page.data.owner = true
    page.data.userId = 1
    page.data.playerCount = 3
    page.data.transferPlayers = room.players
    ui.actions.mockResolvedValue(1)
    const claimed = { ...room, rev: 2, players: room.players.map((p: any) => p.id === 'p1' ? { ...p, user_id: 1 } : p) }
    request.request.mockResolvedValue(claimed)
    page.openTransfer({ currentTarget: { dataset: { id: 'p3' } } })
    await vi.waitFor(() => expect(page.data.transferOpen).toBe(true))
    expect(ui.actions.mock.calls[0][0][1]).toBe('张三')
    expect(request.request).toHaveBeenCalledWith({ path: '/api/v1/score/rooms/1/players/p1/claim', method: 'POST', data: {}, withLedger: false })
    expect(page.data).toMatchObject({ proxy: false, fromPlayerId: 'p1', toPlayerId: 'p3' })
  })

  it('房主无本人身份可新增自己后转分；代转不需要身份', async () => {
    const { page, room, request, ui } = setup()
    page.visible = true
    page.generation = 1
    page.roomId = 1
    page.data.room = room
    page.data.owner = true
    page.data.userId = 1
    page.data.playerCount = 2
    page.data.transferPlayers = room.players
    page.openTransfer({ currentTarget: { dataset: { mode: 'proxy' } } })
    expect(page.data).toMatchObject({ transferOpen: true, proxy: true })
    expect(ui.actions).not.toHaveBeenCalled()
    page.data.transferOpen = false
    ui.actions.mockResolvedValue(0)
    const added = { ...room, rev: 2, players: [...room.players, { id: 'p9', name: '我', score: 0 }] }
    const bound = { ...added, rev: 3, players: added.players.map((p: any) => p.id === 'p9' ? { ...p, user_id: 1 } : p) }
    request.request.mockResolvedValueOnce(added).mockResolvedValueOnce(bound)
    page.openTransfer()
    await vi.waitFor(() => expect(page.data.transferOpen).toBe(true))
    expect(request.request.mock.calls[0][0]).toMatchObject({ path: '/api/v1/score/rooms/1/players', data: { name: '我' } })
    expect(request.request.mock.calls[1][0].path).toBe('/api/v1/score/rooms/1/players/p9/claim')
    expect(page.data).toMatchObject({ proxy: false, fromPlayerId: 'p9' })
  })

  it('房主进入没有本人身份的房间时自动补建一次', async () => {
    const { page, request, room } = setup()
    room.invite_token = 'room-token'
    const bound = { ...room, rev: 2, players: [...room.players, { id: 'p9', name: '房主', score: 0, user_id: 1 }] }
    request.post.mockResolvedValue(bound)
    page.onShow()
    await vi.waitFor(() => expect(page.data.room.rev).toBe(2))
    expect(request.post).toHaveBeenCalledWith('/api/v1/score/join', { token: 'room-token' }, { withLedger: false })
    page.onShow()
    await vi.waitFor(() => expect(request.get).toHaveBeenCalledTimes(4))
    expect(request.post).toHaveBeenCalledOnce()
  })

  it('普通成员不能转给自己，快捷分数直接填入', () => {
    const { page, room, ui } = setup()
    room.players[1].user_id = 2
    page.data.room = room
    page.data.userId = 2
    page.data.transferPlayers = room.players
    page.openTransfer()
    expect(page.data.fromPlayerId).toBe('p2')
    expect(page.data.toPlayerId).toBe('p1')
    page.pickTo({ currentTarget: { dataset: { id: 'p2' } } })
    expect(ui.fail).toHaveBeenCalled()
    expect(page.data.toPlayerId).toBe('p1')
    page.quickAmount({ currentTarget: { dataset: { value: 20 } } })
    expect(page.data.delta).toBe('20')
  })

  it('房主菜单收纳低频操作', async () => {
    const { page, room, ui } = setup()
    page.data.room = room
    page.data.owner = true
    page.data.playerCount = 2
    ui.actions.mockResolvedValue(-1)
    await page.roomMenu()
    expect(ui.actions).toHaveBeenCalledWith(['添加玩家', '重置邀请', '结束房间', '返回房间列表'])
    page.data.owner = false
    await page.roomMenu()
    expect(ui.actions).toHaveBeenLastCalledWith(['退出房间', '返回房间列表'])
  })

  it('房主删除无认领且分数为零的玩家', async () => {
    const { page, request, room, ui } = setup()
    page.visible = true
    page.generation = 1
    page.roomId = 1
    page.data.room = room
    page.data.owner = true
    page.data.userId = 1
    room.players[0].user_id = 1
    request.request.mockResolvedValue(room)
    await page.managePlayer({ currentTarget: { dataset: { id: 'p2' } } })
    expect(ui.actions).toHaveBeenCalledWith(['修改名称', '停用玩家', '删除未认领玩家'])
    expect(request.request).toHaveBeenCalledWith({ path: '/api/v1/score/rooms/1/players/p2', method: 'DELETE', data: {}, withLedger: false })
  })

  it('滚到页面底部按游标加载下一页，加载中忽略重复触发', async () => {
    const { page, request, room } = setup()
    page.visible = true
    page.generation = 1
    page.roomId = 1
    page.data.room = room
    page.data.next = 20
    page.data.entries = [{ id: 21, player_name: '张三' }]
    let resolvePage!: (value: any) => void
    request.get.mockImplementation((path: string) => path.includes('/entries')
      ? new Promise((resolve) => { resolvePage = resolve })
      : Promise.resolve(room))

    const first = page.onReachBottom()
    expect(page.data.historyLoading).toBe(true)
    const duplicate = page.onReachBottom()
    expect(request.get).toHaveBeenCalledOnce()
    expect(request.get).toHaveBeenCalledWith('/api/v1/score/rooms/1/entries?before=20', null,
      { withLedger: false, silentAuth: true })

    resolvePage({ items: [{ id: 20, player_name: '李四', delta: 5, score_after: 5, created_at: 1 }], next: null })
    await Promise.all([first, duplicate])
    expect(page.data.entries.map((entry: any) => entry.id)).toEqual([21, 20])
    expect(page.data.next).toBeNull()
    expect(page.data.historyLoading).toBe(false)
  })

  it('旧房间、旧账号响应不能覆盖当前页面', async () => {
    const { page, request, changeToken } = setup()
    let resolve!: (value: any) => void
    request.get.mockImplementation(() => new Promise((done) => { resolve = done }))
    page.onShow()
    changeToken('other-token')
    resolve({ id: 1, rev: 1, players: [] })
    await Promise.resolve(); await Promise.resolve()
    expect(page.data.room).toBeNull()
  })

  it('分享邀请未登录不丢失，登录后继续加入', async () => {
    const { page, request, session, changeToken, room } = setup()
    page.onLoad({ token: 'invite-token' }); changeToken('')
    page.onShow(); page.goLogin()
    expect(session.goLogin).toHaveBeenCalledOnce()
    expect(request.post).not.toHaveBeenCalled()
    changeToken('new-token'); request.post.mockResolvedValue(room)
    page.onShow()
    await vi.waitFor(() => expect(request.post).toHaveBeenCalledWith('/api/v1/score/join', { token: 'invite-token' }, { withLedger: false }))
  })
})
