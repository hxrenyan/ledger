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
  },

  onLoad() {
    this.setData({ calOpen: readCalOpen() })
  },

  onShow() {
    if (!session.getToken()) {
      session.goLogin()
      return
    }
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
