/**
 * 新增 / 编辑联系人。日子可空。名称和月日交给服务端校验，这里只负责选。
 */

const { toId } = require('../../utils/id')
const request = require('../../utils/request')
const session = require('../../utils/session')
const ui = require('../../utils/ui')

const QUICK_RELATIONS = ['朋友', '同事', '亲戚', '同学', '家人', '邻居']
const LUNAR_MONTHS = ['正月', '二月', '三月', '四月', '五月', '六月', '七月', '八月', '九月', '十月', '冬月', '腊月']
const SOLAR_DAYS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

function solarMonths() {
  const names = []
  for (let i = 1; i <= 12; i += 1) names.push(i + '月')
  return names
}

function dayNames(calendar, month) {
  const max = calendar === 'lunar' ? 30 : SOLAR_DAYS[month - 1] || 31
  const names = []
  for (let i = 1; i <= max; i += 1) names.push(calendar === 'lunar' ? lunarDay(i) : i + '日')
  return names
}

function dateSummary(item) {
  const lunar = item.calendar === 'lunar'
  const month = lunar
    ? (item.leap ? '闰' : '') + (LUNAR_MONTHS[item.month - 1] || '') + lunarDay(item.day)
    : item.month + '月' + item.day + '日'
  const year = item.year ? item.year + '年' : ''
  return item.kind + ' · ' + (lunar ? '农历' : '阳历') + ' ' + year + month
}

function withSummary(item) {
  return Object.assign({}, item, { summary: dateSummary(item) })
}

function sameDate(a, b) {
  return a.kind === b.kind && a.calendar === b.calendar && a.month === b.month && a.day === b.day && String(a.year || '') === String(b.year || '') && !!a.leap === !!b.leap
}

function lunarDay(value) {
  const n = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十']
  if (value <= 10) return '初' + n[value]
  if (value < 20) return '十' + n[value - 10]
  if (value === 20) return '二十'
  if (value < 30) return '廿' + n[value - 20]
  return '三十'
}

