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
        const date = found.date
        const calendar = date && date.calendar === 'lunar' ? 'lunar' : 'solar'
        const month = date && date.month ? Number(date.month) : 1
        const day = date && date.day ? Number(date.day) : 1
        const label = date ? date.kind_label || date.kind || '' : ''
        if (label && tags.indexOf(label) < 0) tags.unshift(label)
        this.setData(Object.assign(patch, {
          tags: tags,
          name: found.name || '',
          relation: found.relation || '',
          archived: !!found.archived,
          selected: label,
          showDate: !!label,
          calendar: calendar,
          leap: !!(date && date.leap),
          year: date && date.year ? String(date.year) : '',
          yearLabel: label === '生日' ? '出生年' : '年份',
          monthIndex: month - 1,
          dayIndex: day - 1,
          monthNames: calendar === 'lunar' ? LUNAR_MONTHS : solarMonths(),
          dayNames: dayNames(calendar, month),
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

  clearDate() {
    this.setData({
      selected: '',
      draft: '',
      naming: false,
      showDate: false,
      yearLabel: '年份',
      err: '',
    })
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
    const label = this.data.naming && draft ? draft : this.data.selected
    const yearText = String(this.data.year || '').trim()
    const date = label
      ? {
          kind: label,
          calendar: this.data.calendar,
          month: this.data.monthIndex + 1,
          day: this.data.dayIndex + 1,
          year: yearText ? Number(yearText) : null,
          leap: this.data.calendar === 'lunar' && this.data.leap,
        }
      : null
    const payload = { name: name, relation: String(this.data.relation || '').trim(), date: date }
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
