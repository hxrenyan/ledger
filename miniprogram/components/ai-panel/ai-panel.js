/**
 * 智能记账浮层（认得出就记下 → 逐行核对 → 提交）。
 *
 * 两条入口，汇到同一个下游：
 *   语音  按住说话 → POST /speech/transcribe → 文字
 *   拍照  拍一张   → utils/image 压到能送出去 → POST /ocr/scan → 文字
 *   两者都 → POST /imports/receipt 或 /imports/utterances（提示词不同：
 *          口语一句一笔；票据要区分实付金额与余额、明细与合计）
 *        → 用户核对、改正 → POST /imports/commit。
 *
 * 两个 scope：
 *   tx    普通记账，解析结果按支出/收入正常入账；
 *   favor 人情往来，行里带 counterparty 时提交 favor_contact / favor_kind 落成人情。
 *
 * 两个可用性开关（管理员在后台配了对应模型才有）：
 *   canSpeak 语音识别（ASR）    canPhoto 图片识别（OCR）
 * 只配了其中一个时，另一个入口不显示 —— 别让人按住说话却拿到「未配置」。
 *
 * 上传都走 utils 里的手工 multipart：语音接口按 audio/*、认图接口按 image/*
 * 校验分片自己的 Content-Type，而 wx.uploadFile 不保证给对（和收据上传同一个坑）。
 */

const request = require('../../utils/request')
const image = require('../../utils/image')
const money = require('../../utils/money')
const time = require('../../utils/time')
const ui = require('../../utils/ui')

const MAX_SECONDS = 60
/** 核对页里那行原文只作参考，太长就把票据正文挤没了。 */
const BRIEF_CHARS = 200

function brief(text) {
  const s = String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
  return s.length > BRIEF_CHARS ? s.slice(0, BRIEF_CHARS) + '…' : s
}

/**
 * wx.getRecorderManager() 是全局单例，而 onStop / onError 是「后注册覆盖先注册」。
 *
 * 这个浮层同时挂在明细页与智能记账整页（home / speak）。只要开过整页那一个，
 * 它的回调就把明细页那个覆盖掉；从整页返回时整页实例已销毁，之后在明细页录音，
 * 结束回调会打在**已销毁**的实例上 —— 明细页的浮层就永远停在「识别中…」，
 * 既不报错也不超时，只能杀掉小程序重进。反过来也一样。
 *
 * 所以不按实例注册：全局回调只绑这一个模块级函数，由它转发给「本次真正发起
 * 录音」的实例。注册的是同一个函数引用，多实例互相覆盖（或重复注册）都无副作用 ——
 * activePanel 被取走后立刻置空，重复调用自然被挡掉。
 */
let activePanel = null

function bindRecorder(manager) {
  manager.onStop(function (res) {
    const panel = activePanel
    activePanel = null
    if (panel) panel.onRecorded(res)
  })
  manager.onError(function (err) {
    const panel = activePanel
    activePanel = null
    if (panel) panel.onRecordError(err)
  })
}

