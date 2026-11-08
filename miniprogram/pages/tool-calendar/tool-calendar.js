/**
 * 个人日历记事。跟登录用户走，不跟当前账本。
 *
 * 页面采用三段式结构：
 * 1. 月历卡（顶部固定月份切换 + 回今天 + 收起/展开月历，展开时展示紧凑月历网格）
 * 2. 当天记事卡（前一天/日期/后一天 + 记一条按钮 → 紧接着输入框和当天记事列表，中间不再夹月历）
 * 3. 记事一览卡（默认展开，支持「本月 / 今起」一键筛选、近一年关键词搜索，以及直接记一条/编辑/删除）
 */

const request = require('../../utils/request')
const session = require('../../utils/session')
const time = require('../../utils/time')
const ui = require('../../utils/ui')

/** 搜索时往前后各展开的月数，合起来不超过接口的一年上限。 */
const SEARCH_SPAN_MONTHS = 5

/** 月历开合状态存本地，下次进来保持上次的样子。默认展开。 */
const CAL_OPEN_KEY = 'calendar_cal_open'

function readCalOpen() {
  try {
    const saved = wx.getStorageSync(CAL_OPEN_KEY)
    return saved === '' || saved == null ? true : saved !== '0'
  } catch (e) {
    return true
  }
}

function writeCalOpen(open) {
  try {
    wx.setStorageSync(CAL_OPEN_KEY, open ? '1' : '0')
  } catch (e) {
    // 存不上不影响这次使用
  }
}

function dayInMonth(month, day, today) {
  if (day && day.slice(0, 7) === month) return day
  if (today.slice(0, 7) === month) return today
  return month + '-01'
}

function dayDiff(from, to) {
  if (!from || !to) return 0
  const f = from.split('-').map(Number)
  const t = to.split('-').map(Number)
  const t1 = Date.UTC(f[0], f[1] - 1, f[2])
  const t2 = Date.UTC(t[0], t[1] - 1, t[2])
  return Math.round((t2 - t1) / 86400000)
}

function relativeLabel(date, today) {
  if (!date || !today) return ''
  if (date === today) return '今天'
  if (date === time.addDays(today, -1)) return '昨天'
  if (date === time.addDays(today, 1)) return '明天'
  if (date === time.addDays(today, -2)) return '前天'
  if (date === time.addDays(today, 2)) return '后天'
  const diff = dayDiff(today, date)
  if (diff > 0 && diff <= 30) return diff + '天后'
  if (diff < 0 && diff >= -30) return Math.abs(diff) + '天前'
  return ''
}

function decorateCells(cells, countsByDay) {
  return (cells || []).map(function (cell, index) {
    if (cell.blank) return Object.assign({}, cell, { weekend: false, count: 0 })
    const count = Number(countsByDay && countsByDay[cell.date]) || 0
    return Object.assign({}, cell, {
      weekend: index % 7 >= 5,
      has: count > 0,
      count: count,
    })
  })
}

function textCount(raw) {
  return Array.from(String(raw || '')).length
}

function monthBounds(month) {
  const days = time.daysInMonth(month)
  return { from: month + '-01', to: month + '-' + String(days).padStart(2, '0') }
}

/** 搜索范围：选中月前后各 SEARCH_SPAN_MONTHS 个月。 */
function searchBounds(month) {
  const start = time.addMonth(month, -SEARCH_SPAN_MONTHS)
  const end = time.addMonth(month, SEARCH_SPAN_MONTHS)
  return { from: start + '-01', to: monthBounds(end).to }
}

function countsOf(days) {
  const map = {}
  ;(days || []).forEach(function (row) {
    if (row && row.day && Number(row.count) > 0) map[row.day] = Number(row.count)
  })
  return map
}

function shapeItems(items) {
  return (items || []).map(function (item) {
    return {
      id: item.id,
      day: item.day || '',
      body: item.body || '',
      clock: time.shanghaiClock(item.created_at),
      edited: Number(item.updated_at) > Number(item.created_at),
    }
  })
}

