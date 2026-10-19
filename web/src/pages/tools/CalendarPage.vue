<script setup lang="ts">
/**
 * 日历记录（H5）。与小程序 pages/tool-calendar 保持同一套三段式结构：
 * 1. 月历卡（顶部月份切换 + 回今天 + 展开/收起月历，展开时展示紧凑月历网格）
 * 2. 当天记事卡（前一天/日期/后一天 + 记一条按钮 → 紧接着输入框与当天记事列表，中间不再夹月历）
 * 3. 记事一览卡（默认展开，支持「本月全部 / 今起待办」一键切换、近一年关键词搜索，以及直接点记一条/编辑/删除）
 */
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { addDays, addMonth, daysInShanghaiMonth, shanghaiDate, shanghaiMonth } from '@server/time.ts'
import { api } from '../../tools/session.ts'

type Note = {
  id: number
  day: string
  body: string
  created_at: number
  updated_at: number
}

type Cell = {
  key: string
  blank: boolean
  day: number
  date: string
  count: number
  weekend: boolean
}

type DayGroup = {
  day: string
  label: string
  rel: string
  isToday: boolean
  items: Note[]
}

const WEEK = ['一', '二', '三', '四', '五', '六', '日']
const WEEK_FULL = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

/** 搜索时往前后各展开的月数，合起来不超过接口的一年上限。 */
const SEARCH_SPAN_MONTHS = 5

/** 月历开合状态存本地，下次进来保持上次的样子。默认展开。 */
const CAL_OPEN_KEY = 'calendar_cal_open'

function readCalOpen(): boolean {
  try {
    return window.localStorage.getItem(CAL_OPEN_KEY) !== '0'
  } catch {
    return true
  }
}

function monthBounds(value: string) {
  const days = daysInShanghaiMonth(value)
  return { from: `${value}-01`, to: `${value}-${String(days).padStart(2, '0')}` }
}

function searchBounds(value: string) {
  const start = addMonth(value, -SEARCH_SPAN_MONTHS)
  const end = addMonth(value, SEARCH_SPAN_MONTHS)
  return { from: `${start}-01`, to: monthBounds(end).to }
}

const router = useRouter()
const today = shanghaiDate()
const month = ref(shanghaiMonth())
const selected = ref(today)
const marks = ref<Record<string, number>>({})
const monthItems = ref<Note[]>([])
const dayFallbackItems = ref<Note[]>([])
const draft = ref('')
const q = ref('')
const listFilter = ref<'all' | 'upcoming'>('all')
const searchItems = ref<Note[]>([])
const listError = ref('')
const listOpen = ref(true)
const calOpen = ref(readCalOpen())
const editingId = ref<number | null>(null)
/** 本页刚保存、刷新结果里可能还没有的记事。 */
const freshNotes = new Map<number, Note>()
const error = ref('')
const loading = ref(true)
const saving = ref(false)
const adding = ref(false)
const monthInputRef = ref<HTMLInputElement | null>(null)
const dayCardRef = ref<HTMLElement | null>(null)
let editSession = 0
let ticket = 0
let searchTicket = 0
let searchKey = ''
let pendingKey = ''
let touchStartX = 0
let touchStartY = 0

const monthText = computed(() => {
  const [y, m] = month.value.split('-')
  return `${y}年${Number(m)}月`
})

const cells = computed<Cell[]>(() => grid(month.value, marks.value))

const items = computed<Note[]>(() => {
  if (selected.value.startsWith(month.value)) {
    const filtered = monthItems.value.filter((item) => item.day === selected.value)
    if (filtered.length || !dayFallbackItems.value.length) return filtered
  }
  return dayFallbackItems.value
})

const dayTitle = computed(() => dateLabelOf(selected.value))
const dayRel = computed(() => relativeLabelOf(selected.value, today))
const monthCount = computed(() => Object.values(marks.value).reduce((sum, n) => sum + n, 0))
const activeDaysCount = computed(() => Object.values(marks.value).filter((n) => n > 0).length)
const upcomingCount = computed(() => monthItems.value.filter((item) => item.day >= today).length)
const draftCount = computed(() => [...draft.value].length)
const canSave = computed(() => draft.value.trim().length > 0)
const showBack = computed(() => month.value !== shanghaiMonth() || selected.value !== today)

const searching = computed(() => q.value.trim().length > 0)
const scope = computed(() => searchBounds(month.value))

