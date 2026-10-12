<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { adminApi, setAdminToken } from '../../adminApi.ts'
import AdminAi from './AdminAi.vue'
import AdminAsr from './AdminAsr.vue'
import AdminOcr from './AdminOcr.vue'
import AdminWechat from './AdminWechat.vue'
import AdminPoints from './AdminPoints.vue'
import AdminFeedback from './AdminFeedback.vue'

type Tab = 'users' | 'ledgers' | 'points' | 'feedback' | 'ai' | 'asr' | 'ocr' | 'wechat'
type UserStatus = 'all' | 'active' | 'disabled'
type TimeSort = 'created' | 'seen'
type TimeOrder = 'asc' | 'desc'
type Overview = { users: number; ledgers: number; transactions: number; disabled_users: number }
type UserRow = { id: number; username: string; nickname: string; disabled: boolean; created_at: number; last_seen_at: number | null; ledger_count: number }
type LedgerRow = { id: number; name: string; owner_username: string; member_count: number; tx_count: number; created_at: number; last_seen_at: number | null }
type Reloadable = { reload: () => Promise<void> | void }

const router = useRouter()
const tab = ref<Tab>('users')
const overview = ref<Overview>({ users: 0, ledgers: 0, transactions: 0, disabled_users: 0 })
const users = ref<UserRow[]>([])
const ledgers = ref<LedgerRow[]>([])
const err = ref('')
const userLoading = ref(false)
const ledgerLoading = ref(false)
const refreshing = ref(false)
const busyId = ref<number | ''>('')
const userQuery = ref('')
const userStatus = ref<UserStatus>('all')
const userSort = ref<TimeSort>('created')
const userOrder = ref<TimeOrder>('desc')
const ledgerQuery = ref('')
const ledgerSort = ref<TimeSort>('created')
const ledgerOrder = ref<TimeOrder>('desc')
const ledgersReady = ref(false)
const pointsPanel = ref<Reloadable | null>(null)
const feedbackPanel = ref<Reloadable | null>(null)
const aiPanel = ref<Reloadable | null>(null)
const asrPanel = ref<Reloadable | null>(null)
const ocrPanel = ref<Reloadable | null>(null)
const wechatPanel = ref<Reloadable | null>(null)
let userReq = 0
let ledgerReq = 0
let userTimer = 0
let ledgerTimer = 0

const navGroups = [
  { title: '概览', items: [{ key: 'users', label: '用户' }, { key: 'ledgers', label: '账本' }, { key: 'points', label: '积分' }, { key: 'feedback', label: '反馈' }] },
  { title: '能力配置', items: [{ key: 'ai', label: 'AI 解析' }, { key: 'asr', label: '语音识别' }, { key: 'ocr', label: '图片识别' }] },
  { title: '产品配置', items: [{ key: 'wechat', label: '微信登录' }] },
] as const
const navItems: { key: Tab; label: string }[] = []
for (const group of navGroups) {
  for (const item of group.items) navItems.push({ key: item.key, label: item.label })
}
const userFilters: { key: UserStatus; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'active', label: '正常' },
  { key: 'disabled', label: '已停用' },
]
const page = computed(() => {
  for (const group of navGroups) {
    const item = group.items.find((entry) => entry.key === tab.value)
    if (item) return { eyebrow: group.title, title: item.label }
  }
  return { eyebrow: '概览', title: '用户' }
})
const userEmpty = computed(() => (userQuery.value.trim() || userStatus.value !== 'all' ? '没有匹配的用户' : '暂无用户'))
const ledgerEmpty = computed(() => (ledgerQuery.value.trim() ? '没有匹配的账本' : '暂无账本'))

function queryPath(path: string, query: string, extra?: Record<string, string>) {
  const params = new URLSearchParams()
  const q = query.trim()
  if (q) params.set('q', q)
  for (const [key, value] of Object.entries(extra ?? {})) {
    if (value) params.set(key, value)
  }
  const text = params.toString()
  return text ? `${path}?${text}` : path
}

async function loadOverview() {
  overview.value = await adminApi<Overview>('/api/v1/admin/overview')
}

async function loadUsers() {
  const req = ++userReq
  userLoading.value = true
  try {
    const status = userStatus.value === 'all' ? '' : userStatus.value
    const data = await adminApi<{ items: UserRow[] }>(queryPath('/api/v1/admin/users', userQuery.value, {
      status,
      sort: userSort.value,
      order: userOrder.value,
    }))
    if (req !== userReq) return
    users.value = data.items
    err.value = ''
  } catch (e) {
    if (req !== userReq) return
    err.value = e instanceof Error ? e.message : '加载失败'
  } finally {
    if (req === userReq) userLoading.value = false
  }
}

