/**
 * 记一笔 / 改一笔。
 *
 * 传 id 就是编辑：先拉详情回填，保存走 PATCH。没有 id 就是新增。
 *
 * 三个细节值得留意：
 * 1. 金额支持算式（12+8、3*4），由 utils/money 按「分」求值，服务端还会再校验一次；
 * 2. 收据上传不走 wx.uploadFile，走 utils/request 里手工拼的 multipart——收据接口
 *    读的是分片自己的 Content-Type，只认 jpeg/png/webp，且必须小于 512KB，
 *    所以先挑图、按 512KB 压（utils/image 的梯度压缩），压完再传；
 * 3. 看收据要把 token 带上去，previewImage 不能加请求头，先用 downloadFile 下到本地。
 */

const { toId } = require('../../utils/id')
const request = require('../../utils/request')
const config = require('../../config')
const image = require('../../utils/image')
const money = require('../../utils/money')
const nav = require('../../utils/nav')
const time = require('../../utils/time')
const ui = require('../../utils/ui')

function formatFullDate(date) {
  if (!date) return '选择日期'
  const thisYear = time.todayISO().slice(0, 4)
  if (date.slice(0, 4) !== thisYear) {
    const p = String(date).split('-')
    if (p.length >= 3) return p[0] + '年' + Number(p[1]) + '月' + Number(p[2]) + '日'
  }
  return time.dateLabel(date)
}

function calcDatePreset(date) {
  const today = time.todayISO()
  if (date === today) return 'today'
  if (date === time.addDays(today, -1)) return 'yesterday'
  if (date === time.addDays(today, -2)) return 'beforeYesterday'
  return ''
}

function calcAmountPreview(raw) {
  const s = String(raw == null ? '' : raw).trim()
  if (!s || !/[+\-*/＋－×÷]/.test(s)) return ''
  const cents = money.yuanExprToCents(s)
  if (cents) return '= ¥' + money.formatYuanGrouped(cents)
  return '算式待完成…'
}

const RECEIPT_MAX = 512 * 1024
/** 收据接口的白名单，压完按文件头判出来的类型要在这儿才收（见 utils/image.mimeOf）。 */
const RECEIPT_MIME = { 'image/jpeg': true, 'image/png': true, 'image/webp': true }

