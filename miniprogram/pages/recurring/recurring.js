/**
 * 周期记账。
 *
 * 只在「收入 / 支出」两种类型，日期限 1–28（避开 2 月没有 29–31 号的坑，
 * 这一条是服务端的硬约束）。
 *
 * 到期的补记由 POST /recurrences/run 完成，首页每次进入也会兜底跑一次，
 * 所以这里只提供手动「立即补记」，用于当月刚打开时想看结果。
 */

const request = require('../../utils/request')
const session = require('../../utils/session')
const money = require('../../utils/money')
const ui = require('../../utils/ui')

Page({
  data: {
    items: [],
    loading: true,
    accounts: [],
    accountNames: [],
    cats: [],
  },

  onLoad() {
    this.loadRefs()
  },

  onShow() {
    if (!session.ensure()) return
    this.load()
  },

  onPullDownRefresh() {
    this.load().then(() => wx.stopPullDownRefresh())
  },

  loadRefs() {
    Promise.all([request.get('/api/v1/accounts'), request.get('/api/v1/categories')])
      .then((res) => {
        const accounts = ((res[0] && res[0].items) || []).filter((a) => !a.archived)
        const cats = ((res[1] && res[1].items) || []).filter((c) => !c.archived)
        this.accountMap = {}
        this.categoryMap = {}
        accounts.forEach((a) => { this.accountMap[a.id] = a.name })
        cats.forEach((c) => { this.categoryMap[c.id] = c.name })
        this.allAccounts = accounts
        this.allCats = cats
        this.setData({ accounts: accounts, accountNames: accounts.map((a) => a.name), cats: cats })
      })
      .catch(() => {})
  },

  load() {
    this.setData({ loading: true })
    return request
      .get('/api/v1/recurrences')
      .then((res) => {
        const items = ((res && res.items) || []).map((r) => ({
          id: r.id,
          kind: r.kind,
          kindText: r.kind === 'income' ? '收入' : '支出',
          amountText: money.formatYuan(r.amount_cents),
          account: (this.accountMap && this.accountMap[r.account_id]) || '已删除账户',
          category: (this.categoryMap && this.categoryMap[r.category_id]) || '已删除分类',
          day: r.day_of_month,
          note: r.note || '',
          enabled: !!r.enabled,
        }))
        this.setData({ loading: false, items: items })
      })
      .catch((err) => {
        this.setData({ loading: false })
        ui.fail(err, '加载失败')
      })
  },

  add() {
    if (!this.data.accounts.length) {
      ui.toast('先建一个账户')
      return
    }
    ui.actions(['支出', '收入']).then((kindIdx) => {
      if (kindIdx < 0) return
      const kind = kindIdx === 0 ? 'expense' : 'income'
      const cats = (this.allCats || []).filter((c) => c.kind === kind)
      if (!cats.length) {
        ui.toast('这个类型下还没有分类')
        return
      }
      ui.prompt({ title: '金额（元）', placeholder: '比如 3000' }).then((amount) => {
        if (!amount) return
        const cents = money.yuanExprToCents(amount)
        if (cents == null) {
          ui.toast('金额填个正数吧')
          return
        }
        ui.prompt({ title: '每月几号（1–28）', placeholder: '10' }).then((dayText) => {
          const day = Number(dayText)
          if (!Number.isInteger(day) || day < 1 || day > 28) {
            ui.toast('日期要在 1–28 之间')
            return
          }
          ui.actions(this.data.accountNames).then((acctIdx) => {
            if (acctIdx < 0) return
            ui.actions(cats.map((c) => c.name)).then((catIdx) => {
              if (catIdx < 0) return
              ui.prompt({ title: '备注（可空）', placeholder: '比如：房租' }).then((note) => {
                if (note == null) return
                ui.withLoading('保存中', () =>
                  request.post('/api/v1/recurrences', {
                    kind: kind,
                    amount_cents: cents,
                    account_id: this.data.accounts[acctIdx].id,
                    category_id: cats[catIdx].id,
                    day_of_month: day,
                    note: note || '',
                  }),
                )
                  .then(() => {
                    ui.ok('已新增')
                    this.load()
                  })
                  .catch((err) => ui.fail(err, '保存失败'))
              })
            })
          })
        })
      })
    })
  },

  onItem(e) {
    const id = require('../../utils/id').toId(e.currentTarget.dataset.id)
    const item = this.data.items.find((r) => r.id === id)
    if (!item) return
    const options = [item.enabled ? '停用' : '启用', '删除']
    ui.actions(options).then((idx) => {
      if (idx === 0) this.patch(item.id, { enabled: !item.enabled })
      if (idx === 1) {
        ui.confirm('删掉这条周期记账？已生成的流水不会撤销。').then((yes) => {
          if (!yes) return
          ui.withLoading('删除中', () => request.del('/api/v1/recurrences/' + item.id))
            .then(() => this.load())
            .catch((err) => ui.fail(err, '删除失败'))
        })
      }
    })
  },

  patch(id, body) {
    ui.withLoading('保存中', () => request.request({ path: '/api/v1/recurrences/' + id, method: 'PATCH', data: body }))
      .then(() => this.load())
      .catch((err) => ui.fail(err, '保存失败'))
  },

  /** 到期的周期记账补记。同一期不会重复记（生成后 next_at 会推到下个月）。 */
  runNow() {
    ui.withLoading('补记中', () => request.post('/api/v1/recurrences/run', {}))
      .then((res) => {
        ui.ok(res && res.created ? '补记了 ' + res.created + ' 笔' : '没有到期的')
      })
      .catch((err) => ui.fail(err, '补记失败'))
  },
})