async function loadLedgers() {
  const req = ++ledgerReq
  ledgerLoading.value = true
  try {
    const data = await adminApi<{ items: LedgerRow[] }>(queryPath('/api/v1/admin/ledgers', ledgerQuery.value, {
      sort: ledgerSort.value,
      order: ledgerOrder.value,
    }))
    if (req !== ledgerReq) return
    ledgers.value = data.items
    ledgersReady.value = true
    err.value = ''
  } catch (e) {
    if (req !== ledgerReq) return
    err.value = e instanceof Error ? e.message : '加载失败'
  } finally {
    if (req === ledgerReq) ledgerLoading.value = false
  }
}

function onUserInput() {
  window.clearTimeout(userTimer)
  userTimer = window.setTimeout(() => { void loadUsers() }, 250)
}

function clearUserQuery() {
  userQuery.value = ''
  window.clearTimeout(userTimer)
  void loadUsers()
}

function setUserStatus(next: UserStatus) {
  if (userStatus.value === next) return
  userStatus.value = next
  void loadUsers()
}

function setUserSort(key: TimeSort) {
  if (userSort.value === key) return
  userSort.value = key
  void loadUsers()
}

function toggleUserSort(key: TimeSort) {
  if (userSort.value === key) userOrder.value = userOrder.value === 'desc' ? 'asc' : 'desc'
  else userSort.value = key
  void loadUsers()
}

function setUserOrder(order: TimeOrder) {
  if (userOrder.value === order) return
  userOrder.value = order
  void loadUsers()
}

function setLedgerSort(key: TimeSort) {
  if (ledgerSort.value === key) return
  ledgerSort.value = key
  void loadLedgers()
}

function toggleLedgerSort(key: TimeSort) {
  if (ledgerSort.value === key) ledgerOrder.value = ledgerOrder.value === 'desc' ? 'asc' : 'desc'
  else ledgerSort.value = key
  void loadLedgers()
}

function setLedgerOrder(order: TimeOrder) {
  if (ledgerOrder.value === order) return
  ledgerOrder.value = order
  void loadLedgers()
}

function sortMark(active: boolean, order: TimeOrder) {
  if (!active) return ''
  return order === 'asc' ? ' ↑' : ' ↓'
}

function onLedgerInput() {
  window.clearTimeout(ledgerTimer)
  ledgerTimer = window.setTimeout(() => { void loadLedgers() }, 250)
}

function clearLedgerQuery() {
  ledgerQuery.value = ''
  window.clearTimeout(ledgerTimer)
  void loadLedgers()
}

function currentPanel() {
  if (tab.value === 'points') return pointsPanel.value
  if (tab.value === 'feedback') return feedbackPanel.value
  if (tab.value === 'ai') return aiPanel.value
  if (tab.value === 'asr') return asrPanel.value
  if (tab.value === 'ocr') return ocrPanel.value
  if (tab.value === 'wechat') return wechatPanel.value
  return null
}

async function refresh() {
  if (refreshing.value) return
  refreshing.value = true
  err.value = ''
  try {
    if (tab.value === 'users') await Promise.all([loadOverview(), loadUsers()])
    else if (tab.value === 'ledgers') await Promise.all([loadOverview(), loadLedgers()])
    else await currentPanel()?.reload()
  } catch (e) {
    err.value = e instanceof Error ? e.message : '刷新失败'
  } finally {
    refreshing.value = false
  }
}

async function toggle(u: UserRow) {
  if (busyId.value) return
  if (!u.disabled && !confirm(`停用 @${u.username}？停用后无法登录。`)) return
  busyId.value = u.id
  err.value = ''
  const next = !u.disabled
  try {
    await adminApi(`/api/v1/admin/users/${u.id}`, { method: 'PATCH', body: JSON.stringify({ disabled: next }) })
    overview.value.disabled_users += next ? 1 : -1
    if ((userStatus.value === 'active' && next) || (userStatus.value === 'disabled' && !next)) {
      users.value = users.value.filter((item) => item.id !== u.id)
    } else {
      u.disabled = next
    }
  } catch (e) {
    err.value = e instanceof Error ? e.message : '操作失败'
  } finally {
    busyId.value = ''
  }
}

function logout() { setAdminToken(''); router.replace('/admin/login') }

