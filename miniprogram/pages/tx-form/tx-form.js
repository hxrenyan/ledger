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

const request = require('../../utils/request')
const config = require('../../config')
const image = require('../../utils/image')
const money = require('../../utils/money')
const time = require('../../utils/time')
const ui = require('../../utils/ui')

const RECEIPT_MAX = 512 * 1024
/** 收据接口的白名单，压完按文件头判出来的类型要在这儿才收（见 utils/image.mimeOf）。 */
const RECEIPT_MIME = { 'image/jpeg': true, 'image/png': true, 'image/webp': true }

Page({
  data: {
    id: '',
    kind: 'expense',
    amountText: '',
    date: '',
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
    catChips: [],
    dateQuick: [],
    hasReceipt: false,
    receiptUrl: '',
  },

  onLoad(query) {
    if (!require('../../utils/session').ensure()) return
    const q = query || {}
    const date = q.date || time.todayISO()
    const kind = q.kind === 'income' ? 'income' : 'expense'
    this.setData({
      id: q.id || '',
      kind: kind,
      date: date,
      dateQuick: this.buildQuick(date),
    })
    wx.setNavigationBarTitle({ title: q.id ? '改一笔' : '记一笔' })
    this.loadRefs().then(() => {
      if (q.id) this.loadTx(q.id)
    })
  },

  buildQuick(date) {
    const today = time.todayISO()
    const marks = [
      { value: today, label: '今天' },
      { value: time.addDays(today, -1), label: '昨天' },
      { value: time.addDays(today, -2), label: '前天' },
    ]
    return marks.map((m) => ({ value: m.value, label: m.label, on: m.value === date }))
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
        this.setData({
          accounts: accounts,
          accountNames: accounts.map((a) => a.name),
          cats: cats,
          accountId: this.data.accountId || (accounts[0] ? accounts[0].id : ''),
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
    this.setData({
      catChips: list,
      categoryId: keep ? this.data.categoryId : (list[0] ? list[0].id : ''),
    })
  },

  catsFor(kind) {
    return (this.data.cats || []).filter((c) => c.kind === kind)
  },

  loadTx(id) {
    ui.withLoading('加载中', () => request.get('/api/v1/transactions/' + id))
      .then((tx) => {
        const date = time.occurredAtToDate(tx.occurred_at)
        this.setData({
          kind: tx.kind,
          amountText: money.formatYuan(tx.amount_cents),
          date: date,
          dateQuick: this.buildQuick(date),
          note: tx.note || '',
          excluded: !!tx.excluded,
          accountId: tx.account_id,
          toAccountId: tx.to_account_id || '',
          categoryId: tx.category_id || '',
          hasReceipt: !!tx.has_receipt,
        })
        this.syncAccountNames()
      })
      .catch((err) => ui.fail(err, '流水加载失败'))
  },

  // ---- 表单 ----

  setKind(e) {
    const kind = e.currentTarget.dataset.kind
    const list = this.catsFor(kind)
    this.setData({
      kind: kind,
      catChips: list,
      categoryId: list.some((c) => c.id === this.data.categoryId)
        ? this.data.categoryId
        : (list[0] ? list[0].id : ''),
    })
  },

  onAmount(e) {
    this.setData({ amountText: e.detail.value, err: '' })
  },

  onNote(e) {
    this.setData({ note: e.detail.value })
  },

  tapQuick(e) {
    const date = e.currentTarget.dataset.date
    this.setData({ date: date, dateQuick: this.buildQuick(date) })
  },

  onDate(e) {
    const date = e.detail.value
    this.setData({ date: date, dateQuick: this.buildQuick(date) })
  },

  pickCategory(e) {
    this.setData({ categoryId: e.currentTarget.dataset.id })
  },

  pickAccount(e) {
    const account = this.data.accounts[Number(e.detail.value)]
    if (!account) return
    this.setData({ accountId: account.id })
    this.syncAccountNames()
  },

  pickToAccount(e) {
    const account = this.data.accounts[Number(e.detail.value)]
    if (!account) return
    this.setData({ toAccountId: account.id })
    this.syncAccountNames()
  },

  onExcluded(e) {
    this.setData({ excluded: e.detail.value })
  },

  onKeepGoing(e) {
    this.setData({ keepGoing: e.detail.value })
  },

  // ---- 收据 ----

  pickReceipt() {
    if (!this.data.id) {
      ui.toast('先保存这笔，再传收据')
      return
    }
    image
      .pick()
      // 收据接口硬上限 512KB，直接按它当目标体积压（比后端打回再重试省一个来回）。
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
        // 选图面板点取消不算失败。
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
      note: this.data.note,
      excluded: this.data.excluded,
      account_id: this.data.accountId,
    }
    if (this.data.kind === 'transfer') payload.to_account_id = this.data.toAccountId
    else payload.category_id = this.data.categoryId

    this.setData({ saving: true, err: '' })
    const task = this.data.id
      ? request.request({ path: '/api/v1/transactions/' + this.data.id, method: 'PATCH', data: payload })
      : request.post('/api/v1/transactions', payload)

    task
      .then(() => {
        this.setData({ saving: false })
        if (this.data.id) {
          ui.ok('已保存')
          setTimeout(() => wx.navigateBack(), 600)
          return
        }
        if (this.data.keepGoing) {
          // 再记一笔：日期、账户、分类、收支类型都留着，只清金额和备注。
          this.setData({ amountText: '', note: '', err: '' })
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
