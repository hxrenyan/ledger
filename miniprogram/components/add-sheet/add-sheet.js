/**
 * 加号浮层：明细页右下角那个 + 展开的四个入口。
 * 只负责选，具体跳转交给页面（页面才知道当前上下文，比如要不要带日期）。
 */

Component({
  properties: {
    show: { type: Boolean, value: false },
    /**
     * 智能记账是否可用。语音识别与图片识别任一配置好就算可用 ——
     * 具体用哪个入口由浮层内部再分（那边两个开关是分开的）。
     * 两个都没配时整项隐藏，免得点进去只看到「未配置」。
     */
    canAi: { type: Boolean, value: true },
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
