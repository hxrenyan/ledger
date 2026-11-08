/** 临时记分：独立于账本，页面显示期间订阅房间版本。 */
const request = require('../../utils/request')
const session = require('../../utils/session')
const ui = require('../../utils/ui')
const OPTIONS = { withLedger: false }

function errorMessage(error) {
  if (error && /缺少账本/.test(error.message || '')) return '记分服务尚未更新；当前服务仍要求账本，请更新后端后重试。'
  return (error && error.message) || '请求失败'
}

function pad(value) { return value < 10 ? '0' + value : String(value) }
function timeText(at) {
  const date = new Date(at), now = new Date()
  const hm = pad(date.getHours()) + ':' + pad(date.getMinutes())
  return date.toDateString() === now.toDateString() ? hm : (date.getMonth() + 1) + '-' + date.getDate() + ' ' + hm
}

Page({
  data: { guest: false, rooms: [], room: null, entries: [], next: null, historyLoading: false, loading: false,
    error: '', playerCount: 0, totalScore: 0, transferPlayers: [], amounts: [1, 2, 5, 10, 20, 50, 100],
    fromPlayerId: '', toPlayerId: '', fromPlayerName: '', toPlayerName: '', delta: '', transferOpen: false,
    autoFocus: false, pending: false, proxy: false, saving: false, owner: false, userId: 0 },

  onLoad(query) {
    this.roomId = query && query.id ? Number(query.id) : null
    this.invitation = query && query.token ? { token: query.token } : null
  },
  onShow() {
    const currentToken = session.getToken()
    if (this.accountToken !== undefined && this.accountToken !== currentToken) {
      this.unsubscribe()
      this.pendingEntry = null
      this.roomId = null
      this.setData({ room: null, entries: [], next: null, historyLoading: false, rooms: [], transferOpen: false, fromPlayerId: '', toPlayerId: '', delta: '', saving: false, pending: false })
    }
    this.accountToken = currentToken
    this.visible = true
    this.generation = (this.generation || 0) + 1
    this.setData({ guest: !session.getToken(), userId: (session.getUser() || {}).id || 0 })
    if (!session.getToken()) return
    if (this.invitation) {
      this.join(this.invitation).then((ok) => { if (ok) this.invitation = null })
    } else if (this.roomId) this.loadRoom()
    else this.loadRooms()
  },
  onHide() { this.visible = false; this.generation++; this.unsubscribe() },
  onUnload() { this.visible = false; this.generation++; this.unsubscribe() },
  onReachBottom() {
    if (!this.data.room || !this.data.next || this.data.historyLoading) return Promise.resolve()
    return this.loadHistory(true).catch((e) => ui.fail(e))
  },
  unsubscribe() { const stop = this.stopSubscription; if (stop) stop(); this.stopSubscription = null },
  goLogin() { session.goLogin() },
  async loadRooms() {
    const generation = this.generation, token = session.getToken()
    this.setData({ loading: true, error: '' })
    try {
      const body = await request.get('/api/v1/score/rooms', null, OPTIONS)
      if (!this.visible || generation !== this.generation || token !== session.getToken()) return
      this.setData({ rooms: (body.items || []).map((room) => ({ ...room, playerCount: room.players.length })), loading: false })
    } catch (e) { if (this.visible && generation === this.generation) this.setData({ loading: false, error: errorMessage(e) }) }
  },
  async createRoom() {
    const generation = this.generation, token = session.getToken()
    const raw = await ui.prompt({ title: '添加其他玩家', placeholder: '可留空；用逗号分隔，如：张三,李四', confirmText: '创建' })
    if (raw === null) return
    const players = raw.split(/[,，、\n]/).map((value) => value.trim()).filter(Boolean)
    try {
      const room = await request.post('/api/v1/score/rooms', { players }, OPTIONS)
      if (!this.visible || generation !== this.generation || token !== session.getToken()) return
      this.roomId = room.id
      await this.loadRoom()
    } catch (e) { ui.fail(e); if (e.status === 409) this.loadRooms() }
  },
  async joinCode() {
    const code = await ui.prompt({ title: '加入记分', placeholder: '输入10位邀请码' })
    if (code) await this.join({ code })
  },
  async join(invitation) {
    const generation = this.generation, token = session.getToken()
    try {
      const room = await request.post('/api/v1/score/join', invitation, OPTIONS)
      if (!this.visible || generation !== this.generation || token !== session.getToken()) return false
      this.roomId = room.id
      await this.loadRoom()
      return true
    } catch (e) { ui.fail(e); this.setData({ error: e.message || '加入失败' }); return false }
  },
  openRoom(e) { this.unsubscribe(); this.generation++; this.roomId = Number(e.currentTarget.dataset.id); this.loadRoom() },
  async loadRoom() {
    const generation = this.generation, token = session.getToken(), id = this.roomId
    this.setData({ loading: true, error: '' })
    try {
      const room = await request.get('/api/v1/score/rooms/' + id, null, OPTIONS)
      if (!this.visible || generation !== this.generation || token !== session.getToken() || id !== this.roomId) return
      this.applyRoom(room)
      await this.ensureOwnerIdentity(room)
      await this.loadHistory(false)
      this.subscribeRoom()
    } catch (e) { if (this.visible && generation === this.generation) this.setData({ loading: false, error: errorMessage(e) }) }
  },
  /** 房主尚无本人身份（旧后端建的房间）时，借邀请凭证重新加入自动补建；每个房间只尝试一次，失败不打断。 */
  async ensureOwnerIdentity(room) {
    const userId = (session.getUser() || {}).id
    if (room.owner_id !== userId || room.status !== 'active' || !room.invite_token || room.players.length >= 10
      || room.players.some((player) => player.user_id === userId)) return
    this.identityTried = this.identityTried || {}
    if (this.identityTried[room.id]) return
    this.identityTried[room.id] = true
    const id = this.roomId, generation = this.generation, token = session.getToken()
    try {
      const next = await request.post('/api/v1/score/join', { token: room.invite_token }, OPTIONS)
      if (!this.visible || id !== this.roomId || generation !== this.generation || token !== session.getToken()) return
      if (next.rev >= this.data.room.rev) this.applyRoom(next)
    } catch (e) { /* 保留代转可用，房主仍可在「···」里认领身份 */ }
  },
  applyRoom(room) {
    this.setData({ room, playerCount: room.players.length, totalScore: room.players.reduce((sum, player) => sum + (Number(player.score) || 0), 0), transferPlayers: room.players.filter((player) => !player.disabled), owner: room.owner_id === (session.getUser() || {}).id, loading: false, error: '',
      ...(room.status !== 'active' ? { transferOpen: false, fromPlayerId: '', toPlayerId: '', delta: '' } : {}) })
  },
  subscribeRoom() {
    this.unsubscribe()
    const app = getApp()
    if (!app.heartbeat && !app.globalData.updateRequired) app.startHeartbeat()
    if (!app.heartbeat || !this.data.room) return
    const id = this.roomId, token = session.getToken(), generation = this.generation
    this.stopSubscription = app.heartbeat.subscribe('game:' + id, {
      rev: this.data.room.rev, interval: 5000,
      refresh: async ({ isCurrent }) => {
        try {
          const room = await request.get('/api/v1/score/rooms/' + id, null, { ...OPTIONS, silentAuth: true })
          if (!isCurrent() || !this.visible || generation !== this.generation || token !== session.getToken() || id !== this.roomId) return
          // 旧网络响应不能覆盖本机提交后已经应用的新版本；草稿保持原样。
          if (!this.data.room || room.rev >= this.data.room.rev) this.applyRoom(room)
          await this.loadHistory(false)
          return this.data.room.rev
        } catch (e) { if (this.visible && id === this.roomId) this.setData({ error: '同步暂不可用，将自动重试' }); throw e }
      },
      unavailable: () => { if (this.visible && id === this.roomId) this.setData({ room: null, transferOpen: false, error: '房间已过期或无法访问' }) },
    })
  },
  async loadHistory(append) {
    if (append && (this.data.historyLoading || !this.data.next)) return
    const ticket = this.historyTicket = (this.historyTicket || 0) + 1
    if (append) this.setData({ historyLoading: true })
    else this.setData({ historyLoading: false })
    const id = this.roomId, generation = this.generation, token = session.getToken()
    const query = append ? '?before=' + this.data.next : ''
    try {
      const body = await request.get('/api/v1/score/rooms/' + id + '/entries' + query, null, { ...OPTIONS, silentAuth: true })
      if (!this.visible || generation !== this.generation || token !== session.getToken() || id !== this.roomId || ticket !== this.historyTicket) return
      const items = (body.items || []).map((entry) => ({ ...entry,
        deltaText: entry.delta > 0 ? '+' + entry.delta : String(entry.delta),
        timeText: timeText(entry.created_at) }))
      this.setData({ entries: append ? this.data.entries.concat(items) : items, next: body.next })
    } finally {
      if (ticket === this.historyTicket) this.setData({ historyLoading: false })
    }
  },
  /** 转分入口：默认从本人转出，点玩家行即预选接收方；房主点「代转」（data-mode=proxy）才可指定他人转出。 */
  openTransfer(e) {
    if (this.data.saving || this.pendingEntry || !this.data.room || this.data.room.status !== 'active') return
    const players = this.data.transferPlayers
    if (players.length < 2) { ui.fail({ message: '至少需要两位可用玩家才能转分' }); return }
    const self = players.find((player) => player.user_id === this.data.userId)
    const dataset = (e && e.currentTarget && e.currentTarget.dataset) || {}
    let target = players.find((player) => player.id === dataset.id)
    if (dataset.id && !target) return
    const proxy = this.data.owner && dataset.mode === 'proxy'
    if (!proxy && !self) {
      // 转分从不展示转出方；房主还没有本人身份时先绑定，再继续本次转分。
      if (this.data.owner && !(e && e.retried)) this.bindSelf().then((ok) => { if (ok) this.openTransfer({ currentTarget: { dataset }, retried: true }) })
      else ui.fail({ message: '尚未创建你的身份，请重新通过邀请加入' })
      return
    }
    let from = proxy ? null : self
    if (proxy) {
      const rest = players.filter((player) => !target || player.id !== target.id)
      from = rest.length === 1 ? rest[0] : null
    } else if (target && target.id === self.id) target = null
    if (!target) {
      const rest = players.filter((player) => !from || player.id !== from.id)
      target = rest.length === 1 ? rest[0] : null
    }
    this.setData({ transferOpen: true, proxy, delta: '', autoFocus: !!(from && target),
      fromPlayerId: from ? from.id : '', fromPlayerName: from ? from.name : '',
      toPlayerId: target ? target.id : '', toPlayerName: target ? target.name : '' })
  },
  /** 房主绑定本人身份：认领一位未认领玩家，或用昵称新增自己（操作菜单最多 6 项）。 */
  async bindSelf() {
    const user = session.getUser() || {}
    const myName = [...String(user.nickname || user.username || '我').trim()].slice(0, 24).join('') || '我'
    const free = this.data.room.players.filter((player) => player.user_id == null && !player.disabled)
    const canAdd = this.data.playerCount < 10 && !this.data.room.players.some((player) => player.name === myName)
    const choices = (canAdd ? [{ name: '新增我：' + myName }] : []).concat(free).slice(0, 6)
    if (!choices.length) { ui.fail({ message: '玩家已满，请先删除一位未认领玩家' }); return false }
    ui.toast('先选择你是哪位玩家')
    const index = await ui.actions(choices.map((choice) => choice.name))
    const choice = choices[index]
    if (!choice) return false
    let player = choice.id ? choice : null
    if (!player) {
      const room = await this.action('/players', { name: myName })
      player = room && room.players.find((p) => p.name === myName && p.user_id == null)
    }
    return !!(player && await this.action('/players/' + player.id + '/claim', {}))
  },
  /** 代转时选转出方；选中当前接收方时两者互换，免去先取消再选。 */
  pickFrom(e) {
    if (!this.data.owner || !this.data.proxy || this.data.saving || this.pendingEntry) return
    const player = this.data.transferPlayers.find((p) => p.id === e.currentTarget.dataset.id)
    if (!player) return
    const swap = player.id === this.data.toPlayerId
    this.setData({ fromPlayerId: player.id, fromPlayerName: player.name,
      ...(swap ? { toPlayerId: this.data.fromPlayerId, toPlayerName: this.data.fromPlayerName } : {}) })
  },
  pickTo(e) {
    if (this.data.saving || this.pendingEntry) return
    const player = this.data.transferPlayers.find((p) => p.id === e.currentTarget.dataset.id)
    if (!player) return
    if (player.id === this.data.fromPlayerId) {
      if (!this.data.proxy) { ui.fail({ message: '不能转给自己' }); return }
      this.setData({ toPlayerId: player.id, toPlayerName: player.name,
        fromPlayerId: this.data.toPlayerId, fromPlayerName: this.data.toPlayerName })
      return
    }
    this.setData({ toPlayerId: player.id, toPlayerName: player.name })
  },
  quickAmount(e) { if (!this.data.saving && !this.pendingEntry) this.setData({ delta: String(e.currentTarget.dataset.value) }) },
  noop() {},
  inputDelta(e) { if (!this.data.saving && !this.pendingEntry) this.setData({ delta: e.detail.value }) },
  closeEntry() {
    if (this.pendingEntry) { ui.fail({ message: '上一笔结果待确认，请先重试确认' }); return }
    if (!this.data.saving) this.setData({ transferOpen: false, delta: '' })
  },
  async saveEntry() {
    if (this.data.saving) return
    const delta = Number(this.data.delta)
    if (!Number.isSafeInteger(delta) || delta <= 0 || delta > 1000000) { ui.fail({ message: '请输入正整数，最多1000000分' }); return }
    if (!this.data.fromPlayerId || !this.data.toPlayerId || this.data.fromPlayerId === this.data.toPlayerId) {
      ui.fail({ message: '请选择不同的转出方和接收方' }); return
    }
    const id = this.roomId, token = session.getToken(), generation = this.generation
    if (!this.pendingEntry) this.pendingEntry = { to_player_id: this.data.toPlayerId, delta,
      ...(this.data.owner ? { from_player_id: this.data.fromPlayerId } : {}),
      request_id: 'mp-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12) }
    this.setData({ saving: true })
    try {
      const body = await request.post('/api/v1/score/rooms/' + id + '/entries', this.pendingEntry, OPTIONS)
      if (!this.visible || id !== this.roomId || token !== session.getToken() || generation !== this.generation) return
      this.pendingEntry = null
      this.setData({ pending: false })
      if (body.room.rev >= this.data.room.rev) this.applyRoom(body.room)
      this.setData({ transferOpen: false, delta: '' })
      if (getApp().heartbeat) getApp().heartbeat.markSynced('game:' + id, this.data.room.rev)
      await this.loadHistory(false)
    } catch (e) {
      if (e.status && e.status !== 0) this.pendingEntry = null
      this.setData({ pending: !!this.pendingEntry })
      ui.fail({ message: this.pendingEntry ? '结果待确认，请点击重试；请勿另记一笔' : e.message })
    } finally {
      if (id === this.roomId && generation === this.generation && token === session.getToken()) this.setData({ saving: false })
    }
  },
  async claim(e) { await this.action('/players/' + e.currentTarget.dataset.id + '/claim', {}) },
  async addPlayer() { const name = await ui.prompt({ title: '新增玩家', placeholder: '最多10位玩家' }); if (name) await this.action('/players', { name }) },
  async managePlayer(e) {
    const player = this.data.room.players.find((p) => p.id === e.currentTarget.dataset.id)
    const actions = ['修改名称', player.disabled ? '启用玩家' : '停用玩家']
    if (player.user_id == null && player.score === 0) actions.push('删除未认领玩家')
    // 旧房间房主没有本人身份时，可直接认领一位未认领玩家。
    const canClaim = player.user_id == null && !player.disabled && !this.data.room.players.some((p) => p.user_id === this.data.userId)
    if (canClaim) actions.push('设为我的身份')
    const index = await ui.actions(actions)
    if (canClaim && index === actions.length - 1) { await this.action('/players/' + player.id + '/claim', {}); return }
    let body
    if (index === 0) { const name = await ui.prompt({ title: '玩家名称', value: player.name }); if (!name) return; body = { name } }
    else if (index === 1) body = { disabled: !player.disabled }
    else if (index === 2 && player.user_id == null) {
      if (await ui.confirm('删除后玩家不再显示，历史记录仍保留。', '删除未认领玩家')) {
        await this.action('/players/' + player.id, {}, 'DELETE')
      }
      return
    } else return
    await this.action('/players/' + player.id, body, 'PATCH')
  },
  async action(suffix, body, method) {
    const id = this.roomId, token = session.getToken(), generation = this.generation
    try {
      const room = await request.request({ path: '/api/v1/score/rooms/' + this.roomId + suffix, method: method || 'POST', data: body, withLedger: false })
      if (!this.visible || id !== this.roomId || token !== session.getToken() || generation !== this.generation) return
      if (!this.data.room || room.rev >= this.data.room.rev) this.applyRoom(room)
      this.subscribeRoom()
      return room
    } catch (e) { if (this.visible && id === this.roomId && generation === this.generation && token === session.getToken()) ui.fail(e) }
  },
  async roomMenu() {
    const room = this.data.room
    if (!room) return
    const items = []
    if (room.status === 'active' && this.data.owner) {
      if (this.data.playerCount < 10) items.push(['添加玩家', () => this.addPlayer()])
      items.push(['重置邀请', () => this.resetInvite()], ['结束房间', () => this.endRoom()])
    } else if (room.status === 'active') items.push(['退出房间', () => this.leaveRoom()])
    items.push(['返回房间列表', () => this.backToList()])
    const index = await ui.actions(items.map((item) => item[0]))
    if (items[index]) await items[index][1]()
  },
  copyCode() { wx.setClipboardData({ data: this.data.room.invite_code }) },
  async resetInvite() { if (await ui.confirm('旧链接和邀请码将失效，已有成员不受影响。', '重置邀请')) await this.action('/invite/reset', {}) },
  async endRoom() { if (await ui.confirm('结束后不可继续记分，结果保留7天。', '结束记分')) await this.action('/end', {}) },
  async leaveRoom() {
    const id = this.roomId, token = session.getToken(), generation = this.generation
    if (!(await ui.confirm('退出后无法查看；玩家和分数仍保留。', '退出房间'))) return
    try {
      await request.post('/api/v1/score/rooms/' + id + '/leave', {}, OPTIONS)
      if (!this.visible || id !== this.roomId || token !== session.getToken() || generation !== this.generation) return
      this.backToList()
    } catch (e) { if (this.visible && id === this.roomId && token === session.getToken()) ui.fail(e) }
  },
  backToList() { if (this.pendingEntry) { ui.fail({ message: '上一笔结果待确认，请先重试确认' }); return } this.unsubscribe(); this.generation++; this.roomId = null; this.setData({ room: null, entries: [], next: null, historyLoading: false, transferOpen: false, fromPlayerId: '', toPlayerId: '', delta: '', error: '' }); this.loadRooms() },
  onShareAppMessage() {
    const room = this.data.room
    return room && room.status === 'active' ? { title: room.name + ' · 一起记分', path: '/pages/score/score?token=' + encodeURIComponent(room.invite_token) }
      : { title: '记分', path: '/pages/score/score' }
  },
})
