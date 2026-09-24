/**
 * 预算（按月）。
 *
 * 服务端把「总预算」存成 category_id 为空的记录，分类预算存具体 category_id。
 * GET /budgets 拿当月设置，GET /stats/monthly 拿已用金额（budget_used_cents 就是当月支出）。
 */

const request = require('../../utils/request')
const session = require('../../utils/session')
const money = require('../../utils/money')
const time = require('../../utils/time')
const ui = require('../../utils/ui')

Page({
  data: {
    month: '',
    monthText: '',
    /** 月份条的上限：本月 + 1。预算是唯一允许选到未来的页面。 */
    maxMonth: '',
    totalBudgetId: '',
    totalText: '未设置',
    totalUsedText: '',
    totalPercent: 0,
    totalOver: false,
    rows: [],
    loading: true,
  },

  onLoad() {
    const now = time.shanghaiMonth()
    this.setData({
      month: now,
      monthText: time.monthLabel(now),
      // 上限给到下个月，月份条里的年月滚轮也只能选到这儿。
      maxMonth: time.addMonth(now, 1),
    })
    this.load()
  },

  onShow() {
    if (!session.ensure()) return
    if (this.loaded) this.load()
    this.loaded = true
  },

  /**
   * 月份条（components/month-nav）换了月份。
   *
   * 以前这里只允许在本月 / 下月之间挪，现在可以跳去任何历史月份看当时的预算 ——
   * 上限（下个月）交给组件的 max 属性，这里不再自己判断越界。
   */
  onMonthChange(e) {
    const month = e.detail.month
    if (!month || month === this.data.month) return
    this.setData({ month: month, monthText: time.monthLabel(month) })
    this.load()
  },

  load() {
    const month = this.data.month
    this.setData({ loading: true })
    return Promise.all([
      request.get('/api/v1/budgets?month=' + month),
      request.get('/api/v1/stats/monthly?month=' + month),
      request.get('/api/v1/categories'),
    ])
      .then((res) => {
        const budgets = ((res[0] && res[0].items) || [])
        const stats = res[1] || {}
        const cats = ((res[2] && res[2].items) || []).filter((c) => c.kind === 'expense' && !c.archived)
        const usedByCat = {}
        ;(stats.by_category || []).forEach((c) => {
          if (c.kind === 'expense') usedByCat[c.category_id] = Number(c.amount_cents) || 0
        })

        const totalRow = budgets.find((b) => !b.category_id)
        const total = totalRow ? Number(totalRow.amount_cents) || 0 : 0
        const used = Number(stats.budget_used_cents) || 0

        const rows = cats.map((c) => {
          const row = budgets.find((b) => b.category_id === c.id)
          const amount = row ? Number(row.amount_cents) || 0 : 0
          const spent = usedByCat[c.id] || 0
          const percent = amount ? Math.min(100, Math.round((spent / amount) * 100)) : 0
          return {
            id: c.id,
            budgetId: row ? row.id : '',
            name: c.name,
            amountText: amount ? money.formatYuan(amount) : '未设置',
            spentText: money.formatYuan(spent),
            percent: percent,
            over: amount > 0 && spent > amount,
          }
        })

        this.setData({
          loading: false,
          totalBudgetId: totalRow ? totalRow.id : '',
          totalText: total ? money.formatYuan(total) : '未设置',
          totalUsedText: money.formatYuan(used),
          totalPercent: total ? Math.min(100, Math.round((used / total) * 100)) : 0,
          totalOver: total > 0 && used > total,
          rows: rows,
        })
      })
      .catch((err) => {
        this.setData({ loading: false })
        ui.fail(err, '加载失败')
      })
  },

  setTotal() {
    const current = this.data.totalText === '未设置' ? '' : this.data.totalText
    ui.prompt({ title: '本月总预算（元）', value: current }).then((value) => {
      if (value == null) return
      if (!value) {
        this.removeTotal()
        return
      }
      this.save('', value)
    })
  },

  removeTotal() {
    const id = this.data.totalBudgetId
    if (!id) {
      ui.toast('本来就没设总预算')
      return
    }
    ui.confirm('删掉本月总预算？').then((yes) => {
      if (!yes) return
      ui.withLoading('删除中', () => request.del('/api/v1/budgets/' + id))
        .then(() => this.load())
        .catch((err) => ui.fail(err, '删除失败'))
    })
  },

  setCategory(e) {
    const id = require('../../utils/id').toId(e.currentTarget.dataset.id)
    const item = this.data.rows.find((r) => r.id === id)
    if (!item) return
    const current = item.amountText === '未设置' ? '' : item.amountText
    ui.prompt({ title: '「' + item.name + '」预算（元）', value: current }).then((value) => {
      if (value == null) return
      if (!value) {
        this.removeCategory(item)
        return
      }
      this.save(id, value)
    })
  },

  removeCategory(item) {
    if (!item.budgetId) return
    ui.confirm('删掉「' + item.name + '」的预算？').then((yes) => {
      if (!yes) return
      ui.withLoading('删除中', () => request.del('/api/v1/budgets/' + item.budgetId))
        .then(() => this.load())
        .catch((err) => ui.fail(err, '删除失败'))
    })
  },

  save(categoryId, value) {
    const cents = money.yuanExprToCents(value)
    if (cents == null) {
      ui.toast('金额填个正数吧')
      return
    }
    ui.withLoading('保存中', () =>
      request.put('/api/v1/budgets', {
        month: this.data.month,
        category_id: categoryId,
        amount_cents: cents,
      }),
    )
      .then(() => this.load())
      .catch((err) => ui.fail(err, '保存失败'))
  },
})
