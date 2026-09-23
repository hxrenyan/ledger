/**
 * 时间：与 src/time.ts 保持同一套口径（上海无夏令时，固定 UTC+8）。
 * 月份、日期都是 'YYYY-MM' / 'YYYY-MM-DD' 字符串，和接口参数一致。
 */

const SH_OFFSET = 8 * 3600 * 1000
const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

/**
 * 日历表头的排列顺序：**周一开头**（与 web/src/pages/Home.vue 的日历一致）。
 *
 * 这个数组和下面的 calendarGrid 里的 lead 计算是一对，必须同时是周一开头：
 * 表头写「一…日」而格子从周日排，日期就会整体错位一格。所以表头也从这里出，
 * 页面上不要再硬编码七个 <view class="w">。
 */
const CAL_WEEK = ['一', '二', '三', '四', '五', '六', '日']

function pad2(n) {
  return String(n).padStart(2, '0')
}

function shanghaiDate(ms) {
  return new Date((ms == null ? Date.now() : ms) + SH_OFFSET).toISOString().slice(0, 10)
}

function shanghaiMonth(ms) {
  return shanghaiDate(ms).slice(0, 7)
}

function occurredAtToDate(ms) {
  return shanghaiDate(ms)
}

function todayISO() {
  return shanghaiDate()
}

function addDays(dateStr, delta) {
  const p = dateStr.split('-').map(Number)
  const d = new Date(Date.UTC(p[0], p[1] - 1, p[2] + delta))
  return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate())
}

function addMonth(month, delta) {
  const p = month.split('-').map(Number)
  const d = new Date(Date.UTC(p[0], p[1] - 1 + delta, 1))
  return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1)
}

function daysInMonth(month) {
  const p = month.split('-').map(Number)
  return new Date(Date.UTC(p[0], p[1], 0)).getUTCDate()
}

/** '2026-09' → '2026年9月' */
function monthLabel(month) {
  if (!month) return ''
  const p = month.split('-')
  return p[0] + '年' + Number(p[1]) + '月'
}

// ---------------------------------------------------------------------------
// 月份选择（点月份标签弹出的年 / 月双列滚轮）
//
// 三页共用 components/month-nav，这几个函数是它的数据源。规则只有一条：
// **不许出现比 max 更晚的月份**（明细与人情不能看未来，预算是 max = 下个月，
// 因为它允许提前给下个月设预算）。所以「上限那年」的月份列只排到上限月，
// 其余年份排满 12 个月。
// ---------------------------------------------------------------------------

/** 年份列默认跨度：近 10 年（含上限年）。 */
const YEAR_SPAN = 10

/**
 * 年份列（升序），上限年取自 maxMonth。
 * @param {string} maxMonth 'YYYY-MM'
 * @param {number} [span]
 * @returns {number[]} 例如 [2017, ..., 2026]
 */
function pickerYears(maxMonth, span) {
  const top = Number((maxMonth || shanghaiMonth()).slice(0, 4))
  const n = span || YEAR_SPAN
  const years = []
  for (let y = top - n + 1; y <= top; y += 1) years.push(y)
  return years
}

/**
 * 某一年可选的月份（1-12）。
 *
 * 只有「上限那年」会被截断到上限月 —— 这是防选未来的唯一一处判断，
 * 页面不要再各自写一遍。
 * @param {number|string} year
 * @param {string} maxMonth 'YYYY-MM'
 * @returns {number[]}
 */
function pickerMonths(year, maxMonth) {
  const cap = maxMonth || shanghaiMonth()
  const last = String(year) === cap.slice(0, 4) ? Number(cap.slice(5, 7)) : 12
  const months = []
  for (let m = 1; m <= last; m += 1) months.push(m)
  return months
}

/**
 * 当前月份在年份列里的下标（月份列下标就是 月 - 1）。
 * 给进来的月份超范围时退回最后一年，避免滚轮定位不到而落在第 0 项。
 * @param {string} month 'YYYY-MM'
 * @param {number[]} years
 */
function pickerIndex(month, years) {
  const at = years.indexOf(Number(String(month).slice(0, 4)))
  return at < 0 ? years.length - 1 : at
}

/** '2026-09-23' → '9月23日 周三' */
function dateLabel(dateStr) {
  if (!dateStr) return ''
  const p = dateStr.split('-').map(Number)
  const d = new Date(Date.UTC(p[0], p[1] - 1, p[2]))
  return p[1] + '月' + p[2] + '日 ' + WEEK[d.getUTCDay()]
}

/** 列表分组用的短标签：今天 / 昨天 / 9月23日 周三 */
function dayLabel(dateStr) {
  if (!dateStr) return ''
  const today = todayISO()
  if (dateStr === today) return '今天'
  if (dateStr === addDays(today, -1)) return '昨天'
  const p = dateStr.split('-').map(Number)
  const d = new Date(Date.UTC(p[0], p[1] - 1, p[2]))
  return p[1] + '月' + p[2] + '日 ' + WEEK[d.getUTCDay()]
}

/**
 * 日历网格：补齐月初空位，标记有流水的日期。
 *
 * 起点是**周一**（+6 再取模），与 CAL_WEEK 一致 —— 别改回 first.getUTCDay()，
 * 那是周日开头，会让格子与表头错开一格。
 *
 * @param {string} month 'YYYY-MM'
 * @param {Object} marked { '2026-09-23': true }
 * @returns {{ cells: {key:string, day:number, date:string, has:boolean, blank:boolean}[], weeks: number }}
 */
function calendarGrid(month, marked) {
  const p = month.split('-').map(Number)
  const first = new Date(Date.UTC(p[0], p[1] - 1, 1))
  const lead = (first.getUTCDay() + 6) % 7
  const total = daysInMonth(month)
  const cells = []
  for (let i = 0; i < lead; i += 1) {
    cells.push({ key: 'blank-' + i, day: 0, date: '', has: false, blank: true })
  }
  for (let d = 1; d <= total; d += 1) {
    const date = month + '-' + pad2(d)
    cells.push({ key: date, day: d, date: date, has: !!(marked && marked[date]), blank: false })
  }
  return { cells: cells, weeks: Math.ceil(cells.length / 7) }
}

module.exports = {
  WEEK: WEEK,
  CAL_WEEK: CAL_WEEK,
  shanghaiDate: shanghaiDate,
  shanghaiMonth: shanghaiMonth,
  occurredAtToDate: occurredAtToDate,
  todayISO: todayISO,
  addDays: addDays,
  addMonth: addMonth,
  daysInMonth: daysInMonth,
  monthLabel: monthLabel,
  YEAR_SPAN: YEAR_SPAN,
  pickerYears: pickerYears,
  pickerMonths: pickerMonths,
  pickerIndex: pickerIndex,
  dateLabel: dateLabel,
  dayLabel: dayLabel,
  calendarGrid: calendarGrid,
}
