/**
 * 记人情 / 改人情。
 *
 * 事由用常见项做 chips（婚礼、满月、乔迁…），也可以自己写；
 * 事由上限 16 字，由后端截断，这里先拦一下提示更清楚。
 *
 * 传 contact_id 进来就是「给某人记一笔」（从某人明细页过来）。
 */

const request = require('../../utils/request')
const session = require('../../utils/session')
const money = require('../../utils/money')
const time = require('../../utils/time')
const ui = require('../../utils/ui')

const OCCASIONS = ['婚礼', '满月', '乔迁', '生日', '探病', '升学', '白事', '节日']

Page({
  data: {
    id: '',
    kind: 'give', // give 送出 | receive 收入
    amountText: '',
    date: '',
    dateQuick: [],
    occasion: '',
    customOccasion: '',
    note: '',
    contactId: '',
    contactName: '',
    // 下拉定位用的下标（picker 的 value 要下标，不是 id）
    contactIndex: 0,
    contacts: [],
    contactNames: [],
    occasions: OCCASIONS,
    keepGoing: false,
    saving: false,
    err: '',
  },

  onLoad(query) {
    if (!session.ensure()) return
    const q = query || {}
    const date = q.date || time.todayISO()
    this.setData({
      id: q.id || '',
      contactId: q.contact_id || '',
      date: date,
      dateQuick: this.buildQuick(date),
    })
    wx.setNavigationBarTitle({ title: q.id ? '改人情' : '记人情' })
    this.loadContacts().then(() => {
      if (q.id) this.loadGift(q.id)
      else this.pickDefaultContact()
    })
  },

  buildQuick(date) {
    const today = time.todayISO()
    return [
      { value: today, label: '今天' },
      { value: time.addDays(today, -1), label: '昨天' },
      { value: time.addDays(today, -2), label: '前天' },
    ].map((m) => ({ value: m.value, label: m.label, on: m.value === date }))
  },

  loadContacts() {
    return request
      .get('/api/v1/contacts')
      .then((res) => {
        const contacts = ((res && res.items) || []).filter((c) => !c.archived)
        this.setData({
          contacts: contacts,
          contactNames: contacts.map((c) => c.name + (c.relation ? '（' + c.relation + '）' : '')),
        })
        this.syncContactName()
      })
      .catch((err) => ui.fail(err, '联系人加载失败'))
  },

  pickDefaultContact() {
    if (this.data.contactId) {
      this.syncContactName()
      return
    }
    const first = this.data.contacts[0]
    if (first) {
      this.setData({ contactId: first.id, contactName: first.name, contactIndex: 0 })
    }
  },

  /** 同步显示名与下拉下标。找不到（联系人已归档）时保留服务端给的名字。 */
  syncContactName() {
    const index = this.data.contacts.findIndex((c) => c.id === this.data.contactId)
    const hit = this.data.contacts[index]
    this.setData({
      contactIndex: index < 0 ? 0 : index,
      contactName: hit ? hit.name : this.data.contactName,
    })
  },

  loadGift(id) {
    ui.withLoading('加载中', () => request.get('/api/v1/gifts/' + id))
      .then((g) => {
        const date = time.occurredAtToDate(g.occurred_at)
        const known = OCCASIONS.indexOf(g.occasion) >= 0
        this.setData({
          kind: g.kind,
          amountText: money.formatYuan(g.amount_cents),
          date: date,
          dateQuick: this.buildQuick(date),
          occasion: known ? g.occasion : '',
          customOccasion: known ? '' : g.occasion || '',
          note: g.note || '',
          contactId: g.contact_id,
          contactName: g.contact_name || '',
        })
      })
      .catch((err) => ui.fail(err, '记录加载失败'))
  },

  // ---- 表单 ----

  setKind(e) {
    this.setData({ kind: e.currentTarget.dataset.kind })
  },

  onAmount(e) {
    this.setData({ amountText: e.detail.value, err: '' })
  },

  onNote(e) {
    this.setData({ note: e.detail.value })
  },

  onCustomOccasion(e) {
    this.setData({ customOccasion: e.detail.value, occasion: '' })
  },

  pickOccasion(e) {
    const value = e.currentTarget.dataset.value
    this.setData({ occasion: this.data.occasion === value ? '' : value, customOccasion: '' })
  },

  tapQuick(e) {
    const date = e.currentTarget.dataset.date
    this.setData({ date: date, dateQuick: this.buildQuick(date) })
  },

  onDate(e) {
    const date = e.detail.value
    this.setData({ date: date, dateQuick: this.buildQuick(date) })
  },

  pickContact(e) {
    const index = Number(e.detail.value)
    const contact = this.data.contacts[index]
    if (!contact) return
    this.setData({ contactId: contact.id, contactName: contact.name, contactIndex: index })
  },

  addContact() {
    ui.prompt({ title: '新增联系人', placeholder: '姓名' }).then((name) => {
      if (name == null || !name) return
      ui.withLoading('保存中', () => request.post('/api/v1/contacts', { name: name }))
        .then((c) => {
          // 接口对同名联系人是「返回已有的那个」，所以这里直接采信返回的 id。
          return this.loadContacts().then(() => {
            this.setData({ contactId: c.id, contactName: c.name })
            this.syncContactName()
          })
        })
        .catch((err) => ui.fail(err, '保存失败'))
    })
  },

  onKeepGoing(e) {
    this.setData({ keepGoing: e.detail.value })
  },

  // ---- 保存 ----

  save() {
    if (this.data.saving) return
    const cents = money.yuanExprToCents(this.data.amountText)
    if (!cents) {
      this.setData({ err: '金额填一下' })
      return
    }
    if (!this.data.contactId) {
      this.setData({ err: '请选择对方' })
      return
    }
    const occasion = (this.data.occasion || this.data.customOccasion || '').trim()
    if (occasion.length > 16) {
      this.setData({ err: '事由最多 16 字' })
      return
    }

    const payload = {
      contact_id: this.data.contactId,
      kind: this.data.kind,
      amount_cents: cents,
      date: this.data.date,
      occasion: occasion,
      note: this.data.note,
    }

    this.setData({ saving: true, err: '' })
    const task = this.data.id
      ? request.request({ path: '/api/v1/gifts/' + this.data.id, method: 'PATCH', data: payload })
      : request.post('/api/v1/gifts', payload)

    task
      .then(() => {
        this.setData({ saving: false })
        if (this.data.id) {
          ui.ok('已保存')
          setTimeout(() => wx.navigateBack(), 600)
          return
        }
        if (this.data.keepGoing) {
          this.setData({ amountText: '', note: '', customOccasion: '' })
          wx.showToast({ title: '已记下，继续', icon: 'success', duration: 900 })
          return
        }
        ui.ok('已记下')
        setTimeout(() => wx.navigateBack(), 600)
      })
      .catch((err) => {
        this.setData({ saving: false })
        ui.fail(err, '保存失败')
      })
  },

  async remove() {
    if (!this.data.id) return
    const yes = await ui.confirm('删掉这条人情记录？')
    if (!yes) return
    ui.withLoading('删除中', () => request.del('/api/v1/gifts/' + this.data.id))
      .then(() => {
        ui.ok('已删除')
        setTimeout(() => wx.navigateBack(), 600)
      })
      .catch((err) => ui.fail(err, '删除失败'))
  },
})
