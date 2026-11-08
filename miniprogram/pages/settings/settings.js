/** 本机账号偏好：记录人展示与明细加号入口，修改后立即保存。 */
const session = require('../../utils/session')

Page({
  data: {
    showRecorder: true,
    actions: [],
    dragType: '',
    dragOffset: 0,
  },

  onShow() {
    this.drag = null
    this.setData({ showRecorder: session.recorderPreference(), actions: session.addActionPreference(), dragType: '', dragOffset: 0 })
  },

  onHide() {
    this.cancelDrag()
  },

  toggleRecorder(e) {
    session.setRecorderPreference(e.detail.value)
    this.setData({ showRecorder: session.recorderPreference() })
  },

  toggleAction(e) {
    if (this.drag) return
    const type = e.currentTarget.dataset.type
    const actions = session.addActionPreference()
    const item = actions.find((entry) => entry.type === type)
    if (!item) return
    if (!e.detail.value && item.enabled && actions.filter((entry) => entry.enabled).length === 1) {
      // 先同步本次开关状态，再恢复，确保原生 switch 也回到开启。
      this.setData({ actions: actions.map((entry) => Object.assign({}, entry, { enabled: entry.type === type ? false : entry.enabled })) }, () => {
        this.setData({ actions })
      })
      wx.showToast({ title: '至少保留一个入口', icon: 'none' })
      return
    }
    item.enabled = !!e.detail.value
    this.saveActions(actions)
  },

  startDrag(e) {
    const point = e.touches && e.touches[0]
    const type = e.currentTarget.dataset.type
    const index = this.data.actions.findIndex((item) => item.type === type)
    if (!point || index < 0 || this.drag) return
    const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
    // 与样式中的单行 96rpx 同步，整个列表可在一屏内完成拖动。
    this.drag = { type, startY: point.clientY, startIndex: index, rowHeight: 96 * info.windowWidth / 750,
      original: this.data.actions.slice() }
    this.setData({ dragType: type, dragOffset: 0 })
  },

  moveDrag(e) {
    const point = e.touches && e.touches[0]
    const drag = this.drag
    if (!drag || !point) return
    const actions = this.data.actions.slice()
    const index = actions.findIndex((item) => item.type === drag.type)
    const delta = Math.max(-drag.startIndex * drag.rowHeight,
      Math.min((actions.length - 1 - drag.startIndex) * drag.rowHeight, point.clientY - drag.startY))
    const target = Math.max(0, Math.min(actions.length - 1, drag.startIndex + Math.round(delta / drag.rowHeight)))
    if (target !== index) {
      const item = actions.splice(index, 1)[0]
      actions.splice(target, 0, item)
    }
    this.setData({ actions, dragOffset: delta + (drag.startIndex - target) * drag.rowHeight })
  },

  endDrag() {
    if (!this.drag) return
    this.drag = null
    this.saveActions(this.data.actions)
    this.setData({ dragType: '', dragOffset: 0 })
  },

  cancelDrag() {
    if (!this.drag) return
    const actions = this.drag.original
    this.drag = null
    this.setData({ actions, dragType: '', dragOffset: 0 })
  },

  saveActions(actions) {
    session.setAddActionPreference(actions)
    this.setData({ actions: session.addActionPreference() })
  },
})
