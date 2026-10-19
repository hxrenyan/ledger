<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { api } from '../../tools/session.ts'

type CalendarKind = 'solar' | 'lunar'

const lunarMonths = ['正月', '二月', '三月', '四月', '五月', '六月', '七月', '八月', '九月', '十月', '冬月', '腊月']
const quickRelations = ['朋友', '同事', '亲戚', '同学', '家人', '邻居']

const route = useRoute()
const router = useRouter()
const isNew = computed(() => route.params.id === 'new')
const name = ref('')
const relation = ref('')
const archived = ref(false)
const tags = ref<string[]>([])
const dates = ref<DateDraft[]>([])
const editingIndex = ref<number | null>(null)
const selected = ref('')
const draft = ref('')
const naming = ref(false)
const addingTag = ref(false)
const draftInput = ref<HTMLInputElement | null>(null)
const calendar = ref<CalendarKind>('solar')
const month = ref(1)
const day = ref(1)
const year = ref('')
const leap = ref(false)
const error = ref('')
const saving = ref(false)
const loading = ref(false)
const DATE_LIMIT = 8

const activeLabel = computed(() => {
  if (naming.value && draft.value.trim()) return draft.value.trim()
  return selected.value.trim()
})
const showDateDetail = computed(() => Boolean(selected.value || naming.value))
const atLimit = computed(() => editingIndex.value == null && dates.value.length >= DATE_LIMIT)

const monthOptions = computed(() => {
  if (calendar.value === 'lunar') return lunarMonths.map((label, index) => ({ value: index + 1, label }))
  return Array.from({ length: 12 }, (_, index) => ({ value: index + 1, label: `${index + 1}月` }))
})

const dayOptions = computed(() => {
  const max = calendar.value === 'lunar' ? 30 : maxSolarDay(month.value)
  return Array.from({ length: max }, (_, index) => ({ value: index + 1, label: dayLabel(index + 1) }))
})

onMounted(async () => {
  loading.value = true
  try {
    await loadTags()
    if (isNew.value) return
    const body = await api<{ items: ContactRow[] }>('/api/v1/contacts')
    const found = (body.items || []).find((item) => String(item.id) === route.params.id)
    if (!found) {
      error.value = '联系人不存在'
      return
    }
    name.value = found.name
    relation.value = found.relation || ''
    archived.value = !!found.archived
    const loaded = found.dates?.length ? found.dates : found.date ? [found.date] : []
    dates.value = loaded.map((item, index) => draftFrom(item, index))
    for (const item of dates.value) {
      if (item.kind && !tags.value.includes(item.kind)) tags.value.unshift(item.kind)
    }
  } catch (err) {
    error.value = err instanceof Error ? err.message : '加载失败'
  } finally {
    loading.value = false
  }
})

async function loadTags() {
  const dict = await api<{ items: { name: string }[] }>('/api/v1/dicts?kind=contact_date')
  tags.value = (dict.items || []).map((item) => item.name)
}

function pickQuickRelation(rel: string) {
  relation.value = relation.value.trim() === rel ? '' : rel
}

function clearComposer() {
  selected.value = ''
  draft.value = ''
  naming.value = false
  editingIndex.value = null
  calendar.value = 'solar'
  month.value = 1
  day.value = 1
  year.value = ''
  leap.value = false
  error.value = ''
}

function draftFrom(item: ContactDateRow, index: number): DateDraft {
  return {
    key: `d-${item.id || index}`,
    kind: item.kind_label || item.kind,
    calendar: item.calendar,
    month: item.month,
    day: item.day,
    year: item.year ? String(item.year) : '',
    leap: !!item.leap,
  }
}

function summaryOf(item: DateDraft) {
  const cal = item.calendar === 'lunar' ? '农历' : '阳历'
  const monthText =
    item.calendar === 'lunar'
      ? `${item.leap ? '闰' : ''}${lunarMonths[item.month - 1] || ''}${dayLabelOf(item.day, 'lunar')}`
      : `${item.month}月${item.day}日`
  const yearText = item.year ? `${item.year}年` : ''
  return `${item.kind} · ${cal} ${yearText}${monthText}`
}

function dayLabelOf(value: number, kind: CalendarKind) {
  if (kind === 'solar') return `${value}日`
  const n = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十']
  if (value <= 10) return `初${n[value]}`
  if (value < 20) return `十${n[value - 10]}`
  if (value === 20) return '二十'
  if (value < 30) return `廿${n[value - 20]}`
  return '三十'
}

