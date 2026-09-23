/**
 * 账单导入。
 *
 * 流程：本地读文件（微信聊天里的 CSV/TXT/JSON）或直接粘贴文本
 *   → POST /imports/preview（解析在主库里做：先规则、认不出来再交给 AI）
 *   → 逐行核对/改正（方向、金额、日期、分类、账户）
 *   → POST /imports/commit（默认按「账户+金额+时间+备注」去重）
 *   → 需要时在批次里撤销整批。
 *
 * 编码：国内导出的 CSV 大量是 GBK，而 wx.getFileSystemManager().readFile 只认
 * utf-8 这类编码名，读 GBK 会得到乱码。所以统一读成字节后用 utils/fileText
 * 嗅探（UTF-8 优先，坏了再用 GBK 表解）。
 *
 * 表格文件（xlsx）不在小程序里解析：没有可靠的解析库，体积也不划算。
 * 提示用户导出成 CSV 再导入。
 */

const request = require('../../utils/request')
const session = require('../../utils/session')
const fileText = require('../../utils/fileText')
const money = require('../../utils/money')
const time = require('../../utils/time')
const ui = require('../../utils/ui')

const PREVIEW_LIMIT = 200

Page({
  data: {
    tab: 'pick', // pick | preview | batches
    pasted: '',
    filename: '',
    loading: false,

    // 预览结果
    stats: null,
    via: '',
    aiUsed: false,
    aiError: '',
    truncated: false,
    accounts: [],
    accountNames: [],
    categories: [],
    expenseCatNames: [],
    incomeCatNames: [],
    rows: [],
    hiddenCount: 0,
    dedupe: true,

    // 批次
    batches: [],
  },

  onLoad() {
    if (!session.ensure()) return
    this.allRows = []
  },

  onShow() {
    if (this.data.tab === 'batches') this.loadBatches()
  },

  switchTab(e) {
    const tab = e.currentTarget.dataset.t
    this.setData({ tab: tab })
    if (tab === 'batches') this.loadBatches()
  },

  // ---- 选文件 / 粘贴 ----

  chooseFile() {
    wx.chooseMessageFile({
      count: 1,
      type: 'file',
      extension: ['csv', 'txt', 'json'],
      success: (res) => {
        const file = (res.tempFiles || [])[0]
        if (!file) return
        const name = file.name || ''
        this.setData({ filename: name })
        ui.withLoading('读取中', () => fileText.readFileText(file.path))
          .then((text) => this.doPreview(text, name))
          .catch((err) => ui.fail(err, '文件读取失败'))
      },
      fail: () => {},
    })
  },

  onPaste(e) {
    this.setData({ pasted: e.detail.value })
  },

  previewPasted() {
    const text = (this.data.pasted || '').trim()
    if (!text) {
      ui.toast('先粘贴账单内容')
      return
    }
    this.doPreview(text, '粘贴的账单')
  },

  doPreview(text, filename) {
    this.setData({ loading: true })
    return request
      .post('/api/v1/imports/preview', { kind: 'text', text: text, filename: filename || '' })
      .then((res) => {
        const accounts = (res && res.accounts) || []
        const categories = (res && res.categories) || []
        this.accounts = accounts
        this.allRows = ((res && res.rows) || []).map((r) => this.shapeRow(r, accounts, categories))
        const shown = this.allRows.slice(0, PREVIEW_LIMIT)
        this.setData({
          loading: false,
          tab: 'preview',
          stats: (res && res.stats) || null,
          via: (res && res.via) || '',
          aiUsed: !!(res && res.ai && res.ai.used),
          aiError: (res && res.ai && res.ai.error) || '',
          truncated: !!(res && res.truncated),
          accounts: accounts,
          accountNames: accounts.map((a) => a.name),
          categories: categories,
          expenseCatNames: categories.filter((c) => c.kind === 'expense').map((c) => c.name),
          incomeCatNames: categories.filter((c) => c.kind === 'income').map((c) => c.name),
          rows: shown,
          hiddenCount: Math.max(0, this.allRows.length - shown.length),
          filename: (res && res.filename) || filename || '',
        })
      })
      .catch((err) => {
        this.setData({ loading: false })
        ui.fail(err, '解析失败')
      })
  },

  /** 每行都要在视图里直接显示文本，这里把 id 换算成名字并算好分类下标。 */
  shapeRow(r, accounts, categories) {
    const expCats = categories.filter((c) => c.kind === 'expense')
    const incCats = categories.filter((c) => c.kind === 'income')
    const cats = r.direction === 'income' ? incCats : expCats
    let catIndex = cats.findIndex((c) => c.id === r.category_id)
    if (catIndex < 0) catIndex = 0
    let acctIndex = accounts.findIndex((a) => a.id === r.account_id)
    if (acctIndex < 0) acctIndex = 0
    const statusText =
      r.status === 'skip' ? '跳过' : r.status === 'error' ? r.reason || '识别失败' : r.duplicate ? '疑似重复' : ''
    return {
      row: r.row,
      date: r.date || time.todayISO(),
      amountText: r.amount_cents ? money.formatYuan(r.amount_cents) : '',
      direction: r.direction === 'income' ? 'income' : 'expense',
      note: r.note || '',
      counterparty: r.counterparty || '',
      favorContact: r.favor_contact || '',
      favorKind: r.favor_kind || '',
      favorOccasion: r.favor_occasion || '',
      catIndex: catIndex,
      acctIndex: acctIndex,
      catName: cats[catIndex] ? cats[catIndex].name : '未匹配',
      acctName: accounts[acctIndex] ? accounts[acctIndex].name : '未匹配',
      status: r.status,
      statusText: statusText,
      duplicate: !!r.duplicate,
      include: r.status !== 'skip' && r.status !== 'error' && !r.duplicate,
      bad: r.status === 'error' || r.status === 'skip',
    }
  },

  // ---- 行编辑 ----

  toggleInclude(e) {
    const i = Number(e.currentTarget.dataset.i)
    const row = this.data.rows[i]
    if (!row) return
    this.patchRow(i, { include: !row.include })
  },

  selectAll(e) {
    const on = e.currentTarget.dataset.on === '1'
    const rows = this.data.rows.map((r) => Object.assign({}, r, { include: on && !r.bad }))
    this.setData({ rows: rows })
    this.syncAll(rows)
  },

  onAmount(e) {
    this.patchRow(Number(e.currentTarget.dataset.i), { amountText: e.detail.value })
  },

  onNote(e) {
    this.patchRow(Number(e.currentTarget.dataset.i), { note: e.detail.value })
  },

  onDate(e) {
    this.patchRow(Number(e.currentTarget.dataset.i), { date: e.detail.value })
  },

  toggleDirection(e) {
    const i = Number(e.currentTarget.dataset.i)
    const row = this.data.rows[i]
    if (!row) return
    const direction = row.direction === 'expense' ? 'income' : 'expense'
    const cats = this.catsFor(direction)
    this.patchRow(i, {
      direction: direction,
      catIndex: 0,
      catName: cats[0] ? cats[0].name : '未匹配',
    })
  },

  pickCategory(e) {
    const i = Number(e.currentTarget.dataset.i)
    const row = this.data.rows[i]
    if (!row) return
    const cats = this.catsFor(row.direction)
    const idx = Number(e.detail.value)
    this.patchRow(i, { catIndex: idx, catName: cats[idx] ? cats[idx].name : '未匹配' })
  },

  pickAccount(e) {
    const i = Number(e.currentTarget.dataset.i)
    const idx = Number(e.detail.value)
    const acct = this.data.accounts[idx]
    this.patchRow(i, { acctIndex: idx, acctName: acct ? acct.name : '未匹配' })
  },

  catsFor(direction) {
    return (this.data.categories || []).filter((c) => c.kind === direction)
  },

  patchRow(i, obj) {
    const data = {}
    Object.keys(obj).forEach((k) => { data['rows[' + i + '].' + k] = obj[k] })
    this.setData(data)
    if (this.allRows[i]) Object.assign(this.allRows[i], obj)
  },

  syncAll(rows) {
    rows.forEach((r, i) => {
      if (this.allRows[i]) Object.assign(this.allRows[i], r)
    })
  },

  onDedupe(e) {
    this.setData({ dedupe: e.detail.value })
  },

  // ---- 提交 ----

  commit() {
    const rows = []
    ;(this.allRows || []).forEach((r) => {
      if (!r.include) return
      const cents = money.yuanExprToCents(r.amountText)
      if (!cents) return
      const cats = this.catsFor(r.direction)
      const cat = cats[r.catIndex]
      const acct = this.data.accounts[r.acctIndex]
      if (!acct) return
      const row = {
        date: r.date,
        amount_cents: cents,
        direction: r.direction,
        account_id: acct.id,
        note: r.note,
      }
      if (cat) row.category_id = cat.id
      if (r.favorContact || r.counterparty) {
        row.favor_contact = r.favorContact || r.counterparty
        row.favor_kind = r.favorKind || (r.direction === 'income' ? 'receive' : 'give')
        row.favor_occasion = r.favorOccasion
      }
      rows.push(row)
    })

    if (!rows.length) {
      ui.toast('没有勾选任何行')
      return
    }

    ui.withLoading('导入中', () =>
      request.post('/api/v1/imports/commit', {
        filename: this.data.filename,
        source: 'generic',
        dedupe: this.data.dedupe,
        ai_used: this.data.aiUsed,
        rows: rows,
      }),
    )
      .then((res) => {
        const failed = (res && res.failed) || []
        ui.ok('导入 ' + ((res && res.imported) || 0) + ' 笔')
        if (failed.length) {
          wx.showModal({
            title: '有 ' + failed.length + ' 行没导入',
            content: failed
              .slice(0, 5)
              .map((f) => '第 ' + f.row + ' 行：' + f.reason)
              .join('\n'),
            showCancel: false,
          })
        }
        this.setData({ tab: 'batches', rows: [], stats: null, pasted: '' })
        this.allRows = []
        this.loadBatches()
      })
      .catch((err) => ui.fail(err, '导入失败'))
  },

  cancelPreview() {
    this.allRows = []
    this.setData({ tab: 'pick', rows: [], stats: null, hiddenCount: 0 })
  },

  // ---- 批次 ----

  loadBatches() {
    return request
      .get('/api/v1/imports/batches')
      .then((res) => {
        this.setData({
          batches: ((res && res.items) || []).map((b) => ({
            id: b.id,
            filename: b.filename || '（无文件名）',
            source: b.source,
            timeText: time.dateLabel(time.occurredAtToDate(b.created_at)) + ' ' +
              new Date(b.created_at + 8 * 3600 * 1000).toISOString().slice(11, 16),
            countText: '共 ' + b.parsed_rows + ' 行 · 导入 ' + b.imported_rows +
              (b.duplicate_rows ? ' · 重复 ' + b.duplicate_rows : '') +
              (b.skipped_rows ? ' · 跳过 ' + b.skipped_rows : ''),
            aiUsed: !!b.ai_used,
            undone: !!b.undone_at,
            byName: b.created_by_name || '',
          })),
        })
      })
      .catch((err) => ui.fail(err, '批次加载失败'))
  },

  undoBatch(e) {
    const id = e.currentTarget.dataset.id
    ui.confirm('撤销这一批导入？由这批产生的流水和人情的会一并删掉。').then((yes) => {
      if (!yes) return
      ui.withLoading('撤销中', () => request.post('/api/v1/imports/batches/' + id + '/undo', {}))
        .then((res) => {
          ui.ok('已撤销 ' + ((res && res.removed) || 0) + ' 笔')
          this.loadBatches()
        })
        .catch((err) => ui.fail(err, '撤销失败'))
    })
  },

  helpFile() {
    wx.showModal({
      title: '支持哪些文件',
      content:
        'CSV / TXT / JSON 都能直接选（微信聊天里的文件也行）。\n' +
        'Excel 请先在电脑上「另存为 CSV」再发到微信。\n' +
        '编码不用管：GBK 和 UTF-8 都会自动识别。',
      showCancel: false,
    })
  },
})
