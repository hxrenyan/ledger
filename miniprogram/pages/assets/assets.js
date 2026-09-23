/**
 * 资产。
 *
 * 净资产 = 未归档账户的 current_cents 之和（服务端算好给 net_cents）。
 * 「改余额」是直接覆盖 current_cents，不是记一笔调整流水——这是账户的期初口径，
 * 和 web 端一致。
 */

const request = require('../../utils/request')
const session = require('../../utils/session')
const money = require('../../utils/money')
const ui = require('../../utils/ui')

const TYPES = [
  { value: 'cash', label: '现金' },
  { value: 'bank', label: '银行卡' },
  { value: 'alipay', label: '支付宝' },
  { value: 'wechat', label: '微信' },
  { value: 'credit', label: '信用卡' },
  { value: 'other', label: '其他' },
]

const TYPE_LABEL = {}
TYPES.forEach((t) => { TYPE_LABEL[t.value] = t.label })
const TYPE_KEYS = TYPES.map((t) => t.value)
const TYPE_NAMES = TYPES.map((t) => t.label)

Page({
  data: {
    netText: '0.00',
    netClass: 'income',
    items: [],
    archived: [],
    showArchived: false,
    loading: true,
  },

  onLoad() {
    this.setData({ typeNames: TYPE_NAMES })
  },

  onShow() {
    if (!session.ensure()) return
    this.load()
  },

  onPullDownRefresh() {
    this.load().then(() => wx.stopPullDownRefresh())
  },

  load() {
    this.setData({ loading: true })
    return request
      .get('/api/v1/accounts')
      .then((res) => {
        const items = (res && res.items) || []
        const net = Number(res && res.net_cents) || 0
        const shape = (a) => ({
          id: a.id,
          name: a.name,
          type: a.type,
          typeLabel: TYPE_LABEL[a.type] || '其他',
          archived: !!a.archived,
          balanceText: money.formatYuan(a.current_cents),
          balanceClass: a.current_cents < 0 ? 'expense' : '',
        })
        this.setData({
          loading: false,
          netText: money.formatYuan(net),
          netClass: net < 0 ? 'expense' : 'income',
          items: items.filter((a) => !a.archived).map(shape),
          archived: items.filter((a) => a.archived).map(shape),
        })
      })
      .catch((err) => {
        this.setData({ loading: false })
        ui.fail(err, '加载失败')
      })
  },

  toggleArchived() {
    this.setData({ showArchived: !this.data.showArchived })
  },

  /** 新增账户：名字 → 类型 → 期初余额，三步都用原生弹窗，不用自己搭浮层。 */
  addAccount() {
    ui.prompt({ title: '新增账户', placeholder: '账户名，比如：招行储蓄卡' }).then((name) => {
      if (name == null || !name) return
      ui.actions(TYPE_NAMES).then((typeIdx) => {
        if (typeIdx < 0) return
        ui.prompt({ title: '当前余额（元）', placeholder: '可空，默认 0', value: '' }).then((balance) => {
          if (balance == null) return
          let cents = 0
          if (balance) {
            const parsed = money.yuanExprToCents(balance)
            if (parsed == null) {
              ui.toast('余额填个正数吧')
              return
            }
            cents = parsed
          }
          ui.withLoading('保存中', () =>
            request.post('/api/v1/accounts', {
              name: name,
              type: TYPE_KEYS[typeIdx],
              current_cents: cents,
            }),
          )
            .then(() => {
              ui.ok('已新增')
              this.load()
            })
            .catch((err) => ui.fail(err, '新增失败'))
        })
      })
    })
  },

  onAccount(e) {
    const id = e.currentTarget.dataset.id
    const item = this.data.items.concat(this.data.archived).find((a) => a.id === id)
    if (!item) return
    const options = ['改名字', '改余额', item.archived ? '取消归档' : '归档']
    ui.actions(options).then((idx) => {
      if (idx === 0) this.rename(item)
      else if (idx === 1) this.setBalance(item)
      else if (idx === 2) this.toggleArchive(item)
    })
  },

  rename(item) {
    ui.prompt({ title: '账户名', value: item.name }).then((name) => {
      if (name == null || !name) return
      this.patch(item.id, { name: name })
    })
  },

  setBalance(item) {
    ui.prompt({ title: '当前余额（元）', value: item.balanceText }).then((value) => {
      if (value == null) return
      const cents = money.yuanExprToCents(value)
      if (cents == null) {
        ui.toast('余额填个正数吧')
        return
      }
      this.patch(item.id, { current_cents: cents })
    })
  },

  toggleArchive(item) {
    if (item.archived) {
      this.patch(item.id, { archived: false })
      return
    }
    ui.confirm('归档后不能再用于记账，历史流水保留。').then((yes) => {
      if (yes) this.patch(item.id, { archived: true })
    })
  },

  patch(id, body) {
    ui.withLoading('保存中', () => request.request({ path: '/api/v1/accounts/' + id, method: 'PATCH', data: body }))
      .then(() => this.load())
      .catch((err) => ui.fail(err, '保存失败'))
  },

  openBudgets() {
    require('../../utils/nav').go('budgets')
  },
})