const groups = computed<DayGroup[]>(() => {
  const kw = q.value.trim().toLowerCase()
  const source = searching.value ? searchItems.value : monthItems.value
  const grouped = new Map<string, Note[]>()
  for (const item of source) {
    if (!searching.value && listFilter.value === 'upcoming' && item.day < today) continue
    if (kw && !item.body.toLowerCase().includes(kw) && !item.day.includes(kw)) continue
    const list = grouped.get(item.day) ?? []
    list.push(item)
    grouped.set(item.day, list)
  }
  return Array.from(grouped.entries()).map(([day, list]) => ({
    day,
    label: dateLabelOf(day),
    rel: relativeLabelOf(day, today),
    isToday: day === today,
    items: list,
  }))
})

onMounted(() => load())

// 刚输入关键词时拉一次跨月数据；之后继续打字只在本地过滤。
// 切月由 load() 负责重拉，不放进这里，免得同一次切月发两遍请求。
watch(searching, (on) => {
  if (!on) {
    listError.value = ''
    return
  }
  void loadSearch()
})

function grid(value: string, marked: Record<string, number>): Cell[] {
  const [y, m] = value.split('-').map(Number)
  const first = new Date(Date.UTC(y ?? 0, (m ?? 1) - 1, 1))
  const lead = (first.getUTCDay() + 6) % 7
  const total = new Date(Date.UTC(y ?? 0, m ?? 1, 0)).getUTCDate()
  const result: Cell[] = []
  for (let i = 0; i < lead; i += 1) {
    result.push({ key: `blank-${i}`, blank: true, day: 0, date: '', count: 0, weekend: false })
  }
  for (let d = 1; d <= total; d += 1) {
    const date = `${value}-${String(d).padStart(2, '0')}`
    const index = result.length
    result.push({
      key: date,
      blank: false,
      day: d,
      date,
      count: marked[date] || 0,
      weekend: index % 7 >= 5,
    })
  }
  return result
}

function dateLabelOf(date: string) {
  const [m, d] = date.split('-').slice(1).map(Number)
  const dt = new Date(Date.UTC(Number(date.slice(0, 4)), (m ?? 1) - 1, d ?? 1))
  return `${m}月${d}日 ${WEEK_FULL[dt.getUTCDay()]}`
}

function dayDiff(from: string, to: string): number {
  const [fy, fm, fd] = from.split('-').map(Number)
  const [ty, tm, td] = to.split('-').map(Number)
  const t1 = Date.UTC(fy ?? 0, (fm ?? 1) - 1, fd ?? 1)
  const t2 = Date.UTC(ty ?? 0, (tm ?? 1) - 1, td ?? 1)
  return Math.round((t2 - t1) / 86400000)
}

function relativeLabelOf(date: string, now: string): string {
  if (date === now) return '今天'
  if (date === addDays(now, -1)) return '昨天'
  if (date === addDays(now, 1)) return '明天'
  if (date === addDays(now, -2)) return '前天'
  if (date === addDays(now, 2)) return '后天'
  const diff = dayDiff(now, date)
  if (diff > 0 && diff <= 30) return `${diff}天后`
  if (diff < 0 && diff >= -30) return `${Math.abs(diff)}天前`
  return ''
}

function clock(ms: number) {
  const date = new Date(ms + 8 * 3600 * 1000)
  const hh = String(date.getUTCHours()).padStart(2, '0')
  const mm = String(date.getUTCMinutes()).padStart(2, '0')
  return `${hh}:${mm}`
}

function applyMonth(next: string, nextDay?: string, keepEditor = false) {
  if (!/^\d{4}-\d{2}$/.test(next)) return
  month.value = next
  if (nextDay && nextDay.startsWith(next)) {
    selected.value = nextDay
  } else if (!selected.value.startsWith(next)) {
    selected.value = next === shanghaiMonth() ? today : `${next}-01`
  }
  dayFallbackItems.value = []
  monthItems.value = []
  marks.value = {}
  if (!keepEditor) cancelEdit()
  void load()
}

function shiftMonth(delta: number) {
  applyMonth(addMonth(month.value, delta))
}

function onPickMonthInput(e: Event) {
  const val = (e.target as HTMLInputElement).value
  if (val && val !== month.value) applyMonth(val)
}

function openMonthPicker() {
  const el = monthInputRef.value
  if (!el) return
  if (typeof el.showPicker === 'function') {
    try {
      el.showPicker()
      return
    } catch {
      // 浏览器不允许时退回点击
    }
  }
  el.focus()
  el.click()
}

function backToday() {
  const currentMonth = shanghaiMonth()
  if (month.value === currentMonth) {
    pick(today)
    return
  }
  applyMonth(currentMonth, today)
}

