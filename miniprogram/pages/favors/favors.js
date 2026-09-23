/**
 * 人情往来（tab）。
 *
 * 两段数据：
 *   汇总 —— GET /gifts 全量算出「送出 / 收入 / 差额」，并支持按姓名搜索；
 *   联系人 —— GET /contacts 带每人 given/received，点进去看他的往来明细。
 *
 * 人情不参与收支统计（后端口径如此），所以这里只按「送出 / 收入」两个方向看。
 */

const request = require('../../utils/request')
const session = require('../../utils/session')
const nav = require('../../utils/nav')
const money = require('../../utils/money')
const time = require('../../utils/time')
const ui = require('../../utils/ui')

Page({
  data: {
    loading: true,
    tab: 'gifts', // gifts | contacts
    // 月份（往来记录与汇总都按它算；联系人那一栏不受影响）
    month: '',
    // 汇总
    givenText: '0.00',
    receivedText: '0.00',
    netText: '0.00',
    netClass: 'income',
    // 往来
    q: '',
    groups: [],
    empty: false,
    emptyText: '',
    // 联系人
    contacts: [],
    contactEmpty: false,
  },

  onLoad() {
    this.gifts = []
    this.contacts = []
    this.setData({ month: time.shanghaiMonth() })
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
    return Promise.all([request.get('/api/v1/gifts'), request.get('/api/v1/contacts')])
      .then((res) => {
        const gifts = (res[0] && res[0].items) || []
        const contacts = (res[1] && res[1].items) || []
        this.gifts = gifts.map((g) => this.decorate(g))
        this.contacts = contacts.map((c) => ({
          id: c.id,
          name: c.name,
          initial: c.name.slice(0, 1),
          relation: c.relation || '',
          archived: !!c.archived,
          givenText: money.formatYuan(c.given_cents),
          receivedText: money.formatYuan(c.received_cents),
          netText: money.formatYuan(c.net_cents),
          netClass: c.net_cents >= 0 ? 'income' : 'expense',
          summary: '送出 ' + money.formatYuan(c.given_cents) + ' · 收入 ' + money.formatYuan(c.received_cents),
        }))

        this.setData({
          loading: false,
          contacts: this.contacts.filter((c) => !c.archived),
          contactEmpty: !contacts.length,
        })
        // 汇总跟着所选月份走，所以放在 applyFilter 里一起算，
        // 否则切月份时汇总数字会停在旧月份上。
        this.applyFilter()
      })
      .catch((err) => {
        this.setData({ loading: false })
        ui.fail(err, '加载失败')
      })
  },

  decorate(g) {
    return {
      id: g.id,
      contactId: g.contact_id,
      contact: g.contact_name || '',
      kind: g.kind,
      kindText: g.kind === 'give' ? '送出' : '收入',
      // 汇总要按月份重算，所以留一份分值在手里（amountText 是给人看的）
      amountCents: Number(g.amount_cents) || 0,
      date: time.occurredAtToDate(g.occurred_at),
      amountText: (g.kind === 'give' ? '-' : '+') + money.formatYuan(g.amount_cents),
      occasion: g.occasion || '',
      note: g.note || '',
    }
  },

  /**
   * 筛选 + 汇总 + 分组。
   *
   * 顺序是「先按月份圈定范围 → 在这个范围里算汇总 → 再按关键词筛 → 分组」。
   * 三件事放一起是因为它们必须用同一份数据：以前汇总在 load() 里算的是全量，
   * 加了月份之后如果还留在那儿，切月份时列表变了、汇总不动。
   *
   * 接口给的是全量往来（GET /gifts 没有 month 参数），所以月份在本地筛，
   * 切月份不必再发一次请求 —— 按「送出/收到的总账」看，这个体量完全够。
   */
  applyFilter() {
    const month = this.data.month
    const inMonth = month ? this.gifts.filter((g) => g.date.slice(0, 7) === month) : this.gifts

    let given = 0
    let received = 0
    inMonth.forEach((g) => {
      if (g.kind === 'give') given += g.amountCents
      else received += g.amountCents
    })

    const q = (this.data.q || '').trim()
    const list = q
      ? inMonth.filter((g) => g.contact.indexOf(q) >= 0 || g.note.indexOf(q) >= 0 || g.occasion.indexOf(q) >= 0)
      : inMonth
    const groups = []
    const byKey = {}
    list.forEach((g) => {
      let row = byKey[g.date]
      if (!row) {
        row = { key: g.date, label: time.dayLabel(g.date), items: [] }
        byKey[g.date] = row
        groups.push(row)
      }
      row.items.push(g)
    })
    this.setData({
      groups: groups,
      empty: !list.length,
      // 区分「这个月本来就没有」和「搜索没搜到」——后者说「还没有记录」会让人以为数据丢了
      emptyText:
        inMonth.length > 0 ? '没有匹配的记录' : '这个月还没有人情记录，点右下角 + 记一笔',
      givenText: money.formatYuan(given),
      receivedText: money.formatYuan(received),
      netText: money.formatYuan(received - given),
      netClass: received - given >= 0 ? 'income' : 'expense',
    })
  },

  /** 月份条（components/month-nav）换了月份。上限是本月，看不到未来。 */
  onMonthChange(e) {
    const month = e.detail.month
    if (!month || month === this.data.month) return
    this.setData({ month: month })
    this.applyFilter()
  },

  onSearch(e) {
    this.setData({ q: e.detail.value })
    this.applyFilter()
  },

  switchTab(e) {
    this.setData({ tab: e.currentTarget.dataset.t })
  },

  openPerson(e) {
    nav.go('favor-person', { id: e.currentTarget.dataset.id })
  },

  editGift(e) {
    nav.go('gift-form', { id: e.currentTarget.dataset.id })
  },

  async removeGift(e) {
    const yes = await ui.confirm('删掉这条人情记录？')
    if (!yes) return
    ui.withLoading('删除中', () => request.del('/api/v1/gifts/' + e.currentTarget.dataset.id))
      .then(() => {
        ui.ok('已删除')
        this.load()
      })
      .catch((err) => ui.fail(err, '删除失败'))
  },

  addContact() {
    ui.prompt({ title: '新增联系人', placeholder: '姓名' }).then((name) => {
      if (name == null || !name) return
      ui.prompt({ title: '关系（可空）', placeholder: '比如：同事 / 亲戚' }).then((relation) => {
        ui.withLoading('保存中', () => request.post('/api/v1/contacts', { name: name, relation: relation || '' }))
          .then(() => this.load())
          .catch((err) => ui.fail(err, '保存失败'))
      })
    })
  },

  addGift() {
    nav.go('gift-form', {})
  },

  onShareAppMessage() {
    return { title: '人情往来', path: '/pages/favors/favors' }
  },
})
