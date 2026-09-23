<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import LedgerName from '../components/LedgerName.vue'
import { api, type Account } from '../api.ts'
import { formatYuan } from '../money.ts'
import { useSession } from '../stores/session.ts'

/**
 * 资产页，布局对齐小程序 pages/assets：净资产卡 → 账户列表 → 已归档折叠 →
 * 新增账户 / 去设预算。新增表单平时收起（点「新增账户」展开），不占首屏。
 */
const TYPE_LABEL: Record<string, string> = {
  cash: '现金',
  alipay: '支付宝',
  wechat: '微信',
  bank: '银行卡',
  credit: '信用卡',
  other: '其他',
}

const router = useRouter()
const session = useSession()
const items = ref<Account[]>([])
const net = ref(0)
const name = ref('')
const type = ref('other')
const openYuan = ref('')
const err = ref('')
const editId = ref('')
const editYuan = ref('')
const showAdd = ref(false)
const showArchived = ref(false)

const live = computed(() => items.value.filter((a) => !a.archived))
const archived = computed(() => items.value.filter((a) => a.archived))

async function load() {
  const data = await api<{ items: Account[]; net_cents: number }>('/api/v1/accounts')
  items.value = data.items
  net.value = data.net_cents
}

async function add() {
  err.value = ''
  try {
    await api('/api/v1/accounts', {
      method: 'POST',
      body: JSON.stringify({
        name: name.value,
        type: type.value,
        current_cents: Math.round(Number(openYuan.value.trim() || '0') * 100) || 0,
      }),
    })
    name.value = ''
    openYuan.value = ''
    await load()
  } catch (e) {
    err.value = e instanceof Error ? e.message : '失败'
  }
}

async function saveBalance(a: Account) {
  const n = Number(editYuan.value.trim())
  if (!Number.isFinite(n)) return
  await api(`/api/v1/accounts/${a.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ current_cents: Math.round(n * 100) }),
  })
  editId.value = ''
  await load()
}

async function toggle(a: Account) {
  await api(`/api/v1/accounts/${a.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ archived: !a.archived }),
  })
  await load()
}

onMounted(load)
watch(() => session.ledgerId, load)
</script>

<template>
  <div class="page">
    <div class="head">
      <h1>资产</h1>
      <LedgerName />
    </div>
    <div class="card" style="margin-bottom: 12px">
      <div class="muted">净资产</div>
      <div class="v" style="font-size: 28px; font-weight: 700">{{ formatYuan(net) }}</div>
      <p class="muted" style="margin: 6px 0 0">只统计未归档账户；归档的账户不计入。</p>
    </div>
    <div class="card" style="margin-bottom: 12px">
      <h2 style="margin-bottom: 0">账户</h2>
      <div v-if="!live.length" class="muted" style="padding: 8px 0">还没有账户，点下面新增</div>
      <div class="row" v-for="a in live" :key="a.id">
        <div>
          <div>{{ a.name }}</div>
          <div class="muted">{{ TYPE_LABEL[a.type] || a.type }}</div>
        </div>
        <div style="text-align: right">
          <div v-if="editId !== a.id" class="amount" @click="editId = a.id; editYuan = formatYuan(a.current_cents)">
            {{ formatYuan(a.current_cents) }}
          </div>
          <div v-else class="inline">
            <input v-model="editYuan" inputmode="decimal" style="width: 88px" @keyup.enter="saveBalance(a)" />
            <button class="btn" style="width: auto; padding: 8px" @click="saveBalance(a)">存</button>
          </div>
          <button class="btn ghost" style="width: auto; margin-top: 4px; padding: 4px 8px" @click="toggle(a)">归档</button>
        </div>
      </div>
    </div>

    <template v-if="archived.length">
      <div class="row" style="border-bottom: 0" @click="showArchived = !showArchived">
        <div>已归档（{{ archived.length }}）</div>
        <span class="muted">{{ showArchived ? '收起' : '展开' }}</span>
      </div>
      <div v-if="showArchived" class="card" style="margin-top: 8px">
        <div class="row" v-for="a in archived" :key="a.id">
          <div>
            <div>{{ a.name }}</div>
            <div class="muted">{{ TYPE_LABEL[a.type] || a.type }} · 已归档</div>
          </div>
          <div style="text-align: right">
            <div class="amount">{{ formatYuan(a.current_cents) }}</div>
            <button class="btn ghost" style="width: auto; margin-top: 4px; padding: 4px 8px" @click="toggle(a)">恢复</button>
          </div>
        </div>
      </div>
    </template>

    <button class="btn ghost" type="button" style="margin-top: 12px" @click="showAdd = !showAdd">新增账户</button>
    <div v-if="showAdd" class="card" style="margin-top: 12px">
      <div class="inline">
        <input v-model="name" placeholder="账户名" />
        <input v-model="openYuan" class="slim" inputmode="decimal" placeholder="余额" />
        <select v-model="type" aria-label="账户类型">
          <option value="cash">现金</option>
          <option value="alipay">支付宝</option>
          <option value="wechat">微信</option>
          <option value="bank">银行卡</option>
          <option value="credit">信用卡</option>
          <option value="other">其他</option>
        </select>
        <button class="btn" style="width: auto" @click="add">添加</button>
      </div>
      <p v-if="err" class="err">{{ err }}</p>
    </div>
    <button class="btn ghost" type="button" style="margin-top: 12px" @click="router.push('/budgets')">去设预算</button>
  </div>
</template>
