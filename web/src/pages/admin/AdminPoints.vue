<script setup lang="ts">
/**
 * 只给有微信登录的账号手动加减积分。勾选多位时，同一次变动和同一条备注一起提交。
 */
import { onMounted, ref } from 'vue'
import { adminApi } from '../../adminApi.ts'

type PointUser = {
  id: number
  username: string
  nickname: string
  disabled: boolean
  balance: number
}

type PointEntry = {
  id: number
  user_id: number
  delta: number
  balance_after: number
  kind: string
  note: string
  created_at: number
}

const users = ref<PointUser[]>([])
const selected = ref<number[]>([])
const err = ref('')
const msg = ref('')
const loading = ref(false)
const openId = ref<number | ''>('')
const deltaText = ref('')
const note = ref('')
const busy = ref(false)
const entries = ref<PointEntry[]>([])
const restricted = ref(false)
const limitBusy = ref(false)

const kindLabel: Record<string, string> = {
  admin_grant: '管理员分配',
  admin_deduct: '管理员扣减',
}

async function loadLimit() {
  const data = await adminApi<{ restricted: boolean }>('/api/v1/admin/recognition')
  restricted.value = data.restricted
}

async function saveLimit(next: boolean) {
  if (limitBusy.value) return
  limitBusy.value = true
  err.value = ''
  msg.value = ''
  try {
    const data = await adminApi<{ restricted: boolean }>('/api/v1/admin/recognition', {
      method: 'PUT',
      body: JSON.stringify({ restricted: next }),
    })
    restricted.value = data.restricted
    msg.value = data.restricted ? '已开启识别限制' : '已关闭识别限制'
  } catch (e) {
    err.value = e instanceof Error ? e.message : '保存失败'
  } finally {
    limitBusy.value = false
  }
}

async function load() {
  loading.value = true
  err.value = ''
  try {
    await loadLimit()
    const data = await adminApi<{ items: PointUser[] }>('/api/v1/admin/points')
    users.value = data.items
    const ids = new Set(data.items.map((item) => item.id))
    selected.value = selected.value.filter((id) => ids.has(id))
  } catch (e) {
    err.value = e instanceof Error ? e.message : '加载失败'
  } finally {
    loading.value = false
  }
}

async function open(user: PointUser) {
  err.value = ''
  msg.value = ''
  if (openId.value === user.id) {
    openId.value = ''
    entries.value = []
    return
  }
  openId.value = user.id
  entries.value = []
  try {
    const data = await adminApi<{ items: PointEntry[] }>(`/api/v1/admin/users/${user.id}/points`)
    entries.value = data.items
  } catch (e) {
    err.value = e instanceof Error ? e.message : '明细加载失败'
  }
}

function toggle(id: number) {
  if (selected.value.includes(id)) selected.value = selected.value.filter((item) => item !== id)
  else selected.value = [...selected.value, id]
}

function toggleAll() {
  if (selected.value.length === users.value.length) selected.value = []
  else selected.value = users.value.map((user) => user.id)
}

async function submitBatch() {
  if (busy.value) return
  if (!selected.value.length) {
    err.value = '请选择用户'
    msg.value = ''
    return
  }
  const delta = Number(deltaText.value)
  if (!Number.isInteger(delta) || delta === 0) {
    err.value = '积分变动须为非 0 整数'
    msg.value = ''
    return
  }
  err.value = ''
  msg.value = ''
  busy.value = true
  try {
    const data = await adminApi<{ items: PointEntry[] }>('/api/v1/admin/points', {
      method: 'POST',
      body: JSON.stringify({ user_ids: selected.value, delta, note: note.value }),
    })
    const count = selected.value.length
    for (const entry of data.items) {
      const user = users.value.find((item) => item.id === entry.user_id)
      if (user) user.balance = entry.balance_after
      if (entry.user_id === openId.value) entries.value = [entry, ...entries.value].slice(0, 20)
    }
    selected.value = []
    deltaText.value = ''
    note.value = ''
    msg.value = delta > 0 ? `已给 ${count} 人各分配 ${delta} 积分` : `已给 ${count} 人各扣减 ${-delta} 积分`
  } catch (e) {
    err.value = e instanceof Error ? e.message : '分配失败'
  } finally {
    busy.value = false
  }
}

