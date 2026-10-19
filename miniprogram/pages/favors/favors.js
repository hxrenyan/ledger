/**
 * 人情往来（tab）。
 *
 * 两段数据：
 *   往来记录 —— GET /gifts 支持按月份或全量查看、按方向（送出/收到）与关键词（姓名/事由/备注）筛选；
 *   联系人 —— GET /contacts 带每人 given/received 与日子提醒，支持搜索联系人、一键给某人记一笔、点进看往来明细。
 *
 * 人情不参与收支统计（后端口径如此），所以这里只按「送出 / 收到」两个方向看。
 */

const request = require('../../utils/request')
const session = require('../../utils/session')
const nav = require('../../utils/nav')
const money = require('../../utils/money')
const time = require('../../utils/time')
const ui = require('../../utils/ui')

/** 顶部提醒：每条即将到来的日子各一张卡；没有即将到来时，只留最近过去的那一条。 */
function comingSoon(contacts) {
  const items = []
  ;(contacts || []).forEach((c) => {
    if (!c || c.archived) return
    const dates = dateRows(c)
    const upcoming = []
    let past = null
    dates.forEach((date) => {
      const reminder = date.reminder || (!date.kind && c.reminder) || null
      if (!reminder) return
      const card = {
        key: c.id + '-' + (date.id || date.kind || ''),
        id: c.id,
        name: c.name || '',
        relation: c.relation || '',
        kindText: date.kind_label || date.kind || '',
        whenText: reminder.text || '',
        ageText: reminder.age_text || '',
        state: reminder.state === 'past' ? 'past' : 'upcoming',
        days: Number(reminder.days) || 0,
      }
      if (card.state === 'upcoming' || (reminder.text === '今天' || String(reminder.text || '').indexOf('还剩') === 0)) {
        card.state = 'upcoming'
        upcoming.push(card)
      } else if (!past || card.days < past.days) {
        past = card
      }
    })
    if (upcoming.length) items.push.apply(items, upcoming)
    else if (past) items.push(past)
  })
  items.sort((a, b) => {
    if (a.state !== b.state) return a.state === 'upcoming' ? -1 : 1
    return a.days - b.days
  })
  return items
}

function giftDaySumLabel(givenCents, receivedCents) {
  const parts = []
  if (givenCents > 0) parts.push('送 ' + money.formatYuan(givenCents))
  if (receivedCents > 0) parts.push('收 ' + money.formatYuan(receivedCents))
  return parts.join(' · ')
}

function dateRows(c) {
  if (c && c.dates && c.dates.length) return c.dates
  if (c && c.date) return [Object.assign({}, c.date, { reminder: c.reminder })]
  return []
}

function contactDateLine(c) {
  const dates = dateRows(c)
  if (!dates.length) return ''
  return dates.map((date) => {
    const kind = date.kind_label || date.kind || ''
    const label = date.label || ''
    const reminder = date.reminder || null
    const when = reminder && reminder.text ? ' · ' + reminder.text : ''
    return (kind ? kind + ' · ' : '') + label + when
  }).join('；')
}