Page({
  data: {
    id: '',
    isNew: true,
    loading: true,
    name: '',
    relation: '',
    archived: false,
    quickRelations: QUICK_RELATIONS,
    tags: [],
    dates: [],
    editingIndex: -1,
    selected: '',
    draft: '',
    naming: false,
    addingTag: false,
    showDate: false,
    calendar: 'solar',
    monthIndex: 0,
    dayIndex: 0,
    monthNames: solarMonths(),
    dayNames: dayNames('solar', 1),
    year: '',
    leap: false,
    yearLabel: '年份',
    saving: false,
    err: '',
  },

  onLoad(query) {
    if (!session.ensure()) return
    const id = (query && query.id) || 'new'
    const isNew = id === 'new'
    this.setData({ id: isNew ? '' : id, isNew: isNew })
    wx.setNavigationBarTitle({ title: isNew ? '新增联系人' : '编辑联系人' })
    this.load(isNew ? '' : id)
  },

  load(id) {
    const jobs = [request.get('/api/v1/dicts', { kind: 'contact_date' })]
    if (id) jobs.push(request.get('/api/v1/contacts'))
    return Promise.all(jobs)
      .then((res) => {
        const tags = ((res[0] && res[0].items) || []).map((item) => item.name)
        const patch = { loading: false, tags: tags }
        if (!id) {
          this.setData(patch)
          return
        }
        const found = ((res[1] && res[1].items) || []).find((item) => String(item.id) === String(toId(id)))
        if (!found) {
          this.setData(Object.assign(patch, { err: '联系人不存在' }))
          return
        }
        const rawDates = (found.dates && found.dates.length) ? found.dates : (found.date ? [found.date] : [])
        const dates = rawDates.map(function (date, index) {
          const calendar = date.calendar === 'lunar' ? 'lunar' : 'solar'
          const month = date.month ? Number(date.month) : 1
          const day = date.day ? Number(date.day) : 1
          const label = date.kind_label || date.kind || ''
          if (label && tags.indexOf(label) < 0) tags.unshift(label)
          return withSummary({
            key: 'd-' + (date.id || index),
            kind: label,
            calendar: calendar,
            month: month,
            day: day,
            year: date.year ? String(date.year) : '',
            leap: !!date.leap,
          })
        })
        this.setData(Object.assign(patch, {
          tags: tags,
          dates: dates,
          editingIndex: -1,
          name: found.name || '',
          relation: found.relation || '',
          archived: !!found.archived,
          selected: '',
          showDate: false,
          calendar: 'solar',
          leap: false,
          year: '',
          yearLabel: '年份',
          monthIndex: 0,
          dayIndex: 0,
          monthNames: solarMonths(),
          dayNames: dayNames('solar', 1),
        }))
      })
      .catch((err) => {
        this.setData({ loading: false })
        ui.fail(err, '加载失败')
      })
  },

  onName(e) {
    this.setData({ name: e.detail.value, err: '' })
  },

  onRelation(e) {
    this.setData({ relation: e.detail.value })
  },

  pickRelation(e) {
    const rel = e.currentTarget.dataset.rel || ''
    this.setData({ relation: this.data.relation === rel ? '' : rel })
  },

  pickTag(e) {
    const label = e.currentTarget.dataset.tag || ''
    const selected = this.data.selected === label && !this.data.naming ? '' : label
    this.setData({
      selected: selected,
      naming: false,
      draft: '',
      showDate: !!selected,
      yearLabel: selected === '生日' ? '出生年' : '年份',
      err: '',
    })
  },

  toggleNaming() {
    if (this.data.naming) {
      this.setData({ naming: false, draft: '', showDate: !!this.data.selected, err: '' })
      return
    }
    this.setData({ naming: true, showDate: true, err: '' })
  },

  onDraft(e) {
    this.setData({ draft: e.detail.value })
  },

  addTag() {
    const label = String(this.data.draft || '').trim()
    if (!label || this.data.addingTag) return
    this.setData({ addingTag: true, err: '' })
    request
      .post('/api/v1/dicts', { kind: 'contact_date', name: label })
      .then((saved) => {
        const name = (saved && saved.name) || label
        const tags = this.data.tags.slice()
        if (tags.indexOf(name) < 0) tags.push(name)
        this.setData({
          tags: tags,
          selected: name,
          draft: '',
          naming: false,
          addingTag: false,
          showDate: true,
          yearLabel: name === '生日' ? '出生年' : '年份',
        })
      })
      .catch((err) => {
        this.setData({ addingTag: false })
        ui.fail(err, '添加失败')
      })
  },

  clearComposer() {
    this.setData({
      selected: '',
      draft: '',
      naming: false,
      showDate: false,
      editingIndex: -1,
      year: '',
      leap: false,
      yearLabel: '年份',
      err: '',
    })
  },

  currentDraft() {
    const draft = String(this.data.draft || '').trim()
    const kind = this.data.naming && draft ? draft : this.data.selected
    if (!kind) return null
    return {
      key: this.data.editingIndex >= 0 ? (this.data.dates[this.data.editingIndex] || {}).key : 'n-' + Date.now(),
      kind: kind,
      calendar: this.data.calendar,
      month: this.data.monthIndex + 1,
      day: this.data.dayIndex + 1,
      year: String(this.data.year || '').trim(),
      leap: this.data.calendar === 'lunar' && this.data.leap,
    }
  },

  commitDate() {
    const item = this.currentDraft()
    if (!item) {
      this.setData({ err: '请先选择或填写日子名称' })
      return false
    }
    const dates = this.data.dates.slice()
    const dup = dates.some((row, index) => index !== this.data.editingIndex && sameDate(row, item))
    if (dup) {
      this.setData({ err: '同一日子不能重复' })
      return false
    }
    if (this.data.editingIndex < 0 && dates.length >= 8) {
      this.setData({ err: '日子最多 8 个' })
      return false
    }
    const next = withSummary(item)
    if (this.data.editingIndex < 0) dates.push(next)
    else dates.splice(this.data.editingIndex, 1, next)
    this.setData({
      dates: dates,
      selected: '',
      draft: '',
      naming: false,
      showDate: false,
      editingIndex: -1,
      year: '',
      leap: false,
      yearLabel: '年份',
      err: '',
    })
    return true
  },

  editDate(e) {
    const index = Number(e.currentTarget.dataset.index)
    const item = this.data.dates[index]
    if (!item) return
    const days = dayNames(item.calendar, item.month)
    this.setData({
      editingIndex: index,
      selected: item.kind,
      draft: '',
      naming: false,
      showDate: true,
      calendar: item.calendar,
      leap: !!item.leap,
      year: item.year || '',
      yearLabel: item.kind === '生日' ? '出生年' : '年份',
      monthIndex: item.month - 1,
      dayIndex: Math.min(item.day - 1, days.length - 1),
      monthNames: item.calendar === 'lunar' ? LUNAR_MONTHS : solarMonths(),
      dayNames: days,
      err: '',
    })
  },

  removeDate(e) {
    const index = Number(e.currentTarget.dataset.index)
    const dates = this.data.dates.slice()
    dates.splice(index, 1)
    let editingIndex = this.data.editingIndex
    if (editingIndex === index) {
      this.setData({ dates: dates })
      this.clearComposer()
      return
    }
    if (editingIndex > index) editingIndex -= 1
    this.setData({ dates: dates, editingIndex: editingIndex })
  },

  pickCalendar(e) {
    const calendar = e.currentTarget.dataset.cal === 'lunar' ? 'lunar' : 'solar'
    const month = this.data.monthIndex + 1
    const days = dayNames(calendar, month)
    let dayIndex = this.data.dayIndex
    if (dayIndex >= days.length) dayIndex = days.length - 1
    this.setData({
      calendar: calendar,
      leap: calendar === 'lunar' ? this.data.leap : false,
      monthNames: calendar === 'lunar' ? LUNAR_MONTHS : solarMonths(),
      dayNames: days,
      dayIndex: dayIndex,
    })
  },

  toggleLeap() {
    this.setData({ leap: !this.data.leap })
  },

  pickMonth(e) {
    const monthIndex = Number(e.detail.value) || 0
    const days = dayNames(this.data.calendar, monthIndex + 1)
    let dayIndex = this.data.dayIndex
    if (dayIndex >= days.length) dayIndex = days.length - 1
    this.setData({ monthIndex: monthIndex, dayNames: days, dayIndex: dayIndex })
  },

  pickDay(e) {
    this.setData({ dayIndex: Number(e.detail.value) || 0 })
  },

  onYear(e) {
    this.setData({ year: e.detail.value })
  },

  goBack() {
    wx.navigateBack()
  },

  toggleArchive() {
    if (this.data.isNew || this.data.saving) return
    this.setData({ saving: true, err: '' })
    request
      .request({
        path: '/api/v1/contacts/' + this.data.id,
        method: 'PATCH',
        data: { archived: !this.data.archived },
      })
      .then(() => wx.navigateBack())
      .catch((err) => {
        this.setData({ saving: false })
        ui.fail(err, '操作失败')
      })
  },

  save() {
    if (this.data.saving) return
    const name = String(this.data.name || '').trim()
    if (!name) {
      this.setData({ err: '请填写姓名' })
      return
    }
    const draft = String(this.data.draft || '').trim()
    if (this.data.naming && !draft && !this.data.selected) {
      this.setData({ err: '请填写日子名称，或点取消' })
      return
    }
    if ((this.data.selected || (this.data.naming && draft)) && !this.commitDate()) return
    const dates = this.data.dates.map(function (item) {
      return {
        kind: item.kind,
        calendar: item.calendar,
        month: item.month,
        day: item.day,
        year: item.year ? Number(item.year) : null,
        leap: item.calendar === 'lunar' && !!item.leap,
      }
    })
    const payload = { name: name, relation: String(this.data.relation || '').trim(), dates: dates }
    this.setData({ saving: true, err: '' })
    const task = this.data.isNew
      ? request.post('/api/v1/contacts', payload)
      : request.request({ path: '/api/v1/contacts/' + this.data.id, method: 'PATCH', data: payload })
    task
      .then(() => wx.navigateBack())
      .catch((err) => {
        this.setData({ saving: false })
        ui.fail(err, '保存失败')
      })
  },
})
