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
const nav = require('../../utils/nav')
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
    convertTx: '',
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
    alsoTx: false,
    accounts: [],
    accountNames: [],
    accountId: '',
    accountIndex: 0,
    accountName: '选择账户',
    cats: [],
    categoryNames: [],
    categoryId: '',
    categoryIndex: 0,
    categoryName: '无分类',
    saving: false,
    err: '',
  },

  onLoad(query) {
    if (!session.ensure()) return
    const q = query || {}
    const date = q.date || time.todayISO()
    const convertTx = toId(q.convert_tx) || ''
    const carried = convertTx ? nav.takeCarry() : null
    const carriedNote = carried && carried.note != null ? carried.note : ''
    this.setData({
      id: convertTx ? '' : toId(q.id) || '',
      convertTx: convertTx,
      contactId: toId(q.contact_id) || '',
      kind: q.kind === 'receive' ? 'receive' : 'give',
      amountText: q.amount || '',
      note: convertTx ? nav.repairNote(nav.noteFromPrevPage() || carriedNote) : q.note || '',
      date: date,
      dateText: shortDate(date),
    })
    wx.setNavigationBarTitle({ title: convertTx ? '转成人情' : q.id ? '改人情' : '记人情' })
    const jobs = [this.loadContacts()]
    if (!convertTx && !toId(q.id)) jobs.push(this.loadRefs())
    Promise.all(jobs).then(() => {
      if (q.id && !convertTx) this.loadGift(q.id)
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

  loadRefs() {
    return Promise.all([request.get('/api/v1/accounts'), request.get('/api/v1/categories')])
      .then((res) => {
        const accounts = ((res[0] && res[0].items) || []).filter((a) => !a.archived)
        const cats = ((res[1] && res[1].items) || []).filter((c) => !c.archived)
        this.setData({
          accounts: accounts,
          accountNames: accounts.map((a) => a.name),
          accountId: this.data.accountId || (accounts[0] ? accounts[0].id : ''),
          cats: cats,
        })
        this.syncAccountName()
        this.pickDefaultCategory()
      })
      .catch((err) => ui.fail(err, '账户/分类加载失败'))
  },

  syncAccountName() {
    const accounts = this.data.accounts || []
    const index = accounts.findIndex((a) => a.id === this.data.accountId)
    const hit = accounts[index]
    this.setData({
      accountIndex: index < 0 ? 0 : index,
      accountName: hit ? hit.name : '选择账户',
    })
  },

  /** 送出对应支出分类，收到对应收入分类。 */
  catsForKind() {
    const kind = this.data.kind === 'receive' ? 'income' : 'expense'
    return (this.data.cats || []).filter((c) => c.kind === kind)
  },

  pickDefaultCategory() {
    const list = this.catsForKind()
    const keep = list.some((c) => c.id === this.data.categoryId)
    const categoryId = keep ? this.data.categoryId : list[0] ? list[0].id : ''
    const index = list.findIndex((c) => c.id === categoryId)
    this.setData({
      categoryNames: list.map((c) => c.name),
      categoryId: categoryId,
      categoryIndex: index < 0 ? 0 : index,
      categoryName: index < 0 ? '无分类' : list[index].name,
    })
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
          note: nav.repairNote(g.note || ''),
          contactId: g.contact_id,
          contactName: g.contact_name || '',
        }, occasionView(known ? g.occasion : '', known ? '' : g.occasion || '')))
      })
      .catch((err) => ui.fail(err, '记录加载失败'))
  },

  // ---- 表单 ----

  setKind(e) {
    this.setData({ kind: e.currentTarget.dataset.kind })
    this.pickDefaultCategory()
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

  onAlsoTx(e) {
    this.setData({ alsoTx: !!e.detail.value, err: '' })
    if (e.detail.value) this.pickDefaultCategory()
  },

  pickCategory(e) {
    const cat = this.catsForKind()[Number(e.detail.value)]
    if (!cat) return
    this.setData({ categoryId: cat.id, categoryIndex: Number(e.detail.value), categoryName: cat.name })
  },

  pickAccount(e) {
    const account = this.data.accounts[Number(e.detail.value)]
    if (!account) return
    this.setData({ accountId: account.id })
    this.syncAccountName()
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

    const alsoTx = !this.data.id && !this.data.convertTx && this.data.alsoTx
    if (alsoTx && !this.data.accountId) {
      this.setData({ err: '请选择账户' })
      return
    }
    if (alsoTx && !this.data.categoryId) {
      this.setData({ err: '请选择分类' })
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
    if (alsoTx) {
      payload.account_id = this.data.accountId
      payload.category_id = this.data.categoryId
    }

    this.setData({ saving: true, err: '' })
    const task = this.data.convertTx
      ? request.request({ path: '/api/v1/transactions/' + this.data.convertTx + '/to-gift', method: 'POST', data: payload })
      : this.data.id
        ? request.request({ path: '/api/v1/gifts/' + this.data.id, method: 'PATCH', data: payload })
        : request.post('/api/v1/gifts', payload)

    task
      .then(() => {
        this.setData({ saving: false })
        if (this.data.convertTx) {
          ui.ok('已转成人情')
          setTimeout(() => wx.navigateBack({ delta: 2 }), 600)
          return
        }
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
        ui.ok(this.data.alsoTx ? '人情和明细' : '已记下')
        setTimeout(() => wx.navigateBack(), 600)
      })
      .catch((err) => {
        this.setData({ saving: false })
        ui.fail(err, '保存失败')
      })
  },

  async toTransaction() {
    if (!this.data.id) return
    const yes = await ui.confirm('这条会从人情里拿掉，改记到明细并计入所选账户。', '转成明细')
    if (!yes) return
    nav.carry({ note: this.data.note || '' })
    nav.go('tx-form', {
      convert_gift: this.data.id,
      amount: this.data.amountText,
      date: this.data.date,
      kind: this.data.kind === 'receive' ? 'income' : 'expense',
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
