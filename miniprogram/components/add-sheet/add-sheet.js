/**
 * 加号浮层：明细页右下角那个 + 展开的入口。
 * 只负责选，具体跳转交给页面（页面才知道当前上下文，比如要不要带日期）。
 */

Component({
  properties: {
    show: { type: Boolean, value: false },
    /**
     * 智能记账是否可用。语音走微信插件，始终算可用；图片识别没配时仍可说话。
     */
    canAi: { type: Boolean, value: true },
    /** 语音是否可用。「日历记录」按住说话后拆日期和事情，再记进日历。 */
    canSpeak: { type: Boolean, value: true },
  },

  methods: {
    close() {
      this.triggerEvent('close')
    },

    pick(e) {
      const type = e.currentTarget.dataset.type
      this.triggerEvent('close')
      this.triggerEvent('select', { type: type })
    },

    noop() {
      /* 挡住浮层下的点击 */
    },
  },
})