Page({
  data: {
    id: '',
    convertGift: '',
    kind: 'expense',
    amountText: '',
    amountPreview: '',
    date: '',
    dateText: '',
    datePreset: 'today',
    clock: '',
    currentCats: [],
    categoryName: '',
    categoryNames: [],
    categoryIndex: 0,
    note: '',
    excluded: false,
    accountId: '',
    toAccountId: '',
    // 下拉框显示的名字：WXML 插值不能调用页面方法，只能先算好放进 data
    accountName: '',
    toAccountName: '',
    accountIndex: 0,
    toAccountIndex: 0,
    categoryId: '',
    keepGoing: false,
    saving: false,
    err: '',

    accounts: [],
    accountNames: [],
    cats: [],
    hasReceipt: false,
    receiptUrl: '',
  },

  onLoad(query) {
    if (!require('../../utils/session').ensure()) return
    const q = query || {}
    const date = q.date || time.todayISO()
    const kind = q.kind === 'income' ? 'income' : q.kind === 'transfer' ? 'transfer' : 'expense'
    const convertGift = toId(q.convert_gift) || ''
    const carried = convertGift ? nav.takeCarry() : null
    const carriedNote = carried && carried.note != null ? carried.note : ''
    const amountText = q.amount || ''
    this.setData({
      id: convertGift ? '' : toId(q.id) || '',
      convertGift: convertGift,
      kind: kind,
      amountText: amountText,
      amountPreview: calcAmountPreview(amountText),
      note: convertGift ? nav.repairNote(nav.noteFromPrevPage() || carriedNote) : q.note || '',
      date: date,
      dateText: formatFullDate(date),
      datePreset: calcDatePreset(date),
      clock: time.shanghaiClock(),
    })
    wx.setNavigationBarTitle({ title: convertGift ? '转成明细' : q.id ? '改一笔' : '记一笔' })
    this.loadRefs().then(() => {
      if (q.id && !convertGift) this.loadTx(q.id)
    })
  },

  loadRefs() {
    return Promise.all([request.get('/api/v1/accounts'), request.get('/api/v1/categories')])
      .then((res) => {
        const all = (res[0] && res[0].items) || []
        const accounts = all.filter((a) => !a.archived)
        const cats = ((res[1] && res[1].items) || []).filter((c) => !c.archived)
        // 能选的账户只有未归档的；但显示名字要用全量——编辑一笔旧流水时，
        // 它的账户可能已经归档，那时仍要显示原名，而不是「选择账户」。
        this.accountLabel = {}
        all.forEach((a) => { this.accountLabel[a.id] = a.name })
        const defaultAccountId = this.data.accountId || (accounts[0] ? accounts[0].id : '')
        const defaultToAccountId =
          this.data.toAccountId ||
          (accounts.length > 1 ? (accounts[0].id === defaultAccountId ? accounts[1].id : accounts[0].id) : '')
        this.setData({
          accounts: accounts,
          accountNames: accounts.map((a) => a.name),
          cats: cats,
          accountId: defaultAccountId,
          toAccountId: defaultToAccountId,
        })
        this.pickDefaultCategory()
        this.syncAccountNames()
      })
      .catch((err) => ui.fail(err, '账户/分类加载失败'))
  },

  /** 把账户 id 翻成显示名 + 下拉定位用的下标。
      WXML 里调不了方法（写了会安静地渲染成空），所以名字和下标都在这里算好。 */
  syncAccountNames() {
    const label = this.accountLabel || {}
    const accounts = this.data.accounts || []
    const name = (id) => label[id] || ''
    // picker 的 value 要的是下标；找不到（已归档/未选）就落在第一个。
    const index = (id) => {
      const i = accounts.findIndex((a) => a.id === id)
      return i < 0 ? 0 : i
    }
    this.setData({
      accountName: name(this.data.accountId) || '选择账户',
      toAccountName: name(this.data.toAccountId) || '选择转入账户',
      accountIndex: index(this.data.accountId),
      toAccountIndex: index(this.data.toAccountId),
    })
  },

  /** 选中的分类被归档或类型不匹配时，退回该类型下的第一个。 */
  pickDefaultCategory() {
    const list = this.catsFor(this.data.kind)
    const keep = list.some((c) => c.id === this.data.categoryId)
    const categoryId = keep ? this.data.categoryId : (list[0] ? list[0].id : '')
    const index = list.findIndex((c) => c.id === categoryId)
    this.setData({
      currentCats: list,
      categoryNames: list.map((c) => c.name),
      categoryId: categoryId,
      categoryIndex: index < 0 ? 0 : index,
      categoryName: index < 0 ? '无分类' : list[index].name,
    })
  },

  catsFor(kind) {
    return (this.data.cats || []).filter((c) => c.kind === kind)
  },

  loadTx(id) {
    ui.withLoading('加载中', () => request.get('/api/v1/transactions/' + id))
      .then((tx) => {
        const date = time.occurredAtToDate(tx.occurred_at)
        const amountText = money.formatYuan(tx.amount_cents)
        this.setData({
          kind: tx.kind,
          amountText: amountText,
          amountPreview: calcAmountPreview(amountText),
          date: date,
          dateText: formatFullDate(date),
          datePreset: calcDatePreset(date),
          clock: time.shanghaiClock(tx.occurred_at),
          note: nav.repairNote(tx.note || ''),
          excluded: !!tx.excluded,
          accountId: tx.account_id,
          toAccountId: tx.to_account_id || '',
          categoryId: tx.category_id || '',
          hasReceipt: !!tx.has_receipt,
        })
        this.syncAccountNames()
        this.pickDefaultCategory()
      })
      .catch((err) => ui.fail(err, '流水加载失败'))
  },

  // ---- 表单 ----

  setKind(e) {
    const kind = e.currentTarget.dataset.kind
    if (!kind || kind === this.data.kind) return
    this.setData({ kind: kind, err: '' })
    this.pickDefaultCategory()
  },

  onAmount(e) {
    const val = e.detail.value
    this.setData({
      amountText: val,
      amountPreview: calcAmountPreview(val),
      err: '',
    })
  },

  clearAmount() {
    this.setData({ amountText: '', amountPreview: '', err: '' })
  },

  onNote(e) {
    this.setData({ note: e.detail.value })
  },

  clearNote() {
    this.setData({ note: '' })
  },

  onDate(e) {
    const date = e.detail.value
    this.setData({
      date: date,
      dateText: formatFullDate(date),
      datePreset: calcDatePreset(date),
    })
  },

  tapQuickDate(e) {
    const preset = e.currentTarget.dataset.preset
    const today = time.todayISO()
    let date = today
    if (preset === 'yesterday') date = time.addDays(today, -1)
    else if (preset === 'beforeYesterday') date = time.addDays(today, -2)
    this.setData({
      date: date,
      dateText: formatFullDate(date),
      datePreset: preset,
    })
  },

  onClock(e) {
    this.setData({ clock: e.detail.value })
  },

  selectCategory(e) {
    const id = toId(e.currentTarget.dataset.id)
    const list = this.data.currentCats || []
    const index = list.findIndex((c) => c.id === id)
    if (index < 0) return
    this.setData({
      categoryId: id,
      categoryIndex: index,
      categoryName: list[index].name,
      err: '',
    })
  },

  pickCategory(e) {
    const index = Number(e.detail.value)
    const cat = (this.data.currentCats || [])[index]
    if (!cat) return
    this.setData({ categoryId: cat.id, categoryIndex: index, categoryName: cat.name, err: '' })
  },

  addCategory() {
    const kind = this.data.kind === 'income' ? 'income' : 'expense'
    ui.prompt({
      title: kind === 'income' ? '新增收入分类' : '新增支出分类',
      placeholder: '分类名称，最多 32 字',
    }).then((name) => {
      if (!name || !name.trim()) return
      ui.withLoading('保存中', () => request.post('/api/v1/categories', { name: name.trim(), kind: kind }))
        .then((created) => {
          return this.loadRefs().then(() => {
            if (created && created.id) {
              this.setData({ categoryId: created.id })
              this.pickDefaultCategory()
            }
          })
        })
        .catch((err) => ui.fail(err, '新增分类失败'))
    })
  },

  selectAccount(e) {
    const id = toId(e.currentTarget.dataset.id)
    if (!id) return
    this.setData({ accountId: id, err: '' })
    this.syncAccountNames()
  },

  selectToAccount(e) {
    const id = toId(e.currentTarget.dataset.id)
    if (!id) return
    this.setData({ toAccountId: id, err: '' })
    this.syncAccountNames()
  },

  pickAccount(e) {
    const account = this.data.accounts[Number(e.detail.value)]
    if (!account) return
    this.setData({ accountId: account.id, err: '' })
    this.syncAccountNames()
  },

  pickToAccount(e) {
    const account = this.data.accounts[Number(e.detail.value)]
    if (!account) return
    this.setData({ toAccountId: account.id, err: '' })
    this.syncAccountNames()
  },

  swapAccounts() {
    const fromId = this.data.accountId
    const toIdVal = this.data.toAccountId
    this.setData({
      accountId: toIdVal,
      toAccountId: fromId,
      err: '',
    })
    this.syncAccountNames()
  },

  onExcluded(e) {
    this.setData({ excluded: e.detail.value })
  },

  onKeepGoing(e) {
    this.setData({ keepGoing: e.detail.value })
  },

  // ---- 收据（入口暂隐藏，方法保留） ----

  pickReceipt() {
    if (!this.data.id) {
      ui.toast('先保存这笔，再传收据')
      return
    }
    image
      .pick()
      .then((picked) => image.prepare(picked, RECEIPT_MAX))
      .then((ready) => {
        if (!RECEIPT_MIME[ready.mime]) {
          throw { code: 'bad_request', message: '收据只支持 JPG / PNG / WebP，换一张试试', status: 0 }
        }
        return ui.withLoading('上传中', () => request.uploadReceipt(this.data.id, ready.filePath, ready.mime))
      })
      .then(() => {
        ui.ok('收据已上传')
        this.setData({ hasReceipt: true })
      })
      .catch((err) => {
        if (err && err.code === 'cancelled') return
        ui.fail(err, '收据上传失败')
      })
  },

  viewReceipt() {
    if (!this.data.id) return
    const token = require('../../utils/session').getToken()
    const url = config.getBaseUrl() + '/api/v1/transactions/' + this.data.id + '/receipt'
    wx.downloadFile({
      url: url,
      header: token ? { authorization: 'Bearer ' + token } : {},
      success: (res) => {
        if (res.statusCode !== 200) {
          ui.toast('收据打不开')
          return
        }
        wx.previewImage({ urls: [res.tempFilePath] })
      },
      fail: () => ui.toast('收据下载失败'),
    })
  },

  deleteReceipt() {
    ui.confirm('删掉这张收据？').then((yes) => {
      if (!yes) return
      ui.withLoading('删除中', () => request.del('/api/v1/transactions/' + this.data.id + '/receipt'))
        .then(() => this.setData({ hasReceipt: false }))
        .catch((err) => ui.fail(err, '删除失败'))
    })
  },

  // ---- 保存 ----

  save() {
    if (this.data.saving) return
    const cents = money.yuanExprToCents(this.data.amountText)
    if (!cents) {
      this.setData({ err: '金额填一下（支持 12+8 这样的算式）' })
      return
    }
    if (!this.data.accountId) {
      this.setData({ err: '请选择账户' })
      return
    }
    if (this.data.kind === 'transfer') {
      if (!this.data.toAccountId) {
        this.setData({ err: '请选择转入账户' })
        return
      }
      if (this.data.toAccountId === this.data.accountId) {
        this.setData({ err: '转出与转入不能是同一个账户' })
        return
      }
    } else if (!this.data.categoryId) {
      this.setData({ err: '请选择分类' })
      return
    }

    const payload = {
      kind: this.data.kind,
      amount_cents: cents,
      date: this.data.date,
      time: this.data.clock,
      note: this.data.note,
      excluded: this.data.excluded,
      account_id: this.data.accountId,
    }
    if (this.data.kind === 'transfer') payload.to_account_id = this.data.toAccountId
    else payload.category_id = this.data.categoryId

    this.setData({ saving: true, err: '' })
    const task = this.data.convertGift
      ? request.request({ path: '/api/v1/gifts/' + this.data.convertGift + '/to-transaction', method: 'POST', data: payload })
      : this.data.id
        ? request.request({ path: '/api/v1/transactions/' + this.data.id, method: 'PATCH', data: payload })
        : request.post('/api/v1/transactions', payload)

    task
      .then(() => {
        this.setData({ saving: false })
        if (this.data.convertGift) {
          ui.ok('已转成明细')
          setTimeout(() => wx.navigateBack({ delta: 2 }), 600)
          return
        }
        if (this.data.id) {
          ui.ok('已保存')
          setTimeout(() => wx.navigateBack(), 600)
          return
        }
        if (this.data.keepGoing) {
          // 再记一笔：日期、账户、分类、收支类型都留着，只清金额和备注。
          this.setData({ amountText: '', amountPreview: '', note: '', err: '' })
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

  async toFavor() {
    if (!this.data.id || this.data.kind === 'transfer') return
    const yes = await ui.confirm('这笔会从明细里拿掉，账户余额回退，改记到人情往来。有收据会一起删除。', '转成人情')
    if (!yes) return
    nav.carry({ note: this.data.note || '' })
    nav.go('gift-form', {
      convert_tx: this.data.id,
      amount: this.data.amountText,
      date: this.data.date,
      kind: this.data.kind === 'income' ? 'receive' : 'give',
    })
  },

  async remove() {
    if (!this.data.id) return
    const yes = await ui.confirm('删除这笔流水？账户余额会一并回退。', '删除流水')
    if (!yes) return
    ui.withLoading('删除中', () => request.del('/api/v1/transactions/' + this.data.id))
      .then(() => {
        ui.ok('已删除')
        setTimeout(() => wx.navigateBack(), 600)
      })
      .catch((err) => ui.fail(err, '删除失败'))
  },
})
