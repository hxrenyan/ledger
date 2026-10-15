/**
 * 联系人管理。读写 /api/v1/contacts，和人情页是同一批人。
 */

const { toId } = require('../../utils/id')
const request = require('../../utils/request')
const session = require('../../utils/session')
const money = require('../../utils/money')
const nav = require('../../utils/nav')
const ui = require('../../utils/ui')

function isUpcoming(item) {
  const text = item.reminderText || ''
  return text === '今天' || text.indexOf('还剩') === 0
}

function upcomingRank(item) {
  const text = item.reminderText || ''
  if (text === '今天') return 0
  const matched = text.match(/还剩\s*(\d+)\s*天/)
  return matched ? Number(matched[1]) : 999
}

function shape(raw) {
  const given = Number(raw.given_cents) || 0
  const received = Number(raw.received_cents) || 0
  const net = received - given
  const date = raw.date
  const reminder = raw.reminder
  const reminderText = reminder && reminder.text ? reminder.text : ''
  let netText = '收支持平'
  let netClass = 'muted'
  if (net > 0) {
    netText = '净收 ¥' + money.formatYuan(net)
    netClass = 'income'
  } else if (net < 0) {
    netText = '净送 ¥' + money.formatYuan(Math.abs(net))
    netClass = 'expense'
  }
  return {
    id: raw.id,
    name: raw.name,
    initial: (raw.name || '?').trim().slice(0, 1) || '?',
    relation: raw.relation || '',
    archived: !!raw.archived,
    dateText: date ? (date.kind_label || '') + ' · ' + (date.label || '') : '',
    reminderText: reminderText,
    ageText: reminder && reminder.age_text ? reminder.age_text : '',
    upcoming: reminderText === '今天' || reminderText.indexOf('还剩') === 0,
    hasGifts: given > 0 || received > 0,
    givenText: '送出 ¥' + money.formatYuan(given),
    receivedText: '收到 ¥' + money.formatYuan(received),
    netText: netText,
    netClass: netClass,
  }
}

function viewOf(items, filter, relationFilter, q) {
  const active = items.filter((item) => !item.archived)
  const upcoming = active.filter(isUpcoming).slice().sort((a, b) => upcomingRank(a) - upcomingRank(b))
  const relations = []
  active.forEach((item) => {
    if (item.relation && relations.indexOf(item.relation) < 0) relations.push(item.relation)
  })
  let base = active
  if (filter === 'archived') base = items.filter((item) => item.archived)
  else if (filter === 'date') base = active.filter((item) => item.dateText)
  else if (filter === 'upcoming') base = upcoming
  const kw = String(q || '').trim().toLowerCase()
  const shown = base.filter((item) => {
    if (relationFilter && filter !== 'archived' && item.relation !== relationFilter) return false
    if (!kw) return true
    const hay = (item.name + ' ' + item.relation + ' ' + item.dateText).toLowerCase()
    return hay.indexOf(kw) >= 0
  })
  return {
    countAll: active.length,
    countDate: active.filter((item) => item.dateText).length,
    countUpcoming: upcoming.length,
    countArchived: items.filter((item) => item.archived).length,
    relations: relations,
    upcoming: upcoming,
    shown: shown,
    emptyAll: items.length === 0,
    emptyShown: shown.length === 0,
  }
}

Page({
  data: {
    loading: true,
    q: '',
    filter: 'all',
    relationFilter: '',
    items: [],
    shown: [],
    upcoming: [],
    relations: [],
    countAll: 0,
    countDate: 0,
    countUpcoming: 0,
    countArchived: 0,
    emptyAll: false,
    emptyShown: false,
    busyId: '',
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
      .get('/api/v1/contacts')
      .then((res) => {
        const items = ((res && res.items) || []).map(shape)
        this.items = items
        this.setData(Object.assign({ loading: false, items: items }, this.currentView(items)))
      })
      .catch((err) => {
        this.setData({ loading: false })
        ui.fail(err, '加载失败')
      })
  },

  currentView(items) {
    return viewOf(items || this.items || [], this.data.filter, this.data.relationFilter, this.data.q)
  },

  refreshView(patch) {
    const next = Object.assign(
      {
        filter: this.data.filter,
        relationFilter: this.data.relationFilter,
        q: this.data.q,
      },
      patch || {},
    )
    this.setData(Object.assign(next, viewOf(this.items || [], next.filter, next.relationFilter, next.q)))
  },

  onSearch(e) {
    this.refreshView({ q: e.detail.value })
  },

  clearSearch() {
    this.refreshView({ q: '' })
  },

  setFilter(e) {
    const filter = e.currentTarget.dataset.filter || 'all'
    this.refreshView({ filter: filter, relationFilter: filter === 'archived' ? '' : this.data.relationFilter })
  },

  toggleRelation(e) {
    const rel = e.currentTarget.dataset.rel || ''
    this.refreshView({ relationFilter: this.data.relationFilter === rel ? '' : rel })
  },

  resetFilters() {
    this.refreshView({ q: '', filter: 'all', relationFilter: '' })
  },

  openEdit(e) {
    nav.go('contact-form', { id: e.currentTarget.dataset.id })
  },

  addContact() {
    nav.go('contact-form', { id: 'new' })
  },

  openRecords(e) {
    nav.go('favor-person', { id: e.currentTarget.dataset.id })
  },

  toggleArchive(e) {
    const id = toId(e.currentTarget.dataset.id)
    const item = (this.items || []).find((row) => row.id === id)
    if (!item || this.data.busyId) return
    this.setData({ busyId: id })
    request
      .request({ path: '/api/v1/contacts/' + id, method: 'PATCH', data: { archived: !item.archived } })
      .then(() => this.load())
      .catch((err) => ui.fail(err, '操作失败'))
      .then(() => this.setData({ busyId: '' }))
  },
})
