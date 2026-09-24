<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { adminApi, setAdminToken } from '../../adminApi.ts'
import AdminAi from './AdminAi.vue'
import AdminAsr from './AdminAsr.vue'
import AdminOcr from './AdminOcr.vue'

type Overview = { users: number; ledgers: number; transactions: number; disabled_users: number }
type UserRow = { id: number; username: string; nickname: string; disabled: boolean; created_at: number; ledger_count: number }
type LedgerRow = { id: number; name: string; owner_username: string; member_count: number; tx_count: number; created_at: number }

const router = useRouter()
const tab = ref<'users' | 'ledgers' | 'ai' | 'asr' | 'ocr'>('users')
const overview = ref<Overview>({ users: 0, ledgers: 0, transactions: 0, disabled_users: 0 })
const users = ref<UserRow[]>([])
const ledgers = ref<LedgerRow[]>([])
const err = ref('')
const busyId = ref<number | ''>('')

async function load() {
  err.value = ''
  try {
    overview.value = await adminApi<Overview>('/api/v1/admin/overview')
    users.value = (await adminApi<{ items: UserRow[] }>('/api/v1/admin/users')).items
    ledgers.value = (await adminApi<{ items: LedgerRow[] }>('/api/v1/admin/ledgers')).items
  } catch (e) {
    err.value = e instanceof Error ? e.message : '加载失败'
  }
}

async function toggle(u: UserRow) {
  if (busyId.value) return
  if (!u.disabled && !confirm(`停用 @${u.username}？停用后无法登录。`)) return
  busyId.value = u.id
  err.value = ''
  try {
    await adminApi(`/api/v1/admin/users/${u.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ disabled: !u.disabled }),
    })
    await load()
  } catch (e) {
    err.value = e instanceof Error ? e.message : '操作失败'
  } finally {
    busyId.value = ''
  }
}

function logout() {
  setAdminToken('')
  router.replace('/admin/login')
}

function when(ms: number) {
  return new Date(ms + 8 * 3600 * 1000).toISOString().slice(0, 10)
}

onMounted(load)
</script>

<template>
  <div class="page">
    <div class="admin-head">
      <h1>管理后台</h1>
      <button class="btn ghost compact" type="button" @click="logout">退出</button>
    </div>
    <div class="summary">
      <div class="card"><div class="k">用户</div><div class="v">{{ overview.users }}</div></div>
      <div class="card"><div class="k">账本</div><div class="v">{{ overview.ledgers }}</div></div>
    </div>
    <div class="summary">
      <div class="card"><div class="k">流水</div><div class="v">{{ overview.transactions }}</div></div>
      <div class="card"><div class="k">已停用</div><div class="v expense">{{ overview.disabled_users }}</div></div>
    </div>
    <div class="tabs">
      <button :class="{ on: tab === 'users' }" @click="tab = 'users'">用户</button>
      <button :class="{ on: tab === 'ledgers' }" @click="tab = 'ledgers'">账本</button>
      <button :class="{ on: tab === 'ai' }" @click="tab = 'ai'">AI 配置</button>
      <button :class="{ on: tab === 'asr' }" @click="tab = 'asr'">语音识别</button>
      <button :class="{ on: tab === 'ocr' }" @click="tab = 'ocr'">图片识别</button>
    </div>
    <p v-if="err" class="err">{{ err }}</p>
    <div v-if="tab === 'users'" class="card">
      <div class="row" v-for="u in users" :key="u.id">
        <div>
          <div>{{ u.nickname || u.username }}</div>
          <div class="muted">@{{ u.username }} · {{ u.ledger_count }} 本账本 · {{ when(u.created_at) }}</div>
        </div>
        <button
          class="btn compact"
          :class="u.disabled ? 'ghost' : 'danger'"
          type="button"
          :disabled="busyId === u.id"
          @click="toggle(u)"
        >
          {{ u.disabled ? '启用' : '停用' }}
        </button>
      </div>
    </div>
    <div v-else-if="tab === 'ledgers'" class="card">
      <div class="row" v-for="l in ledgers" :key="l.id">
        <div>
          <div>{{ l.name }}</div>
          <div class="muted">主账号 @{{ l.owner_username }} · {{ l.member_count }} 人 · {{ l.tx_count }} 笔</div>
        </div>
      </div>
    </div>
    <AdminAi v-else-if="tab === 'ai'" />
    <AdminAsr v-else-if="tab === 'asr'" />
    <AdminOcr v-else />
  </div>
</template>
