/**
 * 加号浮层：明细页右下角那个 + 展开的入口。
 * 只负责选，具体跳转交给页面（页面才知道当前上下文，比如要不要带日期）。
 */

Component({
  properties: {
    show: { type: Boolean, value: false },
    /** 页面已经按用户配置、排序及当前能力筛选过的入口。 */
    items: { type: Array, value: [] },
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