Component({
  properties: {
    show: { type: Boolean, value: false },
    scope: { type: String, value: 'tx' },
    canSpeak: { type: Boolean, value: true },
    canPhoto: { type: Boolean, value: true },
  },

  data: {
    state: 'idle', // idle | recording | busy | editing
    seconds: 0,
    maxSeconds: MAX_SECONDS,
    /** 这一轮是从哪进来的：'' | 'voice' | 'photo'（决定「重说」还是「换一张」） */
    mode: '',
    hintText: '',
    /** 核对页里显示的原文（语音是原句，拍照是票据文字的前一段） */
    text: '',
    /** 拍照认出的完整文字。解析不了时直接摆给用户看，别让人以为是拍糊了。 */
    rawText: '',
    items: [],
    parser: '',
    aiError: '',
    accounts: [],
    expenseCats: [],
    incomeCats: [],
    acctNames: [],
    expNames: [],
    incNames: [],
    tip: '',
  },

  observers: {
    show(v) {
      if (v) {
        this.reset()
        this.ensureRefs()
      } else if (this.data.state === 'recording') {
        this.finishRecord()
      }
    },
    // 两个开关是父页面异步拉回来的，可能晚于 show 到位，所以各自盯一下。
    canSpeak() {
      this.syncHint()
    },
    canPhoto() {
      this.syncHint()
    },
  },

  lifetimes: {
    attached() {
      this.recorder = wx.getRecorderManager()
      bindRecorder(this.recorder)
      this.timer = null
      this.stopGuard = null
    },
    detached() {
      // 录音途中被销毁：这次的结果没人要了，但 activePanel 必须清掉，
      // 否则下一次录音的回调会落在一个已销毁的实例上（正是上面说的那个坑）。
      if (activePanel === this) activePanel = null
      this.clearTimer()
      this.clearStopGuard()
      this.clearSlowTip()
      if (this.data.state === 'recording') {
        try {
          this.recorder.stop()
        } catch (e) {
          /* ignore */
        }
      }
    },
  },

  methods: {
    reset() {
      this.clearTimer()
      this.clearStopGuard()
      this.clearSlowTip()
      this.setData({
        state: 'idle',
        seconds: 0,
        mode: '',
        text: '',
        rawText: '',
        items: [],
        parser: '',
        aiError: '',
        tip: '',
      })
      this.syncHint()
    },

    /** 提示语跟着可用入口走，免得出现「按住说话」但语音没配。 */
    syncHint() {
      const speak = !!this.data.canSpeak
      const photo = !!this.data.canPhoto
      let hint = ''
      if (speak && photo) hint = '按住说话，或拍一张小票 / 支付截图'
      else if (speak) hint = '按住说话，例如「昨天午饭 35」或「给王哥随礼 800」'
      else if (photo) hint = '拍一张小票或支付截图，认出来逐行核对后再存'
      else hint = '识别服务还没配置（管理员在后台加语音识别或图片识别模型即可）'
      this.setData({ hintText: hint })
    },

    clearTimer() {
      if (this.timer) {
        clearInterval(this.timer)
        this.timer = null
      }
    },

    /**
     * onStop 迟迟不来的兜底。
     *
     * recorder.stop() 正常都会回调 onStop；个别机型、或录音短到几乎没启动时不会，
     * 这时浮层就永远停在「识别中…」。这个定时器只盯「回调到没到」——
     * onRecorded 一到就把 gotStop 置上，所以上传本身耗时长并不会被它误伤。
     */
    armStopGuard() {
      this.clearStopGuard()
      this.stopGuard = setTimeout(() => {
        this.stopGuard = null
        if (this.gotStop || this.data.state !== 'busy') return
        this.setData({ state: 'idle', tip: '' })
        ui.toast('这次没录上，再说一次')
      }, 8000)
    },

    clearStopGuard() {
      if (this.stopGuard) {
        clearTimeout(this.stopGuard)
        this.stopGuard = null
      }
    },

    /**
     * 认图等久了，把话说明白。
     *
     * 这条路真的慢（视觉模型排队，实测首 token 30~60 秒），一直显示「识别中…」
     * 会让人以为卡死了。所以十几秒后换成一句有信息量、并且**预期可控**的话 ——
     * 「半分钟」这种量级说出来了，用户才愿意等。
     */
    armSlowTip() {
      this.clearSlowTip()
      this.slowTip = setTimeout(() => {
        this.slowTip = null
        if (this.data.state !== 'busy') return
        this.setData({ tip: '还在认图，识别模型排队中，通常要半分钟' })
      }, 12000)
    },

    clearSlowTip() {
      if (this.slowTip) {
        clearTimeout(this.slowTip)
        this.slowTip = null
      }
    },

    /** 账户与分类在浮层里要能改，拉一次缓存住。 */
    ensureRefs() {
      if (this.refsLoaded) return
      Promise.all([request.get('/api/v1/accounts'), request.get('/api/v1/categories')])
        .then((res) => {
          const accounts = (res[0] && res[0].items) || []
          const cats = (res[1] && res[1].items) || []
          const expenseCats = cats.filter((c) => c.kind === 'expense' && !c.archived)
          const incomeCats = cats.filter((c) => c.kind === 'income' && !c.archived)
          this.setData({
            accounts: accounts,
            acctNames: accounts.map((a) => a.name),
            expenseCats: expenseCats,
            incomeCats: incomeCats,
            expNames: expenseCats.map((c) => c.name),
            incNames: incomeCats.map((c) => c.name),
          })
          this.refsLoaded = true
        })
        .catch(() => {
          /* 拉不到就只能在浮层里看、不能改，提交仍会由服务端兜底校验 */
        })
    },

    close() {
      if (this.data.state === 'recording') this.finishRecord()
      this.triggerEvent('close')
    },

    noop() {},

    // ---- 语音 ----

    startRecord() {
      if (this.data.state === 'recording') return
      // 认领这次录音：结束回调由模块级 bindRecorder 转发到这儿（见文件顶部说明）。
      activePanel = this
      this.setData({ state: 'recording', mode: 'voice', seconds: 0, tip: '松开发送' })
      this.recorder.start({ duration: MAX_SECONDS * 1000, format: 'mp3', sampleRate: 16000, encodeBitRate: 48000 })
      this.clearTimer()
      this.timer = setInterval(() => {
        const s = this.data.seconds + 1
        this.setData({ seconds: s })
        if (s >= MAX_SECONDS) this.finishRecord()
      }, 1000)
    },

    finishRecord() {
      if (this.data.state !== 'recording') return
      this.clearTimer()
      this.setData({ state: 'busy', tip: '识别中…' })
      this.gotStop = false
      this.armStopGuard()
      try {
        this.recorder.stop()
      } catch (e) {
        this.clearStopGuard()
        this.setData({ state: 'idle', tip: '' })
      }
    },

    onRecorded(res) {
      this.gotStop = true
      this.clearStopGuard()
      const filePath = res && res.tempFilePath
      if (!filePath) {
        this.setData({ state: 'idle', tip: '' })
        ui.toast('没有录到声音')
        return
      }
      if (res.duration && res.duration < 600) {
        this.setData({ state: 'idle', tip: '' })
        ui.toast('说得太短了')
        return
      }
      request
        .uploadBinary({ path: '/api/v1/speech/transcribe', filePath: filePath, ext: 'mp3' })
        .then((data) => {
          const text = (data && data.text) || ''
          if (!text.trim()) {
            this.setData({ state: 'idle', tip: '' })
            ui.toast('没听清，再说一次')
            return null
          }
          this.setData({ text: brief(text), rawText: '' })
          return request.post('/api/v1/imports/utterances', { text: text })
        })
        .then((preview) => this.applyPreview(preview, '没解析出记录，换种说法再试'))
        .catch((err) => this.onFail(err, '语音识别失败'))
    },

    /** 录音器报错（由模块级 bindRecorder 转发过来）。 */
    onRecordError(err) {
      this.gotStop = true
      this.clearStopGuard()
      this.setData({ state: 'idle', tip: '' })
      ui.toast((err && err.errMsg) || '录音失败')
    },

    // ---- 拍照 ----

    /**
     * 拍照 / 选图识账。
     *
     * 压缩放在 utils/image 里（起点档位是纯函数，逐档收敛在 prepare 里）。
     * 图片不落库、不进云存储：识别完就丢，临时文件交给微信回收。
     */
    pickPhoto() {
      if (this.data.state === 'busy' || this.data.state === 'recording') return
      this.setData({ mode: 'photo' })
      image
        .pick()
        .then((picked) => {
          this.setData({ state: 'busy', tip: '处理照片…' })
          return image.prepare(picked)
        })
        .then((ready) => {
          this.setData({ tip: '识别中…' })
          this.armSlowTip()
          return request.scanImage(ready)
        })
        .then((res) => {
          const text = (res && res.text) || ''
          if (!text.trim()) {
            this.setData({ state: 'idle', tip: '' })
            ui.toast('这张没认出文字，靠近点重拍')
            return null
          }
          this.setData({ text: brief(text), rawText: text })
          return request.post('/api/v1/imports/receipt', { text: text })
        })
        .then((preview) => this.applyPreview(preview, '这张没整理出流水，可以换一张'))
        .catch((err) => this.onFail(err, '拍照识别失败'))
    },

    // ---- 两条入口汇到这儿 ----

    /** @param {object|null} preview 上一步返回空（已经 toast 过了）时跳过 */
    applyPreview(preview, emptyTip) {
      this.clearSlowTip()
      if (!preview) return
      const items = this.decorate((preview && preview.items) || [])
      this.setData({
        state: items.length ? 'editing' : 'idle',
        items: items,
        parser: (preview && preview.parser) || '',
        aiError: (preview && preview.ai_error) || '',
        tip: items.length ? '' : emptyTip,
      })
    },

    /** 用户点取消不算失败，别弹报错。 */
    onFail(err, fallback) {
      this.clearSlowTip()
      const cancelled = err && err.code === 'cancelled'
      this.setData({ state: 'idle', tip: '' })
      if (cancelled) return
      ui.fail(err, fallback)
    },

    /** 认出了文字但没配解析模型：原文摆出来，让用户能照着手动记。 */
    copyRawText() {
      const text = String(this.data.rawText || '').trim()
      if (!text) return
      wx.setClipboardData({
        data: text,
        success: () => ui.toast('文字已复制'),
      })
    },

    // ---- 行编辑 ----

    /** 把接口行补上 WXML 里要直接显示的文本与下标。 */
    decorate(rows) {
      const expNames = this.data.expNames
      const incNames = this.data.incNames
      const acctNames = this.data.acctNames
      return rows.map((r) => {
        const cats = r.direction === 'income' ? this.data.incomeCats : this.data.expenseCats
        const names = r.direction === 'income' ? incNames : expNames
        let catIndex = cats.findIndex((c) => c.id === r.category_id)
        if (catIndex < 0 && r.category_name) catIndex = names.indexOf(r.category_name)
        let acctIndex = this.data.accounts.findIndex((a) => a.id === r.account_id)
        if (acctIndex < 0 && r.account_name) acctIndex = acctNames.indexOf(r.account_name)
        return Object.assign({}, r, {
          amountText: r.amount_cents ? money.formatYuan(r.amount_cents) : '',
          date: r.date || time.todayISO(),
          noteText: r.note || '',
          counterpartyText: r.counterparty || '',
          catIndex: catIndex,
          acctIndex: acctIndex,
          catName: names[catIndex] || '未选分类',
          acctName: acctNames[acctIndex] || '未选账户',
          bad: r.status !== 'ok',
          isFavor: !!(r.favor_contact || r.counterparty) || this.data.scope === 'favor',
        })
      })
    },

    onAmount(e) {
      this.patch(e.currentTarget.dataset.i, { amountText: e.detail.value })
    },

    onNote(e) {
      this.patch(e.currentTarget.dataset.i, { noteText: e.detail.value })
    },

    onCounterparty(e) {
      this.patch(e.currentTarget.dataset.i, { counterpartyText: e.detail.value })
    },

    onDate(e) {
      this.patch(e.currentTarget.dataset.i, { date: e.detail.value })
    },

    onDirection(e) {
      const i = Number(e.currentTarget.dataset.i)
      const item = this.data.items[i]
      if (!item) return
      const direction = item.direction === 'expense' ? 'income' : 'expense'
      // 收支一变，分类列表整套换掉，原来的分类下标不再有意义。
      const names = direction === 'income' ? this.data.incNames : this.data.expNames
      const cats = direction === 'income' ? this.data.incomeCats : this.data.expenseCats
      this.patch(i, {
        direction: direction,
        catIndex: 0,
        catName: names[0] || '未选分类',
        category_id: cats[0] ? cats[0].id : '',
      })
    },

    pickCategory(e) {
      const i = Number(e.currentTarget.dataset.i)
      const item = this.data.items[i]
      if (!item) return
      const cats = item.direction === 'income' ? this.data.incomeCats : this.data.expenseCats
      const names = item.direction === 'income' ? this.data.incNames : this.data.expNames
      const idx = Number(e.detail.value)
      this.patch(i, {
        catIndex: idx,
        catName: names[idx] || '未选分类',
        category_id: cats[idx] ? cats[idx].id : '',
      })
    },

    pickAccount(e) {
      const i = Number(e.currentTarget.dataset.i)
      const idx = Number(e.detail.value)
      const acct = this.data.accounts[idx]
      this.patch(i, { acctIndex: idx, acctName: acct ? acct.name : '未选账户', account_id: acct ? acct.id : '' })
    },

    removeRow(e) {
      const i = Number(e.currentTarget.dataset.i)
      const items = this.data.items.slice()
      items.splice(i, 1)
      this.setData({ items: items, state: items.length ? 'editing' : 'idle' })
    },

    patch(i, obj) {
      const data = {}
      Object.keys(obj).forEach((k) => {
        data['items[' + i + '].' + k] = obj[k]
      })
      this.setData(data)
    },

    retry() {
      this.reset()
    },

    // ---- 提交 ----

    buildRows() {
      const out = []
      const expenseCats = this.data.expenseCats
      const incomeCats = this.data.incomeCats
      const accounts = this.data.accounts
      const favorScope = this.data.scope === 'favor'
      this.data.items.forEach((it) => {
        if (it.bad) return
        const cents = money.yuanExprToCents(it.amountText)
        if (!cents) return
        const cats = it.direction === 'income' ? incomeCats : expenseCats
        const catId = it.category_id || (cats[it.catIndex] ? cats[it.catIndex].id : '')
        const acctId = it.account_id || (accounts[it.acctIndex] ? accounts[it.acctIndex].id : '')
        const row = {
          date: it.date,
          amount_cents: cents,
          direction: it.direction,
          category_id: catId,
          account_id: acctId,
          note: it.noteText,
        }
        if (favorScope) {
          row.favor_contact = it.counterpartyText || it.noteText
          row.favor_kind = it.direction === 'income' ? 'receive' : 'give'
          row.favor_occasion = it.favor_occasion || ''
        }
        out.push(row)
      })
      return out
    },

    commit() {
      const rows = this.buildRows()
      if (!rows.length) {
        ui.toast('没有可保存的行')
        return
      }
      const missing = rows.some((r) => !r.account_id)
      if (missing) {
        ui.toast('有行还没选账户')
        return
      }
      ui.withLoading('保存中', () =>
        request.post('/api/v1/imports/commit', {
          source: this.data.mode === 'photo' ? 'generic' : 'utterance',
          dedupe: true,
          rows: rows,
        }),
      )
        .then((res) => {
          const n = (res && res.imported) || 0
          const gifts = (res && res.gifts) || 0
          ui.ok(gifts ? '记下 ' + n + ' 笔，含 ' + gifts + ' 笔人情' : '记下 ' + n + ' 笔')
          this.triggerEvent('done', { imported: n, gifts: gifts })
          this.triggerEvent('close')
        })
        .catch((err) => ui.fail(err, '保存失败'))
    },
  },
})
