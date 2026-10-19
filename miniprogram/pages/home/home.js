/**
 * 明细（首页）。
 *
 * 三个视图共用一份月度数据：
 *   list 流水（按日分组）· cal 日历（点某天看当天）· stat 统计（含 6 个月趋势与预算）
 *
 * 数据来源：GET /transactions?month= 、GET /stats/monthly?month= 、GET /stats/overview?month=
 * 金额一律是整数分，展示时才转元。搜索与账户/分类筛选交给服务端（同一组 query 参数）。
 *
 * 页面跳转一律走 utils/nav.go。
 */

const request = require('../../utils/request')
const session = require('../../utils/session')
const nav = require('../../utils/nav')
const money = require('../../utils/money')
const time = require('../../utils/time')
const ui = require('../../utils/ui')
const localOcr = require('../../utils/localOcr')

const SH_OFFSET = 8 * 3600 * 1000

/** 模型已配置即可用。会话已是微信登录时，不因 status.allowed 为 false 把入口藏掉。 */
function modelReady(res) {
  if (!res || !res.available) return false
  if (res.allowed !== false) return true
  return session.isWechat()
}

function timeText(ms) {
  const d = new Date(ms + SH_OFFSET)
  return String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0')
}

function daySumLabel(incomeCents, expenseCents) {
  const parts = []
  if (incomeCents > 0) parts.push('收 ' + money.formatYuan(incomeCents))
  if (expenseCents > 0) parts.push('支 ' + money.formatYuan(expenseCents))
  return parts.length ? parts.join(' · ') : '无收支'
}

function buildQuickMonths(selectedMonth) {
  const thisMonth = time.shanghaiMonth()
  const current = selectedMonth || thisMonth
  const years = time.pickerYears(thisMonth)
  const minMonth = years[0] + '-01'
  const recentStart = time.addMonth(thisMonth, -5)
  const items = []

  if (current >= recentStart) {
    for (let i = -5; i <= 0; i += 1) {
      const m = time.addMonth(thisMonth, i)
      if (m < minMonth) continue
      const sameYear = m.slice(0, 4) === thisMonth.slice(0, 4)
      items.push({
        month: m,
        label:
          m === thisMonth
            ? '本月'
            : sameYear
              ? Number(m.slice(5, 7)) + '月'
              : m.slice(2, 4) + '/' + Number(m.slice(5, 7)),
        on: m === current,
        isBack: false,
      })
    }
    return items
  }

  const prevCap = time.addMonth(thisMonth, -1)
  let start = time.addMonth(current, -2)
  if (start < minMonth) start = minMonth
  let end = time.addMonth(start, 4)
  if (end > prevCap) {
    end = prevCap
    start = time.addMonth(end, -4)
    if (start < minMonth) start = minMonth
  }
  for (let i = 0; i < 5; i += 1) {
    const m = time.addMonth(start, i)
    if (m > end) break
    const sameYearAsCurrent = m.slice(0, 4) === current.slice(0, 4)
    const showYear = m === current && m.slice(0, 4) !== thisMonth.slice(0, 4)
    items.push({
      month: m,
      label: showYear
        ? m.slice(2, 4) + '年' + Number(m.slice(5, 7)) + '月'
        : sameYearAsCurrent
          ? Number(m.slice(5, 7)) + '月'
          : m.slice(2, 4) + '/' + Number(m.slice(5, 7)),
      on: m === current,
      isBack: false,
    })
  }
  items.push({
    month: thisMonth,
    label: '回到本月',
    on: false,
    isBack: true,
  })
  return items
}

