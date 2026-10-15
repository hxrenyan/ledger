<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { centsToYuan } from '@server/money.ts'
import { api, inMiniProgram, openFavorPerson } from '../../tools/session.ts'

type Contact = {
  id: number
  name: string
  relation: string
  archived: boolean
  given_cents: number
  received_cents: number
  net_cents: number
  date: { label: string; kind_label: string } | null
  reminder: { text: string; age_text: string } | null
}

type FilterKind = 'all' | 'date' | 'upcoming' | 'archived'

const router = useRouter()
const allItems = ref<Contact[]>([])
const q = ref('')
const filter = ref<FilterKind>('all')
const relationFilter = ref('')
const error = ref('')
const loading = ref(true)
const busyId = ref<number | null>(null)
const showRecords = inMiniProgram()

onMounted(load)

async function load() {
  loading.value = true
  error.value = ''
  try {
    const body = await api<{ items: Contact[] }>('/api/v1/contacts')
    allItems.value = body.items || []
  } catch (err) {
    error.value = err instanceof Error ? err.message : '加载失败'
  } finally {
    loading.value = false
  }
}

const activeItems = computed(() => allItems.value.filter((item) => !item.archived))
const archivedCount = computed(() => allItems.value.filter((item) => item.archived).length)
const withDateCount = computed(() => activeItems.value.filter((item) => Boolean(item.date)).length)

function isUpcoming(item: Contact) {
  const txt = item.reminder?.text || ''
  return txt === '今天' || txt.startsWith('还剩')
}

function upcomingRank(item: Contact) {
  const txt = item.reminder?.text || ''
  if (txt === '今天') return 0
  const m = txt.match(/还剩\s*(\d+)\s*天/)
  return m ? Number(m[1]) : 999
}

const upcomingItems = computed(() =>
  activeItems.value
    .filter(isUpcoming)
    .slice()
    .sort((a, b) => upcomingRank(a) - upcomingRank(b)),
)

const relations = computed(() => {
  const set = new Set<string>()
  for (const item of activeItems.value) {
    if (item.relation && item.relation.trim()) set.add(item.relation.trim())
  }
  return Array.from(set)
})

const filteredItems = computed(() => {
  const kw = q.value.trim().toLowerCase()
  const base =
    filter.value === 'archived'
      ? allItems.value.filter((item) => item.archived)
      : filter.value === 'date'
        ? activeItems.value.filter((item) => Boolean(item.date))
        : filter.value === 'upcoming'
          ? upcomingItems.value
          : activeItems.value

  return base.filter((item) => {
    if (relationFilter.value && filter.value !== 'archived' && item.relation !== relationFilter.value) {
      return false
    }
    if (!kw) return true
    const hay = [
      item.name,
      item.relation || '',
      item.date?.kind_label || '',
      item.date?.label || '',
    ]
      .join(' ')
      .toLowerCase()
    return hay.includes(kw)
  })
})

function setFilter(next: FilterKind) {
  filter.value = next
  if (next === 'archived') relationFilter.value = ''
}

function toggleRelation(rel: string) {
  relationFilter.value = relationFilter.value === rel ? '' : rel
}

function resetFilters() {
  q.value = ''
  filter.value = 'all'
  relationFilter.value = ''
}

function initialOf(name: string) {
  return (name || '?').trim().slice(0, 1) || '?'
}

async function openRecords(id: number) {
  try {
    await openFavorPerson(id)
  } catch (err) {
    error.value = err instanceof Error ? err.message : '打不开往来'
  }
}

