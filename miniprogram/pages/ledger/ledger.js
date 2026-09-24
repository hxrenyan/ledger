/**
 * 账本与成员。
 *
 * 账本列表来自会话缓存（登录 / /me 时会刷新）；成员与邀请码要单独拉
 * GET /members —— 邀请码只有账本主（owner）看得到，且可以重置。
 *
 * 切换账本只改本地当前账本 id，之后所有请求都会带上新的 X-Ledger-Id。
 */

const request = require('../../utils/request')
const session = require('../../utils/session')
const ui = require('../../utils/ui')

Page({
  data: {
    ledgers: [],
    members: [],
    inviteCode: '',
    ledgerName: '',
    isOwner: false,
    loading: true,
  },

  onShow() {
    if (!session.ensure()) return
    this.renderLedgers()
    this.loadMembers()
  },

  renderLedgers() {
    const current = session.getLedgerId()
    this.setData({
      ledgers: session.getLedgers().map((l) => ({
        id: l.id,
        name: l.name,
        roleText: l.role === 'owner' ? '我的' : '共享',
        on: l.id === current,
      })),
    })
  },

  loadMembers() {
    this.setData({ loading: true })
    return request
      .get('/api/v1/members')
      .then((res) => {
        const me = session.getUser() || {}
        this.setData({
          loading: false,
          ledgerName: (res && res.name) || '',
          inviteCode: (res && res.invite_code) || '',
          members: ((res && res.items) || []).map((m) => ({
            userId: m.user_id,
            name: m.nickname || m.username,
            initial: (m.nickname || m.username || '?').slice(0, 1),
            roleText: m.role === 'owner' ? '账本主' : '成员',
            isOwner: m.role === 'owner',
            isMe: m.user_id === me.id,
          })),
        })
        const ledger = session.currentLedger()
        this.setData({
          isOwner: !!(ledger && ledger.role === 'owner'),
        })
      })
      .catch((err) => {
        this.setData({ loading: false })
        ui.fail(err, '成员加载失败')
      })
  },

  switchLedger(e) {
    const id = require('../../utils/id').toId(e.currentTarget.dataset.id)
    if (!id || id === session.getLedgerId()) return
    session.setLedger(id)
    this.renderLedgers()
    this.loadMembers()
    ui.toast('已切换账本')
  },

  create() {
    ui.prompt({ title: '新账本名称', placeholder: '比如：家庭账本' }).then((name) => {
      if (name == null || !name) return
      ui.withLoading('创建中', () => request.post('/api/v1/ledgers', { name: name }, { withLedger: false }))
        .then((ledger) => {
          return request.get('/api/v1/me').then((body) => {
            session.apply(body)
            session.setLedger(ledger.id)
            this.renderLedgers()
            this.loadMembers()
          })
        })
        .catch((err) => ui.fail(err, '创建失败'))
    })
  },

  join() {
    ui.prompt({ title: '邀请码', placeholder: '向对方要 6 位邀请码' }).then((code) => {
      if (code == null || !code) return
      ui.withLoading('加入中', () =>
        request.post('/api/v1/ledgers/join', { code: code.toUpperCase() }, { withLedger: false }),
      )
        .then((ledger) => {
          return request.get('/api/v1/me').then((body) => {
            session.apply(body)
            session.setLedger(ledger.id)
            this.renderLedgers()
            this.loadMembers()
            ui.ok('已加入')
          })
        })
        .catch((err) => ui.fail(err, '加入失败'))
    })
  },

  rename() {
    if (!this.data.isOwner) {
      ui.toast('只有账本主能改名')
      return
    }
    ui.prompt({ title: '账本名称', value: this.data.ledgerName }).then((name) => {
      if (name == null || !name) return
      ui.withLoading('保存中', () => request.request({ path: '/api/v1/ledger', method: 'PATCH', data: { name: name } }))
        .then(() => request.get('/api/v1/me'))
        .then((body) => {
          session.apply(body)
          this.renderLedgers()
          this.loadMembers()
        })
        .catch((err) => ui.fail(err, '改名失败'))
    })
  },

  copyInvite() {
    if (!this.data.inviteCode) return
    wx.setClipboardData({
      data: this.data.inviteCode,
      success: () => ui.ok('邀请码已复制'),
    })
  },

  rotate() {
    ui.confirm('重置后旧邀请码立即失效，已经加入的成员不受影响。').then((yes) => {
      if (!yes) return
      ui.withLoading('重置中', () => request.post('/api/v1/invite/rotate', {}))
        .then((res) => {
          this.setData({ inviteCode: (res && res.invite_code) || '' })
          ui.ok('已重置')
        })
        .catch((err) => ui.fail(err, '重置失败'))
    })
  },

  onMember(e) {
    if (!this.data.isOwner) return
    const userId = require('../../utils/id').toId(e.currentTarget.dataset.user)
    const member = this.data.members.find((m) => m.userId === userId)
    if (!member || member.isMe) return
    if (member.isOwner) {
      ui.toast('不能移除账本主')
      return
    }
    ui.confirm('把「' + member.name + '」移出这个账本？他记的流水会留在账本里。').then((yes) => {
      if (!yes) return
      ui.withLoading('移除中', () => request.del('/api/v1/members/' + userId))
        .then(() => this.loadMembers())
        .catch((err) => ui.fail(err, '移除失败'))
    })
  },
})