function whenAt(ms: number) {
  return new Date(ms + 8 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' ')
}

function signed(n: number) {
  return n > 0 ? `+${n}` : String(n)
}

onMounted(load)
</script>

<template>
  <div class="admin-config-page">
    <div class="admin-config-title">
      <div>
        <h2>积分分配</h2>
        <p class="muted">只列出微信登录的账号。勾选后按同一变动、同一备注一次分配。正数增加，负数扣减。任何一人不够扣时，这一批都不写入。</p>
      </div>
      <button class="btn ghost compact" type="button" :disabled="loading" @click="load">{{ loading ? '刷新中…' : '刷新' }}</button>
    </div>
    <p v-if="err" class="err admin-alert">{{ err }}</p>
    <p v-if="msg" class="admin-success">{{ msg }}</p>
    <section class="admin-panel">
      <div class="admin-panel-head">
        <div>
          <h3>识别限制</h3>
          <p class="muted">开启后，语音、拍照和文本整理只允许微信登录，并按积分扣费。关闭后，已登录用户都能用，不扣积分。保存后立即生效。</p>
        </div>
        <button class="btn compact" type="button" :disabled="limitBusy" @click="saveLimit(!restricted)">
          {{ limitBusy ? '保存中…' : restricted ? '已开启，点击关闭' : '已关闭，点击开启' }}
        </button>
      </div>
    </section>
    <section class="admin-panel">
      <div class="admin-panel-head">
        <div>
          <h3>微信用户</h3>
          <p class="muted">共 {{ users.length }} 位，已选 {{ selected.length }} 位</p>
        </div>
        <button class="btn ghost compact" type="button" :disabled="!users.length" @click="toggleAll">
          {{ selected.length === users.length && users.length ? '取消全选' : '全选' }}
        </button>
      </div>
      <form v-if="users.length" class="point-batch" @submit.prevent="submitBatch">
        <input v-model="deltaText" inputmode="numeric" placeholder="如 10 或 -5" aria-label="积分变动" />
        <input v-model="note" maxlength="100" placeholder="备注，例如活动补发" aria-label="备注" />
        <button class="btn compact" type="submit" :disabled="busy || !selected.length">
          {{ busy ? '提交中…' : `分配给已选 ${selected.length} 人` }}
        </button>
      </form>
      <div v-if="!users.length && !loading" class="admin-empty">还没有微信用户</div>
      <div v-for="u in users" :key="u.id" class="point-user">
        <div class="admin-list-row">
          <input class="point-check" type="checkbox" :checked="selected.includes(u.id)" :aria-label="`选择 ${u.nickname || u.username}`" @change="toggle(u.id)" />
          <div class="admin-avatar">{{ (u.nickname || u.username).slice(0, 1).toUpperCase() }}</div>
          <div class="admin-row-main">
            <strong>{{ u.nickname || u.username }}</strong>
            <span>@{{ u.username }}</span>
          </div>
          <span class="admin-status" :class="u.disabled ? 'off' : 'on'">{{ u.disabled ? '已停用' : '正常' }}</span>
          <span class="point-balance">{{ u.balance }} 分</span>
          <button class="btn compact" :class="openId === u.id ? 'ghost' : ''" type="button" @click="open(u)">
            {{ openId === u.id ? '收起' : '明细' }}
          </button>
        </div>
        <ul v-if="openId === u.id" class="point-entries">
          <li v-if="!entries.length">还没有明细</li>
          <li v-for="item in entries" :key="item.id">
            {{ whenAt(item.created_at) }} · {{ kindLabel[item.kind] || item.kind }} {{ signed(item.delta) }} · 余额 {{ item.balance_after }} · {{ item.note }}
          </li>
        </ul>
      </div>
    </section>
  </div>
</template>
