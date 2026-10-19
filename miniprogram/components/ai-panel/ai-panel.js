/**
 * 智能记账浮层（认得出就记下 → 逐行核对 → 提交）。
 *
 * 两条入口，汇到同一个下游：
 *   语音  按住说话 → POST /speech/transcribe → 文字
 *   拍照  拍一张   → 本机 VisionKit 先认字；不够再压图上传 POST /ocr/scan → 文字
 *   两者都 → POST /imports/receipt 或 /imports/utterances（提示词不同：
 *          口语一句一笔；票据要区分实付金额与余额、明细与合计）
 *        → 用户核对、改正 → POST /imports/commit。
 *
 * 两个 scope：
 *   tx    普通记账，解析结果按支出/收入正常入账；
 *   favor 人情往来。认出对方姓名的行默认是人情，核对时可以改回明细。
 *         人情行可以打开「同时记明细」，再按所选账户和分类写一笔流水。
 *
 * 两个可用性开关（管理员在后台配了对应模型才有）：
 *   canSpeak 语音识别（ASR）    canPhoto 图片识别（OCR）
 * 只配了其中一个时，另一个入口不显示 —— 别让人按住说话却拿到「未配置」。
 *
 * 上传都走 utils 里的手工 multipart：语音接口按 audio/*、认图接口按 image/*
 * 校验分片自己的 Content-Type，而 wx.uploadFile 不保证给对（和收据上传同一个坑）。
 */

const request = require('../../utils/request')
const session = require('../../utils/session')
const image = require('../../utils/image')
const localOcr = require('../../utils/localOcr')
const money = require('../../utils/money')
const time = require('../../utils/time')
const ui = require('../../utils/ui')

const MAX_SECONDS = 60
/** OCR 返回文字后还要再走一次文本模型整理，不能沿用普通接口 20 秒默认值。 */
const PARSE_TIMEOUT_MS = 120000
/** 核对页里那行原文只作参考，太长就把票据正文挤没了。 */
const BRIEF_CHARS = 200

const WECHAT_ONLY = '语音识别、图片识别和文本整理仅支持微信登录'

function pointsBody(raw) {
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw)
    } catch (e) {
      return null
    }
  }
  return raw && typeof raw === 'object' ? raw : null
}

/**
 * 余额不够或不是微信账号时返回 null，并说明原因。够用时返回摘要。
 * 会话里已经是微信登录时，不以摘要里缺失的 wechat 字段把人拦下。
 */