function pick(date: string, keepEditor = false) {
  if (!date) return
  const targetMonth = date.slice(0, 7)
  if (targetMonth !== month.value) {
    applyMonth(targetMonth, date, keepEditor)
    return
  }
  if (date === selected.value) {
    if (!keepEditor) error.value = ''
    return
  }
  selected.value = date
  dayFallbackItems.value = []
  if (!keepEditor) cancelEdit()
  error.value = ''
}

function scrollToDayCard() {
  void nextTick(() => {
    dayCardRef.value?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  })
}

/** 一览里点某天：切过去并把当天记事卡滚进视野。 */
function jumpDay(date: string) {
  pick(date)
  scrollToDayCard()
}

/** 一览里点某天的「＋记一条」：切到那天并直接打开新增输入框。 */
function jumpAdd(date: string) {
  pick(date, true)
  editSession += 1
  adding.value = true
  editingId.value = null
  draft.value = ''
  error.value = ''
  scrollToDayCard()
  focusDraft()
}

/** 一览里点某条的「编辑」：切到那天并直接就地编辑这条。 */
function jumpEdit(item: Note) {
  pick(item.day, true)
  editSession += 1
  adding.value = false
  editingId.value = item.id
  draft.value = item.body
  error.value = ''
  scrollToDayCard()
  focusDraft()
}

function stepDay(delta: number) {
  pick(addDays(selected.value, delta))
}

function onCalTouchStart(e: TouchEvent) {
  const t = e.touches?.[0]
  if (!t) return
  touchStartX = t.clientX
  touchStartY = t.clientY
}

function onCalTouchEnd(e: TouchEvent) {
  const t = e.changedTouches?.[0]
  if (!t) return
  const dx = t.clientX - touchStartX
  const dy = t.clientY - touchStartY
  if (Math.abs(dx) < 50 || Math.abs(dx) <= Math.abs(dy) * 1.2) return
  shiftMonth(dx < 0 ? 1 : -1)
}

async function load(preserveError = false) {
  const current = ++ticket
  const editor = editSession
  const monthValue = month.value
  const dayValue = selected.value
  loading.value = true
  if (!preserveError) error.value = ''
  try {
    const monthBody = await api<{
      days: { day: string; count: number }[]
      items?: Note[]
    }>(`/api/v1/day-notes?month=${monthValue}`)
    if (current !== ticket) return
    const next: Record<string, number> = {}
    for (const row of monthBody.days || []) next[row.day] = row.count
    marks.value = next
    if (Array.isArray(monthBody.items)) {
      const seen = new Set(monthBody.items.map((item) => item.id))
      const merged = monthBody.items.slice()
      for (const note of freshNotes.values()) {
        if (seen.has(note.id) || !note.day.startsWith(monthValue)) continue
        merged.push(note)
        next[note.day] = (next[note.day] || 0) + 1
      }
      monthItems.value = merged
      marks.value = next
      dayFallbackItems.value = []
    } else {
      const dayBody = await api<{ items: Note[] }>(`/api/v1/day-notes?day=${dayValue}`)
      if (current !== ticket) return
      monthItems.value = dayBody.items || []
      dayFallbackItems.value = dayBody.items || []
    }
    // 当月数据变了，缓存的搜索结果跟着失效。
    searchKey = ''
    pendingKey = ''
    if (searching.value) await loadSearch()
  } catch (err) {
    if (current !== ticket) return
    if (editor === editSession && (!preserveError || !error.value)) {
      error.value = err instanceof Error ? err.message : '加载失败'
    }
  } finally {
    if (current === ticket) loading.value = false
  }
}

async function loadSearch() {
  const { from, to } = scope.value
  const key = `${from}~${to}`
  // 同一范围只拉一次，已有结果或请求在途都直接复用。
  if (key === searchKey || key === pendingKey) return
  const current = ++searchTicket
  pendingKey = key
  try {
    const body = await api<{ items?: Note[] }>(`/api/v1/day-notes?from=${from}&to=${to}`)
    if (current !== searchTicket) return
    pendingKey = ''
    searchKey = key
    searchItems.value = body.items || []
    listError.value = ''
  } catch (err) {
    if (current !== searchTicket) return
    pendingKey = ''
    listError.value = err instanceof Error ? err.message : '加载失败'
  }
}

function toggleCal() {
  calOpen.value = !calOpen.value
  try {
    window.localStorage.setItem(CAL_OPEN_KEY, calOpen.value ? '1' : '0')
  } catch {
    // 存不上不影响这次使用
  }
}

function setFilter(next: 'all' | 'upcoming') {
  listFilter.value = next
  if (!listOpen.value) listOpen.value = true
}

