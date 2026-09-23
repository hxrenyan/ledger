<script setup lang="ts">
/**
 * 月份切换条（药丸）：‹ 2026年9月 ▾ ›，与小程序 components/month-nav 同一套交互。
 *
 * 明细 / 预算 / 人情三页共用。中间的月份可点：弹出「年 / 月」选择，直接跳，
 * 不用一个月一个月点箭头。H5 没有 picker 滚轮，用两个原生 select 兜住 ——
 * 选择能力一致，交互稍轻。
 *
 * 属性
 *   month  当前月份 'YYYY-MM'（空 = 本月）
 *   max    可选的最后一个月 'YYYY-MM'（空 = 本月）。预算传「下个月」——
 *          它是唯一允许提前设预算的页面。
 * 事件
 *   change  detail 为月份字符串。月份没变不派发，免得页面白重拉数据。
 */
import { computed, ref, watch } from 'vue'
import { addMonth, shanghaiMonth } from '@server/time.ts'

const props = defineProps<{ month?: string; max?: string }>()
const emit = defineEmits<{ change: [month: string] }>()

const cap = computed(() => props.max || shanghaiMonth())
const current = computed(() => props.month || cap.value)

/** 年份列：近 10 年（含上限年），升序。与小程序 time.pickerYears 同一规则。 */
const years = computed(() => {
  const top = Number(cap.value.slice(0, 4))
  const list: number[] = []
  for (let y = top - 9; y <= top; y++) list.push(y)
  return list
})

/** 某一年可选的月份：只有上限那年截断到上限月 —— 防选未来的唯一一处判断。 */
function monthsOfYear(year: number) {
  const last = String(year) === cap.value.slice(0, 4) ? Number(cap.value.slice(5, 7)) : 12
  return Array.from({ length: last }, (_, i) => i + 1)
}

const label = computed(() => {
  const [y, m] = current.value.split('-')
  return `${y}年${Number(m)}月`
})
const canPrev = computed(() => current.value > `${years.value[0]}-01`)
const canNext = computed(() => current.value < cap.value)
const showBack = computed(() => current.value !== shanghaiMonth())

const pickerOpen = ref(false)
const pickYear = ref(0)
const pickMonth = ref(1)
const pickMonths = computed(() => monthsOfYear(pickYear.value))

function openPicker() {
  pickYear.value = Number(current.value.slice(0, 4))
  pickMonth.value = Number(current.value.slice(5, 7))
  pickerOpen.value = true
}

function confirmPicker() {
  pickerOpen.value = false
  // 选了上限年的越界月份（先选年再换月下拉不会出现，但 select 直接选会）→ 钳到上限
  const months = monthsOfYear(pickYear.value)
  const m = Math.min(pickMonth.value, months[months.length - 1])
  emitMonth(`${pickYear.value}-${String(m).padStart(2, '0')}`)
}

/** 派发月份变化：没变、超上限、早于年份下界都不发。 */
function emitMonth(month: string) {
  if (!month || month === current.value) return
  if (month > cap.value) return
  if (month < `${years.value[0]}-01`) return
  emit('change', month)
}

function prev() {
  emitMonth(addMonth(current.value, -1))
}
function next() {
  emitMonth(addMonth(current.value, 1))
}
function back() {
  emitMonth(shanghaiMonth())
}

// 换年后月份可能越界（比如停在 12 月再切到上限年），收敛到该年最后一个月
watch(pickYear, () => {
  const ms = monthsOfYear(pickYear.value)
  if (pickMonth.value > ms[ms.length - 1]) pickMonth.value = ms[ms.length - 1]
})
</script>

<template>
  <div class="month-nav">
    <div class="pill">
      <button class="nav" type="button" aria-label="上个月" :disabled="!canPrev" @click="prev">
        <i class="ico" aria-hidden="true"></i>
      </button>
      <button class="label" type="button" @click="openPicker">
        {{ label }}<i class="caret" aria-hidden="true"></i>
      </button>
      <button class="nav" type="button" aria-label="下个月" :disabled="!canNext" @click="next">
        <i class="ico ico-next" aria-hidden="true"></i>
      </button>
    </div>
    <button v-if="showBack" class="back" type="button" @click="back">回到本月</button>
  </div>

  <div v-if="pickerOpen" class="sheet-mask" @click="pickerOpen = false">
    <div class="sheet month-picker" @click.stop>
      <p class="add-title">选择年月</p>
      <div class="mp-row">
        <select v-model.number="pickYear" aria-label="年份">
          <option v-for="y in years" :key="y" :value="y">{{ y }}年</option>
        </select>
        <select v-model.number="pickMonth" aria-label="月份">
          <option v-for="m in pickMonths" :key="m" :value="m">{{ m }}月</option>
        </select>
      </div>
      <div class="mp-actions">
        <button class="btn ghost" type="button" @click="pickerOpen = false">取消</button>
        <button class="btn" type="button" @click="confirmPicker">确定</button>
      </div>
    </div>
  </div>
</template>
