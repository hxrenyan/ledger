/** 明细快捷入口：原生拖动限制在窗口内，位置按窗口比例保存在本机。 */
const POSITION = 'ledger.floatingActions.position'

Component({
  data: { x: 0, y: 0, width: 0, height: 0 },
  lifetimes: {
    attached() { this.restorePosition() },
  },
  pageLifetimes: {
    show() { this.restorePosition() },
    resize() { this.restorePosition() },
  },
  methods: {
    restorePosition() {
      const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
      const scale = info.windowWidth / 750
      const inset = info.safeArea ? Math.max(0, info.screenHeight - info.safeArea.bottom) : 0
      const width = Math.max(0, info.windowWidth - 24)
      const height = Math.max(0, info.windowHeight - 24 - inset)
      this.maxX = Math.max(0, width - 112 * scale)
      this.maxY = Math.max(0, height - 112 * scale)
      let saved
      try { saved = wx.getStorageSync(POSITION) } catch (e) { /* 未保存时使用右下角 */ }
      const ratio = (value) => typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 1
      this.position = { x: ratio(saved && saved.x) * this.maxX, y: ratio(saved && saved.y) * this.maxY }
      this.setData({ width, height, x: this.position.x, y: this.position.y })
    },
    startTouch(e) {
      this.startPoint = e.touches && e.touches[0]
      this.dragged = false
    },
    moveTouch(e) {
      const point = e.touches && e.touches[0]
      if (point && this.startPoint && Math.hypot(point.clientX - this.startPoint.clientX, point.clientY - this.startPoint.clientY) > 6) {
        this.dragged = true
      }
    },
    changePosition(e) {
      if (e.detail.source !== 'touch') return
      this.position = {
        x: Math.max(0, Math.min(this.maxX, e.detail.x)),
        y: Math.max(0, Math.min(this.maxY, e.detail.y)),
      }
    },
    endTouch() {
      if (!this.dragged || !this.position) return
      this.ignoreTapUntil = Date.now() + 350
      try {
        wx.setStorageSync(POSITION, {
          x: this.maxX ? this.position.x / this.maxX : 0,
          y: this.maxY ? this.position.y / this.maxY : 0,
        })
      } catch (e) { /* 存储失败不影响拖动 */ }
    },
    add() {
      if (this.dragged || Date.now() < (this.ignoreTapUntil || 0)) return
      this.triggerEvent('add')
    },
  },
})