function focusDraft() {
  void nextTick(() => {
    const card = dayCardRef.value
    const el = card?.querySelector('textarea')
    const foot = card?.querySelector('.editor-foot')
    if (el instanceof HTMLTextAreaElement) el.focus()
    foot?.scrollIntoView({ block: 'nearest' })
  })
}

/** 当天卡片上的「＋记一条」：再点一次收起输入框。 */
function startAdd() {
  if (adding.value) {
    cancelEdit()
    return
  }
  editSession += 1
  adding.value = true
  editingId.value = null
  draft.value = ''
  error.value = ''
  focusDraft()
}

function startEdit(item: Note) {
  editSession += 1
  adding.value = false
  editingId.value = item.id
  draft.value = item.body
  error.value = ''
  focusDraft()
}

function cancelEdit() {
  editSession += 1
  editingId.value = null
  adding.value = false
  draft.value = ''
}

function onKeydown(e: KeyboardEvent) {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
    e.preventDefault()
    void save()
  } else if (e.key === 'Escape' && (editingId.value != null || adding.value)) {
    e.preventDefault()
    cancelEdit()
  }
}

async function save() {
  const text = draft.value.trim()
  if (!text || [...text].length > 200) {
    error.value = '正文须为 1–200 字'
    return
  }
  if (saving.value) return
  saving.value = true
  error.value = ''
  const editor = editSession
  const submittedDraft = draft.value
  const id = editingId.value
  try {
    const saved = await api<Note>(id == null ? '/api/v1/day-notes' : `/api/v1/day-notes/${id}`, {
      method: id == null ? 'POST' : 'PATCH',
      body: JSON.stringify(id == null ? { day: selected.value, body: text } : { body: text }),
    })
    freshNotes.set(saved.id, saved)
    monthItems.value = [...monthItems.value.filter((item) => item.id !== saved.id), saved]
    if (editor === editSession) {
      if (draft.value === submittedDraft) {
        cancelEdit()
      } else if (id == null) {
        // 等待期间继续写的内容仍属于这条记事，后续保存应修改刚创建的记录。
        adding.value = false
        editingId.value = saved.id
      }
    }
    // 只刷新列表，不能让旧提交覆盖另一个编辑会话的提示。
    await load(true)
  } catch (err) {
    if (editor === editSession) error.value = err instanceof Error ? err.message : '保存失败'
  } finally {
    saving.value = false
  }
}

async function remove(item: Note) {
  if (!window.confirm('删除这条记事？')) return
  error.value = ''
  try {
    await api(`/api/v1/day-notes/${item.id}`, { method: 'DELETE' })
    freshNotes.delete(item.id)
    if (editingId.value === item.id) cancelEdit()
    await load()
  } catch (err) {
    error.value = err instanceof Error ? err.message : '删除失败'
  }
}
</script>