/** 刷新结果里没有的、本页刚记下的条目补回去。服务端已有的以服务端为准。 */
function mergeFresh(serverItems, month, fresh) {
  const list = (serverItems || []).slice()
  const seen = {}
  list.forEach(function (item) { seen[item.id] = true })
  Object.keys(fresh || {}).forEach(function (id) {
    const item = fresh[id]
    if (!item || seen[item.id]) return
    if (month && String(item.day || '').slice(0, 7) !== month) return
    list.push(item)
  })
  list.sort(function (a, b) {
    if (a.day === b.day) return (Number(a.id) || 0) - (Number(b.id) || 0)
    return a.day < b.day ? -1 : 1
  })
  return list
}

function buildGroups(shapedItems, q, today, listFilter, searching) {
  const kw = String(q || '').trim().toLowerCase()
  const order = []
  const byDay = {}
  ;(shapedItems || []).forEach(function (item) {
    if (!item.day) return
    if (!searching && listFilter === 'upcoming' && item.day < today) return
    if (kw && String(item.body).toLowerCase().indexOf(kw) < 0 && item.day.indexOf(kw) < 0) return
    if (!byDay[item.day]) {
      byDay[item.day] = []
      order.push(item.day)
    }
    byDay[item.day].push(item)
  })
  return order.map(function (day) {
    const list = byDay[day] || []
    return {
      day: day,
      label: time.dateLabel(day),
      rel: relativeLabel(day, today),
      isToday: day === today,
      count: list.length,
      items: list,
    }
  })
}

function historyState() {
  return {
    open: false, loading: false, previewLoading: false, navigating: false,
    summary: { as_of: '', total_count: 0, recorded_days: 0, years: [] },
    year: 0, month: '', monthText: '', groups: [], shown: 30, total: 0,
    error: '', previewError: '', notice: '', older: '', newer: '', anchor: '',
  }
}

