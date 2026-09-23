/**
 * 月份切换条（药丸）：‹ 2026年9月 ›
 *
 * 明细 / 预算 / 人情三页共用。以前这几处各写一遍 .month-nav，样式一改要改三处；
 * 更麻烦的是月份文字只是个 <view>，想跳到几个月以前只能一个月一个月点箭头。
 * 现在中间的月份是可点的：弹出一个「年 / 月」双列滚轮，直接跳过去。
 *
 * 组件只负责显示与派发，**月份本身由页面持有**。切月往往要连带重置筛选、
 * 清掉选中日、重新拉数据，那是页面的决定，组件不该替它做主。
 *
 * 属性
 *   month   当前月份 'YYYY-MM'（空 = 本月）
 *   max     可选的最后一个月 'YYYY-MM'（空 = 本月）。预算传「下个月」——
 *           它是唯一允许提前设预算的页面，别把上限一律写成当月。
 *   compact 紧凑模式：整条收成内容宽度（inline-flex）、去掉外边距，
 *           「回到本月」改挂在药丸旁边而不是行的右缘。
 *           用于和别的控件并排一行的场景（人情页的月份条 + 搜索框）。
 * 事件
 *   bind:change  detail = { month }。选中的月份与当前相同时不派发，
 *                免得页面白白重拉一遍数据。
 */

const time = require('../../utils/time')

Component({
  properties: {
    month: { type: String, value: '' },
    max: { type: String, value: '' },
    compact: { type: Boolean, value: false },
  },

  data: {
    monthText: '',
    canPrev: true,
    canNext: true,
    showBack: false,
    /** 双列滚轮：[年份, 月份]，picker 的 range 需要二维数组 */
    range: [[], []],
    value: [0, 0],
  },

  observers: {
    'month, max': function () {
      this.sync()
    },
  },

  lifetimes: {
    attached() {
      // observers 初始化时也会跑一次，这里再兜一次：万一页面还没给 month，
      // 组件也要立刻显示成本月，而不是一片空白。
      this.sync()
    },
  },

  methods: {
    /**
     * 按当前 month / max 重算文案、箭头状态与两列滚轮。
     * 这些状态全部从这里出，别在别处零散 setData —— 否则很容易出现
     * 「文案变了、滚轮还停在旧位置」这种半更新。
     */
    sync() {
      const cap = this.data.max || time.shanghaiMonth()
      const month = this.data.month || cap
      const years = time.pickerYears(cap)
      const months = time.pickerMonths(Number(month.slice(0, 4)), cap)
      // 存一份数值形式给换算用：data 里放的是给 picker 看的「2017年」这种字符串。
      this.years = years
      this.setData({
        monthText: time.monthLabel(month),
        canPrev: month > years[0] + '-01',
        canNext: month < cap,
        showBack: month !== time.shanghaiMonth(),
        range: [years.map((y) => y + '年'), months.map((m) => m + '月')],
        value: [time.pickerIndex(month, years), Math.min(Number(month.slice(5, 7)) - 1, months.length - 1)],
      })
    },

    prev() {
      this.emit(time.addMonth(this.data.month, -1))
    },

    next() {
      this.emit(time.addMonth(this.data.month, 1))
    },

    back() {
      this.emit(time.shanghaiMonth())
    },

    /**
     * 派发月份变化。三种情况不发：
     *   月份没变（免得页面白重拉一次）、超出上限、早于年份列下界。
     * 后两条本该被置灰的按钮挡住，但按钮的 disabled 只挡点击、挡不住代码，
     * 所以在这里再收一道口 —— 页面不该收到一个越界的月份。
     */
    emit(month) {
      if (!month || month === this.data.month) return
      const years = this.years || []
      const cap = this.data.max || time.shanghaiMonth()
      if (month > cap) return
      if (years.length && month < years[0] + '-01') return
      this.triggerEvent('change', { month: month })
    },

    /**
     * 滚年份列时把月份列截断：上限那年只排到上限月。
     * 只处理第 0 列，第 1 列自身的变化不用管。
     */
    onColumn(e) {
      if (e.detail.column !== 0) return
      const cap = this.data.max || time.shanghaiMonth()
      const year = this.years[e.detail.value]
      if (year == null) return
      const months = time.pickerMonths(year, cap)
      // 月份列变短后，旧下标可能已经越界；不收敛的话 picker 会停在一个
      // 不存在的位置，再点确定就取到 undefined。
      this.setData({
        'range[1]': months.map((m) => m + '月'),
        value: [e.detail.value, Math.min(this.data.value[1], months.length - 1)],
      })
    },

    /**
     * 点确定。
     *
     * 必须按选中的年份**自己重算**月份列再取值：用户可能先滚到今年、再滚到
     * 12 月，而列变化事件不保证来得及把月份列截断，所以不能直接拿
     * e.detail.value[1] 去索引。最后再和上限比一次是兜底（正常不会命中）。
     */
    onPick(e) {
      const cap = this.data.max || time.shanghaiMonth()
      const year = this.years[e.detail.value[0]]
      if (year == null) {
        this.sync()
        return
      }
      const months = time.pickerMonths(year, cap)
      const mi = Math.min(e.detail.value[1], months.length - 1)
      let month = year + '-' + String(months[mi]).padStart(2, '0')
      if (month > cap) month = cap
      // 不论选没选中新月份，都把滚轮复位（用户可能中途滚过又滚回来）
      this.sync()
      this.emit(month)
    },
  },
})