<template>
  <div class="tools-head">
    <button class="btn ghost compact" type="button" @click="router.push('/tools')">‹ 工具</button>
    <h1>日历记录</h1>
    <span class="head-slot"></span>
  </div>

  <!-- 1. 月历卡：顶部固定月份切换 + 回今天 + 收起/展开月历；不再夹在当天标题与记事之间 -->
  <div
    class="card cal-card"
    @touchstart.passive="onCalTouchStart"
    @touchend.passive="onCalTouchEnd"
  >
    <div class="cal-top">
      <div class="cal-bar">
        <button class="nav" type="button" aria-label="上个月" @click="shiftMonth(-1)">
          <span class="ico"></span>
        </button>
        <button class="label" type="button" @click="openMonthPicker">
          <span>{{ monthText }}</span>
          <span class="bar-caret"></span>
          <input
            ref="monthInputRef"
            class="month-native-input"
            type="month"
            :value="month"
            tabindex="-1"
            aria-label="选择年月"
            @change="onPickMonthInput"
          />
        </button>
        <button class="nav" type="button" aria-label="下个月" @click="shiftMonth(1)">
          <span class="ico ico-next"></span>
        </button>
      </div>

      <div class="cal-actions">
        <button v-if="showBack" type="button" class="pill-btn today-btn" @click="backToday">
          回今天
        </button>
        <button type="button" class="pill-btn fold-btn" @click="toggleCal">
          <span>{{ calOpen ? '收起日历' : '展开日历' }}</span>
          <span class="caret" :class="{ open: calOpen }"></span>
        </button>
      </div>
    </div>

    <div v-if="calOpen" class="cal">
      <div
        v-for="(name, idx) in WEEK"
        :key="name"
        class="cal-w"
        :class="{ end: idx >= 5 }"
      >
        {{ name }}
      </div>
      <template v-for="cell in cells" :key="cell.key">
        <span v-if="cell.blank" class="cal-blank"></span>
        <button
          v-else
          type="button"
          class="cal-d"
          :class="{
            has: cell.count > 0,
            on: cell.date === selected,
            today: cell.date === today,
            weekend: cell.weekend,
          }"
          @click="pick(cell.date)"
        >
          <span class="num">{{ cell.day }}</span>
          <span class="mark">
            <span v-if="cell.count > 1" class="cnt">{{ cell.count }}</span>
            <span v-else-if="cell.count === 1" class="dot"></span>
          </span>
        </button>
      </template>
    </div>
  </div>

  <!-- 2. 当天记事卡：日期切换、记一条按钮、输入框和当天记事紧挨在一起 -->
  <div ref="dayCardRef" class="card day-card">
    <div class="day-bar">
      <div class="day-nav">
        <button type="button" class="step-btn" title="前一天" aria-label="前一天" @click="stepDay(-1)">
          <span class="ico"></span>
        </button>
        <div class="day-info">
          <div class="day-title-row">
            <strong class="day-title">{{ dayTitle }}</strong>
            <span v-if="dayRel" class="rel-tag" :class="{ today: selected === today }">{{ dayRel }}</span>
          </div>
          <span class="day-sub">
            {{ items.length ? `当天 ${items.length} 条记事` : '当天暂无记事' }}
          </span>
        </div>
        <button type="button" class="step-btn" title="后一天" aria-label="后一天" @click="stepDay(1)">
          <span class="ico ico-next"></span>
        </button>
      </div>

      <button type="button" class="add-btn" :class="{ on: adding }" @click="startAdd">
        <span class="add-mark">{{ adding ? '×' : '＋' }}</span>
        <span>{{ adding ? '收起' : '记一条' }}</span>
      </button>
    </div>

    <p v-if="error" class="err">{{ error }}</p>

    <div v-if="adding" class="editor">
      <textarea
        v-model="draft"
        maxlength="200"
        rows="2"
        placeholder="记下这天要办的事（如：下午三点取快递、交水电费）…"
        @keydown="onKeydown"
      ></textarea>
      <div class="editor-foot">
        <span class="muted" :class="{ over: draftCount >= 200 }">{{ draftCount }}/200</span>
        <div class="btns">
          <button type="button" class="act-btn" @click="cancelEdit">取消</button>
          <button type="button" class="act-btn primary" :disabled="saving || !canSave" @pointerdown.prevent="save">
            {{ saving ? '保存中…' : '记下' }}
          </button>
        </div>
      </div>
    </div>

    <p v-if="loading && !items.length" class="day-hint">加载中…</p>
    <button
      v-else-if="!items.length && !adding"
      type="button"
      class="day-empty-btn"
      @click="startAdd"
    >
      这天还没有记事，点此记一条 ＋
    </button>

    <div v-if="items.length" class="note-list">
      <div v-for="item in items" :key="item.id" class="note" :class="{ on: editingId === item.id }">
        <div v-if="editingId === item.id" class="editor inline">
          <textarea v-model="draft" maxlength="200" rows="2" @keydown="onKeydown"></textarea>
          <div class="editor-foot">
            <span class="muted" :class="{ over: draftCount >= 200 }">{{ draftCount }}/200</span>
            <div class="btns">
              <button type="button" class="act-btn" @click="cancelEdit">取消</button>
              <button type="button" class="act-btn primary" :disabled="saving || !canSave" @pointerdown.prevent="save">
                {{ saving ? '保存中…' : '保存' }}
              </button>
            </div>
          </div>
        </div>
        <template v-else>
          <p class="note-body">{{ item.body }}</p>
          <div class="note-meta">
            <span class="muted">
              {{ clock(item.created_at) }}
              <template v-if="item.updated_at > item.created_at"> · 已编辑</template>
            </span>
            <div class="btns">
              <button type="button" class="act-btn" @click="startEdit(item)">编辑</button>
              <button type="button" class="act-btn danger" @click="remove(item)">删除</button>
            </div>
          </div>
        </template>
      </div>
    </div>
  </div>

  <!-- 3. 记事一览：默认展开，支持全部/待办切换、跨月搜索，以及直接在列表里操作 -->
  <div class="card list-card">
    <div class="lc-top">
      <button type="button" class="lc-head" @click="listOpen = !listOpen">
        <span class="lc-title-wrap">
          <strong class="lc-title">记事一览</strong>
          <span class="lc-sub">{{ monthCount }} 条 · {{ activeDaysCount }} 天</span>
        </span>
        <span class="caret" :class="{ open: listOpen }"></span>
      </button>

      <div v-if="!searching" class="lc-tabs">
        <button
          type="button"
          class="lc-tab"
          :class="{ on: listFilter === 'all' }"
          @click="setFilter('all')"
        >
          本月 {{ monthCount }}
        </button>
        <button
          type="button"
          class="lc-tab"
          :class="{ on: listFilter === 'upcoming' }"
          @click="setFilter('upcoming')"
        >
          今起 {{ upcomingCount }}
        </button>
      </div>
    </div>

    <template v-if="listOpen">
      <div class="lc-search">
        <input v-model="q" type="search" placeholder="搜索记事（输入关键词自动查近一年）" />
        <button v-if="q" type="button" class="clear-x" @click="q = ''">×</button>
      </div>

      <p v-if="searching" class="lc-scope">搜索范围 {{ scope.from }} 至 {{ scope.to }}</p>
      <p v-if="listError" class="err">{{ listError }}</p>

      <p v-if="!groups.length" class="empty">
        {{
          searching
            ? '没有匹配的记事'
            : listFilter === 'upcoming'
              ? '今天及之后还没有安排'
              : '这个月还没有记事'
        }}
      </p>

      <div v-else class="lc-groups">
        <div
          v-for="group in groups"
          :key="group.day"
          class="lc-group"
          :class="{ on: group.day === selected }"
        >
          <div class="lc-day-head" @click="jumpDay(group.day)">
            <div class="lc-day-title">
              <strong>{{ group.label }}</strong>
              <span v-if="group.rel" class="lc-rel" :class="{ today: group.isToday }">{{ group.rel }}</span>
              <span class="lc-cnt">{{ group.items.length }} 条</span>
            </div>
            <button type="button" class="lc-add-btn" @click.stop="jumpAdd(group.day)">
              ＋ 记一条
            </button>
          </div>
          <div class="lc-items">
            <div v-for="note in group.items" :key="note.id" class="lc-item">
              <div class="lc-item-main" @click="jumpDay(group.day)">
                <span class="lc-dot"></span>
                <span class="lc-text">{{ note.body }}</span>
              </div>
              <div class="lc-item-right">
                <span class="lc-time">{{ clock(note.created_at) }}</span>
                <button type="button" class="lc-link" @click.stop="jumpEdit(note)">编辑</button>
                <button type="button" class="lc-link danger" @click.stop="remove(note)">删除</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.tools-head {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
}
.tools-head h1 {
  margin: 0;
  flex: 1;
  font-size: 20px;
  text-align: center;
}
.tools-head .btn {
  width: auto;
  min-height: 36px;
  padding: 6px 12px;
}
.head-slot {
  width: 72px;
  flex: none;
}