function currentDraft(): DateDraft | null {
  const label = activeLabel.value
  if (!label) return null
  return {
    key: editingIndex.value == null ? `new-${Date.now()}` : dates.value[editingIndex.value]?.key || `e-${editingIndex.value}`,
    kind: label,
    calendar: calendar.value,
    month: Number(month.value),
    day: Number(day.value),
    year: year.value.trim(),
    leap: calendar.value === 'lunar' && leap.value,
  }
}

function sameDate(a: DateDraft, b: DateDraft) {
  return (
    a.kind === b.kind &&
    a.calendar === b.calendar &&
    a.month === b.month &&
    a.day === b.day &&
    a.year === b.year &&
    a.leap === b.leap
  )
}

function applyComposer() {
  error.value = commitComposer()
}

function commitComposer() {
  const item = currentDraft()
  if (!item) return '请先选择或填写日子名称'
  const dup = dates.value.some((row, index) => index !== editingIndex.value && sameDate(row, item))
  if (dup) return '同一日子不能重复'
  if (editingIndex.value == null && dates.value.length >= DATE_LIMIT) return `日子最多 ${DATE_LIMIT} 个`
  if (editingIndex.value == null) dates.value.push(item)
  else dates.value.splice(editingIndex.value, 1, item)
  clearComposer()
  return ''
}

function editDate(index: number) {
  const item = dates.value[index]
  if (!item) return
  editingIndex.value = index
  selected.value = item.kind
  naming.value = false
  draft.value = ''
  calendar.value = item.calendar
  month.value = item.month
  day.value = item.day
  year.value = item.year
  leap.value = item.leap
  error.value = ''
}

function removeDate(index: number) {
  dates.value.splice(index, 1)
  if (editingIndex.value === index) clearComposer()
  else if (editingIndex.value != null && editingIndex.value > index) editingIndex.value -= 1
}

async function toggleNaming() {
  if (naming.value) {
    cancelNaming()
    return
  }
  naming.value = true
  error.value = ''
  await nextTick()
  draftInput.value?.focus()
}

function cancelNaming() {
  naming.value = false
  draft.value = ''
  error.value = ''
}

function maxSolarDay(value: number) {
  return [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][value - 1] || 31
}

function dayLabel(value: number) {
  return dayLabelOf(value, calendar.value)
}

function pickTag(label: string) {
  naming.value = false
  draft.value = ''
  selected.value = selected.value === label ? '' : label
  error.value = ''
}

async function addTag() {
  const label = draft.value.trim()
  if (!label || addingTag.value) return
  error.value = ''
  addingTag.value = true
  try {
    const saved = await api<{ name: string }>('/api/v1/dicts', {
      method: 'POST',
      body: JSON.stringify({ kind: 'contact_date', name: label }),
    })
    if (!tags.value.includes(saved.name)) tags.value.push(saved.name)
    selected.value = saved.name
    draft.value = ''
    naming.value = false
  } catch (err) {
    error.value = err instanceof Error ? err.message : '添加失败'
  } finally {
    addingTag.value = false
  }
}

function clampDay() {
  const max = dayOptions.value.length
  if (day.value > max) day.value = max
}

function pickCalendar(next: CalendarKind) {
  calendar.value = next
  if (next === 'solar') leap.value = false
  error.value = ''
  clampDay()
}

function goBack() {
  router.replace('/tools/contacts')
}