async function toggleArchive(item: Contact) {
  if (busyId.value != null) return
  busyId.value = item.id
  error.value = ''
  try {
    await api(`/api/v1/contacts/${item.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ archived: !item.archived }),
    })
    await load()
  } catch (err) {
    error.value = err instanceof Error ? err.message : '操作失败'
  } finally {
    busyId.value = null
  }
}

function hasGifts(item: Contact) {
  return (item.given_cents || 0) > 0 || (item.received_cents || 0) > 0
}

function netLabel(item: Contact) {
  const net = (item.received_cents || 0) - (item.given_cents || 0)
  if (net === 0) return '收支持平'
  return net > 0 ? `净收 ¥${centsToYuan(net)}` : `净送 ¥${centsToYuan(Math.abs(net))}`
}

function netClass(item: Contact) {
  const net = (item.received_cents || 0) - (item.given_cents || 0)
  if (net > 0) return 'income'
  if (net < 0) return 'expense'
  return 'muted'
}
</script>

<template>
  <!-- 顶栏：左侧返回工具，中间标题，右侧直接新建 -->
  <div class="tools-head">
    <button class="btn ghost compact" type="button" @click="router.push('/tools')">‹ 工具</button>
    <h1>联系人管理</h1>
    <button class="btn compact" type="button" @click="router.push('/tools/contacts/new')">＋ 新增</button>
  </div>

  <!-- 顶部概览三格 -->
  <div v-if="!loading && allItems.length" class="stats-bar">
    <button
      type="button"
      class="stat-box"
      :class="{ on: filter === 'all' }"
      @click="setFilter('all')"
    >
      <span class="sk">联系人</span>
      <strong class="sv">{{ activeItems.length }}</strong>
    </button>
    <button
      type="button"
      class="stat-box"
      :class="{ on: filter === 'date' }"
      @click="setFilter('date')"
    >
      <span class="sk">已设日子</span>
      <strong class="sv brand">{{ withDateCount }}</strong>
    </button>
    <button
      type="button"
      class="stat-box"
      :class="{ on: filter === 'upcoming', highlight: upcomingItems.length > 0 }"
      @click="setFilter('upcoming')"
    >
      <span class="sk">30天内提醒</span>
      <strong class="sv" :class="{ warn: upcomingItems.length > 0 }">{{ upcomingItems.length }}</strong>
    </button>
  </div>

  <!-- 近期日子提醒横幅（30天内到来） -->
  <div v-if="!loading && upcomingItems.length && filter !== 'archived'" class="upcoming-strip">
    <div class="up-head">
      <span class="up-title">近期重要日子</span>
      <span class="up-hint">点卡片可直接编辑</span>
    </div>
    <div class="up-list">
      <div
        v-for="u in upcomingItems"
        :key="'up-' + u.id"
        class="up-card"
        @click="router.push('/tools/contacts/' + u.id)"
      >
        <div class="up-top">
          <strong>{{ u.name }}</strong>
          <span class="up-badge" :class="{ today: u.reminder?.text === '今天' }">
            {{ u.reminder?.text }}
          </span>
        </div>
        <div class="up-sub">
          {{ u.date?.kind_label }} · {{ u.date?.label }}
          <template v-if="u.reminder?.age_text"> · {{ u.reminder.age_text }}</template>
        </div>
      </div>
    </div>
  </div>

  <!-- 搜索与筛选工具栏 -->
  <div v-if="!loading && allItems.length" class="toolbar">
    <div class="search-box">
      <input
        v-model="q"
        type="search"
        placeholder="搜索姓名、关系或日子（如：生日、表哥）…"
      />
      <button v-if="q" type="button" class="clear-x" @click="q = ''">×</button>
    </div>

    <div class="filter-pills">
      <button type="button" class="f-pill" :class="{ on: filter === 'all' }" @click="setFilter('all')">
        全部 ({{ activeItems.length }})
      </button>
      <button type="button" class="f-pill" :class="{ on: filter === 'date' }" @click="setFilter('date')">
        有日子 ({{ withDateCount }})
      </button>
      <button
        v-if="upcomingItems.length"
        type="button"
        class="f-pill"
        :class="{ on: filter === 'upcoming' }"
        @click="setFilter('upcoming')"
      >
        近期提醒 ({{ upcomingItems.length }})
      </button>
      <button
        v-if="archivedCount"
        type="button"
        class="f-pill"
        :class="{ on: filter === 'archived' }"
        @click="setFilter('archived')"
      >
        已归档 ({{ archivedCount }})
      </button>
    </div>

    <!-- 关系标签快筛 -->
    <div v-if="relations.length && filter !== 'archived'" class="rel-pills">
      <span class="rel-label">关系：</span>
      <button
        v-for="rel in relations"
        :key="rel"
        type="button"
        class="r-pill"
        :class="{ on: relationFilter === rel }"
        @click="toggleRelation(rel)"
      >
        {{ rel }}
      </button>
    </div>
  </div>

  <p v-if="error" class="err">{{ error }}</p>
  <p v-if="loading" class="muted empty-state">加载中…</p>

  <!-- 完全空态 -->
  <div v-else-if="!allItems.length" class="card empty-card">
    <p class="empty-title">还没有联系人</p>
    <p class="muted">在人情往来里记下的人也会同步出现在这里，可以统一管理姓名、关系和重要日子。</p>
    <button class="btn" type="button" style="margin-top: 14px" @click="router.push('/tools/contacts/new')">
      ＋ 新增第一个联系人
    </button>
  </div>

  <!-- 筛选无结果空态 -->
  <div v-else-if="!filteredItems.length" class="card empty-card">
    <p class="empty-title">没有匹配的联系人</p>
    <div class="empty-actions">
      <button class="btn ghost compact" type="button" @click="resetFilters">清除筛选条件</button>
      <button class="btn compact" type="button" @click="router.push('/tools/contacts/new')">＋ 新增联系人</button>
    </div>
  </div>

  <!-- 联系人列表 -->
  <div v-else class="contact-list">
    <div
      v-for="item in filteredItems"
      :key="item.id"
      class="card contact-card"
      :class="{ archived: item.archived }"
      @click="router.push('/tools/contacts/' + item.id)"
    >
      <div class="c-top">
        <div class="c-avatar" :class="{ upcoming: isUpcoming(item) }">{{ initialOf(item.name) }}</div>
        <div class="c-main">
          <div class="c-title-row">
            <strong class="c-name">{{ item.name }}</strong>
            <span v-if="item.relation" class="rel-badge">{{ item.relation }}</span>
            <span v-if="item.archived" class="arch-badge">已归档</span>
          </div>

          <!-- 日子与提醒标签 -->
          <div v-if="item.date" class="c-date-line">
            <span class="date-tag" :class="{ hot: isUpcoming(item) }">
              {{ item.date.kind_label }} · {{ item.date.label }}
            </span>
            <span v-if="item.reminder?.text" class="rem-badge" :class="{ hot: isUpcoming(item) }">
              {{ item.reminder.text }}
            </span>
            <span v-if="item.reminder?.age_text" class="age-text">
              {{ item.reminder.age_text }}
            </span>
          </div>
          <div v-else class="c-no-date">未设置生日/纪念日 · 点此补充</div>
        </div>

        <div class="c-actions" @click.stop>
          <button
            type="button"
            class="act-btn edit"
            @click="router.push('/tools/contacts/' + item.id)"
          >
            编辑
          </button>
          <button
            v-if="showRecords && !item.archived"
            type="button"
            class="act-btn"
            @click="openRecords(item.id)"
          >
            往来
          </button>
          <button
            v-if="item.archived"
            type="button"
            class="act-btn"
            :disabled="busyId === item.id"
            @click="toggleArchive(item)"
          >
            恢复
          </button>
        </div>
      </div>

      <!-- 底部人情往来汇总条 -->
      <div class="c-foot">
        <div v-if="hasGifts(item)" class="c-money">
          <span>送出 ¥{{ centsToYuan(item.given_cents || 0) }}</span>
          <span class="dot">·</span>
          <span>收到 ¥{{ centsToYuan(item.received_cents || 0) }}</span>
          <span class="dot">·</span>
          <span :class="netClass(item)">{{ netLabel(item) }}</span>
        </div>
        <div v-else class="c-money muted">暂无人情往来记录</div>

        <button
          v-if="!item.archived"
          type="button"
          class="arch-link"
          :disabled="busyId === item.id"
          @click.stop="toggleArchive(item)"
        >
          归档
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.tools-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 14px;
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

/* 顶部概览三格 */
.stats-bar {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 10px;
  margin-bottom: 14px;
}
.stat-box {
  border: 1px solid transparent;
  border-radius: 14px;
  background: #fff;
  padding: 12px 10px;
  box-shadow: var(--shadow);
  text-align: center;
  cursor: pointer;
}
.stat-box.on {
  border-color: var(--brand);
  background: #f5f7ff;
}
.stat-box.highlight {
  background: #fff9f5;
}
.stat-box .sk {
  display: block;
  font-size: 12px;
  color: var(--muted);
}
.stat-box .sv {
  display: block;
  margin-top: 4px;
  font-size: 20px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}
.stat-box .sv.brand {
  color: var(--brand);
}
.stat-box .sv.warn {
  color: #e8590c;
}

/* 近期重要日子横幅 */
.upcoming-strip {
  margin-bottom: 14px;
  padding: 12px 14px;
  border-radius: 16px;
  background: linear-gradient(135deg, #eef2ff 0%, #f8f9ff 100%);
  border: 1px solid #dce3ff;
}
.up-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}
.up-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--brand);
}
.up-hint {
  font-size: 11px;
  color: var(--muted);
}
.up-list {
  display: flex;
  gap: 8px;
  overflow-x: auto;
  scrollbar-width: none;
}
.up-list::-webkit-scrollbar {
  display: none;
}
.up-card {
  flex: 0 0 auto;
  min-width: 150px;
  padding: 10px 12px;
  border-radius: 12px;
  background: #fff;
  box-shadow: 0 2px 8px rgba(59, 91, 219, 0.08);
  cursor: pointer;
}
.up-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 14px;
}
.up-badge {
  padding: 2px 8px;
  border-radius: 999px;
  background: #eef0ff;
  color: var(--brand);
  font-size: 11px;
  font-weight: 600;
}
.up-badge.today {
  background: #ffe9e8;
  color: var(--expense);
}
.up-sub {
  margin-top: 4px;
  font-size: 12px;
  color: var(--muted);
  white-space: nowrap;
}

/* 搜索与筛选栏 */
.toolbar {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-bottom: 14px;
}
.search-box {
  position: relative;
  display: flex;
  align-items: center;
  background: #fff;
  border-radius: 999px;
  padding: 0 14px;
  height: 42px;
  box-shadow: var(--shadow);
}
.search-box input {
  flex: 1;
  min-width: 0;
  border: 0;
  background: transparent;
  font-size: 14px;
  outline: none;
}
.clear-x {
  border: 0;
  background: #eceef5;
  color: var(--muted);
  width: 22px;
  height: 22px;
  border-radius: 11px;
  font-size: 15px;
  line-height: 20px;
  padding: 0;
}

.filter-pills {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.f-pill {
  border: 0;
  border-radius: 999px;
  padding: 6px 12px;
  background: #eceef5;
  color: var(--muted);
  font-size: 12px;
  font-weight: 500;
}
.f-pill.on {
  background: var(--brand);
  color: #fff;
  font-weight: 600;
}

.rel-pills {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
}
.rel-label {
  font-size: 12px;
  color: var(--muted);
}
.r-pill {
  border: 1px solid var(--line);
  border-radius: 999px;
  padding: 3px 10px;
  background: #fff;
  color: var(--text);
  font-size: 12px;
}
.r-pill.on {
  border-color: var(--brand);
  background: #eef0ff;
  color: var(--brand);
  font-weight: 600;
}

/* 联系人卡片列表 */
.contact-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.contact-card {
  padding: 14px;
  cursor: pointer;
  transition: transform 0.1s;
}
.contact-card.archived {
  opacity: 0.72;
}
.c-top {
  display: flex;
  align-items: flex-start;
  gap: 12px;
}
.c-avatar {
  flex: none;
  width: 40px;
  height: 40px;
  border-radius: 20px;
  background: #eef0ff;
  color: var(--brand);
  font-size: 16px;
  font-weight: 600;
  display: grid;
  place-items: center;
}
.c-avatar.upcoming {
  background: #fff0e6;
  color: #e8590c;
}
.c-main {
  flex: 1;
  min-width: 0;
}
.c-title-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
}
.c-name {
  font-size: 16px;
  font-weight: 600;
}
.rel-badge {
  padding: 2px 8px;
  border-radius: 999px;
  background: #f2f3f7;
  color: var(--muted);
  font-size: 11px;
}
.arch-badge {
  padding: 2px 8px;
  border-radius: 999px;
  background: #ffe9e8;
  color: var(--expense);
  font-size: 11px;
}

.c-date-line {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 6px;
}
.date-tag {
  font-size: 12px;
  color: var(--text);
  background: #f4f5f8;
  padding: 2px 8px;
  border-radius: 6px;
}
.date-tag.hot {
  background: #eef0ff;
  color: var(--brand);
  font-weight: 500;
}
.rem-badge {
  font-size: 11px;
  color: var(--muted);
}
.rem-badge.hot {
  padding: 1px 7px;
  border-radius: 999px;
  background: #fff0e6;
  color: #e8590c;
  font-weight: 600;
}
.age-text {
  font-size: 12px;
  color: var(--muted);
}
.c-no-date {
  margin-top: 5px;
  font-size: 12px;
  color: #b0b3be;
}

.c-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: none;
}
.act-btn {
  border: 0;
  border-radius: 999px;
  padding: 5px 11px;
  background: #f2f3f7;
  color: var(--text);
  font-size: 12px;
  font-weight: 600;
}
.act-btn.edit {
  background: #eef0ff;
  color: var(--brand);
}

.c-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px solid var(--line);
  font-size: 12px;
}
.c-money {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px;
  font-variant-numeric: tabular-nums;
}
.c-money .dot {
  color: var(--muted);
}
.arch-link {
  border: 0;
  background: transparent;
  color: var(--muted);
  font-size: 12px;
  padding: 2px 4px;
}

/* 空状态 */
.empty-state {
  text-align: center;
  padding: 32px 0;
}
.empty-card {
  text-align: center;
  padding: 28px 18px;
}
.empty-title {
  margin: 0 0 8px;
  font-size: 16px;
  font-weight: 600;
}
.empty-actions {
  display: flex;
  justify-content: center;
  gap: 10px;
  margin-top: 14px;
}
</style>