/* 1. 月历卡 */
.cal-card {
  padding: 12px 14px;
}
.cal-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.cal-bar {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  background: #f4f5f8;
  border-radius: 999px;
  padding: 2px;
}
.nav {
  flex: none;
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 0;
  background: transparent;
  border-radius: 999px;
}
.nav:hover {
  background: #e6e8f0;
}
.ico {
  width: 8px;
  height: 8px;
  border-left: 2px solid var(--muted);
  border-bottom: 2px solid var(--muted);
  transform: rotate(45deg);
}
.ico-next {
  transform: rotate(-135deg);
}
.label {
  position: relative;
  overflow: hidden;
  height: 32px;
  padding: 0 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  border: 0;
  background: transparent;
  border-radius: 999px;
  font-size: 14px;
  font-weight: 650;
  color: inherit;
}
.label:hover {
  background: #e6e8f0;
}
.bar-caret {
  width: 0;
  height: 0;
  border-left: 4px solid transparent;
  border-right: 4px solid transparent;
  border-top: 5px solid var(--muted);
}
.month-native-input {
  position: absolute;
  inset: 0;
  opacity: 0;
  width: 100%;
  height: 100%;
  border: 0;
  padding: 0;
  cursor: pointer;
}
.cal-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}
.pill-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 32px;
  padding: 0 11px;
  border-radius: 999px;
  border: 1px solid var(--line);
  background: #fff;
  color: var(--text);
  font-size: 12px;
  font-weight: 600;
}
.pill-btn:hover {
  background: #f4f5f8;
}
.today-btn {
  border-color: #ccd3ef;
  color: var(--brand);
  background: #f6f8ff;
}
.caret {
  flex: none;
  width: 0;
  height: 0;
  border-left: 4px solid transparent;
  border-right: 4px solid transparent;
  border-top: 5px solid var(--muted);
  transition: transform 0.15s;
}
.caret.open {
  transform: rotate(180deg);
}