function whenAt(ms: number | null) {
  if (!ms) return '暂无'
  return new Date(ms + 8 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' ')
}

watch(tab, (next) => {
  if (next === 'ledgers' && !ledgersReady.value) void loadLedgers()
})

onMounted(() => {
  void loadOverview().catch((e) => { err.value = e instanceof Error ? e.message : '加载失败' })
  void loadUsers()
})
</script>

<template>
  <div class="admin-shell">
    <aside class="admin-sidebar">
      <div class="admin-brand">
        <span class="admin-brand-mark">L</span>
        <div><strong>Ledger</strong><small>管理后台</small></div>
      </div>
      <nav class="admin-nav">
        <div v-for="group in navGroups" :key="group.title" class="admin-nav-group">
          <div class="admin-nav-title">{{ group.title }}</div>
          <button v-for="item in group.items" :key="item.key" type="button" :class="{ on: tab === item.key }" @click="tab = item.key">{{ item.label }}</button>
        </div>
      </nav>
      <button class="admin-logout" type="button" @click="logout">退出管理后台</button>
    </aside>
    <main class="admin-main">
      <header class="admin-topbar">
        <div>
          <div class="admin-eyebrow">{{ page.eyebrow }}</div>
          <h1>{{ page.title }}</h1>
        </div>
        <div class="admin-top-actions">
          <button class="btn ghost compact" type="button" :disabled="refreshing" @click="refresh">{{ refreshing ? '刷新中…' : '刷新' }}</button>
          <button class="btn danger compact admin-mobile-logout" type="button" @click="logout">退出</button>
        </div>
      </header>
      <div class="admin-mobile-nav">
        <button
          v-for="item in navItems"
          :key="item.key"
          class="admin-mobile-nav-item"
          type="button"
          :class="{ on: tab === item.key }"
          @click="tab = item.key"
        >{{ item.label }}</button>
      </div>
      <section class="admin-content">
        <p v-if="err && tab !== 'points' && tab !== 'feedback' && tab !== 'ai' && tab !== 'asr' && tab !== 'ocr' && tab !== 'wechat'" class="err admin-alert">{{ err }}</p>

        <template v-if="tab === 'users' || tab === 'ledgers'">
          <div class="admin-stats">
            <div class="admin-stat"><span>用户</span><strong>{{ overview.users }}</strong><small>注册用户</small></div>
            <div class="admin-stat"><span>账本</span><strong>{{ overview.ledgers }}</strong><small>全部账本</small></div>
            <div class="admin-stat"><span>流水</span><strong>{{ overview.transactions }}</strong><small>累计记录</small></div>
            <div class="admin-stat warning"><span>已停用</span><strong>{{ overview.disabled_users }}</strong><small>无法登录</small></div>
          </div>
        </template>

        <section v-if="tab === 'users'" class="admin-panel">
          <div class="admin-toolbar">
            <label class="admin-search">
              <input v-model="userQuery" placeholder="搜索昵称或账号" aria-label="搜索用户" @input="onUserInput" />
              <button v-if="userQuery" class="admin-search-clear" type="button" @click="clearUserQuery">清除</button>
            </label>
            <div class="admin-seg">
              <button v-for="item in userFilters" :key="item.key" type="button" :class="{ on: userStatus === item.key }" @click="setUserStatus(item.key)">{{ item.label }}</button>
            </div>
            <div class="admin-seg" aria-label="用户排序">
              <button type="button" :class="{ on: userSort === 'created' }" @click="setUserSort('created')">注册时间</button>
              <button type="button" :class="{ on: userSort === 'seen' }" @click="setUserSort('seen')">最后使用时间</button>
            </div>
            <div class="admin-seg" aria-label="用户顺序">
              <button type="button" :class="{ on: userOrder === 'desc' }" @click="setUserOrder('desc')">倒序</button>
              <button type="button" :class="{ on: userOrder === 'asc' }" @click="setUserOrder('asc')">正序</button>
            </div>
            <span class="count">{{ userLoading ? '查询中' : `${users.length} 位` }}</span>
          </div>
          <div v-if="!users.length && !userLoading" class="admin-empty">{{ userEmpty }}</div>
          <div v-else-if="users.length" class="admin-table-wrap">
            <div class="admin-table users">
              <div class="admin-table-head">
                <span>用户</span><span>账本</span>
                <button type="button" class="admin-sort" :class="{ on: userSort === 'created' }" @click="toggleUserSort('created')">注册时间{{ sortMark(userSort === 'created', userOrder) }}</button>
                <button type="button" class="admin-sort" :class="{ on: userSort === 'seen' }" @click="toggleUserSort('seen')">最后使用时间{{ sortMark(userSort === 'seen', userOrder) }}</button>
                <span>状态</span><span>操作</span>
              </div>
              <div v-for="u in users" :key="u.id" class="admin-table-row">
                <div class="admin-person">
                  <div class="admin-avatar">{{ (u.nickname || u.username).slice(0, 1).toUpperCase() }}</div>
                  <div><strong>{{ u.nickname || u.username }}</strong><span>@{{ u.username }}</span></div>
                </div>
                <span class="admin-num">{{ u.ledger_count }}</span>
                <span class="admin-time">{{ whenAt(u.created_at) }}</span>
                <span class="admin-time">{{ whenAt(u.last_seen_at) }}</span>
                <span class="admin-status" :class="u.disabled ? 'off' : 'on'">{{ u.disabled ? '已停用' : '正常' }}</span>
                <button class="admin-row-btn" :class="{ danger: !u.disabled }" type="button" :disabled="busyId === u.id" @click="toggle(u)">{{ busyId === u.id ? '处理中' : u.disabled ? '启用' : '停用' }}</button>
              </div>
            </div>
          </div>
        </section>

        <section v-else-if="tab === 'ledgers'" class="admin-panel">
          <div class="admin-toolbar">
            <label class="admin-search">
              <input v-model="ledgerQuery" placeholder="搜索账本、账号或昵称" aria-label="搜索账本" @input="onLedgerInput" />
              <button v-if="ledgerQuery" class="admin-search-clear" type="button" @click="clearLedgerQuery">清除</button>
            </label>
            <div class="admin-seg" aria-label="账本排序">
              <button type="button" :class="{ on: ledgerSort === 'created' }" @click="setLedgerSort('created')">创建时间</button>
              <button type="button" :class="{ on: ledgerSort === 'seen' }" @click="setLedgerSort('seen')">最后使用时间</button>
            </div>
            <div class="admin-seg" aria-label="账本顺序">
              <button type="button" :class="{ on: ledgerOrder === 'desc' }" @click="setLedgerOrder('desc')">倒序</button>
              <button type="button" :class="{ on: ledgerOrder === 'asc' }" @click="setLedgerOrder('asc')">正序</button>
            </div>
            <span class="count">{{ ledgerLoading ? '查询中' : `${ledgers.length} 本` }}</span>
          </div>
          <div v-if="!ledgers.length && !ledgerLoading" class="admin-empty">{{ ledgerEmpty }}</div>
          <div v-else-if="ledgers.length" class="admin-table-wrap">
            <div class="admin-table ledgers">
              <div class="admin-table-head">
                <span>账本</span><span>主账号</span><span>成员</span><span>流水</span>
                <button type="button" class="admin-sort" :class="{ on: ledgerSort === 'created' }" @click="toggleLedgerSort('created')">创建时间{{ sortMark(ledgerSort === 'created', ledgerOrder) }}</button>
                <button type="button" class="admin-sort" :class="{ on: ledgerSort === 'seen' }" @click="toggleLedgerSort('seen')">最后使用时间{{ sortMark(ledgerSort === 'seen', ledgerOrder) }}</button>
              </div>
              <div v-for="l in ledgers" :key="l.id" class="admin-table-row">
                <div class="admin-person">
                  <div class="admin-avatar ledger">账</div>
                  <div><strong>{{ l.name }}</strong></div>
                </div>
                <span>@{{ l.owner_username }}</span>
                <span class="admin-num">{{ l.member_count }}</span>
                <span class="admin-num">{{ l.tx_count }}</span>
                <span class="admin-time">{{ whenAt(l.created_at) }}</span>
                <span class="admin-time">{{ whenAt(l.last_seen_at) }}</span>
              </div>
            </div>
          </div>
        </section>

        <AdminPoints v-else-if="tab === 'points'" ref="pointsPanel" />
        <AdminFeedback v-else-if="tab === 'feedback'" ref="feedbackPanel" />
        <AdminAi v-else-if="tab === 'ai'" ref="aiPanel" />
        <AdminAsr v-else-if="tab === 'asr'" ref="asrPanel" />
        <AdminOcr v-else-if="tab === 'ocr'" ref="ocrPanel" />
        <AdminWechat v-else-if="tab === 'wechat'" ref="wechatPanel" />
      </section>
    </main>
  </div>
</template>