function ensurePoints(need) {
  const sessionWechat = session.isWechat()
  return request.get('/api/v1/points').then((raw) => {
    const summary = pointsBody(raw)
    if (summary && summary.restricted === false) return summary
    const flagged = !!(summary && (summary.wechat === true || summary.wechat === 1))
    if (!flagged && !sessionWechat) {
      wx.showModal({
        title: '无法使用',
        content: WECHAT_ONLY,
        showCancel: false,
      })
      return null
    }
    // 登录态已是微信，但这份摘要把余额写成 0（判成非微信时的占位）。交给后面的接口扣费。
    if (!flagged) return { wechat: true, balance: need, today_checked: false }
    if (Number(summary.balance) < need) {
      const lack = need - Number(summary.balance)
      const tail = summary.today_checked ? '今日进入积分已领取' : '今日进入积分还未领取'
      wx.showModal({
        title: '积分不足',
        content: '这段需要 ' + need + ' 积分，还差 ' + lack + '。' + tail,
        showCancel: false,
      })
      return null
    }
    return summary
  })
}

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
  manager.onStart(function () {
    const panel = activePanel
    // 浮层已经关了：没有面板来收这次开始，直接停，避免麦克风空录到时长上限。
    if (!panel) {
      try {
        manager.stop()
      } catch (e) {
        /* ignore */
      }
      return
    }
    panel.onRecordStart()
  })
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
    /** 圆按钮上的字。录音中只改这段文字，不换节点，否则松手事件会丢。 */
    talkText: '按住说话',
    maxSeconds: MAX_SECONDS,
    /** 这一轮是从哪进来的：'' | 'voice' | 'photo'（决定「重说」还是「换一张」） */
    mode: '',
    /** 本机认字成功后才允许「云端再认一次」。云端路径不再提供，避免同一张图反复上传。 */
    canCloudRetry: false,
    /** '' | 'local' | 'cloud'。核对页用来标明这批字是从哪认出来的。 */
    ocrSource: '',
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
      // 不要在页面打开时就拿录音器。正式版会按隐私接口检查麦克风，
      // 一进明细就调用的话，每次打开都会弹错。等用户真的按住说话再拿。
      this.recorder = null
      this.timer = null
      this.stopGuard = null
      this.photoGen = 0
      this.photoPicked = null
      this.holding = false
      this.stopping = false
      this.pendingStop = false
      this.recorderStarted = false
    },
    detached() {
      // 录音途中被销毁：这次的结果没人要了，但 activePanel 必须清掉，
      // 否则下一次录音的回调会落在一个已销毁的实例上（正是上面说的那个坑）。
      this.holding = false
      this.pendingStop = true
      const recorder = this.recorder
      const started = this.recorderStarted || this.data.state === 'recording'
      if (activePanel === this) activePanel = null
      this.clearTimer()
      this.clearStopGuard()
      this.clearSlowTip()
      if (recorder && started) {
        try {
          recorder.stop()
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
      // 作废还在飞的认图：关掉再打开时，上一张的结果不能写进新的一轮。
      this.photoGen = (this.photoGen || 0) + 1
      this.photoPicked = null
      this.holding = false
      this.stopping = false
      this.pendingStop = false
      this.recorderStarted = false
      this.setData({
        state: 'idle',
        seconds: 0,
        talkText: '按住说话',
        mode: '',
        text: '',
        rawText: '',
        items: [],
        parser: '',
        aiError: '',
        tip: '',
        canCloudRetry: false,
        ocrSource: '',
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

    ensureRecorder() {
      if (this.recorder) return this.recorder
      this.recorder = wx.getRecorderManager()
      bindRecorder(this.recorder)
      return this.recorder
    },

    startRecord() {
      if (this.data.state === 'recording' || this.data.state === 'busy' || this.holding) return
      // 新语音沿用整轮重置，清掉上一张照片，并作废选图、认图和确认弹窗的迟到回调。
      this.reset()
      const gen = this.photoGen
      this.holding = true
      ensurePoints(1)
        .then((summary) => {
          if (this.photoGen !== gen) return
          // 余额查询回来时手指已经松开，就不要再开录，否则按钮会在松手后才变状态。
          if (!summary || !this.holding || this.data.state !== 'idle') {
            this.holding = false
            return
          }
          // 认领这次录音：结束回调由模块级 bindRecorder 转发到这儿（见文件顶部说明）。
          activePanel = this
          this.setData({
            state: 'recording',
            mode: 'voice',
            seconds: 0,
            talkText: '0 · 松开结束',
            tip: '松开发送',
          })
          this.ensureRecorder().start({ duration: MAX_SECONDS * 1000, format: 'mp3', sampleRate: 16000, encodeBitRate: 48000 })
          this.clearTimer()
          this.timer = setInterval(() => {
            if (this.data.state !== 'recording') return
            const s = this.data.seconds + 1
            this.setData({ seconds: s, talkText: s + ' · 松开结束' })
            if (s >= MAX_SECONDS) this.finishRecord()
          }, 1000)
        })
        .catch((err) => {
          if (this.photoGen !== gen) return
          this.holding = false
          this.onFail(err, '暂时无法录音')
        })
    },

    /**
     * 松手、滑出、来电打断都走这里。蒙版和圆按钮都会调用，必须可重复进入。
     * 录音器在 onStart 之前收到 stop 会直接丢掉，所以先记下，等真正开始再停。
     */
    finishRecord() {
      this.holding = false
      if (this.stopping) return
      const recording = this.data.state === 'recording'
      if (!recording && !this.pendingStop) return
      if (!this.recorderStarted) {
        this.pendingStop = true
        if (recording) {
          this.clearTimer()
          this.setData({ state: 'busy', tip: '识别中…', talkText: '按住说话' })
          this.armStopGuard()
        }
        return
      }
      this.stopRecorder()
    },

    /** 录音器真正开始。手指已经松开的话，补上刚才被丢掉的 stop。 */
    onRecordStart() {
      this.recorderStarted = true
      if (!this.holding || this.pendingStop) this.stopRecorder()
    },

    stopRecorder() {
      if (this.stopping) return
      this.stopping = true
      this.pendingStop = false
      this.holding = false
      this.clearTimer()
      this.setData({ state: 'busy', tip: '识别中…', talkText: '按住说话' })
      this.gotStop = false
      this.armStopGuard()
      try {
        this.recorder.stop()
      } catch (e) {
        this.stopping = false
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
      const durationMs = res.duration || this.data.seconds * 1000
      let seconds = Math.ceil(durationMs / 1000)
      if (seconds < 1) seconds = 1
      if (seconds > MAX_SECONDS) seconds = MAX_SECONDS
      const need = Math.max(1, Math.ceil(seconds / 2))
      ensurePoints(need)
        .then((summary) => {
          if (!summary) {
            this.setData({ state: 'idle', tip: '' })
            return null
          }
          return request.uploadBinary({
            path: '/api/v1/speech/transcribe',
            filePath: filePath,
            ext: 'mp3',
            formData: { duration_ms: String(durationMs) },
          })
        })
        .then((data) => {
          if (!data) return null
          const text = (data && data.text) || ''
          if (!text.trim()) {
            this.setData({ state: 'idle', tip: '' })
            ui.toast('没听清，再说一次')
            return null
          }
          this.setData({ text: brief(text), rawText: '' })
          return request.post('/api/v1/imports/utterances', { text: text }, { timeout: PARSE_TIMEOUT_MS })
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
     * 先在手机上认（VisionKit，照片不上传）。有效文字够就直接整理成流水。
     * 不够、超时或这台设备没有端侧能力时，再压图上传走原来的 /ocr/scan。
     * 图片不落库、不进云存储：识别完就丢，临时文件交给微信回收。
     */
    pickPhoto() {
      if (this.data.state === 'busy' || this.data.state === 'recording' || this.holding) return
      const gen = this.photoGen || 0
      ensurePoints(1)
        .then((summary) => {
          if (!summary || this.photoGen !== gen) return null
          this.setData({ mode: 'photo' })
          return image.pick()
        })
        .then((picked) => {
          if (!picked || this.photoGen !== gen) return null
          this.photoPicked = picked
          // 基础库没有 VisionKit 时不要先闪一句「本机识别」。
          if (!localOcr.supported()) return this.runCloudScan(picked, gen, '正在识别…')
          this.setData({ state: 'busy', tip: '正在本机识别…', canCloudRetry: false, ocrSource: '' })
          return localOcr.recognize(picked.filePath).then(
            (text) => {
              if (this.photoGen !== gen) return null
              if (localOcr.usable(text)) {
                this.setData({ canCloudRetry: true, ocrSource: 'local' })
                return this.useOcrText(text, gen)
              }
              return this.runCloudScan(picked, gen, '本机没认全，改用云端识别…')
            },
            (err) => {
              if (this.photoGen !== gen) return null
              const tip = err && err.code === 'unsupported' ? '这台设备改用云端识别…' : '本机没认全，改用云端识别…'
              return this.runCloudScan(picked, gen, tip)
            },
          )
        })
        .catch((err) => {
          if (this.photoGen !== gen) return
          this.onFail(err, '拍照识别失败')
        })
    },

    canRetryPhoto() {
      return this.data.mode === 'photo' && this.data.canCloudRetry && !!this.photoPicked
        && this.data.state !== 'busy' && this.data.state !== 'recording' && !this.holding
    },

    /**
     * 用户觉得本机结果不对。确认后再上传同一张图。
     * 云端失败或没认出字时，把确认前的核对结果放回来，不要把已经对过的行清掉。
     */
    cloudRetry() {
      if (!this.canRetryPhoto()) return
      const picked = this.photoPicked
      const gen = this.photoGen || 0
      const keep = this.snapshot()
      wx.showModal({
        title: '云端再认一次',
        content: '这张照片会上传到服务器重新读字，整理成流水时按这一次的结果计积分。照片不会保存。',
        confirmText: '上传识别',
        success: (res) => {
          if (!res || !res.confirm || this.photoGen !== gen || this.photoPicked !== picked || !this.canRetryPhoto()) return
          this.runCloudScan(picked, gen, '正在上传，云端识别…', true)
            .then((preview) => {
              if (this.photoGen !== gen) return
              if (!preview) this.restore(keep)
            })
            .catch((err) => {
              if (this.photoGen !== gen) return
              this.restore(keep)
              this.onFail(err, '拍照识别失败', true)
            })
        },
      })
    },

    snapshot() {
      return {
        state: this.data.state,
        items: this.data.items,
        text: this.data.text,
        rawText: this.data.rawText,
        parser: this.data.parser,
        aiError: this.data.aiError,
        tip: this.data.tip,
        canCloudRetry: this.data.canCloudRetry,
        ocrSource: this.data.ocrSource,
      }
    },

    restore(keep) {
      if (!keep) return
      this.setData(keep)
    },

    /** 已经有文字了：交给票据整理。重试无可用结果时不覆盖原核对行，返回 null。 */
    useOcrText(text, gen, keepPreview) {
      const value = String(text || '')
      if (!value.trim()) {
        this.clearSlowTip()
        this.setData({ state: 'idle', tip: '' })
        ui.toast('这张没认出文字，靠近点重拍')
        return Promise.resolve(null)
      }
      this.setData({ text: brief(value), rawText: value, tip: '正在整理…' })
      return request.post('/api/v1/imports/receipt', { text: value }, { timeout: PARSE_TIMEOUT_MS }).then((preview) => {
        if (this.photoGen !== gen) return null
        if (keepPreview && (!preview || preview.parser === 'none' || !Array.isArray(preview.items) || !preview.items.length)) {
          this.clearSlowTip()
          ui.toast((preview && preview.ai_error) || '这张没整理出流水，保留原核对结果')
          return null
        }
        this.applyPreview(preview, '这张没整理出流水，可以换一张')
        return preview || null
      })
    },

    /** 压到能送出去的体积，再走服务器认图。tip 由调用方按「自动回退 / 用户点的再认」分开写。 */
    runCloudScan(picked, gen, tip, keepPreview) {
      this.setData({ state: 'busy', tip: tip, canCloudRetry: false, ocrSource: 'cloud' })
      this.armSlowTip()
      return image.prepare(picked).then((ready) => {
        if (!ready || this.photoGen !== gen) return null
        return request.scanImage(ready)
      }).then((res) => {
        if (!res || this.photoGen !== gen) return null
        return this.useOcrText((res && res.text) || '', gen, keepPreview)
      })
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

    /**
     * 用户点取消不算失败，别弹报错。
     * keepState：云端再认失败时核对页还在，不能把 state 刷回 idle。
     */
    onFail(err, fallback, keepState) {
      this.clearSlowTip()
      const cancelled = err && err.code === 'cancelled'
      if (!keepState) this.setData({ state: 'idle', tip: '' })
      if (cancelled) return
      const message = (err && err.message) || fallback
      if (err && (err.code === 'insufficient_points' || err.status === 403)) {
        wx.showModal({ title: err.status === 403 ? '无法使用' : '积分不足', content: message, showCancel: false })
        return
      }
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

    onRawText(e) {
      this.setData({ rawText: e.detail.value })
    },

    reparseRawText() {
      const text = String(this.data.rawText || '').trim()
      if (!text || this.data.state !== 'idle') return
      this.setData({ state: 'busy', tip: '正在整理…' })
      request
        .post('/api/v1/imports/receipt', { text: text }, { timeout: PARSE_TIMEOUT_MS })
        .then((preview) => this.applyPreview(preview, '这段文字没整理出流水，可以继续修改后重试'))
        .catch((err) => this.onFail(err, '重新整理失败'))
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
          counterpartyText: r.favor_contact || '',
          favorOccasion: r.favor_occasion || '',
          catIndex: catIndex,
          acctIndex: acctIndex,
          catName: names[catIndex] || '未选分类',
          acctName: acctNames[acctIndex] || '未选账户',
          bad: r.status !== 'ok',
          isFavor: !!r.favor_contact || this.data.scope === 'favor',
          alsoTx: false,
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

    setFavor(e) {
      const i = Number(e.currentTarget.dataset.i)
      const on = String(e.currentTarget.dataset.favor) === '1'
      const item = this.data.items[i]
      if (!item || !!item.isFavor === on) return
      this.patch(i, { isFavor: on })
    },

    onAlsoTx(e) {
      const i = Number(e.currentTarget.dataset.i)
      this.patch(i, { alsoTx: !!e.detail.value })
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
      let missingName = false
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
          favor_contact: '',
        }
        if (it.isFavor) {
          const name = String(it.counterpartyText || '').trim()
          if (!name) missingName = true
          row.favor_contact = name
          row.favor_kind = it.direction === 'income' ? 'receive' : 'give'
          row.favor_occasion = it.favorOccasion || ''
          row.also_tx = !!it.alsoTx
        }
        out.push(row)
      })
      return { rows: out, missingName: missingName }
    },

    commit() {
      const built = this.buildRows()
      const rows = built.rows
      if (built.missingName) {
        ui.toast('人情要填对方姓名')
        return
      }
      if (!rows.length) {
        ui.toast('没有可保存的行')
        return
      }
      const missing = rows.some((r) => r.also_tx !== false && !r.account_id)
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
          const failed = (res && res.failed) || []
          const duplicates = (res && res.duplicates) || 0
          if (!n && !gifts) {
            const reason = failed[0] && failed[0].reason
            ui.toast(reason ? '没记下：' + reason : duplicates ? '这几笔已经记过了' : '没有写下新记录')
            return
          }
          const dates = rows.map((row) => row.date).filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date))
          const latest = dates.slice().sort().pop()
          const otherMonth = latest && latest.slice(0, 7) !== time.shanghaiMonth()
          const summary = !n && gifts ? '记下 ' + gifts + ' 笔人情' : gifts ? '记下 ' + n + ' 笔，含 ' + gifts + ' 笔人情' : '记下 ' + n + ' 笔'
          ui.ok(otherMonth ? Number(latest.slice(5, 7)) + '月' + Number(latest.slice(8, 10)) + '日' : summary)
          this.triggerEvent('done', { imported: n, gifts: gifts, dates: dates })
          this.triggerEvent('close')
        })
        .catch((err) => ui.fail(err, '保存失败'))
    },
  },
})