/* 月历网格：紧凑高度，一屏能同时看到月历与下方当天记事 */
.cal {
  padding: 8px 0 2px;
  gap: 3px;
}
.cal-w {
  color: var(--muted);
  font-size: 12px;
  font-weight: 500;
  padding: 2px 0 4px;
}
.cal-w.end {
  color: #b0b3bd;
}
.cal-blank {
  min-height: 40px;
}
.cal-d {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  min-height: 40px;
  padding: 3px 2px;
  border-radius: 10px;
  transition: background 0.12s, color 0.12s;
}
.cal-d:active {
  background: #f2f4fa;
}
.cal-d.weekend:not(.on):not(.has) {
  color: #8f95a3;
}
.cal-d.has:not(.on) {
  color: var(--brand);
  font-weight: 600;
}
.cal-d.today:not(.on) {
  box-shadow: inset 0 0 0 1.5px var(--brand);
}
.cal-d.on {
  background: var(--brand);
  color: #fff;
  box-shadow: 0 3px 10px rgba(59, 91, 219, 0.24);
}
.num {
  font-size: 14px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  line-height: 1.1;
}
.mark {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 11px;
}
.cnt {
  font-size: 10px;
  line-height: 11px;
  min-width: 14px;
  padding: 0 3px;
  border-radius: 999px;
  background: rgba(59, 91, 219, 0.14);
  color: var(--brand);
  font-weight: 700;
}
.dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--brand);
}
.cal-d.on .cnt {
  background: rgba(255, 255, 255, 0.28);
  color: #fff;
}
.cal-d.on .dot {
  background: #fff;
}

/* 2. 当天记事卡 */
.day-card {
  margin-top: 10px;
  padding: 14px;
  scroll-margin-top: 12px;
}
.day-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--line);
  margin-bottom: 12px;
}
.day-nav {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  flex: 1;
}
.step-btn {
  flex: none;
  width: 34px;
  height: 34px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: 10px;
  background: #f4f5f8;
}
.step-btn:hover {
  background: #e6e8f0;
}
.day-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.day-title-row {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.day-title {
  font-size: 16px;
  font-weight: 650;
  line-height: 1.2;
}
.day-sub {
  font-size: 12px;
  color: var(--muted);
}
.rel-tag {
  padding: 2px 7px;
  border-radius: 999px;
  background: #f0f2f7;
  color: var(--muted);
  font-size: 11px;
  font-weight: 600;
}
.rel-tag.today {
  background: #eef0ff;
  color: var(--brand);
}
.add-btn {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  height: 36px;
  padding: 0 14px;
  border: 0;
  border-radius: 999px;
  background: var(--brand);
  color: #fff;
  font-size: 13px;
  font-weight: 600;
  line-height: 1;
  white-space: nowrap;
}
.add-btn.on {
  background: #eef0ff;
  color: var(--brand);
}
.add-mark {
  font-size: 16px;
  line-height: 1;
}

.day-hint {
  margin: 0;
  padding: 14px 12px;
  border-radius: 12px;
  background: #f8f9fc;
  color: var(--muted);
  font-size: 13px;
  text-align: center;
}
.day-empty-btn {
  width: 100%;
  padding: 14px 12px;
  border-radius: 12px;
  border: 1px dashed #d5d9e8;
  background: #f9fafe;
  color: var(--brand);
  font-size: 13px;
  font-weight: 500;
  text-align: center;
}
.day-empty-btn:hover {
  background: #eef0ff;
}

/* 记事列表 */
.note-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.note {
  padding: 12px;
  border-radius: 12px;
  background: #f6f7fb;
  border: 1px solid transparent;
}
.note.on {
  background: #eef0ff;
  border-color: var(--brand);
}
.note-body {
  margin: 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  line-height: 1.55;
  font-size: 14px;
}
.note-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-top: 8px;
}
.btns {
  display: flex;
  align-items: center;
  gap: 6px;
}
.act-btn {
  border: 1px solid #e3e6f0;
  border-radius: 999px;
  padding: 5px 12px;
  min-height: 28px;
  font-size: 12px;
  font-weight: 600;
  background: #fff;
  color: var(--text);
}
.act-btn:hover {
  background: #f0f2f8;
}
.act-btn.primary {
  border-color: var(--brand);
  background: var(--brand);
  color: #fff;
}
.act-btn.danger {
  color: var(--expense);
  border-color: #f5d0d2;
}
.act-btn:disabled {
  opacity: 0.45;
}

