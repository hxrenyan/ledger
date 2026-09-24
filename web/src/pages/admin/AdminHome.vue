<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { adminApi, setAdminToken } from '../../adminApi.ts'
import AdminAi from './AdminAi.vue'
import AdminAsr from './AdminAsr.vue'
import AdminOcr from './AdminOcr.vue'
import AdminWebview from './AdminWebview.vue'

type Tab = 'users' | 'ledgers' | 'ai' | 'asr' | 'ocr' | 'webview'
type Overview = { users: number; ledgers: number; transactions: number; disabled_users: number }
type UserRow = { id: number; username: string; nickname: string; disabled: boolean; created_at: number; ledger_count: number }
type LedgerRow = { id: number; name: string; owner_username: string; member_count: number; tx_count: number; created_at: number }
const router = useRouter()
const tab = ref<Tab>('users')
const overview = ref<Overview>({ users: 0, ledgers: 0, transactions: 0, disabled_users: 0 })
const users = ref<UserRow[]>([])
const ledgers = ref<LedgerRow[]>([])
const err = ref('')
const loading = ref(false)
const busyId = ref<number | ''>('')
const navGroups = [
  { title: '概览', items: [{ key: 'users', label: '用户' }, { key: 'ledgers', label: '账本' }] },
  { title: '能力配置', items: [{ key: 'ai', label: 'AI 解析' }, { key: 'asr', label: '语音识别' }, { key: 'ocr', label: '图片识别' }] },
  { title: '产品配置', items: [{ key: 'webview', label: 'Web-view' }] },
] as const
async function load() {
  loading.value = true; err.value = ''
  try {
    const [nextOverview, nextUsers, nextLedgers] = await Promise.all([
      adminApi<Overview>('/api/v1/admin/overview'), adminApi<{ items: UserRow[] }>('/api/v1/admin/users'), adminApi<{ items: LedgerRow[] }>('/api/v1/admin/ledgers'),
    ])
    overview.value = nextOverview; users.value = nextUsers.items; ledgers.value = nextLedgers.items
  } catch (e) { err.value = e instanceof Error ? e.message : '加载失败' } finally { loading.value = false }
}
async function toggle(u: UserRow) {
  if (busyId.value) return
  if (!u.disabled && !confirm(`停用 @${u.username}？停用后无法登录。`)) return
  busyId.value = u.id; err.value = ''
  try { await adminApi(`/api/v1/admin/users/${u.id}`, { method: 'PATCH', body: JSON.stringify({ disabled: !u.disabled }) }); await load() }
  catch (e) { err.value = e instanceof Error ? e.message : '操作失败' } finally { busyId.value = '' }
}
function logout() { setAdminToken(''); router.replace('/admin/login') }
function when(ms: number) { return new Date(ms + 8 * 3600 * 1000).toISOString().slice(0, 10) }
onMounted(load)
</script>

<template>
  <div class="admin-shell">
    <aside class="admin-sidebar">
      <div class="admin-brand"><span class="admin-brand-mark">L</span><div><strong>Ledger</strong><small>管理后台</small></div></div>
      <nav class="admin-nav"><div v-for="group in navGroups" :key="group.title" class="admin-nav-group"><div class="admin-nav-title">{{ group.title }}</div><button v-for="item in group.items" :key="item.key" type="button" :class="{ on: tab === item.key }" @click="tab = item.key">{{ item.label }}</button></div></nav>
      <button class="admin-logout" type="button" @click="logout">退出管理后台</button>
    </aside>
    <main class="admin-main">
      <header class="admin-topbar"><div><div class="admin-eyebrow">OPERATIONS</div><h1>管理后台</h1></div><div class="admin-top-actions"><button class="btn ghost compact" type="button" :disabled="loading" @click="load">{{ loading ? '刷新中…' : '刷新数据' }}</button><button class="btn danger compact admin-mobile-logout" type="button" @click="logout">退出</button></div></header>
      <div class="admin-mobile-nav"><button v-for="group in navGroups" :key="group.title" type="button" class="admin-mobile-nav-group" @click="tab = group.items[0].key">{{ group.title }}</button><template v-for="group in navGroups" :key="`${group.title}-items`"><button v-for="item in group.items" :key="item.key" class="admin-mobile-nav-item" type="button" :class="{ on: tab === item.key }" @click="tab = item.key">{{ item.label }}</button></template></div>
      <section class="admin-content">
        <div v-if="tab === 'users' || tab === 'ledgers'" class="admin-overview-head"><div><h2>{{ tab === 'users' ? '用户管理' : '账本管理' }}</h2><p class="muted">查看当前数据概况和运营状态。</p></div><span class="admin-updated">{{ loading ? '正在同步' : '数据已加载' }}</span></div>
        <div v-if="tab === 'users' || tab === 'ledgers'" class="admin-stats"><div class="admin-stat"><span>用户</span><strong>{{ overview.users }}</strong><small>注册用户</small></div><div class="admin-stat"><span>账本</span><strong>{{ overview.ledgers }}</strong><small>全部账本</small></div><div class="admin-stat"><span>流水</span><strong>{{ overview.transactions }}</strong><small>累计记录</small></div><div class="admin-stat warning"><span>已停用</span><strong>{{ overview.disabled_users }}</strong><small>无法登录</small></div></div>
        <p v-if="err" class="err admin-alert">{{ err }}</p>
        <section v-if="tab === 'users'" class="admin-panel"><div class="admin-panel-head"><div><h3>用户列表</h3><p class="muted">共 {{ users.length }} 位用户</p></div></div><div v-if="!users.length && !loading" class="admin-empty">暂无用户数据</div><div v-for="u in users" :key="u.id" class="admin-list-row"><div class="admin-avatar">{{ (u.nickname || u.username).slice(0, 1).toUpperCase() }}</div><div class="admin-row-main"><strong>{{ u.nickname || u.username }}</strong><span>@{{ u.username }} · {{ u.ledger_count }} 本账本 · {{ when(u.created_at) }}</span></div><span class="admin-status" :class="u.disabled ? 'off' : 'on'">{{ u.disabled ? '已停用' : '正常' }}</span><button class="btn compact" :class="u.disabled ? 'ghost' : 'danger'" type="button" :disabled="busyId === u.id" @click="toggle(u)">{{ u.disabled ? '启用' : '停用' }}</button></div></section>
        <section v-else-if="tab === 'ledgers'" class="admin-panel"><div class="admin-panel-head"><div><h3>账本列表</h3><p class="muted">共 {{ ledgers.length }} 本账本</p></div></div><div v-if="!ledgers.length && !loading" class="admin-empty">暂无账本数据</div><div v-for="l in ledgers" :key="l.id" class="admin-list-row"><div class="admin-avatar ledger">账</div><div class="admin-row-main"><strong>{{ l.name }}</strong><span>主账号 @{{ l.owner_username }} · 创建于 {{ when(l.created_at) }}</span></div><div class="admin-row-metrics"><span>{{ l.member_count }} 人</span><span>{{ l.tx_count }} 笔</span></div></div></section>
        <AdminAi v-else-if="tab === 'ai'" /><AdminAsr v-else-if="tab === 'asr'" /><AdminOcr v-else-if="tab === 'ocr'" /><AdminWebview v-else />
      </section>
    </main>
  </div>
</template>
