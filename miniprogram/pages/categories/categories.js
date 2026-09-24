/**
 * 分类管理：支出 / 收入两组，可新增、改名、归档、取消归档。
 * 归档不会删历史流水（流水里存的是 category_id），只是不能再用于新记账。
 */

const request = require('../../utils/request')
const session = require('../../utils/session')
const ui = require('../../utils/ui')

Page({
  data: {
    tab: 'expense',
    expense: [],
    income: [],
    showArchived: false,
    loading: true,
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
      .get('/api/v1/categories')
      .then((res) => {
        const items = (res && res.items) || []
        const shape = (c) => ({ id: c.id, name: c.name, kind: c.kind, archived: !!c.archived })
        this.all = items.map(shape)
        this.setData({ loading: false, expense: this.pick('expense'), income: this.pick('income') })
      })
      .catch((err) => {
        this.setData({ loading: false })
        ui.fail(err, '加载失败')
      })
  },

  pick(kind) {
    return (this.all || []).filter((c) => c.kind === kind && (this.data.showArchived || !c.archived))
  },

  switchTab(e) {
    this.setData({ tab: e.currentTarget.dataset.t })
  },

  toggleArchived() {
    const showArchived = !this.data.showArchived
    this.setData({ showArchived: showArchived })
    this.setData({ expense: this.pick('expense'), income: this.pick('income') })
  },

  add() {
    const kind = this.data.tab
    ui.prompt({ title: kind === 'expense' ? '新增支出分类' : '新增收入分类', placeholder: '名称，最多 32 字' }).then((name) => {
      if (name == null || !name) return
      ui.withLoading('保存中', () => request.post('/api/v1/categories', { name: name, kind: kind }))
        .then(() => this.load())
        .catch((err) => ui.fail(err, '保存失败'))
    })
  },

  onCategory(e) {
    const id = require('../../utils/id').toId(e.currentTarget.dataset.id)
    const item = (this.all || []).find((c) => c.id === id)
    if (!item) return
    const options = ['改名字', item.archived ? '取消归档' : '归档']
    ui.actions(options).then((idx) => {
      if (idx === 0) {
        ui.prompt({ title: '分类名', value: item.name }).then((name) => {
          if (name == null || !name) return
          this.patch(id, { name: name })
        })
        return
      }
      if (idx === 1) {
        if (item.archived) {
          this.patch(id, { archived: false })
          return
        }
        ui.confirm('归档后不能再用于新记账，历史流水不受影响。').then((yes) => {
          if (yes) this.patch(id, { archived: true })
        })
      }
    })
  },

  patch(id, body) {
    ui.withLoading('保存中', () => request.request({ path: '/api/v1/categories/' + id, method: 'PATCH', data: body }))
      .then(() => this.load())
      .catch((err) => ui.fail(err, '保存失败'))
  },
})