Page({
  data: {
    loading: true,
    tab: 'gifts', // gifts | contacts
    // 范围：month 按月看 | all 全部时间
    scope: 'month',
    month: '',
    // 汇总
    givenText: '0.00',
    receivedText: '0.00',
    netText: '0.00',
    netClass: 'income',
    // 往来筛选
    q: '',
    kindFilter: 'all', // all | give | receive
    hasGiftFilter: false,
    groups: [],
    empty: false,
    emptyText: '',
    // 联系人与筛选
    contactQ: '',
    contacts: [],
    contactEmpty: false,
    contactNoMatch: false,
    soon: [],
    guest: false,
  },

  onLoad() {
    this.gifts = []
    this.contacts = []
    const month = time.shanghaiMonth()
    this.setData({ month: month })
  },

  onShow() {
    if (!session.getToken()) {
      this.setData({
        guest: true,
        loading: false,
        empty: true,
        emptyText: '这个月还没有人情记录，点右下角 + 记一笔',
        contactEmpty: true,
        contactNoMatch: false,
        contacts: [],
        soon: [],
        groups: [],
      })
      return
    }
    if (this.data.guest) this.setData({ guest: false })
    this.load()
  },

  onPullDownRefresh() {
    if (!session.getToken()) {
      wx.stopPullDownRefresh()
      return
    }
    this.load().then(() => wx.stopPullDownRefresh())
  },

  load() {
    this.setData({ loading: true })
    return Promise.all([request.get('/api/v1/gifts'), request.get('/api/v1/contacts')])
      .then((res) => {
        const gifts = (res[0] && res[0].items) || []
        const contacts = (res[1] && res[1].items) || []
        this.gifts = gifts.map((g) => this.decorate(g))
        this.contacts = contacts
          .filter((c) => !c.archived)
          .map((c) => {
            const net = Number(c.net_cents) || 0
            return {
              id: c.id,
              name: c.name,
              initial: c.name.slice(0, 1),
              relation: c.relation || '',
              archived: !!c.archived,
              givenText: money.formatYuan(c.given_cents),
              receivedText: money.formatYuan(c.received_cents),
              netText: (net > 0 ? '+' : '') + money.formatYuan(net),
              netClass: net >= 0 ? 'income' : 'expense',
              summary: '送出 ' + money.formatYuan(c.given_cents) + ' · 收到 ' + money.formatYuan(c.received_cents),
              dateLine: contactDateLine(c),
            }
          })

        this.setData({
          loading: false,
          contactEmpty: !this.contacts.length,
          soon: comingSoon(contacts),
        })
        this.applyContactFilter()
        this.applyFilter()
      })
      .catch((err) => {
        this.setData({ loading: false })
        ui.fail(err, '加载失败')
      })
  },

  decorate(g) {
    const name = g.contact_name || ''
    return {
      id: g.id,
      contactId: g.contact_id,
      contact: name,
      initial: name ? name.slice(0, 1) : '友',
      kind: g.kind,
      kindText: g.kind === 'give' ? '送出' : '收到',
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
   * 往来记录支持「按月」或「全部时间」查看；切到联系人 tab 时汇总固定展示全部累计。
   */
  applyFilter() {
    const useMonth = this.data.tab === 'gifts' && this.data.scope === 'month' && this.data.month
    const month = this.data.month
    const inScope = useMonth ? this.gifts.filter((g) => g.date.slice(0, 7) === month) : this.gifts

    let given = 0
    let received = 0
    inScope.forEach((g) => {
      if (g.kind === 'give') given += g.amountCents
      else received += g.amountCents
    })

    const kindFilter = this.data.kindFilter || 'all'
    const q = (this.data.q || '').trim()
    const hasGiftFilter = Boolean(q || kindFilter !== 'all')
    const list = inScope.filter((g) => {
      if (kindFilter !== 'all' && g.kind !== kindFilter) return false
      if (!q) return true
      return g.contact.indexOf(q) >= 0 || g.note.indexOf(q) >= 0 || g.occasion.indexOf(q) >= 0
    })

    const groups = []
    const byKey = {}
    list.forEach((g) => {
      let row = byKey[g.date]
      if (!row) {
        row = { key: g.date, label: time.dayLabel(g.date), items: [], givenCents: 0, receivedCents: 0 }
        byKey[g.date] = row
        groups.push(row)
      }
      row.items.push(g)
      if (g.kind === 'give') row.givenCents += g.amountCents
      else row.receivedCents += g.amountCents
    })

    const shapedGroups = groups.map((row) => ({
      key: row.key,
      label: row.label,
      items: row.items,
      sumText: giftDaySumLabel(row.givenCents, row.receivedCents),
    }))

    const net = received - given
    this.setData({
      groups: shapedGroups,
      empty: !list.length,
      hasGiftFilter: hasGiftFilter,
      emptyText: hasGiftFilter
        ? '没有匹配的往来记录'
        : useMonth
          ? '这个月还没有人情记录'
          : '还没有人情记录',
      givenText: money.formatYuan(given),
      receivedText: money.formatYuan(received),
      netText: (net > 0 ? '+' : '') + money.formatYuan(net),
      netClass: net >= 0 ? 'income' : 'expense',
    })
  },

  applyContactFilter() {
    const all = this.contacts || []
    const q = (this.data.contactQ || '').trim()
    const filtered = q
      ? all.filter(
          (c) =>
            c.name.indexOf(q) >= 0 ||
            c.relation.indexOf(q) >= 0 ||
            (c.dateLine && c.dateLine.indexOf(q) >= 0),
        )
      : all
    this.setData({
      contacts: filtered,
      contactEmpty: !all.length,
      contactNoMatch: all.length > 0 && !filtered.length,
    })
  },

  /** 月份条（components/month-nav）换了月份。上限是本月，看不到未来。 */
  onMonthChange(e) {
    if (!session.getToken()) {
      session.goLogin()
      return
    }
    const month = e.detail.month
    if (!month) return
    this.setData({ month: month, scope: 'month' })
    this.applyFilter()
  },

  toggleScope(e) {
    if (!session.getToken()) {
      session.goLogin()
      return
    }
    const next = e.currentTarget.dataset.scope || (this.data.scope === 'all' ? 'month' : 'all')
    if (next === this.data.scope) return
    this.setData({ scope: next })
    this.applyFilter()
  },

  onSearch(e) {
    if (!session.getToken()) {
      session.goLogin()
      return
    }
    this.setData({ q: e.detail.value })
    this.applyFilter()
  },

  clearSearch() {
    if (!this.data.q) return
    this.setData({ q: '' })
    this.applyFilter()
  },

  setKindFilter(e) {
    if (!session.getToken()) {
      session.goLogin()
      return
    }
    const kind = e.currentTarget.dataset.kind || 'all'
    if (kind === this.data.kindFilter) return
    this.setData({ kindFilter: kind })
    this.applyFilter()
  },

  resetGiftFilter() {
    this.setData({ q: '', kindFilter: 'all', hasGiftFilter: false })
    this.applyFilter()
  },

  onContactSearch(e) {
    if (!session.getToken()) {
      session.goLogin()
      return
    }
    this.setData({ contactQ: e.detail.value })
    this.applyContactFilter()
  },

  clearContactSearch() {
    if (!this.data.contactQ) return
    this.setData({ contactQ: '' })
    this.applyContactFilter()
  },

  switchTab(e) {
    const tab = e.currentTarget.dataset.t
    if (!session.getToken()) {
      if (tab !== 'gifts') session.goLogin()
      return
    }
    if (tab === this.data.tab) return
    this.setData({ tab: tab })
    this.applyFilter()
  },

  openPerson(e) {
    nav.go('favor-person', { id: e.currentTarget.dataset.id })
  },

  openTools() {
    if (!session.getToken()) {
      session.goLogin()
      return
    }
    nav.go('tool-contacts')
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
    if (!session.getToken()) {
      session.goLogin()
      return
    }
    ui.prompt({ title: '新增联系人', placeholder: '姓名' }).then((name) => {
      if (name == null || !name) return
      ui.prompt({ title: '关系（可空）', placeholder: '比如：同事 / 亲戚' }).then((relation) => {
        ui.withLoading('保存中', () => request.post('/api/v1/contacts', { name: name, relation: relation || '' }))
          .then(() => this.load())
          .catch((err) => ui.fail(err, '保存失败'))
      })
    })
  },

  addGiftForContact(e) {
    if (!session.getToken()) {
      session.goLogin()
      return
    }
    nav.go('gift-form', { contact_id: e.currentTarget.dataset.id })
  },

  addGift() {
    if (!session.getToken()) {
      session.goLogin()
      return
    }
    nav.go('gift-form', {})
  },

  onShareAppMessage() {
    return { title: '人情往来', path: '/pages/favors/favors' }
  },
})
