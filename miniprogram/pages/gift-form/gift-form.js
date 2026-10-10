/**
 * 记人情 / 改人情。
 *
 * 对方、日期、事由放在一行下拉里。事由选「自己写」时再出现输入框。
 * 事由上限 16 字，由后端截断，这里先拦一下提示更清楚。
 *
 * 传 contact_id 进来就是「给某人记一笔」（从某人明细页过来）。
 */

const { toId } = require('../../utils/id')
const request = require('../../utils/request')
const session = require('../../utils/session')
const money = require('../../utils/money')
const time = require('../../utils/time')
const ui = require('../../utils/ui')

const OCCASIONS = ['婚礼', '满月', '乔迁', '生日', '探病', '升学', '白事', '节日']
const OCCASION_NAMES = OCCASIONS.concat(['自己写'])

function occasionView(occasion, custom) {
  const known = OCCASIONS.indexOf(occasion)
  if (known >= 0) {
    return { occasion: occasion, customOccasion: '', occasionIndex: known, occasionName: occasion, writing: false }
  }
  const text = String(custom || '')
  if (text.trim()) {
    return {
      occasion: '',
      customOccasion: text,
      occasionIndex: OCCASIONS.length,
      occasionName: text.trim(),
      writing: true,
    }
  }
  return { occasion: '', customOccasion: '', occasionIndex: 0, occasionName: '选事由', writing: false }
}

function shortDate(date) {
  if (!date) return '日期'
  const parts = String(date).split('-')
  if (parts.length < 3) return '日期'
  return Number(parts[1]) + '/' + Number(parts[2])
}

Page({
  data: {
    id: '',
    kind: 'give', // give 送出 | receive 收入
    amountText: '',
    date: '',
    dateText: '',
    occasion: '',
    customOccasion: '',
    occasionIndex: 0,
    occasionName: '选事由',
    occasionNames: OCCASION_NAMES,
    writing: false,
    note: '',
    contactId: '',
    contactName: '',
    // 下拉定位用的下标（picker 的 value 要下标，不是 id）
    contactIndex: 0,
    contacts: [],
    contactNames: [],
    keepGoing: false,
    saving: false,
    err: '',
  },

  onLoad(query) {
    if (!session.ensure()) return
    const q = query || {}
    const date = q.date || time.todayISO()
    this.setData({
      id: toId(q.id) || '',
      contactId: toId(q.contact_id) || '',
      date: date,
      dateText: shortDate(date),
    })
    wx.setNavigationBarTitle({ title: q.id ? '改人情' : '记人情' })
    this.loadContacts().then(() => {
      if (q.id) this.loadGift(q.id)
      else this.pickDefaultContact()
    })
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
        this.setData(Object.assign({
          kind: g.kind,
          amountText: money.formatYuan(g.amount_cents),
          date: date,
          dateText: shortDate(date),
          note: g.note || '',
          contactId: g.contact_id,
          contactName: g.contact_name || '',
        }, occasionView(known ? g.occasion : '', known ? '' : g.occasion || '')))
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
    const value = e.detail.value
    const text = String(value || '').trim()
    this.setData({
      customOccasion: value,
      occasion: '',
      occasionIndex: OCCASIONS.length,
      occasionName: text || '自己写',
      writing: true,
    })
  },

  pickOccasion(e) {
    const index = Number(e.detail.value)
    if (index >= OCCASIONS.length) {
      const text = String(this.data.customOccasion || '').trim()
      this.setData({
        occasion: '',
        occasionIndex: OCCASIONS.length,
        occasionName: text || '自己写',
        writing: true,
      })
      return
    }
    this.setData(occasionView(OCCASIONS[index], ''))
  },

  onDate(e) {
    const date = e.detail.value
    this.setData({ date: date, dateText: shortDate(date) })
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
          const picked = this.data.occasion ? occasionView(this.data.occasion, '') : occasionView('', '')
          this.setData({
            amountText: '',
            note: '',
            occasion: picked.occasion,
            customOccasion: picked.customOccasion,
            occasionIndex: picked.occasionIndex,
            occasionName: picked.occasionName,
            writing: picked.writing,
          })
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