async function toggleArchive() {
  if (isNew.value || saving.value) return
  saving.value = true
  error.value = ''
  try {
    await api(`/api/v1/contacts/${route.params.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ archived: !archived.value }),
    })
    await router.replace('/tools/contacts')
  } catch (err) {
    error.value = err instanceof Error ? err.message : '操作失败'
  } finally {
    saving.value = false
  }
}

async function save() {
  error.value = ''
  if (!name.value.trim()) {
    error.value = '请填写姓名'
    return
  }
  if (naming.value && !draft.value.trim() && !selected.value.trim()) {
    error.value = '请填写日子名称，或点「取消」'
    draftInput.value?.focus()
    return
  }
  if (activeLabel.value) {
    const message = commitComposer()
    if (message) {
      error.value = message
      return
    }
  }
  const payloadDates = dates.value.map((item) => ({
    kind: item.kind,
    calendar: item.calendar,
    month: item.month,
    day: item.day,
    year: item.year.trim() ? Number(item.year.trim()) : null,
    leap: item.calendar === 'lunar' && item.leap,
  }))
  saving.value = true
  try {
    const payload = { name: name.value.trim(), relation: relation.value.trim(), dates: payloadDates }
    if (isNew.value) await api('/api/v1/contacts', { method: 'POST', body: JSON.stringify(payload) })
    else await api(`/api/v1/contacts/${route.params.id}`, { method: 'PATCH', body: JSON.stringify(payload) })
    await router.replace('/tools/contacts')
  } catch (err) {
    error.value = err instanceof Error ? err.message : '保存失败'
  } finally {
    saving.value = false
  }
}

type ContactDateRow = {
  id?: number
  kind: string
  kind_label: string
  calendar: CalendarKind
  month: number
  day: number
  year: number | null
  leap: boolean
}

type DateDraft = {
  key: string
  kind: string
  calendar: CalendarKind
  month: number
  day: number
  year: string
  leap: boolean
}

type ContactRow = {
  id: number
  name: string
  relation: string
  archived: boolean
  date: ContactDateRow | null
  dates?: ContactDateRow[]
}
</script>

<template>
  <div class="tools-head">
    <button class="btn ghost compact" type="button" @click="goBack">‹ 返回</button>
    <h1>{{ isNew ? '新增联系人' : '编辑联系人' }}</h1>
    <button
      v-if="!isNew"
      class="btn ghost compact"
      type="button"
      :disabled="saving"
      @click="toggleArchive"
    >
      {{ archived ? '恢复' : '归档' }}
    </button>
  </div>
  <p v-if="loading" class="muted">加载中…</p>
  <form v-else class="card" @submit.prevent="save">
    <label class="field">
      <span>姓名</span>
      <input v-model="name" maxlength="32" placeholder="1–32 个字" />
    </label>
    <div class="field">
      <div class="date-head">
        <span>关系</span>
        <small class="date-hint">可点选下方标签或自己填写</small>
      </div>
      <input v-model="relation" maxlength="16" placeholder="比如同事、亲戚，可以空着" />
      <div class="rel-tags">
        <button
          v-for="rel in quickRelations"
          :key="rel"
          type="button"
          class="rel-tag"
          :class="{ on: relation.trim() === rel }"
          @click="pickQuickRelation(rel)"
        >
          {{ rel }}
        </button>
      </div>
    </div>
    <div class="field">
      <div class="date-head">
        <span>日子</span>
        <small class="date-hint">最多 {{ DATE_LIMIT }} 个，比如生日和纪念日</small>
      </div>
      <div v-if="dates.length" class="date-list">
        <div v-for="(item, index) in dates" :key="item.key" class="date-item" :class="{ on: editingIndex === index }">
          <span>{{ summaryOf(item) }}</span>
          <button type="button" class="link" @click="editDate(index)">改</button>
          <button type="button" class="link danger" @click="removeDate(index)">删</button>
        </div>
      </div>
      <p v-else class="date-hint">还没有日子，在下面选一个名称就能加上</p>
      <div class="date-head">
        <span>{{ editingIndex == null ? '再加一个' : '修改这条' }}</span>
        <button v-if="showDateDetail || editingIndex != null" class="clear-btn" type="button" @click="clearComposer">取消</button>
      </div>
      <div class="tags">
        <button
          v-for="item in tags"
          :key="item"
          type="button"
          class="tag"
          :class="{ on: selected === item && !naming, used: dates.some((row) => row.kind === item) }"
          @click="pickTag(item)"
        >
          {{ item }}
        </button>
        <button
          type="button"
          class="tag tag-add"
          :class="{ on: naming }"
          @click="toggleNaming"
        >
          ＋ 自定义
        </button>
      </div>
      <div v-if="naming" class="custom-tag-row">
        <input
          ref="draftInput"
          v-model="draft"
          maxlength="16"
          placeholder="输入名称，如：生日、纪念日"
          @keydown.enter.prevent="addTag"
        />
        <button
          type="button"
          class="btn compact"
          :disabled="!draft.trim() || addingTag"
          @click="addTag"
        >
          {{ addingTag ? '添加中…' : '确定' }}
        </button>
        <button type="button" class="btn ghost compact" @click="cancelNaming">取消</button>
      </div>
    </div>
    <div v-if="showDateDetail" class="date-panel">
      <div class="field">
        <div class="cal-head">
          <span>历法</span>
          <button
            v-if="calendar === 'lunar'"
            type="button"
            class="leap-btn"
            :class="{ on: leap }"
            @click="leap = !leap"
          >
            {{ leap ? '✓ 闰月' : '闰月' }}
          </button>
        </div>
        <div class="seg">
          <button type="button" :class="{ on: calendar === 'solar' }" @click="pickCalendar('solar')">阳历</button>
          <button type="button" :class="{ on: calendar === 'lunar' }" @click="pickCalendar('lunar')">农历</button>
        </div>
      </div>
      <div class="date-row">
        <label class="field">
          <span>月</span>
          <select v-model.number="month" @change="clampDay">
            <option v-for="item in monthOptions" :key="item.value" :value="item.value">{{ item.label }}</option>
          </select>
        </label>
        <label class="field">
          <span>日</span>
          <select v-model.number="day">
            <option v-for="item in dayOptions" :key="item.value" :value="item.value">{{ item.label }}</option>
          </select>
        </label>
        <label class="field">
          <span>{{ activeLabel === '生日' ? '出生年' : '年份' }}</span>
          <input v-model="year" inputmode="numeric" maxlength="4" placeholder="可空" />
        </label>
      </div>
      <button class="btn ghost compact add-date" type="button" :disabled="atLimit && editingIndex == null" @click="applyComposer">
        {{ editingIndex == null ? '加入这个日子' : '保存这条' }}
      </button>
    </div>
    <p v-if="error" class="err">{{ error }}</p>
    <div class="form-actions">
      <button class="btn ghost" type="button" :disabled="saving" @click="goBack">取消</button>
      <button class="btn" type="submit" :disabled="saving">{{ saving ? '保存中…' : '保存' }}</button>
    </div>
  </form>
</template>

<style scoped>
.tools-head {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 16px;
}
.tools-head h1 { margin: 0; flex: 1; font-size: 20px; text-align: center; }
.tools-head .btn { width: auto; min-height: 36px; padding: 6px 12px; }
.date-head, .cal-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 22px;
}
.date-hint {
  color: var(--muted);
  font-size: 12px;
}
.clear-btn {
  width: auto;
  border: 0;
  background: transparent;
  color: var(--muted);
  font-size: 13px;
  font-weight: 500;
  padding: 2px 4px;
}
.rel-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 2px;
}
.rel-tag {
  width: auto;
  border: 1px solid var(--line);
  border-radius: 999px;
  padding: 4px 12px;
  background: #fff;
  color: var(--muted);
  font-size: 12px;
}
.rel-tag.on {
  border-color: var(--brand);
  background: #eef0ff;
  color: var(--brand);
  font-weight: 600;
}
.tags {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.tag {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: auto;
  border: 1px solid transparent;
  border-radius: 999px;
  min-height: 36px;
  padding: 6px 14px;
  background: #eef0f4;
  color: var(--text);
  font-size: 14px;
  font-weight: 500;
}
.tag.on {
  background: #eef0ff;
  border-color: var(--brand);
  color: var(--brand);
  font-weight: 600;
}
.tag-add {
  background: #fff;
  border: 1px dashed #c8cdd8;
  color: var(--muted);
}
.tag-add.on {
  border-style: solid;
  border-color: var(--brand);
  background: #eef0ff;
  color: var(--brand);
}
.custom-tag-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
}
.custom-tag-row input {
  flex: 1;
  min-width: 0;
}
.custom-tag-row .btn.compact {
  min-height: 44px;
  padding: 0 14px;
}
.date-list { display: flex; flex-direction: column; gap: 6px; margin: 8px 0; }
.date-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border-radius: 10px;
  background: #f6f7fb;
  font-size: 13px;
}
.date-item.on { background: #eef0ff; }
.date-item span { flex: 1; min-width: 0; }
.link {
  border: 0;
  background: transparent;
  color: var(--brand);
  font-weight: 600;
  padding: 0;
  width: auto;
}
.link.danger { color: var(--expense); }
.tag.used { box-shadow: inset 0 0 0 1px #d5daf0; }
.add-date { margin-top: 8px; }
.date-panel {
  margin-top: 4px;
  padding-top: 12px;
  border-top: 1px solid var(--line);
}
.seg {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px;
  padding: 4px;
  border-radius: 12px;
  background: #eef0f4;
}
.seg button {
  border: 0;
  border-radius: 9px;
  min-height: 36px;
  background: transparent;
  color: var(--muted);
  font-size: 14px;
  font-weight: 500;
}
.seg button.on {
  background: #fff;
  color: var(--brand);
  font-weight: 600;
  box-shadow: 0 1px 3px rgba(20, 20, 40, 0.08);
}
.leap-btn {
  width: auto;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: #fff;
  color: var(--muted);
  font-size: 12px;
  font-weight: 500;
  padding: 3px 10px;
  line-height: 1.4;
}
.leap-btn.on {
  border-color: var(--brand);
  background: #eef0ff;
  color: var(--brand);
  font-weight: 600;
}
.date-row {
  display: grid;
  grid-template-columns: 1fr 1fr 0.85fr;
  gap: 8px;
  margin-bottom: 4px;
}
.date-row .field { margin-bottom: 0; }
.form-actions {
  display: grid;
  grid-template-columns: 1fr 2fr;
  gap: 10px;
  margin-top: 16px;
}
.err { color: var(--expense); font-size: 13px; margin: 12px 0 0; }
</style>