Page({
  data: {
    month: '',
    monthText: '',
    isCurrentMonth: true,
    quickMonths: [],
    view: 'list',
    loading: true,

    // 汇总与预算
    incomeText: '0.00',
    expenseText: '0.00',
    netText: '0.00',
    netClass: 'income',
    budgetText: '',
    budgetPercent: 0,
    budgetOver: false,

    // 列表
    groups: [],
    empty: false,

    // 筛选
    q: '',
    kindFilter: 'all',
    accountId: '',
    categoryId: '',
    // 两个筛选项各存各的显示名。以前共用一个 filterText，选完账户再选分类时，
    // 分类那栏会显示成账户名。
    accountFilterText: '',
    categoryFilterText: '',
    // 下拉定位用（picker 的 value 是下标，不是 id）
    accountFilterIndex: 0,
    categoryFilterIndex: 0,
    accountNames: [],
    categoryNames: [],
    hasFilter: false,

    // 日历
    cells: [],
    calWeek: time.CAL_WEEK,
    selectedDay: '',
    dayItems: [],
    dayTitle: '',
    daySumText: '',

    // 统计
    statCats: [],
    trend: [],
    trendMax: 1,

    // 交互
    showAdd: false,
    guest: false,
    showVoice: false,
    /** tx 智能记账；note 日历记录，认出日期和事情后再写入。 */
    voiceTarget: 'tx',
    /** 「智能记账」浮层里两个入口各自的可用性（后台配了对应模型才有） */
    canSpeak: true,
    canPhoto: true,
    /** 加号浮层里那一项：任一入口可用就显示 */
    canAi: true,
    todayISO: '',
  },

  onLoad() {
    const month = time.shanghaiMonth()
    this.accounts = []
    this.categories = []
    this.accountMap = {}
    this.categoryMap = {}
    this.ledgerId = session.getLedgerId()
    this.setData({
      month: month,
      monthText: time.monthLabel(month),
      isCurrentMonth: true,
      quickMonths: buildQuickMonths(month),
      todayISO: time.todayISO(),
    })
    this.buildCells(month)
    if (!session.getToken()) {
      this.setData({ guest: true, loading: false, empty: true })
      return
    }
    this.loadAiStatus()
    this.runRecurrences()
    // 账户名、分类名没到就去画流水，this.accountMap 还是空的，有记录就会抛错并弹出「加载失败」。
    this.loadRefs().then(() => this.loadMonth())
  },

  onShow() {
    if (!session.getToken()) {
      this.setData({ guest: true, loading: false, empty: true, showAdd: false, showVoice: false })
      return
    }
    if (this.data.guest) {
      this.setData({ guest: false, loading: true })
      this.ledgerId = session.getLedgerId()
      this.loadAiStatus()
      this.runRecurrences()
      this.loadRefs().then(() => this.loadMonth())
      this.loadedOnce = true
      return
    }
    // 两个识别接口只要有一次没拉成，浮层里的「拍一张 / 按住说话」就是隐身的
    // （见 loadAiStatus）。每次回到本页补一次，成功过一次就不再重复问。
    if (!this.aiStatusOk) this.loadAiStatus()
    // 账本只能在「我的 → 账本与成员」里切换（明细页不再放切换入口）。
    // 切完回到这一页时，账户、分类和筛选条件都还属于上一个账本：必须清掉筛选
    // 并重拉账户/分类，否则会拿旧账本的 id 去筛，表现为「列表空了」或分类名对不上。
    // 列表要等分类就绪再发一次，避免流水的分类名仍用旧映射。
    const switched = !!this.ledgerId && this.ledgerId !== session.getLedgerId()
    this.ledgerId = session.getLedgerId()
    if (switched) {
      this.setData({
        q: '',
        kindFilter: 'all',
        accountId: '',
        categoryId: '',
        accountFilterText: '',
        categoryFilterText: '',
        accountFilterIndex: 0,
        categoryFilterIndex: 0,
        hasFilter: false,
      })
      this.loadRefs().then(() => this.loadMonth())
      this.loadedOnce = true
      return
    }
    // 拍照/语音在单独页面保存后，把要看的日期带回来。本页浮层走 onVoiceDone，不经这里。
    const pending = getApp().globalData.pendingLedgerDate
    if (pending && /^\d{4}-\d{2}-\d{2}$/.test(pending)) {
      getApp().globalData.pendingLedgerDate = ''
      this.focusDate(pending)
      this.loadedOnce = true
      return
    }
    // 从记账页返回要看到最新数据；首次 onShow 紧接 onLoad，跳过一次重复请求。
    if (this.loadedOnce) this.loadMonth()
    this.loadedOnce = true
  },

  onPullDownRefresh() {
    if (!session.getToken()) {
      wx.stopPullDownRefresh()
      return
    }
    this.loadMonth().then(() => wx.stopPullDownRefresh())
  },

  // ---- 数据 ----

  loadRefs() {
    return Promise.all([request.get('/api/v1/accounts'), request.get('/api/v1/categories')])
      .then((res) => {
        this.accounts = ((res[0] && res[0].items) || []).filter((a) => !a.archived)
        this.categories = ((res[1] && res[1].items) || []).filter((c) => !c.archived)
        this.accountMap = {}
        this.categoryMap = {}
        this.accounts.forEach((a) => { this.accountMap[a.id] = a.name })
        this.categories.forEach((c) => { this.categoryMap[c.id] = c.name })
        const accountNames = ['全部账户'].concat(this.accounts.map((a) => a.name))
        const categoryNames = ['全部分类'].concat(this.categories.map((c) => c.name))
        this.setData({ accountNames: accountNames, categoryNames: categoryNames })
      })
      .catch(() => {
        /* 名字拉不到就显示为空，不阻塞流水 */
      })
  },

  /**
   * 两个识别模型（语音 ASR / 图片 OCR）都可能在后台没配，各自独立判断：
   * 服务器没配图片识别、这台手机也不能端侧认字时，别给「拍一张」。
   * 手机能端侧认字就仍给入口；认不全再请求服务器，没配会得到明确失败。
   * 两个 status 都与账本无关，所以不带账本头。
   *
   * 「成功拉到过」记在 aiStatusOk 上：请求失败与「后台真的没配」都是 false，
   * 但前者只是这一次没问着，不该把入口永久藏起来 —— 交给 onShow 再补一次。
   */
  loadAiStatus() {
    let ok = 0
    const settled = () => {
      ok += 1
      if (ok === 2) this.aiStatusOk = true
    }
    request
      .get('/api/v1/speech/status', null, { withLedger: false })
      .then((res) => {
        this.setAiStatus('canSpeak', modelReady(res))
        settled()
      })
      .catch(() => this.setAiStatus('canSpeak', false))
    request
      .get('/api/v1/ocr/status', null, { withLedger: false })
      .then((res) => {
        this.setAiStatus('canPhoto', localOcr.photoAvailable(modelReady(res)))
        settled()
      })
      .catch(() => this.setAiStatus('canPhoto', localOcr.photoAvailable(false)))
  },

  setAiStatus(key, value) {
    const patch = {}
    patch[key] = value
    patch.canAi = key === 'canSpeak' ? value || this.data.canPhoto : value || this.data.canSpeak
    this.setData(patch)
  },

  /** 周期记账的兜底：进首页补记到期的（同一个 next_at 不会重复记）。 */
  runRecurrences() {
    request
      .post('/api/v1/recurrences/run', {})
      .then((res) => {
        if (res && res.created) this.loadMonth()
      })
      .catch(() => {
        /* 失败不影响正常使用 */
      })
  },

  query() {
    const q = { month: this.data.month }
    if (this.data.q) q.q = this.data.q
    if (this.data.accountId) q.account_id = this.data.accountId
    if (this.data.categoryId) q.category_id = this.data.categoryId
    return request.queryString(q)
  },

  loadMonth() {
    const month = this.data.month
    this.setData({ loading: true })
    return Promise.all([
      request.get('/api/v1/transactions?' + this.query()),
      request.get('/api/v1/stats/monthly?month=' + month),
      request.get('/api/v1/stats/overview?month=' + month),
    ])
      .then((res) => {
        const items = (res[0] && res[0].items) || []
        const monthly = res[1] || {}
        const overview = res[2] || {}
        const decorated = items.map((t) => this.decorate(t))
        const kindFilter = this.data.kindFilter || 'all'
        const filtered = kindFilter === 'all' ? decorated : decorated.filter((t) => t.kind === kindFilter)
        const hasFilter = Boolean(
          this.data.q || this.data.accountId || this.data.categoryId || kindFilter !== 'all',
        )
        const budget = Number(monthly.budget_cents) || 0
        const used = Number(monthly.budget_used_cents) || 0
        const net = Number(monthly.net_cents) || 0
        this.setData({
          loading: false,
          empty: !filtered.length,
          hasFilter: hasFilter,
          groups: this.groupByDay(filtered),
          incomeText: money.formatYuan(monthly.income_cents),
          expenseText: money.formatYuan(monthly.expense_cents),
          netText: (net > 0 ? '+' : '') + money.formatYuan(monthly.net_cents),
          netClass: net < 0 ? 'expense' : 'income',
          budgetText: budget ? money.formatYuan(used) + ' / ' + money.formatYuan(budget) : '',
          budgetPercent: budget ? Math.min(100, Math.round((used / budget) * 100)) : 0,
          budgetOver: budget > 0 && used > budget,
          statCats: this.statRows(monthly.by_category || []),
          trend: this.trendRows((overview && overview.trend) || []),
        })
        this.all = decorated
        // 日历格子只跟月份走，切月时就已经画好了；这里只补「哪天有流水」的标记。
        // 分开算的原因：接口挂了或还没回来时，日历也不该是一片空白。
        this.buildCells(month)
        // 选中态一律等数据到位再算（showDay 是从 this.all 里筛当天），
        // 否则会先闪一下「这天没有记录」。没有选中项时按本月默认选今天。
        if (this.data.selectedDay) this.showDay(this.data.selectedDay)
        else this.autoSelectToday()
      })
      .catch((err) => {
        this.setData({ loading: false })
        ui.fail(err, '加载失败')
      })
  },

  decorate(t) {
    const kindText = t.kind === 'income' ? '收入' : t.kind === 'expense' ? '支出' : '转账'
    const accountMap = this.accountMap || {}
    const categoryMap = this.categoryMap || {}
    return {
      id: t.id,
      kind: t.kind,
      kindText: kindText,
      amountCents: Number(t.amount_cents) || 0,
      date: time.occurredAtToDate(t.occurred_at),
      clock: timeText(t.occurred_at),
      amountText: money.signedText(t.kind, t.amount_cents),
      note: t.note || '',
      category: t.category_id ? categoryMap[t.category_id] || '未命名分类' : '',
      account: accountMap[t.account_id] || '',
      toAccount: t.to_account_id ? accountMap[t.to_account_id] || '' : '',
      hasReceipt: !!t.has_receipt,
      excluded: !!t.excluded,
    }
  },

  groupByDay(items) {
    const groups = []
    const byKey = {}
    items.forEach((it) => {
      let g = byKey[it.date]
      if (!g) {
        g = { key: it.date, label: time.dayLabel(it.date), items: [], incomeCents: 0, expenseCents: 0 }
        byKey[it.date] = g
        groups.push(g)
      }
      g.items.push(it)
      if (!it.excluded) {
        if (it.kind === 'income') g.incomeCents += Number(it.amountCents) || 0
        if (it.kind === 'expense') g.expenseCents += Number(it.amountCents) || 0
      }
    })
    return groups.map((g) => ({
      key: g.key,
      label: g.label,
      items: g.items,
      sumText: daySumLabel(g.incomeCents, g.expenseCents),
    }))
  },

  markedDays(items) {
    const marked = {}
    items.forEach((it) => { marked[it.date] = true })
    return marked
  },

  /**
   * 生成日历格子。
   *
   * 只依赖月份，「哪天有记录」用已加载的流水补 —— 与请求解耦，所以接口失败、
   * 或者切到日历视图时数据还没回来，日历照样有日期格子可点（不会一片空白）。
   */
  buildCells(month) {
    const m = month || this.data.month
    if (!m) return
    this.setData({ cells: time.calendarGrid(m, this.markedDays(this.all || [])).cells })
  },

  statRows(list) {
    const max = list.reduce((m, c) => Math.max(m, Number(c.amount_cents) || 0), 0) || 1
    const expTotal = list
      .filter((c) => c.kind === 'expense')
      .reduce((s, c) => s + (Number(c.amount_cents) || 0), 0)
    return list.map((c) => {
      const amount = Number(c.amount_cents) || 0
      const share = c.kind === 'expense' && expTotal ? Math.round((amount / expTotal) * 100) : 0
      const budget = Number(c.budget_cents) || 0
      const over = budget > 0 && amount > budget
      return {
        id: c.category_id,
        name: c.name,
        kind: c.kind,
        amountText: money.formatYuan(amount),
        width: Math.max(4, Math.round((amount / max) * 100)),
        shareText: share ? share + '%' : '',
        budgetText: budget ? '预算 ' + money.formatYuan(budget) + (over ? ' · 超支' : '') : '',
        over: over,
      }
    })
  },

  trendRows(list) {
    // 柱高百分比在这里算好：WXML 表达式里没有 Math，也不该在视图层做算术。
    let max = 0
    list.forEach((t) => {
      max = Math.max(max, Number(t.income_cents) || 0, Number(t.expense_cents) || 0)
    })
    const scale = max || 1
    return list.map((t) => {
      const income = Number(t.income_cents) || 0
      const expense = Number(t.expense_cents) || 0
      return {
        month: t.month,
        label: Number(t.month.slice(5)) + '月',
        incomeH: Math.max(income ? 4 : 0, Math.round((income / scale) * 100)),
        expenseH: Math.max(expense ? 4 : 0, Math.round((expense / scale) * 100)),
      }
    })
  },

  // ---- 月份与视图 ----

  /**
   * 月份条（components/month-nav）换了月份。
   *
   * 箭头、年月滚轮、「回到本月」三种来源都收敛到这一个入口 —— 组件只报月份，
   * 越界由组件自己挡（它的 max 默认就是本月）。
   */
  onMonthChange(e) {
    if (!session.getToken()) {
      session.goLogin()
      return
    }
    const month = e.detail.month
    if (!month || month === this.data.month) return
    this.changeMonth(month)
  },

  changeMonth(month, day) {
    const cap = time.shanghaiMonth()
    const years = time.pickerYears(cap)
    if (!month || month > cap) return
    if (years.length && month < years[0] + '-01') return
    this.setData({
      month: month,
      monthText: time.monthLabel(month),
      isCurrentMonth: month === cap,
      quickMonths: buildQuickMonths(month),
      selectedDay: day || '',
      dayItems: [],
      daySumText: '',
    })
    this.buildCells(month)
    this.loadMonth()
  },

  tapQuickMonth(e) {
    if (!session.getToken()) {
      session.goLogin()
      return
    }
    const month = e.currentTarget.dataset.month
    if (!month || month === this.data.month) return
    this.changeMonth(month)
  },

  onCalTouchStart(e) {
    const t = e.touches && e.touches[0]
    if (!t) return
    this.calTouchX = t.clientX
    this.calTouchY = t.clientY
  },

  onCalTouchEnd(e) {
    const t = e.changedTouches && e.changedTouches[0]
    if (!t || this.calTouchX == null || this.calTouchY == null) return
    const dx = t.clientX - this.calTouchX
    const dy = t.clientY - this.calTouchY
    this.calTouchX = null
    this.calTouchY = null
    if (Math.abs(dx) < 50 || Math.abs(dx) < Math.abs(dy) * 1.5) return
    const next = time.addMonth(this.data.month, dx < 0 ? 1 : -1)
    if (next !== this.data.month) this.changeMonth(next)
  },

  /** 保存落在别的月份时，列表停在本月会像没记下。切到那一天再刷新。 */
  focusDate(date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      this.loadMonth()
      return
    }
    const month = date.slice(0, 7)
    if (month !== this.data.month) this.changeMonth(month, date)
    else {
      this.setData({ selectedDay: date })
      this.loadMonth()
    }
  },

  switchView(e) {
    const view = e.currentTarget.dataset.v
    if (!session.getToken()) {
      if (view !== 'list') session.goLogin()
      return
    }
    this.setData({ view: view })
    // 首次进日历就把「今天」选上并列出当天明细：否则进来只看到一堆数字，
    // 还得自己找哪天是今天。已经有选中项时不覆盖（用户的选择优先）。
    if (view === 'cal') this.autoSelectToday()
  },

  // ---- 搜索与筛选 ----

  onSearch(e) {
    if (!session.getToken()) {
      session.goLogin()
      return
    }
    this.setData({ q: e.detail.value })
  },

  doSearch() {
    if (!session.getToken()) {
      session.goLogin()
      return
    }
    this.loadMonth()
  },

  clearSearch() {
    if (!this.data.q) return
    this.setData({ q: '' })
    this.loadMonth()
  },

  setKindFilter(e) {
    if (!session.getToken()) {
      session.goLogin()
      return
    }
    const kind = e.currentTarget.dataset.kind || 'all'
    if (kind === this.data.kindFilter) return
    this.setData({ kindFilter: kind })
    this.loadMonth()
  },

  pickAccount(e) {
    if (!session.getToken()) {
      session.goLogin()
      return
    }
    const idx = Number(e.detail.value)
    const id = idx === 0 ? '' : this.accounts[idx - 1].id
    this.setData({
      accountId: id,
      accountFilterText: idx === 0 ? '' : this.accounts[idx - 1].name,
      accountFilterIndex: idx,
    })
    this.loadMonth()
  },

  pickCategory(e) {
    if (!session.getToken()) {
      session.goLogin()
      return
    }
    const idx = Number(e.detail.value)
    const id = idx === 0 ? '' : this.categories[idx - 1].id
    this.setData({
      categoryId: id,
      categoryFilterText: idx === 0 ? '' : this.categories[idx - 1].name,
      categoryFilterIndex: idx,
    })
    this.loadMonth()
  },

  resetFilter() {
    this.setData({
      accountId: '',
      categoryId: '',
      accountFilterText: '',
      categoryFilterText: '',
      accountFilterIndex: 0,
      categoryFilterIndex: 0,
      kindFilter: 'all',
      q: '',
      hasFilter: false,
    })
    this.loadMonth()
  },

  // ---- 日历 ----

  tapDay(e) {
    const date = e.currentTarget.dataset.date
    if (!date) return
    this.showDay(date)
  },

  /**
   * 日历默认选中「今天」。
   *
   * 三个前提：当前就在日历视图、看的是本月（历史月份里没有今天）、还没有选中任何一天
   * （用户已经点过某天时不覆盖他的选择）。最后那个月份比对是兜底防 isCurrentMonth 失同步。
   *
   * `this.all` 还没到位时直接返回 —— 那时筛出来必然是空，会先闪一下「这天没有记录」。
   * 这种情况下等 loadMonth 成功后再调一次（见那里的 else 分支）。
   *
   * 当天明细直接拿已加载的本月流水在本地筛（showDay），不额外发请求 ——
   * 当天的几笔本来就在列表里，再查一次只是多一跳。
   */
  autoSelectToday() {
    if (this.data.view !== 'cal') return
    if (!this.data.isCurrentMonth) return
    if (this.data.selectedDay) return
    if (!this.all) return
    const today = time.todayISO()
    if (today.slice(0, 7) !== this.data.month) return
    this.showDay(today)
  },

  showDay(date) {
    const items = (this.all || []).filter((it) => it.date === date)
    let incomeCents = 0
    let expenseCents = 0
    items.forEach((it) => {
      if (!it.excluded) {
        if (it.kind === 'income') incomeCents += Number(it.amountCents) || 0
        if (it.kind === 'expense') expenseCents += Number(it.amountCents) || 0
      }
    })
    this.setData({
      selectedDay: date,
      dayTitle: time.dateLabel(date),
      dayItems: items,
      daySumText: items.length ? daySumLabel(incomeCents, expenseCents) : '',
    })
  },

  clearDay() {
    this.setData({ selectedDay: '', dayItems: [], daySumText: '' })
  },

  addTxOnSelectedDay() {
    if (!session.getToken()) {
      session.goLogin()
      return
    }
    nav.go('tx-form', this.data.selectedDay ? { date: this.data.selectedDay } : {})
  },

  // ---- 统计联动 ----

  tapTrendMonth(e) {
    const month = e.currentTarget.dataset.month
    if (!month || month === this.data.month) return
    this.changeMonth(month)
  },

  tapStatCategory(e) {
    const id = e.currentTarget.dataset.id
    const name = e.currentTarget.dataset.name
    if (!id) return
    const categories = this.categories || []
    const idx = categories.findIndex((c) => c.id === id)
    this.setData({
      view: 'list',
      categoryId: id,
      categoryFilterText: name || (idx >= 0 ? categories[idx].name : ''),
      categoryFilterIndex: idx >= 0 ? idx + 1 : 0,
    })
    this.loadMonth()
  },

  openBudget() {
    if (!session.getToken()) {
      session.goLogin()
      return
    }
    nav.go('budgets')
  },

  // ---- 流水操作 ----

  quickAddTx() {
    if (!session.getToken()) {
      session.goLogin()
      return
    }
    nav.go('tx-form', {})
  },

  openVoice() {
    if (!session.getToken()) {
      session.goLogin()
      return
    }
    this.setData({ showVoice: true, voiceTarget: 'tx' })
  },

  editTx(e) {
    nav.go('tx-form', { id: e.currentTarget.dataset.id })
  },

  async deleteTx(e) {
    const id = e.currentTarget.dataset.id
    const yes = await ui.confirm('删除这笔流水？删除后账户余额会一并回退。', '删除流水')
    if (!yes) return
    ui.withLoading('删除中', () => request.del('/api/v1/transactions/' + id))
      .then(() => {
        ui.ok('已删除')
        this.loadMonth()
      })
      .catch((err) => ui.fail(err, '删除失败'))
  },

  editAccount() {
    nav.go('assets')
  },

  // ---- 加号浮层 ----

  openAdd() {
    if (!session.getToken()) {
      session.goLogin()
      return
    }
    this.setData({ showAdd: true })
  },

  closeAdd() {
    this.setData({ showAdd: false })
  },

  onAddSelect(e) {
    const type = e.detail.type
    if (type === 'tx') nav.go('tx-form', {})
    else if (type === 'gift') nav.go('gift-form', {})
    else if (type === 'speak') this.setData({ showVoice: true, voiceTarget: 'tx' })
    else if (type === 'note') {
      if (!this.data.canSpeak) return
      this.setData({ showVoice: true, voiceTarget: 'note' })
    } else if (type === 'import') nav.go('import')
  },

  closeVoice() {
    this.setData({ showVoice: false, voiceTarget: 'tx' })
  },

  onVoiceDone(e) {
    const dates = (e.detail && e.detail.dates) || []
    const latest = dates.filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date)).sort().pop()
    if (latest) this.focusDate(latest)
    else this.loadMonth()
  },

  onShareAppMessage() {
    return { title: '记账 · 明细', path: '/pages/home/home' }
  },
})