/* 编辑器 */
.editor {
  padding: 10px 12px;
  margin-bottom: 10px;
  border: 1px solid var(--brand);
  border-radius: 12px;
  background: #eef0ff;
}
.editor.inline {
  margin: 0;
  padding: 0;
  border: 0;
  background: transparent;
}
.editor textarea {
  width: 100%;
  margin: 0;
  padding: 0;
  border: 0;
  background: transparent;
  resize: vertical;
  line-height: 1.5;
  font-size: 14px;
}
.editor textarea:focus {
  outline: none;
}
.editor-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-top: 8px;
  scroll-margin-bottom: 40vh;
}
.over {
  color: var(--expense);
}

/* 3. 记事一览卡 */
.list-card {
  margin-top: 10px;
  padding: 14px;
}
.lc-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.lc-head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
  min-width: 0;
  padding: 0;
  border: 0;
  background: transparent;
  text-align: left;
  color: inherit;
}
.lc-title-wrap {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}
.lc-title {
  font-size: 15px;
  font-weight: 650;
}
.lc-sub {
  font-size: 12px;
  color: var(--muted);
}
.lc-tabs {
  display: inline-flex;
  background: #f2f4f8;
  border-radius: 999px;
  padding: 2px;
  gap: 2px;
}
.lc-tab {
  border: 0;
  background: transparent;
  border-radius: 999px;
  padding: 4px 10px;
  font-size: 12px;
  font-weight: 600;
  color: var(--muted);
}
.lc-tab.on {
  background: #fff;
  color: var(--brand);
  box-shadow: 0 1px 4px rgba(20, 20, 40, 0.06);
}
.lc-search {
  display: flex;
  align-items: center;
  background: #f4f5f8;
  border-radius: 999px;
  padding: 0 12px;
  height: 36px;
  margin-top: 10px;
}
.lc-search input {
  flex: 1;
  min-width: 0;
  border: 0;
  background: transparent;
  font-size: 13px;
  outline: none;
}
.clear-x {
  border: 0;
  background: #e2e5ee;
  color: var(--muted);
  width: 20px;
  height: 20px;
  border-radius: 10px;
  font-size: 14px;
  line-height: 18px;
  padding: 0;
}
.lc-scope {
  margin: 6px 0 0;
  color: var(--muted);
  font-size: 11px;
}
.lc-groups {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 10px;
}
.lc-group {
  padding: 10px 12px;
  border-radius: 12px;
  background: #f8f9fc;
  border: 1px solid transparent;
}
.lc-group.on {
  background: #f3f6ff;
  border-color: #cdd8ff;
}
.lc-day-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding-bottom: 6px;
  border-bottom: 1px solid #eceef5;
  margin-bottom: 6px;
  cursor: pointer;
}
.lc-day-title {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  font-size: 13px;
}
.lc-rel {
  padding: 1px 6px;
  border-radius: 999px;
  background: #eceef5;
  color: var(--muted);
  font-size: 11px;
}
.lc-rel.today {
  background: #eef0ff;
  color: var(--brand);
  font-weight: 600;
}
.lc-cnt {
  font-size: 11px;
  color: var(--muted);
}
.lc-add-btn {
  border: 0;
  background: #eef0ff;
  color: var(--brand);
  border-radius: 999px;
  padding: 3px 9px;
  font-size: 11px;
  font-weight: 600;
}
.lc-add-btn:hover {
  background: #dfe4ff;
}
.lc-items {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.lc-item {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
  font-size: 13px;
  line-height: 1.45;
}
.lc-item-main {
  display: flex;
  align-items: baseline;
  gap: 6px;
  flex: 1;
  min-width: 0;
  cursor: pointer;
}
.lc-dot {
  flex: none;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--brand);
  transform: translateY(-2px);
}
.lc-text {
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
}
.lc-item-right {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: none;
}
.lc-time {
  font-size: 11px;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}
.lc-link {
  border: 0;
  background: #fff;
  border-radius: 999px;
  padding: 2px 8px;
  font-size: 11px;
  font-weight: 600;
  color: var(--text);
  border: 1px solid #e5e7f0;
}
.lc-link.danger {
  color: var(--expense);
  border-color: #f5d0d2;
}

.empty {
  margin: 12px 0 2px;
  color: var(--muted);
  font-size: 13px;
  text-align: center;
}
.err {
  color: var(--expense);
  margin: 0 0 8px;
}
</style>
