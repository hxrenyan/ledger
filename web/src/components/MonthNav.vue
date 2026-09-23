<script setup lang="ts">
/**
 * 月份切换条（药丸）：‹ 2026年9月 ▾ ›，与小程序 components/month-nav 同一套交互。
 *
 * 明细 / 预算 / 人情三页共用。中间的月份可点：弹出「年 / 月」双列滚轮，直接跳，
 * 不用一个月一个月点箭头。滚轮用 overflow + scroll-snap 实现：每项 40px、
 * 视口露出 5 项，滚停后取 Math.round(scrollTop / 40) 当选中项 —— 和小程序
 * picker 的取值口径一致（滚到哪格算哪格，不依赖任何「确认中的中间态」）。
 *
 * 属性
 *   month  当前月份 'YYYY-MM'（空 = 本月）
 *   max    可选的最后一个月 'YYYY-MM'（空 = 本月）。预算传「下个月」——
 *          它是唯一允许提前设预算的页面。
 * 事件
 *   change  detail 为月份字符串。月份没变不派发，免得页面白重拉数据。
 */
import { computed, nextTick, ref, watch } from 'vue'
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

// ---- 滚轮 -----------------------------------------------------------------
// 每项固定 40px，CSS 里 .mp-item 高度必须与它一致，否则取值会错位。
const ITEM_H = 40

const pickerOpen = ref(false)
const yearIdx = ref(0)
const monthIdx = ref(0)
const pickMonths = computed(() => monthsOfYear(years.value[yearIdx.value] ?? cap))

const yearEl = ref<HTMLElement | null>(null)
const monthEl = ref<HTMLElement | null>(null)

function openPicker() {
  yearIdx.value = Math.max(0, years.value.indexOf(Number(current.value.slice(0, 4))))
  const ms = monthsOfYear(years.value[yearIdx.value])
  monthIdx.value = Math.min(Number(current.value.slice(5, 7)) - 1, ms.length - 1)
  pickerOpen.value = true
  // 等滚轮渲染出来再定位：scrollTop 直接落在选中项上（顶部/底部各留了半个视口的空白）
  void nextTick(() => {
    if (yearEl.value) yearEl.value.scrollTop = yearIdx.value * ITEM_H
    if (monthEl.value) monthEl.value.scrollTop = monthIdx.value * ITEM_H
  })
}

/** 滚停取值：scrollTop → 最近的一格。滚动过程里会连发，算的是即时位置，无害。 */
function onScrollYear(e: Event) {
  const idx = Math.max(0, Math.min(years.value.length - 1, Math.round((e.target as HTMLElement).scrollTop / ITEM_H)))
  if (idx === yearIdx.value) return
  yearIdx.value = idx
  // 换年后月份列变短（上限年截断），旧下标可能越界 —— 滚轮同步归位，别停在不存在的一格
  const ms = monthsOfYear(years.value[idx])
  if (monthIdx.value > ms.length - 1) {
    monthIdx.value = ms.length - 1
    if (monthEl.value) monthEl.value.scrollTop = monthIdx.value * ITEM_H
  }
}

function onScrollMonth(e: Event) {
  const ms = pickMonths.value
  monthIdx.value = Math.max(0, Math.min(ms.length - 1, Math.round((e.target as HTMLElement).scrollTop / ITEM_H)))
}

/** 点某一格 = 平滑滚到那一格。 */
function scrollCol(el: HTMLElement | null, idx: number) {
  if (!el) return
  el.scrollTo({ top: idx * ITEM_H, behavior: 'smooth' })
}

function confirmPicker() {
  pickerOpen.value = false
  const year = years.value[yearIdx.value]
  const ms = monthsOfYear(year)
  const m = ms[Math.min(monthIdx.value, ms.length - 1)]
  emitMonth(`${year}-${String(m).padStart(2, '0')}`)
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
      <div class="mp-wheel">
        <div class="mp-band" aria-hidden="true"></div>
        <div ref="yearEl" class="mp-col" @scroll.passive="onScrollYear">
          <div class="mp-pad" aria-hidden="true"></div>
          <div
            v-for="(y, i) in years"
            :key="y"
            class="mp-item"
            :class="{ on: i === yearIdx }"
            @click="scrollCol(yearEl, i)"
          >{{ y }}年</div>
          <div class="mp-pad" aria-hidden="true"></div>
        </div>
        <div ref="monthEl" class="mp-col" @scroll.passive="onScrollMonth">
          <div class="mp-pad" aria-hidden="true"></div>
          <div
            v-for="(m, i) in pickMonths"
            :key="m"
            class="mp-item"
            :class="{ on: i === monthIdx }"
            @click="scrollCol(monthEl, i)"
          >{{ m }}月</div>
          <div class="mp-pad" aria-hidden="true"></div>
        </div>
      </div>
      <div class="mp-actions">
        <button class="btn ghost" type="button" @click="pickerOpen = false">取消</button>
        <button class="btn" type="button" @click="confirmPicker">确定</button>
      </div>
    </div>
  </div>
</template>
