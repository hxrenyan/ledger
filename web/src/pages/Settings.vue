<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { api, type Ledger, type SessionBody } from '../api.ts'
import { useSession } from '../stores/session.ts'

const session = useSession()
const router = useRouter()
const newName = ref('')
const joinCode = ref('')
const invite = ref('')
const members = ref<{ user_id: string; role: string; username: string; nickname: string }[]>([])
const ledgerName = ref('')
const err = ref('')
const msg = ref('')
const showMore = ref(false)

/** 头像字：取昵称 / 用户名首字。 */
const initial = computed(() => (session.user?.nickname || session.user?.username || '?').slice(0, 1))

async function refreshMe() {
  const body = await api<SessionBody>('/api/v1/me')
  session.apply({ ...body, token: session.token })
}

async function loadMembers() {
  if (!session.ledgerId) return
  const data = await api<{ name: string; invite_code: string | null; items: typeof members.value }>('/api/v1/members')
  members.value = data.items
  invite.value = data.invite_code ?? ''
  ledgerName.value = data.name
}

async function createLedger() {
  err.value = ''
  try {
    const created = await api<Ledger>('/api/v1/ledgers', {
      method: 'POST',
      body: JSON.stringify({ name: newName.value }),
    })
    newName.value = ''
    await refreshMe()
    session.setLedger(created.id)
    await loadMembers()
    msg.value = '已创建账本'
  } catch (e) {
    err.value = e instanceof Error ? e.message : '失败'
  }
}

async function join() {
  err.value = ''
  try {
    const joined = await api<Ledger>('/api/v1/ledgers/join', {
      method: 'POST',
      body: JSON.stringify({ code: joinCode.value }),
    })
    joinCode.value = ''
    await refreshMe()
    session.setLedger(joined.id)
    await loadMembers()
    msg.value = '已加入账本'
  } catch (e) {
    err.value = e instanceof Error ? e.message : '失败'
  }
}

async function switchLedger(id: string) {
  session.setLedger(id)
  await loadMembers()
}

async function rotate() {
  const data = await api<{ invite_code: string }>('/api/v1/invite/rotate', { method: 'POST' })
  invite.value = data.invite_code
}

async function kick(userId: string) {
  if (!confirm('移除该成员？')) return
  await api(`/api/v1/members/${userId}`, { method: 'DELETE' })
  await loadMembers()
}

function logout() {
  session.clear()
  router.replace('/login')
}

async function exportCsv() {
  err.value = ''
  try {
    const headers = new Headers()
    if (session.token) headers.set('authorization', `Bearer ${session.token}`)
    if (session.ledgerId) headers.set('x-ledger-id', session.ledgerId)
    const res = await fetch('/api/v1/export', { headers })
    if (!res.ok) {
      let message = '导出失败'
      try {
        const data = await res.json()
        if (data?.message) message = data.message
      } catch {
        /* ignore */
      }
      err.value = message
      return
    }
    const blob = await res.blob()
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = '记账.csv'
    a.rel = 'noopener'
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 2000)
    msg.value = '已开始下载 CSV'
  } catch (e) {
    err.value = e instanceof Error ? e.message : '导出失败'
  }
}

onMounted(async () => {
  await refreshMe()
  await loadMembers()
})
</script>

<template>
  <!-- 布局对齐小程序 pages/me：头像卡 → 链接行分组 → 退出登录 -->
  <div class="page">
    <div class="card user-card">
      <span class="avatar avatar-lg">{{ initial }}</span>
      <div>
        <div style="font-weight: 600">{{ session.user?.nickname || session.user?.username }}</div>
        <div class="muted">@{{ session.user?.username }}</div>
      </div>
    </div>

    <div class="card" style="margin-bottom: 12px">
      <div class="row" @click="showMore = !showMore">
        <div>账本与成员</div>
        <span class="muted">{{ session.currentLedger?.name || ledgerName }}（{{ session.ledgers.length }}） ›</span>
      </div>
      <template v-if="showMore">
        <div class="row" v-for="l in session.ledgers" :key="l.id" @click="switchLedger(l.id)">
          <div>
            <div>{{ l.name }}</div>
            <div class="muted">{{ l.role === 'owner' ? '账本主' : '成员' }}</div>
          </div>
          <span class="muted">{{ l.id === session.ledgerId ? '当前' : '切换' }}</span>
        </div>
        <div class="inline" style="margin-top: 12px">
          <input v-model="newName" placeholder="新账本名称" />
          <button class="btn" style="width: auto" @click="createLedger">创建</button>
        </div>
        <div class="inline" style="margin-top: 8px">
          <input v-model="joinCode" placeholder="邀请码" />
          <button class="btn ghost" style="width: auto" @click="join">加入</button>
        </div>
        <p v-if="invite" class="muted" style="margin-top: 12px">
          {{ ledgerName }} 邀请码 {{ invite }}
          <button class="btn ghost" style="width: auto; padding: 4px 8px" @click="rotate">重置</button>
        </p>
        <div class="row" v-for="m in members" :key="m.user_id">
          <div>
            <div>{{ m.nickname || m.username }}</div>
            <div class="muted">{{ m.role === 'owner' ? '账本主' : '成员' }}</div>
          </div>
          <button
            v-if="session.currentLedger?.role === 'owner' && m.role !== 'owner'"
            class="btn ghost"
            style="width: auto"
            @click="kick(m.user_id)"
          >移除</button>
        </div>
      </template>
      <div class="row" @click="router.push('/budgets')">
        <div>月预算</div>
        <span class="muted">›</span>
      </div>
      <div class="row" @click="router.push('/categories')">
        <div>分类管理</div>
        <span class="muted">›</span>
      </div>
      <div class="row" @click="router.push('/recurring')">
        <div>周期记账</div>
        <span class="muted">›</span>
      </div>
      <div class="row" @click="router.push('/import')">
        <div>账单导入</div>
        <span class="muted">CSV / Excel / JSON ›</span>
      </div>
      <div class="row" @click="router.push('/speak')">
        <div>智能记账</div>
        <span class="muted">›</span>
      </div>
    </div>

    <div class="card" style="margin-bottom: 12px">
      <div class="row" @click="exportCsv">
        <div>导出账单 CSV</div>
        <span class="muted">›</span>
      </div>
      <p v-if="err" class="err">{{ err }}</p>
      <p v-if="msg" class="muted">{{ msg }}</p>
    </div>

    <button class="btn ghost" type="button" @click="logout">退出登录</button>
  </div>
</template>
