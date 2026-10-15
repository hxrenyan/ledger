<script setup lang="ts">
/**
 * 只给有微信登录的账号手动加减积分。勾选多位时，同一次变动和同一条备注一起提交。
 */
import { computed, onMounted, ref } from 'vue'
import { adminApi } from '../../adminApi.ts'

type PointUser = {
  id: number
  username: string
  nickname: string
  disabled: boolean
  balance: number
  updated_at: number | null
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
const query = ref('')
const err = ref('')
const msg = ref('')
const loading = ref(false)
let queryTimer = 0
let listReq = 0
const openId = ref<number | ''>('')
const deltaText = ref('')
const note = ref('')
const busy = ref(false)
const entries = ref<PointEntry[]>([])
const restricted = ref(false)
const limitBusy = ref(false)

const kindLabel: Record<string, string> = {
  signup_grant: '新用户赠送',
  daily_enter: '每日进入',
  streak_bonus: '连续进入奖励',
  speech: '语音识别',
  image: '图片识别',
  text: '文本整理',
  refund: '退回',
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

async function loadUsers() {
  const req = ++listReq
  loading.value = true
  try {
    const q = query.value.trim()
    const data = await adminApi<{ items: PointUser[] }>(`/api/v1/admin/points${q ? `?q=${encodeURIComponent(q)}` : ''}`)
    if (req !== listReq) return
    users.value = data.items
    const ids = new Set(data.items.map((item) => item.id))
    selected.value = selected.value.filter((id) => ids.has(id))
    err.value = ''
  } catch (e) {
    if (req !== listReq) return
    err.value = e instanceof Error ? e.message : '加载失败'
  } finally {
    if (req === listReq) loading.value = false
  }
}

async function load() {
  let limitErr = ''
  try {
    await loadLimit()
  } catch (e) {
    limitErr = e instanceof Error ? e.message : '加载失败'
  }
  await loadUsers()
  if (limitErr) err.value = limitErr
}

function onQuery() {
  window.clearTimeout(queryTimer)
  queryTimer = window.setTimeout(() => { void loadUsers() }, 250)
}

function clearQuery() {
  query.value = ''
  window.clearTimeout(queryTimer)
  void loadUsers()
}

const batchReady = computed(() => {
  const delta = Number(deltaText.value)
  const text = note.value.trim()
  return selected.value.length > 0 && Number.isInteger(delta) && delta !== 0 && text.length > 0 && text.length <= 100
})

const batchLabel = computed(() => {
  if (busy.value) return '提交中…'
  const count = selected.value.length
  const delta = Number(deltaText.value)
  if (!count || !Number.isInteger(delta) || delta === 0) return '提交变动'
  return delta > 0 ? `给 ${count} 人加 ${delta}` : `给 ${count} 人扣 ${-delta}`
})

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
  const visible = users.value.map((user) => user.id)
  const allVisible = visible.length > 0 && visible.every((id) => selected.value.includes(id))
  if (allVisible) selected.value = selected.value.filter((id) => !visible.includes(id))
  else selected.value = [...new Set([...selected.value, ...visible])]
}

async function submitBatch() {
  if (busy.value) return
  if (!batchReady.value) {
    err.value = !selected.value.length ? '请选择用户' : !note.value.trim() ? '请填写备注' : '积分变动须为非 0 整数'
    msg.value = ''
    return
  }
  const delta = Number(deltaText.value)
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

function whenAt(ms: number | null) {
  if (!ms) return '暂无'
  return new Date(ms + 8 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' ')
}

function signed(n: number) {
  return n > 0 ? `+${n}` : String(n)
}

onMounted(load)
defineExpose({ reload: load })
</script>

<template>
  <div class="admin-config-page">
    <div class="admin-config-title">
      <div>
        <h2>积分分配</h2>
        <p class="muted">只列出微信登录的账号。勾选后按同一变动、同一备注一次分配。正数增加，负数扣减。任何一人不够扣时，这一批都不写入。</p>
      </div>
    </div>
    <p v-if="err" class="err admin-alert">{{ err }}</p>
    <p v-if="msg" class="admin-success">{{ msg }}</p>
    <section class="admin-panel admin-limit">
      <div>
        <h3>识别限制</h3>
        <p class="muted">开启后，语音、拍照和文本整理只允许微信登录，并按积分扣费。关闭后，已登录用户都能用，不扣积分。保存后立即生效。</p>
      </div>
      <label class="admin-switch">
        <input type="checkbox" :checked="restricted" :disabled="limitBusy" aria-label="识别限制" @change="saveLimit(($event.target as HTMLInputElement).checked)" />
        <span></span>
      </label>
    </section>
    <section class="admin-panel">
      <div class="admin-toolbar">
        <label class="admin-search">
          <input v-model="query" placeholder="搜索昵称或账号" aria-label="搜索微信用户" @input="onQuery" />
          <button v-if="query" class="admin-search-clear" type="button" @click="clearQuery">清除</button>
        </label>
        <button class="btn ghost compact" type="button" :disabled="!users.length" @click="toggleAll">
          {{ users.length && users.every((user) => selected.includes(user.id)) ? '取消全选' : '全选当前' }}
        </button>
        <button v-if="selected.length" class="admin-row-btn" type="button" @click="selected = []">清空已选</button>
        <span class="count">{{ loading ? '查询中' : `当前 ${users.length} 位，已选 ${selected.length} 位` }}</span>
      </div>
      <form class="admin-toolbar point-batch" @submit.prevent="submitBatch">
        <input v-model="deltaText" inputmode="numeric" placeholder="变动分值，如 10 或 -5" aria-label="积分变动" />
        <input v-model="note" class="note" maxlength="100" placeholder="变动原因备注（必填），例如活动补发" aria-label="备注" />
        <button class="btn compact" type="submit" :disabled="busy || !batchReady">{{ batchLabel }}</button>
      </form>
      <div v-if="!users.length && !loading" class="admin-empty">{{ query.trim() ? '没有匹配的微信用户' : '还没有微信用户' }}</div>
      <div v-else-if="users.length" class="admin-table-wrap">
        <div class="admin-table points">
          <div class="admin-table-head">
            <input
              class="point-check"
              type="checkbox"
              :checked="users.length > 0 && users.every((user) => selected.includes(user.id))"
              aria-label="全选当前列表"
              @change="toggleAll"
            />
            <span>用户</span><span>状态</span><span>余额</span><span>修改时间</span><span>操作</span>
          </div>
          <div v-for="u in users" :key="u.id" class="point-user">
            <div class="admin-table-row">
              <input class="point-check" type="checkbox" :checked="selected.includes(u.id)" :aria-label="`选择 ${u.nickname || u.username}`" @change="toggle(u.id)" />
              <div class="admin-person">
                <div class="admin-avatar">{{ (u.nickname || u.username).slice(0, 1).toUpperCase() }}</div>
                <div><strong>{{ u.nickname || u.username }}</strong><span>@{{ u.username }}</span></div>
              </div>
              <span class="admin-status" :class="u.disabled ? 'off' : 'on'">{{ u.disabled ? '已停用' : '正常' }}</span>
              <span class="point-balance">{{ u.balance }} 分</span>
              <span class="admin-time">{{ whenAt(u.updated_at) }}</span>
              <button class="admin-row-btn" type="button" @click="open(u)">{{ openId === u.id ? '收起' : '明细' }}</button>
            </div>
            <ul v-if="openId === u.id" class="point-entries">
              <li v-if="!entries.length">还没有明细</li>
              <li v-for="item in entries" :key="item.id">
                <span class="admin-time">{{ whenAt(item.created_at) }}</span> · {{ kindLabel[item.kind] || item.kind }} {{ signed(item.delta) }} · 余额 {{ item.balance_after }} · {{ item.note }}
              </li>
            </ul>
          </div>
        </div>
      </div>
    </section>
  </div>
</template>