Page({
  data: {
    month: '',
    monthText: '',
    calWeek: time.CAL_WEEK,
    cells: [],
    selected: '',
    today: '',
    dayTitle: '',
    dayRel: '',
    items: [],
    groups: [],
    q: '',
    listFilter: 'all',
    searching: false,
    scopeFrom: '',
    scopeTo: '',
    calOpen: true,
    listOpen: true,
    listError: '',
    draft: '',
    draftCount: 0,
    canSave: false,
    monthCount: 0,
    activeDaysCount: 0,
    upcomingCount: 0,
    showBack: false,
    adding: false,
    editingId: 0,
    busy: false,
    loading: true,
    error: '',
    history: historyState(),
    highlightedId: 0,
  },

  onLoad() {
    this.setData({ calOpen: readCalOpen() })
  },

  onShow() {
    if (!session.getToken()) {
      session.goLogin()
      return
    }
    const account = session.getToken()
    if (this._historyAccount && this._historyAccount !== account) this.resetHistory()
    this._historyAccount = account
    const today = time.todayISO()
    const month = this.data.month || time.shanghaiMonth()
    const selected = dayInMonth(month, this.data.selected, today)
    this.setData({
      today: today,
      month: month,
      monthText: time.monthLabel(month),
      selected: selected,
      dayTitle: time.dateLabel(selected),
      dayRel: relativeLabel(selected, today),
      showBack: month !== today.slice(0, 7) || selected !== today,
    })
    this.load(month, selected)
    if (this.data.history.open) this.refreshHistory()
  },

  onUnload() {
    this.closeHistory()
    clearTimeout(this._highlightTimer)
    clearTimeout(this._historyScrollTimer)
  },

  onHide() { if (this.data.history.open) this.closeHistory() },

  patchHistory(patch) {
    this.setData({ history: Object.assign({}, this.data.history, patch) })
  },

  resetHistory() {
    this._historyTicket = (this._historyTicket || 0) + 1
    this._previewTicket = (this._previewTicket || 0) + 1
    this._historyItems = []
    this._historyAnchor = ''
    this._historyShown = 30
    this.setData({ history: historyState() })
  },

  openHistory() {
    const account = session.getToken()
    if (this._historyAccount && this._historyAccount !== account) this.resetHistory()
    this._historyAccount = account
    this.patchHistory({ open: true })
    return this.refreshHistory()
  },

  closeHistory() {
    this._historyTicket = (this._historyTicket || 0) + 1
    this._previewTicket = (this._previewTicket || 0) + 1
    this.patchHistory({ open: false, loading: false, previewLoading: false, navigating: false })
  },

  swallowHistoryTouch() {},

  historyCurrent(ticket, preview) {
    if (this._historyAccount !== session.getToken()) { this.resetHistory(); return false }
    return this.data.history.open
      && ticket === (preview ? this._previewTicket : this._historyTicket)
  },

  async refreshHistory(reconciled) {
    const ticket = this._historyTicket = (this._historyTicket || 0) + 1
    this._previewTicket = (this._previewTicket || 0) + 1
    this.patchHistory({ loading: true, previewLoading: false, navigating: false, error: '', previewError: '', groups: [] })
    try {
      const summary = await request.request({ path: '/api/v1/day-notes/history' })
      if (!this.historyCurrent(ticket, false)) return
      summary.years = summary.years.map(function (year) { return Object.assign({}, year, { monthCount: year.months.length }) })
      const months = summary.years.reduce(function (all, year) { return all.concat(year.months) }, [])
      const oldMonth = this.data.history.month
      const preferred = oldMonth || this.data.month
      const target = months.find(function (m) { return m.month === preferred })
        || months.find(function (m) { return m.month.slice(0, 4) === preferred.slice(0, 4) }) || months[0]
      this.patchHistory({ summary: summary, loading: false,
        notice: oldMonth && !months.some(function (m) { return m.month === oldMonth }) ? '原月份已无历史记录，已显示最近记录' : '' })
      if (target) return this.selectHistoryMonth(target.month, reconciled === true, true)
      this._historyItems = []
      this.patchHistory({ month: '', year: 0, monthText: '', total: 0, groups: [], older: '', newer: '', anchor: '' })
    } catch (err) {
      if (this.historyCurrent(ticket, false)) this.patchHistory({ loading: false, error: err.message || '目录加载失败' })
    }
  },

  async selectHistoryMonth(value, reconciled, restore) {
    if (this.data.history.navigating) return
    const month = typeof value === 'string' ? value : value.currentTarget.dataset.month
    const summary = this.data.history.summary
    const months = summary.years.reduce(function (all, year) { return all.concat(year.months) }, [])
    const index = months.findIndex(function (m) { return m.month === month })
    if (index < 0 || !this.data.history.open || this.data.history.loading) return
    const same = month === this.data.history.month
    if (!same) { this._historyAnchor = ''; this._historyShown = 30 }
    const ticket = this._previewTicket = (this._previewTicket || 0) + 1
    this._historyItems = []
    this.patchHistory({ month: month, monthText: time.monthLabel(month), year: Number(month.slice(0, 4)),
      shown: restore && same ? this._historyShown || 30 : 30, total: months[index].count,
      groups: [], previewError: '', previewLoading: true, anchor: '',
      older: months[index + 1] ? months[index + 1].month : '', newer: months[index - 1] ? months[index - 1].month : '' })
    try {
      const body = await request.request({ path: '/api/v1/day-notes?month=' + encodeURIComponent(month) })
      if (!this.historyCurrent(ticket, true)) return
      const items = (body.items || []).filter(function (item) { return item.day.slice(0, 7) === month && item.day <= summary.as_of })
      const days = new Set(items.map(function (item) { return item.day })).size
      if (items.length !== months[index].count || days !== months[index].recorded_days) {
        if (!reconciled) return this.refreshHistory(true)
        this.patchHistory({ notice: '记录有更新，点击刷新目录' })
      }
      items.sort(function (a, b) { return a.day === b.day ? a.created_at - b.created_at || a.id - b.id : a.day < b.day ? 1 : -1 })
      this._historyItems = items
      this.patchHistory({ total: items.length, previewLoading: false })
      this.renderHistory()
      const anchor = restore && this._historyAnchor
      this.patchHistory({ anchor: anchor && items.some(function (item) { return 'history-note-' + item.id === anchor }) ? anchor : restore && !anchor ? '' : 'history-preview' })
    } catch (err) {
      if (this.historyCurrent(ticket, true)) this.patchHistory({ previewLoading: false, previewError: err.message || '记事加载失败' })
    }
  },

  selectHistoryYear(e) {
    const year = Number(e.currentTarget.dataset.year)
    if (this.data.history.year === year) { this.patchHistory({ year: 0 }); return }
    const group = this.data.history.summary.years.find(function (item) { return item.year === year })
    if (group && group.months.length) return this.selectHistoryMonth(group.months[0].month)
  },

  stepHistory(e) {
    const month = this.data.history[e.currentTarget.dataset.direction]
    if (month) return this.selectHistoryMonth(month)
  },

  retryHistoryPreview() { return this.selectHistoryMonth(this.data.history.month) },

  renderHistory() {
    const items = (this._historyItems || []).slice(0, this.data.history.shown)
    const counts = {}
    ;(this._historyItems || []).forEach(function (item) { counts[item.day] = (counts[item.day] || 0) + 1 })
    const groups = []
    items.forEach(function (item) {
      let group = groups[groups.length - 1]
      if (!group || group.day !== item.day) {
        group = { day: item.day, label: time.dateLabel(item.day), count: counts[item.day], items: [] }
        groups.push(group)
      }
      group.items.push(item)
    })
    this.patchHistory({ groups: groups })
  },

  moreHistory() {
    this._historyShown = this.data.history.shown + 30
    this.patchHistory({ shown: this._historyShown })
    this.renderHistory()
  },

  rememberHistoryScroll() {
    if (this._historyScrollTimer) return
    const self = this
    this._historyScrollTimer = setTimeout(function () {
      self._historyScrollTimer = null
      if (!self.data.history.open || self.data.history.loading || self.data.history.previewLoading) return
      const ticket = self._previewTicket
      self.createSelectorQuery().selectAll('.history-note').boundingClientRect().select('.history-scroll').boundingClientRect().exec(function (rects) {
        if (!self.historyCurrent(ticket, true)) return
        const viewport = rects[1]
        const first = viewport && (rects[0] || []).find(function (rect) { return rect.bottom > viewport.top && rect.top < viewport.bottom })
        self._historyAnchor = first ? first.id : ''
        self._historyShown = self.data.history.shown
      })
    }, 120)
  },

  async viewHistoryDay(e) {
    if (this._saving || this.data.history.navigating) { this.patchHistory({ notice: '请等待当前保存或加载结束' }); return }
    const id = Number(e.currentTarget.dataset.id)
    const item = (this._historyItems || []).find(function (note) { return note.id === id })
    if (!item) return
    this.patchHistory({ navigating: true, previewError: '' })
    const ticket = this._previewTicket
    const editor = this._editSession || 0
    const draft = this.data.draft
    try {
      if (draft.trim() && !await ui.confirm('放弃未保存的修改并查看当天？', '查看历史记录')) return
      if (!this.historyCurrent(ticket, true) || this._saving || editor !== (this._editSession || 0)) return
      if (this.data.draft !== draft) { this.patchHistory({ notice: '草稿已更新，请重新确认后查看' }); return }
      const body = await request.request({ path: '/api/v1/day-notes?day=' + encodeURIComponent(item.day) })
      if (!this.historyCurrent(ticket, true) || this._saving || editor !== (this._editSession || 0)) return
      if (this.data.draft !== draft) { this.patchHistory({ notice: '草稿已更新，请重新确认后查看' }); return }
      if (!(body.items || []).some(function (note) { return note.id === id })) {
        const refresh = this.refreshHistory()
        const refreshTicket = this._historyTicket
        await refresh
        if (this.historyCurrent(refreshTicket, false)) this.patchHistory({ notice: '这条记事已不存在，目录已刷新' })
        return
      }
      this._historyAnchor = 'history-note-' + id
      this._historyShown = this.data.history.shown
      this._searchTicket = (this._searchTicket || 0) + 1
      this._searchKey = ''; this._pendingKey = ''; this._searchItems = []
      this.setData({ q: '', searching: false, listFilter: 'all', listOpen: true })
      this.cancelEdit()
      this.setData({ month: item.day.slice(0, 7), monthText: time.monthLabel(item.day.slice(0, 7)), selected: item.day,
        dayTitle: time.dateLabel(item.day), dayRel: relativeLabel(item.day, this.data.today || time.todayISO()),
        showBack: item.day !== (this.data.today || time.todayISO()), items: shapeItems(body.items), highlightedId: id })
      this._monthItems = null
      this.closeHistory()
      this.load(undefined, undefined, true)
      wx.nextTick(function () { wx.pageScrollTo({ selector: '#day-note-' + id, duration: 240 }) })
      clearTimeout(this._highlightTimer)
      const self = this
      this._highlightTimer = setTimeout(function () { self.setData({ highlightedId: 0 }) }, 2400)
    } catch (err) {
      if (this.historyCurrent(ticket, true)) this.patchHistory({ previewError: err.message || '当天记事加载失败，请重试' })
    } finally {
      if (this.historyCurrent(ticket, true)) this.patchHistory({ navigating: false })
    }
  },

  onPullDownRefresh() {
    const self = this
    this.load().then(function () {
      wx.stopPullDownRefresh()
    }, function () {
      wx.stopPullDownRefresh()
      self.setData({ loading: false })
    })
  },

  prevMonth() {
    this.shiftMonth(-1)
  },

  nextMonth() {
    this.shiftMonth(1)
  },

  onPickMonth(e) {
    const next = e && e.detail && e.detail.value
    if (!next || next === this.data.month) return
    this.applyMonth(next, '', false)
  },

  shiftMonth(delta) {
    this.applyMonth(time.addMonth(this.data.month, delta), '', false)
  },

  applyMonth(month, preferredDay, keepEditor) {
    const today = this.data.today || time.todayISO()
    const selected = dayInMonth(month, preferredDay, today)
    this._monthItems = null
    const patch = {
      month: month,
      monthText: time.monthLabel(month),
      selected: selected,
      dayTitle: time.dateLabel(selected),
      dayRel: relativeLabel(selected, today),
      showBack: month !== today.slice(0, 7) || selected !== today,
      items: [],
      groups: [],
      monthCount: 0,
      activeDaysCount: 0,
      upcomingCount: 0,
    }
    if (!keepEditor) {
      this._editSession = (this._editSession || 0) + 1
      patch.editingId = 0
      patch.adding = false
      patch.draft = ''
      patch.draftCount = 0
      patch.canSave = false
    }
    this.setData(patch)
    this.load(month, selected)
  },

  backToday() {
    const today = this.data.today || time.todayISO()
    const month = today.slice(0, 7)
    if (this.data.month === month && Array.isArray(this._monthItems)) {
      this.selectDayInCurrentMonth(today, false)
      return
    }
    this.applyMonth(month, today, false)
  },

  tapDay(e) {
    const date = e.currentTarget.dataset.date
    this.pickDate(date, false)
  },

  pickDate(date, keepEditor) {
    if (!date) return
    if (date.slice(0, 7) !== this.data.month) {
      this.applyMonth(date.slice(0, 7), date, keepEditor)
      return
    }
    if (date === this.data.selected) {
      if (!keepEditor) this.setData({ error: '' })
      return
    }
    if (Array.isArray(this._monthItems)) {
      this.selectDayInCurrentMonth(date, keepEditor)
      return
    }
    const today = this.data.today || time.todayISO()
    const patch = {
      selected: date,
      dayTitle: time.dateLabel(date),
      dayRel: relativeLabel(date, today),
      showBack: this.data.month !== today.slice(0, 7) || date !== today,
      items: [],
    }
    if (!keepEditor) {
      this._editSession = (this._editSession || 0) + 1
      patch.editingId = 0
      patch.adding = false
      patch.draft = ''
      patch.draftCount = 0
      patch.canSave = false
    }
    this.setData(patch)
    this.load(this.data.month, date)
  },

  scrollToDayCard() {
    wx.pageScrollTo({ selector: '.day-card', duration: 240 })
  },

  /** 从一览里点某天：切过去之后把当天记事卡滚进视野。 */
  jumpDay(e) {
    const date = e.currentTarget.dataset.date
    if (!date) return
    this.pickDate(date, false)
    this.scrollToDayCard()
  },

  /** 从一览里点某天的「＋记一条」：切到那天并直接打开新增输入框。 */
  jumpAdd(e) {
    const date = e.currentTarget.dataset.date
    if (!date) return
    this.pickDate(date, true)
    this._editSession = (this._editSession || 0) + 1
    this.setData({
      adding: true,
      editingId: 0,
      draft: '',
      draftCount: 0,
      canSave: false,
      error: '',
    })
    this.scrollToDayCard()
  },

  /** 从一览里点某条的「编辑」：切到那天并直接就地编辑这条。 */
  jumpEdit(e) {
    const dataset = e.currentTarget.dataset || {}
    const id = Number(dataset.id)
    const day = dataset.day
    const body = String(dataset.body || '')
    if (!id || !day) return
    this.pickDate(day, true)
    this._editSession = (this._editSession || 0) + 1
    this.setData({
      adding: false,
      editingId: id,
      draft: body,
      draftCount: textCount(body),
      canSave: textCount(body.trim()) > 0,
      error: '',
    })
    this.scrollToDayCard()
  },

  selectDayInCurrentMonth(date, keepEditor) {
    const today = this.data.today || time.todayISO()
    const dayItems = (this._monthItems || []).filter(function (item) {
      return item.day === date
    })
    const patch = {
      selected: date,
      dayTitle: time.dateLabel(date),
      dayRel: relativeLabel(date, today),
      showBack: this.data.month !== today.slice(0, 7) || date !== today,
      error: '',
      items: dayItems,
    }
    if (!keepEditor) {
      this._editSession = (this._editSession || 0) + 1
      patch.editingId = 0
      patch.adding = false
      patch.draft = ''
      patch.draftCount = 0
      patch.canSave = false
    }
    this.setData(patch)
  },

  prevDay() {
    this.stepDay(-1)
  },

  nextDay() {
    this.stepDay(1)
  },

  stepDay(delta) {
    const nextDate = time.addDays(this.data.selected, delta)
    this.pickDate(nextDate, false)
  },

  onCalTouchStart(e) {
    const t = e && e.touches && e.touches[0]
    if (!t) return
    this._touchX = t.clientX
    this._touchY = t.clientY
  },

  onCalTouchEnd(e) {
    const t = e && e.changedTouches && e.changedTouches[0]
    if (!t || this._touchX == null) return
    const dx = t.clientX - this._touchX
    const dy = t.clientY - (this._touchY || 0)
    this._touchX = null
    this._touchY = null
    if (Math.abs(dx) < 50 || Math.abs(dx) <= Math.abs(dy) * 1.2) return
    this.shiftMonth(dx < 0 ? 1 : -1)
  },

  toggleList() {
    this.setData({ listOpen: !this.data.listOpen })
  },

  setFilter(e) {
    const next = (e.currentTarget.dataset && e.currentTarget.dataset.filter) || 'all'
    this.setData({
      listFilter: next,
      listOpen: true,
    })
    this.renderGroups()
  },

  toggleCal() {
    const next = !this.data.calOpen
    this.setData({ calOpen: next })
    writeCalOpen(next)
  },

  /** 当天卡片上的「＋记一条」：再点一次收起输入框。 */
  startAdd() {
    if (this.data.adding) {
      this.cancelEdit()
      return
    }
    this._editSession = (this._editSession || 0) + 1
    this.setData({
      adding: true,
      editingId: 0,
      draft: '',
      draftCount: 0,
      canSave: false,
      error: '',
    })
  },

  onSearch(e) {
    const q = String((e && e.detail && e.detail.value) || '')
    const has = q.trim().length > 0
    if (!has) {
      this.clearSearch()
      return
    }
    const bounds = searchBounds(this.data.month)
    this.setData({
      q: q,
      searching: true,
      scopeFrom: bounds.from,
      scopeTo: bounds.to,
    })
    // 同一范围只拉一次：已有结果或请求在途时，继续打字只在本地过滤。
    const key = bounds.from + '~' + bounds.to
    if ((this._searchKey === key && Array.isArray(this._searchItems)) || this._pendingKey === key) {
      this.renderGroups()
      return
    }
    this.loadSearch(bounds)
  },

  clearSearch() {
    this.setData({ q: '', searching: false, listError: '' })
    this.renderGroups()
  },

  /** 一览的数据源：搜索中用跨月结果，否则用当月。 */
  renderGroups() {
    const today = this.data.today || time.todayISO()
    const source = this.data.searching ? this._searchItems || [] : this._monthItems || []
    this.setData({
      groups: buildGroups(source, this.data.q, today, this.data.listFilter, this.data.searching),
    })
  },

  loadSearch(bounds) {
    const key = bounds.from + '~' + bounds.to
    const ticket = (this._searchTicket || 0) + 1
    this._searchTicket = ticket
    this._pendingKey = key
    const self = this
    return request.request({
      path: '/api/v1/day-notes?from=' + encodeURIComponent(bounds.from) + '&to=' + encodeURIComponent(bounds.to),
    }).then(function (body) {
      if (self._searchTicket !== ticket) return
      self._pendingKey = ''
      self._searchKey = key
      self._searchItems = shapeItems((body && body.items) || [])
      self.setData({ listError: '' })
      self.renderGroups()
    }).catch(function (err) {
      if (self._searchTicket !== ticket) return
      self._pendingKey = ''
      self.setData({ listError: (err && err.message) || '加载失败' })
    })
  },

  onDraft(e) {
    const draft = e.detail.value
    this.setData({
      draft: draft,
      draftCount: textCount(draft),
      canSave: textCount(String(draft || '').trim()) > 0,
    })
  },

  startEdit(e) {
    const id = Number(e.currentTarget.dataset.id)
    if (this.data.editingId === id && !this.data.adding) return
    const found = (this.data.items || []).filter(function (item) { return item.id === id })[0]
    if (!found) return
    this._editSession = (this._editSession || 0) + 1
    this.setData({
      adding: false,
      editingId: id,
      draft: found.body,
      draftCount: textCount(found.body),
      canSave: textCount(String(found.body || '').trim()) > 0,
      error: '',
    })
  },

  cancelEdit() {
    this._editSession = (this._editSession || 0) + 1
    this.setData({
      editingId: 0,
      adding: false,
      draft: '',
      draftCount: 0,
      canSave: false,
      error: '',
    })
  },

  load(month, day, preserveError) {
    const ticket = (this._ticket || 0) + 1
    this._ticket = ticket
    const self = this
    const editSession = this._editSession || 0
    const monthValue = month || this.data.month
    const dayValue = day || this.data.selected
    const today = this.data.today || time.todayISO()
    this.setData(preserveError ? { loading: true } : { loading: true, error: '' })
    return Promise.all([
      request.request({ path: '/api/v1/day-notes?month=' + encodeURIComponent(monthValue) }),
      request.request({ path: '/api/v1/day-notes?day=' + encodeURIComponent(dayValue) }),
    ]).then(function (pair) {
      if (self._ticket !== ticket) return
      const monthBody = pair[0] || {}
      const dayBody = pair[1] || {}
      if (!Array.isArray(monthBody.items) && self.data.selected !== dayValue) {
        return self.load(monthValue, self.data.selected, preserveError)
      }
      const days = monthBody.days || []
      const countsByDay = countsOf(days)
      let monthCount = 0
      let activeDaysCount = 0
      days.forEach(function (row) {
        const c = Number(row && row.count) || 0
        if (c > 0) {
          monthCount += c
          activeDaysCount += 1
        }
      })

      const shapedDayItems = shapeItems(dayBody.items)
      const fromMonth = Array.isArray(monthBody.items)
      let shapedMonthItems = fromMonth ? shapeItems(monthBody.items) : shapedDayItems
      const before = shapedMonthItems.length
      shapedMonthItems = mergeFresh(shapedMonthItems, fromMonth ? monthValue : '', self._fresh)
      if (shapedMonthItems.length !== before) {
        const recount = {}
        shapedMonthItems.forEach(function (item) {
          if (!item.day) return
          recount[item.day] = (recount[item.day] || 0) + 1
        })
        Object.keys(countsByDay).forEach(function (key) { delete countsByDay[key] })
        Object.keys(recount).forEach(function (key) { countsByDay[key] = recount[key] })
        monthCount = 0
        activeDaysCount = 0
        Object.keys(countsByDay).forEach(function (key) {
          monthCount += countsByDay[key]
          activeDaysCount += 1
        })
      }
      self._monthItems = fromMonth || shapedMonthItems.length ? shapedMonthItems : null
      // 当月数据变了，缓存的搜索结果跟着失效，下次搜索重新拉。
      self._searchKey = ''
      self._searchItems = null
      self._pendingKey = ''

      let upcomingCount = 0
      if (fromMonth || shapedMonthItems.length) {
        shapedMonthItems.forEach(function (item) {
          if (item.day >= today) upcomingCount += 1
        })
      } else {
        days.forEach(function (row) {
          if (row && row.day >= today) upcomingCount += Number(row.count) || 0
        })
      }

      const rawGrid = time.calendarGrid(monthValue, countsByDay)
      const selectedNow = self.data.selected
      self.setData({
        cells: decorateCells(rawGrid.cells, countsByDay),
        items: fromMonth || shapedMonthItems.length
          ? shapedMonthItems.filter(function (item) { return item.day === selectedNow })
          : shapedDayItems,
        monthCount: monthCount,
        activeDaysCount: activeDaysCount,
        upcomingCount: upcomingCount,
        loading: false,
      })
      if (!preserveError && (self._editSession || 0) === editSession) self.setData({ error: '' })
      if (self.data.searching) {
        self.loadSearch(searchBounds(monthValue))
        return
      }
      self.renderGroups()
    }).catch(function (err) {
      if (self._ticket !== ticket) return
      self.setData({ loading: false })
      if ((self._editSession || 0) === editSession && (!preserveError || !self.data.error)) {
        self.setData({ error: (err && err.message) || '加载失败' })
      }
    })
  },

  save() {
    // setData 的 busy 要下一帧才生效。键盘「完成」和按钮按下可能接连进来，这里同步挡住第二次。
    if (this._saving || !this.data.canSave) return
    const text = String(this.data.draft || '').trim()
    if (!text || Array.from(text).length > 200) {
      this.setData({ error: '正文须为 1–200 字' })
      return
    }
    const self = this
    const editSession = this._editSession || 0
    const submittedDraft = this.data.draft
    const editingId = this.data.editingId
    const path = editingId ? '/api/v1/day-notes/' + editingId : '/api/v1/day-notes'
    const method = editingId ? 'PATCH' : 'POST'
    const data = editingId ? { body: text } : { day: this.data.selected, body: text }
    this._saving = true
    this.setData({ busy: true, error: '' })
    return request.request({ path: path, method: method, data: data }).then(function (saved) {
      const item = shapeItems([saved])[0]
      if (item && item.id) {
        if (!self._fresh) self._fresh = {}
        self._fresh[item.id] = item
        const monthItems = (Array.isArray(self._monthItems) ? self._monthItems : []).filter(function (note) {
          return note.id !== item.id
        })
        monthItems.push(item)
        self._monthItems = monthItems
        if ((self._editSession || 0) === editSession && item.day === self.data.selected) {
          self.setData({ items: monthItems.filter(function (note) { return note.day === self.data.selected }) })
        }
        self.renderGroups()
      }
      if ((self._editSession || 0) === editSession) {
        if (self.data.draft === submittedDraft) {
          self.cancelEdit()
        } else if (!editingId) {
          // 等待期间继续写的内容仍属于这条记事，后续保存应修改刚创建的记录。
          self.setData({ editingId: saved.id, adding: false })
        }
      }
      ui.ok(editingId ? '已保存' : '已记下')
      if (self.data.history.open) self.refreshHistory()
      // 只刷新列表，不能让旧提交覆盖另一个编辑会话的提示。
      return self.load(undefined, undefined, true)
    }).catch(function (err) {
      if ((self._editSession || 0) === editSession) {
        self.setData({ error: (err && err.message) || '保存失败' })
      }
    }).finally(function () {
      self._saving = false
      self.setData({ busy: false })
    })
  },

  remove(e) {
    const id = Number(e.currentTarget.dataset.id)
    if (!id) return
    const self = this
    ui.confirm('删除这条记事？', '删除').then(function (ok) {
      if (!ok) return
      request.request({ path: '/api/v1/day-notes/' + id, method: 'DELETE' }).then(function () {
        if (self.data.history.open) self.refreshHistory()
        if (self._fresh) delete self._fresh[id]
        if (self.data.editingId === id) {
          self.setData({
            editingId: 0,
            adding: false,
            draft: '',
            draftCount: 0,
            canSave: false,
          })
        }
        return self.load()
      }).catch(function (err) {
        self.setData({ error: (err && err.message) || '删除失败' })
      })
    })
  },
})
